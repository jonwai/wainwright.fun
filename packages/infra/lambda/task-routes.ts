/**
 * Task routes for wainwright.fun — the Tickets app.
 *
 * An admin defines tasks (chores, achievements, anything earnable) and assigns
 * them to children. A child marks a task complete to earn its ticket reward;
 * children can also undo their own completion (the latest one). Admins can
 * mark tasks complete on a child's behalf (e.g. recording something that
 * already happened) and undo any completion.
 *
 * Tickets are tracked SEPARATELY from snack budgets:
 *   - wainwright-tasks (PK task_id): the task definitions
 *     - title, description (optional), ticket_reward (default 1)
 *     - assigned_to: child subdomains (empty = every child)
 *     - enabled: disabled tasks disappear from the kid app
 *   - wainwright-task-completions (PK child_subdomain,
 *     SK `${task_id}#${completed_at}`): append-only event log — one item
 *     per completion. A child's ticket total is the sum over all events, so
 *     history always reconciles. Undo deletes the newest event for that
 *     child+task.
 *
 * Kid routes (device token, same as the main app and Snacks):
 *   GET  /kid/tasks                       → my tasks + completion state
 *   GET  /kid/tasks/history               → my completion log
 *   POST /kid/tasks/{taskId}/complete    → mark complete (earns tickets)
 *   POST /kid/tasks/{taskId}/undo        → undo my latest completion
 *
 * Admin routes (Cognito):
 *   GET    /tasks                          → all tasks
 *   PUT    /tasks/{taskId}                 → create/update a task
 *   DELETE /tasks/{taskId}                 → delete a task
 *   GET    /tasks/completions               → every completion event
 *   POST   /tasks/{taskId}/children/{child}/complete
 *   POST   /tasks/{taskId}/children/{child}/undo
 *   POST   /tasks/bonus/children/{child}/award   → bonus tickets
 *   POST   /tasks/bonus/children/{child}/undo     → undo newest bonus
 *
 * Bonus awards (parent-awarded tickets with NO task, e.g. "Happy
 * Birthday"): they share the completion log with a reserved task_id of
 * "bonus" and carry a `label` that kid history shows as the title.
 * They count towards the child's ticket total and spendable balance
 * (both derive from the completion log) but never appear on the
 * jobs list — that iterates real task rows only. The regular admin
 * undo route with taskId "bonus" removes a child's newest bonus.
 *
 * Job board (how tasks are offered):
 *   - wainwright-job-board (PK board_id): postings that reference a
 *     library task and add recurrence:
 *       repeat: "once" | "daily" | "school_day" | "on_demand"
 *       ticket_reward / assigned_to: per-posting overrides
 *       posted / posted_at: the admin's on/off switch for on_demand jobs
 *       completion_mode: "each_child" | "first_done" (on_demand only)
 *   - A library task with NO postings behaves as a single implicit "once"
 *     posting — the original behaviour, so live data needs no migration.
 *   - All kid-facing recurrence state is DERIVED from the completion log
 *     on the fly — nothing is materialised per day:
 *       once       done = any completion ever (stays visible, greyed)
 *       daily      done = completed today (Europe/London); resets next day
 *       school_day visible only on school days (term dates + bank
 *                  holidays); done = completed today
 *       on_demand  visible only while posted; done = completed since
 *                  posted_at. first_done auto-unposts on ANY completion;
 *                  each_child stays posted until every audience child is done.
 *
 * Admin routes:
 *   GET    /board                         → every posting
 *   PUT    /board/{boardId}               → create/update a posting
 *   DELETE /board/{boardId}               → delete a posting
 *
 * Rewards (prizes a child can swap tickets for):
 *   - wainwright-rewards (PK reward_id): title, description (optional),
 *     ticket_cost (1-500), cost_pence (the real-money cost in pence —
 *     ADMIN ONLY, never returned by kid routes), enabled, and a LIMIT:
 *       limit_type: "unlimited" | "stock" | "period" | "snack_stock"
 *     stock:   stock_remaining — a shared family pool; decremented on
 *              redeem, restored on refund (claimed = gone for good)
 *     period:  period ("week" | "month" | "summer" | "term" | "year")
 *              — max ONE redemption per child per window; windows derive
 *              from the calendar (Mon-anchored weeks, calendar months/years,
 *              1 Jun–31 Aug for summer) and the term-dates table for "term"
 *     snack_stock: snack_product_slug — live stock from the Wainsbury's
 *              integration API (same one as the Snacks app): a portion is
 *              consumed on redeem; refunds do NOT restore it (matching
 *              the snacks budget's select/unselect precedent)
 *   - wainwright-reward-redemptions (PK child_subdomain,
 *     SK `${epoch36}-${rand}`): one item per redemption, status "pending"
 *     until a parent marks it "claimed". Refund deletes the event and is
 *     allowed ONLY while pending. A child's spendable tickets =
 *     Σ completion events − Σ redemption events (any status), so the
 *     history always reconciles. Limits are enforced on kid AND admin
 *     redeems; period counts derive from the redemption log, so a
 *     refund frees the period slot automatically.
 *
 * Kid routes:
 *   GET  /kid/rewards                      → rewards + spendable tickets + my redemptions
 *   POST /kid/rewards/{rewardId}/redeem    → swap tickets for a reward
 *   POST /kid/rewards/refund                → undo my newest pending redemption
 *
 * Admin routes:
 *   GET    /rewards                          → all rewards (incl. cost_pence)
 *   PUT    /rewards/{rewardId}               → create/update a reward
 *   DELETE /rewards/{rewardId}               → delete a reward
 *   GET    /rewards/redemptions             → every redemption event
 *   POST   /rewards/{rewardId}/children/{child}/redeem
 *   POST   /rewards/redemptions/{child}/{redemptionId}/refund|claim
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { json, parseBody, type APIGatewayEvent, type APIResponse } from "./http.js";
import { extractDeviceToken, getDevice, getPreviewChild } from "./kid-routes.js";
import { fetchSnackProducts, consumeWainsburysPortion } from "./budget-routes.js";
import { academicYearFor, getTermDatesRow, resolveSchoolDay, termWindowFor } from "./term-dates.js";

const TASKS_TABLE = process.env.TASKS_TABLE!;
const TASK_COMPLETIONS_TABLE = process.env.TASK_COMPLETIONS_TABLE!;
const JOB_BOARD_TABLE = process.env.JOB_BOARD_TABLE!;
const REWARDS_TABLE = process.env.REWARDS_TABLE!;
const REDEMPTIONS_TABLE = process.env.REDEMPTIONS_TABLE!;

// ── Ticket icon uploads ────────────────────────────────────────────────
// Admins upload photos for tasks/rewards; they land in the site bucket
// under ticket-icons/ and are served by CloudFront like the other icon
// dirs. The S3 client is created lazily so local tests with no bucket
// configured never touch it.
const SITE_BUCKET_NAME = process.env.CONFIG_BUCKET_NAME ?? "";
let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

/** Allowed upload content types → normalised file extension. */
const ICON_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** Max decoded upload size (5 MB) — photos from a phone are usually <2 MB. */
const MAX_ICON_BYTES = 5 * 1024 * 1024;

