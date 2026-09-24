/**
 * Budget routes for wainwright.fun — generic budget engine.
 *
 * A "budget" is a named spending allowance per child (snacks today; clothes,
 * treats, shoes later). Each budget row configures, per child:
 *   - school_day_amount_pence:     allowance in pence on school days
 *   - non_school_day_amount_pence:  allowance in pence on non-school days
 *   - included_products: product slugs selectable in the picker (allowlist —
 *     a snack must be explicitly ticked in the admin panel to appear)
 *
 * There is no per-day item cap — children may pick as many snacks as they
 * like while money remains. Which allowance applies is decided by the
 * term-dates module (cdk/lambda/term-dates.ts): weekdays inside a term
 * that aren't half term / bank holiday / inset day are school days.
 *
 * Selections live in wainwright-budget-selections (PK child_subdomain,
 * SK `${budget_id}#${date}`) as an append-only list; previous unselected
 * days remain open so kids can go back and fill them in.
 *
 * Product data + consumption are delegated to the Wainsbury's app via its
 * token-authed integration API (server-to-server, kids never call it directly).
 *
 * Kid routes (device token, same cookie as the main app):
 *   GET  /kid/budget/{budgetId}                     → budget state for today
 *   GET  /kid/budget/{budgetId}/products             → selectable products
 *   GET  /kid/budget/{budgetId}/history              → past selections
 *   POST /kid/budget/{budgetId}/select               → pick an item (deducts)
 *   POST /kid/budget/{budgetId}/unselect              → remove a pick (refunds)
 *
 * Admin routes (Cognito):
 *   GET    /budgets                                  → all budgets
 *   PUT    /budgets/{budgetId}                       → create/update a budget
 *   DELETE /budgets/{budgetId}                       → delete a budget
 *   GET    /budgets/{budgetId}/selections            → all children's selections
 *   POST   /budgets/{budgetId}/children/{child}/add  → parent adds a selection
 *   POST   /budgets/{budgetId}/children/{child}/remove
 *          → parent removes a selection (refunds its price; the balance is
 *          derived from the selection list, so deleting the entry restores
 *          the money as if the snack was never picked)
 *   GET    /budgets/{budgetId}/children/{child}/balance[?date=]
 *          → child's balance for a day (allowance + adjustments − spent)
 *   POST   /budgets/{budgetId}/children/{child}/balance
 *          → adjust the balance (new_balance_pence or delta_pence [+note]);
 *          recorded as an "adjustment" transaction
 *   GET    /budgets/{budgetId}/children/{child}/transactions[?limit=]
 *          → the child's transaction log (spends, refunds, adjustments)
 *
 * Every balance change (child spend, unselect refund, parent adjustment,
 * parent-added snack) is recorded in wainwright-budget-transactions.
 */

import { createHash } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { json, parseBody, header, type APIGatewayEvent, type APIResponse } from "./http.js";
import { extractDeviceToken, getDevice, getPreviewChild } from "./kid-routes.js";
import { resolveSchoolDay } from "./term-dates.js";
import { snacksModeForAge, SNACKS_UNIT_PRICE_PENCE, COIN_UNIT_PENCE, roundUpToNearest5, coinsFor } from "../../shared/child-age.js";
import { calculateAge } from "../../scripts/birthday.js";

const BUDGETS_TABLE = process.env.BUDGETS_TABLE!;
const CHILDREN_TABLE = process.env.CHILDREN_TABLE!;
const BUDGET_SELECTIONS_TABLE = process.env.BUDGET_SELECTIONS_TABLE!;
const BUDGET_TRANSACTIONS_TABLE = process.env.BUDGET_TRANSACTIONS_TABLE!;
const WAINSBURYS_TOKEN_SECRET = process.env.WAINSBURYS_TOKEN_SECRET!;
const WAINSBURYS_API_URL = (process.env.WAINSBURYS_API_URL ?? "https://api.wainsburys.co.uk").replace(/\/$/, "");

// ── Types ──────────────────────────────────────────────────────────────

export interface BudgetSelection {
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number | null;
  selectedAt: string;
  selectedBy: "child" | "parent";
  /**
   * The Wainsbury's inventory row the portion was consumed from — passed
   * back to /integration/unconsume on a refund so the exact row is
   * restored. Null on selections made before this field existed (the
   * unconsume fallback then tops up the newest row for the product).
   */
  inventoryItemId?: string | null;
}

export interface BudgetRow {
  budget_id: string;
  name: string;
  /** Child subdomain → pence on school days. */
  school_day_amount_pence: Record<string, number>;
  /** Child subdomain → pence on non-school days. */
  non_school_day_amount_pence: Record<string, number>;
  /** Product slugs selectable in the picker (allowlist — a snack must be
   * explicitly ticked in the admin panel to appear). */
  included_products: string[];
  /**
   * Rollover epoch: the date balance carry-over starts from. Null (or a date
   * after the requested day) means no rollover — each day stands alone with
   * its own allowance. When set, a day's balance is the previous day's
   * closing balance plus that day's allowance and adjustments, minus its spend.
   */
  rollover_start_date?: string | null;
  updated_at: string;
}

