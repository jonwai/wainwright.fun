import { useEffect, useState, useCallback, type ReactNode } from "react";
import { EditForm } from "./IconGridEditor";
import { Modal } from "./Modal";

// ── Generic table editor ──────────────────────────────────────────

export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "avatar" | "restriction-overrides" | "blocked-apps";
  options?: string[];
  required?: boolean;
  primaryKey?: boolean;
  /** Render full-width above the grid of other fields. */
  prominent?: boolean;
}

/** One tab of the edit modal. */
export interface EditTabDef<T = Record<string, unknown>> {
  label: string;
  /** Field names shown on this tab. Fields not listed anywhere default to the first tab. */
  fields: string[];
  /** Whether the editExtras node renders on this tab. */
  extras?: boolean;
  /** Per-tab extras node — overrides the entity-level `extras` when this tab is active. */
  extrasFn?: (item: T, isNew: boolean) => ReactNode;
}


export interface TableConfig<T> {
  entityName: string;
  /** Override for plural form. Defaults to entityName + "s". */
  pluralName?: string;
  fields: FieldDef[];
  /** Optional tabs for the edit modal. When set, fields are grouped onto tabs. */
  editTabs?: EditTabDef[];
  load: () => Promise<T[]>;
  save: (item: T) => Promise<T>;
  remove: (item: T) => Promise<void>;
  emptyItem: () => T;
  getKey: (item: T) => string;
}

export function TableEditor<T extends Record<string, unknown>>({
  config,
}: {
  config: TableConfig<T>;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<T | null>(null);
  const [original, setOriginal] = useState<T | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);

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

  function handleEdit(item: T) {
    setEditing({ ...item });
    setOriginal({ ...item });
    setIsNew(false);
  }

  function handleAdd() {
    setEditing(config.emptyItem());
    setOriginal(null);
    setIsNew(true);
  }

  function handleFieldChange(name: string, value: unknown) {
    setEditing((prev) => prev ? { ...prev, [name]: value } : prev);
  }

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  const tableFields = config.fields.filter((f) => f.type !== "avatar" && f.type !== "restriction-overrides" && f.type !== "blocked-apps");

  return (
    <div className="flex flex-col gap-4">
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

      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}

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
          />
        </Modal>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {tableFields.map((f) => (
                <th
                  key={f.name}
                  className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap"
                >
                  {f.label}
                </th>
              ))}
              <th className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="hover:bg-surface-hover">
                {tableFields.map((f) => (
                  <td
                    key={f.name}
                    className="px-3 py-2 text-left border-b border-border whitespace-nowrap"
                  >
                    {f.type === "boolean"
                      ? item[f.name]
                        ? "✓"
                        : "✗"
                      : String(item[f.name] ?? "")}
                  </td>
                ))}
                <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                  <button
                    className="bg-none border-none text-accent cursor-pointer text-xs hover:underline"
                    onClick={() => handleEdit(item)}
                  >
                    Edit
                  </button>
                  {" | "}
                  <button
                    className="bg-none border-none text-danger cursor-pointer text-xs hover:underline"
                    onClick={() => {
                      const key = config.getKey(item);
                      if (confirm(`Delete ${config.entityName} "${key}"?`)) {
                        handleDelete(item);
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
