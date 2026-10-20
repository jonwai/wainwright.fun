/**
 * Household printer-paper client used when a parent confirms a paper reward.
 * Run: npx tsx tools/test-household-inventory.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOUSEHOLD_CONSUMABLE_PATHS,
  STOCK_WARNINGS,
  TICKETS_REWARD_SOURCE,
  consumablePath,
  consumableSpec,
  decideConsumableClaim,
  householdAuthHeaders,
  householdInventoryFromEnv,
  householdServiceToken,
  householdUseOf,
  listConsumableOptions,
  paperUseRef,
  parseConsumableOptions,
  recordConsumableUse,
  reverseConsumableUse,
} from "../packages/local/src/household-inventory.ts";

const HP = "hp-everyday-a4-75gsm-x500-sheets";
const SPEC = { category: "printer-paper", sheets: 10 };
const PAPERS = [
  { product_slug: "small-pack", name: "Small pack", sheets_remaining: 40 },
  { product_slug: HP, name: "HP Everyday Printer Paper A4 75gsm x500 Sheets", sheets_remaining: 1500 },
  { product_slug: "short", name: "Almost gone", sheets_remaining: 4 },
];

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
  {
    papers: [
      { product_slug: "small-pack", name: "Small pack", sheets_remaining: 12 },
      { product_slug: HP, name: "HP Everyday Printer Paper A4 75gsm x500 Sheets", sheets_remaining: 1500 },
      { product_slug: "short", name: "Almost gone", sheets_remaining: 9 },
      { product_slug: HP, name: "stale duplicate", sheets_remaining: 20 },
    ],
  },
  10,
);
assert.deepEqual(parsed?.map((option) => option.product_slug), [HP, "small-pack"]);
assert.deepEqual(parseConsumableOptions(PAPERS, 10)?.map((option) => option.product_slug), [HP, "small-pack"]);
assert.equal(parseConsumableOptions({ options: [{ product_slug: HP, name: "HP Everyday", sheets_remaining: 500 }] }, 10), null);
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

const sampleRedemptionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
assert.equal(sampleRedemptionId.includes("#"), false);
assert.equal(paperUseRef(`  ${sampleRedemptionId}  `), sampleRedemptionId);
assert.throws(() => paperUseRef("redeem#again"), /cannot contain/);
assert.throws(() => paperUseRef("   "), /cannot contain/);

assert.equal(consumablePath("printer-paper"), HOUSEHOLD_CONSUMABLE_PATHS["printer-paper"]);
assert.equal(consumablePath("card"), null);
assert.deepEqual(householdInventoryFromEnv({ HOUSEHOLD_URL: "http://household:43126/" }), {
  url: "http://household:43126",
});
assert.deepEqual(householdInventoryFromEnv({ HOUSEHOLD_URL: "http://household:43126", HOUSEHOLD_SERVICE_TOKEN: "secret" }), {
  url: "http://household:43126",
  token: "secret",
});
const tokenDir = mkdtempSync(join(tmpdir(), "household-token-"));
const tokenFile = join(tokenDir, "service-token");
writeFileSync(tokenFile, "  from-file \n");
assert.equal(householdServiceToken({ HOUSEHOLD_SERVICE_TOKEN_FILE: tokenFile }), "from-file");
assert.equal(
  householdServiceToken({ HOUSEHOLD_SERVICE_TOKEN: "inline", HOUSEHOLD_SERVICE_TOKEN_FILE: tokenFile }),
  "inline",
);
assert.deepEqual(householdInventoryFromEnv({ HOUSEHOLD_URL: "http://household:43126", HOUSEHOLD_SERVICE_TOKEN_FILE: tokenFile }), {
  url: "http://household:43126",
  token: "from-file",
});
assert.equal(householdServiceToken({ HOUSEHOLD_SERVICE_TOKEN_FILE: join(tokenDir, "missing") }), "");
assert.deepEqual(householdAuthHeaders({ url: "http://household", token: "secret" }), {
  accept: "application/json",
  Authorization: "Bearer secret",
});
assert.deepEqual(householdAuthHeaders({ url: "http://household" }), { accept: "application/json" });

type Reply =
  | { status: number; body: unknown }
  | { status: 200; papers: true };

let reply: Reply = { status: 200, papers: true };
const calls: { method: string; path: string; body: unknown; authorization: string | undefined }[] = [];
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
    });
    const status = "papers" in reply ? 200 : reply.status;
    const payload = "papers" in reply ? { papers: PAPERS } : reply.body;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
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

reply = { status: 400, body: { error: "min_sheets must be a positive integer" } };
const badSheets = await listConsumableOptions(inventory, SPEC);
assert.deepEqual(badSheets, { ok: false, warning: STOCK_WARNINGS.badSheets });

reply = { status: 401, body: { error: "unauthorised" } };
const refusedList = await listConsumableOptions(inventory, SPEC);
assert.deepEqual(refusedList, { ok: false, warning: STOCK_WARNINGS.unauthorised });

reply = { status: 200, body: { ok: true, already: false, ref: sampleRedemptionId, sheets_remaining: 1490 } };
const used = await recordConsumableUse(inventory, {
  category: "printer-paper",
  product_slug: HP,
  sheets: 10,
  ref: sampleRedemptionId,
});
assert.equal(used.ok, true);
assert.deepEqual(calls.at(-1)?.body, {
  product_slug: HP,
  sheets: 10,
  ref: sampleRedemptionId,
  source: TICKETS_REWARD_SOURCE,
});
assert.equal(calls.at(-1)?.authorization, "Bearer secret");

reply = { status: 200, body: { ok: true, already: true, ref: sampleRedemptionId } };
const again = await recordConsumableUse(inventory, {
  category: "printer-paper",
  product_slug: HP,
  sheets: 10,
  ref: sampleRedemptionId,
});
assert.equal(again.ok, true);

reply = { status: 400, body: { error: "That product is not printer paper" } };
const notPaper = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "tape", sheets: 10, ref: "other-1" });
assert.deepEqual(notPaper, {
  ok: false,
  rejected: true,
  warning: STOCK_WARNINGS.notRecorded,
  error: "That product is not printer paper",
});

reply = { status: 400, body: {} };
const noPack = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "loose", sheets: 10, ref: "other-2" });
assert.deepEqual(noPack, { ok: false, rejected: true, warning: STOCK_WARNINGS.notRecorded, error: STOCK_WARNINGS.notPaper });

reply = { status: 404, body: { message: "No such product" } };
const missing = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "gone", sheets: 10, ref: "other-3" });
assert.deepEqual(missing, { ok: false, rejected: true, warning: STOCK_WARNINGS.notRecorded, error: "No such product" });

reply = { status: 404, body: {} };
const unknown = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "gone", sheets: 10, ref: "other-4" });
assert.equal(unknown.ok, false);
if (!unknown.ok && unknown.rejected) assert.equal(unknown.error, STOCK_WARNINGS.unknownProduct);

reply = { status: 409, body: { error: "Only 4 sheets left" } };
const tooMany = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: HP, sheets: 10, ref: "other-5" });
assert.equal(tooMany.ok, false);
if (!tooMany.ok && tooMany.rejected) assert.equal(tooMany.error, "Only 4 sheets left");

reply = { status: 409, body: {} };
const clash = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: "other", sheets: 5, ref: sampleRedemptionId });
assert.equal(clash.ok, false);
if (!clash.ok && clash.rejected) assert.equal(clash.error, STOCK_WARNINGS.conflict);

reply = { status: 401, body: { error: "unauthorised" } };
const refusedUse = await recordConsumableUse(inventory, { category: "printer-paper", product_slug: HP, sheets: 10, ref: "other-6" });
assert.deepEqual(refusedUse, { ok: false, rejected: false, warning: STOCK_WARNINGS.unauthorised });

reply = { status: 200, body: { ok: true, ref: sampleRedemptionId, restored: true, already: false } };
const reversed = await reverseConsumableUse(inventory, { category: "printer-paper", ref: sampleRedemptionId });
assert.equal(reversed.ok, true);
assert.equal(calls.at(-1)?.method, "POST");
assert.equal(calls.at(-1)?.path, `${paper}/reverse`);
assert.deepEqual(calls.at(-1)?.body, { ref: sampleRedemptionId });
assert.equal(calls.at(-1)?.authorization, "Bearer secret");

reply = { status: 200, body: { ok: true, ref: sampleRedemptionId, restored: false, already: true } };
const reversedAgain = await reverseConsumableUse(inventory, { category: "printer-paper", ref: sampleRedemptionId });
assert.equal(reversedAgain.ok, true);

reply = { status: 401, body: { error: "unauthorised" } };
const refusedReverse = await reverseConsumableUse(inventory, { category: "printer-paper", ref: sampleRedemptionId });
assert.deepEqual(refusedReverse, { ok: false, rejected: false, warning: STOCK_WARNINGS.unauthorisedRestore });

const down = await listConsumableOptions({ url: "http://127.0.0.1:1" }, SPEC);
assert.deepEqual(down, { ok: false, warning: STOCK_WARNINGS.silent });
const unlinked = await recordConsumableUse(null, { category: "printer-paper", product_slug: HP, sheets: 10, ref: sampleRedemptionId });
assert.deepEqual(unlinked, { ok: false, rejected: false, warning: STOCK_WARNINGS.unlinked });

server.close();
console.log("household inventory ok");
