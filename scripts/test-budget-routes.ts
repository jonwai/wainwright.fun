/**
 * Local end-to-end smoke test for the budget routes — exercises the real
 * handler logic against an in-memory DDB mock (no AWS, no Wainsbury's).
 * Verifies route dispatch, kid auth, select/unselect refund, and the admin
 * add/remove selection routes. Run:
 *   npx tsx scripts/test-budget-routes.ts
 *
 * Wainsbury's product/consume calls are stubbed via WAINSBURYS_TOKEN +
 * a mocked global fetch (the module only calls fetch when a token exists).
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayEvent, APIResponse } from "../cdk/lambda/http.js";

// Env vars must be set BEFORE importing budget-routes (it reads them at
// module load, same as the real Lambda).
process.env.BUDGETS_TABLE = "BUDGETS";
process.env.BUDGET_SELECTIONS_TABLE = "SELECTIONS";
process.env.BUDGET_TRANSACTIONS_TABLE = "TRANSACTIONS";
process.env.PAIRING_TABLE = "PAIRING";
process.env.DEVICES_TABLE = "DEVICES";
process.env.TERM_DATES_TABLE = "TERM_DATES";
process.env.CHILDREN_TABLE = "CHILDREN";
process.env.WAINSBURYS_TOKEN = "test-token";

const { tryHandleBudgetRoute } = await import("../cdk/lambda/budget-routes.js");

// ── Wainsbury's stub ──────────────────────────────────────────
const products: Array<{
  productSlug: string;
  name: string;
  image: string | null;
  pricePence: number;
  portionsLeft: number;
  portionLabel: string | null;
  useByDate?: string | null;
  halfPrice?: boolean;
}> = [
  { productSlug: "apple", name: "Apple", image: null, pricePence: 20, portionsLeft: 5, portionLabel: null },
  { productSlug: "crisps", name: "Crisps", image: null, pricePence: 40, portionsLeft: 3, portionLabel: null },
];
const portionsLeft: Record<string, number> = { apple: 5, crisps: 3 };
let consumeCount = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (href.endsWith("/integration/snack-products")) {
    return new Response(JSON.stringify({ products }), { status: 200 });
  }
  if (href.endsWith("/integration/consume")) {
    const slug = String(body.productSlug);
    portionsLeft[slug] -= 1;
    consumeCount += 1;
    return new Response(
      JSON.stringify({ portionsLeft: portionsLeft[slug], inventoryItemId: `inv-${slug}-${consumeCount}` }),
      { status: 200 }
    );
  }
  if (href.endsWith("/integration/unconsume")) {
    const slug = String(body.productSlug);
    portionsLeft[slug] += 1;
    return new Response(
      JSON.stringify({ portionsLeft: portionsLeft[slug], inventoryItemId: String(body.inventoryItemId ?? "fallback") }),
      { status: 200 }
    );
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// ── Minimal in-memory DDB mock ────────────────────────────────
type Row = Record<string, unknown>;

function makeMockDdb(tables: Record<string, Map<string, Row>>): DynamoDBDocumentClient {
  async function send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input as {
      TableName: string;
      Key?: Row;
      Item?: Row;
      ExpressionAttributeValues?: Row;
      ExpressionAttributeNames?: Record<string, string>;
      FilterExpression?: string;
      KeyConditionExpression?: string;
      ScanIndexForward?: boolean;
      Limit?: number;
      ExclusiveStartKey?: Row;
    };
    if (!tables[input.TableName]) tables[input.TableName] = new Map();
    const table = tables[input.TableName];

    if (name === "GetCommand") {
      return { Item: table.get(JSON.stringify(input.Key)) };
    }
    if (name === "PutCommand") {
      const item = (input.Item ?? {}) as Row;
      // Canonical key from the row's PK fields (matches the GetCommand
      // keys the real code uses): selections → child_subdomain+budget_day,
      // budgets → budget_id, transactions → child_subdomain+transaction_id,
      // pairing → code.
      const key: Row =
        typeof item.budget_day === "string"
          ? { child_subdomain: item.child_subdomain, budget_day: item.budget_day }
          : typeof item.transaction_id === "string"
            ? { child_subdomain: item.child_subdomain, transaction_id: item.transaction_id }
            : typeof item.budget_id === "string"
              ? { budget_id: item.budget_id }
              : typeof item.code === "string"
                ? { code: item.code }
                : (input.Key ?? item);
      table.set(JSON.stringify(key), item);
      return {};
    }
    if (name === "DeleteCommand") {
      table.delete(JSON.stringify(input.Key));
      return {};
    }
    if (name === "QueryCommand") {
      const values = input.ExpressionAttributeValues ?? {};
      const pk = String(values[":child"] ?? "");
      const prefix = String(values[":prefix"] ?? "");
      const rows = [...table.values()].filter((item) => {
        if (item.child_subdomain !== pk) return false;
        if (prefix) return String(item.budget_day ?? "").startsWith(prefix);
        return true;
      });
      // Filtered queries (transactions by budget/kind/date).
      const filter = input.FilterExpression ?? "";
      const filtered = filter
        ? rows.filter((item) => {
          // Only the shapes budget-routes uses: budget_id (+ kind, + date).
          if (filter.includes("budget_id") && item.budget_id !== values[":budgetId"]) return false;
          if (filter.includes("#kind") && item.kind !== values[":kind"]) return false;
          if (filter.includes("#date") && item.date !== values[":date"]) return false;
          return true;
        })
        : rows;
      const sortKey = (item: Row) => String(item.transaction_id ?? item.budget_day ?? "");
      filtered.sort((a, b) =>
        input.ScanIndexForward === false
          ? sortKey(b).localeCompare(sortKey(a))
          : sortKey(a).localeCompare(sortKey(b))
      );
      return { Items: input.Limit ? filtered.slice(0, input.Limit) : filtered };
    }
    if (name === "ScanCommand") {
      const filter = input.FilterExpression ?? "";
      const values = input.ExpressionAttributeValues ?? {};
      const rows = [...table.values()].filter((item) =>
        !filter || item.budget_id === values[":budgetId"]
      );
      return { Items: rows };
    }
    throw new Error(`Mock DDB does not implement ${name}`);
  }
  return { send } as unknown as DynamoDBDocumentClient;
}

// ── Event builder ──────────────────────────────────────────────
let bearerToken: string | null = null;

function event(method: string, path: string, body?: unknown): APIGatewayEvent {
  return {
    rawPath: path,
    requestContext: { http: { method, path } },
    headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

function must(response: APIResponse | null, label: string): APIResponse {
  if (!response) {
    console.error(`✗ ${label}: route returned null (not handled)`);
    process.exit(1);
  }
  return response;
}

function bodyOf(response: APIResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

// ── Run ──────────────────────────────────────────────────────────
const tables: Record<string, Map<string, Row>> = {
  BUDGETS: new Map(),
  SELECTIONS: new Map(),
  TRANSACTIONS: new Map(),
  PAIRING: new Map(),
  TERM_DATES: new Map(),
  CHILDREN: new Map(),
};
const ddb = makeMockDdb(tables);

// Seed the snacks budget (40p school days for hannah) and a preview-token
// pairing row (getPreviewChild reads the pairing table).
tables.BUDGETS.set(JSON.stringify({ budget_id: "snacks" }), {
  budget_id: "snacks",
  name: "Snacks",
  school_day_amount_pence: { hannah: 40 },
  non_school_day_amount_pence: { hannah: 20 },
  included_products: ["apple", "crisps"],
  rollover_start_date: null,
  updated_at: new Date().toISOString(),
});
const previewToken = "prv_test123456";
tables.PAIRING.set(JSON.stringify({ code: previewToken }), {
  code: previewToken,
  kind: "preview",
  child_subdomain: "hannah",
  ttl: 9999999999,
});
bearerToken = previewToken;

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 1. Kid state: full 40p balance, nothing picked.
const state0 = must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "kid GET budget state"
);
assert(state0.statusCode === 200, "kid GET state returns 200");
const state0Body = bodyOf(state0);
assert(state0Body.remaining_pence === 40, "initial balance is 40p");
assert(state0Body.spent_pence === 0, "initial spent is 0");

// 2. Kid selects an apple (20p) — balance drops to 20p.
const select = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "apple", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "kid POST select"
);
assert(select.statusCode === 200, "kid select returns 200");
assert(bodyOf(select).remaining_pence === 20, "balance after apple is 20p");

// 3. Kid selects crisps (40p) — over budget, rejected.
const selectTooMuch = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "crisps", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "kid POST select over budget"
);
assert(selectTooMuch.statusCode === 400, "select over budget returns 400");

// 4. Admin removes the apple selection — money returns to the balance
// as if the pick never happened.
const state1 = must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "kid GET state after select"
);
const state1Body = bodyOf(state1);
const appleSelection = (state1Body.selections as Array<Record<string, unknown>>)[0];
assert(appleSelection?.productSlug === "apple", "apple selection present");

const remove = must(
  await tryHandleBudgetRoute(
    event("POST", "/budgets/snacks/children/hannah/remove", {
      productSlug: "apple",
      selectedAt: appleSelection.selectedAt,
      date: today,
    }) as never,
    "POST", "budgets", "snacks/children/hannah/remove", ddb
  ),
  "admin POST remove selection"
);
assert(remove.statusCode === 200, "admin remove returns 200");
assert(bodyOf(remove).remaining_pence === 40, "remove refunds the full 40p");

// 5. Balance is fully restored — as if the selection never happened.
const state2 = must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "kid GET state after remove"
);
const state2Body = bodyOf(state2);
assert(state2Body.remaining_pence === 40, "balance restored to 40p");
assert(state2Body.spent_pence === 0, "spent back to 0");
assert((state2Body.selections as unknown[]).length === 0, "selections list empty");

// 6. Removing a non-existent selection 404s.
const removeMissing = must(
  await tryHandleBudgetRoute(
    event("POST", "/budgets/snacks/children/hannah/remove", {
      productSlug: "apple",
      selectedAt: "1970-01-01T00:00:00.000Z",
      date: today,
    }) as never,
    "POST", "budgets", "snacks/children/hannah/remove", ddb
  ),
  "admin POST remove missing selection"
);
assert(removeMissing.statusCode === 404, "removing a missing selection returns 404");

// 7. Missing params 400.
const removeBad = must(
  await tryHandleBudgetRoute(
    event("POST", "/budgets/snacks/children/hannah/remove", { date: today }) as never,
    "POST", "budgets", "snacks/children/hannah/remove", ddb
  ),
  "admin POST remove without params"
);
assert(removeBad.statusCode === 400, "remove without productSlug/selectedAt returns 400");

// 8. The refund is in the transaction log.
const txRows = [...tables.TRANSACTIONS.values()].filter(
  (t) => t.kind === "refund"
);
assert(txRows.length === 1, "one refund transaction recorded");
assert(txRows[0].amount_pence === 20, "refund amount is +20p");
assert(txRows[0].by === "parent", "refund recorded by parent");

// 8b. The Wainsbury's portion was restored: the select consumed one
// (portions 5→4) and the admin remove put it back (4→5).
assert(portionsLeft.apple === 5, "admin remove restored the Wainsbury's portion");

// 9. Kid unselect still works (kid-side refund path).
const select2 = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "apple", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "kid POST select again"
);
assert(select2.statusCode === 200, "second select returns 200");
const state3 = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "kid GET state after second select"
));
const sel = (state3.selections as Array<Record<string, unknown>>)[0];
const unselect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/unselect", {
      productSlug: "apple",
      selectedAt: sel.selectedAt,
      date: today,
    }) as never,
    "POST", "kid", "budget/snacks/unselect", ddb
  ),
  "kid POST unselect"
);
assert(unselect.statusCode === 200, "kid unselect returns 200");
assert(bodyOf(unselect).remaining_pence === 40, "kid unselect refunds 40p");

// 10. The kid unselect also restored its Wainsbury's portion (4→5 again).
assert(portionsLeft.apple === 5, "kid unselect restored the Wainsbury's portion");

// 11. Parent-added selections never consumed a portion — removing one must
// NOT call unconsume (would add phantom inventory).
const parentAdd = must(
  await tryHandleBudgetRoute(
    event("POST", "/budgets/snacks/children/hannah/add", {
      productSlug: "apple",
      date: today,
    }) as never,
    "POST", "budgets", "snacks/children/hannah/add", ddb
  ),
  "admin POST add parent selection"
);
assert(parentAdd.statusCode === 200, "admin add returns 200");
const beforeUnconsume = portionsLeft.apple;
const state4 = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "kid GET state after parent add"
));
const parentSel = (state4.selections as Array<Record<string, unknown>>).find(
  (s) => s.selectedBy === "parent"
);
assert(Boolean(parentSel), "parent selection present");
const removeParent = must(
  await tryHandleBudgetRoute(
    event("POST", "/budgets/snacks/children/hannah/remove", {
      productSlug: "apple",
      selectedAt: parentSel!.selectedAt,
      date: today,
    }) as never,
    "POST", "budgets", "snacks/children/hannah/remove", ddb
  ),
  "admin POST remove parent selection"
);
assert(removeParent.statusCode === 200, "removing parent selection returns 200");
assert(portionsLeft.apple === beforeUnconsume, "removing a parent selection does not unconsume");

// ── Count mode (young children) ─────────────────────────────
// Hannah has no child row → age unknown → pence mode (backwards compat).
assert(state0Body.mode === "pence", "no child row defaults to pence mode");
assert(state0Body.snacks_remaining === null, "pence mode has snacks_remaining null");

// Seed a young child (age 5 → count mode) and an older one (age 8 → pence).
// Zoe's budget is 50p → 2 snacks of 25p; Lydia's is 40p → pence as before.
tables.CHILDREN.set(JSON.stringify({ subdomain: "zoe" }), {
  subdomain: "zoe",
  date_of_birth: "2021-06-15",
});
tables.CHILDREN.set(JSON.stringify({ subdomain: "lydia" }), {
  subdomain: "lydia",
  date_of_birth: "2018-06-15",
});
tables.PAIRING.set(JSON.stringify({ code: "prv_zoe123456" }), {
  code: "prv_zoe123456",
  kind: "preview",
  child_subdomain: "zoe",
  ttl: 9999999999,
});
tables.PAIRING.set(JSON.stringify({ code: "prv_lydia12345" }), {
  code: "prv_lydia12345",
  kind: "preview",
  child_subdomain: "lydia",
  ttl: 9999999999,
});
tables.BUDGETS.set(JSON.stringify({ budget_id: "snacks" }), {
  budget_id: "snacks",
  name: "Snacks",
  school_day_amount_pence: { hannah: 40, zoe: 50, lydia: 40 },
  non_school_day_amount_pence: { hannah: 20, zoe: 50, lydia: 40 },
  included_products: ["apple", "crisps", "banana"],
  rollover_start_date: null,
  updated_at: new Date().toISOString(),
});
products.push(
  { productSlug: "banana", name: "Banana", image: null, pricePence: 25, portionsLeft: 4, portionLabel: null }
);
portionsLeft.banana = 4;

// 12. Young child (zoe, 5): count mode, 50p → 10 coins.
bearerToken = "prv_zoe123456";
const zoeState = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "zoe GET state"
));
assert(zoeState.mode === "count", "young child gets count mode");
assert(zoeState.coins_remaining === 10, "50p balance is 10 coins");
assert(zoeState.snacks_remaining === null, "count mode has snacks_remaining null");

// 13. Count-mode products: all included snacks are shown (each priced in
// whole coins, rounded up to the nearest 5p).
const zoeProducts = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks/products") as never, "GET", "kid", "budget/snacks/products", ddb),
  "zoe GET products"
));
const zoeSlugs = (zoeProducts.products as Array<Record<string, unknown>>).map((p) => p.productSlug);
assert(
  zoeSlugs.length === 3,
  "count mode shows all included snacks"
);

// 14. Count-mode select: the pick costs the real price rounded UP to a
// whole number of coins. Apple is 20p on the shelf → 20p (4 coins).
const zoeSelect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "apple", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "zoe POST select apple"
);
assert(zoeSelect.statusCode === 200, "count-mode select returns 200");
const zoeState2 = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "zoe GET state after select"
));
assert(zoeState2.coins_remaining === 6, "20p spent, 30p = 6 coins left");
assert(zoeState2.remaining_pence === 30, "coin-rounded price (20p) spent, not the shelf price");
const zoeAppleSel = (zoeState2.selections as Array<Record<string, unknown>>)[0];
assert(zoeAppleSel.pricePence === 20, "stored selection carries the coin-rounded price");

// 15. Count-mode select: crisps (40p) no longer fits (30p left) and is
// rejected with the coin message; banana (25p) spends all but 5p.
const zoeSelectTooMuch = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "crisps", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "zoe POST select crisps when too few coins"
);
assert(zoeSelectTooMuch.statusCode === 400, "too-expensive pick rejected in count mode");
assert(
  String(bodyOf(zoeSelectTooMuch).error).includes("coins"),
  "count-mode rejection mentions coins"
);
const zoeSelect2 = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "banana", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "zoe POST select last coins"
);
assert(zoeSelect2.statusCode === 200, "last-coins select returns 200");
const zoeState3 = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "zoe GET state after second select"
));
assert(zoeState3.coins_remaining === 1, "25p spent, 5p = 1 coin left");
const zoeSelectNone = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "apple", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "zoe POST select when out of coins"
);
assert(zoeSelectNone.statusCode === 400, "out-of-coins pick rejected in count mode");

// 16. Older child (lydia, 8): still pence mode, all included products shown.
bearerToken = "prv_lydia12345";
const lydiaState = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "lydia GET state"
));
assert(lydiaState.mode === "pence", "older child keeps pence mode");
assert(lydiaState.coins_remaining === null, "pence mode coins_remaining is null");
const lydiaProducts = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks/products") as never, "GET", "kid", "budget/snacks/products", ddb),
  "lydia GET products"
));
assert(
  (lydiaProducts.products as unknown[]).length === 3,
  "pence mode shows all included snacks"
);

// ── Half price (use-by) ───────────────────────────────
// A product on or past its use-by date is charged at half price. The stub
// gains a use-by yoghurt (30p, use-by yesterday → halfPrice true).
products.push(
  { productSlug: "yoghurt", name: "Yoghurt", image: null, pricePence: 30, portionsLeft: 2, portionLabel: null,
    useByDate: yesterday, halfPrice: true }
);
portionsLeft.yoghurt = 2;
tables.BUDGETS.set(JSON.stringify({ budget_id: "snacks" }), {
  budget_id: "snacks",
  name: "Snacks",
  school_day_amount_pence: { hannah: 40, zoe: 50, lydia: 40 },
  non_school_day_amount_pence: { hannah: 20, zoe: 50, lydia: 40 },
  included_products: ["apple", "crisps", "banana", "yoghurt"],
  rollover_start_date: null,
  updated_at: new Date().toISOString(),
});

// 17. Kid products route passes the use-by fields through.
bearerToken = previewToken;
const hpProducts = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks/products") as never, "GET", "kid", "budget/snacks/products", ddb),
  "hannah GET products with use-by"
));
const hpYoghurt = (hpProducts.products as Array<Record<string, unknown>>).find(
  (p) => p.productSlug === "yoghurt"
);
assert(hpYoghurt?.halfPrice === true, "use-by product flagged halfPrice");
assert(hpYoghurt?.useByDate === yesterday, "use-by date passed through");
const hpApple = (hpProducts.products as Array<Record<string, unknown>>).find(
  (p) => p.productSlug === "apple"
);
assert(hpApple?.halfPrice === false, "fresh product not flagged halfPrice");

// 18. Selecting the use-by yoghurt charges half price (15p), not 30p.
const hpSelect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "yoghurt", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "hannah POST select use-by yoghurt"
);
assert(hpSelect.statusCode === 200, "half-price select returns 200");
const hpState = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "hannah GET state after half-price select"
));
assert(hpState.remaining_pence === 25, "half price (15p) charged, not 30p");
const hpSel = (hpState.selections as Array<Record<string, unknown>>).find(
  (s) => s.productSlug === "yoghurt"
);
assert(hpSel?.pricePence === 15, "stored selection carries the half price");

// 19. Unselect refunds exactly the half price that was charged.
const hpUnselect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/unselect", {
      productSlug: "yoghurt",
      selectedAt: hpSel!.selectedAt,
      date: today,
    }) as never,
    "POST", "kid", "budget/snacks/unselect", ddb
  ),
  "hannah POST unselect use-by yoghurt"
);
assert(hpUnselect.statusCode === 200, "half-price unselect returns 200");
assert(bodyOf(hpUnselect).remaining_pence === 40, "half price refunded, balance back to 40p");

// 20. Count mode with a use-by item: the half price (15p) is rounded up to
// 20p (4 coins) — half price still applies under coin pricing. Free a pick
// first by unselecting her banana from step 15.
bearerToken = "prv_zoe123456";
const zoeStateBefore = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "zoe GET state before use-by select"
));
const zoeBanana = (zoeStateBefore.selections as Array<Record<string, unknown>>).find(
  (s) => s.productSlug === "banana"
);
const zoeUnselect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/unselect", {
      productSlug: "banana",
      selectedAt: zoeBanana!.selectedAt,
      date: today,
    }) as never,
    "POST", "kid", "budget/snacks/unselect", ddb
  ),
  "zoe POST unselect banana"
);
assert(zoeUnselect.statusCode === 200, "zoe unselect banana returns 200");
const zoeHpSelect = must(
  await tryHandleBudgetRoute(
    event("POST", "/kid/budget/snacks/select", { productSlug: "yoghurt", date: today }) as never,
    "POST", "kid", "budget/snacks/select", ddb
  ),
  "zoe POST select use-by yoghurt (count mode)"
);
assert(zoeHpSelect.statusCode === 200, "count-mode use-by select returns 200");
const zoeHpState = bodyOf(must(
  await tryHandleBudgetRoute(event("GET", "/kid/budget/snacks") as never, "GET", "kid", "budget/snacks", ddb),
  "zoe GET state after use-by select"
));
assert(zoeHpState.remaining_pence === 15, "half price (15p, already a whole coin multiple) spent, 15p left");
assert(zoeHpState.coins_remaining === 3, "15p left is 3 coins");
const zoeHpSel = (zoeHpState.selections as Array<Record<string, unknown>>).find(
  (s) => s.productSlug === "yoghurt"
);
assert(zoeHpSel?.pricePence === 15, "count mode stores the half price when already coin-rounded");

globalThis.fetch = realFetch;
console.log(process.exitCode ? "Budget route tests FAILED" : "Budget route tests passed");
