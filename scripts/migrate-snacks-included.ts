/**
 * One-off migration: flip the snacks budget row from the denylist model
 * (excluded_products — everything selectable unless removed) to the allowlist
 * model (included_products — nothing selectable unless ticked).
 *
 * To keep the children's picker EXACTLY as it looks today, the new allowlist
 * is seeded as: every Wainsbury's product minus the currently-excluded slugs.
 *
 * Idempotent: skips the row if included_products is already set, and removes
 * the legacy excluded_products attribute afterwards. Run with:
 *   AWS_PROFILE=email npx tsx scripts/migrate-snacks-included.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const BUDGETS_TABLE = process.env.BUDGETS_TABLE ?? "wainwright-budgets";
const TOKEN_SECRET = process.env.WAINSBURYS_TOKEN_SECRET ?? "wainsburys-integration-token";
const API_URL = (process.env.WAINSBURYS_API_URL ?? "https://api.wainsburys.co.uk").replace(/\/$/, "");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const response = await ddb.send(
  new GetCommand({ TableName: BUDGETS_TABLE, Key: { budget_id: "snacks" } })
);

if (!response.Item) {
  console.log("No snacks budget row found — run seed-snacks-budget.ts instead.");
  process.exit(0);
}

const row = response.Item as {
  included_products?: string[];
  excluded_products?: string[];
};

if (row.included_products) {
  console.log("Row already migrated — nothing to do.");
  process.exit(0);
}

if (!row.excluded_products) {
  console.log("Row has no excluded_products — nothing to convert.");
  process.exit(0);
}

// Fetch the full product list from Wainsbury's (same integration API the
// Lambda uses) so the allowlist covers every current product.
const secrets = new SecretsManagerClient({ region: "us-east-1" });
const secretValue = await secrets.send(
  new GetSecretValueCommand({ SecretId: TOKEN_SECRET })
);
const token = (JSON.parse(secretValue.SecretString ?? "{}") as { token?: string }).token;
if (!token) throw new Error("Wainsbury's integration token is not set");

const productsResponse = await fetch(`${API_URL}/integration/snack-products`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!productsResponse.ok) {
  throw new Error(`Wainsbury's returned ${productsResponse.status}`);
}
const products = ((await productsResponse.json()) as { products: Array<{ productSlug: string }> }).products ?? [];

const excluded = new Set(row.excluded_products);
const included = products.map((p) => p.productSlug).filter((slug) => !excluded.has(slug));

await ddb.send(
  new UpdateCommand({
    TableName: BUDGETS_TABLE,
    Key: { budget_id: "snacks" },
    UpdateExpression:
      "SET included_products = :included, updated_at = :now REMOVE excluded_products",
    ExpressionAttributeValues: {
      ":included": included,
      ":now": new Date().toISOString(),
    },
  })
);

console.log("Migrated snacks budget to the allowlist model.");
console.log(`  included_products: ${included.length} of ${products.length} products`);
console.log(`  (previously excluded: ${row.excluded_products.length})`);
