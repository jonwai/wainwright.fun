/**
 * wainwright.fun (the iPad launcher) and admin.wainwright.fun on the home network, next to tickets
 * in the same server. Requests are dispatched on Host:
 *
 *   wainwright.fun        the kids' launcher; the child is the device's IP (core.devices), a parent
 *                         may pick a child to look at. /kid/config, /kid/avatar, /kid/profile.
 *   admin.wainwright.fun  the iPad config admin (children, apps, websites, themes, restrictions,
 *                         term dates). Parents' devices only; never a child's device.
 *   www.wainwright.fun    301 to wainwright.fun (as the hosted CloudFront function).
 *   anything else         tickets (tickets.wainwright.fun, health checks).
 *
 * An unknown device gets "This device isn't set up" and nothing else, on every host.
 */
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import yaml from "js-yaml";
import type pg from "pg";
import { buildRootConfig, type DbApp, type DbChild, type DbRestriction, type DbTheme, type DbWebsite } from "../../shared/scripts/yaml-generator.js";
import { HttpError, inTransaction, page, parse, readBody, sendResult, serveFile, type Result } from "./app.js";
import { ACT_AS_HEADER, clientIp, loadDirectory, NOT_SET_UP, NOT_SET_UP_HTML, readChoices, resolveViewer, type Viewer } from "./identity.js";
import { isAvatar, loadResolved, loadRows, sha256, signProfile, SigningUnavailable, toKidPayload, unsignedProfile, type Signer } from "./kids.js";
import { LOGICAL_TABLES, PgDocumentClient, type PgDocumentClientOptions } from "./pg-ddb.js";
import { tryHandleTermDatesRoute } from "./routes.js";

export const APEX_HOST = "wainwright.fun";
export const ADMIN_HOST = "admin.wainwright.fun";
export const WWW_HOST = "www.wainwright.fun";

const ICON_PREFIXES = ["app-icons", "website-icons", "system-icons"] as const;
const PROFILE_TYPE = "application/x-apple-aspen-config";

export interface LocalSitesOptions {
  pool: pg.Pool;
  /** The tickets listener (createLocalTickets): the tickets host, health checks and whoami. */
  tickets: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Built kids launcher (apps/kids, local mode). */
  kidsDir?: string | null;
  /** Built local admin (apps/admin/dist-local-admin). */
  adminDir?: string | null;
  /** Copy of the hosted site bucket's app-icons/, website-icons/ and system-icons/. */
  kidsIconsDir?: string | null;
  /** Ticket and reward photos (shared with tickets). */
  ticketIconsDir?: string | null;
  /** Profile signing cert and key files. Without them no profile is served. */
  signer?: Signer | null;
  log?: (line: string) => void;
  now?: () => Date;
  ddbOptions?: PgDocumentClientOptions;
}

