import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { ResolvedChildConfig } from "./resolve.js";
import { filterNonDefault } from "../shared/restriction-catalog.js";
import { websiteIconKeys } from "./icons.js";

export type Theme = "little" | "early" | "primary" | "teen";

export interface AppEntry {
  name: string;
  bundle_id: string;
  app_store_url: string;
  /** Minimum age (years) this app appears from. Any age — not just band ages. */
  min_age: number;
  emoji?: string;
  category?: string;
  icon_url?: string;
}

export interface SystemApp {
  bundle_id: string;
  name: string;
  /** Minimum age (years) this system app appears from. */
  min_age: number;
  show_on_site?: boolean;
  icon?: string;
  app_store_url?: string;
  icon_url?: string;
  category?: string;
}

export interface WebsiteEntry {
  name: string;
  url: string;
  /** Custom icon filename in public/website-icons/ (without path prefix). */
  icon?: string;
  icon_url?: string;
  category?: string;
  /** Minimum age (years) this shared website appears from. Absent for
   *  personal websites, which bypass age gating entirely. */
  min_age?: number;
  /** When true, excluded from site display but still included in profile. */
  hidden?: boolean;
  /** When true, this site gets a Home Screen Web Clip even if hidden
   *  (e.g. the Snacks PWA, hidden from the site but pinned to Home Screen). */
  web_clip?: boolean;
}

export type ChildColor = "red" | "green" | "blue" | "orange" | "purple";

/**
 * Maps a child's accent colour to its hex value, matching the CSS
 * --child-gradient end colour used for the profile button.
 */
export const CHILD_COLOR_HEX: Record<ChildColor, string> = {
  red: "#e53935",
  green: "#43a047",
  blue: "#5b6cff",
  orange: "#fb8c00",
  purple: "#8e24aa",
};

export interface Child {
  name: string;
  subdomain: string;
  date_of_birth: string | Date;
  /** Favourite colour — used for name badge, profile section and install button */
  color: ChildColor;
  /** Emoji avatar chosen by the child (or set by an adult). */
  avatar?: string;
  /** When false, public profile can be removed in Settings. Defaults to locked. */
  locked?: boolean;
  /** Per-child restriction overrides (only for restrictions marked overridable). */
  restriction_overrides?: RestrictionOverride[];
  /** Websites personal to this child (bypass age bands, no min_age needed). */
  personal_websites?: WebsiteEntry[];
  /** Bundle IDs of apps blocked for this child. Blocked apps still appear on
   *  the site (semi-transparent, unclickable) but are excluded from the
   *  profile whitelist so they cannot be downloaded. */
  blocked_apps?: string[];
}

export interface AgeBand {
  from_age: number;
  theme: Theme;
  subtitle: string;
  /** Per-age-band restriction overrides (only for restrictions marked overridable). */
  restriction_overrides?: RestrictionOverride[];
}

export type RestrictionType = "boolean" | "integer" | "real" | "string";

export interface Restriction {
  key: string;
  value: boolean | number | string;
  type: RestrictionType;
  /** Whether this restriction can be overridden per age band or child. */
  overridable?: boolean;
}

export interface RestrictionOverride {
  key: string;
  value: boolean | number | string;
}

export interface RootConfig {
  domain: string;
  site: {
    profile_button_text: string;
  };
  profile: {
    organization: string;
  };
  restrictions?: Restriction[];
  children: Child[];
  /** All apps (type "app"), any min_age. */
  apps: AppEntry[];
  /** All system apps, any min_age. */
  system_apps: SystemApp[];
  /** All shared websites (no child_subdomain), any min_age. */
  websites: WebsiteEntry[];
  /** Theme bands — drive theme/subtitle only, never app membership. */
  age_bands: AgeBand[];
}

function scriptsRoot(): string {
  const dir = import.meta.dirname;
  return typeof dir === "string" ? join(dir, "..") : process.cwd();
}

