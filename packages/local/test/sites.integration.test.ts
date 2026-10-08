/**
 * wainwright.fun and admin.wainwright.fun end to end against a scratch Postgres database:
 *   KIDS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/kids_local_test npm test
 * Runs the built bundle (npm run build first). Devices are simulated with X-Real-IP from loopback
 * (a trusted proxy, as Caddy is); a request without it is a local caller, i.e. unknown.
 * Profiles are signed with a throwaway certificate made for the test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

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
  CREATE TABLE core.devices (ip inet PRIMARY KEY, mac macaddr, person_id text NOT NULL REFERENCES core.people ON UPDATE CASCADE ON DELETE CASCADE, label text);
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
const servers: { close(): void }[] = [];
let scans = "";
let iconsDir = "";
let certFile = "";
const CBEEBIES_ICON = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

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
  const keyFile = path.join(tmp, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Test Profile Signing", "-days", "1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const log = process.env.KIDS_TEST_LOG ? (l: string) => console.error(l) : () => {};
  const tickets = createLocalTickets({ pool, log });
  const options = { pool, tickets, kidsIconsDir: iconsDir, log, now: () => new Date("2026-10-08T12:00:00Z") };
  port = await listen(createLocalSites({ ...options, signer: { certFile, keyFile } }));
  unsignedPort = await listen(createLocalSites({ ...options, signer: null }));
});

after(async () => {
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

function call(host: string, pathname: string, ip: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string>; port?: number } = {}): Promise<Reply> {
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
  assert.equal((await admin("/api/tasks", MAC)).status, 200, "the Tickets tab reaches the tickets API");
  const icons = await admin("/api/icons", MAC);
  assert.deepEqual(icons.json, { appIcons: ["111.jpg"], websiteIcons: ["cbeebies.png"], systemIcons: [] });
  const config = await admin("/api/config", MAC);
  assert.equal(config.status, 200);
  assert.match(config.text, /com\.example\.maths/);
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
});
