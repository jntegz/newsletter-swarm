// Pure helpers for the growth screens, mirrored from the server checks so problems show before a
// save: Split Test variants, Smart Prompt placements, Signup Journey variants, funnel rates and
// list reordering. The server stays the authority; these only spare a round trip.
import {
  CHAMPION_REWARD_KINDS,
  FUNNEL_STAGE_KEYS,
  SIGNUP_JOURNEY_MAX_STEPS,
  SPLIT_TEST_LABELS,
  SPLIT_TEST_MAX_VARIANTS,
  SPLIT_TEST_MIN_VARIANTS,
  SPLIT_TEST_PERCENT,
  SPLIT_TEST_WINDOW_MINUTES,
  type ChampionRewardKind,
  type DispatchDocument,
  type FunnelCounts,
  type FunnelStage,
  type SignupJourneyVariants,
  type SmartPromptPlacement,
  type SplitTestVariable,
} from '@swarm/domain';

/**
 * The kinds a reward can be picked as. Goods needs its flag, but a reward that is already Goods
 * keeps its kind so it still opens and saves.
 */
export function rewardKinds(
  goodsOn: boolean,
  current: ChampionRewardKind | undefined,
): ChampionRewardKind[] {
  return CHAMPION_REWARD_KINDS.filter((kind) => kind !== 'goods' || goodsOn || current === 'goods');
}

export interface Problem {
  /** The input path, as the API reports it (e.g. `variants.1.subject`). */
  path: string;
  message: string;
}

// ---- Split Tests ---------------------------------------------------------------------------

/** A variant as the setup form holds it. Variant A is always the Dispatch as written. */
interface VariantDraft {
  subject: string;
  preheader: string;
  content: DispatchDocument | null;
}

export interface SplitTestDraft {
  variable: SplitTestVariable;
  /** B to D (A is the Dispatch). */
  variants: VariantDraft[];
  testPercent: number;
  metric: 'opens' | 'clicks' | 'goal';
  windowMinutes: number;
}

/** Whether a document holds a top-level Smart Block (only variant A may have them). */
const hasSmartBlocks = (doc: DispatchDocument | null | undefined): boolean =>
  !!doc?.content.some((node) => node.type === 'smartBlock');

/** Problems with a Split Test setup, before it goes to the API. */
export function splitTestProblems(draft: SplitTestDraft): Problem[] {
  const problems: Problem[] = [];
  const total = draft.variants.length + 1;
  if (total < SPLIT_TEST_MIN_VARIANTS || total > SPLIT_TEST_MAX_VARIANTS) {
    problems.push({
      path: 'variants',
      message: `Test ${SPLIT_TEST_MIN_VARIANTS} to ${SPLIT_TEST_MAX_VARIANTS} variants.`,
    });
  }
  const subjects = new Set<string>();
  draft.variants.forEach((variant, i) => {
    const path = `variants.${i + 1}`;
    const label = SPLIT_TEST_LABELS[i + 1] ?? '?';
    if (draft.variable === 'subject') {
      const subject = variant.subject.trim();
      if (!subject) {
        problems.push({ path: `${path}.subject`, message: `Give variant ${label} a subject.` });
      } else if (subject.length > 200) {
        problems.push({
          path: `${path}.subject`,
          message: 'Keep the subject under 200 characters.',
        });
      } else if (subjects.has(subject.toLowerCase())) {
        problems.push({ path: `${path}.subject`, message: `Variant ${label} repeats a subject.` });
      }
      subjects.add(subject.toLowerCase());
      if (variant.preheader.trim().length > 200) {
        problems.push({
          path: `${path}.preheader`,
          message: 'Keep the preview text under 200 characters.',
        });
      }
    } else {
      if (!variant.content) {
        problems.push({ path: `${path}.content`, message: `Write variant ${label}'s content.` });
      } else if (hasSmartBlocks(variant.content)) {
        problems.push({
          path: `${path}.content`,
          message: `Only variant A can have smart blocks. Remove them from variant ${label}.`,
        });
      }
    }
  });
  if (
    !Number.isInteger(draft.testPercent) ||
    draft.testPercent < SPLIT_TEST_PERCENT.min ||
    draft.testPercent > SPLIT_TEST_PERCENT.max
  ) {
    problems.push({
      path: 'testPercent',
      message: `Test on ${SPLIT_TEST_PERCENT.min}% to ${SPLIT_TEST_PERCENT.max}% of the audience.`,
    });
  }
  if (
    !Number.isInteger(draft.windowMinutes) ||
    draft.windowMinutes < SPLIT_TEST_WINDOW_MINUTES.min ||
    draft.windowMinutes > SPLIT_TEST_WINDOW_MINUTES.max
  ) {
    problems.push({
      path: 'windowMinutes',
      message: 'Wait between 30 minutes and 7 days before picking the winner.',
    });
  }
  return problems;
}