/**
 * One entry in a child's append-only transaction log. Every balance change —
 * a child picking a snack, an unselect refund, or a parent adjustment —
 * is recorded here so the full history is always reconstructable.
 */
export interface BudgetTransaction {
  transaction_id: string;
  budget_id: string;
  child_subdomain: string;
  date: string;
  kind: "spend" | "refund" | "adjustment";
  /** Signed delta in pence: spends are negative, refunds/adjustments may be either. */
  amount_pence: number;
  /** Effective remaining balance after this transaction (allowance + adjustments − spent). */
  balance_after_pence: number;
  /** What the transaction was for (product name, or a parent's note). */
  description: string | null;
  /** Who caused it: the child, a parent, or a refund of a prior pick. */
  by: "child" | "parent";
  created_at: string;
}

/** The allowance that applies to a child on a given date. */
async function allowanceFor(
  ddb: DynamoDBDocumentClient,
  budget: BudgetRow,
  subdomain: string,
  date: string
): Promise<number> {
  const schoolDay = await resolveSchoolDay(ddb, date);
  const amounts = schoolDay ? budget.school_day_amount_pence : budget.non_school_day_amount_pence;
  return amounts[subdomain] ?? budget.school_day_amount_pence[subdomain] ?? 0;
}

/**
 * The child's calendar age in whole years (Europe/London), or null when the
 * child row has no usable date_of_birth. Used to pick the snacks app's
 * presentation mode — younger children get the simple "count" UI.
 */
async function childAge(
  ddb: DynamoDBDocumentClient,
  subdomain: string
): Promise<number | null> {
  try {
    const response = await ddb.send(
      new GetCommand({ TableName: CHILDREN_TABLE, Key: { subdomain } })
    );
    const dob = (response.Item as { date_of_birth?: string } | undefined)?.date_of_birth;
    if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
    return calculateAge(dob);
  } catch {
    return null;
  }
}

interface WainsburysProduct {
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number | null;
  portionsLeft: number;
  portionLabel: string | null;
  /** Earliest use-by date (YYYY-MM-DD) across the product's active inventory
   *  rows; null when no active row carries a use-by date. */
  useByDate?: string | null;
  /** True when useByDate is set and is today (London) or earlier — the item
   *  is on or past its use-by date and is charged at half price. */
  halfPrice?: boolean;
}

/**
 * The price a selection is charged at: half price when the product is on or
 * past its use-by date (the halfPrice flag from Wainsbury's), otherwise the
 * normal per-portion price. Exported for tests.
 */
export function effectivePricePence(product: WainsburysProduct): number | null {
  if (product.halfPrice) {
    const half = product.pricePence === null ? null : Math.max(1, Math.round(product.pricePence / 2));
    return half;
  }
  return product.pricePence;
}

// ── Wainsbury's client ─────────────────────────────────────────────────

let cachedToken: { value: string; loadedAt: number } | null = null;

export async function wainsburysToken(): Promise<string> {
  // Tests inject a plain token via env; production reads Secrets Manager.
  const envToken = process.env.WAINSBURYS_TOKEN;
  if (envToken) return envToken;
  if (cachedToken && Date.now() - cachedToken.loadedAt < 5 * 60_000) {
    return cachedToken.value;
  }
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: WAINSBURYS_TOKEN_SECRET })
  );
  const parsed = JSON.parse(response.SecretString ?? "{}") as { token?: string };
  if (!parsed.token) throw new Error("Wainsbury's integration token is not set");
  cachedToken = { value: parsed.token, loadedAt: Date.now() };
  return cachedToken.value;
}

async function wainsburysFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await wainsburysToken();
  return fetch(`${WAINSBURYS_API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export async function fetchSnackProducts(): Promise<WainsburysProduct[]> {
  const response = await wainsburysFetch("/integration/snack-products");
  if (!response.ok) {
    throw new Error(`Wainsbury's returned ${response.status}`);
  }
  const data = (await response.json()) as { products: WainsburysProduct[] };
  return data.products ?? [];
}

