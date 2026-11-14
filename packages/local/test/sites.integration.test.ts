/**
 * wainwright.fun and admin.wainwright.fun end to end against a scratch Postgres database:
 *   KIDS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/kids_local_test npm test
 * Runs the built bundle (npm run build first). Devices are simulated with X-Real-IP from loopback
 * (a trusted proxy, as Caddy is); a request without it is a local caller, i.e. unknown.
 * Profiles are signed with a throwaway certificate made for the test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { haClientFromEnv } from "../src/ha.ts";

const url = process.env.KIDS_TEST_DATABASE_URL;
// @ts-ignore built bundle
const { createLocalSites, createLocalTickets, importKids, readKidsScans, applyTicketsMigrations, loadResolved, unsignedProfile, PgDocumentClient } = await import("../dist/sites.mjs");

const CORE = `
  DROP SCHEMA IF EXISTS kids CASCADE;
  DROP SCHEMA IF EXISTS tickets CASCADE;
  DROP SCHEMA IF EXISTS core CASCADE;
  DROP TABLE IF EXISTS public.tickets_schema_migrations;
  CREATE SCHEMA core;
  CREATE TABLE core.people (id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'), display_name text NOT NULL, role text NOT NULL CHECK (role IN ('child', 'parent')),
    sort_order int NOT NULL DEFAULT 0, date_of_birth date, color text CHECK (color IN ('red', 'green', 'blue', 'orange', 'purple')),
    avatar text CHECK (avatar <> ''), UNIQUE (id, role));
  CREATE TABLE core.devices (ip inet PRIMARY KEY, mac macaddr, person_id text NOT NULL REFERENCES core.people ON UPDATE CASCADE ON DELETE CASCADE, label text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE core.term_dates (academic_year text NOT NULL, position int NOT NULL, name text NOT NULL, opens date NOT NULL, closes date NOT NULL,
    half_term_start date, half_term_end date, PRIMARY KEY (academic_year, position));
  INSERT INTO core.people VALUES
    ('hannah', 'Hannah', 'child', 1, '2017-10-07', 'red', '🧜'), ('lydia', 'Lydia', 'child', 2, '2019-04-25', 'green', '🐸'),
    ('zoe', 'Zoe', 'child', 3, '2020-09-12', 'blue', '🍭'), ('joanna', 'Joanna', 'child', 4, '2025-06-20', 'purple', '🦄'),
    ('ethan', 'Ethan', 'child', 5, '2022-03-27', 'orange', '🦊'), ('jonathan', 'Jonathan', 'parent', 6, NULL, NULL, NULL);
  INSERT INTO core.devices (ip, person_id, label) VALUES ('192.168.1.219', 'zoe', 'Zoe iPad'), ('192.168.1.98', 'lydia', 'Lydia iPad'),
    ('192.168.1.182', 'hannah', 'Hannah iPad'), ('192.168.1.170', 'jonathan', 'Mac Studio');
  INSERT INTO core.term_dates VALUES ('2026-2027', 0, 'Autumn', '2026-09-03', '2026-12-18', '2026-10-26', '2026-10-30');
`;

const ZOE = "192.168.1.219";
const LYDIA = "192.168.1.98";
const MAC = "192.168.1.170";
const STRANGER = "192.168.1.66";

function marshal(value: unknown): unknown {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshal) };
  return { M: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, marshal(v)])) };
}

function hostedFixture() {
  return {
    children: [
      { subdomain: "hannah", name: "Hannah", date_of_birth: "2017-10-07", color: "red", avatar: "🧜", locked: true },
      { subdomain: "lydia", name: "Lydia", date_of_birth: "2019-04-25", color: "green", avatar: "🐸", locked: true, blocked_apps: [] },
      // Hosted avatar differs from core: reported, core kept.
      { subdomain: "zoe", name: "Zoe", date_of_birth: "2020-09-12", color: "blue", avatar: "🐼", locked: true },
      { subdomain: "joanna", name: "Joanna", date_of_birth: "2025-06-20", color: "purple", avatar: "🦄", locked: true },
      { subdomain: "ethan", name: "Ethan", date_of_birth: "2022-03-27", color: "orange", avatar: "🦊", locked: false, restriction_overrides: { allowCamera: false } },
    ],
    apps: [
      { bundle_id: "com.example.maths", name: "Maths Fun", type: "app", app_store_url: "https://apps.apple.com/gb/app/maths/id111", category: "Education", min_age: 4, enabled: true, show_on_site: true },
      { bundle_id: "com.example.teen", name: "Teen Chat", type: "app", app_store_url: "https://apps.apple.com/gb/app/teen/id222", category: "Social", min_age: 13, enabled: true },
      { bundle_id: "com.apple.camera", name: "Camera", type: "system", category: "Utilities", icon: "camera", min_age: 0, enabled: true, show_on_site: false },
    ],
    websites: [
      { url: "https://www.bbc.co.uk/cbeebies", name: "CBeebies", category: "TV", min_age: 0, enabled: true, icon: "cbeebies.png" },
      { url: "https://www.example.org/", name: "Example", category: "Learning", min_age: 6, enabled: true },
    ],
    themes: [
      { from_age: 0, theme: "little", subtitle: "Hi" },
      { from_age: 5, theme: "early", subtitle: "" },
      { from_age: 8, theme: "primary", subtitle: "" },
      { from_age: 12, theme: "teen", subtitle: "" },
    ],
    restrictions: [
      { key: "allowCamera", value: true, type: "boolean" },
      { key: "ratingApps", value: 600, type: "integer" },
      { key: "allowExplicitContent", value: false, type: "boolean" },
    ],
    "term-dates": [
      { academic_year: "2026-2027", updated_at: "2026-09-01T00:00:00Z", terms: [{ name: "Autumn", opens: "2026-09-03", closes: "2026-12-18", half_term_start: "2026-10-26", half_term_end: "2026-10-30" }] },
    ],
  };
}

async function writeScans(dir: string, data: ReturnType<typeof hostedFixture>) {
  for (const [name, items] of Object.entries(data)) {
    const marshalled = (items as unknown[]).map((item) => (marshal(item) as { M: unknown }).M);
    await writeFile(path.join(dir, `wainwright-${name}.json`), JSON.stringify({ Items: marshalled, Count: marshalled.length }));
  }
}

let pool: pg.Pool;
let port = 0;
let unsignedPort = 0;
/** Same server with the clock after letters to Santa have opened. */
let openPort = 0;
const HA_TOKEN = "ha-test-token";
const DOMAINS_TOKEN = "domains-test-token";
let haTokenFile = "";
let domainsTokenFile = "";
let haDown = false;
/** When set, the stand-in Home Assistant reports this break. A homework POST during it is a 409. */
let haBreak: { on_break: boolean; break_ends_at: string | null; break_seconds_left: number; homework_available: boolean } | null = null;
const haCalls: { method: string; path: string; body: unknown }[] = [];
const haServer = createServer((req, res) => {
  if (haDown) {
    req.socket.destroy();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const reqPath = req.url ?? "";
    haCalls.push({ method: req.method ?? "GET", path: reqPath, body });
    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "no" }));
      return;
    }
    const kid = /^\/api\/wainwright_fun\/kids\/([a-z]+)(\/mode)?$/.exec(reqPath);
    if (!kid) {
      res.writeHead(404).end("{}");
      return;
    }
    if (kid[1] === "joanna") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown child" }));
      return;
    }
    const command = (body ?? {}) as { mode?: string; homework_declared?: string; allowance_seconds?: number; end_break?: boolean };
    if (req.method === "POST" && command.end_break === true) {
      const keys = Object.keys(command);
      if (keys.length !== 1 || command.mode !== undefined || command.homework_declared !== undefined) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "end_break must be the only key" }));
        return;
      }
      haBreak = { on_break: false, break_ends_at: null, break_seconds_left: 0, homework_available: true };
    }
    if (req.method === "POST" && command.mode === "off") {
      res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ reason: "Internet stays on until the timer ends" }));
      return;
    }
    if (req.method === "POST" && command.mode === "homework" && haBreak?.on_break) {
      res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "Homework mode is paused", reason: "internet_break" }));
      return;
    }
    const next = {
      child_id: kid[1],
      date: "2026-11-12",
      mode: command.end_break ? "off" : command.mode ?? "off",
      homework_declared: command.homework_declared === "skipped" ? "skipped" : command.mode === "homework" ? "homework" : "none",
      internet_used_today: command.mode === "internet" || Boolean(haBreak),
      internet_available: !haBreak?.on_break && command.mode !== "internet",
      allowance_seconds: command.allowance_seconds ?? 999,
      seconds_left: command.mode === "internet" || command.mode === "homework" ? 1200 : 3600,
      internet_ends_at: command.mode === "internet" ? "2026-11-12T13:00:00.000Z" : null,
      resets_at: "2026-11-13T00:00:00.000Z",
      on_break: haBreak?.on_break ?? false,
      break_ends_at: haBreak?.break_ends_at ?? null,
      break_seconds_left: haBreak?.break_seconds_left ?? 0,
      homework_available: haBreak ? haBreak.homework_available : command.mode !== "homework" && command.mode !== "internet",
    };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next));
  });
});
const servers: { close(): void }[] = [];
let scans = "";
let iconsDir = "";
let certFile = "";
const CBEEBIES_ICON = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ICON_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const iconFetches: Promise<void>[] = [];
const iconHolds = new Map<string, Promise<void>>();
const iconPages = new Map<string, string>();
const iconFiles = new Map<string, { body: Buffer; type: string }>();
const iconArtwork = new Map<string, string>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Every icon download the server makes. Anything not staged here is a 404, so tests never touch the network. */
async function mockFetch(input: RequestInfo | URL): Promise<Response> {
  const url = requestUrl(input);
  const hold = iconHolds.get(url);
  if (hold) await hold;
  if (url.startsWith("https://itunes.apple.com/lookup")) {
    const ids = new URL(url).searchParams.get("id")?.split(",") ?? [];
    const results = ids.flatMap((id) => (iconArtwork.has(id) ? [{ trackId: Number(id), artworkUrl512: iconArtwork.get(id) }] : []));
    return Response.json({ results });
  }
  const page = iconPages.get(url);
  if (page !== undefined) return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const file = iconFiles.get(url);
  if (file) return new Response(file.body, { status: 200, headers: { "content-type": file.type } });
  return new Response("missing", { status: 404 });
}