/** A copy of a document with every Smart Block replaced by its content (for content variants). */
export function withoutSmartBlocks(doc: DispatchDocument): DispatchDocument {
  return {
    type: 'doc',
    content: doc.content.flatMap((node) =>
      node.type === 'smartBlock'
        ? ((node.content as Record<string, unknown>[] | undefined) ?? [])
        : [node],
    ),
  };
}

/** The request body for PUT /split-test. Variant A goes as {}. */
export function splitTestBody(draft: SplitTestDraft) {
  return {
    variable: draft.variable,
    testPercent: draft.testPercent,
    metric: draft.metric,
    windowMinutes: draft.windowMinutes,
    variants: [
      {},
      ...draft.variants.map((v) =>
        draft.variable === 'subject'
          ? {
              subject: v.subject.trim(),
              ...(v.preheader.trim() ? { preheader: v.preheader.trim() } : {}),
            }
          : { content: v.content as DispatchDocument },
      ),
    ],
  };
}

/** Each variant's share of the whole audience, in percent (rounded to one place). */
export function variantShare(testPercent: number, variants: number): number {
  if (variants <= 0) return 0;
  return Math.round((testPercent / variants) * 10) / 10;
}

/** "2 h", "45 min", "1 day 2 h". */
export function formatMinutes(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [
    days ? `${days} day${days === 1 ? '' : 's'}` : '',
    hours ? `${hours} h` : '',
    mins ? `${mins} min` : '',
  ].filter(Boolean);
  return parts.join(' ') || '0 min';
}

// ---- Smart Prompts -------------------------------------------------------------------------

