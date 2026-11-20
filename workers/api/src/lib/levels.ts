/**
 * Helpers shared by the Membership level, coupon, comp, Gate and revenue routes (Phase 5): the
 * Stripe client, the Channel's connected account, row mappers and Stripe error mapping.
 */
import { all, first, toIso } from '@swarm/db';
import type { Coupon, LevelPrice, MembershipLevel } from '@swarm/domain';
import { StripeError, stripeApi, stripeFor, type StripeApi } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { env, type AppContext } from './context';
import { credentialFetch } from './vault';

// ---- Stripe client ---------------------------------------------------------------------------

let injected: StripeApi | null | undefined;

/**
 * Tests replace the Stripe client (a DevStripe they can inspect). Pass undefined to go back to
 * the one the env selects.
 */
export function useStripeForTests(api: StripeApi | null | undefined): void {
  injected = api;
}

/** The platform client for Connect calls (the injected one in tests), or null when payments are off. */
export function platformStripe(c: AppContext): StripeApi | null {
  return injected !== undefined ? injected : stripeApi(env(c));
}

/** The Stripe client, or a 503 when payments are off for this deployment. */
export function stripe(c: AppContext): StripeApi {
  // An account with its own key is reached through the vault under this request's credential.
  const api =
    injected !== undefined
      ? injected
      : stripeFor({
          ...env(c),
          ownKeyFetch: (channelId) => credentialFetch(c, { kind: 'stripe', channelId }),
        });
  if (!api) throw new ApiError('unavailable', 'Payments are not set up on this deployment.');
  return api;
}

export interface ConnectedAccount {
  accountId: string;
  defaultCurrency: string | null;
}

/** The Channel's connected account, or null when there is none that can take payments. */
export async function connectedAccount(
  db: D1Database,
  channelId: string,
): Promise<ConnectedAccount | null> {
  const row = await first<{ stripe_account_id: string; default_currency: string | null }>(
    db,
    `SELECT stripe_account_id, default_currency FROM stripe_accounts
      WHERE channel_id = ?1 AND status = 'connected' AND charges_enabled = 1`,
    channelId,
  );
  return row ? { accountId: row.stripe_account_id, defaultCurrency: row.default_currency } : null;
}

export async function requireConnectedAccount(
  db: D1Database,
  channelId: string,
): Promise<ConnectedAccount> {
  const account = await connectedAccount(db, channelId);
  if (!account) {
    throw new ApiError(
      'conflict',
      'Connect a Stripe account that can take payments (Settings, Payments) first.',
    );
  }
  return account;
}

/** Runs a Stripe call and turns its failures into API errors the dashboard can show. */
export async function stripeCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StripeError) {
      if (error.status >= 400 && error.status < 500) {
        throw new ApiError('conflict', `Stripe refused the change: ${error.message}`);
      }
      throw new ApiError('unavailable', 'Stripe is not answering. Try again in a moment.');
    }
    throw error;
  }
}

// ---- Rows and mappers ------------------------------------------------------------------------

