import { useCallback, useEffect, useState } from "react";
import { QrScanner } from "./components/QrScanner";
import {
  chooseChild,
  completeTask,
  LOCAL_AUTH,
  whoAmI,
  type LocalWhoAmI,
  extractPairingCode,
  fetchRewardsState,
  fetchTaskHistory,
  fetchTasksState,
  pairDevice,
  redeemReward,
  refundReward,
  undoTask,
  type KidReward,
  type KidTask,
  type RewardsState,
  type TaskHistoryEntry,
  type TasksState,
} from "./api";

type Screen = "jobs" | "rewards" | "history";

function friendlyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function friendlyTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Kid-friendly label for a period cap ("week" → "week", "term" → "term"). */
function periodLabel(period: "week" | "month" | "summer" | "term" | "year"): string {
  return period;
}

export default function App() {
  const [state, setState] = useState<TasksState | null>(null);
  const [rewardsState, setRewardsState] = useState<RewardsState | null>(null);
  const [history, setHistory] = useState<TaskHistoryEntry[] | null>(null);
  const [screen, setScreen] = useState<Screen>("jobs");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState<KidTask | null>(null);
  const [justRedeemed, setJustRedeemed] = useState<KidReward | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [typedCode, setTypedCode] = useState("");
  const [pairMode, setPairMode] = useState<"home" | "scan" | "type">("home");
  // Home network only: who this device is.
  const [notSetUp, setNotSetUp] = useState(false);
  const [who, setWho] = useState<LocalWhoAmI | null>(null);
  const [pickChild, setPickChild] = useState(false);

  const load = useCallback(async () => {
    try {
      if (LOCAL_AUTH) setWho(await whoAmI());
      const next = await fetchTasksState();
      setState(next);
      setError(null);
      setUnpaired(false);
      setPickChild(false);
    } catch (err) {
      if (err instanceof Error && err.message === "notsetup") {
        setNotSetUp(true);
      } else if (err instanceof Error && err.message === "pickchild") {
        setPickChild(true);
      } else if (err instanceof Error && err.message === "unpaired") {
        setUnpaired(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not load your jobs");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Errors auto-dismiss after 6s — long enough for a young reader, not sticky.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (screen === "history") {
      fetchTaskHistory()
        .then(setHistory)
        .catch(() => setHistory([]));
    }
    if (screen === "rewards") {
      setRewardsState(null);
      fetchRewardsState()
        .then(setRewardsState)
        .catch((err) => {
          if (err instanceof Error && err.message === "unpaired") {
            setUnpaired(true);
          } else {
            setError(err instanceof Error ? err.message : "Could not load your rewards");
          }
        });
    }
  }, [screen]);

  const redeem = useCallback(
    async (reward: KidReward) => {
      if (busyId) return;
      setBusyId(reward.reward_id);
      setError(null);
      try {
        await redeemReward(reward.reward_id);
        setJustRedeemed(reward);
        setRewardsState(await fetchRewardsState());
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not swap your tickets";
        // Refresh first — a reload clears the error state on success.
        try {
          setRewardsState(await fetchRewardsState());
        } catch {
          // Keep the message even if the refresh fails.
        }
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId]
  );

  const refund = useCallback(async () => {
    if (busyId) return;
    setBusyId("refund");
    setError(null);
    try {
      await refundReward();
      setRewardsState(await fetchRewardsState());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not refund that reward";
      try {
        setRewardsState(await fetchRewardsState());
      } catch {
        // Keep the message even if the refresh fails.
      }
      setError(message);
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  const complete = useCallback(
    async (task: KidTask) => {
      if (busyId) return;
      setBusyId(task.task_id);
      setError(null);
      try {
        await completeTask(task.task_id);
        setJustCompleted(task);
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not complete that job";
        // Refresh first — load() clears the error state on success, which used
        // to wipe this message about a second after it appeared.
        await load();
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load]
  );

  const undo = useCallback(
    async (task: KidTask) => {
      if (busyId) return;
      setBusyId(task.task_id);
      setError(null);
      try {
        await undoTask(task.task_id);
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not undo that job";
        await load();
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load]
  );

  async function handlePairSubmit(raw: string) {
    const code = extractPairingCode(raw);
    if (!code) {
      setPairingError("Enter the pairing code from a grown-up");
      return;
    }
    setPairing(true);
    setPairingError(null);
    try {
      await pairDevice(code);
      setTypedCode("");
      await load();
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Could not pair this iPad");
    } finally {
      setPairing(false);
    }
  }

  if (notSetUp) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full p-10 bg-surface border border-border rounded-xl text-center shadow-card">
          <p className="text-lg font-semibold">This device isn't set up.</p>
        </div>
      </div>
    );
  }

  if (pickChild && who) {
    const children = who.people.filter((person) => person.role === "child");
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full p-10 bg-surface border border-border rounded-xl text-center shadow-card">
          <div className="text-5xl mb-4">🎟️</div>
          <h1 className="text-2xl font-extrabold mb-2">Which child?</h1>
          <p className="text-muted mb-6">Hello {who.viewer.me?.name}. Pick whose tickets to look at.</p>
          <div className="flex flex-col gap-3">
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-text text-base font-semibold cursor-pointer border border-border bg-surface-solid"
                onClick={() => {
                  void chooseChild(child.id).then(load);
                }}
              >
                {child.name}
              </button>
            ))}
            {who.viewer.admin && (
              <a className="text-muted text-sm font-semibold mt-2" href="/admin/">
                Parent admin
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (unpaired) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full p-10 bg-surface border border-border rounded-xl text-center backdrop-blur-md shadow-card">
          <div className="text-5xl mb-4">🎟️</div>
          <h1 className="text-2xl font-extrabold mb-2">Tickets</h1>
          <p className="text-muted mb-6">
            This iPad isn't set up yet. Ask a grown-up to open the Wainwright app
            and show the pairing code for your name.
          </p>
          {pairingError && (
            <p className="mb-4 p-3 px-4 rounded-md bg-red-50 text-red-700 text-sm font-semibold text-center">
              {pairingError}
            </p>
          )}
          {pairMode === "scan" ? (
            <QrScanner
              onDetect={(text) => {
                void handlePairSubmit(text);
              }}
              onCancel={() => setPairMode("home")}
            />
          ) : pairMode === "type" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handlePairSubmit(typedCode);
              }}
            >
              <label className="text-sm font-bold text-muted" htmlFor="pair-code">
                Pairing code
              </label>
              <input
                id="pair-code"
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                disabled={pairing}
                className="w-full min-h-14 px-4 rounded-xl border border-border bg-surface-solid text-center text-2xl font-extrabold tracking-[0.3em]"
                placeholder="ABCD2345"
              />
              <button
                type="submit"
                disabled={pairing || typedCode.trim().length < 6}
                className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-white text-base font-semibold bg-accent transition-colors hover:bg-accent-strong no-underline disabled:opacity-50"
              >
                {pairing ? "Pairing…" : "Pair this iPad"}
              </button>
              <button
                type="button"
                className="text-muted text-sm font-semibold border-none bg-transparent cursor-pointer no-underline"
                onClick={() => setPairMode("home")}
              >
                Back
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                className="inline-flex items-center justify-center min-h-14 px-6 w-full rounded-md text-white text-lg font-extrabold border-none cursor-pointer bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
                onClick={() => setPairMode("scan")}
                disabled={pairing}
              >
                Scan QR code
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-text text-base font-semibold cursor-pointer border border-border bg-surface-solid"
                onClick={() => setPairMode("type")}
                disabled={pairing}
              >
                Type the code instead
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  const totalTickets = state.total_tickets;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 pt-8 pb-4 text-center">
        <h1 className="text-3xl font-extrabold">🎟️ {LOCAL_AUTH && who?.viewer.admin && who.viewer.child ? `${who.viewer.child.name}'s Tickets` : "My Tickets"}</h1>
        {LOCAL_AUTH && who?.viewer.admin && (
          <p className="text-sm text-muted mt-1 flex justify-center gap-4">
            <button
              type="button"
              className="border-none bg-transparent cursor-pointer text-muted font-semibold underline"
              onClick={() => {
                setState(null);
                void chooseChild(null).then(load);
              }}
            >
              Switch child
            </button>
            <a className="font-semibold underline text-muted" href="/admin/">
              Parent admin
            </a>
          </p>
        )}
        <p className="text-muted text-lg">Do your jobs to earn tickets</p>
        <div className="mt-3 inline-flex items-baseline gap-2 bg-accent-soft rounded-full px-5 py-2">
          <span className="text-2xl font-extrabold text-accent-strong">{totalTickets}</span>
          <span className="text-sm text-muted">
            ticket{totalTickets === 1 ? "" : "s"} earned
          </span>
        </div>
      </header>

      <nav className="flex justify-center gap-2 px-6 pb-4">
        <TabButton active={screen === "jobs"} onClick={() => setScreen("jobs")}>
          My jobs
        </TabButton>
        <TabButton active={screen === "rewards"} onClick={() => setScreen("rewards")}>
          Rewards
        </TabButton>
        <TabButton active={screen === "history"} onClick={() => setScreen("history")}>
          My tickets
        </TabButton>
      </nav>

      {error && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-red-50 border border-red-200 text-danger text-center font-semibold shake">
          {error}
        </div>
      )}

      {justCompleted && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-center font-semibold pop-in">
          Amazing! {justCompleted.title} done — {justCompleted.ticket_reward} ticket
          {justCompleted.ticket_reward === 1 ? "" : "s"} earned! 🎉
        </div>
      )}

      {justRedeemed && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-center font-semibold pop-in">
          Yay! {justRedeemed.title} is yours — tell a grown-up! 🎁
        </div>
      )}

      <main className="flex-1 px-6 pb-10 max-w-3xl mx-auto w-full">
        {screen === "jobs" ? (
          state.tasks.length === 0 ? (
            <div className="text-center py-10">
              <div className="text-6xl mb-3">🎈</div>
              <p className="text-xl font-bold">No jobs yet!</p>
              <p className="text-muted">Come back soon for new jobs to do.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {state.tasks.map((task) => (
                <JobCard
                  key={task.task_id}
                  task={task}
                  busy={busyId === task.task_id}
                  onComplete={() => complete(task)}
                  onUndo={() => undo(task)}
                />
              ))}
            </div>
          )
        ) : screen === "rewards" ? (
          rewardsState === null ? (
            <div className="flex justify-center py-10">
              <div className="spinner" />
            </div>
          ) : (
            <RewardsScreen
              state={rewardsState}
              busyId={busyId}
              onRedeem={redeem}
              onRefund={refund}
            />
          )
        ) : history === null ? (
          <div className="flex justify-center py-10">
            <div className="spinner" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {history.length === 0 && (
              <p className="text-center text-muted py-8">
                No tickets yet — do a job to earn your first one! 😊
              </p>
            )}
            {history.map((entry) => (
              <div
                key={`${entry.task_id}/${entry.completed_at}`}
                className="bg-surface border border-border rounded-lg p-4 backdrop-blur-md flex items-center gap-3"
              >
                <span className="w-10 h-10 rounded-md bg-accent-soft flex items-center justify-center text-xl shrink-0">
                  🎟️
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold truncate">{entry.title}</span>
                  <span className="block text-xs text-muted">
                    {friendlyDate(entry.completed_at)} at {friendlyTime(entry.completed_at)}
                    {entry.completed_by === "parent" ? " · by a grown-up" : ""}
                  </span>
                </span>
                <span className="text-accent-strong font-extrabold whitespace-nowrap">
                  +{entry.tickets}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`min-h-10 px-5 rounded-full text-sm font-bold cursor-pointer border transition-colors ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-surface text-muted border-border hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RewardsScreen({
  state,
  busyId,
  onRedeem,
  onRefund,
}: {
  state: RewardsState;
  busyId: string | null;
  onRedeem: (reward: KidReward) => void;
  onRefund: () => void;
}) {
  const spendable = state.spendable_tickets;
  const pending = state.redemptions.filter((r) => r.status === "pending");
  const pendingRewardTitles = pending.map((r) => r.title);

  return (
    <div className="flex flex-col gap-4">
      {pending.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <h2 className="font-extrabold text-amber-800">Waiting for your rewards 🎁</h2>
          <p className="text-amber-800 text-sm mt-1">
            {pendingRewardTitles.join(", ")} — ask a grown-up to hand it over!
          </p>
          <button
            type="button"
            className="mt-3 min-h-10 px-4 rounded-md text-sm font-semibold cursor-pointer border border-amber-300 bg-white text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
            onClick={onRefund}
            disabled={busyId !== null}
          >
            {busyId === "refund" ? "Refunding…" : "Change my mind — refund it"}
          </button>
        </div>
      )}

      {state.rewards.length === 0 ? (
        <div className="text-center py-10">
          <div className="text-6xl mb-3">🎁</div>
          <p className="text-xl font-bold">No rewards yet!</p>
          <p className="text-muted">Come back soon for new rewards.</p>
        </div>
      ) : (
        state.rewards.map((reward) => {
          const affordable = spendable >= reward.ticket_cost;
          const limit = reward.limit;
          const soldOut =
            (limit?.limit_type === "stock" && (limit.stock_remaining ?? 0) <= 0) ||
            (limit?.limit_type === "snack_stock" && (limit.stock_remaining ?? 0) <= 0);
          // period_used arrives from the server; snack_stock stock_remaining
          // is resolved server-side too (kid routes fetch Wainsbury's).
          const periodUsed = limit?.limit_type === "period" && limit.period_used === true;
          const blocked = soldOut || periodUsed;
          return (
            <div
              key={reward.reward_id}
              className={`bg-surface border rounded-xl p-4 backdrop-blur-md shadow-card ${
                affordable && !blocked ? "border-border" : "border-border opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <CardIcon iconUrl={reward.icon_url} emoji={reward.emoji} />
                  <div className="min-w-0">
                    <h2 className="text-lg font-extrabold leading-tight">{reward.title}</h2>
                    {reward.description && (
                      <p className="text-muted text-sm mt-1">{reward.description}</p>
                    )}
                    {limit?.limit_type === "stock" && limit.stock_remaining !== null && (
                      <p className={`text-sm mt-1 font-semibold ${soldOut ? "text-danger" : "text-muted"}`}>
                        {soldOut
                          ? "All gone for now! 🐻"
                          : `${limit.stock_remaining} left in the cupboard`}
                      </p>
                    )}
                    {limit?.limit_type === "snack_stock" && (
                      <p className={`text-sm mt-1 font-semibold ${soldOut ? "text-danger" : "text-muted"}`}>
                        {soldOut
                          ? "No popcorn bags left! 🍿"
                          : `${limit.stock_remaining} popcorn bag${limit.stock_remaining === 1 ? "" : "s"} left`}
                      </p>
                    )}
                    {limit?.limit_type === "period" && limit.period && (
                      <p className={`text-sm mt-1 font-semibold ${periodUsed ? "text-danger" : "text-muted"}`}>
                        {periodUsed
                          ? `Already had this ${periodLabel(limit.period)} 😊`
                          : `One pick every ${periodLabel(limit.period)}`}
                      </p>
                    )}
                  </div>
                </div>
                <div className="inline-flex items-baseline gap-1 bg-accent-soft rounded-full px-3 py-1 shrink-0">
                  <span className="text-lg font-extrabold text-accent-strong">
                    {reward.ticket_cost}
                  </span>
                  <span className="text-xs text-muted">
                    ticket{reward.ticket_cost === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3">
                {blocked ? (
                  <span className="ml-auto text-sm font-semibold text-muted">
                    {soldOut
                      ? "Check back when it's restocked!"
                      : `Back next ${periodLabel(limit!.period!)}`}
                  </span>
                ) : affordable ? (
                  <button
                    type="button"
                    className="ml-auto min-h-12 px-6 rounded-md text-white text-base font-extrabold border-none cursor-pointer bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
                    onClick={() => onRedeem(reward)}
                    disabled={busyId !== null}
                  >
                    {busyId === reward.reward_id ? "Swapping…" : "Swap my tickets! 🎁"}
                  </button>
                ) : (
                  <span className="ml-auto text-sm font-semibold text-muted">
                    Do {reward.ticket_cost - spendable} more job
                    {reward.ticket_cost - spendable === 1 ? "" : "s"} first!
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Fixed-size photo icon for a job/reward card. Renders nothing when the item
 * has no icon, so cards without photos keep their old layout. The fixed
 * slot keeps the grid scannable for pre-readers.
 */
function CardIcon({ iconUrl, emoji }: { iconUrl: string | null; emoji: string | null }) {
  // Photo wins; emoji is the zero-effort fallback so a card never renders bare.
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        loading="lazy"
        className="w-28 h-28 rounded-xl object-cover shrink-0 border border-border bg-surface-solid"
      />
    );
  }
  if (emoji) {
    return (
      <span
        aria-hidden="true"
        className="w-28 h-28 rounded-xl shrink-0 grid place-items-center text-7xl border border-border bg-surface-solid select-none"
      >
        {emoji}
      </span>
    );
  }
  return null;
}

function JobCard({
  task,
  busy,
  onComplete,
  onUndo,
}: {
  task: KidTask;
  busy: boolean;
  onComplete: () => void;
  onUndo: () => void;
}) {
  // `done` is the server-derived state for THIS recurrence
  // window (today for daily/school-day jobs, since the
  // last post for on-demand ones) — not "ever completed".
  const done = task.done;
  return (
    <div
      className={`bg-surface border rounded-xl p-4 backdrop-blur-md shadow-card ${
        done ? "border-green-300 opacity-60" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <CardIcon iconUrl={task.icon_url} emoji={task.emoji} />
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold leading-tight">{task.title}</h2>
            {task.description && (
              <p className="text-muted text-sm mt-1">{task.description}</p>
            )}
          </div>
        </div>
        <div className="inline-flex items-baseline gap-1 bg-accent-soft rounded-full px-3 py-1 shrink-0">
          <span className="text-lg font-extrabold text-accent-strong">
            {task.ticket_reward}
          </span>
          <span className="text-xs text-muted">ticket{task.ticket_reward === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        {done ? (
          <>
            <span className="inline-flex items-center gap-1 text-success font-bold text-sm">
              ✓ Done{task.repeat === "daily" || task.repeat === "school_day" ? " today" : ""}
              {task.completed_count > 1 ? ` ×${task.completed_count}` : ""}
            </span>
            <button
              type="button"
              className="ml-auto min-h-10 px-4 rounded-md text-sm font-semibold cursor-pointer border border-border bg-surface-solid transition-colors hover:bg-bg-accent disabled:opacity-50"
              onClick={onUndo}
              disabled={busy}
            >
              Undo
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ml-auto min-h-12 px-6 rounded-md text-white text-base font-extrabold border-none cursor-pointer bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
            onClick={onComplete}
            disabled={busy}
          >
            I did it! 🎉
          </button>
        )}
        {busy && <div className="spinner" />}
      </div>
    </div>
  );
}
