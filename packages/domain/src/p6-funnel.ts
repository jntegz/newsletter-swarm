// Funnel Explorer (Phase 6): request and response schemas for
// GET /api/v1/channels/{channelId}/analytics/funnel. The rollups behind it live in
// @swarm/engine (funnel.ts) and fill funnel_daily (migrations/0010_growth.sql, 0011_funnel.sql).
import { z } from '@hono/zod-openapi';
import { FUNNEL_STAGES } from './p6-growth';

/** The cuts the API groups by. `utm` in FUNNEL_CUTS is offered as its three columns. */
export const FUNNEL_QUERY_CUTS = [
  'source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'form',
  'champion',
] as const;
export type FunnelQueryCut = (typeof FUNNEL_QUERY_CUTS)[number];

/** The funnel_daily column behind each cut. */
export const FUNNEL_CUT_COLUMNS: Record<FunnelQueryCut, string> = {
  source: 'source',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  form: 'form_id',
  champion: 'champion_id',
};

const FUNNEL_TOP_DEFAULT = 10;
const FUNNEL_TOP_MAX = 50;
/** The widest range one request may ask for (the by-day series has one entry per day). */
export const FUNNEL_MAX_RANGE_DAYS = 3660;

const filter = z.string().max(120).optional();

export const FunnelQuerySchema = z
  .object({
    /** Start day (inclusive), YYYY-MM-DD in UTC. Defaults to 30 days before `to`. */
    from: z.iso.date().optional(),
    /** End day (inclusive), YYYY-MM-DD in UTC. Defaults to today. */
    to: z.iso.date().optional(),
    cut: z.enum(FUNNEL_QUERY_CUTS).default('source'),
    /** How many cut values to list before the rest are summed into "other". */
    top: z.coerce.number().int().min(1).max(FUNNEL_TOP_MAX).default(FUNNEL_TOP_DEFAULT),
    /** Exact-match filters; an empty value matches "none". */
    source: filter,
    utmSource: filter,
    utmMedium: filter,
    utmCampaign: filter,
    formId: filter,
    championId: filter,
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start day comes before the end day.',
    path: ['from'],
  });
const FunnelStageSchema = z.enum(FUNNEL_STAGES).openapi('FunnelStage');

const FunnelCountsSchema = z
  .object({
    visits: z.number().int(),
    formViews: z.number().int(),
    subscribes: z.number().int(),
    confirms: z.number().int(),
    firstOpens: z.number().int(),
    paid: z.number().int(),
  })
  .openapi('FunnelCounts');
export type FunnelCounts = z.infer<typeof FunnelCountsSchema>;

/** Each stage over the stage before it (null when the earlier stage is 0). */
const FunnelRatesSchema = z
  .object({
    formViews: z.number().nullable(),
    subscribes: z.number().nullable(),
    confirms: z.number().nullable(),
    firstOpens: z.number().nullable(),
    paid: z.number().nullable(),
  })
  .openapi('FunnelRates');
type FunnelRates = z.infer<typeof FunnelRatesSchema>;

export const FunnelSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    cut: z.enum(FUNNEL_QUERY_CUTS),
    /** Days of history the workspace plan allows (null = unlimited). */
    lookbackDays: z.number().int().nullable(),
    /** True when `from` was moved forward to the plan's lookback. */
    clamped: z.boolean(),
    stages: z.array(
      z.object({
        stage: FunnelStageSchema,
        count: z.number().int(),
        /** This stage over the previous one; null for visits or when the previous is 0. */
        fromPrevious: z.number().nullable(),
        /** This stage over visits; null when there were no visits. */
        fromVisits: z.number().nullable(),
      }),
    ),
    totals: FunnelCountsSchema,
    rates: FunnelRatesSchema,
    breakdown: z.array(
      z.object({
        /** The cut value; '' = none (no UTM, no form, no Champion); null for "other". */
        value: z.string().nullable(),
        /** A form's name or a Champion's name or email, when the value is an id. */
        label: z.string().nullable(),
        other: z.boolean(),
        counts: FunnelCountsSchema,
        rates: FunnelRatesSchema,
      }),
    ),
    byDay: z.array(FunnelCountsSchema.extend({ day: z.string() })),
  })
  .openapi('Funnel');
export type Funnel = z.infer<typeof FunnelSchema>;

const STAGE_KEYS = {
  visits: 'visits',
  form_views: 'formViews',
  subscribes: 'subscribes',
  confirms: 'confirms',
  first_opens: 'firstOpens',
  paid: 'paid',
} as const satisfies Record<(typeof FUNNEL_STAGES)[number], keyof FunnelCounts>;
export const FUNNEL_STAGE_KEYS = STAGE_KEYS;

/** A ratio rounded to four places, or null when the denominator is 0. */
export function funnelRate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

/** Stage-over-previous-stage rates. */
export function funnelRates(counts: FunnelCounts): FunnelRates {
  return {
    formViews: funnelRate(counts.formViews, counts.visits),
    subscribes: funnelRate(counts.subscribes, counts.formViews),
    confirms: funnelRate(counts.confirms, counts.subscribes),
    firstOpens: funnelRate(counts.firstOpens, counts.confirms),
    paid: funnelRate(counts.paid, counts.firstOpens),
  };
}
