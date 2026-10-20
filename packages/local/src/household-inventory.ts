/**
 * Printer paper (and any other Household consumable) used when a parent confirms
 * a Tickets reward.
 *
 * Household does not have this API yet. These paths and bodies are provisional
 * and live in one place so they can change without touching the admin UI.
 * Base URL is HOUSEHOLD_URL, usually http://household:43126. No token.
 *
 *   GET  {HOUSEHOLD_URL}/api/inventory/options?category={category}&min_sheets={sheets}
 *        200 [{ product_slug, name, sheets_remaining }]
 *        A body of { options: [...] } is also accepted.
 *        Tickets drops anything below min_sheets and sorts the fullest pack first.
 *        Household should already convert pack counts (on_hand) into sheets_remaining.
 *
 *   POST {HOUSEHOLD_URL}/api/inventory/use
 *        { product_slug, sheets, ref: redemption_id, source: "tickets-reward" }
 *        Any 2xx counts as recorded.
 *
 *   POST {HOUSEHOLD_URL}/api/inventory/reverse
 *        { ref: redemption_id, source: "tickets-reward" }
 *        Undoes the use with that ref. Any 2xx counts as reversed.
 *
 * Which reward uses this is tickets.rewards.extra.household_consumable:
 * { category: "printer-paper", sheets: 10 }. The reward id is not special.
 */
export const HOUSEHOLD_INVENTORY_PATHS = {
  options: "/api/inventory/options",
  use: "/api/inventory/use",
  reverse: "/api/inventory/reverse",
} as const;

export const TICKETS_REWARD_SOURCE = "tickets-reward";

export const STOCK_WARNINGS = {
  unlinked: "Household isn't linked, so the paper stock wasn't reduced.",
  silent: "Household didn't answer, so the paper stock wasn't reduced.",
  unrecognised: "Household's paper list wasn't recognised, so the stock wasn't reduced.",
  none: (sheets: number) => `No paper has at least ${sheets} sheets left, so the stock wasn't reduced.`,
  notRecorded: "Claimed, but Household didn't record the sheets used, so the stock wasn't reduced.",
  notRestored: "Refunded, but Household didn't put the sheets back.",
} as const;

export interface HouseholdInventory {
  /** Household base URL, no trailing slash. */
  url: string;
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
  source: typeof TICKETS_REWARD_SOURCE;
  recorded: boolean;
}

export function householdInventoryFromEnv(env: NodeJS.ProcessEnv = process.env): HouseholdInventory | null {
  const url = (env.HOUSEHOLD_URL ?? "").trim().replace(/\/$/, "");
  return url ? { url } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
  if (!product_slug || !ref || !Number.isInteger(sheets) || sheets < 1) return null;
  return { product_slug, name, sheets, ref, source: TICKETS_REWARD_SOURCE, recorded: true };
}

function optionOf(value: unknown): ConsumableOption | null {
  const row = asRecord(value);
  const product_slug = typeof row?.product_slug === "string" ? row.product_slug.trim() : "";
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  const sheets = Number(row?.sheets_remaining);
  if (!product_slug || !name || !Number.isFinite(sheets)) return null;
  return { product_slug, name, sheets_remaining: sheets };
}

/** Accept a bare array or `{ options: [...] }`. Anything else is unrecognised. */
export function parseConsumableOptions(payload: unknown, minSheets: number): ConsumableOption[] | null {
  const body = asRecord(payload);
  const list = Array.isArray(payload) ? payload : Array.isArray(body?.options) ? body.options : null;
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
  try {
    const url = new URL(HOUSEHOLD_INVENTORY_PATHS.options, inventory.url);
    url.searchParams.set("category", spec.category);
    url.searchParams.set("min_sheets", String(spec.sheets));
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
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

export async function recordConsumableUse(
  inventory: HouseholdInventory | null,
  use: { product_slug: string; sheets: number; ref: string },
): Promise<{ ok: true } | { ok: false; warning: string }> {
  if (!inventory?.url) return { ok: false, warning: STOCK_WARNINGS.unlinked };
  try {
    const response = await fetch(new URL(HOUSEHOLD_INVENTORY_PATHS.use, inventory.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        product_slug: use.product_slug,
        sheets: use.sheets,
        ref: use.ref,
        source: TICKETS_REWARD_SOURCE,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { ok: false, warning: STOCK_WARNINGS.notRecorded };
    return { ok: true };
  } catch {
    return { ok: false, warning: STOCK_WARNINGS.notRecorded };
  }
}

export async function reverseConsumableUse(
  inventory: HouseholdInventory | null,
  ref: string,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  if (!inventory?.url) return { ok: false, warning: STOCK_WARNINGS.notRestored };
  try {
    const response = await fetch(new URL(HOUSEHOLD_INVENTORY_PATHS.reverse, inventory.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ref, source: TICKETS_REWARD_SOURCE }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { ok: false, warning: STOCK_WARNINGS.notRestored };
    return { ok: true };
  } catch {
    return { ok: false, warning: STOCK_WARNINGS.notRestored };
  }
}
