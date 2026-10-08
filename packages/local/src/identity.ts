import { isIP } from "node:net";
import type pg from "pg";

/**
 * Who is using the app, on the home LAN, without passwords. IP address only.
 *
 * 1. The client IP is looked up in core.devices. A child's device is that child, always.
 *    A parent's device is that parent.
 * 2. An unknown IP gets nothing: no name picker, no data, just "This device isn't set up".
 * 3. A parent's device gets admin and may act as any child on the kid site (the act-as choice
 *    travels as a header from localStorage and a cookie). A child's device never gets admin.
 */

export const ACT_AS_COOKIE = "tickets_act_as";
export const ACT_AS_HEADER = "x-tickets-act-as";
/** Cookies from a retired name picker. Tickets never had one, so there are none to expire. */
export const LEGACY_COOKIES: string[] = [];
export const NOT_SET_UP = "This device isn't set up";
/** 400 days: the longest cookie lifetime browsers keep. Refreshed on every visit. */
export const CHOICE_MAX_AGE = 400 * 24 * 60 * 60;

export interface Person {
  id: string;
  name: string;
  role: "child" | "parent";
}

export interface Device {
  ip: string;
  mac: string | null;
  personId: string;
  label: string | null;
}

export interface Viewer {
  ip: string | null;
  device: Device | null;
  me: Person | null;
  /** How `me` was decided: only ever the device (IP). */
  via: "device" | null;
  /** The child the kid site shows: `me` for a child, the chosen child for a parent. */
  child: Person | null;
  admin: boolean;
  /** A known child's device: admin is refused on the server. */
  kidDevice: boolean;
}

export interface Choices {
  actAs: string | null;
}

export interface Directory {
  people: Person[];
  devices: Device[];
}

export async function loadDirectory(db: pg.Pool | pg.PoolClient): Promise<Directory> {
  const people = await db.query("SELECT id, display_name, role FROM core.people ORDER BY sort_order, id");
  const devices = await db.query("SELECT host(ip) AS ip, mac::text AS mac, person_id, label FROM core.devices ORDER BY ip");
  return {
    people: people.rows.map((row) => ({ id: row.id, name: row.display_name, role: row.role })),
    devices: devices.rows.map((row) => ({ ip: row.ip, mac: row.mac, personId: row.person_id, label: row.label })),
  };
}

export function resolveViewer(directory: Directory, ip: string | null, choices: Choices): Viewer {
  const person = (id: string | null) => (id ? directory.people.find((item) => item.id === id) ?? null : null);
  const device = ip ? directory.devices.find((item) => item.ip === ip) ?? null : null;
  const deviceOwner = device ? person(device.personId) : null;
  const me = deviceOwner;
  const via = deviceOwner ? "device" : null;
  const kidDevice = deviceOwner?.role === "child";
  const actAs = person(choices.actAs);
  const child = me?.role === "child" ? me : me?.role === "parent" && actAs?.role === "child" ? actAs : null;
  return { ip, device, me, via, child, admin: !kidDevice && me?.role === "parent", kidDevice };
}

/** "::ffff:192.168.1.5" → "192.168.1.5". Anything that is not an IP → null. */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  if (isIP(ip) === 6 || isIP(base) === 6) return ip === base;
  const bits = Number(bitsText ?? 32);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/**
 * Peers allowed to tell us the client IP: loopback and Docker Desktop's VM gateway (the native
 * Caddy reaches the container through 127.0.0.1 port publishing, which Docker Desktop NATs to
 * 192.168.65.1) and Docker bridge networks. The API port is published on 127.0.0.1 only.
 */
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1", "192.168.65.0/24", "172.16.0.0/12"];

/**
 * Client IP for a request: X-Real-IP set by the trusted proxy, else the TCP peer itself.
 * A header from an untrusted peer is ignored.
 */
export function clientIp(
  peer: string | null | undefined,
  realIpHeader: string | null | undefined,
  trusted: string[] = DEFAULT_TRUSTED_PROXIES,
): string | null {
  const from = normaliseIp(peer);
  if (!from) return null;
  const isTrusted = trusted.some((cidr) => inCidr(from, cidr));
  if (isTrusted) {
    const real = normaliseIp(realIpHeader?.split(",").pop());
    if (real) return real;
    // A trusted peer with no header is a local caller (health check, curl on the Mac).
    return null;
  }
  return from;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const ID = /^[a-z][a-z0-9-]{0,40}$/;

function cleanId(value: string | null | undefined): string | null {
  const id = value?.trim().toLowerCase();
  return id && ID.test(id) ? id : null;
}

/** Header (localStorage) first, then cookie. Only a parent's device ever uses it. */
export function readChoices(headers: Record<string, string | undefined>, cookie: string | null | undefined): Choices {
  return {
    actAs: cleanId(headers[ACT_AS_HEADER]) ?? cleanId(readCookie(cookie, ACT_AS_COOKIE)),
  };
}

/** Set-Cookie values that expire any retired picker cookie this request still carries. */
export function expireLegacyCookies(cookie: string | null | undefined, host: string | null | undefined, secure: boolean): string[] {
  return LEGACY_COOKIES.filter((name) => readCookie(cookie, name) !== null).map((name) => choiceCookie(name, null, host, secure));
}

/** The whole response for an unknown device: no app, no data. */
export const NOT_SET_UP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${NOT_SET_UP}</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center;padding:24px;color:#333}</style></head><body><p>${NOT_SET_UP}.</p></body></html>`;

/** Shared by tickets.wainwright.fun and admin.tickets.wainwright.fun; host-only elsewhere. */
export function cookieDomain(host: string | null | undefined): string | null {
  const name = (host ?? "").toLowerCase().split(":")[0];
  if (name === "tickets.wainwright.fun" || name.endsWith(".tickets.wainwright.fun")) return "tickets.wainwright.fun";
  return null;
}

export function choiceCookie(name: string, value: string | null, host: string | null | undefined, secure: boolean): string {
  const domain = cookieDomain(host);
  const parts = [
    `${name}=${value ? encodeURIComponent(value) : ""}`,
    "Path=/",
    value ? `Max-Age=${CHOICE_MAX_AGE}` : "Max-Age=0",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function publicViewer(viewer: Viewer) {
  return {
    ip: viewer.ip,
    via: viewer.via,
    device: viewer.device ? { label: viewer.device.label, personId: viewer.device.personId } : null,
    me: viewer.me,
    child: viewer.child,
    admin: viewer.admin,
    kidDevice: viewer.kidDevice,
  };
}
