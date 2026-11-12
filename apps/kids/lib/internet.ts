/**
 * What the launcher shows for homework and internet mode.
 * Home Assistant owns the timers. This only decides which buttons a child sees.
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
}

export type InternetCommand =
  | { mode: "homework" }
  | { mode: "internet" }
  | { mode: "off" }
  | { homework_declared: "skipped" };

export interface InternetView {
  hidden: boolean;
  showHomeworkChoices: boolean;
  showInternetButton: boolean;
  minutes: number;
  modeLabel: "Homework mode" | "Internet mode" | null;
  countdownSeconds: number | null;
  timeOver: boolean;
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

/** Buttons and the countdown for one poll of /kid/internet. */
export function internetView(state: InternetState, nowMs: number, fetchedAtMs: number): InternetView {
  if (state.available === false) {
    return {
      hidden: true,
      showHomeworkChoices: false,
      showInternetButton: false,
      minutes: internetMinutes(state.allowance_seconds),
      modeLabel: null,
      countdownSeconds: null,
      timeOver: false,
    };
  }
  const declared = state.homework_declared ?? "none";
  const mode = state.mode ?? "off";
  const remaining = secondsRemaining(state, nowMs, fetchedAtMs);
  const running = (mode === "homework" || mode === "internet") && (remaining === null || remaining > 0);
  const timeOver = Boolean(state.internet_used_today) && mode !== "homework" && !running;
  const modeLabel = mode === "homework" ? "Homework mode" : mode === "internet" ? "Internet mode" : null;
  return {
    hidden: false,
    showHomeworkChoices: !state.internet_used_today && declared === "none" && mode === "off" && !timeOver,
    showInternetButton: (declared === "homework" || declared === "skipped") && mode !== "internet" && !timeOver,
    minutes: internetMinutes(state.allowance_seconds),
    modeLabel: timeOver ? null : modeLabel,
    countdownSeconds: timeOver ? null : remaining,
    timeOver,
  };
}
