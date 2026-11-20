import type { Channel, DispatchListItem, DispatchSummary } from '@swarm/domain';
import { Button, EmptyState, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useDebounced } from '../api/circles';
import { useChannelFlag } from '../api/queries';
import { postCountsQuery, postListQuery, useArchivePosts } from '../api/send';
import { NewPostMenu } from '../home/NewPostMenu';
import * as Icon from '../icons';
import { ARCHIVE_NOTE, canArchive } from '../send/send-helpers';
import { isPlainShortcut, isTypingTarget } from '../shell/keys';
import { useToast } from '../shell/toast';
import { useDisclosure } from '../shell/useDisclosure';
import { PageHeader } from './Channels';
import { PostsCalendar } from './PostsCalendar';
import { DispatchPill, When, WithChannel } from './common';
import {
  SHOW_CHIPS,
  STARTED_BY_OPTIONS,
  archiveToastText,
  authorName,
  cleanSearch,
  listFilterFor,
  rowClickOpens,
  sendRates,
  startedByLabel,
  type PostsListChange,
  type PostsListSearch,
} from './posts-list';

const VIA: Record<
  NonNullable<DispatchSummary['createdVia']>,
  { label: string; tone: 'neutral' | 'scheduled' }
> = {
  agent: { label: 'Agent', tone: 'scheduled' },
  copilot: { label: 'Copilot', tone: 'scheduled' },
  api: { label: 'API', tone: 'neutral' },
  feed: { label: 'Feed Sync', tone: 'neutral' },
};

type PostsView = 'list' | 'calendar';
const VIEW_KEY = 'swarm:posts-view';

function readView(): PostsView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}
function storeView(view: PostsView) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage can be blocked; the choice then lasts for this visit.
  }
}

const plannedFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const countFormat = new Intl.NumberFormat('en-GB');
/** The list answers with at most this many posts (the API's limit). */
const LIST_LIMIT = 200;

/** The sent, scheduled or planned moment of a post, in words where a date alone would mislead. */
function WhenCell({ dispatch }: { dispatch: DispatchSummary }) {
  if (dispatch.latestBroadcastId) {
    return (
      <Link
        to="/broadcasts/$broadcastId"
        params={{ broadcastId: dispatch.latestBroadcastId }}
        className="text-purple-deep"
      >
        <When iso={dispatch.sentAt ?? dispatch.updatedAt} />
      </Link>
    );
  }
  if (dispatch.importedAt) {
    return (
      <>
        On your website since <When iso={dispatch.webPublishedAt} />
      </>
    );
  }
  if (dispatch.status === 'draft' && dispatch.plannedDate) {
    return <>Planned for {plannedFormat.format(new Date(`${dispatch.plannedDate}T12:00:00Z`))}</>;
  }
  return <When iso={dispatch.publishAt} time />;
}

/** Who started a post: the agent, API or Feed Sync pill, or the teammate by name. */
function AuthorCell({ post }: { post: DispatchListItem }) {
  if (post.createdVia) {
    return <Pill tone={VIA[post.createdVia].tone}>{VIA[post.createdVia].label}</Pill>;
  }
  const name = authorName(post);
  if (!post.author) return <span className="text-sub">{name}</span>;
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <span className="inline-flex max-w-[180px] items-center gap-2">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-pill bg-lavender text-[11px] font-semibold text-purple-deep"
      >
        {initials}
      </span>
      <span className="truncate" title={name}>
        {name}
      </span>
    </span>
  );
}

export function DispatchesPage({
  channelId,
  filters = {},
}: {
  channelId: string | undefined;
  filters?: PostsListSearch;
}) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/dispatches', search: { channel: id } })}
    >
      {(channel, picker) => (
        <DispatchList
          key={channel.id}
          channel={channel}
          picker={picker}
          filters={filters}
          onFilters={(next) =>
            void navigate({
              to: '/dispatches',
              search: { ...(channelId ? { channel: channelId } : {}), ...cleanSearch(next) },
              replace: true,
            })
          }
        />
      )}
    </WithChannel>
  );
}

