/**
 * School term dates for wainwright.fun.
 *
 * One row per academic year (e.g. "2026-2027") in wainwright-term-dates:
 *   terms: [
 *     { name: "Autumn", opens: "2026-08-24", closes: "2026-12-18",
 *       half_term_start: "2026-10-19", half_term_end: "2026-10-23" },
 *     ...
 *   ]
 *
 * A date is a SCHOOL DAY when it falls on a weekday inside a term's opens..closes
 * window and is not in half term and not an England & Wales bank holiday.
 * Bank holidays are built in (ENGLAND_BANK_HOLIDAYS below, from gov.uk) —
 * they never need to be entered. Inset days are not entered either: they sit at
 * the start/end of terms, outside the opens..closes window, so they are
 * non-school days by construction. Every year always has the three standard
 * terms (Autumn, Spring, Summer).
 *
 * Dates outside every term (weekends, holidays) are NON-SCHOOL days. When no
 * row exists for the date's academic year the date falls back to school day,
 * matching the original single-allowance behaviour.
 *
 * Admin routes (Cognito):
 *   GET    /term-dates              → all years, oldest first
 *   PUT    /term-dates/{year}       → create/update a year
 *   DELETE /term-dates/{year}       → delete a year
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { json, parseBody, type APIGatewayEvent, type APIResponse } from "./http.js";
import { ENGLAND_BANK_HOLIDAYS } from "../../shared/bank-holidays.js";

const TERM_DATES_TABLE = process.env.TERM_DATES_TABLE!;

// ── Types ──────────────────────────────────────────────────────────────

export interface TermDates {
  name: string;
  opens: string;
  closes: string;
  half_term_start: string | null;
  half_term_end: string | null;
}

export interface TermDatesRow {
  academic_year: string;
  terms: TermDates[];
  updated_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}-\d{4}$/;

/** Module-level cache for term-dates rows. Rows change rarely, but the budget
 * rollover fold calls resolveSchoolDay once per day, so an uncached read
 * per day would dominate every balance request. Short TTL keeps admin edits
 * visible quickly; PUT/DELETE invalidate immediately. */
const TERM_DATES_CACHE_TTL_MS = 60_000;
const termDatesCache = new Map<string, { row: TermDatesRow | null; loadedAt: number }>();

export function invalidateTermDatesCache(): void {
  termDatesCache.clear();
}

/** England & Wales bank holidays are built into the school-day classifier via
 * the shared map in shared/bank-holidays.ts (gov.uk dates 2025–2028). */

/** Academic year ("2026-2027") a calendar date belongs to. August onwards
 *  counts towards the year starting that August. */
