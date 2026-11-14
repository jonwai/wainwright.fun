/**
 * Letter to Santa: one place to edit who is asked what.
 *
 * The launcher asks the child identified by the device (the same child as /kid/internet).
 * Hannah and Lydia get the reading layout. Zoe, Ethan and Joanna get big picture tiles.
 * Joanna's list is only the toddler tiles below — never Ninjago, Harry Potter, Minecraft or Pokémon.
 * Science (the activity and the science kit) is Zoe, Lydia and Hannah.
 * Harry Potter is Hannah's character list only. Lydia does not get it.
 *
 * Letters open at SANTA_OPENS_EUROPE_LONDON (Europe/London wall time). That constant is the only start.
 */

/** Europe/London wall time the section and submissions open. `YYYY-MM-DDTHH:mm:ss`. */
export const SANTA_OPENS_EUROPE_LONDON = "2026-11-15T00:00:00";

export const SANTA_TIME_ZONE = "Europe/London";
export const SANTA_MAX_PICKS = 3;
export const SANTA_MAX_OWN_LINE = 240;
/** Decoded PNG bytes. A finger drawing on the small canvas stays well under this. */
export const SANTA_MAX_DRAWING_BYTES = 200 * 1024;

export type SantaStyle = "reading" | "tiles";

export interface SantaOption {
  id: string;
  label: string;
  emoji: string;
}

export interface SantaQuestion {
  id: string;
  prompt: string;
  options: SantaOption[];
}

export interface SantaChild {
  childId: string;
  style: SantaStyle;
  questions: SantaQuestion[];
}

export interface SantaPick {
  id: string;
  label: string;
  emoji: string;
}

export interface SantaStoredQuestion {
  prompt: string;
  picks: SantaPick[];
  /** Option id, or null when they didn't star one. */
  favourite: string | null;
}

export type SantaStoredAnswers = Record<string, SantaStoredQuestion>;

const LOVE: SantaOption[] = [
  { id: "building", label: "Building", emoji: "🧱" },
  { id: "arts", label: "Arts & crafts", emoji: "🎨" },
  { id: "jigsaws", label: "Jigsaws", emoji: "🧩" },
  { id: "board-games", label: "Board games", emoji: "🎲" },
  { id: "pretend", label: "Pretend play", emoji: "🎭" },
  { id: "dressing-up", label: "Dressing up & jewellery", emoji: "💍" },
  { id: "cars", label: "Cars & trains", emoji: "🚂" },
  { id: "science", label: "Science", emoji: "🔬" },
  { id: "outside", label: "Playing outside", emoji: "🌳" },
  { id: "music", label: "Music", emoji: "🎵" },
  { id: "soft-toys", label: "Soft toys & stories", emoji: "🧸" },
  { id: "dolls", label: "Looking after baby dolls", emoji: "👶" },
];

/** Older reading list. Harry Potter is removed for everyone except Hannah. */
const OLDER_CHARACTERS: SantaOption[] = [
  { id: "bluey", label: "Bluey", emoji: "🐶" },
  { id: "peppa", label: "Peppa Pig", emoji: "🐷" },
  { id: "paw-patrol", label: "PAW Patrol", emoji: "🐾" },
  { id: "ninjago", label: "Ninjago", emoji: "🥷" },
  { id: "barbie", label: "Barbie", emoji: "💖" },
  { id: "minecraft", label: "Minecraft", emoji: "⛏️" },
  { id: "frozen", label: "Frozen/Disney Princess", emoji: "❄️" },
  { id: "hot-wheels", label: "Hot Wheels", emoji: "🏎️" },
  { id: "pokemon", label: "Pokémon", emoji: "⚡" },
  { id: "harry-potter", label: "Harry Potter", emoji: "🪄" },
  { id: "spider-man", label: "Spider-Man", emoji: "🕷️" },
  { id: "dinosaurs", label: "Dinosaurs", emoji: "🦕" },
  { id: "unicorns", label: "Unicorns", emoji: "🦄" },
  { id: "gabbys", label: "Gabby's Dollhouse", emoji: "🏠" },
  { id: "sonic", label: "Sonic", emoji: "💨" },
  { id: "star-wars", label: "Star Wars", emoji: "⭐" },
];

