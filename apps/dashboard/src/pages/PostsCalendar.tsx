// Posts → Calendar (flag content_calendar): a month of one publication's posts. Scheduled and sent
// posts sit on the day they send, in the person's time zone; drafts on their planned date, which
// schedules nothing. Dragging only ever moves a planned date. A real send moves through Change time,
// which uses the same scheduling route and checks as the editor. Below 768px the grid becomes a list.
import type { Channel, DispatchSummary } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { calendarQuery, useCreateDispatch, useSchedule, useSetPlannedDate } from '../api/send';
import * as Icon from '../icons';
import {
  addMonths,
  calendarDay,
  calendarKind,
  calendarSortKey,
  dayOf,
  firstDayOfWeek,
  monthGrid,
  type CalendarKind,
} from './calendar-dates';

const utc = (day: string) => new Date(`${day}T12:00:00.000Z`);
const monthLabel = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const timeLabel = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

const title = (post: DispatchSummary) => post.subject || 'Untitled post';

function statusText(post: DispatchSummary, kind: CalendarKind): string {
  switch (kind) {
    case 'draft':
      return 'Draft, planned';
    case 'scheduled':
      return `Scheduled, ${timeLabel.format(new Date(post.publishAt!))}`;
    case 'sending':
      return 'Sending';
    case 'sent':
      return `Sent, ${timeLabel.format(new Date(post.sentAt ?? post.updatedAt))}`;
    case 'past':
      return 'Past issue';
  }
}

/** A datetime-local value for a moment, in the person's time zone. */
function localInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Dialogs = { kind: 'plan' | 'send'; post: DispatchSummary } | null;

function Entry({
  post,
  canPlan,
  canSend,
  onDragStart,
  onDragEnd,
  onOpenDialog,
}: {
  post: DispatchSummary;
  canPlan: boolean;
  canSend: boolean;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  onOpenDialog: (dialog: NonNullable<Dialogs>) => void;
}) {
  const kind = calendarKind(post);
  if (!kind) return null;
  const movable = kind === 'draft' && canPlan;
  // Only a draft's planned date moves by dragging. A scheduled send is never draggable.
  const drag =
    movable && onDragStart
      ? {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.setData('text/plain', post.id);
            event.dataTransfer.effectAllowed = 'move';
            onDragStart(post.id);
          },
          onDragEnd,
        }
      : {};
  return (
    <li
      {...drag}
      data-kind={kind}
      className={`cal-entry ${movable && onDragStart ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <span className={`cal-mk cal-mk-${kind}`} aria-hidden="true" />
      <div className="min-w-0">
        <Link
          to="/dispatches/$dispatchId"
          params={{ dispatchId: post.id }}
          draggable={false}
          className="line-clamp-2 text-[13px] leading-[1.3] font-semibold text-ink no-underline hover:underline"
        >
          {title(post)}
        </Link>
        <span className="block text-[12px] leading-[1.35] text-sub">{statusText(post, kind)}</span>
        {movable && (
          <button
            type="button"
            className="cal-action"
            aria-label={`Move ${title(post)} to another day`}
            onClick={() => onOpenDialog({ kind: 'plan', post })}
          >
            Move
          </button>
        )}
        {kind === 'scheduled' && canSend && (
          <button
            type="button"
            className="cal-action"
            aria-label={`Change time of ${title(post)}`}
            onClick={() => onOpenDialog({ kind: 'send', post })}
          >
            Change time
          </button>
        )}
      </div>
    </li>
  );
}

/** Changes a draft's planned date. Saving it has no effect on sending, and says so. */
function PlanDialog({
  channelId,
  post,
  onClose,
}: {
  channelId: string;
  post: DispatchSummary;
  onClose: () => void;
}) {
  const plan = useSetPlannedDate(channelId);
  const [date, setDate] = useState(post.plannedDate ?? '');
  const save = (plannedDate: string | null) =>
    plan.mutate({ id: post.id, plannedDate }, { onSuccess: onClose });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (date) save(date);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Change planned date"
      description={`${title(post)}. A planned date is a goal for your team. It doesn’t schedule or send anything.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {post.plannedDate && (
            <Button variant="quiet" onClick={() => save(null)} disabled={plan.isPending}>
              Remove date
            </Button>
          )}
          <Button type="submit" form="plan-form" loading={plan.isPending} disabled={!date}>
            Save date
          </Button>
        </>
      }
    >
      <form id="plan-form" onSubmit={submit} className="pt-3">
        <TextField
          label="Planned date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </form>
      {plan.error && <ErrorNotice message={plan.error.message} />}
    </Dialog>
  );
}

