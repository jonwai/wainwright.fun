/**
 * Backfill: resize every existing icon image in the site bucket to a
 * 224×224 square (scale-to-cover, then center-crop) — 2× the largest
 * render size (tickets cards 112px, main-site app icons up to 136px), matching
 * the client-side resize the admin SPA now applies on upload. Files are
 * rewritten IN PLACE (same key) so no DDB rows need updates, then a CloudFront
 * invalidation flushes the edge cache.
 *
 * Covers all four icon dirs: ticket-icons, app-icons, website-icons, system-icons
 * (or pass --dirs a,b to select). Skips: files already 224×224, gifs
 * (animation), SVGs (vector), and anything sharp can't decode. Dry-run by
 * default; pass --apply to write.
 *
 * Run:  AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx scripts/backfill-icon-images.ts --apply
 */
import { execSync } from "node:child_process";
import sharp from "sharp";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const APPLY = process.argv.includes("--apply");
const SIZE = 224;
const ALL_DIRS = ["ticket-icons", "app-icons", "website-icons", "system-icons"];
const dirsFlagIdx = process.argv.indexOf("--dirs");
const DIRS =
  dirsFlagIdx !== -1 && process.argv[dirsFlagIdx + 1]
    ? process.argv[dirsFlagIdx + 1].split(",")
    : ALL_DIRS;
const awsProfile = process.env.AWS_PROFILE || "email";
const awsRegion = process.env.AWS_REGION || "us-east-1";

const bucketName = execSync(
  `aws cloudformation describe-stacks --stack-name KidsAppsStack --query "Stacks[0].Outputs[?ExportName=='KidsAppsBucketName'].OutputValue" --output text --profile ${awsProfile} --region ${awsRegion}`,
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
).trim();

const distId = execSync(
  `aws cloudformation describe-stacks --stack-name KidsAppsStack --query "Stacks[0].Outputs[?ExportName=='KidsAppsDistributionId'].OutputValue" --output text --profile ${awsProfile} --region ${awsRegion}`,
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
).trim();

const s3 = new S3Client({ region: awsRegion });

let resized = 0;
let skipped = 0;
let failed = 0;
const touchedDirs = new Set<string>();

for (const dir of DIRS) {
  // Collect every key under this dir.
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${dir}/`,
        ContinuationToken: token,
      })
    );
    for (const obj of list.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  console.log(`\n=== ${dir}/ (${keys.length} objects) ===`);

  for (const key of keys) {
    const name = key.split("/").pop() ?? key;
    const get = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const input = Buffer.from(await get.Body!.transformToByteArray());

    // Vector / animated formats keep their bytes.
    if (key.endsWith(".svg") || key.endsWith(".gif")) {
      skipped += 1;
      console.log(`  skip (vector/animated): ${name}`);
      continue;
    }

    try {
      const meta = await sharp(input).metadata();
      if (meta.width === SIZE && meta.height === SIZE) {
        skipped += 1;
        console.log(`  skip (already ${SIZE}×${SIZE}): ${name}`);
        continue;
      }
      // Never UPSCALE: a 128×128 icon blown up to 224 is both worse
      // quality and a bigger file. Small icons keep their bytes.
      if ((meta.width ?? 0) < SIZE || (meta.height ?? 0) < SIZE) {
        skipped += 1;
        console.log(`  skip (smaller than ${SIZE}×${SIZE}, would upscale): ${name}`);
        continue;
      }
      // Re-encode in the ORIGINAL format so the key's extension stays truthful.
      const output = await sharp(input)
        .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
        .toBuffer();

      if (APPLY) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: output,
            ContentType: get.ContentType ?? "application/octet-stream",
            CacheControl: "public, max-age=3600",
          })
        );
        touchedDirs.add(dir);
      }
      resized += 1;
      console.log(
        `${APPLY ? "  resized" : "  would resize"}: ${name} ` +
          `(${meta.width}×${meta.height} → ${SIZE}×${SIZE}, ` +
          `${input.length} → ${output.length} bytes)`
      );
    } catch (err) {
      failed += 1;
      console.warn(`  FAILED: ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

console.log(
  `\n${resized} ${APPLY ? "resized" : "to resize"}, ${skipped} skipped, ${failed} failed.`
);

if (APPLY && resized > 0) {
  const paths = (touchedDirs.size > 0 ? [...touchedDirs] : DIRS).map((d) => `/${d}/*`);
  console.log(`Invalidating CloudFront paths: ${paths.join(" ")} ...`);
  execSync(
    `aws cloudfront create-invalidation --distribution-id ${distId} --paths ${paths
      .map((p) => JSON.stringify(p))
      .join(" ")} --profile ${awsProfile} --region ${awsRegion}`,
    { stdio: "inherit" }
  );
  console.log("Done — invalidation takes ~30s to propagate.");
} else if (!APPLY) {
  console.log("Dry run — pass --apply to write changes.");
}