/** Slugifies a filename base: lowercase, [a-z0-9-], collapsed runs. */
function iconSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.(png|jpe?g|webp|gif|svg)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function handleAdminUploadIcon(
  event: APIGatewayEvent
): Promise<APIResponse> {
  const body = parseBody(event);
  const contentType = String(body.content_type ?? "").toLowerCase();
  const ext = ICON_CONTENT_TYPES[contentType];
  if (!ext) {
    return json(event, 400, {
      error: "content_type must be one of: " + Object.keys(ICON_CONTENT_TYPES).join(", "),
    });
  }
  if (typeof body.data !== "string" || !body.data) {
    return json(event, 400, { error: "data (base64 image) is required" });
  }
  if (!SITE_BUCKET_NAME) {
    return json(event, 500, { error: "Uploads are not configured" });
  }

  const bytes = Buffer.from(body.data, "base64");
  if (bytes.length === 0) {
    return json(event, 400, { error: "data is not valid base64" });
  }
  if (bytes.length > MAX_ICON_BYTES) {
    return json(event, 400, { error: "Image is too big — keep it under 5 MB" });
  }

  // Filename: caller-supplied name (slugified) or a random one. A short
  // random suffix avoids collisions when the same name is re-uploaded —
  // the new file gets a new key, so CloudFront serves the new bytes
  // immediately instead of for up to max-age.
  const base = iconSlug(String(body.name ?? "")) || "icon";
  const suffix = Math.random().toString(36).slice(2, 8);
  const key = `ticket-icons/${base}-${suffix}.${ext}`;

  await getS3().send(
    new PutObjectCommand({
      Bucket: SITE_BUCKET_NAME,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: "public, max-age=3600",
    })
  );

  return json(event, 200, { icon: key.slice("ticket-icons/".length), icon_url: `/${key}` });
}

// ── Types ──────────────────────────────────────────────────────────────

export interface TaskCompletionEvent {
  child_subdomain: string;
  /** `${task_id}#${completed_at}` — sort key, chronological per task. */
  task_completion: string;
  task_id: string;
  completed_at: string;
  /** Who completed it. */
  completed_by: "child" | "parent";
  /** Ticket reward recorded at completion time (task edits later don't rewrite history). */
  tickets: number;
  /** Bonus awards only (task_id "bonus"): the label shown as the
   * title in kid history, e.g. "Happy Birthday". Null for real tasks. */
  label?: string | null;
}

export interface TaskRow {
  task_id: string;
  title: string;
  description: string | null;
  ticket_reward: number;
  /** Child subdomains this task is for. Empty = every child. */
  assigned_to: string[];
  /** Icon filename under ticket-icons/ in the site bucket (optional). */
  icon: string | null;
  /** Fallback emoji shown when there's no photo (optional). */
  emoji: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RewardRow {
  reward_id: string;
  title: string;
  description: string | null;
  /** Tickets a child must swap for this reward. */
  ticket_cost: number;
  /** What the prize actually costs, in whole pence. ADMIN ONLY — never
   * returned by kid routes. */
  cost_pence: number | null;
  /** Icon filename under ticket-icons/ in the site bucket (optional). */
  icon: string | null;
  /** Fallback emoji shown when there's no photo (optional). */
  emoji: string | null;
  /** How redemptions of this reward are limited. */
  limit_type: RewardLimitType;
  /** stock-pool rewards: how many are left in the shared family pool. */
  stock_remaining: number | null;
  /** period-capped rewards: the window length (1 per window per child). */
  period: RewardPeriod | null;
  /** snack-stock rewards: the Wainsbury's product slug to track. */
  snack_product_slug: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type RewardLimitType = "unlimited" | "stock" | "period" | "snack_stock";
export type RewardPeriod = "week" | "month" | "summer" | "term" | "year";

const LIMIT_TYPES: RewardLimitType[] = ["unlimited", "stock", "period", "snack_stock"];
const REWARD_PERIODS: RewardPeriod[] = ["week", "month", "summer", "term", "year"];

export interface RewardRedemptionEvent {
  child_subdomain: string;
  /** `${epoch36}-${rand}` — sort key, chronological per child. */
  redemption_id: string;
  reward_id: string;
  redeemed_at: string;
  /** Who redeemed it. */
  redeemed_by: "child" | "parent";
  /** Ticket cost recorded at redemption time (reward edits later don't rewrite history). */
  tickets: number;
  /** "pending" until a parent marks the reward received, then "claimed". */
  status: "pending" | "claimed";
  claimed_at?: string;
}

export type BoardRepeat = "once" | "daily" | "school_day" | "on_demand";
export type BoardCompletionMode = "each_child" | "first_done";

export interface BoardEntry {
  board_id: string;
  /** The library task this posting offers. */
  task_id: string;
  repeat: BoardRepeat;
  /** Per-posting reward override (recorded on completion). */
  ticket_reward: number;
  /** Per-posting audience override. Empty = fall back to the task's. */
  assigned_to: string[];
  /** on_demand only: the admin's on/off switch. */
  posted: boolean;
  /** When it was last posted — the "done since" anchor for on_demand. */
  posted_at: string | null;
  /** on_demand only: first_done auto-unposts on any completion. */
  completion_mode: BoardCompletionMode;
  created_at: string;
  updated_at: string;
}

const REPEATS: BoardRepeat[] = ["once", "daily", "school_day", "on_demand"];
const COMPLETION_MODES: BoardCompletionMode[] = ["each_child", "first_done"];

// ── Helpers ───────────────────────────────────────────────────────────

async function getTask(
  ddb: DynamoDBDocumentClient,
  taskId: string
): Promise<TaskRow | null> {
  const response = await ddb.send(
    new GetCommand({ TableName: TASKS_TABLE, Key: { task_id: taskId } })
  );
  return (response.Item as TaskRow) ?? null;
}

/** All tasks, sorted by title for stable admin display. */
async function listTasks(ddb: DynamoDBDocumentClient): Promise<TaskRow[]> {
  const items: TaskRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: TASKS_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as TaskRow[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** Every completion event for one child, newest first. */
async function completionsForChild(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  limit?: number
): Promise<TaskCompletionEvent[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: TASK_COMPLETIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      ExpressionAttributeValues: { ":child": childSubdomain },
      ScanIndexForward: false,
      ...(limit ? { Limit: limit } : {}),
    })
  );
  return (response.Items ?? []) as TaskCompletionEvent[];
}

/** The newest completion event for one child+task, or null. */
async function latestCompletion(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  taskId: string
): Promise<TaskCompletionEvent | null> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: TASK_COMPLETIONS_TABLE,
      KeyConditionExpression:
        "child_subdomain = :child AND begins_with(task_completion, :prefix)",
      ExpressionAttributeValues: {
        ":child": childSubdomain,
        ":prefix": `${taskId}#`,
      },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  return ((response.Items ?? [])[0] as TaskCompletionEvent) ?? null;
}

async function recordCompletion(
  ddb: DynamoDBDocumentClient,
  task: TaskRow,
  childSubdomain: string,
  by: "child" | "parent",
  ticketsOverride?: number
): Promise<TaskCompletionEvent> {
  const completedAt = new Date().toISOString();
  const event: TaskCompletionEvent = {
    child_subdomain: childSubdomain,
    // Random suffix: two completions within the same millisecond would
    // otherwise collide on an identical sort key and overwrite.
    task_completion: `${task.task_id}#${completedAt}#${Math.random().toString(36).slice(2, 8)}`,
    task_id: task.task_id,
    completed_at: completedAt,
    completed_by: by,
    tickets: ticketsOverride ?? task.ticket_reward,
  };
  await ddb.send(
    new PutCommand({ TableName: TASK_COMPLETIONS_TABLE, Item: event })
  );
  return event;
}

