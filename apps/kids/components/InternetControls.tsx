import { useCallback, useEffect, useRef, useState } from "react";
import { fetchKidInternet, setKidInternetMode } from "../lib/kidApi";
import {
  formatDuration,
  internetCountdownFinished,
  internetProblemMessage,
  internetView,
  type InternetCommand,
  type InternetState,
} from "../lib/internet";

const POLL_MS = 30_000;

/**
 * Homework, internet, and the break after internet, at the top of the home-network launcher.
 * Local apps stay on the page whatever the mode is. Joanna, and any child
 * Home Assistant does not know, gets nothing here.
 */
export function InternetControls() {
  const [state, setState] = useState<InternetState | null>(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshedKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchKidInternet();
      setState(next);
      setFetchedAt(Date.now());
      setProblem(null);
    } catch (err) {
      setProblem(internetProblemMessage(err instanceof Error ? err.message : "Internet controls aren't available right now."));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  const view = state ? internetView(state, now, fetchedAt) : null;

  useEffect(() => {
    if (!view || !internetCountdownFinished(view)) {
      refreshedKey.current = null;
      return;
    }
    const key = view.onBreak
      ? `break:${state?.break_ends_at ?? ""}:${state?.break_seconds_left ?? ""}`
      : `mode:${state?.mode ?? ""}:${state?.internet_ends_at ?? ""}:${state?.seconds_left ?? ""}`;
    if (refreshedKey.current === key) return;
    refreshedKey.current = key;
    void load();
  }, [view, state, load]);

  async function choose(command: InternetCommand) {
    setBusy(true);
    setProblem(null);
    try {
      const next = await setKidInternetMode(command);
      setState(next);
      setFetchedAt(Date.now());
    } catch (err) {
      setProblem(internetProblemMessage(err instanceof Error ? err.message : "Internet controls aren't available right now."));
    } finally {
      setBusy(false);
    }
  }

  if (!problem && (!view || view.hidden)) return null;

  const buttonClass =
    "w-full min-h-16 px-5 rounded-2xl text-xl font-extrabold border cursor-pointer disabled:opacity-60 disabled:cursor-wait";
  const showChoices = Boolean(view && !view.hidden && (view.showHomeworkButton || view.showSkipHomework));

  return (
    <section className="internet-panel mb-8 grid gap-3 pr-14" aria-label="Homework and internet">
      {view && !view.hidden && view.timeOver && (
        <p className="m-0 rounded-2xl bg-surface border border-border px-4 py-4 text-center text-xl font-extrabold shadow-card">
          Internet time is over for today.
        </p>
      )}
      {view && !view.hidden && view.onBreak && (
        <div className="rounded-2xl bg-surface border border-border px-4 py-4 text-center shadow-card" aria-live="polite">
          <p className="m-0 text-xl font-extrabold">Internet break</p>
          {view.breakSeconds !== null && (
            <p className="m-0 mt-1 text-lg font-bold tabular-nums">{formatDuration(view.breakSeconds)} left</p>
          )}
        </div>
      )}
      {view && !view.hidden && view.modeLabel && (
        <div className="rounded-2xl bg-surface border border-border px-4 py-4 text-center shadow-card">
          <p className="m-0 text-xl font-extrabold">{view.modeLabel}</p>
          {view.countdownSeconds !== null && (
            <p className="m-0 mt-1 text-lg font-bold tabular-nums">{formatDuration(view.countdownSeconds)} left</p>
          )}
        </div>
      )}
      {showChoices && view && (
        <div className={view.showHomeworkButton && view.showSkipHomework ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
          {view.showHomeworkButton && (
            <button type="button" className={`${buttonClass} border-transparent bg-accent text-white shadow-btn`} disabled={busy} onClick={() => void choose({ mode: "homework" })}>
              Homework mode
            </button>
          )}
          {view.showSkipHomework && (
            <button type="button" className={`${buttonClass} border-border bg-surface-solid text-text`} disabled={busy} onClick={() => void choose({ homework_declared: "skipped" })}>
              I have no homework
            </button>
          )}
        </div>
      )}
      {view && !view.hidden && view.showInternetButton && (
        <button type="button" className={`${buttonClass} border-transparent bg-accent-strong text-white shadow-btn`} disabled={busy} onClick={() => void choose({ mode: "internet" })}>
          Internet mode · {view.minutes === 1 ? "1 minute" : `${view.minutes} minutes`}
        </button>
      )}
      {problem && <p className="m-0 text-center text-base font-bold">{problem}</p>}
    </section>
  );
}
