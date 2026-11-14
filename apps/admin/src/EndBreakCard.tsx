import { useEffect, useState } from "react";
import { endChildBreak, fetchChildInternet, type ChildInternetState } from "./api";
import { breakSecondsRemaining, formatDuration } from "../../kids/lib/internet";

/** Home Assistant knows these four. Joanna has no internet controls. */
const INTERNET_CHILDREN = new Set(["hannah", "lydia", "zoe", "ethan"]);

export function childHasInternetControls(childId: string): boolean {
  return INTERNET_CHILDREN.has(childId);
}

/**
 * Ends the 10-minute break after internet mode. The button works even when the
 * current break state could not be loaded.
 */
export function EndBreakCard({ accessToken, childId }: { accessToken: string; childId: string }) {
  const [state, setState] = useState<ChildInternetState | null>(null);
  const [known, setKnown] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setKnown(false);
    setState(null);
    setError(null);
    void fetchChildInternet(accessToken, childId).then((next) => {
      if (cancel) return;
      setState(next);
      setKnown(next !== null);
      setFetchedAt(Date.now());
    });
    return () => {
      cancel = true;
    };
  }, [accessToken, childId]);

  useEffect(() => {
    if (!known || state?.on_break !== true) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [known, state?.on_break]);

  async function endBreak() {
    setBusy(true);
    setError(null);
    try {
      const next = await endChildBreak(accessToken, childId);
      setState(next);
      setKnown(true);
      setFetchedAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't end the break");
    } finally {
      setBusy(false);
    }
  }

  const breakSeconds = state ? breakSecondsRemaining(state, now, fetchedAt) : null;
  const status = !known
    ? null
    : state?.on_break === true
      ? breakSeconds === null
        ? "Internet break"
        : `Internet break · ${formatDuration(breakSeconds)} left`
      : "Not on an internet break";

  return (
    <div className="mb-4 p-4 bg-surface border border-border rounded-xl flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="m-0 text-sm font-semibold">Internet break</p>
        {status && (
          <p className="m-0 mt-1 text-sm text-muted tabular-nums" aria-live="polite">
            {status}
          </p>
        )}
      </div>
      <button
        type="button"
        className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-white text-sm font-semibold cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => void endBreak()}
        disabled={busy}
        aria-busy={busy}
      >
        End break
      </button>
      {error && <p className="m-0 w-full text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
