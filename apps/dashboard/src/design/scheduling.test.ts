import { describe, expect, it } from 'vitest';
import {
  draftSummary,
  fromLocalInput,
  quickPicks,
  scheduleAround,
  scheduleTimeProblem,
  scheduleTimeShort,
  scheduleWhen,
  toLocalInput,
} from './scheduling';

// Local times, so the tests read the same in any time zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe('scheduling a design', () => {
  it('turns a local date and time into a moment and back', () => {
    const date = at(2026, 11, 10, 9, 5);
    expect(toLocalInput(date)).toBe('2026-11-10T09:05');
    expect(fromLocalInput('2026-11-10T09:05')?.getTime()).toBe(date.getTime());
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
  });

  it('offers tomorrow and the next Monday at 09:00', () => {
    // Sunday 8 Nov: Monday is tomorrow, so it is offered once.
    expect(quickPicks(at(2026, 11, 8, 15)).map((p) => [p.label, toLocalInput(p.at)])).toEqual([
      ['Tomorrow 09:00', '2026-11-09T09:00'],
    ]);
    // Monday: the Monday after.
    expect(quickPicks(at(2026, 11, 9, 8)).map((p) => toLocalInput(p.at))).toEqual([
      '2026-11-10T09:00',
      '2026-11-16T09:00',
    ]);
    // Friday.
    expect(quickPicks(at(2026, 11, 13, 22)).map((p) => [p.label, toLocalInput(p.at)])).toEqual([
      ['Tomorrow 09:00', '2026-11-14T09:00'],
      ['Monday 09:00', '2026-11-16T09:00'],
    ]);
    // Across a month's end.
    expect(toLocalInput(quickPicks(at(2026, 11, 30, 12))[0]!.at)).toBe('2026-12-01T09:00');
  });

  it('checks the time like the server: 5 minutes to 90 days ahead', () => {
    const now = at(2026, 11, 9, 12).getTime();
    expect(scheduleTimeProblem(null, now)).toMatch(/Choose a date/);
    expect(scheduleTimeProblem(new Date(now + 4 * 60_000), now)).toMatch(/at least 5 minutes/);
    expect(scheduleTimeProblem(new Date(now - 60_000), now)).toMatch(/at least 5 minutes/);
    expect(scheduleTimeProblem(new Date(now + 5 * 60_000), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now + 90 * 86_400_000), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now + 91 * 86_400_000), now)).toMatch(/90 days/);
  });

  it('says when, honestly about the five-minute cron', () => {
    const date = at(2026, 11, 16, 9);
    expect(scheduleWhen(date)).toBe('Mon 16 Nov, 09:00');
    expect(scheduleAround(date)).toBe('Mon 16 Nov, around 09:00');
    expect(scheduleTimeShort(date, at(2026, 11, 16, 7))).toBe('09:00');
    expect(scheduleTimeShort(date, at(2026, 11, 15, 7))).toBe('Mon 16 Nov, 09:00');
  });

  it('sums up what goes live', () => {
    expect(draftSummary('Launch', 7)).toBe('The draft as it is now: Launch theme, 7 sections');
    expect(draftSummary('Letter', 1)).toBe('The draft as it is now: Letter theme, 1 section');
    expect(draftSummary(null, 3)).toBe('The draft as it is now: Your own theme, 3 sections');
  });
});