async function settleIcons() {
  const pending = iconFetches.splice(0, iconFetches.length);
  await Promise.all(pending);
}

async function listen(listener: (req: any, res: any) => Promise<void>): Promise<number> {
  const server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  await pool.query(CORE);
  await applyTicketsMigrations(pool);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kids-sites-"));
  scans = path.join(tmp, "scans");
  iconsDir = path.join(tmp, "icons");
  await mkdir(scans);
  await mkdir(path.join(iconsDir, "website-icons"), { recursive: true });
  await mkdir(path.join(iconsDir, "app-icons"), { recursive: true });
  await writeFile(path.join(iconsDir, "website-icons", "cbeebies.png"), CBEEBIES_ICON);
  await writeFile(path.join(iconsDir, "app-icons", "111.jpg"), "jpg");
  await writeScans(scans, hostedFixture());
  certFile = path.join(tmp, "cert.pem");
  haTokenFile = path.join(tmp, "ha-token");
  domainsTokenFile = path.join(tmp, "domains-token");
  await writeFile(haTokenFile, `${HA_TOKEN}\n`);
  await writeFile(domainsTokenFile, `${DOMAINS_TOKEN}\n`);
  await new Promise<void>((resolve) => haServer.listen(0, "127.0.0.1", resolve));
  const haPort = (haServer.address() as AddressInfo).port;
  servers.push(haServer);
  const keyFile = path.join(tmp, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Test Profile Signing", "-days", "1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const log = process.env.KIDS_TEST_LOG ? (l: string) => console.error(l) : () => {};
  const tickets = createLocalTickets({ pool, log });
  const options = {
    pool,
    tickets,
    kidsIconsDir: iconsDir,
    log,
    fetch: mockFetch,
    trackIconFetch: (done: Promise<void>) => iconFetches.push(done),
    now: () => new Date("2026-10-08T12:00:00Z"),
    launcherHosts: new Set(["preview.example"]),
    ha: haClientFromEnv({ HA_URL: `http://127.0.0.1:${haPort}`, HA_TOKEN_FILE: haTokenFile }),
    homeworkDomainsTokenFile: domainsTokenFile,
  };
  port = await listen(createLocalSites({ ...options, signer: { certFile, keyFile } }));
  unsignedPort = await listen(createLocalSites({ ...options, signer: null }));
  openPort = await listen(createLocalSites({ ...options, now: () => new Date("2026-11-16T08:00:00.000Z"), signer: { certFile, keyFile } }));
});

after(async () => {
  iconHolds.clear();
  await Promise.allSettled(iconFetches);
  for (const server of servers) server.close();
  await pool?.end();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  bytes: Buffer;
  json: any;
}

function call(host: string, pathname: string, ip: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string>; port?: number; timeout?: number } = {}): Promise<Reply> {
  const headers: Record<string, string> = { host, ...(init.headers ?? {}) };
  if (ip) headers["x-real-ip"] = ip;
  const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (payload) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: init.port ?? port, path: pathname, method: init.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, bytes, json });
      });
    });
    if (init.timeout) req.setTimeout(init.timeout, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}
const apex = (p: string, ip: string | null, init?: Parameters<typeof call>[3]) => call("wainwright.fun", p, ip, init);
const admin = (p: string, ip: string | null, init?: Parameters<typeof call>[3]) => call("admin.wainwright.fun", p, ip, init);

