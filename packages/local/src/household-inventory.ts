/**
 * Printer paper used when a parent confirms a Tickets reward.
 *
 * Household PR #26. Paths for a category live here so a later category can be
 * added without touching the admin UI. Base URL is HOUSEHOLD_URL, usually
 * http://household:43126.
 *
 *   printer-paper
 *   GET  {HOUSEHOLD_URL}/api/integrations/tickets/printer-paper?min_sheets={sheets}
 *        200 { papers: [{ product_slug, name, sheets_remaining }] }, fullest first.
 *        A bare array is accepted too. 400 means min_sheets was not a whole number.
 *   POST {HOUSEHOLD_URL}/api/integrations/tickets/printer-paper/use
 *        { product_slug, sheets, ref, source: "tickets-reward" }
 *        sheets is a whole number above 0. ref must not contain "#".
 *        200 { ok, already, ref, ... } records the use. The same ref with the
 *        same product and sheets returns already:true. A different product or
 *        sheet count, or a ref that was already reversed, is 409.
 *        400 is not paper or no pack size. 404 is an unknown product.
 *        409 is not enough sheets, or that ref clash.
 *   POST {HOUSEHOLD_URL}/api/integrations/tickets/printer-paper/reverse
 *        { ref }
 *        200 { ok, ref, restored:true, already:false } the first time, then
 *        { restored:false, already:true }. Both are success.
 *
 * Every call sends Authorization: Bearer <token>. 401 means the token was refused.
 * The token is HOUSEHOLD_SERVICE_TOKEN, or the trimmed contents of
 * HOUSEHOLD_SERVICE_TOKEN_FILE. A Tickets redemption id is a fresh
 * `${epoch36}-${rand}` with no "#", and a refund deletes that row, so the ref
 * is the redemption id. A later redeem is a new id.
 *
 * Which reward uses this is tickets.rewards.extra.household_consumable:
 * { category: "printer-paper", sheets: 10 }. The reward id is not special.
 */
import { readFileSync } from "node:fs";

export const TICKETS_REWARD_SOURCE = "tickets-reward";

/** Category on a reward → Household path, with no trailing slash. */
export const HOUSEHOLD_CONSUMABLE_PATHS = {
  "printer-paper": "/api/integrations/tickets/printer-paper",
} as const;

export const STOCK_WARNINGS = {
  unlinked: "Household isn't linked, so the paper stock wasn't reduced.",
  silent: "Household didn't answer, so the paper stock wasn't reduced.",
  unauthorised: "Household refused the service token, so the paper stock wasn't reduced.",
  badSheets: "Household rejected the sheet count, so the stock wasn't reduced.",
  unrecognised: "Household's paper list wasn't recognised, so the stock wasn't reduced.",
  unmapped: (category: string) => `Household has no paper list for ${category}, so the stock wasn't reduced.`,
  none: (sheets: number) => `No paper has at least ${sheets} sheets left, so the stock wasn't reduced.`,
  notRecorded: "Claimed, but Household didn't record the sheets used, so the stock wasn't reduced.",
  notPaper: "That product is not printer paper, or it has no pack size.",
  unknownProduct: "Household doesn't know that paper.",
  conflict: "Not enough sheets left, or that paper was already used under another choice.",
  refused: "Household refused that paper.",
  notRestored: "Refunded, but Household didn't put the sheets back.",
  unauthorisedRestore: "Household refused the service token, so the sheets weren't put back.",
} as const;

export interface HouseholdInventory {
  /** Household base URL, no trailing slash. */
  url: string;
  /** Service token. Omitted when neither the env value nor the token file is set. */
  token?: string;
}

export interface ConsumableSpec {
  category: string;
  sheets: number;
}

export interface ConsumableOption {
  product_slug: string;
  name: string;
  sheets_remaining: number;
}

export interface RecordedConsumableUse {
  product_slug: string;
  name: string;
  sheets: number;
  ref: string;
  category: string;
  source: typeof TICKETS_REWARD_SOURCE;
  recorded: boolean;
}

export function householdServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  const inline = (env.HOUSEHOLD_SERVICE_TOKEN ?? "").trim();
  if (inline) return inline;
  const file = (env.HOUSEHOLD_SERVICE_TOKEN_FILE ?? "").trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function householdInventoryFromEnv(env: NodeJS.ProcessEnv = process.env): HouseholdInventory | null {
  const url = (env.HOUSEHOLD_URL ?? "").trim().replace(/\/$/, "");
  if (!url) return null;
  const token = householdServiceToken(env);
  return { url, ...(token ? { token } : {}) };
}

