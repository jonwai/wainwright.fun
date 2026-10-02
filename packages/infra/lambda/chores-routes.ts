/**
 * Chore routes for wainwright.fun — the Chores app.
 *
 * The house (synced with the twin model) is modelled as rooms, fixtures
 * windows and light switches/sensors. Each chore row references a target
 * (room / fixture / window / switch) and a job template (vacuum, mop, dust,
 * clean, empty, fill…). Chores are NOT claimed per-child in this table —
 * a child CLAIMS a chore, which materialises it as a real task row
 * (task_id `chores#{chore_id}#{child}`) in wainwright-tasks, audience-locked
 * to that child, so it appears in the Tickets app and completes/undoes/history
 * work there with no changes to task-routes.
 *
 * Tables:
 *   - wainwright-chores-rooms (PK room_id): the rooms of the house —
 *     name, floor, area_m2 (drives ticket scaling), carpeted (bool),
 *     enabled. IDs match the twin model's room ids.
 *   - wainwright-chores-fixtures (PK fixture_id): furniture items that
 *     carry jobs (toilet, sink, dishwasher…). room_id links them to a room.
 *   - wainwright-chores-windows (PK window_id): windows, room_id linked.
 *   - wainwright-chores-switches (PK switch_id): light switches/sensors,
 *     room_id linked, battery_dead (bool — set from the Hue app; only
 *     true shows the battery chore).
 *   - wainwright-chores (PK chore_id): one row per chore:
 *       target_type: "room" | "fixture" | "window" | "switch"
 *       target_id: the target row's id
 *       job: the job template id (see JOBS below)
 *       title: kid-facing title
 *       base_tickets: tickets at the reset interval (before size scaling)
 *       reset_days: how often the chore "resets" (tickets regrow to base)
 *       enabled
 *     Tickets RIGHT NOW = round(base_tickets × size_factor × elapsed/reset_days),
 *     clamped to base_tickets × 2 (so a long-neglected chore is worth
 *     double, not infinity). size_factor is 1 for non-room targets and
 *     area/10 (clamped 0.5–2) for rooms. 0 tickets = not worth doing yet.
 *
 * Kid routes (device token):
 *   GET  /kid/chores                       → rooms with their chores + live tickets
 *   POST /kid/chores/{choreId}/claim      → claim (creates the Tickets task)
 *   GET  /kid/chores/mine                  → my claimed chores + done state
 *   POST /kid/chores/{choreId}/complete  → mark my claim done (earns tickets)
 *   POST /kid/chores/{choreId}/undo        → undo my latest completion
 *
 * Claiming writes BOTH a task row and a chore-claim row:
 *   - wainwright-chore-claims (PK child_subdomain,
 *     SK `${chore_id}#${claimed_at}`): one item per claim, with the
 *     materialised task_id. Completing the chore completes that task row
 *     via the shared completion log (tickets flow to the child's account
 *     exactly like a Tickets-app job). Undo removes the newest completion.
 *     A chore can be re-claimed after completion (a fresh task row).
 *
 * Admin routes (Cognito):
 *   GET    /chores/rooms | /chores/fixtures | /chores/windows |
 *          /chores/switches | /chores | /chores/claims
 *   PUT    /chores/rooms/{roomId} etc.      → create/update a row
 *   DELETE /chores/rooms/{roomId} etc.      → delete a row
 *   POST   /chores/switches/{switchId}/battery → set battery_dead
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { json, parseBody, type APIGatewayEvent, type APIResponse } from "./http.js";
import { extractDeviceToken, getDevice, getPreviewChild } from "./kid-routes.js";

const ROOMS_TABLE = process.env.CHORES_ROOMS_TABLE!;
const FIXTURES_TABLE = process.env.CHORES_FIXTURES_TABLE!;
const WINDOWS_TABLE = process.env.CHORES_WINDOWS_TABLE!;
const SWITCHES_TABLE = process.env.CHORES_SWITCHES_TABLE!;
const CHORES_TABLE = process.env.CHORES_TABLE!;
const CLAIMS_TABLE = process.env.CHORES_CLAIMS_TABLE!;
const TASKS_TABLE = process.env.TASKS_TABLE!;
const TASK_COMPLETIONS_TABLE = process.env.TASK_COMPLETIONS_TABLE!;

// ── Types ──────────────────────────────────────────────────────────────
export interface ChoreRoomRow {
  room_id: string;
  name: string;
  floor: number;
  /** Floor area in m² — drives the size factor for room chores. */
  area_m2: number;
  /** Carpeted rooms get "vacuum", others get "sweep/mop". */
  carpeted: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChoreFixtureRow {
  fixture_id: string;
  room_id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChoreWindowRow {
  window_id: string;
  room_id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChoreSwitchRow {
  switch_id: string;
  room_id: string;
  name: string;
  /** Set from the Hue app — dead battery shows the battery chore. */
  battery_dead: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ChoreTargetType = "room" | "fixture" | "window" | "switch";

export interface ChoreRow {
  chore_id: string;
  target_type: ChoreTargetType;
  target_id: string;
  /** Job template id (vacuum, mop, dust, clean, empty, fill…). */
  job: string;
  title: string;
  /** Tickets at the reset interval, before size scaling. */
  base_tickets: number;
  /** Tickets regrow to base over this many days. */
  reset_days: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChoreClaimRow {
  child_subdomain: string;
  /** `${chore_id}#${claimed_at}` — sort key. */
  chore_claim: string;
  chore_id: string;
  /** The materialised Tickets-app task row id. */
  task_id: string;
  claimed_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────
async function scanTable<T>(
  ddb: DynamoDBDocumentClient,
  tableName: string
): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as T[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getRow<T>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, unknown>
): Promise<T | null> {
  const response = await ddb.send(new GetCommand({ TableName: tableName, Key: key }));
  return (response.Item as T) ?? null;
}

/** All rooms sorted by floor then name for stable display. */
async function listRooms(ddb: DynamoDBDocumentClient): Promise<ChoreRoomRow[]> {
  const rooms = await scanTable<ChoreRoomRow>(ddb, ROOMS_TABLE);
  rooms.sort((a, b) => a.floor - b.floor || a.name.localeCompare(b.name));
  return rooms;
}

/** Size factor for a chore: rooms scale by area (0.5×–2×), others 1×. */
function sizeFactor(chore: ChoreRow, room?: ChoreRoomRow): number {
  if (chore.target_type !== "room" || !room) return 1;
  return Math.min(2, Math.max(0.5, room.area_m2 / 10));
}

/**
 * Live ticket value of a chore right now: base × size × elapsed fraction
 * of the reset interval, rounded to a whole number (0 = not worth
 * doing yet), clamped at 2× base.
 */
export function choreTicketsNow(
  chore: ChoreRow,
  lastDoneAt: string | null,
  room?: ChoreRoomRow
): number {
  const base = Math.round(chore.base_tickets * sizeFactor(chore, room));
  if (!lastDoneAt) return base;
  const elapsedDays =
    (Date.now() - new Date(lastDoneAt).getTime()) / 86_400_000;
  const grown = Math.floor((elapsedDays / chore.reset_days) * base);
  return Math.min(base * 2, grown);
}

/** The newest completion timestamp for a chore across ALL children —
 * the "done since" anchor for ticket regrowth. */
async function lastChoreCompletion(
  ddb: DynamoDBDocumentClient,
  choreId: string
): Promise<string | null> {
  // Chore completions are recorded on the materialised task rows, whose
  // ids all start with `chores#{chore_id}#`. Scan the completion log
  // per child is not possible here (no child context), so we scan the
  // tasks table for this chore's task rows and query each child's log.
  // Simpler and correct: scan ALL completions once and filter by prefix.
  const completions = await scanTable<{
    child_subdomain: string;
    task_completion: string;
    task_id: string;
    completed_at: string;
  }>(ddb, TASK_COMPLETIONS_TABLE);
  let latest: string | null = null;
  const prefix = `chores#${choreId}#`;
  for (const c of completions) {
    if (!c.task_id.startsWith(prefix)) continue;
    if (!latest || c.completed_at > latest) latest = c.completed_at;
  }
  return latest;
}

// ── Kid auth (same as task-routes) ────────────────────────────
type KidAuth = { subdomain: string } | APIResponse;
function isKidDenied(value: KidAuth): value is APIResponse {
  return "statusCode" in value;
}

async function resolveKid(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<KidAuth> {
  const token = await extractDeviceToken(event, ddb);
  if (!token) return json(event, 401, { error: "Missing device token" });
  const device = await getDevice(ddb, token);
  if (device) return { subdomain: String(device.child_subdomain) };
  const previewSubdomain = await getPreviewChild(ddb, token);
  if (previewSubdomain) return { subdomain: previewSubdomain };
  return json(event, 401, { error: "Unknown or revoked device" });
}

// ── Kid routes ─────────────────────────────────────────────────────────
/** The task_id a claim of `choreId` by `child` materialises. */
export function choreTaskId(choreId: string, child: string): string {
  return `chores#${choreId}#${child}`;
}

async function handleKidChores(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;
  const [rooms, fixtures, windows, switches, chores, claims] = await Promise.all([
    listRooms(ddb),
    scanTable<ChoreFixtureRow>(ddb, FIXTURES_TABLE),
    scanTable<ChoreWindowRow>(ddb, WINDOWS_TABLE),
    scanTable<ChoreSwitchRow>(ddb, SWITCHES_TABLE),
    scanTable<ChoreRow>(ddb, CHORES_TABLE),
    claimsForChild(ddb, auth.subdomain),
  ]);
  const roomById = new Map(rooms.map((r) => [r.room_id, r]));
  const fixtureById = new Map(fixtures.map((f) => [f.fixture_id, f]));
  const windowById = new Map(windows.map((w) => [w.window_id, w]));
  const switchById = new Map(switches.map((s) => [s.switch_id, s]));
  const claimedChoreIds = new Set(claims.map((c) => c.chore_id));

  // One completion timestamp per chore (newest across children) — the
  // ticket-regrowth anchor. Batched: a single pass over the log.
  const completions = await scanTable<{
    task_id: string;
    completed_at: string;
  }>(ddb, TASK_COMPLETIONS_TABLE);
  const lastDone = new Map<string, string>();
  for (const c of completions) {
    const m = c.task_id.match(/^chores#([^#]+)#/);
    if (!m) continue;
    const prev = lastDone.get(m[1]);
    if (!prev || c.completed_at > prev) lastDone.set(m[1], c.completed_at);
  }

  const choresByRoom = new Map<string, unknown[]>();
  const unassigned: unknown[] = [];
  for (const chore of chores) {
    if (!chore.enabled) continue;
    // Battery chores only appear once the battery is actually dead.
    if (chore.job === "batteries") {
      const sw = switchById.get(chore.target_id);
      if (!sw?.battery_dead) continue;
    }
    const room =
      chore.target_type === "room"
        ? roomById.get(chore.target_id)
        : roomById.get(
            String(
              chore.target_type === "fixture"
                ? fixtureById.get(chore.target_id)?.room_id
                : chore.target_type === "window"
                  ? windowById.get(chore.target_id)?.room_id
                  : switchById.get(chore.target_id)?.room_id ?? ""
            )
          ) ?? undefined;
    const entry = {
      chore_id: chore.chore_id,
      target_type: chore.target_type,
      target_id: chore.target_id,
      room_id: chore.target_type === "room" ? chore.target_id : room?.room_id ?? null,
      title: chore.title,
      job: chore.job,
      tickets: choreTicketsNow(chore, lastDone.get(chore.chore_id) ?? null, room),
      base_tickets: chore.base_tickets,
      reset_days: chore.reset_days,
      claimed: claimedChoreIds.has(chore.chore_id),
    };
    if (room) {
      const list = choresByRoom.get(room.room_id) ?? [];
      list.push(entry);
      choresByRoom.set(room.room_id, list);
    } else {
      unassigned.push(entry);
    }
  }

  return json(event, 200, {
    rooms: rooms
      .filter((r) => r.enabled)
      .map((r) => ({
        room_id: r.room_id,
        name: r.name,
        floor: r.floor,
        carpeted: r.carpeted,
        chores: choresByRoom.get(r.room_id) ?? [],
      })),
    mine: claims.map((c) => {
      const chore = chores.find((x) => x.chore_id === c.chore_id);
      return {
        chore_id: c.chore_id,
        task_id: c.task_id,
        title: chore?.title ?? c.chore_id,
        claimed_at: c.claimed_at,
      };
    }),
  });
}

async function claimsForChild(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string
): Promise<ChoreClaimRow[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: CLAIMS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      ExpressionAttributeValues: { ":child": childSubdomain },
      ScanIndexForward: false,
    })
  );
  return (response.Items ?? []) as ChoreClaimRow[];
}

async function handleKidClaim(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  choreId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;
  const chore = await getRow<ChoreRow>(ddb, CHORES_TABLE, { chore_id: choreId });
  if (!chore || !chore.enabled) {
    return json(event, 404, { error: "That chore isn't available any more" });
  }
  // One live claim per chore per child: re-claiming an open claim is a no-op.
  const existing = (await claimsForChild(ddb, auth.subdomain)).find(
    (c) => c.chore_id === choreId
  );
  const taskId = choreTaskId(choreId, auth.subdomain);
  if (existing) {
    return json(event, 200, { task_id: existing.task_id, already: true });
  }

  const claimedAt = new Date().toISOString();
  // Live ticket value at claim time — completing from EITHER app earns this.
  const room =
    chore.target_type === "room"
      ? ((await getRow<ChoreRoomRow>(ddb, ROOMS_TABLE, { room_id: chore.target_id })) ?? undefined)
      : undefined;
  const tickets = choreTicketsNow(chore, await lastChoreCompletion(ddb, choreId), room);
  // 1. The claim row (this app's record).
  await ddb.send(
    new PutCommand({
      TableName: CLAIMS_TABLE,
      Item: {
        child_subdomain: auth.subdomain,
        chore_claim: `${choreId}#${claimedAt}`,
        chore_id: choreId,
        task_id: taskId,
        claimed_at: claimedAt,
        tickets,
      },
    })
  );
  // 2. The materialised Tickets-app task row, audience-locked to this child.
  await ddb.send(
    new PutCommand({
      TableName: TASKS_TABLE,
      Item: {
        task_id: taskId,
        title: chore.title,
        description: null,
        ticket_reward: tickets,
        assigned_to: [auth.subdomain],
        icon: null,
        emoji: null,
        enabled: true,
        created_at: claimedAt,
        updated_at: claimedAt,
      },
    })
  );
  return json(event, 200, { task_id: taskId, chore_id: choreId, tickets });
}

async function handleKidMine(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;
  const [claims, chores] = await Promise.all([
    claimsForChild(ddb, auth.subdomain),
    scanTable<ChoreRow>(ddb, CHORES_TABLE),
  ]);
  const choreById = new Map(chores.map((c) => [c.chore_id, c]));

  // Done state: the child's newest completion of the materialised task.
  const completions = await scanTable<{
    child_subdomain: string;
    task_completion: string;
    task_id: string;
    completed_at: string;
    tickets: number;
  }>(ddb, TASK_COMPLETIONS_TABLE);
  const mine: unknown[] = [];
  for (const claim of claims) {
    const chore = choreById.get(claim.chore_id);
    if (!chore || !chore.enabled) continue;
    const events = completions
      .filter(
        (c) =>
          c.child_subdomain === auth.subdomain && c.task_id === claim.task_id
      )
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
    const latest = events[0] ?? null;
    mine.push({
      chore_id: claim.chore_id,
      task_id: claim.task_id,
      title: chore.title,
      claimed_at: claim.claimed_at,
      done: latest !== null,
      completed_at: latest?.completed_at ?? null,
    });
  }
  return json(event, 200, { mine });
}

async function handleKidComplete(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  choreId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;
  const claims = await claimsForChild(ddb, auth.subdomain);
  const claim = claims.find((c) => c.chore_id === choreId);
  if (!claim) {
    return json(event, 404, { error: "Claim that chore first" });
  }
  // Tickets RIGHT NOW — the reward for this completion.
  const chore = await getRow<ChoreRow>(ddb, CHORES_TABLE, { chore_id: choreId });
  if (!chore || !chore.enabled) {
    return json(event, 404, { error: "That chore isn't available any more" });
  }
  const room =
    chore.target_type === "room"
      ? ((await getRow<ChoreRoomRow>(ddb, ROOMS_TABLE, { room_id: chore.target_id })) ?? undefined)
      : undefined;
  const lastDone = await lastChoreCompletion(ddb, choreId);
  const tickets = choreTicketsNow(chore, lastDone, room);

  const completedAt = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: TASK_COMPLETIONS_TABLE,
      Item: {
        child_subdomain: auth.subdomain,
        task_completion: `${claim.task_id}#${completedAt}#${Math.random().toString(36).slice(2, 8)}`,
        task_id: claim.task_id,
        completed_at: completedAt,
        completed_by: "child",
        tickets,
      },
    })
  );
  // Remove the claim (the chore is done; it can be re-claimed later).
  await ddb.send(
    new DeleteCommand({
      TableName: CLAIMS_TABLE,
      Key: {
        child_subdomain: auth.subdomain,
        chore_claim: claim.chore_claim,
      },
    })
  );
  const all = await scanTable<{ tickets: number; child_subdomain: string }>(
    ddb,
    TASK_COMPLETIONS_TABLE
  );
  const totalTickets = all
    .filter((c) => c.child_subdomain === auth.subdomain)
    .reduce((sum, c) => sum + c.tickets, 0);
  return json(event, 200, {
    completion: {
      chore_id: choreId,
      task_id: claim.task_id,
      title: chore.title,
      completed_at: completedAt,
      completed_by: "child",
      tickets,
    },
    total_tickets: totalTickets,
  });
}

async function handleKidUndo(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  choreId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;
  // Undo works off the completion log, not the claim: a completion from the
  // Tickets app (or one already finished here) has no live claim row.
  const taskId = choreTaskId(choreId, auth.subdomain);
  const completions = (
    await ddb.send(
      new QueryCommand({
        TableName: TASK_COMPLETIONS_TABLE,
        KeyConditionExpression:
          "child_subdomain = :child AND begins_with(task_completion, :prefix)",
        ExpressionAttributeValues: {
          ":child": auth.subdomain,
          ":prefix": `${taskId}#`,
        },
        ScanIndexForward: false,
        Limit: 1,
      })
    )
  ).Items as { task_completion: string }[];
  const latest = completions[0];
  if (!latest) {
    return json(event, 404, { error: "That chore wasn't completed yet" });
  }
  await ddb.send(
    new DeleteCommand({
      TableName: TASK_COMPLETIONS_TABLE,
      Key: {
        child_subdomain: auth.subdomain,
        task_completion: latest.task_completion,
      },
    })
  );
  const all = await scanTable<{ tickets: number; child_subdomain: string }>(
    ddb,
    TASK_COMPLETIONS_TABLE
  );
  const totalTickets = all
    .filter((c) => c.child_subdomain === auth.subdomain)
    .reduce((sum, c) => sum + c.tickets, 0);
  return json(event, 200, { removed: true, total_tickets: totalTickets });
}

// ── Admin routes ─────────────────────────────────────────────────────
type AdminTable =
  | "rooms"
  | "fixtures"
  | "windows"
  | "switches"
  | "chores"
  | "claims";

const ADMIN_TABLES: Record<AdminTable, string> = {
  rooms: ROOMS_TABLE,
  fixtures: FIXTURES_TABLE,
  windows: WINDOWS_TABLE,
  switches: SWITCHES_TABLE,
  chores: CHORES_TABLE,
  claims: CLAIMS_TABLE,
};

/** Per-table field normalisers: coerce the body into a storable row. */
function adminRowFor(
  table: AdminTable,
  id: string,
  existing: Record<string, unknown> | null,
  body: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const str = (v: unknown, fallback: string | null): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : v === null ? null : fallback;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    Number.isFinite(Number(v)) ? Number(v) : fallback;
  const base = {
    created_at: (existing?.created_at as string) ?? now,
    updated_at: now,
    enabled: bool(body.enabled, (existing?.enabled as boolean) ?? true),
  };
  switch (table) {
    case "rooms":
      return {
        room_id: id,
        name: str(body.name, (existing?.name as string) ?? id),
        floor: num(body.floor, (existing?.floor as number) ?? 0),
        area_m2: num(body.area_m2, (existing?.area_m2 as number) ?? 0),
        carpeted: bool(body.carpeted, (existing?.carpeted as boolean) ?? false),
        ...base,
      };
    case "fixtures":
    case "windows":
      return {
        [`${table === "fixtures" ? "fixture_id" : "window_id"}`]: id,
        room_id: str(body.room_id, (existing?.room_id as string) ?? ""),
        name: str(body.name, (existing?.name as string) ?? id),
        ...base,
      };
    case "switches":
      return {
        switch_id: id,
        room_id: str(body.room_id, (existing?.room_id as string) ?? ""),
        name: str(body.name, (existing?.name as string) ?? id),
        battery_dead: bool(body.battery_dead, (existing?.battery_dead as boolean) ?? false),
        ...base,
      };
    case "chores":
      return {
        chore_id: id,
        target_type: str(body.target_type, (existing?.target_type as string) ?? "room") as ChoreTargetType,
        target_id: str(body.target_id, (existing?.target_id as string) ?? ""),
        job: str(body.job, (existing?.job as string) ?? ""),
        title: str(body.title, (existing?.title as string) ?? id),
        base_tickets: num(body.base_tickets, (existing?.base_tickets as number) ?? 1),
        reset_days: num(body.reset_days, (existing?.reset_days as number) ?? 7),
        ...base,
      };
    case "claims":
      return {
        child_subdomain: id,
        chore_claim: str(body.chore_claim, (existing?.chore_claim as string) ?? ""),
        chore_id: str(body.chore_id, (existing?.chore_id as string) ?? ""),
        task_id: str(body.task_id, (existing?.task_id as string) ?? ""),
        claimed_at: str(body.claimed_at, (existing?.claimed_at as string) ?? now),
      };
  }
}

async function handleAdminList(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  table: AdminTable
): Promise<APIResponse> {
  const rows = await scanTable<Record<string, unknown>>(ddb, ADMIN_TABLES[table]);
  return json(event, 200, rows);
}

async function handleAdminPut(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  table: AdminTable,
  id: string
): Promise<APIResponse> {
  const tableName = ADMIN_TABLES[table];
  const body = parseBody(event);
  const keyName =
    table === "rooms"
      ? "room_id"
      : table === "fixtures"
        ? "fixture_id"
        : table === "windows"
          ? "window_id"
          : table === "switches"
            ? "switch_id"
            : table === "chores"
              ? "chore_id"
              : "child_subdomain";
  const existing = await getRow<Record<string, unknown>>(ddb, tableName, { [keyName]: id });
  const row = adminRowFor(table, id, existing, body);
  await ddb.send(new PutCommand({ TableName: tableName, Item: row }));
  return json(event, 200, row);
}

async function handleAdminDelete(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  table: AdminTable,
  id: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: ADMIN_TABLES[table], Key: { [keyNameFor(table)]: id } })
  );
  return json(event, 200, { deleted: true });
}