/** Removes the newest completion event for a child+task. Returns it, or null. */
async function undoLatestCompletion(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  taskId: string
): Promise<TaskCompletionEvent | null> {
  const latest = await latestCompletion(ddb, childSubdomain, taskId);
  if (!latest) return null;
  await ddb.send(
    new DeleteCommand({
      TableName: TASK_COMPLETIONS_TABLE,
      Key: {
        child_subdomain: childSubdomain,
        task_completion: latest.task_completion,
      },
    })
  );
  return latest;
}

/** Whether a task is for a child: assigned list contains them, or is empty (all). */
function taskAppliesTo(task: TaskRow, childSubdomain: string): boolean {
  return task.assigned_to.length === 0 || task.assigned_to.includes(childSubdomain);
}

// ── Job board helpers ────────────────────────────────────────────────

/** All board postings, oldest first for stable admin display. */
async function listBoardEntries(ddb: DynamoDBDocumentClient): Promise<BoardEntry[]> {
  const items: BoardEntry[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: JOB_BOARD_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as BoardEntry[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return items;
}

async function getBoardEntry(
  ddb: DynamoDBDocumentClient,
  boardId: string
): Promise<BoardEntry | null> {
  const response = await ddb.send(
    new GetCommand({ TableName: JOB_BOARD_TABLE, Key: { board_id: boardId } })
  );
  return (response.Item as BoardEntry) ?? null;
}

/** Today's calendar date in the family's timezone. */
function londonDate(date?: Date): string {
  // The sv-SE locale formats as YYYY-MM-DD.
  return (date ?? new Date()).toLocaleDateString("sv-SE", {
    timeZone: "Europe/London",
  });
}

/** The effective audience of a posting: its override, or the task's list. */
function entryAudience(entry: BoardEntry, task: TaskRow): string[] {
  return entry.assigned_to.length > 0 ? entry.assigned_to : task.assigned_to;
}

function entryAppliesToChild(
  entry: BoardEntry,
  task: TaskRow,
  childSubdomain: string
): boolean {
  const audience = entryAudience(entry, task);
  return audience.length === 0 || audience.includes(childSubdomain);
}

/** Whether a posting is on the board for the child right now (audience + day). */
function entryVisibleToday(entry: BoardEntry, schoolDay: boolean): boolean {
  if (entry.repeat === "on_demand") return entry.posted;
  if (entry.repeat === "school_day") return schoolDay;
  return true;
}

/** Derived done state for one posting, from the child's completion events. */
function entryDone(
  entry: BoardEntry,
  events: TaskCompletionEvent[],
  today: string
): boolean {
  switch (entry.repeat) {
    case "once":
      return events.length > 0;
    case "daily":
    case "school_day":
      return events.some((e) => londonDate(new Date(e.completed_at)) === today);
    case "on_demand": {
      const since = entry.posted_at;
      // Strictly after: a completion at exactly posted_at predates the
      // posting (same-millisecond re-posts must not inherit old completions).
      const relevant = since ? events.filter((e) => e.completed_at > since) : events;
      return relevant.length > 0;
    }
  }
}

/** Auto-unpost first_done on_demand postings after a completion. */
async function unpostFirstDoneEntries(
  ddb: DynamoDBDocumentClient,
  entries: BoardEntry[]
): Promise<void> {
  const now = new Date().toISOString();
  for (const entry of entries) {
    if (entry.repeat !== "on_demand" || entry.completion_mode !== "first_done" || !entry.posted) {
      continue;
    }
    await ddb.send(
      new PutCommand({
        TableName: JOB_BOARD_TABLE,
        Item: { ...entry, posted: false, posted_at: null, updated_at: now },
      })
    );
  }
}

/**
 * Resolves what a completion of `task` by `childSubdomain` should earn and
 * which board postings it touches. Returns null when the child can't see
 * the task right now (unposted on_demand, or a school_day job on a
 * non-school day) — kid-facing 404s then.
 */
async function resolveCompletionContext(
  ddb: DynamoDBDocumentClient,
  task: TaskRow,
  childSubdomain: string
): Promise<{ tickets: number; entries: BoardEntry[] } | null> {
  const entries = (await listBoardEntries(ddb)).filter(
    (e) => e.task_id === task.task_id
  );
  if (entries.length === 0) {
    // No postings — the implicit once behaviour. Task-level audience applies.
    if (!taskAppliesTo(task, childSubdomain)) return null;
    return { tickets: task.ticket_reward, entries: [] };
  }
  const schoolDayEntries = entries.some((e) => e.repeat === "school_day");
  const schoolDay = schoolDayEntries
    ? await resolveSchoolDay(ddb, londonDate())
    : true;
  const visible = entries.filter(
    (e) =>
      entryAppliesToChild(e, task, childSubdomain) &&
      entryVisibleToday(e, schoolDay)
  );
  if (visible.length === 0) return null;
  return { tickets: visible[0].ticket_reward, entries };
}

// ── Reward helpers ────────────────────────────────────────────────────

async function getReward(
  ddb: DynamoDBDocumentClient,
  rewardId: string
): Promise<RewardRow | null> {
  const response = await ddb.send(
    new GetCommand({ TableName: REWARDS_TABLE, Key: { reward_id: rewardId } })
  );
  return (response.Item as RewardRow) ?? null;
}

/** All rewards, sorted by ticket cost then title for stable display. */
async function listRewards(ddb: DynamoDBDocumentClient): Promise<RewardRow[]> {
  const items: RewardRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({ TableName: REWARDS_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((response.Items ?? []) as RewardRow[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort(
    (a, b) => a.ticket_cost - b.ticket_cost || a.title.localeCompare(b.title)
  );
  return items;
}

/** Every redemption event for one child, newest first. */
async function redemptionsForChild(
  ddb: DynamoDBDocumentClient,
  childSubdomain: string
): Promise<RewardRedemptionEvent[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: REDEMPTIONS_TABLE,
      KeyConditionExpression: "child_subdomain = :child",
      ExpressionAttributeValues: { ":child": childSubdomain },
      ScanIndexForward: false,
    })
  );
  return (response.Items ?? []) as RewardRedemptionEvent[];
}

/** Tickets earned minus tickets spent on redemptions (any status). */
function spendableTickets(
  completions: TaskCompletionEvent[],
  redemptions: RewardRedemptionEvent[]
): number {
  const earned = completions.reduce((sum, c) => sum + c.tickets, 0);
  const spent = redemptions.reduce((sum, r) => sum + r.tickets, 0);
  return earned - spent;
}

// ── Reward limits ──────────────────────────────────────────────────

/** The London calendar date a redemption falls in. */
function redemptionDate(redeemedAt: string): string {
  return new Date(redeemedAt).toLocaleDateString("sv-SE", {
    timeZone: "Europe/London",
  });
}

/** Monday the Mon-anchored "1 per week" window containing `date`. */
function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Sun=0 → Mon-anchored
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Calendar month (YYYY-MM) containing `date`. */
function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Calendar year containing `date`. */
function yearKey(date: string): string {
  return date.slice(0, 4);
}

/** The summer window (1 Jun – 31 Aug) containing `date`, or null outside it. */
function summerKey(date: string): string | null {
  const month = date.slice(5, 7);
  return month >= "06" && month <= "08" ? `${date.slice(0, 4)}-summer` : null;
}

/** The term window (from the term-dates table) containing `date`, or null. */
async function termKey(
  ddb: DynamoDBDocumentClient,
  date: string
): Promise<string | null> {
  const row = await getTermDatesRow(ddb, academicYearFor(date));
  if (!row) return null;
  const window = termWindowFor(row.terms, date);
  return window ? `${window.name} ${window.start}..${window.end}` : null;
}

/** The window key a period-capped redemption counts against, or null when
 * the window can't be resolved (no term-dates row for "term"). */
async function periodWindowKey(
  ddb: DynamoDBDocumentClient,
  period: RewardPeriod,
  redeemedAt: string
): Promise<string | null> {
  const date = redemptionDate(redeemedAt);
  switch (period) {
    case "week":
      return weekStart(date);
    case "month":
      return monthKey(date);
    case "summer":
      return summerKey(date);
    case "term":
      return termKey(ddb, date);
    case "year":
      return yearKey(date);
  }
}

/** How many of the child's redemptions of `reward` already count against the
 * current window (period caps are 1 per window; a redemption outside the
 * current window doesn't count). */
async function periodRedemptionsInWindow(
  ddb: DynamoDBDocumentClient,
  reward: RewardRow,
  redemptions: RewardRedemptionEvent[]
): Promise<number> {
  const period = reward.period!;
  const currentWindow = await periodWindowKey(ddb, period, new Date().toISOString());
  if (!currentWindow) return 0;
  let count = 0;
  for (const r of redemptions) {
    if (r.reward_id !== reward.reward_id) continue;
    const window = await periodWindowKey(ddb, period, r.redeemed_at);
    if (window === currentWindow) count += 1;
  }
  return count;
}

/** Kid-facing limit state for one reward, derived from the redemption log. */
async function rewardLimitState(
  ddb: DynamoDBDocumentClient,
  reward: RewardRow,
  _childSubdomain: string,
  redemptions: RewardRedemptionEvent[]
): Promise<{
  limit_type: RewardLimitType;
  stock_remaining: number | null;
  period: RewardPeriod | null;
  period_used: boolean;
  period_window: string | null;
}> {
  const periodUsed =
    reward.limit_type === "period" && reward.period
      ? (await periodRedemptionsInWindow(ddb, reward, redemptions)) > 0
      : false;
  const periodWindow =
    reward.limit_type === "period" && reward.period
      ? await periodWindowKey(ddb, reward.period, new Date().toISOString())
      : null;
  // snack_stock: resolve live portions from Wainsbury's so the kid card
  // shows real remaining stock (stock_remaining is null on the row).
  const stockRemaining =
    reward.limit_type === "snack_stock"
      ? await snackStockRemaining(reward)
      : reward.stock_remaining;
  return {
    limit_type: reward.limit_type,
    stock_remaining: stockRemaining,
    period: reward.period,
    period_used: periodUsed,
    period_window: periodWindow,
  };
}

/** Child-friendly message when a redemption is blocked by its limit. */
function limitBlockedMessage(reward: RewardRow): string {
  switch (reward.limit_type) {
    case "stock":
      return "Oh no, that's all gone for now! Pick a different reward. 🐻";
    case "snack_stock":
      return "Oh no, the popcorn's all gone! Pick a different reward. 🍿";
    case "period":
      switch (reward.period) {
        case "week":
          return "You've already had that this week — save for something else! 😊";
        case "month":
          return "You've already had that this month — save for something else! 😊";
        case "summer":
          return "That's a once-a-summer treat — it'll be back next summer! ☀️";
        case "term":
          return "You've already had that this term — save for something else! 😊";
        case "year":
          return "That's a once-a-year treat — it'll be back next year! 🎉";
      }
      return "You've already had that recently — save for something else! 😊";
    default:
      return "That reward isn't available right now. Pick a different one! 🐻";
  }
}

/** Whether a snack-stock reward still has portions left in Wainsbury's. */
async function snackStockRemaining(reward: RewardRow): Promise<number | null> {
  if (reward.limit_type !== "snack_stock" || !reward.snack_product_slug) return null;
  const products = await fetchSnackProducts();
  return products.find((p) => p.productSlug === reward.snack_product_slug)
    ?.portionsLeft ?? null;
}

/**
 * Enforces a reward's limit BEFORE recording the redemption. Returns an
 * APIResponse when blocked (kid-facing message), else null.
 * Stock pools decrement here; snack-stock consumes a Wainsbury's portion
 * here — both AFTER the caller has checked spendable tickets.
 */
async function enforceRewardLimit(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  reward: RewardRow,
  _childSubdomain: string,
  redemptions: RewardRedemptionEvent[]
): Promise<APIResponse | null> {
  switch (reward.limit_type) {
    case "stock": {
      if ((reward.stock_remaining ?? 0) <= 0) {
        return json(event, 409, { error: limitBlockedMessage(reward) });
      }
      break;
    }
    case "snack_stock": {
      const remaining = await snackStockRemaining(reward);
      if (remaining === null || remaining <= 0) {
        return json(event, 409, { error: limitBlockedMessage(reward) });
      }
      break;
    }
    case "period": {
      const used = await periodRedemptionsInWindow(ddb, reward, redemptions);
      if (used > 0) {
        return json(event, 409, { error: limitBlockedMessage(reward) });
      }
      break;
    }
  }
  return null;
}

/** Applies the side effects of a successful redeem: decrements a stock pool
 * (persisted) or consumes a Wainsbury's portion (external). */
async function applyRedemptionEffects(
  ddb: DynamoDBDocumentClient,
  reward: RewardRow
): Promise<void> {
  if (reward.limit_type === "stock") {
    await ddb.send(
      new PutCommand({
        TableName: REWARDS_TABLE,
        Item: {
          ...reward,
          stock_remaining: (reward.stock_remaining ?? 1) - 1,
          updated_at: new Date().toISOString(),
        },
      })
    );
    return;
  }
  if (reward.limit_type === "snack_stock" && reward.snack_product_slug) {
    // Consume FIRST (same ordering as the snacks budget select): if
    // Wainsbury's refuses (raced to zero), the redemption still stands —
    // the child picked it while it was available; the pool is simply
    // one short for the next picker.
    await consumeWainsburysPortion(reward.snack_product_slug);
  }
}

/** Restores the side effects of a refund: increments a stock pool back.
 * Snack-stock portions are NOT restored (matching the snacks budget's
 * unselect precedent — the physical bag is already opened/made). */
async function applyRefundEffects(
  ddb: DynamoDBDocumentClient,
  reward: RewardRow
): Promise<void> {
  if (reward.limit_type !== "stock") return;
  await ddb.send(
    new PutCommand({
      TableName: REWARDS_TABLE,
      Item: {
        ...reward,
        stock_remaining: (reward.stock_remaining ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
    })
  );
}

async function recordRedemption(
  ddb: DynamoDBDocumentClient,
  reward: RewardRow,
  childSubdomain: string,
  by: "child" | "parent"
): Promise<RewardRedemptionEvent> {
  const event: RewardRedemptionEvent = {
    child_subdomain: childSubdomain,
    redemption_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    reward_id: reward.reward_id,
    redeemed_at: new Date().toISOString(),
    redeemed_by: by,
    tickets: reward.ticket_cost,
    status: "pending",
  };
  await ddb.send(
    new PutCommand({ TableName: REDEMPTIONS_TABLE, Item: event })
  );
  return event;
}

// ── Kid routes ─────────────────────────────────────────────────────────

type KidAuth = { subdomain: string } | APIResponse;

function isKidDenied(value: KidAuth): value is APIResponse {
  return "statusCode" in value;
}

async function resolveKid(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<KidAuth> {
  const token = await extractDeviceToken(event, ddb);
  if (!token) return json(event, 401, { error: "Missing device token" });
  const device = await getDevice(ddb, token);
  if (device) return { subdomain: String(device.child_subdomain) };
  const previewSubdomain = await getPreviewChild(ddb, token);
  if (previewSubdomain) return { subdomain: previewSubdomain };
  return json(event, 401, { error: "Unknown or revoked device" });
}

async function handleKidTasks(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const [tasks, board, completions] = await Promise.all([
    listTasks(ddb),
    listBoardEntries(ddb),
    completionsForChild(ddb, auth.subdomain),
  ]);

  const completionsByTask = new Map<string, TaskCompletionEvent[]>();
  for (const c of completions) {
    const list = completionsByTask.get(c.task_id) ?? [];
    list.push(c);
    completionsByTask.set(c.task_id, list);
  }

  const entriesByTask = new Map<string, BoardEntry[]>();
  for (const entry of board) {
    const list = entriesByTask.get(entry.task_id) ?? [];
    list.push(entry);
    entriesByTask.set(entry.task_id, list);
  }

  const today = londonDate();
  const schoolDay = await resolveSchoolDay(ddb, today);

  const mine: unknown[] = [];
  for (const task of tasks) {
    if (!task.enabled) continue;
    const entries = entriesByTask.get(task.task_id) ?? [];
    const effective: BoardEntry[] =
      entries.length > 0
        ? entries
        : [
            {
              // Implicit once posting — the original pre-board behaviour.
              board_id: "",
              task_id: task.task_id,
              repeat: "once",
              ticket_reward: task.ticket_reward,
              assigned_to: [],
              posted: true,
              posted_at: null,
              completion_mode: "each_child",
              created_at: task.created_at,
              updated_at: task.updated_at,
            },
          ];
    for (const entry of effective) {
      if (!entryAppliesToChild(entry, task, auth.subdomain)) continue;
      if (!entryVisibleToday(entry, schoolDay)) continue;
      const events = completionsByTask.get(task.task_id) ?? [];
      const latest = events[0] ?? null;
      mine.push({
        task_id: task.task_id,
        board_id: entry.board_id || null,
        title: task.title,
        description: task.description,
        ticket_reward: entry.ticket_reward,
        repeat: entry.repeat,
        icon_url: task.icon ? `/ticket-icons/${task.icon}` : null,
        emoji: task.emoji ?? null,
        completed_count: events.length,
        completed_at: latest?.completed_at ?? null,
        completed_by: latest?.completed_by ?? null,
        done: entryDone(entry, events, today),
      });
    }
  }

  const totalTickets = completions.reduce((sum, c) => sum + c.tickets, 0);

  return json(event, 200, {
    tasks: mine,
    total_tickets: totalTickets,
  });
}

async function handleKidTaskHistory(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const completions = await completionsForChild(ddb, auth.subdomain, 100);
  const tasks = new Map((await listTasks(ddb)).map((t) => [t.task_id, t]));
  return json(event, 200, {
    completions: completions.map((c) => ({
      task_id: c.task_id,
      title:
        c.task_id === BONUS_TASK_ID
          ? c.label ?? "Bonus tickets"
          : tasks.get(c.task_id)?.title ?? c.task_id,
      completed_at: c.completed_at,
      completed_by: c.completed_by,
      tickets: c.tickets,
    })),
  });
}

async function handleKidComplete(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const task = await getTask(ddb, taskId);
  if (!task || !task.enabled) {
    return json(event, 404, { error: "That job isn't available any more" });
  }

  const context = await resolveCompletionContext(ddb, task, auth.subdomain);
  if (!context) {
    return json(event, 404, { error: "That job isn't available any more" });
  }

  const completion = await recordCompletion(
    ddb,
    task,
    auth.subdomain,
    "child",
    context.tickets
  );
  await unpostFirstDoneEntries(ddb, context.entries);

  const completions = await completionsForChild(ddb, auth.subdomain);
  const totalTickets = completions.reduce((sum, c) => sum + c.tickets, 0);

  return json(event, 200, {
    completion: {
      task_id: taskId,
      title: task.title,
      completed_at: completion.completed_at,
      completed_by: "child",
      tickets: completion.tickets,
    },
    total_tickets: totalTickets,
  });
}

async function handleKidUndo(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const removed = await undoLatestCompletion(ddb, auth.subdomain, taskId);
  if (!removed) {
    return json(event, 404, { error: "That job wasn't completed yet" });
  }

  const completions = await completionsForChild(ddb, auth.subdomain);
  const totalTickets = completions.reduce((sum, c) => sum + c.tickets, 0);
  return json(event, 200, { removed: true, total_tickets: totalTickets });
}

async function handleKidRewards(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const [rewards, completions, redemptions] = await Promise.all([
    listRewards(ddb),
    completionsForChild(ddb, auth.subdomain),
    redemptionsForChild(ddb, auth.subdomain),
  ]);

  // cost_pence is admin-only — never leak it to kid responses.
  const titleFor = new Map(rewards.map((r) => [r.reward_id, r.title]));
  const limitStates = new Map(
    await Promise.all(
      rewards
        .filter((r) => r.enabled)
        .map((r) => rewardLimitState(ddb, r, auth.subdomain, redemptions))
    ).then((states) =>
      rewards
        .filter((r) => r.enabled)
        .map((r, i) => [r.reward_id, states[i]])
    )
  );
  return json(event, 200, {
    rewards: rewards
      .filter((r) => r.enabled)
      .map((r) => ({
        reward_id: r.reward_id,
        title: r.title,
        description: r.description,
        ticket_cost: r.ticket_cost,
        icon_url: r.icon ? `/ticket-icons/${r.icon}` : null,
        emoji: r.emoji ?? null,
        limit: limitStates.get(r.reward_id) ?? null,
      })),
    spendable_tickets: spendableTickets(completions, redemptions),
    redemptions: redemptions.map((r) => ({
      redemption_id: r.redemption_id,
      reward_id: r.reward_id,
      title: titleFor.get(r.reward_id) ?? r.reward_id,
      redeemed_at: r.redeemed_at,
      tickets: r.tickets,
      status: r.status,
    })),
  });
}

async function handleKidRedeem(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  rewardId: string
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  const reward = await getReward(ddb, rewardId);
  if (!reward || !reward.enabled) {
    return json(event, 404, { error: "That reward isn't available any more" });
  }

  const [completions, redemptions] = await Promise.all([
    completionsForChild(ddb, auth.subdomain),
    redemptionsForChild(ddb, auth.subdomain),
  ]);
  const spendable = spendableTickets(completions, redemptions);
  if (spendable < reward.ticket_cost) {
    return json(event, 400, { error: "Not enough tickets yet — keep doing your jobs!" });
  }

  const blocked = await enforceRewardLimit(event, ddb, reward, auth.subdomain, redemptions);
  if (blocked) return blocked;

  const redemption = await recordRedemption(ddb, reward, auth.subdomain, "child");
  await applyRedemptionEffects(ddb, reward);
  return json(event, 200, {
    redemption: {
      reward_id: reward.reward_id,
      title: reward.title,
      redeemed_at: redemption.redeemed_at,
      tickets: redemption.tickets,
      status: redemption.status,
    },
    spendable_tickets: spendable - reward.ticket_cost,
  });
}

async function handleKidRewardRefund(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const auth = await resolveKid(event, ddb);
  if (isKidDenied(auth)) return auth;

  // Refund the newest PENDING redemption — once a parent marks it claimed
  // the tickets are spent for good.
  const redemptions = await redemptionsForChild(ddb, auth.subdomain);
  const pending = redemptions.find((r) => r.status === "pending");
  if (!pending) {
    return json(event, 404, { error: "Nothing to refund" });
  }
  const refundedReward = await getReward(ddb, pending.reward_id);
  await ddb.send(
    new DeleteCommand({
      TableName: REDEMPTIONS_TABLE,
      Key: {
        child_subdomain: auth.subdomain,
        redemption_id: pending.redemption_id,
      },
    })
  );
  if (refundedReward) {
    await applyRefundEffects(ddb, refundedReward);
  }

  const [completions, remaining] = await Promise.all([
    completionsForChild(ddb, auth.subdomain),
    redemptionsForChild(ddb, auth.subdomain),
  ]);
  return json(event, 200, {
    refunded: true,
    spendable_tickets: spendableTickets(completions, remaining),
  });
}

// ── Admin routes ─────────────────────────────────────────────────────

async function handleAdminListTasks(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  return json(event, 200, await listTasks(ddb));
}

async function handleAdminPutTask(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string
): Promise<APIResponse> {
  const body = parseBody(event);
  const existing = await getTask(ddb, taskId);

  const reward = Number(body.ticket_reward ?? existing?.ticket_reward ?? 1);
  if (!Number.isFinite(reward) || reward < 0 || reward > 100) {
    return json(event, 400, { error: "ticket_reward must be a number between 0 and 100" });
  }

  const assignedTo = Array.isArray(body.assigned_to)
    ? (body.assigned_to as unknown[]).map(String)
    : existing?.assigned_to ?? [];

  // icon: optional filename under ticket-icons/ (explicit null clears it;
   // absent keeps the existing row's — `??` alone can't tell the two apart).
  const iconRaw = body.icon !== undefined ? body.icon : existing?.icon ?? null;
  const icon =
    typeof iconRaw === "string" && iconRaw.trim() ? iconRaw.trim() : null;

  // emoji: optional fallback shown when there's no photo.
  const emojiRaw = body.emoji !== undefined ? body.emoji : existing?.emoji ?? null;
  const emoji =
    typeof emojiRaw === "string" && emojiRaw.trim() ? emojiRaw.trim() : null;

  const item: TaskRow = {
    task_id: taskId,
    title: String(body.title ?? existing?.title ?? taskId),
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : body.description === null
          ? null
          : existing?.description ?? null,
    ticket_reward: Math.round(reward),
    assigned_to: assignedTo,
    icon,
    emoji,
    enabled: body.enabled !== undefined ? body.enabled !== false : existing?.enabled !== false,
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TASKS_TABLE, Item: item }));
  return json(event, 200, item);
}

async function handleAdminDeleteTask(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: TASKS_TABLE, Key: { task_id: taskId } })
  );
  return json(event, 200, { deleted: true });
}

// ── Bonus awards (parent-awarded tickets, no task) ──────────────────

/** Reserved task_id for bonus awards — real tasks can't take it. */
const BONUS_TASK_ID = "bonus";

async function handleAdminBonusAward(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  childSubdomain: string
): Promise<APIResponse> {
  const body = parseBody(event);

  const label =
    typeof body.label === "string" && body.label.trim() ? body.label.trim() : "";
  if (!label) {
    return json(event, 400, { error: "label is required (e.g. \"Happy Birthday\")" });
  }
  if (label.length > 100) {
    return json(event, 400, { error: "label must be 100 characters or fewer" });
  }

  // Same cap as ticket_reward — keep in sync with the doc comment above.
  const tickets = Number(body.tickets);
  if (!Number.isFinite(tickets) || tickets < 1 || tickets > 100 || !Number.isInteger(tickets)) {
    return json(event, 400, { error: "tickets must be a whole number between 1 and 100" });
  }

  const completedAt = new Date().toISOString();
  const award: TaskCompletionEvent = {
    child_subdomain: childSubdomain,
    // Same shape as task completions (random suffix avoids same-ms collisions).
    task_completion: `${BONUS_TASK_ID}#${completedAt}#${Math.random().toString(36).slice(2, 8)}`,
    task_id: BONUS_TASK_ID,
    completed_at: completedAt,
    completed_by: "parent",
    tickets,
    label,
  };
  await ddb.send(new PutCommand({ TableName: TASK_COMPLETIONS_TABLE, Item: award }));

  const completions = await completionsForChild(ddb, childSubdomain);
  const totalTickets = completions.reduce((sum, c) => sum + c.tickets, 0);
  return json(event, 200, {
    award: {
      task_id: BONUS_TASK_ID,
      label,
      completed_at: completedAt,
      completed_by: "parent",
      tickets,
    },
    total_tickets: totalTickets,
  });
}

async function handleAdminListCompletions(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const items: TaskCompletionEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: TASK_COMPLETIONS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((response.Items ?? []) as TaskCompletionEvent[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => b.completed_at.localeCompare(a.completed_at));
  return json(event, 200, items);
}

async function handleAdminChildComplete(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const task = await getTask(ddb, taskId);
  if (!task) return json(event, 404, { error: "Task not found" });

  // Admins record things that already happened — no visibility check,
  // but the posting's reward override and first_done auto-unpost still apply.
  const entries = (await listBoardEntries(ddb)).filter(
    (e) => e.task_id === task.task_id
  );
  const tickets = entries[0]?.ticket_reward ?? task.ticket_reward;

  const completion = await recordCompletion(
    ddb,
    task,
    childSubdomain,
    "parent",
    tickets
  );
  await unpostFirstDoneEntries(ddb, entries);

  return json(event, 200, {
    completion: {
      task_id: taskId,
      title: task.title,
      completed_at: completion.completed_at,
      completed_by: "parent",
      tickets: completion.tickets,
    },
  });
}

async function handleAdminChildUndo(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  taskId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const removed = await undoLatestCompletion(ddb, childSubdomain, taskId);
  if (!removed) return json(event, 404, { error: "No completion to undo" });
  return json(event, 200, { removed: true });
}

async function handleAdminListRewards(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  return json(event, 200, await listRewards(ddb));
}

async function handleAdminPutReward(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  rewardId: string
): Promise<APIResponse> {
  const body = parseBody(event);
  const existing = await getReward(ddb, rewardId);

  const cost = Number(body.ticket_cost ?? existing?.ticket_cost ?? 1);
  if (!Number.isFinite(cost) || cost < 1 || cost > 500) {
    return json(event, 400, { error: "ticket_cost must be a number between 1 and 500" });
  }

  // cost_pence is optional admin bookkeeping (what the prize really costs).
  // Explicit null/"" clears it; absent keeps the existing row's.
  const costPenceRaw = body.cost_pence !== undefined ? body.cost_pence : existing?.cost_pence ?? null;
  const costPence =
    costPenceRaw === null || costPenceRaw === "" || costPenceRaw === undefined
      ? null
      : Number(costPenceRaw);
  if (costPence !== null && (!Number.isFinite(costPence) || costPence < 0 || !Number.isInteger(costPence))) {
    return json(event, 400, { error: "cost_pence must be a whole number of pence (or empty)" });
  }

  // icon: optional filename under ticket-icons/ (explicit null clears it;
  // absent keeps the existing row's — `??` alone can't tell the two apart).
  const iconRaw = body.icon !== undefined ? body.icon : existing?.icon ?? null;
  const icon =
    typeof iconRaw === "string" && iconRaw.trim() ? iconRaw.trim() : null;

  // emoji: optional fallback shown when there's no photo.
  const emojiRaw = body.emoji !== undefined ? body.emoji : existing?.emoji ?? null;
  const emoji =
    typeof emojiRaw === "string" && emojiRaw.trim() ? emojiRaw.trim() : null;

  // Limit: how redemptions are capped. Defaults keep the existing row's
  // (or unlimited for a brand-new reward).
  const limitTypeRaw = String(body.limit_type ?? existing?.limit_type ?? "unlimited");
  if (!LIMIT_TYPES.includes(limitTypeRaw as RewardLimitType)) {
    return json(event, 400, {
      error: `limit_type must be one of ${LIMIT_TYPES.join(", ")}`,
    });
  }
  const limitType = limitTypeRaw as RewardLimitType;

  let stockRemaining: number | null =
    body.stock_remaining !== undefined
      ? Number(body.stock_remaining)
      : existing?.stock_remaining ?? null;
  if (limitType === "stock") {
    if (stockRemaining === null) stockRemaining = 0;
    if (!Number.isFinite(stockRemaining) || stockRemaining < 0 || !Number.isInteger(stockRemaining)) {
      return json(event, 400, { error: "stock_remaining must be a whole number (0 or more)" });
    }
  } else {
    stockRemaining = null;
  }

  let period: RewardPeriod | null = null;
  if (limitType === "period") {
    const periodRaw = String(body.period ?? existing?.period ?? "");
    if (!REWARD_PERIODS.includes(periodRaw as RewardPeriod)) {
      return json(event, 400, {
        error: `period must be one of ${REWARD_PERIODS.join(", ")}`,
      });
    }
    period = periodRaw as RewardPeriod;
  }

  let snackProductSlug: string | null = null;
  if (limitType === "snack_stock") {
    const slugRaw = body.snack_product_slug ?? existing?.snack_product_slug ?? null;
    snackProductSlug =
      typeof slugRaw === "string" && slugRaw.trim() ? slugRaw.trim() : null;
    if (!snackProductSlug) {
      return json(event, 400, {
        error: "snack_product_slug is required for snack_stock rewards",
      });
    }
  }

  const item: RewardRow = {
    reward_id: rewardId,
    title: String(body.title ?? existing?.title ?? rewardId),
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : body.description === null
          ? null
          : existing?.description ?? null,
    ticket_cost: Math.round(cost),
    cost_pence: costPence,
    icon,
    emoji,
    limit_type: limitType,
    stock_remaining: stockRemaining,
    period,
    snack_product_slug: snackProductSlug,
    enabled: body.enabled !== undefined ? body.enabled !== false : existing?.enabled !== false,
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: REWARDS_TABLE, Item: item }));
  return json(event, 200, item);
}

