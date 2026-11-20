// Scheduled publishing in the design studio (docs/site-themes.md, "Draft, preview, publish"): the
// times on offer, the words for a schedule, and the check before asking the server, which stays
// the authority. Times are the person's own: the form takes a local date and time, and the
// server gets an ISO instant.

// Mirrors of SITE_DESIGN_SCHEDULE_MIN_MS and _MAX_MS in @swarm/domain. Imported as values they
// would pull zod into the bundle.
export const SCHEDULE_MIN_MS = 5 * 60_000;
export const SCHEDULE_MAX_MS = 90 * 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local value for a moment, in the browser's time zone. */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The moment a datetime-local value names, or null when it isn't one. */
export function fromLocalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Why a time can't be scheduled, or null when it can. */
export function scheduleTimeProblem(at: Date | null, now = Date.now()): string | null {
  if (!at) return 'Choose a date and a time.';
  if (at.getTime() < now + SCHEDULE_MIN_MS) return 'Choose a time at least 5 minutes from now.';
  if (at.getTime() > now + SCHEDULE_MAX_MS) return 'Choose a time within the next 90 days.';
  return null;
}

interface QuickPick {
  label: string;
  at: Date;
}

/** 09:00 on the day `days` after `from`, local time. */
function nineOn(from: Date, days: number): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date;
}

/** "Tomorrow 09:00" and "Monday 09:00" (the next Monday after tomorrow, when that differs). */
export function quickPicks(now = new Date()): QuickPick[] {
  const tomorrow = nineOn(now, 1);
  const picks: QuickPick[] = [{ label: 'Tomorrow 09:00', at: tomorrow }];
  // getDay: 0 is Sunday, 1 is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday !== 1) picks.push({ label: 'Monday 09:00', at: nineOn(now, toMonday) });
  return picks;
}

/** A time to start the form on: tomorrow at 09:00. */
export const defaultScheduleTime = (now = new Date()) => nineOn(now, 1);

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Mon 10 Nov, 09:00". */
export const scheduleWhen = (at: Date) => `${dayFormat.format(at)}, ${timeFormat.format(at)}`;

/** "Mon 10 Nov, around 09:00": the cron runs every five minutes, so it can be a little late. */
export const scheduleAround = (at: Date) =>
  `${dayFormat.format(at)}, around ${timeFormat.format(at)}`;

/** "09:00" today, else "Mon 10 Nov, 09:00". */
export function scheduleTimeShort(at: Date, now = new Date()): string {
  return at.toDateString() === now.toDateString() ? timeFormat.format(at) : scheduleWhen(at);
}

/** What will go live: "The draft as it is now: Launch theme, 7 sections". */
export function draftSummary(themeName: string | null, sections: number): string {
  const theme = themeName ? `${themeName} theme` : 'Your own theme';
  return `The draft as it is now: ${theme}, ${sections} ${sections === 1 ? 'section' : 'sections'}`;
}

/** The person's time zone by name, such as "Europe/Berlin". */
export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time';
  } catch {
    return 'your local time';
  }
}
