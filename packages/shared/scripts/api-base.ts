/**
 * Where a kids app loads /kid/config, /pair and icon files from.
 *
 * Hosted builds leave the base empty (the page origin: CloudFront sends /kid
 * to the API) or set VITE_API_URL (the hosted admin deploy uses
 * https://api.wainwright.fun). The home-network build (VITE_LOCAL_AUTH=1) is
 * served by packages/local on the Mac. Same-origin then reads that server's
 * database and icons directory. A relative base such as /api is kept (tickets).
 * An absolute origin is dropped, so a hosted API URL leaked into the build
 * cannot send the app at api.wainwright.fun.
 */
export function resolveKidApiBase(configured: string | undefined, localMode: boolean): string {
  const value = (configured ?? "").trim().replace(/\/$/, "");
  if (!localMode) return value;
  if (value.startsWith("/")) return value;
  return "";
}

const FAMILY_HOST = /^(?:[a-z0-9-]+\.)*wainwright\.fun$/i;
/** Paths the launcher loads from its own server, not from a website the child opens. */
const LOCAL_PATH = /^\/(?:app-icons|website-icons|system-icons|ticket-icons|kid|pair|api\/local)(?:\/|$)/;

export interface KidDevProxy {
  target: string;
  changeOrigin: boolean;
  headers?: Record<string, string>;
}

/**
 * Vite dev proxy for /kid and /pair.
 * The default is the hosted API (`pnpm dev`, as the README describes).
 * To develop against the Mac instead:
 *   KID_API_PROXY=http://127.0.0.1:43127 KID_API_PROXY_HOST=wainwright.fun
 * The local server dispatches on Host, so the header has to be a launcher name
 * (wainwright.fun or a child's hostname), not the proxy target's own host.
 */
export function kidDevProxy(env: Record<string, string | undefined> = process.env): KidDevProxy {
  const target = env.KID_API_PROXY ?? "https://api.wainwright.fun";
  const host = env.KID_API_PROXY_HOST?.trim();
  if (!host) return { target, changeOrigin: true };
  return {
    target,
    changeOrigin: false,
    headers: { host, "x-real-ip": env.KID_API_PROXY_IP?.trim() || "192.168.1.182" },
  };
}

/**
 * Icon or kid-API URL as the home-network launcher should request it.
 * Relative paths stay on the page origin (the Mac, once that name points here).
 * An absolute https://….wainwright.fun URL for an icon or /kid path becomes
 * that path on the local base, so a stored hosted URL does not fetch the
 * S3/Lambda copy. Other URLs (the website itself, the App Store) are unchanged.
 * Hosted builds only prefix a relative path when an API base is set.
 */
export function localAssetUrl(url: string | null | undefined, apiBase: string, localMode: boolean): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/")) return `${apiBase}${url}`;
  if (!localMode) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && FAMILY_HOST.test(parsed.hostname) && LOCAL_PATH.test(parsed.pathname)) {
      return `${apiBase}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Not a URL.
  }
  return url;
}
