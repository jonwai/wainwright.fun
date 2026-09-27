import { useCallback, useEffect, useState } from "react";
import {
  deleteTermDates,
  getTermDates,
  putTermDates,
  type Term,
  type TermDatesYear,
} from "./api";
import { bankHolidaysBetween } from "../../shared/bank-holidays";

const EMPTY_TERM: Term = {
  name: "",
  opens: "",
  closes: "",
  half_term_start: null,
  half_term_end: null,
};

/** Every academic year always has these three terms. */
const STANDARD_TERMS: Term[] = [
  { ...EMPTY_TERM, name: "Autumn" },
  { ...EMPTY_TERM, name: "Spring" },
  { ...EMPTY_TERM, name: "Summer" },
];

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Next academic year after the latest one present (e.g. "2026-2027" → "2027-2028"). */
function nextAcademicYear(years: TermDatesYear[]): string {
  const last = years[years.length - 1]?.academic_year;
  if (!last) {
    const now = new Date();
    const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    return `${start}-${start + 1}`;
  }
  const start = Number(last.split("-")[0]);
  return `${start + 1}-${start + 2}`;
}

export function TermDatesPanel({ accessToken }: { accessToken: string }) {
  const [years, setYears] = useState<TermDatesYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setYears(await getTermDates(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  const saveYear = useCallback(
    async (year: TermDatesYear) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await putTermDates(accessToken, year.academic_year, year);
        setYears((prev) => {
          const next = prev.filter((y) => y.academic_year !== saved.academic_year);
          next.push(saved);
          next.sort((a, b) => a.academic_year.localeCompare(b.academic_year));
          return next;
        });
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [accessToken]
  );

  const addYear = () => {
    const academicYear = nextAcademicYear(years);
    if (years.some((y) => y.academic_year === academicYear)) return;
    setYears((prev) =>
      [...prev, { academic_year: academicYear, terms: STANDARD_TERMS.map((t) => ({ ...t })) }].sort((a, b) =>
        a.academic_year.localeCompare(b.academic_year)
      )
    );
  };

  const removeYear = async (academicYear: string) => {
    setSaving(true);
    setError(null);
    try {
      await deleteTermDates(accessToken, academicYear);
      setYears((prev) => prev.filter((y) => y.academic_year !== academicYear));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="spinner mx-auto my-8" />;
  }

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

      <section>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-extrabold">Term dates</h2>
          <button
            className="min-h-10 px-4 rounded-md text-white text-sm font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none"
            onClick={addYear}
            disabled={saving}
          >
            Add academic year
          </button>
        </div>
        <p className="text-muted text-sm mb-4">
          School days drive the snack budgets (and other scheduling later): a
          weekday inside a term that isn't half term is a school day. England &
          Wales bank holidays are included automatically, and inset days fall
          outside the term dates, so neither needs entering — just set when each
          term opens and closes.
        </p>
        {years.length === 0 && (
          <p className="text-muted text-sm">
            No academic years yet — add one to get started.
          </p>
        )}
        <div className="flex flex-col gap-6">
          {years.map((year) => (
            <YearEditor
              key={year.academic_year}
              year={year}
              saving={saving}
              onSave={saveYear}
              onDelete={removeYear}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function YearEditor({
  year,
  saving,
  onSave,
  onDelete,
}: {
  year: TermDatesYear;
  saving: boolean;
  onSave: (year: TermDatesYear) => Promise<void>;
  onDelete: (academicYear: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TermDatesYear>(year);

  // Keep the draft in sync when the saved row changes underneath it.
  useEffect(() => setDraft(year), [year]);

  const updateTerm = (index: number, patch: Partial<Term>) => {
    setDraft((prev) => ({
      ...prev,
      terms: prev.terms.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    }));
  };

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-base font-extrabold">{year.academic_year}</h3>
        <div className="flex gap-2">
          <button
            className="min-h-9 px-4 rounded-md text-white text-sm font-semibold bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 cursor-pointer border-none"
            onClick={() => onSave(draft)}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save year"}
          </button>
          <button
            className="min-h-9 px-4 rounded-md text-danger text-sm font-semibold border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50 cursor-pointer bg-transparent"
            onClick={() => onDelete(year.academic_year)}
            disabled={saving}
          >
            Delete
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {draft.terms.map((term, index) => (
          <TermEditorCard
            key={index}
            term={term}
            saving={saving}
            onChange={(patch) => updateTerm(index, patch)}
          />
        ))}
      </div>
    </div>
  );
}

function TermEditorCard({
  term,
  saving,
  onChange,
}: {
  term: Term;
  saving: boolean;
  onChange: (patch: Partial<Term>) => void;
}) {
  const inputClass =
    "px-2 py-1 rounded border border-border bg-surface-solid disabled:opacity-50";

  // UK bank holidays that fall inside this term (weekend holidays excluded —
  // they don't affect school days). Recomputed as the dates change.
  const termHolidays = bankHolidaysBetween(term.opens, term.closes).filter(
    (h) => {
      const weekday = new Date(`${h.date}T12:00:00`).getDay();
      return weekday !== 0 && weekday !== 6;
    }
  );

  return (
    <div className="border border-border rounded-lg p-3 bg-surface-solid">
      <div className="font-semibold mb-3">{term.name}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">Schools open</span>
          <input
            type="date"
            value={term.opens}
            onChange={(e) => onChange({ opens: e.target.value })}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">Schools close</span>
          <input
            type="date"
            value={term.closes}
            onChange={(e) => onChange({ closes: e.target.value })}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">Half term from</span>
          <input
            type="date"
            value={term.half_term_start ?? ""}
            onChange={(e) => onChange({ half_term_start: e.target.value || null })}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">Half term to</span>
          <input
            type="date"
            value={term.half_term_end ?? ""}
            onChange={(e) => onChange({ half_term_end: e.target.value || null })}
            className={inputClass}
            disabled={saving}
          />
        </label>
      </div>
      {termHolidays.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-xs font-semibold text-muted mb-1">
            UK holidays during this term
          </div>
          <ul className="flex flex-col gap-0.5">
            {termHolidays.map((holiday) => (
              <li key={holiday.date} className="text-xs text-muted">
                {formatDate(holiday.date)} — {holiday.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(term.opens || term.closes) && (
        <p className="text-xs text-muted mt-3">
          {term.opens && <>Opens {formatDate(term.opens)} </>}
          {term.closes && <>· closes {formatDate(term.closes)}</>}
        </p>
      )}
    </div>
  );
}
