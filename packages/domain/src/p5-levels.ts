// Membership levels, prices, coupons, comp access, Gates and revenue (Phase 5). Shared by the api
// worker, the site worker and the dashboard. Money is in minor units with a lowercase ISO 4217
// currency, as Stripe uses.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Limits

/** Stripe's smallest charge is around 0.50 in most currencies; we use 50 minor units everywhere. */
export const MIN_PRICE_AMOUNT = 50;
/** Stripe's largest unit amount (8 digits). */
export const MAX_PRICE_AMOUNT = 99_999_999;
export const MAX_LEVELS = 20;
export const MAX_BENEFITS = 20;
const MAX_GATE_LEVELS = 20;

// ---------------------------------------------------------------------------------------------
// Shared pieces

const CurrencySchema = z
  .string()
  .regex(/^[a-z]{3}$/, 'Use a three-letter ISO currency code in lowercase, like "usd".')
  .openapi('Currency', { example: 'usd' });

const PRICE_INTERVALS = ['month', 'year', 'lifetime'] as const;
const PriceIntervalSchema = z.enum(PRICE_INTERVALS).openapi('PriceInterval');
export type PriceInterval = z.infer<typeof PriceIntervalSchema>;

const Amount = z.number().int().min(0).max(MAX_PRICE_AMOUNT);
const BenefitSchema = z.string().trim().min(1).max(120);
const BenefitsSchema = z.array(BenefitSchema).max(MAX_BENEFITS);

/** A Gate's copy. Every part is optional; the site falls back to the Channel default, then its own. */
const GateDesignSchema = z
  .object({
    headline: z.string().trim().max(120).optional(),
    body: z.string().trim().max(600).optional(),
    ctaLabel: z.string().trim().max(40).optional(),
    benefits: z.array(BenefitSchema).max(10).optional(),
  })
  .strict()
  .openapi('GateDesign');
export type GateDesign = z.infer<typeof GateDesignSchema>;

// ---------------------------------------------------------------------------------------------
// Prices

/**
 * One price of a level. With `customAmount` (pay what you want, flag pay_what_you_want) `amount`
 * is the suggested amount and `minAmount` the floor; the reader picks at checkout.
 */
function checkPrice(
  value: { amount: number; customAmount: boolean; minAmount?: number | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.customAmount) {
    if (value.minAmount === undefined || value.minAmount === null) {
      ctx.addIssue({ code: 'custom', path: ['minAmount'], message: 'Set the smallest amount.' });
    } else if (value.minAmount < MIN_PRICE_AMOUNT) {
      ctx.addIssue({
        code: 'custom',
        path: ['minAmount'],
        message: `The smallest amount is at least ${MIN_PRICE_AMOUNT}.`,
      });
    } else if (value.amount < value.minAmount) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'The suggested amount is at least the smallest amount.',
      });
    }
  } else {
    if (value.amount < MIN_PRICE_AMOUNT) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: `A price is at least ${MIN_PRICE_AMOUNT} (in minor units, so 0.50).`,
      });
    }
    if (value.minAmount !== undefined && value.minAmount !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['minAmount'],
        message: 'Only a pay-what-you-want price has a smallest amount.',
      });
    }
  }
}

const PriceInputSchema = z
  .object({
    interval: PriceIntervalSchema,
    amount: Amount,
    customAmount: z.boolean().default(false),
    minAmount: Amount.nullable().optional(),
  })
  .superRefine(checkPrice)
  .openapi('PriceInput');
export const LevelPriceSchema = z
  .object({
    id: id('levelPrice'),
    levelId: id('membershipLevel'),
    interval: PriceIntervalSchema,
    currency: CurrencySchema,
    /** For pay what you want: the suggested amount. */
    amount: z.number().int(),
    customAmount: z.boolean(),
    minAmount: z.number().int().nullable(),
    status: z.enum(['active', 'scheduled', 'retired']),
    effectiveAt: timestamp.nullable(),
    existing: z.enum(['grandfather', 'migrate']),
    /**
     * Null for a recurring pay-what-you-want price: Stripe has no custom amounts on recurring
     * prices, so checkout sends price_data with the reader's amount on the level's product.
     */
    stripePriceId: z.string().nullable(),
    createdAt: timestamp,
    retiredAt: timestamp.nullable(),
  })
  .openapi('LevelPrice');
