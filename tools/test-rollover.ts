/**
 * Tests for the rollover fold (foldRolloverBalance in cdk/lambda/budget-routes.ts)
 * and its date-walk arithmetic. Pure — no AWS access needed.
 *
 * Covers the forfeit rule: a completed day with no snacks picked forfeits
 * its allowance (carry-in and parent adjustments survive); the requested
 * date itself is exempt. Carry-over only happens out of a day where the
 * child picked a snack and had leftover pennies.
 *
 * Run: npx tsx scripts/test-rollover.ts
 */

import { foldRolloverBalance, type BudgetSelection } from "../packages/infra/lambda/budget-routes.js";

function sel(pricePence: number, selectedBy: "child" | "parent" = "child"): BudgetSelection {
  return {
    productSlug: `p${pricePence}`,
    name: `Product ${pricePence}`,
    image: null,
    pricePence,
    selectedAt: new Date().toISOString(),
    selectedBy,
  };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: got ${JSON.stringify(actual)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`
  );
}

async function main() {
  // 1. Five untouched school days at 40p: the first four forfeit their
  //    allowance (no snack picked); only the final (requested) day's
  //    allowance remains — it is exempt as "today".
  {
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-18",
      async () => 40,
      new Map(),
      new Map()
    );
    check("fold forfeits untouched days before the requested one", carry, 40);
  }

  // 2. Spend drains the carry, floors at zero, then builds back up.
  //    Mon 40-30=10; Tue 10+40-50=0; Wed (final day, no picks) 0+40=40.
  {
    const selections = new Map<string, BudgetSelection[]>([
      ["2026-09-14", [sel(30)]],
      ["2026-09-15", [sel(50)]],
      ["2026-09-16", []],
    ]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-16",
      async () => 40,
      selections,
      new Map()
    );
    check("fold drains and floors at zero", carry, 40);
  }

  // 3. Parent adjustments count: 40 + 20 - 60 = 0.
  {
    const selections = new Map<string, BudgetSelection[]>([["2026-09-14", [sel(60)]]]);
    const adjustments = new Map<string, number>([["2026-09-14", 20]]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-14",
      async () => 40,
      selections,
      adjustments
    );
    check("fold applies adjustments", carry, 0);
  }

  // 4. Single day (anchor == date): the requested day is exempt from the
  //    forfeit rule, so its allowance is available even with no picks.
  {
    const carry = await foldRolloverBalance(
      "2026-09-18",
      "2026-09-18",
      async () => 40,
      new Map(),
      new Map()
    );
    check("fold single day", carry, 40);
  }

  // 5. Anchor after the requested date: loop is a no-op (balanceFor's
  //    rolloverApplies guard also short-circuits before calling the fold).
  {
    const carry = await foldRolloverBalance(
      "2026-09-20",
      "2026-09-18",
      async () => 40,
      new Map(),
      new Map()
    );
    check("fold no-op when start after date", carry, 0);
  }

  // 6. Mixed week with school/non-school allowances and spend. Wednesday
  //    has no picks, so its 40p allowance is forfeited while the 5p carry
  //    from Tuesday survives:
  //    Mon 40-30=10; Tue 10+40-45=5; Wed forfeit (carry 5);
  //    Thu 5+40-15=30; Fri 30+40-10=60.
  {
    const selections = new Map<string, BudgetSelection[]>([
      ["2026-09-14", [sel(30)]],
      ["2026-09-15", [sel(45)]],
      ["2026-09-17", [sel(15)]],
      ["2026-09-18", [sel(10)]],
    ]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-18",
      async (day) => {
        const weekday = new Date(`${day}T12:00:00`).getDay();
        return weekday === 0 || weekday === 6 ? 20 : 40;
      },
      selections,
      new Map()
    );
    check("fold forfeits a no-pick mid-week day but keeps carry-in", carry, 60);
  }

  // 7. Date walk crosses a month boundary correctly: three forfeited days
  //    plus the exempt final day's 40p.
  {
    const carry = await foldRolloverBalance(
      "2026-09-29",
      "2026-10-02",
      async () => 40,
      new Map(),
      new Map()
    );
    check("fold crosses month boundary (final day only)", carry, 40);
  }

  // 8. Forfeit rule: a no-pick day mid-fold loses only its own allowance —
  //    carry built on earlier days survives.
  //    Mon 40-30=10; Tue no picks → forfeit 40, carry stays 10;
  //    Wed 10+40-5=45.
  {
    const selections = new Map<string, BudgetSelection[]>([
      ["2026-09-14", [sel(30)]],
      ["2026-09-16", [sel(5)]],
    ]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-16",
      async () => 40,
      selections,
      new Map()
    );
    check("no-pick day forfeits its allowance, carry-in survives", carry, 45);
  }

  // 9. A parent adjustment recorded on a no-pick day survives the forfeit
  //    (only the allowance is deducted).
  //    Mon no picks, +25 adjustment → carry 25 (40p allowance forfeited);
  //    Tue (final) 25+40=65.
  {
    const adjustments = new Map<string, number>([["2026-09-14", 25]]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-15",
      async () => 40,
      new Map(),
      adjustments
    );
    check("adjustment on a no-pick day survives the forfeit", carry, 65);
  }

  // 10. Admin "removes the deduction" by adding the snack purchased: a
  //     parent-added selection counts as a pick, so the day folds normally.
  //     Mon parent-added 30p snack → 40-30=10; Tue (final) 10+40=50.
  {
    const selections = new Map<string, BudgetSelection[]>([
      ["2026-09-14", [sel(30, "parent")]],
    ]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-15",
      async () => 40,
      selections,
      new Map()
    );
    check("parent-added selection counts as picked (deduction removed)", carry, 50);
  }

  // 11. Carry-over only when picked AND leftover: picking exactly the full
  //     allowance two days running leaves nothing to carry — the final day
  //     starts from zero.
  {
    const selections = new Map<string, BudgetSelection[]>([
      ["2026-09-14", [sel(40)]],
      ["2026-09-15", [sel(40)]],
    ]);
    const carry = await foldRolloverBalance(
      "2026-09-14",
      "2026-09-16",
      async () => 40,
      selections,
      new Map()
    );
    check("no leftover after full spend → nothing carries", carry, 40);
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll rollover tests passed");
}

void main();
