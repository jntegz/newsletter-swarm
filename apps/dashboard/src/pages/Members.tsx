// Members: search, filters (kept in the URL, so a view can be bookmarked), saved views, a column
// picker, row selection with bulk actions and the keyboard, the member drawer, adding a Member and
// (for admins) exporting.
import type { Channel, Member, MemberField, MemberListItem } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/client';
import { allCirclesQuery } from '../api/circles';
import {
  memberCountsQuery,
  memberFieldsQuery,
  memberViewsQuery,
  membersQuery,
  tagsQuery,
  useAddMember,
} from '../api/members';
import { emailCheckSummaryQuery } from '../api/emailChecks';
import { useChannelFlag } from '../api/queries';
import * as Icon from '../icons';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { When, WithChannel, numberFormat } from './common';
import { EmailCheckBar, EmailCheckDot, type EmailCheckFilter } from './EmailChecks';
import { BulkBar } from './MemberBulk';
import { MemberDrawer } from './MemberDrawer';
import { ExportDialog } from './MemberExport';
import { ViewsMenu } from './MemberViews';
import {
  activeView,
  filtersFromSearch,
  filtersFromView,
  isFiltered,
  searchFromFilters,
  type ListFilters,
  type MemberListSearch,
} from './member-views';
import {
  BULK_MAX,
  MEMBER_COLUMNS,
  MEMBER_STATUSES,
  FIELDS_UNAVAILABLE,
  STATUS_LABEL,
  STATUS_TONE,
  MAX_FIELD_COLUMNS,
  browserStorage,
  columnsStorageKey,
  engagementText,
  fieldColumn,
  fieldColumnKeys,
  fieldText,
  readColumns,
  toggleColumn,
  writeColumns,
  type ListColumn,
  type MemberColumn,
} from './members-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

const DIGEST_LABEL: Record<Member['digest'], string> = {
  every: 'Every post',
  weekly: 'Weekly digest',
  monthly: 'Monthly digest',
};

/** How long typing in the search waits before the list (and the URL) follows. */
const SEARCH_DELAY_MS = 300;

export function MembersPage({
  channelId,
  search = {},
}: {
  channelId: string | undefined;
  search?: MemberListSearch;
}) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/members', search: { channel: id } })}
    >
      {(channel, picker) => (
        <MemberList key={channel.id} channel={channel} picker={picker} search={search} />
      )}
    </WithChannel>
  );
}