export async function consumeWainsburysPortion(productSlug: string): Promise<{ portionsLeft: number; inventoryItemId: string } | { error: string; status: number }> {
  const response = await wainsburysFetch("/integration/consume", {
    method: "POST",
    body: JSON.stringify({ productSlug }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: (data as { message?: string }).message ?? `Wainsbury's returned ${response.status}`, status: response.status };
  }
  return (data as { portionsLeft: number; inventoryItemId: string });
}

export async function unconsumeWainsburysPortion(
  productSlug: string,
  inventoryItemId?: string | null
): Promise<{ portionsLeft: number; inventoryItemId: string } | { error: string; status: number }> {
  const response = await wainsburysFetch("/integration/unconsume", {
    method: "POST",
    body: JSON.stringify({ productSlug, ...(inventoryItemId ? { inventoryItemId } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: (data as { message?: string }).message ?? `Wainsbury's returned ${response.status}`, status: response.status };
  }
  return (data as { portionsLeft: number; inventoryItemId: string });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function londonToday(): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function budgetDay(budgetId: string, date: string): string {
  return `${budgetId}#${date}`;
}

/** Next calendar date (YYYY-MM-DD strings, London-agnostic pure arithmetic). */
function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Whether rollover applies for `date` on this budget: the anchor must be set
 * and not after the requested day. */
function rolloverApplies(budget: BudgetRow, date: string): boolean {
  return typeof budget.rollover_start_date === "string" && budget.rollover_start_date <= date;
}

async function getBudget(ddb: DynamoDBDocumentClient, budgetId: string): Promise<BudgetRow | null> {
  const response = await ddb.send(
    new GetCommand({ TableName: BUDGETS_TABLE, Key: { budget_id: budgetId } })
  );
  return (response.Item as BudgetRow) ?? null;
}

async function getSelectionRow(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string,
  date: string
): Promise<{ child_subdomain: string; budget_day: string; selections: BudgetSelection[] } | null> {
  const response = await ddb.send(
    new GetCommand({
      TableName: BUDGET_SELECTIONS_TABLE,
      Key: { child_subdomain: childSubdomain, budget_day: budgetDay(budgetId, date) },
    })
  );
  return (response.Item as { child_subdomain: string; budget_day: string; selections: BudgetSelection[] }) ?? null;
}

async function putSelectionRow(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string,
  date: string,
  selections: BudgetSelection[]
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: BUDGET_SELECTIONS_TABLE,
      Item: {
        child_subdomain: childSubdomain,
        budget_day: budgetDay(budgetId, date),
        budget_id: budgetId,
        date,
        selections,
        updated_at: new Date().toISOString(),
      },
    })
  );
}

/** Child-friendly error messages keyed by failure mode. */
function childFriendlyError(error: string): string {
  if (/no .* left|sold out/i.test(error)) {
    return "Oh no, that snack has all gone! Please pick a different one. 🐻";
  }
  return "Something went wrong choosing that snack. Please try again!";
}

// ── Transaction log ───────────────────────────────────────────────────

/**
 * Append a transaction to the child's ledger. transaction_id is
 * `${created_at epoch-ms}#${random}` so sort-key order is chronological.
 */
async function recordTransaction(
  ddb: DynamoDBDocumentClient,
  entry: {
    budgetId: string;
    childSubdomain: string;
    date: string;
    kind: BudgetTransaction["kind"];
    amountPence: number;
    balanceAfterPence: number;
    description: string | null;
    by: BudgetTransaction["by"];
  }
): Promise<BudgetTransaction> {
  const createdAt = new Date().toISOString();
  const transaction: BudgetTransaction = {
    transaction_id: `${Date.now()}#${Math.random().toString(36).slice(2, 10)}`,
    budget_id: entry.budgetId,
    child_subdomain: entry.childSubdomain,
    date: entry.date,
    kind: entry.kind,
    amount_pence: entry.amountPence,
    balance_after_pence: entry.balanceAfterPence,
    description: entry.description,
    by: entry.by,
    created_at: createdAt,
  };
  await ddb.send(
    new PutCommand({ TableName: BUDGET_TRANSACTIONS_TABLE, Item: transaction })
  );
  return transaction;
}

/** All transactions for one child (one budget), newest first. */
async function listTransactions(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string,
  limit = 100
): Promise<BudgetTransaction[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: BUDGET_TRANSACTIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      FilterExpression: "budget_id = :budgetId",
      ExpressionAttributeValues: {
        ":child": childSubdomain,
        ":budgetId": budgetId,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (response.Items ?? []) as BudgetTransaction[];
}

/**
 * The parent adjustments recorded for a child on a given date (the
 * "adjustment" kind only — spends/refunds are derived from selections).
 */
async function adjustmentsFor(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string,
  date: string
): Promise<BudgetTransaction[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: BUDGET_TRANSACTIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      FilterExpression: "budget_id = :budgetId AND #kind = :kind AND #date = :date",
      ExpressionAttributeNames: { "#kind": "kind", "#date": "date" },
      ExpressionAttributeValues: {
        ":child": childSubdomain,
        ":budgetId": budgetId,
        ":kind": "adjustment",
        ":date": date,
      },
    })
  );
  return (response.Items ?? []) as BudgetTransaction[];
}

/**
 * All selection rows for one child and budget, oldest first. One query —
 * the rollover fold needs every day since the anchor, so per-day Gets would
 * be one round-trip per day.
 */
async function getSelectionRows(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string
): Promise<Map<string, BudgetSelection[]>> {
  const rows = new Map<string, BudgetSelection[]>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: BUDGET_SELECTIONS_TABLE,
        KeyConditionExpression: "child_subdomain = :child AND begins_with(budget_day, :prefix)",
        ExpressionAttributeValues: {
          ":child": childSubdomain,
          ":prefix": `${budgetId}#`,
        },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of response.Items ?? []) {
      const row = item as { date?: string; selections?: BudgetSelection[] };
      if (typeof row.date === "string") rows.set(row.date, row.selections ?? []);
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}

/**
 * All parent adjustments for one child and budget, grouped by date. One
 * filtered query (the table is per-child, so this stays small).
 */
