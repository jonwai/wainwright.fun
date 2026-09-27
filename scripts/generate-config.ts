/**
 * Generates apps.yaml from DynamoDB — the same logic as the API Lambda's
 * generateYaml(), but run locally with the `email` AWS profile.
 *
 * Usage:
 *   AWS_PROFILE=email npx tsx scripts/generate-config.ts
 *
 * Reads table names from CloudFormation exports (ApiStack).
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { execSync } from "node:child_process";
import { buildRootConfig, type DbChild, type DbApp, type DbWebsite, type DbTheme, type DbRestriction } from "./yaml-generator.js";

const ROOT = join(import.meta.dirname, "..");

function getOutput(stackName: string, exportName: string): string {
  return execSync(
    `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?ExportName=='${exportName}'].OutputValue" --output text`,
    { encoding: "utf8" }
  ).trim();
}

async function scanAll(client: DynamoDBClient, tableName: string): Promise<Record<string, unknown>[]> {
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
  const childrenTable = getOutput("ApiStack", "AdminChildrenTable");
  const appsTable = getOutput("ApiStack", "AdminAppsTable");
  const websitesTable = getOutput("ApiStack", "AdminWebsitesTable");
  const themesTable = getOutput("ApiStack", "AdminThemesTable");
  const restrictionsTable = getOutput("ApiStack", "AdminRestrictionsTable");

  console.log("Scanning DynamoDB tables...");
  const client = new DynamoDBClient({ region: "us-east-1" });

  const [children, apps, websites, themes, restrictions] = await Promise.all([
    scanAll(client, childrenTable),
    scanAll(client, appsTable),
    scanAll(client, websitesTable),
    scanAll(client, themesTable),
    scanAll(client, restrictionsTable),
  ]);

  console.log(`  ${children.length} children, ${apps.length} apps, ${websites.length} websites, ${themes.length} themes, ${restrictions.length} restrictions`);

  const config = buildRootConfig({
    children: children as unknown as DbChild[],
    apps: apps as unknown as DbApp[],
    websites: websites as unknown as DbWebsite[],
    themes: themes as unknown as DbTheme[],
    restrictions: restrictions as unknown as DbRestriction[],
  });

  const yamlContent = yaml.dump(config, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });

  const outputPath = join(ROOT, "apps.yaml");
  writeFileSync(outputPath, yamlContent);
  console.log(`\n✓ Generated ${outputPath}`);
}

main().catch((err) => {
  console.error("Failed to generate config:", err);
  process.exit(1);
});