export type LevelPrice = z.infer<typeof LevelPriceSchema>;

/**
 * A price change. Without effectiveAt it takes effect now: new checkouts use the new price and
 * existing paying Members keep theirs (grandfathered). With effectiveAt it is scheduled; when it takes
 * effect, existing paying Members are moved at renewal ('migrate') or keep their price ('grandfather').
 */
export const CreateLevelPriceSchema = z
  .object({
    interval: PriceIntervalSchema,
    amount: Amount,
    customAmount: z.boolean().default(false),
    minAmount: Amount.nullable().optional(),
    effectiveAt: z.iso.datetime().optional(),
    existing: z.enum(['grandfather', 'migrate']).default('grandfather'),
  })
  .superRefine((value, ctx) => {
    checkPrice(value, ctx);
    if (value.existing === 'migrate' && !value.effectiveAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['existing'],
        message: 'Moving existing subscribers needs a scheduled change (effectiveAt).',
      });
    }
    if (value.existing === 'migrate' && value.interval === 'lifetime') {
      ctx.addIssue({
        code: 'custom',
        path: ['existing'],
        message: 'Lifetime purchases have no renewal to move.',
      });
    }
  })
  .openapi('CreateLevelPrice');
export type CreateLevelPrice = z.infer<typeof CreateLevelPriceSchema>;

// ---------------------------------------------------------------------------------------------
// Levels

const LevelVisibilitySchema = z.enum(['public', 'hidden']).openapi('LevelVisibility');

export const MembershipLevelSchema = z
  .object({
    id: id('membershipLevel'),
    channelId: id('channel'),
    name: z.string(),
    description: z.string().nullable(),
    benefits: z.array(z.string()),
    /** A Founding Level (flag founding_level). */
    founding: z.boolean(),
    visibility: LevelVisibilitySchema,
    trialDays: z.number().int(),
    /** Archived levels can't be bought; existing members keep access. */
    status: z.enum(['active', 'archived']),
    position: z.number().int(),
    currency: CurrencySchema.nullable(),
    stripeProductId: z.string().nullable(),
    /**
     * Active and scheduled prices. The single-level read also lists retired ones. A level's
     * purchasable prices are the `active` ones.
     */
    prices: z.array(LevelPriceSchema),
    /** Members whose entitlement is this level right now. */
    memberCount: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('MembershipLevel');
export type MembershipLevel = z.infer<typeof MembershipLevelSchema>;

export const MembershipLevelListSchema = z
  .object({
    /** The free level every Channel has; it has no row and no price. */
    free: z.object({ name: z.string(), memberCount: z.number().int() }),
    items: z.array(MembershipLevelSchema),
  })
  .openapi('MembershipLevelList');
export type MembershipLevelList = z.infer<typeof MembershipLevelListSchema>;

export const LevelListQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
});

function uniqueIntervals(prices: { interval: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  prices.forEach((price, index) => {
    if (seen.has(price.interval)) {
      ctx.addIssue({
        code: 'custom',
        path: ['prices', index, 'interval'],
        message: 'Give each interval one price.',
      });
    }
    seen.add(price.interval);
  });
}

export const CreateMembershipLevelSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the paid plan.').max(60),
    description: z.string().trim().max(500).nullable().optional(),
    benefits: BenefitsSchema.default([]),
    founding: z.boolean().default(false),
    visibility: LevelVisibilitySchema.default('public'),
    trialDays: z.number().int().min(0).max(365).default(0),
    position: z.number().int().min(0).max(1000).optional(),
    /** Defaults to the connected Stripe account's currency. */
    currency: CurrencySchema.optional(),
    prices: z.array(PriceInputSchema).min(1, 'Add at least one price.').max(3),
  })
  .superRefine((value, ctx) => uniqueIntervals(value.prices, ctx))
  .openapi('CreateMembershipLevel');
