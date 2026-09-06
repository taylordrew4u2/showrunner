import { describe, it, expect } from 'vitest';
import {
  describeRecurrence,
  MAX_OCCURRENCES,
  recurringDates,
  weekdayOrdinal,
} from './recurrence';

describe('recurringDates', () => {
  it('never includes the show being repeated — it already exists', () => {
    const dates = recurringDates('2026-04-07', 'weekly', 3);
    expect(dates).toEqual(['2026-04-14', '2026-04-21', '2026-04-28']);
  });

  it('steps by two and four weeks', () => {
    expect(recurringDates('2026-04-07', 'fortnightly', 2)).toEqual(['2026-04-21', '2026-05-05']);
    expect(recurringDates('2026-04-07', 'every-4-weeks', 2)).toEqual(['2026-05-05', '2026-06-02']);
  });

  it('crosses a month and a year without drifting', () => {
    expect(recurringDates('2026-12-29', 'weekly', 2)).toEqual(['2027-01-05', '2027-01-12']);
  });

  it('keeps the same date each month', () => {
    expect(recurringDates('2026-01-14', 'monthly-date', 3)).toEqual([
      '2026-02-14',
      '2026-03-14',
      '2026-04-14',
    ]);
  });

  it('skips a month too short for the date rather than moving the show', () => {
    // A show on the 31st does not happen in February, and landing it on the
    // 28th would book a night nobody chose.
    expect(recurringDates('2026-01-31', 'monthly-date', 3)).toEqual([
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ]);
  });

  it('keeps the same weekday and position — the second Tuesday stays the second Tuesday', () => {
    // 2026-04-14 is the second Tuesday of April.
    expect(recurringDates('2026-04-14', 'monthly-weekday', 3)).toEqual([
      '2026-05-12',
      '2026-06-09',
      '2026-07-14',
    ]);
  });

  it('skips months with no fifth weekday instead of sliding to the fourth', () => {
    // 2026-01-30 is the fifth Friday of January.
    const dates = recurringDates('2026-01-30', 'monthly-weekday', 3);
    for (const d of dates) {
      const day = new Date(`${d}T00:00:00`);
      expect(day.getDay()).toBe(5);
      expect(weekdayOrdinal(day)).toBe(5);
    }
    expect(dates).not.toContain('2026-02-27');
  });

  it('still returns the number of shows asked for when months are skipped', () => {
    expect(recurringDates('2026-01-31', 'monthly-date', 6)).toHaveLength(6);
    expect(recurringDates('2026-01-30', 'monthly-weekday', 6)).toHaveLength(6);
  });

  it('refuses a bad date or a nonsense count rather than inventing shows', () => {
    expect(recurringDates('', 'weekly', 4)).toEqual([]);
    expect(recurringDates('not a date', 'weekly', 4)).toEqual([]);
    expect(recurringDates('2026-04-07', 'weekly', 0)).toEqual([]);
    expect(recurringDates('2026-04-07', 'weekly', -3)).toEqual([]);
  });

  it('caps a run, so one slip of a finger cannot book a hundred nights', () => {
    expect(recurringDates('2026-04-07', 'weekly', 500)).toHaveLength(MAX_OCCURRENCES);
  });
});

describe('describeRecurrence', () => {
  it('reads back as the rule for this particular show', () => {
    expect(describeRecurrence('2026-04-07', 'weekly')).toBe('Every week on Tuesday');
    expect(describeRecurrence('2026-04-14', 'monthly-weekday')).toBe(
      'Monthly, on the 2nd Tuesday',
    );
    expect(describeRecurrence('2026-04-03', 'monthly-date')).toBe('Monthly, on the 3rd');
    expect(describeRecurrence('2026-04-11', 'monthly-date')).toBe('Monthly, on the 11th');
    expect(describeRecurrence('2026-04-21', 'monthly-date')).toBe('Monthly, on the 21st');
  });

  it('falls back to the plain label when the show has no date yet', () => {
    expect(describeRecurrence('', 'weekly')).toBe('Every week');
  });
});
