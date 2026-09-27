/**
 * Local end-to-end smoke test for the chore routes — exercises the real
 * handler logic against an in-memory DDB mock (no AWS). Verifies route
 * dispatch, kid auth, ticket maths, claim → Tickets task materialisation,
 * complete/undo, and the battery-dead gating. Run:
 *   npx tsx scripts/test-chore-routes.ts
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayEvent, APIResponse } from "../cdk/lambda/http.js";

// Env vars must be set BEFORE importing chores-routes (it reads them at
// module load, same as the real Lambda).
process.env.TASKS_TABLE = "TASKS";
process.env.TASK_COMPLETIONS_TABLE = "COMPLETIONS";
process.env.CHORES_ROOMS_TABLE = "ROOMS";
process.env.CHORES_FIXTURES_TABLE = "FIXTURES";
process.env.CHORES_WINDOWS_TABLE = "WINDOWS";
process.env.CHORES_SWITCHES_TABLE = "SWITCHES";
process.env.CHORES_TABLE = "CHORES";
process.env.CHORES_CLAIMS_TABLE = "CLAIMS";
process.env.PAIRING_TABLE = "PAIRING";
process.env.DEVICES_TABLE = "DEVICES";

const { tryHandleChoreRoute } = await import("../cdk/lambda/chores-routes.js");

// ── Minimal in-memory DDB mock ────────────────────────────────
type Row = Record<string, unknown>;

function makeMockDdb(tables: Record<string, Map<string, Row>>): DynamoDBDocumentClient {
  async function send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input as {
      TableName: string;
      Key?: Row;
      Item?: Row;
      ExpressionAttributeValues?: Row;
      ScanIndexForward?: boolean;
      Limit?: number;
    };
    if (!tables[input.TableName]) tables[input.TableName] = new Map();
    const table = tables[input.TableName];

    if (name === "GetCommand") {
      return { Item: table.get(JSON.stringify(input.Key)) };
    }
    if (name === "PutCommand") {
      const item = (input.Item ?? {}) as Row;
      const key: Row =
        typeof item.chore_claim === "string"
          ? { child_subdomain: item.child_subdomain, chore_claim: item.chore_claim }
          : typeof item.task_completion === "string"
          ? { child_subdomain: item.child_subdomain, task_completion: item.task_completion }
          : typeof item.room_id === "string"
            ? { room_id: item.room_id }
            : typeof item.fixture_id === "string"
              ? { fixture_id: item.fixture_id }
              : typeof item.window_id === "string"
                ? { window_id: item.window_id }
                : typeof item.switch_id === "string"
                  ? { switch_id: item.switch_id }
                  : typeof item.chore_id === "string"
                    ? { chore_id: item.chore_id }
                    : typeof item.task_id === "string"
                      ? { task_id: item.task_id }
                      : typeof item.device_id === "string"
                        ? { device_id: item.device_id }
                        : (input.Key ?? item);
      table.set(JSON.stringify(key), item);
      return {};
    }
    if (name === "DeleteCommand") {
      table.delete(JSON.stringify(input.Key));
      return {};
    }
    if (name === "QueryCommand") {
      const values = input.ExpressionAttributeValues ?? {};
      const pk = String(values[":child"] ?? values[":h"] ?? "");
      const prefix = String(values[":prefix"] ?? "");
      const rows = [...table.values()].filter((item) => {
        if (item.child_subdomain !== pk && item.token_hash !== pk) return false;
        if (prefix) return String(item.chore_claim ?? item.task_completion ?? "").startsWith(prefix);
        return true;
      });
      const sortKey = (item: Row) => String(item.chore_claim ?? item.task_completion ?? item.redemption_id ?? "");
      rows.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
      return { Items: input.Limit ? rows.slice(0, input.Limit) : rows };
    }
    if (name === "ScanCommand") {
      return { Items: [...table.values()] };
    }
    throw new Error(`Mock DDB does not implement ${name}`);
  }
  return { send } as unknown as DynamoDBDocumentClient;
}

// ── Event builder ────────────────────────────────────────────────
let bearerToken: string | null = null;

function event(method: string, path: string, body?: unknown): APIGatewayEvent {
  return {
    rawPath: path,
    requestContext: { http: { method, path } },
    headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

function must(response: APIResponse | null, label: string): APIResponse {
  if (!response) {
    console.error(`✗ ${label}: route returned null (not handled)`);
    process.exit(1);
  }
  return response;
}

function bodyOf(response: APIResponse): Record<string, unknown> {
  return JSON.parse(response.body);
}

/** Flattens the kid response's rooms[].chores into one list. */
function allChores(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const room of (data.rooms as Array<Record<string, unknown>>) ?? []) {
    out.push(...((room.chores as Array<Record<string, unknown>>) ?? []));
  }
  return out;
}