/** Moves a real send, through the same route and pre-send checks as the editor. */
function SendTimeDialog({ post, onClose }: { post: DispatchSummary; onClose: () => void }) {
  const schedule = useSchedule(post.id);
  const [at, setAt] = useState(() => localInput(post.publishAt!));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (at) schedule.mutate(new Date(at).toISOString(), { onSuccess: onClose });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Change send time"
      description={`${title(post)} will email your subscribers at the new time. The pre-send checks run again, and if one fails the time stays as it is.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep current time
          </Button>
          <Button type="submit" form="send-time-form" loading={schedule.isPending} disabled={!at}>
            Change send time
          </Button>
        </>
      }
    >
      <form id="send-time-form" onSubmit={submit} className="pt-3">
        <TextField
          label="Send at"
          type="datetime-local"
          value={at}
          hint={`Time zone: ${zone}`}
          onChange={(e) => setAt(e.target.value)}
          required
        />
      </form>
      {schedule.error && <ErrorNotice title="Not moved" message={schedule.error.message} />}
    </Dialog>
  );
}

export function PostsCalendar({ channel }: { channel: Channel }) {
  const navigate = useNavigate();
  const canPlan = channel.role !== 'viewer';
  const canSend = ['editor', 'admin', 'owner'].includes(channel.role);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dayOf(new Date());
  const [month, setMonth] = useState(today.slice(0, 7));
  const weeks = useMemo(() => monthGrid(month, firstDayOfWeek()), [month]);
  const from = weeks[0]![0]!;
  const to = weeks.at(-1)![6]!;
  const posts = useQuery({
    ...calendarQuery(channel.id, from, to),
    placeholderData: keepPreviousData,
  });
  const byDay = useMemo(() => {
    const days = new Map<string, DispatchSummary[]>();
    for (const post of posts.data ?? []) {
      const day = calendarDay(post);
      if (day) days.set(day, [...(days.get(day) ?? []), post]);
    }
    for (const list of days.values()) {
      list.sort((a, b) => calendarSortKey(a).localeCompare(calendarSortKey(b)));
    }
    return days;
  }, [posts.data]);

  const plan = useSetPlannedDate(channel.id);
  const create = useCreateDispatch(channel.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [newDay, setNewDay] = useState(today);
  const [problem, setProblem] = useState<string | null>(null);

  const newPost = async (plannedDate: string) => {
    setProblem(null);
    try {
      const post = await create.mutateAsync({});
      // The draft exists either way, so a planned date that didn't save still opens it.
      await plan.mutateAsync({ id: post.id, plannedDate }).catch(() => undefined);
      void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId: post.id } });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The post wasn’t created.');
    }
  };

  const dropTarget = (day: string) =>
    dragging
      ? {
          onDragOver: (event: DragEvent) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (over !== day) setOver(day);
          },
          onDragLeave: () => setOver((current) => (current === day ? null : current)),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            const post = posts.data?.find((p) => p.id === dragging);
            setOver(null);
            setDragging(null);
            if (post && post.plannedDate !== day) {
              plan.mutate({ id: post.id, plannedDate: day });
            }
          },
        }
      : {};

  const entry = (post: DispatchSummary, draggable: boolean) => (
    <Entry
      key={post.id}
      post={post}
      canPlan={canPlan}
      canSend={canSend}
      onOpenDialog={setDialog}
      {...(draggable
        ? {
            onDragStart: setDragging,
            onDragEnd: () => {
              setDragging(null);
              setOver(null);
            },
          }
        : {})}
    />
  );

  const monthName = monthLabel.format(utc(`${month}-01`));
  const inMonth = [...byDay.entries()]
    .filter(([day]) => day.startsWith(month))
    .sort(([a], [b]) => a.localeCompare(b));
  const showsPast = inMonth.some(([, list]) => list.some((p) => calendarKind(p) === 'past'));

  return (
    <section aria-label="Calendar">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-[17px] font-[650] tracking-[-0.005em]" aria-live="polite">
          {monthName}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={month === today.slice(0, 7)}
            onClick={() => setMonth(today.slice(0, 7))}
          >
            Today
          </Button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            aria-label="Previous month"
            onClick={() => setMonth((m) => addMonths(m, -1))}
          >
            <Icon.ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            aria-label="Next month"
            onClick={() => setMonth((m) => addMonths(m, 1))}
          >
            <Icon.ChevronRight size={16} />
          </button>
        </div>
      </div>
      <p className="mb-4 max-w-[72ch] text-[13px] leading-[1.55] text-sub">
        Times are in {zone}. A planned date is a goal for your team and doesn’t schedule or send
        anything.{' '}
        {canPlan && (
          <span className="max-md:hidden">Drag a draft to another day, or use Move. </span>
        )}
        {canSend && 'To move a scheduled send, use Change time.'}
        {showsPast &&
          ' A past issue came from another platform: it’s on your website, and Swarm won’t email it.'}
      </p>
      {posts.isPending && <LoadingRows label="Loading the calendar" />}
      {posts.error && (
        <ErrorNotice
          message={posts.error.message}
          action={
            <Button variant="ghost" onClick={() => void posts.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {plan.error && <ErrorNotice title="Date not changed" message={plan.error.message} />}
      {problem && <ErrorNotice message={problem} />}

      {posts.data && (
        <>
          <table className="cal-grid max-md:hidden">
            <caption className="sr-only">Posts in {monthName}</caption>
            <thead>
              <tr>
                {weeks[0]!.map((day) => (
                  <th key={day} scope="col">
                    {weekdayLabel.format(utc(day))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((day) => {
                    const list = byDay.get(day) ?? [];
                    const isToday = day === today;
                    return (
                      <td
                        key={day}
                        data-day={day}
                        {...(isToday ? { 'aria-current': 'date' as const } : {})}
                        className={`group ${day.startsWith(month) ? '' : 'cal-other'} ${over === day ? 'cal-over' : ''}`}
                        {...dropTarget(day)}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={isToday ? 'cal-today' : 'cal-num'}>
                            <span className="sr-only">{dayLabel.format(utc(day))}</span>
                            <span aria-hidden="true">{Number(day.slice(8))}</span>
                          </span>
                          {isToday && <span className="text-[12px] font-semibold">Today</span>}
                        </div>
                        {list.length > 0 ? (
                          <ul className="mt-1.5 grid gap-1.5">
                            {list.map((post) => entry(post, true))}
                          </ul>
                        ) : (
                          canPlan &&
                          day >= today && (
                            <button
                              type="button"
                              className="cal-new"
                              aria-label={`New post for ${dayLabel.format(utc(day))}`}
                              disabled={create.isPending}
                              onClick={() => void newPost(day)}
                            >
                              <Icon.Plus size={14} />
                              New post
                            </button>
                          )
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="md:hidden">
            {canPlan && (
              <form
                className="mb-5 flex items-end gap-2 border-b border-line pb-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (newDay) void newPost(newDay);
                }}
              >
                <div className="min-w-0 flex-1">
                  <TextField
                    label="Planned date"
                    type="date"
                    value={newDay}
                    onChange={(e) => setNewDay(e.target.value)}
                  />
                </div>
                <Button type="submit" loading={create.isPending} className="mb-1 shrink-0">
                  New post
                </Button>
              </form>
            )}
            {inMonth.length === 0 ? (
              <p className="text-[14px] text-sub">No posts in {monthName}.</p>
            ) : (
              <ol className="grid">
                {inMonth.map(([day, list]) => (
                  <li key={day} className="border-b border-line py-3 first:pt-0">
                    <h3
                      className="mb-2 text-[13px] font-[650]"
                      {...(day === today ? { 'aria-current': 'date' as const } : {})}
                    >
                      {dayLabel.format(utc(day))}
                      {day === today && ', today'}
                    </h3>
                    <ul className="grid gap-2.5">{list.map((post) => entry(post, false))}</ul>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      {dialog?.kind === 'plan' && (
        <PlanDialog channelId={channel.id} post={dialog.post} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'send' && (
        <SendTimeDialog post={dialog.post} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}
