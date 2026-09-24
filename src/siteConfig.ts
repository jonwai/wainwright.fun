import { CHILD_COLOR_HEX } from "../shared/avatars";
import type { KidConfig } from "./lib/kidApi";

const CONFIG_URL = "/config.json";

/**
 * Dev-only yaml fallback when VITE_CHILD is set. Production always uses the
 * kid API after the iPad has been paired.
 */
export async function getDevFallbackConfig(): Promise<KidConfig | null> {
  if (!import.meta.env.DEV) return null;

  const element = document.getElementById("site-config");
  if (element?.textContent) {
    return JSON.parse(element.textContent) as KidConfig;
  }

  const asOf = new URLSearchParams(window.location.search).get("asOf");
  const url = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? `${CONFIG_URL}?asOf=${asOf}`
    : CONFIG_URL;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export function applyKidTheme(config: KidConfig): void {
  document.title = config.site.title;
  const themeColor = CHILD_COLOR_HEX[config.child.color] ?? "#5b6cff";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeColor);
}
