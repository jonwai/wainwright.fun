/**
 * Provisional Household inventory client used when a parent confirms a paper reward.
 * Run: npx tsx tools/test-household-inventory.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HOUSEHOLD_CONSUMABLE_PATHS,
  HOUSEHOLD_PAPER_REVERSE,
  STOCK_WARNINGS,
  TICKETS_REWARD_SOURCE,
  consumablePath,
  consumableSpec,
  decideConsumableClaim,
  householdAuthHeaders,
  householdInventoryFromEnv,
  householdUseOf,
  listConsumableOptions,
  parseConsumableOptions,
  recordConsumableUse,
  reverseConsumableUse,
} from "../packages/local/src/household-inventory.ts";

const HP = "hp-everyday-a4-75gsm-x500-sheets";
const SPEC = { category: "printer-paper", sheets: 10 };

assert.equal(consumableSpec({ reward_id: "plain-paper" }), null);
assert.deepEqual(consumableSpec({ household_consumable: { category: " printer-paper ", sheets: 10 } }), SPEC);
assert.deepEqual(consumableSpec({ extra: { household_consumable: SPEC } }), SPEC);
assert.equal(consumableSpec({ household_consumable: { category: "printer-paper", sheets: 0 } }), null);

assert.equal(householdUseOf({ household_use: { recorded: false, product_slug: HP, sheets: 10, ref: "r1" } }), null);
assert.equal(
  householdUseOf({
    extra: { household_use: { recorded: true, product_slug: HP, name: "HP Everyday", sheets: 10, ref: "r1" } },
  })?.ref,
  "r1",
);

const parsed = parseConsumableOptions(
  [
    { product_slug: "small-pack", name: "Small pack", sheets_remaining: 12 },
    { product_slug: HP, name: "HP Everyday Printer Paper A4 75gsm x500 Sheets", sheets_remaining: 1500 },
    { product_slug: "short", name: "Almost gone", sheets_remaining: 9 },
    { product_slug: HP, name: "stale duplicate", sheets_remaining: 20 },
  ],
  10,
);
assert.deepEqual(parsed?.map((option) => option.product_slug), [HP, "small-pack"]);
assert.deepEqual(
  parseConsumableOptions({ options: [{ product_slug: HP, name: "HP Everyday", sheets_remaining: 500 }] }, 10)?.[0].product_slug,
  HP,
);
assert.equal(parseConsumableOptions({ products: [] }, 10), null);

assert.deepEqual(decideConsumableClaim({ ok: false, warning: STOCK_WARNINGS.silent }, undefined, SPEC), {
  kind: "warn",
  warning: STOCK_WARNINGS.silent,
});
assert.equal(decideConsumableClaim({ ok: true, options: [] }, HP, SPEC).kind, "warn");
const rejected = decideConsumableClaim({ ok: true, options: parsed! }, "", SPEC);
assert.equal(rejected.kind, "reject");
const chosen = decideConsumableClaim({ ok: true, options: parsed! }, "small-pack", SPEC);
assert.deepEqual(chosen, { kind: "use", option: parsed![1], sheets: 10 });

assert.equal(HOUSEHOLD_PAPER_REVERSE, "post");
assert.equal(consumablePath("printer-paper"), HOUSEHOLD_CONSUMABLE_PATHS["printer-paper"]);
assert.equal(consumablePath("card"), null);
assert.deepEqual(householdInventoryFromEnv({ HOUSEHOLD_URL: "http://household:43126/" }), {
  url: "http://household:43126",
  authHeader: "Authorization",
  reverse: "post",
});
assert.deepEqual(
  householdInventoryFromEnv({
    HOUSEHOLD_URL: "http://household:43126",
    HOUSEHOLD_SERVICE_TOKEN: "secret",
    HOUSEHOLD_SERVICE_HEADER: "X-Household-Token",
    HOUSEHOLD_PAPER_REVERSE: "delete",
  }),
  { url: "http://household:43126", token: "secret", authHeader: "X-Household-Token", reverse: "delete" },
);
assert.deepEqual(householdAuthHeaders({ url: "http://household", token: "secret" }), {
  accept: "application/json",
  Authorization: "Bearer secret",
});
assert.equal(householdAuthHeaders({ url: "http://household", token: "secret", authHeader: "X-Household-Token" })["X-Household-Token"], "secret");

const calls: { method: string; path: string; body: unknown; authorization: string | undefined; service: string | undefined }[] = [];
const paper = HOUSEHOLD_CONSUMABLE_PATHS["printer-paper"];
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://household");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    calls.push({
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      service: typeof req.headers["x-household-token"] === "string" ? req.headers["x-household-token"] : undefined,
    });
    if (url.pathname === paper && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { product_slug: "small-pack", name: "Small pack", sheets_remaining: 40 },
        { product_slug: HP, name: "HP Everyday Printer Paper A4 75gsm x500 Sheets", sheets_remaining: 1500 },
        { product_slug: "short", name: "Almost gone", sheets_remaining: 4 },
      ]));
      return;
    }
    if (url.pathname === `${paper}/use` && req.method === "POST") {
      const slug = body && typeof body === "object" ? (body as { product_slug?: string }).product_slug : "";
      if (slug === "not-paper") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "That product is not printer paper" }));
        return;
      }
      if (slug === "too-many") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Only 4 sheets left" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === `${paper}/reverse` && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith(`${paper}/use/`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const inventory = { url: base, token: "secret" };

const unmapped = await listConsumableOptions(inventory, { category: "card", sheets: 10 });
assert.deepEqual(unmapped, { ok: false, warning: STOCK_WARNINGS.unmapped("card") });
assert.equal(calls.length, 0);

const listed = await listConsumableOptions(inventory, SPEC);
assert.equal(listed.ok, true);
if (listed.ok) assert.deepEqual(listed.options.map((option) => option.product_slug), [HP, "small-pack"]);
assert.equal(calls[0].method, "GET");
assert.equal(calls[0].path, `${paper}?min_sheets=10`);
assert.equal(calls[0].authorization, "Bearer secret");

const used = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: HP, sheets: 10, ref: "zoe-paper-1" });
assert.equal(used.ok, true);
assert.deepEqual(calls[1].body, { product_slug: HP, sheets: 10, ref: "zoe-paper-1", source: TICKETS_REWARD_SOURCE });

const notPaper = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "not-paper", sheets: 10, ref: "zoe-paper-2" });
assert.deepEqual(notPaper, { ok: false, rejected: true, warning: STOCK_WARNINGS.notRecorded, error: "That product is not printer paper" });
const tooMany = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "too-many", sheets: 10, ref: "zoe-paper-3" });
assert.equal(tooMany.ok, false);
if (!tooMany.ok) assert.equal(tooMany.rejected && tooMany.error, "Only 4 sheets left");

const reversed = await reverseConsumableUse(inventory, { category: "printer-paper", ref: "zoe-paper-1" });
assert.equal(reversed.ok, true);
assert.equal(calls.at(-1)?.method, "POST");
assert.equal(calls.at(-1)?.path, `${paper}/reverse`);
assert.deepEqual(calls.at(-1)?.body, { ref: "zoe-paper-1" });

const custom = { url: base, token: "secret", authHeader: "X-Household-Token", reverse: "delete" as const };
const deleted = await reverseConsumableUse(custom, { category: "printer-paper", ref: "zoe paper/1" });
assert.equal(deleted.ok, true);
assert.equal(calls.at(-1)?.method, "DELETE");
assert.equal(calls.at(-1)?.path, `${paper}/use/${encodeURIComponent("zoe paper/1")}`);
assert.equal(calls.at(-1)?.body, null);
assert.equal(calls.at(-1)?.service, "secret");

const down = await listConsumableOptions({ url: "http://127.0.0.1:1" }, SPEC);
assert.deepEqual(down, { ok: false, warning: STOCK_WARNINGS.silent });
const unlinked = await recordConsumableUse(null, { category: "printer-paper", product_slug: HP, sheets: 10, ref: "zoe-paper-1" });
assert.deepEqual(unlinked, { ok: false, rejected: false, warning: STOCK_WARNINGS.unlinked });

server.close();
console.log("household inventory ok");
