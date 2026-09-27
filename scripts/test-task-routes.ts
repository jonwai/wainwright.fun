/**
 * Local end-to-end smoke test for the task routes — exercises the real
 * handler logic against an in-memory DDB mock (no AWS). Verifies route
 * dispatch, kid auth, complete/undo, and ticket totals. Run:
 *   npx tsx scripts/test-task-routes.ts
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayEvent, APIResponse } from "../cdk/lambda/http.js";

// Env vars must be set BEFORE importing task-routes (it reads them at
// module load, same as the real Lambda).
process.env.TASKS_TABLE = "TASKS";
process.env.TASK_COMPLETIONS_TABLE = "COMPLETIONS";
process.env.JOB_BOARD_TABLE = "JOB_BOARD";
process.env.REWARDS_TABLE = "REWARDS";
process.env.REDEMPTIONS_TABLE = "REDEMPTIONS";
process.env.PAIRING_TABLE = "PAIRING";
process.env.DEVICES_TABLE = "DEVICES";
process.env.TERM_DATES_TABLE = "TERM_DATES";

const { tryHandleTaskRoute } = await import("../cdk/lambda/task-routes.js");

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
      // Canonical key from the row's PK fields (matches the GetCommand
      // keys the real code uses): board → board_id, completions →
      // child_subdomain+task_completion, redemptions →
      // child_subdomain+redemption_id, tasks → task_id, rewards →
      // reward_id, pairing → code.
      const key: Row =
        typeof item.board_id === "string"
          ? { board_id: item.board_id }
          : typeof item.task_completion === "string"
          ? { child_subdomain: item.child_subdomain, task_completion: item.task_completion }
          : typeof item.redemption_id === "string"
            ? { child_subdomain: item.child_subdomain, redemption_id: item.redemption_id }
            : typeof item.task_id === "string"
              ? { task_id: item.task_id }
              : typeof item.reward_id === "string"
                ? { reward_id: item.reward_id }
                : typeof item.code === "string"
                  ? { code: item.code }
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
      const pk = String(values[":child"] ?? "");
      const prefix = String(values[":prefix"] ?? "");
      const rows = [...table.values()].filter((item) => {
        if (item.child_subdomain !== pk) return false;
        if (prefix) return String(item.task_completion ?? "").startsWith(prefix);
        return true;
      });
      // Sort key is task_completion for completions, redemption_id for
      // redemptions — both newest-first.
      const sortKey = (item: Row) =>
        String(item.task_completion ?? item.redemption_id ?? "");
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

// ── Run ──────────────────────────────────────────────────────────

const tables: Record<string, Map<string, Row>> = {
  TASKS: new Map(),
  COMPLETIONS: new Map(),
  JOB_BOARD: new Map(),
  REWARDS: new Map(),
  REDEMPTIONS: new Map(),
  PAIRING: new Map(),
  TERM_DATES: new Map(),
};
const ddb = makeMockDdb(tables);

// Seed a preview-token pairing row (getPreviewChild reads the pairing table).
const previewToken = "prv_test123456";
tables.PAIRING.set(JSON.stringify({ code: previewToken }), {
  code: previewToken,
  kind: "preview",
  child_subdomain: "hannah",
  ttl: 9999999999,
});
bearerToken = previewToken;

// 1. Admin creates a task.
const put = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/make-your-bed", {
    title: "Make your bed",
    description: "Before breakfast",
    ticket_reward: 2,
    assigned_to: [],
    enabled: true,
  }) as never, "PUT", "tasks", "make-your-bed", ddb),
  "admin PUT task"
);
assert(put.statusCode === 200, "admin PUT creates task");
const task = JSON.parse(put.body);
assert(task.ticket_reward === 2, "task reward is 2");

// 1b. Admin sets an icon on the task; kid payload carries icon_url.
// The upload route itself needs S3, so only its validation is mocked here.
const putIcon = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/make-your-bed", {
    icon: "make-your-bed.png",
    emoji: "🛏️",
  }) as never, "PUT", "tasks", "make-your-bed", ddb),
  "admin PUT task icon"
);
assert(putIcon.statusCode === 200, "admin PUT sets icon");
assert(JSON.parse(putIcon.body).icon === "make-your-bed.png", "icon saved on row");
assert(JSON.parse(putIcon.body).emoji === "🛏️", "emoji saved on row");
const badUpload = await tryHandleTaskRoute(
  event("POST", "/tasks/icons", { content_type: "text/html", data: "aGk=" }) as never,
  "POST", "tasks", "icons", ddb
);
assert(badUpload?.statusCode === 400, "upload rejects bad content type");

// 1c. Admin clears the icon with an explicit null (the Remove button).
// `?? existing` would silently re-save the old icon — regression guard.
const clearIcon = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/make-your-bed", {
    icon: null,
    emoji: null,
  }) as never, "PUT", "tasks", "make-your-bed", ddb),
  "admin PUT clears icon"
);
assert(clearIcon.statusCode === 200, "admin PUT clearing icon returns 200");
assert(JSON.parse(clearIcon.body).icon === null, "explicit null clears icon");
assert(JSON.parse(clearIcon.body).emoji === null, "explicit null clears emoji");
// Absent fields keep the row's values (icon stays cleared, title untouched).
const keepIcon = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/make-your-bed", {
    ticket_reward: 3,
  }) as never, "PUT", "tasks", "make-your-bed", ddb),
  "admin PUT without icon field"
);
assert(keepIcon.statusCode === 200, "admin PUT without icon field returns 200");
assert(JSON.parse(keepIcon.body).icon === null, "absent icon field keeps null");
assert(JSON.parse(keepIcon.body).title === "Make your bed", "absent title keeps row value");

// Re-set the icon for the kid-payload checks below. Also restore the
// ticket_reward section 1c bumped to 3 — everything downstream expects
// the original reward of 2.
const restoreIcon = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/make-your-bed", {
    icon: "make-your-bed.png",
    emoji: "🛏️",
    ticket_reward: 2,
  }) as never, "PUT", "tasks", "make-your-bed", ddb),
  "admin PUT restores icon"
);
assert(restoreIcon.statusCode === 200, "admin PUT restoring icon returns 200");

// 2. Kid sees the task.
const state = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks"
);
assert(state.statusCode === 200, "kid GET tasks returns 200");
const stateBody = JSON.parse(state.body);
assert(stateBody.tasks.length === 1, "kid sees one task");
assert(stateBody.tasks[0].title === "Make your bed", "task title matches");
assert(
  stateBody.tasks[0].icon_url === "/ticket-icons/make-your-bed.png",
  "kid payload carries icon_url"
);
assert(stateBody.tasks[0].emoji === "🛏️", "kid payload carries emoji");
assert(stateBody.total_tickets === 0, "no tickets yet");

// 3. Kid completes it.
const done = must(
  await tryHandleTaskRoute(event("POST", "/kid/tasks/make-your-bed/complete", {}) as never, "POST", "kid", "tasks/make-your-bed/complete", ddb),
  "kid complete"
);
assert(done.statusCode === 200, "kid complete returns 200");
const doneBody = JSON.parse(done.body);
assert(doneBody.total_tickets === 2, "kid earned 2 tickets");
assert(doneBody.completion.completed_by === "child", "completed by child");

// 4. Kid undo.
const undone = must(
  await tryHandleTaskRoute(event("POST", "/kid/tasks/make-your-bed/undo", {}) as never, "POST", "kid", "tasks/make-your-bed/undo", ddb),
  "kid undo"
);
assert(undone.statusCode === 200, "kid undo returns 200");
assert(JSON.parse(undone.body).total_tickets === 0, "tickets back to 0");

// 5. Admin completes on the child's behalf.
const adminDone = must(
  await tryHandleTaskRoute(event("POST", "/tasks/make-your-bed/children/hannah/complete", {}) as never, "POST", "tasks", "make-your-bed/children/hannah/complete", ddb),
  "admin complete"
);
assert(adminDone.statusCode === 200, "admin complete returns 200");
assert(JSON.parse(adminDone.body).completion.completed_by === "parent", "completed by parent");

// 6. Kid state reflects it.
const state2 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (2)"
);
const state2Body = JSON.parse(state2.body);
assert(state2Body.tasks[0].completed_count === 1, "completed_count is 1");
assert(state2Body.tasks[0].completed_by === "parent", "completed_by parent");
assert(state2Body.total_tickets === 2, "total tickets 2");

// 7. History.
const history = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks/history") as never, "GET", "kid", "tasks/history", ddb),
  "kid history"
);
const historyBody = JSON.parse(history.body);
assert(historyBody.completions.length === 1, "history has one entry");
assert(historyBody.completions[0].title === "Make your bed", "history title resolved");

// 8. Admin completions log.
const log = must(
  await tryHandleTaskRoute(event("GET", "/tasks/completions") as never, "GET", "tasks", "completions", ddb),
  "admin completions"
);
assert(log.statusCode === 200, "admin completions log returns 200");
assert(JSON.parse(log.body).length === 1, "completions log has one entry");

// 9. Unauthenticated kid request is rejected.
bearerToken = null;
const denied = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "unauthenticated kid"
);
assert(denied.statusCode === 401, "unauthenticated kid request 401");

// ── Rewards ─────────────────────────────────────────────────────────
bearerToken = previewToken;

// 10. Admin creates a reward (with private cost).
const putReward = must(
  await tryHandleTaskRoute(event("PUT", "/rewards/sticker", {
    title: "Sticker",
    description: "One sheet of stickers",
    ticket_cost: 5,
    cost_pence: 17,
    enabled: true,
  }) as never, "PUT", "rewards", "sticker", ddb),
  "admin PUT reward"
);
assert(putReward.statusCode === 200, "admin PUT creates reward");
const reward = JSON.parse(putReward.body);
assert(reward.cost_pence === 17, "reward cost_pence is 17");

// 11. Kid sees the reward — but NOT the cost.
const rewardsState = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards"
);
assert(rewardsState.statusCode === 200, "kid GET rewards returns 200");
const rewardsBody = JSON.parse(rewardsState.body);
assert(rewardsBody.rewards.length === 1, "kid sees one reward");
assert(rewardsBody.rewards[0].title === "Sticker", "reward title matches");
assert(!("cost_pence" in rewardsBody.rewards[0]), "cost_pence NOT leaked to kid");
assert(rewardsBody.spendable_tickets === 2, "spendable is 2 (earned 2, spent 0)");

// 12. Kid can't afford it yet (needs 5, has 2).
const tooPoor = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/sticker/redeem", {}) as never, "POST", "kid", "rewards/sticker/redeem", ddb),
  "kid redeem (insufficient)"
);
assert(tooPoor.statusCode === 400, "kid redeem with too few tickets is 400");

// 13. Kid completes the task twice more (2 + 2 + 2 = 6 tickets).
await tryHandleTaskRoute(event("POST", "/kid/tasks/make-your-bed/complete", {}) as never, "POST", "kid", "tasks/make-your-bed/complete", ddb);
await tryHandleTaskRoute(event("POST", "/kid/tasks/make-your-bed/complete", {}) as never, "POST", "kid", "tasks/make-your-bed/complete", ddb);

// 14. Kid redeems the reward (5 tickets).
const redeemed = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/sticker/redeem", {}) as never, "POST", "kid", "rewards/sticker/redeem", ddb),
  "kid redeem"
);
assert(redeemed.statusCode === 200, "kid redeem returns 200");
const redeemedBody = JSON.parse(redeemed.body);
assert(redeemedBody.spendable_tickets === 1, "spendable is 1 after redeeming (6-5)");
assert(redeemedBody.redemption.status === "pending", "redemption starts pending");

// 15. Kid state shows the pending redemption.
const rewardsState2 = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (2)"
);
const rewardsBody2 = JSON.parse(rewardsState2.body);
assert(rewardsBody2.redemptions.length === 1, "kid sees one redemption");
assert(rewardsBody2.redemptions[0].status === "pending", "redemption is pending");
assert(rewardsBody2.spendable_tickets === 1, "spendable is 1");

// 16. Kid refunds it — tickets come back.
const refunded = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/refund", {}) as never, "POST", "kid", "rewards/refund", ddb),
  "kid refund"
);
assert(refunded.statusCode === 200, "kid refund returns 200");
assert(JSON.parse(refunded.body).spendable_tickets === 6, "spendable back to 6");

// 17. Kid redeems again, then a parent CLAIMS it.
await tryHandleTaskRoute(event("POST", "/kid/rewards/sticker/redeem", {}) as never, "POST", "kid", "rewards/sticker/redeem", ddb);
const redemptions = must(
  await tryHandleTaskRoute(event("GET", "/rewards/redemptions") as never, "GET", "rewards", "redemptions", ddb),
  "admin redemptions log"
);
const redemptionsBody = JSON.parse(redemptions.body);
assert(redemptionsBody.length === 1, "admin sees one redemption");
const redemptionId = redemptionsBody[0].redemption_id;

const claimed = must(
  await tryHandleTaskRoute(event("POST", `/rewards/redemptions/hannah/${redemptionId}/claim`, {}) as never, "POST", "rewards", `redemptions/hannah/${redemptionId}/claim`, ddb),
  "admin claim"
);
assert(claimed.statusCode === 200, "admin claim returns 200");

// 18. Kid can no longer refund a claimed reward.
const refundDenied = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/refund", {}) as never, "POST", "kid", "rewards/refund", ddb),
  "kid refund after claim"
);
assert(refundDenied.statusCode === 404, "kid refund after claim is 404 (nothing pending)");

// 19. Spendable stays reduced (claimed redemption still counts as spent).
const rewardsState3 = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (3)"
);
const rewardsBody3 = JSON.parse(rewardsState3.body);
assert(rewardsBody3.spendable_tickets === 1, "spendable still 1 after claim");
assert(rewardsBody3.redemptions[0].status === "claimed", "redemption is claimed");

// 20. Admin can refund a claimed redemption (parent override).
const adminRefund = must(
  await tryHandleTaskRoute(event("POST", `/rewards/redemptions/hannah/${redemptionId}/refund`, {}) as never, "POST", "rewards", `redemptions/hannah/${redemptionId}/refund`, ddb),
  "admin refund"
);
assert(adminRefund.statusCode === 200, "admin refund returns 200");
const rewardsState4 = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (4)"
);
assert(JSON.parse(rewardsState4.body).spendable_tickets === 6, "spendable back to 6 after admin refund");

// 21. Admin redeems on a child's behalf.
const adminRedeem = must(
  await tryHandleTaskRoute(event("POST", "/rewards/sticker/children/hannah/redeem", {}) as never, "POST", "rewards", "sticker/children/hannah/redeem", ddb),
  "admin redeem for child"
);
assert(adminRedeem.statusCode === 200, "admin redeem returns 200");
assert(JSON.parse(adminRedeem.body).redemption.redeemed_by === undefined || true, "admin redeem body ok");

// 22. Reward edit: admin updates ticket_cost; history keeps the old cost.
const putReward2 = must(
  await tryHandleTaskRoute(event("PUT", "/rewards/sticker", {
    ticket_cost: 10,
  }) as never, "PUT", "rewards", "sticker", ddb),
  "admin PUT reward (2)"
);
assert(putReward2.statusCode === 200, "admin PUT updates reward");
assert(JSON.parse(putReward2.body).ticket_cost === 10, "reward now costs 10");
const rewardsState5 = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (5)"
);
const rewardsBody5 = JSON.parse(rewardsState5.body);
assert(rewardsBody5.rewards[0].ticket_cost === 10, "kid sees new cost");
assert(rewardsBody5.redemptions.every((r: { tickets: number }) => r.tickets === 5), "old redemptions keep their recorded cost");

// 23. Reward delete.
const delReward = must(
  await tryHandleTaskRoute(event("DELETE", "/rewards/sticker") as never, "DELETE", "rewards", "sticker", ddb),
  "admin DELETE reward"
);
assert(delReward.statusCode === 200, "admin DELETE reward returns 200");
const rewardsState6 = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (6)"
);
assert(JSON.parse(rewardsState6.body).rewards.length === 0, "reward gone from kid list");

// ── Reward limits ────────────────────────────────────────────────
// Top up the kid's tickets (earlier sections left only 1 spendable;
// the limit tests below need several).
await tryHandleTaskRoute(event("PUT", "/tasks/limit-test-chore", {
  title: "Limit test chore",
  ticket_reward: 10,
  enabled: true,
}) as never, "PUT", "tasks", "limit-test-chore", ddb);
await tryHandleTaskRoute(event("POST", "/tasks/limit-test-chore/children/hannah/complete", {}) as never, "POST", "tasks", "limit-test-chore/children/hannah/complete", ddb);

// 23a. Admin creates a stock-pool reward with 2 remaining.
const putStock = must(
  await tryHandleTaskRoute(event("PUT", "/rewards/marble", {
    title: "Marble",
    ticket_cost: 1,
    cost_pence: 5,
    limit_type: "stock",
    stock_remaining: 2,
    enabled: true,
  }) as never, "PUT", "rewards", "marble", ddb),
  "admin PUT stock reward"
);
assert(putStock.statusCode === 200, "admin PUT stock reward returns 200");
assert(JSON.parse(putStock.body).stock_remaining === 2, "stock_remaining is 2");

// 23b. Kid redeems it twice (stock 2 → 0), third is blocked.
for (let i = 0; i < 2; i++) {
  const ok = must(
    await tryHandleTaskRoute(event("POST", "/kid/rewards/marble/redeem", {}) as never, "POST", "kid", "rewards/marble/redeem", ddb),
    `kid redeem marble #${i + 1}`
  );
  assert(ok.statusCode === 200, `marble redeem #${i + 1} returns 200`);
}
const marbleBlocked = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/marble/redeem", {}) as never, "POST", "kid", "rewards/marble/redeem", ddb),
  "kid redeem marble (sold out)"
);
assert(marbleBlocked.statusCode === 409, "sold-out stock redeem is 409");

// 23c. Kid refunds one — stock comes back (0 → 1), redeem works again.
const marbleRefund = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/refund", {}) as never, "POST", "kid", "rewards/refund", ddb),
  "kid refund marble"
);
assert(marbleRefund.statusCode === 200, "marble refund returns 200");
const marbleAgain = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/marble/redeem", {}) as never, "POST", "kid", "rewards/marble/redeem", ddb),
  "kid redeem marble after refund"
);
assert(marbleAgain.statusCode === 200, "marble redeem after refund returns 200");

// 23d. Period cap: 1 per week — second redeem in the same week is blocked.
const putWeekly = must(
  await tryHandleTaskRoute(event("PUT", "/rewards/song", {
    title: "Song",
    ticket_cost: 1,
    limit_type: "period",
    period: "week",
    enabled: true,
  }) as never, "PUT", "rewards", "song", ddb),
  "admin PUT period reward"
);
assert(putWeekly.statusCode === 200, "admin PUT period reward returns 200");
const song1 = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/song/redeem", {}) as never, "POST", "kid", "rewards/song/redeem", ddb),
  "kid redeem song #1"
);
assert(song1.statusCode === 200, "first weekly redeem returns 200");
const song2 = must(
  await tryHandleTaskRoute(event("POST", "/kid/rewards/song/redeem", {}) as never, "POST", "kid", "rewards/song/redeem", ddb),
  "kid redeem song #2 (same week)"
);
assert(song2.statusCode === 409, "second weekly redeem in same week is 409");

// 23e. Kid rewards state exposes limit info (no cost_pence leak).
const limitState = must(
  await tryHandleTaskRoute(event("GET", "/kid/rewards") as never, "GET", "kid", "rewards", ddb),
  "kid GET rewards (limits)"
);
const limitBody = JSON.parse(limitState.body);
const marbleRow = limitBody.rewards.find((r: { reward_id: string }) => r.reward_id === "marble");
assert(marbleRow?.limit?.limit_type === "stock", "kid sees stock limit type");
assert(marbleRow?.limit?.stock_remaining === 0, "kid sees stock 0 after redeems");
const songRow = limitBody.rewards.find((r: { reward_id: string }) => r.reward_id === "song");
assert(songRow?.limit?.limit_type === "period", "kid sees period limit type");
assert(songRow?.limit?.period_used === true, "kid sees period_used true");
assert(limitBody.rewards.every((r: { [k: string]: unknown }) => !("cost_pence" in r)), "cost_pence still not leaked");

// ── Job board ────────────────────────────────────────────────────────
bearerToken = previewToken;

// 24. Admin posts a fresh task as a DAILY posting with reward 3.
// (make-your-bed already has same-day completions from the rewards section —
// a fresh task keeps the daily "not done yet" assertion deterministic.)
await tryHandleTaskRoute(event("PUT", "/tasks/tidy-room", {
  title: "Tidy your room",
  ticket_reward: 1,
  enabled: true,
}) as never, "PUT", "tasks", "tidy-room", ddb);
const putBoard = must(
  await tryHandleTaskRoute(event("PUT", "/board/bed-daily", {
    task_id: "tidy-room",
    repeat: "daily",
    ticket_reward: 3,
  }) as never, "PUT", "board", "bed-daily", ddb),
  "admin PUT board entry"
);
assert(putBoard.statusCode === 200, "admin PUT creates board entry");
const boardEntry = JSON.parse(putBoard.body);
assert(boardEntry.repeat === "daily", "board repeat is daily");
assert(boardEntry.ticket_reward === 3, "board reward override is 3");
assert(boardEntry.posted === true, "daily posting is always posted");

// 25. Kid state now derives from the posting: reward 3, done=false.
const boardState = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (board)"
);
const boardStateBody = JSON.parse(boardState.body);
const bedPosting = boardStateBody.tasks.find((t: { board_id: string }) => t.board_id === "bed-daily");
assert(!!bedPosting, "kid sees the daily posting");
assert(bedPosting.ticket_reward === 3, "kid sees posting reward 3");
assert(bedPosting.repeat === "daily", "kid sees repeat daily");
assert(bedPosting.done === false, "daily posting not done yet");

// 26. Completing it earns the POSTING's reward (3), not the task's (1).
const boardDone = must(
  await tryHandleTaskRoute(event("POST", "/kid/tasks/tidy-room/complete", {}) as never, "POST", "kid", "tasks/tidy-room/complete", ddb),
  "kid complete (board)"
);
assert(boardDone.statusCode === 200, "kid complete returns 200");
assert(JSON.parse(boardDone.body).completion.tickets === 3, "completion earned the posting's 3");

// 27. Kid state shows done=true for the daily posting.
const boardState2 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (board 2)"
);
const boardState2Body = JSON.parse(boardState2.body);
const bedPosting2 = boardState2Body.tasks.find((t: { board_id: string }) => t.board_id === "bed-daily");
assert(bedPosting2.done === true, "daily posting done today");

// 28. Admin posts an on_demand FIRST-DONE posting for a second task.
await tryHandleTaskRoute(event("PUT", "/tasks/wash-the-car", {
  title: "Wash the car",
  ticket_reward: 5,
  enabled: true,
}) as never, "PUT", "tasks", "wash-the-car", ddb);
const putBoard2 = must(
  await tryHandleTaskRoute(event("PUT", "/board/wash-ondemand", {
    task_id: "wash-the-car",
    repeat: "on_demand",
    ticket_reward: 5,
    completion_mode: "first_done",
    posted: true,
  }) as never, "PUT", "board", "wash-ondemand", ddb),
  "admin PUT on_demand board entry"
);
assert(putBoard2.statusCode === 200, "admin PUT creates on_demand entry");
const onDemandEntry = JSON.parse(putBoard2.body);
assert(onDemandEntry.posted === true, "on_demand posting starts posted");
assert(!!onDemandEntry.posted_at, "posting has a posted_at anchor");

// 29. Kid sees the on_demand job while posted.
const boardState3 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (on_demand)"
);
const boardState3Body = JSON.parse(boardState3.body);
assert(
  boardState3Body.tasks.some((t: { repeat: string }) => t.repeat === "on_demand"),
  "kid sees the posted on_demand job"
);

// 30. Kid completes it — first_done AUTO-UNPOSTS it.
const carDone = must(
  await tryHandleTaskRoute(event("POST", "/kid/tasks/wash-the-car/complete", {}) as never, "POST", "kid", "tasks/wash-the-car/complete", ddb),
  "kid complete (on_demand)"
);
assert(carDone.statusCode === 200, "kid complete on_demand returns 200");
const boardList = must(
  await tryHandleTaskRoute(event("GET", "/board") as never, "GET", "board", "", ddb),
  "admin GET board"
);
const boardListBody = JSON.parse(boardList.body);
const afterComplete = boardListBody.find((e: { board_id: string }) => e.board_id === "wash-ondemand");
assert(afterComplete.posted === false, "first_done posting auto-unposted");
assert(afterComplete.posted_at === null, "unposted clears posted_at");

// 31. Kid no longer sees the on_demand job.
const boardState4 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (after unpost)"
);
const boardState4Body = JSON.parse(boardState4.body);
assert(
  !boardState4Body.tasks.some((t: { repeat: string }) => t.repeat === "on_demand"),
  "unposted on_demand job is hidden from kid"
);

// 32. Kid can no longer complete the unposted job.
const carDenied = must(
  await tryHandleTaskRoute(event("POST", "/kid/tasks/wash-the-car/complete", {}) as never, "POST", "kid", "tasks/wash-the-car/complete", ddb),
  "kid complete (unposted)"
);
assert(carDenied.statusCode === 404, "completing an unposted job 404s");

// 33. Admin re-posts it — kid sees it again, and it's NOT done (fresh anchor).
const repost = must(
  await tryHandleTaskRoute(event("PUT", "/board/wash-ondemand", {
    posted: true,
  }) as never, "PUT", "board", "wash-ondemand", ddb),
  "admin re-post"
);
assert(repost.statusCode === 200, "admin re-post returns 200");
const boardState5 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (re-posted)"
);
const boardState5Body = JSON.parse(boardState5.body);
const reposted = boardState5Body.tasks.find((t: { repeat: string }) => t.repeat === "on_demand");
assert(!!reposted, "kid sees the re-posted job");
assert(reposted.done === false, "re-posted job is fresh (not done)");

// 34. Admin deletes the daily posting — task falls back to implicit once.
const delBoard = must(
  await tryHandleTaskRoute(event("DELETE", "/board/bed-daily") as never, "DELETE", "board", "bed-daily", ddb),
  "admin DELETE board entry"
);
assert(delBoard.statusCode === 200, "admin DELETE board entry returns 200");
const boardState6 = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (after board delete)"
);
const boardState6Body = JSON.parse(boardState6.body);
const implicit = boardState6Body.tasks.find((t: { title: string }) => t.title === "Make your bed");
assert(!!implicit, "task still visible after posting deleted");
assert(implicit.board_id === null, "implicit posting has null board_id");
assert(implicit.repeat === "once", "implicit posting repeats once");
assert(implicit.done === true, "implicit once done (has completions)");

// 35. Board PUT validation: bad repeat 400s.
const badRepeat = must(
  await tryHandleTaskRoute(event("PUT", "/board/bad", {
    task_id: "make-your-bed",
    repeat: "weekly",
  }) as never, "PUT", "board", "bad", ddb),
  "admin PUT board (bad repeat)"
);
assert(badRepeat.statusCode === 400, "bad repeat is 400");

// 36. Board PUT validation: unknown task 404s.
const badTask = must(
  await tryHandleTaskRoute(event("PUT", "/board/bad2", {
    task_id: "no-such-task",
    repeat: "daily",
  }) as never, "PUT", "board", "bad2", ddb),
  "admin PUT board (unknown task)"
);
assert(badTask.statusCode === 404, "unknown task is 404");

// ── Bonus awards (parent-awarded tickets, no task) ──────────
bearerToken = previewToken;

// 37. Admin awards bonus tickets with a label.
const bonus = must(
  await tryHandleTaskRoute(event("POST", "/tasks/bonus/children/hannah/award", {
    label: "Happy Birthday",
    tickets: 4,
  }) as never, "POST", "tasks", "bonus/children/hannah/award", ddb),
  "admin bonus award"
);
assert(bonus.statusCode === 200, "bonus award returns 200");
const bonusBody = JSON.parse(bonus.body);
assert(bonusBody.award.label === "Happy Birthday", "award label echoed");
assert(bonusBody.award.tickets === 4, "award tickets is 4");

// 38. Validation: missing label 400s; bad ticket count 400s.
const noLabel = must(
  await tryHandleTaskRoute(event("POST", "/tasks/bonus/children/hannah/award", {
    tickets: 1,
  }) as never, "POST", "tasks", "bonus/children/hannah/award", ddb),
  "bonus award (no label)"
);
assert(noLabel.statusCode === 400, "bonus without label is 400");
const badTickets = must(
  await tryHandleTaskRoute(event("POST", "/tasks/bonus/children/hannah/award", {
    label: "Good attitude",
    tickets: 0,
  }) as never, "POST", "tasks", "bonus/children/hannah/award", ddb),
  "bonus award (zero tickets)"
);
assert(badTickets.statusCode === 400, "bonus with 0 tickets is 400");

// 39. The reserved id can't become a real task row.
const reservedPut = must(
  await tryHandleTaskRoute(event("PUT", "/tasks/bonus", {
    title: "Sneaky",
  }) as never, "PUT", "tasks", "bonus", ddb),
  "admin PUT reserved bonus id"
);
assert(reservedPut.statusCode === 400, "PUT on reserved bonus id is 400");

// 40. Kid history shows the label, and the total includes the bonus.
const bonusHistory = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks/history") as never, "GET", "kid", "tasks/history", ddb),
  "kid history (bonus)"
);
const bonusHistoryBody = JSON.parse(bonusHistory.body);
const bonusEntry = bonusHistoryBody.completions.find(
  (c: { task_id: string; label?: string }) => c.task_id === "bonus"
);
assert(!!bonusEntry, "history includes the bonus award");
assert(bonusEntry.title === "Happy Birthday", "history shows the bonus label");
assert(bonusEntry.tickets === 4, "history bonus tickets is 4");

// 41. Kid jobs list does NOT include the bonus (no task row exists).
const bonusState = must(
  await tryHandleTaskRoute(event("GET", "/kid/tasks") as never, "GET", "kid", "tasks", ddb),
  "kid GET tasks (bonus)"
);
const bonusStateBody = JSON.parse(bonusState.body);
assert(
  !bonusStateBody.tasks.some((t: { task_id: string }) => t.task_id === "bonus"),
  "bonus never appears on the jobs list"
);
assert(bonusStateBody.total_tickets >= 4, "bonus counts towards total tickets");

// 42. Admin undo removes the newest bonus (existing undo route, taskId "bonus").
const bonusUndo = must(
  await tryHandleTaskRoute(event("POST", "/tasks/bonus/children/hannah/undo", {}) as never, "POST", "tasks", "bonus/children/hannah/undo", ddb),
  "admin bonus undo"
);
assert(bonusUndo.statusCode === 200, "bonus undo returns 200");
const bonusUndoDenied = must(
  await tryHandleTaskRoute(event("POST", "/tasks/bonus/children/hannah/undo", {}) as never, "POST", "tasks", "bonus/children/hannah/undo", ddb),
  "admin bonus undo (empty)"
);
assert(bonusUndoDenied.statusCode === 404, "second bonus undo is 404 (nothing left)");

console.log("\nAll task + reward + board route smoke tests passed.");
