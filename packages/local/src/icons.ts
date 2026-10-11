/**
 * Downloads app and website icons into the local icons directory, at the path the
 * launcher requests (appIconUrlPath / websiteIconUrlPath). The lookup is the hosted
 * icon-fetcher's: iTunes artwork for apps, the page's favicon then Google's favicon
 * service for websites. An icon that is already on disk is left alone.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { appIconUrlPath, extractAppStoreId, websiteIconUrlPath } from "../../shared/scripts/icons.js";
import {
  downloadIconBytes,
  extractFaviconFromHtml,
  googleFaviconUrl,
  lookupAppStoreArtwork,
  type IconFetch,
} from "../../shared/scripts/icon-fetch.js";

/** Raster icons only. A multi-megabyte "favicon" is not written into the icons directory. */
const MAX_ICON_BYTES = 2 * 1024 * 1024;

export interface IconSubject {
  name?: string;
  type?: string;
  icon?: string;
  app_store_url?: string;
  url?: string;
}

export interface IconFetchDeps {
  iconsDir: string;
  fetch?: IconFetch;
  log?: (line: string) => void;
}

export interface IconFetchReport {
  downloaded: number;
  skipped: number;
  failed: number;
}

export type IconFetchOutcome = "downloaded" | "skipped" | "failed";

/** `app-icons/{appStoreId}.jpg`, or null when the launcher would not request that file. */
export function appIconKey(app: { app_store_url?: string; icon?: string; type?: string }): string | null {
  const urlPath = appIconUrlPath(app);
  if (!urlPath?.startsWith("/app-icons/")) return null;
  const key = urlPath.slice(1);
  return /^app-icons\/\d+\.jpg$/.test(key) ? key : null;
}

/** The website icon the launcher requests, or null when the name is not a single file. */
export function websiteIconKey(site: { url?: string; icon?: string }): string | null {
  if (!site.url) return null;
  const urlPath = websiteIconUrlPath({ url: site.url, icon: site.icon });
  if (!urlPath?.startsWith("/website-icons/")) return null;
  const key = urlPath.slice(1);
  return /^website-icons\/[^/\\]+$/.test(key) ? key : null;
}

function isHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype") || head.startsWith("<html");
}

/** The file is served by its extension, so an SVG or HTML page must not be stored as a .png/.jpg. */
function acceptableIcon(bytes: Buffer, contentType: string, key: string): boolean {
  if (bytes.length === 0) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/") || type === "application/json" || type === "application/xhtml+xml") return false;
  if (type === "image/svg+xml" || looksLikeMarkup(bytes)) return key.endsWith(".svg");
  return true;
}

