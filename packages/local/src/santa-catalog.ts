/**
 * Letter to Santa: one place to edit who is asked what, and the words each choice
 * becomes in the letter.
 *
 * The launcher asks the child identified by the device (the same child as /kid/internet).
 * Hannah and Lydia get the reading layout. Zoe, Ethan and Joanna get big picture tiles.
 * Joanna's list is only the toddler tiles below — never Ninjago, Harry Potter, Minecraft or Pokémon.
 * Science (the activity and the science kit) is Zoe, Lydia and Hannah.
 * Harry Potter is Hannah's character list only. Lydia does not get it.
 *
 * Each option has a `phrase` (the child-like words joined as "A, B and C") and a `short`
 * name for the favourite line ("building", "Harry Potter"). A phrase is a fragment, not a
 * request, so it can sit after "I love" without asking Santa to bring anything.
 *
 * Letters open at SANTA_OPENS_EUROPE_LONDON (Europe/London wall time). That constant is the only start.
 * `composeSantaLetter` is the only letter. The on-screen preview and `letter_text` both call it.
 */

/** Europe/London wall time the section and submissions open. `YYYY-MM-DDTHH:mm:ss`. */
export const SANTA_OPENS_EUROPE_LONDON = "2026-11-15T00:00:00";

export const SANTA_TIME_ZONE = "Europe/London";
export const SANTA_MAX_PICKS = 3;
export const SANTA_MAX_OWN_LINE = 240;
/** Decoded PNG bytes. A finger drawing on the small canvas stays well under this. */
export const SANTA_MAX_DRAWING_BYTES = 200 * 1024;

export type SantaStyle = "reading" | "tiles";
/** Hannah and Lydia write a fuller letter. Zoe and Ethan write shorter sentences. Joanna is a toddler. */
export type SantaVoice = "older" | "younger" | "toddler";

