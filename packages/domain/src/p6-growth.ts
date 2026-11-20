// Growth (Phase 6): shared enums, limits and core types for Split Tests, Cohort Sampling, Smart
// Blocks, Champions, Ask, Signup Journeys, Smart Prompts, Series, Templates and the Funnel
// Explorer. Request and response schemas live next to their routes; these are the pieces more
// than one worker (or the dashboard) must agree on. Tables: migrations/0010_growth.sql.
import { z } from '@hono/zod-openapi';
import { CircleRuleSchema } from './audience';
import { idPattern } from './ids';
import { BroadcastSchema, DispatchDocumentSchema, EditorDecisionsUndoneSchema } from './send';
import { SendWaitSchema } from './sending-limits';

const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));
const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });

// ---------------------------------------------------------------------------------------------
// Split Tests (flag split_tests)

const SPLIT_TEST_VARIABLES = ['subject', 'content'] as const;
export type SplitTestVariable = (typeof SPLIT_TEST_VARIABLES)[number];
const SPLIT_TEST_METRICS = ['opens', 'clicks', 'goal'] as const;
const SPLIT_TEST_STATUSES = ['draft', 'testing', 'promoted', 'canceled'] as const;
export const SPLIT_TEST_LABELS = ['A', 'B', 'C', 'D'] as const;
export type SplitTestLabel = (typeof SPLIT_TEST_LABELS)[number];
export const SPLIT_TEST_MIN_VARIANTS = 2;
export const SPLIT_TEST_MAX_VARIANTS = 4;
export const SPLIT_TEST_PERCENT = { min: 5, max: 100 } as const;
export const SPLIT_TEST_WINDOW_MINUTES = { min: 30, max: 10_080 } as const;

/** split_tests.goal_json for metric 'goal': a member event within the window after delivery. */
export const SplitTestGoalSchema = z
  .object({
    event: z.enum(['level_purchased', 'api_event', 'link_clicked']),
    levelId: id('membershipLevel').optional(),
    name: z.string().max(60).optional(),
    url: z.url().max(2000).optional(),
  })
  .openapi('SplitTestGoal');
export type SplitTestGoal = z.infer<typeof SplitTestGoalSchema>;

export interface SplitTestVariantMetrics {
  variantId: string;
  label: SplitTestLabel;
  /** Delivered messages (sent minus bounced). */
  delivered: number;
  /** Human opens / clicks / goal conversions, counted once per Member. */
  value: number;
}

/**
 * The winner, deterministically: highest rate (value / delivered, 0 when nothing delivered),
 * then the most delivered, then the earliest label. Shared by the engine and its tests.
 */
export function pickSplitTestWinner(
  variants: readonly SplitTestVariantMetrics[],
): SplitTestVariantMetrics | undefined {
  const rate = (v: SplitTestVariantMetrics) => (v.delivered > 0 ? v.value / v.delivered : 0);
  return [...variants].sort(
    (a, b) => rate(b) - rate(a) || b.delivered - a.delivered || a.label.localeCompare(b.label),
  )[0];
}

/** Hash buckets for deterministic per-Member assignment: 0 … SPLIT_BUCKETS - 1. */
const SPLIT_BUCKETS = 10_000;

/**
 * A Member's bucket for one test (or sample): FNV-1a over `${seed}:${memberId}`, so the same
 * Member always lands in the same place for the same test, and different tests are independent.
 */