async function getAdjustmentsByDate(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  budgetId: string
): Promise<Map<string, number>> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: BUDGET_TRANSACTIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      FilterExpression: "budget_id = :budgetId AND #kind = :kind",
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: {
        ":child": childSubdomain,
        ":budgetId": budgetId,
        ":kind": "adjustment",
      },
    })
  );
  const byDate = new Map<string, number>();
  for (const item of response.Items ?? []) {
    const t = item as { date?: string; amount_pence?: number };
    if (typeof t.date === "string" && typeof t.amount_pence === "number") {
      byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.amount_pence);
    }
  }
  return byDate;
}

/**
 * The rollover fold, extracted so it can be tested without DynamoDB:
 * walks day by day from `start` to `date` (inclusive), carrying each
 * day's closing balance forward. `allowanceForDay` resolves a day's
 * allowance (school vs non-school); a day can never close below zero because
 * spends are only recorded when the balance covered them.
 *
 * Forfeit rule: a day on which the child picked NO snacks forfeits its
 * allowance — only the day's allowance is lost; pennies already carried in
 * from earlier days survive, as do parent adjustments recorded for that
 * day. The requested `date` itself is exempt (it is "today" from the
 * caller's perspective — the child hasn't had their chance yet), so a
 * no-pick final day still folds normally. Carry-over therefore only
 * happens out of a day where the child picked at least one snack and had
 * leftover pennies.
 */
export async function foldRolloverBalance(
  start: string,
  date: string,
  allowanceForDay: (day: string) => Promise<number>,
  selectionsByDate: Map<string, BudgetSelection[]>,
  adjustmentsByDate: Map<string, number>
): Promise<number> {
  let carry = 0;
  for (let day = start; day <= date; day = nextDate(day)) {
    const dayAllowance = await allowanceForDay(day);
    const dayAdjustments = adjustmentsByDate.get(day) ?? 0;
    const daySelections = selectionsByDate.get(day) ?? [];
    const daySpent = daySelections.reduce(
      (sum, s) => sum + (s.pricePence ?? 0),
      0
    );
    if (daySelections.length === 0 && day !== date) {
      // No snack picked on a completed day: the day's allowance is
      // forfeited. Carry-in and parent adjustments survive untouched —
      // only the allowance itself is deducted. The requested date itself
      // is exempt (the child hasn't had their chance yet).
      carry = Math.max(0, carry + dayAdjustments);
    } else {
      carry = Math.max(0, carry + dayAllowance + dayAdjustments - daySpent);
    }
  }
  return carry;
}

/**
 * Full balance picture for a child on a date: the day's allowance, the
 * parent adjustments on top, what has been spent, and what remains.
 * Adjustments are stored in the ledger (not on the budget row) so the
 * history is always complete and the budget config stays per-day amounts.
 *
 * When the budget has a rollover_start_date on or before `date`, the
 * remaining balance folds forward day by day from that anchor: each day
 * starts with the previous day's closing balance, adds its allowance and
 * adjustments, and subtracts its spend. A day on which the child picked no
 * snacks forfeits its allowance (carry-in and adjustments survive) — so
 * unspent pence only carry over out of a day where the child actually
 * picked a snack. A day can never go below zero because a spend is
 * only ever recorded when the balance covered it. The fold is computed
 * on the fly from the selection rows and adjustment ledger — nothing is
 * materialised, so history always reconciles. An admin "removes" a
 * forfeiture by adding the snack the child actually had that day
 * (POST .../children/{child}/add with the date) — the day then counts
 * as picked and folds normally.
 */
async function balanceFor(
  ddb: DynamoDBDocumentClient,
  budget: BudgetRow,
  subdomain: string,
  date: string
): Promise<{
  allowance_pence: number;
  adjustments_pence: number;
  spent_pence: number;
  remaining_pence: number;
  carried_pence: number;
}> {
  const allowance = await allowanceFor(ddb, budget, subdomain, date);
  const adjustments = await adjustmentsFor(ddb, subdomain, budget.budget_id, date);
  const adjustmentTotal = adjustments.reduce((sum, t) => sum + t.amount_pence, 0);
  const row = await getSelectionRow(ddb, subdomain, budget.budget_id, date);
  const spent = (row?.selections ?? []).reduce((sum, s) => sum + (s.pricePence ?? 0), 0);

  // No rollover (anchor unset or in the future): today stands alone.
  if (!rolloverApplies(budget, date)) {
    return {
      allowance_pence: allowance,
      adjustments_pence: adjustmentTotal,
      spent_pence: spent,
      remaining_pence: allowance + adjustmentTotal - spent,
      carried_pence: 0,
    };
  }

  // Rollover: fold every day from the anchor to `date` (inclusive).
  const [selectionsByDate, adjustmentsByDate] = await Promise.all([
    getSelectionRows(ddb, subdomain, budget.budget_id),
    getAdjustmentsByDate(ddb, subdomain, budget.budget_id),
  ]);

  const carry = await foldRolloverBalance(
    budget.rollover_start_date!,
    date,
    (day) => allowanceFor(ddb, budget, subdomain, day),
    selectionsByDate,
    adjustmentsByDate
  );

  return {
    allowance_pence: allowance,
    adjustments_pence: adjustmentTotal,
    spent_pence: spent,
    remaining_pence: carry,
    carried_pence: carry - (allowance + adjustmentTotal - spent),
  };
}