export function academicYearFor(date: string): string {
  const [yearStr, monthStr] = date.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function isWithin(date: string, start: string | null, end: string | null): boolean {
  return start !== null && end !== null && date >= start && date <= end;
}

/** Pure classifier: is `date` a school day given a year's terms? */
export function isSchoolDay(terms: TermDates[], date: string): boolean {
  if (!DATE_RE.test(date)) return true;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (weekday === 0 || weekday === 6) return false;
  if (date in ENGLAND_BANK_HOLIDAYS) return false;
  let inTerm = false;
  for (const term of terms) {
    if (!isWithin(date, term.opens, term.closes)) continue;
    inTerm = true;
    if (isWithin(date, term.half_term_start, term.half_term_end)) return false;
  }
  return terms.length === 0 ? true : inTerm;
}

export interface TermWindow {
  name: string;
  start: string;
  end: string;
}

/**
 * The window a "1 per term" reward cap applies to for `date`: the term
 * containing the date (half term and bank holidays inside a term still
 * count as that term), or — outside every term — the most recently
 * opened term. Null when the year has no terms at all.
 */
export function termWindowFor(terms: TermDates[], date: string): TermWindow | null {
  if (!DATE_RE.test(date)) return null;
  let containing: TermDates | null = null;
  let lastOpened: TermDates | null = null;
  for (const term of terms) {
    if (term.opens > date) continue;
    if (!lastOpened || term.opens > lastOpened.opens) lastOpened = term;
    if (date <= term.closes) containing = term;
  }
  const term = containing ?? lastOpened;
  if (!term) return null;
  return { name: term.name, start: term.opens, end: term.closes };
}

export async function getTermDatesRow(
  ddb: DynamoDBDocumentClient,
  academicYear: string
): Promise<TermDatesRow | null> {
  const cached = termDatesCache.get(academicYear);
  if (cached && Date.now() - cached.loadedAt < TERM_DATES_CACHE_TTL_MS) {
    return cached.row;
  }
  const response = await ddb.send(
    new GetCommand({ TableName: TERM_DATES_TABLE, Key: { academic_year: academicYear } })
  );
  const row = (response.Item as TermDatesRow) ?? null;
  termDatesCache.set(academicYear, { row, loadedAt: Date.now() });
  return row;
}

/** Resolves whether a calendar date is a school day. Dates with no term-dates
 *  row for their academic year default to school day. */
export async function resolveSchoolDay(
  ddb: DynamoDBDocumentClient,
  date: string
): Promise<boolean> {
  if (!DATE_RE.test(date)) return true;
  const row = await getTermDatesRow(ddb, academicYearFor(date));
  if (!row) return true;
  return isSchoolDay(row.terms, date);
}

// ── Admin routes ──────────────────────────────────────────────────────

function normalizeTerm(input: unknown): TermDates | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const name = String(raw.name ?? "").trim();
  const opens = String(raw.opens ?? "");
  const closes = String(raw.closes ?? "");
  if (!name || !DATE_RE.test(opens) || !DATE_RE.test(closes)) return null;
  const halfStart = typeof raw.half_term_start === "string" && DATE_RE.test(raw.half_term_start) ? raw.half_term_start : null;
  const halfEnd = typeof raw.half_term_end === "string" && DATE_RE.test(raw.half_term_end) ? raw.half_term_end : null;
  return {
    name,
    opens,
    closes,
    half_term_start: halfStart,
    half_term_end: halfEnd,
  };
}

async function handleAdminListTermDates(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const items: TermDatesRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: TERM_DATES_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as TermDatesRow[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => a.academic_year.localeCompare(b.academic_year));
  return json(event, 200, items);
}

async function handleAdminPutTermDates(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  academicYear: string
): Promise<APIResponse> {
  if (!YEAR_RE.test(academicYear)) {
    return json(event, 400, { error: "Academic year must look like 2026-2027" });
  }
  const body = parseBody(event);
  const rawTerms = Array.isArray(body.terms) ? body.terms : [];
  const terms = rawTerms.map(normalizeTerm).filter((t): t is TermDates => t !== null);
  const existing = await getTermDatesRow(ddb, academicYear);
  const item: TermDatesRow = {
    academic_year: academicYear,
    terms: terms.length > 0 ? terms : existing?.terms ?? [],
    updated_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TERM_DATES_TABLE, Item: item }));
  invalidateTermDatesCache();
  return json(event, 200, item);
}

async function handleAdminDeleteTermDates(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  academicYear: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: TERM_DATES_TABLE, Key: { academic_year: academicYear } })
  );
  invalidateTermDatesCache();
  return json(event, 200, { deleted: true });
}

// ── Router ────────────────────────────────────────────────────────────

export async function tryHandleTermDatesRoute(
  event: APIGatewayEvent,
  method: string,
  resource: string,
  resourceId: string,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse | null> {
  if (resource !== "term-dates") return null;
  if (method === "GET" && !resourceId) return handleAdminListTermDates(event, ddb);
  if (method === "PUT" && resourceId) return handleAdminPutTermDates(event, ddb, resourceId);
  if (method === "DELETE" && resourceId) return handleAdminDeleteTermDates(event, ddb, resourceId);
  return json(event, 404, { error: "Not found" });
}
