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
 * The kid list is only chores claimed by or assigned to this child, plus a
 * done-recently list. Household may still send the older room catalog; those
 * unclaimed chores are dropped here. A locked chore carries `waiting_on`.
 * Assignment itself stays in Household. The Tickets app does not offer claim.
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
  /** What a locked chore is waiting on, already a short label. */
  waiting_on: string | null;
  /** Claimed, held, or flagged assigned for this child. */
  assigned_to_me: boolean;
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

function waitingLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return null;
  if (Array.isArray(value)) {
    const parts = value.map(waitingLabel).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const direct = asString(record.title) ?? asString(record.name) ?? asString(record.label) ?? asString(record.reason);
  if (direct) return direct;
  return waitingLabel(record.chore ?? record.task ?? record.waiting_on);
}

function roomNameOf(chore: Record<string, unknown>, fallback: string | null): string | null {
  const direct = asString(chore.room_name) ?? asString(chore.roomName);
  if (direct) return direct;
  const room = asRecord(chore.room);
  return asString(room?.name) ?? fallback;
}

function parseChore(entry: unknown, child: ChildRef, fallbackRoom: string | null): ParsedChore | null {
  const chore = asRecord(entry);
  const id = asString(chore?.id);
  const title = asString(chore?.title);
  if (!chore || !id || !title) return null;
  const claimRecord = asRecord(chore.claim);
  const claimId = asString(claimRecord?.child_id);
  const claim: HouseholdClaim | null = claimRecord && claimId
    ? {
        child_id: claimId,
        name: asString(claimRecord.name) ?? claimId,
        mine: claimRecord.mine === true || claimId === child.id,
      }
    : null;
  const holder = heldBy(chore.held_by, child);
  const tickets = Number(chore.tickets);
  const waiting = waitingLabel(chore.waiting_on ?? chore.waitingOn);
  const assignedFlag = chore.assigned === true || chore.assigned_to_me === true || chore.auto_assigned === true;
  const locked = chore.can_undo !== true && (chore.locked === true || chore.waiting === true || chore.status === "locked" || chore.status === "waiting" || waiting !== null);
  const heldByMe = chore.held === true && holder.mine;
  const someoneElse = claim !== null && !claim.mine && !heldByMe && !assignedFlag && !locked;
  return {
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
    room_name: roomNameOf(chore, fallbackRoom),
    locked,
    waiting_on: waiting,
    assigned_to_me: claim?.mine === true || heldByMe || assignedFlag,
    forChild: !someoneElse && (claim?.mine === true || heldByMe || assignedFlag || locked || chore.can_undo === true),
  };
}

interface ParsedChore extends HouseholdChoreView {
  /** True when this child claimed it, holds it, is assigned it, or it is locked for them. */
  forChild: boolean;
}

/**
 * Turns Household's GET /api/kid/chores body into this child's chores.
 * `tickets` is copied through; Tickets does not recompute it.
 *
 * A `chores` array is the current kid list (claimed and auto-assigned only).
 * Older payloads send every visible chore under `rooms`; unclaimed ones are dropped.
 * `done_recently` (or `doneRecently`) is the completed section.
 * Returns null when the body is neither shape.
 */
export function normalizeHouseholdList(
  payload: unknown,
  childId: string,
): { chores: HouseholdChoreView[]; done_recently: HouseholdChoreView[] } | null {
  const body = asRecord(payload);
  if (!body) return null;
  const doneSource = Array.isArray(body.done_recently) ? body.done_recently : Array.isArray(body.doneRecently) ? body.doneRecently : null;
  const assignedSource = Array.isArray(body.chores) ? body.chores : null;
  const hasRooms = Array.isArray(body.rooms);
  if (!hasRooms && !assignedSource && !doneSource) return null;

  const childRecord = asRecord(body.child);
  const child: ChildRef = {
    id: asString(childRecord?.id) ?? childId,
    name: asString(childRecord?.name) ?? childId,
  };

  const incoming: ParsedChore[] = [];
  if (assignedSource) {
    for (const entry of assignedSource) {
      const chore = parseChore(entry, child, null);
      if (!chore) continue;
      // This array is already this child's list. Keep it unless it is clearly someone else's claim.
      const someoneElse = chore.claim !== null && !chore.claim.mine && !chore.held_by_me && !chore.assigned_to_me && !chore.locked;
      if (!someoneElse) incoming.push({ ...chore, forChild: true });
    }
  } else if (hasRooms) {
    for (const item of body.rooms as unknown[]) {
      const room = asRecord(item);
      if (!room || !Array.isArray(room.chores)) continue;
      const name = asString(room.name);
      for (const entry of room.chores) {
        const chore = parseChore(entry, child, name);
        if (chore?.forChild) incoming.push(chore);
      }
    }
  }

  const done: HouseholdChoreView[] = [];
  const doneIds = new Set<string>();
  const pushDone = (chore: ParsedChore) => {
    if (doneIds.has(chore.id)) return;
    doneIds.add(chore.id);
    done.push(strip(chore));
  };
  if (doneSource) {
    for (const entry of doneSource) {
      const chore = parseChore(entry, child, null);
      if (chore) pushDone(chore);
    }
  }
  const chores: HouseholdChoreView[] = [];
  for (const chore of incoming) {
    if (doneIds.has(chore.id) || chore.can_undo) pushDone(chore);
    else chores.push(strip(chore));
  }
  return { chores, done_recently: done };
}

function strip(chore: ParsedChore): HouseholdChoreView {
  const { forChild, ...view } = chore;
  void forChild;
  return view;
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
