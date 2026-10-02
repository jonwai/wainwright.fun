/**
 * One-off: strip legacy inset_days/bank_holidays from the live 2026-2027 row.
 * The classifier now derives bank holidays from the built-in gov.uk list and
 * treats inset days as outside the term window, so the per-term fields are dead.
 * Run: AWS_PROFILE=email npx tsx scripts/cleanup-term-dates.ts
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const res = await ddb.send(
  new GetCommand({ TableName: "wainwright-term-dates", Key: { academic_year: "2026-2027" } })
);
const row = res.Item as
  | { academic_year: string; terms: Array<Record<string, unknown>>; updated_at: string }
  | undefined;
if (!row) {
  console.log("No 2026-2027 row — nothing to clean.");
} else {
  const cleaned = row.terms.map(({ inset_days: _i, bank_holidays: _b, ...term }) => term);
  await ddb.send(
    new PutCommand({
      TableName: "wainwright-term-dates",
      Item: { academic_year: row.academic_year, terms: cleaned, updated_at: new Date().toISOString() },
    })
  );
  console.log("Cleaned 2026-2027 row:", JSON.stringify(cleaned, null, 2));
}