async function iconExists(iconsDir: string, key: string): Promise<boolean> {
  try {
    const info = await stat(path.resolve(iconsDir, key));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function placeIcon(iconsDir: string, key: string, bytes: Buffer): Promise<"written" | "present" | "rejected"> {
  const base = path.resolve(iconsDir);
  const dest = path.resolve(base, key);
  if (!dest.startsWith(base + path.sep)) return "rejected";
  await mkdir(path.dirname(dest), { recursive: true });
  if (await iconExists(iconsDir, key)) return "present";
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, bytes);
  try {
    await link(tmp, dest);
    return "written";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "present";
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function downloadToKey(deps: IconFetchDeps, remoteUrl: string, key: string): Promise<boolean> {
  if (!isHttp(remoteUrl)) return false;
  const downloaded = await downloadIconBytes(remoteUrl, deps.fetch ?? fetch, MAX_ICON_BYTES);
  if (!downloaded.ok) {
    if (downloaded.error) deps.log?.(`  ! Error downloading ${remoteUrl}: ${downloaded.error}`);
    else deps.log?.(`  ! Failed to download ${remoteUrl} (${downloaded.status})`);
    return false;
  }
  if (!acceptableIcon(downloaded.bytes, downloaded.contentType, key)) {
    deps.log?.(`  ! ${remoteUrl} is not a usable icon for ${key}`);
    return false;
  }
  const placed = await placeIcon(deps.iconsDir, key, downloaded.bytes);
  if (placed === "rejected") return false;
  if (placed === "written") deps.log?.(`  ✓ ${key} (downloaded)`);
  return true;
}

export async function ensureWebsiteIcon(site: { url?: string; icon?: string; name?: string }, deps: IconFetchDeps): Promise<IconFetchOutcome> {
  const key = websiteIconKey(site);
  if (!key || !site.url) return "skipped";
  if (await iconExists(deps.iconsDir, key)) {
    deps.log?.(`  ✓ ${key} (already exists)`);
    return "skipped";
  }
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const faviconUrl = isHttp(site.url) ? await extractFaviconFromHtml(site.url, fetchImpl) : null;
    if (faviconUrl) {
      if (await downloadToKey(deps, faviconUrl, key)) return "downloaded";
      deps.log?.(`  · HTML favicon failed, falling back to Google service`);
    } else {
      deps.log?.(`  · No favicon link found in ${site.url}, falling back to Google service`);
    }
    if (await iconExists(deps.iconsDir, key)) return "skipped";
    return (await downloadToKey(deps, googleFaviconUrl(site.url), key)) ? "downloaded" : "failed";
  } catch (err) {
    deps.log?.(`  ! Error fetching icon for ${site.name ?? site.url}: ${(err as Error).message}`);
    return "failed";
  }
}

export async function ensureAppIcon(app: IconSubject, deps: IconFetchDeps): Promise<IconFetchOutcome> {
  const key = appIconKey(app);
  if (!key || !app.app_store_url) return "skipped";
  if (await iconExists(deps.iconsDir, key)) {
    deps.log?.(`  ✓ ${key} (already exists)`);
    return "skipped";
  }
  const id = extractAppStoreId(app.app_store_url);
  if (!id) return "skipped";
  try {
    const artwork = await lookupAppStoreArtwork([id], deps.fetch ?? fetch);
    const remote = artwork.get(id);
    if (!remote) {
      deps.log?.(`  ! No artwork for "${app.name ?? id}" (id${id})`);
      return "failed";
    }
    return (await downloadToKey(deps, remote, key)) ? "downloaded" : "failed";
  } catch (err) {
    deps.log?.(`  ! Error fetching icon for ${app.name ?? id}: ${(err as Error).message}`);
    return "failed";
  }
}

export async function fetchMissingIcons(apps: IconSubject[], websites: IconSubject[], deps: IconFetchDeps): Promise<IconFetchReport> {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const bump = (outcome: IconFetchOutcome) => {
    if (outcome === "downloaded") downloaded += 1;
    else if (outcome === "skipped") skipped += 1;
    else failed += 1;
  };

  const pending: { app: IconSubject; id: string; key: string }[] = [];
  for (const app of apps) {
    const key = appIconKey(app);
    if (!key || !app.app_store_url) {
      skipped += 1;
      continue;
    }
    if (await iconExists(deps.iconsDir, key)) {
      deps.log?.(`  ✓ ${key} (already exists)`);
      skipped += 1;
      continue;
    }
    const id = extractAppStoreId(app.app_store_url);
    if (!id) {
      skipped += 1;
      continue;
    }
    pending.push({ app, id, key });
  }

  let artwork = new Map<string, string>();
  if (pending.length > 0) {
    try {
      artwork = await lookupAppStoreArtwork([...new Set(pending.map((item) => item.id))], deps.fetch ?? fetch);
    } catch (err) {
      deps.log?.(`  ! iTunes lookup failed: ${(err as Error).message}`);
      failed += pending.length;
      pending.length = 0;
    }
  }
  for (const item of pending) {
    const remote = artwork.get(item.id);
    if (!remote) {
      deps.log?.(`  ! No artwork for "${item.app.name ?? item.id}" (id${item.id})`);
      failed += 1;
      continue;
    }
    try {
      bump((await downloadToKey(deps, remote, item.key)) ? "downloaded" : "failed");
    } catch (err) {
      deps.log?.(`  ! Error fetching icon for ${item.app.name ?? item.id}: ${(err as Error).message}`);
      failed += 1;
    }
  }

  for (const site of websites) {
    if (!site.url) {
      skipped += 1;
      continue;
    }
    bump(await ensureWebsiteIcon(site, deps));
  }

  deps.log?.(`Done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
  return { downloaded, skipped, failed };
}
