/**
 * Icon-fetcher Lambda — triggered by SQS.
 *
 * Two modes:
 * 1. fetch-all-icons — reads all apps/websites from DynamoDB, downloads all missing icons
 * 2. fetch-icon — fetches a single app's icon (by bundleId + appStoreUrl)
 *    If bundleId looks like a URL (website), fetches the favicon instead.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { extractAppStoreId, websiteIconFilename } from "../../shared/scripts/icons.js";
import { downloadIconBytes, extractFaviconFromHtml, googleFaviconUrl, lookupAppStoreArtwork } from "../../shared/scripts/icon-fetch.js";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.CONFIG_BUCKET_NAME!;
const APPS_TABLE = process.env.APPS_TABLE!;
const WEBSITES_TABLE = process.env.WEBSITES_TABLE!;

async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function downloadAndUploadIcon(
  remoteUrl: string,
  s3Key: string,
  contentType: string
): Promise<boolean> {
  if (await s3ObjectExists(s3Key)) {
    console.log(`  ✓ ${s3Key} (already exists)`);
    return true;
  }
  const downloaded = await downloadIconBytes(remoteUrl);
  if (!downloaded.ok) {
    if (downloaded.error) console.warn(`  ! Error downloading ${remoteUrl}:`, downloaded.error);
    else console.warn(`  ! Failed to download ${remoteUrl} (${downloaded.status})`);
    return false;
  }
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: downloaded.bytes,
        ContentType: contentType,
        CacheControl: "public, max-age=86400",
      })
    );
    console.log(`  ✓ ${s3Key} (downloaded)`);
    return true;
  } catch (err) {
    console.warn(`  ! Error downloading ${remoteUrl}:`, err);
    return false;
  }
}

/**
 * Fetch a website icon: try parsing the site's HTML for a favicon link
 * (apple-touch-icon, link rel=icon) first, then fall back to Google's
 * favicon service. SVGs are stored as-is; raster icons as PNG.
 */
async function fetchWebsiteIcon(siteUrl: string, s3Key: string): Promise<boolean> {
  if (await s3ObjectExists(s3Key)) {
    console.log(`  ✓ ${s3Key} (already exists)`);
    return true;
  }

  // 1. Try parsing the website's HTML for a favicon link
  const faviconUrl = await extractFaviconFromHtml(siteUrl);
  if (faviconUrl) {
    const isSvg = faviconUrl.endsWith(".svg");
    const contentType = isSvg ? "image/svg+xml" : "image/png";
    const ok = await downloadAndUploadIcon(faviconUrl, s3Key, contentType);
    if (ok) return true;
    console.log(`  · HTML favicon failed, falling back to Google service`);
  } else {
    console.log(`  · No favicon link found in ${siteUrl}, falling back to Google service`);
  }

  // 2. Fall back to Google's favicon service
  return downloadAndUploadIcon(googleFaviconUrl(siteUrl), s3Key, "image/png");
}

// ── DynamoDB scan ──────────────────────────────────────────────────

async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ── Fetch all icons ────────────────────────────────────────────────

async function fetchAllIcons(): Promise<void> {
  const [apps, websites] = await Promise.all([
    scanAll(APPS_TABLE),
    scanAll(WEBSITES_TABLE),
  ]);

  console.log(`Apps: ${apps.length}, Websites: ${websites.length}`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // App icons (from iTunes API) — includes disabled apps
  const appsWithStoreUrl = apps.filter(
    (a) => a.app_store_url && !a.icon
  );
  const appStoreIds = [
    ...new Set(
      appsWithStoreUrl
        .map((a) => extractAppStoreId(a.app_store_url as string))
        .filter((id): id is string => id !== null)
    ),
  ];

  console.log(`Looking up ${appStoreIds.length} App Store IDs...`);
  const artworkById = appStoreIds.length > 0 ? await lookupAppStoreArtwork(appStoreIds) : new Map<string, string>();

  for (const app of appsWithStoreUrl) {
    const appStoreId = extractAppStoreId(app.app_store_url as string);
    if (!appStoreId) {
      skipped++;
      continue;
    }
    const remoteUrl = artworkById.get(appStoreId);
    if (!remoteUrl) {
      console.warn(`  ! No artwork for "${app.name}" (id${appStoreId})`);
      failed++;
      continue;
    }
    const s3Key = `app-icons/${appStoreId}.jpg`;
    const ok = await downloadAndUploadIcon(remoteUrl, s3Key, "image/jpeg");
    if (ok) downloaded++;
    else failed++;
  }

  // Website icons — parse HTML for favicon first, fall back to Google service
  for (const site of websites) {
    if (site.icon) {
      skipped++;
      continue;
    }
    const url = site.url as string;
    const filename = websiteIconFilename(url);
    const s3Key = `website-icons/${filename}`;
    const ok = await fetchWebsiteIcon(url, s3Key);
    if (ok) downloaded++;
    else failed++;
  }

  console.log(`Done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
}

// ── Fetch single app icon ──────────────────────────────────────────

async function fetchSingleIcon(bundleId: string, appStoreUrl?: string): Promise<void> {
  // If it looks like a URL, treat as website
  if (bundleId.startsWith("http")) {
    const filename = websiteIconFilename(bundleId);
    const s3Key = `website-icons/${filename}`;
    await fetchWebsiteIcon(bundleId, s3Key);
    return;
  }

  // Otherwise it's an app — look up via iTunes
  if (!appStoreUrl) {
    console.log(`No app_store_url for ${bundleId}, skipping`);
    return;
  }

  const appStoreId = extractAppStoreId(appStoreUrl);
  if (!appStoreId) {
    console.log(`No App Store ID in URL for ${bundleId}, skipping`);
    return;
  }

  const artworkById = await lookupAppStoreArtwork([appStoreId]);
  const remoteUrl = artworkById.get(appStoreId);
  if (!remoteUrl) {
    console.warn(`No artwork found for ${bundleId} (id${appStoreId})`);
    return;
  }

  const s3Key = `app-icons/${appStoreId}.jpg`;
  await downloadAndUploadIcon(remoteUrl, s3Key, "image/jpeg");
}

// ── Handler ────────────────────────────────────────────────────────

interface SQSRecord {
  body: string;
}

interface SQSEvent {
  Records?: SQSRecord[];
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records ?? []) {
    try {
      const message = JSON.parse(record.body);
      console.log(`Processing: ${message.action}`);

      if (message.action === "fetch-icon" && message.bundleId) {
        await fetchSingleIcon(message.bundleId, message.appStoreUrl);
      } else {
        // Default: fetch all
        await fetchAllIcons();
      }
    } catch (err) {
      console.error("Error processing SQS message:", err);
      // Don't throw — SQS will retry, but we don't want to block the queue
    }
  }
};
