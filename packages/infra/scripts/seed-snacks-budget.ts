/**
 * Seed the snacks budget row with the agreed defaults:
 *   Ethan, Zoe:   20p on school days, 40p on non-school days
 *   Hannah, Lydia:  40p on school days, 80p on non-school days
 *
 * No item cap — children can pick as many snacks as their money allows.
 *
 * Idempotent: only creates the row if missing (never overwrites admin
 * edits). Run with:  AWS_PROFILE=email npx tsx scripts/seed-snacks-budget.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const BUDGETS_TABLE = process.env.BUDGETS_TABLE ?? "wainwright-budgets";

const budget = {
  budget_id: "snacks",
  name: "Snacks",
  school_day_amount_pence: {
    ethan: 20,
    zoe: 20,
    hannah: 40,
    lydia: 40,
  },
  non_school_day_amount_pence: {
    ethan: 20,
    zoe: 20,
    hannah: 20,
    lydia: 20,
  },
  included_products: [],
  updated_at: new Date().toISOString(),
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const existing = await ddb.send(
  new GetCommand({ TableName: BUDGETS_TABLE, Key: { budget_id: "snacks" } })
);

if (existing.Item) {
  console.log("Snacks budget already exists — leaving it alone.");
} else {
  await ddb.send(new PutCommand({ TableName: BUDGETS_TABLE, Item: budget }));
  console.log("Created snacks budget:", JSON.stringify(budget, null, 2));
}
