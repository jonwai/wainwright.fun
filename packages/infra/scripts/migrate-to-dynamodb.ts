/**
 * Migration script: reads apps.yaml and imports all data into DynamoDB.
 *
 * Usage:
 *   AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx packages/infra/scripts/migrate-to-dynamodb.ts
 *
 * Reads table names from CloudFormation exports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  DynamoDBClient,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { execSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");  // repo root

interface AppEntry {
  name: string;
  bundle_id: string;
  app_store_url: string;
  min_age?: number;
  emoji?: string;
  category?: string;
  icon_url?: string;
}

interface SystemApp {
  bundle_id: string;
  name: string;
  min_age?: number;
  show_on_site?: boolean;
  icon?: string;
  app_store_url?: string;
  icon_url?: string;
}

interface WebsiteEntry {
  name: string;
  url: string;
  min_age?: number;
  icon?: string;
  icon_url?: string;
}

interface AgeBand {
  from_age: number;
  theme: string;
  subtitle: string;
}

interface Child {
  name: string;
  subdomain: string;
  date_of_birth: string | Date;
  color: string;
}

interface RootConfig {
  domain: string;
  site: { profile_button_text: string };
  profile: { organization: string; removal_disallowed?: boolean };
  restrictions?: { key: string; value: boolean | number | string; type: string }[];
  children: Child[];
  apps: AppEntry[];
  system_apps: SystemApp[];
  websites: WebsiteEntry[];
  age_bands: AgeBand[];
}

function getOutput(stackName: string, exportName: string): string {
  return execSync(
    `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?ExportName=='${exportName}'].OutputValue" --output text`,
    { encoding: "utf8" }
  ).trim();
}

async function batchWrite(tableName: string, items: Record<string, unknown>[]): Promise<void> {
  const ddb = new DynamoDBClient({ region: "us-east-1" });

  // DynamoDB BatchWriteItem max 25 items per request
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const requestItems = batch.map((item) => ({
      PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) },
    }));

    await ddb.send(
      new BatchWriteItemCommand({ RequestItems: { [tableName]: requestItems } })
    );
    console.log(`  ${tableName}: wrote ${Math.min(i + 25, items.length)}/${items.length}`);
  }
}

async function main() {
  const raw = readFileSync(join(ROOT, "apps.yaml"), "utf8");
  const config = yaml.load(raw) as RootConfig;

  const childrenTable = getOutput("ApiStack", "AdminChildrenTable");
  const appsTable = getOutput("ApiStack", "AdminAppsTable");
  const websitesTable = getOutput("ApiStack", "AdminWebsitesTable");
  const themesTable = getOutput("ApiStack", "AdminThemesTable");
  const restrictionsTable = getOutput("ApiStack", "AdminRestrictionsTable");

  console.log(`Tables: ${childrenTable}, ${appsTable}, ${websitesTable}, ${themesTable}, ${restrictionsTable}`);

  // ── Children ───────────────────────────────────────────────────
  const children = config.children.map((c) => ({
    subdomain: c.subdomain,
    name: c.name,
    date_of_birth: c.date_of_birth instanceof Date ? c.date_of_birth.toISOString().split("T")[0] : c.date_of_birth,
    color: c.color,
  }));
  console.log(`\nMigrating ${children.length} children...`);
  await batchWrite(childrenTable, children);

  // ── Themes ─────────────────────────────────────────────────────
  const themes = config.age_bands.map((band) => ({
    from_age: band.from_age,
    theme: band.theme,
    subtitle: band.subtitle,
  }));
  console.log(`\nMigrating ${themes.length} themes...`);
  await batchWrite(themesTable, themes);

  // ── Apps (regular + system, combined) ─────────────────────────
  const apps: Record<string, unknown>[] = [];

  for (const app of config.apps) {
    apps.push({
      bundle_id: app.bundle_id,
      name: app.name,
      type: "app",
      app_store_url: app.app_store_url,
      category: app.category,
      min_age: app.min_age ?? 0,
      enabled: true,
    });
  }

  for (const app of config.system_apps) {
    apps.push({
      bundle_id: app.bundle_id,
      name: app.name,
      type: "system",
      app_store_url: app.app_store_url,
      icon: app.icon,
      show_on_site: app.show_on_site ?? false,
      min_age: app.min_age ?? 0,
      enabled: true,
    });
  }

  // Deduplicate by bundle_id (keep first occurrence)
  const seenBundleIds = new Set<string>();
  const uniqueApps = apps.filter((app) => {
    const id = app.bundle_id as string;
    if (seenBundleIds.has(id)) return false;
    seenBundleIds.add(id);
    return true;
  });

  console.log(`\nMigrating ${uniqueApps.length} apps (from ${apps.length} total, ${apps.length - uniqueApps.length} duplicates)...`);
  await batchWrite(appsTable, uniqueApps);

  // ── Websites ───────────────────────────────────────────────────
  const websites: Record<string, unknown>[] = [];

  for (const site of config.websites) {
    websites.push({
      url: site.url,
      name: site.name,
      icon: site.icon,
      min_age: site.min_age ?? 0,
      enabled: true,
    });
  }

  console.log(`\nMigrating ${websites.length} websites...`);
  await batchWrite(websitesTable, websites);

  // ── Restrictions ──────────────────────────────────────────────
  const restrictions = (config.restrictions ?? []).map((r) => ({
    key: r.key,
    value: r.value,
    type: r.type,
  }));
  console.log(`\nMigrating ${restrictions.length} restrictions...`);
  await batchWrite(restrictionsTable, restrictions);

  console.log("\n✓ Migration complete!");
  console.log(`  Children: ${children.length}`);
  console.log(`  Apps: ${uniqueApps.length}`);
  console.log(`  Websites: ${websites.length}`);
  console.log(`  Themes: ${themes.length}`);
  console.log(`  Restrictions: ${restrictions.length}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
