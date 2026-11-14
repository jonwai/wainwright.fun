import type { ResolvedChildConfig } from "../../../packages/shared/scripts/resolve";
import type { Child } from "../../../packages/shared/scripts/config";
import { localAssetUrl, resolveKidApiBase } from "../../../packages/shared/scripts/api-base";
import { getDeviceToken } from "./deviceAuth";
import type { InternetCommand, InternetState } from "./internet";

/**
 * The home-network build (served by packages/local on the Mac): the server knows the child from
 * the device's IP address. No pairing, no device token is sent, and the hosted token stored on the
 * iPad is left alone (so moving back to hosted needs nothing on the iPads).
 */
export const LOCAL_MODE = import.meta.env.VITE_LOCAL_AUTH === "1";
/**
 * Empty on the home network: /kid/config and icons are loaded from the page's own host
 * (wainwright.fun, or a child's hostname once that name points at the Mac). An absolute
 * VITE_API_URL is ignored in this build so it cannot fall through to api.wainwright.fun.
 */
export const KID_API_URL = resolveKidApiBase(import.meta.env.VITE_API_URL, LOCAL_MODE);

/** Icon src. Hosted absolute icon URLs become paths on this server in local mode. */
export function assetUrl(url: string | null | undefined): string | undefined {
  return localAssetUrl(url, KID_API_URL, LOCAL_MODE);
}

export type KidChild = Omit<Child, "date_of_birth" | "restriction_overrides">;
export type KidConfig = Omit<ResolvedChildConfig, "child" | "restrictions"> & {
  child: KidChild;
};

export function extractPairingCode(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("c") ?? url.searchParams.get("code");
    if (fromQuery) return normalizeCode(fromQuery);
  } catch {
    // Not a URL — treat as a raw code.
  }
  const code = normalizeCode(trimmed);
  return code.length >= 6 ? code : null;
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function kidFetch(path: string, init: RequestInit, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = LOCAL_MODE ? null : token ?? getDeviceToken();
  if (auth) headers.set("Authorization", `Bearer ${auth}`);
  return fetch(`${KID_API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

export async function pairDevice(code: string): Promise<{ token: string; config: KidConfig }> {
  const response = await kidFetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalizeCode(code) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not pair this iPad");
  }
  return data as { token: string; config: KidConfig };
}

export async function fetchKidConfig(token?: string): Promise<KidConfig> {
  const response = await kidFetch("/kid/config", { method: "GET" }, token);
  if (LOCAL_MODE && response.status === 403) throw new Error("notSetUp");
  if (LOCAL_MODE && response.status === 401) throw new Error("pickChild");
  if (response.status === 401) {
    throw new Error("unpaired");
  }
  if (!response.ok) {
    throw new Error("Could not load this iPad's apps");
  }
  return response.json();
}

export async function fetchKidPreview(token: string): Promise<KidConfig> {
  const response = await kidFetch("/kid/config", { method: "GET" }, token);
  if (!response.ok) {
    throw new Error("This preview link is invalid or has expired");
  }
  return response.json();
}

export async function saveKidAvatar(avatar: string, token?: string): Promise<string> {
  const response = await kidFetch("/kid/avatar", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar }),
  }, token);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not save avatar");
  }
  return data.avatar as string;
}

export interface SantaOption {
  id: string;
  label: string;
  emoji: string;
  /** Child-like words for this choice, from the shared catalog. */
  phrase?: string;
}

export interface SantaQuestion {
  id: string;
  prompt: string;
  options: SantaOption[];
}

export interface SantaLetterRecord {
  id: string;
  submittedAt: string;
  answers: Record<string, { prompt: string; picks: SantaOption[]; favourite: string | null }>;
  ownLine: string | null;
  letterText: string;
  drawingPng: string | null;
}

export interface SantaFormState {
  open: boolean;
  child?: { id: string; name: string };
  /** Whole years from date of birth, or null when core.people has none. */
  age?: number | null;
  style?: "reading" | "tiles";
  maxPicks?: number;
  questions?: SantaQuestion[];
  latest?: SantaLetterRecord | null;
}

export async function fetchKidSanta(): Promise<SantaFormState> {
  const response = await kidFetch("/kid/santa", { method: "GET" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not load the letter");
  }
  return data as SantaFormState;
}

export async function sendKidSanta(body: {
  answers: Record<string, { picks: string[]; favourite: string | null }>;
  ownLine: string;
  drawing: string | null;
}): Promise<SantaLetterRecord> {
  const response = await kidFetch("/kid/santa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not send the letter");
  }
  return data.letter as SantaLetterRecord;
}

export async function fetchKidInternet(): Promise<InternetState> {
  const response = await kidFetch("/kid/internet", { method: "GET" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "internet controls unavailable");
  }
  return data as InternetState;
}

export async function setKidInternetMode(command: InternetCommand): Promise<InternetState> {
  const response = await kidFetch("/kid/internet/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409) {
    const reason = typeof data.reason === "string" ? data.reason : typeof data.error === "string" ? data.error : "Not now";
    throw new Error(reason);
  }
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "internet controls unavailable");
  }
  return data as InternetState;
}

export async function unpairDevice(): Promise<void> {
  await kidFetch("/kid/unpair", { method: "POST" }).catch(() => undefined);
}

export function profileDownloadUrl(token: string): string {
  if (LOCAL_MODE) return `${KID_API_URL}/kid/profile`;
  return `${KID_API_URL}/kid/profile?token=${encodeURIComponent(token)}`;
}

export interface LocalPerson {
  id: string;
  name: string;
  role: "child" | "parent";
}

/** Home network: who this device is, and (for a parent) the children to pick from. */
export async function fetchLocalViewer(): Promise<{ me: LocalPerson | null; child: LocalPerson | null; admin: boolean; children: LocalPerson[] }> {
  const response = await fetch(`${KID_API_URL}/api/local/whoami`, { credentials: "include" });
  if (!response.ok) throw new Error(response.status === 403 ? "notSetUp" : "Could not load");
  const data = await response.json();
  return {
    me: data.viewer?.me ?? null,
    child: data.viewer?.child ?? null,
    admin: data.viewer?.admin === true,
    children: ((data.people ?? []) as LocalPerson[]).filter((p) => p.role === "child"),
  };
}

/** Home network, parent's device: look at a child (null = pick again). */
export async function chooseLocalChild(childId: string | null): Promise<void> {
  const response = await fetch(`${KID_API_URL}/api/local/session`, {
    method: childId ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: childId ? JSON.stringify({ actAs: childId }) : undefined,
    credentials: "include",
  });
  if (!response.ok) throw new Error("Could not switch child");
}
