/**
 * Provisional Household inventory client used when a parent confirms a paper reward.
 * Run: npx tsx tools/test-household-inventory.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HOUSEHOLD_INVENTORY_PATHS,
  STOCK_WARNINGS,
  TICKETS_REWARD_SOURCE,
  consumableSpec,
  decideConsumableClaim,
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

const calls: { method: string; path: string; body: unknown }[] = [];
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://household");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    calls.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, body });
    if (url.pathname === HOUSEHOLD_INVENTORY_PATHS.options) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { product_slug: "small-pack", name: "Small pack", sheets_remaining: 40 },
        { product_slug: HP, name: "HP Everyday Printer Paper A4 75gsm x500 Sheets", sheets_remaining: 1500 },
        { product_slug: "short", name: "Almost gone", sheets_remaining: 4 },
      ]));
      return;
    }
    if (url.pathname === HOUSEHOLD_INVENTORY_PATHS.use || url.pathname === HOUSEHOLD_INVENTORY_PATHS.reverse) {
      res.writeHead(req.headers["x-fail"] ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !req.headers["x-fail"] }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const inventory = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };

const listed = await listConsumableOptions(inventory, SPEC);
assert.equal(listed.ok, true);
if (listed.ok) assert.deepEqual(listed.options.map((option) => option.product_slug), [HP, "small-pack"]);
assert.equal(calls[0].method, "GET");
assert.equal(calls[0].path, `${HOUSEHOLD_INVENTORY_PATHS.options}?category=printer-paper&min_sheets=10`);

const used = await recordConsumableUse(inventory, { product_slug: HP, sheets: 10, ref: "zoe-paper-1" });
assert.equal(used.ok, true);
assert.deepEqual(calls[1].body, { product_slug: HP, sheets: 10, ref: "zoe-paper-1", source: TICKETS_REWARD_SOURCE });

const reversed = await reverseConsumableUse(inventory, "zoe-paper-1");
assert.equal(reversed.ok, true);
assert.deepEqual(calls[2].body, { ref: "zoe-paper-1", source: TICKETS_REWARD_SOURCE });

const down = await listConsumableOptions({ url: "http://127.0.0.1:1" }, SPEC);
assert.deepEqual(down, { ok: false, warning: STOCK_WARNINGS.silent });
const unlinked = await recordConsumableUse(null, { product_slug: HP, sheets: 10, ref: "zoe-paper-1" });
assert.deepEqual(unlinked, { ok: false, warning: STOCK_WARNINGS.unlinked });

server.close();
console.log("household inventory ok");
