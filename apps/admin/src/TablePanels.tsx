import { useEffect, useState, useCallback } from "react";
import { IconGridEditor } from "./IconGridEditor";
import type { TableConfig } from "./TableEditor";
import type { FieldDef } from "./TableEditor";
import { TableEditor } from "./TableEditor";
import type { Child, App, Website, Theme } from "./api";
import { appIconUrl, websiteIconUrl } from "./iconUrl";
import { childAvatar, CHILD_COLOR_HEX, hexToRgba } from "./avatars";
import {
  getChildren, putChild, deleteChild,
  getApps, putApp, deleteApp,
  getWebsites, putWebsite, deleteWebsite,
  getThemes, putTheme, deleteTheme,
} from "./api";
import { PairQrCard } from "./PairQrCard";
import { RestrictionsPanel as RestrictionsPanelImpl } from "./RestrictionsPanel";
import { SnackBalanceCard } from "./SnackBalanceCard";

// ── Children ─────────────────────────────────────────────────────

const childrenConfig = (accessToken: string, opts: { includeSnacks?: boolean } = {}): TableConfig<Child> => ({
  entityName: "Child",
  pluralName: "Children",
  fields: [
    { name: "subdomain", label: "ID", type: "text", required: true, primaryKey: true },
    { name: "name", label: "Name", type: "text", required: true },
    { name: "date_of_birth", label: "Date of Birth", type: "text", required: true },
    { name: "color", label: "Color", type: "select", options: ["red", "green", "blue", "orange", "purple"], required: true },
    { name: "avatar", label: "Avatar", type: "avatar" },
    { name: "locked", label: "Locked", type: "boolean" },
    { name: "restriction_overrides", label: "Restriction Overrides", type: "restriction-overrides" },
    { name: "blocked_apps", label: "Blocked Apps", type: "blocked-apps" },
  ],
  editTabs: [
    { label: "Details", fields: ["subdomain", "name", "date_of_birth", "color", "avatar", "locked"] },
    { label: "Restrictions", fields: ["restriction_overrides", "blocked_apps"] },
    { label: "Pairing", fields: [], extras: true },
    ...(opts.includeSnacks === false ? [] : [{
      label: "Snacks",
      fields: [] as string[],
      extrasFn: (item: Record<string, unknown>, isNew: boolean) => {
        if (isNew) return null;
        const child = item as unknown as Child;
        return <SnackBalanceCard accessToken={accessToken} subdomain={child.subdomain} />;
      },
    }]),
  ],
  load: () => getChildren(accessToken),
  save: (item) => putChild(accessToken, item.subdomain, item),
  remove: (item) => deleteChild(accessToken, item.subdomain),
  emptyItem: () => ({ subdomain: "", name: "", date_of_birth: "", color: "blue", avatar: undefined, locked: true }),
  getKey: (item) => item.subdomain,
});

// ── Apps ──────────────────────────────────────────────────────────

/** Category options shared by apps, system apps, and websites. */
const CATEGORY_OPTIONS = [
  "Action Games", "Adventure", "Board Games", "Book", "Business", "Card Games",
  "Catalogs", "Developer Tools", "Education", "Entertainment", "Finance",
  "Food & Drink", "Games", "Graphics & Design", "Health & Fitness", "Kids",
  "Lifestyle", "Medical", "Music", "Navigation", "News", "Photo & Video",
  "Productivity", "Puzzles", "Reference", "Role Playing", "Shopping",
  "Social Networking", "Sports", "Strategy", "Travel", "Utilities",
  "Weather", "Word",
];

const appsConfig = (accessToken: string, type: "app" | "system"): TableConfig<App> => ({
  entityName: type === "system" ? "System App" : "App",
  fields: [
    { name: "app_store_url", label: "App Store URL", type: "text", prominent: true },
    { name: "bundle_id", label: "Bundle ID", type: "text", required: true, primaryKey: true },
    { name: "name", label: "Name", type: "text", required: true },
    { name: "category", label: "Category", type: "select", options: CATEGORY_OPTIONS },
    ...(type === "system" ? [
      { name: "icon", label: "Icon", type: "text" as const },
      { name: "show_on_site", label: "Show on Site", type: "boolean" as const },
    ] : []),
    { name: "min_age", label: "Min Age", type: "number", required: true },
    { name: "enabled", label: "Enabled", type: "boolean" },
  ],
  load: () => getApps(accessToken, type),
  save: (item) => putApp(accessToken, item.bundle_id, { ...item, type }),
  remove: (item) => deleteApp(accessToken, item.bundle_id),
  emptyItem: () => ({ bundle_id: "", name: "", type, app_store_url: "", category: "", icon: "", show_on_site: false, min_age: 0, enabled: true }),
  getKey: (item) => item.bundle_id,
});

// ── Websites ─────────────────────────────────────────────────────

const websiteFields = (childOptions: string[]): FieldDef[] => [
  { name: "url", label: "URL", type: "text", required: true, primaryKey: true },
  { name: "name", label: "Name", type: "text", required: true },
  { name: "icon", label: "Icon", type: "text" },
  { name: "category", label: "Category", type: "select", options: CATEGORY_OPTIONS },
  { name: "child_subdomain", label: "Child", type: "select", options: childOptions },
  { name: "min_age", label: "Min Age", type: "number", required: true },
  { name: "enabled", label: "Enabled", type: "boolean" },
];

// ── Themes ────────────────────────────────────────────────────────

