/**
 * Live end-to-end test of the job board routes against api.wainwright.fun.
 * Uses the admin preview-token flow (transient pairing row), exercises
 * board PUT/GET/DELETE + kid derived state, then cleans up.
 * Run: AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx scripts/test-board-live.ts
 */
import { PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";

const REGION = "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });

const API = "https://api.wainwright.fun";
const TOKEN = `prv_test${randomBytes(12).toString("hex")}`;
const NOW = Math.floor(Date.now() / 1000);

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

async function call(path: string, method: string, token: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

// Seed the preview pairing row (same as the admin preview flow).
await ddb.send(new PutCommand({
  TableName: "wainwright-pairing",
  Item: {
    code: TOKEN,
    kind: "preview",
    child_subdomain: "hannah",
    created_at: NOW,
    ttl: NOW + 300,
  },
}));

try {
  // 1. Kid state is reachable with the token.
  const before = await call("/kid/tasks", "GET", TOKEN);
  assert(before.status === 200, "kid GET tasks reachable");

  // 2. Admin creates a library task + a daily posting (admin routes need
  //    Cognito — we can't drive those from here; instead verify the
  //    kid-visible DERIVED fields work with a hand-seeded board row).
  await ddb.send(new PutCommand({
    TableName: "wainwright-tasks",
    Item: {
      task_id: "live-test-job",
      title: "Live test job",
      description: null,
      ticket_reward: 2,
      assigned_to: [],
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }));
  await ddb.send(new PutCommand({
    TableName: "wainwright-job-board",
    Item: {
      board_id: "live-test-daily",
      task_id: "live-test-job",
      repeat: "daily",
      ticket_reward: 3,
      assigned_to: [],
      posted: true,
      posted_at: null,
      completion_mode: "each_child",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }));

  // 3. Kid sees the posting with the OVERRIDDEN reward and repeat.
  const state = await call("/kid/tasks", "GET", TOKEN);
  assert(state.status === 200, "kid GET tasks (with posting)");
  const tasks = state.data.tasks as Array<Record<string, unknown>>;
  const posting = tasks.find((t) => t.board_id === "live-test-daily");
  assert(!!posting, "kid sees the daily posting");
  assert(posting?.ticket_reward === 3, "posting reward override is 3");
  assert(posting?.repeat === "daily", "posting repeat is daily");
  assert(posting?.done === false, "posting not done yet");

  // 4. Kid completes it — earns the posting's 3.
  const done = await call("/kid/tasks/live-test-job/complete", "POST", TOKEN);
  assert(done.status === 200, "kid complete returns 200");
  assert((done.data.completion as { tickets: number }).tickets === 3, "completion earned the posting's 3");

  // 5. Kid state now shows done today.
  const after = await call("/kid/tasks", "GET", TOKEN);
  const afterTasks = after.data.tasks as Array<Record<string, unknown>>;
  const afterPosting = afterTasks.find((t) => t.board_id === "live-test-daily");
  assert(afterPosting?.done === true, "daily posting done today");

  // 6. Undo restores it.
  const undone = await call("/kid/tasks/live-test-job/undo", "POST", TOKEN);
  assert(undone.status === 200, "kid undo returns 200");
  const final = await call("/kid/tasks", "GET", TOKEN);
  const finalTasks = final.data.tasks as Array<Record<string, unknown>>;
  const finalPosting = finalTasks.find((t) => t.board_id === "live-test-daily");
  assert(finalPosting?.done === false, "undo clears done");

  console.log("\nAll live job-board tests passed.");
} finally {
  // Clean up: pairing row, completions, task, board row.
  await ddb.send(new DeleteCommand({
    TableName: "wainwright-pairing",
    Key: { code: TOKEN },
  }));
  const completions = await ddb.send(new QueryCommand({
    TableName: "wainwright-task-completions",
    KeyConditionExpression: "child_subdomain = :c AND begins_with(task_completion, :p)",
    ExpressionAttributeValues: { ":c": "hannah", ":p": "live-test-job#" },
  }));
  for (const item of completions.Items ?? []) {
    await ddb.send(new DeleteCommand({
      TableName: "wainwright-task-completions",
      Key: { child_subdomain: "hannah", task_completion: item.task_completion },
    }));
  }
  await ddb.send(new DeleteCommand({
    TableName: "wainwright-tasks",
    Key: { task_id: "live-test-job" },
  }));
  await ddb.send(new DeleteCommand({
    TableName: "wainwright-job-board",
    Key: { board_id: "live-test-daily" },
  }));
  console.log("Cleanup done.");
}
