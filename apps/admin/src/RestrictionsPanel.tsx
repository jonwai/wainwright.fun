import { useEffect, useState, useCallback, useMemo } from "react";
import type { Restriction } from "./api";
import { getRestrictions, putRestriction, deleteRestriction } from "./api";
import {
  RESTRICTION_CATALOG,
  getRestrictionMeta,
  isDefaultValue,
  recommendationStatus,
  type RestrictionMeta,
} from "../../../packages/shared/restriction-catalog";
import { Modal } from "./Modal";

// ── Types ──────────────────────────────────────────────────────────

interface RestrictionRow extends Restriction {
  meta: RestrictionMeta | null;
  isDefault: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

function toRow(r: Restriction): RestrictionRow {
  const meta = getRestrictionMeta(r.key);
  return {
    ...r,
    meta,
    isDefault: isDefaultValue(r.key, r.value),
  };
}

function formatValue(value: boolean | number | string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function formatDefault(meta: RestrictionMeta | null): string {
  if (!meta || meta.defaultValue === null) return "—";
  if (typeof meta.defaultValue === "boolean") return meta.defaultValue ? "true" : "false";
  return String(meta.defaultValue);
}

// ── Component ──────────────────────────────────────────────────────

export function RestrictionsPanel({ accessToken }: { accessToken: string }) {
  const [items, setItems] = useState<Restriction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Restriction | null>(null);
  const [original, setOriginal] = useState<Restriction | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDefaults, setShowDefaults] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRestrictions(accessToken);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await putRestriction(accessToken, editing.key, editing);
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

  async function handleDelete(item: Restriction) {
    try {
      await deleteRestriction(accessToken, item.key);
      await load();
      setEditing(null);
      setOriginal(null);
      setIsNew(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function handleEdit(item: Restriction) {
    setEditing({ ...item });
    setOriginal({ ...item });
    setIsNew(false);
  }

  function handleAdd() {
    setEditing({ key: "", type: "boolean", value: false });
    setOriginal(null);
    setIsNew(true);
  }

  function handleFieldChange(name: string, value: unknown) {
    setEditing((prev) => prev ? { ...prev, [name]: value } : prev);
  }

  // Build merged list: stored restrictions + catalog entries not yet stored
  const rows = useMemo<RestrictionRow[]>(() => {
    const storedMap = new Map(items.map((r) => [r.key, r]));
    const result: RestrictionRow[] = [];

    // First, all stored restrictions (sorted by key)
    for (const item of items.sort((a, b) => a.key.localeCompare(b.key))) {
      result.push(toRow(item));
    }

    // Then, catalog entries not yet stored (so the user can see all known restrictions)
    for (const meta of RESTRICTION_CATALOG) {
      if (!storedMap.has(meta.key)) {
        result.push({
          key: meta.key,
          type: meta.type,
          value: meta.defaultValue ?? false,
          overridable: meta.overridable,
          meta,
          isDefault: true,
        });
      }
    }

    return result;
  }, [items]);

  const filteredRows = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => {
      const meta = row.meta;
      const haystack = [
        row.key,
        meta?.description ?? "",
        meta?.recommendation ?? "",
        formatValue(row.value),
      ].join(" ").toLowerCase();
      return haystack.includes(normalized);
    });
  }, [rows, searchQuery]);

  const visibleRows = useMemo(
    () => (showDefaults ? filteredRows : filteredRows.filter((r) => !r.isDefault)),
    [filteredRows, showDefaults],
  );

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-extrabold tracking-wider uppercase text-muted">
          Restrictions
        </h2>
        <button
          className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-white text-sm font-semibold no-underline cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleAdd}
        >
          Add Restriction
        </button>
      </div>

      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}

      {/* Edit form in modal */}
      {editing && (
        <Modal
          title={isNew ? "New Restriction" : "Restriction"}
          onClose={() => {
            setEditing(null);
            setIsNew(false);
          }}
        >
          <RestrictionEditForm
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
          />
        </Modal>
      )}

      {/* Search + filter */}
      <div className="flex items-center gap-4 flex-wrap">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search restrictions…"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-[200px] min-h-12 p-3.5 px-4 border border-border rounded-md bg-surface-solid text-text text-base focus:outline-2 focus:outline-accent focus:outline-offset-2"
        />
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={showDefaults}
            onChange={(e) => setShowDefaults(e.target.checked)}
            className="w-[18px] h-[18px] cursor-pointer"
          />
          Show default values
        </label>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Key
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Value
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Default
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider">
                Description
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider">
                Recommendation
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Status
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Override
              </th>
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted text-sm">
                  No restrictions match your search.
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const isStored = items.some((i) => i.key === row.key);
                return (
                  <tr
                    key={row.key}
                    className={`border-b border-border hover:bg-surface-hover ${
                      row.isDefault ? "opacity-40" : ""
                    }`}
                  >
                    <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap font-mono text-xs">
                      {row.key}
                    </td>
                    <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap">
                      {formatValue(row.value)}
                    </td>
                    <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap text-muted text-xs">
                      {formatDefault(row.meta)}
                    </td>
                    <td className="px-3 py-2 text-left border-b border-border text-xs text-muted max-w-xs">
                      {row.meta?.description ?? (
                        <span className="italic">Unknown restriction key</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-left border-b border-border text-xs text-muted max-w-xs">
                      {row.meta?.recommendation ?? ""}
                    </td>
                    <td className="px-3 py-2 border-b border-border whitespace-nowrap text-xs">
                      {(() => {
                        const status = recommendationStatus(row.key, row.value);
                        if (status === "accepted")
                          return <span className="text-success font-semibold">✓ Accepted</span>;
                        if (status === "ignored")
                          return <span className="text-warning font-semibold">⚠ Ignored</span>;
                        return <span className="text-muted">—</span>;
                      })()}
                    </td>
                    <td className="px-3 py-2 border-b border-border whitespace-nowrap text-xs">
                      {row.overridable ? (
                        <span className="text-accent font-semibold">✓ Yes</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                      {isStored ? (
                        <button
                          className="bg-none border-none text-accent cursor-pointer text-xs hover:underline"
                          onClick={() => handleEdit(row)}
                        >
                          Edit
                        </button>
                      ) : (
                        <button
                          className="bg-none border-none text-accent cursor-pointer text-xs hover:underline"
                          onClick={() => handleEdit({ key: row.key, type: row.type, value: row.value })}
                        >
                          Add
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Edit form ───────────────────────────────────────────────────────

function RestrictionEditForm({
  editing,
  isNew,
  saving,
  onFieldChange,
  onSave,
  onCancel,
  onDelete,
}: {
  editing: Restriction;
  original?: Restriction;
  isNew: boolean;
  saving: boolean;
  onFieldChange: (name: string, value: unknown) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (item: Restriction) => void;
}) {
  const meta = getRestrictionMeta(editing.key);
  const inputClass =
    "w-full bg-surface-solid text-text border border-border rounded-md px-2 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div>
      {/* Description + recommendation */}
      {meta && (
        <div className="mb-4 flex flex-col gap-2">
          {meta.description && (
            <p className="text-xs text-muted leading-relaxed">{meta.description}</p>
          )}
          {meta.recommendation && (
            <p className="text-xs text-muted italic">
              <span className="font-semibold">Recommendation:</span> {meta.recommendation}
            </p>
          )}
          {meta.defaultValue !== null && (
            <p className="text-xs text-muted">
              <span className="font-semibold">Default:</span> {formatDefault(meta)}
            </p>
          )}
          {(() => {
            const status = recommendationStatus(editing.key, editing.value);
            if (status === "accepted")
              return <p className="text-xs text-success font-semibold">✓ Recommendation accepted</p>;
            if (status === "ignored")
              return <p className="text-xs text-warning font-semibold">⚠ Recommendation ignored</p>;
            return null;
          })()}
        </div>
      )}

      {/* Key */}
      <div className="flex flex-col gap-1 mb-4">
        <label className="text-xs text-muted font-medium">Key</label>
        <input
          type="text"
          value={editing.key}
          onChange={(e) => onFieldChange("key", e.target.value)}
          disabled={!isNew}
          className={inputClass}
          placeholder="e.g. allowAppInstallation"
        />
        {meta && isNew && (
          <span className="text-xs text-success">✓ Known restriction key</span>
        )}
        {!meta && editing.key && (
          <span className="text-xs text-warning">⚠ Unknown restriction key — verify the key name</span>
        )}
      </div>

      {/* Type */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted font-medium">Type</label>
          <select
            value={editing.type}
            onChange={(e) => {
              const type = e.target.value as Restriction["type"];
              onFieldChange("type", type);
              // Reset value to a sensible default for the type
              if (type === "boolean") onFieldChange("value", false);
              else if (type === "integer") onFieldChange("value", 0);
              else if (type === "real") onFieldChange("value", 0);
              else onFieldChange("value", "");
            }}
            disabled={!isNew && meta !== null}
            className={inputClass}
          >
            <option value="boolean">boolean</option>
            <option value="integer">integer</option>
            <option value="real">real</option>
            <option value="string">string</option>
          </select>
          {!isNew && meta !== null && (
            <span className="text-xs text-muted italic">Type is fixed for known keys</span>
          )}
        </div>

        {/* Value */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted font-medium">Value</label>
          {editing.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(editing.value)}
              onChange={(e) => onFieldChange("value", e.target.checked)}
              className="w-[18px] h-[18px] cursor-pointer mt-1"
            />
          ) : editing.type === "integer" || editing.type === "real" ? (
            <input
              type="number"
              value={String(editing.value ?? "")}
              onChange={(e) => onFieldChange("value", Number(e.target.value))}
              className={inputClass}
            />
          ) : (
            <input
              type="text"
              value={String(editing.value ?? "")}
              onChange={(e) => onFieldChange("value", e.target.value)}
              className={inputClass}
            />
          )}
        </div>
      </div>

      {/* Default indicator */}
      {meta && meta.defaultValue !== null && isDefaultValue(editing.key, editing.value) && (
        <div className="mb-4 p-2 px-3 rounded-md bg-surface-hover border border-border text-xs text-muted">
          ⚠ This value matches the Apple default. It will be excluded from the generated profile
          (no override applied).
        </div>
      )}

      {/* Overridable flag */}
      <div className="mb-4 flex items-center gap-2">
        <input
          type="checkbox"
          checked={Boolean(editing.overridable)}
          onChange={(e) => onFieldChange("overridable", e.target.checked)}
          className="w-[18px] h-[18px] cursor-pointer"
        />
        <label className="text-xs text-muted font-medium cursor-pointer">
          Overridable — allow this restriction to be overridden per age band or child
        </label>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-white text-sm font-semibold no-underline cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onSave}
          disabled={saving || !editing.key}
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
              if (confirm(`Delete restriction "${editing.key}"?`)) {
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
