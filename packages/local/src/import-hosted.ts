/**
 * Brings hosted tickets into Postgres and proves nothing was lost.
 *
 *   DATABASE_URL=… node dist/import-hosted.mjs --from <dir> [--dry-run]
 *
 * <dir> holds read-only scans of the hosted tables, one file each, as written by
 *   aws dynamodb scan --consistent-read --table-name wainwright-<table> --output json
 * for tasks, task-completions, job-board, rewards and reward-redemptions (see the README).
 *
 * Idempotent: run it again to catch up with hosted until tickets.wainwright.fun moves. The
 * library (tasks, rewards, job board) is mirrored exactly; awards and redemptions that came from
 * hosted are upserted and removed when hosted removed them (undo, refund). Awards and
 * redemptions made locally (source tickets or household) are never touched.
 *
 * Everything happens in one transaction under the tickets lock, followed by a reconciliation that
 * reads every row back through the same adapter the app uses and compares it with the hosted
 * item. Any difference rolls the whole import back.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { applyTicketsMigrations, waitForCore } from "./migrate.js";
import { LOGICAL_TABLES, PgDocumentClient } from "./pg-ddb.js";

type Item = Record<string, any>;

export function unmarshall(value: any): any {
  const [type, inner] = Object.entries(value)[0] as [string, any];
  switch (type) {
    case "S":
      return inner;
    case "N":
      return Number(inner);
    case "BOOL":
      return inner;
    case "NULL":
      return null;
    case "L":
      return inner.map(unmarshall);
    case "M":
      return Object.fromEntries(Object.entries(inner).map(([k, v]) => [k, unmarshall(v)]));
    case "SS":
      return [...inner];
    case "NS":
      return inner.map(Number);
    default:
      throw new Error(`unsupported DynamoDB type ${type}`);
  }
}

export interface HostedTickets {
  tasks: Item[];
  completions: Item[];
  board: Item[];
  rewards: Item[];
  redemptions: Item[];
}

export async function readScans(dir: string): Promise<HostedTickets> {
  const load = async (table: string) => {
    const raw = JSON.parse(await readFile(path.join(dir, `wainwright-${table}.json`), "utf8"));
    return (raw.Items as Item[]).map((item) => unmarshall({ M: item }));
  };
  return {
    tasks: await load("tasks"),
    completions: await load("task-completions"),
    board: await load("job-board"),
    rewards: await load("rewards"),
    redemptions: await load("reward-redemptions"),
  };
}

const MODELLED = {
  tasks: ["task_id", "title", "description", "ticket_reward", "assigned_to", "icon", "emoji", "enabled", "created_at", "updated_at"],
  board: ["board_id", "task_id", "repeat", "ticket_reward", "assigned_to", "posted", "posted_at", "completion_mode", "created_at", "updated_at"],
  completions: ["child_subdomain", "task_completion", "task_id", "completed_at", "completed_by", "tickets", "label"],
  rewards: ["reward_id", "title", "description", "ticket_cost", "cost_pence", "icon", "emoji", "limit_type", "stock_remaining", "period", "snack_product_slug", "enabled", "created_at", "updated_at"],
  redemptions: ["child_subdomain", "redemption_id", "reward_id", "redeemed_at", "redeemed_by", "tickets", "status", "claimed_at"],
};

const extra = (item: Item, modelled: string[]) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([k]) => !modelled.includes(k))));
const v = (value: unknown) => (value === undefined ? null : value);

/** Null and missing are the same to the hosted handlers; timestamps compare as instants. */
function normalise(item: Item): Item {
  const out: Item = {};
  for (const key of Object.keys(item).sort()) {
    let value = item[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) value = new Date(value).toISOString();
    out[key] = value;
  }
  return out;
}

export interface ImportReport {
  counts: Record<string, { hosted: number; local: number }>;
  removed: Record<string, number>;
  mismatches: { table: string; key: string; hosted: Item | null; local: Item | null }[];
  balances: Record<string, { hosted: number; local: number }>;
  pending: { hosted: number; local: number };
  localOnly: { awards: number; redemptions: number };
  ok: boolean;
}