export function loadConfig(): RootConfig {
  const raw = readFileSync(join(scriptsRoot(), "apps.yaml"), "utf8");
  return yaml.load(raw) as RootConfig;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

/**
 * Generates the restriction payload XML from a list of Restriction objects.
 * Each restriction becomes a <key>…</key> + value pair, sorted alphabetically.
 */
function generateRestrictionsXml(restrictions: Restriction[]): string {
  return restrictions
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      let valueXml: string;
      switch (r.type) {
        case "boolean":
          valueXml = `<${r.value ? "true" : "false"}/>`;
          break;
        case "integer":
          valueXml = `<integer>${Math.trunc(Number(r.value))}</integer>`;
          break;
        case "real":
          valueXml = `<real>${Number(r.value)}</real>`;
          break;
        case "string":
          valueXml = plistString(String(r.value));
          break;
        default:
          valueXml = plistString(String(r.value));
      }
      return `      <key>${r.key}</key>\n      ${valueXml}`;
    })
    .join("\n");
}

function generateAppRestrictionsPayload(
  config: ResolvedChildConfig,
  allBundleIds: string[],
  restrictions: Restriction[]
): string {
  const payloadUuid = randomUUID().toUpperCase();
  const payloadIdentifier = `${config.profile.identifier}.restrictions`;

  const bundleIdEntries = allBundleIds
    .map((id) => `        ${plistString(id)}`)
    .join("\n");

  const restrictionsXml = generateRestrictionsXml(filterNonDefault(restrictions));

  return `    <dict>
      <key>PayloadType</key>
      <string>com.apple.applicationaccess</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      ${plistString(payloadIdentifier)}
      <key>PayloadUUID</key>
      ${plistString(payloadUuid)}
      <key>PayloadDisplayName</key>
      ${plistString("Allowed Apps")}
      <key>PayloadDescription</key>
      ${plistString(`Restricts this iPad to apps listed on ${config.siteUrl}`)}
${restrictionsXml}
      <key>whitelistedAppBundleIDs</key>
      <array>
${bundleIdEntries}
      </array>
    </dict>`;
}

function generateWebFilterPayload(config: ResolvedChildConfig): string | null {
  if (config.websites.length === 0) {
    return null;
  }

  const payloadUuid = randomUUID().toUpperCase();
  const payloadIdentifier = `${config.profile.identifier}.webfilter`;

  const bookmarkEntries = config.websites
    .map(
      (site) => `        <dict>
          <key>Title</key>
          ${plistString(site.name)}
          <key>URL</key>
          ${plistString(site.url)}
        </dict>`
    )
    .join("\n");

  return `    <dict>
      <key>PayloadType</key>
      <string>com.apple.webcontent-filter</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      ${plistString(payloadIdentifier)}
      <key>PayloadUUID</key>
      ${plistString(payloadUuid)}
      <key>PayloadDisplayName</key>
      ${plistString("Allowed Websites")}
      <key>PayloadDescription</key>
      ${plistString(`Safari can only visit sites allowed for ${config.child.name}. Allowed sites also appear as Home Screen icons.`)}
      <key>FilterType</key>
      <string>BuiltIn</string>
      <key>AutoFilterEnabled</key>
      <false/>
      <key>AllowListBookmarks</key>
      <array>
${bookmarkEntries}
      </array>
    </dict>`;
}

const WEB_CLIP_BUNDLE_ID = "com.apple.webapp";

function stableUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-").toUpperCase();
}

function plistData(bytes: Buffer): string {
  return `<data>${bytes.toString("base64")}</data>`;
}

function isChildOwnSite(config: ResolvedChildConfig, url: string): boolean {
  try {
    return new URL(url).hostname === `${config.child.subdomain}.${config.domain}`;
  } catch {
    return false;
  }
}

/** Visible allowlisted websites that should appear as Home Screen Web Clips. */
export function webClipSites(config: ResolvedChildConfig): WebsiteEntry[] {
  return config.websites.filter(
    (site) =>
      (!site.hidden || site.web_clip === true) &&
      !isChildOwnSite(config, site.url)
  );
}

