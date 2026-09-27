import { useCallback, useEffect, useRef, useState } from "react";
import {
  awardBonusTickets,
  claimRewardForChild,
  completeTaskForChild,
  deleteBoardEntry,
  deleteReward,
  deleteTask,
  getBoard,
  getChildren,
  getRewardRedemptions,
  getTaskCompletions,
  getTasks,
  getRewards,
  putBoardEntry,
  putReward,
  putTask,
  redeemRewardForChild,
  refundRewardForChild,
  undoTaskForChild,
  uploadTicketIcon,
  type BoardCompletionMode,
  type BoardEntry,
  type BoardRepeat,
  type Child,
  type Reward,
  type RewardLimitType,
  type RewardPeriod,
  type RewardRedemption,
  type Task,
  type TaskCompletion,
} from "./api";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function friendlyDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface TaskDraft {
  title: string;
  description: string;
  ticket_reward: string;
  assigned_to: string[];
}

const EMPTY_DRAFT: TaskDraft = { title: "", description: "", ticket_reward: "1", assigned_to: [] };

interface RewardDraft {
  title: string;
  description: string;
  ticket_cost: string;
  cost_pence: string;
  limit_type: RewardLimitType;
  stock_remaining: string;
  period: RewardPeriod;
  snack_product_slug: string;
}

const EMPTY_REWARD_DRAFT: RewardDraft = {
  title: "",
  description: "",
  ticket_cost: "5",
  cost_pence: "",
  limit_type: "unlimited",
  stock_remaining: "",
  period: "month",
  snack_product_slug: "",
};

const LIMIT_TYPE_LABELS: Record<RewardLimitType, string> = {
  unlimited: "Unlimited",
  stock: "Stock pool",
  period: "1 per period",
  snack_stock: "Snack stock (live)",
};

const PERIOD_LABELS: Record<RewardPeriod, string> = {
  week: "week",
  month: "month",
  summer: "summer",
  term: "term",
  year: "year",
};

/** Draft state for editing an existing reward (null = not editing). */
interface RewardEditDraft extends RewardDraft {
  reward_id: string;
}

interface BoardDraft {
  task_id: string;
  repeat: BoardRepeat;
  ticket_reward: string;
  assigned_to: string[];
  completion_mode: BoardCompletionMode;
}

const EMPTY_BOARD_DRAFT: BoardDraft = {
  task_id: "",
  repeat: "daily",
  ticket_reward: "",
  assigned_to: [],
  completion_mode: "each_child",
};

interface BonusDraft {
  label: string;
  tickets: string;
  child: string;
}

const EMPTY_BONUS_DRAFT: BonusDraft = { label: "", tickets: "1", child: "" };

const REPEAT_LABELS: Record<BoardRepeat, string> = {
  once: "One-off",
  daily: "Every day",
  school_day: "School days only",
  on_demand: "When I post it",
};

/** Formats whole pence as £x.yy (or "free" for 0). */
function friendlyCost(pence: number | null): string {
  if (pence === null) return "—";
  if (pence === 0) return "free";
  return `£${(pence / 100).toFixed(2)}`;
}

/** Human summary of a reward's limit for the card list. */
function limitSummary(reward: Reward): string {
  switch (reward.limit_type) {
    case "stock":
      return `Stock pool · ${reward.stock_remaining ?? 0} left`;
    case "period":
      return `1 per ${reward.period ?? "period"}`;
    case "snack_stock":
      return `Snack stock · ${reward.snack_product_slug ?? ""}`;
    default:
      return "Unlimited";
  }
}

/**
 * Limit controls shared by the create and edit reward forms.
 * Only the fields relevant to the chosen limit type are shown.
 */
