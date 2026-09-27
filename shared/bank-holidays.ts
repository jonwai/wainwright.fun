/**
 * England & Wales bank holidays, from the official gov.uk register
 * (https://www.gov.uk/bank-holidays). Substitute days are already the
 * observed date. Extend here as gov.uk announces further years.
 *
 * Shared between the term-dates Lambda (school-day classification) and the
 * admin panel (holiday display) — keep it dependency-free.
 */

export const ENGLAND_BANK_HOLIDAYS: Record<string, string> = {
  // 2025
  "2025-01-01": "New Year's Day",
  "2025-04-18": "Good Friday",
  "2025-04-21": "Easter Monday",
  "2025-05-05": "Early May bank holiday",
  "2025-05-26": "Spring bank holiday",
  "2025-08-25": "Summer bank holiday",
  "2025-12-25": "Christmas Day",
  "2025-12-26": "Boxing Day",
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-04-03": "Good Friday",
  "2026-04-06": "Easter Monday",
  "2026-05-04": "Early May bank holiday",
  "2026-05-25": "Spring bank holiday",
  "2026-08-31": "Summer bank holiday",
  "2026-12-25": "Christmas Day",
  "2026-12-28": "Boxing Day (substitute day)",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-03-26": "Good Friday",
  "2027-03-29": "Easter Monday",
  "2027-05-03": "Early May bank holiday",
  "2027-05-31": "Spring bank holiday",
  "2027-08-30": "Summer bank holiday",
  "2027-12-27": "Christmas Day (substitute day)",
  "2027-12-28": "Boxing Day (substitute day)",
  // 2028
  "2028-01-03": "New Year's Day (substitute day)",
  "2028-04-14": "Good Friday",
  "2028-04-17": "Easter Monday",
  "2028-05-01": "Early May bank holiday",
  "2028-05-29": "Spring bank holiday",
  "2028-08-28": "Summer bank holiday",
  "2028-12-25": "Christmas Day",
  "2028-12-26": "Boxing Day",
};

/** Bank holidays (date + name) falling within an inclusive date range,
 * sorted by date. Used by the admin panel to show the holidays that
 * land inside each term. */
export function bankHolidaysBetween(
  start: string | null,
  end: string | null
): { date: string; name: string }[] {
  if (!start || !end) return [];
  return Object.entries(ENGLAND_BANK_HOLIDAYS)
    .filter(([date]) => date >= start && date <= end)
    .map(([date, name]) => ({ date, name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
