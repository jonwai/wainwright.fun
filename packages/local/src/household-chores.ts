/**
 * House chores in the Tickets kid app.
 *
 * Household (https://github.com/jonwai/household, main after PR #6) is the only
 * place chores are defined. Tickets does not read `household.*` and does not
 * calculate ticket values. The kid list, the badge, and claim / done / undo all
 * go to Household's HTTP API, which awards tickets in its own transaction.
 *
 * Kid identity is `core.people.id` in both apps. Tickets has already resolved
 * the viewer (a child's device, or a parent acting as a child) and sends that
 * id as `X-Household-Child`. GET also sends `?child=`, and POST sends
 * `{"child_id"}`. All three are the same id. Household trusts the header only
 * from the Docker bridge (172.16.0.0/12); the tickets container sends no token.
 *
 *   GET  {HOUSEHOLD_URL}/api/health
 *   GET  {HOUSEHOLD_URL}/api/kid/chores?child=<id>
 *   POST {HOUSEHOLD_URL}/api/kid/chores/{id}/claim|complete|undo
 *
 * Household main 06ce9a8 returns `{ child, now, rooms }`. `rooms[].chores` still
 * includes unclaimed chores this child could claim; those are left out. A chore
 * is in My chores when `claim.child_id` is this child (manual or auto-assigned),
 * including locked ones. `waiting_on` is a list of strings. Done is the latest
 * completion when `last_completed_by_me` and `last_completed_at` is within 24
 * hours of `now`.
 *
 * When Household adds them, `chores` (holds, plus `room_id` and `room_name`) and
 * `done_recently` (`chore_id`, `title`, `room_id`, `room_name`, `completed_at`,
 * `tickets`, `auto_done`, `can_undo`) replace those rules. Complete still posts
 * `{ child_id }`. Household may also take `product_slug` or `consumable_na`;
 * Tickets has no consumable picker, so it does not send those.
 *
 * Off unless HOUSEHOLD_CHORES=1 and HOUSEHOLD_URL is set. If Household does not
 * answer, the section is hidden and the jobs list is unchanged.
 */
export const HOUSEHOLD_CHILD_HEADER = "x-household-child";

export interface HouseholdLink {
  /** House chores are shown only when this is true and `url` is set. */
  enabled: boolean;
  /** Household base URL, no trailing slash. e.g. http://household:43126 */
  url: string;
}

export function householdLinkFromEnv(env: NodeJS.ProcessEnv = process.env): HouseholdLink {
  const url = (env.HOUSEHOLD_URL ?? "").trim().replace(/\/$/, "");
  return { enabled: env.HOUSEHOLD_CHORES === "1" && url.length > 0, url };
}

const CHORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

export interface HouseholdClaim {
  child_id: string;
  name: string;
  mine: boolean;
  auto_assigned: boolean;
}

/** One chore as Household's kid list describes it, plus `held_by_me` for the button. */
export interface HouseholdChoreView {
  id: string;
  title: string;
  job: string | null;
  chore_kind: string;
  target_type: string;
  target_id: string | null;
  place_name: string | null;
  tickets: number;
  term_time_only: boolean;
  due_today: boolean;
  allowed_claimers: string[];
  claim: HouseholdClaim | null;
  held: boolean;
  held_by: string | null;
  held_by_me: boolean;
  last_completed_at: string | null;
  last_completed_by: string | null;
  last_completed_by_me: boolean;
  can_undo: boolean;
  /** Home Assistant area name, when Household sent one. */
  room_name: string | null;
  /** Set when this chore is assigned to the child but blocked. */
  locked: boolean;
  /** `waiting_on` strings joined for display. Null when the list is empty. */
  waiting_on: string | null;
  /** This child holds the chore, including an auto-assignment. */
  assigned_to_me: boolean;
  /** Household assigned it without the child claiming it by hand. */
  auto_assigned: boolean;
  auto_done: boolean;
}

export interface HouseholdRoomView {
  id: string;
  name: string;
  floor: number | null;
  chores: HouseholdChoreView[];
}