// ── Kid routes ─────────────────────────────────────────────────────────

type KidAuth = { subdomain: string } | APIResponse;

function isKidDenied(value: KidAuth): value is APIResponse {
  return "statusCode" in value;
}

async function resolveKid(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<KidAuth> {
  const token = await extractDeviceToken(event, ddb);
  if (!token) return json(event, 401, { error: "Missing device token" });
  const device = await getDevice(ddb, token);
  if (device) return { subdomain: String(device.child_subdomain) };
  // Preview tokens (prv_*) — transient rows in the pairing table, same as the main kid routes.
  const previewSubdomain = await getPreviewChild(ddb, token);
  if (previewSubdomain) return { subdomain: previewSubdomain };
  return json(event, 401, { error: "Unknown or revoked device" });
}

async function handleKidBudgetState(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const date = event.queryStringParameters?.date ?? londonToday();
  const balance = await balanceFor(ddb, budget, auth.subdomain, date);
  const row = await getSelectionRow(ddb, auth.subdomain, budgetId, date);
  const selections = row?.selections ?? [];

  // Presentation mode: children SIMPLE_AGE_THRESHOLD and under can't do
  // arithmetic yet — they see their balance in 5p coins, and each snack
  // costs a whole number of coins (its price rounded up to the nearest 5p).
  // Older children see pence as before.
  const age = await childAge(ddb, auth.subdomain);
  const mode = age === null ? "pence" : snacksModeForAge(age);
  const coinsRemaining =
    mode === "count" ? coinsFor(balance.remaining_pence) : null;

  return json(event, 200, {
    budget_id: budgetId,
    name: budget.name,
    date,
    mode,
    allowance_pence: balance.allowance_pence,
    adjustments_pence: balance.adjustments_pence,
    spent_pence: balance.spent_pence,
    remaining_pence: balance.remaining_pence,
    snacks_remaining: null,
    coins_remaining: coinsRemaining,
    carried_pence: balance.carried_pence,
    selections,
  });
}

async function handleKidBudgetProducts(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const products = await fetchSnackProducts();
  const included = new Set(budget.included_products);
  const visible = products.filter((p) => included.has(p.productSlug));

  return json(event, 200, {
    products: visible.map((p) => ({
      productSlug: p.productSlug,
      name: p.name,
      image: p.image,
      pricePence: p.pricePence,
      portionsLeft: p.portionsLeft,
      portionLabel: p.portionLabel,
      useByDate: p.useByDate ?? null,
      halfPrice: p.halfPrice ?? false,
    })),
  });
}

async function handleKidBudgetHistory(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const response = await ddb.send(
    new QueryCommand({
      TableName: BUDGET_SELECTIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child AND begins_with(budget_day, :prefix)",
      ExpressionAttributeValues: {
        ":child": auth.subdomain,
        ":prefix": `${budgetId}#`,
      },
      ScanIndexForward: false,
      Limit: 60,
    })
  );

  const days = (response.Items ?? []).map((item) => ({
    date: item.date,
    selections: (item.selections ?? []) as BudgetSelection[],
  }));

  return json(event, 200, { days });
}

async function handleKidBudgetSelect(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const body = parseBody(event);
  const productSlug = String(body.productSlug ?? "");
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : londonToday();
  if (!productSlug) return json(event, 400, { error: "productSlug is required" });

  const balance = await balanceFor(ddb, budget, auth.subdomain, date);
  const row = await getSelectionRow(ddb, auth.subdomain, budgetId, date);
  const selections = row?.selections ?? [];

  // Check the product is selectable right now (included, still in stock).
  const products = await fetchSnackProducts();
  const included = new Set(budget.included_products);
  const product = products.find((p) => p.productSlug === productSlug);
  if (!product || !included.has(productSlug)) {
    return json(event, 400, { error: "That snack isn't available to pick. Please choose another!" });
  }
  if (product.portionsLeft <= 0) {
    return json(event, 409, { error: "Oh no, that snack has all gone! Please pick a different one. 🐻" });
  }

  // Count mode (young children): the child sees and spends 5p coins. Each
  // pick costs the real per-portion price (halved when on or past use-by),
  // rounded UP to a whole number of coins so the balance always reconciles.
  // Older children pay the effective price directly.
  const age = await childAge(ddb, auth.subdomain);
  const countMode = age !== null && snacksModeForAge(age) === "count";
  const effective = effectivePricePence(product);
  const pricePence = countMode
    ? roundUpToNearest5(effective ?? SNACKS_UNIT_PRICE_PENCE)
    : effective;

  if (pricePence !== null && pricePence > balance.remaining_pence) {
    return json(event, 400, {
      error: countMode
        ? "You don't have enough coins for that snack today!"
        : "You don't have enough pennies left for that snack today!",
    });
  }

  // Consume the portion in Wainsbury's FIRST — if it fails (e.g. raced to
  // zero), tell the child to pick another. Only then record the selection.
  const consumed = await consumeWainsburysPortion(productSlug);
  if ("error" in consumed) {
    return json(event, consumed.status === 409 ? 409 : 502, {
      error: consumed.status === 409 ? childFriendlyError(consumed.error) : "Something went wrong choosing that snack. Please try again!",
    });
  }

  const selection: BudgetSelection = {
    productSlug,
    name: product.name,
    image: product.image,
    // Count mode stores the coin-rounded price; refunds and history
    // reconcile automatically from the stored value.
    pricePence,
    selectedAt: new Date().toISOString(),
    selectedBy: "child",
    inventoryItemId: consumed.inventoryItemId,
  };
  await putSelectionRow(ddb, auth.subdomain, budgetId, date, [...selections, selection]);

  // Record the spend in the transaction log.
  const remainingAfter = balance.remaining_pence - (pricePence ?? 0);
  await recordTransaction(ddb, {
    budgetId,
    childSubdomain: auth.subdomain,
    date,
    kind: "spend",
    amountPence: -(pricePence ?? 0),
    balanceAfterPence: remainingAfter,
    description: product.name,
    by: "child",
  });

  return json(event, 200, {
    selection,
    remaining_pence: remainingAfter,
    portions_left: consumed.portionsLeft,
  });
}

async function handleKidBudgetUnselect(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const body = parseBody(event);
  const productSlug = String(body.productSlug ?? "");
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : londonToday();
  const selectedAt = String(body.selectedAt ?? "");
  if (!productSlug || !selectedAt) {
    return json(event, 400, { error: "productSlug and selectedAt are required" });
  }

  const balance = await balanceFor(ddb, budget, auth.subdomain, date);
  const row = await getSelectionRow(ddb, auth.subdomain, budgetId, date);
  const selections = row?.selections ?? [];
  const index = selections.findIndex((s) => s.productSlug === productSlug && s.selectedAt === selectedAt);
  if (index === -1) {
    return json(event, 404, { error: "That selection wasn't found" });
  }

  const removed = selections[index];
  selections.splice(index, 1);
  await putSelectionRow(ddb, auth.subdomain, budgetId, date, selections);

  // Restore the inventory portion in Wainsbury's (best effort — the money
  // refund below is the source of truth for the child's balance, so a
  // Wainsbury's hiccup must not block it). Only child selections consumed a
  // portion; parent-added selections never did, so there's nothing to restore.
  if (removed.selectedBy === "child") {
    const unconsumed = await unconsumeWainsburysPortion(productSlug, removed.inventoryItemId ?? null);
    if ("error" in unconsumed) {
      console.warn("unselect: Wainsbury's unconsume failed", {
        productSlug,
        inventoryItemId: removed.inventoryItemId ?? null,
        status: unconsumed.status,
        error: unconsumed.error,
      });
    }
  }

  // Record the refund in the transaction log.
  const remainingAfter = balance.remaining_pence + (removed.pricePence ?? 0);
  await recordTransaction(ddb, {
    budgetId,
    childSubdomain: auth.subdomain,
    date,
    kind: "refund",
    amountPence: removed.pricePence ?? 0,
    balanceAfterPence: remainingAfter,
    description: removed.name,
    by: "child",
  });

  return json(event, 200, { removed: true, remaining_pence: remainingAfter });
}

// ── Admin routes ───────────────────────────────────────────────────────

async function handleAdminListBudgets(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const items: BudgetRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: BUDGETS_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as BudgetRow[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => a.budget_id.localeCompare(b.budget_id));
  return json(event, 200, items);
}

async function handleAdminPutBudget(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const body = parseBody(event);
  const existing = await getBudget(ddb, budgetId);
  // rollover_start_date: null/"" clears rollover; otherwise must be a date.
  let rolloverStartDate: string | null = existing?.rollover_start_date ?? null;
  if (body.rollover_start_date !== undefined) {
    const raw = body.rollover_start_date;
    if (raw === null || raw === "") {
      rolloverStartDate = null;
    } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      rolloverStartDate = raw;
    } else {
      return json(event, 400, { error: "rollover_start_date must be a YYYY-MM-DD date or null" });
    }
  }
  const item: BudgetRow = {
    budget_id: budgetId,
    name: String(body.name ?? existing?.name ?? budgetId),
    school_day_amount_pence: (body.school_day_amount_pence as Record<string, number>) ?? existing?.school_day_amount_pence ?? {},
    non_school_day_amount_pence: (body.non_school_day_amount_pence as Record<string, number>) ?? existing?.non_school_day_amount_pence ?? {},
    included_products: (body.included_products as string[]) ?? existing?.included_products ?? [],
    rollover_start_date: rolloverStartDate,
    updated_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: item }));
  return json(event, 200, item);
}

