import { useCallback, useEffect, useState } from "react";
import {
  adjustChildBalance,
  getChildBalance,
  getChildTransactions,
  type BudgetBalance,
  type BudgetTransaction,
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

const KIND_LABEL: Record<BudgetTransaction["kind"], string> = {
  spend: "Snack",
  refund: "Refund",
  adjustment: "Adjustment",
};

/**
 * Card shown in the Children tab's edit modal: today's snack balance
 * for the child, controls to change it (recorded as an adjustment in the
 * transaction log), and the recent log itself.
 */
export function SnackBalanceCard({
  accessToken,
  subdomain,
}: {
  accessToken: string;
  subdomain: string;
}) {
  const [balance, setBalance] = useState<BudgetBalance | null>(null);
  const [transactions, setTransactions] = useState<BudgetTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [balanceData, transactionsData] = await Promise.all([
        getChildBalance(accessToken, BUDGET_ID, subdomain),
        getChildTransactions(accessToken, BUDGET_ID, subdomain, 20),
      ]);
      setBalance(balanceData);
      setTransactions(transactionsData.transactions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snack balance");
    } finally {
      setLoading(false);
    }
  }, [accessToken, subdomain]);

  useEffect(() => {
    load();
  }, [load]);

  async function applyAdjustment(deltaPence: number, note?: string) {
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      const result = await adjustChildBalance(accessToken, BUDGET_ID, subdomain, {
        deltaPence,
        note,
      });
      if (result.transaction) setSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update balance");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="spinner mx-auto my-2" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 flex flex-col gap-3">
      {/* Header + today's balance */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-extrabold uppercase tracking-wider text-muted">
            Snack balance
          </h3>
          <p className="text-xs text-muted">
            Today ({balance?.date ?? todayLondon()}) — allowance (plus any
            carried-over pennies and parent adjustments) minus snacks picked.
          </p>
        </div>
        {balance && (
          <div className="text-right">
            <span className="block text-2xl font-extrabold leading-tight">
              {formatPence(balance.remaining_pence)}
            </span>
            <span className="block text-xs text-muted">left today</span>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}
      {savedAt && !error && (
        <p className="text-sm text-success">Balance updated ✓ (recorded in the transaction log)</p>
      )}

      {balance && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
          <span>Allowance: <strong className="text-text">{formatPence(balance.allowance_pence)}</strong></span>
          {(balance.carried_pence ?? 0) > 0 && (
            <span>Carried over: <strong className="text-text">{formatPence(balance.carried_pence ?? 0)}</strong></span>
          )}
          {balance.adjustments_pence !== 0 && (
            <span>Adjustments: <strong className="text-text">{formatPence(balance.adjustments_pence)}</strong></span>
          )}
          <span>Spent: <strong className="text-text">{formatPence(balance.spent_pence)}</strong></span>
        </div>
      )}

      {/* Set balance */}
      <SetBalanceForm busy={busy} current={balance?.remaining_pence ?? null} onSet={(pence, note) => {
        // Set-to-value is expressed as a delta so it lands in the log as an adjustment.
        applyAdjustment(pence - (balance?.remaining_pence ?? 0), note);
      }} />

      {/* Quick buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Quick add:</span>
        {[-20, -10, 10, 20, 50].map((pence) => (
          <button
            key={pence}
            type="button"
            disabled={busy}
            onClick={() => applyAdjustment(pence)}
            className="px-2.5 py-1 rounded-md border border-border bg-surface-solid text-sm font-semibold cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pence > 0 ? `+${pence}p` : `${pence}p`}
          </button>
        ))}
      </div>

      {/* Transaction log */}
      <div>
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">
          Recent transactions
        </h4>
        {transactions.length === 0 ? (
          <p className="text-xs text-muted">No transactions yet.</p>
        ) : (
          <div className="border border-border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.transaction_id} className="border-t border-border first:border-t-0">
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted">
                      {t.date}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-semibold">
                      {KIND_LABEL[t.kind]}
                      {t.by === "parent" && (
                        <span className="text-muted font-normal"> (parent)</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {t.description ?? "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right font-semibold whitespace-nowrap ${
                      t.amount_pence < 0 ? "text-danger" : "text-success"
                    }`}>
                      {t.amount_pence > 0 ? "+" : ""}{formatPence(t.amount_pence)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted whitespace-nowrap">
                      → {formatPence(t.balance_after_pence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Set-to-value input. Uses the draft-on-change/commit-on-blur pattern (like
 * AmountInput in SnacksPanel) so we don't fire a request per keystroke.
 */
function SetBalanceForm({
  busy,
  current,
  onSet,
}: {
  busy: boolean;
  current: number | null;
  onSet: (pence: number, note?: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const next = Math.round(parsed);
    if (current !== null && next !== current) onSet(next, note.trim() || undefined);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted font-medium">Set balance to (p)</span>
        <input
          type="number"
          value={draft ?? current ?? ""}
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
          disabled={busy || current === null}
          className="w-24 px-2 py-1.5 rounded border border-border bg-surface-solid"
          placeholder={current === null ? "—" : undefined}
        />
      </label>
      <label className="flex flex-col gap-1 flex-1 min-w-40">
        <span className="text-xs text-muted font-medium">Note (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy || current === null}
          className="w-full px-2 py-1.5 rounded border border-border bg-surface-solid"
          placeholder="e.g. Reward for tidying the playroom"
        />
      </label>
      <button
        type="button"
        disabled={busy || current === null || draft === null}
        onClick={commit}
        className="min-h-9 px-4 rounded-md text-white text-sm font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-none cursor-pointer"
      >
        Apply
      </button>
    </div>
  );
}
