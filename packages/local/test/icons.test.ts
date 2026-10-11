/**
 * Icon downloads, with the network stubbed. No database: the HTTP wiring is in
 * sites.integration.test.ts.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureAppIcon, ensureWebsiteIcon, fetchMissingIcons, websiteIconKey } from "../src/icons.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

test("a website icon is the apple-touch-icon, at the path the launcher requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  const seen: string[] = [];
  const outcome = await ensureWebsiteIcon(
    { url: "https://homeassistant.example/", name: "Home Assistant" },
    {
      iconsDir: dir,
      fetch: async (input) => {
        const url = urlOf(input);
        seen.push(url);
        if (url === "https://homeassistant.example/") {
          return new Response(
            `<link rel="icon" href="/small.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">`,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (url === "https://homeassistant.example/touch.png") {
          return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected ${url}`);
      },
    },
  );
  assert.equal(outcome, "downloaded");
  assert.deepEqual(seen, ["https://homeassistant.example/", "https://homeassistant.example/touch.png"]);
  assert.deepEqual(await readFile(path.join(dir, "website-icons", "homeassistant.example.png")), PNG);
});

test("a named website icon is stored under that name, and an svg falls back to a png", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  const seen: string[] = [];
  const outcome = await ensureWebsiteIcon(
    { url: "https://svg.example/", icon: "ha.png" },
    {
      iconsDir: dir,
      fetch: async (input) => {
        const url = urlOf(input);
        seen.push(url);
        if (url === "https://svg.example/") {
          return new Response(`<link rel="icon" href="/icon.svg">`, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url.endsWith("/icon.svg")) {
          return new Response("<svg></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } });
        }
        if (url.startsWith("https://www.google.com/s2/favicons")) {
          return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response("no", { status: 404 });
      },
    },
  );
  assert.equal(outcome, "downloaded");
  assert.equal(websiteIconKey({ url: "https://svg.example/", icon: "ha.png" }), "website-icons/ha.png");
  assert.ok(seen.some((url) => url.startsWith("https://www.google.com/s2/favicons")));
  assert.deepEqual(await readFile(path.join(dir, "website-icons", "ha.png")), PNG);
  await assert.rejects(readFile(path.join(dir, "website-icons", "svg.example.png")));
});

test("an icon already on disk is not downloaded again, and a bad name is not written", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  await mkdir(path.join(dir, "website-icons"));
  const file = path.join(dir, "website-icons", "kept.example.png");
  await writeFile(file, Buffer.from("original"));
  let called = false;
  const outcome = await ensureWebsiteIcon(
    { url: "https://kept.example/" },
    {
      iconsDir: dir,
      fetch: async () => {
        called = true;
        return new Response("no", { status: 500 });
      },
    },
  );
  assert.equal(outcome, "skipped");
  assert.equal(called, false);
  assert.equal(await readFile(file, "utf8"), "original");
  assert.equal(websiteIconKey({ url: "https://kept.example/", icon: "../../secret.png" }), null);
  assert.equal(await ensureWebsiteIcon({ url: "https://kept.example/", icon: "../../secret.png" }, { iconsDir: dir, fetch: async () => { called = true; return new Response("", { status: 500 }); } }), "skipped");
  assert.equal(called, false);
});

test("a failed download does not throw and does not write a file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  const outcome = await ensureWebsiteIcon(
    { url: "https://broken.example/", name: "Broken" },
    { iconsDir: dir, fetch: async () => new Response("no", { status: 500 }) },
  );
  assert.equal(outcome, "failed");
  await assert.rejects(readFile(path.join(dir, "website-icons", "broken.example.png")));
});

test("an app icon is iTunes artwork at app-icons/{id}.jpg; a system icon is left alone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  let called = false;
  const skipped = await ensureAppIcon(
    { name: "Camera", type: "system", icon: "camera", app_store_url: "https://apps.apple.com/gb/app/camera/id1" },
    {
      iconsDir: dir,
      fetch: async () => {
        called = true;
        return new Response("", { status: 500 });
      },
    },
  );
  assert.equal(skipped, "skipped");
  assert.equal(called, false);

  const outcome = await ensureAppIcon(
    { name: "Home", type: "app", app_store_url: "https://apps.apple.com/gb/app/home/id424242" },
    {
      iconsDir: dir,
      fetch: async (input) => {
        const url = urlOf(input);
        if (url.startsWith("https://itunes.apple.com/lookup")) {
          return Response.json({ results: [{ trackId: 424242, artworkUrl512: "https://art.test/424242.jpg" }] });
        }
        if (url === "https://art.test/424242.jpg") {
          return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
        }
        return new Response("no", { status: 404 });
      },
    },
  );
  assert.equal(outcome, "downloaded");
  assert.deepEqual(await readFile(path.join(dir, "app-icons", "424242.jpg")), JPEG);
});

test("backfill counts downloaded, already-present and failed icons", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icons-"));
  await mkdir(path.join(dir, "app-icons"), { recursive: true });
  await writeFile(path.join(dir, "app-icons", "111.jpg"), JPEG);
  const report = await fetchMissingIcons(
    [
      { name: "Maths", type: "app", app_store_url: "https://apps.apple.com/gb/app/maths/id111" },
      { name: "New", type: "app", app_store_url: "https://apps.apple.com/gb/app/new/id222" },
      { name: "Camera", type: "system", icon: "camera" },
    ],
    [{ url: "https://new.example/", name: "New" }, { url: "not a url", name: "Bad" }],
    {
      iconsDir: dir,
      fetch: async (input) => {
        const url = urlOf(input);
        if (url.startsWith("https://itunes.apple.com/lookup")) {
          return Response.json({ results: [{ trackId: 222, artworkUrl100: "https://art.test/222.jpg" }] });
        }
        if (url === "https://art.test/222.jpg") return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
        if (url === "https://new.example/") return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
        if (url.startsWith("https://www.google.com/s2/favicons")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
        return new Response("no", { status: 404 });
      },
    },
  );
  assert.deepEqual(report, { downloaded: 2, skipped: 3, failed: 0 });
  assert.deepEqual(await readFile(path.join(dir, "app-icons", "111.jpg")), JPEG);
  assert.deepEqual(await readFile(path.join(dir, "website-icons", "new.example.png")), PNG);
});