export type CreateMembershipLevel = z.infer<typeof CreateMembershipLevelSchema>;

/** Prices change through POST …/prices, never here. */
export const UpdateMembershipLevelSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the paid plan.').max(60).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    benefits: BenefitsSchema.optional(),
    founding: z.boolean().optional(),
    visibility: LevelVisibilitySchema.optional(),
    trialDays: z.number().int().min(0).max(365).optional(),
    position: z.number().int().min(0).max(1000).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateMembershipLevel');
export type UpdateMembershipLevel = z.infer<typeof UpdateMembershipLevelSchema>;

// ---------------------------------------------------------------------------------------------
// Coupons

const CouponCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{3,40}$/, 'Use 3 to 40 letters and digits.');

const CouponDurationSchema = z.enum(['once', 'repeating', 'forever']);

export const CouponSchema = z
  .object({
    id: id('coupon'),
    channelId: id('channel'),
    code: z.string(),
    name: z.string().nullable(),
    percentOff: z.number().int().nullable(),
    amountOff: z.number().int().nullable(),
    currency: CurrencySchema.nullable(),
    duration: CouponDurationSchema,
    durationMonths: z.number().int().nullable(),
    maxRedemptions: z.number().int().nullable(),
    expiresAt: timestamp.nullable(),
    /** Empty = every level. */
    levelIds: z.array(id('membershipLevel')),
    status: z.enum(['active', 'archived']),
    stripeCouponId: z.string().nullable(),
    stripePromotionCodeId: z.string().nullable(),
    createdAt: timestamp,
  })
  .openapi('Coupon');
export type Coupon = z.infer<typeof CouponSchema>;

export const CreateCouponSchema = z
  .object({
    code: CouponCodeSchema,
    name: z.string().trim().max(60).nullable().optional(),
    percentOff: z.number().int().min(1).max(100).optional(),
    amountOff: z.number().int().min(1).max(MAX_PRICE_AMOUNT).optional(),
    currency: CurrencySchema.optional(),
    duration: CouponDurationSchema,
    durationMonths: z.number().int().min(1).max(36).optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
    expiresAt: z.iso.datetime().optional(),
    levelIds: z.array(id('membershipLevel')).max(MAX_LEVELS).default([]),
  })
  .superRefine((value, ctx) => {
    if ((value.percentOff === undefined) === (value.amountOff === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['percentOff'],
        message: 'Give either a percentage or an amount off.',
      });
    }
    if (value.amountOff !== undefined && !value.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'An amount off needs a currency.',
      });
    }
    if (value.percentOff !== undefined && value.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'A percentage has no currency.',
      });
    }
    if ((value.duration === 'repeating') !== (value.durationMonths !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMonths'],
        message: 'Set months for a repeating coupon, and only then.',
      });
    }
  })
  .openapi('CreateCoupon');
export type CreateCoupon = z.infer<typeof CreateCouponSchema>;

