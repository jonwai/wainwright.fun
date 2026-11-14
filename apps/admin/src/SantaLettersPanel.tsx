import { useCallback, useEffect, useState } from "react";
import { apiConfig } from "./config";

interface SantaPick {
  id: string;
  label: string;
  emoji: string;
}

interface SantaLetter {
  id: string;
  submittedAt: string;
  answers: Record<string, { prompt: string; picks: SantaPick[]; favourite: string | null }>;
  ownLine: string | null;
  letterText: string;
  drawingPng: string | null;
  clientIp: string | null;
}

interface SantaChild {
  childId: string;
  name: string;
  submissions: number;
  latest: SantaLetter | null;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * Latest letter to Santa for each child. The home-network admin only answers a parent's device;
 * this panel calls GET /api/admin/santa-letters the same way as the other tabs.
 */
export function SantaLettersPanel({ accessToken }: { accessToken: string }) {
  const [letters, setLetters] = useState<SantaChild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiConfig.baseUrl}/admin/santa-letters`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `API returned ${res.status}`;
        throw new Error(message);
      }
      setLetters(Array.isArray(data?.letters) ? data.letters : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-muted">Loading letters…</p>;
  if (error) return <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">{error}</div>;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted m-0">
        Each child&apos;s latest letter. Older sends are kept in <span className="font-semibold">kids.santa_letters</span>.
      </p>
      {letters.map((child) => (
        <article key={child.childId} className="bg-surface border border-border rounded-xl p-4 grid gap-3">
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-lg font-extrabold">{child.name}</h2>
            <p className="m-0 text-sm text-muted">
              {child.latest ? formatWhen(child.latest.submittedAt) : "No letter yet"}
              {child.submissions > 1 ? ` · ${child.submissions} sends` : ""}
            </p>
          </header>
          {child.latest && (
            <>
              <ul className="grid gap-2 m-0 p-0 list-none">
                {Object.entries(child.latest.answers).map(([id, answer]) => (
                  <li key={id}>
                    <p className="m-0 text-sm font-semibold">{answer.prompt}</p>
                    <p className="m-0 text-sm">
                      {answer.picks.map((pick) => (
                        <span key={pick.id} className="inline-block mr-2">
                          {pick.emoji} {pick.label}
                          {pick.id === answer.favourite ? " ★" : ""}
                        </span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="m-0 text-sm">
                <span className="font-semibold">Their line: </span>
                {child.latest.ownLine ?? "—"}
              </p>
              {child.latest.drawingPng ? (
                <img src={child.latest.drawingPng} alt={`${child.name}'s drawing`} className="max-w-full w-80 rounded-lg border border-border" />
              ) : (
                <p className="m-0 text-sm text-muted">No drawing</p>
              )}
              <pre className="m-0 whitespace-pre-wrap text-sm font-sans bg-surface-solid border border-border rounded-lg p-3">{child.latest.letterText}</pre>
            </>
          )}
        </article>
      ))}
    </div>
  );
}