export interface SantaOption {
  id: string;
  label: string;
  emoji: string;
  /** Words for the letter. A fragment that can be joined with other picks. */
  phrase: string;
  /** Short name used when this choice is the starred favourite. */
  short: string;
  /** True when `short` takes "are" ("jigsaws are") rather than "is". */
  plural?: boolean;
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

function choice(id: string, label: string, emoji: string, phrase: string, short: string, plural = false): SantaOption {
  return { id, label, emoji, phrase, short, plural };
}

const LOVE: SantaOption[] = [
  choice("building", "Building", "🧱", "building things, especially when I can make something really tall", "building"),
  choice("arts", "Arts & crafts", "🎨", "arts and crafts with lots of colour", "arts and crafts", true),
  choice("jigsaws", "Jigsaws", "🧩", "doing jigsaws", "jigsaws", true),
  choice("board-games", "Board games", "🎲", "playing board games with my family", "board games", true),
  choice("pretend", "Pretend play", "🎭", "playing pretend", "pretend play"),
  choice("dressing-up", "Dressing up & jewellery", "💍", "dressing up and wearing jewellery", "dressing up"),
  choice("cars", "Cars & trains", "🚂", "cars and trains", "cars and trains", true),
  choice("science", "Science", "🔬", "science and finding out how things work", "science"),
  choice("outside", "Playing outside", "🌳", "playing outside", "outside"),
  choice("music", "Music", "🎵", "music and singing", "music"),
  choice("soft-toys", "Soft toys & stories", "🧸", "soft toys and bedtime stories", "soft toys", true),
  choice("dolls", "Looking after baby dolls", "👶", "looking after baby dolls", "baby dolls", true),
];

/** Older reading list. Harry Potter is removed for everyone except Hannah. */
const OLDER_CHARACTERS: SantaOption[] = [
  choice("bluey", "Bluey", "🐶", "Bluey and her family", "Bluey"),
  choice("peppa", "Peppa Pig", "🐷", "Peppa Pig and muddy puddles", "Peppa Pig"),
  choice("paw-patrol", "PAW Patrol", "🐾", "PAW Patrol on a rescue", "PAW Patrol"),
  choice("ninjago", "Ninjago", "🥷", "the Ninjago ninjas", "Ninjago"),
  choice("barbie", "Barbie", "💖", "Barbie dolls", "Barbie"),
  choice("minecraft", "Minecraft", "⛏️", "building worlds in Minecraft", "Minecraft"),
  choice("frozen", "Frozen/Disney Princess", "❄️", "the Frozen stories with Elsa and Anna", "Frozen"),
  choice("hot-wheels", "Hot Wheels", "🏎️", "racing Hot Wheels cars", "Hot Wheels"),
  choice("pokemon", "Pokémon", "⚡", "catching Pokémon", "Pokémon"),
  choice("harry-potter", "Harry Potter", "🪄", "anything to do with Harry Potter and Hogwarts", "Harry Potter"),
  choice("spider-man", "Spider-Man", "🕷️", "Spider-Man swinging about", "Spider-Man"),
  choice("dinosaurs", "Dinosaurs", "🦕", "dinosaurs especially the enormous ones", "dinosaurs", true),
  choice("unicorns", "Unicorns", "🦄", "unicorns with sparkly manes", "unicorns", true),
  choice("gabbys", "Gabby's Dollhouse", "🏠", "Gabby's Dollhouse", "Gabby's Dollhouse"),
  choice("sonic", "Sonic", "💨", "Sonic speeding along", "Sonic"),
  choice("star-wars", "Star Wars", "⭐", "Star Wars and the Jedi", "Star Wars"),
];

/** Big-picture tiles for Zoe and Ethan. */
const YOUNGER_CHARACTERS: SantaOption[] = [
  choice("bluey", "Bluey", "🐶", "Bluey", "Bluey"),
  choice("peppa", "Peppa", "🐷", "Peppa", "Peppa"),
  choice("paw-patrol", "PAW Patrol", "🐾", "PAW Patrol", "PAW Patrol"),
  choice("thomas", "Thomas", "🚂", "Thomas the Tank Engine", "Thomas"),
  choice("frozen", "Frozen", "❄️", "Frozen", "Frozen"),
  choice("dinosaurs", "Dinosaurs", "🦕", "dinosaurs", "dinosaurs", true),
  choice("unicorns", "Unicorns", "🦄", "unicorns", "unicorns", true),
  choice("night-garden", "In the Night Garden", "🌙", "In the Night Garden", "In the Night Garden"),
  choice("ms-rachel", "Ms. Rachel", "🎤", "Ms Rachel", "Ms Rachel"),
  choice("paddington", "Paddington/teddy", "🧸", "Paddington", "Paddington"),
];

const JIGSAW_OPTIONS: SantaOption[] = [
  choice("jigsaws", "Jigsaws", "🧩", "doing jigsaws", "jigsaws", true),
  choice("board-games", "Board games", "🎲", "playing board games with my family", "board games", true),
  choice("both", "Both", "✨", "doing jigsaws and playing board games with my family", "jigsaws and board games", true),
  choice("not-really", "Not really", "🙂", "having a break from jigsaws and board games", "something else"),
];

const MAKE_OPTIONS: SantaOption[] = [
  choice("play-doh", "Play-Doh or slime", "🟢", "squishing Play-Doh or slime", "Play-Doh"),
  choice("painting", "Painting & colouring", "🖌️", "painting and colouring", "painting"),
  choice("jewellery", "Beads, jewellery or nail art", "📿", "making beads, jewellery and nail art", "making jewellery"),
  choice("science-kit", "A science kit", "🔬", "trying a little science experiment", "science"),
  choice("lego", "Something with LEGO/building", "🧱", "building with LEGO", "LEGO"),
];

const PRETEND_OPTIONS: SantaOption[] = [
  choice("shop", "Running a shop", "🏪", "running a little shop", "running a shop"),
  choice("doctor", "Doctor or vet", "🩺", "being a doctor or a vet", "being a doctor"),
  choice("tea-party", "Tea party/kitchen", "🍵", "having a tea party in the kitchen", "a tea party"),
  choice("builder", "Builder", "👷", "being a builder", "being a builder"),
  choice("racing", "Racing or train driver", "🏁", "being a racing driver or a train driver", "racing"),
  choice("baby", "Looking after a baby", "👶", "looking after a baby", "looking after a baby"),
];

const WHERE_OPTIONS: SantaOption[] = [
  choice("outside", "Outside", "☀️", "outside in the fresh air", "outside"),
  choice("bath", "In the bath", "🛁", "in the bath with lots of splashing", "the bath"),
  choice("den", "In a den or tunnel", "⛺", "in a den or a tunnel", "a den"),
  choice("indoors", "Quietly indoors", "🛋️", "quietly indoors", "quiet time"),
];

const COSY_OPTIONS: SantaOption[] = [
  choice("story-book", "Story book", "📖", "a story book to snuggle up with", "a story book"),
  choice("soft-toy", "Soft toy", "🧸", "a soft toy to cuddle", "a soft toy"),
  choice("musical", "Something musical", "🔔", "something musical to sing along with", "music"),
];

/** Age 1–2. These tiles only, plus a short cosy question that fits a toddler. */
const JOANNA_LOVE: SantaOption[] = [
  choice("shape-sorters", "Shape sorters", "🔷", "posting shapes in the shape sorter", "shape sorters", true),
  choice("rockers", "Rockers & ride-ons", "🐴", "rocking and riding", "rocking"),
  choice("mega-bloks", "Mega Bloks / DUPLO", "🧱", "stacking Mega Bloks and DUPLO", "Mega Bloks", true),
  choice("bath-toys", "Bath toys", "🛁", "splashing about at bath time", "bath time"),
  choice("soft-toys", "Soft toys", "🧸", "cuddling my soft toys", "soft toys", true),
  choice("books", "Books", "📚", "looking at books", "books", true),
];

const JOANNA_CHARACTERS: SantaOption[] = [
  choice("bluey", "Bluey", "🐶", "Bluey", "Bluey"),
  choice("peppa", "Peppa", "🐷", "Peppa", "Peppa"),
  choice("night-garden", "In the Night Garden", "🌙", "In the Night Garden", "In the Night Garden"),
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

export function santaVoice(childId: string): SantaVoice {
  if (childId === "joanna") return "toddler";
  if (childId === "hannah" || childId === "lydia") return "older";
  return "younger";
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

export interface SantaLetterPick {
  id: string;
  phrase: string;
  /** Short favourite name. Falls back to the phrase when a caller omits it. */
  short?: string;
  plural?: boolean;
}

export interface SantaLetterSection {
  questionId: string;
  picks: SantaLetterPick[];
  /** Option id, or null when they didn't star one. */
  favourite: string | null;
}

export interface SantaLetterDraft {
  childId: string;
  childName: string;
  /** Whole years from `core.people.date_of_birth`, or null when that date is missing. */
  age: number | null;
  sections: SantaLetterSection[];
  ownLine: string | null;
  hasDrawing: boolean;
}

export interface SantaLetterBlock {
  kind: "salutation" | "body" | "signoff";
  text: string;
}

/** British list: "A", "A and B", "A, B and C". A comma inside a phrase gets a pause before "and". */
export function joinSantaPhrases(phrases: string[]): string {
  const items = phrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  const needsPause = items.some((item) => item.includes(","));
  if (items.length === 2) return needsPause ? `${items[0]}, and ${items[1]}` : `${items[0]} and ${items[1]}`;
  const head = items.slice(0, -1).join(", ");
  return needsPause ? `${head}, and ${items[items.length - 1]}` : `${head} and ${items[items.length - 1]}`;
}

type Opener = (list: string) => string;

/** Different first words for each question, so a full letter does not start every paragraph the same way. */
const OPENERS: Record<SantaVoice, Record<string, Opener>> = {
  older: {
    love: (list) => `The things I love doing most are ${list}.`,
    characters: (list) => `What makes me happy is ${list}.`,
    jigsaws: (list) => `I love ${list}.`,
    make: (list) => `I have such a happy time ${list}.`,
    pretend: (list) => `It is fun to pretend, like ${list}.`,
    where: (list) => `I like to play ${list}.`,
    cosy: (list) => `For a cosy moment, I love ${list}.`,
  },
  younger: {
    love: (list) => `I love ${list}.`,
    characters: (list) => `It makes me smile to think about ${list}.`,
    jigsaws: (list) => `A good game for me is ${list}.`,
    make: (list) => `Making things is fun, like ${list}.`,
    pretend: (list) => `Pretending is fun, like ${list}.`,
    where: (list) => `I play ${list}.`,
    cosy: (list) => `At bedtime I love ${list}.`,
  },
  toddler: {
    love: (list) => `I love ${list}.`,
    characters: (list) => `I like ${list}.`,
    cosy: (list) => `At bedtime I love ${list}.`,
  },
};

const HOPE = "I hope you and Mrs Claus and all the reindeer are keeping warm at the North Pole!";

function tidyName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "me";
}

function nameSentence(name: string, age: number | null): string {
  if (age == null || !Number.isInteger(age) || age < 0) return `My name is ${name}.`;
  if (age === 0) return `My name is ${name} and I'm not 1 yet.`;
  return `My name is ${name} and I'm ${age}.`;
}

function capFirst(text: string): string {
  if (!text || /^[A-Z0-9]/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pickShort(pick: SantaLetterPick): { short: string; plural: boolean } {
  const short = (pick.short?.trim() || pick.phrase).trim();
  return { short, plural: pick.plural === true };
}

/** Words we never lowercase, even mid-sentence: the child, the family, and Christmas. */
const KEEP_CAPITAL = /^(I|I'm|I'll|I'd|I've|Mum|Dad|Mummy|Daddy|Santa|Christmas|Hannah|Lydia|Zoe|Ethan|Joanna)$/;

/**
 * For a line woven into a sentence, lowercase the first letter only when that word
 * is an ordinary word. "I", "Mum", "Santa" and the children's names stay as they are.
 */
export function lowercaseOwnLineStart(line: string): string {
  const match = /^([A-Za-z][A-Za-z']*)([\s\S]*)$/.exec(line);
  if (!match) return line;
  const [word, rest] = [match[1], match[2]];
  if (KEEP_CAPITAL.test(word) || KEEP_CAPITAL.test(word[0].toUpperCase() + word.slice(1))) return line;
  if (word !== word[0].toUpperCase() + word.slice(1).toLowerCase() && word !== word.toUpperCase()) return line;
  // A single capital (The, Snow) can become a common word. All-caps and CamelCase stay.
  if (word === word.toUpperCase() && word.length > 1) return line;
  return word.charAt(0).toLowerCase() + word.slice(1) + rest;
}

function withTerminalPunctuation(line: string): string {
  if (/[.!?]$/.test(line)) return line;
  return `${line}${line.includes(" ") ? "." : "!"}`;
}

/** The child's own words as a P.S. sentence: capital start, and a stop if they left one off. */
export function formatOwnLine(ownLine: string): string {
  let line = ownLine.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return "";
  if (/^i(?![a-z])/i.test(line)) line = `I${line.slice(1)}`;
  else if (/^[a-z]/.test(line)) line = capFirst(line);
  return withTerminalPunctuation(line);
}

type FavouriteLine = (short: string, plural: boolean) => string;

function spokenFavourites(voice: SantaVoice): FavouriteLine[] {
  const name = (short: string) => capFirst(short);
  const verb = (plural: boolean) => (plural ? "are" : "is");
  if (voice === "toddler") {
    return [
      (short, plural) => `${name(short)} ${verb(plural)} my favourite!`,
      (short) => `I like ${short} best!`,
      (short, plural) => `${name(short)} ${verb(plural)} the best!`,
      (short) => `I like ${short} the most!`,
      (short) => `Hooray for ${short}!`,
      (short, plural) => `${name(short)} ${verb(plural)} my best thing!`,
      (short) => `I like ${short} so much!`,
    ];
  }
  if (voice === "younger") {
    return [
      (short, plural) => `${name(short)} ${verb(plural)} my favourite.`,
      (short) => `I like ${short} best.`,
      (short, plural) => `${name(short)} ${verb(plural)} the best bit.`,
      (short) => `I smile most about ${short}.`,
      (short) => `Best of all is ${short}.`,
      (short, plural) => `${name(short)} ${verb(plural)} the one I like most.`,
      (short) => `I like ${short} lots.`,
    ];
  }
  return [
    (short, plural) => (plural ? `${name(short)} are my very favourite of all.` : `${name(short)} is my very favourite thing of all.`),
    (short) => `If I had to choose, I'd pick ${short} every time.`,
    (short, plural) => `${name(short)} ${verb(plural)} the best bit for me.`,
    (short) => `Nothing makes me smile like ${short}.`,
    (short) => `The one I love most is ${short}.`,
    (short) => `I come back to ${short} every time.`,
    (short) => `Most of all, I love ${short}.`,
  ];
}

function foldFavourite(sentence: string, short: string, plural: boolean, voice: SantaVoice): string {
  const bare = sentence.replace(/[.!]$/, "");
  if (voice === "toddler") return plural ? `${bare}, but ${short} are the best!` : `${bare}, but ${short} is the best!`;
  if (voice === "younger") return plural ? `${bare}, but ${short} are the best.` : `${bare}, but ${short} is the best.`;
  return plural ? `${bare}, but the best of all is ${short}.` : `${bare}, but ${short} is the best of all.`;
}

interface BuiltSection {
  questionId: string;
  text: string;
  thin: boolean;
  short: string;
  plural: boolean;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function questionParagraph(voice: SantaVoice, section: SantaLetterSection, favourites: { foldUsed: boolean; spoken: number }): BuiltSection | null {
  const picks = section.picks.filter((pick) => pick.phrase.trim());
  const list = joinSantaPhrases(picks.map((pick) => pick.phrase));
  if (!list) return null;
  const open = OPENERS[voice][section.questionId] ?? ((items: string) => (voice === "older" ? `I love ${items}.` : `I like ${items}.`));
  const sentence = open(list);
  const favourite = picks.find((pick) => pick.id === section.favourite);
  const named = favourite ? pickShort(favourite) : pickShort(picks[0]);
  const shortPick = picks.length === 1 && wordCount(picks[0].phrase) <= 3;
  const bareLove = /^I (?:love|like) \S+(?: \S+){0,2}\.$/.test(sentence);
  if (!favourite) {
    return { questionId: section.questionId, text: sentence, thin: shortPick && bareLove, short: named.short, plural: named.plural };
  }
  const lines = spokenFavourites(voice);
  // The first list folds the short name into that sentence. Later favourites, and a
  // starred pick on its own, each take the next line so one letter never repeats a template.
  if (picks.length > 1 && !favourites.foldUsed) {
    favourites.foldUsed = true;
    return { questionId: section.questionId, text: foldFavourite(sentence, named.short, named.plural, voice), thin: false, short: named.short, plural: named.plural };
  }
  const callout = lines[favourites.spoken % lines.length](named.short, named.plural);
  favourites.spoken += 1;
  if (shortPick) {
    return { questionId: section.questionId, text: callout, thin: false, short: named.short, plural: named.plural };
  }
  return { questionId: section.questionId, text: `${sentence} ${callout}`, thin: false, short: named.short, plural: named.plural };
}

function thinExtra(short: string, plural: boolean): string {
  return plural ? `${capFirst(short)} are a treat as well.` : `${capFirst(short)} is a treat as well.`;
}

/** A tiny "I love doing jigsaws." joins the paragraph next to it instead of sitting alone. */
function mergeThinSections(sections: BuiltSection[]): string[] {
  const used = new Set<number>();
  const extras = new Map<number, string[]>();
  const related = (questionId: string) => questionId !== "characters";
  for (let i = 0; i < sections.length; i += 1) {
    if (!sections[i].thin) continue;
    const prev = i - 1;
    const next = i + 1;
    const prevOk = prev >= 0 && !sections[prev].thin && related(sections[prev].questionId);
    const nextOk = next < sections.length && !sections[next].thin && related(sections[next].questionId);
    const previousMentions = prevOk && sections[prev].text.toLowerCase().includes(sections[i].short.toLowerCase());
    const host = previousMentions ? (nextOk ? next : prev) : prevOk ? prev : nextOk ? next : prev >= 0 && !sections[prev].thin ? prev : nextOk ? next : -1;
    if (host < 0) {
      sections[i] = {
        ...sections[i],
        thin: false,
        text: `I am happy with ${sections[i].short}.`,
      };
      continue;
    }
    used.add(i);
    const notes = extras.get(host) ?? [];
    notes.push(thinExtra(sections[i].short, sections[i].plural));
    extras.set(host, notes);
  }
  const paragraphs: string[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    if (used.has(i)) continue;
    const extra = extras.get(i);
    paragraphs.push(extra ? `${sections[i].text} ${extra.join(" ")}` : sections[i].text);
  }
  return paragraphs;
}

function thanks(voice: SantaVoice): string {
  if (voice === "toddler") return "Thank you, Santa. Have a safe journey on Christmas Eve. I try to be kind and helpful.";
  if (voice === "younger") return "Thank you, Santa. Have a safe journey on Christmas Eve. I have tried to be kind and helpful.";
  return "Thank you, Santa, for reading my letter. I hope you have a safe journey on Christmas Eve. I have tried to be kind and helpful this year.";
}

/**
 * The letter they see and the letter we store. It names what they love and thanks Santa.
 * It does not promise a present, and it does not ask for one.
 */
export function composeSantaLetter(draft: SantaLetterDraft): string {
  const name = tidyName(draft.childName);
  const voice = santaVoice(draft.childId);
  const named = nameSentence(name, draft.age);
  const intro = voice === "toddler"
    ? `${named} A grown-up helped me write this because I'm still little. ${HOPE}`
    : `${named} ${HOPE}`;
  const favourites = { foldUsed: false, spoken: 0 };
  const built: BuiltSection[] = [];
  for (const section of draft.sections) {
    if (section.picks.length === 0) continue;
    const paragraph = questionParagraph(voice, section, favourites);
    if (paragraph) built.push(paragraph);
  }
  const blocks = ["Dear Santa,", intro, ...mergeThinSections(built)];
  if (draft.hasDrawing) blocks.push("I've drawn you a picture too!");
  blocks.push(thanks(voice));
  blocks.push(`Love from ${name}\nMerry Christmas!`);
  const line = formatOwnLine(draft.ownLine ?? "");
  if (line) blocks.push(`P.S. ${line}`);
  return blocks.join("\n\n");
}

/** Split a stored letter into the salutation, the paragraphs, and the sign-off, for the paper on screen. */
export function santaLetterBlocks(letterText: string): SantaLetterBlock[] {
  return letterText.split(/\n\n+/).map((text) => text.trim()).filter(Boolean).map((text) => {
    if (text.startsWith("Dear ")) return { kind: "salutation" as const, text };
    if (text.startsWith("Love from ")) return { kind: "signoff" as const, text };
    return { kind: "body" as const, text };
  });
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
 * `age` is whole years from date of birth, when `core.people` has one. `hasDrawing` mentions the picture.
 */
export function validateSantaAnswers(
  childId: string,
  childName: string,
  input: unknown,
  letter: { age?: number | null; hasDrawing?: boolean } = {},
): ValidatedSantaAnswers | { error: string } {
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
    const optionById = new Map(questionSpec.options.map((option) => [option.id, option]));
    sections.push({
      questionId: questionSpec.id,
      picks: stored.picks.map((pick) => {
        const option = optionById.get(pick.id);
        return { id: pick.id, phrase: option?.phrase ?? pick.label, short: option?.short ?? pick.label, plural: option?.plural === true };
      }),
      favourite: stored.favourite,
    });
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
    letterText: composeSantaLetter({
      childId,
      childName,
      age: letter.age ?? null,
      sections,
      ownLine,
      hasDrawing: letter.hasDrawing === true,
    }),
  };
}