async function handleAdminDeleteReward(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  rewardId: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: REWARDS_TABLE, Key: { reward_id: rewardId } })
  );
  return json(event, 200, { deleted: true });
}

async function handleAdminListRedemptions(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  const items: RewardRedemptionEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: REDEMPTIONS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((response.Items ?? []) as RewardRedemptionEvent[]));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  items.sort((a, b) => b.redeemed_at.localeCompare(a.redeemed_at));
  return json(event, 200, items);
}

async function handleAdminChildRedeem(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  rewardId: string,
  childSubdomain: string
): Promise<APIResponse> {
  const reward = await getReward(ddb, rewardId);
  if (!reward) return json(event, 404, { error: "Reward not found" });

  // Parent-initiated redeems respect limits too — a parent handing over the
  // last bag of popcorn shouldn't succeed either.
  const redemptions = await redemptionsForChild(ddb, childSubdomain);
  const blocked = await enforceRewardLimit(event, ddb, reward, childSubdomain, redemptions);
  if (blocked) return blocked;

  const redemption = await recordRedemption(ddb, reward, childSubdomain, "parent");
  await applyRedemptionEffects(ddb, reward);
  return json(event, 200, {
    redemption: {
      reward_id: rewardId,
      title: reward.title,
      redeemed_at: redemption.redeemed_at,
      tickets: redemption.tickets,
      status: redemption.status,
    },
  });
}

