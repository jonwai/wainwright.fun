/**
 * Tickets (tasks) API client.
 *
 * Auth: the same `wfk_device` cookie/localStorage token pattern as the
 * Snacks app — each iOS web clip has an isolated cookie jar, so the
 * Tickets clip pairs itself (see pairDevice).
 */

const TOKEN_KEY = "wfk_device_token";

export const KID_API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export interface KidTask {
  task_id: string;
  /** Set when this job comes from a board posting, else null. */
  board_id: string | null;
  title: string;
  description: string | null;
  ticket_reward: number;
  /** How this job recurs: once | daily | school_day | on_demand. */
  repeat: "once" | "daily" | "school_day" | "on_demand";
  /** Photo icon (/ticket-icons/…), shown next to the title. Null = none. */
  icon_url: string | null;
  /** Fallback emoji shown when there's no photo. Null = none. */
  emoji: string | null;
  /** How many times this task has been completed (all time). */
  completed_count: number;
  /** When it was last completed, or null. */
  completed_at: string | null;
  completed_by: "child" | "parent" | null;
  /** Derived: is this job done for the child right now? */
  done: boolean;
}

export interface TasksState {
  tasks: KidTask[];
  total_tickets: number;
}

export interface TaskHistoryEntry {
  task_id: string;
  title: string;
  completed_at: string;
  completed_by: "child" | "parent";
  tickets: number;
}

export interface KidReward {
  reward_id: string;
  title: string;
  description: string | null;
  ticket_cost: number;
  /** Photo icon (/ticket-icons/…), shown next to the title. Null = none. */
  icon_url: string | null;
  /** Fallback emoji shown when there's no photo. Null = none. */
  emoji: string | null;
  /** How redemptions of this reward are limited (null = unlimited). */
  limit: {
    limit_type: "unlimited" | "stock" | "period" | "snack_stock";
    stock_remaining: number | null;
    period: "week" | "month" | "summer" | "term" | "year" | null;
    /** True when the child already used this window's 1-per-period pick. */
    period_used: boolean;
    period_window: string | null;
  } | null;
}

export interface KidRedemption {
  redemption_id: string;
  reward_id: string;
  title: string;
  redeemed_at: string;
  tickets: number;
  status: "pending" | "claimed";
}

export interface RewardsState {
  rewards: KidReward[];
  spendable_tickets: number;
  redemptions: KidRedemption[];
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
 * isolated storage/cookie jar, so the Tickets clip pairs separately from
 * the main Wainwright app and the Snacks clip).
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

export async function fetchTasksState(): Promise<TasksState> {
  const response = await kidFetch("/kid/tasks");
  if (response.status === 401) throw new Error("unpaired");
  if (!response.ok) throw new Error("Could not load your jobs");
  return response.json();
}

export async function fetchTaskHistory(): Promise<TaskHistoryEntry[]> {
  const response = await kidFetch("/kid/tasks/history");
  if (!response.ok) throw new Error("Could not load your ticket history");
  const data = await response.json();
  return data.completions as TaskHistoryEntry[];
}

export async function completeTask(
  taskId: string
): Promise<{ completion: TaskHistoryEntry; total_tickets: number }> {
  const response = await kidFetch(`/kid/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not complete that job");
  }
  return data;
}

export async function undoTask(
  taskId: string
): Promise<{ removed: boolean; total_tickets: number }> {
  const response = await kidFetch(`/kid/tasks/${encodeURIComponent(taskId)}/undo`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not undo that job");
  }
  return data;
}

export async function fetchRewardsState(): Promise<RewardsState> {
  const response = await kidFetch("/kid/rewards");
  if (response.status === 401) throw new Error("unpaired");
  if (!response.ok) throw new Error("Could not load your rewards");
  return response.json();
}

export async function redeemReward(
  rewardId: string
): Promise<{ redemption: { reward_id: string; title: string; redeemed_at: string; tickets: number; status: string }; spendable_tickets: number }> {
  const response = await kidFetch(`/kid/rewards/${encodeURIComponent(rewardId)}/redeem`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not swap your tickets");
  }
  return data;
}

export async function refundReward(): Promise<{ refunded: boolean; spendable_tickets: number }> {
  const response = await kidFetch("/kid/rewards/refund", {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not refund that reward");
  }
  return data;
}
