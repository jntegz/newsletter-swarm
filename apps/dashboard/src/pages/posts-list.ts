// The posts list's filters, labels and keyboard rules, kept apart from the page so they can be
// tested without a browser.
import type { ArchiveResult, DispatchListItem, DispatchStartedBy } from '@swarm/domain';
import type { PostListFilter } from '../api/send';

/** A status chip: a status of the list, or the archive. */
type PostsShow = 'draft' | 'scheduled' | 'sent' | 'archived';

/** The list's state in the address: ?q= (search), ?show= (chip), ?by= (Started by). */
export interface PostsListSearch {
  q?: string;
  show?: PostsShow;
  by?: DispatchStartedBy;
}

const SHOWS: readonly PostsShow[] = ['draft', 'scheduled', 'sent', 'archived'];
const BYS: readonly DispatchStartedBy[] = ['people', 'agents'];

/** The search params of /dispatches that belong to the list; anything else is dropped. */
export function postsListSearch(search: Record<string, unknown>): PostsListSearch {
  const out: PostsListSearch = {};
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 100) : '';
  if (q) out.q = q;
  if (SHOWS.includes(search.show as PostsShow)) out.show = search.show as PostsShow;
  if (BYS.includes(search.by as DispatchStartedBy)) out.by = search.by as DispatchStartedBy;
  return out;
}

/** A change to the list's state, where undefined clears that part. */
export type PostsListChange = { [K in keyof PostsListSearch]?: PostsListSearch[K] | undefined };

/** The state to put in the address: empty parts left out. */
export function cleanSearch(change: PostsListChange): PostsListSearch {
  const out: PostsListSearch = {};
  if (change.q) out.q = change.q;
  if (change.show) out.show = change.show;
  if (change.by) out.by = change.by;
  return out;
}

/** The chips in order. Archived shows only while the archive is on. */
export const SHOW_CHIPS: readonly { value: PostsShow | undefined; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'sent', label: 'Sent' },
  { value: 'archived', label: 'Archived' },
];

export const STARTED_BY_OPTIONS: readonly {
  value: DispatchStartedBy | undefined;
  label: string;
}[] = [
  { value: undefined, label: 'Anyone' },
  { value: 'people', label: 'A teammate' },
  { value: 'agents', label: 'An agent or the API' },
];

/** What to ask the API for. With the archive off, the Archived chip doesn't exist. */
export function listFilterFor(search: PostsListSearch, archiveOn: boolean): PostListFilter {
  const show = search.show === 'archived' && !archiveOn ? undefined : search.show;
  return {
    archived: show === 'archived' ? 'only' : 'exclude',
    status: show === 'archived' ? undefined : show,
    q: search.q,
    startedBy: search.by,
  };
}

/** "Started by a teammate", or null when nobody is filtered out. */
export function startedByLabel(by: DispatchStartedBy | undefined): string | null {
  if (!by) return null;
  return `Started by ${by === 'people' ? 'a teammate' : 'an agent or the API'}`;
}

/** The teammate who started a post, by name where they gave one. */
export function authorName(post: Pick<DispatchListItem, 'author'>): string {
  return post.author ? post.author.name || post.author.email : 'Teammate';
}

const percentFormat = new Intl.NumberFormat('en-GB', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** 0.4823 → "48.2%", and 0.46 → "46.0%", so the column lines up. */
export const percent = (rate: number) => percentFormat.format(rate);

/**
 * The open and click rate of a post's latest send, or null where there is nothing to show yet:
 * not sent, or nothing delivered so far.
 */
export function sendRates(
  post: Pick<DispatchListItem, 'latestSend'>,
): { opens: string; clicks: string } | null {
  const send = post.latestSend;
  if (!send || send.delivered === 0) return null;
  return { opens: percent(send.openRate), clicks: percent(send.clickRate) };
}

const posts = (n: number) => `${n} post${n === 1 ? '' : 's'}`;

/** The toast after archiving or restoring: what changed, and what the server refused and why. */
export function archiveToastText(action: 'archive' | 'restore', result: ArchiveResult): string {
  const done = action === 'archive' ? 'Archived' : 'Restored';
  const changed = result.changed.length ? `${done} ${posts(result.changed.length)}` : '';
  const refused = result.refused.length;
  if (!refused) return changed;
  const why = `${posts(refused)} ${refused === 1 ? 'wasn’t' : 'weren’t'} changed: ${result.refused[0]!.message}`;
  return changed ? `${changed}. ${why}` : why;
}

/** Controls inside a row that keep their own click: the row doesn't open the post for them. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [data-row-ignore]';

/** Whether a click on a row should open its post (not a control, not the end of a text selection). */
export function rowClickOpens(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element) || !row.contains(target)) return false;
  if (target.closest(OWN_CLICK)) return false;
  const selection = window.getSelection();
  if (
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    row.contains(selection.anchorNode)
  ) {
    return false;
  }
  return true;
}
