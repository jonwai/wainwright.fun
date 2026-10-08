/**
 * End to end against a scratch Postgres database (core and tickets schemas dropped and recreated):
 *   TICKETS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/tickets_local_test npm test
 * Runs the built bundle (npm run build first), so the hosted handlers go through the same shims
 * as production.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

const url = process.env.TICKETS_TEST_DATABASE_URL;
// @ts-ignore built bundle
const { createLocalTickets, PgDocumentClient, applyTicketsMigrations } = await import("../dist/app.mjs");
// @ts-ignore built bundle
const { importHosted, importStragglers, readScans } = await import("../dist/import-hosted.mjs");

const CORE = `
  DROP SCHEMA IF EXISTS tickets CASCADE;
  DROP SCHEMA IF EXISTS core CASCADE;
  DROP TABLE IF EXISTS public.tickets_schema_migrations;
  CREATE SCHEMA core;
  CREATE TABLE core.people (id text PRIMARY KEY, display_name text NOT NULL, role text NOT NULL, sort_order int NOT NULL DEFAULT 0,
    date_of_birth date, color text, avatar text, UNIQUE (id, role));
  CREATE TABLE core.devices (ip inet PRIMARY KEY, mac macaddr, person_id text NOT NULL REFERENCES core.people, label text);
  CREATE TABLE core.term_dates (academic_year text NOT NULL, position int NOT NULL, name text NOT NULL, opens date NOT NULL, closes date NOT NULL,
    half_term_start date, half_term_end date, PRIMARY KEY (academic_year, position));
  INSERT INTO core.people VALUES
    ('hannah', 'Hannah', 'child', 1, '2017-10-07', 'red', '🧜'), ('lydia', 'Lydia', 'child', 2, '2019-04-25', 'green', '🐸'),
    ('zoe', 'Zoe', 'child', 3, '2020-09-12', 'blue', '🍭'), ('ethan', 'Ethan', 'child', 5, '2022-03-27', 'orange', '🦊'),
    ('jonathan', 'Jonathan', 'parent', 6, NULL, NULL, NULL);
  INSERT INTO core.devices (ip, person_id, label) VALUES ('192.168.1.219', 'zoe', 'Zoe iPad'), ('192.168.1.98', 'lydia', 'Lydia iPad'),
    ('192.168.1.170', 'jonathan', 'Mac Studio');
  INSERT INTO core.term_dates VALUES ('2026-2027', 0, 'Autumn', '2026-08-24', '2026-12-18', '2026-10-19', '2026-10-23');
`;

function marshal(value: unknown): unknown {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshal) };
  return { M: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, marshal(v)])) };
}

const T0 = "2026-09-20T09:00:00.000Z";
function hostedFixture() {
  return {
    tasks: [
      { task_id: "tidy-room", title: "Tidy your room", description: null, ticket_reward: 2, assigned_to: [], icon: "tidy-abc123.png", emoji: "🧸", enabled: true, created_at: T0, updated_at: T0 },
      { task_id: "feed-cat", title: "Feed the cat", description: "Morning", ticket_reward: 1, assigned_to: ["zoe", "lydia"], icon: null, emoji: null, enabled: true, created_at: T0, updated_at: T0, future_field: { kept: true } },
    ],
    completions: [
      { child_subdomain: "zoe", task_completion: "tidy-room#2026-09-21T08:00:00.123Z#a1b2c3", task_id: "tidy-room", completed_at: "2026-09-21T08:00:00.123Z", completed_by: "child", tickets: 2 },
      { child_subdomain: "zoe", task_completion: "bonus#2026-09-22T08:00:00.000Z#zz9", task_id: "bonus", completed_at: "2026-09-22T08:00:00.000Z", completed_by: "parent", tickets: 5, label: "Happy Birthday" },
      { child_subdomain: "lydia", task_completion: "feed-cat#2026-09-23T07:00:00.000Z#q", task_id: "feed-cat", completed_at: "2026-09-23T07:00:00.000Z", completed_by: "child", tickets: 1, label: null },
    ],
    board: [],
    rewards: [
      { reward_id: "small-toy", title: "Small toy", description: null, ticket_cost: 5, cost_pence: 300, icon: null, emoji: "🧸", enabled: true, created_at: T0, updated_at: T0 },
      { reward_id: "screen-time", title: "Extra screen time", description: "30 min", ticket_cost: 1, cost_pence: null, icon: null, emoji: "📺", limit_type: "unlimited", stock_remaining: null, period: null, snack_product_slug: null, enabled: true, created_at: T0, updated_at: T0 },
    ],
    redemptions: [
      { child_subdomain: "zoe", redemption_id: "mf1-aaa", reward_id: "small-toy", redeemed_at: "2026-09-24T10:00:00.000Z", redeemed_by: "child", tickets: 5, status: "claimed", claimed_at: "2026-09-25T10:00:00.000Z" },
      { child_subdomain: "zoe", redemption_id: "mf2-bbb", reward_id: "screen-time", redeemed_at: "2026-09-26T10:00:00.000Z", redeemed_by: "child", tickets: 1, status: "pending" },
    ],
  };
}

async function writeScans(dir: string, data: ReturnType<typeof hostedFixture>) {
  const files: Record<string, unknown[]> = {
    tasks: data.tasks,
    "task-completions": data.completions,
    "job-board": data.board,
    rewards: data.rewards,
    "reward-redemptions": data.redemptions,
  };
  for (const [name, items] of Object.entries(files)) {
    const marshalled = items.map((item) => (marshal(item) as { M: unknown }).M);
    await writeFile(path.join(dir, `wainwright-${name}.json`), JSON.stringify({ Items: marshalled, Count: marshalled.length }));
  }
}

let pool: pg.Pool;
let base = "";
let close = () => {};
let scans = "";
let icons = "";

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  await pool.query(CORE);
  await applyTicketsMigrations(pool);
  scans = await mkdtemp(path.join(os.tmpdir(), "tickets-scans-"));
  icons = await mkdtemp(path.join(os.tmpdir(), "tickets-icons-"));
  const listener = createLocalTickets({ pool, iconsDir: icons, log: process.env.TICKETS_TEST_LOG ? (l: string) => console.error(l) : () => {} });
  const server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(async () => {
  close();
  await pool?.end();
});

async function call(pathname: string, ip: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (ip) headers["x-real-ip"] = ip;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body, cookie: response.headers.get("set-cookie") };
}
const ZOE = "192.168.1.219";
const LYDIA = "192.168.1.98";
const PARENT = "192.168.1.170";
const UNKNOWN = "192.168.1.50";

test("imports hosted tickets exactly, and again idempotently", { skip: !url }, async () => {
  const data = hostedFixture();
  await writeScans(scans, data);
  const report = await importHosted(pool, await readScans(scans));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.counts, {
    tasks: { hosted: 2, local: 2 },
    board: { hosted: 0, local: 0 },
    rewards: { hosted: 2, local: 2 },
    completions: { hosted: 3, local: 3 },
    redemptions: { hosted: 2, local: 2 },
  });
  assert.deepEqual(report.balances.zoe, { hosted: 1, local: 1 });
  assert.deepEqual(report.balances.lydia, { hosted: 1, local: 1 });
  assert.deepEqual(report.pending, { hosted: 1, local: 1 });
  const extra = await pool.query("SELECT extra FROM tickets.tasks WHERE task_id = 'feed-cat'");
  assert.deepEqual(extra.rows[0].extra, { future_field: { kept: true } });

  const again = await importHosted(pool, await readScans(scans));
  assert.equal(again.ok, true);
  assert.deepEqual(again.removed, { awards: 0, redemptions: 0 });

  // Hosted undid Lydia's job and refunded Zoe's pending reward: the next import follows.
  const changed = hostedFixture();
  changed.completions = changed.completions.filter((c) => c.child_subdomain !== "lydia");
  changed.redemptions = changed.redemptions.filter((r) => r.status !== "pending");
  await writeScans(scans, changed);
  const followed = await importHosted(pool, await readScans(scans));
  assert.equal(followed.ok, true, JSON.stringify(followed));
  assert.deepEqual(followed.removed, { awards: 1, redemptions: 1 });
  await writeScans(scans, data);
  assert.equal((await importHosted(pool, await readScans(scans))).ok, true);

  // A dry run changes nothing.
  await pool.query("UPDATE tickets.rewards SET title = 'Edited' WHERE reward_id = 'small-toy'");
  const dry = await importHosted(pool, await readScans(scans), { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal((await pool.query("SELECT title FROM tickets.rewards WHERE reward_id = 'small-toy'")).rows[0].title, "Edited");
  assert.equal((await importHosted(pool, await readScans(scans))).ok, true);
});

test("IP address only: unknown devices get nothing; kids never get admin", { skip: !url }, async () => {
  for (const p of ["/api/kid/tasks", "/api/kid/rewards", "/api/tasks", "/api/children", "/api/local/whoami"]) {
    const r = await call(p, UNKNOWN);
    assert.deepEqual([p, r.status, r.body], [p, 403, { error: "This device isn't set up", notSetUp: true }]);
  }
  assert.equal((await call("/api/kid/tasks", null)).status, 403);
  const page = await call("/", UNKNOWN);
  assert.equal(page.status, 403);
  assert.match(page.body, /This device isn't set up/);
  assert.equal((await call("/admin/", UNKNOWN)).status, 403);
  assert.equal((await call("/api/health", null)).status, 200);

  for (const p of ["/api/tasks", "/api/rewards", "/api/rewards/redemptions", "/api/tasks/completions", "/api/board", "/api/children"]) {
    assert.equal((await call(p, ZOE)).status, 403, p);
  }
  assert.equal((await call("/api/tasks/tidy-room/children/zoe/complete", ZOE, { method: "POST", body: {} })).status, 403);
  assert.equal((await call("/admin/", ZOE)).status, 403);
  // The child header the server sets cannot be supplied by the client.
  const spoof = await call("/api/kid/tasks", ZOE, { headers: { "x-local-child": "lydia", "x-tickets-act-as": "lydia", authorization: "Bearer x" } });
  assert.equal(spoof.status, 200);
  assert.deepEqual(spoof.body.tasks.map((t: any) => t.task_id).sort(), ["feed-cat", "tidy-room"]);
  assert.equal(spoof.body.total_tickets, 7);
  assert.equal((await call("/api/local/session", ZOE, { method: "POST", body: { actAs: "lydia" } })).status, 403);
  assert.equal((await call("/api/local/session", ZOE, { method: "POST", body: { me: "jonathan" } })).status, 400);
  assert.equal((await call("/api/pair", ZOE, { method: "POST", body: { code: "ABCD2345" } })).status, 410);
  assert.deepEqual((await call("/api/local/whoami", ZOE)).body.people, []);
});

test("a parent's device is admin and can act as a child", { skip: !url }, async () => {
  assert.equal((await call("/api/kid/tasks", PARENT)).status, 401);
  const who = await call("/api/local/whoami", PARENT);
  assert.equal(who.body.viewer.admin, true);
  const session = await call("/api/local/session", PARENT, { method: "POST", body: { actAs: "lydia" } });
  assert.equal(session.status, 200);
  assert.match(session.cookie ?? "", /tickets_act_as=lydia/);
  const asLydia = await call("/api/kid/tasks", PARENT, { headers: { "x-tickets-act-as": "lydia" } });
  assert.equal(asLydia.body.total_tickets, 1);
  const tasks = await call("/api/tasks", PARENT);
  assert.equal(tasks.status, 200);
  assert.equal(tasks.body.tasks?.length ?? tasks.body.length, 2);
  const children = await call("/api/children", PARENT);
  assert.deepEqual(children.body[0], { subdomain: "hannah", name: "Hannah", date_of_birth: "2017-10-07", color: "red", avatar: "🧜", locked: true });
  const rewards = await call("/api/rewards", PARENT);
  assert.equal(rewards.status, 200);
  const redemptions = await call("/api/rewards/redemptions", PARENT);
  assert.equal(redemptions.status, 200);

  // Bonus award and a task completed on a child's behalf.
  const bonus = await call("/api/tasks/bonus/children/ethan/award", PARENT, { method: "POST", body: { label: "Good sport", tickets: 3 } });
  assert.equal(bonus.status, 200, JSON.stringify(bonus.body));
  const done = await call("/api/tasks/tidy-room/children/ethan/complete", PARENT, { method: "POST", body: {} });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual((await pool.query("SELECT spendable FROM tickets.balances WHERE child_id = 'ethan'")).rows[0], { spendable: 5 });
  const undo = await call("/api/tasks/tidy-room/children/ethan/undo", PARENT, { method: "POST", body: {} });
  assert.equal(undo.status, 200);
  // An award for a non-child fails on the database's rules and leaves nothing behind.
  const bad = await call("/api/tasks/bonus/children/jonathan/award", PARENT, { method: "POST", body: { label: "x", tickets: 1 } });
  assert.deepEqual([bad.status, bad.body], [400, { error: "That breaks a data rule (unknown child or invalid value)" }]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE child_id = 'jonathan'")).rows[0].n, 0);

  // Icon upload lands on disk and is served to known devices.
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const upload = await call("/api/tasks/icons", PARENT, { method: "POST", body: { content_type: "image/png", data: png, name: "Cat.png" } });
  assert.equal(upload.status, 200);
  assert.match(upload.body.icon, /^cat-[0-9a-f]{6}\.png$/);
  assert.equal((await readFile(path.join(icons, upload.body.icon))).length, 8);
  const served = await fetch(`${base}${upload.body.icon_url}`, { headers: { "x-real-ip": ZOE } });
  assert.equal(served.status, 200);
  assert.equal((await fetch(`${base}${upload.body.icon_url}`, { headers: { "x-real-ip": UNKNOWN } })).status, 403);
});

test("a child completes, undoes, redeems and refunds; balances hold", { skip: !url }, async () => {
  const before = await call("/api/kid/tasks", LYDIA);
  assert.equal(before.body.total_tickets, 1);
  const done = await call("/api/kid/tasks/feed-cat/complete", LYDIA, { method: "POST" });
  assert.equal(done.status, 200);
  assert.equal(done.body.total_tickets, 2);
  const history = await call("/api/kid/tasks/history", LYDIA);
  assert.equal(history.body.completions[0].title, "Feed the cat");
  assert.equal((await call("/api/kid/tasks/feed-cat/undo", LYDIA, { method: "POST" })).body.total_tickets, 1);
  assert.equal((await call("/api/kid/tasks/feed-cat/complete", LYDIA, { method: "POST" })).status, 200);

  const tooDear = await call("/api/kid/rewards/small-toy/redeem", LYDIA, { method: "POST" });
  assert.equal(tooDear.status, 400);
  const rewards = await call("/api/kid/rewards", LYDIA);
  assert.equal(rewards.body.spendable_tickets, 2);
  assert.equal(rewards.body.rewards.some((r: any) => "cost_pence" in r), false, "kid routes never show cost_pence");
  const redeemed = await call("/api/kid/rewards/screen-time/redeem", LYDIA, { method: "POST" });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.spendable_tickets, 1);
  const refund = await call("/api/kid/rewards/refund", LYDIA, { method: "POST" });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.spendable_tickets, 2);
});

test("two redeems at once cannot overspend", { skip: !url }, async () => {
  // Lydia has 2 tickets; screen time costs 1. Five parallel redeems: exactly two succeed.
  const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/kid/rewards/screen-time/redeem", LYDIA, { method: "POST" })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 400, 400, 400]);
  assert.deepEqual((await pool.query("SELECT spendable FROM tickets.balances WHERE child_id = 'lydia'")).rows[0], { spendable: 0 });
});

test("other apps award in their own transaction, idempotently; household awards stay household's", { skip: !url }, async () => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const first = await db.query("SELECT tickets.award('zoe', 'chores#hoover-bathroom', 3, 'Hoover the bathroom', 'household', 'hoover-bathroom#2026-10-08T09:00:00.000Z#zoe', '2026-10-08T09:00:00Z') AS id");
    const repeat = await db.query("SELECT tickets.award('zoe', 'chores#hoover-bathroom', 3, 'Hoover the bathroom', 'household', 'hoover-bathroom#2026-10-08T09:00:00.000Z#zoe', '2026-10-08T09:00:00Z') AS id");
    assert.equal(first.rows[0].id, repeat.rows[0].id);
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE source = 'household'")).rows[0].n, 0, "rolled back with its transaction");

  await pool.query("SELECT tickets.award('zoe', 'chores#hoover-bathroom', 3, 'Hoover the bathroom', 'household', 'ref-1', '2026-10-08T09:00:00Z')");
  const tasks = await call("/api/kid/tasks", ZOE);
  assert.equal(tasks.body.total_tickets, 10);
  assert.equal(tasks.body.tasks.some((t: any) => t.task_id.startsWith("chores#")), false, "chores are not jobs in the tickets app");
  const history = await call("/api/kid/tasks/history", ZOE);
  const chore = history.body.completions.find((c: any) => c.task_id === "chores#hoover-bathroom");
  assert.equal(chore.title, "Hoover the bathroom");
  // Hosted does not decode task ids in paths, so a chore cannot even be addressed from here...
  assert.equal((await call("/api/kid/tasks/chores%23hoover-bathroom/undo", ZOE, { method: "POST" })).status, 404);
  assert.equal((await call("/api/tasks/chores%23hoover-bathroom/children/zoe/undo", PARENT, { method: "POST", body: {} })).status, 404);
  // ...and if a hosted change ever did, the adapter refuses to delete or overwrite household's award.
  const key = (await pool.query("SELECT task_completion FROM tickets.awards WHERE source_ref = 'ref-1'")).rows[0];
  const db2 = await pool.connect();
  try {
    const ddb = new PgDocumentClient(db2);
    const Key = { child_subdomain: "zoe", task_completion: key.task_completion };
    await assert.rejects(ddb.send({ constructor: { name: "DeleteCommand" }, input: { TableName: "task-completions", Key } }), /undo the chore in Household/);
    await assert.rejects(
      ddb.send({ constructor: { name: "PutCommand" }, input: { TableName: "task-completions", Item: { ...Key, task_id: "chores#hoover-bathroom", completed_at: "2026-10-08T09:00:00.000Z", completed_by: "child", tickets: 99 } } }),
      /undo the chore in Household/,
    );
  } finally {
    db2.release();
  }
  assert.equal((await pool.query("SELECT tickets FROM tickets.awards WHERE source_ref = 'ref-1'")).rows[0].tickets, 3);
  assert.equal((await pool.query("SELECT tickets.revoke('household', 'ref-1') AS removed")).rows[0].removed, true);
  assert.equal((await pool.query("SELECT tickets.revoke('household', 'ref-1') AS removed")).rows[0].removed, false);
  await assert.rejects(pool.query("SELECT tickets.award('jonathan', 'chores#x', 1, 'x', 'household', 'ref-2')"), /foreign key/);
});

test("after the switch, stragglers only add new hosted rows and never touch local changes", { skip: !url }, async () => {
  const atSwitch = hostedFixture();
  assert.equal((await importHosted(pool, atSwitch)).ok, true);
  // Local life after the switch: Zoe's pending reward is handed over, Lydia's job is undone, household awards.
  await pool.query("UPDATE tickets.redemptions SET status = 'claimed', claimed_at = '2026-10-08T12:00:00Z' WHERE redemption_id = 'mf2-bbb'");
  await pool.query("DELETE FROM tickets.awards WHERE child_id = 'lydia' AND task_id = 'feed-cat'");
  await pool.query("SELECT tickets.award('zoe', 'chores#oven', 3, 'Clean the Oven', 'household', 'oven#1#zoe', '2026-10-08T12:01:00Z')");
  await pool.query("UPDATE tickets.rewards SET ticket_cost = 6 WHERE reward_id = 'small-toy'");
  const snapshot = async () => (await pool.query("SELECT (SELECT json_agg(a ORDER BY a.task_completion) FROM tickets.awards a)::text || (SELECT json_agg(r ORDER BY r.redemption_id) FROM tickets.redemptions r)::text || (SELECT json_agg(w ORDER BY w.reward_id) FROM tickets.rewards w)::text AS s")).rows[0].s;
  const localBefore = await snapshot();

  // Hosted meanwhile: one late award and one late redemption (stragglers), plus a change and a removal there.
  const later = hostedFixture();
  later.completions.push({ child_subdomain: "lydia", task_completion: "tidy-room#2026-10-08T11:05:00.000Z#late", task_id: "tidy-room", completed_at: "2026-10-08T11:05:00.000Z", completed_by: "child", tickets: 2 });
  later.redemptions.push({ child_subdomain: "lydia", redemption_id: "mf9-late", reward_id: "screen-time", redeemed_at: "2026-10-08T11:06:00.000Z", redeemed_by: "child", tickets: 1, status: "pending" });
  later.redemptions = later.redemptions.filter((r) => r.redemption_id !== "mf1-aaa");
  later.tasks[0] = { ...later.tasks[0], ticket_reward: 9 };

  const dry = await importStragglers(pool, atSwitch, later, { dryRun: true });
  assert.equal(await snapshot(), localBefore, "dry run changes nothing");
  const report = await importStragglers(pool, atSwitch, later);
  assert.equal(report.ok, true);
  assert.deepEqual(dry.inserted, report.inserted);
  assert.deepEqual(report.inserted, { awards: ["lydia#tidy-room#2026-10-08T11:05:00.000Z#late"], redemptions: ["lydia#mf9-late"] });
  assert.deepEqual(report.notApplied.sort(), ["redemption zoe#mf1-aaa removed on hosted (refunded there)", "tasks: tidy-room changed on hosted"]);
  // Every row that was here is exactly as it was; only the two stragglers were added.
  const after = await pool.query("SELECT child_id, task_id, task_completion FROM tickets.awards WHERE source = 'hosted' ORDER BY task_completion");
  // Hosted had 3 at the switch; Lydia's feed-cat was undone locally; one straggler arrived.
  assert.deepEqual(after.rows.map((r) => `${r.child_id}#${r.task_id}`).sort(), ["lydia#tidy-room", "zoe#bonus", "zoe#tidy-room"]);
  assert.equal(after.rows.some((r) => r.task_id === "feed-cat"), false, "a local undo stays undone");
  assert.equal((await pool.query("SELECT status FROM tickets.redemptions WHERE redemption_id = 'mf2-bbb'")).rows[0].status, "claimed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.redemptions WHERE redemption_id = 'mf1-aaa'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT ticket_cost FROM tickets.rewards WHERE reward_id = 'small-toy'")).rows[0].ticket_cost, 6);
  assert.equal((await pool.query("SELECT ticket_reward FROM tickets.tasks WHERE task_id = 'tidy-room'")).rows[0].ticket_reward, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE source = 'household'")).rows[0].n, 1);
  // Idempotent: a second run adds nothing.
  const again = await importStragglers(pool, atSwitch, later);
  assert.deepEqual(again.inserted, { awards: [], redemptions: [] });
  assert.deepEqual(again.alreadyHere, report.inserted);
  assert.equal(again.ok, true);
  await pool.query("SELECT tickets.revoke('household', 'oven#1#zoe')");
});

test("term dates come from core.term_dates and are read-only here", { skip: !url }, async () => {
  const db = await pool.connect();
  try {
    const ddb = new PgDocumentClient(db);
    const row = await ddb.send({ constructor: { name: "GetCommand" }, input: { TableName: "term-dates", Key: { academic_year: "2026-2027" } } });
    assert.deepEqual(row.Item.terms, [{ name: "Autumn", opens: "2026-08-24", closes: "2026-12-18", half_term_start: "2026-10-19", half_term_end: "2026-10-23" }]);
    await assert.rejects(ddb.send({ constructor: { name: "PutCommand" }, input: { TableName: "term-dates", Item: {} } }), /edited in Snacks/);
    await assert.rejects(ddb.send({ constructor: { name: "QueryCommand" }, input: { TableName: "tasks", KeyConditionExpression: "x = :y" } }), /not supported/);
  } finally {
    db.release();
  }
});