/**
 * Household's paper ref. A Tickets redemption id is safe to use as-is:
 * recordRedemption builds `${Date.now().toString(36)}-${random}`, which has
 * no "#", and a refund deletes that row, so the next redeem is a new id.
 */
export function paperUseRef(redemptionId: string): string {
  const ref = redemptionId.trim();
  if (!ref || ref.includes("#")) throw new Error("A paper ref cannot contain '#'");
  return ref;
}

export function consumablePath(category: string): string | null {
  return HOUSEHOLD_CONSUMABLE_PATHS[category as keyof typeof HOUSEHOLD_CONSUMABLE_PATHS] ?? null;
}

/** Every Household integration call uses this. A missing token is sent as no Authorization header. */
export function householdAuthHeaders(inventory: HouseholdInventory): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = inventory.token?.trim();
  if (!token) return headers;
  headers.Authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reward extra, or the reward row once Postgres has flattened extra onto it. */
export function consumableSpec(reward: unknown): ConsumableSpec | null {
  const record = asRecord(reward);
  if (!record) return null;
  return specOf(record.household_consumable) ?? specOf(asRecord(record.extra)?.household_consumable);
}

function specOf(value: unknown): ConsumableSpec | null {
  const spec = asRecord(value);
  const category = typeof spec?.category === "string" ? spec.category.trim() : "";
  const sheets = Number(spec?.sheets);
  if (!category || !Number.isInteger(sheets) || sheets < 1 || sheets > 10000) return null;
  return { category, sheets };
}

export function householdUseOf(redemption: unknown): RecordedConsumableUse | null {
  const record = asRecord(redemption);
  if (!record) return null;
  const raw = asRecord(record.household_use) ?? asRecord(asRecord(record.extra)?.household_use);
  if (!raw || raw.recorded !== true) return null;
  const product_slug = typeof raw.product_slug === "string" ? raw.product_slug.trim() : "";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : product_slug;
  const sheets = Number(raw.sheets);
  const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : "printer-paper";
  if (!product_slug || !ref || !Number.isInteger(sheets) || sheets < 1) return null;
  return { product_slug, name, sheets, ref, category, source: TICKETS_REWARD_SOURCE, recorded: true };
}

function optionOf(value: unknown): ConsumableOption | null {
  const row = asRecord(value);
  const product_slug = typeof row?.product_slug === "string" ? row.product_slug.trim() : "";
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  const sheets = Number(row?.sheets_remaining);
  if (!product_slug || !name || !Number.isFinite(sheets)) return null;
  return { product_slug, name, sheets_remaining: sheets };
}

/** Household returns `{ papers: [...] }`. A bare array is accepted too. */
export function parseConsumableOptions(payload: unknown, minSheets: number): ConsumableOption[] | null {
  const body = asRecord(payload);
  const list = Array.isArray(body?.papers) ? body.papers : Array.isArray(payload) ? payload : null;
  if (!list) return null;
  const bySlug = new Map<string, ConsumableOption>();
  for (const entry of list) {
    const option = optionOf(entry);
    if (!option || option.sheets_remaining < minSheets) continue;
    const previous = bySlug.get(option.product_slug);
    if (!previous || option.sheets_remaining > previous.sheets_remaining) bySlug.set(option.product_slug, option);
  }
  return [...bySlug.values()].sort(
    (a, b) => b.sheets_remaining - a.sheets_remaining || a.name.localeCompare(b.name),
  );
}

async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function listConsumableOptions(
  inventory: HouseholdInventory | null,
  spec: ConsumableSpec,
): Promise<{ ok: true; options: ConsumableOption[] } | { ok: false; warning: string }> {
  if (!inventory?.url) return { ok: false, warning: STOCK_WARNINGS.unlinked };
  const path = consumablePath(spec.category);
  if (!path) return { ok: false, warning: STOCK_WARNINGS.unmapped(spec.category) };
  try {
    const url = new URL(path, inventory.url);
    url.searchParams.set("min_sheets", String(spec.sheets));
    const response = await fetch(url, { headers: householdAuthHeaders(inventory), signal: AbortSignal.timeout(4000) });
    if (response.status === 401) return { ok: false, warning: STOCK_WARNINGS.unauthorised };
    if (response.status === 400) return { ok: false, warning: STOCK_WARNINGS.badSheets };
    if (!response.ok) return { ok: false, warning: STOCK_WARNINGS.silent };
    const options = parseConsumableOptions(await readBody(response), spec.sheets);
    if (!options) return { ok: false, warning: STOCK_WARNINGS.unrecognised };
    return { ok: true, options };
  } catch {
    return { ok: false, warning: STOCK_WARNINGS.silent };
  }
}