/** Keys pressed in a text field, a select or an editor belong to it, not to the list. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type)
  );
}

type FilterPatch = { [K in keyof ListFilters]?: ListFilters[K] | undefined };

function MemberList({
  channel,
  picker,
  search: urlSearch,
}: {
  channel: Channel;
  picker: ReactNode;
  search: MemberListSearch;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const canEdit = RANK[channel.role] >= RANK.editor;
  const isAdmin = RANK[channel.role] >= RANK.admin;
  const rostersOn = useChannelFlag(channel.id, 'rosters') === true;
  const engagementOn = useChannelFlag(channel.id, 'engagement_scores') === true;
  const checksOn = useChannelFlag(channel.id, 'email_verification') === true;
  // Grey "not checked" dots only once checking is possible here.
  const checksAvailable =
    useQuery(emailCheckSummaryQuery(channel.id, checksOn)).data?.available === true;

  // The filters are the URL's: reload, Back and a bookmark all show the same list.
  const filters = filtersFromSearch(urlSearch);
  const { status, tag, circle } = filters;
  const q = filters.q ?? '';
  /** Merges into the URL's current filters, so a late search keystroke can't undo a chip. */
  const update = (patch: FilterPatch, { replace = false, all = false } = {}) =>
    void navigate({
      to: '/members',
      search: (prev: MemberListSearch) => ({
        channel: channel.id,
        ...searchFromFilters({ ...(all ? {} : filtersFromSearch(prev)), ...patch } as ListFilters),
      }),
      replace,
    });

  // The search box types ahead of the URL, which follows once typing pauses.
  const [searchText, setSearchText] = useState(q);
  const written = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    // The URL changed some other way (a view, Back, the command menu): show its search.
    if (q !== written.current) {
      written.current = q;
      setSearchText(q);
    }
  }, [q]);
  const onSearch = (value: string) => {
    setSearchText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      written.current = value.trim();
      update({ q: value.trim() || undefined }, { replace: true });
    }, SEARCH_DELAY_MS);
  };

  // The email check filter stays on this screen: saved views and the URL don't carry it.
  const [check, setCheck] = useState<EmailCheckFilter>({});

  // A stack of cursors per filter: the first page has none. Changing a filter starts again.
  const filterKey = JSON.stringify([q, status, tag, circle, check]);
  const [paging, setPaging] = useState<{ key: string; cursors: (string | null)[] }>({
    key: filterKey,
    cursors: [null],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [null];
  const cursor = cursors.at(-1) ?? null;

  // Columns: the URL's when it names them (a view or a bookmark), else this teammate's last choice.
  const storageKey = columnsStorageKey(me.operator.id);
  const [storedColumns, setStoredColumns] = useState<ListColumn[]>(() =>
    readColumns(browserStorage(), storageKey),
  );
  const columns = filters.columns ?? storedColumns;
  const profileFields = useQuery(memberFieldsQuery(channel.id));
  const fieldList = profileFields.data ?? [];
  // Field columns whose field was deleted are skipped, not sent: the API refuses unknown keys.
  const fieldKeys = fieldColumnKeys(columns, fieldList);
  const shownFields = fieldKeys.map((k) => fieldList.find((f) => f.key === k)!);

  const members = useQuery(
    membersQuery(channel.id, {
      cursor,
      status,
      tag,
      q,
      circle,
      fields: fieldKeys,
      emailCheck: check.state,
      emailCheckCode: check.code,
    }),
  );
  const counts = useQuery(memberCountsQuery(channel.id));
  const tags = useQuery(tagsQuery(channel.id));
  const segments = useQuery(allCirclesQuery(channel.id));
  const views = useQuery(memberViewsQuery(channel.id));
  const current = activeView(views.data ?? [], filters, columns);

  const changeColumns = (next: ListColumn[]) => {
    setStoredColumns(next);
    writeColumns(browserStorage(), storageKey, next);
    update({ columns: next }, { replace: true });
  };

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [openMember, setOpenMember] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = isFiltered(filters) || !!check.state;
  const items = members.data?.items ?? [];
  const total = counts.data ? MEMBER_STATUSES.reduce((sum, s) => sum + counts.data[s], 0) : null;

  /** Shows another set of filters at once, search box included. */
  const showFilters = (next: ListFilters) => {
    clearTimeout(timer.current);
    written.current = next.q ?? '';
    setSearchText(next.q ?? '');
    setCheck({});
    update(next, { all: true });
  };
  /** Back to everyone, keeping the columns on screen. */
  const clearFilters = () => showFilters(filters.columns ? { columns: filters.columns } : {});

  const pageIds = items.map((m) => m.id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BULK_MAX) next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageSelected === pageIds.length) pageIds.forEach((id) => next.delete(id));
      else for (const id of pageIds) if (next.size < BULK_MAX) next.add(id);
      return next;
    });

  const show = (column: MemberColumn) =>
    columns.includes(column) && (column !== 'engagement' || engagementOn);

  // "/" goes to the search from anywhere on the page, unless something else is being typed in.
  const searchBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      searchBox.current?.querySelector('input')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // In the table: the arrow keys move between rows (staying on the same control), Home and End
  // go to the first and last row, Enter opens the subscriber and x selects them.
  const table = useRef<HTMLTableElement>(null);
  const onTableKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
    const target = event.target as HTMLElement;
    const row = target.closest('tr');
    const body = table.current?.tBodies[0];
    if (!row || !body) return;
    const rows = [...body.rows];
    const at = rows.indexOf(row);
    const id = row.dataset.memberId;
    const controls = (r: HTMLTableRowElement) => [
      ...r.querySelectorAll<HTMLElement>('[data-row-control]'),
    ];
    const moveTo = (next: HTMLTableRowElement | undefined) => {
      if (!next) return;
      event.preventDefault();
      const there = controls(next);
      const column = Math.max(0, controls(row).indexOf(target));
      (there[Math.min(column, there.length - 1)] ?? there[0])?.focus();
    };
    if (event.key === 'ArrowDown') moveTo(at === -1 ? rows[0] : rows[at + 1]);
    else if (event.key === 'ArrowUp') moveTo(at > 0 ? rows[at - 1] : undefined);
    else if (event.key === 'Home' && at !== -1) moveTo(rows[0]);
    else if (event.key === 'End' && at !== -1) moveTo(rows.at(-1));
    else if (event.key === 'Enter' && id && target.tagName !== 'BUTTON') {
      event.preventDefault();
      setOpenMember(id);
    } else if (event.key.toLowerCase() === 'x' && !event.shiftKey && id && canEdit) {
      event.preventDefault();
      toggle(id);
    }
  };
  const keyHint = useId();

  return (
    <>
      <PageHeader
        title="Subscribers"
        subtitle={`People who receive ${channel.name}.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {picker}
            {rostersOn && (
              <Link to="/rosters" search={{ channel: channel.id }} className="btn-ghost">
                Rosters
              </Link>
            )}
            {canEdit && (
              <Link
                to="/channels/$channelId/members-settings"
                params={{ channelId: channel.id }}
                className="btn-ghost"
              >
                Fields and tags
              </Link>
            )}
            {isAdmin && (
              <Button variant="ghost" onClick={() => setExporting(true)}>
                Export
              </Button>
            )}
            {canEdit && (
              <Link to="/members/import" search={{ channel: channel.id }} className="btn-ghost">
                Import subscribers
              </Link>
            )}
            {canEdit && (
              <Button onClick={() => setAdding(true)}>
                <Icon.Plus size={16} />
                Add subscriber
              </Button>
            )}
          </div>
        }
      />

      <div role="status" aria-live="polite" className="empty:hidden mb-4">
        {notice && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card-app border border-lavender-line bg-lavender px-4 py-3 text-[13.5px] text-purple-deep">
            <span>{notice}</span>
            <Button variant="quiet" size="sm" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        )}
      </div>

      {/* The toolbar: every control in this row is 36px high. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div ref={searchBox} className="relative w-full sm:w-72">
          <Icon.Search
            size={16}
            className="pointer-events-none absolute top-[18px] left-3 z-[1] -translate-y-1/2 text-sub"
          />
          <TextField
            label="Search"
            hideLabel
            type="search"
            size="sm"
            className="pl-9"
            placeholder="Search by email or name"
            maxLength={100}
            value={searchText}
            onChange={(event) => onSearch(event.target.value)}
            aria-keyshortcuts="/"
          />
        </div>
        <ListFilter
          label="Tag"
          any="Any tag"
          options={(tags.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
          value={tag}
          onChange={(next) => update({ tag: next })}
        />
        <ListFilter
          label="Segment"
          any="Any segment"
          missing="Segment not found"
          options={(segments.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          value={circle}
          onChange={(next) => update({ circle: next })}
        />
        <div className="ml-auto flex min-w-0 items-center gap-2 max-sm:relative">
          <ViewsMenu
            channelId={channel.id}
            canEdit={canEdit}
            views={views.data}
            loadError={views.error?.message ?? null}
            active={current}
            filters={filters}
            columns={columns}
            segmentName={(id) => segments.data?.find((c) => c.id === id)?.name}
            onApply={(view) => (view ? showFilters(filtersFromView(view)) : clearFilters())}
            onNotice={setNotice}
          />
          <ColumnPicker
            columns={columns}
            fields={fieldList}
            engagementOn={engagementOn}
            onChange={changeColumns}
          />
        </div>
      </div>

      <div role="group" aria-label="Filter by status" className="line-chips mb-4">
        {([undefined, ...MEMBER_STATUSES] as const).map((value) => {
          const count = value ? counts.data?.[value] : total;
          return (
            <button
              key={value ?? 'all'}
              type="button"
              aria-pressed={status === value}
              onClick={() => update({ status: value })}
              className="line-chip"
            >
              {value ? STATUS_LABEL[value] : 'All'}
              {count !== undefined && count !== null && (
                <span className="line-chip-count tabular">{numberFormat.format(count)}</span>
              )}
            </button>
          );
        })}
      </div>

      {checksOn && <EmailCheckBar channel={channel} filter={check} onFilter={setCheck} />}

      {canEdit && (
        <BulkBar
          channelId={channel.id}
          selected={selected}
          onClear={() => setSelected(new Set())}
          onStarted={() => setSelected(new Set())}
        />
      )}

      {members.isPending && <LoadingRows label="Loading subscribers" />}
      {members.error && <ErrorNotice message={members.error.message} />}
      {members.data && items.length === 0 && (filtered || cursors.length > 1) && (
        <EmptyState
          title="No subscribers match"
          action={
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        >
          Try another search, status, tag or segment.
        </EmptyState>
      )}
      {members.data && items.length === 0 && !filtered && cursors.length === 1 && (
        <EmptyState
          title="No subscribers yet"
          action={
            canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  to="/members/import"
                  search={{ channel: channel.id }}
                  className="btn-primary btn-sm"
                >
                  Import subscribers
                </Link>
                <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
                  Add subscriber
                </Button>
              </div>
            )
          }
        >
          Import a list you already have, or add the people who asked to hear from you. Everyone
          gets an unsubscribe link in every post.
        </EmptyState>
      )}
      {shownFields.some((f) => f.encrypted) && items.some((m) => m.encryptedUnavailable) && (
        <p role="status" className="mb-2 text-[13px] text-sub">
          {FIELDS_UNAVAILABLE}
        </p>
      )}
      {items.length > 0 && (
        <div
          className={`card-app overflow-x-auto ${members.isPlaceholderData ? 'opacity-60' : ''}`}
          aria-busy={members.isPlaceholderData || undefined}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys act on the row whose checkbox or email has focus */}
          <table
            ref={table}
            onKeyDown={onTableKeyDown}
            aria-describedby={keyHint}
            className="w-full min-w-[640px] text-left text-[13.5px]"
          >
            <caption className="sr-only">
              Subscribers of {channel.name}
              {selected.size > 0 ? `, ${numberFormat.format(selected.size)} selected` : ''}
            </caption>
            <thead>
              <tr className="table-head">
                {canEdit && (
                  <th scope="col" className="w-10 py-2.5 pl-5">
                    <PageCheckbox
                      checked={pageSelected > 0 && pageSelected === pageIds.length}
                      indeterminate={pageSelected > 0 && pageSelected < pageIds.length}
                      onChange={togglePage}
                    />
                  </th>
                )}
                <th scope="col" className={`py-2.5 font-semibold ${canEdit ? 'px-3' : 'px-5'}`}>
                  Email
                </th>
                {MEMBER_COLUMNS.filter((c) => show(c.id)).map((c) => (
                  <th key={c.id} scope="col" className="px-3 py-2.5 font-semibold last:pr-5">
                    {c.label}
                  </th>
                ))}
                {shownFields.map((f) => (
                  <th key={f.key} scope="col" className="px-3 py-2.5 font-semibold last:pr-5">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  columns={columns.filter((c) => c !== 'engagement' || engagementOn)}
                  fields={shownFields}
                  selectable={canEdit}
                  checksOn={checksOn}
                  checksAvailable={checksAvailable}
                  selected={selected.has(member.id)}
                  onToggle={() => toggle(member.id)}
                  onOpen={() => setOpenMember(member.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && (
        <p id={keyHint} className="mt-2 hidden text-[12.5px] text-sub sm:block">
          Press / to search and the arrow keys to move between subscribers. Enter opens one
          {canEdit ? ', and x selects it.' : '.'}
        </p>
      )}
      {selected.size >= BULK_MAX && (
        <p className="mt-2 text-[12.5px] text-sub">
          Bulk actions take up to {numberFormat.format(BULK_MAX)} subscribers at a time.
        </p>
      )}
      {(cursors.length > 1 || members.data?.nextCursor) && (
        <nav aria-label="Pages" className="mt-4 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1) })}
          >
            Newer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!members.data?.nextCursor || members.isPlaceholderData}
            onClick={() => {
              const next = members.data?.nextCursor;
              if (next) setPaging({ key: filterKey, cursors: [...cursors, next] });
            }}
          >
            Older
          </Button>
        </nav>
      )}

      <AddMemberDialog
        channelId={channel.id}
        requireConfirmation={channel.requireConfirmation}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(member) =>
          setNotice(
            member.status === 'pending'
              ? `${member.email} was added as pending. No email has been sent, and they receive nothing until they confirm.`
              : `${member.email} was added and will receive the next post.`,
          )
        }
      />
      {isAdmin && (
        <ExportDialog channel={channel} open={exporting} onClose={() => setExporting(false)} />
      )}
      <MemberDrawer
        channel={channel}
        memberId={openMember}
        onClose={() => setOpenMember(null)}
        onDeleted={(email) => setNotice(`${email} was deleted.`)}
      />
    </>
  );
}

function PageCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select every subscriber on this page"
      checked={checked}
      onChange={onChange}
      className="size-4 accent-purple"
    />
  );
}

function MemberRow({
  member,
  columns,
  fields,
  selectable,
  checksOn,
  checksAvailable,
  selected,
  onToggle,
  onOpen,
}: {
  member: MemberListItem;
  columns: ListColumn[];
  fields: MemberField[];
  selectable: boolean;
  checksOn: boolean;
  checksAvailable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
  const none = <span className="text-sub">—</span>;
  const cells: Record<MemberColumn, ReactNode> = {
    name: name || none,
    status: <Pill tone={STATUS_TONE[member.status]}>{STATUS_LABEL[member.status]}</Pill>,
    tags: member.tags.length ? (
      <span className="flex flex-wrap gap-1">
        {member.tags.slice(0, 3).map((t) => (
          <Pill key={t} tone="brand">
            {t}
          </Pill>
        ))}
        {member.tags.length > 3 && (
          <span className="text-[12px] text-sub">+{member.tags.length - 3}</span>
        )}
      </span>
    ) : (
      none
    ),
    digest: DIGEST_LABEL[member.digest],
    joined: (
      <span className="tabular text-sub">
        <When iso={member.createdAt} />
      </span>
    ),
    confirmed: (
      <span className="tabular text-sub">
        <When iso={member.confirmedAt} />
      </span>
    ),
    pausedUntil: (
      <span className="tabular text-sub">
        <When iso={member.pausedUntil} />
      </span>
    ),
    engagement: <span className="text-sub">{engagementText(member.engagement)}</span>,
  };
  return (
    <tr
      data-member-id={member.id}
      className={`border-t border-line ${selected ? 'bg-lavender' : 'hover:bg-surface-alt has-[:focus-visible]:bg-surface-alt'}`}
    >
      {selectable && (
        <td className="py-2 pl-5">
          <input
            type="checkbox"
            data-row-control
            aria-keyshortcuts="x"
            aria-label={`Select ${member.email}`}
            checked={selected}
            onChange={onToggle}
            className="size-4 accent-purple"
          />
        </td>
      )}
      <td className={`py-2 ${selectable ? 'px-3' : 'px-5'}`}>
        <span className="flex items-center gap-2">
          {checksOn && <EmailCheckDot check={member.emailCheck} showUnchecked={checksAvailable} />}
          <button
            type="button"
            data-row-control
            aria-haspopup="dialog"
            onClick={onOpen}
            className="min-h-8 rounded-[8px] text-left font-mono text-[12.5px] whitespace-nowrap text-ink hover:text-purple-deep hover:underline"
          >
            {member.email}
          </button>
        </span>
      </td>
      {MEMBER_COLUMNS.filter((c) => columns.includes(c.id)).map((c) => (
        <td key={c.id} className="px-3 py-2 whitespace-nowrap last:pr-5">
          {cells[c.id]}
        </td>
      ))}
      {fields.map((f) => (
        <td key={f.key} className="px-3 py-2 last:pr-5">
          {member.encryptedUnavailable && f.encrypted ? (
            <span className="text-sub">Unavailable</span>
          ) : (
            (fieldText(member.fields?.[f.key]) ?? none)
          )}
        </td>
      ))}
    </tr>
  );
}

/** A select over the list (tag, segment), shown once there is something to choose. */
function ListFilter({
  label,
  any,
  missing,
  options,
  value,
  onChange,
}: {
  label: string;
  /** The empty choice, such as "Any tag". */
  any: string;
  /** How to show a value that is no longer offered (a deleted segment); the value by default. */
  missing?: string;
  options: { value: string; label: string }[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  if (!options.length && !value) return null;
  const offered = !value || options.some((o) => o.value === value);
  return (
    <div className="min-w-0 flex-1 basis-[40%] sm:w-44 sm:flex-none sm:basis-auto">
      <SelectField
        label={label}
        hideLabel
        size="sm"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        options={[
          { value: '', label: any },
          ...(offered || !value ? [] : [{ value, label: missing ?? value }]),
          ...options,
        ]}
      />
    </div>
  );
}

/** A disclosure with a checkbox per optional column. Escape or a click outside closes it. */
function ColumnPicker({
  columns,
  fields,
  engagementOn,
  onChange,
}: {
  columns: ListColumn[];
  fields: MemberField[];
  engagementOn: boolean;
  onChange: (columns: ListColumn[]) => void;
}) {
  const fieldCount = fieldColumnKeys(columns, fields).length;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape handling for the disclosure inside
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="btn-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        Columns
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 z-20 mt-2 w-56 rounded-card-app border border-line-app bg-surface p-3 shadow-card"
      >
        <fieldset>
          <legend className="mb-2 text-[12.5px] font-semibold text-sub">Show columns</legend>
          <div className="grid gap-1">
            {MEMBER_COLUMNS.filter((c) => c.id !== 'engagement' || engagementOn).map((c) => (
              <label
                key={c.id}
                className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 text-[13.5px] hover:bg-surface-alt"
              >
                <input
                  type="checkbox"
                  checked={columns.includes(c.id)}
                  onChange={() => onChange(toggleColumn(columns, c.id))}
                  className="size-4 accent-purple"
                />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
        {fields.length > 0 && (
          <fieldset className="mt-3 border-t border-line pt-3">
            <legend className="mb-2 text-[12.5px] font-semibold text-sub">Profile fields</legend>
            <div className="grid max-h-64 gap-1 overflow-y-auto">
              {fields.map((f) => {
                const id = fieldColumn(f.key);
                const checked = columns.includes(id);
                const full = !checked && fieldCount >= MAX_FIELD_COLUMNS;
                return (
                  <label
                    key={f.key}
                    className={`flex min-h-9 items-center gap-2.5 rounded-[8px] px-1.5 text-[13.5px] ${full ? 'cursor-not-allowed text-sub' : 'cursor-pointer hover:bg-surface-alt'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={full}
                      onChange={() => onChange(toggleColumn(columns, id))}
                      className="size-4 accent-purple"
                    />
                    {f.label}
                  </label>
                );
              })}
            </div>
            {fieldCount >= MAX_FIELD_COLUMNS && (
              <p className="mt-2 text-[12px] text-sub">
                Up to {MAX_FIELD_COLUMNS} profile fields at once.
              </p>
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}

function AddMemberDialog({
  channelId,
  requireConfirmation,
  open,
  onClose,
  onAdded,
}: {
  channelId: string;
  requireConfirmation: boolean;
  open: boolean;
  onClose: () => void;
  onAdded: (member: Member) => void;
}) {
  const add = useAddMember(channelId);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [consent, setConsent] = useState(false);
  const consentHint = useId();
  const error = add.error instanceof ApiError ? add.error : null;

  const close = () => {
    add.reset();
    setEmail('');
    setFirstName('');
    setLastName('');
    setConsent(false);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      {
        email,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        consent,
      },
      {
        onSuccess: (member) => {
          onAdded(member);
          close();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a subscriber"
      description="Only add people who asked to receive this publication."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="add-member" loading={add.isPending}>
            Add subscriber
          </Button>
        </>
      }
    >
      <form id="add-member" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Email"
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={error?.field('email') ?? (error?.code === 'conflict' ? error.message : undefined)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="First name"
            maxLength={80}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          <TextField
            label="Last name"
            maxLength={80}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <div className="rounded-card-app border border-line-app bg-surface-alt p-3.5">
          <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] font-semibold">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              aria-describedby={consentHint}
              className="mt-0.5 size-4 shrink-0 accent-purple"
            />
            They asked to receive this publication
          </label>
          <p id={consentHint} className="mt-1.5 pl-[26px] text-[12.5px] text-sub">
            {requireConfirmation
              ? 'This publication requires every subscriber to confirm, so they are emailed a confirmation and added as pending.'
              : consent
                ? 'They are added as active and receive the next post.'
                : 'Without this, they are added as pending. No email is sent yet, and they receive nothing until they confirm.'}
          </p>
        </div>
        {error && !error.details.length && error.code !== 'conflict' && (
          <ErrorNotice message={error.message} />
        )}
      </form>
    </Dialog>
  );
}