test("import mirrors the hosted iPad config, keeps people and reconciles", { skip: !url }, async () => {
  const report = await importKids(pool, await readKidsScans(scans));
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.hosted, { children: 5, apps: 3, websites: 2, themes: 4, restrictions: 3, termDates: 1 });
  assert.deepEqual(report.local, { children: 5, apps: 3, websites: 2, themes: 4, restrictions: 3 });
  assert.deepEqual(report.peopleDifferences, [{ child: "zoe", field: "avatar", hosted: "🐼", local: "🍭" }]);
  assert.equal(report.termDates.equal, true);
  assert.equal((await pool.query("SELECT avatar FROM core.people WHERE id = 'zoe'")).rows[0].avatar, "🍭");
  const lydia = (await pool.query("SELECT blocked_apps FROM kids.child_settings WHERE child_id = 'lydia'")).rows[0];
  assert.deepEqual(lydia.blocked_apps, []);
  // Nothing duplicated: children's names, dates of birth, colours, avatars only in core.people.
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'kids' AND table_name = 'child_settings'")).rows.map((r) => r.column_name);
  for (const dup of ["name", "display_name", "date_of_birth", "color", "avatar"]) assert.ok(!cols.includes(dup), dup);
  // Idempotent.
  const again = await importKids(pool, await readKidsScans(scans));
  assert.deepEqual(again.mismatches, []);
  assert.deepEqual(again.local, report.local);
  // A hosted removal is mirrored.
  const fewer = hostedFixture();
  fewer.apps.pop();
  const dir = await mkdtemp(path.join(os.tmpdir(), "kids-fewer-"));
  await writeScans(dir, fewer);
  const dry = await importKids(pool, await readKidsScans(dir), { dryRun: true });
  assert.equal(dry.removed.apps, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM kids.apps")).rows[0].n, 3, "dry run writes nothing");
});

