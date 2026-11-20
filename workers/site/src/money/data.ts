// Reads for Membership levels, prices, the connected Stripe account, Gates and coupons. Every
// query is scoped to the Channel resolved from the Host header.
import { all, first } from '@swarm/db';
import type { SiteEnv } from '../env';

export interface PaidAccount {
  stripeAccountId: string;
  /** Checkout can run only when Stripe says the account can take charges. */
  chargesEnabled: boolean;
  taxEnabled: boolean;
  defaultCurrency: string | null;
  /** Connected with its own Stripe key, so it doesn't depend on this deployment's Connect. */
  ownKey: boolean;
}

/** Whether readers can pay: Connect needs payments on here, an account's own key doesn't. */
export const paymentsOpen = (env: SiteEnv, account: PaidAccount) =>
  account.ownKey || env.PAYMENTS !== 'off';

/** The Channel's connected Stripe account, or null when none is connected. */
export async function paidAccount(env: SiteEnv, channelId: string): Promise<PaidAccount | null> {
  const row = await first<{
    stripe_account_id: string;
    charges_enabled: number;
    tax_enabled: number;
    default_currency: string | null;
    own_key: number;
  }>(
    env.DB,
    `SELECT stripe_account_id, charges_enabled, tax_enabled, default_currency,
            own_key_enc IS NOT NULL AS own_key
       FROM stripe_accounts WHERE channel_id = ?1 AND status = 'connected'`,
    channelId,
  );
  return row
    ? {
        stripeAccountId: row.stripe_account_id,
        chargesEnabled: row.charges_enabled === 1,
        taxEnabled: row.tax_enabled === 1,
        defaultCurrency: row.default_currency,
        ownKey: row.own_key === 1,
      }
    : null;
}

/** PayPal stands on its own: a publication can take it with or without Stripe. */
export const paypalConnected = async (env: SiteEnv, channelId: string) =>
  (await first(env.DB, 'SELECT 1 AS ok FROM paypal_accounts WHERE channel_id = ?1', channelId)) !==
  null;

type PriceInterval = 'month' | 'year' | 'lifetime';

export interface LevelPrice {
  id: string;
  levelId: string;
  interval: PriceInterval;
  currency: string;
  /** Minor units. For pay what you want, the suggested amount. */
  amount: number;
  customAmount: boolean;
  minAmount: number | null;
  stripePriceId: string | null;
}

export interface Level {
  id: string;
  name: string;
  description: string | null;
  benefits: string[];
  founding: boolean;
  visibility: 'public' | 'hidden';
  trialDays: number;
  stripeProductId: string | null;
  prices: LevelPrice[];
}

interface LevelRow {
  id: string;
  name: string;
  description: string | null;
  benefits_json: string;
  founding: number;
  visibility: 'public' | 'hidden';
  trial_days: number;
  stripe_product_id: string | null;
}

interface PriceRow {
  id: string;
  level_id: string;
  interval: PriceInterval;
  currency: string;
  amount: number;
  custom_amount: number;
  min_amount: number | null;
  stripe_price_id: string | null;
}

function benefitsOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

const toPrice = (row: PriceRow): LevelPrice => ({
  id: row.id,
  levelId: row.level_id,
  interval: row.interval,
  currency: row.currency.toLowerCase(),
  amount: row.amount,
  customAmount: row.custom_amount === 1,
  minAmount: row.min_amount,
  stripePriceId: row.stripe_price_id,
});

/**
 * Active Membership levels with their active prices, in display order (position, then age).
 * `id` narrows it to one level; archived levels are never returned.
 */
export async function activeLevels(
  env: SiteEnv,
  channelId: string,
  id: string | null = null,
): Promise<Level[]> {
  const [levels, prices] = await Promise.all([
    all<LevelRow>(
      env.DB,
      `SELECT id, name, description, benefits_json, founding, visibility, trial_days, stripe_product_id
         FROM membership_levels
        WHERE channel_id = ?1 AND status = 'active' AND (?2 IS NULL OR id = ?2)
        ORDER BY position, created_at, id`,
      channelId,
      id,
    ),
    all<PriceRow>(
      env.DB,
      `SELECT id, level_id, interval, currency, amount, custom_amount, min_amount, stripe_price_id
         FROM level_prices
        WHERE channel_id = ?1 AND status = 'active' AND (?2 IS NULL OR level_id = ?2)`,
      channelId,
      id,
    ),
  ]);
  return levels.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    benefits: benefitsOf(row.benefits_json),
    founding: row.founding === 1,
    visibility: row.visibility,
    trialDays: row.trial_days,
    stripeProductId: row.stripe_product_id,
    prices: prices.filter((p) => p.level_id === row.id).map(toPrice),
  }));
}

