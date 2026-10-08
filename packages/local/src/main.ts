import { createServer } from "node:http";
import pg from "pg";
import { createLocalTickets } from "./app.js";
import { createLocalSites } from "./sites.js";
import { applyTicketsMigrations, waitForCore } from "./migrate.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: url, max: 10 });

await waitForCore(pool, { log });
const ran = await applyTicketsMigrations(pool);
if (ran.length) log(`applied tickets migrations: ${ran.join(", ")}`);

const ticketIconsDir = process.env.TICKETS_ICONS_DIR ?? "/data/ticket-icons";
const tickets = createLocalTickets({
  pool,
  staticDir: process.env.TICKETS_STATIC_DIR ?? "apps/tickets/dist",
  adminDir: process.env.TICKETS_ADMIN_DIR ?? "apps/admin/dist-local-tickets",
  iconsDir: ticketIconsDir,
  log,
});
// wainwright.fun and admin.wainwright.fun share the server; everything else is tickets.
const certFile = process.env.PROFILE_SIGNING_CERT_FILE;
const keyFile = process.env.PROFILE_SIGNING_KEY_FILE;
const listener = createLocalSites({
  pool,
  tickets,
  kidsDir: process.env.KIDS_STATIC_DIR ?? "apps/kids/dist-local",
  adminDir: process.env.KIDS_ADMIN_DIR ?? "apps/admin/dist-local-admin",
  kidsIconsDir: process.env.KIDS_ICONS_DIR ?? "/data/kids-icons",
  ticketIconsDir,
  signer: certFile && keyFile ? { certFile, keyFile } : null,
  log,
});
if (!certFile || !keyFile) log("profile signing is not configured: iPad profiles will not be handed out");
const port = Number(process.env.PORT ?? 43127);
createServer((req, res) => void listener(req, res)).listen(port, "0.0.0.0", () => log(`tickets listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: shutting down`);
    void pool.end().finally(() => process.exit(0));
  });
}