test("an unknown device gets nothing on either host", { skip: !url }, async () => {
  for (const ip of [STRANGER, null]) {
    const page = await apex("/", ip);
    assert.equal(page.status, 403);
    assert.match(page.text, /This device isn't set up/);
    assert.doesNotMatch(page.text, /script/);
    assert.equal((await apex("/kid/config", ip)).status, 403);
    assert.equal((await apex("/kid/profile", ip)).status, 403);
    assert.equal((await apex("/website-icons/cbeebies.png", ip)).status, 403);
    assert.equal((await apex("/api/local/whoami", ip)).status, 403);
    assert.equal((await admin("/", ip)).status, 403);
    assert.match((await admin("/", ip)).text, /This device isn't set up/);
    assert.equal((await admin("/api/children", ip)).status, 403);
    assert.equal((await admin("/api/tasks", ip)).status, 403);
  }
  // No name picker: a device can't claim to be someone.
  const claim = await apex("/api/local/session", STRANGER, { method: "POST", body: { me: "jonathan" } });
  assert.equal(claim.status, 403);
});

test("a child's iPad sees only its own child and never the admin", { skip: !url }, async () => {
  const config = await apex("/kid/config", ZOE);
  assert.equal(config.status, 200);
  assert.equal(config.json.child.subdomain, "zoe");
  assert.equal(config.json.child.avatar, "🍭");
  assert.equal(config.json.restrictions, undefined);
  assert.equal(config.json.child.date_of_birth, undefined);
  // Acting as another child is ignored on a child's device.
  const other = await apex("/kid/config", ZOE, { headers: { "x-tickets-act-as": "hannah", cookie: "tickets_act_as=hannah" } });
  assert.equal(other.json.child.subdomain, "zoe");
  assert.equal((await apex("/api/local/session", ZOE, { method: "POST", body: { actAs: "hannah" } })).status, 403);
  for (const [p, method] of [["/", "GET"], ["/api/children", "GET"], ["/api/apps", "GET"], ["/api/tasks", "GET"], ["/api/restrictions/allowCamera", "PUT"], ["/api/me", "GET"]]) {
    const r = await admin(p, ZOE, { method, body: method === "PUT" ? { value: false } : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  assert.equal((await pool.query("SELECT value FROM kids.restrictions WHERE key = 'allowCamera'")).rows[0].value, true);
});

test("pairing is gone, unpair is harmless and nothing touches the hosted device cookie", { skip: !url }, async () => {
  assert.equal((await apex("/pair", ZOE, { method: "POST", body: { code: "ABC123" } })).status, 410);
  const unpair = await apex("/kid/unpair", ZOE, { method: "POST" });
  assert.equal(unpair.status, 200);
  assert.equal(unpair.headers["set-cookie"], undefined);
  assert.equal((await apex("/kid/config", ZOE)).status, 200);
});

test("a kid changes their avatar in core.people", { skip: !url }, async () => {
  assert.equal((await apex("/kid/avatar", LYDIA, { method: "PUT", body: { avatar: "not-an-avatar" } })).status, 400);
  const ok = await apex("/kid/avatar", LYDIA, { method: "PUT", body: { avatar: "🦄" } });
  assert.equal(ok.status, 200);
  assert.equal((await pool.query("SELECT avatar FROM core.people WHERE id = 'lydia'")).rows[0].avatar, "🦄");
  await pool.query("UPDATE core.people SET avatar = '🐸' WHERE id = 'lydia'");
});

test("a parent picks which child to look at", { skip: !url }, async () => {
  const none = await apex("/kid/config", MAC);
  assert.equal(none.status, 401);
  assert.equal(none.json.pickChild, true);
  const picked = await apex("/api/local/session", MAC, { method: "POST", body: { actAs: "hannah" } });
  assert.equal(picked.status, 200);
  const cookie = String(picked.headers["set-cookie"]);
  assert.match(cookie, /tickets_act_as=hannah/);
  assert.doesNotMatch(cookie, /Domain=/, "host-only on wainwright.fun");
  const config = await apex("/kid/config", MAC, { headers: { cookie: "tickets_act_as=hannah" } });
  assert.equal(config.json.child.subdomain, "hannah");
  assert.equal((await apex("/kid/config", MAC, { headers: { "x-tickets-act-as": "jonathan" } })).status, 401, "a parent is not a child");
});

test("the profile is the shared generator's, signed with the cert file, and recorded", { skip: !url }, async () => {
  const reply = await apex("/kid/profile", ZOE);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-type"], "application/x-apple-aspen-config");
  assert.match(String(reply.headers["content-disposition"]), /zoe-profile\.mobileconfig/);
  assert.equal(reply.headers["cache-control"], "no-store");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kids-profile-"));
  const signedFile = path.join(tmp, "p.der");
  await writeFile(signedFile, reply.bytes);
  const content = execFileSync("openssl", ["smime", "-verify", "-inform", "DER", "-in", signedFile, "-CAfile", certFile, "-purpose", "any"], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  const db = await pool.connect();
  try {
    const resolved = await loadResolved(new PgDocumentClient(db), "zoe", new Date("2026-10-08T12:00:00Z"));
    // openssl smime -sign (hosted's exact command) canonicalises line endings to CRLF.
    assert.equal(content.replaceAll("\r\n", "\n"), (await unsignedProfile(resolved, iconsDir)).replaceAll("\r\n", "\n"));
  } finally {
    db.release();
  }
  assert.match(content, /<string>com\.example\.maths<\/string>/);
  assert.doesNotMatch(content, /com\.example\.teen/, "the age gate still applies");
  assert.ok(content.includes(CBEEBIES_ICON.toString("base64").slice(0, 16)), "Web Clip icon from the icons directory");
  const audit = (await pool.query("SELECT child_id, host(ip) AS ip, viewer_id, signed, bytes FROM kids.profile_downloads ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(audit, { child_id: "zoe", ip: ZOE, viewer_id: "zoe", signed: true, bytes: reply.bytes.length });
  // A parent downloading a child's profile.
  const parent = await apex("/kid/profile.mobileconfig", MAC, { headers: { cookie: "tickets_act_as=lydia" } });
  assert.equal(parent.status, 200);
  assert.match(String(parent.headers["content-disposition"]), /lydia-profile/);
});

test("without the signing files no profile is handed out", { skip: !url }, async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM kids.profile_downloads")).rows[0].n;
  const reply = await apex("/kid/profile", ZOE, { port: unsignedPort });
  assert.equal(reply.status, 503);
  assert.doesNotMatch(reply.text, /PayloadContent/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM kids.profile_downloads")).rows[0].n, before);
});

test("the admin edits the iPad config on a parent's device", { skip: !url }, async () => {
  const children = await admin("/api/children", MAC);
  assert.equal(children.status, 200);
  assert.deepEqual(children.json.map((c: any) => c.subdomain), ["ethan", "hannah", "joanna", "lydia", "zoe"]);
  assert.deepEqual(children.json.find((c: any) => c.subdomain === "lydia").blocked_apps, []);
  assert.equal(children.json.find((c: any) => c.subdomain === "ethan").locked, false);

  const systemApps = await admin("/api/apps?type=system", MAC);
  assert.deepEqual(systemApps.json.map((a: any) => a.bundle_id), ["com.apple.camera"]);
  const put = await admin("/api/apps/com.example.new", MAC, { method: "PUT", body: { name: "New", app_store_url: "https://apps.apple.com/gb/app/new/id333", min_age: 3 } });
  assert.equal(put.status, 200);
  const row = (await pool.query("SELECT name, type, show_on_site, min_age, enabled FROM kids.apps WHERE bundle_id = 'com.example.new'")).rows[0];
  assert.deepEqual(row, { name: "New", type: "app", show_on_site: false, min_age: 3, enabled: true });
  assert.equal((await admin("/api/apps/com.example.new", MAC, { method: "DELETE" })).status, 200);

  const site = encodeURIComponent("https://kid.example/");
  assert.equal((await admin(`/api/websites/${site}`, MAC, { method: "PUT", body: { name: "Kid site", child_subdomain: "zoe" } })).status, 200);
  assert.equal((await pool.query("SELECT child_id FROM kids.websites WHERE url = 'https://kid.example/'")).rows[0].child_id, "zoe");
  assert.equal((await admin(`/api/websites/${encodeURIComponent("https://bad.example/")}`, MAC, { method: "PUT", body: { name: "Bad", child_subdomain: "nobody" } })).status, 400);
  assert.equal((await admin(`/api/websites/${site}`, MAC, { method: "DELETE" })).status, 200);

  assert.equal((await admin("/api/themes/5", MAC, { method: "PUT", body: { theme: "early", subtitle: "Hello" } })).status, 200);
  assert.equal((await admin("/api/themes", MAC)).json.find((t: any) => t.from_age === 5).subtitle, "Hello");
  assert.equal((await admin("/api/restrictions/ratingApps", MAC, { method: "PUT", body: { value: 300, type: "integer", overridable: true } })).status, 200);
  assert.deepEqual((await admin("/api/restrictions", MAC)).json.find((r: any) => r.key === "ratingApps"), { key: "ratingApps", value: 300, type: "integer", overridable: true });

  // A child is edited in core.people (shared with every home app) and never deleted from here.
  const edit = await admin("/api/children/hannah", MAC, { method: "PUT", body: { name: "Hannah", date_of_birth: "2017-10-07", color: "purple", avatar: "🧜", locked: true, blocked_apps: ["com.example.maths"] } });
  assert.equal(edit.status, 200);
  assert.deepEqual((await pool.query("SELECT color FROM core.people WHERE id = 'hannah'")).rows[0], { color: "purple" });
  assert.equal((await admin("/api/children/hannah", MAC, { method: "DELETE" })).status, 409);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.people WHERE id = 'hannah'")).rows[0].n, 1);
  assert.equal((await admin("/api/children/jonathan", MAC, { method: "PUT", body: { name: "J" } })).status, 409, "a parent is not a child");
  const hannah = await apex("/kid/config", MAC, { headers: { cookie: "tickets_act_as=hannah" } });
  assert.deepEqual(hannah.json.blocked_apps, ["com.example.maths"], "the launcher marks it blocked");
  const profile = await apex("/kid/profile", MAC, { headers: { cookie: "tickets_act_as=hannah" } });
  assert.equal(profile.status, 200);
  assert.ok(!profile.bytes.includes("com.example.maths"), "and the profile's allowlist drops it");
  await admin("/api/children/hannah", MAC, { method: "PUT", body: { name: "Hannah", date_of_birth: "2017-10-07", color: "red", avatar: "🧜", locked: true } });
});

test("term dates read from core, written only in Snacks; retired routes say so", { skip: !url }, async () => {
  const terms = await admin("/api/term-dates", MAC);
  assert.equal(terms.status, 200);
  assert.ok(JSON.stringify(terms.json).includes("2026-09-03"));
  assert.equal((await admin("/api/term-dates/2026-2027", MAC, { method: "PUT", body: { terms: [] } })).status, 405);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.term_dates")).rows[0].n, 1);
  for (const p of ["/api/chores/rooms", "/api/budgets"]) assert.equal((await admin(p, MAC)).status, 410, p);
  assert.equal((await admin("/api/children/zoe/pair", MAC, { method: "POST" })).status, 410);
  assert.deepEqual((await admin("/api/pairings", MAC)).json, []);
  assert.equal((await admin("/api/rebuild", MAC, { method: "POST" })).status, 202);
  for (const p of ["/api/tasks", "/api/rewards", "/api/board"]) assert.equal((await admin(p, MAC)).status, 410, `${p}: tickets has its own admin`);
  assert.equal((await call("tickets.wainwright.fun", "/api/health", null)).status, 200);
  const icons = await admin("/api/icons", MAC);
  assert.deepEqual(icons.json, { appIcons: ["111.jpg"], websiteIcons: ["cbeebies.png"], systemIcons: [] });
  const config = await admin("/api/config", MAC);
  assert.equal(config.status, 200);
  assert.match(config.text, /com\.example\.maths/);
});

test("a parent manages devices on the admin; a child and an unknown device cannot", { skip: !url }, async () => {
  const list = await admin("/api/admin/devices", MAC);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.map((d: { ip: string }) => d.ip),
    ["192.168.1.170", "192.168.1.182", "192.168.1.219", "192.168.1.98"],
  );
  assert.deepEqual(list.json.find((d: { ip: string }) => d.ip === MAC), { ip: MAC, mac: null, personId: "jonathan", label: "Mac Studio" });

  const people = await admin("/api/admin/people", MAC);
  assert.equal(people.status, 200);
  assert.ok(people.json.some((p: { id: string; role: string }) => p.id === "jonathan" && p.role === "parent"));
  assert.ok(people.json.some((p: { id: string; role: string }) => p.id === "ethan" && p.role === "child"));

  const kid = await admin("/api/admin/devices", ZOE);
  assert.equal(kid.status, 403);
  assert.equal(kid.json.notSetUp, undefined);
  assert.equal((await admin("/api/admin/devices", ZOE, { method: "PUT", body: { ip: "192.168.1.50", personId: "ethan" } })).status, 403);
  assert.equal((await admin("/api/admin/devices?ip=192.168.1.98", ZOE, { method: "DELETE" })).status, 403);

  const unknown = await admin("/api/admin/devices", STRANGER);
  assert.equal(unknown.status, 403);
  assert.deepEqual(unknown.json, { error: "This device isn't set up", notSetUp: true });
  const unknownPut = await admin("/api/admin/devices", null, { method: "PUT", body: { ip: "192.168.1.50", personId: "ethan" } });
  assert.deepEqual(unknownPut.json, { error: "This device isn't set up", notSetUp: true });

  assert.equal((await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: "192.168.1.999", personId: "ethan" } })).json.error, "ip must be an IPv4 address");
  assert.equal((await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: "2001:db8::1", personId: "ethan" } })).status, 400);
  assert.equal((await admin("/api/admin/devices", MAC, { method: "PUT", body: { personId: "ethan" } })).status, 400);
  assert.match((await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: "192.168.1.50", personId: "nobody" } })).json.error, /Unknown person/);
  assert.equal((await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: "192.168.1.50", personId: "ethan", mac: "not-a-mac" } })).json.error, "mac must be a MAC address");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.devices WHERE ip = '192.168.1.50'")).rows[0].n, 0, "rejected puts write nothing");

  const put = await admin("/api/admin/devices", MAC, {
    method: "PUT",
    body: { ip: "192.168.1.50", personId: " ethan ", label: " Ethan iPad ", mac: "AA:BB:CC:DD:EE:FF" },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { ip: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff", personId: "ethan", label: "Ethan iPad" });
  const again = await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: "192.168.1.50", personId: "joanna", label: "Joanna iPad" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.personId, "joanna");
  assert.equal(again.json.mac, null, "an omitted mac is cleared");
  assert.equal(again.json.label, "Joanna iPad");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.devices WHERE ip = '192.168.1.50'")).rows[0].n, 1, "upsert does not duplicate");

  const relabel = await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: MAC, personId: "jonathan", label: "Studio", mac: "00:11:22:33:44:55" } });
  assert.equal(relabel.status, 200);
  const keep = await admin(`/api/admin/devices?ip=${encodeURIComponent(MAC)}`, MAC, { method: "DELETE" });
  assert.equal(keep.status, 409);
  assert.match(keep.json.error, /device you're using/);
  assert.equal((await pool.query("SELECT label FROM core.devices WHERE ip = '192.168.1.170'")).rows[0].label, "Studio");

  assert.equal((await admin("/api/admin/devices", MAC, { method: "DELETE" })).json.error, "ip is required");
  assert.equal((await admin("/api/admin/devices?ip=192.168.1.50", MAC, { method: "DELETE" })).status, 200);
  assert.equal((await admin("/api/admin/devices?ip=192.168.1.50", MAC, { method: "DELETE" })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.devices WHERE ip = '192.168.1.50'")).rows[0].n, 0);
  assert.equal((await admin("/api/admin/devices", MAC, { method: "POST" })).status, 405);
  assert.equal((await admin("/api/admin/people", MAC, { method: "DELETE" })).status, 405);

  // Put the parent's device back how the other tests expect it.
  await admin("/api/admin/devices", MAC, { method: "PUT", body: { ip: MAC, personId: "jonathan", label: "Mac Studio" } });
});

test("hosted redirects are kept: www to the apex, the apex admin paths to admin", { skip: !url }, async () => {
  const www = await call("www.wainwright.fun", "/x?y=1", null);
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, "https://wainwright.fun/x?y=1");
  const toAdmin = await apex("/admin/apps", ZOE);
  assert.equal(toAdmin.status, 301);
  assert.equal(toAdmin.headers.location, "https://admin.wainwright.fun/admin/apps");
  assert.equal((await apex("/website-icons/cbeebies.png", ZOE)).status, 200);
  assert.equal((await call("tickets.wainwright.fun", "/api/health", null)).status, 200, "other hosts stay tickets");
  assert.equal((await call("api.wainwright.fun", "/api/health", null)).status, 200, "api stays off the launcher");
  assert.equal((await call("bible.wainwright.fun", "/api/health", null)).status, 200, "other apps stay tickets");
});