// ── Seed data ─────────────────────────────────────────────────────
const now = new Date().toISOString();
const tables: Record<string, Map<string, Row>> = {
  ROOMS: new Map(),
  FIXTURES: new Map(),
  WINDOWS: new Map(),
  SWITCHES: new Map(),
  CHORES: new Map(),
  CLAIMS: new Map(),
  TASKS: new Map(),
  COMPLETIONS: new Map(),
  DEVICES: new Map(),
};
const ddb = makeMockDdb(tables);

async function put(table: string, item: Row): Promise<void> {
  await ddb.send(new (await import("@aws-sdk/lib-dynamodb")).PutCommand({ TableName: table, Item: item }) as never);
}

// A paired device for hannah
await put("DEVICES", {
  device_id: "dev-1",
  child_subdomain: "hannah",
  token_hash: "65dcf16ea3dfa49069628089eb4a75483070f5584b2a21ee64912b5f621f12da",
  created_at: now,
});
bearerToken = "tok-1";

// Rooms: lounge (carpeted, 14.3 m²), kitchen (hard, 8.2 m²)
await put("ROOMS", { room_id: "lounge", name: "Lounge", floor: 1, carpeted: true, area_m2: 14.3, enabled: true, created_at: now, updated_at: now });
await put("ROOMS", { room_id: "kitchen", name: "Kitchen", floor: 0, carpeted: false, area_m2: 8.2, enabled: true, created_at: now, updated_at: now });

// A fixture (dishwasher) and a window and a switch
await put("FIXTURES", { fixture_id: "dishwasher-kitchen", room_id: "kitchen", kind: "dishwasher", name: "Dishwasher", enabled: true, created_at: now, updated_at: now });
await put("WINDOWS", { window_id: "win-g-study-s", room_id: "kitchen", name: "Study window", enabled: true, created_at: now, updated_at: now });
await put("SWITCHES", { switch_id: "switch-kitchen", room_id: "kitchen", name: "Kitchen light switch", battery_dead: false, enabled: true, created_at: now, updated_at: now });

// Chores: vacuum lounge (never done → full tickets), clean dishwasher
// (done 3 days ago of a 30-day cadence → partial), dust switch
await put("CHORES", { chore_id: "vacuum-lounge", title: "Vacuum the Lounge", target_type: "room", target_id: "lounge", base_tickets: 2, reset_days: 7, enabled: true, created_at: now, updated_at: now });
await put("CHORES", { chore_id: "clean-dishwasher-kitchen", title: "Clean the Dishwasher", target_type: "fixture", target_id: "dishwasher-kitchen", base_tickets: 2, reset_days: 30, enabled: true, created_at: now, updated_at: now });
await put("CHORES", { chore_id: "dust-switch-kitchen", title: "Dust the Kitchen light switch", target_type: "switch", target_id: "switch-kitchen", base_tickets: 1, reset_days: 30, enabled: true, created_at: now, updated_at: now });
await put("CHORES", { chore_id: "batteries-switch-kitchen", job: "batteries", title: "Replace batteries in the Kitchen light switch", target_type: "switch", target_id: "switch-kitchen", base_tickets: 2, reset_days: 1, enabled: true, created_at: now, updated_at: now });
// Dishwasher cleaned 3 days ago (by a parent)
const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
await put("COMPLETIONS", {
  child_subdomain: "hannah",
  task_completion: `chores#clean-dishwasher-kitchen#hannah#${threeDaysAgo}#abc123`,
  task_id: "chores#clean-dishwasher-kitchen#hannah",
  completed_at: threeDaysAgo,
  completed_by: "parent",
  tickets: 2,
});

