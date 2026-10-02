/**
 * Updates app categories in DynamoDB to match the App Store's primaryGenreName.
 *
 * Usage:
 *   AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx scripts/update-app-categories.ts
 *
 * Reads table names from CloudFormation exports (ApiStack).
 */

import { execSync } from "node:child_process";
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

function getOutput(stackName: string, exportName: string): string {
  return execSync(
    `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?ExportName=='${exportName}'].OutputValue" --output text`,
    { encoding: "utf8" }
  ).trim();
}

function extractAppStoreId(url: string): string | null {
  const match = url.match(/id(\d+)/);
  return match?.[1] ?? null;
}

interface App {
  bundle_id: string;
  name: string;
  type: "app" | "system";
  app_store_url?: string;
  category?: string;
  icon?: string;
  show_on_site?: boolean;
  min_age: number;
  enabled: boolean;
}

async function scanAll(client: DynamoDBClient, tableName: string): Promise<App[]> {
  const items: App[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await client.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
    );
    items.push(...(response.Items ?? []).map((item) => unmarshall(item) as App));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function lookupCategories(
  appStoreIds: string[]
): Promise<Map<string, string>> {
  const categoryById = new Map<string, string>();
  const batchSize = 20;

  for (let i = 0; i < appStoreIds.length; i += batchSize) {
    const batch = appStoreIds.slice(i, i + batchSize);
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=gb&entity=software`
    );

    if (!response.ok) {
      throw new Error(`iTunes lookup failed (${response.status})`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        trackId: number;
        primaryGenreName?: string;
      }>;
    };

    for (const result of data.results ?? []) {
      if (result.primaryGenreName) {
        categoryById.set(String(result.trackId), result.primaryGenreName);
      }
    }

    console.log(
      `  Looked up ${Math.min(i + batchSize, appStoreIds.length)}/${appStoreIds.length}`
    );
  }

  return categoryById;
}

async function main() {
  const appsTable = getOutput("ApiStack", "AdminAppsTable");
  console.log(`Apps table: ${appsTable}`);

  const client = new DynamoDBClient({ region: "us-east-1" });

  console.log("Scanning apps...");
  const apps = await scanAll(client, appsTable);
  console.log(`  Found ${apps.length} apps`);

  // Extract App Store IDs for apps that have an app_store_url
  const appsWithUrl = apps.filter((a) => a.app_store_url);
  const appStoreIds = [
    ...new Set(
      appsWithUrl
        .map((a) => extractAppStoreId(a.app_store_url!))
        .filter((id): id is string => id !== null)
    ),
  ];

  console.log(`  ${appStoreIds.length} unique App Store IDs to look up`);

  if (appStoreIds.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log("Looking up categories from iTunes...");
  const categoryById = await lookupCategories(appStoreIds);

  // Build list of apps that need updating
  const toUpdate: App[] = [];
  for (const app of apps) {
    if (!app.app_store_url) continue;
    const id = extractAppStoreId(app.app_store_url);
    if (!id) continue;
    const newCategory = categoryById.get(id);
    if (!newCategory) continue;
    if (app.category === newCategory) continue;
    toUpdate.push({ ...app, category: newCategory });
  }

  console.log(`\n${toUpdate.length} apps need category updates:`);
  for (const app of toUpdate) {
    console.log(`  ${app.name}: "${app.category ?? ""}" → "${app.category}"`);
  }

  if (toUpdate.length === 0) {
    console.log("All categories already match. Nothing to do.");
    return;
  }

  // Batch write updates (max 25 per request)
  for (let i = 0; i < toUpdate.length; i += 25) {
    const batch = toUpdate.slice(i, i + 25);
    const requestItems = batch.map((app) => ({
      PutRequest: { Item: marshall(app, { removeUndefinedValues: true }) },
    }));

    await client.send(
      new BatchWriteItemCommand({ RequestItems: { [appsTable]: requestItems } })
    );
    console.log(
      `  Updated ${Math.min(i + 25, toUpdate.length)}/${toUpdate.length}`
    );
  }

  console.log("\n✓ Done!");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