test("a child's hostname is the launcher and reads the local database", { skip: !url }, async () => {
  const hannahIp = "192.168.1.182";
  const onHannah = await call("hannah.wainwright.fun", "/kid/config", hannahIp);
  assert.equal(onHannah.status, 200);
  assert.equal(onHannah.json.child.subdomain, "hannah", "the hostname is not which child");
  const onZoeViaHannah = await call("hannah.wainwright.fun", "/kid/config", ZOE);
  assert.equal(onZoeViaHannah.json.child.subdomain, "zoe");
  assert.equal((await call("zoe.wainwright.fun", "/website-icons/cbeebies.png", ZOE)).status, 200);
  assert.equal((await call("hannah.wainwright.fun", "/admin/apps", ZOE)).headers.location, "https://admin.wainwright.fun/admin/apps");
  assert.equal((await call("preview.example", "/kid/config", ZOE)).json.child.subdomain, "zoe", "KIDS_LAUNCHER_HOSTS");
  assert.equal((await call("nobody.wainwright.fun", "/api/health", null)).status, 200, "an unknown label stays tickets");

  const site = "https://homeassistant.local/";
  const put = await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, {
    method: "PUT",
    body: { name: "Home Assistant", min_age: 0, enabled: true },
  });
  assert.equal(put.status, 200);
  try {
    const config = await call("hannah.wainwright.fun", "/kid/config", hannahIp);
    const row = (config.json.websites as { name: string; url: string; icon_url?: string }[]).find((w) => w.url === site);
    assert.equal(row?.name, "Home Assistant");
    assert.equal(row?.icon_url, "/website-icons/homeassistant.local.png");
  } finally {
    await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "DELETE" });
  }
});