/** The discount itself can't change (Stripe coupons are immutable): archive and create anew. */
export const UpdateCouponSchema = z
  .object({
    name: z.string().trim().max(60).nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateCoupon');
export type UpdateCoupon = z.infer<typeof UpdateCouponSchema>;

// ---------------------------------------------------------------------------------------------
// Comp access

export const CompGrantSchema = z
  .object({
    id: id('compGrant'),
    channelId: id('channel'),
    memberId: id('member'),
    memberEmail: z.string().nullable(),
    levelId: id('membershipLevel').nullable(),
    levelName: z.string().nullable(),
    subscriptionId: id('memberSubscription').nullable(),
    expiresAt: timestamp.nullable(),
    note: z.string().nullable(),
    grantedBy: id('operator').nullable(),
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
    revokedBy: id('operator').nullable(),
    /** Active: not revoked and not expired. */
    active: z.boolean(),
  })
  .openapi('CompGrant');
export type CompGrant = z.infer<typeof CompGrantSchema>;

export const CompGrantListSchema = z.object({ items: z.array(CompGrantSchema) });

export const CreateCompGrantSchema = z
  .object({
    levelId: id('membershipLevel'),
    /** Null or absent: no end. */
    expiresAt: z.iso.datetime().nullable().optional(),
    note: z.string().trim().max(280).nullable().optional(),
  })
  .strict()
  .openapi('CreateCompGrant');
export type CreateCompGrant = z.infer<typeof CreateCompGrantSchema>;

export const CompGrantListQuerySchema = z.object({
  memberId: id('member').optional(),
  includeRevoked: z.enum(['true', 'false']).optional(),
});

/** What a Member is entitled to now (the member_entitlements row), or null for free. */
export const MemberEntitlementSchema = z
  .object({
    levelId: id('membershipLevel').nullable(),
    levelName: z.string().nullable(),
    source: z.string(),
    startsAt: timestamp,
    expiresAt: timestamp.nullable(),
  })
  .openapi('MemberEntitlement');
// ---------------------------------------------------------------------------------------------
// Gates and the meter

export const GateSchema = z
  .object({
    dispatchId: id('dispatch'),
    /** Levels that read past the gate divider. Empty = any paid level. */
    levelIds: z.array(id('membershipLevel')),
    /** Whether the Channel's meter can let a non-member read this Dispatch. */
    metered: z.boolean(),
    design: GateDesignSchema,
    /** False when no Gate was saved: the values are the defaults. */
    saved: z.boolean(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('Gate');
export type Gate = z.infer<typeof GateSchema>;

export const PutGateSchema = z
  .object({
    levelIds: z.array(id('membershipLevel')).max(MAX_GATE_LEVELS).default([]),
    metered: z.boolean().default(true),
    design: GateDesignSchema.default({}),
  })
  .strict()
  .openapi('PutGate');
export type PutGate = z.infer<typeof PutGateSchema>;

const MeterPeriodSchema = z.enum(['week', 'month']);
export type MeterPeriod = z.infer<typeof MeterPeriodSchema>;

export const GateSettingsSchema = z
  .object({
    channelId: id('channel'),
    /** Free gated Dispatches per period per reader; 0 = meter off. */
    meterLimit: z.number().int(),
    meterPeriod: MeterPeriodSchema,
    /** 'soft': the Gate can be dismissed once the meter is spent; 'hard': it can't. */
    meterMode: z.enum(['soft', 'hard']),
    design: GateDesignSchema,
    /** Coupon shown inside the Gate (flag paywall_coupon). */
    gateCouponId: id('coupon').nullable(),
    /** The meter period key in effect now (see meterPeriodKey). */
    currentPeriod: z.string(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('GateSettings');
export type GateSettings = z.infer<typeof GateSettingsSchema>;

export const UpdateGateSettingsSchema = z
  .object({
    meterLimit: z.number().int().min(0).max(100).optional(),
    meterPeriod: MeterPeriodSchema.optional(),
    meterMode: z.enum(['soft', 'hard']).optional(),
    design: GateDesignSchema.optional(),
    gateCouponId: id('coupon').nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateGateSettings');
export type UpdateGateSettings = z.infer<typeof UpdateGateSettingsSchema>;

export const MeterGrantSchema = z
  .object({
    id: id('meterGrant'),
    channelId: id('channel'),
    memberId: id('member'),
    period: z.string(),
    extra: z.number().int(),
    createdAt: timestamp,
  })
  .openapi('MeterGrant');
export type MeterGrant = z.infer<typeof MeterGrantSchema>;

export const CreateMeterGrantSchema = z
  .object({ extra: z.number().int().min(1).max(100) })
  .strict()
  .openapi('CreateMeterGrant');

/**
 * The meter period a moment falls in, in UTC: 'YYYY-MM' for months, ISO week 'YYYY-Www' for
 * weeks. gate_meter_reads.period and gate_meter_grants.period use this key.
 */
export function meterPeriodKey(period: MeterPeriod, now: number = Date.now()): string {
  const date = new Date(now);
  if (period === 'month') {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  // ISO week: the week with the year's first Thursday is week 1.
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Gift Passes and pledges (read-only admin views)

export const GiftPassSchema = z
  .object({
    id: id('giftPass'),
    levelId: id('membershipLevel').nullable(),
    months: z.number().int(),
    purchaserEmail: z.string(),
    recipientEmail: z.string().nullable(),
    status: z.enum(['pending_payment', 'paid', 'claimed', 'expired', 'refunded']),
    claimedMemberId: id('member').nullable(),
    claimedAt: timestamp.nullable(),
    claimBy: timestamp.nullable(),
    createdAt: timestamp,
  })
  .openapi('GiftPass');
export type GiftPass = z.infer<typeof GiftPassSchema>;

export const PledgeSchema = z
  .object({
    id: id('pledge'),
    memberId: id('member'),
    memberEmail: z.string().nullable(),
    levelId: id('membershipLevel').nullable(),
    interval: z.enum(['month', 'year']),
    currency: CurrencySchema,
    amount: z.number().int(),
    status: z.enum(['open', 'notified', 'converted', 'withdrawn']),
    createdAt: timestamp,
    notifiedAt: timestamp.nullable(),
    convertedAt: timestamp.nullable(),
  })
  .openapi('Pledge');
export type Pledge = z.infer<typeof PledgeSchema>;

export const PledgeNotifyResultSchema = z
  .object({
    /** Pledges marked notified in this call. */
    notified: z.number().int(),
    /** Of those, how many got an email (Members who unsubscribed or bounced don't). */
    emailed: z.number().int(),
    /** Open pledges left for another call. */
    remaining: z.number().int(),
  })
  .openapi('PledgeNotifyResult');

export const MoneyListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.string().max(20).optional(),
});

// ---------------------------------------------------------------------------------------------
// Revenue

const MoneyAmountSchema = z
  .object({ currency: CurrencySchema, amount: z.number().int() })
  .openapi('MoneyAmount');

export const RevenueQuerySchema = z
  .object({
    /** Start day (inclusive), YYYY-MM-DD in UTC. Defaults to 30 days before `to`. */
    from: z.iso.date().optional(),
    /** End day (inclusive), YYYY-MM-DD in UTC. Defaults to today. */
    to: z.iso.date().optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start day comes before the end day.',
    path: ['from'],
  });

export const RevenueSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    /**
     * Monthly recurring revenue now, per currency: paying Stripe subscriptions (active, or past
     * due within grace; not trials), at what they bill after coupons that recur ('repeating' while
     * they last, 'forever'; a 'once' coupon doesn't count), yearly ones divided by 12.
     */
    mrr: z.array(MoneyAmountSchema),
    /**
     * What trialing subscriptions would add to MRR when they convert, on the same terms, leaving
     * out trials set to cancel.
     */
    trialMrr: z.array(MoneyAmountSchema),
    activePaid: z.number().int(),
    trialing: z.number().int(),
    /** Comp and Gift Pass access in effect now. */
    complimentary: z.number().int(),
    churn: z.object({
      /** Stripe subscriptions paying at the start of the range (trials not yet paid don't count). */
      activeAtStart: z.number().int(),
      /** Of those, canceled or revoked within the range. */
      canceled: z.number().int(),
      /** canceled / activeAtStart, or null when nothing was active. */
      rate: z.number().nullable(),
    }),
    /** Members whose first paid subscription started paying in the range (a trial when it converted). */
    newPaid: z.number().int(),
    /**
     * Members who joined in the range, by source (utm_source, else the capture kind, else
     * 'direct'), and how many of them have paid (trials count once converted).
     */
    conversionBySource: z.array(
      z.object({
        source: z.string(),
        members: z.number().int(),
        paid: z.number().int(),
        rate: z.number(),
      }),
    ),
    /** Net money in per UTC day (refunds are negative). */
    revenueByDay: z.array(
      z.object({ day: z.string(), currency: CurrencySchema, amount: z.number().int() }),
    ),
    lifetimeRevenue: z.array(MoneyAmountSchema),
  })
  .openapi('Revenue');
export type Revenue = z.infer<typeof RevenueSchema>;
