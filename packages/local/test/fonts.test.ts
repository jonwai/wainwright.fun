/**
 * Pages the home-network server actually sends (Dockerfile.local builds these HTML files
 * into the image). A stylesheet from fonts.googleapis.com blocks first paint when the
 * iPad's WAN is off, so none of them may point at Google Fonts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

/** HTML the local server serves, plus the hosted admin page that shares this head. */
const SERVED_HTML = [
  "apps/kids/index.html",
  "apps/admin/index.html",
  "apps/admin/local-admin.html",
  "apps/admin/local-tickets.html",
  "apps/tickets/index.html",
];

const FONT_CSS = ["apps/kids/index.css", "apps/admin/src/index.css", "apps/tickets/src/styles.css"];

function headOf(html: string): string {
  const match = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  assert.ok(match, "page has a head");
  return match[1] ?? "";
}

/** Absolute URLs on link href or script src inside head. Those leave the iPad. */
function externalHeadUrls(head: string): string[] {
  const urls: string[] = [];
  for (const tag of head.match(/<(?:link|script)\b[^>]*>/gi) ?? []) {
    const href = /\b(?:href|src)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const url = href?.[1] ?? "";
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

test("served pages do not load Google Fonts or any other external head resource", async () => {
  for (const relative of SERVED_HTML) {
    const html = await readFile(path.join(root, relative), "utf8");
    assert.equal(html.includes("fonts.googleapis.com"), false, `${relative} links fonts.googleapis.com`);
    assert.equal(html.includes("fonts.gstatic.com"), false, `${relative} links fonts.gstatic.com`);
    assert.deepEqual(externalHeadUrls(headOf(html)), [], `${relative} head has an external url`);
  }
});

test("Nunito is a local latin woff2 with font-display swap", async () => {
  const font = await readFile(path.join(root, "packages/shared/fonts/nunito-latin.woff2"));
  assert.equal(font.subarray(0, 4).toString("latin1"), "wOF2");
  assert.ok(font.length > 1000);
  for (const relative of FONT_CSS) {
    const css = await readFile(path.join(root, relative), "utf8");
    assert.match(css, /font-family:\s*"Nunito"/);
    assert.match(css, /font-weight:\s*400 800/, `${relative} must cover weights 400, 600, 700 and 800`);
    assert.match(css, /font-display:\s*swap/);
    assert.match(css, /nunito-latin\.woff2/);
    assert.equal(css.includes("fonts.googleapis.com"), false, relative);
    assert.equal(css.includes("fonts.gstatic.com"), false, relative);
  }
});
