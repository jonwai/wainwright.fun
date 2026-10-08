import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Advisory lock for tickets migrations (snacks 4207321, the mirror 4207312). */
export const TICKETS_MIGRATION_LOCK = 4207331;

export function migrationsDir(): string {
  return process.env.TICKETS_MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

/** Waits until core (people, devices, term dates) exists; the Wainsburys/local poller creates it. */
export async function waitForCore(pool: pg.Pool, { attempts = 60, delayMs = 5000, log = (_: string) => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await pool.query(
        "SELECT to_regclass('core.people') IS NOT NULL AND to_regclass('core.devices') IS NOT NULL AND to_regclass('core.term_dates') IS NOT NULL AS ready",
      );
      if (result.rows[0]?.ready) return;
      log(`waiting for the core schema (attempt ${attempt})`);
    } catch (error) {
      log(`waiting for Postgres (attempt ${attempt}): ${(error as Error).message}`);
    }
    if (attempt >= attempts) throw new Error("core schema did not appear; is the poller running migrations?");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function applyTicketsMigrations(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [TICKETS_MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS public.tickets_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query("SELECT version FROM public.tickets_schema_migrations")).rows.map((row) => row.version));
    const ran: string[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      await client.query(await readFile(path.join(dir, file), "utf8"));
      await client.query("INSERT INTO public.tickets_schema_migrations (version) VALUES ($1)", [file]);
      ran.push(file);
    }
    await client.query("COMMIT");
    return ran;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