const themesConfig = (accessToken: string): TableConfig<Theme> => ({
  entityName: "Theme",
  fields: [
    { name: "from_age", label: "From Age", type: "number", required: true, primaryKey: true },
    { name: "theme", label: "Theme", type: "select", options: ["little", "early", "primary", "teen"], required: true },
    { name: "subtitle", label: "Subtitle", type: "text", required: true },
    { name: "restriction_overrides", label: "Restriction Overrides", type: "restriction-overrides" },
  ],
  load: () => getThemes(accessToken),
  save: (item) => putTheme(accessToken, item.from_age, item),
  remove: (item) => deleteTheme(accessToken, item.from_age),
  emptyItem: () => ({ from_age: 0, theme: "little", subtitle: "" }),
  getKey: (item) => String(item.from_age),
});

// ── Exported components ───────────────────────────────────────────

export function ChildrenPanel({ accessToken, includeSnacks = true }: { accessToken: string; includeSnacks?: boolean }) {
  return (
    <IconGridEditor
      config={childrenConfig(accessToken, { includeSnacks }) as unknown as TableConfig<Record<string, unknown>>}
      iconUrl={() => null}
      fallbackEmoji="🌟"
      itemEmoji={(item) => childAvatar((item as unknown as Child).avatar)}
      itemBgColor={(item) => {
        const color = (item as unknown as Child).color;
        const hex = CHILD_COLOR_HEX[color];
        return hex ? hexToRgba(hex, 0.15) : undefined;
      }}
      accessToken={accessToken}
      editExtras={(item, isNew) => {
        if (isNew) return null;
        const child = item as unknown as Child;
        return <PairQrCard
          accessToken={accessToken}
          subdomain={child.subdomain}
          childName={child.name}
        />;
      }}
    />
  );
}

export function AppsPanel({ accessToken }: { accessToken: string }) {
  return (
    <IconGridEditor
      config={appsConfig(accessToken, "app") as unknown as TableConfig<Record<string, unknown>>}
      iconUrl={(item) => appIconUrl(item as unknown as App)}
      fallbackEmoji="📱"
    />
  );
}

export function SystemAppsPanel({ accessToken }: { accessToken: string }) {
  return (
    <IconGridEditor
      config={appsConfig(accessToken, "system") as unknown as TableConfig<Record<string, unknown>>}
      iconUrl={(item) => appIconUrl(item as unknown as App)}
      fallbackEmoji="⚙️"
    />
  );
}

export function WebsitesPanel({ accessToken }: { accessToken: string }) {
  const [children, setChildren] = useState<Child[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [childrenData, websitesData] = await Promise.all([
        getChildren(accessToken),
        getWebsites(accessToken),
      ]);
      setChildren(childrenData);
      setWebsites(websitesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  if (error) {
    return (
      <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
        {error}
      </div>
    );
  }

  // Child subdomain options for the select field (empty option = all children)
  const childSubdomains = children.map((c) => c.subdomain);
  const fields = websiteFields(childSubdomains);

  // Group websites: null child_subdomain = "All Children", otherwise per child
  const sharedWebsites = websites.filter((w) => !w.child_subdomain);
  const childSections = children.map((child) => ({
    child,
    websites: websites.filter((w) => w.child_subdomain === child.subdomain),
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* All Children section */}
      <WebsiteSection
        title="All Children"
        subtitle="Visible to every child based on min age"
        websites={sharedWebsites}
        fields={fields}
        accessToken={accessToken}
        childSubdomain={undefined}
        onReload={load}
      />

      {/* Per-child sections */}
      {childSections.map(({ child, websites: childWebsites }) => (
        <WebsiteSection
          key={child.subdomain}
          title={child.name}
          subtitle={`Personal to ${child.name} only`}
          websites={childWebsites}
          fields={fields}
          accessToken={accessToken}
          childSubdomain={child.subdomain}
          onReload={load}
          accentEmoji={childAvatar(child.avatar)}
        />
      ))}
    </div>
  );
}

// ── Website section (one per group) ──────────────────────────────

function WebsiteSection({
  title,
  subtitle,
  websites,
  fields,
  accessToken,
  childSubdomain,
  onReload,
  accentEmoji,
}: {
  title: string;
  subtitle: string;
  websites: Website[];
  fields: FieldDef[];
  accessToken: string;
  childSubdomain: string | undefined;
  onReload: () => Promise<void>;
  accentEmoji?: string;
}) {
  const config: TableConfig<Website> = {
    entityName: "Website",
    pluralName: title,
    fields,
    load: async () => websites,
    save: async (item) => {
      const result = await putWebsite(accessToken, item.url, item);
      await onReload();
      return result;
    },
    remove: async (item) => {
      await deleteWebsite(accessToken, item.url);
      await onReload();
    },
    emptyItem: () => ({
      url: "",
      name: "",
      icon: "",
      category: "",
      min_age: 0,
      enabled: true,
      child_subdomain: childSubdomain,
    }),
    getKey: (item) => item.url,
  };

  return (
    <div>
      <IconGridEditor
        config={config as unknown as TableConfig<Record<string, unknown>>}
        iconUrl={(item) => websiteIconUrl(item as unknown as Website)}
        fallbackEmoji={accentEmoji ?? "🌐"}
        subtitle={subtitle}
      />
    </div>
  );
}

export function ThemesPanel({ accessToken }: { accessToken: string }) {
  return <TableEditor config={themesConfig(accessToken) as unknown as TableConfig<Record<string, unknown>>} />;
}

export function RestrictionsPanel({ accessToken }: { accessToken: string }) {
  return <RestrictionsPanelImpl accessToken={accessToken} />;
}
