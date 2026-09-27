/**
 * Populates categories for system apps and websites that don't have one.
 *
 * System apps without an App Store URL (App Store, Settings, Web Clips) get
 * manually-assigned categories. Websites all get "Education" or "Entertainment"
 * based on their content.
 *
 * Usage:
 *   AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx scripts/populate-categories.ts
 */

import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const APPS_TABLE = "wainwright-apps";
const WEBSITES_TABLE = "wainwright-websites";

const client = new DynamoDBClient({ region: "us-east-1" });

// ── Manual category assignments ───────────────────────────────────

const SYSTEM_APP_CATEGORIES: Record<string, string> = {
  "com.apple.AppStore": "Utilities",
  "com.apple.Preferences": "Utilities",
  "com.apple.webapp": "Utilities",
};

const WEBSITE_CATEGORIES: Record<string, string> = {
  "https://www.bbc.co.uk/cbeebies": "Education",
  "https://pbskids.org": "Education",
  "https://www.starfall.com": "Education",
  "https://storylineonline.net": "Education",
  "https://wainsburys.co.uk": "Shopping",
  "https://www.busythings.co.uk": "Education",
  "https://musiclab.chromeexperiments.com": "Music",
  "https://www.ictgames.com": "Education",
  "https://www.lbq.org": "Education",
  "https://home.oxfordowl.co.uk": "Education",
  "https://www.bbc.co.uk/bitesize/primary": "Education",
  "https://www.bbc.co.uk/cbbc": "Entertainment",
  "https://www.coolmathgames.com": "Games",
  "https://www.khanacademy.org": "Education",
  "https://kids.nationalgeographic.com": "Education",
  "https://www.bbc.co.uk/newsround": "News",
  "https://www.scratch.mit.edu": "Education",
};

// ── DynamoDB helpers ──────────────────────────────────────────────

async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await client.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
    );
    items.push(...(response.Items ?? []).map((item) => unmarshall(item)));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  // ── System apps ────────────────────────────────────────────────
  console.log("Scanning system apps...");
  const apps = (await scanAll(APPS_TABLE)) as Array<{
    bundle_id: string;
    name: string;
    type: string;
    category?: string;
    [key: string]: unknown;
  }>;

  const systemAppsToUpdate = apps
    .filter((a) => a.type === "system")
    .filter((a) => !a.category)
    .filter((a) => a.bundle_id in SYSTEM_APP_CATEGORIES)
    .map((a) => ({ ...a, category: SYSTEM_APP_CATEGORIES[a.bundle_id] }));

  console.log(`  ${systemAppsToUpdate.length} system apps to update:`);
  for (const app of systemAppsToUpdate) {
    console.log(`    ${app.name} → ${app.category}`);
  }

  // ── Websites ───────────────────────────────────────────────────
  console.log("\nScanning websites...");
  const websites = (await scanAll(WEBSITES_TABLE)) as Array<{
    url: string;
    name: string;
    category?: string;
    [key: string]: unknown;
  }>;

  const websitesToUpdate = websites
    .filter((w) => !w.category)
    .filter((w) => w.url in WEBSITE_CATEGORIES)
    .map((w) => ({ ...w, category: WEBSITE_CATEGORIES[w.url] }));

  console.log(`  ${websitesToUpdate.length} websites to update:`);
  for (const site of websitesToUpdate) {
    console.log(`    ${site.name} → ${site.category}`);
  }

  const allUpdates = [
    ...systemAppsToUpdate.map((a) => ({ table: APPS_TABLE, item: a })),
    ...websitesToUpdate.map((w) => ({ table: WEBSITES_TABLE, item: w })),
  ];

  if (allUpdates.length === 0) {
    console.log("\nNothing to update.");
    return;
  }

  // Batch write (max 25 per request)
  for (let i = 0; i < allUpdates.length; i += 25) {
    const batch = allUpdates.slice(i, i + 25);
    const requestItems: Record<string, Array<{ PutRequest: { Item: Record<string, AttributeValue> } }>> = {};

    for (const { table, item } of batch) {
      if (!requestItems[table]) requestItems[table] = [];
      requestItems[table].push({
        PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) },
      });
    }

    await client.send(new BatchWriteItemCommand({ RequestItems: requestItems }));
    console.log(`  Wrote ${Math.min(i + 25, allUpdates.length)}/${allUpdates.length}`);
  }

  console.log("\n✓ Done!");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
