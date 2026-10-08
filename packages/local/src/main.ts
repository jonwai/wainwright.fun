import { createServer } from "node:http";
import pg from "pg";
import { createLocalTickets } from "./app.js";
import { applyTicketsMigrations, waitForCore } from "./migrate.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: url, max: 10 });

await waitForCore(pool, { log });
const ran = await applyTicketsMigrations(pool);
if (ran.length) log(`applied tickets migrations: ${ran.join(", ")}`);

const listener = createLocalTickets({
  pool,
  staticDir: process.env.TICKETS_STATIC_DIR ?? "apps/tickets/dist",
  adminDir: process.env.TICKETS_ADMIN_DIR ?? "apps/admin/dist-local-tickets",
  iconsDir: process.env.TICKETS_ICONS_DIR ?? "/data/ticket-icons",
  log,
});
const port = Number(process.env.PORT ?? 43127);
createServer((req, res) => void listener(req, res)).listen(port, "0.0.0.0", () => log(`tickets listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: shutting down`);
    void pool.end().finally(() => process.exit(0));
  });
}
