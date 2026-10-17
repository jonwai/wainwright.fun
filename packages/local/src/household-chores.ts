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

/**
 * Turns Household's GET /api/kid/chores body into the kid-UI list.
 * `tickets` is copied through; Tickets does not recompute it.
 * Returns null when the body is not that list.
 */
export function normalizeHouseholdList(payload: unknown, childId: string): { rooms: HouseholdRoomView[] } | null {
  const body = asRecord(payload);
  if (!body || !Array.isArray(body.rooms)) return null;
  const childRecord = asRecord(body.child);
  const child: ChildRef = {
    id: asString(childRecord?.id) ?? childId,
    name: asString(childRecord?.name) ?? childId,
  };
  const rooms: HouseholdRoomView[] = [];
  for (const item of body.rooms) {
    const room = asRecord(item);
    if (!room || !Array.isArray(room.chores)) continue;
    const chores: HouseholdChoreView[] = [];
    for (const entry of room.chores) {
      const chore = asRecord(entry);
      const id = asString(chore?.id);
      const title = asString(chore?.title);
      if (!chore || !id || !title) continue;
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
      chores.push({
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
        held_by_me: chore.held === true && holder.mine,
        last_completed_at: asString(chore.last_completed_at),
        last_completed_by: asString(chore.last_completed_by),
        last_completed_by_me: chore.last_completed_by_me === true,
        can_undo: chore.can_undo === true,
      });
    }
    rooms.push({
      id: asString(room.id) ?? "",
      name: asString(room.name) ?? "Room",
      floor: Number.isFinite(Number(room.floor)) ? Number(room.floor) : null,
      chores,
    });
  }
  return { rooms: rooms.filter((room) => room.chores.length > 0) };
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
): Promise<{ ok: true; rooms: HouseholdRoomView[] } | { ok: false; down: boolean; reason: string }> {
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
    return { ok: true, rooms: listed.rooms };
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
  const hidden = { status: 200, body: { enabled: false, rooms: [] as HouseholdRoomView[] } };
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
    return { status: 200, body: { enabled: true, rooms: listed.rooms } };
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
