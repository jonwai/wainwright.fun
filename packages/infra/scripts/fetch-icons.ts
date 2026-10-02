/**
 * Fetch icons from S3 into the kids app's public/ (app-icons, website-icons,
 * system-icons, ticket-icons). Run before `pnpm run dev` so icons are local.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");  // repo root
const PUBLIC = join(ROOT, "apps", "kids", "public");
const awsProfile = process.env.AWS_PROFILE || "email";
const awsRegion = process.env.AWS_REGION || "us-east-1";

// Get bucket name from CloudFormation
const bucketName = execSync(
  `aws cloudformation describe-stacks --stack-name KidsAppsStack --query "Stacks[0].Outputs[?ExportName=='KidsAppsBucketName'].OutputValue" --output text --profile ${awsProfile} --region ${awsRegion}`,
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
).trim();

console.log("Fetching icons from S3...");

for (const dir of ["app-icons", "website-icons", "system-icons", "ticket-icons"]) {
  mkdirSync(join(PUBLIC, dir), { recursive: true });
  execSync(
    `aws s3 sync s3://${bucketName}/${dir}/ apps/kids/public/${dir}/ --profile ${awsProfile} --region ${awsRegion} --exclude ".gitkeep" --no-progress`,
    { stdio: "inherit", cwd: ROOT }
  );
}

console.log("Done!");
