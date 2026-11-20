// Dates for the posts calendar, apart from its rendering so they are tested without a browser. A day
// is a YYYY-MM-DD string. Grid arithmetic runs in UTC, so a clock change never skips or repeats a day;
// only turning a moment into a day uses the person's time zone.
import type { DispatchSummary } from '@swarm/domain';

const MS_PER_DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const toUtc = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const addDays = (day: string, days: number) => fromUtc(toUtc(day) + days * MS_PER_DAY);

/** The day a moment falls on in a time zone (the browser's by default). */
export function dayOf(moment: string | Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(moment));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Moves a YYYY-MM month by a number of months. */
export function addMonths(month: string, months: number): string {
  const [year = 0, index = 1] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + months, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** The first day of the week where someone lives: 0 is Sunday. Monday if the browser can't say. */
export function firstDayOfWeek(locale?: string): number {
  try {
    const info = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    return ((info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
}

/** The whole weeks that show a month, each a list of seven days. */
export function monthGrid(month: string, firstDay: number): string[][] {
  const start = `${month}-01`;
  const lead = (new Date(toUtc(start)).getUTCDay() - firstDay + 7) % 7;
  const end = `${addMonths(month, 1)}-01`;
  const weeks: string[][] = [];
  let day = addDays(start, -lead);
  while (day < end) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
    day = addDays(day, 7);
  }
  return weeks;
}

type Post = Pick<
  DispatchSummary,
  'status' | 'plannedDate' | 'publishAt' | 'sentAt' | 'updatedAt' | 'webPublishedAt' | 'importedAt'
>;

/** A past issue is a draft in the table and never a draft to the person reading the calendar. */
export type CalendarKind = 'draft' | 'scheduled' | 'sending' | 'sent' | 'past';

export function calendarKind(post: Post): CalendarKind | null {
  if (post.importedAt && post.status === 'draft') return 'past';
  if (post.status === 'canceled') return null;
  return post.status;
}

/** The moment a post is placed by; a draft has only a date, which no time zone can move. */
const momentOf = (post: Post, kind: CalendarKind): string | null => {
  if (kind === 'scheduled') return post.publishAt;
  if (kind === 'past') return post.webPublishedAt;
  if (kind === 'draft') return null;
  return post.sentAt ?? post.updatedAt;
};

/** The day a post sits on, or null when it has no place on a calendar. */
export function calendarDay(post: Post, timeZone?: string): string | null {
  const kind = calendarKind(post);
  if (!kind) return null;
  if (kind === 'draft') return post.plannedDate;
  const moment = momentOf(post, kind);
  return moment ? dayOf(moment, timeZone) : null;
}

/** Earlier posts first; a draft, having no time, comes after the posts with one. */
export function calendarSortKey(post: Post): string {
  const kind = calendarKind(post);
  return (kind && momentOf(post, kind)) ?? '9999';
}
