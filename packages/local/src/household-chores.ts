/**
 * House chores in the Tickets kid app.
 *
 * Household (a separate service) is the only place chores are defined. Tickets
 * reads `household.*` on the shared database for the kid list, and sends claim,
 * done and undo to Household's own HTTP API so `tickets.award` / `tickets.revoke`
 * stay inside Household's transaction. Tickets never writes those tables.
 *
 * Kid identity is `core.people.id` in both apps (the old child subdomain:
 * hannah, lydia, zoe, ethan). Tickets has already resolved the viewer — a
 * child's device, or a parent acting as a child — and sends that id as
 * `X-Household-Child` plus the device IP as `X-Real-IP`.
 *
 * Paths (the kid routes the retired chores app used, under the `/api` prefix
 * the home services use). Override the prefix with HOUSEHOLD_API_PREFIX:
 *   POST {HOUSEHOLD_URL}{prefix}/kid/chores/{id}/claim
 *   POST {HOUSEHOLD_URL}{prefix}/kid/chores/{id}/complete
 *   POST {HOUSEHOLD_URL}{prefix}/kid/chores/{id}/undo
 *
 * The private household repo was not readable from this environment, so these
 * paths are the contract Tickets calls. If Household mounts them somewhere
 * else, set HOUSEHOLD_API_PREFIX. If Household does not accept
 * `X-Household-Child` from the tickets container, actions fail and the gap is
 * reported — Tickets does not award tickets itself.
 *
 * Display uses Household's choreTicketsNow rule: area-adjusted base, 0 just
 * after a completion, growing to at most 2× once overdue. Optional columns
 * from Household PR #3 (allowed claimers, held claims, term-time routines)
 * are used when they exist and ignored when they do not.
 */
import type pg from "pg";

export const HOUSEHOLD_CHILD_HEADER = "x-household-child";

export interface HouseholdLink {
  /** House chores are shown only when this is true and `url` is set. */
  enabled: boolean;
  /** Household base URL, no trailing slash. e.g. http://household:43126 */
  url: string;
  /** Path before `/kid/chores`. Default `/api`. Empty string mounts at the root. */
  apiPrefix?: string;
}

export function householdLinkFromEnv(env: NodeJS.ProcessEnv = process.env): HouseholdLink {
  const url = (env.HOUSEHOLD_URL ?? "").trim().replace(/\/$/, "");
  const enabled = env.HOUSEHOLD_CHORES === "1" && url.length > 0;
  return { enabled, url, apiPrefix: env.HOUSEHOLD_API_PREFIX };
}

const CHORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

/** Size factor: rooms scale by area (0.5×–2× around 10 m²), everything else is 1×. */
function sizeFactor(targetType: string, areaM2: number | null): number {
  if (targetType !== "room" || areaM2 === null || !Number.isFinite(areaM2)) return 1;
  return Math.min(2, Math.max(0.5, areaM2 / 10));
}

/**
 * Live ticket value. Matches Household's choreTicketsNow: the area-adjusted
 * base when a chore has never been done, 0 the moment it is completed, and
 * at most twice that base once it is overdue (`reset_days` past).
 */
export function choreTicketsNow(
  chore: { base_tickets: number; reset_days: number; target_type: string },
  lastDoneAt: string | null,
  areaM2: number | null,
  now = Date.now(),
): number {
  const base = Math.round(chore.base_tickets * sizeFactor(chore.target_type, areaM2));
  if (!lastDoneAt) return base;
  const elapsedDays = (now - new Date(lastDoneAt).getTime()) / 86_400_000;
  if (!Number.isFinite(elapsedDays) || chore.reset_days <= 0) return 0;
  const grown = Math.floor((elapsedDays / chore.reset_days) * base);
  return Math.min(base * 2, Math.max(0, grown));
}

export interface HouseholdChoreView {
  id: string;
  title: string;
  job: string | null;
  place_name: string | null;
  target_type: string;
  tickets: number;
  last_done_at: string | null;
  last_done_by: string | null;
  last_done_by_me: boolean;
  claim: { child_id: string; name: string; mine: boolean; held: boolean } | null;
  kind: string | null;
  term_time: boolean;
}

