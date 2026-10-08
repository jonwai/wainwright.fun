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

/**
 * After the DNS switch the local tables are the live ones, so a full import would undo local changes
 * to hosted-sourced rows (a local undo, refund or claim). importStragglers compares two hosted scans
 * (the one imported at the switch and a later one) and only ADDS the awards and redemptions hosted
 * gained in between. Anything hosted changed or removed, and any library change, is reported for a
 * parent to look at, never applied. It commits only if every row that was already here is unchanged.
 */
export interface StragglerReport {
  hosted: Record<string, { added: string[]; changed: string[]; removed: string[] }>;
  inserted: { awards: string[]; redemptions: string[] };
  alreadyHere: { awards: string[]; redemptions: string[] };
  notApplied: string[];
  localUnchanged: boolean;
  bySource: { before: Record<string, number>; after: Record<string, number> };
  balances: Record<string, { spendable: number; pending: number }>;
  ok: boolean;
}

const KEY_OF: Record<keyof HostedTickets, (i: Item) => string> = {
  tasks: (i) => i.task_id,
  board: (i) => i.board_id,
  rewards: (i) => i.reward_id,
  completions: (i) => `${i.child_subdomain}#${i.task_completion}`,
  redemptions: (i) => `${i.child_subdomain}#${i.redemption_id}`,
};

function diffScans(before: Item[], now: Item[], keyOf: (i: Item) => string) {
  const was = new Map(before.map((i) => [keyOf(i), JSON.stringify(normalise(i))]));
  const is = new Map(now.map((i) => [keyOf(i), i]));
  return {
    added: [...is.keys()].filter((k) => !was.has(k)),
    changed: [...is].filter(([k, i]) => was.has(k) && was.get(k) !== JSON.stringify(normalise(i))).map(([k]) => k),
    removed: [...was.keys()].filter((k) => !is.has(k)),
  };
}

// Every existing row, excluding the ones this run inserts.
const FINGERPRINT = `SELECT
  (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.task_id), '')) FROM tickets.tasks t) ||
  (SELECT md5(coalesce(string_agg(b::text, '|' ORDER BY b.board_id), '')) FROM tickets.board b) ||
  (SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r.reward_id), '')) FROM tickets.rewards r) ||
  (SELECT md5(coalesce(string_agg(a::text, '|' ORDER BY a.child_id, a.task_completion), '')) FROM tickets.awards a
     WHERE NOT ((a.child_id || '#' || a.task_completion) = ANY($1::text[]))) ||
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.child_id, x.redemption_id), '')) FROM tickets.redemptions x
     WHERE NOT ((x.child_id || '#' || x.redemption_id) = ANY($2::text[]))) AS fp`;

const BY_SOURCE = `SELECT 'awards:' || source AS k, count(*)::int AS n FROM tickets.awards GROUP BY source
  UNION ALL SELECT 'redemptions:' || source, count(*)::int FROM tickets.redemptions GROUP BY source`;

export async function importStragglers(pool: pg.Pool, before: HostedTickets, now: HostedTickets, { dryRun = false } = {}): Promise<StragglerReport> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT tickets.lock()");
    const hosted = Object.fromEntries(
      (Object.keys(KEY_OF) as (keyof HostedTickets)[]).map((table) => [table, diffScans(before[table], now[table], KEY_OF[table])]),
    ) as StragglerReport["hosted"];
    const counts = async () => Object.fromEntries((await db.query(BY_SOURCE)).rows.map((r) => [r.k, r.n]));
    const bySourceBefore = await counts();
    const fpBefore = (await db.query(FINGERPRINT, [[], []])).rows[0].fp;

    const inserted: StragglerReport["inserted"] = { awards: [], redemptions: [] };
    const alreadyHere: StragglerReport["alreadyHere"] = { awards: [], redemptions: [] };
    const nowAwards = new Map(now.completions.map((c) => [KEY_OF.completions(c), c]));
    for (const key of hosted.completions.added) {
      const c = nowAwards.get(key)!;
      const row = await db.query(
        `INSERT INTO tickets.awards (child_id, task_completion, task_id, completed_at, completed_by, tickets, label, source, source_ref, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'hosted',$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
        [c.child_subdomain, c.task_completion, c.task_id, c.completed_at, c.completed_by, c.tickets, v(c.label), key, extra(c, MODELLED.completions)],
      );
      (row.rowCount ? inserted.awards : alreadyHere.awards).push(key);
    }
    const nowRedemptions = new Map(now.redemptions.map((r) => [KEY_OF.redemptions(r), r]));
    for (const key of hosted.redemptions.added) {
      const r = nowRedemptions.get(key)!;
      const row = await db.query(
        `INSERT INTO tickets.redemptions (child_id, redemption_id, reward_id, redeemed_at, redeemed_by, tickets, status, claimed_at, source, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'hosted',$9) ON CONFLICT DO NOTHING RETURNING child_id`,
        [r.child_subdomain, r.redemption_id, r.reward_id, r.redeemed_at, r.redeemed_by, r.tickets, r.status, v(r.claimed_at), extra(r, MODELLED.redemptions)],
      );
      (row.rowCount ? inserted.redemptions : alreadyHere.redemptions).push(key);
    }

    const fpAfter = (await db.query(FINGERPRINT, [inserted.awards, inserted.redemptions])).rows[0].fp;
    const notApplied = [
      ...(["tasks", "board", "rewards"] as const).flatMap((t) => [...hosted[t].added, ...hosted[t].changed, ...hosted[t].removed].map((k) => `${t}: ${k} changed on hosted`)),
      ...hosted.completions.changed.map((k) => `award ${k} changed on hosted`),
      ...hosted.completions.removed.map((k) => `award ${k} removed on hosted (undone there)`),
      ...hosted.redemptions.changed.map((k) => `redemption ${k} changed on hosted`),
      ...hosted.redemptions.removed.map((k) => `redemption ${k} removed on hosted (refunded there)`),
    ];
    const balances = Object.fromEntries(
      (await db.query("SELECT child_id, spendable, pending FROM tickets.balances ORDER BY child_id")).rows.map((r) => [r.child_id, { spendable: r.spendable, pending: r.pending }]),
    );
    const report: StragglerReport = {
      hosted,
      inserted,
      alreadyHere,
      notApplied,
      localUnchanged: fpBefore === fpAfter,
      bySource: { before: bySourceBefore, after: await counts() },
      balances,
      ok: fpBefore === fpAfter,
    };
    await db.query(report.ok && !dryRun ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

const isMain = process.argv[1] && /import-hosted\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const from = args[args.indexOf("--from") + 1];
  if (!args.includes("--from") || !from) throw new Error("usage: import-hosted --from <dir of scans> [--stragglers-since <dir of the scans imported at the switch> | --full] [--dry-run]");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await waitForCore(pool, { attempts: 1 });
    await applyTicketsMigrations(pool);
    const since = args.includes("--stragglers-since") ? args[args.indexOf("--stragglers-since") + 1] : null;
    const dryRun = args.includes("--dry-run");
    // Since the DNS switch (8 Oct 2026) the local tables are live; the full import would make
    // hosted-sourced rows match hosted again, undoing local undos, refunds and claims.
    if (!since && !dryRun && !args.includes("--full")) {
      throw new Error("tickets are live locally: use --stragglers-since <dir of the scans imported at the switch>, or --full to really mirror hosted");
    }
    const report = since
      ? await importStragglers(pool, await readScans(since), await readScans(from), { dryRun })
      : await importHosted(pool, await readScans(from), { dryRun });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}