export type ConsumableDecision =
  | { kind: "reject"; error: string; options: ConsumableOption[] }
  | { kind: "warn"; warning: string }
  | { kind: "use"; option: ConsumableOption; sheets: number };

/** A listed pack must be chosen. No list, or Household not answering, still allows confirm. */
export function decideConsumableClaim(
  listed: { ok: true; options: ConsumableOption[] } | { ok: false; warning: string },
  productSlug: unknown,
  spec: ConsumableSpec,
): ConsumableDecision {
  if (!listed.ok) return { kind: "warn", warning: listed.warning };
  if (listed.options.length === 0) return { kind: "warn", warning: STOCK_WARNINGS.none(spec.sheets) };
  const slug = typeof productSlug === "string" ? productSlug.trim() : "";
  const option = listed.options.find((item) => item.product_slug === slug);
  if (!option) return { kind: "reject", error: "Choose which paper to use.", options: listed.options };
  return { kind: "use", option, sheets: spec.sheets };
}

export type ConsumableWriteResult =
  | { ok: true }
  | { ok: false; rejected: false; warning: string }
  | { ok: false; rejected: true; warning: string; error: string };

function refused(payload: unknown, fallback: string): string {
  const body = asRecord(payload);
  return asString(body?.error) ?? asString(body?.message) ?? fallback;
}

function useFailure(status: number, payload: unknown, whenDown: string, whenUnauthorised: string): ConsumableWriteResult {
  if (status === 401) return { ok: false, rejected: false, warning: whenUnauthorised };
  if (status === 400) return { ok: false, rejected: true, warning: whenDown, error: refused(payload, STOCK_WARNINGS.notPaper) };
  if (status === 404) return { ok: false, rejected: true, warning: whenDown, error: refused(payload, STOCK_WARNINGS.unknownProduct) };
  if (status === 409) return { ok: false, rejected: true, warning: whenDown, error: refused(payload, STOCK_WARNINGS.conflict) };
  return { ok: false, rejected: false, warning: whenDown };
}

export async function recordConsumableUse(
  inventory: HouseholdInventory | null,
  use: { category: string; product_slug: string; sheets: number; ref: string },
): Promise<ConsumableWriteResult> {
  if (!inventory?.url) return { ok: false, rejected: false, warning: STOCK_WARNINGS.unlinked };
  const path = consumablePath(use.category);
  if (!path) return { ok: false, rejected: false, warning: STOCK_WARNINGS.unmapped(use.category) };
  try {
    const response = await fetch(new URL(`${path}/use`, inventory.url), {
      method: "POST",
      headers: { ...householdAuthHeaders(inventory), "content-type": "application/json" },
      body: JSON.stringify({
        product_slug: use.product_slug,
        sheets: use.sheets,
        ref: use.ref,
        source: TICKETS_REWARD_SOURCE,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) return { ok: true };
    return useFailure(response.status, await readBody(response), STOCK_WARNINGS.notRecorded, STOCK_WARNINGS.unauthorised);
  } catch {
    return { ok: false, rejected: false, warning: STOCK_WARNINGS.notRecorded };
  }
}

export async function reverseConsumableUse(
  inventory: HouseholdInventory | null,
  use: { category: string; ref: string },
): Promise<ConsumableWriteResult> {
  if (!inventory?.url) return { ok: false, rejected: false, warning: STOCK_WARNINGS.notRestored };
  const path = consumablePath(use.category);
  if (!path) return { ok: false, rejected: false, warning: STOCK_WARNINGS.notRestored };
  try {
    const response = await fetch(new URL(`${path}/reverse`, inventory.url), {
      method: "POST",
      headers: { ...householdAuthHeaders(inventory), "content-type": "application/json" },
      body: JSON.stringify({ ref: use.ref }),
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) return { ok: true };
    return useFailure(response.status, await readBody(response), STOCK_WARNINGS.notRestored, STOCK_WARNINGS.unauthorisedRestore);
  } catch {
    return { ok: false, rejected: false, warning: STOCK_WARNINGS.notRestored };
  }
}