export interface LevelRow {
  id: string;
  channel_id: string;
  name: string;
  description: string | null;
  benefits_json: string;
  founding: number;
  visibility: 'public' | 'hidden';
  trial_days: number;
  status: 'active' | 'archived';
  position: number;
  stripe_product_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface PriceRow {
  id: string;
  level_id: string;
  channel_id: string;
  interval: 'month' | 'year' | 'lifetime';
  currency: string;
  amount: number;
  custom_amount: number;
  min_amount: number | null;
  status: 'active' | 'scheduled' | 'retired';
  effective_at: number | null;
  existing: 'grandfather' | 'migrate';
  stripe_price_id: string | null;
  created_at: number;
  retired_at: number | null;
}

export function toLevelPrice(row: PriceRow): LevelPrice {
  return {
    id: row.id,
    levelId: row.level_id,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    customAmount: row.custom_amount === 1,
    minAmount: row.min_amount,
    status: row.status,
    effectiveAt: row.effective_at === null ? null : toIso(row.effective_at),
    existing: row.existing,
    stripePriceId: row.stripe_price_id,
    createdAt: toIso(row.created_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

const PRICE_ORDER = { month: 0, year: 1, lifetime: 2 } as const;
const STATUS_ORDER = { active: 0, scheduled: 1, retired: 2 } as const;

function toLevel(row: LevelRow, prices: PriceRow[], memberCount: number): MembershipLevel {
  const sorted = [...prices].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      PRICE_ORDER[a.interval] - PRICE_ORDER[b.interval] ||
      b.created_at - a.created_at,
  );
  const current = sorted.find((p) => p.status === 'active') ?? sorted[0];
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description,
    benefits: JSON.parse(row.benefits_json) as string[],
    founding: row.founding === 1,
    visibility: row.visibility,
    trialDays: row.trial_days,
    status: row.status,
    position: row.position,
    currency: current?.currency ?? null,
    stripeProductId: row.stripe_product_id,
    prices: sorted.map(toLevelPrice),
    memberCount,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Levels of a Channel with their prices and current member counts. */
export async function readLevels(
  db: D1Database,
  channelId: string,
  options: { levelId?: string; includeArchived?: boolean; includeRetired?: boolean } = {},
): Promise<MembershipLevel[]> {
  const rows = await all<LevelRow>(
    db,
    `SELECT * FROM membership_levels
      WHERE channel_id = ?1 AND (?2 IS NULL OR id = ?2) AND (?3 = 1 OR status = 'active')
      ORDER BY founding DESC, position, created_at`,
    channelId,
    options.levelId ?? null,
    options.includeArchived || options.levelId ? 1 : 0,
  );
  if (!rows.length) return [];
  const prices = await all<PriceRow>(
    db,
    `SELECT * FROM level_prices WHERE channel_id = ?1 AND (?2 IS NULL OR level_id = ?2)
       AND (?3 = 1 OR status <> 'retired')`,
    channelId,
    options.levelId ?? null,
    options.includeRetired ? 1 : 0,
  );
  const counts = await all<{ level_id: string; n: number }>(
    db,
    `SELECT level_id, count(*) AS n FROM member_entitlements
      WHERE channel_id = ?1 AND kind = 'paid' AND level_id IS NOT NULL
        AND (expires_at IS NULL OR expires_at > ?2)
      GROUP BY level_id`,
    channelId,
    Date.now(),
  );
  const countBy = new Map(counts.map((r) => [r.level_id, r.n]));
  return rows.map((row) =>
    toLevel(
      row,
      prices.filter((p) => p.level_id === row.id),
      countBy.get(row.id) ?? 0,
    ),
  );
}

export async function requireLevel(
  db: D1Database,
  channelId: string,
  levelId: string,
): Promise<LevelRow> {
  const row = await first<LevelRow>(
    db,
    'SELECT * FROM membership_levels WHERE id = ?1 AND channel_id = ?2',
    levelId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Paid plan not found.');
  return row;
}

/** Refuses level ids that are not this Channel's. */
export async function checkLevelIds(
  db: D1Database,
  channelId: string,
  levelIds: string[],
  path: string,
): Promise<LevelRow[]> {
  const ids = [...new Set(levelIds)];
  if (ids.length !== levelIds.length) {
    const message = 'Choose each paid plan once.';
    throw new ApiError('invalid_input', message, [{ path, message }]);
  }
  if (!ids.length) return [];
  const rows = await all<LevelRow>(
    db,
    `SELECT * FROM membership_levels WHERE channel_id = ?1
       AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`,
    channelId,
    ...ids,
  );
  if (rows.length !== ids.length) {
    const message = 'Choose paid plans of this publication.';
    throw new ApiError('invalid_input', message, [{ path, message }]);
  }
  return rows;
}

export interface CouponRow {
  id: string;
  channel_id: string;
  code: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_months: number | null;
  max_redemptions: number | null;
  expires_at: number | null;
  level_ids_json: string;
  status: 'active' | 'archived';
  stripe_coupon_id: string | null;
  stripe_promotion_code_id: string | null;
  created_at: number;
}

export function toCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    channelId: row.channel_id,
    code: row.code,
    name: row.name,
    percentOff: row.percent_off,
    amountOff: row.amount_off,
    currency: row.currency,
    duration: row.duration,
    durationMonths: row.duration_months,
    maxRedemptions: row.max_redemptions,
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    levelIds: JSON.parse(row.level_ids_json) as string[],
    status: row.status,
    stripeCouponId: row.stripe_coupon_id,
    stripePromotionCodeId: row.stripe_promotion_code_id,
    createdAt: toIso(row.created_at),
  };
}

/** A Member of this Channel, or 404. */
export async function requireChannelMember(
  db: D1Database,
  channelId: string,
  memberId: string,
): Promise<{ id: string; email: string; status: string }> {
  const row = await first<{ id: string; email: string; status: string }>(
    db,
    'SELECT id, email, status FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Subscriber not found.');
  return row;
}