export interface HouseholdRoomView {
  id: string;
  name: string;
  floor: number | null;
  chores: HouseholdChoreView[];
}

interface Columns {
  names: Set<string>;
  types: Map<string, string>;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected column ${name}`);
  return name;
}

async function tableColumns(db: pg.PoolClient, table: string): Promise<Columns | null> {
  const { rows } = await db.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'household' AND table_name = $1`,
    [table],
  );
  if (rows.length === 0) return null;
  return {
    names: new Set(rows.map((row) => String(row.column_name))),
    types: new Map(rows.map((row) => [String(row.column_name), String(row.udt_name)])),
  };
}

function pick(cols: Columns | null, options: string[]): string | null {
  if (!cols) return null;
  return options.find((name) => cols.names.has(name)) ?? null;
}

function londonDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function inTermTime(db: pg.PoolClient, day: string): Promise<boolean | null> {
  const ready = await db.query("SELECT to_regclass('core.term_dates') IS NOT NULL AS ready");
  if (!ready.rows[0]?.ready) return null;
  const { rows } = await db.query(
    `SELECT to_char(opens, 'YYYY-MM-DD') AS opens, to_char(closes, 'YYYY-MM-DD') AS closes,
            to_char(half_term_start, 'YYYY-MM-DD') AS half_start, to_char(half_term_end, 'YYYY-MM-DD') AS half_end
     FROM core.term_dates`,
  );
  if (rows.length === 0) return null;
  return rows.some((row) => {
    if (day < row.opens || day > row.closes) return false;
    if (row.half_start && row.half_end && day >= row.half_start && day <= row.half_end) return false;
    return true;
  });
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function childIdsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

const CLOSED_CLAIM = new Set(["released", "done", "cancelled", "canceled", "undone", "closed"]);

/** Which chores this child is allowed to claim, or null when Household has no such data. */
async function allowedClaimers(
  db: pg.PoolClient,
  choreIdCol: string,
): Promise<Map<string, Set<string>> | null> {
  const tables = ["chore_allowed_claimers", "chore_claimers", "allowed_claimers", "chore_children"];
  for (const table of tables) {
    const cols = await tableColumns(db, table);
    const choreCol = pick(cols, ["chore_id", choreIdCol, "id"]);
    const childCol = pick(cols, ["child_id", "child_subdomain", "person_id"]);
    if (!cols || !choreCol || !childCol) continue;
    const { rows } = await db.query(`SELECT ${ident(choreCol)} AS chore_id, ${ident(childCol)} AS child_id FROM household.${ident(table)}`);
    if (rows.length === 0) continue;
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = map.get(String(row.chore_id)) ?? new Set<string>();
      set.add(String(row.child_id));
      map.set(String(row.chore_id), set);
    }
    return map;
  }
  return null;
}

