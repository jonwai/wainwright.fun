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

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.CONFIG_BUCKET_NAME!;
const APPS_TABLE = process.env.APPS_TABLE!;
const WEBSITES_TABLE = process.env.WEBSITES_TABLE!;

// ── Helpers ───────────────────────────────────────────────────────

function extractAppStoreId(url: string): string | null {
  const match = url.match(/id(\d+)/);
  return match?.[1] ?? null;
}

function websiteIconFilename(url: string): string {
  const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${hostname}.png`;
}

function googleFaviconUrl(url: string): string {
  const hostname = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
}

/**
 * Fetches the website's HTML and extracts the best favicon URL from
 * <link rel="icon"> / <link rel="apple-touch-icon"> tags. Returns null if
 * the page can't be fetched or no icon link is found.
 *
 * Preference order: apple-touch-icon (180×180) > svg > largest png > any icon.
 */
async function extractFaviconFromHtml(siteUrl: string): Promise<string | null> {
  try {
    const response = await fetch(siteUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "wainwright.fun-icon-fetcher/1.0" },
    });
    if (!response.ok) return null;
    const html = await response.text();

    // Parse <link rel="..."> tags with href attributes
    const linkRegex = /<link\s+[^>]*?>/gi;
    const icons: { href: string; size: number; isApple: boolean; isSvg: boolean }[] = [];

    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(html)) !== null) {
      const tag = match[0];
      const relMatch = tag.match(/rel\s*=\s*["']([^"']+)["']/i);
      if (!relMatch) continue;
      const rel = relMatch[1].toLowerCase();
      if (!rel.includes("icon") && !rel.includes("apple-touch")) continue;

      const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];

      let size = 0;
      const sizeMatch = tag.match(/sizes\s*=\s*["']([^"']+)["']/i);
      if (sizeMatch) {
        const sizes = sizeMatch[1].split(/\s+/);
        for (const s of sizes) {
          const m = s.match(/^(\d+)x(\d+)$/);
          if (m) size = Math.max(size, parseInt(m[1], 10));
        }
      }
      icons.push({
        href,
        size,
        isApple: rel.includes("apple-touch"),
        isSvg: href.endsWith(".svg"),
      });
    }

    if (icons.length === 0) return null;

    // Preference: apple-touch-icon > largest PNG > SVG > any
    const apple = icons.find((i) => i.isApple);
    if (apple) return resolveUrl(siteUrl, apple.href);
    const pngs = icons.filter((i) => !i.isSvg).sort((a, b) => b.size - a.size);
    if (pngs.length > 0) return resolveUrl(siteUrl, pngs[0].href);
    return resolveUrl(siteUrl, icons[0].href);
  } catch {
    return null;
  }
}

/** Resolve a possibly-relative href against the page URL. */
function resolveUrl(pageUrl: string, href: string): string {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return href;
  }
}

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
  try {
    const response = await fetch(remoteUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.warn(`  ! Failed to download ${remoteUrl} (${response.status})`);
      return false;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: buffer,
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

// ── iTunes artwork lookup ──────────────────────────────────────────

async function lookupArtwork(appStoreIds: string[]): Promise<Map<string, string>> {
  const artworkById = new Map<string, string>();
  const batchSize = 20;

  for (let i = 0; i < appStoreIds.length; i += batchSize) {
    const batch = appStoreIds.slice(i, i + batchSize);
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=gb&entity=software`
    );
    if (!response.ok) {
      console.warn(`iTunes lookup failed (${response.status})`);
      continue;
    }
    const data = (await response.json()) as {
      results?: Array<{
        trackId: number;
        artworkUrl512?: string;
        artworkUrl100?: string;
      }>;
    };
    for (const result of data.results ?? []) {
      const artwork = result.artworkUrl512 ?? result.artworkUrl100;
      if (artwork) {
        artworkById.set(String(result.trackId), artwork);
      }
    }
  }
  return artworkById;
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
  const artworkById = appStoreIds.length > 0 ? await lookupArtwork(appStoreIds) : new Map<string, string>();

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

  const artworkById = await lookupArtwork([appStoreId]);
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
