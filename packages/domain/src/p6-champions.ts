// Champions (referrals with milestones and rewards) and Series (flag post_series), Phase 6.
// Request and response schemas for the api worker and the dashboard. Shared enums and the code
// alphabet are in p6-growth.ts; tables in migrations/0010_growth.sql.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import {
  CHAMPION_AWARD_STATUSES,
  CHAMPION_REWARD_KINDS,
  REFERRAL_REVIEW_REASONS,
  REFERRAL_STATUSES,
} from './p6-growth';
import { SiteSlugSchema } from './site';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Settings

export const ChampionSettingsSchema = z
  .object({
    /** Milestones are awarded only while Champions is on. Referrals are recorded either way. */
    enabled: z.boolean(),
    engagementDays: z.number().int(),
    clusterLimit: z.number().int(),
    clusterWindowHours: z.number().int(),
    blockDisposable: z.boolean(),
    /** The public "top Champions" page (/champions); also needs the referral_awards flag. */
    publicLeaderboard: z.boolean(),
    shareText: z.string().nullable(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('ChampionSettings');
export type ChampionSettings = z.infer<typeof ChampionSettingsSchema>;

export const UpdateChampionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    engagementDays: z.number().int().min(1).max(90),
    clusterLimit: z.number().int().min(1).max(100),
    clusterWindowHours: z.number().int().min(1).max(720),
    blockDisposable: z.boolean(),
    publicLeaderboard: z.boolean(),
    shareText: z.string().trim().max(280).nullable(),
  })
  .partial()
  .strict()
  .openapi('UpdateChampionSettings');
export type UpdateChampionSettings = z.infer<typeof UpdateChampionSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Rewards and milestones

const ChampionRewardKindSchema = z.enum(CHAMPION_REWARD_KINDS).openapi('ChampionRewardKind');

export const ChampionRewardSchema = z
  .object({
    id: id('championReward'),
    kind: ChampionRewardKindSchema,
    name: z.string(),
    description: z.string().nullable(),
    levelId: id('membershipLevel').nullable(),
    compDays: z.number().int().nullable(),
    couponId: id('coupon').nullable(),
    goodsRef: z.string().nullable(),
    fulfilFlowId: id('flow').nullable(),
    status: z.enum(['active', 'archived']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('ChampionReward');
export type ChampionReward = z.infer<typeof ChampionRewardSchema>;

const rewardFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  /** comp_level: the Membership level granted, for compDays days. */
  levelId: id('membershipLevel').nullable(),
  compDays: z.number().int().min(1).max(3650).nullable(),
  /** coupon: the coupon whose code is emailed to the Champion. */
  couponId: id('coupon').nullable(),
  /** goods: a Goods item reference (Phase 8). The award waits for the operator until then. */
  goodsRef: z.string().trim().min(1).max(80).nullable(),
  /** Reserved for a Flow that sends the fulfilment email; the built-in email is sent for now. */
  fulfilFlowId: id('flow').nullable(),
};

export const CreateChampionRewardSchema = z
  .object({
    kind: ChampionRewardKindSchema,
    name: rewardFields.name,
    description: rewardFields.description.optional(),
    levelId: rewardFields.levelId.optional(),
    compDays: rewardFields.compDays.optional(),
    couponId: rewardFields.couponId.optional(),
    goodsRef: rewardFields.goodsRef.optional(),
    fulfilFlowId: rewardFields.fulfilFlowId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'comp_level') {
      if (!value.levelId) ctx.addIssue({ code: 'custom', path: ['levelId'], message: 'Required.' });
      if (!value.compDays) {
        ctx.addIssue({ code: 'custom', path: ['compDays'], message: 'Required.' });
      }
    }
    if (value.kind === 'coupon' && !value.couponId) {
      ctx.addIssue({ code: 'custom', path: ['couponId'], message: 'Required.' });
    }
  })
  .openapi('CreateChampionReward');
export type CreateChampionReward = z.infer<typeof CreateChampionRewardSchema>;

export const UpdateChampionRewardSchema = z
  .object({ ...rewardFields, status: z.enum(['active', 'archived']) })
  .partial()
  .strict()
  .openapi('UpdateChampionReward');
export type UpdateChampionReward = z.infer<typeof UpdateChampionRewardSchema>;

export const ChampionMilestoneSchema = z
  .object({
    id: id('championMilestone'),
    referralsRequired: z.number().int(),
    name: z.string(),
    rewardId: id('championReward').nullable(),
    status: z.enum(['active', 'archived']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('ChampionMilestone');
export type ChampionMilestone = z.infer<typeof ChampionMilestoneSchema>;

export const CreateChampionMilestoneSchema = z
  .object({
    referralsRequired: z.number().int().min(1).max(100_000),
    name: z.string().trim().min(1).max(80),
    rewardId: id('championReward').nullable().optional(),
  })
  .strict()
  .openapi('CreateChampionMilestone');
export type CreateChampionMilestone = z.infer<typeof CreateChampionMilestoneSchema>;

export const UpdateChampionMilestoneSchema = z
  .object({
    referralsRequired: z.number().int().min(1).max(100_000),
    name: z.string().trim().min(1).max(80),
    rewardId: id('championReward').nullable(),
    status: z.enum(['active', 'archived']),
  })
  .partial()
  .strict()
  .openapi('UpdateChampionMilestone');
export type UpdateChampionMilestone = z.infer<typeof UpdateChampionMilestoneSchema>;

// ---------------------------------------------------------------------------------------------
// Leaderboard, referrals and awards

const ChampionLeaderboardEntrySchema = z
  .object({
    memberId: id('member'),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    championCode: z.string().nullable(),
    counted: z.number().int(),
    pending: z.number().int(),
    held: z.number().int(),
  })
  .openapi('ChampionLeaderboardEntry');
export type ChampionLeaderboardEntry = z.infer<typeof ChampionLeaderboardEntrySchema>;

export const ChampionLeaderboardSchema = z
  .object({ items: z.array(ChampionLeaderboardEntrySchema), nextCursor: z.string().nullable() })
  .openapi('ChampionLeaderboard');

const ReferralStatusSchema = z.enum(REFERRAL_STATUSES).openapi('ReferralStatus');

export const ReferralSchema = z
  .object({
    id: id('referral'),
    referrerId: id('member'),
    referrerEmail: z.string().nullable(),
    referredId: id('member'),
    referredEmail: z.string().nullable(),
    status: ReferralStatusSchema,
    reviewReason: z.enum(REFERRAL_REVIEW_REASONS).nullable(),
    /** The referred sign-up's network (/24 or /48), never the full address. */
    ipPrefix: z.string().nullable(),
    createdAt: timestamp,
    countedAt: timestamp.nullable(),
    reviewedBy: id('operator').nullable(),
    reviewedAt: timestamp.nullable(),
  })
  .openapi('Referral');
export type Referral = z.infer<typeof ReferralSchema>;

export const ReferralListSchema = z
  .object({ items: z.array(ReferralSchema), nextCursor: z.string().nullable() })
  .openapi('ReferralList');

export const ReferralListQuerySchema = z.object({
  status: ReferralStatusSchema.optional(),
  referrerId: id('member').optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ChampionAwardSchema = z
  .object({
    id: id('championAward'),
    memberId: id('member'),
    memberEmail: z.string().nullable(),
    milestoneId: id('championMilestone'),
    milestoneName: z.string().nullable(),
    rewardId: id('championReward').nullable(),
    rewardName: z.string().nullable(),
    rewardKind: ChampionRewardKindSchema.nullable(),
    status: z.enum(CHAMPION_AWARD_STATUSES),
    compGrantId: id('compGrant').nullable(),
    detail: z.string().nullable(),
    createdAt: timestamp,
    fulfilledAt: timestamp.nullable(),
  })
  .openapi('ChampionAward');
export type ChampionAward = z.infer<typeof ChampionAwardSchema>;

export const ChampionAwardListSchema = z
  .object({ items: z.array(ChampionAwardSchema), nextCursor: z.string().nullable() })
  .openapi('ChampionAwardList');

export const ChampionAwardListQuerySchema = z.object({
  status: z.enum(CHAMPION_AWARD_STATUSES).optional(),
  memberId: id('member').optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const FulfilChampionAwardSchema = z
  .object({ detail: z.string().trim().max(500).nullable().optional() })
  .strict()
  .openapi('FulfilChampionAward');

/** A Member's Champion view: their share links and progress. */
export const MemberChampionSchema = z
  .object({
    memberId: id('member'),
    code: z.string(),
    /** <site origin>/?ref=<code> */
    shareUrl: z.string(),
    /** <site origin>/r/<code> */
    shortUrl: z.string(),
    counted: z.number().int(),
    pending: z.number().int(),
    held: z.number().int(),
    rejected: z.number().int(),
    nextMilestone: z
      .object({
        id: id('championMilestone'),
        name: z.string(),
        referralsRequired: z.number().int(),
        remaining: z.number().int(),
      })
      .nullable(),
    awards: z.number().int(),
  })
  .openapi('MemberChampion');
export type MemberChampion = z.infer<typeof MemberChampionSchema>;

// ---------------------------------------------------------------------------------------------
// Series (flag post_series)

const SERIES_MAX_DISPATCHES = 200;

const SeriesSlugSchema = SiteSlugSchema.pipe(z.string().min(1).max(80));

export const SeriesSchema = z
  .object({
    id: id('series'),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    /** In reading order (Part 1 first). */
    dispatchIds: z.array(id('dispatch')),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('Series');
export type Series = z.infer<typeof SeriesSchema>;

export const SeriesListSchema = z.object({ items: z.array(SeriesSchema) }).openapi('SeriesList');

const dispatchIds = z
  .array(id('dispatch'))
  .max(SERIES_MAX_DISPATCHES)
  .refine((ids) => new Set(ids).size === ids.length, 'A post can be in a Series once.');

export const CreateSeriesSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Derived from the name when absent. */
    slug: SeriesSlugSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    dispatchIds: dispatchIds.optional(),
  })
  .strict()
  .openapi('CreateSeries');
export type CreateSeries = z.infer<typeof CreateSeriesSchema>;

export const UpdateSeriesSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: SeriesSlugSchema,
    description: z.string().trim().max(500).nullable(),
    /** The full new order; Dispatches left out leave the Series. */
    dispatchIds,
  })
  .partial()
  .strict()
  .openapi('UpdateSeries');
export type UpdateSeries = z.infer<typeof UpdateSeriesSchema>;
