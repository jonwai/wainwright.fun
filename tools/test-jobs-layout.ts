/**
 * Jobs page grouping: claimed household chores, one room at a time, and
 * completed work pulled out of those rooms.
 *
 * Run: npx tsx tools/test-jobs-layout.ts
 */

import assert from "node:assert/strict";
import { splitHousehold, splitTasks } from "../apps/tickets/src/jobs-layout.ts";

const kitchen = {
  id: "kitchen",
  name: "Kitchen",
  chores: [
    { id: "empty-bin", can_undo: false, claim: { mine: true } },
    { id: "pack-bag", can_undo: false, claim: null },
    { id: "clean-oven", can_undo: true, claim: { mine: true } },
  ],
};
const bathroom = {
  id: "bathroom",
  name: "Bathroom",
  chores: [{ id: "wipe-sink", can_undo: false, claim: { mine: false } }],
};
const lounge = {
  id: "lounge",
  name: "Lounge",
  chores: [{ id: "tidy-playroom", can_undo: false, claim: null }],
};
const bedroom = { id: "bedroom", name: "Bedroom", chores: [] as { id: string; can_undo: boolean; claim: { mine: boolean } | null }[] };

const house = splitHousehold([kitchen, bathroom, lounge, bedroom]);

assert.deepEqual(
  house.claimed.map((row) => [row.chore.id, row.roomName]),
  [["empty-bin", "Kitchen"]],
);
assert.deepEqual(
  house.done.map((row) => [row.chore.id, row.roomName]),
  [["clean-oven", "Kitchen"]],
);
assert.deepEqual(
  house.rooms.map((room) => [room.name, room.chores.map((chore) => chore.id)]),
  [
    ["Kitchen", ["pack-bag"]],
    ["Bathroom", ["wipe-sink"]],
    ["Lounge", ["tidy-playroom"]],
    ["Bedroom", []],
  ],
);

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