/** Big-picture tiles for Zoe and Ethan. */
const YOUNGER_CHARACTERS: SantaOption[] = [
  { id: "bluey", label: "Bluey", emoji: "🐶" },
  { id: "peppa", label: "Peppa", emoji: "🐷" },
  { id: "paw-patrol", label: "PAW Patrol", emoji: "🐾" },
  { id: "thomas", label: "Thomas", emoji: "🚂" },
  { id: "frozen", label: "Frozen", emoji: "❄️" },
  { id: "dinosaurs", label: "Dinosaurs", emoji: "🦕" },
  { id: "unicorns", label: "Unicorns", emoji: "🦄" },
  { id: "night-garden", label: "In the Night Garden", emoji: "🌙" },
  { id: "ms-rachel", label: "Ms. Rachel", emoji: "🎤" },
  { id: "paddington", label: "Paddington/teddy", emoji: "🧸" },
];

const JIGSAW_OPTIONS: SantaOption[] = [
  { id: "jigsaws", label: "Jigsaws", emoji: "🧩" },
  { id: "board-games", label: "Board games", emoji: "🎲" },
  { id: "both", label: "Both", emoji: "✨" },
  { id: "not-really", label: "Not really", emoji: "🙂" },
];

const MAKE_OPTIONS: SantaOption[] = [
  { id: "play-doh", label: "Play-Doh or slime", emoji: "🟢" },
  { id: "painting", label: "Painting & colouring", emoji: "🖌️" },
  { id: "jewellery", label: "Beads, jewellery or nail art", emoji: "📿" },
  { id: "science-kit", label: "A science kit", emoji: "🔬" },
  { id: "lego", label: "Something with LEGO/building", emoji: "🧱" },
];

const PRETEND_OPTIONS: SantaOption[] = [
  { id: "shop", label: "Running a shop", emoji: "🏪" },
  { id: "doctor", label: "Doctor or vet", emoji: "🩺" },
  { id: "tea-party", label: "Tea party/kitchen", emoji: "🍵" },
  { id: "builder", label: "Builder", emoji: "👷" },
  { id: "racing", label: "Racing or train driver", emoji: "🏁" },
  { id: "baby", label: "Looking after a baby", emoji: "👶" },
];

const WHERE_OPTIONS: SantaOption[] = [
  { id: "outside", label: "Outside", emoji: "☀️" },
  { id: "bath", label: "In the bath", emoji: "🛁" },
  { id: "den", label: "In a den or tunnel", emoji: "⛺" },
  { id: "indoors", label: "Quietly indoors", emoji: "🛋️" },
];

const COSY_OPTIONS: SantaOption[] = [
  { id: "story-book", label: "Story book", emoji: "📖" },
  { id: "soft-toy", label: "Soft toy", emoji: "🧸" },
  { id: "musical", label: "Something musical", emoji: "🔔" },
];

/** Age 1–2. These tiles only, plus a short cosy question that fits a toddler. */
const JOANNA_LOVE: SantaOption[] = [
  { id: "shape-sorters", label: "Shape sorters", emoji: "🔷" },
  { id: "rockers", label: "Rockers & ride-ons", emoji: "🐴" },
  { id: "mega-bloks", label: "Mega Bloks / DUPLO", emoji: "🧱" },
  { id: "bath-toys", label: "Bath toys", emoji: "🛁" },
  { id: "soft-toys", label: "Soft toys", emoji: "🧸" },
  { id: "books", label: "Books", emoji: "📚" },
];

const JOANNA_CHARACTERS: SantaOption[] = [
  { id: "bluey", label: "Bluey", emoji: "🐶" },
  { id: "peppa", label: "Peppa", emoji: "🐷" },
  { id: "night-garden", label: "In the Night Garden", emoji: "🌙" },
];

function question(id: string, prompt: string, options: SantaOption[]): SantaQuestion {
  return { id, prompt, options };
}

