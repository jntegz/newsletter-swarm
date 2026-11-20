import { describe, expect, it } from 'vitest';
import { describeRosters, hasConflictChoice, setConflict, toggleRoster } from './helpers';

const names = new Map([
  ['rs_a', 'Deals'],
  ['rs_b', 'Events'],
  ['rs_c', 'Press'],
]);

describe('describeRosters', () => {
  it('is null without Rosters', () => {
    expect(describeRosters(undefined, names)).toBeNull();
    expect(describeRosters({ include: [], exclude: [], conflict: 'exclude_wins' }, names)).toBe(
      null,
    );
  });

  it('names the included and excluded Rosters and the policy', () => {
    expect(
      describeRosters(
        { include: ['rs_a', 'rs_b'], exclude: ['rs_c'], conflict: 'exclude_wins' },
        names,
      ),
    ).toBe('only subscribers on Deals or Events, not on Press');
    expect(
      describeRosters({ include: ['rs_a'], exclude: ['rs_c'], conflict: 'include_wins' }, names),
    ).toBe('only subscribers on Deals, not on Press, unless they are also on an included roster');
    expect(
      describeRosters({ include: [], exclude: ['rs_x'], conflict: 'exclude_wins' }, names),
    ).toBe('not on a deleted roster');
  });
});

describe('toggleRoster', () => {
  const base = { include: ['cl_a'], exclude: [] };

  it('adds and removes Rosters, never on both sides', () => {
    const one = toggleRoster(base, 'include', 'rs_a', true);
    expect(one.rosters).toEqual({ include: ['rs_a'], exclude: [], conflict: 'exclude_wins' });
    const moved = toggleRoster(one, 'exclude', 'rs_a', true);
    expect(moved.rosters).toEqual({ include: [], exclude: ['rs_a'], conflict: 'exclude_wins' });
    expect(moved.include).toEqual(['cl_a']);
  });

  it('drops an empty Roster part', () => {
    const one = toggleRoster(base, 'include', 'rs_a', true);
    expect(toggleRoster(one, 'include', 'rs_a', false)).toEqual(base);
  });

  it('keeps the policy and knows when it matters', () => {
    let audience = toggleRoster(base, 'include', 'rs_a', true);
    expect(hasConflictChoice(audience.rosters)).toBe(false);
    audience = toggleRoster(audience, 'exclude', 'rs_b', true);
    expect(hasConflictChoice(audience.rosters)).toBe(true);
    audience = setConflict(audience, 'include_wins');
    expect(audience.rosters?.conflict).toBe('include_wins');
    expect(toggleRoster(audience, 'exclude', 'rs_c', true).rosters?.conflict).toBe('include_wins');
  });
});