/** "Filter": the Started by choice, in a small menu next to the search. */
function FilterMenu({
  by,
  onChange,
}: {
  by: PostsListSearch['by'];
  onChange: (by: PostsListSearch['by']) => void;
}) {
  const menu = useDisclosure();
  const active = startedByLabel(by);
  return (
    <div className="relative">
      <button
        type="button"
        {...menu.buttonProps}
        className={`btn-ghost h-9 min-h-9 ${active ? 'border-purple text-ink' : ''}`}
      >
        <Icon.Filter size={16} />
        {active ?? 'Filter'}
        <Icon.ChevronDown size={16} />
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] left-0 w-[min(280px,calc(100vw-32px))]"
      >
        <fieldset>
          <legend className="px-2.5 pt-1.5 pb-1 text-[13px] font-semibold text-sub">
            Started by
          </legend>
          {STARTED_BY_OPTIONS.map((option) => (
            <label key={option.value ?? 'anyone'} className="line-menu-item cursor-pointer">
              <input
                type="radio"
                name="posts-started-by"
                className="size-4 shrink-0"
                checked={by === option.value}
                onChange={() => {
                  onChange(option.value);
                  menu.close(true);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

const NO_FILTERS: PostsListSearch = {};

export function DispatchList({
  channel,
  picker,
  filters = NO_FILTERS,
  onFilters = () => undefined,
}: {
  channel: Channel;
  picker: ReactNode;
  filters?: PostsListSearch;
  onFilters?: (next: PostsListChange) => void;
}) {
  // Authors and above write Dispatches; the Channel carries the operator's effective role.
  const canWrite = channel.role !== 'viewer';
  const canManage = ['editor', 'admin', 'owner'].includes(channel.role);
  const navigate = useNavigate();
  const toast = useToast();
  const feedSyncOn = useChannelFlag(channel.id, 'feed_sync') === true;
  const archiveFlag = useChannelFlag(channel.id, 'post_archive');
  const archiveOn = archiveFlag === true;
  const calendarOn = useChannelFlag(channel.id, 'content_calendar') === true;
  const [chosenView, setChosenView] = useState<PostsView>(readView);
  const view: PostsView = calendarOn ? chosenView : 'list';

  const filter = listFilterFor(filters, archiveOn);
  const shelf = filter.archived === 'only' ? 'archived' : 'active';
  const dispatches = useQuery({
    ...postListQuery(channel.id, filter),
    // An address that asks for the archive waits for the flag, so it doesn't ask twice.
    enabled: view === 'list' && (filters.show !== 'archived' || archiveFlag !== undefined),
  });
  const counts = useQuery({
    ...postCountsQuery(channel.id, { q: filters.q, startedBy: filters.by }),
    enabled: view === 'list',
  });

  // The search box: typed text goes to the address once it settles, and Back puts it back.
  const urlQ = filters.q ?? '';
  const [text, setText] = useState(urlQ);
  const [seenQ, setSeenQ] = useState(urlQ);
  if (urlQ !== seenQ) {
    setSeenQ(urlQ);
    if (urlQ !== text.trim()) setText(urlQ);
  }
  const settled = useDebounced(text.trim(), 300);
  const lastSettled = useRef(settled);
  useEffect(() => {
    if (settled === lastSettled.current) return;
    lastSettled.current = settled;
    if (settled !== urlQ) onFilters({ ...filters, q: settled });
  }, [settled, urlQ, filters, onFilters]);

  // Selection belongs to one filter: changing it starts again.
  const filterKey = JSON.stringify(filter);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: filterKey,
    ids: new Set(),
  });
  const selected = selection.key === filterKey ? selection.ids : new Set<string>();
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key: filterKey, ids });

  // Archive and restore act at once: the rows go while the list reloads, and a toast offers Undo.
  const archive = useArchivePosts(channel.id);
  const [hiding, setHiding] = useState<{ ids: ReadonlySet<string>; before: number } | null>(null);
  const hidden =
    hiding && dispatches.dataUpdatedAt <= hiding.before ? hiding.ids : new Set<string>();
  const rows = (dispatches.data ?? []).filter((d) => !hidden.has(d.id));

  const managing = archiveOn && canManage;
  const action = shelf === 'archived' ? 'restore' : 'archive';
  const selectable = managing ? rows.filter(canArchive) : [];
  const chosen = selectable.filter((d) => selected.has(d.id));

  const run = (nextAction: 'archive' | 'restore', ids: string[], undoable = true) => {
    if (!ids.length) return;
    setHiding({ ids: new Set(ids), before: dispatches.dataUpdatedAt });
    archive.mutate(
      { action: nextAction, ids },
      {
        onSuccess: (result) => {
          setSelected(new Set([...selected].filter((id) => !result.changed.includes(id))));
          const undo = nextAction === 'archive' ? 'restore' : 'archive';
          toast.show({
            message: archiveToastText(nextAction, result),
            ...(undoable && result.changed.length
              ? {
                  action: {
                    label: 'Undo',
                    onAction: () => run(undo, result.changed, false),
                  },
                }
              : {}),
            // A refusal is longer to read.
            ...(result.refused.length ? { duration: 10_000 } : {}),
          });
        },
        onError: () => setHiding(null),
      },
    );
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  // Keyboard: arrow keys move between rows (one row link is in the tab order at a time), Enter
  // opens, x selects; / goes to the search and c opens New post, while nothing else has the key.
  const searchRef = useRef<HTMLInputElement>(null);
  const newPostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [activeRow, setActiveRow] = useState(0);
  const current = Math.max(0, Math.min(activeRow, rows.length - 1));

  const focusRow = (index: number) => {
    const links = bodyRef.current?.querySelectorAll<HTMLElement>('a[data-row-link]') ?? [];
    const target = links[Math.max(0, Math.min(index, links.length - 1))];
    target?.focus();
  };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isPlainShortcut(event)) return;
      if (event.key === '/' && view === 'list' && searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
      } else if (event.key === 'c' && canWrite) {
        const button = newPostRef.current?.querySelector<HTMLButtonElement>(
          'button[aria-expanded="false"]',
        );
        if (!button) return;
        event.preventDefault();
        button.click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, canWrite]);

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
    const post = rows[index];
    if (!post) return;
    if (event.key === 'ArrowDown') focusRow(index + 1);
    else if (event.key === 'ArrowUp') {
      if (index === 0) searchRef.current?.focus();
      else focusRow(index - 1);
    } else if (event.key === 'Home') focusRow(0);
    else if (event.key === 'End') focusRow(rows.length - 1);
    else if (event.key === 'x' && managing && canArchive(post)) toggle(post.id);
    else return;
    event.preventDefault();
  };

  /** A click anywhere on a row opens it, as its subject link does; Ctrl/⌘ or a middle click opens a tab. */
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (event.button > 1 || !rowClickOpens(event.target, event.currentTarget)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
      const href = event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]')?.href;
      if (href) window.open(href, '_blank', 'noopener');
      return;
    }
    void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId: id } });
  };

  const newButton = canWrite && <NewPostMenu channel={channel} />;
  const filtered = !!(filters.q || filters.by || filters.show);
  const countFor = (value: (typeof SHOW_CHIPS)[number]['value']) =>
    counts.data ? (value ? counts.data[value] : counts.data.all) : null;
  const shownCount = countFor(filters.show === 'archived' && !archiveOn ? undefined : filters.show);
  const clearFilters = () => {
    setText('');
    onFilters({});
  };

  return (
    <>
      <PageHeader
        title="Posts"
        subtitle={`Issues of ${channel.name}.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            {feedSyncOn && (
              <Link
                to="/channels/$channelId/feeds"
                params={{ channelId: channel.id }}
                className="btn-ghost no-underline"
              >
                Feed Sync
              </Link>
            )}
            <div ref={newPostRef} className="contents">
              {newButton}
            </div>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {view === 'list' && (
          <>
            <div className="relative w-full sm:w-72">
              <label htmlFor="posts-search" className="sr-only">
                Search posts by subject
              </label>
              <Icon.Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sub"
              />
              <input
                ref={searchRef}
                id="posts-search"
                type="search"
                className="line-input h-9 min-h-9 pl-9 text-[14px]"
                placeholder="Search by subject"
                autoComplete="off"
                maxLength={100}
                aria-keyshortcuts="/"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && rows.length) {
                    event.preventDefault();
                    focusRow(current);
                  }
                }}
              />
            </div>
            <FilterMenu by={filters.by} onChange={(by) => onFilters({ ...filters, by })} />
          </>
        )}
        {calendarOn && (
          <fieldset className="ml-auto inline-flex min-w-0 rounded-control border border-line bg-surface-alt p-[3px]">
            <legend className="sr-only">Show posts as</legend>
            {(
              [
                { id: 'list', label: 'List' },
                { id: 'calendar', label: 'Calendar' },
              ] as const
            ).map((option) => (
              <label
                key={option.id}
                className={`inline-flex h-[28px] cursor-pointer items-center rounded-[6px] px-3 text-[13px] whitespace-nowrap transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
                  view === option.id
                    ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line-control)]'
                    : 'text-sub hover:text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="posts-view"
                  className="sr-only"
                  checked={view === option.id}
                  onChange={() => {
                    setChosenView(option.id);
                    storeView(option.id);
                  }}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      {view === 'calendar' ? (
        <PostsCalendar channel={channel} />
      ) : (
        <>
          <div role="group" aria-label="Filter by status" className="line-chips mb-4">
            {SHOW_CHIPS.filter((chip) => chip.value !== 'archived' || archiveOn).map((chip) => {
              const pressed =
                (filters.show === 'archived' && !archiveOn ? undefined : filters.show) ===
                chip.value;
              const count = countFor(chip.value);
              return (
                <button
                  key={chip.value ?? 'all'}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => onFilters({ ...filters, show: chip.value })}
                  className="line-chip"
                >
                  {chip.label}
                  {count !== null && (
                    <span className="line-chip-count tabular">{countFormat.format(count)}</span>
                  )}
                </button>
              );
            })}
          </div>

          {shelf === 'archived' && (
            <p className="mb-3 max-w-[72ch] text-[13px] leading-[1.55] text-sub">{ARCHIVE_NOTE}</p>
          )}
          {chosen.length > 0 && (
            <div className="mb-3 grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">{chosen.length} selected</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={archive.isPending}
                  onClick={() =>
                    run(
                      action,
                      chosen.map((d) => d.id),
                    )
                  }
                >
                  {action === 'archive' ? 'Archive' : 'Restore'} {chosen.length} post
                  {chosen.length === 1 ? '' : 's'}
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </div>
              {shelf === 'active' && (
                <p className="max-w-[72ch] text-[13px] leading-[1.55] text-sub">{ARCHIVE_NOTE}</p>
              )}
            </div>
          )}

          {dispatches.isPending && <LoadingRows label="Loading posts" />}
          {dispatches.error && (
            <ErrorNotice
              message={dispatches.error.message}
              action={
                <Button variant="ghost" onClick={() => void dispatches.refetch()}>
                  Try again
                </Button>
              }
            />
          )}
          {archive.error && <ErrorNotice message={archive.error.message} />}
          {dispatches.data &&
            rows.length === 0 &&
            !filtered &&
            (counts.data?.archived ? (
              <EmptyState title="Everything is archived" action={newButton}>
                Your archived posts are under Archived, where you can restore them.
              </EmptyState>
            ) : (
              <EmptyState title="No posts yet" action={newButton}>
                Write your first issue. It stays a draft until you send or schedule it.
              </EmptyState>
            ))}
          {dispatches.data &&
            rows.length === 0 &&
            filtered &&
            (shelf === 'archived' && !filters.q && !filters.by ? (
              <EmptyState title="No archived posts">
                Posts you archive appear here, and you can restore them at any time.
              </EmptyState>
            ) : (
              <EmptyState
                title="No posts match"
                action={
                  <Button size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              >
                Try another search, status or filter.
              </EmptyState>
            ))}
          {rows.length > 0 && (
            <div
              className={`card-app relative overflow-x-auto ${dispatches.isPlaceholderData ? 'opacity-60' : ''}`}
              aria-busy={dispatches.isPlaceholderData || undefined}
            >
              <table className="w-full min-w-[760px] text-left text-[13.5px]">
                <caption className="sr-only">
                  Posts of {channel.name}
                  {chosen.length > 0 ? `, ${chosen.length} selected` : ''}
                </caption>
                <thead>
                  <tr className="table-head">
                    {managing && (
                      <th scope="col" className="w-10 py-3 pl-3">
                        {selectable.length > 0 && (
                          <label className="grid size-8 cursor-pointer place-items-center">
                            <input
                              type="checkbox"
                              aria-label="Select all posts that can be changed"
                              checked={chosen.length === selectable.length}
                              onChange={(e) =>
                                setSelected(
                                  new Set(e.target.checked ? selectable.map((d) => d.id) : []),
                                )
                              }
                            />
                          </label>
                        )}
                      </th>
                    )}
                    <th scope="col" className={`${managing ? 'px-2' : 'px-5'} min-w-[200px] py-3`}>
                      Subject
                    </th>
                    <th scope="col" className="px-3 py-3">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-3">
                      Author
                    </th>
                    <th scope="col" className="px-3 py-3">
                      Sent or scheduled
                    </th>
                    <th scope="col" className="px-3 py-3 text-right">
                      Opens
                    </th>
                    <th scope="col" className="px-3 py-3 text-right">
                      Clicks
                    </th>
                    <th scope="col" className="hidden px-5 py-3 xl:table-cell">
                      Last edited
                    </th>
                    {managing && (
                      <th scope="col" className="px-5 py-3">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody ref={bodyRef}>
                  {rows.map((dispatch, index) => {
                    const subject = dispatch.subject || 'Untitled post';
                    const able = canArchive(dispatch);
                    const rates = sendRates(dispatch);
                    const isSelected = selected.has(dispatch.id);
                    return (
                      // The row is a bigger target for the subject link, which stays the way in
                      // for the keyboard and screen readers; the keys here only move between rows.
                      <tr
                        key={dispatch.id}
                        onClick={(event) => onRowClick(event, dispatch.id)}
                        onAuxClick={(event) => onRowClick(event, dispatch.id)}
                        onKeyDown={(event) => onRowKey(event, index)}
                        onFocus={() => setActiveRow(index)}
                        className={`cursor-pointer border-t border-line ${
                          isSelected
                            ? 'bg-lavender'
                            : 'hover:bg-surface-alt has-[a:focus-visible]:bg-surface-alt'
                        }`}
                      >
                        {managing && (
                          <td className="py-2 pl-3" data-row-ignore>
                            {able && (
                              <label className="grid size-8 cursor-pointer place-items-center">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${subject}`}
                                  aria-keyshortcuts="x"
                                  checked={isSelected}
                                  onChange={() => toggle(dispatch.id)}
                                />
                              </label>
                            )}
                          </td>
                        )}
                        <td className={`${managing ? 'px-2' : 'px-5'} py-3`}>
                          <Link
                            to="/dispatches/$dispatchId"
                            params={{ dispatchId: dispatch.id }}
                            data-row-link
                            tabIndex={index === current ? 0 : -1}
                            className="font-semibold text-ink no-underline hover:underline"
                          >
                            {subject}
                          </Link>
                          {dispatch.preheader && (
                            <p className="mt-0.5 line-clamp-1 text-[12.5px] text-sub">
                              {dispatch.preheader}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <DispatchPill status={dispatch.status} imported={!!dispatch.importedAt} />
                        </td>
                        <td className="px-3 py-3">
                          <AuthorCell post={dispatch} />
                        </td>
                        <td className="tabular px-3 py-3 whitespace-nowrap text-sub">
                          <WhenCell dispatch={dispatch} />
                        </td>
                        <td className="tabular px-3 py-3 text-right">{rates?.opens}</td>
                        <td className="tabular px-3 py-3 text-right">{rates?.clicks}</td>
                        <td className="tabular hidden px-5 py-3 whitespace-nowrap text-sub xl:table-cell">
                          <When iso={dispatch.updatedAt} />
                        </td>
                        {managing && (
                          <td
                            className="row-reveal px-5 py-3 text-right whitespace-nowrap"
                            data-row-ignore
                          >
                            {able ? (
                              <Button
                                variant="quiet"
                                size="sm"
                                aria-label={`${action === 'archive' ? 'Archive' : 'Restore'} ${subject}`}
                                disabled={archive.isPending}
                                onClick={() => run(action, [dispatch.id])}
                              >
                                {action === 'archive' ? 'Archive' : 'Restore'}
                              </Button>
                            ) : dispatch.status === 'scheduled' || dispatch.status === 'sending' ? (
                              <span className="text-[12.5px] text-sub">
                                Can’t archive until it’s sent
                              </span>
                            ) : null}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[13px] text-sub">
              <p>
                {shownCount !== null &&
                dispatches.data &&
                dispatches.data.length >= LIST_LIMIT &&
                shownCount > dispatches.data.length
                  ? `Showing the ${dispatches.data.length} most recently edited of ${countFormat.format(shownCount)}. Search to find older posts.`
                  : ''}
              </p>
              <p className="hidden pointer-fine:block">
                Arrow keys to move, Enter to open
                {managing ? ', x to select' : ''}, / to search
                {canWrite ? ', c for a new post' : ''}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}