function loveQuestion(science: boolean): SantaQuestion {
  return question(
    "love",
    "What do you love doing most?",
    science ? LOVE : LOVE.filter((option) => option.id !== "science"),
  );
}

function characterQuestion(options: SantaOption[]): SantaQuestion {
  return question("characters", "Which characters would you like?", options);
}

function jigsawQuestion(): SantaQuestion {
  return question("jigsaws", "Jigsaws or board games?", JIGSAW_OPTIONS);
}

function makeQuestion(science: boolean): SantaQuestion {
  return question(
    "make",
    "If you could make something, what would it be?",
    science ? MAKE_OPTIONS : MAKE_OPTIONS.filter((option) => option.id !== "science-kit"),
  );
}

function pretendQuestion(): SantaQuestion {
  return question("pretend", "What's fun to pretend?", PRETEND_OPTIONS);
}

function whereQuestion(): SantaQuestion {
  return question("where", "Where do you like to play?", WHERE_OPTIONS);
}

function cosyQuestion(): SantaQuestion {
  return question("cosy", "A cosy Christmas pick?", COSY_OPTIONS);
}

function reading(science: boolean, characters: SantaOption[]): SantaQuestion[] {
  return [loveQuestion(science), characterQuestion(characters), jigsawQuestion(), makeQuestion(science), pretendQuestion(), whereQuestion(), cosyQuestion()];
}

function tiles(science: boolean, characters: SantaOption[]): SantaQuestion[] {
  return reading(science, characters);
}

const HANNAH_CHARACTERS = OLDER_CHARACTERS;
const LYDIA_CHARACTERS = OLDER_CHARACTERS.filter((option) => option.id !== "harry-potter");

const CHILDREN: Record<string, { style: SantaStyle; questions: SantaQuestion[] }> = {
  hannah: { style: "reading", questions: reading(true, HANNAH_CHARACTERS) },
  lydia: { style: "reading", questions: reading(true, LYDIA_CHARACTERS) },
  zoe: { style: "tiles", questions: tiles(true, YOUNGER_CHARACTERS) },
  ethan: { style: "tiles", questions: tiles(false, YOUNGER_CHARACTERS) },
  // Toddler: skip jigsaws, making, pretend jobs and "where", which don't fit age 1–2.
  joanna: {
    style: "tiles",
    questions: [
      question("love", "What do you love playing with?", JOANNA_LOVE),
      question("characters", "Which characters would you like?", JOANNA_CHARACTERS),
      cosyQuestion(),
    ],
  },
};

/** A child with no row here gets Ethan's list (tiles, no science, no older franchises). */
const DEFAULT_CHILD = "ethan";

export function santaChild(childId: string): SantaChild {
  const spec = CHILDREN[childId] ?? CHILDREN[DEFAULT_CHILD];
  return { childId, style: spec.style, questions: spec.questions };
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function zonedPartsAsUtc(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => formatted.find((item) => item.type === type)?.value ?? "";
  let hour = Number(part("hour"));
  if (hour === 24) hour = 0;
  return Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")), hour, Number(part("minute")), Number(part("second")));
}

/** `YYYY-MM-DDTHH:mm:ss` as a Europe/London wall time, as a UTC Date. */
export function londonWallTimeToUtc(localIso: string, timeZone = SANTA_TIME_ZONE): Date {
  const match = WALL_TIME.exec(localIso);
  if (!match) throw new Error("Santa opening must be YYYY-MM-DDTHH:mm:ss Europe/London wall time");
  const wallAsUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  let utc = wallAsUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zonedPartsAsUtc(new Date(utc), timeZone) - utc;
    utc = wallAsUtc - offset;
  }
  return new Date(utc);
}

export function santaOpensAt(opensAt = SANTA_OPENS_EUROPE_LONDON): Date {
  return londonWallTimeToUtc(opensAt);
}

export function santaIsOpen(now: Date, opensAt = SANTA_OPENS_EUROPE_LONDON): boolean {
  return now.getTime() >= santaOpensAt(opensAt).getTime();
}

