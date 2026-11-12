/**
 * Home Assistant client for homework / internet mode.
 *
 * HA owns the modes, the timers and the UK-local midnight reset. This process only
 * reads a long-lived token from HA_TOKEN_FILE and calls HA. The token never goes to
 * a child's browser. A missing token file or a network failure is an unavailable
 * result, not a throw.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const HA_DEFAULT_URL = "https://home.wainwright.fun";
export const INTERNET_CONTROLS_UNAVAILABLE = "internet controls unavailable";
const HA_TIMEOUT_MS = 5000;

export interface HaResult {
  status: number;
  body: unknown;
  /** Token file missing, HA redirected, or HA could not be reached. */
  unavailable?: boolean;
}

export interface HaClient {
  getKid(childId: string): Promise<HaResult>;
  setMode(childId: string, body: Record<string, unknown>): Promise<HaResult>;
}

export function unavailableResult(): HaResult {
  return { status: 503, unavailable: true, body: { error: INTERNET_CONTROLS_UNAVAILABLE } };
}

/** Trimmed file contents, or "" when the path is unset, empty, or unreadable. */
export function readTokenFile(file: string | undefined | null): string {
  const path = (file ?? "").trim();
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** The credential from `Authorization: Bearer <token>`, or "" when it is absent or malformed. */
export function bearerToken(header: string | undefined | null): string {
  if (!header) return "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? "";
}

/**
 * Constant-time string compare. An empty expected or provided token never matches,
 * including the case where the token file is missing and the header is missing too.
 */
export function tokensMatch(expected: string, provided: string): boolean {
  if (!expected || !provided) {
    const dummy = Buffer.alloc(32);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { reason: trimmed.slice(0, 300) };
  }
}

export async function haFetch(
  base: string,
  path: string,
  init: { method: string; body?: string },
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<HaResult> {
  const token = readTokenFile(env.HA_TOKEN_FILE);
  if (!token) return unavailableResult();
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method,
      redirect: "manual",
      signal: AbortSignal.timeout(HA_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
      },
      body: init.body,
    });
    // Do not follow a redirect: that would send the token to another host.
    if (response.status >= 300 && response.status < 400) return unavailableResult();
    const text = await response.text();
    return { status: response.status, body: parseBody(text) };
  } catch {
    return unavailableResult();
  }
}

export function haClientFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): HaClient {
  const configured = (env.HA_URL ?? "").trim().replace(/\/$/, "");
  const base = configured || HA_DEFAULT_URL;
  return {
    getKid: (childId) => haFetch(base, `/api/wainwright_fun/kids/${encodeURIComponent(childId)}`, { method: "GET" }, env, fetchImpl),
    setMode: (childId, body) =>
      haFetch(
        base,
        `/api/wainwright_fun/kids/${encodeURIComponent(childId)}/mode`,
        { method: "POST", body: JSON.stringify(body) },
        env,
        fetchImpl,
      ),
  };
}