export async function importHosted(pool: pg.Pool, hosted: HostedTickets, { dryRun = false } = {}): Promise<ImportReport> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT tickets.lock()");

    // Library: mirror exactly.
    await db.query("DELETE FROM tickets.tasks WHERE NOT (task_id = ANY($1::text[]))", [hosted.tasks.map((t) => t.task_id)]);
    for (const t of hosted.tasks) {
      await db.query(
        `INSERT INTO tickets.tasks (task_id, title, description, ticket_reward, assigned_to, icon, emoji, enabled, created_at, updated_at, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (task_id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, ticket_reward=EXCLUDED.ticket_reward,
           assigned_to=EXCLUDED.assigned_to, icon=EXCLUDED.icon, emoji=EXCLUDED.emoji, enabled=EXCLUDED.enabled,
           created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, extra=EXCLUDED.extra`,
        [t.task_id, t.title, v(t.description), t.ticket_reward, t.assigned_to ?? [], v(t.icon), v(t.emoji), t.enabled !== false, t.created_at, t.updated_at, extra(t, MODELLED.tasks)],
      );
    }
    await db.query("DELETE FROM tickets.board WHERE NOT (board_id = ANY($1::text[]))", [hosted.board.map((b) => b.board_id)]);
    for (const b of hosted.board) {
      await db.query(
        `INSERT INTO tickets.board (board_id, task_id, repeat, ticket_reward, assigned_to, posted, posted_at, completion_mode, created_at, updated_at, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (board_id) DO UPDATE SET task_id=EXCLUDED.task_id, repeat=EXCLUDED.repeat, ticket_reward=EXCLUDED.ticket_reward,
           assigned_to=EXCLUDED.assigned_to, posted=EXCLUDED.posted, posted_at=EXCLUDED.posted_at, completion_mode=EXCLUDED.completion_mode,
           created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, extra=EXCLUDED.extra`,
        [b.board_id, b.task_id, b.repeat, b.ticket_reward, b.assigned_to ?? [], b.posted !== false, v(b.posted_at), b.completion_mode, b.created_at, b.updated_at, extra(b, MODELLED.board)],
      );
    }
    await db.query("DELETE FROM tickets.rewards WHERE NOT (reward_id = ANY($1::text[]))", [hosted.rewards.map((r) => r.reward_id)]);
    for (const r of hosted.rewards) {
      await db.query(
        `INSERT INTO tickets.rewards (reward_id, title, description, ticket_cost, cost_pence, icon, emoji, limit_type, stock_remaining, period, snack_product_slug, enabled, created_at, updated_at, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (reward_id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, ticket_cost=EXCLUDED.ticket_cost,
           cost_pence=EXCLUDED.cost_pence, icon=EXCLUDED.icon, emoji=EXCLUDED.emoji, limit_type=EXCLUDED.limit_type,
           stock_remaining=EXCLUDED.stock_remaining, period=EXCLUDED.period, snack_product_slug=EXCLUDED.snack_product_slug,
           enabled=EXCLUDED.enabled, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, extra=EXCLUDED.extra`,
        [r.reward_id, r.title, v(r.description), r.ticket_cost, v(r.cost_pence), v(r.icon), v(r.emoji), v(r.limit_type), v(r.stock_remaining), v(r.period), v(r.snack_product_slug), r.enabled !== false, r.created_at, r.updated_at, extra(r, MODELLED.rewards)],
      );
    }

    // History from hosted: upsert, and drop what hosted dropped. Local rows are left alone.
    const removed: Record<string, number> = {};
    const awardRefs = hosted.completions.map((c) => `${c.child_subdomain}#${c.task_completion}`);
    removed.awards = (await db.query("DELETE FROM tickets.awards WHERE source = 'hosted' AND NOT (source_ref = ANY($1::text[]))", [awardRefs])).rowCount ?? 0;
    for (const c of hosted.completions) {
      await db.query(
        `INSERT INTO tickets.awards (child_id, task_completion, task_id, completed_at, completed_by, tickets, label, source, source_ref, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'hosted',$8,$9)
         ON CONFLICT (child_id, task_completion) DO UPDATE SET task_id=EXCLUDED.task_id, completed_at=EXCLUDED.completed_at,
           completed_by=EXCLUDED.completed_by, tickets=EXCLUDED.tickets, label=EXCLUDED.label, extra=EXCLUDED.extra
         WHERE tickets.awards.source = 'hosted'`,
        [c.child_subdomain, c.task_completion, c.task_id, c.completed_at, c.completed_by, c.tickets, v(c.label), `${c.child_subdomain}#${c.task_completion}`, extra(c, MODELLED.completions)],
      );
    }
    const redemptionKeys = hosted.redemptions.map((r) => `${r.child_subdomain}#${r.redemption_id}`);
    removed.redemptions = (
      await db.query("DELETE FROM tickets.redemptions WHERE source = 'hosted' AND NOT ((child_id || '#' || redemption_id) = ANY($1::text[]))", [redemptionKeys])
    ).rowCount ?? 0;
    for (const r of hosted.redemptions) {
      await db.query(
        `INSERT INTO tickets.redemptions (child_id, redemption_id, reward_id, redeemed_at, redeemed_by, tickets, status, claimed_at, source, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'hosted',$9)
         ON CONFLICT (child_id, redemption_id) DO UPDATE SET reward_id=EXCLUDED.reward_id, redeemed_at=EXCLUDED.redeemed_at,
           redeemed_by=EXCLUDED.redeemed_by, tickets=EXCLUDED.tickets, status=EXCLUDED.status, claimed_at=EXCLUDED.claimed_at, extra=EXCLUDED.extra
         WHERE tickets.redemptions.source = 'hosted'`,
        [r.child_subdomain, r.redemption_id, r.reward_id, r.redeemed_at, r.redeemed_by, r.tickets, r.status, v(r.claimed_at), extra(r, MODELLED.redemptions)],
      );
    }

    const report = await reconcile(db, hosted, removed);
    await db.query(report.ok && !dryRun ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/** Reads everything back through the app's adapter and compares it with hosted, item by item. */
async function reconcile(db: pg.PoolClient, hosted: HostedTickets, removed: Record<string, number>): Promise<ImportReport> {
  const ddb = new PgDocumentClient(db);
  const scan = async (table: string) => ((await ddb.send({ constructor: { name: "ScanCommand" }, input: { TableName: table } })).Items as Item[]);
  const local = {
    tasks: await scan(LOGICAL_TABLES.tasks),
    board: await scan(LOGICAL_TABLES.board),
    rewards: await scan(LOGICAL_TABLES.rewards),
  };
  // History is compared through hosted-sourced rows only; local rows are reported separately.
  const awards = (await db.query("SELECT child_id, task_completion FROM tickets.awards WHERE source = 'hosted'")).rows;
  const redemptions = (await db.query("SELECT child_id, redemption_id FROM tickets.redemptions WHERE source = 'hosted'")).rows;
  const get = async (table: string, key: Item) => (await ddb.send({ constructor: { name: "GetCommand" }, input: { TableName: table, Key: key } })).Item as Item | undefined;

  const mismatches: ImportReport["mismatches"] = [];
  const compare = (table: string, keyOf: (i: Item) => string, hostedItems: Item[], localItems: Item[]) => {
    const byKey = new Map(localItems.map((i) => [keyOf(i), i]));
    for (const h of hostedItems) {
      const l = byKey.get(keyOf(h)) ?? null;
      if (!l || JSON.stringify(normalise(h)) !== JSON.stringify(normalise(l))) mismatches.push({ table, key: keyOf(h), hosted: h, local: l });
      byKey.delete(keyOf(h));
    }
    for (const [key, l] of byKey) mismatches.push({ table, key, hosted: null, local: l });
  };
  compare("tasks", (i) => i.task_id, hosted.tasks, local.tasks);
  compare("board", (i) => i.board_id, hosted.board, local.board);
  compare("rewards", (i) => i.reward_id, hosted.rewards, local.rewards);
  const localAwards: Item[] = [];
  for (const row of awards) localAwards.push((await get(LOGICAL_TABLES.completions, { child_subdomain: row.child_id, task_completion: row.task_completion }))!);
  compare("completions", (i) => `${i.child_subdomain}#${i.task_completion}`, hosted.completions, localAwards);
  const localRedemptions: Item[] = [];
  for (const row of redemptions) localRedemptions.push((await get(LOGICAL_TABLES.redemptions, { child_subdomain: row.child_id, redemption_id: row.redemption_id }))!);
  compare("redemptions", (i) => `${i.child_subdomain}#${i.redemption_id}`, hosted.redemptions, localRedemptions);

  const hostedBalances: Record<string, number> = {};
  for (const c of hosted.completions) hostedBalances[c.child_subdomain] = (hostedBalances[c.child_subdomain] ?? 0) + c.tickets;
  for (const r of hosted.redemptions) hostedBalances[r.child_subdomain] = (hostedBalances[r.child_subdomain] ?? 0) - r.tickets;
  const balanceRows = (await db.query("SELECT child_id, spendable, pending FROM tickets.balances ORDER BY child_id")).rows;
  const balances: ImportReport["balances"] = {};
  for (const row of balanceRows) balances[row.child_id] = { hosted: hostedBalances[row.child_id] ?? 0, local: row.spendable };
  for (const child of Object.keys(hostedBalances)) balances[child] ??= { hosted: hostedBalances[child], local: Number.NaN };
  const localOnly = (await db.query("SELECT (SELECT count(*) FROM tickets.awards WHERE source <> 'hosted')::int AS awards, (SELECT count(*) FROM tickets.redemptions WHERE source <> 'hosted')::int AS redemptions")).rows[0];
  const pending = {
    hosted: hosted.redemptions.filter((r) => r.status === "pending").length,
    local: balanceRows.reduce((sum, row) => sum + row.pending, 0),
  };
  const counts = {
    tasks: { hosted: hosted.tasks.length, local: local.tasks.length },
    board: { hosted: hosted.board.length, local: local.board.length },
    rewards: { hosted: hosted.rewards.length, local: local.rewards.length },
    completions: { hosted: hosted.completions.length, local: awards.length },
    redemptions: { hosted: hosted.redemptions.length, local: redemptions.length },
  };
  // Balances only have to match while nothing local has been written.
  const balancesMatch = localOnly.awards + localOnly.redemptions > 0 || Object.values(balances).every((b) => b.hosted === b.local);
  const ok =
    mismatches.length === 0 &&
    Object.values(counts).every((c) => c.hosted === c.local) &&
    balancesMatch &&
    (localOnly.redemptions > 0 || pending.hosted === pending.local);
  return { counts, removed, mismatches: mismatches.slice(0, 20), balances, pending, localOnly, ok };
}

const isMain = process.argv[1] && /import-hosted\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const from = args[args.indexOf("--from") + 1];
  if (!args.includes("--from") || !from) throw new Error("usage: import-hosted --from <dir of scans> [--dry-run]");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await waitForCore(pool, { attempts: 1 });
    await applyTicketsMigrations(pool);
    const report = await importHosted(pool, await readScans(from), { dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}