async function handleAdminRedemptionAction(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  childSubdomain: string,
  redemptionId: string,
  action: "refund" | "claim"
): Promise<APIResponse> {
  const response = await ddb.send(
    new GetCommand({
      TableName: REDEMPTIONS_TABLE,
      Key: { child_subdomain: childSubdomain, redemption_id: redemptionId },
    })
  );
  const redemption = (response.Item as RewardRedemptionEvent) ?? null;
  if (!redemption) return json(event, 404, { error: "Redemption not found" });

  if (action === "refund") {
    await ddb.send(
      new DeleteCommand({
        TableName: REDEMPTIONS_TABLE,
        Key: { child_subdomain: childSubdomain, redemption_id: redemptionId },
      })
    );
    const refundedReward = await getReward(ddb, redemption.reward_id);
    if (refundedReward) {
      await applyRefundEffects(ddb, refundedReward);
    }
    return json(event, 200, { refunded: true });
  }

  // claim: mark the reward received. Only pending redemptions can be claimed.
  if (redemption.status === "claimed") {
    return json(event, 400, { error: "Already claimed" });
  }
  await ddb.send(
    new PutCommand({
      TableName: REDEMPTIONS_TABLE,
      Item: { ...redemption, status: "claimed", claimed_at: new Date().toISOString() },
    })
  );
  return json(event, 200, { claimed: true });
}

