/**
 * House chores shown in Tickets. The list and claim / done / undo go through a
 * Household stand-in that speaks the merged kid API. Tickets does not read
 * household.* and does not award tickets itself.
 *   TICKETS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/tickets_local_test pnpm --filter @wainwright/local test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { normalizeHouseholdList } from "../src/household-chores.ts";
import { startHouseholdStub } from "./household-stub.ts";

const url = process.env.TICKETS_TEST_DATABASE_URL;
// @ts-ignore built bundle
const { createLocalTickets, applyTicketsMigrations } = await import("../dist/app.mjs");

const ZOE = "192.168.1.219";
const HANNAH_IP = "192.168.1.50";
const PARENT = "192.168.1.170";

const CORE = `
  DROP SCHEMA IF EXISTS household CASCADE;
  DROP SCHEMA IF EXISTS kids CASCADE;
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
    ('192.168.1.50', 'hannah', 'Hannah iPad'), ('192.168.1.170', 'jonathan', 'Mac Studio');
  INSERT INTO core.term_dates VALUES ('2026-2027', 0, 'Autumn', '2026-08-24', '2026-12-18', '2026-10-19', '2026-10-23');
`;

test("the kid list keeps this child's claims and a day of completions", () => {
  const now = "2026-10-19T12:00:00.000Z";
  const listed = normalizeHouseholdList({
    child: { id: "zoe", name: "Zoe" },
    now,
    rooms: [{
      id: "lounge",
      name: "Lounge",
      floor: 0,
      chores: [{
        id: "tidy-playroom",
        title: "Tidy the playroom",
        tickets: 9,
        claim: { child_id: "zoe", name: "Zoe", mine: true, auto_assigned: false },
        held: true,
        held_by: "Zoe",
        locked: false,
        waiting_on: [],
      }, {
        id: "open-chore",
        title: "An unclaimed chore",
        tickets: 1,
        claim: null,
        held: true,
        held_by: { child_id: "zoe", name: "Zoe", mine: true },
      }],
    }],
  }, "zoe");
  assert.equal(listed?.chores.length, 1);
  assert.equal(listed?.chores[0].tickets, 9);
  assert.equal(listed?.chores[0].held_by, "Zoe");
  assert.equal(listed?.chores[0].held_by_me, true);
  assert.equal(listed?.chores[0].room_name, "Lounge");
  assert.equal(listed?.chores[0].claim?.auto_assigned, false);
  assert.equal(normalizeHouseholdList({ now }, "zoe"), null);

  const planned = normalizeHouseholdList({
    child: { id: "lydia", name: "Lydia" },
    now,
    chores: [{ id: "empty-bin", title: "Empty the bin", tickets: 2, room_name: "Kitchen", locked: true, waiting_on: ["the washing machine"] }],
    done_recently: [{ chore_id: "clean-oven", title: "Clean the oven", room_name: "Kitchen", completed_at: "2026-10-19T09:00:00.000Z", tickets: 0, auto_done: false, can_undo: true }],
  }, "lydia");
  assert.equal(planned?.chores[0].waiting_on, "the washing machine");
  assert.equal(planned?.chores[0].assigned_to_me, true);
  assert.equal(planned?.done_recently[0].id, "clean-oven");
  assert.equal(planned?.done_recently[0].can_undo, true);
});

let pool: pg.Pool;
let base = "";
let stubUrl = "";
let closeServer = () => {};
let closeStub = async () => {};
let resetStub = () => {};
let calls: { action: string; choreId: string | null; headerChild: string | null; queryChild: string | null; bodyChild: string | null }[] = [];

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  await pool.query(CORE);
  await applyTicketsMigrations(pool);
  await pool.query(`
    INSERT INTO tickets.tasks (task_id, title, ticket_reward, assigned_to, emoji, created_at, updated_at)
    VALUES ('tidy-room', 'Tidy your room', 2, '{}', '🧸', now(), now())
    ON CONFLICT (task_id) DO NOTHING
  `);
  const stub = await startHouseholdStub(pool);
  calls = stub.calls;
  resetStub = stub.reset;
  closeStub = stub.close;
  stubUrl = stub.url;
  const listener = createLocalTickets({
    pool,
    household: { enabled: true, url: stub.url },
    log: () => {},
  });
  const server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => server.close();
});

after(async () => {
  closeServer();
  await closeStub();
  await pool?.end();
});

async function call(pathname: string, ip: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-real-ip": ip, ...(init.headers ?? {}) };
  const response = await fetch(`${base}${pathname}`, { method: init.method ?? "GET", headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function flat(body: { chores: Record<string, unknown>[]; done_recently: Record<string, unknown>[] }) {
  return [...body.chores, ...body.done_recently].map((chore) => ({ ...chore, room: chore.room_name })) as {
    id: string;
    title: string;
    room: string;
    place_name: string | null;
    tickets: number;
    last_completed_by: string | null;
    last_completed_by_me: boolean;
    can_undo: boolean;
    term_time_only: boolean;
    due_today: boolean;
    chore_kind: string;
    held: boolean;
    held_by: string | null;
    held_by_me: boolean;
    claim: { child_id: string; name: string; mine: boolean } | null;
  }[];
}

test("a child sees the household list, with its ticket badge, and jobs stay put", { skip: !url }, async () => {
  resetStub();
  const schema = await pool.query("SELECT to_regnamespace('household') AS schema");
  assert.equal(schema.rows[0].schema, null);
  const listed = await call("/api/kid/household-chores", ZOE);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.enabled, true);
  const listCall = calls.find((entry) => entry.action === "list");
  assert.equal(listCall?.headerChild, "zoe");
  assert.equal(listCall?.queryChild, "zoe");
  const chores = flat(listed.body);
  assert.deepEqual(listed.body.chores.map((chore: { id: string }) => chore.id), []);
  assert.deepEqual(listed.body.done_recently.map((chore: { id: string }) => chore.id), ["clean-oven"]);
  assert.equal(chores.some((chore) => ["clean-window", "pack-bag", "hoover-bathroom", "empty-bin", "tidy-playroom"].includes(chore.id)), false);
  const oven = chores.find((chore) => chore.id === "clean-oven")!;
  assert.equal(oven.room, "Kitchen");
  assert.equal(oven.place_name, "Oven");
  assert.equal(oven.tickets, 0);
  assert.equal(oven.last_completed_by, "Zoe");
  assert.equal(oven.last_completed_by_me, true);
  assert.equal(oven.can_undo, true);

  const hannah = flat((await call("/api/kid/household-chores", HANNAH_IP)).body);
  assert.equal(hannah.some((chore) => chore.id === "wipe-sink"), false);
  assert.equal(hannah.some((chore) => chore.id === "make-bed"), false);

  const jobs = await call("/api/kid/tasks", ZOE);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.tasks.some((task: { task_id: string }) => task.task_id === "tidy-room"), true);
  assert.equal(jobs.body.tasks.some((task: { task_id: string }) => String(task.task_id).startsWith("chores#")), false);
});

test("claim, done and undo go through household and award tickets once", { skip: !url }, async () => {
  resetStub();
  calls.length = 0;
  const before = await call("/api/kid/tasks", ZOE);
  const claim = await call("/api/kid/household-chores/hoover-bathroom/claim", ZOE, { method: "POST" });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.result.claim.choreId, "hoover-bathroom");
  assert.equal(claim.body.result.claim.childId, "zoe");
  assert.equal(calls.at(-1)?.action, "claim");
  assert.equal(calls.at(-1)?.headerChild, "zoe");
  assert.equal(calls.at(-1)?.bodyChild, "zoe");
  assert.equal(calls.at(-1)?.queryChild, null);

  const done = await call("/api/kid/household-chores/hoover-bathroom/complete", ZOE, { method: "POST" });
  assert.equal(done.status, 200);
  assert.equal(done.body.tickets, 2);
  assert.equal(done.body.result.ticketSync.ok, true);
  assert.equal(calls.at(-1)?.action, "complete");
  assert.equal(calls.at(-1)?.headerChild, "zoe");
  assert.equal(calls.at(-1)?.bodyChild, "zoe");
  const awards = await pool.query("SELECT tickets, source, label FROM tickets.awards WHERE child_id = 'zoe' AND task_id = 'chores#hoover-bathroom'");
  assert.equal(awards.rowCount, 1);
  assert.equal(awards.rows[0].source, "household");
  assert.equal(awards.rows[0].tickets, 2);
  assert.equal(awards.rows[0].label, "Hoover the bathroom");
  const after = await call("/api/kid/tasks", ZOE);
  assert.equal(after.body.spendable_tickets, before.body.spendable_tickets + 2);
  assert.equal(after.body.tasks.some((task: { task_id: string }) => task.task_id === "tidy-room"), true);
  const again = flat((await call("/api/kid/household-chores", ZOE)).body).find((chore) => chore.id === "hoover-bathroom")!;
  assert.equal(again.tickets, 0);
  assert.equal(again.claim, null);
  assert.equal(again.last_completed_by, "Zoe");
  assert.equal(again.can_undo, true);

  const repeat = await call("/api/kid/household-chores/hoover-bathroom/complete", ZOE, { method: "POST" });
  assert.equal(repeat.status, 404);
  assert.equal(typeof repeat.body.error, "string");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE task_id = 'chores#hoover-bathroom'")).rows[0].n, 1);

  const blocked = await call("/api/kid/household-chores/empty-bin/claim", ZOE, { method: "POST" });
  assert.equal(blocked.status, 409);
  assert.equal(typeof blocked.body.error, "string");
  const notMine = await call("/api/kid/household-chores/wipe-sink/claim", ZOE, { method: "POST" });
  assert.equal(notMine.status, 403);
  const notDue = await call("/api/kid/household-chores/make-bed/claim", ZOE, { method: "POST" });
  assert.equal(notDue.status, 409);
  assert.match(notDue.body.error, /due today/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE task_id = 'chores#make-bed'")).rows[0].n, 0);

  const undo = await call("/api/kid/household-chores/hoover-bathroom/undo", ZOE, { method: "POST" });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.result.ticketSync.ok, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE task_id = 'chores#hoover-bathroom'")).rows[0].n, 0);
  assert.equal((await call("/api/kid/tasks", ZOE)).body.spendable_tickets, before.body.spendable_tickets);

  const asParent = await call("/api/kid/household-chores/hoover-bathroom/claim", PARENT, {
    method: "POST",
    headers: { "x-tickets-act-as": "zoe" },
  });
  assert.equal(asParent.status, 200);
  assert.equal(calls.at(-1)?.headerChild, "zoe");
  assert.equal(calls.at(-1)?.bodyChild, "zoe");
});

test("the stand-in rejects a child that does not match on header, query and body", { skip: !url }, async () => {
  const mismatch = await fetch(`${stubUrl}/api/kid/chores?child=hannah`, { headers: { "x-household-child": "zoe" } });
  assert.equal(mismatch.status, 400);
  const post = await fetch(`${stubUrl}/api/kid/chores/hoover-bathroom/claim`, {
    method: "POST",
    headers: { "x-household-child": "zoe", "content-type": "application/json" },
    body: JSON.stringify({ child_id: "hannah" }),
  });
  assert.equal(post.status, 400);
  const health = await fetch(`${stubUrl}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, service: "household", demo: true });
});

test("a switched-off flag or a silent household hides the section and leaves jobs", { skip: !url }, async () => {
  const offListener = createLocalTickets({ pool, household: { enabled: false, url: "http://127.0.0.1:9" }, log: () => {} });
  const offServer = createServer((req, res) => void offListener(req, res));
  await new Promise<void>((resolve) => offServer.listen(0, "127.0.0.1", resolve));
  const offBase = `http://127.0.0.1:${(offServer.address() as AddressInfo).port}`;
  const off = await fetch(`${offBase}/api/kid/household-chores`, { headers: { "x-real-ip": ZOE } });
  const offBody = await off.json();
  assert.equal(off.status, 200);
  assert.equal(offBody.enabled, false);
  assert.equal("error" in offBody, false);
  const jobs = await fetch(`${offBase}/api/kid/tasks`, { headers: { "x-real-ip": ZOE } });
  assert.equal(jobs.status, 200);
  offServer.close();

  const downListener = createLocalTickets({ pool, household: { enabled: true, url: "http://127.0.0.1:9" }, log: () => {} });
  const downServer = createServer((req, res) => void downListener(req, res));
  await new Promise<void>((resolve) => downServer.listen(0, "127.0.0.1", resolve));
  const downBase = `http://127.0.0.1:${(downServer.address() as AddressInfo).port}`;
  const down = await fetch(`${downBase}/api/kid/household-chores`, { headers: { "x-real-ip": ZOE } });
  const downBody = await down.json();
  assert.equal(down.status, 200);
  assert.deepEqual(downBody, { enabled: false, chores: [], done_recently: [] });
  const post = await fetch(`${downBase}/api/kid/household-chores/hoover-bathroom/claim`, { method: "POST", headers: { "x-real-ip": ZOE } });
  const postBody = await post.json();
  assert.equal(post.status, 200);
  assert.equal(postBody.enabled, false);
  assert.equal("error" in postBody, false);
  downServer.close();

  const missing = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "nope" }));
  });
  await new Promise<void>((resolve) => missing.listen(0, "127.0.0.1", resolve));
  const missingUrl = `http://127.0.0.1:${(missing.address() as AddressInfo).port}`;
  const gapListener = createLocalTickets({ pool, household: { enabled: true, url: missingUrl }, log: () => {} });
  const gapServer = createServer((req, res) => void gapListener(req, res));
  await new Promise<void>((resolve) => gapServer.listen(0, "127.0.0.1", resolve));
  const gapBase = `http://127.0.0.1:${(gapServer.address() as AddressInfo).port}`;
  const hidden = await fetch(`${gapBase}/api/kid/household-chores`, { headers: { "x-real-ip": ZOE } });
  assert.deepEqual(await hidden.json(), { enabled: false, chores: [], done_recently: [] });
  const awardsBefore = (await pool.query("SELECT count(*)::int AS n FROM tickets.awards")).rows[0].n;
  const gap = await fetch(`${gapBase}/api/kid/household-chores/hoover-bathroom/claim`, { method: "POST", headers: { "x-real-ip": ZOE } });
  const gapBody = await gap.json();
  assert.equal(gap.status, 404);
  assert.equal(gapBody.error, "nope");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards")).rows[0].n, awardsBefore);
  gapServer.close();
  missing.close();
});
