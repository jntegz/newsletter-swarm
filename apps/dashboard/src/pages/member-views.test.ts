import {
  MAX_MEMBER_VIEWS,
  MEMBER_LIST_COLUMNS,
  MemberViewFiltersSchema,
  type MemberView,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  activeView,
  describeFilters,
  filtersFromSearch,
  filtersFromView,
  isFiltered,
  memberListSearch,
  searchFromFilters,
  viewFilters,
  viewHref,
} from './member-views';
import { MEMBER_COLUMNS, parseColumns } from './members-helpers';

const CH = `ch_${'2'.padStart(32, '0')}`;
const CL = `cl_${'6'.padStart(32, '0')}`;
const view = (name: string, filters: MemberView['filters']): MemberView => ({
  id: `mv_${name.length.toString().padStart(32, '0')}`,
  channelId: CH,
  name,
  filters,
  createdBy: null,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
});

describe('the Subscribers URL', () => {
  it('keeps the filters it understands and drops the rest', () => {
    expect(
      memberListSearch({
        channel: CH,
        status: 'active',
        tag: ' paid ',
        q: 'ada',
        circle: CL,
        cols: 'joined,name,nonsense,field:plan',
        other: 'x',
      }),
    ).toEqual({
      channel: CH,
      status: 'active',
      tag: 'paid',
      q: 'ada',
      circle: CL,
      cols: 'name,joined,field:plan',
    });
    expect(
      memberListSearch({
        channel: 'ch_nope',
        status: 'everyone',
        tag: '',
        q: 'x'.repeat(101),
        circle: 'cl_nope',
        cols: 'nonsense',
      }),
    ).toEqual({});
  });

  it('reads a number-looking search as text', () => {
    expect(memberListSearch({ q: 2026, tag: true })).toEqual({ q: '2026', tag: 'true' });
  });

  it('keeps an empty column list: only the email shows', () => {
    expect(memberListSearch({ cols: '' })).toEqual({ cols: '' });
    expect(filtersFromSearch({ cols: '' })).toEqual({ columns: [] });
    expect(parseColumns('')).toEqual([]);
  });

  it('round-trips filters through the URL', () => {
    const filters = {
      status: 'paused' as const,
      tag: 'paid',
      q: 'ada',
      circle: CL,
      columns: ['name' as const, 'field:plan' as const],
    };
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
    expect(searchFromFilters({ q: '  ' })).toEqual({});
  });
});

describe('saved views', () => {
  it('stores the filters and the columns on screen, in the shape the API checks', () => {
    const saved = viewFilters({ status: 'active', q: ' ada ', circle: CL }, ['name', 'tags']);
    expect(saved).toEqual({ status: 'active', q: 'ada', circleId: CL, columns: ['name', 'tags'] });
    expect(MemberViewFiltersSchema.safeParse(saved).success).toBe(true);
    expect(filtersFromView({ filters: saved })).toEqual({
      status: 'active',
      q: 'ada',
      circle: CL,
      columns: ['name', 'tags'],
    });
  });

  it('names the view whose filters and columns are on screen', () => {
    const paid = view('Paid', { status: 'active', tag: 'paid', columns: ['name'] });
    const pending = view('Pending', { status: 'pending' });
    const views = [paid, pending];
    expect(activeView(views, { status: 'active', tag: 'paid' }, ['name'])).toBe(paid);
    // Other columns: no longer the saved view.
    expect(activeView(views, { status: 'active', tag: 'paid' }, ['name', 'tags'])).toBeUndefined();
    // A view without columns matches whatever columns are shown.
    expect(activeView(views, { status: 'pending' }, ['tags'])).toBe(pending);
    expect(activeView(views, { status: 'pending', q: 'x' }, ['tags'])).toBeUndefined();
    expect(activeView(views, {}, ['name'])).toBeUndefined();
  });

  it('links to a view', () => {
    const href = viewHref(CH, view('Paid', { status: 'active', tag: 'paid reader' }));
    expect(href).toBe(`/members?channel=${CH}&status=active&tag=paid+reader`);
  });

  it('describes the filters in a few words', () => {
    expect(describeFilters({})).toBe('No filters');
    expect(
      describeFilters({ status: 'active', tag: 'paid', circle: CL, q: 'ada' }, () => 'Readers'),
    ).toBe('Active · Tag paid · Segment Readers · Search “ada”');
    expect(describeFilters({ circle: CL })).toBe('Segment not found');
    expect(isFiltered({ columns: ['name'] })).toBe(false);
    expect(isFiltered({ q: 'a' })).toBe(true);
  });

  it('knows the same columns as the API', () => {
    expect(MEMBER_COLUMNS.map((c) => c.id)).toEqual([...MEMBER_LIST_COLUMNS]);
    expect(MAX_MEMBER_VIEWS).toBeGreaterThan(0);
  });
});
