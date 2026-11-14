/**
 * What the launcher shows for homework mode, internet mode, and the break after internet.
 * Home Assistant owns the timers and whether each button is available. This only
 * turns one poll of /kid/internet into the buttons and countdowns a child sees.
 */

export type InternetMode = "off" | "homework" | "internet";
export type HomeworkDeclared = "none" | "homework" | "skipped";

export interface InternetState {
  available?: boolean;
  child_id?: string;
  mode?: InternetMode | string;
  homework_declared?: HomeworkDeclared | string;
  internet_used_today?: boolean;
  internet_available?: boolean;
  allowance_seconds?: number;
  seconds_left?: number | null;
  internet_ends_at?: string | null;
  resets_at?: string | null;
  /** Home Assistant: a 10-minute break after internet mode ends. */
  on_break?: boolean;
  break_ends_at?: string | null;
  break_seconds_left?: number;
  /** Homework mode can start again, including after the break, as often as HA allows. */
  homework_available?: boolean;
}

export type InternetCommand =
  | { mode: "homework" }
  | { mode: "internet" }
  | { mode: "off" }
  | { homework_declared: "skipped" };

export interface InternetView {
  hidden: boolean;
  showHomeworkButton: boolean;
  /** "I have no homework", beside Homework mode before anything is declared. */
  showSkipHomework: boolean;
  showInternetButton: boolean;
  minutes: number;
  modeLabel: "Homework mode" | "Internet mode" | null;
  countdownSeconds: number | null;
  /** Internet's one session is over. Homework can still be available. */
  timeOver: boolean;
  onBreak: boolean;
  breakSeconds: number | null;
}

export function secondsRemaining(state: InternetState, nowMs: number, fetchedAtMs: number): number | null {
  if (state.mode === "internet" && state.internet_ends_at) {
    const end = Date.parse(state.internet_ends_at);
    if (Number.isFinite(end)) return Math.max(0, Math.round((end - nowMs) / 1000));
  }
  if ((state.mode === "homework" || state.mode === "internet") && typeof state.seconds_left === "number" && Number.isFinite(state.seconds_left)) {
    const elapsed = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000));
    return Math.max(0, Math.floor(state.seconds_left) - elapsed);
  }
  return null;
}

/**
 * Seconds left on the internet break. `break_ends_at` is the clock; `break_seconds_left`
 * is the fallback counted down from the moment this state was fetched.
 */
export function breakSecondsRemaining(state: InternetState, nowMs: number, fetchedAtMs: number): number | null {
  if (state.on_break !== true) return null;
  if (state.break_ends_at) {
    const end = Date.parse(state.break_ends_at);
    if (Number.isFinite(end)) return Math.max(0, Math.round((end - nowMs) / 1000));
  }
  if (typeof state.break_seconds_left === "number" && Number.isFinite(state.break_seconds_left)) {
    const elapsed = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000));
    return Math.max(0, Math.floor(state.break_seconds_left) - elapsed);
  }
  return null;
}

/** The break or a running mode has ticked down to zero, so the page should ask the server again. */
export function internetCountdownFinished(view: InternetView): boolean {
  if (view.onBreak && view.breakSeconds === 0) return true;
  return view.countdownSeconds === 0 && (view.modeLabel === "Homework mode" || view.modeLabel === "Internet mode");
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return rest === 1 ? "1 second" : `${rest} seconds`;
  const minLabel = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  if (rest === 0) return minLabel;
  const secLabel = rest === 1 ? "1 second" : `${rest} seconds`;
  return `${minLabel} ${secLabel}`;
}

export function internetMinutes(allowanceSeconds: number | undefined): number {
  const seconds = typeof allowanceSeconds === "number" && Number.isFinite(allowanceSeconds) ? allowanceSeconds : 3600;
  return Math.max(0, Math.round(seconds / 60));
}

/** What the launcher says when a mode change is refused or Home Assistant can't be reached. */
export function internetProblemMessage(message: string): string {
  if (message === "internet controls unavailable") return "Internet controls aren't available right now.";
  if (message === "internet_break") return "You're on an internet break. Homework mode is back when the break ends.";
  return message;
}

function hiddenView(minutes: number): InternetView {
  return {
    hidden: true,
    showHomeworkButton: false,
    showSkipHomework: false,
    showInternetButton: false,
    minutes,
    modeLabel: null,
    countdownSeconds: null,
    timeOver: false,
    onBreak: false,
    breakSeconds: null,
  };
}

/** Buttons and the countdowns for one poll of /kid/internet. */
export function internetView(state: InternetState, nowMs: number, fetchedAtMs: number): InternetView {
  const minutes = internetMinutes(state.allowance_seconds);
  if (state.available === false) return hiddenView(minutes);

  const declared = state.homework_declared ?? "none";
  const mode = state.mode ?? "off";
  const remaining = secondsRemaining(state, nowMs, fetchedAtMs);
  const onBreak = state.on_break === true;
  const breakSeconds = breakSecondsRemaining(state, nowMs, fetchedAtMs);
  // Internet's one session is over when it has been used and neither mode is on.
  // A countdown sitting at zero still shows its mode until the server says the break has started.
  const timeOver = Boolean(state.internet_used_today) && !onBreak && mode !== "homework" && mode !== "internet";
  const modeLabel = mode === "homework" ? "Homework mode" : mode === "internet" ? "Internet mode" : null;
  const undeclared = declared === "none" || declared === "";

  return {
    hidden: false,
    showHomeworkButton: state.homework_available === true,
    showSkipHomework: state.homework_available === true && undeclared,
    showInternetButton: state.internet_available === true && mode !== "internet",
    minutes,
    modeLabel,
    countdownSeconds: remaining,
    timeOver,
    onBreak,
    breakSeconds,
  };
}
