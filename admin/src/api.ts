import { apiConfig } from "./config";
import { refreshSession, logout } from "./auth";

// ── Types ─────────────────────────────────────────────────────────

export interface Child {
  subdomain: string;
  name: string;
  date_of_birth: string;
  color: string;
  /** Emoji avatar chosen by the child (or set by an adult). */
  avatar?: string;
  /** When true (default), profile cannot be removed in Settings. */
  locked: boolean;
  /** Per-child restriction overrides (only for restrictions marked overridable). */
  restriction_overrides?: RestrictionOverride[];
  /** Bundle IDs of apps blocked for this child. Blocked apps still appear on
   *  the site (semi-transparent, unclickable) but are excluded from the
   *  profile whitelist so they cannot be downloaded. */
  blocked_apps?: string[];
}

export interface App {
  bundle_id: string;
  name: string;
  type: "app" | "system";
  app_store_url?: string;
  category?: string;
  icon?: string;
  /** Apple-hosted artwork URL (transient — set by App Store lookup, not persisted). */
  icon_url?: string;
  show_on_site?: boolean;
  min_age: number;
  enabled: boolean;
}

export interface Website {
  url: string;
  name: string;
  icon?: string;
  category?: string;
  min_age: number;
  enabled: boolean;
  /** When set, this website is personal to the named child subdomain and
   *  bypasses age-band assignment (min_age is ignored). */
  child_subdomain?: string;
}

export interface Theme {
  from_age: number;
  theme: string;
  subtitle: string;
  /** Per-age-band restriction overrides (only for restrictions marked overridable). */
  restriction_overrides?: RestrictionOverride[];
}

export type RestrictionType = "boolean" | "integer" | "real" | "string";

export interface Restriction {
  key: string;
  value: boolean | number | string;
  type: RestrictionType;
  /** Whether this restriction can be overridden per age band or child. */
  overridable?: boolean;
}

export interface RestrictionOverride {
  key: string;
  value: boolean | number | string;
}

// ── API helpers ───────────────────────────────────────────────────

/**
 * Fetch wrapper that handles 401 responses by refreshing the access token
 * and retrying once. If the refresh fails, the user is logged out.
 */
async function fetchWithAuth(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${apiConfig.baseUrl}/${path}`;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${accessToken}`,
  };

  const res = await fetch(url, { ...init, headers });

  if (res.status !== 401) return res;

  // 401 — try refreshing the token
  const refreshed = await refreshSession();
  if (!refreshed) {
    logout();
    throw new Error("Session expired. Please sign in again.");
  }

  // Retry with the new access token
  return fetch(url, {
    ...init,
    headers: { ...headers, Authorization: `Bearer ${refreshed.accessToken}` },
  });
}

async function apiGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetchWithAuth(accessToken, path);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