async function handleAdminDeleteBudget(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: BUDGETS_TABLE, Key: { budget_id: budgetId } })
  );
  return json(event, 200, { deleted: true });
}

async function handleAdminListSelections(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const items: Array<{ child_subdomain: string; budget_day: string; date: string; selections: BudgetSelection[] }> = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: BUDGET_SELECTIONS_TABLE,
        FilterExpression: "budget_id = :budgetId",
        ExpressionAttributeValues: { ":budgetId": budgetId },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((response.Items ?? []) as typeof items));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => b.date.localeCompare(a.date) || a.child_subdomain.localeCompare(b.child_subdomain));
  return json(event, 200, items);
}

async function handleAdminListProducts(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const products = await fetchSnackProducts();
  const included = new Set(budget.included_products);
  return json(event, 200, {
    products: products.map((p) => ({
      productSlug: p.productSlug,
      name: p.name,
      image: p.image,
      pricePence: p.pricePence,
      portionsLeft: p.portionsLeft,
      portionLabel: p.portionLabel,
      useByDate: p.useByDate ?? null,
      halfPrice: p.halfPrice ?? false,
      included: included.has(p.productSlug),
    })),
  });
}

async function handleAdminAddSelection(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const body = parseBody(event);
  const productSlug = String(body.productSlug ?? "");
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : londonToday();
  if (!productSlug) return json(event, 400, { error: "productSlug is required" });

  const products = await fetchSnackProducts();
  const product = products.find((p) => p.productSlug === productSlug);
  if (!product) return json(event, 400, { error: "Unknown product" });

  const row = await getSelectionRow(ddb, childSubdomain, budgetId, date);
  const selections = row?.selections ?? [];

  const selection: BudgetSelection = {
    productSlug,
    name: product.name,
    image: product.image,
    // Parent-added picks are charged at the effective price too — half price
    // when the product is on or past its use-by date.
    pricePence: effectivePricePence(product),
    selectedAt: new Date().toISOString(),
    selectedBy: "parent",
  };
  await putSelectionRow(ddb, childSubdomain, budgetId, date, [...selections, selection]);

  // Record the parent-added spend in the transaction log.
  const balance = await balanceFor(ddb, budget, childSubdomain, date);
  await recordTransaction(ddb, {
    budgetId,
    childSubdomain,
    date,
    kind: "spend",
    amountPence: -(effectivePricePence(product) ?? 0),
    balanceAfterPence: balance.remaining_pence,
    description: product.name,
    by: "parent",
  });

  return json(event, 200, { selection });
}

