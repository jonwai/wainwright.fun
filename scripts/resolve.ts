import { createHash } from "node:crypto";
import type {
  AgeBand,
  AppEntry,
  Child,
  RootConfig,
  SystemApp,
  Theme,
  WebsiteEntry,
  Restriction,
} from "./config.js";
import { mergeRestrictions, type RestrictionOverride } from "../shared/restriction-catalog.js";
import { appIconUrlPath, websiteIconUrlPath } from "./icons.js";
import { calculateAge, getBirthdayState, ordinal } from "./birthday.js";

export { calculateAge, getBirthdayState, ordinal } from "./birthday.js";

export type UnifiedItemKind = "app" | "system" | "website";

export interface UnifiedItem {
  kind: UnifiedItemKind;
  name: string;
  /** App Store URL for apps/system apps, website URL for websites. */
  url: string;
  /** Bundle ID for apps/system apps, website URL for websites. */
  key: string;
  category?: string;
  emoji?: string;
  icon_url?: string;
  /** System-app icon filename (without path prefix). */
  icon?: string;
  /** Whether this is a static (non-clickable) system app with no app_store_url. */
  static?: boolean;
  /** Whether this app is blocked for the current child. Blocked apps appear
   *  semi-transparent and unclickable on the site, and are excluded from the
   *  profile whitelist so they cannot be downloaded. */
  blocked?: boolean;
  /** Age band this item first became available. */
  from_age?: number;
  /** Newly unlocked during the current birthday window. */
  isNew?: boolean;
}

export interface BirthdayCelebration {
  isToday: boolean;
  /** from_age of the band entered this birthday, if any. */
  unlockedFromAge: number | null;
  unlockedCount: number;
  headline: string;
  message: string;
}

export interface UnifiedCategory {
  name: string;
  items: UnifiedItem[];
}

export interface ResolvedChildConfig {
  child: Child;
  age: number;
  theme: Theme;
  domain: string;
  siteUrl: string;
  site: {
    title: string;
    subtitle: string;
    profile_button_text: string;
  };
  profileVersion: string;
  profileUpdatedAt: string;
  system_apps: SystemApp[];
  websites: WebsiteEntry[];
  apps: AppEntry[];
  categories: UnifiedCategory[];
  /** Merged restrictions (global + theme + child overrides, defaults filtered). */
  restrictions: Restriction[];
  /** Bundle IDs of apps blocked for this child (excluded from profile whitelist). */
  blocked_apps: string[];
  /** All visible apps, system apps, and websites (little theme uses this list). */
  items: UnifiedItem[];
  /** Newly unlocked apps and websites (not system apps) during the birthday window. */
  justUnlocked: UnifiedItem[];
  birthday: BirthdayCelebration | null;
  profile: {
    display_name: string;
    identifier: string;
    organization: string;
    removal_disallowed: boolean;
  };
}

function dedupeSystemApps(apps: SystemApp[]): SystemApp[] {
  const seen = new Set<string>();
  const result: SystemApp[] = [];
  for (const app of apps) {
    if (seen.has(app.bundle_id)) {
      continue;
    }
    seen.add(app.bundle_id);
    result.push(app);
  }
  return result;
}