export interface SantaLetterSection {
  prompt: string;
  picks: { id: string; label: string }[];
  favourite: string | null;
}

/**
 * The letter they see and the letter we store. It names what they love and thanks Santa.
 * It does not promise a present.
 */
export function composeSantaLetter(childName: string, sections: SantaLetterSection[], ownLine: string | null): string {
  const name = childName.trim() || "me";
  const lines = ["Dear Santa,", "", "Here are some things I love…", ""];
  for (const section of sections) {
    if (section.picks.length === 0) continue;
    const picks = section.picks.map((pick) => (pick.id === section.favourite ? `${pick.label} (my favourite)` : pick.label));
    lines.push(section.prompt);
    lines.push(picks.join(", "));
    lines.push("");
  }
  const line = ownLine?.trim();
  if (line) {
    lines.push(line);
    lines.push("");
  }
  lines.push("Thank you for reading my letter. Merry Christmas!");
  lines.push(`Love, ${name}`);
  return lines.join("\n");
}

export interface ValidatedSantaAnswers {
  answers: SantaStoredAnswers;
  ownLine: string | null;
  letterText: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Checks picks against this child's questions. At most three picks, and the favourite
 * (if they starred one) is one of those picks. Drawing is checked separately on the server.
 */
export function validateSantaAnswers(childId: string, childName: string, input: unknown): ValidatedSantaAnswers | { error: string } {
  const body = asRecord(input);
  if (!body) return { error: "Send the answers as JSON" };
  const rawAnswers = body.answers == null ? {} : asRecord(body.answers);
  if (!rawAnswers) return { error: "Answers have to be a list of questions" };
  const child = santaChild(childId);
  const byId = new Map(child.questions.map((item) => [item.id, item]));
  const answers: SantaStoredAnswers = {};
  const sections: SantaLetterSection[] = [];

  for (const [questionId, raw] of Object.entries(rawAnswers)) {
    const questionSpec = byId.get(questionId);
    if (!questionSpec) return { error: "That isn't one of the questions" };
    const answer = asRecord(raw);
    if (!answer) return { error: "Each answer needs the picks you chose" };
    if (!Array.isArray(answer.picks)) return { error: "Each answer needs the picks you chose" };
    if (answer.picks.length > SANTA_MAX_PICKS) return { error: "Pick up to 3 for each question" };
    const optionById = new Map(questionSpec.options.map((option) => [option.id, option]));
    const picks: SantaPick[] = [];
    const seen = new Set<string>();
    for (const pick of answer.picks) {
      if (typeof pick !== "string" || !optionById.has(pick)) return { error: "That isn't one of the choices" };
      if (seen.has(pick)) return { error: "Pick each choice once" };
      seen.add(pick);
      const option = optionById.get(pick)!;
      picks.push({ id: option.id, label: option.label, emoji: option.emoji });
    }
    let favourite: string | null = null;
    if (answer.favourite != null && answer.favourite !== "") {
      if (typeof answer.favourite !== "string") return { error: "Star one favourite" };
      if (!seen.has(answer.favourite)) return { error: "The favourite has to be one of the ones you picked" };
      favourite = answer.favourite;
    }
    if (picks.length === 0) continue;
    answers[questionId] = { prompt: questionSpec.prompt, picks, favourite };
  }

  for (const questionSpec of child.questions) {
    const stored = answers[questionSpec.id];
    if (!stored) continue;
    sections.push({ prompt: stored.prompt, picks: stored.picks, favourite: stored.favourite });
  }
  if (sections.length === 0) return { error: "Choose at least one thing you love" };

  let ownLine: string | null = null;
  if (body.ownLine != null && body.ownLine !== "") {
    if (typeof body.ownLine !== "string") return { error: "Your own line has to be text" };
    const cleaned = body.ownLine.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length > SANTA_MAX_OWN_LINE) return { error: "Your own line is too long" };
    ownLine = cleaned || null;
  }

  return {
    answers,
    ownLine,
    letterText: composeSantaLetter(childName, sections, ownLine),
  };
}
