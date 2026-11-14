/**
 * Store and read letters to Santa. The child is the device (or a parent's act-as choice),
 * the same way /kid/internet works. Submissions before SANTA_OPENS_EUROPE_LONDON are refused.
 * Every send is a new row; the launcher and the admin show the latest.
 */
import { calculateAge } from "../../shared/scripts/birthday.js";
import { HttpError, type Result } from "./app.js";
import type { Queryable } from "./pg-ddb.js";
import {
  SANTA_MAX_DRAWING_BYTES,
  santaChild,
  santaIsOpen,
  validateSantaAnswers,
  type SantaStoredAnswers,
} from "./santa-catalog.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface StoredSantaLetter {
  id: string;
  childId: string;
  submittedAt: string;
  answers: SantaStoredAnswers;
  ownLine: string | null;
  letterText: string;
  drawingPng: string | null;
  clientIp: string | null;
}

function asBuffer(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) return value.length ? Buffer.from(value) : null;
  return null;
}

function drawingDataUrl(value: unknown): string | null {
  const bytes = asBuffer(value);
  if (!bytes) return null;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function asAnswers(value: unknown): SantaStoredAnswers {
  if (typeof value === "string") return JSON.parse(value) as SantaStoredAnswers;
  return (value ?? {}) as SantaStoredAnswers;
}

function present(row: Record<string, unknown>): StoredSantaLetter {
  const submitted = row.submitted_at instanceof Date ? row.submitted_at : new Date(String(row.submitted_at));
  return {
    id: String(row.id),
    childId: String(row.child_id),
    submittedAt: submitted.toISOString(),
    answers: asAnswers(row.answers),
    ownLine: row.own_line == null || row.own_line === "" ? null : String(row.own_line),
    letterText: String(row.letter_text ?? ""),
    drawingPng: drawingDataUrl(row.drawing_png),
    clientIp: row.client_ip == null ? null : String(row.client_ip),
  };
}

export function decodeSantaDrawing(value: unknown): Buffer | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "The drawing has to be a PNG");
  const trimmed = value.trim();
  const base64 = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  if (!base64 || base64.length > SANTA_MAX_DRAWING_BYTES * 2) throw new HttpError(400, "That drawing is too big");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new HttpError(400, "The drawing has to be a PNG");
  }
  if (bytes.length === 0 || bytes.length > SANTA_MAX_DRAWING_BYTES || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new HttpError(400, bytes.length > SANTA_MAX_DRAWING_BYTES ? "That drawing is too big" : "The drawing has to be a PNG");
  }
  return bytes;
}

/** The iPad doesn't need the address we stored next to the letter. */
function forChild(letter: StoredSantaLetter) {
  const { clientIp: _clientIp, ...rest } = letter;
  return rest;
}

/** Whole years from core.people.date_of_birth, or null when the date is missing. */
export async function childAgeYears(db: Queryable, childId: string, now: Date): Promise<number | null> {
  const { rows } = await db.query(
    `-- santa-age
     SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob
     FROM core.people
     WHERE id = $1`,
    [childId],
  );
  const dob = rows[0]?.dob;
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const age = calculateAge(dob, now);
  if (!Number.isInteger(age) || age < 0) return null;
  return age;
}

function publicForm(childId: string, childName: string, age: number | null, latest: StoredSantaLetter | null) {
  const child = santaChild(childId);
  return {
    open: true as const,
    child: { id: childId, name: childName },
    age,
    style: child.style,
    maxPicks: 3,
    questions: child.questions,
    latest: latest ? forChild(latest) : null,
  };
}

export async function getSantaLetter(db: Queryable, childId: string, childName: string, now = new Date()): Promise<Result> {
  if (!santaIsOpen(now)) return { status: 200, body: { open: false } };
  const age = await childAgeYears(db, childId, now);
  const { rows } = await db.query(
    `-- santa-latest
     SELECT id, child_id, submitted_at, answers, own_line, letter_text, drawing_png, host(client_ip) AS client_ip
     FROM kids.santa_letters
     WHERE child_id = $1
     ORDER BY submitted_at DESC, id DESC
     LIMIT 1`,
    [childId],
  );
  return { status: 200, body: publicForm(childId, childName, age, rows[0] ? present(rows[0]) : null) };
}

export async function postSantaLetter(db: Queryable, childId: string, childName: string, rawBody: string, clientIp: string | null, now = new Date()): Promise<Result> {
  if (!santaIsOpen(now)) throw new HttpError(403, "Letters to Santa are not open yet");
  const input = rawBody.trim() ? JSON.parse(rawBody) : {};
  const drawing = decodeSantaDrawing(asRecordDrawing(input));
  const age = await childAgeYears(db, childId, now);
  const validated = validateSantaAnswers(childId, childName, input, { age, hasDrawing: drawing != null });
  if ("error" in validated) throw new HttpError(400, validated.error);
  const { rows } = await db.query(
    `-- santa-insert
     INSERT INTO kids.santa_letters (child_id, answers, own_line, drawing_png, letter_text, client_ip)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6::inet)
     RETURNING id, child_id, submitted_at, answers, own_line, letter_text, drawing_png, host(client_ip) AS client_ip`,
    [childId, JSON.stringify(validated.answers), validated.ownLine, drawing, validated.letterText, clientIp],
  );
  return { status: 200, body: { ok: true, letter: forChild(present(rows[0])) } };
}

function asRecordDrawing(input: unknown): unknown {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).drawing : undefined;
}

export async function listSantaLetters(db: Queryable): Promise<Result> {
  // One client, one transaction: these cannot run at the same time.
  const people = await db.query(
    `-- santa-children
     SELECT id, display_name FROM core.people WHERE role = 'child' ORDER BY sort_order, id`,
  );
  const letters = await db.query(
    `-- santa-all
     SELECT id, child_id, submitted_at, answers, own_line, letter_text, drawing_png, host(client_ip) AS client_ip
     FROM kids.santa_letters
     ORDER BY submitted_at DESC, id DESC`,
  );
  const latest = new Map<string, StoredSantaLetter>();
  const submissions = new Map<string, number>();
  for (const row of letters.rows) {
    const childId = String(row.child_id);
    submissions.set(childId, (submissions.get(childId) ?? 0) + 1);
    if (!latest.has(childId)) latest.set(childId, present(row));
  }
  return {
    status: 200,
    body: {
      letters: people.rows.map((person) => ({
        childId: String(person.id),
        name: String(person.display_name),
        submissions: submissions.get(String(person.id)) ?? 0,
        latest: latest.get(String(person.id)) ?? null,
      })),
    },
  };
}
