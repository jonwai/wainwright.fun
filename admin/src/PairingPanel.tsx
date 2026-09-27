import { useCallback, useEffect, useState } from "react";
import {
  deletePairing,
  getChildren,
  getPairings,
  type Child,
  type PairingRow,
} from "./api";

function friendlyWhen(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) return "never";
  const date = new Date(epochSeconds * 1000);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function PairingPanel({ accessToken }: { accessToken: string }) {
  const [rows, setRows] = useState<PairingRow[] | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pairingData, childrenData] = await Promise.all([
        getPairings(accessToken),
        getChildren(accessToken),
      ]);
      setRows(pairingData);
      setChildren(childrenData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pairings");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(async (code: string) => {
    setDeleting(code);
    setError(null);
    try {
      await deletePairing(accessToken, code);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove pairing code");
    } finally {
      setDeleting(null);
    }
  }, [accessToken, load]);

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

  if (error && !rows) {
    return (
      <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
        {error}
      </div>
    );
  }

  const childName = (subdomain: string): string =>
    children.find((c) => c.subdomain === subdomain)?.name ?? subdomain;

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">
          {error}
        </div>
      )}
      <section>
        <h2 className="text-lg font-extrabold mb-1">Pairing codes</h2>
        <p className="text-muted text-sm mb-4">
          Every pairing code minted for a child — live codes from the admin app, preview codes from the
          Chores app's own pair screen. Preview codes never expire on their own, so old
          ones can pile up; remove them once the child has paired the real app.
        </p>
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-border">
                <th className="px-4 py-2 font-semibold">Code</th>
                <th className="px-4 py-2 font-semibold">Child</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Minted</th>
                <th className="px-4 py-2 font-semibold">Expires</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((row) => (
                <tr key={row.code} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono whitespace-nowrap">{row.code}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{childName(row.child_subdomain)}</td>
                  <td>
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                      row.kind === "pair" ? "bg-accent-soft text-accent-strong" : "bg-amber-50 text-amber-700"
                    }`}>
                      {row.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted whitespace-nowrap">{friendlyWhen(row.created_at)}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      disabled={deleting !== null}
                      onClick={() => remove(row.code)}
                      className="min-h-9 px-3 rounded-md border border-border text-xs font-semibold text-danger cursor-pointer transition-colors hover:bg-red-50 disabled:opacity-50"
                    >
                      {deleting === row.code ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
