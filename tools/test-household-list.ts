/**
 * Household kid list as of household main 06ce9a8, plus the planned
 * `chores` and `done_recently` fields.
 *
 * Run: npx tsx tools/test-household-list.ts
 */

import assert from "node:assert/strict";
import { normalizeHouseholdList } from "../packages/local/src/household-chores.ts";

const NOW = "2026-10-19T12:00:00.000Z";
const WITHIN = "2026-10-19T11:00:00.000Z";
const EDGE = "2026-10-18T12:00:00.000Z";
const TOO_OLD = "2026-10-18T11:59:59.000Z";

const rooms = normalizeHouseholdList({
  child: { id: "lydia", name: "Lydia" },
  now: NOW,
  rooms: [{
    id: "kitchen",
    name: "Kitchen",
    floor: 0,
    chores: [
      {
        id: "empty-bin",
        title: "Empty the bin",
        tickets: 2,
        place_name: "Bin",
        claim: { child_id: "lydia", name: "Lydia", mine: true, auto_assigned: false },
        locked: false,
        waiting_on: [],
      },
      {
        id: "pack-bag",
        title: "Pack the school bag",
        tickets: 1,
        claim: { child_id: "lydia", name: "Lydia", mine: true, auto_assigned: true },
        locked: true,
        waiting_on: ["the washing machine", "the dryer"],
      },
      { id: "clean-window", title: "Clean the window", tickets: 9, claim: null, waiting_on: { title: "not a list" } },
      { id: "wipe-sink", title: "Wipe the sink", tickets: 1, claim: { child_id: "hannah", name: "Hannah", mine: false } },
      { id: "tidy", title: "Tidy the playroom", tickets: 4, claim: null, held: true, held_by: "Lydia" },
      {
        id: "clean-oven",
        title: "Clean the oven",
        tickets: 0,
        place_name: "Oven",
        claim: null,
        can_undo: true,
        last_completed_at: WITHIN,
        last_completed_by: "Lydia",
        last_completed_by_me: true,
      },
      {
        id: "old-job",
        title: "An old job",
        tickets: 0,
        claim: null,
        can_undo: true,
        last_completed_at: TOO_OLD,
        last_completed_by_me: true,
      },
      {
        id: "edge-job",
        title: "Just inside a day",
        tickets: 0,
        claim: null,
        last_completed_at: EDGE,
        last_completed_by_me: true,
      },
    ],
  }],
}, "lydia");

assert.deepEqual(rooms?.chores.map((chore) => chore.id), ["empty-bin", "pack-bag"]);
assert.equal(rooms?.chores[0].room_name, "Kitchen");
assert.equal(rooms?.chores[0].place_name, "Bin");
assert.equal(rooms?.chores[0].tickets, 2);
assert.equal(rooms?.chores[0].claim?.mine, true);
assert.equal(rooms?.chores[0].auto_assigned, false);
assert.equal(rooms?.chores[0].assigned_to_me, true);
assert.equal(rooms?.chores[1].locked, true);
assert.equal(rooms?.chores[1].waiting_on, "the washing machine, the dryer");
assert.equal(rooms?.chores[1].auto_assigned, true);
assert.equal(rooms?.chores[1].claim?.auto_assigned, true);
assert.deepEqual(rooms?.done_recently.map((chore) => chore.id), ["clean-oven", "edge-job"]);
assert.equal(rooms?.done_recently[0].room_name, "Kitchen");
assert.equal(rooms?.done_recently[0].can_undo, true);
assert.equal(rooms?.done_recently[0].last_completed_at, WITHIN);

const planned = normalizeHouseholdList({
  child: { id: "lydia", name: "Lydia" },
  now: NOW,
  rooms: [{
    id: "kitchen",
    name: "Kitchen",
    floor: 0,
    chores: [
      { id: "clean-window", title: "Clean the window", tickets: 9, claim: null },
      {
        id: "clean-oven",
        title: "Clean the oven",
        tickets: 0,
        claim: null,
        last_completed_at: WITHIN,
        last_completed_by_me: true,
      },
    ],
  }],
  chores: [
    {
      id: "empty-bin",
      title: "Empty the bin",
      tickets: 2,
      room_id: "kitchen",
      room_name: "Kitchen",
      claim: { child_id: "lydia", name: "Lydia", mine: true, auto_assigned: false },
      locked: true,
      waiting_on: ["the bin bag"],
    },
    { id: "clean-oven", title: "Clean the oven", tickets: 3, room_name: "Kitchen", claim: { child_id: "lydia", name: "Lydia", mine: true } },
  ],
  done_recently: [
    {
      chore_id: "hoover-bathroom",
      title: "Hoover the bathroom",
      room_id: "bathroom",
      room_name: "Bathroom",
      completed_at: WITHIN,
      tickets: 2,
      auto_done: true,
      can_undo: true,
    },
    { chore_id: "clean-oven", title: "Clean the oven", room_name: "Kitchen", completed_at: WITHIN, tickets: 0, auto_done: false, can_undo: false },
  ],
  doneRecently: [{ chore_id: "ignored", title: "Ignored camelCase list", completed_at: WITHIN, tickets: 1, can_undo: false }],
}, "lydia");

assert.deepEqual(planned?.chores.map((chore) => chore.id), ["empty-bin", "clean-oven"]);
assert.equal(planned?.chores[0].room_name, "Kitchen");
assert.equal(planned?.chores[0].waiting_on, "the bin bag");
assert.equal(planned?.chores[0].locked, true);
assert.equal(planned?.chores[0].assigned_to_me, true);
assert.deepEqual(planned?.done_recently.map((chore) => [chore.id, chore.room_name, chore.tickets, chore.auto_done, chore.can_undo]), [
  ["hoover-bathroom", "Bathroom", 2, true, true],
]);
assert.equal(planned?.done_recently[0].last_completed_at, WITHIN);
assert.equal(planned?.done_recently.some((chore) => chore.id === "ignored"), false);
assert.equal(planned?.chores.some((chore) => chore.id === "clean-window"), false);

assert.equal(normalizeHouseholdList({ now: NOW, doneRecently: [] }, "lydia"), null);
assert.deepEqual(normalizeHouseholdList({ chores: [], done_recently: [], now: NOW }, "lydia"), { chores: [], done_recently: [] });

console.log("household list ok");
