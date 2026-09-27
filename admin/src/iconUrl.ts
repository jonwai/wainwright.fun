import type { App, Website } from "./api";

/**
 * Extracts the App Store numeric ID from an App Store URL.
 * e.g. "https://apps.apple.com/gb/app/angry-birds/id1067456176" → "1067456176"
 */
function extractAppStoreId(url: string): string | null {
  const match = url.match(/id(\d+)/);
  return match?.[1] ?? null;
}

/**
 * Computes the icon URL for an app (regular or system).
 * Returns null if no icon can be determined.
 */
export function appIconUrl(app: App): string | null {
  // System apps may have a named icon: /system-icons/{icon}.png
  if (app.type === "system" && app.icon) {
    return `/system-icons/${app.icon}.png`;
  }

  // If an explicit icon_url is set (e.g. Apple-hosted artwork for new apps)
  if (app.icon_url) {
    return app.icon_url;
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
 * Computes the icon URL for a website.
 * Returns null if no icon can be determined.
 */
export function websiteIconUrl(site: Website): string | null {
  // Named icon: /website-icons/{icon}
  if (site.icon) {
    return `/website-icons/${site.icon}`;
  }

  // Derive from URL hostname: /website-icons/{hostname}.png
  try {
    const hostname = new URL(site.url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    return `/website-icons/${hostname}.png`;
  } catch {
    return null;
  }
}