const PLACEMENT_PATH = /^\/[A-Za-z0-9._~\-/*]*$/;

/** Problems with a Smart Prompt placement, the same rules the API applies. */
export function placementProblems(placement: SmartPromptPlacement): Problem[] {
  const problems: Problem[] = [];
  placement.paths.forEach((glob, i) => {
    if (!PLACEMENT_PATH.test(glob) || glob.startsWith('//')) {
      problems.push({
        path: `placement.paths.${i}`,
        message: `“${glob}”: paths start with / and may use * as a wildcard.`,
      });
    }
  });
  if (placement.paths.length > 20) {
    problems.push({ path: 'placement.paths', message: 'Use at most 20 paths.' });
  }
  const value = placement.value;
  if (placement.trigger === 'scroll' && (value === undefined || value < 1 || value > 100)) {
    problems.push({
      path: 'placement.value',
      message: 'Give the scroll depth as a percentage from 1 to 100.',
    });
  }
  if (placement.trigger === 'delay' && (value === undefined || value < 0 || value > 3600)) {
    problems.push({
      path: 'placement.value',
      message: 'Give the delay in seconds, up to 3,600.',
    });
  }
  if (placement.trigger === 'gate_hit' && placement.readers === 'everyone') {
    problems.push({
      path: 'placement.readers',
      message: 'A paywall prompt is for anonymous or free readers.',
    });
  }
  if (
    !Number.isInteger(placement.cooldownDays) ||
    placement.cooldownDays < 0 ||
    placement.cooldownDays > 365
  ) {
    problems.push({
      path: 'placement.cooldownDays',
      message: 'Wait 0 to 365 days before showing it again.',
    });
  }
  return problems;
}

/** Keeps `value` only for the triggers that use one. */
export function normalizePlacement(placement: SmartPromptPlacement): SmartPromptPlacement {
  const { value, ...rest } = placement;
  const paths = placement.paths.map((p) => p.trim()).filter(Boolean);
  return placement.trigger === 'scroll' || placement.trigger === 'delay'
    ? { ...rest, paths, ...(value !== undefined ? { value } : {}) }
    : { ...rest, paths };
}

export const DEFAULT_PLACEMENT: SmartPromptPlacement = {
  trigger: 'scroll',
  value: 50,
  paths: [],
  readers: 'anonymous',
  cooldownDays: 7,
};

/** One line for the list: "At 50% scroll · /p/* · anonymous readers". */
export function describePlacement(placement: SmartPromptPlacement): string {
  const when: Record<SmartPromptPlacement['trigger'], string> = {
    gate_hit: 'When a reader reaches a paywall',
    dispatch_end: 'At the end of a post',
    scroll: `At ${placement.value ?? 0}% scroll`,
    exit_intent: 'When a reader is about to leave',
    delay: `After ${placement.value ?? 0} s`,
  };
  const who: Record<SmartPromptPlacement['readers'], string> = {
    anonymous: 'readers who are not subscribers',
    free: 'non-subscribers and free subscribers',
    everyone: 'everyone',
  };
  const where = placement.paths.length ? placement.paths.join(', ') : 'every page';
  return `${when[placement.trigger]} · ${where} · ${who[placement.readers]}`;
}

// ---- Signup Journeys -----------------------------------------------------------------------

const VARIANT_KEY = /^[a-z]{1,8}$/;

/** Problems with a journey's variants, before they go to the API. */
export function journeyProblems(variants: SignupJourneyVariants): Problem[] {
  const problems: Problem[] = [];
  if (variants.length < 1 || variants.length > 4) {
    problems.push({ path: 'variants', message: 'Use 1 to 4 variants.' });
  }
  const keys = new Set<string>();
  variants.forEach((variant, i) => {
    const path = `variants.${i}`;
    if (!VARIANT_KEY.test(variant.key)) {
      problems.push({ path: `${path}.key`, message: 'Name variants with 1 to 8 letters.' });
    } else if (keys.has(variant.key)) {
      problems.push({ path: `${path}.key`, message: `Variant “${variant.key}” is used twice.` });
    }
    keys.add(variant.key);
    if (!Number.isInteger(variant.weight) || variant.weight < 1 || variant.weight > 100) {
      problems.push({ path: `${path}.weight`, message: 'Weights are whole numbers, 1 to 100.' });
    }
    if (variant.steps.length < 1 || variant.steps.length > SIGNUP_JOURNEY_MAX_STEPS) {
      problems.push({
        path: `${path}.steps`,
        message: `Give each variant 1 to ${SIGNUP_JOURNEY_MAX_STEPS} steps.`,
      });
    }
    variant.steps.forEach((step, j) => {
      const at = `${path}.steps.${j}`;
      if (step.kind === 'ask' && !step.askId) {
        problems.push({
          path: `${at}.askId`,
          message: 'Choose the poll or survey this step shows.',
        });
      }
      if (step.kind === 'welcome' && !step.headline.trim()) {
        problems.push({ path: `${at}.headline`, message: 'Give the welcome page a headline.' });
      }
    });
  });
  return problems;
}

/** Each variant's share of new Members, in percent. */
export function weightShares(variants: readonly { weight: number }[]): number[] {
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  return variants.map((v) => (total > 0 ? Math.round((Math.max(0, v.weight) / total) * 100) : 0));
}

/** The next unused variant key: a, b, c… */
export function nextVariantKey(used: readonly string[]): string {
  for (const key of 'abcdefghijklmnopqrstuvwxyz') if (!used.includes(key)) return key;
  return 'z';
}

// ---- Funnel Explorer -----------------------------------------------------------------------

export const FUNNEL_STAGE_LABEL: Record<FunnelStage, string> = {
  visits: 'Site visits',
  form_views: 'Form views',
  subscribes: 'Sign-ups',
  confirms: 'Confirmed',
  first_opens: 'First open',
  paid: 'Paid',
};

const ratePercent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/** A conversion rate (0–1) as a percentage; "—" when there was nothing to convert. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  if (rate > 0 && rate < 0.001) return '<0.1%';
  return ratePercent.format(rate);
}

/** The stage's count from a counts object. */
export const stageCount = (counts: FunnelCounts, stage: FunnelStage) =>
  counts[FUNNEL_STAGE_KEYS[stage]];

/** Bar widths for the stage chart, relative to the largest stage (0–100). */
export function stageWidths(counts: readonly number[]): number[] {
  const max = Math.max(0, ...counts);
  return counts.map((n) => (max > 0 ? Math.max(n > 0 ? 1 : 0, (n / max) * 100) : 0));
}

/** True when every count in the range is zero. */
export const funnelIsEmpty = (totals: FunnelCounts) => Object.values(totals).every((n) => n === 0);

// ---- Lists ---------------------------------------------------------------------------------

/** A copy of `list` with the item at `from` moved to `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The first problem for a path (or one below it), for inline errors. */
export const problemAt = (problems: readonly Problem[], path: string): string | undefined =>
  problems.find((p) => p.path === path || p.path.startsWith(`${path}.`))?.message;
