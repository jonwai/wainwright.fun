/**
 * tickets.wainwright.fun on the home network.
 *
 *   /api/kid/…                 the hosted kid routes (jobs, history, rewards, redeem, refund) for
 *                              the child this device belongs to (or a parent's chosen child)
 *   /api/tasks|rewards|board…  the hosted admin routes, for a parent's device only
 *   /api/children              the children (core.people), for the admin
 *   /api/local/whoami|session  who this device is; a parent picks which child to act as
 *   /ticket-icons/…            task and reward photos (copied from the hosted site bucket)
 *   /admin/…                   the tickets admin (the hosted admin's Tickets panel)
 *   everything else            the tickets kid app
 *
 * Identity is the client IP only (core.devices): an unknown device gets "This device isn't set
 * up" and no data. Every API request is one Postgres transaction (rolled back on any error or
 * 4xx/5xx), and every write holds the tickets lock, so balance checks cannot race.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type pg from "pg";
import {
  ACT_AS_COOKIE,
  ACT_AS_HEADER,
  choiceCookie,
  clientIp,
  loadDirectory,
  NOT_SET_UP,
  NOT_SET_UP_HTML,
  publicViewer,
  readChoices,
  resolveViewer,
  type Viewer,
} from "./identity.js";
import { PgDocumentClient, RefusedWrite, type PgDocumentClientOptions } from "./pg-ddb.js";
import { tryHandleTaskRoute } from "./routes.js";
import { LOCAL_CHILD_HEADER } from "./shims/kid-routes.js";

export interface LocalTicketsOptions {
  pool: pg.Pool;
  /** Built tickets kid app (apps/tickets/dist). */
  staticDir?: string | null;
  /** Built tickets admin (apps/admin/dist-local-tickets), served under /admin/. */
  adminDir?: string | null;
  /** Task and reward photos; uploads land here too. */
  iconsDir?: string | null;
  log?: (line: string) => void;
  /** Tests only: in-memory tables for anything the adapter does not map. */
  ddbOptions?: PgDocumentClientOptions;
}

type Json = Record<string, unknown> | unknown[];
interface Result {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  cookies?: string[];
}

