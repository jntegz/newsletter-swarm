// The arithmetic and wire contract of sending limits, without zod, so the realtime worker's
// SendPacer can import it cheaply (`@swarm/domain/limit-windows`). The schemas, presets and the
// rest of the contract are in ./sending-limits, which re-exports this file.

/**
 * The counted windows, all in UTC: the clock hour (10:00 to 11:00), the calendar day (from
 * 00:00) and the calendar month (from the 1st). Fixed, not rolling: a window's count starts again
 * at zero when the next one begins.
 */
export const LIMIT_WINDOWS = ['hour', 'day', 'month'] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** When the window holding `now` began, in ms since the epoch. */
export function windowStart(window: LimitWindow, now: number): number {
  if (window === 'hour') return now - (now % HOUR_MS);
  if (window === 'day') return now - (now % DAY_MS);
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** When the window holding `now` ends and the next one starts counting from zero. */
export function windowEnd(window: LimitWindow, now: number): number {
  if (window === 'hour') return windowStart('hour', now) + HOUR_MS;
  if (window === 'day') return windowStart('day', now) + DAY_MS;
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/**
 * Who an email is for. `transactional` is mail someone is waiting for (sign-in links, signup
 * confirmations, receipts, invites, notices): it may use the whole of each window and goes ahead
 * of sends in the per-second line. `bulk` is posts, automation emails and one-off Direct Sends.
 */
export type MailPriority = 'transactional' | 'bulk';

/** The share of each hour, day and month that bulk mail leaves for transactional mail. */
const TRANSACTIONAL_RESERVE = 0.1;

/** How much of a window limit bulk mail may use: all but a tenth, and never all of it. */
export const bulkAllowance = (limit: number): number =>
  Math.max(0, limit - Math.max(1, Math.ceil(limit * TRANSACTIONAL_RESERVE)));

/** The stored limits; null means no limit of that kind (SendingLimitsSchema). */
export interface LimitValues {
  perSecond: number | null;
  perHour: number | null;
  perDay: number | null;
  perMonth: number | null;
}

export const WINDOW_LIMIT_KEY = {
  hour: 'perHour',
  day: 'perDay',
  month: 'perMonth',
} as const satisfies Record<LimitWindow, keyof LimitValues>;

/** The per-second rate that applies: the setting, lowered by MAIL_MAX_PER_SECOND when set. */
export function effectivePerSecond(
  limits: Pick<LimitValues, 'perSecond'>,
  ceiling: number | null | undefined,
): number | null {
  const values = [limits.perSecond, ceiling ?? null].filter(
    (value): value is number => value !== null && value > 0,
  );
  return values.length ? Math.min(...values) : null;
}

// ---- The SendPacer's methods, as the engine calls them -------------------------------------

/** What held mail back: the per-second line, a window, or the email service's own quota. */
export type LimitReason = 'second' | LimitWindow | 'service_day' | 'service_month';

export interface TurnRequest {
  /** Emails this turn would send. 0 only asks whether sending is open, and counts nothing. */
  count: number;
  priority: MailPriority;
  /**
   * The workspace a bulk turn sends for. While more than one workspace is sending bulk mail, each
   * may use only its share of the hour, day and month (SEND_WORKSPACE_SHARE_*), so one large
   * Broadcast can't take an install's whole window from the others. Absent: not shared.
   */
  workspaceId?: string;
  /**
   * More than one workspace exists on this install (the send worker reads it through a short
   * cache). Then a workspace's bulk mail is admitted in parts: at most SEND_ADMISSION_SHARE of
   * what is left for it of the hour and the day, until the last part of each window releases the
   * rest, so one very large send can't take a whole window before others arrive.
   */
  sharedInstall?: boolean;
  limits: LimitValues;
  /**
   * When `limits` were saved (sending_limits.updated_at; 0 when there is no row). The pacer keeps
   * the most recently saved limits it has been given and applies those to a turn that brings
   * older ones, so a worker's cached copy can never undo a change. Absent (the old take()): the
   * turn's own limits apply.
   */
  limitsSavedAt?: number;
  /**
   * The caller can come back later (a Direct Send's API client, told Retry-After): its turn is
   * refused while the email service says its quota is used up, as bulk turns are, whatever its
   * priority. Mail Swarm sends itself (sign-in links, confirmations) leaves it out and is still
   * tried, since the service may accept it.
   */
  canWait?: boolean;
  /**
   * MAIL_MAX_PER_SECOND, from the send worker: a number sets the ceiling the pacer applies to
   * every turn, null clears it, and absent (every other worker) leaves it as it is.
   */
  ceiling?: number | null;
  now?: number;
}

export interface LimitTurn {
  /** Emails this turn may send now: all, some (a window had fewer left) or none. */
  granted: number;
  /** How long to wait before sending them. */
  startInMs: number;
  /** For what was not granted: seconds before asking again is worthwhile. */
  retryAfterSeconds: number;
  /** Why not everything was granted; null when it was. */
  limit: LimitReason | null;
  /** When that window or quota resets, in ms; null for the per-second line. */
  resetsAt: number | null;
  /**
   * What held it back was this workspace's share, not the install's limits: other workspaces are
   * sending too, or a very large send is being admitted in parts. Absent when false.
   */
  share?: boolean;
}

export interface WindowUsage {
  used: number;
  limit: number | null;
  /** What bulk mail may use of the limit. */
  forSends: number | null;
  resetsAt: number;
}

export interface LimiterUsage {
  hour: WindowUsage;
  day: WindowUsage;
  month: WindowUsage;
  /** The email service said its quota is used up: bulk mail waits until then. */
  service: { window: 'day' | 'month'; until: number } | null;
  ceiling: number | null;
}

/**
 * A workspace counts as sending bulk mail for this long after its last bulk turn. While two or
 * more are, each may use at most an equal part of what bulk mail may use of the hour, day and
 * month; on its own a workspace may use all of it, so a single-tenant install is not limited.
 * Owner decision: whether installs serve several untrusting workspaces, and the share they get.
 */
export const SEND_WORKSPACE_ACTIVE_MS = 10 * 60 * 1000;
/** A workspace held back by its share asks again after this long (it isn't a window reset). */
export const SEND_WORKSPACE_RETRY_SECONDS = 60;
/**
 * The per-second line is shared between the workspaces that asked for a bulk turn this recently:
 * with n of them, each gets 1/n of the rate (a workspace alone gets all of it). Short, so a share
 * nobody uses goes back within seconds.
 */
export const SEND_LINE_ACTIVE_MS = 15_000;
/**
 * On an install with more than one workspace, a workspace's bulk mail may use at most this share
 * of what is left for it of the hour and of the day (the window's bulk allowance minus what the
 * other workspaces used), so a very large send is admitted in parts and others arriving later
 * still find room. Owner decision, like SEND_WORKSPACE_ACTIVE_MS.
 */
export const SEND_ADMISSION_SHARE = 0.5;
/** The last part of an hour or day in which the admission share no longer applies. */
export const SEND_ADMISSION_RELEASE = 0.2;
