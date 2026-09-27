import type { ResolvedChildConfig } from "../../scripts/resolve";
import type { Child } from "../../scripts/config";
import { getDeviceToken } from "./deviceAuth";

export const KID_API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

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
  const auth = token ?? getDeviceToken();
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

export async function unpairDevice(): Promise<void> {
  await kidFetch("/kid/unpair", { method: "POST" }).catch(() => undefined);
}

export function profileDownloadUrl(token: string): string {
  return `${KID_API_URL}/kid/profile?token=${encodeURIComponent(token)}`;
}
