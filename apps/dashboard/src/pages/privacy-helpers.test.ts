import { describe, expect, it } from 'vitest';
import { dueLabel, lastRunLabel, span } from './privacy-helpers';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('privacy helpers', () => {
  it('spans read in the largest whole unit', () => {
    expect(span(30_000)).toBe('1 min');
    expect(span(59 * 60_000)).toBe('59 min');
    expect(span(23 * HOUR)).toBe('23 h');
    expect(span(47 * HOUR)).toBe('47 h');
    expect(span(30 * 24 * HOUR)).toBe('30 days');
  });

  it('shows the SLA timer for open and closed requests', () => {
    const open = { status: 'pending' as const, completedAt: null };
    expect(dueLabel({ ...open, dueAt: iso(now + 23 * HOUR), overdue: false }, now)).toBe(
      'Due in 23 h',
    );
    expect(dueLabel({ ...open, dueAt: iso(now - 3 * HOUR), overdue: true }, now)).toBe(
      'Overdue by 3 h',
    );
    expect(
      dueLabel(
        { status: 'completed', dueAt: iso(now), overdue: false, completedAt: iso(now - HOUR) },
        now,
      ),
    ).toBe('Done in time');
    expect(
      dueLabel(
        { status: 'completed', dueAt: iso(now - 2 * HOUR), overdue: false, completedAt: iso(now) },
        now,
      ),
    ).toBe('Done 2 h late');
    expect(
      dueLabel({ status: 'rejected', dueAt: iso(now), overdue: false, completedAt: null }, now),
    ).toBe('Closed');
  });

  it('describes the last export run', () => {
    expect(lastRunLabel(null, now)).toBe('Not run yet');
    expect(lastRunLabel(iso(now - 2 * HOUR), now)).toBe('2 h ago');
  });
});
