// Warm-up (the Reputation Ramp): the named paces an admin can pick, and the day-by-day plan a ramp
// is expected to follow. Everything here is pure, so the API, the engine and the dashboard agree on
// the same numbers. The rules it mirrors live in @swarm/engine (ramp.ts: rollover and reserve).
import { z } from '@hono/zod-openapi';

/** A ramp on a verified sending domain of the Channel's own, or on the shared platform domain. */
export type RampKind = 'custom' | 'shared';

export const RAMP_PACE_KEYS = ['careful', 'standard', 'fast'] as const;
export type RampPaceKey = (typeof RAMP_PACE_KEYS)[number];
/** What a ramp reports: a named pace, or 'custom' when its numbers match none of them. */
export type RampPace = RampPaceKey | 'custom';

export interface RampPaceValues {
  /** Emails on the first day. */
  startCap: number;
  /** What the daily cap is multiplied by after a healthy day. */
  growth: number;
}

/**
 * The named paces. Standard is what every new ramp starts with. The shared domain's paces are
 * slower because every Channel on the instance shares its reputation.
 */
export const RAMP_PACES: Record<RampKind, Record<RampPaceKey, RampPaceValues>> = {
  custom: {
    careful: { startCap: 50, growth: 1.25 },
    standard: { startCap: 200, growth: 1.5 },
    fast: { startCap: 500, growth: 2 },
  },
  shared: {
    careful: { startCap: 50, growth: 1.2 },
    standard: { startCap: 100, growth: 1.3 },
    fast: { startCap: 200, growth: 1.5 },
  },
};

/** Bounds for a custom pace. The shared domain allows less, to protect the other Channels on it. */
export const RAMP_BOUNDS: Record<
  RampKind,
  { startCap: { min: number; max: number }; growth: { min: number; max: number } }
> = {
  custom: { startCap: { min: 10, max: 100_000 }, growth: { min: 1.05, max: 3 } },
  shared: { startCap: { min: 10, max: 500 }, growth: { min: 1.05, max: 1.5 } },
};

/**
 * Where warm-up on the shared domain ends unless an instance admin raises it: the default ceiling,
 * and the most a Channel admin may set there.
 */
export const SHARED_RAMP_MAX_CAP = 5_000;

/** The named pace whose numbers a ramp has, or 'custom'. */
export function rampPaceOf(kind: RampKind, startCap: number, growth: number): RampPace {
  for (const key of RAMP_PACE_KEYS) {
    const pace = RAMP_PACES[kind][key];
    if (pace.startCap === startCap && Math.abs(pace.growth - growth) < 1e-9) return key;
  }
  return 'custom';
}

/** Why custom numbers are refused for this kind of ramp, or null when they are fine. */
export function rampPaceProblem(kind: RampKind, values: Partial<RampPaceValues>): string | null {
  const bounds = RAMP_BOUNDS[kind];
  const where = kind === 'shared' ? ' on the shared domain' : '';
  if (
    values.startCap !== undefined &&
    (values.startCap < bounds.startCap.min || values.startCap > bounds.startCap.max)
  ) {
    return `The first day's limit must be between ${bounds.startCap.min} and ${bounds.startCap.max}${where}.`;
  }
  if (
    values.growth !== undefined &&
    (values.growth < bounds.growth.min || values.growth > bounds.growth.max)
  ) {
    return `Daily growth must be between ${bounds.growth.min} and ${bounds.growth.max}${where}.`;
  }
  return null;
}

/**
 * The cap of the day after a day with `cap`, when that day was healthy and at least half used.
 * The same arithmetic as the engine's rollover.
 */
export const nextRampCap = (cap: number, growth: number, maxCap: number) =>
  Math.min(maxCap, Math.ceil(cap * growth));

/**
 * Today's cap after a change of pace to `startCap`: the rule of the engine's updateRamp, so a
 * preview shows what saving will do.
 *
 * - A complete ramp keeps its cap.
 * - A ramp that has not grown yet (its cap is at or under its old start cap) takes the new start
 *   cap, held under the ceiling and never under what today already used.
 * - A ramp that has grown keeps its cap, or is raised to the new start cap. Never lowered.
 */
