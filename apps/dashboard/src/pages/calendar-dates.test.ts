import { describe, expect, it } from 'vitest';
import {
  addMonths,
  calendarDay,
  calendarKind,
  dayOf,
  firstDayOfWeek,
  monthGrid,
} from './calendar-dates';

const post = (over: Partial<Parameters<typeof calendarDay>[0]> = {}) => ({
  status: 'draft' as const,
  plannedDate: null,
  publishAt: null,
  sentAt: null,
  updatedAt: '2026-11-01T00:00:00.000Z',
  webPublishedAt: null,
  importedAt: null,
  ...over,
});

describe('the month grid', () => {
  it('fills whole weeks from the first day of the week', () => {
    const monday = monthGrid('2026-11', 1);
    expect(monday[0]![0]).toBe('2026-10-26');
    expect(monday[0]![6]).toBe('2026-11-01');
    expect(monday.at(-1)![6]).toBe('2026-12-06');
    const sunday = monthGrid('2026-11', 0);
    expect(sunday[0]![0]).toBe('2026-11-01');
    expect(sunday.every((week) => week.length === 7)).toBe(true);
  });

  it('keeps every day across a clock change', () => {
    const days = monthGrid('2026-03', 1).flat();
    expect(new Set(days).size).toBe(days.length);
    expect(days).toContain('2026-03-29');
    expect(days).toContain('2026-03-30');
  });

  it('moves between months across a year', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('reads the first day of the week from the locale', () => {
    expect(firstDayOfWeek('en-US')).toBe(0);
    expect(firstDayOfWeek('en-GB')).toBe(1);
  });
});

describe('where a post sits', () => {
  it('places a moment on the day it falls in the person’s time zone', () => {
    const moment = '2026-11-10T23:30:00.000Z';
    expect(dayOf(moment, 'UTC')).toBe('2026-11-10');
    expect(dayOf(moment, 'Asia/Tokyo')).toBe('2026-11-11');
    expect(dayOf(moment, 'America/New_York')).toBe('2026-11-10');
    const scheduled = post({ status: 'scheduled', publishAt: moment } as never);
    expect(calendarDay(scheduled, 'Asia/Tokyo')).toBe('2026-11-11');
  });

  it('keeps a planned date on its day in every time zone', () => {
    const draft = post({ plannedDate: '2026-11-10' } as never);
    expect(calendarDay(draft, 'Asia/Tokyo')).toBe('2026-11-10');
    expect(calendarDay(draft, 'America/Los_Angeles')).toBe('2026-11-10');
  });

  it('shows an imported issue as a past issue, on its website date', () => {
    const imported = post({
      importedAt: '2026-11-01T00:00:00.000Z',
      webPublishedAt: '2021-03-04T10:00:00.000Z',
      plannedDate: null,
    } as never);
    expect(calendarKind(imported)).toBe('past');
    expect(calendarDay(imported, 'UTC')).toBe('2021-03-04');
  });

  it('leaves out a draft with no planned date and a canceled post', () => {
    expect(calendarDay(post(), 'UTC')).toBeNull();
    expect(calendarDay(post({ status: 'canceled' } as never), 'UTC')).toBeNull();
  });
});