/**
 * POST /budgets/{budgetId}/children/{child}/remove
 * Body: { productSlug, selectedAt, date? }
 *
 * Removes one selection from the child's day list and records a refund
 * transaction. The balance is always derived from the selection list
 * (allowance + adjustments − spent), so deleting the entry returns the
 * money to the child's budget as if the snack was never picked.
 */
async function handleAdminRemoveSelection(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const body = parseBody(event);
  const productSlug = String(body.productSlug ?? "");
  const selectedAt = String(body.selectedAt ?? "");
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : londonToday();
  if (!productSlug || !selectedAt) {
    return json(event, 400, { error: "productSlug and selectedAt are required" });
  }

  const row = await getSelectionRow(ddb, childSubdomain, budgetId, date);
  const selections = row?.selections ?? [];
  const index = selections.findIndex(
    (s) => s.productSlug === productSlug && s.selectedAt === selectedAt
  );
  if (index === -1) {
    return json(event, 404, { error: "Selection not found" });
  }

  // Balance BEFORE the removal (the selection still counts as spent) so the
  // refund's balance_after_pence is correct — same order as the kid route.
  const balance = await balanceFor(ddb, budget, childSubdomain, date);

  const removed = selections[index];
  selections.splice(index, 1);
  await putSelectionRow(ddb, childSubdomain, budgetId, date, selections);

  // Restore the inventory portion in Wainsbury's (best effort — the money
  // refund below is the source of truth for the child's balance, so a
  // Wainsbury's hiccup must not block it). Only child selections consumed a
  // portion; parent-added selections never did, so there's nothing to restore.
  if (removed.selectedBy === "child") {
    const unconsumed = await unconsumeWainsburysPortion(productSlug, removed.inventoryItemId ?? null);
    if ("error" in unconsumed) {
      console.warn("admin remove: Wainsbury's unconsume failed", {
        productSlug,
        inventoryItemId: removed.inventoryItemId ?? null,
        status: unconsumed.status,
        error: unconsumed.error,
      });
    }
  }

  // Record the refund in the transaction log.
  const remainingAfter = balance.remaining_pence + (removed.pricePence ?? 0);
  await recordTransaction(ddb, {
    budgetId,
    childSubdomain,
    date,
    kind: "refund",
    amountPence: removed.pricePence ?? 0,
    balanceAfterPence: remainingAfter,
    description: removed.name,
    by: "parent",
  });

  return json(event, 200, { removed, remaining_pence: remainingAfter });
}

// ── Admin balance routes ───────────────────────────────────────────────

/**
 * GET /budgets/{budgetId}/children/{child}/balance[?date=]
 * The parent-facing view of a child's snack balance for a day.
 */
async function handleAdminChildBalance(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const date = event.queryStringParameters?.date ?? londonToday();
  const balance = await balanceFor(ddb, budget, childSubdomain, date);
  return json(event, 200, {
    budget_id: budgetId,
    child_subdomain: childSubdomain,
    date,
    ...balance,
  });
}

