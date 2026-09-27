/** Family timezone for age and birthday calculations. */
export const FAMILY_TIMEZONE = "Europe/London";

/** How long after a birthday to highlight newly unlocked apps. */
export const BIRTHDAY_WINDOW_DAYS = 14;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface BirthdayState {
  /** Calendar age in Europe/London. */
  age: number;
  isToday: boolean;
  /** Birthday was today or within BIRTHDAY_WINDOW_DAYS after. */
  celebrating: boolean;
  daysSince: number;
}

export function partsInTimezone(
  date: Date,
  timeZone = FAMILY_TIMEZONE,
): DateParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

export function parseDobParts(dateOfBirth: string | Date): DateParts {
  if (dateOfBirth instanceof Date) {
    if (Number.isNaN(dateOfBirth.getTime())) {
      throw new Error(`Invalid date_of_birth: ${String(dateOfBirth)}`);
    }
    return {
      year: dateOfBirth.getFullYear(),
      month: dateOfBirth.getMonth() + 1,
      day: dateOfBirth.getDate(),
    };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateOfBirth).trim());
  if (!match) {
    throw new Error(`Invalid date_of_birth: ${String(dateOfBirth)}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** This child's birthday in a given year (Feb 29 → Feb 28 in common years). */
export function birthdayOnYear(birth: DateParts, year: number): DateParts {
  if (birth.month === 2 && birth.day === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28 };
  }
  return { year, month: birth.month, day: birth.day };
}

function utcDays(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

export function calculateAge(dateOfBirth: string | Date, asOf = new Date()): number {
  const birth = parseDobParts(dateOfBirth);
  const now = partsInTimezone(asOf);
  let age = now.year - birth.year;
  const anniversary = birthdayOnYear(birth, now.year);
  if (
    now.month < anniversary.month ||
    (now.month === anniversary.month && now.day < anniversary.day)
  ) {
    age--;
  }
  return age;
}

export function getBirthdayState(
  dateOfBirth: string | Date,
  asOf = new Date(),
): BirthdayState {
  const birth = parseDobParts(dateOfBirth);
  const now = partsInTimezone(asOf);
  const age = calculateAge(dateOfBirth, asOf);

  const thisYear = birthdayOnYear(birth, now.year);
  let daysSince = utcDays(now) - utcDays(thisYear);
  if (daysSince < 0) {
    const lastYear = birthdayOnYear(birth, now.year - 1);
    daysSince = utcDays(now) - utcDays(lastYear);
  }

  return {
    age,
    isToday: daysSince === 0,
    celebrating: daysSince >= 0 && daysSince <= BIRTHDAY_WINDOW_DAYS,
    daysSince,
  };
}

export function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function parseAsOfDate(value: string | null | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  // Noon UTC is the same calendar day in both the UK and US.
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
