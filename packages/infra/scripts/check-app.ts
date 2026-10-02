import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { execSync } from "node:child_process";

const table = execSync('aws cloudformation describe-stacks --stack-name ApiStack --query "Stacks[0].Outputs[?ExportName==\'AdminAppsTable\'].OutputValue" --output text', { encoding: "utf8" }).trim();

async function main() {
  const client = new DynamoDBClient({ region: "us-east-1" });
  const res = await client.send(new ScanCommand({ TableName: table }));
  const apps = (res.Items ?? []).map(i => unmarshall(i));
  const app = apps.find(a => a.name === "1-Minute Maths");
  console.log(JSON.stringify(app, null, 2));
}
main();
