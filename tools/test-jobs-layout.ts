/**
 * Jobs page grouping for Tickets' own jobs.
 *
 * Run: npx tsx tools/test-jobs-layout.ts
 */

import assert from "node:assert/strict";
import { splitTasks } from "../apps/tickets/src/jobs-layout.ts";

const tasks = splitTasks([
  { task_id: "feed-cat", done: false },
  { task_id: "make-bed", done: true },
  { task_id: "water-plants", done: false },
]);
assert.deepEqual(
  tasks.open.map((task) => task.task_id),
  ["feed-cat", "water-plants"],
);
assert.deepEqual(
  tasks.done.map((task) => task.task_id),
  ["make-bed"],
);

console.log("jobs layout ok");