/**
 * POST /budgets/{budgetId}/children/{child}/balance
 * Body: { date?: string, new_balance_pence?: number, delta_pence?: number, note?: string }
 *
 * Sets or shifts the child's balance for a day by recording an adjustment
 * transaction. Exactly one of new_balance_pence / delta_pence is required.
 */
async function handleAdminAdjustBalance(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const body = parseBody(event);
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : londonToday();
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const hasNew = body.new_balance_pence !== undefined && body.new_balance_pence !== null;
  const hasDelta = body.delta_pence !== undefined && body.delta_pence !== null;
  if (hasNew === hasDelta) {
    return json(event, 400, { error: "Provide exactly one of new_balance_pence or delta_pence" });
  }

  const balance = await balanceFor(ddb, budget, childSubdomain, date);
  let delta: number;
  if (hasNew) {
    const target = Number(body.new_balance_pence);
    if (!Number.isFinite(target)) return json(event, 400, { error: "new_balance_pence must be a number" });
    delta = Math.round(target) - balance.remaining_pence;
  } else {
    const parsed = Number(body.delta_pence);
    if (!Number.isFinite(parsed)) return json(event, 400, { error: "delta_pence must be a number" });
    delta = Math.round(parsed);
  }

  if (delta === 0) {
    return json(event, 200, { balance, transaction: null, unchanged: true });
  }

  const transaction = await recordTransaction(ddb, {
    budgetId,
    childSubdomain,
    date,
    kind: "adjustment",
    amountPence: delta,
    balanceAfterPence: balance.remaining_pence + delta,
    description: note,
    by: "parent",
  });

  return json(event, 200, {
    balance: {
      ...balance,
      adjustments_pence: balance.adjustments_pence + delta,
      remaining_pence: balance.remaining_pence + delta,
    },
    transaction,
  });
}

/**
 * GET /budgets/{budgetId}/children/{child}/transactions[?limit=]
 * The child's transaction log, newest first.
 */
async function handleAdminChildTransactions(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  budgetId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const budget = await getBudget(ddb, budgetId);
  if (!budget) return json(event, 404, { error: "Budget not found" });

  const limitParam = Number(event.queryStringParameters?.limit ?? 100);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, Math.round(limitParam)), 500) : 100;
  const transactions = await listTransactions(ddb, childSubdomain, budgetId, limit);
  return json(event, 200, { transactions });
}

// ── Router ─────────────────────────────────────────────────────────────

export async function tryHandleBudgetRoute(
  event: APIGatewayEvent,
  method: string,
  resource: string,
  resourceId: string,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse | null> {
  // Kid routes: /kid/budget/{budgetId}[/{action}]
  if (resource === "kid" && resourceId.startsWith("budget/")) {
    const rest = resourceId.slice("budget/".length);
    const [budgetId, action] = rest.split("/");
    if (!budgetId) return json(event, 404, { error: "Not found" });

    if (method === "GET" && !action) return handleKidBudgetState(event, ddb, budgetId);
    if (method === "GET" && action === "products") return handleKidBudgetProducts(event, ddb, budgetId);
    if (method === "GET" && action === "history") return handleKidBudgetHistory(event, ddb, budgetId);
    if (method === "POST" && action === "select") return handleKidBudgetSelect(event, ddb, budgetId);
    if (method === "POST" && action === "unselect") return handleKidBudgetUnselect(event, ddb, budgetId);
    return json(event, 404, { error: "Not found" });
  }

  // Admin routes: /budgets[/{budgetId}[/{...}]]
  if (resource === "budgets") {
    if (method === "GET" && !resourceId) return handleAdminListBudgets(event, ddb);
    if (method === "PUT" && resourceId) return handleAdminPutBudget(event, ddb, resourceId);
    if (method === "DELETE" && resourceId) return handleAdminDeleteBudget(event, ddb, resourceId);

    const [budgetId, subResource, childSubdomain, action] = resourceId.split("/");
    if (method === "GET" && budgetId && subResource === "products") {
      return handleAdminListProducts(event, ddb, budgetId);
    }
    if (method === "GET" && budgetId && subResource === "selections") {
      return handleAdminListSelections(event, ddb, budgetId);
    }
    if (method === "POST" && budgetId && subResource === "children" && childSubdomain && action === "add") {
      return handleAdminAddSelection(event, ddb, budgetId, childSubdomain);
    }
    if (method === "POST" && budgetId && subResource === "children" && childSubdomain && action === "remove") {
      return handleAdminRemoveSelection(event, ddb, budgetId, childSubdomain);
    }
    if (method === "GET" && budgetId && subResource === "children" && childSubdomain && action === "balance") {
      return handleAdminChildBalance(event, ddb, budgetId, childSubdomain);
    }
    if (method === "POST" && budgetId && subResource === "children" && childSubdomain && action === "balance") {
      return handleAdminAdjustBalance(event, ddb, budgetId, childSubdomain);
    }
    if (method === "GET" && budgetId && subResource === "children" && childSubdomain && action === "transactions") {
      return handleAdminChildTransactions(event, ddb, budgetId, childSubdomain);
    }
    return json(event, 404, { error: "Not found" });
  }

  return null;
}
