/**
 * Snack budgets API client.
 *
 * Auth: the same `wfk_device` cookie the main app sets on api.wainwright.fun
 * (sent via credentials: "include"). Falls back to a localStorage token for
 * dev servers where the cookie may be absent.
 */

const TOKEN_KEY = "wfk_device_token";

export const KID_API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export interface BudgetSelection {
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number | null;
  selectedAt: string;
  selectedBy: "child" | "parent";
}

export interface BudgetState {
  budget_id: string;
  name: string;
  date: string;
  /**
   * Presentation mode: "count" for younger children (told how many snacks they
   * get, every snack costs one pick) or "pence" (money, as before).
   */
  mode: "pence" | "count";
  allowance_pence: number;
  /** Parent adjustments on top of the day's allowance (from the transaction log). */
  adjustments_pence: number;
  spent_pence: number;
  remaining_pence: number;
  /** Count mode only: whole 5p coins left today (null in pence mode). */
  coins_remaining: number | null;
  /** Deprecated: count mode now uses coins_remaining; always null. */
  snacks_remaining?: number | null;
  /** Pennies carried over from previous days (present when rollover is on; not shown to children). */
  carried_pence?: number;
  selections: BudgetSelection[];
}

export interface BudgetProduct {
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number | null;
  portionsLeft: number;
  portionLabel: string | null;
  /** Earliest use-by date (YYYY-MM-DD) across the product's inventory rows. */
  useByDate?: string | null;
  /** True when the product is on or past its use-by date — charged at half price. */
  halfPrice?: boolean;
}

export interface BudgetHistoryDay {
  date: string;
  selections: BudgetSelection[];
}

function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setDeviceToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing — the cookie (set by /pair) still carries the session.
  }
}

function clearDeviceToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

/** Normalises a raw or URL-form pairing code (e.g. "https://wainwright.fun/?c=ABCD2345"). */
export function extractPairingCode(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("c") ?? url.searchParams.get("code");
    if (fromQuery) return fromQuery.toUpperCase().replace(/[^A-Z0-9]/g, "");
  } catch {
    // Not a URL — treat as a raw code.
  }
  const code = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 6 ? code : null;
}

/**
 * Pairs this app to a child using a grown-up's pairing code. The token is
 * stored in this app's own localStorage (web clips on iOS each have an
 * isolated storage/cookie jar, so the Snacks clip pairs separately from
 * the main Wainwright app).
 */
export async function pairDevice(code: string): Promise<void> {
  const normalized = extractPairingCode(code);
  if (!normalized) throw new Error("Enter the pairing code from a grown-up");
  const response = await fetch(`${KID_API_URL}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalized }),
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not pair this iPad");
  }
  if (typeof data.token === "string") setDeviceToken(data.token);
}

export async function unpairDevice(): Promise<void> {
  try {
    await kidFetch("/kid/unpair", { method: "POST" });
  } catch {
    // Best effort — clear the local token regardless.
  }
  clearDeviceToken();
}

async function kidFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getDeviceToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(`${KID_API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

export async function fetchBudgetState(budgetId: string, date?: string): Promise<BudgetState> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  const response = await kidFetch(`/kid/budget/${budgetId}${query}`);
  if (response.status === 401) throw new Error("unpaired");
  if (!response.ok) throw new Error("Could not load your snacks");
  return response.json();
}

export async function fetchBudgetProducts(budgetId: string): Promise<BudgetProduct[]> {
  const response = await kidFetch(`/kid/budget/${budgetId}/products`);
  if (!response.ok) throw new Error("Could not load the snack list");
  const data = await response.json();
  return data.products as BudgetProduct[];
}

export async function fetchBudgetHistory(budgetId: string): Promise<BudgetHistoryDay[]> {
  const response = await kidFetch(`/kid/budget/${budgetId}/history`);
  if (!response.ok) throw new Error("Could not load your snack history");
  const data = await response.json();
  return data.days as BudgetHistoryDay[];
}

export async function selectBudgetItem(
  budgetId: string,
  productSlug: string,
  date?: string
): Promise<{ selection: BudgetSelection; remaining_pence: number }> {
  const response = await kidFetch(`/kid/budget/${budgetId}/select`, {
    method: "POST",
    body: JSON.stringify({ productSlug, date }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not pick that snack");
  }
  return data;
}

export async function unselectBudgetItem(
  budgetId: string,
  productSlug: string,
  selectedAt: string,
  date?: string
): Promise<{ removed: boolean; remaining_pence: number }> {
  const response = await kidFetch(`/kid/budget/${budgetId}/unselect`, {
    method: "POST",
    body: JSON.stringify({ productSlug, selectedAt, date }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not put that snack back");
  }
  return data;
}

export function formatPence(pence: number | null): string {
  if (pence === null) return "—";
  if (pence === 0) return "free";
  const pounds = pence / 100;
  return pounds >= 1 ? `£${pounds.toFixed(2)}` : `${pence}p`;
}
