// The Subscribers list's filters as URL search params, and saved views (MemberView) as those
// filters. Pure, so the router and the command menu can use it and it can be unit tested.
//
// URL: /members?channel=ch_…&status=active&tag=paid&q=ada&circle=cl_…&cols=name,status,field:plan
// Every key is optional. Without `cols` the list shows the columns this teammate last chose.
import type { MemberStatus, MemberView, MemberViewFilters } from '@swarm/domain';
import { MEMBER_STATUSES, STATUS_LABEL, parseColumns, type ListColumn } from './members-helpers';

export interface ListFilters {
  status?: MemberStatus;
  tag?: string;
  q?: string;
  /** A segment (Circle) id. */
  circle?: string;
  /** The columns shown, when the URL or a view sets them. */
  columns?: ListColumn[];
}

/** The Subscribers route's search params, as strings. */
export interface MemberListSearch {
  channel?: string;
  status?: string;
  tag?: string;
  q?: string;
  circle?: string;
  cols?: string;
}

const CHANNEL = /^ch_[0-9a-f]{32}$/;
const CIRCLE = /^cl_[0-9a-f]{32}$/;

/** A search value as text; the router turns a numeric-looking value into a number. */
const text = (value: unknown, max: number): string | undefined => {
  const raw = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
};

const isStatus = (value: unknown): value is MemberStatus =>
  typeof value === 'string' && (MEMBER_STATUSES as readonly string[]).includes(value);

/** Drops absent keys, so search params stay optional under exactOptionalPropertyTypes. */
function compact<T extends object>(value: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** validateSearch for /members: anything unknown or malformed is dropped. */
export function memberListSearch(search: Record<string, unknown>): MemberListSearch {
  const channel = typeof search.channel === 'string' ? search.channel : undefined;
  const circle = typeof search.circle === 'string' ? search.circle : undefined;
  const cols = typeof search.cols === 'string' ? parseColumns(search.cols) : undefined;
  return compact<MemberListSearch>({
    channel: channel && CHANNEL.test(channel) ? channel : undefined,
    status: isStatus(search.status) ? search.status : undefined,
    tag: text(search.tag, 60),
    q: text(search.q, 100),
    circle: circle && CIRCLE.test(circle) ? circle : undefined,
    cols: cols ? cols.join(',') : undefined,
  });
}

export function filtersFromSearch(search: MemberListSearch): ListFilters {
  const columns = search.cols !== undefined ? parseColumns(search.cols) : undefined;
  return compact<ListFilters>({
    status: isStatus(search.status) ? search.status : undefined,
    tag: search.tag,
    q: search.q,
    circle: search.circle,
    columns,
  });
}

/** The search params for a set of filters (without `channel`). */
export function searchFromFilters(filters: ListFilters): Omit<MemberListSearch, 'channel'> {
  return compact<Omit<MemberListSearch, 'channel'>>({
    status: filters.status,
    tag: filters.tag,
    q: filters.q?.trim() || undefined,
    circle: filters.circle,
    cols: filters.columns ? filters.columns.join(',') : undefined,
  });
}

export function filtersFromView(view: Pick<MemberView, 'filters'>): ListFilters {
  const f = view.filters;
  return compact<ListFilters>({
    status: f.status,
    tag: f.tag,
    q: f.q,
    circle: f.circleId,
    columns: f.columns ? (parseColumns(f.columns.join(',')) ?? []) : undefined,
  });
}

/** What a view saves: the filters, and the columns on screen. */
export function viewFilters(
  filters: ListFilters,
  columns: readonly ListColumn[],
): MemberViewFilters {
  return compact<MemberViewFilters>({
    status: filters.status,
    tag: filters.tag,
    q: filters.q?.trim() || undefined,
    circleId: filters.circle,
    columns: [...columns],
  });
}

/** Whether any filter narrows the list (columns don't). */
export const isFiltered = (filters: ListFilters) =>
  !!(filters.status || filters.tag || filters.q?.trim() || filters.circle);

/** The filters in a few words, for the Views menu: "Active · Tag paid · Search “ada”". */
export function describeFilters(
  filters: ListFilters,
  segmentName: (id: string) => string | undefined = () => undefined,
): string {
  const q = filters.q?.trim();
  const parts = [
    filters.status && STATUS_LABEL[filters.status],
    filters.tag && `Tag ${filters.tag}`,
    filters.circle && `Segment ${segmentName(filters.circle) ?? 'not found'}`,
    q && `Search “${q}”`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No filters';
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The saved view the list is showing: the first whose filters are the current ones and whose
 * columns, when it has any, are the ones on screen.
 */
export function activeView<V extends Pick<MemberView, 'filters'>>(
  views: readonly V[],
  filters: ListFilters,
  columns: readonly ListColumn[],
): V | undefined {
  const q = filters.q?.trim() || undefined;
  return views.find((view) => {
    const f = filtersFromView(view);
    return (
      f.status === filters.status &&
      f.tag === filters.tag &&
      f.q === q &&
      f.circle === filters.circle &&
      (!f.columns || same(f.columns, columns))
    );
  });
}

/** The address of a saved view, for links and the command menu. */
export function viewHref(channelId: string, view: Pick<MemberView, 'filters'>): string {
  const params = new URLSearchParams({
    channel: channelId,
    ...searchFromFilters(filtersFromView(view)),
  });
  return `/members?${params}`;
}
