/**
 * Fetch icons from S3 to public/app-icons, public/website-icons, public/system-icons.
 * Run before npm run dev to ensure icons are available locally.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const awsProfile = process.env.AWS_PROFILE || "email";
const awsRegion = process.env.AWS_REGION || "us-east-1";

// Get bucket name from CloudFormation
const bucketName = execSync(
  `aws cloudformation describe-stacks --stack-name KidsAppsStack --query "Stacks[0].Outputs[?ExportName=='KidsAppsBucketName'].OutputValue" --output text --profile ${awsProfile} --region ${awsRegion}`,
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
).trim();

console.log("Fetching icons from S3...");

for (const dir of ["app-icons", "website-icons", "system-icons", "ticket-icons"]) {
  mkdirSync(join(ROOT, "public", dir), { recursive: true });
  execSync(
    `aws s3 sync s3://${bucketName}/${dir}/ public/${dir}/ --profile ${awsProfile} --region ${awsRegion} --exclude ".gitkeep" --no-progress`,
    { stdio: "inherit", cwd: ROOT }
  );
}

console.log("Done!");