export async function listHouseholdChores(
  db: pg.PoolClient,
  childId: string,
  now = new Date(),
): Promise<{ ok: true; rooms: HouseholdRoomView[] } | { ok: false; reason: string }> {
  const choresCols = await tableColumns(db, "chores");
  const choreIdCol = pick(choresCols, ["id", "chore_id"]);
  if (!choresCols || !choreIdCol || !choresCols.names.has("title")) return { ok: false, reason: "household.chores is missing" };

  const select = ["id", "chore_id", "title", "job", "target_type", "room_id", "fixture_id", "window_id", "switch_id", "base_tickets", "reset_days", "enabled", "kind", "term_time", "active", "starts_on", "ends_on", "allowed_child_ids", "allowed_claimers", "claimers"]
    .filter((name) => choresCols.names.has(name))
    .map((name) => (choresCols.types.get(name) === "date" ? `to_char(${ident(name)}, 'YYYY-MM-DD') AS ${ident(name)}` : ident(name)));
  const choreRows = (await db.query(`SELECT ${select.join(", ")} FROM household.chores`)).rows as Record<string, unknown>[];

  const roomsCols = await tableColumns(db, "rooms");
  const roomIdCol = pick(roomsCols, ["id", "room_id"]);
  const rooms = new Map<string, { name: string; floor: number | null; area: number | null; enabled: boolean }>();
  if (roomsCols && roomIdCol && roomsCols.names.has("name")) {
    const roomSelect = [roomIdCol, "name", ...(roomsCols.names.has("floor") ? ["floor"] : []), ...(roomsCols.names.has("area_m2") ? ["area_m2"] : []), ...(roomsCols.names.has("enabled") ? ["enabled"] : [])];
    const { rows } = await db.query(`SELECT ${roomSelect.map(ident).join(", ")} FROM household.rooms`);
    for (const row of rows) {
      rooms.set(String(row[roomIdCol]), {
        name: String(row.name),
        floor: roomsCols.names.has("floor") ? asNumber(row.floor) : null,
        area: roomsCols.names.has("area_m2") ? asNumber(row.area_m2) : null,
        enabled: roomsCols.names.has("enabled") ? row.enabled !== false : true,
      });
    }
  }

  async function places(table: string, idOptions: string[]): Promise<Map<string, { name: string; roomId: string | null; enabled: boolean; batteryDead: boolean | null }>> {
    const cols = await tableColumns(db, table);
    const idCol = pick(cols, idOptions);
    if (!cols || !idCol || !cols.names.has("name")) return new Map();
    const fields = [idCol, "name", ...(cols.names.has("room_id") ? ["room_id"] : []), ...(cols.names.has("enabled") ? ["enabled"] : []), ...(cols.names.has("battery_dead") ? ["battery_dead"] : [])];
    const { rows } = await db.query(`SELECT ${fields.map(ident).join(", ")} FROM household.${ident(table)}`);
    const map = new Map<string, { name: string; roomId: string | null; enabled: boolean; batteryDead: boolean | null }>();
    for (const row of rows) {
      map.set(String(row[idCol]), {
        name: String(row.name),
        roomId: cols.names.has("room_id") && row.room_id != null ? String(row.room_id) : null,
        enabled: cols.names.has("enabled") ? row.enabled !== false : true,
        batteryDead: cols.names.has("battery_dead") ? row.battery_dead === true : null,
      });
    }
    return map;
  }

  // One request holds one connection; pg will not run queries on it concurrently.
  const fixtures = await places("fixtures", ["id", "fixture_id"]);
  const windows = await places("windows", ["id", "window_id"]);
  const switches = await places("switches", ["id", "switch_id"]);

  const names = new Map<string, string>();
  const people = await db.query("SELECT id, display_name FROM core.people");
  for (const row of people.rows) names.set(String(row.id), String(row.display_name));
  const nameOf = (id: string | null) => (id ? names.get(id) ?? id : null);

  const claimCols = await tableColumns(db, "chore_claims");
  const claimChoreCol = pick(claimCols, ["chore_id"]);
  const claimChildCol = pick(claimCols, ["child_id", "child_subdomain", "person_id"]);
  const claimsByChore = new Map<string, { childId: string; at: string; held: boolean }[]>();
  if (claimCols && claimChoreCol && claimChildCol) {
    const fields = [claimChoreCol, claimChildCol, ...(claimCols.names.has("claimed_at") ? ["claimed_at"] : []), ...(claimCols.names.has("status") ? ["status"] : []), ...(claimCols.names.has("released_at") ? ["released_at"] : [])];
    const { rows } = await db.query(`SELECT ${fields.map(ident).join(", ")} FROM household.chore_claims`);
    for (const row of rows) {
      if (claimCols.names.has("released_at") && row.released_at != null) continue;
      const status = claimCols.names.has("status") && row.status != null ? String(row.status).toLowerCase() : "claimed";
      if (CLOSED_CLAIM.has(status)) continue;
      const list = claimsByChore.get(String(row[claimChoreCol])) ?? [];
      list.push({ childId: String(row[claimChildCol]), at: asIso(row.claimed_at) ?? "", held: status === "held" });
      claimsByChore.set(String(row[claimChoreCol]), list);
    }
  }

  const doneCols = await tableColumns(db, "chore_completions");
  const doneChoreCol = pick(doneCols, ["chore_id"]);
  const doneChildCol = pick(doneCols, ["child_id", "child_subdomain", "person_id"]);
  const doneAtCol = pick(doneCols, ["completed_at", "done_at"]);
  const lastDone = new Map<string, { childId: string | null; at: string }>();
  if (doneCols && doneChoreCol && doneAtCol) {
    const fields = [doneChoreCol, doneAtCol, ...(doneChildCol ? [doneChildCol] : []), ...(doneCols.names.has("undone_at") ? ["undone_at"] : [])];
    const { rows } = await db.query(`SELECT ${fields.map(ident).join(", ")} FROM household.chore_completions`);
    for (const row of rows) {
      if (doneCols.names.has("undone_at") && row.undone_at != null) continue;
      const at = asIso(row[doneAtCol]);
      if (!at) continue;
      const id = String(row[doneChoreCol]);
      const prev = lastDone.get(id);
      if (!prev || at > prev.at) lastDone.set(id, { childId: doneChildCol ? String(row[doneChildCol]) : null, at });
    }
  }

  const allowMap = await allowedClaimers(db, choreIdCol);
  const allowCol = pick(choresCols, ["allowed_child_ids", "allowed_claimers", "claimers"]);
  const day = londonDay(now);
  const term = choresCols.names.has("term_time") ? await inTermTime(db, day) : null;

  const grouped = new Map<string, HouseholdRoomView>();
  const loose: HouseholdChoreView[] = [];

  for (const row of choreRows) {
    if (choresCols.names.has("enabled") && row.enabled === false) continue;
    if (choresCols.names.has("active") && row.active === false) continue;
    const id = String(row[choreIdCol]);
    const targetType = choresCols.names.has("target_type") && row.target_type != null ? String(row.target_type) : "room";
    const fixtureId = row.fixture_id != null ? String(row.fixture_id) : null;
    const windowId = row.window_id != null ? String(row.window_id) : null;
    const switchId = row.switch_id != null ? String(row.switch_id) : null;
    const place = targetType === "fixture" && fixtureId ? fixtures.get(fixtureId) : targetType === "window" && windowId ? windows.get(windowId) : targetType === "switch" && switchId ? switches.get(switchId) : null;
    if (place && !place.enabled) continue;
    const job = row.job != null ? String(row.job) : null;
    if (job === "batteries" && place?.batteryDead === false) continue;

    if (choresCols.names.has("starts_on") && row.starts_on != null && day < String(row.starts_on).slice(0, 10)) continue;
    if (choresCols.names.has("ends_on") && row.ends_on != null && day > String(row.ends_on).slice(0, 10)) continue;
    const termTime = choresCols.names.has("term_time") && row.term_time === true;
    if (termTime && term === false) continue;

    if (allowMap) {
      const allowed = allowMap.get(id);
      if (allowed && !allowed.has(childId)) continue;
    } else if (allowCol && row[allowCol] != null) {
      const allowed = childIdsFrom(row[allowCol]);
      if (allowed.length > 0 && !allowed.includes(childId)) continue;
    }

    const roomId = row.room_id != null ? String(row.room_id) : place?.roomId ?? null;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (room && !room.enabled) continue;
    const done = lastDone.get(id) ?? null;
    const claimRows = claimsByChore.get(id) ?? [];
    claimRows.sort((a, b) => b.at.localeCompare(a.at));
    const claim = claimRows.find((item) => item.childId === childId) ?? claimRows[0] ?? null;
    const view: HouseholdChoreView = {
      id,
      title: String(row.title),
      job,
      place_name: place?.name ?? null,
      target_type: targetType,
      tickets: choreTicketsNow(
        {
          base_tickets: asNumber(row.base_tickets) ?? 0,
          reset_days: asNumber(row.reset_days) ?? 0,
          target_type: targetType,
        },
        done?.at ?? null,
        targetType === "room" ? room?.area ?? null : null,
        now.getTime(),
      ),
      last_done_at: done?.at ?? null,
      last_done_by: nameOf(done?.childId ?? null),
      last_done_by_me: done?.childId === childId,
      claim: claim ? { child_id: claim.childId, name: nameOf(claim.childId) ?? claim.childId, mine: claim.childId === childId, held: claim.held } : null,
      kind: row.kind != null ? String(row.kind) : null,
      term_time: termTime,
    };
    if (room && roomId) {
      const bucket = grouped.get(roomId) ?? { id: roomId, name: room.name, floor: room.floor, chores: [] };
      bucket.chores.push(view);
      grouped.set(roomId, bucket);
    } else {
      loose.push(view);
    }
  }

  const roomsOut = [...grouped.values()].sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0) || a.name.localeCompare(b.name));
  for (const room of roomsOut) room.chores.sort((a, b) => (a.place_name ?? "").localeCompare(b.place_name ?? "") || a.title.localeCompare(b.title));
  if (loose.length) {
    loose.sort((a, b) => a.title.localeCompare(b.title));
    roomsOut.push({ id: "", name: "Around the house", floor: null, chores: loose });
  }
  return { ok: true, rooms: roomsOut.filter((room) => room.chores.length > 0) };
}

