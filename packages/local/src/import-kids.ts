/**
 * Brings the hosted iPad config (wainwright.fun / admin.wainwright.fun) into Postgres and proves
 * nothing was lost.
 *
 *   DATABASE_URL=… node dist/import-kids.mjs --from <dir> [--dry-run] [--update-people]
 *
 * <dir> holds read-only scans of the hosted tables, one file each, as written by
 *   aws dynamodb scan --consistent-read --table-name wainwright-<table> --output json
 * for children, apps, websites, themes, restrictions and term-dates. The device tokens
 * (wainwright-devices) and pairing codes (wainwright-pairing) are never read or imported:
 * devices are recognised by IP address on the home network.
 *
 * Children are core.people (shared with every home app). Their name, date of birth, colour and
 * avatar are compared and any difference is reported; they are only overwritten from hosted with
 * --update-people. The iPad settings (locked, restriction overrides, blocked apps) are mirrored.
 * Apps, websites, themes and restrictions are mirrored exactly (rows hosted no longer has are
 * removed). Term dates are compared with core.term_dates (edited in Snacks), never written.
 *
 * Everything happens in one transaction, followed by a reconciliation that reads every row back
 * through the adapter the app uses and compares it with the hosted item. Any difference rolls the
 * whole import back.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { unmarshall } from "./import-hosted.js";
import { applyTicketsMigrations, waitForCore } from "./migrate.js";
import { LOGICAL_TABLES, PgDocumentClient } from "./pg-ddb.js";

type Item = Record<string, any>;

export interface HostedKids {
  children: Item[];
  apps: Item[];
  websites: Item[];
  themes: Item[];
  restrictions: Item[];
  termDates: Item[];
}

export async function readKidsScans(dir: string): Promise<HostedKids> {
  const load = async (table: string) => {
    const raw = JSON.parse(await readFile(path.join(dir, `wainwright-${table}.json`), "utf8"));
    return (raw.Items as Item[]).map((item) => unmarshall({ M: item }));
  };
  return {
    children: await load("children"),
    apps: await load("apps"),
    websites: await load("websites"),
    themes: await load("themes"),
    restrictions: await load("restrictions"),
    termDates: await load("term-dates"),
  };
}

const PEOPLE_FIELDS = ["name", "date_of_birth", "color", "avatar"] as const;
const KEYS: Record<"apps" | "websites" | "themes" | "restrictions", { table: string; sql: string; column: string; key: (i: Item) => string }> = {
  apps: { table: LOGICAL_TABLES.apps, sql: "kids.apps", column: "bundle_id", key: (i) => String(i.bundle_id) },
  websites: { table: LOGICAL_TABLES.websites, sql: "kids.websites", column: "url", key: (i) => String(i.url) },
  themes: { table: LOGICAL_TABLES.themes, sql: "kids.themes", column: "from_age::text", key: (i) => String(i.from_age) },
  restrictions: { table: LOGICAL_TABLES.restrictions, sql: "kids.restrictions", column: "key", key: (i) => String(i.key) },
};

/** null and missing are the same thing; keys sorted, for comparing. */
export function canonical(value: unknown): string {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out: Item = {};
      for (const key of Object.keys(v).sort()) if ((v as Item)[key] !== null && (v as Item)[key] !== undefined) out[key] = clean((v as Item)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(clean(value));
}

export interface KidsImportReport {
  dryRun: boolean;
  hosted: Record<string, number>;
  local: Record<string, number>;
  written: Record<string, number>;
  removed: Record<string, number>;
  peopleDifferences: { child: string; field: string; hosted: unknown; local: unknown }[];
  peopleUpdated: boolean;
  termDates: { hostedYears: number; localYears: number; equal: boolean };
  mismatches: string[];
  notImported: string[];
}

export async function importKids(pool: pg.Pool, hosted: HostedKids, { dryRun = false, updatePeople = false } = {}): Promise<KidsImportReport> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kids.import'))");
    const ddb = new PgDocumentClient(db);
    const send = (name: string, input: Item) => ddb.send({ constructor: { name }, input } as never) as Promise<Item>;
    const scan = async (table: string) => ((await send("ScanCommand", { TableName: table })).Items ?? []) as Item[];
    const written: Record<string, number> = {};
    const removed: Record<string, number> = {};

    // Children: people stay as they are unless asked; settings mirror hosted.
    const before = new Map((await scan(LOGICAL_TABLES.children)).map((c) => [c.subdomain, c]));
    const peopleDifferences: KidsImportReport["peopleDifferences"] = [];
    for (const child of hosted.children) {
      const local = before.get(child.subdomain);
      for (const field of PEOPLE_FIELDS) {
        const h = child[field] === "" ? undefined : child[field];
        if (canonical(h) !== canonical(local?.[field])) peopleDifferences.push({ child: child.subdomain, field, hosted: h ?? null, local: local?.[field] ?? null });
      }
      const item: Item = { ...child };
      if (!updatePeople && local) for (const field of PEOPLE_FIELDS) item[field] = local[field];
      await send("PutCommand", { TableName: LOGICAL_TABLES.children, Item: item });
    }
    written.children = hosted.children.length;
    const hostedChildren = hosted.children.map((c) => String(c.subdomain));
    removed.child_settings = (await db.query("DELETE FROM kids.child_settings WHERE NOT (child_id = ANY($1::text[]))", [hostedChildren])).rowCount ?? 0;

    for (const [name, spec] of Object.entries(KEYS) as [keyof typeof KEYS, (typeof KEYS)[keyof typeof KEYS]][]) {
      const keys = hosted[name].map(spec.key);
      removed[name] = (await db.query(`DELETE FROM ${spec.sql} WHERE NOT (${spec.column} = ANY($1::text[]))`, [keys])).rowCount ?? 0;
      for (const item of hosted[name]) await send("PutCommand", { TableName: spec.table, Item: item });
      written[name] = hosted[name].length;
    }

    // Reconciliation: every hosted item read back through the adapter.
    const mismatches: string[] = [];
    const local: Record<string, number> = {};
    const compare = (label: string, hostedItems: Item[], localItems: Item[], key: (i: Item) => string, adjust: (h: Item, l: Item) => Item = (h) => h) => {
      local[label] = localItems.length;
      const byKey = new Map(localItems.map((i) => [key(i), i]));
      if (localItems.length !== hostedItems.length) mismatches.push(`${label}: ${hostedItems.length} hosted, ${localItems.length} local`);
      for (const h of hostedItems) {
        const l = byKey.get(key(h));
        if (!l) mismatches.push(`${label} ${key(h)}: missing locally`);
        else if (canonical(adjust(h, l)) !== canonical(l)) mismatches.push(`${label} ${key(h)}: differs`);
      }
    };
    compare("children", hosted.children, await scan(LOGICAL_TABLES.children), (i) => String(i.subdomain), (h, l) => {
      const out: Item = { ...h };
      if (out.date_of_birth === "") delete out.date_of_birth;
      if (!updatePeople) for (const field of PEOPLE_FIELDS) out[field] = l[field];
      return out;
    });
    for (const [name, spec] of Object.entries(KEYS) as [keyof typeof KEYS, (typeof KEYS)[keyof typeof KEYS]][]) {
      compare(name, hosted[name], await scan(spec.table), spec.key);
    }

    const localTerms = await scan(LOGICAL_TABLES.termDates);
    const termKey = (i: Item) => String(i.academic_year);
    const localByYear = new Map(localTerms.map((i) => [termKey(i), canonical(i.terms)]));
    const termEqual = localTerms.length === hosted.termDates.length && hosted.termDates.every((h) => localByYear.get(termKey(h)) === canonical(h.terms));

    const report: KidsImportReport = {
      dryRun,
      hosted: Object.fromEntries(Object.entries(hosted).map(([k, v]) => [k, v.length])),
      local,
      written,
      removed,
      peopleDifferences,
      peopleUpdated: updatePeople && peopleDifferences.length > 0,
      termDates: { hostedYears: hosted.termDates.length, localYears: localTerms.length, equal: termEqual },
      mismatches,
      notImported: ["wainwright-devices (device tokens)", "wainwright-pairing (pairing codes)"],
    };
    await db.query(dryRun || mismatches.length ? "ROLLBACK" : "COMMIT");
    return report;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const from = args[args.indexOf("--from") + 1];
  if (!args.includes("--from") || !from) throw new Error("usage: import-kids --from <dir> [--dry-run] [--update-people]");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await waitForCore(pool, { log: () => {} });
    await applyTicketsMigrations(pool);
    const report = await importKids(pool, await readKidsScans(from), { dryRun: args.includes("--dry-run"), updatePeople: args.includes("--update-people") });
    console.log(JSON.stringify(report, null, 2));
    if (report.mismatches.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /import-kids\.(ts|mjs|js)$/.test(process.argv[1])) await main();