export interface GateCoupon {
  id: string;
  code: string;
  name: string | null;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  durationMonths: number | null;
  levelIds: string[];
  stripePromotionCodeId: string | null;
}

interface CouponRow {
  id: string;
  code: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: GateCoupon['duration'];
  duration_months: number | null;
  level_ids_json: string;
  stripe_promotion_code_id: string | null;
}

const toCoupon = (row: CouponRow): GateCoupon => {
  let levelIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.level_ids_json);
    if (Array.isArray(parsed)) levelIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // An unreadable list restricts nothing.
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    percentOff: row.percent_off,
    amountOff: row.amount_off,
    currency: row.currency,
    duration: row.duration,
    durationMonths: row.duration_months,
    levelIds,
    stripePromotionCodeId: row.stripe_promotion_code_id,
  };
};

const COUPON_COLUMNS = `id, code, name, percent_off, amount_off, currency, duration, duration_months,
  level_ids_json, stripe_promotion_code_id`;

/** A usable coupon of this Channel: active, not expired, with a promotion code on Stripe. */
export async function couponBy(
  env: SiteEnv,
  channelId: string,
  by: { id: string } | { code: string },
  now: number,
): Promise<GateCoupon | null> {
  const row = await first<CouponRow>(
    env.DB,
    `SELECT ${COUPON_COLUMNS} FROM coupons
      WHERE channel_id = ?1 AND ${'id' in by ? 'id = ?2' : 'code = ?2'} AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?3)`,
    channelId,
    'id' in by ? by.id : by.code,
    now,
  );
  return row ? toCoupon(row) : null;
}

interface GateSettings {
  meterLimit: number;
  meterPeriod: 'week' | 'month';
  meterMode: 'soft' | 'hard';
  designJson: string;
  couponId: string | null;
}

interface DispatchGate {
  /** Levels that read past the gate; empty = any paid level. */
  levelIds: string[];
  metered: boolean;
  designJson: string;
}

/** The Dispatch's Gate (defaults when it has no row) and the Channel's Gate settings. */
export async function gateConfig(
  env: SiteEnv,
  channelId: string,
  dispatchId: string,
): Promise<{ gate: DispatchGate; settings: GateSettings }> {
  const [gate, settings] = await Promise.all([
    first<{ level_ids_json: string; metered: number; design_json: string }>(
      env.DB,
      `SELECT level_ids_json, metered, design_json FROM gates
        WHERE dispatch_id = ?1 AND channel_id = ?2`,
      dispatchId,
      channelId,
    ),
    first<{
      meter_limit: number;
      meter_period: 'week' | 'month';
      meter_mode: 'soft' | 'hard';
      design_json: string;
      gate_coupon_id: string | null;
    }>(
      env.DB,
      `SELECT meter_limit, meter_period, meter_mode, design_json, gate_coupon_id
         FROM gate_settings WHERE channel_id = ?1`,
      channelId,
    ),
  ]);
  let levelIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(gate?.level_ids_json ?? '[]');
    if (Array.isArray(parsed)) levelIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Unreadable: treat as any paid level.
  }
  return {
    gate: {
      levelIds,
      metered: gate ? gate.metered === 1 : true,
      designJson: gate?.design_json ?? '{}',
    },
    settings: {
      meterLimit: settings?.meter_limit ?? 0,
      meterPeriod: settings?.meter_period ?? 'month',
      meterMode: settings?.meter_mode ?? 'hard',
      designJson: settings?.design_json ?? '{}',
      couponId: settings?.gate_coupon_id ?? null,
    },
  };
}

/** A signed-in reader's Member row, for checkout and the portal. */
export async function memberById(
  env: SiteEnv,
  channelId: string,
  memberId: string,
): Promise<{ id: string; email: string; status: string } | null> {
  return first(
    env.DB,
    'SELECT id, email, status FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
}

/** The Member's customer on the Channel's connected account, if Stripe has made one. */
export async function stripeCustomer(
  env: SiteEnv,
  channelId: string,
  memberId: string,
): Promise<string | null> {
  const row = await first<{ stripe_customer_id: string }>(
    env.DB,
    'SELECT stripe_customer_id FROM stripe_customers WHERE member_id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
  return row?.stripe_customer_id ?? null;
}