function apiPrefix(link: HouseholdLink): string {
  return (link.apiPrefix ?? "/api").replace(/\/$/, "");
}

export function householdActionUrl(link: HouseholdLink, choreId: string, action: "claim" | "complete" | "undo"): string {
  return `${link.url}${apiPrefix(link)}/kid/chores/${encodeURIComponent(choreId)}/${action}`;
}

export async function householdReachable(link: HouseholdLink): Promise<boolean> {
  if (!link.enabled || !link.url) return false;
  try {
    const response = await fetch(`${link.url}${apiPrefix(link)}/health`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export interface HouseholdCall {
  ok: boolean;
  down: boolean;
  status: number;
  error: string | null;
  body: unknown;
}

export async function callHousehold(
  link: HouseholdLink,
  action: "claim" | "complete" | "undo",
  choreId: string,
  childId: string,
  clientIp: string | null,
): Promise<HouseholdCall> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [HOUSEHOLD_CHILD_HEADER]: childId,
    };
    if (clientIp) headers["x-real-ip"] = clientIp;
    const response = await fetch(householdActionUrl(link, choreId, action), {
      method: "POST",
      headers,
      body: JSON.stringify({ child_id: childId }),
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : response.status === 404
          ? "Household has no way to do that from Tickets yet"
          : "Household couldn't do that";
      return { ok: false, down: response.status >= 500, status: response.status, error, body };
    }
    return { ok: true, down: false, status: response.status, error: null, body };
  } catch {
    return { ok: false, down: true, status: 503, error: "Household is not available", body: null };
  }
}

export async function handleHouseholdChores(
  db: pg.PoolClient,
  method: string,
  resourceId: string,
  childId: string,
  clientIp: string | null,
  link: HouseholdLink,
  log: (line: string) => void,
): Promise<{ status: number; body: unknown }> {
  const hidden = { status: 200, body: { enabled: false, rooms: [] as HouseholdRoomView[] } };
  if (!link.enabled || !link.url) return hidden;

  if (method === "GET" && resourceId === "household-chores") {
    if (!(await householdReachable(link))) {
      log("household chores hidden: household did not answer");
      return hidden;
    }
    try {
      const listed = await listHouseholdChores(db, childId);
      if (!listed.ok) {
        log(`household chores hidden: ${listed.reason}`);
        return hidden;
      }
      return { status: 200, body: { enabled: true, rooms: listed.rooms } };
    } catch (error) {
      log(`household chores hidden: ${(error as Error).message}`);
      return hidden;
    }
  }

  const match = /^household-chores\/([^/]+)\/(claim|complete|undo)$/.exec(resourceId);
  if (method !== "POST" || !match) return { status: 404, body: { error: "Not found" } };
  const choreId = decodeURIComponent(match[1]);
  const action = match[2] as "claim" | "complete" | "undo";
  if (!CHORE_ID.test(choreId)) return { status: 400, body: { error: "Unknown chore" } };

  if (!(await householdReachable(link))) {
    log("household chore action skipped: household did not answer");
    return hidden;
  }
  const result = await callHousehold(link, action, choreId, childId, clientIp);
  if (result.down) {
    log(`household chore action skipped: ${result.error}`);
    return hidden;
  }
  if (!result.ok) return { status: result.status, body: { error: result.error } };
  return { status: 200, body: { enabled: true, ok: true, result: result.body } };
}