function hostOf(headers: Record<string, string>): string {
  return (headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function byName(a: Record<string, unknown>, b: Record<string, unknown>) {
  return String(a.name ?? "").localeCompare(String(b.name ?? ""));
}

export function createLocalSites(options: LocalSitesOptions) {
  const { pool } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());

  async function viewerFor(db: pg.Pool | pg.PoolClient, headers: Record<string, string>, peer: string | null): Promise<Viewer> {
    const ip = clientIp(peer, headers["x-real-ip"]);
    return resolveViewer(await loadDirectory(db), ip, readChoices({ [ACT_AS_HEADER]: headers[ACT_AS_HEADER] }, headers.cookie));
  }

  // ── wainwright.fun: the launcher's API (hosted /pair and /kid/*) ────────────────────────────
  async function kidApi(db: pg.PoolClient, method: string, pathname: string, headers: Record<string, string>, rawBody: string, peer: string | null): Promise<Result> {
    const viewer = await viewerFor(db, headers, peer);
    if (!viewer.me) throw new HttpError(403, NOT_SET_UP, { notSetUp: true });
    if (pathname === "/pair") throw new HttpError(410, "Not used on the home network: devices are recognised by IP address");
    if (pathname === "/kid/unpair" && method === "POST") return { status: 200, body: { ok: true } };
    if (!viewer.child) throw new HttpError(401, "Pick which child to look at", { pickChild: true });
    const childId = viewer.child.id;
    const ddb = new PgDocumentClient(db, options.ddbOptions);

    if (pathname === "/kid/config" && method === "GET") {
      return { status: 200, body: toKidPayload(await loadResolved(ddb, childId, now())) };
    }
    if (pathname === "/kid/avatar" && method === "PUT") {
      const avatar = parse(rawBody).avatar;
      if (!isAvatar(avatar)) throw new HttpError(400, "Pick one of the avatars");
      await db.query("UPDATE core.people SET avatar = $2 WHERE id = $1 AND role = 'child'", [childId, avatar]);
      return { status: 200, body: { avatar } };
    }
    if ((pathname === "/kid/profile" || pathname === "/kid/profile.mobileconfig") && method === "GET") {
      const resolved = await loadResolved(ddb, childId, now());
      const unsigned = await unsignedProfile(resolved, options.kidsIconsDir);
      let signed: Buffer;
      try {
        signed = signProfile(unsigned, options.signer ?? null);
      } catch (error) {
        if (error instanceof SigningUnavailable) {
          log(`profile for ${childId} not served: ${error.message}`);
          throw new HttpError(503, "The iPad profile can't be signed right now, so it isn't being handed out");
        }
        throw error;
      }
      await db.query("INSERT INTO kids.profile_downloads (child_id, ip, viewer_id, sha256, bytes, signed) VALUES ($1, $2, $3, $4, $5, true)", [
        childId,
        viewer.ip,
        viewer.me.id,
        sha256(signed),
        signed.length,
      ]);
      log(`profile for ${childId} handed to ${viewer.me.id} at ${viewer.ip} (${signed.length} bytes)`);
      return {
        status: 200,
        body: signed,
        headers: { "content-type": PROFILE_TYPE, "content-disposition": `attachment; filename="${childId}-profile.mobileconfig"` },
      };
    }
    throw new HttpError(404, "Not found");
  }

  // ── admin.wainwright.fun: hosted api-v2 for the iPad config, on Postgres ────────────────────
  async function listIcons(prefix: string): Promise<string[]> {
    if (!options.kidsIconsDir) return [];
    const files = await readdir(path.join(options.kidsIconsDir, prefix)).catch(() => [] as string[]);
    return files.filter((name) => !name.startsWith(".")).sort();
  }

  async function adminApi(db: pg.PoolClient, method: string, pathname: string, query: Record<string, string>, headers: Record<string, string>, rawBody: string): Promise<Result> {
    const ddb = new PgDocumentClient(db, options.ddbOptions);
    const send = (name: string, input: Record<string, unknown>) => ddb.send({ constructor: { name }, input } as never);
    const scan = async (table: string) => ((await send("ScanCommand", { TableName: table })) as { Items: Record<string, unknown>[] }).Items;
    const rest = pathname.slice("/api/".length);
    const slash = rest.indexOf("/");
    const resource = slash === -1 ? rest : rest.slice(0, slash);
    const resourceId = slash === -1 ? "" : rest.slice(slash + 1);
    const body = () => parse(rawBody);
    const ok = (value: unknown, status = 200): Result => ({ status, body: value });

    if (["budgets", "budget", "chores"].includes(resource)) {
      throw new HttpError(410, "Not on the home network: chores stay on chores.wainwright.fun and the old budgets are retired");
    }
    if (resource === "term-dates") {
      const event = { rawPath: `/${rest}`, requestContext: { http: { method, path: `/${rest}` } }, headers, body: rawBody, isBase64Encoded: false, queryStringParameters: query };
      const response = await tryHandleTermDatesRoute(event as never, method, resource, resourceId, ddb as never);
      return { status: response!.statusCode, body: response!.body ? JSON.parse(response!.body) : null };
    }
    if (method === "GET" && resource === "icons") {
      const [appIcons, websiteIcons, systemIcons] = await Promise.all(ICON_PREFIXES.map(listIcons));
      return ok({ appIcons, websiteIcons, systemIcons });
    }
    if (method === "GET" && resource === "config") {
      const rows = await loadRows(ddb);
      const config = buildRootConfig({
        children: rows.children as unknown as DbChild[],
        apps: rows.apps as unknown as DbApp[],
        websites: rows.websites as unknown as DbWebsite[],
        themes: rows.themes as unknown as DbTheme[],
        restrictions: rows.restrictions as unknown as DbRestriction[],
      });
      return { status: 200, body: Buffer.from(yaml.dump(config, { lineWidth: 120 })), headers: { "content-type": "text/yaml; charset=utf-8" } };
    }
    if (method === "POST" && resource === "rebuild") return ok({ message: "Nothing to rebuild: the home-network site reads the database on every request" }, 202);
    if (resource === "pairings") {
      if (method === "GET" && !resourceId) return ok([]);
      throw new HttpError(410, "Pairing is not used on the home network: devices are recognised by IP address");
    }

    if (resource === "children") {
      if (method === "GET" && !resourceId) {
        const items = await scan(LOGICAL_TABLES.children);
        return ok(items.sort(byName).map((c) => ({ ...c, locked: c.locked !== false })));
      }
      const [childId, action] = resourceId.split("/");
      if (childId && (action === "pair" || action === "preview")) {
        throw new HttpError(410, "Pairing and preview links are not used on the home network: open wainwright.fun on your device and pick the child");
      }
      if (method === "PUT" && childId && !action) {
        const input = body();
        const item: Record<string, unknown> = {
          subdomain: childId,
          name: (input.name as string) ?? "",
          date_of_birth: (input.date_of_birth as string) ?? "",
          color: (input.color as string) ?? "blue",
          avatar: input.avatar as string | undefined,
          locked: input.locked !== false,
        };
        if (input.restriction_overrides) item.restriction_overrides = input.restriction_overrides;
        if (input.blocked_apps) item.blocked_apps = input.blocked_apps;
        await send("PutCommand", { TableName: LOGICAL_TABLES.children, Item: item });
        return ok(item);
      }
      if (method === "DELETE" && childId && !action) await send("DeleteCommand", { TableName: LOGICAL_TABLES.children, Key: { subdomain: childId } });
    }

    if (resource === "apps") {
      if (method === "GET" && !resourceId) {
        let items = await scan(LOGICAL_TABLES.apps);
        if (query.type) items = items.filter((a) => a.type === query.type);
        return ok(items.sort(byName));
      }
      if (method === "PUT" && resourceId) {
        const input = body();
        const item: Record<string, unknown> = {
          bundle_id: resourceId,
          name: input.name ?? "",
          type: input.type ?? "app",
          app_store_url: input.app_store_url as string | undefined,
          category: input.category as string | undefined,
          icon: input.icon as string | undefined,
          show_on_site: input.show_on_site ?? false,
          min_age: input.min_age ?? 0,
          enabled: input.enabled ?? true,
        };
        await send("PutCommand", { TableName: LOGICAL_TABLES.apps, Item: item });
        return ok(item);
      }
      if (method === "DELETE" && resourceId) {
        await send("DeleteCommand", { TableName: LOGICAL_TABLES.apps, Key: { bundle_id: resourceId } });
        return ok({ deleted: true });
      }
    }

    if (resource === "websites") {
      if (method === "GET" && !resourceId) return ok((await scan(LOGICAL_TABLES.websites)).sort(byName));
      const url = resourceId ? decodeURIComponent(resourceId) : "";
      if (method === "PUT" && url) {
        const input = body();
        const item: Record<string, unknown> = {
          url,
          name: input.name ?? "",
          icon: input.icon ?? undefined,
          category: input.category as string | undefined,
          min_age: input.min_age ?? 0,
          enabled: input.enabled ?? true,
        };
        if (input.child_subdomain) item.child_subdomain = input.child_subdomain;
        await send("PutCommand", { TableName: LOGICAL_TABLES.websites, Item: item });
        return ok(item);
      }
      if (method === "DELETE" && url) {
        await send("DeleteCommand", { TableName: LOGICAL_TABLES.websites, Key: { url } });
        return ok({ deleted: true });
      }
    }

    if (resource === "themes") {
      if (method === "GET" && !resourceId) return ok((await scan(LOGICAL_TABLES.themes)).sort((a, b) => Number(a.from_age) - Number(b.from_age)));
      const fromAge = Number(resourceId);
      if (resourceId && !Number.isInteger(fromAge)) throw new HttpError(400, "from_age must be a whole number");
      if (method === "PUT" && resourceId) {
        const input = body();
        const item: Record<string, unknown> = { from_age: fromAge, theme: input.theme ?? "little", subtitle: input.subtitle ?? "" };
        if (input.restriction_overrides) item.restriction_overrides = input.restriction_overrides;
        await send("PutCommand", { TableName: LOGICAL_TABLES.themes, Item: item });
        return ok(item);
      }
      if (method === "DELETE" && resourceId) {
        await send("DeleteCommand", { TableName: LOGICAL_TABLES.themes, Key: { from_age: fromAge } });
        return ok({ deleted: true });
      }
    }

    if (resource === "restrictions") {
      if (method === "GET" && !resourceId) return ok((await scan(LOGICAL_TABLES.restrictions)).sort((a, b) => String(a.key).localeCompare(String(b.key))));
      if (method === "PUT" && resourceId) {
        const input = body();
        if (input.value === undefined) throw new HttpError(400, "value is required");
        const item: Record<string, unknown> = { key: resourceId, value: input.value, type: input.type ?? "boolean" };
        if (input.overridable !== undefined) item.overridable = input.overridable;
        await send("PutCommand", { TableName: LOGICAL_TABLES.restrictions, Item: item });
        return ok(item);
      }
      if (method === "DELETE" && resourceId) {
        await send("DeleteCommand", { TableName: LOGICAL_TABLES.restrictions, Key: { key: resourceId } });
        return ok({ deleted: true });
      }
    }
    throw new HttpError(404, "Not found");
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────────────────────
  async function api(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>, fn: (db: pg.PoolClient, method: string, pathname: string, query: Record<string, string>, rawBody: string) => Promise<Result>) {
    const method = (req.method ?? "GET").toUpperCase();
    const rawBody = await readBody(req);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (query[key] = value));
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    sendResult(res, await inTransaction(pool, log, method, pathname, (db) => fn(db, method, pathname, query, rawBody)));
  }

  function html(res: ServerResponse, status: number, body: string) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  }

  /** Icon folders, served on both hosts (the hosted site bucket served them on every host). */
  async function serveIcons(pathname: string, method: string, res: ServerResponse): Promise<boolean> {
    for (const prefix of ICON_PREFIXES) {
      if (pathname.startsWith(`/${prefix}/`)) {
        await serveFile(options.kidsIconsDir ? path.join(options.kidsIconsDir, prefix) : null, pathname.slice(prefix.length + 2), method, res, false);
        return true;
      }
    }
    if (pathname.startsWith("/ticket-icons/")) {
      await serveFile(options.ticketIconsDir, pathname.slice("/ticket-icons/".length), method, res, false);
      return true;
    }
    return false;
  }

  async function apex(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>) {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;
    const peer = req.socket.remoteAddress ?? null;
    // The hosted CloudFront function sends the admin and auth paths to the admin host.
    if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/auth/")) {
      res.writeHead(301, { location: `https://${ADMIN_HOST}${url.pathname}${url.search}` }).end();
      return;
    }
    if (pathname === "/api/health") return options.tickets(req, res);
    if (pathname === "/api/local/whoami" || pathname === "/api/local/session") return options.tickets(req, res);
    if (pathname === "/pair" || pathname === "/kid" || pathname.startsWith("/kid/")) {
      return api(req, res, url, headers, (db, m, p, _q, raw) => kidApi(db, m, p, headers, raw, peer));
    }
    if (pathname.startsWith("/api/")) {
      sendResult(res, { status: 404, body: { error: "Not found" } });
      return;
    }
    const viewer = await viewerFor(pool, headers, peer);
    if (!viewer.me) return html(res, 403, NOT_SET_UP_HTML);
    if (await serveIcons(pathname, method, res)) return;
    return serveFile(options.kidsDir, pathname.slice(1), method, res, true);
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>) {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;
    const peer = req.socket.remoteAddress ?? null;
    if (pathname === "/api/health") return options.tickets(req, res);
    const viewer = await viewerFor(pool, headers, peer);
    const isApi = pathname.startsWith("/api/");
    const refuse = (status: number, message: string, extra: Record<string, unknown> = {}) => {
      log(`admin refused ${status} ${method} ${pathname} for ${viewer.ip ?? "a local caller"} (peer ${peer ?? "?"}, x-real-ip ${JSON.stringify(headers["x-real-ip"] ?? null)}): ${message}`);
      return isApi ? sendResult(res, { status, body: { error: message, ...extra } }) : html(res, status, status === 403 && !viewer.me ? NOT_SET_UP_HTML : page(`${message}.`, "Wainwright Admin"));
    };
    if (!viewer.me) return refuse(403, NOT_SET_UP, { notSetUp: true });
    if (viewer.kidDevice) return refuse(403, "Parents only (not on a child's device)");
    if (!viewer.admin) return refuse(403, "Parents only");

    if (isApi) {
      const resource = pathname.slice("/api/".length).split("/")[0];
      // Tickets has its own app and admin (tickets.wainwright.fun/admin/); this admin has no Tickets tab.
      if (["tasks", "rewards", "board"].includes(resource)) {
        return sendResult(res, { status: 410, body: { error: "Tickets are managed at https://tickets.wainwright.fun/admin/" } });
      }
      if (pathname === "/api/local/whoami") return options.tickets(req, res);
      if (pathname === "/api/me" && method === "GET") {
        sendResult(res, { status: 200, body: { username: viewer.me.id, name: viewer.me.name, via: "device", ip: viewer.ip, groups: ["parents"] } });
        return;
      }
      return api(req, res, url, headers, (db, m, p, q, raw) => adminApi(db, m, p, q, headers, raw));
    }
    if (await serveIcons(pathname, method, res)) return;
    return serveFile(options.adminDir, pathname.slice(1), method, res, true);
  }

  return async function listener(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      const host = hostOf(headers);
      if (host === WWW_HOST) {
        res.writeHead(301, { location: `https://${APEX_HOST}${url.pathname}${url.search}` }).end();
        return;
      }
      if (host === APEX_HOST) return await apex(req, res, url, headers);
      if (host === ADMIN_HOST) return await admin(req, res, url, headers);
      return await options.tickets(req, res);
    } catch (error) {
      log(`sites listener error: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Something went wrong");
    }
  };
}

export { createLocalTickets } from "./app.js";
export { importKids, readKidsScans, canonical } from "./import-kids.js";
export { loadResolved, toKidPayload, unsignedProfile } from "./kids.js";
export { PgDocumentClient, LOGICAL_TABLES } from "./pg-ddb.js";
export { applyTicketsMigrations } from "./migrate.js";
