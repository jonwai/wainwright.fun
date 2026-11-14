/**
 * Letter to Santa without Postgres: opening time in Europe/London, each child's choices,
 * pick/favourite checks, the stored letter, and the admin list. The HTTP round trip is in
 * sites.integration.test.ts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { HttpError } from "../src/app.ts";
import { getSantaLetter, listSantaLetters, postSantaLetter } from "../src/santa.ts";
import {
  composeSantaLetter,
  londonWallTimeToUtc,
  santaChild,
  santaIsOpen,
  SANTA_OPENS_EUROPE_LONDON,
} from "../src/santa-catalog.ts";
import type { Queryable } from "../src/pg-ddb.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const OPEN = new Date("2026-11-16T08:00:00.000Z");
const CLOSED = new Date("2026-11-14T23:59:59.000Z");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CHILDREN = ["hannah", "lydia", "zoe", "ethan", "joanna"] as const;

function optionIds(childId: string): string[] {
  return santaChild(childId).questions.flatMap((question) => question.options.map((option) => option.id));
}

function questionIds(childId: string, questionId: string): string[] {
  return santaChild(childId).questions.find((question) => question.id === questionId)?.options.map((option) => option.id) ?? [];
}

interface Memory extends Queryable {
  letters: Record<string, unknown>[];
  queries: number;
}

function memoryDb(): Memory {
  const letters: Record<string, unknown>[] = [];
  let id = 0;
  const db: Memory = {
    letters,
    queries: 0,
    async query(sql: string, params: unknown[] = []) {
      db.queries += 1;
      if (sql.includes("santa-insert")) {
        id += 1;
        const row = {
          id,
          child_id: params[0],
          submitted_at: new Date(Date.UTC(2026, 10, 16, 12, id, 0)),
          answers: JSON.parse(String(params[1])),
          own_line: params[2],
          drawing_png: params[3],
          letter_text: params[4],
          client_ip: params[5],
        };
        letters.push(row);
        return { rows: [row] };
      }
      if (sql.includes("santa-latest")) {
        const mine = letters.filter((row) => row.child_id === params[0]);
        return { rows: mine.length ? [mine[mine.length - 1]] : [] };
      }
      if (sql.includes("santa-children")) {
        return {
          rows: [
            { id: "hannah", display_name: "Hannah" },
            { id: "lydia", display_name: "Lydia" },
            { id: "zoe", display_name: "Zoe" },
            { id: "ethan", display_name: "Ethan" },
            { id: "joanna", display_name: "Joanna" },
          ],
        };
      }
      if (sql.includes("santa-all")) return { rows: [...letters].reverse() };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  return db;
}

async function rejects(status: number, fn: () => Promise<unknown>) {
  await assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    return true;
  });
}

test("letters open at 15 Nov 2026 00:00 Europe/London and not a moment before", () => {
  assert.equal(SANTA_OPENS_EUROPE_LONDON, "2026-11-15T00:00:00");
  assert.equal(londonWallTimeToUtc(SANTA_OPENS_EUROPE_LONDON).toISOString(), "2026-11-15T00:00:00.000Z");
  // July is British Summer Time (UTC+1), so the helper is not hard-coded to GMT.
  assert.equal(londonWallTimeToUtc("2026-07-01T00:00:00").toISOString(), "2026-06-30T23:00:00.000Z");
  assert.equal(londonWallTimeToUtc("2026-01-15T00:00:00").toISOString(), "2026-01-15T00:00:00.000Z");
  assert.equal(santaIsOpen(CLOSED), false);
  assert.equal(santaIsOpen(new Date("2026-11-14T23:00:00.000Z")), false);
  assert.equal(santaIsOpen(new Date("2026-11-15T00:00:00.000Z")), true);
  assert.equal(santaIsOpen(OPEN), true);
  assert.equal(santaIsOpen(new Date("2026-06-30T22:59:59.000Z"), "2026-07-01T00:00:00"), false);
  assert.equal(santaIsOpen(new Date("2026-06-30T23:00:00.000Z"), "2026-07-01T00:00:00"), true);
});

test("each child gets their own choices", () => {
  assert.equal(santaChild("hannah").style, "reading");
  assert.equal(santaChild("lydia").style, "reading");
  for (const child of ["zoe", "ethan", "joanna"] as const) assert.equal(santaChild(child).style, "tiles");

  assert.equal(questionIds("hannah", "characters").includes("harry-potter"), true);
  for (const child of CHILDREN) {
    if (child === "hannah") continue;
    assert.equal(optionIds(child).includes("harry-potter"), false, child);
  }

  for (const child of ["zoe", "lydia", "hannah"] as const) {
    assert.equal(questionIds(child, "love").includes("science"), true, child);
    assert.equal(questionIds(child, "make").includes("science-kit"), true, child);
  }
  for (const child of ["ethan", "joanna"] as const) {
    assert.equal(optionIds(child).includes("science"), false, child);
    assert.equal(optionIds(child).includes("science-kit"), false, child);
  }

  const joanna = optionIds("joanna");
  for (const id of ["shape-sorters", "rockers", "mega-bloks", "bath-toys", "soft-toys", "books", "bluey", "peppa", "night-garden"]) {
    assert.equal(joanna.includes(id), true, id);
  }
  assert.deepEqual(santaChild("joanna").questions.map((question) => question.id), ["love", "characters", "cosy"]);
  for (const question of santaChild("joanna").questions) {
    for (const option of question.options) {
      assert.doesNotMatch(`${option.id} ${option.label}`, /ninjago|harry potter|minecraft|pokémon|pokemon/i);
    }
  }
  for (const id of ["ninjago", "minecraft", "pokemon", "harry-potter", "spider-man"]) {
    assert.equal(questionIds("zoe", "characters").includes(id), false, id);
    assert.equal(questionIds("ethan", "characters").includes(id), false, id);
    assert.equal(questionIds("lydia", "characters").includes(id), id === "harry-potter" ? false : true, id);
  }
  assert.equal(questionIds("hannah", "love").includes("dressing-up"), true);
  assert.equal(questionIds("lydia", "make").includes("jewellery"), true);
});

test("the letter thanks Santa and does not promise a present", () => {
  const text = composeSantaLetter(
    "Hannah",
    [{ prompt: "What do you love doing most?", picks: [{ id: "building", label: "Building" }, { id: "music", label: "Music" }], favourite: "music" }],
    "The snow is sparkly",
  );
  assert.match(text, /^Dear Santa,/);
  assert.match(text, /Here are some things I love…/);
  assert.match(text, /Building, Music \(my favourite\)/);
  assert.match(text, /The snow is sparkly/);
  assert.match(text, /Thank you for reading my letter\. Merry Christmas!/);
  assert.match(text, /Love, Hannah$/);
  assert.doesNotMatch(text, /I will get|I'll get|you will get|you'll get|I want you to bring/i);
});

test("the server hides the letter before opening day and refuses a send", async () => {
  const db = memoryDb();
  const closed = await getSantaLetter(db, "hannah", "Hannah", CLOSED);
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body, { open: false });
  assert.equal(db.queries, 0);
  await rejects(403, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({ answers: { love: { picks: ["building"] } } }), "192.168.1.182", CLOSED));
  assert.equal(db.letters.length, 0);
  assert.equal(db.queries, 0);
});

test("three picks and one favourite are stored, a fourth pick or a second favourite is not", async () => {
  const db = memoryDb();
  const body = {
    answers: {
      love: { picks: ["building", "music", "arts"], favourite: "music" },
      characters: { picks: ["harry-potter"], favourite: null },
    },
    ownLine: "  The snow is sparkly  ",
    drawing: PNG,
  };
  const sent = await postSantaLetter(db, "hannah", "Hannah", JSON.stringify(body), "192.168.1.182", OPEN);
  assert.equal(sent.status, 200);
  const letter = (sent.body as { letter: { letterText: string; ownLine: string; drawingPng: string; clientIp?: string; answers: Record<string, { favourite: string | null }> } }).letter;
  assert.equal(letter.clientIp, undefined);
  assert.equal(letter.ownLine, "The snow is sparkly");
  assert.match(letter.letterText, /Music \(my favourite\)/);
  assert.match(letter.letterText, /Harry Potter/);
  assert.match(letter.letterText, /Love, Hannah/);
  assert.doesNotMatch(letter.letterText, /I will get|I'll get|you'll get/i);
  assert.match(letter.drawingPng, /^data:image\/png;base64,/);
  assert.equal(db.letters.length, 1);
  assert.equal(db.letters[0].client_ip, "192.168.1.182");

  await rejects(400, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["building", "music", "arts", "jigsaws"], favourite: "music" } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["building"], favourite: "music" } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["building"], favourite: ["building", "music"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({ answers: {} }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "lydia", "Lydia", JSON.stringify({
    answers: { characters: { picks: ["harry-potter"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "ethan", "Ethan", JSON.stringify({
    answers: { love: { picks: ["science"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "ethan", "Ethan", JSON.stringify({
    answers: { make: { picks: ["science-kit"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "joanna", "Joanna", JSON.stringify({
    answers: { characters: { picks: ["ninjago"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "joanna", "Joanna", JSON.stringify({
    answers: { characters: { picks: ["harry-potter"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "joanna", "Joanna", JSON.stringify({
    answers: { love: { picks: ["minecraft"] } },
  }), null, OPEN));
  await rejects(400, () => postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["building"] } },
    drawing: "data:image/png;base64,AAAA",
  }), null, OPEN));
  assert.equal(db.letters.length, 1, "rejected sends are not stored");

  const zoe = await postSantaLetter(db, "zoe", "Zoe", JSON.stringify({
    answers: { love: { picks: ["science"], favourite: "science" }, make: { picks: ["science-kit"] } },
  }), null, OPEN);
  assert.equal(zoe.status, 200);
  const joanna = await postSantaLetter(db, "joanna", "Joanna", JSON.stringify({
    answers: { love: { picks: ["shape-sorters", "books"], favourite: "books" }, characters: { picks: ["bluey", "peppa", "night-garden"] } },
  }), null, OPEN);
  assert.equal(joanna.status, 200);

  const again = await postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["music"], favourite: null } },
    ownLine: "Second letter",
  }), "192.168.1.182", OPEN);
  assert.match(((again.body as { letter: { letterText: string } }).letter.letterText), /Second letter/);

  const latest = await getSantaLetter(db, "hannah", "Hannah", OPEN);
  const shown = (latest.body as { open: boolean; style: string; latest: { letterText: string; ownLine: string } }).latest;
  assert.equal((latest.body as { open: boolean }).open, true);
  assert.equal((latest.body as { style: string }).style, "reading");
  assert.match(shown.letterText, /Second letter/);
  assert.equal(shown.ownLine, "Second letter");

  const admin = await listSantaLetters(db);
  const rows = (admin.body as { letters: { childId: string; submissions: number; latest: { letterText: string; clientIp: string | null; answers: Record<string, { favourite: string | null }> } | null }[] }).letters;
  const hannah = rows.find((row) => row.childId === "hannah");
  assert.equal(hannah?.submissions, 2);
  assert.match(hannah?.latest?.letterText ?? "", /Second letter/);
  assert.equal(hannah?.latest?.clientIp, "192.168.1.182");
  assert.equal(rows.find((row) => row.childId === "lydia")?.latest, null);
  assert.equal(rows.find((row) => row.childId === "joanna")?.submissions, 1);
  assert.equal(rows.find((row) => row.childId === "zoe")?.latest?.answers.love.favourite, "science");
});

test("the santa pages and styles stay on this site", async () => {
  const files = [
    "apps/kids/index.html",
    "apps/kids/index.css",
    "apps/kids/components/SantaLetter.tsx",
    "apps/admin/local-admin.html",
    "apps/admin/src/SantaLettersPanel.tsx",
    "packages/local/src/santa-catalog.ts",
  ];
  for (const relative of files) {
    const text = await readFile(path.join(root, relative), "utf8");
    assert.equal(/https?:\/\//i.test(text), false, relative);
    assert.equal(text.includes("fonts.googleapis.com"), false, relative);
    assert.equal(text.includes("fonts.gstatic.com"), false, relative);
  }
  const css = await readFile(path.join(root, "apps/kids/index.css"), "utf8");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.santa-flake,\s*\n\s*\.santa-twinkle \{\s*\n\s*animation:\s*none/);
});