export function rampCapAfterPaceChange(
  ramp: {
    status: 'warming' | 'paused' | 'complete';
    capToday: number;
    sentToday: number;
    startCap: number;
    maxCap: number;
  },
  startCap: number,
): number {
  if (ramp.status === 'complete') return ramp.capToday;
  const wanted = Math.min(startCap, ramp.maxCap);
  return ramp.capToday <= ramp.startCap
    ? Math.max(wanted, ramp.sentToday)
    : Math.max(ramp.capToday, wanted);
}

// ---------------------------------------------------------------------------------------------
// The plan

/** The most days a plan lists. Dates past the list are still worked out. */
export const WARMUP_PLAN_MAX_DAYS = 60;
/** How far ahead the dates are looked for; a ramp that needs longer reports null. */
const WARMUP_PLAN_HORIZON_DAYS = 730;

export interface WarmupState {
  status: 'warming' | 'paused' | 'complete';
  /** The UTC day (YYYY-MM-DD) the cap and count below belong to. */
  day: string;
  capToday: number;
  sentToday: number;
  growth: number;
  maxCap: number;
}

interface WarmupPlanDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** The most emails that can go out that day. */
  cap: number;
  /**
   * How many people a post sent today to the whole audience has reached by the end of that day:
   * the caps so far (less what today already used), never more than the audience.
   */
  reach: number;
}

