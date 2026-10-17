/**
 * House chores shown in Tickets, with claim / done / undo going through a Household
 * test double (so tickets.award stays in that transaction).
 *   TICKETS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/tickets_local_test pnpm --filter @wainwright/local test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { choreTicketsNow } from "../src/household-chores.ts";
import { seedHousehold, seedHouseholdMinimal } from "./household-demo.ts";
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

test("choreTicketsNow is zero just after a completion and stops at twice the area-adjusted base", () => {
  assert.equal(choreTicketsNow({ base_tickets: 4, reset_days: 7, target_type: "room" }, null, 5.7), 2);
  assert.equal(choreTicketsNow({ base_tickets: 3, reset_days: 7, target_type: "room" }, null, 14.3), 4);
  assert.equal(choreTicketsNow({ base_tickets: 5, reset_days: 14, target_type: "fixture" }, new Date().toISOString(), null), 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  assert.equal(choreTicketsNow({ base_tickets: 4, reset_days: 7, target_type: "room" }, weekAgo, 5.7), 2);
  const overdue = new Date(Date.now() - 21 * 86_400_000).toISOString();
  assert.equal(choreTicketsNow({ base_tickets: 4, reset_days: 7, target_type: "room" }, overdue, 5.7), 4);
});

let pool: pg.Pool;
let base = "";
let closeServer = () => {};
let closeStub = async () => {};
let calls: { action: string; choreId: string; childId: string | null; realIp: string | null }[] = [];

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  await pool.query(CORE);
  await applyTicketsMigrations(pool);
  const stub = await startHouseholdStub(pool);
  calls = stub.calls;
  closeStub = stub.close;
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

function flat(body: { rooms: { name: string; chores: Record<string, unknown>[] }[] }) {
  return body.rooms.flatMap((room) => room.chores.map((chore) => ({ ...chore, room: room.name }))) as {
    id: string;
    title: string;
    room: string;
    place_name: string | null;
    tickets: number;
    last_done_by: string | null;
    last_done_by_me: boolean;
    term_time: boolean;
    kind: string | null;
    claim: { name: string; mine: boolean; held: boolean } | null;
  }[];
}

test("a child sees household chores they can claim, and jobs stay put", { skip: !url }, async () => {
  await seedHousehold(pool);
  const listed = await call("/api/kid/household-chores", ZOE);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.enabled, true);
  const chores = flat(listed.body);
  assert.deepEqual(chores.map((chore) => chore.id).sort(), ["clean-oven", "clean-window", "empty-bin", "hoover-bathroom", "pack-bag", "tidy-playroom"]);
  const oven = chores.find((chore) => chore.id === "clean-oven")!;
  assert.equal(oven.room, "Kitchen");
  assert.equal(oven.place_name, "Oven");
  assert.equal(oven.tickets, 0);
  assert.equal(oven.last_done_by, "Zoe");
  assert.equal(oven.last_done_by_me, true);
  const bin = chores.find((chore) => chore.id === "empty-bin")!;
  assert.equal(bin.claim?.mine, false);
  assert.equal(bin.claim?.name, "Lydia");
  const play = chores.find((chore) => chore.id === "tidy-playroom")!;
  assert.equal(play.room, "Lounge");
  assert.equal(play.tickets, 4);
  assert.equal(play.claim?.mine, true);
  assert.equal(play.claim?.held, true);
  const hoover = chores.find((chore) => chore.id === "hoover-bathroom")!;
  assert.equal(hoover.room, "Bathroom");
  assert.equal(hoover.tickets, 2);
  assert.equal(hoover.place_name, null);
  const bag = chores.find((chore) => chore.id === "pack-bag")!;
  assert.equal(bag.term_time, true);
  assert.equal(bag.kind, "routine");
  assert.equal(chores.find((chore) => chore.id === "clean-window")!.place_name, "Kitchen window");

  const hannah = flat((await call("/api/kid/household-chores", HANNAH_IP)).body);
  assert.equal(hannah.some((chore) => chore.id === "wipe-sink"), true);

  const jobs = await call("/api/kid/tasks", ZOE);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.tasks.some((task: { task_id: string }) => task.task_id === "tidy-room"), true);
  assert.equal(jobs.body.tasks.some((task: { task_id: string }) => String(task.task_id).startsWith("chores#")), false);
});

test("claim, done and undo go through household and award tickets once", { skip: !url }, async () => {
  await seedHousehold(pool);
  calls.length = 0;
  const before = await call("/api/kid/tasks", ZOE);
  const claim = await call("/api/kid/household-chores/hoover-bathroom/claim", ZOE, { method: "POST" });
  assert.equal(claim.status, 200);
  assert.equal(calls.at(-1)?.action, "claim");
  assert.equal(calls.at(-1)?.childId, "zoe");
  assert.equal(calls.at(-1)?.realIp, ZOE);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM household.chore_claims WHERE chore_id = 'hoover-bathroom' AND child_id = 'zoe'")).rows[0].n, 1);

  const done = await call("/api/kid/household-chores/hoover-bathroom/complete", ZOE, { method: "POST" });
  assert.equal(done.status, 200);
  assert.equal(calls.at(-1)?.action, "complete");
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
  assert.equal(again.last_done_by, "Zoe");

  const repeat = await call("/api/kid/household-chores/hoover-bathroom/complete", ZOE, { method: "POST" });
  assert.equal(repeat.status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE task_id = 'chores#hoover-bathroom'")).rows[0].n, 1);

  const blocked = await call("/api/kid/household-chores/empty-bin/claim", ZOE, { method: "POST" });
  assert.equal(blocked.status, 409);
  const notMine = await call("/api/kid/household-chores/wipe-sink/claim", ZOE, { method: "POST" });
  assert.equal(notMine.status, 403);

  const undo = await call("/api/kid/household-chores/hoover-bathroom/undo", ZOE, { method: "POST" });
  assert.equal(undo.status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards WHERE task_id = 'chores#hoover-bathroom'")).rows[0].n, 0);
  assert.equal((await call("/api/kid/tasks", ZOE)).body.spendable_tickets, before.body.spendable_tickets);

  const asParent = await call("/api/kid/household-chores/hoover-bathroom/claim", PARENT, {
    method: "POST",
    headers: { "x-tickets-act-as": "zoe" },
  });
  assert.equal(asParent.status, 200);
  assert.equal(calls.at(-1)?.childId, "zoe");
  assert.equal(calls.at(-1)?.realIp, PARENT);
});

test("missing household columns still list chores, and a down household hides the section", { skip: !url }, async () => {
  await seedHouseholdMinimal(pool);
  const listed = await call("/api/kid/household-chores", ZOE);
  assert.equal(listed.body.enabled, true);
  const chores = flat(listed.body);
  assert.deepEqual(chores.map((chore) => chore.id).sort(), ["brush-toilet", "hoover-bathroom"]);
  assert.equal(chores.find((chore) => chore.id === "brush-toilet")!.place_name, "Toilet");
  assert.equal(chores.find((chore) => chore.id === "hoover-bathroom")!.tickets, 2);

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
  assert.deepEqual(downBody, { enabled: false, rooms: [] });
  const post = await fetch(`${downBase}/api/kid/household-chores/hoover-bathroom/claim`, { method: "POST", headers: { "x-real-ip": ZOE } });
  const postBody = await post.json();
  assert.equal(post.status, 200);
  assert.equal(postBody.enabled, false);
  downServer.close();

  const missing = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => missing.listen(0, "127.0.0.1", resolve));
  const missingUrl = `http://127.0.0.1:${(missing.address() as AddressInfo).port}`;
  const gapListener = createLocalTickets({ pool, household: { enabled: true, url: missingUrl }, log: () => {} });
  const gapServer = createServer((req, res) => void gapListener(req, res));
  await new Promise<void>((resolve) => gapServer.listen(0, "127.0.0.1", resolve));
  const gapBase = `http://127.0.0.1:${(gapServer.address() as AddressInfo).port}`;
  const stillListed = await fetch(`${gapBase}/api/kid/household-chores`, { headers: { "x-real-ip": ZOE } });
  const stillBody = await stillListed.json();
  assert.equal(stillBody.enabled, true, "a 404 health response still means the process is up");
  const awardsBefore = (await pool.query("SELECT count(*)::int AS n FROM tickets.awards")).rows[0].n;
  const gap = await fetch(`${gapBase}/api/kid/household-chores/hoover-bathroom/claim`, { method: "POST", headers: { "x-real-ip": ZOE } });
  const gapBody = await gap.json();
  assert.equal(gap.status, 404);
  assert.match(gapBody.error, /Household has no way/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets.awards")).rows[0].n, awardsBefore);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM household.chore_claims")).rows[0].n, 0);
  gapServer.close();
  missing.close();
});
