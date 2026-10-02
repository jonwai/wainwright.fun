import { useCallback, useEffect, useState } from "react";
import {
  addBudgetSelection,
  removeBudgetSelection,
  getBudgetProducts,
  getBudgetSelections,
  getBudgets,
  getChildren,
  putBudget,
  type Budget,
  type BudgetProduct,
  type BudgetSelectionRow,
  type Child,
} from "./api";

const BUDGET_ID = "snacks";

function formatPence(pence: number | null): string {
  if (pence === null) return "—";
  if (pence === 0) return "free";
  const pounds = pence / 100;
  return pounds >= 1 ? `£${pounds.toFixed(2)}` : `${pence}p`;
}

function todayLondon(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
    .map((part) => (part.type === "literal" ? "" : part.value))
    .join("");
}

export function SnacksPanel({ accessToken }: { accessToken: string }) {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [products, setProducts] = useState<BudgetProduct[]>([]);
  const [selections, setSelections] = useState<BudgetSelectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [budgets, childrenData] = await Promise.all([
        getBudgets(accessToken),
        getChildren(accessToken),
      ]);
      let snacksBudget = budgets.find((b) => b.budget_id === BUDGET_ID) ?? null;
      if (!snacksBudget) {
        // First run — create the snacks budget with sensible defaults.
        snacksBudget = await putBudget(accessToken, BUDGET_ID, {
          budget_id: BUDGET_ID,
          name: "Snacks",
          school_day_amount_pence: {},
          non_school_day_amount_pence: {},
          included_products: [],
        });
      }
      setBudget(snacksBudget);
      setChildren(childrenData);
      const [productsData, selectionsData] = await Promise.all([
        getBudgetProducts(accessToken, BUDGET_ID).then((r) => r.products),
        getBudgetSelections(accessToken, BUDGET_ID),
      ]);
      setProducts(productsData);
      setSelections(selectionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  const saveBudget = useCallback(
    async (next: Budget) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await putBudget(accessToken, BUDGET_ID, next);
        setBudget(saved);
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [accessToken]
  );

  const setChildAmount = (subdomain: string, field: "school_day_amount_pence" | "non_school_day_amount_pence", pence: number) => {
    if (!budget) return;
    saveBudget({
      ...budget,
      [field]: { ...budget[field], [subdomain]: pence },
    });
  };

  const toggleIncluded = (productSlug: string) => {
    if (!budget) return;
    const included = new Set(budget.included_products);
    if (included.has(productSlug)) {
      included.delete(productSlug);
    } else {
      included.add(productSlug);
    }
    saveBudget({ ...budget, included_products: [...included] });
  };

  const setRolloverStart = (date: string | null) => {
    if (!budget) return;
    if ((budget.rollover_start_date ?? null) === date) return;
    saveBudget({ ...budget, rollover_start_date: date });
  };

  const addForChild = async (subdomain: string, productSlug: string, date: string) => {
    setSaving(true);
    setError(null);
    try {
      await addBudgetSelection(accessToken, BUDGET_ID, subdomain, productSlug, date);
      const selectionsData = await getBudgetSelections(accessToken, BUDGET_ID);
      setSelections(selectionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add snack");
    } finally {
      setSaving(false);
    }
  };

  const removeForChild = async (subdomain: string, productSlug: string, selectedAt: string, date: string) => {
    setSaving(true);
    setError(null);
    try {
      await removeBudgetSelection(accessToken, BUDGET_ID, subdomain, productSlug, selectedAt, date);
      const selectionsData = await getBudgetSelections(accessToken, BUDGET_ID);
      setSelections(selectionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove snack");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  if (error && !budget) {
    return (
      <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
        {error}
      </div>
    );
  }

  if (!budget) return null;

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="p-3 px-4 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm">
          Saved ✓
        </div>
      )}

      {/* Per-child configuration */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Daily snack budgets</h2>
        <p className="text-muted text-sm mb-4">
          How much each child can spend each day. There's no snack limit — they can
          pick as many as their money allows. Younger children (6 and under)
          see their budget in 5p coins and each snack's price rounds up to the
          nearest 5p. School days use the term dates on the Term Dates tab.
        </p>
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-border">
                <th className="px-4 py-2 font-semibold">Child</th>
                <th className="px-4 py-2 font-semibold">School day (p)</th>
                <th className="px-4 py-2 font-semibold">Non-school day (p)</th>
              </tr>
            </thead>
            <tbody>
              {children.map((child) => (
                <tr key={child.subdomain} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-semibold whitespace-nowrap">{child.name}</td>
                  {(["school_day_amount_pence", "non_school_day_amount_pence"] as const).map((field) => (
                    <td key={field} className="px-4 py-2">
                      <AmountInput
                        value={budget[field][child.subdomain] ?? 0}
                        disabled={saving}
                        onCommit={(pence) => setChildAmount(child.subdomain, field, pence)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <RolloverStartDateInput
            value={budget.rollover_start_date ?? null}
            disabled={saving}
            onCommit={setRolloverStart}
          />
        </div>
      </section>

      {/* Parent add snack */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Add a snack for a child</h2>
        <p className="text-muted text-sm mb-4">
          Record a snack given by a parent (e.g. fruit from the kitchen counter) — counts toward the day's budget.
        </p>
        <AddSnackForm
          children={children}
          products={products}
          saving={saving}
          onAdd={addForChild}
        />
      </section>

      {/* Product selection (allowlist) */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Selectable snacks</h2>
        <p className="text-muted text-sm mb-4">
          Tick a snack to make it appear in the children's picker — nothing is
          selectable until you tick it. Stock counts come from Wainsbury's.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {products.map((product) => {
            const included = budget.included_products.includes(product.productSlug);
            return (
              <label
                key={product.productSlug}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${
                  included ? "border-border bg-surface" : "opacity-50 border-border"
                }`}
              >
                <input
                  type="checkbox"
                  checked={included}
                  onChange={() => toggleIncluded(product.productSlug)}
                  disabled={saving}
                />
                {product.image ? (
                  <img src={product.image} alt="" className="w-10 h-10 rounded object-cover" />
                ) : (
                  <span className="text-xl">🍪</span>
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate">{product.name}</span>
                  <span className="block text-xs text-muted">
                    {formatPence(product.pricePence)} · {product.portionsLeft} left
                    {product.halfPrice === true && (
                      <span className="font-bold text-accent-strong"> · half price (use-by)</span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Selection history */}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Recent selections</h2>
        <p className="text-muted text-sm mb-4">
          Every snack picked, by child and day. Most recent first.
        </p>
        <div className="flex flex-col gap-3">
          {selections.length === 0 && (
            <p className="text-muted text-sm">No snacks picked yet.</p>
          )}
          {selections.map((row) => (
            <div key={`${row.child_subdomain}/${row.budget_day}`} className="bg-surface border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold">
                  {children.find((c) => c.subdomain === row.child_subdomain)?.name ?? row.child_subdomain}
                </span>
                <span className="text-sm text-muted">{row.date}</span>
              </div>
              {row.selections.length === 0 ? (
                <p className="text-muted text-sm">Nothing picked.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {row.selections.map((selection) => (
                    <li key={selection.selectedAt} className="flex items-center gap-2 text-sm">
                      <span className="flex-1">{selection.name}</span>
                      <span className="text-muted">{formatPence(selection.pricePence)}</span>
                      <span className="text-xs text-muted">
                        {selection.selectedBy === "parent" ? "by parent" : ""}
                      </span>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          removeForChild(
                            row.child_subdomain,
                            selection.productSlug,
                            selection.selectedAt,
                            row.date
                          )
                        }
                        title="Remove this snack and refund its price"
                        className="px-2 py-0.5 rounded border border-border text-xs font-semibold text-danger cursor-pointer transition-colors hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AddSnackForm({
  children,
  products,
  saving,
  onAdd,
}: {
  children: Child[];
  products: BudgetProduct[];
  saving: boolean;
  onAdd: (subdomain: string, productSlug: string, date: string) => Promise<void>;
}) {
  const [child, setChild] = useState(children[0]?.subdomain ?? "");
  const [product, setProduct] = useState("");
  const [date, setDate] = useState(todayLondon());
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !product) return;
    setBusy(true);
    try {
      await onAdd(child, product, date);
      setProduct("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Child</span>
        <select
          value={child}
          onChange={(e) => setChild(e.target.value)}
          className="px-3 py-2 rounded border border-border bg-surface-solid min-w-32"
        >
          {children.map((c) => (
            <option key={c.subdomain} value={c.subdomain}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 flex-1 min-w-48">
        <span className="text-sm font-semibold">Snack</span>
        <select
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          className="px-3 py-2 rounded border border-border bg-surface-solid"
          required
        >
          <option value="">Choose a snack…</option>
          {products.map((p) => (
            <option key={p.productSlug} value={p.productSlug}>
              {p.name} ({formatPence(p.pricePence)})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Day</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded border border-border bg-surface-solid"
        />
      </label>
      <button
        type="submit"
        disabled={busy || saving || !child || !product}
        className="min-h-10 px-5 rounded-md text-white font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none"
      >
        {busy ? "Adding…" : "Add snack"}
      </button>
    </form>
  );
}

/**
 * Date input for the rollover anchor. Same draft-on-change/commit-on-blur
 * pattern as AmountInput — clearing the field (or pressing the Clear
 * button) commits null, which turns rollover off.
 */
function RolloverStartDateInput({
  value,
  disabled,
  onCommit,
}: {
  value: string | null;
  disabled: boolean;
  onCommit: (date: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const next = /^\d{4}-\d{2}-\d{2}$/.test(draft) ? draft : null;
    setDraft(null);
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Unspent pennies carry over from</span>
        <input
          type="date"
          value={draft ?? value ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={disabled}
          className="px-3 py-2 rounded border border-border bg-surface-solid"
        />
      </label>
      <button
        type="button"
        disabled={disabled || value === null}
        onClick={() => onCommit(null)}
        className="min-h-10 px-4 rounded-md border border-border bg-surface-solid font-semibold cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
      >
        No carry-over
      </button>
      <p className="text-xs text-muted self-center max-w-md">
        {value
          ? "Each day starts with yesterday's leftover pennies added on top of its allowance. A day with no snack picked forfeits its allowance — leftovers only carry over when a snack was picked."
          : "Each day's allowance stands alone — leftovers are not saved up."}
      </p>
    </div>
  );
}

/**
 * Number input that only saves when the user is finished editing — typing
 * updates a local draft; blur or Enter commits it (Escape reverts). This
 * avoids a PUT on every keystroke, which disabled the input mid-typing and
 * clobbered the row with half-typed values.
 */
function AmountInput({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (pence: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    const next = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : value;
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      min={0}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-24 px-2 py-1 rounded border border-border bg-surface-solid"
      disabled={disabled}
    />
  );
}
