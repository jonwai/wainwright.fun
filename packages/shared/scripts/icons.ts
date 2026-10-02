import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type {
  AppEntry,
  RootConfig,
  SystemApp,
  WebsiteEntry,
} from "./config.js";

function scriptsRoot(): string {
  // CDK bundles the API Lambda as CJS, where import.meta is empty.
  const dir = import.meta.dirname;
  return typeof dir === "string" ? join(dir, "..") : process.cwd();
}

export const ICONS_DIR = join(scriptsRoot(), "public", "app-icons");
export const WEBSITE_ICONS_DIR = join(scriptsRoot(), "public", "website-icons");

export function extractAppStoreId(url: string): string | null {
  const match = url.match(/id(\d+)/);
  return match?.[1] ?? null;
}

export function websiteIconFilename(url: string): string {
  const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${hostname}.png`;
}

/**
 * Computes the icon_url path for an app (regular or system).
 * Returns null if no icon can be determined.
 * Pure function — no I/O. Used by both the local build (via enrichConfigWithIcons)
 * and the site-rebuilder Lambda (which can't download icons).
 */
export function appIconUrlPath(app: {
  app_store_url?: string;
  icon?: string;
  type?: string;
}): string | null {
  // System apps may have a named icon: /system-icons/{icon}.png
  if (app.type === "system" && app.icon) {
    return `/system-icons/${app.icon}.png`;
  }
  // Derive from App Store URL: /app-icons/{appStoreId}.jpg
  if (app.app_store_url) {
    const id = extractAppStoreId(app.app_store_url);
    if (id) {
      return `/app-icons/${id}.jpg`;
    }
  }
  return null;
}

/**
 * Computes the icon_url path for a website.
 * Returns null if the URL is invalid.
 * Pure function — no I/O.
 */
export function websiteIconUrlPath(site: {
  url: string;
  icon?: string;
}): string | null {
  const keys = websiteIconKeys(site);
  return keys[0] ? `/${keys[0]}` : null;
}

/** S3 / public/ keys to try for a website icon, most specific first. */
export function websiteIconKeys(site: {
  url: string;
  icon?: string;
}): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  if (site.icon) {
    add(`website-icons/${site.icon}`);
  }
  try {
    add(`website-icons/${websiteIconFilename(site.url)}`);
  } catch {
    // Invalid URL — skip hostname fallback.
  }
  return keys;
}

function faviconUrl(url: string): string {
  const hostname = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
}

function collectUniqueSystemApps(config: RootConfig): SystemApp[] {
  return config.system_apps;
}

function collectUniqueApps(config: RootConfig): AppEntry[] {
  return config.apps;
}

function collectUniqueWebsites(config: RootConfig): WebsiteEntry[] {
  return config.websites;
}

async function lookupArtwork(appStoreIds: string[]): Promise<Map<string, string>> {
  const artworkById = new Map<string, string>();
  const batchSize = 20;

  for (let i = 0; i < appStoreIds.length; i += batchSize) {
    const batch = appStoreIds.slice(i, i + batchSize);
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=gb&entity=software`
    );

    if (!response.ok) {
      throw new Error(`iTunes lookup failed (${response.status})`);
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

async function downloadIcon(remoteUrl: string, destination: string): Promise<void> {
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download icon (${response.status})`);
  }

  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await pipeline(Readable.from(buffer), createWriteStream(destination));
}

async function enrichAppsWithIcons(apps: AppEntry[]): Promise<Map<string, AppEntry>> {
  const appsNeedingLookup = apps.filter(
    (app) => !app.icon_url && !existsSync(join(ICONS_DIR, `${extractAppStoreId(app.app_store_url)}.jpg`))
  );
  const appStoreIds = [
    ...new Set(
      appsNeedingLookup
        .map((app) => extractAppStoreId(app.app_store_url))
        .filter((id): id is string => id !== null)
    ),
  ];

  const artworkById = appStoreIds.length > 0 ? await lookupArtwork(appStoreIds) : new Map();
  const enriched = new Map<string, AppEntry>();

  for (const app of apps) {
    if (app.icon_url) {
      enriched.set(app.bundle_id, app);
      continue;
    }

    const appStoreId = extractAppStoreId(app.app_store_url);
    if (!appStoreId) {
      console.warn(`  ! No App Store ID in URL for "${app.name}"`);
      enriched.set(app.bundle_id, app);
      continue;
    }

    const filename = `${appStoreId}.jpg`;
    const localPath = join(ICONS_DIR, filename);

    if (existsSync(localPath)) {
      enriched.set(app.bundle_id, {
        ...app,
        icon_url: `/app-icons/${filename}`,
      });
      continue;
    }

    const remoteUrl = artworkById.get(appStoreId);
    if (!remoteUrl) {
      console.warn(`  ! No icon found for "${app.name}" (id${appStoreId})`);
      enriched.set(app.bundle_id, app);
      continue;
    }

    await downloadIcon(remoteUrl, localPath);

    enriched.set(app.bundle_id, {
      ...app,
      icon_url: `/app-icons/${filename}`,
    });
  }

  return enriched;
}

async function enrichWebsitesWithIcons(
  websites: WebsiteEntry[]
): Promise<Map<string, WebsiteEntry>> {
  const enriched = new Map<string, WebsiteEntry>();

  for (const site of websites) {
    if (site.icon) {
      const filename = site.icon;
      enriched.set(site.url, {
        ...site,
        icon_url: `/website-icons/${filename}`,
      });
      continue;
    }

    if (site.icon_url) {
      enriched.set(site.url, site);
      continue;
    }

    const filename = websiteIconFilename(site.url);
    const localPath = join(WEBSITE_ICONS_DIR, filename);

    if (!existsSync(localPath)) {
      try {
        await downloadIcon(faviconUrl(site.url), localPath);
      } catch {
        console.warn(`  ! No favicon found for "${site.name}"`);
        enriched.set(site.url, site);
        continue;
      }
    }

    enriched.set(site.url, {
      ...site,
      icon_url: `/website-icons/${filename}`,
    });
  }

  return enriched;
}

async function enrichSystemAppsWithIcons(systemApps: SystemApp[]): Promise<SystemApp[]> {
  const needingIcons = systemApps.filter(
    (app) => app.app_store_url && !app.icon_url && !existsSync(join(ICONS_DIR, `${extractAppStoreId(app.app_store_url!)}.jpg`))
  );
  const appStoreIds = [
    ...new Set(
      needingIcons
        .map((app) => extractAppStoreId(app.app_store_url!))
        .filter((id): id is string => id !== null)
    ),
  ];

  const artworkById = appStoreIds.length > 0 ? await lookupArtwork(appStoreIds) : new Map();

  return Promise.all(
    systemApps.map(async (app) => {
      if (app.icon_url || !app.app_store_url) {
        return app;
      }

      const appStoreId = extractAppStoreId(app.app_store_url);
      if (!appStoreId) {
        return app;
      }

      const filename = `${appStoreId}.jpg`;
      const localPath = join(ICONS_DIR, filename);

      if (existsSync(localPath)) {
        return {
          ...app,
          icon_url: `/app-icons/${filename}`,
        };
      }

      const remoteUrl = artworkById.get(appStoreId);
      if (!remoteUrl) {
        console.warn(`  ! No App Store icon for "${app.name}"`);
        return app;
      }

      await downloadIcon(remoteUrl, localPath);

      return {
        ...app,
        icon_url: `/app-icons/${filename}`,
      };
    })
  );
}

function mergeIconsIntoConfig(
  config: RootConfig,
  appsById: Map<string, AppEntry>,
  sitesByUrl: Map<string, WebsiteEntry>,
  systemApps: SystemApp[]
): RootConfig {
  return {
    ...config,
    system_apps: systemApps,
    apps: config.apps.map((app) => appsById.get(app.bundle_id) ?? app),
    websites: config.websites.map((site) => sitesByUrl.get(site.url) ?? site),
  };
}

export async function enrichConfigWithIcons(config: RootConfig): Promise<RootConfig> {
  mkdirSync(ICONS_DIR, { recursive: true });
  mkdirSync(WEBSITE_ICONS_DIR, { recursive: true });

  const allApps = collectUniqueApps(config);
  const allWebsites = collectUniqueWebsites(config);
  const allSystemApps = collectUniqueSystemApps(config);

  const [appsById, sitesByUrl, systemApps] = await Promise.all([
    enrichAppsWithIcons(allApps),
    enrichWebsitesWithIcons(allWebsites),
    enrichSystemAppsWithIcons(allSystemApps),
  ]);

  return mergeIconsIntoConfig(config, appsById, sitesByUrl, systemApps);
}