function dedupeApps(apps: AppEntry[]): AppEntry[] {
  const seen = new Set<string>();
  const result: AppEntry[] = [];
  for (const app of apps) {
    if (seen.has(app.bundle_id)) {
      continue;
    }
    seen.add(app.bundle_id);
    result.push(app);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeWebsites(sites: WebsiteEntry[]): WebsiteEntry[] {
  const seen = new Set<string>();
  const result: WebsiteEntry[] = [];
  for (const site of sites) {
    if (seen.has(site.url)) {
      continue;
    }
    seen.add(site.url);
    result.push(site);
  }
  return result;
}

function unlockPhrase(apps: number, websites: number): string {
  const appLabel = apps === 1 ? "1 new app" : `${apps} new apps`;
  const siteLabel = websites === 1 ? "1 website" : `${websites} websites`;
  if (apps > 0 && websites > 0) return `${appLabel} and ${siteLabel}`;
  if (apps > 0) return appLabel;
  if (websites > 0) return `new ${siteLabel}`;
  return "new apps";
}

function buildBirthday(
  child: Child,
  age: number,
  unlockedFromAge: number | null,
  justUnlocked: UnifiedItem[],
  asOf: Date,
): BirthdayCelebration | null {
  const state = getBirthdayState(child.date_of_birth, asOf);
  if (!state.celebrating) {
    return null;
  }

  const unlockedCount = justUnlocked.length;
  const phrase = unlockPhrase(
    justUnlocked.filter((item) => item.kind === "app").length,
    justUnlocked.filter((item) => item.kind === "website").length,
  );

  if (state.isToday) {
    return {
      isToday: true,
      unlockedFromAge,
      unlockedCount,
      headline: `Happy ${ordinal(age)} birthday, ${child.name}!`,
      message:
        unlockedCount > 0
          ? `You're ${age}! Install the profile to unlock ${phrase}.`
          : `You're ${age} today!`,
    };
  }

  return {
    isToday: false,
    unlockedFromAge,
    unlockedCount,
    headline: unlockedCount > 0 ? `New for age ${age}` : `Happy birthday, ${child.name}!`,
    message:
      unlockedCount > 0
        ? `${child.name} unlocked ${phrase}. Install the profile if you haven't yet.`
        : `Hope it was a great birthday.`,
  };
}

function buildUnifiedItems(
  apps: AppEntry[],
  systemApps: SystemApp[],
  websites: WebsiteEntry[],
  blockedApps: Set<string>,
  fromAgeByKey: Map<string, number>,
  unlockedFromAge: number | null,
): UnifiedItem[] {
  const items: UnifiedItem[] = [];

  const markNew = (key: string): boolean =>
    unlockedFromAge !== null && fromAgeByKey.get(key) === unlockedFromAge;

  for (const app of systemApps) {
    if (app.show_on_site === false) continue;
    items.push({
      kind: "system",
      name: app.name,
      url: app.app_store_url ?? "",
      key: app.bundle_id,
      category: app.category,
      icon: app.icon,
      icon_url: app.icon_url ?? appIconUrlPath(app) ?? undefined,
      static: !app.app_store_url,
      blocked: blockedApps.has(app.bundle_id),
      from_age: fromAgeByKey.get(app.bundle_id),
      isNew: markNew(app.bundle_id),
    });
  }

  for (const app of apps) {
    items.push({
      kind: "app",
      name: app.name,
      url: app.app_store_url,
      key: app.bundle_id,
      category: app.category,
      emoji: app.emoji,
      icon_url: app.icon_url ?? appIconUrlPath(app) ?? undefined,
      blocked: blockedApps.has(app.bundle_id),
      from_age: fromAgeByKey.get(app.bundle_id),
      isNew: markNew(app.bundle_id),
    });
  }

  for (const site of websites) {
    if (site.hidden) continue;
    items.push({
      kind: "website",
      name: site.name,
      url: site.url,
      key: site.url,
      category: site.category,
      icon_url: site.icon_url ?? websiteIconUrlPath(site) ?? undefined,
      from_age: fromAgeByKey.get(site.url),
      isNew: markNew(site.url),
    });
  }

  return items;
}

function groupItemsByCategory(items: UnifiedItem[]): UnifiedCategory[] {
  const groups = new Map<string, UnifiedItem[]>();
  for (const item of items) {
    const category = item.category ?? "Other";
    const list = groups.get(category) ?? [];
    list.push(item);
    groups.set(category, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, categoryItems]) => ({
      name,
      items: categoryItems.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function applicableBands(config: RootConfig, age: number): AgeBand[] {
  return config.age_bands
    .filter((band) => age >= band.from_age)
    .sort((a, b) => a.from_age - b.from_age);
}

export function computeProfileVersion(
  bundleIds: string[],
  websiteUrls: string[],
  subdomain: string
): string {
  const payload = [
    subdomain,
    ...[...bundleIds].sort(),
    ...[...websiteUrls].sort(),
  ].join("|");

  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

export function resolveChildConfig(
  config: RootConfig,
  subdomain: string,
  profileUpdatedAt: string,
  globalRestrictions: Restriction[] = [],
  asOf = new Date(),
): ResolvedChildConfig {
  const child = config.children.find((entry) => entry.subdomain === subdomain);
  if (!child) {
    throw new Error(`Unknown child subdomain: ${subdomain}`);
  }

  const age = calculateAge(child.date_of_birth, asOf);
  const bands = applicableBands(config, age);
  if (bands.length === 0) {
    throw new Error(`No age bands apply to ${child.name} (age ${age})`);
  }

  const theme = bands[bands.length - 1].theme;
  const defaultSubtitle = bands[bands.length - 1].subtitle;

  // Apps and system apps are gated by their own min_age (any age),
  // not by theme-band membership.
  const apps = dedupeApps(config.apps.filter((app) => age >= app.min_age));
  const system_apps = dedupeSystemApps(
    config.system_apps.filter((app) => age >= app.min_age)
  );

  // Shared websites gated by min_age; personal websites bypass age gating.
  const websites = dedupeWebsites([
    ...config.websites.filter((site) => site.min_age === undefined || age >= site.min_age),
    ...(child.personal_websites ?? []),
    {
      name: "Wainwright",
      url: `https://${config.domain}`,
      hidden: true,
    },
    {
      name: "Wainwright API",
      url: `https://api.${config.domain}`,
      hidden: true,
    },
    {
      name: "Snacks",
      url: `https://snacks.${config.domain}`,
      hidden: true,
      web_clip: true,
    },
    {
      name: "Tickets",
      url: `https://tickets.${config.domain}`,
      hidden: true,
      web_clip: true,
    },
    {
      name: `${child.name}'s previous page`,
      url: `https://${child.subdomain}.${config.domain}`,
      hidden: true,
    },
  ]);

  // from_age per item — the item's own min_age, not the band's.
  const fromAgeByKey = new Map<string, number>();
  for (const app of config.system_apps) {
    fromAgeByKey.set(app.bundle_id, app.min_age);
  }
  for (const app of config.apps) {
    fromAgeByKey.set(app.bundle_id, app.min_age);
  }
  for (const site of config.websites) {
    fromAgeByKey.set(site.url, site.min_age ?? 0);
  }
  for (const site of child.personal_websites ?? []) {
    fromAgeByKey.set(site.url, 0);
  }

  // Compute icon URLs for apps (in case enrichConfigWithIcons hasn't run,
  // e.g. when called from the site-rebuilder Lambda)
  const appsWithIcons = apps.map((a) => ({
    ...a,
    icon_url: a.icon_url ?? appIconUrlPath(a) ?? undefined,
  }));
  const systemAppsWithIcons = system_apps.map((a) => ({
    ...a,
    icon_url: a.icon_url ?? appIconUrlPath(a) ?? undefined,
  }));

  // Compute icon URLs for websites (in case enrichConfigWithIcons hasn't run,
  // e.g. when called from the site-rebuilder Lambda)
  const websitesWithIcons = websites.map((w) => ({
    ...w,
    icon_url: w.icon_url ?? websiteIconUrlPath(w) ?? undefined,
  }));

  const bundleIds = [
    ...systemAppsWithIcons.map((app) => app.bundle_id),
    ...appsWithIcons.map((app) => app.bundle_id),
  ];

  // Blocked apps for this child — excluded from the profile whitelist
  const blockedApps = child.blocked_apps ?? [];
  const blockedSet = new Set(blockedApps);

  // Profile version reflects the actual whitelist (blocked apps excluded)
  const whitelistedBundleIds = bundleIds.filter((id) => !blockedSet.has(id));
  const profileVersion = computeProfileVersion(
    whitelistedBundleIds,
    websitesWithIcons.map((site) => site.url),
    child.subdomain
  );

  const birthdayState = getBirthdayState(child.date_of_birth, asOf);
  const lastBand = bands[bands.length - 1];
  // During the birthday window, items whose min_age equals the child's new
  // age are "newly unlocked" — regardless of theme-band boundaries.
  const unlockedFromAge = birthdayState.celebrating ? age : null;

  const allItems = buildUnifiedItems(
    appsWithIcons,
    systemAppsWithIcons,
    websitesWithIcons,
    blockedSet,
    fromAgeByKey,
    unlockedFromAge,
  );
  const categories = theme === "little" ? [] : groupItemsByCategory(allItems);
  const justUnlocked = allItems
    .filter((item) => item.isNew && item.kind !== "system" && !item.blocked)
    .sort((a, b) => a.name.localeCompare(b.name));
  const birthday = buildBirthday(child, age, unlockedFromAge, justUnlocked, asOf);

  // Merge restrictions: global → theme overrides → child overrides
  const themeOverrides = (lastBand.restriction_overrides ?? []) as RestrictionOverride[];
  const childOverrides = (child.restriction_overrides ?? []) as RestrictionOverride[];
  const mergedRestrictions = mergeRestrictions(globalRestrictions, themeOverrides, childOverrides);

  let title = `${child.name}'s Apps`;
  let subtitle = defaultSubtitle;
  let profileButtonText = config.site.profile_button_text;
  let displayName = `${child.name} — Allowed Apps`;

  if (birthday?.isToday) {
    title = `Happy Birthday, ${child.name}!`;
    subtitle = birthday.message;
    displayName = `${child.name} — ${age} Today!`;
    if (birthday.unlockedCount > 0) {
      profileButtonText = "Unlock my birthday apps";
    }
  } else if (birthday && birthday.unlockedCount > 0) {
    profileButtonText = "Install to get new apps";
  }

  return {
    child,
    age,
    theme,
    domain: config.domain,
    siteUrl: `https://${config.domain}`,
    site: {
      title,
      subtitle,
      profile_button_text: profileButtonText,
    },
    profileVersion,
    profileUpdatedAt,
    system_apps: systemAppsWithIcons,
    websites: websitesWithIcons,
    apps: appsWithIcons,
    categories,
    items: allItems,
    justUnlocked,
    birthday,
    restrictions: mergedRestrictions,
    blocked_apps: blockedApps,
    profile: {
      display_name: displayName,
      identifier: `fun.wainwright.kids.${child.subdomain}`,
      organization: config.profile.organization,
      removal_disallowed: child.locked !== false,
    },
  };
}

export function listChildSubdomains(config: RootConfig): string[] {
  return config.children.map((child) => child.subdomain);
}

export function parseSubdomainFromHost(host: string, domain: string): string | null {
  const hostname = host.split(":")[0].toLowerCase();

  for (const suffix of [`.${domain.toLowerCase()}`, ".localhost"]) {
    if (!hostname.endsWith(suffix)) {
      continue;
    }

    const subdomain = hostname.slice(0, -suffix.length);
    if (subdomain && !subdomain.includes(".")) {
      return subdomain;
    }
  }

  return null;
}
