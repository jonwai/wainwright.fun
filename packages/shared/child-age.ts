/**
 * Child age helpers for the budget engine.
 *
 * Lives in shared/ so both the Lambda (cdk/lambda/budget-routes.ts, as
 * ../../shared/child-age.js) and any SPA can use it. Must stay
 * dependency-free (established by shared/bank-holidays.ts).
 *
 * The snacks app has two presentation modes:
 *   - "pence" (default): the child sees a money balance and each snack's
 *     price — for children who can add and subtract.
 *   - "count": the child is simply told how many snacks they get today, and
 *     EVERY snack costs exactly one pick regardless of its pence price —
 *     for younger children (age SIMPLE_AGE_THRESHOLD and under) who can't
 *     do arithmetic yet. The pence engine underneath is untouched: the
 *     day's balance is divided by SNACKS_UNIT_PRICE_PENCE to get the
 *     snack count, and each pick spends its real price against the pence
 *     balance. A young child's allowance should therefore be a whole
 *     multiple of the unit price (e.g. 25p = 1 snack, 50p = 2 snacks).
 *
 * The mode is derived from the child's age, NOT stored: a child at or under
 * SIMPLE_AGE_THRESHOLD sees the count mode automatically and switches to
 * pence on their birthday.
 */

/** Children this age or younger get the simple "count" snacks UI. */
export const SIMPLE_AGE_THRESHOLD = 6;

/**
 * The value of ONE snack in the "count" mode, in pence (e.g. 25p = 1 snack).
 * A young child's snack count is their pence balance divided by this.
 */
export const SNACKS_UNIT_PRICE_PENCE = 25;

/**
 * The value of one coin in the "count" mode, in pence. Young children see and
 * spend their balance in 5p coins; item prices are rounded up to a whole
 * number of coins so balances always reconcile.
 */
export const COIN_UNIT_PENCE = 5;

/** Rounds a pence amount up to the nearest whole 5p coin. */
export function roundUpToNearest5(pence: number): number {
  return Math.ceil(pence / COIN_UNIT_PENCE) * COIN_UNIT_PENCE;
}

/** How many whole 5p coins a pence amount is worth. */
export function coinsFor(pence: number): number {
  return Math.floor(pence / COIN_UNIT_PENCE);
}

/** How the snacks app presents itself to a child. */
export type SnacksMode = "pence" | "count";

/**
 * The snacks mode for a child of the given age (whole years, Europe/London —
 * compute the age with scripts/birthday.ts calculateAge and pass it in).
 */
export function snacksModeForAge(age: number): SnacksMode {
  return age <= SIMPLE_AGE_THRESHOLD ? "count" : "pence";
}
