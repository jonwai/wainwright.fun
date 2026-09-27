import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import type { FieldDef, TableConfig } from "./TableEditor";
import { Modal } from "./Modal";
import { lookupApp } from "./appStoreLookup";
import { AvatarPicker } from "./AvatarPicker";
import { RESTRICTION_CATALOG, getRestrictionMeta, type RestrictionOverride } from "../../shared/restriction-catalog";
import { getApps, type App } from "./api";

// ── Icon grid editor ─────────────────────────────────────────────
// Shows items as a grid of icons (like the child sites). Clicking an
// icon opens an edit panel below the grid. Supports search.

interface IconGridEditorProps<T> {
  config: TableConfig<T>;
  iconUrl: (item: T) => string | null;
  /** Fallback emoji when no icon is available. */
  fallbackEmoji?: string;
  /**
   * Per-item fallback emoji — overrides fallbackEmoji when the item
   * has its own emoji (e.g. a child's avatar). Called for each item
   * in the grid and edit form preview.
   */
  itemEmoji?: (item: T) => string | undefined;
  /**
   * Per-item background colour for the icon container — used when
   * there's no image icon (e.g. a child's avatar on their colour).
   */
  itemBgColor?: (item: T) => string | undefined;
  /** Whether to show a search bar. Defaults to true. */
  searchable?: boolean;
  /** Optional subtitle shown below the section title. */
  subtitle?: string;
  /** Access token for fields that need to fetch additional data (e.g. blocked-apps). */
  accessToken?: string;
  /** Extra UI rendered at the top of the edit form. */
  editExtras?: (item: T, isNew: boolean) => ReactNode;
}

