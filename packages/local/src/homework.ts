/**
 * Homework-mode data for the launcher and for Home Assistant.
 *
 * HA blocks the homework hostnames outside homework mode. This server tells HA which
 * hostnames those are, and proxies each iPad's mode changes. The child is always the
 * device (or a parent's act-as choice), never a field in the body. Joanna has no iPad;
 * she and anyone else HA does not know get no controls.
 */
import type { HaClient, HaResult } from "./ha.js";
import { INTERNET_CONTROLS_UNAVAILABLE } from "./ha.js";
import type { Queryable } from "./pg-ddb.js";

export const INTERNET_CHILD_IDS = ["hannah", "lydia", "zoe", "ethan"] as const;
export const DEFAULT_ALLOWANCE_SECONDS = 3600;
export const MAX_ALLOWANCE_SECONDS = 24 * 60 * 60;

const INTERNET_CHILDREN = new Set<string>(INTERNET_CHILD_IDS);

export function isInternetChild(childId: string): boolean {
  return INTERNET_CHILDREN.has(childId);
}

/**
 * Hostname of a website URL, lower-cased, without a trailing dot.
 * Repairs a single slash after the scheme (`https:/host/`) and ignores anything we cannot parse.
 */
export function websiteHostname(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  const candidates: string[] = [];
  const repaired = raw.replace(/^([a-z][a-z0-9+.-]*):\/(?!\/)/i, "$1://");
  if (repaired !== raw) candidates.push(repaired);
  candidates.push(raw);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(repaired)) candidates.push(`https://${repaired}`);
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
      if (host) return host;
    } catch {
      // try the next repair
    }
  }
  return null;
}

export interface HomeworkSiteRow {
  name: string;
  url: string;
  min_age: number;
  child_id: string | null;
}

export interface HomeworkChildRow {
  id: string;
  allowance_seconds: number;
}

export interface HomeworkDomains {
  domains: string[];
  sites: { name: string; url: string; domain: string; min_age: number; child_id: string | null }[];
  children: Record<string, { allowance_seconds: number }>;
  updated_at: string;
}

export function buildHomeworkDomains(sites: HomeworkSiteRow[], children: HomeworkChildRow[], now: Date): HomeworkDomains {
  const listed: HomeworkDomains["sites"] = [];
  const domains = new Set<string>();
  for (const site of sites) {
    const domain = websiteHostname(site.url);
    if (!domain) continue;
    domains.add(domain);
    listed.push({
      name: site.name,
      url: site.url,
      domain,
      min_age: site.min_age,
      child_id: site.child_id,
    });
  }
  const byChild: HomeworkDomains["children"] = {};
  for (const child of children) byChild[child.id] = { allowance_seconds: child.allowance_seconds };
  return {
    domains: [...domains].sort(),
    sites: listed,
    children: byChild,
    updated_at: now.toISOString(),
  };
}

export async function allowanceSeconds(db: Queryable, childId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(s.allowance_seconds, $2)::int AS allowance_seconds
     FROM core.people p
     LEFT JOIN kids.child_settings s ON s.child_id = p.id
     WHERE p.id = $1 AND p.role = 'child'`,
    [childId, DEFAULT_ALLOWANCE_SECONDS],
  );
  const n = Number(rows[0]?.allowance_seconds ?? DEFAULT_ALLOWANCE_SECONDS);
  if (!Number.isInteger(n) || n < 0 || n > MAX_ALLOWANCE_SECONDS) return DEFAULT_ALLOWANCE_SECONDS;
  return n;
}

export async function loadHomeworkDomains(db: Queryable, now = new Date()): Promise<HomeworkDomains> {
  const sites = await db.query(
    `SELECT name, url, min_age, child_id
     FROM kids.websites
     WHERE enabled AND homework
     ORDER BY name, url`,
  );
  const children = await db.query(
    `SELECT p.id, COALESCE(s.allowance_seconds, $1)::int AS allowance_seconds
     FROM core.people p
     LEFT JOIN kids.child_settings s ON s.child_id = p.id
     WHERE p.role = 'child'
     ORDER BY p.sort_order, p.id`,
    [DEFAULT_ALLOWANCE_SECONDS],
  );
  return buildHomeworkDomains(
    sites.rows.map((row) => ({
      name: String(row.name ?? ""),
      url: String(row.url ?? ""),
      min_age: Number(row.min_age ?? 0),
      child_id: row.child_id == null ? null : String(row.child_id),
    })),
    children.rows.map((row) => ({
      id: String(row.id),
      allowance_seconds: Number(row.allowance_seconds),
    })),
    now,
  );
}

/** One of the four HA mode bodies. Internet allowance always comes from the database. */
export function internetModeCommand(
  input: Record<string, unknown>,
  allowance: number,
): { ok: true; body: Record<string, unknown> } | { ok: false } {
  const mode = input.mode;
  const declared = input.homework_declared;
  if (declared !== undefined && mode !== undefined) return { ok: false };
  if (mode === undefined && declared === "skipped") return { ok: true, body: { homework_declared: "skipped" } };
  if (declared !== undefined) return { ok: false };
  if (mode === "homework" || mode === "off") return { ok: true, body: { mode } };
  if (mode === "internet") return { ok: true, body: { mode: "internet", allowance_seconds: allowance } };
  return { ok: false };
}

export function passHaReason(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return { ...(body as Record<string, unknown>) };
  if (typeof body === "string" && body.trim()) return { reason: body.trim() };
  return { reason: "That change isn't allowed" };
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

function unavailableRoute(): RouteResult {
  return { status: 503, body: { error: INTERNET_CONTROLS_UNAVAILABLE } };
}

function hiddenChild(): RouteResult {
  return { status: 200, body: { available: false } };
}

async function presentKid(db: Queryable, childId: string, result: HaResult): Promise<RouteResult> {
  if (result.unavailable) return unavailableRoute();
  if (result.status === 404) return hiddenChild();
  if (result.status === 409) return { status: 409, body: passHaReason(result.body) };
  if (result.status !== 200) return unavailableRoute();
  const body = result.body && typeof result.body === "object" && !Array.isArray(result.body) ? { ...(result.body as Record<string, unknown>) } : {};
  body.allowance_seconds = await allowanceSeconds(db, childId);
  body.available = true;
  return { status: 200, body };
}

export async function handleKidInternet(db: Queryable, ha: HaClient, childId: string): Promise<RouteResult> {
  if (!isInternetChild(childId)) return hiddenChild();
  try {
    return await presentKid(db, childId, await ha.getKid(childId));
  } catch {
    return unavailableRoute();
  }
}

export async function handleKidInternetMode(db: Queryable, ha: HaClient, childId: string, input: Record<string, unknown>): Promise<RouteResult> {
  if (!isInternetChild(childId)) return { status: 404, body: { available: false } };
  const allowance = await allowanceSeconds(db, childId);
  const command = internetModeCommand(input, allowance);
  if (!command.ok) {
    return { status: 400, body: { error: "mode must be homework, internet or off, or homework_declared skipped" } };
  }
  try {
    return await presentKid(db, childId, await ha.setMode(childId, command.body));
  } catch {
    return unavailableRoute();
  }
}
