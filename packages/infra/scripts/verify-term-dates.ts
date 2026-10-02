/** Quick verification of the term-dates classifier against the 2026/2027 dates. */
import { academicYearFor, isSchoolDay, type TermDates } from "../lambda/term-dates.js";

const terms: TermDates[] = [
  {
    name: "Autumn",
    opens: "2026-08-24",
    closes: "2026-12-18",
    half_term_start: "2026-10-19",
    half_term_end: "2026-10-23",
  },
  {
    name: "Spring",
    opens: "2027-01-05",
    closes: "2027-03-19",
    half_term_start: "2027-02-15",
    half_term_end: "2027-02-19",
  },
  {
    name: "Summer",
    opens: "2027-04-05",
    closes: "2027-07-08",
    half_term_start: "2027-05-28",
    half_term_end: "2027-06-04",
  },
];

const cases: Array<[string, string, boolean]> = [
  ["2026-08-20", "Thursday before schools open (inset)", false],
  ["2026-08-24", "Autumn term first school day", true],
  ["2026-08-31", "Summer bank holiday (Monday)", false],
  ["2026-09-19", "Saturday during term", false],
  ["2026-09-21", "Monday mid autumn term", true],
  ["2026-10-19", "Half term Monday", false],
  ["2026-10-23", "Half term Friday", false],
  ["2026-10-26", "Back after half term", true],
  ["2026-12-18", "Last day of autumn term", true],
  ["2026-12-21", "Monday after term ends", false],
  ["2026-12-25", "Christmas Day (Friday)", false],
  ["2026-12-28", "Boxing Day substitute (Monday)", false],
  ["2027-01-01", "New Year's Day (Friday)", false],
  ["2027-01-04", "Monday before spring term opens (inset)", false],
  ["2027-01-05", "Spring term opens (Tuesday)", true],
  ["2027-02-15", "Spring half term Monday", false],
  ["2027-02-22", "Back after spring half term", true],
  ["2027-03-19", "Spring term closes (Friday)", true],
  ["2027-03-26", "Good Friday", false],
  ["2027-03-29", "Easter Monday", false],
  ["2027-04-05", "Summer term opens (Monday)", true],
  ["2027-05-03", "Early May bank holiday (Monday)", false],
  ["2027-05-31", "Spring bank holiday (Monday)", false],
  ["2027-06-04", "Half term end (Friday)", false],
  ["2027-06-07", "Back after summer half term", true],
  ["2027-07-08", "Summer term closes (Thursday)", true],
  ["2027-07-09", "Friday after term ends", false],
  ["2027-08-30", "Summer bank holiday 2027 (Monday)", false],
  ["2027-12-27", "Christmas Day substitute 2027 (Monday)", false],
  ["2027-12-25", "Christmas Day 2027 (Saturday)", false],
];

let failures = 0;
for (const [date, label, expected] of cases) {
  const actual = isSchoolDay(terms, date);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${date} ${label}: expected ${expected ? "school" : "non-school"}, got ${actual ? "school" : "non-school"}`);
}

const yearCases: Array<[string, string]> = [
  ["2026-08-24", "2026-2027"],
  ["2026-09-19", "2026-2027"],
  ["2027-01-05", "2026-2027"],
  ["2027-07-31", "2026-2027"],
  ["2027-08-01", "2027-2028"],
];
for (const [date, expected] of yearCases) {
  const actual = academicYearFor(date);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} academicYearFor(${date}): expected ${expected}, got ${actual}`);
}

// Empty terms → default school day (matches old single-allowance behaviour)
const emptyDefault = isSchoolDay([], "2027-03-01");
console.log(`${emptyDefault === true ? "✓" : "✗"} empty terms default to school day`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
