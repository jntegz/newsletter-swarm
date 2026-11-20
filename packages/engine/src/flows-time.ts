/**
 * Delay node arithmetic for the Flows engine: durations, and "until the next listed weekday at
 * HH:MM" in an IANA time zone (DST-aware, through Intl; no time zone data of our own).
 */
import type { FlowNodeOf } from '@swarm/domain';

type DelayConfig = FlowNodeOf<'delay'>['config'];

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** Whether `zone` is an IANA zone the runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall-clock parts of instant `ms` in `zone`. */
export function wallClock(ms: number, zone: string) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of `zone` from UTC at instant `ms`, in ms (positive east of Greenwich). */
function offsetAt(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (ms - (ms % 1000));
}

/** The instant a wall-clock time in `zone` happens (the later one across a DST gap). */
function instantOf(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let at = guess - offsetAt(guess, zone);
  // Once more with the offset at the candidate instant, for days that change offset.
  at = guess - offsetAt(at, zone);
  return at;
}

/**
 * The next instant after `now` that is one of `weekdays` (0 = Sunday) at `time` (HH:MM) in
 * `zone`. Always within the next eight days.
 */
export function nextWeekdayTime(
  now: number,
  weekdays: readonly number[],
  time: string,
  zone: string,
): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const today = wallClock(now, zone);
  for (let d = 0; d <= 7; d++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    if (!weekdays.includes(date.getUTCDay())) continue;
    const at = instantOf(
      zone,
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
    );
    if (at > now) return at;
  }
  // Unreachable for a non-empty weekday list; a day from now keeps a run moving regardless.
  return now + 86_400_000;
}

/**
 * When a delay node started at `now` ends. `memberZone` is the zone resolved for the Member
 * (their `timezone` profile field, else the Channel's, else UTC) for config timezone 'member'.
 */
export function delayUntil(config: DelayConfig, now: number, memberZone: string): number {
  if (config.mode === 'duration') return now + config.amount * UNIT_MS[config.unit];
  const zone =
    config.timezone === 'member'
      ? memberZone
      : isTimeZone(config.timezone)
        ? config.timezone
        : 'UTC';
  return nextWeekdayTime(now, config.weekdays, config.time, zone);
}
