/**
 * Seed the 2026/2027 term dates row.
 *
 * Idempotent: only creates the row if missing (never overwrites admin
 * edits). Run with:  AWS_PROFILE=email npx tsx scripts/seed-term-dates.ts
 *
 * Only opens/closes/half-term are entered — bank holidays are built into
 * the classifier (England & Wales, from gov.uk) and inset days fall outside
 * the opens..closes window.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const TERM_DATES_TABLE = process.env.TERM_DATES_TABLE ?? "wainwright-term-dates";

const row = {
  academic_year: "2026-2027",
  terms: [
    {
      name: "Autumn",
      opens: "2026-08-24",
      closes: "2026-12-18",
      half_term_start: "2026-10-19",
      half_term_end: "2026-10-23",
    },
    {
      name: "Spring",
      opens: "2027-01-05",
      closes: "2027-03-19",
      half_term_start: "2027-02-15",
      half_term_end: "2027-02-19",
    },
    {
      name: "Summer",
      opens: "2027-04-05",
      closes: "2027-07-08",
      half_term_start: "2027-05-28",
      half_term_end: "2027-06-04",
    },
  ],
  updated_at: new Date().toISOString(),
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const existing = await ddb.send(
  new GetCommand({ TableName: TERM_DATES_TABLE, Key: { academic_year: "2026-2027" } })
);

if (existing.Item) {
  console.log("2026-2027 term dates already exist — leaving them alone.");
} else {
  await ddb.send(new PutCommand({ TableName: TERM_DATES_TABLE, Item: row }));
  console.log("Created 2026-2027 term dates:", JSON.stringify(row, null, 2));
}