// ── Tests ─────────────────────────────────────────────────────────
// 1. Unauthenticated request → 401
{
  const saved = bearerToken;
  bearerToken = null;
  const res = must(await tryHandleChoreRoute(event("GET", "/kid/chores"), "GET", "kid", "chores", ddb), "unauth GET /kid/chores");
  assert(res.statusCode === 401, "unauthenticated request is rejected with 401");
  bearerToken = saved;
}

// 2. GET /kid/chores — full state with derived tickets
{
  const res = must(await tryHandleChoreRoute(event("GET", "/kid/chores"), "GET", "kid", "chores", ddb), "GET /kid/chores");
  assert(res.statusCode === 200, "GET /kid/chores returns 200");
  const data = bodyOf(res);
  const chores = allChores(data);
  assert(chores.length === 3, `3 visible chores returned (battery chore hidden while alive) (got ${chores.length})`);

  const vacuum = chores.find((c) => c.chore_id === "vacuum-lounge")!;
  // Never done: full base 2 × size 14.3/10 = 2.86 → round = 3
  assert(vacuum.tickets === 3, `vacuum lounge full tickets = 3 (got ${vacuum.tickets})`);
  assert(vacuum.room_id === "lounge", "vacuum chore is grouped under lounge");

  const dishwasher = chores.find((c) => c.chore_id === "clean-dishwasher-kitchen")!;
  // 3 days of 30 elapsed, fixture (no size scaling): floor(2 × 3/30) = 0
  assert(dishwasher.tickets === 0, `dishwasher 3/30 days = 0 tickets (got ${dishwasher.tickets})`);

  const batteries = chores.find((c) => c.chore_id === "batteries-switch-kitchen");
  assert(!batteries, "battery chore hidden while battery alive");
}

// 3. Mark the switch battery dead → battery chore earns tickets
{
  await put("SWITCHES", { switch_id: "switch-kitchen", room_id: "kitchen", name: "Kitchen light switch", battery_dead: true, created_at: now, updated_at: now });
  const res = must(await tryHandleChoreRoute(event("GET", "/kid/chores"), "GET", "kid", "chores", ddb), "GET /kid/chores (battery dead)");
  const chores = allChores(bodyOf(res));
  const batteries = chores.find((c) => c.chore_id === "batteries-switch-kitchen")!;
  assert(batteries.tickets === 2, `battery chore earns 2 when dead (got ${batteries.tickets})`);
}

// 4. Claim the vacuum chore → Tickets task row appears
{
  const res = must(await tryHandleChoreRoute(event("POST", "/kid/chores/vacuum-lounge/claim"), "POST", "kid", "chores/vacuum-lounge/claim", ddb), "POST claim");
  assert(res.statusCode === 200, "claim returns 200");
  const data = bodyOf(res);
  const taskId = data.task_id as string;
  assert(typeof taskId === "string" && taskId.startsWith("chores#vacuum-lounge#"), `claim returns a chores# task id (got ${taskId})`);
  assert(data.tickets === 3, `claim records the live ticket value (got ${data.tickets})`);

  // The Tickets task row exists and is audience-locked to hannah
  const taskRow = tables.TASKS.get(JSON.stringify({ task_id: taskId }));
  assert(!!taskRow, "Tickets task row was materialised");
  assert((taskRow!.assigned_to as string[]).join(",") === "hannah", "task row is locked to the claiming child");
  assert(taskRow!.title === "Vacuum the Lounge", "task row carries the chore title");
  assert(taskRow!.ticket_reward === 3, "task row carries the live ticket reward");

  // GET /kid/chores now shows the chore as claimed by hannah
  const state = bodyOf(must(await tryHandleChoreRoute(event("GET", "/kid/chores"), "GET", "kid", "chores", ddb), "GET after claim"));
  const vacuum = allChores(state).find((c) => c.chore_id === "vacuum-lounge")!;
  assert(vacuum.claimed === true, "chore shows as claimed");
  const mineEntry = (state.mine as Array<Record<string, unknown>>).find((c) => c.chore_id === "vacuum-lounge");
  assert(!!mineEntry, "claim appears in mine list");
  assert(mineEntry!.task_id === taskId, "claim task id is surfaced to the kid");
}

