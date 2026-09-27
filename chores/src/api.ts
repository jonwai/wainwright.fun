/**
 * Chores API client — same device-token pattern as the Tickets app.
 */

const TOKEN_KEY = "wfk_device_token";

export const KID_API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export interface ChoreRoom {
  room_id: string;
  name: string;
  floor: number;
  carpeted: boolean;
  chores: KidChore[];
}

export interface KidChore {
  chore_id: string;
  target_type: "room" | "fixture" | "window" | "switch";
  target_id: string;
  room_id: string | null;
  title: string;
  /** Derived: current ticket reward (0 = not worth doing yet). */
  tickets: number;
  base_tickets: number;
  /** Derived: is someone's claim on this chore outstanding? */
  claimed: boolean;
}

export interface MyClaim {
  chore_id: string;
  task_id: string;
  title: string;
  claimed_at: string;
  done: boolean;
  completed_at: string | null;
}

export interface ChoresState {
  rooms: ChoreRoom[];
  mine: MyClaim[];
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

/** Normalises a raw or URL-form pairing code. */
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

export async function fetchChoresState(): Promise<ChoresState> {
  const response = await kidFetch("/kid/chores");
  if (response.status === 401) throw new Error("unpaired");
  if (!response.ok) throw new Error("Could not load your chores");
  return response.json();
}

export async function claimChore(
  choreId: string
): Promise<{ task_id: string; chore_id: string }> {
  const response = await kidFetch(`/kid/chores/${encodeURIComponent(choreId)}/claim`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not claim that chore");
  }
  return data;
}

export async function completeChore(
  choreId: string
): Promise<{ completion: { title: string; tickets: number }; total_tickets: number }> {
  const response = await kidFetch(`/kid/chores/${encodeURIComponent(choreId)}/complete`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not complete that chore");
  }
  return data;
}

export async function undoChore(choreId: string): Promise<{ removed: boolean }> {
  const response = await kidFetch(`/kid/chores/${encodeURIComponent(choreId)}/undo`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not undo that chore");
  }
  return data;
}
