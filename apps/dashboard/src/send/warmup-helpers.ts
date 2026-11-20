// Settings → Sending → Warm-up: the words and numbers the section shows, worked out from a ramp.
// Nothing here renders or fetches, so the copy can be tested on its own.
import {
  RAMP_BOUNDS,
  RAMP_PACES,
  RAMP_PACE_KEYS,
  WARMUP_CADENCES,
  projectWarmup,
  rampCapAfterPaceChange,
  type Ramp,
  type RampPace,
  type RampPaceKey,
  type RampPaceValues,
  type WarmupCadence,
  type WarmupPlan,
} from '@swarm/domain';

const number = new Intl.NumberFormat('en-US');
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayYearFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const parseDay = (day: string) => new Date(`${day}T00:00:00Z`);

/** "Thu 19 Nov" for a UTC day, with the year once it is not this plan's year. */
export function formatDay(day: string, today?: string): string {
  if (today && day.slice(0, 4) !== today.slice(0, 4)) return dayYearFormat.format(parseDay(day));
  return dayFormat.format(parseDay(day));
}

/** "today", "tomorrow" or "Thu 19 Nov", for use in a sentence. */
export function relativeDay(day: string, today: string): string {
  const days = Math.round((parseDay(day).getTime() - parseDay(today).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return formatDay(day, today);
}

/** Which day of this warm-up today is, counting the day it started as day 1. */
export function dayNumber(ramp: Pick<Ramp, 'startedDay' | 'plan'>): number {
  const days = Math.round(
    (parseDay(ramp.plan.today).getTime() - parseDay(ramp.startedDay).getTime()) / 86_400_000,
  );
  return Math.max(1, days + 1);
}

export const subscribers = (n: number) =>
  `${number.format(n)} ${n === 1 ? 'subscriber' : 'subscribers'}`;

/** 1.5 → "50%". */
export const growthPercent = (growth: number) => `${Math.round((growth - 1) * 100)}%`;

export const PACE_NAMES: Record<RampPace, string> = {
  careful: 'Careful',
  standard: 'Standard',
  fast: 'Fast',
  custom: 'Custom',
};

const PACE_HINTS: Record<RampPaceKey, string> = {
  careful: 'For a brand-new domain, or a list you have not emailed in a while.',
  standard: 'Right for most publications.',
  fast: 'For a list that opens your emails often. Bounces and complaints show up sooner.',
};

/** "200 emails on the first day, then 50% more after each good day." */
export const paceSummary = (values: RampPaceValues) =>
  `${number.format(values.startCap)} emails on the first day, then ${growthPercent(values.growth)} more after each good day.`;

// ---- How often the publication sends ------------------------------------------------------

export const CADENCE_OPTIONS: { key: WarmupCadence; label: string; phrase: string }[] = [
  { key: 'daily', label: 'Every day', phrase: 'every day' },
  { key: 'few', label: 'A few times a week', phrase: 'a few times a week' },
  { key: 'weekly', label: 'Once a week', phrase: 'once a week' },
];

export const cadencePhrase = (cadence: WarmupCadence) =>
  CADENCE_OPTIONS.find((o) => o.key === cadence)?.phrase ?? 'once a week';

/**
 * The plan of a ramp for a publication that sends to its whole list at this rhythm, starting
 * today. `audience` plans for another list size (after an import, or one post's recipients).
 */
export function planFor(
  ramp: Ramp,
  cadence: WarmupCadence,
  audience: number = ramp.plan.audience,
): WarmupPlan {
  return projectWarmup(
    {
      status: ramp.status,
      day: ramp.day,
      capToday: ramp.capToday,
      sentToday: ramp.sentToday,
      growth: ramp.growth,
      maxCap: ramp.maxCap,
    },
    audience,
    ramp.plan.today,
    undefined,
    WARMUP_CADENCES[cadence],
  );
}

/** Whole days from one UTC day to another. */
export const daysBetween = (from: string, to: string) =>
  Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);

/** What today's limit is once the ramp has moved to today, and how much of it is left. */
export function todaysLimit(ramp: Ramp): { cap: number; left: number } {
  const cap = ramp.plan.days[0]?.cap ?? ramp.capToday;
  const used = ramp.day === ramp.plan.today ? ramp.sentToday : 0;
  return { cap, left: Math.max(0, cap - used) };
}

interface PaceOption {
  key: RampPaceKey;
  name: string;
  hint: string;
  values: RampPaceValues;
  /** The plan this pace would give the ramp, from today. */
  plan: WarmupPlan;
}

/**
 * The plan a ramp would follow from today at another pace, using the same rule the server applies
 * to today's limit. With `restart`, the ramp starts over from the pace's first day.
 */
export function previewPace(
  ramp: Ramp,
  values: RampPaceValues,
  restart = false,
  cadence?: WarmupCadence,
): WarmupPlan {
  const capToday = restart
    ? values.startCap
    : rampCapAfterPaceChange(
        {
          status: ramp.status,
          capToday: ramp.capToday,
          sentToday: ramp.sentToday,
          startCap: ramp.startCap,
          maxCap: ramp.maxCap,
        },
        values.startCap,
      );
  return projectWarmup(
    {
      status: restart ? 'warming' : ramp.status,
      // After a restart the row is today's; otherwise it keeps the day it is on.
      day: restart ? ramp.plan.today : ramp.day,
      capToday,
      sentToday: restart && ramp.day !== ramp.plan.today ? 0 : ramp.sentToday,
      growth: values.growth,
      maxCap: restart
        ? Math.max(ramp.maxCap, values.startCap + 1, ramp.plan.audience)
        : ramp.maxCap,
    },
    ramp.plan.audience,
    ramp.plan.today,
    undefined,
    cadence ? WARMUP_CADENCES[cadence] : undefined,
  );
}

export function paceOptions(ramp: Ramp, restart = false, cadence?: WarmupCadence): PaceOption[] {
  return RAMP_PACE_KEYS.map((key) => {
    const values = RAMP_PACES[ramp.kind][key];
    return {
      key,
      name: PACE_NAMES[key],
      hint: PACE_HINTS[key],
      values,
      plan: previewPace(ramp, values, restart, cadence),
    };
  });
}

/**
 * "Your whole list fits in one day from Thu 19 Nov." for a plan, or what to say instead. With a
 * rhythm, the date is said to depend on it.
 */
export function fullListSentence(plan: WarmupPlan, cadence?: WarmupCadence): string {
  if (plan.audience === 0) return 'You have no subscribers yet, so nothing is held back.';
  const list = `Your whole list of ${subscribers(plan.audience)}`;
  if (!plan.fullListDay) {
    return `${list} will not fit in one day within two years at this pace. Choose a faster pace.`;
  }
  if (plan.fullListDay <= plan.today) return `${list} fits in one day already.`;
  return `${list} fits in one day from ${formatDay(plan.fullListDay, plan.today)}${
    cadence ? `, if you send to everyone ${cadencePhrase(cadence)}` : ''
  }.`;
}

/** When a post sent today to everyone finishes going out. Null when there is nothing to add. */
export function sendDoneSentence(plan: WarmupPlan): string | null {
  if (plan.audience === 0 || !plan.sendDoneDay || plan.sendDoneDay <= plan.today) return null;
  return `A post sent to everyone today finishes going out ${
    relativeDay(plan.sendDoneDay, plan.today) === 'tomorrow'
      ? 'tomorrow'
      : `on ${formatDay(plan.sendDoneDay, plan.today)}`
  }.`;
}

/** Custom pace fields as typed, checked against the bounds of the ramp's kind. */
export function customPaceProblem(
  kind: Ramp['kind'],
  startCap: string,
  growthPct: string,
): { startCap?: string; growth?: string; values?: RampPaceValues } {
  const bounds = RAMP_BOUNDS[kind];
  const out: { startCap?: string; growth?: string; values?: RampPaceValues } = {};
  const start = Number(startCap);
  const pct = Number(growthPct);
  const minPct = Math.round((bounds.growth.min - 1) * 100);
  const maxPct = Math.round((bounds.growth.max - 1) * 100);
  if (
    !startCap.trim() ||
    !Number.isInteger(start) ||
    start < bounds.startCap.min ||
    start > bounds.startCap.max
  ) {
    out.startCap = `Enter a whole number from ${number.format(bounds.startCap.min)} to ${number.format(bounds.startCap.max)}.`;
  }
  if (!growthPct.trim() || !Number.isFinite(pct) || pct < minPct || pct > maxPct) {
    out.growth = `Enter a number from ${minPct} to ${maxPct}.`;
  }
  if (!out.startCap && !out.growth) {
    out.values = { startCap: start, growth: Math.round((1 + pct / 100) * 1000) / 1000 };
  }
  return out;
}

/**
 * The reason a pause shows, in the dashboard's words. Who paused it comes from `pausedBy`, never
 * from the words of the reason.
 */
export function pauseReason(ramp: Pick<Ramp, 'pausedReason' | 'pausedBy'>): {
  byHand: boolean;
  text: string;
} {
  if (ramp.pausedBy === 'person') {
    return { byHand: true, text: 'Someone on your team paused it by hand.' };
  }
  return {
    byHand: false,
    text: ramp.pausedReason || 'Bounces or spam complaints went over the limit.',
  };
}

// ---- The route ---------------------------------------------------------------------------

type StepState = 'done' | 'now' | 'ahead';
interface WarmupStep {
  id: 'verified' | 'pace' | 'warming' | 'full' | 'complete';
  title: string;
  state: StepState;
  detail: string;
}

/**
 * Where a domain is on the way from verified to complete. Exactly one step is "now" unless the
 * warm-up is complete, when every step is done.
 */
export function warmupSteps(ramp: Ramp, plan: WarmupPlan = ramp.plan): WarmupStep[] {
  const complete = ramp.status === 'complete';
  const fits = complete || (plan.fullListDay !== null && plan.fullListDay <= plan.today);
  const paceLine = `${PACE_NAMES[ramp.pace]}: starts at ${number.format(ramp.startCap)} a day, grows ${growthPercent(ramp.growth)} a day`;
  const day = dayNumber(ramp);

  let warming: string;
  if (ramp.skipped) warming = 'Skipped';
  else if (complete) warming = 'Finished';
  else if (ramp.status === 'paused') warming = `Paused on day ${day}`;
  else
    warming = `Day ${day}: ${number.format(Math.min(ramp.sentToday, ramp.capToday))} of ${number.format(ramp.capToday)} sent today`;

  let full: string;
  if (ramp.skipped) full = 'No daily limit';
  else if (plan.audience === 0) full = 'No subscribers yet';
  else if (fits) full = `${subscribers(plan.audience)} fit in one day`;
  else if (plan.fullListDay)
    full = `${ramp.status === 'paused' ? 'If you resume today: ' : ''}${formatDay(plan.fullListDay, plan.today)}`;
  else full = 'More than two years away at this pace';

  let done: string;
  if (ramp.skipped && ramp.skippedAt)
    done = `Skipped on ${dayYearFormat.format(new Date(ramp.skippedAt))}`;
  else if (complete) done = 'No daily limit';
  else if (plan.completeDay && ramp.maxCap <= Math.max(1, plan.audience) * 2)
    done = `At ${number.format(ramp.maxCap)} a day, around ${formatDay(plan.completeDay, plan.today)}`;
  else if (fits)
    done = `Nothing is held back. The limit only reaches ${number.format(ramp.maxCap)} a day if you send that much`;
  else done = `When the limit reaches ${number.format(ramp.maxCap)} a day`;

  const warmingState: StepState = complete || fits ? 'done' : 'now';
  return [
    {
      id: 'verified',
      title: ramp.kind === 'shared' ? 'Shared domain ready' : 'Domain verified',
      state: 'done',
      detail: ramp.domain,
    },
    { id: 'pace', title: 'Pace chosen', state: 'done', detail: paceLine },
    { id: 'warming', title: 'Warming up', state: warmingState, detail: warming },
    {
      id: 'full',
      title: 'Whole list in one day',
      state: fits ? 'done' : 'ahead',
      detail: full,
    },
    {
      id: 'complete',
      title: 'Complete',
      state: complete ? 'done' : fits ? 'now' : 'ahead',
      detail: done,
    },
  ];
}

/** The rows of the plan worth showing first: up to the day the list fits or a send finishes. */
export function planPreviewLength(plan: WarmupPlan, most = 8): number {
  const until = [plan.fullListDay, plan.sendDoneDay]
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  const index = until ? plan.days.findIndex((d) => d.day === until) : -1;
  return Math.min(plan.days.length, most, index === -1 ? most : Math.max(3, index + 1));
}

/** The ramp the publication's default sender uses: its own domain's, else the shared one. */
export function primaryRamp(
  ramps: Ramp[],
  defaultDomainId: string | null | undefined,
): Ramp | null {
  return (
    ramps.find((r) => defaultDomainId && r.sendingDomainId === defaultDomainId) ??
    ramps.find((r) => r.kind === 'custom') ??
    ramps[0] ??
    null
  );
}

/** A small rate as a percentage, without rounding 0.08% up to 0.1%. */
export const ratePercent = (rate: number) =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rate * 100)}%`;

/** When each day's limit starts over: "00:00 UTC (01:00 your time)". */
export function resetTime(now = new Date()): string {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
    midnight,
  );
  return local === '00:00' ? '00:00 UTC' : `00:00 UTC (${local} your time)`;
}