test("saving a website fetches its icon without blocking, and the icon route serves it", { skip: !url, timeout: 15_000 }, async () => {
  const site = "https://homeassistant.example/";
  const file = path.join(iconsDir, "website-icons", "homeassistant.example.png");
  iconPages.set(site, `<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">`);
  iconFiles.set("https://homeassistant.example/apple-touch-icon.png", { body: ICON_PNG, type: "image/png" });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  iconHolds.set(site, gate);
  try {
    const put = await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, {
      method: "PUT",
      body: { name: "Home Assistant", min_age: 0, enabled: true },
      timeout: 3000,
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.name, "Home Assistant");
    assert.equal(existsSync(file), false, "the save returns before the icon download finishes");
    release();
    await settleIcons();
    assert.deepEqual(await readFile(file), ICON_PNG);
    const icon = await apex("/website-icons/homeassistant.example.png", ZOE);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers["content-type"], "image/png");
    assert.ok(icon.bytes.equals(ICON_PNG));
  } finally {
    release();
    iconHolds.delete(site);
    await settleIcons();
    await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "DELETE" });
  }
});

test("a failed icon fetch does not fail the save", { skip: !url }, async () => {
  const site = "https://broken.example/";
  const put = await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "PUT", body: { name: "Broken" } });
  assert.equal(put.status, 200);
  await settleIcons();
  assert.equal(existsSync(path.join(iconsDir, "website-icons", "broken.example.png")), false);
  await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "DELETE" });
});

test("saving an app fetches App Store artwork into app-icons/{id}.jpg", { skip: !url }, async () => {
  iconArtwork.set("999", "https://artwork.test/999.jpg");
  iconFiles.set("https://artwork.test/999.jpg", { body: ICON_JPEG, type: "image/jpeg" });
  const put = await admin("/api/apps/com.example.home", MAC, {
    method: "PUT",
    body: { name: "Home", app_store_url: "https://apps.apple.com/gb/app/home/id999", min_age: 0 },
  });
  assert.equal(put.status, 200);
  await settleIcons();
  const file = path.join(iconsDir, "app-icons", "999.jpg");
  assert.deepEqual(await readFile(file), ICON_JPEG);
  const icon = await apex("/app-icons/999.jpg", ZOE);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/jpeg");
  assert.ok(icon.bytes.equals(ICON_JPEG));
  await admin("/api/apps/com.example.home", MAC, { method: "DELETE" });
});

test("POST /api/icons/fetch backfills a missing icon and leaves an existing one", { skip: !url }, async () => {
  assert.equal((await admin("/api/icons/fetch", ZOE, { method: "POST" })).status, 403);
  const site = "https://backfill.example/";
  iconPages.set(site, `<link rel="icon" href="/favicon.png" sizes="128x128">`);
  iconFiles.set("https://backfill.example/favicon.png", { body: ICON_PNG, type: "image/png" });
  const put = await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "PUT", body: { name: "Backfill" } });
  assert.equal(put.status, 200);
  await settleIcons();
  const file = path.join(iconsDir, "website-icons", "backfill.example.png");
  const cbeebies = path.join(iconsDir, "website-icons", "cbeebies.png");
  const maths = path.join(iconsDir, "app-icons", "111.jpg");
  const cbeebiesBefore = await readFile(cbeebies);
  const mathsBefore = await readFile(maths);
  await unlink(file);
  const report = await admin("/api/icons/fetch", MAC, { method: "POST" });
  assert.equal(report.status, 200);
  assert.ok(report.json.downloaded >= 1, JSON.stringify(report.json));
  assert.deepEqual(await readFile(file), ICON_PNG);
  assert.deepEqual(await readFile(cbeebies), cbeebiesBefore);
  assert.deepEqual(await readFile(maths), mathsBefore);
  const icon = await apex("/website-icons/backfill.example.png", ZOE);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/png");
  await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "DELETE" });
});

test("homework domains need the bearer token and skip the device check", { skip: !url }, async () => {
  const bible = "https:/bible.wainwright.fun/";
  const news = "https://www.bbc.co.uk/news";
  const cbbc = "https://www.BBC.co.uk/cbbc";
  const plain = "https://play.example/";
  const off = "https://closed.example/";
  const zoeSite = "https://zoe.example/stories";
  const sites = [
    [bible, { name: "Bible", homework: true, min_age: 0, enabled: true }],
    [news, { name: "Newsround", homework: true, min_age: 6, enabled: true }],
    [cbbc, { name: "CBBC", homework: true, min_age: 6, enabled: true }],
    [plain, { name: "Play", homework: false, min_age: 0, enabled: true }],
    [off, { name: "Closed", homework: true, min_age: 0, enabled: false }],
    [zoeSite, { name: "Zoe stories", homework: true, min_age: 0, enabled: true, child_subdomain: "zoe" }],
  ] as const;
  try {
    for (const [site, body] of sites) {
      assert.equal((await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "PUT", body })).status, 200);
    }
    const listed = await admin("/api/websites", MAC);
    const bibleRow = listed.json.find((site: { url: string }) => site.url === bible);
    assert.equal(bibleRow.homework, true);
    assert.equal(listed.json.find((site: { url: string }) => site.url === plain).homework, false);
    assert.equal((await pool.query("SELECT homework FROM kids.websites WHERE url = $1", [bible])).rows[0].homework, true);

    const stranger = await apex("/api/ha/homework-domains", STRANGER);
    assert.equal(stranger.status, 401, "a wrong device is not consulted; the token is");
    assert.equal(stranger.json.error, "Unauthorized");
    assert.equal((await apex("/api/ha/homework-domains", null)).status, 401);
    assert.equal((await apex("/api/ha/homework-domains", null, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await apex("/api/ha/homework-domains", MAC, { method: "POST", headers: { authorization: `Bearer ${DOMAINS_TOKEN}` } })).status, 405);
    const saved = await readFile(domainsTokenFile, "utf8");
    await unlink(domainsTokenFile);
    assert.equal((await apex("/api/ha/homework-domains", null, { headers: { authorization: `Bearer ${DOMAINS_TOKEN}` } })).status, 401);
    await writeFile(domainsTokenFile, saved);

    const domains = await apex("/api/ha/homework-domains", null, { headers: { authorization: `Bearer ${DOMAINS_TOKEN}` } });
    assert.equal(domains.status, 200);
    assert.deepEqual(domains.json.domains, ["bible.wainwright.fun", "www.bbc.co.uk", "zoe.example"]);
    assert.deepEqual(
      domains.json.sites.map((site: { name: string; domain: string; child_id: string | null }) => [site.name, site.domain, site.child_id]),
      [
        ["Bible", "bible.wainwright.fun", null],
        ["CBBC", "www.bbc.co.uk", null],
        ["Newsround", "www.bbc.co.uk", null],
        ["Zoe stories", "zoe.example", "zoe"],
      ],
    );
    assert.equal(domains.json.sites.filter((site: { domain: string }) => site.domain === "www.bbc.co.uk").length, 2);
    assert.equal(domains.json.children.lydia.allowance_seconds, 3600);
    assert.equal(domains.json.children.joanna.allowance_seconds, 3600);
    assert.equal(domains.json.updated_at, "2026-10-08T12:00:00.000Z");
    assert.doesNotMatch(domains.text, new RegExp(DOMAINS_TOKEN));
    assert.equal((await call("hannah.wainwright.fun", "/api/ha/homework-domains", null, { headers: { authorization: `Bearer ${DOMAINS_TOKEN}` } })).status, 200);
    assert.notEqual((await call("tickets.wainwright.fun", "/api/ha/homework-domains", null, { headers: { authorization: `Bearer ${DOMAINS_TOKEN}` } })).status, 200);
  } finally {
    if (!existsSync(domainsTokenFile)) await writeFile(domainsTokenFile, `${DOMAINS_TOKEN}\n`);
    for (const [site] of sites) await admin(`/api/websites/${encodeURIComponent(site)}`, MAC, { method: "DELETE" });
    await settleIcons();
  }
});

