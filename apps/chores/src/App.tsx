import { useCallback, useEffect, useState } from "react";
import { QrScanner } from "./components/QrScanner";
import {
  claimChore,
  completeChore,
  extractPairingCode,
  fetchChoresState,
  pairDevice,
  undoChore,
  type ChoresState,
  type KidChore,
  type MyClaim,
} from "./api";

const FLOOR_LABELS = ["Ground floor", "First floor", "Second floor"];

const TARGET_EMOJI: Record<KidChore["target_type"], string> = {
  room: "🧹",
  fixture: "🪑",
  window: "🪟",
  switch: "💡",
};

const JOB_EMOJI: Record<string, string> = {
  vacuum: "🧹",
  "sweep-mop": "🧹",
  dust: "🧺",
  clean: "🧽",
  brush: "🚽",
  wipe: "🧻",
  fill: "🧻",
  empty: "🗑️",
  batteries: "🔋",
  tidy: "🧺",
  clear: "🧺",
  salt: "🧂",
  "rinse-aid": "💧",
  make: "☕",
};

function choreEmoji(chore: KidChore): string {
  for (const [key, emoji] of Object.entries(JOB_EMOJI)) {
    if (chore.chore_id.startsWith(`${key}-`)) return emoji;
  }
  return TARGET_EMOJI[chore.target_type] ?? "✨";
}

function friendlyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default function App() {
  const [state, setState] = useState<ChoresState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState<KidChore | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [typedCode, setTypedCode] = useState("");
  const [pairMode, setPairMode] = useState<"home" | "scan" | "type">("home");

  const load = useCallback(async () => {
    try {
      const next = await fetchChoresState();
      setState(next);
      setError(null);
      setUnpaired(false);
    } catch (err) {
      if (err instanceof Error && err.message === "unpaired") {
        setUnpaired(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not load your chores");
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

  const claim = useCallback(
    async (chore: KidChore) => {
      if (busyId) return;
      setBusyId(chore.chore_id);
      setError(null);
      try {
        await claimChore(chore.chore_id);
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not claim that chore";
        await load();
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load]
  );

  const onComplete = useCallback(
    async (chore: KidChore): Promise<void> => {
      if (busyId) return;
      setBusyId(chore.chore_id);
      setError(null);
      try {
        const result = await completeChore(chore.chore_id);
        setJustCompleted({ ...chore, tickets: result.completion.tickets });
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not complete that chore";
        await load();
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load]
  );

  const undo = useCallback(
    async (chore: KidChore) => {
      if (busyId) return;
      setBusyId(chore.chore_id);
      setError(null);
      try {
        await undoChore(chore.chore_id);
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not undo that chore";
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

  if (unpaired) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full p-10 bg-surface border border-border rounded-xl text-center backdrop-blur-md shadow-card">
          <div className="text-5xl mb-4">🧹</div>
          <h1 className="text-2xl font-extrabold mb-2">Chores</h1>
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

  const myChoreIds = new Set(state.mine.map((c) => c.chore_id));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 pt-8 pb-4 text-center">
        <h1 className="text-3xl font-extrabold">🧹 My Chores</h1>
        <p className="text-muted text-lg">Help around the house to earn tickets</p>
      </header>

      {error && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-red-50 border border-red-200 text-danger text-center font-semibold shake">
          {error}
        </div>
      )}

      {justCompleted && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-center font-semibold pop-in">
          Amazing! {justCompleted.title} done — {justCompleted.tickets} ticket
          {justCompleted.tickets === 1 ? "" : "s"} earned! 🎉
        </div>
      )}

      <main className="flex-1 px-6 pb-10 max-w-3xl mx-auto w-full">
        {state.mine.length > 0 && (
          <section className="mb-6">
            <h2 className="text-xl font-extrabold mb-3">My jobs ✋</h2>
            <div className="flex flex-col gap-3">
              {state.mine.map((claim) => (
                <MyClaimCard key={claim.chore_id} claim={claim} />
              ))}
            </div>
          </section>
        )}

        {state.rooms.length === 0 || state.rooms.every((r) => r.chores.length === 0) ? (
          <div className="text-center py-10">
            <div className="text-6xl mb-3">🧹</div>
            <p className="text-xl font-bold">No chores yet!</p>
            <p className="text-muted">Come back soon for new chores to do.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {state.rooms.map((room) => {
              if (room.chores.length === 0) return null;
              return (
                <section key={room.room_id}>
                  <h2 className="text-xl font-extrabold text-muted mb-2">
                    {FLOOR_LABELS[room.floor] ?? `Floor ${room.floor + 1}`}
                  </h2>
                  <div className="bg-surface border border-border rounded-xl p-4 backdrop-blur-md shadow-card mb-3">
                    <h3 className="text-lg font-extrabold">{room.name}</h3>
                  </div>
                  <div className="flex flex-col gap-3">
                    {room.chores.map((chore) => (
                      <ChoreCard
                        key={chore.chore_id}
                        chore={chore}
                        mine={myChoreIds.has(chore.chore_id)}
                        busy={busyId === chore.chore_id}
                        onClaim={claim}
                        onComplete={onComplete}
                        onUndo={undo}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function MyClaimCard({ claim }: { claim: MyClaim }) {
  return (
    <div className="bg-surface border border-amber-300 rounded-xl p-4 backdrop-blur-md shadow-card flex items-center gap-3">
      <span
        aria-hidden="true"
        className="w-14 h-14 rounded-xl shrink-0 grid place-items-center text-3xl border border-border bg-surface-solid select-none"
      >
        ✋
      </span>
      <div className="flex-1 min-w-0">
        <h4 className="text-base font-extrabold leading-tight">{claim.title}</h4>
        <p className="text-muted text-sm mt-1">
          {claim.done
            ? "✓ Done — tickets are in your account!"
            : `Claimed ${friendlyDate(claim.claimed_at)} — finish it in My Tickets!`}
        </p>
      </div>
    </div>
  );
}

function ChoreCard({
  chore,
  mine,
  busy,
  onClaim,
  onComplete,
  onUndo,
}: {
  chore: KidChore;
  mine: boolean;
  busy: boolean;
  onClaim: (chore: KidChore) => void;
  onComplete: (chore: KidChore) => void;
  onUndo: (chore: KidChore) => void;
}) {
  const tickets = chore.tickets;
  const worthDoing = tickets > 0;
  const emoji = choreEmoji(chore);

  return (
    <div
      className={`bg-surface border rounded-xl p-4 backdrop-blur-md shadow-card ${
        mine ? "border-amber-300" : worthDoing ? "border-border" : "border-border opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <span
            aria-hidden="true"
            className="w-14 h-14 rounded-xl shrink-0 grid place-items-center text-3xl border border-border bg-surface-solid select-none"
          >
            {emoji}
          </span>
          <div className="min-w-0">
            <h4 className="text-base font-extrabold leading-tight">{chore.title}</h4>
          </div>
        </div>
        <div className="inline-flex items-baseline gap-1 bg-accent-soft rounded-full px-3 py-1 shrink-0">
          <span className="text-lg font-extrabold text-accent-strong">{tickets}</span>
          <span className="text-xs text-muted">ticket{tickets === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        {mine ? (
          <>
            <button
              type="button"
              className="min-h-10 px-4 rounded-md text-sm font-semibold cursor-pointer border border-border bg-surface-solid transition-colors hover:bg-bg-accent disabled:opacity-50"
              onClick={() => onComplete(chore)}
              disabled={busy}
            >
              I did it! 🎉
            </button>
            <button
              type="button"
              className="min-h-10 px-4 rounded-md text-sm font-semibold cursor-pointer border border-border bg-surface-solid transition-colors hover:bg-bg-accent disabled:opacity-50"
              onClick={() => onUndo(chore)}
              disabled={busy}
            >
              Undo
            </button>
          </>
        ) : worthDoing ? (
          <button
            type="button"
            className="ml-auto min-h-12 px-6 rounded-md text-white text-base font-extrabold border-none cursor-pointer bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
            onClick={() => onClaim(chore)}
            disabled={busy}
          >
            {busy ? "Claiming…" : "I'll do it! ✋"}
          </button>
        ) : (
          <span className="ml-auto text-sm font-semibold text-muted">
            Not worth tickets yet — check back later!
          </span>
        )}
        {busy && <div className="spinner" />}
      </div>
    </div>
  );
}