function RewardLimitFields({
  draft,
  onChange,
}: {
  draft: RewardDraft;
  onChange: (patch: Partial<RewardDraft>) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3 items-end">
      <label className="flex flex-col gap-1 w-44">
        <span className="text-sm font-semibold">Limit</span>
        <select
          value={draft.limit_type}
          onChange={(e) => onChange({ limit_type: e.target.value as RewardLimitType })}
          className="px-3 py-2 rounded border border-border bg-surface-solid"
        >
          {(Object.keys(LIMIT_TYPE_LABELS) as RewardLimitType[]).map((t) => (
            <option key={t} value={t}>{LIMIT_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </label>
      {draft.limit_type === "stock" && (
        <label className="flex flex-col gap-1 w-44">
          <span className="text-sm font-semibold">Stock remaining</span>
          <input
            type="number"
            min={0}
            step={1}
            value={draft.stock_remaining}
            onChange={(e) => onChange({ stock_remaining: e.target.value })}
            placeholder="e.g. 24"
            className="px-3 py-2 rounded border border-border bg-surface-solid"
          />
        </label>
      )}
      {draft.limit_type === "period" && (
        <label className="flex flex-col gap-1 w-44">
          <span className="text-sm font-semibold">Period</span>
          <select
            value={draft.period}
            onChange={(e) => onChange({ period: e.target.value as RewardPeriod })}
            className="px-3 py-2 rounded border border-border bg-surface-solid"
          >
            {(Object.keys(PERIOD_LABELS) as RewardPeriod[]).map((p) => (
              <option key={p} value={p}>1 per {PERIOD_LABELS[p]}</option>
            ))}
          </select>
        </label>
      )}
      {draft.limit_type === "snack_stock" && (
        <label className="flex flex-col gap-1 flex-1 min-w-48">
          <span className="text-sm font-semibold">Wainsbury's product slug</span>
          <input
            type="text"
            value={draft.snack_product_slug}
            onChange={(e) => onChange({ snack_product_slug: e.target.value })}
            placeholder="e.g. butterkist-popcorn-toffee-6x20g"
            className="px-3 py-2 rounded border border-border bg-surface-solid"
          />
        </label>
      )}
    </div>
  );
}

/**
 * Photo picker + emoji fallback for a task/reward card. "Take or choose
 * photo" opens the file picker (a phone browser offers the camera directly);
 * the file is uploaded to S3 and onUploaded fires with the new icon
 * filename. The emoji field sets what shows when there's no photo.
 * A hidden input is re-used across picks; `capture` is unset so phones
 * offer both camera and library.
 */
function IconUpload({
  accessToken,
  icon,
  emoji,
  onUploaded,
  onEmoji,
  disabled,
}: {
  accessToken: string;
  /** Current icon filename (null = none). */
  icon: string | null;
  /** Fallback emoji shown when there's no photo (null = none). */
  emoji: string | null;
  onUploaded: (icon: string) => void;
  onEmoji: (emoji: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await uploadTicketIcon(accessToken, file);
      onUploaded(saved.icon);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex items-center gap-3">
      {icon ? (
        <img
          src={`/ticket-icons/${icon}`}
          alt=""
          className="w-12 h-12 rounded-lg object-cover border border-border"
        />
      ) : (
        <span className="w-12 h-12 rounded-lg border border-dashed border-border flex items-center justify-center text-muted text-xl">
          📷
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="min-h-9 px-3 rounded-md border border-border bg-surface-solid font-semibold text-sm cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
      >
        {busy ? "Uploading…" : icon ? "Change photo" : "Take or choose photo"}
      </button>
      {icon && !busy && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onUploaded("")}
          className="min-h-9 px-3 rounded-md border border-border bg-surface-solid font-semibold text-sm cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          Remove
        </button>
      )}
      {error && <span className="text-danger text-sm">{error}</span>}
      <label className="flex items-center gap-2 text-sm font-semibold">
        Emoji
        <input
          type="text"
          value={emoji ?? ""}
          onChange={(e) => onEmoji(e.target.value.trim() ? e.target.value.trim() : null)}
          placeholder="🍬"
          maxLength={8}
          disabled={disabled}
          className="w-12 px-2 py-1 rounded border border-border bg-surface-solid text-center text-lg"
        />
      </label>
    </div>
  );
}

export function TasksPanel({ accessToken }: { accessToken: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [completions, setCompletions] = useState<TaskCompletion[]>([]);
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [redemptions, setRedemptions] = useState<RewardRedemption[]>([]);
  const [board, setBoard] = useState<BoardEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [rewardDraft, setRewardDraft] = useState<RewardDraft>(EMPTY_REWARD_DRAFT);
  const [rewardEdit, setRewardEdit] = useState<RewardEditDraft | null>(null);
  const [boardDraft, setBoardDraft] = useState<BoardDraft>(EMPTY_BOARD_DRAFT);
  const [bonusDraft, setBonusDraft] = useState<BonusDraft>(EMPTY_BONUS_DRAFT);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasksData, childrenData, completionsData, rewardsData, redemptionsData, boardData] = await Promise.all([
        getTasks(accessToken),
        getChildren(accessToken),
        getTaskCompletions(accessToken),
        getRewards(accessToken),
        getRewardRedemptions(accessToken),
        getBoard(accessToken),
      ]);
      setTasks(tasksData);
      setChildren(childrenData);
      setCompletions(completionsData);
      setRewards(rewardsData);
      setRedemptions(redemptionsData);
      setBoard(boardData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshCompletions = async () => {
    try {
      setCompletions(await getTaskCompletions(accessToken));
    } catch {
      // Keep the stale list — the action itself already reported success.
    }
  };

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    const reward = Number(draft.ticket_reward);
    if (!Number.isFinite(reward) || reward < 1 || reward > 100) {
      setError("Tickets must be between 1 and 100");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const taskId = slugify(title) || `task-${Date.now()}`;
      const existing = tasks?.find((t) => t.task_id === taskId);
      const saved = await putTask(accessToken, existing ? `${taskId}-${Date.now().toString(36)}` : taskId, {
        title,
        description: draft.description.trim() || null,
        ticket_reward: Math.round(reward),
        assigned_to: draft.assigned_to,
        enabled: true,
      });
      setTasks((prev) =>
        [...(prev ?? []), saved].sort((a, b) => a.title.localeCompare(b.title))
      );
      setDraft(EMPTY_DRAFT);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSaving(false);
    }
  };

  const updateTask = async (taskId: string, patch: Partial<Task>) => {
    const existing = tasks?.find((t) => t.task_id === taskId);
    if (!existing) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putTask(accessToken, taskId, { ...existing, ...patch });
      setTasks((prev) =>
        (prev ?? []).map((t) => (t.task_id === taskId ? saved : t)).sort((a, b) =>
          a.title.localeCompare(b.title)
        )
      );
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const removeTask = async (taskId: string) => {
    if (!window.confirm("Delete this task? Its completion history stays, but the task disappears from the kids' app.")) return;
    setSaving(true);
    setError(null);
    try {
      await deleteTask(accessToken, taskId);
      setTasks((prev) => (prev ?? []).filter((t) => t.task_id !== taskId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSaving(false);
    }
  };

  const completeForChild = async (taskId: string, childSubdomain: string) => {
    setSaving(true);
    setError(null);
    try {
      await completeTaskForChild(accessToken, taskId, childSubdomain);
      await refreshCompletions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark complete");
    } finally {
      setSaving(false);
    }
  };

  const undoForChild = async (taskId: string, childSubdomain: string) => {
    setSaving(true);
    setError(null);
    try {
      await undoTaskForChild(accessToken, taskId, childSubdomain);
      await refreshCompletions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setSaving(false);
    }
  };

  const awardBonus = async (e: React.FormEvent) => {
    e.preventDefault();
    const label = bonusDraft.label.trim();
    if (!label || !bonusDraft.child) return;
    const tickets = Number(bonusDraft.tickets);
    if (!Number.isFinite(tickets) || tickets < 1 || tickets > 100 || !Number.isInteger(tickets)) {
      setError("Tickets must be a whole number between 1 and 100");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await awardBonusTickets(accessToken, bonusDraft.child, { label, tickets: Math.round(tickets) });
      await refreshCompletions();
      setBonusDraft({ ...EMPTY_BONUS_DRAFT, child: bonusDraft.child });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to award tickets");
    } finally {
      setSaving(false);
    }
  };

  const saveBoardEntry = async (boardId: string, patch: Partial<BoardEntry>) => {
    const existing = board?.find((e) => e.board_id === boardId);
    setSaving(true);
    setError(null);
    try {
      const saved = await putBoardEntry(accessToken, boardId, { ...existing, ...patch });
      setBoard((prev) =>
        (prev ?? []).map((e) => (e.board_id === boardId ? saved : e))
      );
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const createBoardEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const taskId = boardDraft.task_id;
    if (!taskId) {
      setError("Pick a task to post");
      return;
    }
    const reward = Number(boardDraft.ticket_reward);
    if (!Number.isFinite(reward) || reward < 1 || reward > 100) {
      setError("Tickets must be between 1 and 100");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const baseId = `${taskId}-${boardDraft.repeat}`;
      const existing = board?.find((e) => e.board_id === baseId);
      const boardId = existing ? `${baseId}-${Date.now().toString(36)}` : baseId;
      const saved = await putBoardEntry(accessToken, boardId, {
        task_id: taskId,
        repeat: boardDraft.repeat,
        ticket_reward: Math.round(reward),
        assigned_to: boardDraft.assigned_to,
        completion_mode: boardDraft.completion_mode,
        posted: boardDraft.repeat === "on_demand" ? true : undefined,
      });
      setBoard((prev) => [...(prev ?? []), saved]);
      setBoardDraft({ ...EMPTY_BOARD_DRAFT, task_id: "" });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post the job");
    } finally {
      setSaving(false);
    }
  };

  const removeBoardEntry = async (boardId: string) => {
    if (!window.confirm("Remove this posting? The task stays in the library — it just stops being offered.")) return;
    setSaving(true);
    setError(null);
    try {
      await deleteBoardEntry(accessToken, boardId);
      setBoard((prev) => (prev ?? []).filter((e) => e.board_id !== boardId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setSaving(false);
    }
  };

  const refreshRedemptions = async () => {
    try {
      setRedemptions(await getRewardRedemptions(accessToken));
    } catch {
      // Keep the stale list — the action itself already reported success.
    }
  };

  /**
   * Validates the limit portion of a reward draft and returns the PUT fields
   * (or null after setting an error message).
   */
  const draftLimitFields = (
    draft: RewardDraft,
    setError: (msg: string) => void
  ): Partial<Reward> | null => {
    if (draft.limit_type === "stock") {
      const stock = Number(draft.stock_remaining);
      if (draft.stock_remaining.trim() === "" || !Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock)) {
        setError("Stock remaining must be a whole number (0 or more)");
        return null;
      }
      return { limit_type: "stock", stock_remaining: stock, period: null, snack_product_slug: null };
    }
    if (draft.limit_type === "period") {
      return { limit_type: "period", period: draft.period, stock_remaining: null, snack_product_slug: null };
    }
    if (draft.limit_type === "snack_stock") {
      const slug = draft.snack_product_slug.trim();
      if (!slug) {
        setError("Snack stock rewards need the Wainsbury's product slug");
        return null;
      }
      return { limit_type: "snack_stock", snack_product_slug: slug, stock_remaining: null, period: null };
    }
    return { limit_type: "unlimited", stock_remaining: null, period: null, snack_product_slug: null };
  };

  const createReward = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = rewardDraft.title.trim();
    if (!title) return;
    const cost = Number(rewardDraft.ticket_cost);
    if (!Number.isFinite(cost) || cost < 1 || cost > 500) {
      setError("Tickets must be between 1 and 500");
      return;
    }
    const costPence = rewardDraft.cost_pence.trim() === "" ? null : Math.round(Number(rewardDraft.cost_pence) * 100);
    if (costPence !== null && (!Number.isFinite(costPence) || costPence < 0)) {
      setError("Cost must be a valid amount in pounds (or empty)");
      return;
    }
    const limitFields = draftLimitFields(rewardDraft, setError);
    if (!limitFields) return;
    setSaving(true);
    setError(null);
    try {
      const rewardId = slugify(title) || `reward-${Date.now()}`;
      const existing = rewards?.find((r) => r.reward_id === rewardId);
      const saved = await putReward(accessToken, existing ? `${rewardId}-${Date.now().toString(36)}` : rewardId, {
        title,
        description: rewardDraft.description.trim() || null,
        ticket_cost: Math.round(cost),
        cost_pence: costPence,
        enabled: true,
        ...limitFields,
      });
      setRewards((prev) =>
        [...(prev ?? []), saved].sort((a, b) =>
          a.ticket_cost - b.ticket_cost || a.title.localeCompare(b.title)
        )
      );
      setRewardDraft(EMPTY_REWARD_DRAFT);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create reward");
    } finally {
      setSaving(false);
    }
  };

  const updateReward = async (rewardId: string, patch: Partial<Reward>) => {
    const existing = rewards?.find((r) => r.reward_id === rewardId);
    if (!existing) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putReward(accessToken, rewardId, { ...existing, ...patch });
      setRewards((prev) =>
        (prev ?? []).map((r) => (r.reward_id === rewardId ? saved : r)).sort((a, b) =>
          a.ticket_cost - b.ticket_cost || a.title.localeCompare(b.title)
        )
      );
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  /** Puts a reward card into edit mode with its current values loaded into the draft. */
  const startEditReward = (reward: Reward) => {
    setRewardEdit({
      reward_id: reward.reward_id,
      title: reward.title,
      description: reward.description ?? "",
      ticket_cost: String(reward.ticket_cost),
      cost_pence: reward.cost_pence === null ? "" : (reward.cost_pence / 100).toFixed(2),
      limit_type: reward.limit_type ?? "unlimited",
      stock_remaining: reward.stock_remaining === null ? "" : String(reward.stock_remaining),
      period: reward.period ?? "month",
      snack_product_slug: reward.snack_product_slug ?? "",
    });
  };

  const saveEditReward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rewardEdit) return;
    const title = rewardEdit.title.trim();
    if (!title) return;
    const cost = Number(rewardEdit.ticket_cost);
    if (!Number.isFinite(cost) || cost < 1 || cost > 500) {
      setError("Tickets must be between 1 and 500");
      return;
    }
    const costPence = rewardEdit.cost_pence.trim() === "" ? null : Math.round(Number(rewardEdit.cost_pence) * 100);
    if (costPence !== null && (!Number.isFinite(costPence) || costPence < 0)) {
      setError("Cost must be a valid amount in pounds (or empty)");
      return;
    }
    const limitFields = draftLimitFields(rewardEdit, setError);
    if (!limitFields) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putReward(accessToken, rewardEdit.reward_id, {
        title,
        description: rewardEdit.description.trim() || null,
        ticket_cost: Math.round(cost),
        cost_pence: costPence,
        ...limitFields,
      });
      setRewards((prev) =>
        (prev ?? []).map((r) => (r.reward_id === saved.reward_id ? saved : r)).sort((a, b) =>
          a.ticket_cost - b.ticket_cost || a.title.localeCompare(b.title)
        )
      );
      setRewardEdit(null);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save reward");
    } finally {
      setSaving(false);
    }
  };

  const removeReward = async (rewardId: string) => {
    if (!window.confirm("Delete this reward? Redemption history stays, but the reward disappears from the kids' app.")) return;
    setSaving(true);
    setError(null);
    try {
      await deleteReward(accessToken, rewardId);
      setRewards((prev) => (prev ?? []).filter((r) => r.reward_id !== rewardId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSaving(false);
    }
  };

  const redeemForChild = async (rewardId: string, childSubdomain: string) => {
    setSaving(true);
    setError(null);
    try {
      await redeemRewardForChild(accessToken, rewardId, childSubdomain);
      await refreshRedemptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to redeem");
    } finally {
      setSaving(false);
    }
  };

  const redemptionAction = async (
    childSubdomain: string,
    redemptionId: string,
    action: "refund" | "claim"
  ) => {
    setSaving(true);
    setError(null);
    try {
      if (action === "refund") {
        await refundRewardForChild(accessToken, childSubdomain, redemptionId);
      } else {
        await claimRewardForChild(accessToken, childSubdomain, redemptionId);
      }
      await refreshRedemptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update redemption");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  const childName = (sub: string) =>
    children.find((c) => c.subdomain === sub)?.name ?? sub;

  const completionsByTaskChild = new Map<string, TaskCompletion[]>();
  for (const c of completions) {
    const key = `${c.task_id}/${c.child_subdomain}`;
    const list = completionsByTaskChild.get(key) ?? [];
    list.push(c);
    completionsByTaskChild.set(key, list);
  }

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="p-3 px-4 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm">
          Saved ✓
        </div>
      )}

      {/* New task form */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Add a task</h2>
        <p className="text-muted text-sm mb-4">
          Tasks appear in the kids' Tickets app. Completing one earns its ticket
          reward — tickets are tracked separately from snack budgets.
        </p>
        <form onSubmit={createTask} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 flex-1 min-w-48">
              <span className="text-sm font-semibold">Title</span>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="e.g. Make your bed"
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
            <label className="flex flex-col gap-1 w-28">
              <span className="text-sm font-semibold">Tickets</span>
              <input
                type="number"
                min={1}
                max={100}
                value={draft.ticket_reward}
                onChange={(e) => setDraft({ ...draft, ticket_reward: e.target.value })}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">Description (optional)</span>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="e.g. Before breakfast, every day"
              className="px-3 py-2 rounded border border-border bg-surface-solid"
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <span className="text-sm font-semibold">For (leave empty for everyone)</span>
            <div className="flex flex-wrap gap-3">
              {children.map((c) => (
                <label key={c.subdomain} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.assigned_to.includes(c.subdomain)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        assigned_to: e.target.checked
                          ? [...draft.assigned_to, c.subdomain]
                          : draft.assigned_to.filter((s) => s !== c.subdomain),
                      })
                    }
                    disabled={saving}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={saving || !draft.title.trim()}
            className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none self-start"
          >
            {saving ? "Adding…" : "Add task"}
          </button>
        </form>
      </section>

      {/* Bonus tickets */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Bonus tickets</h2>
        <p className="text-muted text-sm mb-4">
          Give a child tickets without a task — for birthdays, great attitude,
          or anything else worth celebrating. They count towards the child's
          total and show in their "My tickets" list, but never appear as a job.
        </p>
        <form onSubmit={awardBonus} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 flex-1 min-w-48">
              <span className="text-sm font-semibold">What is it for?</span>
              <input
                type="text"
                value={bonusDraft.label}
                onChange={(e) => setBonusDraft({ ...bonusDraft, label: e.target.value })}
                placeholder="e.g. Happy Birthday"
                maxLength={100}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
            <label className="flex flex-col gap-1 w-28">
              <span className="text-sm font-semibold">Tickets</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={bonusDraft.tickets}
                onChange={(e) => setBonusDraft({ ...bonusDraft, tickets: e.target.value })}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
            <label className="flex flex-col gap-1 w-44">
              <span className="text-sm font-semibold">Child</span>
              <select
                value={bonusDraft.child}
                onChange={(e) => setBonusDraft({ ...bonusDraft, child: e.target.value })}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              >
                <option value="" disabled>
                  Pick a child…
                </option>
                {children.map((c) => (
                  <option key={c.subdomain} value={c.subdomain}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            disabled={saving || !bonusDraft.label.trim() || !bonusDraft.child}
            className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none self-start"
          >
            {saving ? "Giving…" : "Give tickets"}
          </button>
        </form>
      </section>

      {/* Task list */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Tasks</h2>
        <p className="text-muted text-sm mb-4">
          Tick a child to mark the task complete for them (e.g. recording
          something that already happened). Untick to undo their latest
          completion of it.
        </p>
        {tasks?.length === 0 && (
          <p className="text-muted text-sm">No tasks yet — add one above.</p>
        )}
        <div className="flex flex-col gap-3">
          {(tasks ?? []).map((task) => {
            const applicable = task.assigned_to.length === 0
              ? children.map((c) => c.subdomain)
              : children.filter((c) => task.assigned_to.includes(c.subdomain)).map((c) => c.subdomain);
            return (
              <div key={task.task_id} className="bg-surface border border-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <span className={`font-bold ${task.enabled ? "" : "line-through opacity-60"}`}>
                      {task.title}
                    </span>
                    {task.description && (
                      <span className="block text-muted text-sm">{task.description}</span>
                    )}
                    <span className="block text-xs text-muted mt-1">
                      {task.ticket_reward} ticket{task.ticket_reward === 1 ? "" : "s"} ·{" "}
                      {task.assigned_to.length === 0
                        ? "everyone"
                        : task.assigned_to.map(childName).join(", ")}
                    </span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => updateTask(task.task_id, { enabled: !task.enabled })}
                      className="min-h-9 px-3 rounded-md border border-border bg-surface-solid font-semibold text-sm cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      {task.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => removeTask(task.task_id)}
                      className="min-h-9 px-3 rounded-md border border-red-200 bg-red-50 text-danger font-semibold text-sm cursor-pointer transition-colors hover:bg-red-100 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <IconUpload
                  accessToken={accessToken}
                  icon={task.icon}
                  emoji={task.emoji}
                  disabled={saving}
                  onUploaded={(icon) => updateTask(task.task_id, { icon: icon || null })}
                  onEmoji={(emoji) => updateTask(task.task_id, { emoji })}
                />
                <div className="flex flex-wrap gap-2">
                  {applicable.map((sub) => {
                    const events = completionsByTaskChild.get(`${task.task_id}/${sub}`) ?? [];
                    const done = events.length > 0;
                    return (
                      <label
                        key={sub}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm cursor-pointer ${
                          done ? "border-green-300 bg-green-50" : "border-border bg-surface-solid"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={done}
                          disabled={saving}
                          onChange={(e) =>
                            e.target.checked
                              ? completeForChild(task.task_id, sub)
                              : undoForChild(task.task_id, sub)
                          }
                        />
                        {childName(sub)}
                        {done && (
                          <span className="text-xs text-muted">
                            ×{events.length}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Job board */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Job board</h2>
        <p className="text-muted text-sm mb-4">
          Post a library task to the kids' app with a schedule. Tasks with no
          posting behave as one-offs (the original behaviour).
        </p>
        <form onSubmit={createBoardEntry} className="flex flex-col gap-3 mb-4">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 flex-1 min-w-48">
              <span className="text-sm font-semibold">Task</span>
              <select
                value={boardDraft.task_id}
                onChange={(e) => setBoardDraft({ ...boardDraft, task_id: e.target.value })}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              >
                <option value="" disabled>
                  Pick a task…
                </option>
                {(tasks ?? []).filter((t) => t.enabled).map((t) => (
                  <option key={t.task_id} value={t.task_id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 w-44">
              <span className="text-sm font-semibold">How often</span>
              <select
                value={boardDraft.repeat}
                onChange={(e) =>
                  setBoardDraft({
                    ...boardDraft,
                    repeat: e.target.value as BoardRepeat,
                    completion_mode:
                      e.target.value === "on_demand"
                        ? boardDraft.completion_mode
                        : "each_child",
                  })
                }
                className="px-3 py-2 rounded border border-border bg-surface-solid"
              >
                {Object.entries(REPEAT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 w-28">
              <span className="text-sm font-semibold">Tickets</span>
              <input
                type="number"
                min={1}
                max={100}
                value={boardDraft.ticket_reward}
                onChange={(e) => setBoardDraft({ ...boardDraft, ticket_reward: e.target.value })}
                placeholder="task's"
                className="px-3 py-2 rounded border border-border bg-surface-solid"
              />
            </label>
          </div>
          {boardDraft.repeat === "on_demand" && (
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold">
                When one child completes it
              </span>
              <div className="flex flex-wrap gap-3">
                {(["each_child", "first_done"] as BoardCompletionMode[]).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="board-completion-mode"
                      checked={boardDraft.completion_mode === mode}
                      onChange={() => setBoardDraft({ ...boardDraft, completion_mode: mode })}
                      disabled={saving}
                    />
                    {mode === "each_child"
                      ? "Each child can do it once"
                      : "First one done wins"}
                  </label>
                ))}
              </div>
            </label>
          )}
          <fieldset className="flex flex-col gap-1">
            <span className="text-sm font-semibold">For (leave empty for everyone)</span>
            <div className="flex flex-wrap gap-3">
              {children.map((c) => (
                <label key={c.subdomain} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={boardDraft.assigned_to.includes(c.subdomain)}
                    onChange={(e) =>
                      setBoardDraft({
                        ...boardDraft,
                        assigned_to: e.target.checked
                          ? [...boardDraft.assigned_to, c.subdomain]
                          : boardDraft.assigned_to.filter((s) => s !== c.subdomain),
                      })
                    }
                    disabled={saving}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={saving || !boardDraft.task_id}
            className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none self-start"
          >
            {saving ? "Posting…" : "Post to job board"}
          </button>
        </form>
        {board?.length === 0 && (
          <p className="text-muted text-sm">
            Nothing posted yet — every task below behaves as a one-off.
          </p>
        )}
        <div className="flex flex-col gap-3">
          {(board ?? []).map((entry) => {
            const task = tasks?.find((t) => t.task_id === entry.task_id);
            return (
              <div key={entry.board_id} className="bg-surface border border-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-bold">{task?.title ?? entry.task_id}</span>
                    <span className="block text-muted text-sm">
                      {REPEAT_LABELS[entry.repeat]}
                    </span>
                    <span className="block text-xs text-muted mt-1">
                      {entry.ticket_reward} ticket{entry.ticket_reward === 1 ? "" : "s"} ·{" "}
                      {entry.assigned_to.length === 0
                        ? "everyone"
                        : entry.assigned_to.map(childName).join(", ")}
                      {entry.repeat === "on_demand" && (
                        <>
                          {" · "}
                          {entry.completion_mode === "first_done"
                            ? "first done wins"
                            : "each child once"}
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {entry.repeat === "on_demand" && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          saveBoardEntry(entry.board_id, { posted: !entry.posted })
                        }
                        className={`min-h-9 px-3 rounded-md font-semibold text-sm cursor-pointer transition-colors disabled:opacity-50 ${
                          entry.posted
                            ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                            : "border-border bg-surface-solid hover:bg-surface-hover"
                        }`}
                      >
                        {entry.posted ? "Posted ✓" : "Post"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => removeBoardEntry(entry.board_id)}
                      className="min-h-9 px-3 rounded-md border border-red-200 bg-red-50 text-danger font-semibold text-sm cursor-pointer transition-colors hover:bg-red-100 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Rewards */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Rewards</h2>
        <p className="text-muted text-sm mb-4">
          Prizes kids can swap tickets for. The bracketed cost is what the prize
          really costs — only you can see it, never the kids.
        </p>
        <form onSubmit={createReward} className="flex flex-col gap-3 mb-4">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 flex-1 min-w-48">
              <span className="text-sm font-semibold">Title</span>
              <input
                type="text"
                value={rewardDraft.title}
                onChange={(e) => setRewardDraft({ ...rewardDraft, title: e.target.value })}
                placeholder="e.g. Ice cream treat"
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
            <label className="flex flex-col gap-1 w-28">
              <span className="text-sm font-semibold">Tickets</span>
              <input
                type="number"
                min={1}
                max={100}
                value={rewardDraft.ticket_cost}
                onChange={(e) => setRewardDraft({ ...rewardDraft, ticket_cost: e.target.value })}
                className="px-3 py-2 rounded border border-border bg-surface-solid"
                required
              />
            </label>
            <label className="flex flex-col gap-1 w-32">
              <span className="text-sm font-semibold">Real cost (£)</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={rewardDraft.cost_pence}
                onChange={(e) => setRewardDraft({ ...rewardDraft, cost_pence: e.target.value })}
                placeholder="e.g. 0.50"
                className="px-3 py-2 rounded border border-border bg-surface-solid"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">Description (optional)</span>
            <input
              type="text"
              value={rewardDraft.description}
              onChange={(e) => setRewardDraft({ ...rewardDraft, description: e.target.value })}
              placeholder="e.g. A small scoop at the shops"
              className="px-3 py-2 rounded border border-border bg-surface-solid"
            />
          </label>
          <RewardLimitFields
            draft={rewardDraft}
            onChange={(patch) => setRewardDraft({ ...rewardDraft, ...patch })}
          />
          <button
            type="submit"
            disabled={saving || !rewardDraft.title.trim()}
            className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none self-start"
          >
            {saving ? "Adding…" : "Add reward"}
          </button>
        </form>
        {rewards?.length === 0 && (
          <p className="text-muted text-sm">No rewards yet — add one above.</p>
        )}
        <div className="flex flex-col gap-3">
          {(rewards ?? []).map((reward) => {
            const editingThis = rewardEdit?.reward_id === reward.reward_id;
            return (
              <div key={reward.reward_id} className="bg-surface border border-border rounded-lg p-4">
                {editingThis && rewardEdit ? (
                  <form onSubmit={saveEditReward} className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-3">
                      <label className="flex flex-col gap-1 flex-1 min-w-48">
                        <span className="text-sm font-semibold">Title</span>
                        <input
                          type="text"
                          value={rewardEdit.title}
                          onChange={(e) => setRewardEdit({ ...rewardEdit, title: e.target.value })}
                          className="px-3 py-2 rounded border border-border bg-surface-solid"
                          required
                          autoFocus
                        />
                      </label>
                      <label className="flex flex-col gap-1 w-28">
                        <span className="text-sm font-semibold">Tickets</span>
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={rewardEdit.ticket_cost}
                          onChange={(e) => setRewardEdit({ ...rewardEdit, ticket_cost: e.target.value })}
                          className="px-3 py-2 rounded border border-border bg-surface-solid"
                          required
                        />
                      </label>
                      <label className="flex flex-col gap-1 w-32">
                        <span className="text-sm font-semibold">Real cost (£)</span>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          value={rewardEdit.cost_pence}
                          onChange={(e) => setRewardEdit({ ...rewardEdit, cost_pence: e.target.value })}
                          placeholder="e.g. 0.50"
                          className="px-3 py-2 rounded border border-border bg-surface-solid"
                        />
                      </label>
                    </div>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-semibold">Description (optional)</span>
                      <input
                        type="text"
                        value={rewardEdit.description}
                        onChange={(e) => setRewardEdit({ ...rewardEdit, description: e.target.value })}
                        placeholder="e.g. A small scoop at the shops"
                        className="px-3 py-2 rounded border border-border bg-surface-solid"
                      />
                    </label>
                    <RewardLimitFields
                      draft={rewardEdit}
                      onChange={(patch) => setRewardEdit({ ...rewardEdit, ...patch })}
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={saving || !rewardEdit.title.trim()}
                        className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none"
                      >
                        {saving ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => setRewardEdit(null)}
                        className="min-h-10 px-5 rounded-md border border-border bg-surface-solid font-semibold cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className={`font-bold ${reward.enabled ? "" : "line-through opacity-60"}`}>
                          {reward.title}
                        </span>
                        {reward.description && (
                          <span className="block text-muted text-sm">{reward.description}</span>
                        )}
                        <span className="block text-xs text-muted mt-1">
                          {reward.ticket_cost} ticket{reward.ticket_cost === 1 ? "" : "s"} ·{" "}
                          <span className="font-semibold text-accent-strong">
                            ({friendlyCost(reward.cost_pence)})
                          </span>
                          {" · "}
                          {limitSummary(reward)}
                        </span>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => startEditReward(reward)}
                          className="min-h-9 px-3 rounded-md border border-border bg-surface-solid font-semibold text-sm cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => updateReward(reward.reward_id, { enabled: !reward.enabled })}
                          className="min-h-9 px-3 rounded-md border border-border bg-surface-solid font-semibold text-sm cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                        >
                          {reward.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => removeReward(reward.reward_id)}
                          className="min-h-9 px-3 rounded-md border border-red-200 bg-red-50 text-danger font-semibold text-sm cursor-pointer transition-colors hover:bg-red-100 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {children.map((c) => (
                        <button
                          key={c.subdomain}
                          type="button"
                          disabled={saving}
                          onClick={() => redeemForChild(reward.reward_id, c.subdomain)}
                          className="min-h-9 px-3 rounded-full border border-border bg-surface-solid text-sm font-semibold cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                        >
                          Give to {c.name}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2">
                      <IconUpload
                        accessToken={accessToken}
                        icon={reward.icon}
                        emoji={reward.emoji}
                        disabled={saving}
                        onUploaded={(icon) => updateReward(reward.reward_id, { icon: icon || null })}
                        onEmoji={(emoji) => updateReward(reward.reward_id, { emoji })}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Redemption log */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Reward redemptions</h2>
        <p className="text-muted text-sm mb-4">
          Every reward swap, newest first. Mark a reward "Claimed" once the child
          has received it — a claimed reward can no longer be refunded.
        </p>
        {redemptions.length === 0 && (
          <p className="text-muted text-sm">Nothing redeemed yet.</p>
        )}
        <div className="flex flex-col gap-2">
          {redemptions.slice(0, 50).map((r) => (
            <div
              key={r.redemption_id}
              className={`flex items-center gap-3 bg-surface border rounded-lg px-4 py-2 text-sm ${
                r.status === "pending" ? "border-amber-300" : "border-border"
              }`}
            >
              <span className="font-semibold">{childName(r.child_subdomain)}</span>
              <span className="flex-1 min-w-0 truncate">
                {rewards?.find((w) => w.reward_id === r.reward_id)?.title ?? r.reward_id}
              </span>
              <span className="text-muted whitespace-nowrap">{friendlyDateTime(r.redeemed_at)}</span>
              <span className="text-xs text-muted">
                {r.redeemed_by === "parent" ? "by grown-up · " : ""}
                {r.status === "pending" ? "waiting" : "claimed ✓"}
              </span>
              <span className="font-bold text-accent-strong whitespace-nowrap">-{r.tickets}</span>
              {r.status === "pending" && (
                <>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => redemptionAction(r.child_subdomain, r.redemption_id, "claim")}
                    className="min-h-8 px-3 rounded-md border border-green-200 bg-green-50 text-green-700 font-semibold text-xs cursor-pointer transition-colors hover:bg-green-100 disabled:opacity-50"
                  >
                    Claimed!
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => redemptionAction(r.child_subdomain, r.redemption_id, "refund")}
                    className="min-h-8 px-3 rounded-md border border-border bg-surface-solid font-semibold text-xs cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    Refund
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Completion log */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Recent completions</h2>
        <p className="text-muted text-sm mb-4">
          Every task completion, newest first. Tickets earned is recorded at
          completion time.
        </p>
        {completions.length === 0 && (
          <p className="text-muted text-sm">Nothing completed yet.</p>
        )}
        <div className="flex flex-col gap-2">
          {completions.slice(0, 50).map((c) => (
            <div
              key={c.task_completion}
              className="flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-2 text-sm"
            >
              <span className="font-semibold">{childName(c.child_subdomain)}</span>
              <span className="flex-1 min-w-0 truncate">
                {c.task_id === "bonus"
                  ? c.label ?? "Bonus tickets"
                  : tasks?.find((t) => t.task_id === c.task_id)?.title ?? c.task_id}
              </span>
              <span className="text-muted whitespace-nowrap">{friendlyDateTime(c.completed_at)}</span>
              <span className="text-xs text-muted">
                {c.completed_by === "parent" ? "by grown-up · " : ""}
                {c.task_id === "bonus" ? "bonus" : ""}
              </span>
              <span className="font-bold text-accent-strong whitespace-nowrap">+{c.tickets}</span>
              {c.task_id === "bonus" && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => undoForChild("bonus", c.child_subdomain)}
                  className="min-h-8 px-3 rounded-md border border-border bg-surface-solid font-semibold text-xs cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  Undo
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