const TICKETS_LOCK_SQL = "SELECT tickets.lock()";
const ICON_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const MAX_ICON_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function createLocalTickets(options: LocalTicketsOptions) {
  const { pool } = options;
  const log = options.log ?? (() => {});

  async function viewerFor(db: pg.PoolClient | pg.Pool, headers: Record<string, string | undefined>, peer: string | null): Promise<Viewer> {
    const ip = clientIp(peer, headers["x-real-ip"]);
    return resolveViewer(await loadDirectory(db), ip, readChoices({ [ACT_AS_HEADER]: headers[ACT_AS_HEADER] }, headers.cookie));
  }

  async function children(db: pg.PoolClient) {
    const { rows } = await db.query(
      `SELECT id, display_name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, color, avatar
       FROM core.people WHERE role = 'child' ORDER BY sort_order, id`,
    );
    return rows.map((row) => ({ subdomain: row.id, name: row.display_name, date_of_birth: row.dob, color: row.color, avatar: row.avatar ?? undefined, locked: true }));
  }

  async function saveIcon(body: Record<string, unknown>): Promise<Json> {
    if (!options.iconsDir) throw new HttpError(500, "Uploads are not configured");
    const ext = ICON_TYPES[String(body.content_type ?? "").toLowerCase()];
    if (!ext) throw new HttpError(400, `content_type must be one of: ${Object.keys(ICON_TYPES).join(", ")}`);
    if (typeof body.data !== "string" || !body.data) throw new HttpError(400, "data (base64 image) is required");
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length === 0) throw new HttpError(400, "data is not valid base64");
    if (bytes.length > MAX_ICON_BYTES) throw new HttpError(400, "Image is too big — keep it under 5 MB");
    const base =
      String(body.name ?? "")
        .toLowerCase()
        .replace(/\.(png|jpe?g|webp|gif|svg)$/i, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "icon";
    const file = `${base}-${randomBytes(4).toString("hex").slice(0, 6)}.${ext}`;
    await mkdir(options.iconsDir, { recursive: true });
    await writeFile(path.join(options.iconsDir, file), bytes, { flag: "wx" });
    return { icon: file, icon_url: `/ticket-icons/${file}` };
  }

  /** Kid history shows a household chore's name (hosted only labels bonus awards). */
  async function labelHistory(db: pg.PoolClient, childId: string, body: any) {
    if (!Array.isArray(body?.completions)) return body;
    const { rows } = await db.query(
      "SELECT DISTINCT ON (task_id) task_id, label FROM tickets.awards WHERE child_id = $1 AND source = 'household' AND label IS NOT NULL ORDER BY task_id, completed_at DESC",
      [childId],
    );
    const labels = new Map(rows.map((row) => [row.task_id, row.label]));
    for (const entry of body.completions) if (entry.title === entry.task_id && labels.has(entry.task_id)) entry.title = labels.get(entry.task_id);
    return body;
  }

  async function api(
    db: pg.PoolClient,
    method: string,
    pathname: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    rawBody: string,
    peer: string | null,
    secure: boolean,
  ): Promise<Result> {
    const viewer = await viewerFor(db, headers, peer);
    const host = headers.host;
    if (method === "GET" && pathname === "/api/health") return { status: 200, body: { ok: true, mode: "local" } };
    if (!viewer.me) throw new HttpError(403, NOT_SET_UP, { notSetUp: true });

    if (method === "GET" && pathname === "/api/local/whoami") {
      return { status: 200, body: { viewer: publicViewer(viewer), people: viewer.admin ? (await loadDirectory(db)).people : [] } };
    }
    if (pathname === "/api/local/session" && method === "DELETE") {
      return { status: 200, body: { ok: true }, cookies: [choiceCookie(ACT_AS_COOKIE, null, host, secure)] };
    }
    if (pathname === "/api/local/session" && method === "POST") {
      const body = parse(rawBody);
      if (body.me !== undefined) throw new HttpError(400, "Devices are recognised by IP address only");
      if (viewer.me.role !== "parent") throw new HttpError(403, "Only a parent can switch child");
      const actAs = typeof body.actAs === "string" ? body.actAs : null;
      const directory = await loadDirectory(db);
      if (actAs && !directory.people.some((p) => p.id === actAs && p.role === "child")) throw new HttpError(400, "Unknown child");
      const next = resolveViewer(directory, viewer.ip, { actAs });
      return { status: 200, body: { viewer: publicViewer(next), people: directory.people }, cookies: [choiceCookie(ACT_AS_COOKIE, next.child ? actAs : null, host, secure)] };
    }
    if (method === "POST" && pathname === "/api/pair") throw new HttpError(410, "Not used on the home network: devices are recognised by IP address");
    if (method === "POST" && pathname === "/api/kid/unpair") return { status: 200, body: { ok: true } };

    const rest = pathname.slice("/api/".length);
    const slash = rest.indexOf("/");
    const resource = slash === -1 ? rest : rest.slice(0, slash);
    const resourceId = slash === -1 ? "" : rest.slice(slash + 1);
    const kid = resource === "kid";
    if (!kid && !["tasks", "rewards", "board", "children"].includes(resource)) throw new HttpError(404, "Not found");

    // Admin: a parent's device only. A child's device never, whatever it sends.
    if (!kid) {
      if (viewer.kidDevice) throw new HttpError(403, "Parents only (not on a child's device)");
      if (!viewer.admin) throw new HttpError(403, "Parents only");
    } else if (!viewer.child) {
      throw new HttpError(401, "Pick which child to look at");
    }

    if (method !== "GET") await db.query(TICKETS_LOCK_SQL);
    if (resource === "children") {
      if (method !== "GET" || resourceId) throw new HttpError(405, "Children are set up in core.people on the home network");
      return { status: 200, body: await children(db) };
    }
    if (resource === "tasks" && resourceId === "icons" && method === "POST") return { status: 200, body: await saveIcon(parse(rawBody)) };

    const eventHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) if (key !== LOCAL_CHILD_HEADER && key !== "authorization") eventHeaders[key] = value;
    if (kid) eventHeaders[LOCAL_CHILD_HEADER] = viewer.child!.id;
    const route = `/${rest}`;
    const event = {
      rawPath: route,
      requestContext: { http: { method, path: route } },
      headers: eventHeaders,
      body: rawBody,
      isBase64Encoded: false,
      queryStringParameters: query,
    };
    const ddb = new PgDocumentClient(db, options.ddbOptions);
    const response = await tryHandleTaskRoute(event as never, method, resource, resourceId, ddb as never);
    if (!response) throw new HttpError(404, "Not found");
    let body: unknown = response.body ? JSON.parse(response.body) : null;
    if (kid && method === "GET" && resourceId === "tasks/history" && response.statusCode === 200) body = await labelHistory(db, viewer.child!.id, body);
    return { status: response.statusCode, body };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>, secure: boolean) {
    const method = (req.method ?? "GET").toUpperCase();
    const rawBody = await readBody(req);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (query[key] = value));
    const pathname = url.pathname.length > 5 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const db = await pool.connect();
    let result: Result;
    try {
      await db.query("BEGIN");
      try {
        result = await api(db, method, pathname, query, headers, rawBody, req.socket.remoteAddress ?? null, secure);
      } catch (error) {
        if (error instanceof HttpError) result = { status: error.status, body: { error: error.message, ...error.extra } };
        else if (error instanceof RefusedWrite) result = { status: error.status, body: { error: error.message } };
        else if (error instanceof SyntaxError) result = { status: 400, body: { error: "Body is not valid JSON" } };
        else if (["23503", "23514", "23502", "22P02"].includes((error as { code?: string }).code ?? "")) {
          // Foreign key, check, not-null, bad value: the database refused it; nothing was written.
          log(`refused by the database: ${method} ${pathname}: ${(error as Error).message}`);
          result = { status: 400, body: { error: "That breaks a data rule (unknown child or invalid value)" } };
        }
        else {
          log(`request failed: ${method} ${pathname}: ${(error as Error).message}`);
          result = { status: 500, body: { error: "Something went wrong" } };
        }
      }
      await db.query(result.status < 400 ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      log(`transaction failed: ${method} ${pathname}: ${(error as Error).message}`);
      result = { status: 500, body: { error: "Something went wrong" } };
    } finally {
      db.release();
    }
    const out: Record<string, string | string[]> = { "content-type": "application/json", "cache-control": "no-store" };
    if (result.cookies?.length) out["set-cookie"] = result.cookies;
    res.writeHead(result.status, out).end(JSON.stringify(result.body ?? null));
  }

  return async function listener(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      const secure = headers["x-forwarded-proto"] === "https";
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, headers, secure);

      // Static: the same IP rule. An unknown device gets the plain page and nothing else.
      const viewer = await viewerFor(pool, headers, req.socket.remoteAddress ?? null);
      if (!viewer.me) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(NOT_SET_UP_HTML);
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname.startsWith("/ticket-icons/")) return await serveFile(options.iconsDir, url.pathname.slice("/ticket-icons/".length), method, res, false);
      if (url.pathname === "/admin") {
        res.writeHead(302, { location: "/admin/" }).end();
        return;
      }
      if (url.pathname.startsWith("/admin/")) {
        if (!viewer.admin) {
          res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page("The tickets admin is for a parent's device."));
          return;
        }
        return await serveFile(options.adminDir, url.pathname.slice("/admin/".length), method, res, true);
      }
      return await serveFile(options.staticDir, url.pathname.slice(1), method, res, true);
    } catch (error) {
      log(`listener error: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Something went wrong");
    }
  };
}

function parse(raw: string): Record<string, unknown> {
  const value = raw ? JSON.parse(raw) : {};
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function page(text: string): string {
  return NOT_SET_UP_HTML.replaceAll(`${NOT_SET_UP}.`, text).replace(`<title>${NOT_SET_UP}</title>`, "<title>Tickets</title>");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new HttpError(413, "Too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Serves a file under root; with `spa`, unknown extension-less paths get index.html. */
async function serveFile(root: string | null | undefined, relative: string, method: string, res: ServerResponse, spa: boolean) {
  if (!root) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  const base = path.resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    res.writeHead(400).end("Bad path");
    return;
  }
  let file = path.resolve(base, decoded || "index.html");
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(404).end("Not found");
    return;
  }
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile() && spa && !path.extname(decoded)) {
    file = path.join(base, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  const immutable = /\/assets\//.test(file);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(info.size),
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

export { PgDocumentClient, LOGICAL_TABLES } from "./pg-ddb.js";
export { applyTicketsMigrations } from "./migrate.js";