function splitBucket(seed: string, memberId: string): number {
  let hash = 0x811c9dc5;
  const input = `${seed}:${memberId}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % SPLIT_BUCKETS;
}

/** Whether a Member is in the first `percent` of a test or sample. */
export function inShare(seed: string, memberId: string, percent: number): boolean {
  return splitBucket(seed, memberId) < Math.round((percent / 100) * SPLIT_BUCKETS);
}

/**
 * Where a Member goes in a Split Test of `variants` variants with `testPercent` in the test:
 * a variant index (spread evenly over the test's buckets), or null when held for the winner.
 */
export function splitAssignment(
  seed: string,
  memberId: string,
  testPercent: number,
  variants: number,
): number | null {
  const inTest = Math.round((testPercent / 100) * SPLIT_BUCKETS);
  const bucket = splitBucket(seed, memberId);
  if (bucket >= inTest) return null;
  return Math.min(variants - 1, Math.floor((bucket * variants) / inTest));
}

const SplitTestVariantInputSchema = z
  .object({
    subject: z.string().trim().min(1).max(200).optional(),
    preheader: z.string().trim().max(200).optional(),
    content: DispatchDocumentSchema.optional(),
  })
  .openapi('SplitTestVariantInput');
export type SplitTestVariantInput = z.infer<typeof SplitTestVariantInputSchema>;

export const PutSplitTestSchema = z
  .object({
    variable: z.enum(SPLIT_TEST_VARIABLES),
    variants: z
      .array(SplitTestVariantInputSchema)
      .min(SPLIT_TEST_MIN_VARIANTS)
      .max(SPLIT_TEST_MAX_VARIANTS)
      .openapi({
        description:
          'A first, then B to D. Variant A is the Dispatch as written, so it is sent as {}. For a subject test each other variant has a subject (and optionally a preheader); for a content test, content (an editor document without Smart Blocks).',
      }),
    testPercent: z.number().int().min(SPLIT_TEST_PERCENT.min).max(SPLIT_TEST_PERCENT.max).openapi({
      description:
        'Share of the audience in the test, split evenly across the variants; the rest get the winner. At 100 every variant goes to its share and the test only reports.',
    }),
    metric: z.enum(SPLIT_TEST_METRICS),
    goal: SplitTestGoalSchema.nullable().optional().openapi({
      description: 'Required for the goal metric: the member event that counts as a conversion.',
    }),
    windowMinutes: z
      .number()
      .int()
      .min(SPLIT_TEST_WINDOW_MINUTES.min)
      .max(SPLIT_TEST_WINDOW_MINUTES.max),
  })
  .openapi('PutSplitTest');
export type PutSplitTest = z.infer<typeof PutSplitTestSchema>;

const SplitTestVariantSchema = z
  .object({
    id: id('splitTestVariant'),
    label: z.enum(SPLIT_TEST_LABELS),
    subject: z.string().nullable(),
    preheader: z.string().nullable(),
    content: DispatchDocumentSchema.nullable(),
    recipients: z.number().int().openapi({ description: 'Members assigned to this variant' }),
    delivered: z.number().int(),
    value: z.number().int().openapi({ description: 'Human opens, clicks or goal conversions' }),
    rate: z.number().openapi({ description: 'value / delivered' }),
  })
  .openapi('SplitTestVariant');
export const SplitTestSchema = z
  .object({
    id: id('splitTest'),
    dispatchId: id('dispatch'),
    broadcastId: id('broadcast').nullable(),
    variable: z.enum(SPLIT_TEST_VARIABLES),
    testPercent: z.number().int(),
    metric: z.enum(SPLIT_TEST_METRICS),
    goal: SplitTestGoalSchema.nullable(),
    windowMinutes: z.number().int(),
    status: z.enum(SPLIT_TEST_STATUSES),
    winnerVariantId: id('splitTestVariant').nullable(),
    startedAt: timestamp.nullable(),
    decideAt: timestamp.nullable(),
    decidedAt: timestamp.nullable(),
    variants: z.array(SplitTestVariantSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('SplitTest');
export type SplitTest = z.infer<typeof SplitTestSchema>;

/** The answer to saving a Split Test: an author's test takes a scheduled Dispatch back to draft. */
export const SavedSplitTestSchema = SplitTestSchema.extend({
  unscheduled: EditorDecisionsUndoneSchema.shape.unscheduled,
}).openapi('SavedSplitTest');

// ---------------------------------------------------------------------------------------------
// Cohort Sampling (flag cohort_sampling)

const COHORT_SAMPLE_STATUSES = ['draft', 'sampling', 'extended', 'halted', 'canceled'] as const;
/** Defaults offered in the send flow. Rates are fractions of delivered messages. */
export const COHORT_SAMPLE_DEFAULTS = {
  samplePercent: 10,
  windowMinutes: 120,
  minOpenRate: null as number | null,
  maxBounceRate: 0.05,
  maxComplaintRate: 0.001,
  maxUnsubscribeRate: 0.02,
} as const;

const fraction = () => z.number().gt(0).lt(1);

export const PutCohortSampleSchema = z
  .object({
    samplePercent: z.number().int().min(1).max(99).default(COHORT_SAMPLE_DEFAULTS.samplePercent),
    windowMinutes: z.number().int().min(30).max(2880).default(COHORT_SAMPLE_DEFAULTS.windowMinutes),
    minOpenRate: z.number().min(0).max(1).nullable().default(COHORT_SAMPLE_DEFAULTS.minOpenRate),
    maxBounceRate: fraction().default(COHORT_SAMPLE_DEFAULTS.maxBounceRate),
    maxComplaintRate: fraction().default(COHORT_SAMPLE_DEFAULTS.maxComplaintRate),
    maxUnsubscribeRate: fraction().default(COHORT_SAMPLE_DEFAULTS.maxUnsubscribeRate),
  })
  .openapi('PutCohortSample');
export type PutCohortSample = z.infer<typeof PutCohortSampleSchema>;

const CohortSampleMetricsSchema = z
  .object({
    sent: z.number().int(),
    delivered: z.number().int(),
    bounced: z.number().int(),
    complained: z.number().int(),
    unsubscribed: z.number().int(),
    opened: z.number().int().openapi({ description: 'Human opens' }),
    openRate: z.number(),
    bounceRate: z.number(),
    complaintRate: z.number(),
    unsubscribeRate: z.number(),
    passed: z.boolean(),
    /** Why the sample failed, one line per threshold missed. */
    reasons: z.array(z.string()),
  })
  .openapi('CohortSampleMetrics');
export type CohortSampleMetrics = z.infer<typeof CohortSampleMetricsSchema>;

export const CohortSampleSchema = z
  .object({
    id: id('cohortSample'),
    dispatchId: id('dispatch'),
    broadcastId: id('broadcast').nullable(),
    samplePercent: z.number().int(),
    windowMinutes: z.number().int(),
    minOpenRate: z.number().nullable(),
    maxBounceRate: z.number(),
    maxComplaintRate: z.number(),
    maxUnsubscribeRate: z.number(),
    status: z.enum(COHORT_SAMPLE_STATUSES),
    decideAt: timestamp.nullable(),
    decidedAt: timestamp.nullable(),
    /** The sample's health so far; once decided, what the decision was based on. */
    metrics: CohortSampleMetricsSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('CohortSample');
export type CohortSample = z.infer<typeof CohortSampleSchema>;

/** The answer to saving a Cohort Sample: an author's sample takes a scheduled Dispatch back to draft. */
export const SavedCohortSampleSchema = CohortSampleSchema.extend({
  unscheduled: EditorDecisionsUndoneSchema.shape.unscheduled,
}).openapi('SavedCohortSample');

/** GET /broadcasts/{id}: the Broadcast with its Split Test results or Cohort Sample, if any. */
export const BroadcastDetailSchema = BroadcastSchema.extend({
  splitTest: SplitTestSchema.nullable(),
  cohortSample: CohortSampleSchema.nullable(),
}).openapi('BroadcastDetail');
export type BroadcastDetail = z.infer<typeof BroadcastDetailSchema>;

/** The dashboard's send report: the detail, and whether the send waits for a sending limit. */
export const BroadcastReportSchema = BroadcastDetailSchema.extend({
  waiting: SendWaitSchema.nullable().openapi({
    description:
      'Set while the send waits for a sending limit or the email service; null while it sends or once it has finished.',
  }),
}).openapi('BroadcastReport');
export type BroadcastReport = z.infer<typeof BroadcastReportSchema>;

// ---------------------------------------------------------------------------------------------
// Smart Blocks (flag smart_blocks)

/**
 * The editor node: `{ type: 'smartBlock', attrs: SmartBlockAttrs, content: [...blocks] }`, top
 * level only, not nested in another Smart Block. Its children are ordinary blocks.
 *
 * Rendering contract (@swarm/mail): a Broadcast render wraps the i-th Smart Block (document
 * order, 0-based) in markers, in both the html and the text part:
 *   `<!--swarm:sb:<i>-->` … `<!--/swarm:sb:<i>-->`
 * The snapshot (or the Flow send) evaluates each block's condition for each recipient and stores
 * the visible indexes in broadcast_recipients.smart_blocks_json; personalisation keeps visible
 * blocks (dropping only the markers) and removes hidden ones with their content. The web page
 * renders a signed-in reader's view the same way, and anonymous readers get the fallback.
 * Conditions are Circle rules evaluated live (compiled per block per snapshot chunk).
 */
export const SMART_BLOCK_MAX = 20;
export const SmartBlockAttrsSchema = z
  .object({
    condition: CircleRuleSchema,
    /** Operator-facing label in the editor. */
    label: z.string().trim().max(80).optional(),
    /** What readers who aren't identified (web, anonymous) see: hide (default) or show. */
    anonymous: z.enum(['hide', 'show']).default('hide'),
  })
  .openapi('SmartBlockAttrs');
export type SmartBlockAttrs = z.infer<typeof SmartBlockAttrsSchema>;
/** GET /dispatches/{id}/preview: the email as one Member (or everyone) would get it. */
export const DispatchPreviewSchema = z
  .object({
    memberId: id('member').nullable(),
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    smartBlocks: z.array(
      z.object({
        index: z.number().int(),
        label: z.string().nullable(),
        visible: z.boolean().openapi({
          description: 'Shown to this Member (always true when no Member is given)',
        }),
      }),
    ),
  })
  .openapi('DispatchPreview');
export type DispatchPreview = z.infer<typeof DispatchPreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Champions (referrals)

export const CHAMPION_DEFAULTS = {
  /** Only confirmed referrals with at least one human open within this many days count. */
  engagementDays: 14,
  /** More than this many referrals for one Champion from one network prefix… */
  clusterLimit: 3,
  /** …within this many hours are held for review. */
  clusterWindowHours: 24,
  blockDisposable: true,
} as const;
export const REFERRAL_STATUSES = ['pending', 'counted', 'held', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_REVIEW_REASONS = [
  'disposable_domain',
  'ip_cluster',
  'not_engaged',
  'operator',
  'unsubscribed',
] as const;
export type ReferralReviewReason = (typeof REFERRAL_REVIEW_REASONS)[number];

export const CHAMPION_REWARD_KINDS = ['comp_level', 'coupon', 'goods', 'manual'] as const;
export type ChampionRewardKind = (typeof CHAMPION_REWARD_KINDS)[number];
export const CHAMPION_AWARD_STATUSES = ['pending', 'fulfilled', 'failed', 'revoked'] as const;
/** members.champion_code: lowercase letters and digits without look-alikes. */
export const CHAMPION_CODE = /^[a-hjkmnp-z2-9]{8}$/;
// ---------------------------------------------------------------------------------------------
// Ask (polls and surveys)

export const ASK_KINDS = ['poll', 'survey'] as const;
export type AskKind = (typeof ASK_KINDS)[number];
export const ASK_STATUSES = ['draft', 'open', 'closed'] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];
export const ASK_QUESTION_KINDS = ['choice', 'text'] as const;
export type AskQuestionKind = (typeof ASK_QUESTION_KINDS)[number];
export const ASK_SURFACES = ['email', 'page', 'journey'] as const;
export type AskSurface = (typeof ASK_SURFACES)[number];
export const ASK_MAX_QUESTIONS = 20;
export const ASK_MAX_OPTIONS = 10;
/**
 * One-tap poll links: token purpose 'ask' (@swarm/tokens), payload `{ m: memberId, o: optionId }`,
 * served at `/a/:token` by the capture worker. The GET shows a confirm page that auto-submits
 * (no state change on GET); the POST records the answer (one per Member per question; a second
 * answer replaces the first) and shows the results.
 */
export const ASK_TOKEN_PURPOSE = 'ask';
export const ASK_TOKEN_LIFETIME_DAYS = 90;

// ---------------------------------------------------------------------------------------------
// Signup Journeys (flag signup_journeys) and Smart Prompts (flag smart_prompts)

export const SIGNUP_JOURNEY_MAX_STEPS = 3;
const SignupJourneyStepSchema = z
  .discriminatedUnion('kind', [
    /** A profile question (flag reader_survey_on_subscribe). */
    z.object({ kind: z.literal('ask'), askId: id('ask') }),
    /** Partner recommendations (flag partner_exchange; Phase 8). */
    z.object({ kind: z.literal('recommendations') }),
    /** An upsell to a paid level. */
    z.object({ kind: z.literal('upsell'), levelId: id('membershipLevel').optional() }),
    /** A welcome page with a "No thanks" opt-out (flag welcome_page). */
    z.object({
      kind: z.literal('welcome'),
      headline: z.string().trim().min(1).max(120),
      body: z.string().trim().max(2000).optional(),
      optOutText: z.string().trim().max(80).optional(),
    }),
  ])
  .openapi('SignupJourneyStep');
export type SignupJourneyStep = z.infer<typeof SignupJourneyStepSchema>;

/** signup_journeys.variants_json: one variant = no test; weights are relative. */
export const SignupJourneyVariantsSchema = z
  .array(
    z.object({
      key: z.string().regex(/^[a-z]{1,8}$/),
      weight: z.number().int().min(1).max(100),
      steps: z.array(SignupJourneyStepSchema).min(1).max(SIGNUP_JOURNEY_MAX_STEPS),
    }),
  )
  .min(1)
  .max(4)
  .openapi('SignupJourneyVariants');
export type SignupJourneyVariants = z.infer<typeof SignupJourneyVariantsSchema>;

export const CAPTURE_FORM_KINDS = ['form', 'prompt'] as const;
export type CaptureFormKind = (typeof CAPTURE_FORM_KINDS)[number];

/** capture_forms.placement_json for kind 'prompt': where and when the site shows it. */
export const SmartPromptPlacementSchema = z
  .object({
    trigger: z.enum(['gate_hit', 'dispatch_end', 'scroll', 'exit_intent', 'delay']),
    /** For 'scroll' (percent) and 'delay' (seconds). */
    value: z.number().int().min(0).max(3600).optional(),
    /** Path globs (`/p/*`); every page when empty. */
    paths: z.array(z.string().max(200)).max(20).default([]),
    /** Who sees it. */
    readers: z.enum(['anonymous', 'free', 'everyone']).default('anonymous'),
    /** Days before showing again after a dismissal. */
    cooldownDays: z.number().int().min(0).max(365).default(7),
  })
  .openapi('SmartPromptPlacement');
export type SmartPromptPlacement = z.infer<typeof SmartPromptPlacementSchema>;

// ---------------------------------------------------------------------------------------------
// Templates and Series

export const TEMPLATE_KINDS = ['dispatch', 'design'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Flow Recipes: code-defined starting graphs (flows.recipe). */
export const FLOW_RECIPES = [
  'welcome',
  'welcome_series',
  'reengagement',
  'paid_upsell',
  'trial_nurture',
  'win_back',
] as const;
export type FlowRecipe = (typeof FLOW_RECIPES)[number];
// ---------------------------------------------------------------------------------------------
// Funnel Explorer

export const FUNNEL_STAGES = [
  'visits',
  'form_views',
  'subscribes',
  'confirms',
  'first_opens',
  'paid',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/** Lookback on the free plan; every paid plan (workspaces.plan <> 'free') is unlimited. */
export const FUNNEL_FREE_LOOKBACK_DAYS = 30;

export function funnelLookbackDays(plan: string): number | null {
  return plan === 'free' ? FUNNEL_FREE_LOOKBACK_DAYS : null;
}
