/**
 * Household's kid list, as Tickets shows it: claimed and assigned chores,
 * locked chores with waiting_on, and done recently. Unclaimed catalog chores
 * from the older room payload are left out.
 *
 * Run: npx tsx tools/test-household-list.ts
 */

import assert from "node:assert/strict";
import { normalizeHouseholdList } from "../packages/local/src/household-chores.ts";

const assigned = normalizeHouseholdList({
  child: { id: "lydia", name: "Lydia" },
  chores: [
    { id: "empty-bin", title: "Empty the bin", tickets: 2, claim: { child_id: "lydia", name: "Lydia", mine: true }, room_name: "Kitchen" },
    { id: "pack-bag", title: "Pack the school bag", tickets: 1, assigned: true, locked: true, waiting_on: ["the washing machine", { title: "the dryer" }], room: { name: "Kitchen" } },
    { id: "wipe-sink", title: "Wipe the sink", tickets: 1, claim: { child_id: "hannah", name: "Hannah", mine: false } },
    { id: "tidy", title: "Tidy the playroom", tickets: 4, held: true, held_by: "Lydia" },
  ],
  doneRecently: [{ id: "clean-oven", title: "Clean the oven", tickets: 0, can_undo: true, room_name: "Kitchen" }],
}, "lydia");

assert.deepEqual(assigned?.chores.map((chore) => chore.id), ["empty-bin", "pack-bag", "tidy"]);
assert.equal(assigned?.chores[1].locked, true);
assert.equal(assigned?.chores[1].waiting_on, "the washing machine, the dryer");
assert.equal(assigned?.chores[1].room_name, "Kitchen");
assert.equal(assigned?.chores[2].held_by_me, true);
assert.equal(assigned?.chores[2].assigned_to_me, true);
assert.deepEqual(assigned?.done_recently.map((chore) => chore.id), ["clean-oven"]);

const catalog = normalizeHouseholdList({
  rooms: [{
    id: "kitchen",
    name: "Kitchen",
    floor: 0,
    chores: [
      { id: "empty-bin", title: "Empty the bin", tickets: 1, claim: { child_id: "lydia", name: "Lydia", mine: true } },
      { id: "clean-window", title: "Clean the window", tickets: 9, claim: null },
      { id: "clean-oven", title: "Clean the oven", tickets: 0, can_undo: true, waiting_on: "ignored once it is done" },
    ],
  }],
}, "lydia");
assert.deepEqual(catalog?.chores.map((chore) => chore.id), ["empty-bin"]);
assert.equal(catalog?.done_recently[0].id, "clean-oven");
assert.equal(catalog?.done_recently[0].room_name, "Kitchen");
assert.equal(catalog?.done_recently[0].locked, false);

assert.equal(normalizeHouseholdList({ now: "2026-10-19T12:00:00.000Z" }, "lydia"), null);
assert.deepEqual(normalizeHouseholdList({ chores: [], done_recently: [] }, "lydia"), { chores: [], done_recently: [] });

console.log("household list ok");
