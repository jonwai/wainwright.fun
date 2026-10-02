/**
 * iTunes Lookup API helper — fetches app metadata from the App Store.
 * The API supports CORS so we can call it directly from the browser.
 */

export interface AppStoreResult {
  name: string;
  bundleId: string;
  appStoreUrl: string;
  iconUrl: string;
  category: string;
  minAge: number;
}

/**
 * Extracts the numeric App Store ID from an App Store URL.
 * e.g. "https://apps.apple.com/gb/app/bbc-iplayer/id416580485" → "416580485"
 */
function extractAppStoreId(url: string): string | null {
  const match = url.match(/id(\d+)/);
  return match?.[1] ?? null;
}

/**
 * Parses a content advisory rating like "4+", "9+", "12+", "17+" into a minimum age.
 */
function parseAgeRating(rating: string | undefined): number {
  if (!rating) return 0;
  const match = rating.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Looks up an app by its App Store URL and returns normalised metadata.
 * Returns null if the app can't be found.
 */
export async function lookupApp(appStoreUrl: string): Promise<AppStoreResult | null> {
  const id = extractAppStoreId(appStoreUrl);
  if (!id) return null;

  const response = await fetch(
    `https://itunes.apple.com/lookup?id=${id}&country=gb&entity=software`
  );
  if (!response.ok) return null;

  const data = await response.json();
  const result = data.results?.[0];
  if (!result) return null;

  return {
    name: result.trackName ?? "",
    bundleId: result.bundleId ?? "",
    appStoreUrl: result.trackViewUrl ?? appStoreUrl,
    iconUrl: result.artworkUrl512 ?? result.artworkUrl100 ?? "",
    category: result.primaryGenreName ?? "",
    minAge: parseAgeRating(result.contentAdvisoryRating),
  };
}
