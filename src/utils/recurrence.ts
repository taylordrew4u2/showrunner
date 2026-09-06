import { parseShowDate, toDateKey } from './showDate';

/**
 * Turning one show into a run of them.
 *
 * A weekly room is the same show over and over — same venue, same host, often
 * the same rough lineup — and building each week by hand is the single most
 * repetitive thing a producer does in here. Duplicating covers two; a monthly
 * booked out to the end of the year does not.
 *
 * The dates are worked out up front and real shows are created for them,
 * rather than storing a rule and expanding it on the fly. A booked show is
 * edited constantly — someone drops out, the venue moves, the date shifts by a
 * week for a holiday — and a rule that keeps regenerating them would either
 * fight those edits or need exceptions layered on top of it. Twelve real shows
 * can each be edited like any other.
 */

export type RecurrencePattern =
  | 'weekly'
  | 'fortnightly'
  | 'every-4-weeks'
  /** The same date each month — the 14th, say. */
  | 'monthly-date'
  /** The same weekday each month — the second Tuesday. */
  | 'monthly-weekday';

export const RECURRENCE_LABELS: Record<RecurrencePattern, string> = {
  weekly: 'Every week',
  fortnightly: 'Every 2 weeks',
  'every-4-weeks': 'Every 4 weeks',
  'monthly-date': 'Monthly, same date',
  'monthly-weekday': 'Monthly, same weekday',
};

/** How many extra shows a producer can book in one go. */
export const MAX_OCCURRENCES = 52;

/** Which weekday of its month a date is — the 2nd Tuesday is `2`. */
export function weekdayOrdinal(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

/**
 * The nth given weekday of a month, or null when the month has no such day —
 * not every month has a fifth Friday.
 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date | null {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const candidate = new Date(year, month, day);
  return candidate.getMonth() === month ? candidate : null;
}

/**
 * The dates after `startDate`, following `pattern`, `count` of them.
 *
 * The first date is deliberately not included: the show being repeated already
 * exists on it, and returning it would offer the producer a duplicate of a
 * show they are looking at.
 *
 * A month that cannot hold the date is skipped rather than nudged: a show on
 * the 31st does not happen in February, and quietly moving it to the 28th
 * books a show on a day nobody chose. The count is a number of shows, so
 * skipping looks further ahead rather than returning fewer.
 */
export function recurringDates(
  startDate: string,
  pattern: RecurrencePattern,
  count: number,
): string[] {
  const start = parseShowDate(startDate);
  if (!start || count < 1) return [];
  const wanted = Math.min(Math.floor(count), MAX_OCCURRENCES);
  const dates: string[] = [];

  if (pattern === 'weekly' || pattern === 'fortnightly' || pattern === 'every-4-weeks') {
    const step = pattern === 'weekly' ? 7 : pattern === 'fortnightly' ? 14 : 28;
    for (let i = 1; i <= wanted; i++) {
      const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + step * i);
      dates.push(toDateKey(next));
    }
    return dates;
  }

  if (pattern === 'monthly-date') {
    const day = start.getDate();
    // Bounded rather than `while (dates.length < wanted)`: a run of skipped
    // months must not become an endless search.
    for (let i = 1; dates.length < wanted && i <= wanted * 2 + 12; i++) {
      const candidate = new Date(start.getFullYear(), start.getMonth() + i, day);
      // Rolled into the next month, so this one is too short — skip it.
      if (candidate.getDate() !== day) continue;
      dates.push(toDateKey(candidate));
    }
    return dates;
  }

  const weekday = start.getDay();
  const nth = weekdayOrdinal(start);
  for (let i = 1; dates.length < wanted && i <= wanted * 2 + 12; i++) {
    const month = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const candidate = nthWeekdayOfMonth(month.getFullYear(), month.getMonth(), weekday, nth);
    if (!candidate) continue; // No fifth Friday this month.
    dates.push(toDateKey(candidate));
  }
  return dates;
}

/**
 * How a pattern reads for one particular show, e.g. "Every week on Tuesday"
 * or "Monthly, on the 2nd Tuesday" — so the producer can check the rule
 * against the show in front of them before booking twelve of it.
 */
export function describeRecurrence(startDate: string, pattern: RecurrencePattern): string {
  const start = parseShowDate(startDate);
  if (!start) return RECURRENCE_LABELS[pattern];
  const weekday = start.toLocaleDateString(undefined, { weekday: 'long' });
  switch (pattern) {
    case 'weekly':
      return `Every week on ${weekday}`;
    case 'fortnightly':
      return `Every 2 weeks on ${weekday}`;
    case 'every-4-weeks':
      return `Every 4 weeks on ${weekday}`;
    case 'monthly-date':
      return `Monthly, on the ${ordinal(start.getDate())}`;
    case 'monthly-weekday':
      return `Monthly, on the ${ordinal(weekdayOrdinal(start))} ${weekday}`;
  }
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