function readLocalWebsiteIcon(site: WebsiteEntry): Buffer | null {
  const root = join(scriptsRoot(), "public");
  for (const key of websiteIconKeys(site)) {
    const path = join(root, key);
    if (existsSync(path)) {
      try {
        return readFileSync(path);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function generateWebClipPayload(
  config: ResolvedChildConfig,
  site: WebsiteEntry,
  icon: Buffer | null,
): string {
  const payloadUuid = stableUuid(`${config.profile.identifier}|webclip|${site.url}`);
  const payloadIdentifier = `${config.profile.identifier}.webclip.${payloadUuid.toLowerCase()}`;
  const iconXml = icon
    ? `\n      <key>Icon</key>\n      ${plistData(icon)}`
    : "";

  return `    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      ${plistString(payloadIdentifier)}
      <key>PayloadUUID</key>
      ${plistString(payloadUuid)}
      <key>PayloadDisplayName</key>
      ${plistString(site.name)}
      <key>PayloadDescription</key>
      ${plistString(`Home Screen icon for ${site.name}`)}
      <key>URL</key>
      ${plistString(site.url)}
      <key>Label</key>
      ${plistString(site.name)}
      <key>FullScreen</key>
      <true/>
      <key>IsRemovable</key>
      <false/>
      <key>Precomposed</key>
      <true/>
      <key>IgnoreManifestScope</key>
      <false/>${iconXml}
    </dict>`;
}

export interface GenerateProfileOptions {
  /** PNG/JPEG/GIF bytes keyed by website URL. Falls back to public/website-icons/. */
  webClipIcons?: Map<string, Buffer>;
}

function generateWebClipPayloads(
  config: ResolvedChildConfig,
  icons?: Map<string, Buffer>,
): string[] {
  return webClipSites(config).map((site) => {
    const icon = icons?.get(site.url) ?? readLocalWebsiteIcon(site);
    return generateWebClipPayload(config, site, icon);
  });
}

export function generateProfile(
  config: ResolvedChildConfig,
  restrictions?: Restriction[],
  options?: GenerateProfileOptions,
): string {
  const effectiveRestrictions = restrictions ?? config.restrictions;
  const blockedApps = new Set(config.blocked_apps);
  const allBundleIds = [
    ...config.system_apps.map((app) => app.bundle_id),
    ...config.apps.map((app) => app.bundle_id),
  ].filter((id) => !blockedApps.has(id));

  if (
    webClipSites(config).length > 0 &&
    !allBundleIds.includes(WEB_CLIP_BUNDLE_ID)
  ) {
    allBundleIds.push(WEB_CLIP_BUNDLE_ID);
  }

  const profileUuid = randomUUID().toUpperCase();
  const payloads = [
    generateAppRestrictionsPayload(config, allBundleIds, effectiveRestrictions),
    generateWebFilterPayload(config),
    ...generateWebClipPayloads(config, options?.webClipIcons),
  ].filter((payload): payload is string => payload !== null);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
${payloads.join("\n")}
  </array>
  <key>PayloadDisplayName</key>
  ${plistString(config.profile.display_name)}
  <key>PayloadIdentifier</key>
  ${plistString(config.profile.identifier)}
  <key>PayloadOrganization</key>
  ${plistString(config.profile.organization)}
  <key>PayloadRemovalDisallowed</key>
  <${config.profile.removal_disallowed === true ? "true" : "false"}/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  ${plistString(profileUuid)}
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
}

export function generateWebManifest(config: ResolvedChildConfig): string {
  const themeColor = CHILD_COLOR_HEX[config.child.color];

  const manifest = {
    name: config.site.title,
    short_name: config.site.title,
    description: config.site.subtitle,
    start_url: "/",
    display: "standalone",
    background_color: config.theme === "teen" ? "#0f172a" : "#ffffff",
    theme_color: themeColor,
    icons: [
      {
        src: "/web-app-manifest-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/web-app-manifest-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}
