/**
 * In-memory stand-in for Household's kid API (jonwai/household main, PR #6).
 * It is not Household. It only speaks the HTTP contract Tickets calls, and on
 * complete / undo it calls tickets.award / tickets.revoke in its own transaction
 * the way Household does. Production Tickets never starts this process.
 *
 * Real Household trusts X-Household-Child only from the Docker bridge
 * (172.16.0.0/12) and sends `"demo": false` on /api/health. This stand-in
 * accepts the header from the test machine and sends `"demo": true`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";

export interface StandInChore {
  id: string;
  title: string;
  job: string | null;
  chore_kind: "job" | "routine";
  target_type: string;
  target_id: string | null;
  place_name: string | null;
  room_id: string;
  room_name: string;
  floor: number;
  /** Award right now, before this stand-in records a fresh completion. */
  tickets: number;
  term_time_only: boolean;
  due_today: boolean;
  /** Empty means any child. */
  allowed_claimers: string[];
}

interface OpenClaim {
  chore_id: string;
  child_id: string;
  claimed_at: string;
}

interface Hold {
  chore_id: string;
  child_id: string;
}

interface Completion {
  chore_id: string;
  child_id: string;
  at: string;
  tickets: number;
  source_ref: string;
}

export interface StandInState {
  claims: OpenClaim[];
  holds: Hold[];
  completions: Completion[];
}

export interface HouseholdCall {
  action: string;
  choreId: string | null;
  headerChild: string | null;
  queryChild: string | null;
  bodyChild: string | null;
}

/** The house used by the tests and the browser stand-in. */
export function demoCatalog(): StandInChore[] {
  return [
    { id: "pack-bag", title: "Pack the school bag", job: "pack", chore_kind: "routine", target_type: "room", target_id: "kitchen", place_name: null, room_id: "kitchen", room_name: "Kitchen", floor: 0, tickets: 1, term_time_only: true, due_today: true, allowed_claimers: [] },
    { id: "empty-bin", title: "Empty the bin", job: "empty", chore_kind: "job", target_type: "fixture", target_id: "bin-kitchen", place_name: "Bin", room_id: "kitchen", room_name: "Kitchen", floor: 0, tickets: 1, term_time_only: false, due_today: true, allowed_claimers: [] },
    { id: "clean-window", title: "Clean the kitchen window", job: "clean", chore_kind: "job", target_type: "window", target_id: "window-kitchen", place_name: "Kitchen window", room_id: "kitchen", room_name: "Kitchen", floor: 0, tickets: 9, term_time_only: false, due_today: true, allowed_claimers: [] },
    { id: "clean-oven", title: "Clean the oven", job: "clean", chore_kind: "job", target_type: "fixture", target_id: "oven", place_name: "Oven", room_id: "kitchen", room_name: "Kitchen", floor: 0, tickets: 0, term_time_only: false, due_today: true, allowed_claimers: [] },
    { id: "hoover-bathroom", title: "Hoover the bathroom", job: "hoover", chore_kind: "job", target_type: "room", target_id: "bathroom", place_name: null, room_id: "bathroom", room_name: "Bathroom", floor: 1, tickets: 2, term_time_only: false, due_today: true, allowed_claimers: [] },
    { id: "wipe-sink", title: "Wipe the sink", job: "wipe", chore_kind: "job", target_type: "fixture", target_id: "sink-bathroom", place_name: "Sink", room_id: "bathroom", room_name: "Bathroom", floor: 1, tickets: 1, term_time_only: false, due_today: true, allowed_claimers: ["hannah"] },
    { id: "tidy-playroom", title: "Tidy the playroom", job: "tidy", chore_kind: "job", target_type: "room", target_id: "lounge", place_name: null, room_id: "lounge", room_name: "Lounge", floor: 0, tickets: 4, term_time_only: false, due_today: true, allowed_claimers: [] },
    { id: "make-bed", title: "Make the bed", job: "make", chore_kind: "routine", target_type: "room", target_id: "bedroom", place_name: null, room_id: "bedroom", room_name: "Bedroom", floor: 1, tickets: 1, term_time_only: false, due_today: false, allowed_claimers: [] },
  ];
}