async function apiPut<T>(accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetchWithAuth(accessToken, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

async function apiDelete(accessToken: string, path: string): Promise<void> {
  const res = await fetchWithAuth(accessToken, path, { method: "DELETE" });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
}

// ── Children ──────────────────────────────────────────────────────

export const getChildren = (t: string) => apiGet<Child[]>(t, "children");
export const putChild = (t: string, subdomain: string, child: Partial<Child>) =>
  apiPut<Child>(t, `children/${encodeURIComponent(subdomain)}`, child);
export const deleteChild = (t: string, subdomain: string) =>
  apiDelete(t, `children/${encodeURIComponent(subdomain)}`);

// ── Apps ──────────────────────────────────────────────────────────

export const getApps = (t: string, type?: "app" | "system") =>
  apiGet<App[]>(t, type ? `apps?type=${type}` : "apps");
export const putApp = (t: string, bundleId: string, app: Partial<App>) =>
  apiPut<App>(t, `apps/${encodeURIComponent(bundleId)}`, app);
export const deleteApp = (t: string, bundleId: string) =>
  apiDelete(t, `apps/${encodeURIComponent(bundleId)}`);

// ── Websites ─────────────────────────────────────────────────────

export const getWebsites = (t: string) => apiGet<Website[]>(t, "websites");
export const putWebsite = (t: string, url: string, website: Partial<Website>) =>
  apiPut<Website>(t, `websites/${encodeURIComponent(url)}`, website);
export const deleteWebsite = (t: string, url: string) =>
  apiDelete(t, `websites/${encodeURIComponent(url)}`);

// ── Themes ───────────────────────────────────────────────────────

export const getThemes = (t: string) => apiGet<Theme[]>(t, "themes");
export const putTheme = (t: string, fromAge: number, theme: Partial<Theme>) =>
  apiPut<Theme>(t, `themes/${fromAge}`, theme);
export const deleteTheme = (t: string, fromAge: number) =>
  apiDelete(t, `themes/${fromAge}`);

// ── Restrictions ─────────────────────────────────────────────────

export const getRestrictions = (t: string) => apiGet<Restriction[]>(t, "restrictions");
export const putRestriction = (t: string, key: string, restriction: Partial<Restriction>) =>
  apiPut<Restriction>(t, `restrictions/${encodeURIComponent(key)}`, restriction);
export const deleteRestriction = (t: string, key: string) =>
  apiDelete(t, `restrictions/${encodeURIComponent(key)}`);

// ── Budgets ────────────────────────────────────────────────────────

export interface Budget {
  budget_id: string;
  name: string;
  school_day_amount_pence: Record<string, number>;
  non_school_day_amount_pence: Record<string, number>;
  /** Product slugs selectable in the picker (allowlist — a snack must be
   * explicitly ticked in the admin panel to appear). */
  included_products: string[];
  /** Date balance carry-over starts from; null = each day stands alone. */
  rollover_start_date?: string | null;
  updated_at?: string;
}

export interface BudgetSelection {
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number | null;
  selectedAt: string;
  selectedBy: "child" | "parent";
}

export interface BudgetSelectionRow {
  child_subdomain: string;
  budget_day: string;
  date: string;
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
  included?: boolean;
}

export interface BudgetBalance {
  budget_id: string;
  child_subdomain: string;
  date: string;
  allowance_pence: number;
  adjustments_pence: number;
  spent_pence: number;
  remaining_pence: number;
  carried_pence?: number;
}

export interface BudgetTransaction {
  transaction_id: string;
  budget_id: string;
  child_subdomain: string;
  date: string;
  kind: "spend" | "refund" | "adjustment";
  amount_pence: number;
  balance_after_pence: number;
  description: string | null;
  by: "child" | "parent";
  created_at: string;
}

export const getBudgets = (t: string) => apiGet<Budget[]>(t, "budgets");
export const putBudget = (t: string, budgetId: string, budget: Partial<Budget>) =>
  apiPut<Budget>(t, `budgets/${encodeURIComponent(budgetId)}`, budget);
export const deleteBudget = (t: string, budgetId: string) =>
  apiDelete(t, `budgets/${encodeURIComponent(budgetId)}`);
export const getBudgetSelections = (t: string, budgetId: string) =>
  apiGet<BudgetSelectionRow[]>(t, `budgets/${encodeURIComponent(budgetId)}/selections`);
export const getBudgetProducts = (t: string, budgetId: string) =>
  apiGet<{ products: BudgetProduct[] }>(t, `budgets/${encodeURIComponent(budgetId)}/products`);

export async function addBudgetSelection(
  accessToken: string,
  budgetId: string,
  childSubdomain: string,
  productSlug: string,
  date?: string
): Promise<{ selection: BudgetSelection }> {
  const res = await fetchWithAuth(
    accessToken,
    `budgets/${encodeURIComponent(budgetId)}/children/${encodeURIComponent(childSubdomain)}/add`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productSlug, date }),
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export async function removeBudgetSelection(
  accessToken: string,
  budgetId: string,
  childSubdomain: string,
  productSlug: string,
  selectedAt: string,
  date?: string
): Promise<{ removed: BudgetSelection; remaining_pence: number }> {
  const res = await fetchWithAuth(
    accessToken,
    `budgets/${encodeURIComponent(budgetId)}/children/${encodeURIComponent(childSubdomain)}/remove`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productSlug, selectedAt, date }),
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

// ── Child snack balance (admin) ────────────────────────────────

export const getChildBalance = (
  t: string, budgetId: string, childSubdomain: string, date?: string
) =>
  apiGet<BudgetBalance>(
    t,
    `budgets/${encodeURIComponent(budgetId)}/children/${encodeURIComponent(childSubdomain)}/balance${date ? `?date=${encodeURIComponent(date)}` : ""}`
  );

export async function adjustChildBalance(
  accessToken: string,
  budgetId: string,
  childSubdomain: string,
  options: { date?: string; newBalancePence?: number; deltaPence?: number; note?: string }
): Promise<{ balance: BudgetBalance; transaction: BudgetTransaction | null; unchanged?: boolean }> {
  const res = await fetchWithAuth(
    accessToken,
    `budgets/${encodeURIComponent(budgetId)}/children/${encodeURIComponent(childSubdomain)}/balance`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: options.date,
        new_balance_pence: options.newBalancePence,
        delta_pence: options.deltaPence,
        note: options.note,
      }),
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export const getChildTransactions = (
  t: string, budgetId: string, childSubdomain: string, limit?: number
) =>
  apiGet<{ transactions: BudgetTransaction[] }>(
    t,
    `budgets/${encodeURIComponent(budgetId)}/children/${encodeURIComponent(childSubdomain)}/transactions${limit ? `?limit=${limit}` : ""}`
  );

// ── Tasks (Tickets app) ────────────────────────────────────────

export interface Task {
  task_id: string;
  title: string;
  description: string | null;
  ticket_reward: number;
  /** Child subdomains this task is for. Empty = every child. */
  assigned_to: string[];
  /** Icon filename under ticket-icons/ in the site bucket. */
  icon: string | null;
  /** Fallback emoji shown when there's no photo. */
  emoji: string | null;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TaskCompletion {
  child_subdomain: string;
  task_completion: string;
  task_id: string;
  completed_at: string;
  completed_by: "child" | "parent";
  tickets: number;
  /** Bonus awards only (task_id "bonus"): the label shown as the title. */
  label?: string | null;
}

export type RewardLimitType = "unlimited" | "stock" | "period" | "snack_stock";
export type RewardPeriod = "week" | "month" | "summer" | "term" | "year";

export interface Reward {
  reward_id: string;
  title: string;
  description: string | null;
  ticket_cost: number;
  /** What the prize actually costs, in whole pence. Admin-only. */
  cost_pence: number | null;
  /** Icon filename under ticket-icons/ in the site bucket. */
  icon: string | null;
  /** Fallback emoji shown when there's no photo. */
  emoji: string | null;
  /** How redemptions are limited. */
  limit_type: RewardLimitType;
  /** stock-pool rewards: how many are left in the shared family pool. */
  stock_remaining: number | null;
  /** period-capped rewards: the window length (1 per window per child). */
  period: RewardPeriod | null;
  /** snack-stock rewards: the Wainsbury's product slug to track. */
  snack_product_slug: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RewardRedemption {
  child_subdomain: string;
  redemption_id: string;
  reward_id: string;
  redeemed_at: string;
  redeemed_by: "child" | "parent";
  tickets: number;
  status: "pending" | "claimed";
  claimed_at?: string;
}

export const getTasks = (t: string) => apiGet<Task[]>(t, "tasks");
export const putTask = (t: string, taskId: string, task: Partial<Task>) =>
  apiPut<Task>(t, `tasks/${encodeURIComponent(taskId)}`, task);
export const deleteTask = (t: string, taskId: string) =>
  apiDelete(t, `tasks/${encodeURIComponent(taskId)}`);
export const getTaskCompletions = (t: string) =>
  apiGet<TaskCompletion[]>(t, "tasks/completions");

export async function completeTaskForChild(
  accessToken: string,
  taskId: string,
  childSubdomain: string
): Promise<{ completion: { task_id: string; title: string; completed_at: string; completed_by: string; tickets: number } }> {
  const res = await fetchWithAuth(
    accessToken,
    `tasks/${encodeURIComponent(taskId)}/children/${encodeURIComponent(childSubdomain)}/complete`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export async function undoTaskForChild(
  accessToken: string,
  taskId: string,
  childSubdomain: string
): Promise<{ removed: boolean }> {
  const res = await fetchWithAuth(
    accessToken,
    `tasks/${encodeURIComponent(taskId)}/children/${encodeURIComponent(childSubdomain)}/undo`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

/** Awards bonus tickets to a child with no task attached (e.g. "Happy Birthday"). */
export async function awardBonusTickets(
  accessToken: string,
  childSubdomain: string,
  options: { label: string; tickets: number }
): Promise<{ award: { label: string; tickets: number; completed_at: string }; total_tickets: number }> {
  const res = await fetchWithAuth(
    accessToken,
    `tasks/bonus/children/${encodeURIComponent(childSubdomain)}/award`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: options.label, tickets: options.tickets }),
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

// ── Job board (Tickets app) ──────────────────────────────

export type BoardRepeat = "once" | "daily" | "school_day" | "on_demand";
export type BoardCompletionMode = "each_child" | "first_done";

export interface BoardEntry {
  board_id: string;
  task_id: string;
  repeat: BoardRepeat;
  ticket_reward: number;
  /** Per-posting audience override. Empty = the task's own list. */
  assigned_to: string[];
  /** on_demand only: the on/off switch. */
  posted: boolean;
  posted_at: string | null;
  completion_mode: BoardCompletionMode;
  created_at?: string;
  updated_at?: string;
}

export const getBoard = (t: string) => apiGet<BoardEntry[]>(t, "board");
export const putBoardEntry = (t: string, boardId: string, entry: Partial<BoardEntry>) =>
  apiPut<BoardEntry>(t, `board/${encodeURIComponent(boardId)}`, entry);
export const deleteBoardEntry = (t: string, boardId: string) =>
  apiDelete(t, `board/${encodeURIComponent(boardId)}`);

// ── Rewards ───────────────────────────────────────────────────────

export const getRewards = (t: string) => apiGet<Reward[]>(t, "rewards");
export const putReward = (t: string, rewardId: string, reward: Partial<Reward>) =>
  apiPut<Reward>(t, `rewards/${encodeURIComponent(rewardId)}`, reward);
export const deleteReward = (t: string, rewardId: string) =>
  apiDelete(t, `rewards/${encodeURIComponent(rewardId)}`);
export const getRewardRedemptions = (t: string) =>
  apiGet<RewardRedemption[]>(t, "rewards/redemptions");

/**
 * Uploads a photo for a task/reward card. The file is resized client-side
 * to a 224×224 square (scale-to-cover, then center-crop) via canvas and
 * re-encoded as webp before upload, so full-size phone photos never hit
 * the API. Gifs and SVGs pass through untouched (canvas would flatten
 * animation / rasterise vectors). The result is base64-encoded and POSTed
 * as JSON to /tasks/icons; the API stores it in the site bucket under
 * ticket-icons/ and returns the new icon filename (to be saved on the
 * task/reward row via PUT).
 */
const ICON_SIZE = 224;

async function resizeToSquare(file: File): Promise<{ blob: Blob; type: string }> {
  // Animated gifs and vectors keep their original bytes.
  if (file.type === "image/gif" || file.type === "image/svg+xml") {
    return { blob: file, type: file.type };
  }
  const bitmap = await createImageBitmap(file);
  try {
    // Scale to cover 224×224, then crop the overflow — same result as
    // sharp's resize(224, 224, { fit: "cover" }).
    const scale = Math.max(ICON_SIZE / bitmap.width, ICON_SIZE / bitmap.height);
    const sw = Math.min(bitmap.width, Math.round(ICON_SIZE / scale));
    const sh = Math.min(bitmap.height, Math.round(ICON_SIZE / scale));
    const sx = Math.round((bitmap.width - sw) / 2);
    const sy = Math.round((bitmap.height - sh) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, type: file.type || "image/png" };
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, ICON_SIZE, ICON_SIZE);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.9)
    );
    if (!blob) return { blob: file, type: file.type || "image/png" };
    return { blob, type: "image/webp" };
  } finally {
    bitmap.close();
  }
}

export async function uploadTicketIcon(
  accessToken: string,
  file: File
): Promise<{ icon: string; icon_url: string }> {
  const { blob, type } = await resizeToSquare(file);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip the data URL prefix: "data:image/png;base64,XXXX" → "XXXX"
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
  const res = await fetchWithAuth(accessToken, "tasks/icons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      content_type: type,
      data,
    }),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status}) ${message}`.slice(0, 200));
  }
  return res.json();
}

export async function redeemRewardForChild(
  accessToken: string,
  rewardId: string,
  childSubdomain: string
): Promise<{ redemption: { reward_id: string; title: string; redeemed_at: string; tickets: number; status: string } }> {
  const res = await fetchWithAuth(
    accessToken,
    `rewards/${encodeURIComponent(rewardId)}/children/${encodeURIComponent(childSubdomain)}/redeem`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export async function refundRewardForChild(
  accessToken: string,
  childSubdomain: string,
  redemptionId: string
): Promise<{ refunded: boolean }> {
  const res = await fetchWithAuth(
    accessToken,
    `rewards/redemptions/${encodeURIComponent(childSubdomain)}/${encodeURIComponent(redemptionId)}/refund`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export async function claimRewardForChild(
  accessToken: string,
  childSubdomain: string,
  redemptionId: string
): Promise<{ claimed: boolean }> {
  const res = await fetchWithAuth(
    accessToken,
    `rewards/redemptions/${encodeURIComponent(childSubdomain)}/${encodeURIComponent(redemptionId)}/claim`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

// ── Term dates ─────────────────────────────────────────────────────

export interface Term {
  name: string;
  opens: string;
  closes: string;
  half_term_start: string | null;
  half_term_end: string | null;
}

export interface TermDatesYear {
  academic_year: string;
  terms: Term[];
  updated_at?: string;
}

export const getTermDates = (t: string) => apiGet<TermDatesYear[]>(t, "term-dates");
export const putTermDates = (t: string, academicYear: string, year: Partial<TermDatesYear>) =>
  apiPut<TermDatesYear>(t, `term-dates/${encodeURIComponent(academicYear)}`, year);
export const deleteTermDates = (t: string, academicYear: string) =>
  apiDelete(t, `term-dates/${encodeURIComponent(academicYear)}`);

// ── Config ────────────────────────────────────────────────────────

export async function getConfig(accessToken: string): Promise<string> {
  const res = await fetchWithAuth(accessToken, "config");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  return data.content;
}

// ── Rebuild ──────────────────────────────────────────────────────

export async function triggerRebuild(accessToken: string): Promise<void> {
  const res = await fetchWithAuth(accessToken, "rebuild", { method: "POST" });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
}

// ── Icons ────────────────────────────────────────────────────────

export interface IconsList {
  appIcons: string[];
  websiteIcons: string[];
  systemIcons: string[];
}

export const getIcons = (t: string) => apiGet<IconsList>(t, "icons");

export interface PairingSession {
  code: string;
  expires_at: number;
  pairing_url: string;
  child: {
    subdomain: string;
    name: string;
    avatar?: string;
    color: string;
  };
}

export async function createPairingSession(
  accessToken: string,
  subdomain: string,
): Promise<PairingSession> {
  const res = await fetchWithAuth(accessToken, `children/${encodeURIComponent(subdomain)}/pair`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export interface PreviewSession {
  preview_url: string;
  expires_at: number;
  child: {
    subdomain: string;
    name: string;
    avatar?: string;
    color: string;
  };
}

export async function createPreviewSession(
  accessToken: string,
  subdomain: string,
): Promise<PreviewSession> {
  const res = await fetchWithAuth(accessToken, `children/${encodeURIComponent(subdomain)}/preview`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}