// ── Admin routes: job board ──────────────────────────────────────────

async function handleAdminListBoard(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse> {
  return json(event, 200, await listBoardEntries(ddb));
}

async function handleAdminPutBoard(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  boardId: string
): Promise<APIResponse> {
  const body = parseBody(event);
  const existing = await getBoardEntry(ddb, boardId);

  const taskId = String(body.task_id ?? existing?.task_id ?? "");
  if (!taskId) {
    return json(event, 400, { error: "task_id is required" });
  }
  const task = await getTask(ddb, taskId);
  if (!task) {
    return json(event, 404, { error: "No task with that task_id" });
  }

  const repeatRaw = String(body.repeat ?? existing?.repeat ?? "once");
  if (!REPEATS.includes(repeatRaw as BoardRepeat)) {
    return json(event, 400, { error: `repeat must be one of ${REPEATS.join(", ")}` });
  }
  const repeat = repeatRaw as BoardRepeat;

  const reward = Number(body.ticket_reward ?? existing?.ticket_reward ?? task.ticket_reward);
  if (!Number.isFinite(reward) || reward < 0 || reward > 100) {
    return json(event, 400, { error: "ticket_reward must be a number between 0 and 100" });
  }

  const modeRaw = String(body.completion_mode ?? existing?.completion_mode ?? "each_child");
  if (!COMPLETION_MODES.includes(modeRaw as BoardCompletionMode)) {
    return json(event, 400, { error: "completion_mode must be each_child or first_done" });
  }

  const assignedTo = Array.isArray(body.assigned_to)
    ? (body.assigned_to as unknown[]).map(String)
    : existing?.assigned_to ?? [];

  const posted =
    repeat === "on_demand"
      ? body.posted !== undefined
        ? body.posted !== false
        : existing?.posted ?? false
      : true;

  // Re-posting re-anchors the "done since" window; unposting clears it.
  let postedAt: string | null;
  if (!posted) {
    postedAt = null;
  } else if (existing?.posted && existing.posted_at) {
    postedAt = existing.posted_at;
  } else {
    postedAt = new Date().toISOString();
  }

  const now = new Date().toISOString();
  const item: BoardEntry = {
    board_id: boardId,
    task_id: taskId,
    repeat,
    ticket_reward: Math.round(reward),
    assigned_to: assignedTo,
    posted,
    posted_at: postedAt,
    completion_mode: modeRaw as BoardCompletionMode,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await ddb.send(new PutCommand({ TableName: JOB_BOARD_TABLE, Item: item }));
  return json(event, 200, item);
}

async function handleAdminDeleteBoard(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  boardId: string
): Promise<APIResponse> {
  await ddb.send(
    new DeleteCommand({ TableName: JOB_BOARD_TABLE, Key: { board_id: boardId } })
  );
  return json(event, 200, { deleted: true });
}

// ── Router ─────────────────────────────────────────────────────────

export async function tryHandleTaskRoute(
  event: APIGatewayEvent,
  method: string,
  resource: string,
  resourceId: string,
  ddb: DynamoDBDocumentClient
): Promise<APIResponse | null> {
  // Admin icon upload: POST /tasks/icons (base64 image → S3 ticket-icons/)
  if (resource === "tasks" && resourceId === "icons" && method === "POST") {
    return handleAdminUploadIcon(event);
  }

  // Kid routes: /kid/tasks[/{taskId}/{action}]
  if (resource === "kid" && (resourceId === "tasks" || resourceId.startsWith("tasks/"))) {
    const rest = resourceId === "tasks" ? "" : resourceId.slice("tasks/".length);
    const [taskId, action] = rest.split("/");
    if (method === "GET" && !taskId) return handleKidTasks(event, ddb);
    if (method === "GET" && taskId === "history") return handleKidTaskHistory(event, ddb);
    if (!taskId) return json(event, 404, { error: "Not found" });
    if (method === "GET" && !action) return handleKidTasks(event, ddb);
    if (method === "POST" && action === "complete") return handleKidComplete(event, ddb, taskId);
    if (method === "POST" && action === "undo") return handleKidUndo(event, ddb, taskId);
    return json(event, 404, { error: "Not found" });
  }

  // Kid routes: /kid/rewards[/{rewardId}/redeem | /refund]
  if (resource === "kid" && (resourceId === "rewards" || resourceId.startsWith("rewards/"))) {
    const rest = resourceId === "rewards" ? "" : resourceId.slice("rewards/".length);
    const [rewardId, action] = rest.split("/");
    if (method === "GET" && !rewardId) return handleKidRewards(event, ddb);
    // "refund" is an action, not a rewardId — match it BEFORE the generic
    // rewardId routes (same class of bug as /kid/tasks/history parsing as
    // taskId="history").
    if (method === "POST" && rewardId === "refund" && !action) {
      return handleKidRewardRefund(event, ddb);
    }
    if (!rewardId) return json(event, 404, { error: "Not found" });
    if (method === "POST" && action === "redeem") return handleKidRedeem(event, ddb, rewardId);
    return json(event, 404, { error: "Not found" });
  }

  // Admin routes: /tasks[/{taskId}[/{...}]]
  if (resource === "tasks") {
    // Bonus awards: POST /tasks/bonus/children/{child}/award — must be
    // matched BEFORE the generic PUT/DELETE (a "bonus" task row must never
    // exist; the id is reserved for parent-awarded tickets).
    {
      const [bonusId, bonusSub, bonusChild, bonusAction] = resourceId.split("/");
      if (
        method === "POST" &&
        bonusId === "bonus" &&
        bonusSub === "children" &&
        bonusChild &&
        bonusAction === "award"
      ) {
        return handleAdminBonusAward(event, ddb, bonusChild);
      }
    }
    if ((method === "PUT" || method === "DELETE") && resourceId === "bonus") {
      return json(event, 400, {
        error: '"bonus" is reserved for parent-awarded tickets — pick a different task id',
      });
    }
    if (method === "GET" && !resourceId) return handleAdminListTasks(event, ddb);
    if (method === "PUT" && resourceId) return handleAdminPutTask(event, ddb, resourceId);
    if (method === "DELETE" && resourceId) return handleAdminDeleteTask(event, ddb, resourceId);

    const [taskId, subResource, childSubdomain, action] = resourceId.split("/");
    if (method === "GET" && resourceId === "completions") {
      return handleAdminListCompletions(event, ddb);
    }
    if (method === "POST" && taskId && subResource === "children" && childSubdomain && action === "complete") {
      return handleAdminChildComplete(event, ddb, taskId, childSubdomain);
    }
    if (method === "POST" && taskId && subResource === "children" && childSubdomain && action === "undo") {
      return handleAdminChildUndo(event, ddb, taskId, childSubdomain);
    }
    return json(event, 404, { error: "Not found" });
  }

  // Admin routes: /rewards[/{rewardId}[/{...}]]
  if (resource === "rewards") {
    // "redemptions" is a sub-route, not a rewardId — match it BEFORE the
    // generic {rewardId} PUT/DELETE (same shadowing class as
    // /tasks/completions).
    if (method === "GET" && resourceId === "redemptions") {
      return handleAdminListRedemptions(event, ddb);
    }
    if (method === "GET" && !resourceId) return handleAdminListRewards(event, ddb);
    if (method === "PUT" && resourceId) return handleAdminPutReward(event, ddb, resourceId);
    if (method === "DELETE" && resourceId) return handleAdminDeleteReward(event, ddb, resourceId);

    const [rewardId, subResource, childSubdomain, action] = resourceId.split("/");
    if (method === "POST" && rewardId && subResource === "children" && childSubdomain && action === "redeem") {
      return handleAdminChildRedeem(event, ddb, rewardId, childSubdomain);
    }
    // /rewards/redemptions/{child}/{redemptionId}/refund|claim
    // Path splits as: rewardId="redemptions", subResource={child},
    // childSubdomain={redemptionId}, action="refund"|"claim".
    if (
      method === "POST" &&
      rewardId === "redemptions" &&
      subResource &&
      childSubdomain &&
      (action === "refund" || action === "claim")
    ) {
      return handleAdminRedemptionAction(event, ddb, subResource, childSubdomain, action);
    }
    return json(event, 404, { error: "Not found" });
  }

  // Admin routes: /board[/{boardId}]
  if (resource === "board") {
    if (method === "GET" && !resourceId) return handleAdminListBoard(event, ddb);
    if (method === "PUT" && resourceId) return handleAdminPutBoard(event, ddb, resourceId);
    if (method === "DELETE" && resourceId) return handleAdminDeleteBoard(event, ddb, resourceId);
    return json(event, 404, { error: "Not found" });
  }

  return null;
}