function keyNameFor(table: AdminTable): string {
  return table === "rooms"
    ? "room_id"
    : table === "fixtures"
      ? "fixture_id"
      : table === "windows"
        ? "window_id"
        : table === "switches"
          ? "switch_id"
          : table === "chores"
            ? "chore_id"
            : "child_subdomain";
}

async function handleAdminBattery(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  switchId: string
): Promise<APIResponse> {
  const body = parseBody(event);
  const existing = await getRow<ChoreSwitchRow>(ddb, SWITCHES_TABLE, {
    switch_id: switchId,
  });
  if (!existing) {
    return json(event, 404, { error: "No such switch" });
  }
  const row: ChoreSwitchRow = {
    ...existing,
    battery_dead: body.battery_dead !== false,
    updated_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: SWITCHES_TABLE, Item: row }));
  return json(event, 200, row);
}

// ── Router ─────────────────────────────────────────────────────────────
export async function tryHandleChoreRoute(
  event: APIGatewayEvent,
  method: string,
  resource: string,
  resourceId: string,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse | null> {
  // Kid routes: /kid/chores[/{choreId}/{action}]
  if (resource === "kid" && (resourceId === "chores" || resourceId.startsWith("chores/"))) {
    const rest = resourceId === "chores" ? "" : resourceId.slice("chores/".length);
    const [choreId, action] = rest.split("/");
    if (method === "GET" && !choreId) return handleKidChores(event, ddb);
    // "mine" is a sub-route, not a choreId — match BEFORE the id branch.
    if (method === "GET" && choreId === "mine") return handleKidMine(event, ddb);
    if (!choreId) return json(event, 404, { error: "Not found" });
    if (method === "POST" && action === "claim") return handleKidClaim(event, ddb, choreId);
    if (method === "POST" && action === "complete") return handleKidComplete(event, ddb, choreId);
    if (method === "POST" && action === "undo") return handleKidUndo(event, ddb, choreId);
    return json(event, 404, { error: "Not found" });
  }

  // Admin routes: /chores/{table}[/{id}[/{action}]]
  if (resource === "chores") {
    const [table, id, action] = resourceId.split("/");
    if (!(table in ADMIN_TABLES)) return json(event, 404, { error: "Not found" });
    const adminTable = table as AdminTable;
    if (method === "GET" && !id) return handleAdminList(event, ddb, adminTable);
    if (method === "PUT" && id) return handleAdminPut(event, ddb, adminTable, id);
    if (method === "DELETE" && id) return handleAdminDelete(event, ddb, adminTable, id);
    if (method === "POST" && adminTable === "switches" && id && action === "battery") {
      return handleAdminBattery(event, ddb, id);
    }
    return json(event, 404, { error: "Not found" });
  }

  return null;
}