test("a child's internet mode follows the device, and Home Assistant failures stay on that route", { skip: !url }, async () => {
  haCalls.length = 0;
  haDown = false;
  const beforeCalls = haCalls.length;
  const joanna = await apex("/kid/internet", MAC, { headers: { cookie: "tickets_act_as=joanna" } });
  assert.equal(joanna.status, 200);
  assert.deepEqual(joanna.json, { available: false });
  assert.equal(haCalls.length, beforeCalls, "Joanna is not sent to Home Assistant");
  assert.equal((await apex("/kid/internet", null)).status, 403);
  assert.equal((await apex("/kid/internet", MAC)).status, 401);

  const zoe = await apex("/kid/internet", ZOE);
  assert.equal(zoe.status, 200);
  assert.equal(zoe.json.available, true);
  assert.equal(zoe.json.child_id, "zoe");
  assert.equal(zoe.json.allowance_seconds, 3600, "the database allowance replaces Home Assistant's copy");
  assert.equal(haCalls.at(-1)?.path, "/api/wainwright_fun/kids/zoe");
  assert.doesNotMatch(zoe.text, new RegExp(HA_TOKEN));

  const posted = await apex("/kid/internet/mode", ZOE, {
    method: "POST",
    body: { mode: "internet", child_id: "hannah", allowance_seconds: 1 },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.json.child_id, "zoe");
  assert.equal(posted.json.mode, "internet");
  assert.equal(haCalls.at(-1)?.path, "/api/wainwright_fun/kids/zoe/mode");
  assert.deepEqual(haCalls.at(-1)?.body, { mode: "internet", allowance_seconds: 3600 });
  assert.equal((await apex("/kid/config", ZOE)).status, 200, "the launcher still loads in internet mode");

  await admin("/api/children/lydia", MAC, {
    method: "PUT",
    body: { name: "Lydia", date_of_birth: "2019-04-25", color: "green", avatar: "🐸", locked: true, allowance_seconds: 1800 },
  });
  const lydia = await call("lydia.wainwright.fun", "/kid/internet/mode", LYDIA, { method: "POST", body: { mode: "homework" } });
  assert.equal(lydia.status, 200);
  assert.equal(lydia.json.mode, "homework");
  assert.equal(haCalls.at(-1)?.path, "/api/wainwright_fun/kids/lydia/mode");
  assert.deepEqual(haCalls.at(-1)?.body, { mode: "homework" });
  const kept = await admin("/api/children/lydia", MAC, {
    method: "PUT",
    body: { name: "Lydia", date_of_birth: "2019-04-25", color: "green", avatar: "🐸", locked: true },
  });
  assert.equal(kept.status, 200);
  assert.equal((await pool.query("SELECT allowance_seconds FROM kids.child_settings WHERE child_id = 'lydia'")).rows[0].allowance_seconds, 1800);
  assert.equal((await admin("/api/children", MAC)).json.find((child: { subdomain: string }) => child.subdomain === "lydia").allowance_seconds, 1800);

  const blocked = await apex("/kid/internet/mode", ZOE, { method: "POST", body: { mode: "off" } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.reason, "Internet stays on until the timer ends");

  const savedToken = await readFile(haTokenFile, "utf8");
  await writeFile(haTokenFile, "");
  const missing = await apex("/kid/internet", ZOE);
  assert.equal(missing.status, 503);
  assert.equal(missing.json.error, "internet controls unavailable");
  await writeFile(haTokenFile, savedToken);

  haDown = true;
  try {
    const down = await apex("/kid/internet", ZOE);
    assert.equal(down.status, 503);
    assert.equal(down.json.error, "internet controls unavailable");
    assert.equal((await apex("/kid/config", ZOE)).status, 200);
  } finally {
    haDown = false;
  }
});

test("a parent can end a break, and the kid page is told the break fields", { skip: !url }, async () => {
  haCalls.length = 0;
  haDown = false;
  haBreak = {
    on_break: true,
    break_ends_at: "2026-11-14T12:10:00.000Z",
    break_seconds_left: 600,
    homework_available: false,
  };
  try {
    const zoe = await apex("/kid/internet", ZOE);
    assert.equal(zoe.status, 200);
    assert.equal(zoe.json.on_break, true);
    assert.equal(zoe.json.break_ends_at, "2026-11-14T12:10:00.000Z");
    assert.equal(zoe.json.break_seconds_left, 600);
    assert.equal(zoe.json.homework_available, false);
    assert.equal(zoe.json.allowance_seconds, 3600);

    const paused = await apex("/kid/internet/mode", ZOE, { method: "POST", body: { mode: "homework" } });
    assert.equal(paused.status, 409);
    assert.equal(paused.json.reason, "internet_break");
    assert.equal(paused.json.error, "Homework mode is paused");

    const kidAttempt = await apex("/kid/internet/mode", ZOE, { method: "POST", body: { end_break: true } });
    assert.equal(kidAttempt.status, 400);

    const stranger = await admin("/api/children/zoe/end-break", ZOE, { method: "POST", body: {} });
    assert.equal(stranger.status, 403);
    const unknown = await admin("/api/children/zoe/end-break", null, { method: "POST", body: {} });
    assert.equal(unknown.status, 403);

    const before = haCalls.length;
    const joanna = await admin("/api/children/joanna/end-break", MAC, { method: "POST", body: { end_break: true, mode: "off" } });
    assert.equal(joanna.status, 404);
    assert.equal(haCalls.length, before, "Joanna is not sent to Home Assistant");

    const ended = await admin("/api/children/zoe/end-break", MAC, { method: "POST", body: { mode: "homework", homework_declared: "skipped", end_break: true } });
    assert.equal(ended.status, 200);
    assert.equal(ended.json.on_break, false);
    assert.equal(ended.json.homework_available, true);
    assert.deepEqual(haCalls.at(-1)?.body, { end_break: true });
    assert.deepEqual(Object.keys(haCalls.at(-1)?.body as object), ["end_break"]);
    assert.equal(haCalls.at(-1)?.path, "/api/wainwright_fun/kids/zoe/mode");

    const again = await admin("/api/children/hannah/end-break", MAC, { method: "POST" });
    assert.equal(again.status, 200);
    assert.deepEqual(haCalls.at(-1)?.body, { end_break: true });

    const status = await admin("/api/children/lydia/internet", MAC);
    assert.equal(status.status, 200);
    assert.equal(status.json.child_id, "lydia");
    assert.equal(status.json.on_break, false);
    assert.equal((await admin("/api/children/joanna/internet", MAC)).status, 404);
    assert.equal((await admin("/api/children/zoe/end-break", MAC)).status, 405);

    haDown = true;
    const down = await admin("/api/children/ethan/end-break", MAC, { method: "POST", body: {} });
    assert.equal(down.status, 503);
    assert.equal(down.json.error, "internet controls unavailable");
    assert.equal((await admin("/api/children", MAC)).status, 200);
  } finally {
    haDown = false;
    haBreak = null;
  }
});

test("a letter to Santa stays hidden until 15 Nov 2026 London, then the device's child is stored", { skip: !url }, async () => {
  const hannahIp = "192.168.1.182";
  const before = Number((await pool.query("SELECT count(*)::int AS n FROM kids.santa_letters")).rows[0].n);
  const closed = await apex("/kid/santa", hannahIp);
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.json, { open: false });
  const refused = await apex("/kid/santa", hannahIp, {
    method: "POST",
    body: { answers: { love: { picks: ["building"], favourite: "building" } }, ownLine: "Too early" },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /not open/i);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM kids.santa_letters")).rows[0].n), before);

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const open = (pathname: string, ip: string | null, init?: Parameters<typeof call>[3]) => call("wainwright.fun", pathname, ip, { ...init, port: openPort });
  const form = await open("/kid/santa", hannahIp);
  assert.equal(form.json.open, true);
  assert.equal(form.json.child.id, "hannah");
  assert.equal(form.json.age, 9);
  assert.equal(form.json.style, "reading");
  const hannahChoices = form.json.questions.flatMap((question: { options: { id: string }[] }) => question.options.map((option) => option.id));
  assert.equal(hannahChoices.includes("harry-potter"), true);
  assert.equal(hannahChoices.includes("science"), true);

  const zoeOnHannahHost = await call("hannah.wainwright.fun", "/kid/santa", ZOE, { port: openPort });
  assert.equal(zoeOnHannahHost.json.child.id, "zoe");
  assert.equal(zoeOnHannahHost.json.age, 6);
  assert.equal(zoeOnHannahHost.json.style, "tiles");
  const zoeChoices = zoeOnHannahHost.json.questions.flatMap((question: { options: { id: string }[] }) => question.options.map((option) => option.id));
  assert.equal(zoeChoices.includes("science"), true);
  assert.equal(zoeChoices.includes("harry-potter"), false);
  assert.equal(zoeChoices.includes("ninjago"), false);

  const tooMany = await open("/kid/santa", hannahIp, {
    method: "POST",
    body: { answers: { love: { picks: ["building", "music", "arts", "jigsaws"] } } },
  });
  assert.equal(tooMany.status, 400);

  const first = await open("/kid/santa", hannahIp, {
    method: "POST",
    body: {
      answers: { love: { picks: ["building", "music"], favourite: "music" }, characters: { picks: ["harry-potter"] } },
      ownLine: "The snow is sparkly",
      drawing: png,
    },
  });
  assert.equal(first.status, 200);
  assert.match(first.json.letter.letterText, /My name is Hannah and I'm 9/);
  assert.match(first.json.letter.letterText, /but music is the best of all/);
  assert.match(first.json.letter.letterText, /I've drawn you a picture too!/);
  assert.match(first.json.letter.letterText, /P\.S\. The snow is sparkly\./);
  assert.match(first.json.letter.letterText, /Love from Hannah/);
  assert.doesNotMatch(first.json.letter.letterText, /\bI want\b|\bbring me\b|\bplease get\b|\bI will get\b|\bI'll get\b|\byou'll get\b/i);
  assert.match(first.json.letter.drawingPng, /^data:image\/png;base64,/);
  assert.equal(first.json.letter.clientIp, undefined);

  const row = (await pool.query("SELECT child_id, own_line, letter_text, host(client_ip) AS client_ip, octet_length(drawing_png)::int AS drawing_bytes FROM kids.santa_letters ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(row.child_id, "hannah");
  assert.equal(row.own_line, "The snow is sparkly");
  assert.equal(row.client_ip, hannahIp);
  assert.ok(row.drawing_bytes > 8);
  assert.match(row.letter_text, /Harry Potter/);

  const second = await open("/kid/santa", hannahIp, {
    method: "POST",
    body: { answers: { cosy: { picks: ["story-book"], favourite: "story-book" } }, ownLine: "Second letter", drawing: png },
  });
  assert.equal(second.status, 200);
  const saved = await open("/kid/santa", hannahIp);
  assert.match(saved.json.latest.letterText, /Second letter/);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM kids.santa_letters WHERE child_id = 'hannah'")).rows[0].n), 2);

  const lydiaHarry = await call("wainwright.fun", "/kid/santa", LYDIA, {
    port: openPort,
    method: "POST",
    body: { answers: { characters: { picks: ["harry-potter"] } } },
  });
  assert.equal(lydiaHarry.status, 400);
  const joanna = await open("/kid/santa", MAC, {
    method: "POST",
    headers: { cookie: "tickets_act_as=joanna" },
    body: { answers: { characters: { picks: ["ninjago"] } } },
  });
  assert.equal(joanna.status, 400);
  const joannaOk = await open("/kid/santa", MAC, {
    method: "POST",
    headers: { cookie: "tickets_act_as=joanna" },
    body: { answers: { love: { picks: ["bath-toys", "books"], favourite: "books" }, characters: { picks: ["bluey"] } } },
  });
  assert.equal(joannaOk.status, 200);
  assert.match(joannaOk.json.letter.letterText, /My name is Joanna and I'm 1/);
  assert.match(joannaOk.json.letter.letterText, /A grown-up helped me write this because I'm still little/);
  assert.match(joannaOk.json.letter.letterText, /splashing about at bath time/);
  assert.match(joannaOk.json.letter.letterText, /Love from Joanna/);
  const ethan = await open("/kid/santa", MAC, {
    method: "POST",
    headers: { cookie: "tickets_act_as=ethan" },
    body: { answers: { love: { picks: ["science"] } } },
  });
  assert.equal(ethan.status, 400);

  const kidAdmin = await call("admin.wainwright.fun", "/api/admin/santa-letters", hannahIp, { port: openPort });
  assert.equal(kidAdmin.status, 403);
  const adminList = await call("admin.wainwright.fun", "/api/admin/santa-letters", MAC, { port: openPort });
  assert.equal(adminList.status, 200);
  const hannah = adminList.json.letters.find((item: { childId: string }) => item.childId === "hannah");
  assert.equal(hannah.submissions, 2);
  assert.match(hannah.latest.letterText, /Second letter/);
  assert.equal(hannah.latest.ownLine, "Second letter");
  assert.match(hannah.latest.drawingPng, /^data:image\/png;base64,/);
  const joannaRow = adminList.json.letters.find((item: { childId: string }) => item.childId === "joanna");
  assert.equal(joannaRow.latest.answers.love.favourite, "books");
  assert.equal((await call("admin.wainwright.fun", "/api/admin/santa-letters", MAC, { method: "POST", port: openPort })).status, 405);
});