// 5. Complete the chore from the Chores app → completion event + claim cleared
{
  const res = must(await tryHandleChoreRoute(event("POST", "/kid/chores/vacuum-lounge/complete"), "POST", "kid", "chores/vacuum-lounge/complete", ddb), "POST complete");
  assert(res.statusCode === 200, "complete returns 200");
  const data = bodyOf(res);
  assert(data.total_tickets === 5, `total tickets after complete = 5 (got ${data.total_tickets})`);

  // Completion event recorded against the materialised task id
  const completions = [...tables.COMPLETIONS.values()].filter(
    (c) => String(c.task_id).startsWith("chores#vacuum-lounge")
  );
  assert(completions.length === 1, "completion event recorded");
  assert(completions[0].tickets === 3, "completion carries the claimed ticket value");

  // Claim cleared
  const claims = [...tables.CLAIMS.values()].filter((c) => c.chore_id === "vacuum-lounge");
  assert(claims.length === 0, "claim cleared after completion");

  // Chore now earns 0 tickets (just done)
  const state = bodyOf(must(await tryHandleChoreRoute(event("GET", "/kid/chores"), "GET", "kid", "chores", ddb), "GET after complete"));
  const vacuum = allChores(state).find((c) => c.chore_id === "vacuum-lounge")!;
  assert(vacuum.tickets === 0, "just-completed chore earns 0 tickets");
}

// 6. Undo the completion → tickets removed, chore due again
{
  const res = must(await tryHandleChoreRoute(event("POST", "/kid/chores/vacuum-lounge/undo"), "POST", "kid", "chores/vacuum-lounge/undo", ddb), "POST undo");
  assert(res.statusCode === 200, "undo returns 200");
  const data = bodyOf(res);
  assert(data.total_tickets === 2, `total tickets after undo = 2 (got ${data.total_tickets})`);
  const completions = [...tables.COMPLETIONS.values()].filter(
    (c) => String(c.task_id).startsWith("chores#vacuum-lounge")
  );
  assert(completions.length === 0, "completion event removed by undo");
}

// 7. Admin routes: list + put
{
  const res = must(await tryHandleChoreRoute(event("GET", "/chores/chores"), "GET", "chores", "chores", ddb), "GET /chores/chores");
  assert(res.statusCode === 200, "admin GET /chores returns 200");
  const data = bodyOf(res);
  assert(Array.isArray(data) && data.length === 4, "admin list returns all chores");

  const putRes = must(await tryHandleChoreRoute(event("PUT", "/chores/chores/vacuum-lounge", { base_tickets: 3 }), "PUT", "chores", "chores/vacuum-lounge", ddb), "PUT /chores/chores/vacuum-lounge");
  assert(putRes.statusCode === 200, "admin PUT returns 200");
  assert(bodyOf(putRes).base_tickets === 3, "admin PUT updates base_tickets");
}

// 8. Unknown route → null (falls through to the next handler)
{
  const res = await tryHandleChoreRoute(event("GET", "/nothing"), "GET", "nothing", "", ddb);
  assert(res === null, "unknown resource returns null (not handled)");
}

console.log(process.exitCode ? "\nSome checks failed." : "\nAll chore route checks passed.");
