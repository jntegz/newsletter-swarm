/**
 * The inbox rule decision: one pure function, no database and no clock of its own, so the engine
 * and anything that rehearses a Flow reach the same answer from the same facts. flows-holds.ts
 * loads the facts for a real run (loadInboxRuleFacts).
 *
 * A day is any 24 hours and a week any 7 days, counted back from the moment in question. "Newsletter
 * day" is the calendar day of a post in the Member's zone.
 */
import type { InboxHoldReason, InboxRules } from '@swarm/domain';
import { nextWeekdayTime, wallClock } from './flows-time';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
/** A held email goes this long after the one in front of it, so they leave in order. */
export const IN_LINE_GAP_MS = 60_000;
/** More than the rules can need to settle; a guard against a rule set that keeps moving. */
const MAX_RULE_PASSES = 32;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export interface InboxRuleFacts {
  now: number;
  rules: InboxRules;
  /** The Member's IANA zone when known, else the Channel's, else UTC (memberZone). */
  zone: string;
  /** The step is marked "send regardless": no rule holds it. */
  sendRegardless: boolean;
  /** When the Member's automated emails went, for the last 7 days at least. Exempt ones too. */
  recentSends: readonly number[];
  /** When this Member got or will get a post: sends, ones under way and scheduled ones. */
  posts: readonly number[];
  /** When this step's wait began; null when it hasn't been held yet. */
  heldSince: number | null;
  /** The latest time an earlier held email of this Member is due; null when none is in front. */
  ahead: number | null;
}

export type InboxRuleDecision =
  | { action: 'send' }
  | { action: 'hold'; reason: InboxHoldReason; until: number }
  /** The wait would pass maxHoldDays: the run exits instead of sending this late. */
  | { action: 'expire'; reason: InboxHoldReason; until: number };

/** Whether `ms` falls inside quiet hours in `zone`. A range may cross midnight. */
export function inQuietHours(ms: number, quiet: { start: string; end: string }, zone: string) {
  const clock = wallClock(ms, zone);
  const at = clock.hour * 60 + clock.minute;
  const [start, end] = [quiet.start, quiet.end].map((time) => {
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    return hour * 60 + minute;
  }) as [number, number];
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** When a limit of `max` per `windowMs` next has room at `at`, or null when it has room now. */
function limitOpensAt(
  sends: readonly number[],
  max: number,
  windowMs: number,
  at: number,
): number | null {
  const inWindow = sends.filter((sent) => sent > at - windowMs && sent <= at).sort((a, b) => a - b);
  if (inWindow.length < max) return null;
  return (inWindow[inWindow.length - max] as number) + windowMs;
}

const sameLocalDay = (a: number, b: number, zone: string) => {
  const x = wallClock(a, zone);
  const y = wallClock(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
};

type Block = { reason: InboxHoldReason; until: number };

/** The first rule that stops an email at `at`, in the order the sentence should name them. */
function firstBlock(facts: InboxRuleFacts, at: number): Block | null {
  const { rules, zone } = facts;
  if (rules.quietHours && inQuietHours(at, rules.quietHours, zone)) {
    return {
      reason: 'quiet_hours',
      until: nextWeekdayTime(at, EVERY_DAY, rules.quietHours.end, zone),
    };
  }
  if (rules.perDay !== null) {
    const until = limitOpensAt(facts.recentSends, rules.perDay, DAY_MS, at);
    if (until !== null) return { reason: 'daily_limit', until };
  }
  if (rules.perWeek !== null) {
    const until = limitOpensAt(facts.recentSends, rules.perWeek, WEEK_MS, at);
    if (until !== null) return { reason: 'weekly_limit', until };
  }
  if (rules.newsletterDay) {
    if (facts.posts.some((post) => sameLocalDay(post, at, zone))) {
      return { reason: 'newsletter_day', until: nextWeekdayTime(at, EVERY_DAY, '00:00', zone) };
    }
    const around = rules.newsletterDay.hoursAround * HOUR_MS;
    const near = facts.posts.filter((post) => Math.abs(post - at) < around);
    if (near.length) return { reason: 'near_post', until: Math.max(...near) + around };
  }
  return null;
}

/**
 * Whether the email goes now, waits, or has waited too long. Rules are checked again from the time
 * each one lifts, so the answer is the first moment every rule agrees, and the reason is the rule
 * that set it. An email held behind another stays behind it.
 */
export function decideInboxRules(facts: InboxRuleFacts): InboxRuleDecision {
  if (facts.sendRegardless) return { action: 'send' };
  let at = facts.now;
  let reason: InboxHoldReason | null = null;
  for (let pass = 0; pass < MAX_RULE_PASSES; pass++) {
    const block = firstBlock(facts, at);
    if (!block || block.until <= at) break;
    at = block.until;
    reason = block.reason;
  }
  if (facts.ahead !== null) {
    const behind = Math.max(facts.ahead, facts.now) + IN_LINE_GAP_MS;
    if (behind > at) {
      at = behind;
      reason ??= 'in_line';
    }
  }
  if (reason === null) return { action: 'send' };
  const since = facts.heldSince ?? facts.now;
  if (at - since > facts.rules.maxHoldDays * DAY_MS) {
    return { action: 'expire', reason, until: at };
  }
  return { action: 'hold', reason, until: at };
}