interface ChildRef {
  id: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function heldBy(value: unknown, child: ChildRef): { name: string | null; mine: boolean } {
  if (typeof value === "string") {
    const name = value.trim();
    return { name: name || null, mine: name === child.id || name === child.name };
  }
  const record = asRecord(value);
  if (!record) return { name: null, mine: false };
  const id = asString(record.child_id);
  const name = asString(record.name) ?? id;
  return { name, mine: id === child.id || name === child.name || record.mine === true };
}

const RECENT_MS = 24 * 60 * 60 * 1000;

/** Household's `waiting_on` is a list of strings. Anything else is ignored. */
function waitingJoined(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseClaim(value: unknown, child: ChildRef): HouseholdClaim | null {
  const record = asRecord(value);
  const claimId = asString(record?.child_id);
  if (!record || !claimId) return null;
  return {
    child_id: claimId,
    name: asString(record.name) ?? claimId,
    mine: record.mine === true || claimId === child.id,
    auto_assigned: record.auto_assigned === true,
  };
}

function blankChore(fields: Pick<HouseholdChoreView, "id" | "title"> & Partial<HouseholdChoreView>): HouseholdChoreView {
  return {
    job: null,
    chore_kind: "job",
    target_type: "room",
    target_id: null,
    place_name: null,
    tickets: 0,
    term_time_only: false,
    due_today: false,
    allowed_claimers: [],
    claim: null,
    held: false,
    held_by: null,
    held_by_me: false,
    last_completed_at: null,
    last_completed_by: null,
    last_completed_by_me: false,
    can_undo: false,
    room_name: null,
    locked: false,
    waiting_on: null,
    assigned_to_me: false,
    auto_assigned: false,
    auto_done: false,
    ...fields,
  };
}

function parseKidChore(entry: unknown, child: ChildRef, fallbackRoom: string | null): HouseholdChoreView | null {
  const chore = asRecord(entry);
  const id = asString(chore?.id);
  const title = asString(chore?.title);
  if (!chore || !id || !title) return null;
  const claim = parseClaim(chore.claim, child);
  const holder = heldBy(chore.held_by, child);
  const tickets = Number(chore.tickets);
  const heldByMe = chore.held === true && holder.mine;
  const autoAssigned = chore.auto_assigned === true || claim?.auto_assigned === true;
  return blankChore({
    id,
    title,
    job: asString(chore.job),
    chore_kind: asString(chore.chore_kind) ?? "job",
    target_type: asString(chore.target_type) ?? "room",
    target_id: asString(chore.target_id),
    place_name: asString(chore.place_name),
    tickets: Number.isFinite(tickets) ? tickets : 0,
    term_time_only: chore.term_time_only === true,
    due_today: chore.due_today === true,
    allowed_claimers: Array.isArray(chore.allowed_claimers) ? chore.allowed_claimers.map(String) : [],
    claim,
    held: chore.held === true,
    held_by: holder.name,
    held_by_me: heldByMe,
    last_completed_at: asString(chore.last_completed_at),
    last_completed_by: asString(chore.last_completed_by),
    last_completed_by_me: chore.last_completed_by_me === true,
    can_undo: chore.can_undo === true,
    room_name: asString(chore.room_name) ?? fallbackRoom,
    locked: chore.locked === true,
    waiting_on: waitingJoined(chore.waiting_on),
    assigned_to_me: claim?.child_id === child.id || autoAssigned,
    auto_assigned: autoAssigned,
    auto_done: chore.auto_done === true,
  });
}

/** Planned `done_recently` rows use `chore_id` and `completed_at`, not a full KidChore. */
function parseDoneRecently(entry: unknown): HouseholdChoreView | null {
  const row = asRecord(entry);
  const id = asString(row?.chore_id);
  const title = asString(row?.title);
  if (!row || !id || !title) return null;
  const tickets = Number(row.tickets);
  return blankChore({
    id,
    title,
    tickets: Number.isFinite(tickets) ? tickets : 0,
    room_name: asString(row.room_name),
    target_id: asString(row.room_id),
    last_completed_at: asString(row.completed_at),
    last_completed_by_me: true,
    can_undo: row.can_undo === true,
    auto_done: row.auto_done === true,
  });
}

function clockMs(body: Record<string, unknown>): number {
  const parsed = Date.parse(asString(body.now) ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function finishedWithinADay(chore: HouseholdChoreView, now: number): boolean {
  if (!chore.last_completed_by_me || !chore.last_completed_at) return false;
  const at = Date.parse(chore.last_completed_at);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age <= RECENT_MS;
}

function flattenRooms(rooms: unknown[], child: ChildRef): HouseholdChoreView[] {
  const chores: HouseholdChoreView[] = [];
  for (const item of rooms) {
    const room = asRecord(item);
    if (!room || !Array.isArray(room.chores)) continue;
    const name = asString(room.name);
    for (const entry of room.chores) {
      const chore = parseKidChore(entry, child, name);
      if (chore) chores.push(chore);
    }
  }
  return chores;
}

/**
 * Turns Household's GET /api/kid/chores body into this child's chores.
 * `tickets` is copied through; Tickets does not recompute it.
 * Returns null when the body has neither `rooms`, `chores`, nor `done_recently`.
 */
export function normalizeHouseholdList(
  payload: unknown,
  childId: string,
): { chores: HouseholdChoreView[]; done_recently: HouseholdChoreView[] } | null {
  const body = asRecord(payload);
  if (!body) return null;
  const hasChores = Array.isArray(body.chores);
  const hasDone = Array.isArray(body.done_recently);
  const hasRooms = Array.isArray(body.rooms);
  if (!hasChores && !hasDone && !hasRooms) return null;

  const childRecord = asRecord(body.child);
  const child: ChildRef = {
    id: asString(childRecord?.id) ?? childId,
    name: asString(childRecord?.name) ?? childId,
  };
  const roomChores = hasRooms ? flattenRooms(body.rooms as unknown[], child) : [];
  const chores = hasChores
    ? (body.chores as unknown[]).flatMap((entry) => {
        const chore = parseKidChore(entry, child, null);
        return chore ? [{ ...chore, assigned_to_me: true }] : [];
      })
    : roomChores.filter((chore) => chore.claim?.child_id === child.id);
  const heldIds = new Set(chores.map((chore) => chore.id));

  const done = hasDone
    ? (body.done_recently as unknown[]).flatMap((entry) => {
        const chore = parseDoneRecently(entry);
        return chore && !heldIds.has(chore.id) ? [chore] : [];
      })
    : dedupe(roomChores.filter((chore) => !heldIds.has(chore.id) && finishedWithinADay(chore, clockMs(body))));
  return { chores, done_recently: done };
}

function dedupe(chores: HouseholdChoreView[]): HouseholdChoreView[] {
  const seen = new Set<string>();
  return chores.filter((chore) => {
    if (seen.has(chore.id)) return false;
    seen.add(chore.id);
    return true;
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({}));
  return asRecord(value) ?? {};
}

export async function householdUp(link: HouseholdLink): Promise<boolean> {
  if (!link.enabled || !link.url) return false;
  try {
    const response = await fetch(`${link.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await readJson(response);
    return body.ok === true;
  } catch {
    return false;
  }
}

function childHeaders(childId: string): Record<string, string> {
  return { [HOUSEHOLD_CHILD_HEADER]: childId, accept: "application/json" };
}

export async function fetchHouseholdList(
  link: HouseholdLink,
  childId: string,
): Promise<{ ok: true; chores: HouseholdChoreView[]; done_recently: HouseholdChoreView[] } | { ok: false; down: boolean; reason: string }> {
  try {
    const url = new URL("/api/kid/chores", link.url);
    url.searchParams.set("child", childId);
    const response = await fetch(url, { headers: childHeaders(childId), signal: AbortSignal.timeout(4000) });
    const body = await readJson(response);
    if (!response.ok) {
      return { ok: false, down: response.status >= 500, reason: asString(body.error) ?? `household list ${response.status}` };
    }
    const listed = normalizeHouseholdList(body, childId);
    if (!listed) return { ok: false, down: false, reason: "household list was not the kid chores payload" };
    return { ok: true, chores: listed.chores, done_recently: listed.done_recently };
  } catch {
    return { ok: false, down: true, reason: "household did not answer" };
  }
}

export async function callHousehold(
  link: HouseholdLink,
  action: "claim" | "complete" | "undo",
  choreId: string,
  childId: string,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; down: boolean; status: number; error: string }> {
  try {
    const response = await fetch(`${link.url}/api/kid/chores/${encodeURIComponent(choreId)}/${action}`, {
      method: "POST",
      headers: { ...childHeaders(childId), "content-type": "application/json" },
      body: JSON.stringify({ child_id: childId }),
      signal: AbortSignal.timeout(4000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      return {
        ok: false,
        down: response.status >= 500,
        status: response.status,
        error: asString(body.error) ?? "Household couldn't do that",
      };
    }
    return { ok: true, status: response.status, body };
  } catch {
    return { ok: false, down: true, status: 503, error: "Household is not available" };
  }
}

export async function handleHouseholdChores(
  method: string,
  resourceId: string,
  childId: string,
  link: HouseholdLink,
  log: (line: string) => void,
): Promise<{ status: number; body: unknown }> {
  const hidden = { status: 200, body: { enabled: false, chores: [] as HouseholdChoreView[], done_recently: [] as HouseholdChoreView[] } };
  if (!link.enabled || !link.url) return hidden;

  if (method === "GET" && resourceId === "household-chores") {
    if (!(await householdUp(link))) {
      log("household chores hidden: household did not answer");
      return hidden;
    }
    const listed = await fetchHouseholdList(link, childId);
    if (!listed.ok) {
      log(`household chores hidden: ${listed.reason}`);
      return hidden;
    }
    return { status: 200, body: { enabled: true, chores: listed.chores, done_recently: listed.done_recently } };
  }

  const match = /^household-chores\/([^/]+)\/(claim|complete|undo)$/.exec(resourceId);
  if (method !== "POST" || !match) return { status: 404, body: { error: "Not found" } };
  const choreId = decodeURIComponent(match[1]);
  const action = match[2] as "claim" | "complete" | "undo";
  if (!CHORE_ID.test(choreId)) return { status: 400, body: { error: "Unknown chore" } };

  const result = await callHousehold(link, action, choreId, childId);
  if (!result.ok && result.down) {
    log(`household chore action skipped: ${result.error}`);
    return hidden;
  }
  if (!result.ok) return { status: result.status, body: { error: result.error } };
  const tickets = Number(result.body.tickets);
  return {
    status: 200,
    body: {
      enabled: true,
      ok: true,
      ...(Number.isFinite(tickets) ? { tickets } : {}),
      result: result.body,
    },
  };
}