export function demoState(): StandInState {
  return {
    claims: [{ chore_id: "empty-bin", child_id: "lydia", claimed_at: "2026-10-17T08:00:00.000Z" }],
    holds: [{ chore_id: "tidy-playroom", child_id: "zoe" }],
    completions: [{ chore_id: "clean-oven", child_id: "zoe", at: "2026-10-17T09:00:00.000Z", tickets: 3, source_ref: "seed:clean-oven" }],
  };
}

export async function startHouseholdStub(
  pool: pg.Pool,
  options: { catalog?: StandInChore[]; state?: StandInState } = {},
): Promise<{ url: string; calls: HouseholdCall[]; reset: () => void; close: () => Promise<void> }> {
  const catalog = () => structuredClone(options.catalog ?? demoCatalog());
  const initial = () => structuredClone(options.state ?? demoState());
  let chores = catalog();
  let state = initial();
  const calls: HouseholdCall[] = [];
  const names = new Map<string, string>();

  async function loadNames(): Promise<void> {
    if (names.size > 0) return;
    const { rows } = await pool.query("SELECT id, display_name FROM core.people WHERE role = 'child'");
    for (const row of rows) names.set(row.id as string, row.display_name as string);
  }

  function reset() {
    chores = catalog();
    state = initial();
    calls.length = 0;
  }

  function listFor(childId: string, childNameValue: string) {
    const rooms = new Map<string, { id: string; name: string; floor: number; chores: unknown[] }>();
    for (const chore of chores) {
      if (chore.allowed_claimers.length > 0 && !chore.allowed_claimers.includes(childId)) continue;
      if (chore.chore_kind === "routine" && !chore.due_today) continue;
      const claim = state.claims.find((row) => row.chore_id === chore.id) ?? null;
      const hold = state.holds.find((row) => row.chore_id === chore.id) ?? null;
      const last = [...state.completions].reverse().find((row) => row.chore_id === chore.id) ?? null;
      const room = rooms.get(chore.room_id) ?? { id: chore.room_id, name: chore.room_name, floor: chore.floor, chores: [] };
      room.chores.push({
        id: chore.id,
        title: chore.title,
        job: chore.job,
        chore_kind: chore.chore_kind,
        target_type: chore.target_type,
        target_id: chore.target_id,
        place_name: chore.place_name,
        tickets: chore.tickets,
        term_time_only: chore.term_time_only,
        due_today: chore.due_today,
        allowed_claimers: chore.allowed_claimers,
        claim: claim
          ? { child_id: claim.child_id, name: names.get(claim.child_id) ?? claim.child_id, mine: claim.child_id === childId }
          : null,
        held: hold !== null,
        held_by: hold ? (names.get(hold.child_id) ?? hold.child_id) : null,
        last_completed_at: last?.at ?? null,
        last_completed_by: last ? (names.get(last.child_id) ?? last.child_id) : null,
        last_completed_by_me: last?.child_id === childId,
        can_undo: last?.child_id === childId,
      });
      rooms.set(chore.room_id, room);
    }
    return {
      child: { id: childId, name: childNameValue },
      now: new Date().toISOString(),
      rooms: [...rooms.values()].sort((a, b) => a.floor - b.floor || a.name.localeCompare(b.name)),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      send(res, 200, { ok: true, service: "household", demo: true });
      return;
    }
    const header = headerValue(req.headers["x-household-child"]);
    const queryChild = url.searchParams.get("child");
    const raw = req.method === "POST" ? await readBody(req) : "";
    let bodyChild: string | null = null;
    if (req.method === "POST" && raw) {
      try {
        const parsed = JSON.parse(raw) as { child_id?: unknown };
        bodyChild = typeof parsed.child_id === "string" ? parsed.child_id : null;
      } catch {
        send(res, 400, { error: "Body is not valid JSON" });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/kid/chores") {
      calls.push({ action: "list", choreId: null, headerChild: header, queryChild, bodyChild: null });
      if (!header || !queryChild || header !== queryChild) {
        send(res, 400, { error: "Child does not match" });
        return;
      }
      await loadNames();
      const name = names.get(header);
      if (!name) {
        send(res, 403, { error: "Unknown child" });
        return;
      }
      send(res, 200, listFor(header, name));
      return;
    }

    const match = /^\/api\/kid\/chores\/([^/]+)\/(claim|complete|undo)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) {
      send(res, 404, { error: "Not found" });
      return;
    }
    const choreId = decodeURIComponent(match[1]);
    const action = match[2];
    calls.push({ action, choreId, headerChild: header, queryChild, bodyChild });
    if (!header || !bodyChild || header !== bodyChild || (queryChild !== null && queryChild !== header)) {
      send(res, 400, { error: "Child does not match" });
      return;
    }
    await loadNames();
    const name = names.get(header);
    if (!name) {
      send(res, 403, { error: "Unknown child" });
      return;
    }
    const chore = chores.find((row) => row.id === choreId);
    if (!chore) {
      send(res, 404, { error: "That chore isn't available any more" });
      return;
    }
    if (chore.allowed_claimers.length > 0 && !chore.allowed_claimers.includes(header)) {
      send(res, 403, { error: "That chore isn't yours to claim" });
      return;
    }
    if (chore.chore_kind === "routine" && !chore.due_today) {
      send(res, 409, { error: "That routine isn't due today" });
      return;
    }

    if (action === "claim") {
      const open = state.claims.find((row) => row.chore_id === choreId);
      if (open && open.child_id !== header) {
        send(res, 409, { error: "Someone else claimed that" });
        return;
      }
      const held = state.holds.find((row) => row.chore_id === choreId);
      if (held && held.child_id !== header) {
        send(res, 409, { error: "Someone else claimed that" });
        return;
      }
      const claimed_at = open?.claimed_at ?? new Date().toISOString();
      if (!open) state.claims.push({ chore_id: choreId, child_id: header, claimed_at });
      state.holds = state.holds.filter((row) => row.chore_id !== choreId);
      send(res, 200, { claim: { choreId, childId: header, childName: name, claimed_at } });
      return;
    }

    if (action === "complete") {
      const open = state.claims.find((row) => row.chore_id === choreId && row.child_id === header);
      const held = state.holds.find((row) => row.chore_id === choreId && row.child_id === header);
      if (!open && !held) {
        send(res, 404, { error: "Claim that chore first" });
        return;
      }
      const tickets = chore.tickets;
      const sourceRef = `${choreId}#${header}#${Date.now()}`;
      const at = new Date().toISOString();
      try {
        await pool.query("SELECT tickets.award($1, $2, $3, $4, 'household', $5)", [header, `chores#${choreId}`, tickets, chore.title, sourceRef]);
      } catch (error) {
        send(res, 500, { error: (error as Error).message });
        return;
      }
      state.claims = state.claims.filter((row) => row.chore_id !== choreId);
      state.holds = state.holds.filter((row) => row.chore_id !== choreId);
      state.completions.push({ chore_id: choreId, child_id: header, at, tickets, source_ref: sourceRef });
      chore.tickets = 0;
      send(res, 200, { tickets, ticketSync: { ok: true }, completion: { choreId, childId: header, completed_at: at, tickets } });
      return;
    }

    const last = [...state.completions].reverse().find((row) => row.chore_id === choreId && row.child_id === header);
    if (!last) {
      send(res, 404, { error: "That chore wasn't completed yet" });
      return;
    }
    try {
      await pool.query("SELECT tickets.revoke('household', $1)", [last.source_ref]);
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
      return;
    }
    state.completions = state.completions.filter((row) => row !== last);
    chore.tickets = last.tickets;
    send(res, 200, { ticketSync: { ok: true } });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: Error) => send(res, 500, { error: error.message }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    reset,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ? raw : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
