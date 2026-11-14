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
  formatOwnLine,
  joinSantaPhrases,
  lowercaseOwnLineStart,
  londonWallTimeToUtc,
  santaChild,
  santaIsOpen,
  santaLetterBlocks,
  SANTA_OPENS_EUROPE_LONDON,
  type SantaLetterSection,
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
      if (sql.includes("santa-age")) {
        const dobs: Record<string, string | null> = {
          hannah: "2017-10-07",
          lydia: "2019-04-25",
          zoe: "2020-09-12",
          ethan: "2022-03-27",
          joanna: "2025-06-20",
          pip: null,
        };
        const id = String(params[0]);
        if (!(id in dobs)) return { rows: [] };
        return { rows: [{ dob: dobs[id] }] };
      }
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

const FORBIDDEN = [
  /\bI want\b/i,
  /\bbring me\b/i,
  /\bplease get\b/i,
  /\bplease bring\b/i,
  /\bI will get\b/i,
  /\bI'll get\b/i,
  /\byou'll get\b/i,
  /\byou will get\b/i,
];

function assertGentle(text: string) {
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
  assert.doesNotMatch(text, /\bfavorite\b|\bjewelry\b|\bMom\b|\bcozy\b|\bcolor\b/i);
}

function section(childId: string, questionId: string, ids: string[], favourite: string | null): SantaLetterSection {
  const question = santaChild(childId).questions.find((item) => item.id === questionId);
  assert.ok(question, `${childId} ${questionId}`);
  return {
    questionId,
    favourite,
    picks: ids.map((id) => {
      const option = question.options.find((item) => item.id === id);
      assert.ok(option, `${childId} ${questionId} ${id}`);
      return { id, phrase: option.phrase, short: option.short, plural: option.plural === true };
    }),
  };
}

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
  assert.match(letter.letterText, /My name is Hannah and I'm 9/);
  assert.match(letter.letterText, /but music is the best of all/);
  assert.match(letter.letterText, /anything to do with Harry Potter and Hogwarts/);
  assert.match(letter.letterText, /Merry Christmas!\n\nP\.S\. The snow is sparkly\./);
  assert.match(letter.letterText, /I've drawn you a picture too!/);
  assert.match(letter.letterText, /Love from Hannah\nMerry Christmas!/);
  assertGentle(letter.letterText);
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
  const joannaLetter = (joanna.body as { letter: { letterText: string } }).letter.letterText;
  assert.match(joannaLetter, /My name is Joanna and I'm 1/);
  assert.match(joannaLetter, /A grown-up helped me write this because I'm still little/);
  assert.match(joannaLetter, /but books are the best!/);
  assert.match(joannaLetter, /Love from Joanna/);
  assertGentle(joannaLetter);

  const again = await postSantaLetter(db, "hannah", "Hannah", JSON.stringify({
    answers: { love: { picks: ["music"], favourite: null } },
    ownLine: "Second letter",
  }), "192.168.1.182", OPEN);
  assert.match(((again.body as { letter: { letterText: string } }).letter.letterText), /Second letter/);

  const latest = await getSantaLetter(db, "hannah", "Hannah", OPEN);
  const shown = (latest.body as { open: boolean; style: string; latest: { letterText: string; ownLine: string } }).latest;
  assert.equal((latest.body as { open: boolean }).open, true);
  assert.equal((latest.body as { style: string }).style, "reading");
  assert.equal((latest.body as { age: number }).age, 9);
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

test("one, two and three picks join with British grammar", () => {
  assert.equal(joinSantaPhrases(["playing outside"]), "playing outside");
  assert.equal(joinSantaPhrases(["playing outside", "playing pretend"]), "playing outside and playing pretend");
  assert.equal(
    joinSantaPhrases(["playing outside", "playing pretend", "looking after baby dolls"]),
    "playing outside, playing pretend and looking after baby dolls",
  );
  assert.equal(
    joinSantaPhrases(["building things, especially when I can make something really tall", "music and singing"]),
    "building things, especially when I can make something really tall, and music and singing",
  );
  assert.equal(
    joinSantaPhrases([
      "building things, especially when I can make something really tall",
      "arts and crafts with lots of colour",
      "music and singing",
    ]),
    "building things, especially when I can make something really tall, arts and crafts with lots of colour, and music and singing",
  );

  const one = composeSantaLetter({
    childId: "lydia",
    childName: "Lydia",
    age: 7,
    sections: [section("lydia", "jigsaws", ["both"], null)],
    ownLine: null,
    hasDrawing: false,
  });
  assert.match(one, /I love doing jigsaws and playing board games with my family\./);

  const two = composeSantaLetter({
    childId: "lydia",
    childName: "Lydia",
    age: 7,
    sections: [section("lydia", "love", ["outside", "music"], null)],
    ownLine: null,
    hasDrawing: false,
  });
  assert.match(two, /The things I love doing most are playing outside and music and singing\./);

  const three = composeSantaLetter({
    childId: "zoe",
    childName: "Zoe",
    age: 6,
    sections: [section("zoe", "love", ["outside", "pretend", "dolls"], "dolls")],
    ownLine: null,
    hasDrawing: false,
  });
  assert.match(three, /I love playing outside, playing pretend and looking after baby dolls, but baby dolls are the best\./);
  assert.doesNotMatch(three, /The things I love doing most/);
});

test("empty questions, a missing age, an own line and a drawing are handled", () => {
  const skipped = composeSantaLetter({
    childId: "lydia",
    childName: "Lydia",
    age: null,
    sections: [
      section("lydia", "love", ["music"], null),
      { questionId: "characters", picks: [], favourite: null },
      { questionId: "where", picks: [], favourite: null },
    ],
    ownLine: "   ",
    hasDrawing: false,
  });
  assert.match(skipped, /My name is Lydia\. I hope you and Mrs Claus/);
  assert.doesNotMatch(skipped, /I'm \d|I'm not 1 yet/);
  assert.match(skipped, /music and singing/);
  assert.doesNotMatch(skipped, /Harry Potter|quietly indoors|Frozen|wanted to tell you|drawn you a picture/);
  assert.doesNotMatch(skipped, /What do you love doing most\?/);

  const withNotes = composeSantaLetter({
    childId: "ethan",
    childName: "Ethan",
    age: 0,
    sections: [section("ethan", "love", ["cars"], null)],
    ownLine: "I like the snow!",
    hasDrawing: true,
  });
  assert.match(withNotes, /My name is Ethan and I'm not 1 yet\./);
  assert.match(withNotes, /P\.S\. I like the snow!/);
  assert.match(withNotes, /I've drawn you a picture too!/);
  assert.doesNotMatch(withNotes, /A grown-up helped me write this/);
  assertGentle(withNotes);

  const toddler = composeSantaLetter({
    childId: "joanna",
    childName: "Joanna",
    age: 1,
    sections: [section("joanna", "love", ["bath-toys"], "bath-toys")],
    ownLine: "Peekaboo",
    hasDrawing: true,
  });
  assert.match(toddler, /A grown-up helped me write this because I'm still little\./);
  assert.match(toddler, /I love splashing about at bath time\. Bath time is my favourite!/);
  assert.match(toddler, /P\.S\. Peekaboo!/);
  assert.match(toddler, /I've drawn you a picture too!/);
  assertGentle(toddler);
});

test("every choice has a phrase, and none of them asks for a present", () => {
  const phrases = new Map<string, string>();
  for (const childId of CHILDREN) {
    for (const question of santaChild(childId).questions) {
      assert.ok(question.options.length > 0, question.id);
      for (const option of question.options) {
        assert.ok(option.phrase.trim().length > 0, `${childId} ${option.id}`);
        assert.equal(option.phrase, option.phrase.trim());
        assert.ok(option.short.trim().length > 0, `${childId} ${option.id} short`);
        assert.equal(option.short, option.short.trim());
        assertGentle(option.phrase);
        assertGentle(option.short);
        phrases.set(`${question.id}:${option.id}`, option.phrase);
      }
      const ids = question.options.slice(0, 3).map((option) => option.id);
      for (const count of [1, 2, 3]) {
        if (ids.length < count) continue;
        const text = composeSantaLetter({
          childId,
          childName: "Sam",
          age: null,
          sections: [section(childId, question.id, ids.slice(0, count), count === 3 ? ids[0] : null)],
          ownLine: null,
          hasDrawing: false,
        });
        assertGentle(text);
        assert.match(text, /Love from Sam\nMerry Christmas!/);
      }
    }
  }
  assert.equal(phrases.get("love:building"), "building things, especially when I can make something really tall");
  assert.equal(phrases.get("jigsaws:both"), "doing jigsaws and playing board games with my family");
  assert.equal(phrases.get("characters:harry-potter"), "anything to do with Harry Potter and Hogwarts");
  assert.equal(phrases.get("love:bath-toys"), "splashing about at bath time");
});

const HANNAH_LETTER = `Dear Santa,

My name is Hannah and I'm 9. I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!

The things I love doing most are science and finding out how things work, doing jigsaws and playing board games with my family, but science is the best of all.

What makes me happy is anything to do with Harry Potter and Hogwarts, building worlds in Minecraft and catching Pokémon. Harry Potter is my very favourite thing of all.

I have such a happy time trying a little science experiment and building with LEGO. Jigsaws are a treat as well.

I like to play quietly indoors and in a den or a tunnel.

Thank you, Santa, for reading my letter. I hope you have a safe journey on Christmas Eve. I have tried to be kind and helpful this year.

Love from Hannah
Merry Christmas!

P.S. The snow is sparkly.`;

const LYDIA_LETTER = `Dear Santa,

My name is Lydia and I'm 7. I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!

The things I love doing most are building things, especially when I can make something really tall, arts and crafts with lots of colour, and music and singing, but building is the best of all.

What makes me happy is the Frozen stories with Elsa and Anna, Barbie dolls and unicorns with sparkly manes.

I love doing jigsaws and playing board games with my family.

I have such a happy time making beads, jewellery and nail art, and painting and colouring. Making jewellery is my very favourite thing of all.

It is fun to pretend, like running a little shop and having a tea party in the kitchen.

For a cosy moment, I love a story book to snuggle up with.

I've drawn you a picture too!

Thank you, Santa, for reading my letter. I hope you have a safe journey on Christmas Eve. I have tried to be kind and helpful this year.

Love from Lydia
Merry Christmas!

P.S. I have been helping Mum with the little ones.`;

const ZOE_LETTER = `Dear Santa,

My name is Zoe and I'm 6. I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!

I love playing outside, playing pretend and looking after baby dolls, but outside is the best.

It makes me smile to think about Bluey and Frozen.

A good game for me is playing board games with my family.

Making things is fun, like squishing Play-Doh or slime and painting and colouring. Play-Doh is my favourite.

I play outside in the fresh air and in the bath with lots of splashing.

At bedtime I love a soft toy to cuddle.

I've drawn you a picture too!

Thank you, Santa. Have a safe journey on Christmas Eve. I have tried to be kind and helpful.

Love from Zoe
Merry Christmas!

P.S. I like jumping in puddles.`;

const ETHAN_LETTER = `Dear Santa,

My name is Ethan and I'm 4. I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!

I love cars and trains, building things, especially when I can make something really tall, and playing outside, but cars and trains are the best.

It makes me smile to think about dinosaurs, Thomas the Tank Engine and PAW Patrol.

Making things is fun, like building with LEGO.

Pretending is fun, like being a racing driver or a train driver and being a builder. Racing is my favourite.

I play outside in the fresh air.

I've drawn you a picture too!

Thank you, Santa. Have a safe journey on Christmas Eve. I have tried to be kind and helpful.

Love from Ethan
Merry Christmas!`;

const JOANNA_LETTER = `Dear Santa,

My name is Joanna and I'm 1. A grown-up helped me write this because I'm still little. I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!

I love splashing about at bath time, looking at books and cuddling my soft toys, but books are the best!

I like Bluey, Peppa and In the Night Garden.

At bedtime I love a soft toy to cuddle.

I've drawn you a picture too!

Thank you, Santa. Have a safe journey on Christmas Eve. I try to be kind and helpful.

Love from Joanna
Merry Christmas!

P.S. Peekaboo!`;

test("a sample letter for each child", () => {
  const letters = {
    hannah: composeSantaLetter({
      childId: "hannah",
      childName: "Hannah",
      age: 9,
      sections: [
        section("hannah", "love", ["science", "jigsaws", "board-games"], "science"),
        section("hannah", "characters", ["harry-potter", "minecraft", "pokemon"], "harry-potter"),
        section("hannah", "jigsaws", ["jigsaws"], null),
        section("hannah", "make", ["science-kit", "lego"], null),
        section("hannah", "where", ["indoors", "den"], null),
      ],
      ownLine: "The snow is sparkly",
      hasDrawing: false,
    }),
    lydia: composeSantaLetter({
      childId: "lydia",
      childName: "Lydia",
      age: 7,
      sections: [
        section("lydia", "love", ["building", "arts", "music"], "building"),
        section("lydia", "characters", ["frozen", "barbie", "unicorns"], null),
        section("lydia", "jigsaws", ["both"], null),
        section("lydia", "make", ["jewellery", "painting"], "jewellery"),
        section("lydia", "pretend", ["shop", "tea-party"], null),
        section("lydia", "cosy", ["story-book"], null),
      ],
      ownLine: "I have been helping Mum with the little ones",
      hasDrawing: true,
    }),
    zoe: composeSantaLetter({
      childId: "zoe",
      childName: "Zoe",
      age: 6,
      sections: [
        section("zoe", "love", ["outside", "pretend", "dolls"], "outside"),
        section("zoe", "characters", ["bluey", "frozen"], null),
        section("zoe", "jigsaws", ["board-games"], null),
        section("zoe", "make", ["play-doh", "painting"], "play-doh"),
        section("zoe", "where", ["outside", "bath"], null),
        section("zoe", "cosy", ["soft-toy"], null),
      ],
      ownLine: "I like jumping in puddles",
      hasDrawing: true,
    }),
    ethan: composeSantaLetter({
      childId: "ethan",
      childName: "Ethan",
      age: 4,
      sections: [
        section("ethan", "love", ["cars", "building", "outside"], "cars"),
        section("ethan", "characters", ["dinosaurs", "thomas", "paw-patrol"], null),
        section("ethan", "make", ["lego"], null),
        section("ethan", "pretend", ["racing", "builder"], "racing"),
        section("ethan", "where", ["outside"], null),
      ],
      ownLine: null,
      hasDrawing: true,
    }),
    joanna: composeSantaLetter({
      childId: "joanna",
      childName: "Joanna",
      age: 1,
      sections: [
        section("joanna", "love", ["bath-toys", "books", "soft-toys"], "books"),
        section("joanna", "characters", ["bluey", "peppa", "night-garden"], null),
        section("joanna", "cosy", ["soft-toy"], null),
      ],
      ownLine: "Peekaboo",
      hasDrawing: true,
    }),
  };
  assert.equal(letters.hannah, HANNAH_LETTER);
  assert.equal(letters.lydia, LYDIA_LETTER);
  assert.equal(letters.zoe, ZOE_LETTER);
  assert.equal(letters.ethan, ETHAN_LETTER);
  assert.equal(letters.joanna, JOANNA_LETTER);
  for (const text of Object.values(letters)) {
    assertGentle(text);
    assert.match(text, /^Dear Santa,\n\nMy name is /);
    assert.match(text, /safe journey on Christmas Eve/);
    assert.match(text, /kind and helpful/);
    const blocks = santaLetterBlocks(text);
    assert.equal(blocks[0]?.kind, "salutation");
    const signoff = blocks.filter((block) => block.kind === "signoff");
    assert.equal(signoff.length, 1);
    assert.match(signoff[0]?.text ?? "", /^Love from /);
    if (text.includes("\n\nP.S. ")) assert.match(blocks.at(-1)?.text ?? "", /^P\.S\. /);
    else assert.equal(blocks.at(-1)?.kind, "signoff");
    assert.doesNotMatch(text, /because it makes me so happy/);
    assert.doesNotMatch(text, /<li>|^\s*[-*•]/m);
  }
  assert.doesNotMatch(letters.hannah, /I love doing jigsaws\./);
  assert.equal(letters.lydia.split("especially when I can make something really tall").length, 2);
  assert.doesNotMatch(letters.hannah, /I've drawn you a picture too!/);
  assert.match(letters.lydia, /I've drawn you a picture too!/);
  assert.doesNotMatch(letters.ethan, /wanted to tell you/);
  assert.doesNotMatch(letters.lydia, /quietly indoors|Harry Potter/);
  assert.match(letters.joanna, /A grown-up helped me write this because I'm still little/);
  assert.doesNotMatch(letters.hannah, /A grown-up helped me write this/);
  assert.doesNotMatch(letters.zoe, /A grown-up helped me write this/);
  const lydiaStarts = santaLetterBlocks(letters.lydia).filter((block) => block.kind === "body").map((block) => block.text.slice(0, 12));
  assert.ok(new Set(lydiaStarts).size >= 5, lydiaStarts.join(" | "));
});

test("a child with no date of birth omits their age", async () => {
  const db = memoryDb();
  const sent = await postSantaLetter(db, "pip", "Pip", JSON.stringify({
    answers: { love: { picks: ["cars"], favourite: "cars" } },
  }), null, OPEN);
  const text = (sent.body as { letter: { letterText: string } }).letter.letterText;
  assert.match(text, /My name is Pip\./);
  assert.doesNotMatch(text, /I'm \d|I'm not 1 yet/);
  assert.match(text, /Cars and trains are my favourite\./);
  assert.doesNotMatch(text, /I love cars and trains/);
  assertGentle(text);
});

test("a P.S. keeps names and I, and only lowercases an ordinary first word", () => {
  assert.equal(formatOwnLine("The snow is sparkly"), "The snow is sparkly.");
  assert.equal(formatOwnLine("the snow is sparkly"), "The snow is sparkly.");
  assert.equal(formatOwnLine("i like the snow"), "I like the snow.");
  assert.equal(formatOwnLine("Peekaboo"), "Peekaboo!");
  assert.equal(formatOwnLine("I have been helping Mum with the little ones"), "I have been helping Mum with the little ones.");
  assert.equal(formatOwnLine("Dad is funny"), "Dad is funny.");
  assert.equal(formatOwnLine("Santa is kind"), "Santa is kind.");
  assert.equal(formatOwnLine("Christmas is soon"), "Christmas is soon.");
  assert.equal(formatOwnLine("Hannah says hello"), "Hannah says hello.");
  assert.equal(lowercaseOwnLineStart("The snow is sparkly"), "the snow is sparkly");
  assert.equal(lowercaseOwnLineStart("I like the snow"), "I like the snow");
  assert.equal(lowercaseOwnLineStart("Mum helped"), "Mum helped");
  assert.equal(lowercaseOwnLineStart("Santa is kind"), "Santa is kind");
  assert.equal(lowercaseOwnLineStart("Christmas is soon"), "Christmas is soon");
  assert.equal(lowercaseOwnLineStart("Zoe laughed"), "Zoe laughed");
  assert.equal(lowercaseOwnLineStart("Ethan ran"), "Ethan ran");
  assert.equal(lowercaseOwnLineStart("Joanna waved"), "Joanna waved");
  assert.equal(lowercaseOwnLineStart("Lydia sang"), "Lydia sang");
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
