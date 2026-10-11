/**
 * Network half of the icon fetcher (packages/infra/lambda/icon-fetcher.ts).
 * Finds an App Store artwork URL or a website favicon and downloads the bytes.
 * Storage (S3, or the local icons directory) is the caller's job.
 */

export type IconFetch = typeof fetch;

export type DownloadResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status?: number; error?: unknown };

const HTML_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 10000;

export function googleFaviconUrl(url: string): string {
  const hostname = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
}

/** Resolve a possibly-relative href against the page URL. */
export function resolveUrl(pageUrl: string, href: string): string {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return href;
  }
}

/**
 * Fetches the website's HTML and extracts the best favicon URL from
 * <link rel="icon"> / <link rel="apple-touch-icon"> tags. Returns null if
 * the page can't be fetched or no icon link is found.
 *
 * Preference order: apple-touch-icon, then the largest non-SVG icon, then the first icon.
 */
export async function extractFaviconFromHtml(siteUrl: string, fetchImpl: IconFetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(siteUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
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

/**
 * Downloads an icon. `maxBytes` defaults to no limit (the hosted uploader).
 * A declared Content-Length over the limit is refused before the body is read.
 */
export async function downloadIconBytes(remoteUrl: string, fetchImpl: IconFetch = fetch, maxBytes = Infinity): Promise<DownloadResult> {
  try {
    const response = await fetchImpl(remoteUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: new Error(`icon is larger than ${maxBytes} bytes`) };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) return { ok: false, error: new Error(`icon is larger than ${maxBytes} bytes`) };
    return { ok: true, bytes, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    return { ok: false, error };
  }
}

/** iTunes artwork lookup. A failed batch is skipped; a network error is thrown (as the Lambda did). */
export async function lookupAppStoreArtwork(appStoreIds: string[], fetchImpl: IconFetch = fetch): Promise<Map<string, string>> {
  const artworkById = new Map<string, string>();
  const batchSize = 20;

  for (let i = 0; i < appStoreIds.length; i += batchSize) {
    const batch = appStoreIds.slice(i, i + batchSize);
    const response = await fetchImpl(
      `https://itunes.apple.com/lookup?id=${batch.join(",")}&country=gb&entity=software`,
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