export interface WarmupPlan {
  /** The audience size the plan was made for: the Channel's active Members. */
  audience: number;
  /** The first day of the plan (the UTC day of the request). */
  today: string;
  /** Today first. Empty when the ramp is complete. At most WARMUP_PLAN_MAX_DAYS. */
  days: WarmupPlanDay[];
  /** The first day one day's cap covers the whole audience. Null when it is out of sight. */
  fullListDay: string | null;
  /** The day a post sent today to the whole audience finishes going out. */
  sendDoneDay: string | null;
  /** The day the cap reaches its ceiling and warm-up ends. Null when it is out of sight. */
  completeDay: string | null;
  /** True for a paused ramp: the plan is what happens if it is resumed today. */
  assumesResume: boolean;
  /** True when the plan runs past the listed days. */
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** How often a publication sends, for a plan made for its real rhythm. */
export const WARMUP_CADENCES = {
  daily: 1,
  few: 2,
  weekly: 7,
} as const;
export type WarmupCadence = keyof typeof WARMUP_CADENCES;

/**
 * The day-by-day plan of a ramp from `today` on, assuming every day is healthy. Writes nothing and
 * reads nothing.
 *
 * Without `sendEveryDays` the plan also assumes at least half of each day's cap is used, which is
 * what the cap needs to grow: the fastest a ramp can go, and what a publication that sends every
 * day gets.
 *
 * With `sendEveryDays` the plan follows a publication that sends one post to its whole audience
 * today and again every that many days, and nothing else. What does not fit in a day waits for the
 * next, as in the engine, and the cap grows only after a day that used at least half of it (the
 * engine's rollover). Days with nothing to send leave the cap where it is, so a weekly newsletter
 * gets there later than a daily one, and the cap stops growing for good once it is more than twice
 * the audience.
 *
 * - A ramp whose row is from an earlier day is first moved to today the way the engine's rollover
 *   would: one growth step if that last day was at least half used, none otherwise.
 * - A paused ramp is planned as if it were resumed today (`assumesResume`).
 * - A complete ramp has no plan: nothing limits it, so both dates are today.
 * - Once the cap reaches `maxCap` the ramp is complete and the whole audience fits, whatever its
 *   size.
 */
export function projectWarmup(
  state: WarmupState,
  audience: number,
  today: string,
  maxDays = WARMUP_PLAN_MAX_DAYS,
  sendEveryDays?: number,
): WarmupPlan {
  const size = Math.max(0, Math.floor(audience));
  const every = sendEveryDays === undefined ? null : Math.max(1, Math.floor(sendEveryDays));
  const plan: WarmupPlan = {
    audience: size,
    today,
    days: [],
    fullListDay: null,
    sendDoneDay: null,
    completeDay: null,
    assumesResume: state.status === 'paused',
    truncated: false,
  };
  if (state.status === 'complete') {
    return { ...plan, fullListDay: today, sendDoneDay: today, completeDay: today };
  }

  const maxCap = Math.max(1, state.maxCap);
  let cap = Math.max(0, state.capToday);
  let used = Math.max(0, state.sentToday);
  if (state.day < today) {
    // What rollover makes of the last day: a paused ramp keeps its cap.
    if (state.status === 'warming' && used >= cap / 2) cap = nextRampCap(cap, state.growth, maxCap);
    used = 0;
  }

  let reach = 0;
  // Emails waiting to go out. Without a rhythm there is always enough to fill the day.
  let waiting = every === null ? Infinity : 0;
  for (let i = 0; i < WARMUP_PLAN_HORIZON_DAYS; i++) {
    const day = addDays(today, i);
    // The cap reaching its ceiling ends the ramp: from that day nothing is held back.
    const complete = cap >= maxCap;
    if (every !== null && i % every === 0) waiting += size;
    const already = i === 0 ? used : 0;
    const sent = complete ? waiting : Math.min(waiting, Math.max(0, cap - already));
    waiting -= sent;
    // The first post is served first, so it is done once this many emails have gone out.
    reach = Math.min(size, reach + sent);
    if (complete && plan.completeDay === null) plan.completeDay = day;
    if (plan.fullListDay === null && (complete || cap >= size)) plan.fullListDay = day;
    if (plan.sendDoneDay === null && reach >= size) plan.sendDoneDay = day;
    if (i < maxDays) plan.days.push({ day, cap, reach });
    else plan.truncated = true;
    if (complete) break;
    // Nothing left to wait for: the list fits, and a post is under half the cap, so no later day
    // can grow it.
    if (
      every !== null &&
      waiting === 0 &&
      plan.fullListDay !== null &&
      plan.sendDoneDay !== null &&
      size < cap / 2
    ) {
      break;
    }
    // The engine's rule: the cap grows after a day that used at least half of it.
    if (already + sent < cap / 2) continue;
    const next = nextRampCap(cap, state.growth, maxCap);
    if (next <= cap) {
      // A cap that cannot grow: every later day looks the same, so finish the dates by division.
      if (plan.sendDoneDay === null && cap > 0) {
        const more = Math.ceil((size - reach) / cap);
        if (i + more < WARMUP_PLAN_HORIZON_DAYS) plan.sendDoneDay = addDays(today, i + more);
      }
      break;
    }
    cap = next;
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Schemas

export const RampPaceSchema = z.enum(['careful', 'standard', 'fast', 'custom']).openapi('RampPace');

export const WarmupPlanSchema = z
  .object({
    audience: z
      .number()
      .int()
      .openapi({ description: 'The Channel’s active Members when the plan was made' }),
    today: z.string().openapi({ description: 'The first day of the plan, a UTC day (YYYY-MM-DD)' }),
    days: z
      .array(
        z.object({
          day: z.string(),
          cap: z.number().int().openapi({ description: 'The most emails that day' }),
          reach: z.number().int().openapi({
            description:
              'How many people a post sent today to the whole audience has reached by the end of that day',
          }),
        }),
      )
      .max(WARMUP_PLAN_MAX_DAYS)
      .openapi({
        description:
          'Today first, assuming healthy days with at least half the cap used. Empty for a complete ramp.',
      }),
    fullListDay: z.string().nullable().openapi({
      description:
        'The first day one day’s cap covers the whole audience; null when more than two years away',
    }),
    sendDoneDay: z.string().nullable().openapi({
      description: 'The day a post sent today to the whole audience finishes going out',
    }),
    completeDay: z.string().nullable().openapi({
      description: 'The day the cap reaches maxCap and the ramp completes; null when out of sight',
    }),
    assumesResume: z
      .boolean()
      .openapi({ description: 'True for a paused ramp: the plan is what follows a resume today' }),
    truncated: z.boolean().openapi({ description: 'True when the plan runs past the listed days' }),
  })
  .openapi('WarmupPlan');
