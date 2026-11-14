/**
 * Homework mode without Postgres: token compare, hostname parsing, the Home Assistant
 * client (409 and a dropped connection), and the kid-route rules. The HTTP round trip
 * against Postgres lives in sites.integration.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { breakSecondsRemaining, formatDuration, internetCountdownFinished, internetProblemMessage, internetView } from "../../../apps/kids/lib/internet.ts";
import { INTERNET_CONTROLS_UNAVAILABLE, bearerToken, haClientFromEnv, readTokenFile, tokensMatch } from "../src/ha.ts";
import { buildHomeworkDomains, endBreakCommand, handleEndBreak, handleKidInternet, handleKidInternetMode, internetModeCommand, websiteHostname } from "../src/homework.ts";

test("bearer tokens match in constant time and a missing token never matches", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret", "secreT"), false);
  assert.equal(tokensMatch("secret", "secret-longer"), false);
  assert.equal(tokensMatch("", "secret"), false);
  assert.equal(tokensMatch("secret", ""), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(bearerToken("Bearer secret"), "secret");
  assert.equal(bearerToken("bearer secret"), "secret");
  assert.equal(bearerToken("Basic secret"), "");
  assert.equal(bearerToken(undefined), "");
});

test("homework hostnames come from the URL, including a missing slash", () => {
  assert.equal(websiteHostname("https:/bible.wainwright.fun/"), "bible.wainwright.fun");
  assert.equal(websiteHostname("https://www.BBC.co.uk/cbbc"), "www.bbc.co.uk");
  assert.equal(websiteHostname("https://www.bbc.co.uk/news"), "www.bbc.co.uk");
  assert.equal(websiteHostname("not a url"), null);
  const payload = buildHomeworkDomains(
    [
      { name: "News", url: "https://www.bbc.co.uk/news", min_age: 6, child_id: null },
      { name: "CBeebies", url: "https://www.bbc.co.uk/cbeebies", min_age: 0, child_id: null },
      { name: "Bible", url: "https:/bible.wainwright.fun/", min_age: 4, child_id: "hannah" },
      { name: "Nope", url: "::::", min_age: 0, child_id: null },
    ],
    [
      { id: "zoe", allowance_seconds: 1800 },
      { id: "joanna", allowance_seconds: 3600 },
    ],
    new Date("2026-11-12T00:00:00.000Z"),
  );
  assert.deepEqual(payload.domains, ["bible.wainwright.fun", "www.bbc.co.uk"]);
  assert.equal(payload.sites.length, 3);
  assert.equal(payload.sites.filter((site) => site.domain === "www.bbc.co.uk").length, 2);
  assert.equal(payload.sites.find((site) => site.name === "Bible")?.child_id, "hannah");
  assert.deepEqual(payload.children.zoe, { allowance_seconds: 1800 });
  assert.equal(payload.updated_at, "2026-11-12T00:00:00.000Z");
});

test("internet mode sends the database allowance, not the body's", () => {
  assert.deepEqual(internetModeCommand({ mode: "internet", allowance_seconds: 1, child_id: "hannah" }, 1800), {
    ok: true,
    body: { mode: "internet", allowance_seconds: 1800 },
  });
  assert.deepEqual(internetModeCommand({ mode: "homework" }, 3600), { ok: true, body: { mode: "homework" } });
  assert.deepEqual(internetModeCommand({ mode: "off" }, 3600), { ok: true, body: { mode: "off" } });
  assert.deepEqual(internetModeCommand({ homework_declared: "skipped" }, 3600), { ok: true, body: { homework_declared: "skipped" } });
  assert.equal(internetModeCommand({ mode: "homework", homework_declared: "skipped" }, 3600).ok, false);
  assert.equal(internetModeCommand({ child_id: "hannah" }, 3600).ok, false);
  assert.equal(internetModeCommand({ end_break: true }, 3600).ok, false);
  assert.equal(internetModeCommand({ end_break: true, mode: "homework" }, 3600).ok, false);
  assert.equal(internetModeCommand({ end_break: true, homework_declared: "skipped" }, 3600).ok, false);
  const override = endBreakCommand();
  assert.deepEqual(override, { end_break: true });
  assert.deepEqual(Object.keys(override), ["end_break"]);
});

test("the kid route hides Joanna and passes a 409 reason through", async () => {
  const db = { async query() { return { rows: [{ allowance_seconds: 1800 }] }; } };
  let calls = 0;
  const ha = {
    async getKid() {
      calls += 1;
      return { status: 409, body: { reason: "Finish your homework first" } };
    },
    async setMode(_childId: string, body: Record<string, unknown>) {
      return { status: 200, body: { child_id: "lydia", mode: body.mode } };
    },
  };
  assert.deepEqual(await handleKidInternet(db, ha, "joanna"), { status: 200, body: { available: false } });
  assert.equal(calls, 0);
  const blocked = await handleKidInternet(db, ha, "zoe");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, "Finish your homework first");

  let sent: unknown = null;
  let sentChild = "";
  const posting = {
    async getKid() {
      return { status: 200, body: { child_id: "someone-else", allowance_seconds: 1 } };
    },
    async setMode(childId: string, body: Record<string, unknown>) {
      sentChild = childId;
      sent = body;
      return { status: 200, body: { child_id: childId, mode: "internet", allowance_seconds: 1 } };
    },
  };
  const started = await handleKidInternetMode(db, posting, "lydia", { mode: "internet", child_id: "hannah", allowance_seconds: 5 });
  assert.equal(sentChild, "lydia");
  assert.deepEqual(sent, { mode: "internet", allowance_seconds: 1800 });
  assert.equal(started.status, 200);
  assert.equal(started.body.child_id, "lydia");
  assert.equal(started.body.allowance_seconds, 1800);
  assert.equal(started.body.available, true);

  const down = {
    async getKid() {
      return { status: 503, unavailable: true, body: { error: INTERNET_CONTROLS_UNAVAILABLE } };
    },
    async setMode() {
      throw new Error("boom");
    },
  };
  assert.equal((await handleKidInternet(db, down, "ethan")).status, 503);
  assert.equal((await handleKidInternet(db, down, "ethan")).body.error, INTERNET_CONTROLS_UNAVAILABLE);
  assert.equal((await handleKidInternetMode(db, down, "ethan", { mode: "off" })).status, 503);
  assert.equal((await handleKidInternetMode(db, down, "hannah", { mode: "sideways" })).status, 400);
  assert.equal((await handleKidInternetMode(db, down, "hannah", { end_break: true, mode: "off" })).status, 400);

  const duringBreak = {
    async getKid() {
      return { status: 200, body: {} };
    },
    async setMode() {
      return { status: 409, body: { error: "Homework mode is paused", reason: "internet_break" } };
    },
  };
  const paused = await handleKidInternetMode(db, duringBreak, "hannah", { mode: "homework" });
  assert.equal(paused.status, 409);
  assert.equal(paused.body.reason, "internet_break");
  assert.equal(internetProblemMessage("internet_break"), "You're on an internet break. Homework mode is back when the break ends.");
  assert.equal(internetProblemMessage("internet controls unavailable"), "Internet controls aren't available right now.");
});

test("GET /kid/internet passes break fields through, and end break sends only end_break", async () => {
  const db = { async query() { return { rows: [{ allowance_seconds: 1800 }] }; } };
  const haState = {
    child_id: "ethan",
    mode: "off",
    on_break: true,
    break_ends_at: "2026-11-14T12:10:00.000Z",
    break_seconds_left: 600,
    homework_available: false,
    internet_available: false,
    allowance_seconds: 1,
  };
  const reading = {
    async getKid() {
      return { status: 200, body: haState };
    },
    async setMode() {
      throw new Error("GET must not change the mode");
    },
  };
  const got = await handleKidInternet(db, reading, "ethan");
  assert.equal(got.status, 200);
  assert.equal(got.body.on_break, true);
  assert.equal(got.body.break_ends_at, "2026-11-14T12:10:00.000Z");
  assert.equal(got.body.break_seconds_left, 600);
  assert.equal(got.body.homework_available, false);
  assert.equal(got.body.internet_available, false);
  assert.equal(got.body.allowance_seconds, 1800);
  assert.equal(got.body.available, true);

  let sent: unknown = null;
  let sentChild = "";
  let calls = 0;
  const ending = {
    async getKid() {
      throw new Error("end break does not read first");
    },
    async setMode(childId: string, body: Record<string, unknown>) {
      calls += 1;
      sentChild = childId;
      sent = body;
      return { status: 200, body: { ...haState, child_id: childId, on_break: false, break_ends_at: null, break_seconds_left: 0, homework_available: true } };
    },
  };
  const ended = await handleEndBreak(db, ending, "lydia");
  assert.equal(calls, 1);
  assert.equal(sentChild, "lydia");
  assert.deepEqual(sent, { end_break: true });
  assert.deepEqual(Object.keys(sent as object), ["end_break"]);
  assert.equal(ended.status, 200);
  assert.equal(ended.body.on_break, false);
  assert.equal(ended.body.homework_available, true);
  assert.equal(ended.body.allowance_seconds, 1800);

  assert.deepEqual(await handleEndBreak(db, ending, "joanna"), { status: 404, body: { available: false } });
  assert.equal(calls, 1, "Joanna is not sent to Home Assistant");

  const down = {
    async getKid() {
      return { status: 503, unavailable: true, body: { error: INTERNET_CONTROLS_UNAVAILABLE } };
    },
    async setMode() {
      return { status: 503, unavailable: true, body: { error: INTERNET_CONTROLS_UNAVAILABLE } };
    },
  };
  assert.equal((await handleEndBreak(db, down, "zoe")).status, 503);
  assert.equal((await handleEndBreak(db, down, "zoe")).body.error, INTERNET_CONTROLS_UNAVAILABLE);
  const throwing = {
    async getKid() {
      return { status: 200, body: {} };
    },
    async setMode() {
      throw new Error("connect ECONNREFUSED");
    },
  };
  assert.equal((await handleEndBreak(db, throwing, "hannah")).status, 503);
});

test("the Home Assistant client returns 409 and survives a missing token or a dropped connection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ha-token-"));
  const tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "long-lived-token\n");
  assert.equal(readTokenFile(tokenFile), "long-lived-token");
  assert.equal(readTokenFile(path.join(dir, "missing")), "");

  let called = false;
  const missing = await haClientFromEnv({ HA_TOKEN_FILE: path.join(dir, "missing") }, async () => {
    called = true;
    return new Response("{}");
  }).getKid("zoe");
  assert.equal(called, false);
  assert.equal(missing.unavailable, true);
  assert.equal((missing.body as { error: string }).error, INTERNET_CONTROLS_UNAVAILABLE);

  let seenUrl = "";
  let seenAuth = "";
  const ok = await haClientFromEnv({ HA_TOKEN_FILE: tokenFile }, async (input, init) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ child_id: "zoe", mode: "off" }), { status: 200 });
  }).getKid("zoe");
  assert.equal(ok.status, 200);
  assert.equal(seenUrl, "https://home.wainwright.fun/api/wainwright_fun/kids/zoe");
  assert.equal(seenAuth, "Bearer long-lived-token");

  const blocked = await haClientFromEnv({ HA_URL: "http://ha.local", HA_TOKEN_FILE: tokenFile }, async (_input, init) => {
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ reason: "Finish your homework first" }), { status: 409, headers: { "content-type": "application/json" } });
  }).setMode("lydia", { mode: "internet", allowance_seconds: 3600 });
  assert.equal(blocked.unavailable, undefined);
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body, { reason: "Finish your homework first" });

  const refused = await haClientFromEnv({ HA_TOKEN_FILE: tokenFile }, async () => {
    throw new Error("connect ECONNREFUSED");
  }).getKid("ethan");
  assert.equal(refused.unavailable, true);
  assert.equal((refused.body as { error: string }).error, INTERNET_CONTROLS_UNAVAILABLE);

  const down = createServer((req) => {
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
  const port = (down.address() as AddressInfo).port;
  try {
    const dropped = await haClientFromEnv({ HA_URL: `http://127.0.0.1:${port}`, HA_TOKEN_FILE: tokenFile }).getKid("hannah");
    assert.equal(dropped.unavailable, true);
    assert.equal((dropped.body as { error: string }).error, INTERNET_CONTROLS_UNAVAILABLE);
  } finally {
    down.close();
  }
});

test("the launcher follows homework_available, internet_available, and the break countdown", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const fresh = {
    available: true,
    mode: "off" as const,
    homework_declared: "none",
    internet_used_today: false,
    internet_available: false,
    homework_available: true,
    on_break: false,
    allowance_seconds: 3600,
    seconds_left: 3600,
  };
  const start = internetView(fresh, now, now);
  assert.equal(start.showHomeworkButton, true);
  assert.equal(start.showSkipHomework, true);
  assert.equal(start.showInternetButton, false);
  assert.equal(start.onBreak, false);
  assert.equal(start.minutes, 60);

  const skipped = internetView({ ...fresh, homework_declared: "skipped", homework_available: false, internet_available: true }, now, now);
  assert.equal(skipped.showHomeworkButton, false);
  assert.equal(skipped.showSkipHomework, false);
  assert.equal(skipped.showInternetButton, true);

  const homework = internetView(
    { ...fresh, mode: "homework", homework_declared: "homework", homework_available: false, internet_available: true, seconds_left: 90 },
    now,
    now - 30_000,
  );
  assert.equal(homework.modeLabel, "Homework mode");
  assert.equal(homework.countdownSeconds, 60);
  assert.equal(homework.showHomeworkButton, false);
  assert.equal(homework.showInternetButton, true);
  assert.equal(formatDuration(homework.countdownSeconds ?? 0), "1 minute");
  assert.equal(internetCountdownFinished(homework), false);

  const running = internetView(
    {
      ...fresh,
      mode: "internet",
      homework_declared: "homework",
      homework_available: false,
      internet_available: false,
      internet_used_today: true,
      internet_ends_at: "2026-11-14T12:10:00.000Z",
      seconds_left: 9999,
    },
    now,
    now,
  );
  assert.equal(running.modeLabel, "Internet mode");
  assert.equal(running.countdownSeconds, 600);
  assert.equal(running.showHomeworkButton, false);
  assert.equal(running.showInternetButton, false);
  assert.equal(running.timeOver, false);
  assert.equal(internetCountdownFinished({ ...running, countdownSeconds: 0 }), true);
  const justEnded = internetView(
    { ...fresh, mode: "internet", internet_used_today: true, internet_available: false, homework_available: false, seconds_left: 0 },
    now,
    now,
  );
  assert.equal(justEnded.modeLabel, "Internet mode");
  assert.equal(justEnded.countdownSeconds, 0);
  assert.equal(justEnded.timeOver, false);
  assert.equal(justEnded.onBreak, false);
  assert.equal(internetCountdownFinished(justEnded), true);

  const onBreak = internetView(
    {
      ...fresh,
      internet_used_today: true,
      homework_available: false,
      internet_available: false,
      on_break: true,
      break_ends_at: "2026-11-14T12:10:00.000Z",
      break_seconds_left: 9999,
    },
    now,
    now,
  );
  assert.equal(onBreak.onBreak, true);
  assert.equal(onBreak.breakSeconds, 600);
  assert.equal(onBreak.showHomeworkButton, false);
  assert.equal(internetView({ ...fresh, internet_used_today: true, on_break: true, homework_available: true, break_ends_at: "2026-11-14T12:10:00.000Z" }, now, now).showHomeworkButton, true);
  assert.equal(onBreak.timeOver, false);
  assert.equal(formatDuration(onBreak.breakSeconds ?? 0), "10 minutes");
  assert.equal(internetCountdownFinished(onBreak), false);
  assert.equal(internetCountdownFinished({ ...onBreak, breakSeconds: 0 }), true);
  const later = Date.parse("2026-11-14T12:01:00.000Z");
  assert.equal(
    breakSecondsRemaining(
      { on_break: true, break_ends_at: null, break_seconds_left: 90 },
      later,
      now,
    ),
    30,
  );
  assert.equal(breakSecondsRemaining({ on_break: false, break_seconds_left: 90 }, later, now), null);

  const after = internetView(
    {
      ...fresh,
      internet_used_today: true,
      homework_declared: "homework",
      homework_available: true,
      internet_available: false,
      on_break: false,
      mode: "off",
    },
    now,
    now,
  );
  assert.equal(after.showHomeworkButton, true, "homework comes back after the break, even though internet was used");
  assert.equal(after.showSkipHomework, false);
  assert.equal(after.showInternetButton, false);
  assert.equal(after.timeOver, true);
  assert.equal(internetView({ available: false, homework_available: true }, now, now).hidden, true);
});