export function IconGridEditor<T extends Record<string, unknown>>({
  config,
  iconUrl,
  fallbackEmoji = "📱",
  itemEmoji,
  itemBgColor,
  searchable = true,
  subtitle,
  accessToken,
  editExtras,
}: IconGridEditorProps<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<T | null>(null);
  const [original, setOriginal] = useState<T | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await config.load();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await config.save(editing);
      await load();
      setEditing(null);
      setOriginal(null);
      setIsNew(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleEdit(item: T) {
    setEditing({ ...item });
    setOriginal({ ...item });
    setIsNew(false);
  }

  async function handleDelete(item: T) {
    try {
      await config.remove(item);
      await load();
      setEditing(null);
      setOriginal(null);
      setIsNew(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function handleAdd() {
    setEditing(config.emptyItem());
    setOriginal(null);
    setIsNew(true);
  }

  function handleFieldChange(name: string, value: unknown) {
    setEditing((prev) => prev ? { ...prev, [name]: value } : prev);
  }

  const filteredItems = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) =>
      config.fields.some((f) =>
        String(item[f.name] ?? "").toLowerCase().includes(normalized)
      )
    );
  }, [items, searchQuery, config.fields]);

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-extrabold tracking-wider uppercase text-muted">
          {config.pluralName ?? `${config.entityName}s`}
        </h2>
        <button
          className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-white text-sm font-semibold no-underline cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleAdd}
        >
          Add {config.entityName}
        </button>
      </div>

      {subtitle && (
        <p className="text-xs text-muted -mt-2">{subtitle}</p>
      )}

      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}

      {/* Edit form in modal */}
      {editing && (
        <Modal
          title={isNew ? `New ${config.entityName}` : config.entityName}
          onClose={() => {
            setEditing(null);
            setIsNew(false);
          }}
        >
          <EditForm
            config={config}
            editing={editing}
            original={original ?? undefined}
            isNew={isNew}
            saving={saving}
            onFieldChange={handleFieldChange}
            onSave={handleSave}
            onCancel={() => {
              setEditing(null);
              setOriginal(null);
              setIsNew(false);
            }}
            onDelete={handleDelete}
            iconUrl={iconUrl}
            fallbackEmoji={fallbackEmoji}
            itemEmoji={itemEmoji}
            itemBgColor={itemBgColor}
            accessToken={accessToken}
            extras={editExtras?.(editing, isNew)}
          />
        </Modal>
      )}

      {/* Search bar */}
      {searchable && items.length > 0 && (
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Search ${(config.pluralName ?? `${config.entityName}s`).toLowerCase()}…`}
          autoComplete="off"
          spellCheck={false}
          className="w-full min-h-12 p-3.5 px-4 border border-border rounded-md bg-surface-solid text-text text-base focus:outline-2 focus:outline-accent focus:outline-offset-2"
        />
      )}

      {/* Icon grid */}
      {filteredItems.length === 0 ? (
        <p className="text-muted text-sm text-center py-8">
          {items.length === 0
            ? `No ${(config.pluralName ?? `${config.entityName}s`).toLowerCase()} yet. Click "Add ${config.entityName}" to create one.`
            : "No results match your search."}
        </p>
      ) : (
        <ul className="icon-grid">
          {filteredItems.map((item) => {
            const url = iconUrl(item);
            const key = config.getKey(item);
            const nameField = config.fields.find((f) => f.name === "name");
            const label = nameField ? String(item[nameField.name] ?? key) : key;
            const isActive = editing && !isNew && config.getKey(editing) === key;
            const emoji = itemEmoji?.(item) ?? fallbackEmoji;
            const bgColor = itemBgColor?.(item);

            return (
              <li key={key} className="flex justify-center min-w-0">
                <button
                  className={`flex flex-col items-center gap-2 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none text-inherit text-center appearance-none cursor-pointer transition-transform duration-150 ease-out hover:-translate-y-0.5 active:scale-95 ${
                    isActive ? "ring-2 ring-accent rounded-md" : ""
                  }`}
                  onClick={() => handleEdit(item)}
                  title={label}
                >
                  <div className="relative">
                    <div
                      className={`flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-solid overflow-hidden ${
                        url ? "" : bgColor ? "" : "bg-accent-soft"
                      }`}
                      style={{
                        backgroundColor: bgColor || undefined,
                        boxShadow:
                          "0 10px 24px rgba(27,27,47,0.08), inset 0 0 0 1px rgba(27,27,47,0.06)",
                      }}
                    >
                      {url ? (
                        <img
                          src={url}
                          alt=""
                          className="app-icon-image"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span className="text-2xl leading-none">{emoji}</span>
                      )}
                    </div>
                    {(() => {
                      const blocked = item.blocked_apps as string[] | undefined;
                      if (!blocked || blocked.length === 0) return null;
                      return (
                        <span
                          className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-danger text-white text-[0.625rem] font-bold leading-none border-2 border-surface"
                          title={`${blocked.length} blocked app${blocked.length === 1 ? "" : "s"}`}
                        >
                          🚫{blocked.length}
                        </span>
                      );
                    })()}
                  </div>
                  <span className="w-full max-w-[6.5rem] text-xs font-bold leading-tight text-center text-text overflow-hidden text-ellipsis line-clamp-2">
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Edit form (shared between grid and table editors) ───────────

interface EditFormProps<T> {
  config: TableConfig<T>;
  editing: T;
  /** Snapshot of the item before editing started. Used to show "was: X" labels. */
  original?: T;
  isNew: boolean;
  saving: boolean;
  onFieldChange: (name: string, value: unknown) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: (item: T) => void;
  iconUrl?: (item: T) => string | null;
  fallbackEmoji?: string;
  itemEmoji?: (item: T) => string | undefined;
  itemBgColor?: (item: T) => string | undefined;
  /** Access token for fields that need to fetch additional data (e.g. blocked-apps). */
  accessToken?: string;
  extras?: ReactNode;
}

export function EditForm<T extends Record<string, unknown>>({
  config,
  editing,
  original,
  isNew,
  saving,
  onFieldChange,
  onSave,
  onCancel,
  onDelete,
  iconUrl,
  fallbackEmoji = "📱",
  itemEmoji,
  itemBgColor,
  accessToken,
  extras,
}: EditFormProps<T>) {
  const previewUrl = iconUrl?.(editing);
  const previewEmoji = itemEmoji?.(editing) ?? fallbackEmoji;
  const previewBgColor = itemBgColor?.(editing);

  // ── Edit modal tabs ─────────────────────────────────────────
  const tabs = config.editTabs;
  const [activeTab, setActiveTab] = useState(0);
  // Reset to the first tab when a different item is opened. Keyed on the item's
  // key (not the editing object, which changes identity on every field edit).
  const editingKey = isNew ? "__new__" : config.getKey(editing);
  useEffect(() => {
    setActiveTab(0);
  }, [editingKey]);

  /**
   * Assign each field to a tab: fields named in a tab's `fields` list go there;
   * any field not claimed by a tab lands on the first tab. Returns the
   * per-tab field lists plus which tab (if any) carries the extras node.
   */
  const tabGroups = useMemo(() => {
    if (!tabs) return null;
    const claimed = new Set(tabs.flatMap((t) => t.fields));
    const perTab: FieldDef[][] = tabs.map((t) => {
      const byName = new Map(config.fields.map((f) => [f.name, f]));
      return t.fields.map((name) => byName.get(name)).filter((f): f is FieldDef => Boolean(f));
    });
    // Unclaimed fields (incl. any added later) default to the first tab.
    perTab[0] = [
      ...config.fields.filter((f) => !claimed.has(f.name)),
      ...perTab[0],
    ];
    const extrasTab = tabs.findIndex((t) => t.extras);
    // Per-tab extras nodes (extrasFn) — rendered instead of the entity-level
    // extras node when their tab is active.
    const perTabExtras = tabs.map((t) => t.extrasFn?.(editing, isNew) ?? null);
    return { perTab, extrasTab, perTabExtras };
  }, [tabs, config.fields, editing, isNew]);

  /** Show a field only when tabs are off or it belongs to the active tab. */
  function fieldVisible(field: FieldDef): boolean {
    if (!tabGroups) return true;
    return tabGroups.perTab[activeTab].some((f) => f.name === field.name);
  }

  // The active tab's extras: a per-tab extrasFn node wins over the
  // entity-level extras node (which only renders on its extrasTab).
  const activeTabExtras = tabGroups?.perTabExtras[activeTab] ?? null;
  const showExtras =
    activeTabExtras !== null ||
    !tabGroups ||
    tabGroups.extrasTab === activeTab;

  /** For new items the extras node is null — hide tabs that would be empty. */
  const visibleTabs = useMemo(() => {
    if (!tabs || !tabGroups) return tabs;
    return tabs.filter(
      (_, i) =>
        tabGroups.perTab[i].length > 0 ||
        (Boolean(tabs[i]?.extras) && extras !== null && extras !== undefined) ||
        tabGroups.perTabExtras[i] !== null,
    );
  }, [tabs, tabGroups, isNew, extras]);

  // ── App Store auto-fetch ──────────────────────────────────────
  const hasAppStoreUrl = config.fields.some((f) => f.name === "app_store_url");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const lastFetchedUrl = useRef<string>("");

  const appStoreUrl = hasAppStoreUrl ? String(editing.app_store_url ?? "") : "";

  async function doFetch() {
    if (!appStoreUrl) return;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await lookupApp(appStoreUrl);
      if (!result) {
        setFetchError("App not found on the App Store");
        return;
      }
      // Fill in fields that exist on this config.
      // Use a single batch update to avoid stale-closure overwrites.
      const updates: Record<string, unknown> = {};
      if (config.fields.some((f) => f.name === "name"))
        updates.name = result.name;
      if (config.fields.some((f) => f.name === "bundle_id"))
        updates.bundle_id = result.bundleId;
      if (config.fields.some((f) => f.name === "category"))
        updates.category = result.category;
      if (config.fields.some((f) => f.name === "min_age"))
        updates.min_age = result.minAge;
      // Store the Apple-hosted icon URL so the preview can use it
      if (result.iconUrl)
        updates.icon_url = result.iconUrl;
      for (const [name, value] of Object.entries(updates)) {
        onFieldChange(name, value);
      }
      setFetched(true);
    } catch {
      setFetchError("Failed to fetch from App Store");
    } finally {
      setFetching(false);
    }
  }

  // Auto-fetch when URL changes on new items (debounced)
  useEffect(() => {
    if (!isNew || !hasAppStoreUrl || !appStoreUrl) return;
    if (lastFetchedUrl.current === appStoreUrl) return;

    const timer = setTimeout(() => {
      lastFetchedUrl.current = appStoreUrl;
      doFetch();
    }, 600);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStoreUrl, isNew, hasAppStoreUrl]);

  // Split fields: prominent ones render full-width above the grid
  const prominentFields = config.fields.filter((f) => f.prominent);
  const avatarFields = config.fields.filter((f) => f.type === "avatar" && !f.prominent);
  const restrictionOverrideFields = config.fields.filter((f) => f.type === "restriction-overrides");
  const blockedAppsFields = config.fields.filter((f) => f.type === "blocked-apps");
  const regularFields = config.fields.filter((f) => !f.prominent && f.type !== "avatar" && f.type !== "restriction-overrides" && f.type !== "blocked-apps");

  return (
    <div>
      {/* Preview + title */}
      {previewUrl !== undefined && (
        <div className="flex items-center gap-3 mb-4">
          <div
            className="flex items-center justify-center w-12 h-12 rounded-xl overflow-hidden shrink-0"
            style={{
              backgroundColor: previewBgColor || undefined,
              boxShadow:
                "0 10px 24px rgba(27,27,47,0.08), inset 0 0 0 1px rgba(27,27,47,0.06)",
            }}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="" className="app-icon-image" />
            ) : (
              <span className="text-xl leading-none">{previewEmoji}</span>
            )}
          </div>
          <span className="text-sm text-muted">
            {isNew ? `Creating a new ${config.entityName.toLowerCase()}` : `Editing ${config.getKey(editing)}`}
          </span>
        </div>
      )}

      {/* Tab strip (only when the config defines tabs) */}
      {visibleTabs && tabGroups && (
        <div role="tablist" className="flex gap-1 -mb-px border-b border-border mb-4 overflow-x-auto no-scrollbar">
          {visibleTabs.map((tab) => {
            const i = tabs!.indexOf(tab);
            return (
              <button
                key={tab.label}
                type="button"
                role="tab"
                aria-selected={i === activeTab}
                onClick={() => setActiveTab(i)}
                className={`shrink-0 whitespace-nowrap border-none border-b-2 px-3 py-2 text-sm font-medium cursor-pointer transition-colors ${
                  i === activeTab
                    ? "text-accent border-accent -mb-px"
                    : "text-muted border-transparent hover:text-text"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab extras: a per-tab extrasFn node wins; otherwise the entity-level
          extras node renders on its own tab (extrasTab). */}
      {showExtras && (activeTabExtras ?? extras)}

      {/* Prominent fields (e.g. App Store URL) */}
      {prominentFields.filter(fieldVisible).length > 0 && (
        <div className="flex flex-col gap-3 mb-4">
          {prominentFields.filter(fieldVisible).map((field) => (
            <div key={field.name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-muted font-medium">{field.label}</label>
                {hasAppStoreUrl && field.name === "app_store_url" && (
                  <FetchButton
                    isNew={isNew}
                    fetching={fetching}
                    fetched={fetched}
                    hasUrl={Boolean(appStoreUrl)}
                    onClick={doFetch}
                  />
                )}
              </div>
              <input
                type="text"
                value={String(editing[field.name] ?? "")}
                onChange={(e) => {
                  onFieldChange(field.name, e.target.value);
                  if (field.name === "app_store_url") {
                    setFetched(false);
                    setFetchError(null);
                  }
                }}
                disabled={Boolean(field.primaryKey && !isNew)}
                className="w-full bg-surface-solid text-text border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="https://apps.apple.com/…/id123456789"
              />
              <ChangedLabel field={field} current={editing[field.name]} original={original?.[field.name]} />
              {hasAppStoreUrl && field.name === "app_store_url" && fetchError && (
                <span className="text-xs text-danger">{fetchError}</span>
              )}
              {hasAppStoreUrl && field.name === "app_store_url" && fetched && !fetchError && (
                <span className="text-xs text-success">✓ Details fetched from App Store</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Regular fields */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 mb-4">
        {regularFields.filter(fieldVisible).map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={editing[field.name]}
            original={original?.[field.name]}
            disabled={Boolean(field.primaryKey && !isNew)}
            onChange={(v) => onFieldChange(field.name, v)}
          />
        ))}
      </div>

      {/* Avatar picker fields (full-width) */}
      {avatarFields.filter(fieldVisible).length > 0 && (
        <div className="flex flex-col gap-3 mb-4">
          {avatarFields.filter(fieldVisible).map((field) => (
            <div key={field.name} className="flex flex-col gap-1">
              <label className="text-xs text-muted font-medium">{field.label}</label>
              <AvatarPicker
                value={String(editing[field.name] ?? "")}
                onChange={(emoji) => onFieldChange(field.name, emoji)}
              />
              <ChangedLabel field={field} current={editing[field.name]} original={original?.[field.name]} />
            </div>
          ))}
        </div>
      )}

      {/* Restriction override fields (full-width) */}
      {restrictionOverrideFields.filter(fieldVisible).length > 0 && (
        <RestrictionOverridesEditor
          fields={restrictionOverrideFields.filter(fieldVisible)}
          editing={editing}
          onFieldChange={onFieldChange}
        />
      )}

      {/* Blocked apps fields (full-width) */}
      {blockedAppsFields.filter(fieldVisible).length > 0 && (
        <BlockedAppsEditor
          fields={blockedAppsFields.filter(fieldVisible)}
          editing={editing}
          onFieldChange={onFieldChange}
          accessToken={accessToken}
        />
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-white text-sm font-semibold no-underline cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-text text-sm font-semibold cursor-pointer border-none bg-surface-hover transition-colors hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        {!isNew && onDelete && (
          <button
            className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-danger text-sm font-semibold cursor-pointer border-none bg-transparent hover:bg-red-50 ml-auto"
            onClick={() => {
              if (confirm(`Delete ${config.entityName} "${config.getKey(editing)}"?`)) {
                onDelete(editing);
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ── Fetch button ─────────────────────────────────────────────────

function FetchButton({
  isNew,
  fetching,
  fetched,
  hasUrl,
  onClick,
}: {
  isNew: boolean;
  fetching: boolean;
  fetched: boolean;
  hasUrl: boolean;
  onClick: () => void;
}) {
  if (isNew) {
    // Auto-fetch handles new items — just show status
    if (fetching) return <span className="text-xs text-muted">Fetching…</span>;
    if (fetched) return <span className="text-xs text-success">✓ Fetched</span>;
    return null;
  }

  // Existing items get a manual fetch button
  return (
    <button
      type="button"
      className="text-xs text-accent font-semibold cursor-pointer border-none bg-transparent hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={onClick}
      disabled={fetching || !hasUrl}
    >
      {fetching ? "Fetching…" : fetched ? "↻ Refetch" : "↻ Fetch from App Store"}
    </button>
  );
}

// ── Field input ──────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  original,
  disabled,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  original?: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const inputClass =
    "w-full bg-surface-solid text-text border border-border rounded-md px-2 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted font-medium">{field.label}</label>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="w-[18px] h-[18px] cursor-pointer mt-1"
        />
      ) : field.type === "select" ? (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={inputClass}
        >
          <option value="">—</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(
              field.type === "number" ? Number(e.target.value) : e.target.value
            )
          }
          disabled={disabled}
          className={inputClass}
        />
      )}
      <ChangedLabel field={field} current={value} original={original} />
    </div>
  );
}

// ── Changed label ─────────────────────────────────────────────────

function ChangedLabel({
  field,
  current,
  original,
}: {
  field: FieldDef;
  current: unknown;
  original?: unknown;
}) {
  if (original === undefined) return null;

  const currentStr = field.type === "boolean" ? (current ? "✓" : "✗") : String(current ?? "");
  const originalStr = field.type === "boolean" ? (original ? "✓" : "✗") : String(original ?? "");

  if (currentStr === originalStr) return null;

  return (
    <span className="text-xs text-muted italic">
      was: {originalStr || "(empty)"}
    </span>
  );
}

// ── Restriction overrides editor ──────────────────────────────────

function RestrictionOverridesEditor({
  fields,
  editing,
  onFieldChange,
}: {
  fields: FieldDef[];
  editing: Record<string, unknown>;
  onFieldChange: (name: string, value: unknown) => void;
}) {
  // Only show restrictions marked as overridable in the catalog
  const overridableRestrictions = RESTRICTION_CATALOG.filter((r) => r.overridable);

  return (
    <div className="flex flex-col gap-3 mb-4">
      {fields.map((field) => {
        const overrides = (editing[field.name] as RestrictionOverride[] | undefined) ?? [];
        const overrideMap = new Map(overrides.map((o) => [o.key, o.value]));

        function toggleOverride(key: string, enabled: boolean) {
          if (enabled) {
            const meta = getRestrictionMeta(key);
            const value = meta?.defaultValue ?? false;
            onFieldChange(field.name, [...overrides, { key, value }]);
          } else {
            onFieldChange(field.name, overrides.filter((o) => o.key !== key));
          }
        }

        function setOverrideValue(key: string, value: boolean | number | string) {
          onFieldChange(
            field.name,
            overrides.map((o) => (o.key === key ? { ...o, value } : o)),
          );
        }

        return (
          <div key={field.name} className="flex flex-col gap-2">
            <label className="text-xs text-muted font-medium">{field.label}</label>
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-hover">
                    <th className="px-2 py-1.5 text-left text-muted font-semibold uppercase tracking-wider">
                      Key
                    </th>
                    <th className="px-2 py-1.5 text-left text-muted font-semibold uppercase tracking-wider">
                      Override
                    </th>
                    <th className="px-2 py-1.5 text-left text-muted font-semibold uppercase tracking-wider">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overridableRestrictions.map((meta) => {
                    const hasOverride = overrideMap.has(meta.key);
                    return (
                      <tr key={meta.key} className="border-t border-border">
                        <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                          {meta.key}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={hasOverride}
                            onChange={(e) => toggleOverride(meta.key, e.target.checked)}
                            className="w-[16px] h-[16px] cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          {hasOverride && meta.type === "boolean" ? (
                            <input
                              type="checkbox"
                              checked={Boolean(overrideMap.get(meta.key))}
                              onChange={(e) => setOverrideValue(meta.key, e.target.checked)}
                              className="w-[16px] h-[16px] cursor-pointer"
                            />
                          ) : hasOverride && (meta.type === "integer" || meta.type === "real") ? (
                            <input
                              type="number"
                              value={String(overrideMap.get(meta.key) ?? "")}
                              onChange={(e) => setOverrideValue(meta.key, Number(e.target.value))}
                              className="w-full bg-surface-solid text-text border border-border rounded px-1.5 py-1 text-xs focus:outline-none focus:border-accent"
                            />
                          ) : hasOverride ? (
                            <input
                              type="text"
                              value={String(overrideMap.get(meta.key) ?? "")}
                              onChange={(e) => setOverrideValue(meta.key, e.target.value)}
                              className="w-full bg-surface-solid text-text border border-border rounded px-1.5 py-1 text-xs focus:outline-none focus:border-accent"
                            />
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Blocked apps editor ───────────────────────────────────────────

function BlockedAppsEditor({
  fields,
  editing,
  onFieldChange,
  accessToken,
}: {
  fields: FieldDef[];
  editing: Record<string, unknown>;
  onFieldChange: (name: string, value: unknown) => void;
  accessToken?: string;
}) {
  const [allApps, setAllApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!accessToken) {
      setLoading(false);
      return;
    }
    getApps(accessToken)
      .then((apps) => {
        setAllApps(apps.sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => setAllApps([]))
      .finally(() => setLoading(false));
  }, [accessToken]);

  const filteredApps = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return allApps;
    return allApps.filter((a) =>
      a.name.toLowerCase().includes(normalized) ||
      a.bundle_id.toLowerCase().includes(normalized)
    );
  }, [allApps, search]);

  return (
    <div className="flex flex-col gap-3 mb-4">
      {fields.map((field) => {
        const blocked = (editing[field.name] as string[] | undefined) ?? [];
        const blockedSet = new Set(blocked);

        function toggleBundleId(bundleId: string, enabled: boolean) {
          if (enabled) {
            onFieldChange(field.name, [...blocked, bundleId]);
          } else {
            onFieldChange(field.name, blocked.filter((id) => id !== bundleId));
          }
        }

        return (
          <div key={field.name} className="flex flex-col gap-2">
            <label className="text-xs text-muted font-medium">{field.label}</label>
            <p className="text-xs text-muted italic -mt-1">
              Blocked apps appear semi-transparent and unclickable on the child's site,
              and are excluded from the profile whitelist so they cannot be downloaded.
            </p>
            {loading ? (
              <div className="spinner" />
            ) : allApps.length === 0 ? (
              <p className="text-xs text-muted">No apps available to block.</p>
            ) : (
              <>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search apps…"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-surface-solid text-text border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
                />
                <div className="border border-border rounded-md overflow-hidden max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <tbody>
                      {filteredApps.map((app) => {
                        const isBlocked = blockedSet.has(app.bundle_id);
                        return (
                          <tr key={app.bundle_id} className="border-t border-border first:border-t-0">
                            <td className="px-2 py-1.5 w-8 text-center">
                              <input
                                type="checkbox"
                                checked={isBlocked}
                                onChange={(e) => toggleBundleId(app.bundle_id, e.target.checked)}
                                className="w-[16px] h-[16px] cursor-pointer"
                              />
                            </td>
                            <td className="px-2 py-1.5 font-semibold whitespace-nowrap">
                              {app.name}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-muted text-xs">
                              {app.bundle_id}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {blocked.length > 0 && (
                  <p className="text-xs text-muted">
                    {blocked.length} app{blocked.length === 1 ? "" : "s"} blocked
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
