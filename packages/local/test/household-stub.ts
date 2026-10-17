/**
 * Test double for the household service. It is not Household: it only implements
 * the claim / complete / undo contract Tickets calls, and it awards tickets with
 * tickets.award in its own transaction the way Household does. Production Tickets
 * never starts this process.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { choreTicketsNow } from "../src/household-chores.ts";

export interface HouseholdCall {
  action: string;
  choreId: string;
  childId: string | null;
  realIp: string | null;
}

export async function startHouseholdStub(pool: pg.Pool): Promise<{ url: string; calls: HouseholdCall[]; close: () => Promise<void> }> {
  const calls: HouseholdCall[] = [];
  const server = createServer((req, res) => {
    void handle(pool, calls, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(payload);
}

async function handle(pool: pg.Pool, calls: HouseholdCall[], req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true });
    return;
  }
  const match = /^\/api\/kid\/chores\/([^/]+)\/(claim|complete|undo)$/.exec(url.pathname);
  if (req.method !== "POST" || !match) {
    send(res, 404, { error: "Not found" });
    return;
  }
  const choreId = decodeURIComponent(match[1]);
  const action = match[2];
  const childId = req.headers["x-household-child"];
  const child = Array.isArray(childId) ? childId[0] : childId ?? null;
  const real = req.headers["x-real-ip"];
  calls.push({ action, choreId, childId: child, realIp: Array.isArray(real) ? real[0] : real ?? null });
  await readBody(req);
  if (!child) {
    send(res, 401, { error: "Missing child" });
    return;
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const person = await db.query("SELECT 1 FROM core.people WHERE id = $1 AND role = 'child'", [child]);
    if (person.rowCount === 0) {
      await db.query("ROLLBACK");
      send(res, 403, { error: "Unknown child" });
      return;
    }
    const chore = await db.query(
      `SELECT c.id, c.title, c.target_type, c.base_tickets, c.reset_days, c.enabled, r.area_m2
       FROM household.chores c LEFT JOIN household.rooms r ON r.id = c.room_id WHERE c.id = $1`,
      [choreId],
    );
    if (chore.rowCount === 0 || chore.rows[0].enabled === false) {
      await db.query("ROLLBACK");
      send(res, 404, { error: "That chore isn't available any more" });
      return;
    }
    const allowTable = await db.query("SELECT to_regclass('household.chore_allowed_claimers') IS NOT NULL AS ok");
    const allowed = allowTable.rows[0]?.ok
      ? await db.query("SELECT child_id FROM household.chore_allowed_claimers WHERE chore_id = $1", [choreId])
      : { rows: [] as { child_id: string }[] };
    if (allowed.rows.length > 0 && !allowed.rows.some((row) => row.child_id === child)) {
      await db.query("ROLLBACK");
      send(res, 403, { error: "That chore isn't yours to claim" });
      return;
    }
    if (action === "claim") {
      const open = await db.query(
        `SELECT child_id FROM household.chore_claims WHERE chore_id = $1 AND status IN ('claimed', 'held') ORDER BY claimed_at DESC LIMIT 1`,
        [choreId],
      );
      if (open.rows.length > 0) {
        await db.query("COMMIT");
        send(res, open.rows[0].child_id === child ? 200 : 409, open.rows[0].child_id === child ? { already: true } : { error: "Someone else claimed that" });
        return;
      }
      await db.query(
        `INSERT INTO household.chore_claims (chore_id, child_id, status) VALUES ($1, $2, 'claimed')`,
        [choreId, child],
      );
      await db.query("COMMIT");
      send(res, 200, { chore_id: choreId, child_id: child });
      return;
    }
    if (action === "complete") {
      const claim = await db.query(
        `SELECT id FROM household.chore_claims WHERE chore_id = $1 AND child_id = $2 AND status IN ('claimed', 'held')`,
        [choreId, child],
      );
      if (claim.rows.length === 0) {
        await db.query("ROLLBACK");
        send(res, 404, { error: "Claim that chore first" });
        return;
      }
      const last = await db.query(
        `SELECT completed_at FROM household.chore_completions WHERE chore_id = $1 ORDER BY completed_at DESC LIMIT 1`,
        [choreId],
      );
      const row = chore.rows[0];
      const tickets = choreTicketsNow(
        { base_tickets: row.base_tickets, reset_days: row.reset_days, target_type: row.target_type },
        last.rows[0] ? new Date(last.rows[0].completed_at).toISOString() : null,
        row.target_type === "room" ? Number(row.area_m2) : null,
      );
      const sourceRef = `${choreId}#${child}#${Date.now()}`;
      await db.query(
        `INSERT INTO household.chore_completions (chore_id, child_id, tickets, source_ref) VALUES ($1, $2, $3, $4)`,
        [choreId, child, tickets, sourceRef],
      );
      await db.query(`DELETE FROM household.chore_claims WHERE chore_id = $1 AND child_id = $2`, [choreId, child]);
      await db.query(`SELECT tickets.award($1, $2, $3, $4, 'household', $5)`, [child, `chores#${choreId}`, tickets, row.title, sourceRef]);
      await db.query("COMMIT");
      send(res, 200, { completion: { title: row.title, tickets, chore_id: choreId } });
      return;
    }
    const latest = await db.query(
      `SELECT id, source_ref FROM household.chore_completions WHERE chore_id = $1 AND child_id = $2 ORDER BY completed_at DESC, id DESC LIMIT 1`,
      [choreId, child],
    );
    if (latest.rows.length === 0) {
      await db.query("ROLLBACK");
      send(res, 404, { error: "That chore wasn't completed yet" });
      return;
    }
    await db.query(`SELECT tickets.revoke('household', $1)`, [latest.rows[0].source_ref]);
    await db.query(`DELETE FROM household.chore_completions WHERE id = $1`, [latest.rows[0].id]);
    await db.query("COMMIT");
    send(res, 200, { removed: true });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    send(res, 500, { error: (error as Error).message });
  } finally {
    db.release();
  }
}
