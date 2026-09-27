/**
 * One-off migration: convert the live snacks budget row from the old
 * daily_amount_pence/daily_items model to school_day_amount_pence /
 * non_school_day_amount_pence.
 *
 * - school_day_amount_pence starts as the old daily amount (behaviour
 *   unchanged on school days).
 * - non_school_day_amount_pence starts at 20p for every child.
 * - daily_items is dropped (no item cap any more).
 *
 * Idempotent: skips children that already have a school-day amount, and
 * deletes the legacy fields afterwards. Run with:
 *   AWS_PROFILE=email npx tsx scripts/migrate-snacks-budget.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const BUDGETS_TABLE = process.env.BUDGETS_TABLE ?? "wainwright-budgets";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const response = await ddb.send(
  new GetCommand({ TableName: BUDGETS_TABLE, Key: { budget_id: "snacks" } })
);

if (!response.Item) {
  console.log("No snacks budget row found — run seed-snacks-budget.ts instead.");
  process.exit(0);
}

const row = response.Item as {
  school_day_amount_pence?: Record<string, number>;
  non_school_day_amount_pence?: Record<string, number>;
  daily_amount_pence?: Record<string, number>;
  daily_items?: Record<string, number>;
};

if (!row.daily_amount_pence && !row.daily_items) {
  console.log("Row already migrated — nothing to do.");
  process.exit(0);
}

const school: Record<string, number> = { ...(row.school_day_amount_pence ?? {}) };
const nonSchool: Record<string, number> = { ...(row.non_school_day_amount_pence ?? {}) };
for (const [child, pence] of Object.entries(row.daily_amount_pence ?? {})) {
  if (school[child] === undefined) school[child] = pence;
  if (nonSchool[child] === undefined) nonSchool[child] = 20;
}

await ddb.send(
  new UpdateCommand({
    TableName: BUDGETS_TABLE,
    Key: { budget_id: "snacks" },
    UpdateExpression:
      "SET school_day_amount_pence = :school, non_school_day_amount_pence = :nonSchool, updated_at = :now REMOVE daily_amount_pence, daily_items",
    ExpressionAttributeValues: {
      ":school": school,
      ":nonSchool": nonSchool,
      ":now": new Date().toISOString(),
    },
  })
);

console.log("Migrated snacks budget:");
console.log("  school_day_amount_pence:", JSON.stringify(school));
console.log("  non_school_day_amount_pence:", JSON.stringify(nonSchool));
