/**
 * Webhook handlers that keep member_subscriptions in step with Stripe: subscription changes,
 * invoices, refunds, disputes, trial notices and connected-account flags. Every lookup is scoped
 * to the Channel the event's account resolved to (see payments.ts).
 */
import { appendAudit } from '@swarm/db';
import type { PrivacyKeys } from './vault-ports';
import { endGoodOrder } from './goods';
import { recomputeEntitlement } from './entitlements';
import { all, first, newIdFor, run } from './db';
import { sendPaymentNotice, sendTrialEndingMail } from './payments-mail';
import type { PaymentsContext } from './payments';
import type { StripeEvent } from './stripe';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventScope {
  ctx: PaymentsContext;
  event: StripeEvent;
  object: Record<string, unknown>;
  /** The connected account (acct_…) the event came from. */
  accountId: string;
  channelId: string;
  workspaceId: string;
  graceDays: number;
  /** The event's creation time, in ms. */
  eventAt: number;
}

/** What recording money and recomputing access need, whichever provider the event came from. */
export interface LedgerScope {
  /** fieldKeys (FIELD_KEYS) matches install-keyed erasure markers (privacy.ts). */
  ctx: { db: D1Database; now: number; fieldKeys: PrivacyKeys };
  channelId: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------------------------
// Reading Stripe objects

type StripeObject = Record<string, unknown>;

export const str = (o: unknown, key: string): string | null => {
  const value = o && typeof o === 'object' ? (o as StripeObject)[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const num = (o: unknown, key: string): number | null => {
  const value = o && typeof o === 'object' ? (o as StripeObject)[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const obj = (o: unknown, key: string): StripeObject | null => {
  const value = o && typeof o === 'object' ? (o as StripeObject)[key] : undefined;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as StripeObject)
    : null;
};

/** An id field that may be a string or an expanded object. */
export const idOf = (o: unknown, key: string): string | null =>
  str(o, key) ?? str(obj(o, key), 'id');

/** Stripe seconds → ms. */
const ms = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);

const SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
]);

/** True for an object that looks like a Stripe subscription (status and items). */
export function isSubscription(o: unknown): o is StripeObject {
  return (
    !!str(o, 'id')?.startsWith('sub_') &&
    SUBSCRIPTION_STATUSES.has(str(o, 'status') ?? '') &&
    Array.isArray(obj(o, 'items')?.data)
  );
}

function items(sub: StripeObject): StripeObject[] {
  const data = obj(sub, 'items')?.data;
  return Array.isArray(data)
    ? data.filter((item): item is StripeObject => !!item && typeof item === 'object')
    : [];
}

/** Since 2025-03-31.basil the period end lives on the items; older payloads have it on the subscription. */
function periodEnd(sub: StripeObject): number | null {
  const ends = items(sub)
    .map((item) => num(item, 'current_period_end'))
    .filter((value): value is number => value !== null);
  if (ends.length) return Math.max(...ends) * 1000;
  return ms(num(sub, 'current_period_end'));
}

/** The subscription an invoice belongs to (basil+ moved it under parent.subscription_details). */
function invoiceSubscriptionId(invoice: StripeObject): string | null {
  const fromParent = idOf(obj(obj(invoice, 'parent'), 'subscription_details'), 'subscription');
  if (fromParent) return fromParent;
  const legacy = idOf(invoice, 'subscription');
  if (legacy) return legacy;
  const lines = obj(invoice, 'lines')?.data;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const id = idOf(obj(obj(line, 'parent'), 'subscription_item_details'), 'subscription');
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

interface SubscriptionRow {
  id: string;
  channel_id: string;
  member_id: string;
  level_id: string | null;
  price_id: string | null;
  source: 'stripe' | 'lifetime' | 'gift' | 'comp';
  status: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  grace_until: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
  stripe_updated_at: number | null;
  discounted_amount: number | null;
  discount_end: number | null;
}

async function subscriptionByStripeId(
  db: D1Database,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  return first<SubscriptionRow>(
    db,
    'SELECT * FROM member_subscriptions WHERE stripe_subscription_id = ?1',
    stripeSubscriptionId,
  );
}

// ---------------------------------------------------------------------------------------------
// Discounts (for MRR: what a subscription really bills, not its list price)

interface CouponTerms {
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: string | null;
}

function couponTerms(coupon: StripeObject | null): CouponTerms | null {
  if (!coupon) return null;
  return {
    percentOff: num(coupon, 'percent_off'),
    amountOff: num(coupon, 'amount_off'),
    currency: str(coupon, 'currency')?.toLowerCase() ?? null,
    duration: str(coupon, 'duration'),
  };
}

/** A coupon by id: ours first (no network), else a best-effort read on the connected account. */
async function couponById(scope: EventScope, couponId: string): Promise<CouponTerms | null> {
  const own = await first<{
    percent_off: number | null;
    amount_off: number | null;
    currency: string | null;
    duration: string;
  }>(
    scope.ctx.db,
    `SELECT percent_off, amount_off, currency, duration FROM coupons
      WHERE channel_id = ?1 AND stripe_coupon_id = ?2`,
    scope.channelId,
    couponId,
  );
  if (own) {
    return {
      percentOff: own.percent_off,
      amountOff: own.amount_off,
      currency: own.currency,
      duration: own.duration,
    };
  }
  try {
    const fetched = await scope.ctx.stripe.request<StripeObject>(
      'GET',
      `/v1/coupons/${encodeURIComponent(couponId)}`,
      {},
      { account: scope.accountId },
    );
    return str(fetched, 'id') === couponId ? couponTerms(fetched) : null;
  } catch {
    return null;
  }
}

/**
 * The subscription's discount objects. Event payloads carry `discounts` as ids, so those are read
 * again with the discounts expanded. Older API versions have a single `discount` object. Null when
 * they can't be read: the row then keeps what it had.
 */
async function discountObjects(
  scope: EventScope,
  sub: StripeObject,
): Promise<StripeObject[] | null> {
  const listed = Array.isArray(sub.discounts) ? (sub.discounts as unknown[]) : null;
  const legacy = obj(sub, 'discount');
  const raw = listed ?? (legacy ? [legacy] : []);
  if (raw.every((d) => d && typeof d === 'object')) return raw as StripeObject[];
  const stripeId = str(sub, 'id');
  if (!stripeId) return null;
  try {
    const fresh = await scope.ctx.stripe.request<StripeObject>(
      'GET',
      `/v1/subscriptions/${encodeURIComponent(stripeId)}`,
      { expand: ['discounts'] },
      { account: scope.accountId },
    );
    const expanded = Array.isArray(fresh.discounts) ? (fresh.discounts as unknown[]) : null;
    if (!expanded || !expanded.every((d) => d && typeof d === 'object')) return null;
    return expanded as StripeObject[];
  } catch {
    return null;
  }
}

interface RecurringDiscount {
  /** What one interval bills while the discounts last; null when no recurring discount applies. */
  amount: number | null;
  /** When the earliest of them ends (ms); null for never. */
  end: number | null;
}

/**
 * Applies the subscription's recurring discounts to `amount` (one interval, list price × quantity).
 * Coupons with duration 'once' are skipped: they change one invoice, not the recurring revenue.
 * Discounts that already ended are skipped too. Percent coupons and amount coupons in the price's
 * currency apply in Stripe's order. Since 2025-09-30.clover the coupon sits under
 * discount.source.coupon; before that under discount.coupon. Undefined when the discounts can't
 * be read.
 */
async function recurringDiscount(
  scope: EventScope,
  sub: StripeObject,
  amount: number | null,
  currency: string | null,
): Promise<RecurringDiscount | undefined> {
  const none = { amount: null, end: null };
  if (amount === null) return none;
  const discounts = await discountObjects(scope, sub);
  if (!discounts) return undefined;
  let billed = amount;
  let end: number | null = null;
  let applied = false;
  for (const discount of discounts) {
    const discountEnd = ms(num(discount, 'end'));
    if (discountEnd !== null && discountEnd <= scope.ctx.now) continue;
    const holder = obj(discount, 'source') ?? discount;
    const couponId = idOf(holder, 'coupon');
    const terms =
      couponTerms(obj(holder, 'coupon')) ?? (couponId ? await couponById(scope, couponId) : null);
    if (!terms || terms.duration === 'once') continue;
    if (terms.percentOff !== null && terms.percentOff > 0) {
      billed *= 1 - Math.min(terms.percentOff, 100) / 100;
    } else if (terms.amountOff !== null && terms.amountOff > 0 && terms.currency === currency) {
      billed = Math.max(0, billed - terms.amountOff);
    } else {
      continue;
    }
    applied = true;
    if (discountEnd !== null) end = end === null ? discountEnd : Math.min(end, discountEnd);
  }
  return applied ? { amount: Math.max(0, Math.round(billed)), end } : none;
}

interface ApplyHint {
  memberId: string;
  levelId: string | null;
  priceId: string | null;
}

type ApplyResult =
  | { applied: true; memberId: string; subscriptionId: string; status: string }
  | { applied: false; memberId: string | null; reason: 'stale' | 'foreign' | 'unknown' };

/**
 * Creates or updates the member_subscriptions row of a Stripe subscription.
 * - `at` is the time the state is from: the event time, or now for a fresh read from Stripe.
 *   State older than the row's stripe_updated_at is never applied.
 * - `ended` marks a customer.subscription.deleted: status canceled, access revoked.
 * - A subscription seen for the first time needs a Member: the checkout hint, or the Member whose
 *   Stripe customer it is on this Channel, and a price that belongs to one of its levels.
 * Recomputing the entitlement is the caller's job.
 */
export async function applyStripeSubscription(
  scope: EventScope,
  sub: StripeObject,
  at: number,
  options: { ended?: boolean; hint?: ApplyHint } = {},
): Promise<ApplyResult> {
  const { db, now } = scope.ctx;
  const stripeId = str(sub, 'id');
  const rawStatus = str(sub, 'status');
  if (!stripeId?.startsWith('sub_') || !rawStatus || !SUBSCRIPTION_STATUSES.has(rawStatus)) {
    return { applied: false, memberId: null, reason: 'unknown' };
  }
  const status = options.ended ? 'canceled' : rawStatus;
  const existing = await subscriptionByStripeId(db, stripeId);
  if (existing && existing.channel_id !== scope.channelId) {
    return { applied: false, memberId: null, reason: 'foreign' };
  }
  if (existing) {
    const stale = existing.stripe_updated_at !== null && at < existing.stripe_updated_at;
    // Once deleted on Stripe, a subscription never comes back; a late update can't revive it.
    const revived = existing.status === 'canceled' && status !== 'canceled';
    if (stale || revived) return { applied: false, memberId: existing.member_id, reason: 'stale' };
  }

  const item = items(sub)[0] ?? null;
  const price = obj(item, 'price');
  const stripePriceId = str(price, 'id');
  const localPrice = stripePriceId
    ? await first<{ id: string; level_id: string; interval: string }>(
        db,
        'SELECT id, level_id, interval FROM level_prices WHERE channel_id = ?1 AND stripe_price_id = ?2',
        scope.channelId,
        stripePriceId,
      )
    : null;
  const customerId = idOf(sub, 'customer');

  let memberId = existing?.member_id ?? options.hint?.memberId ?? null;
  if (!memberId && customerId && localPrice) {
    const owner = await first<{ member_id: string }>(
      db,
      'SELECT member_id FROM stripe_customers WHERE channel_id = ?1 AND stripe_customer_id = ?2',
      scope.channelId,
      customerId,
    );
    memberId = owner?.member_id ?? null;
  }
  if (!memberId) return { applied: false, memberId: null, reason: 'unknown' };

  const levelId = localPrice?.level_id ?? existing?.level_id ?? options.hint?.levelId ?? null;
  const priceId = localPrice?.id ?? existing?.price_id ?? options.hint?.priceId ?? null;
  const recurring = obj(price, 'recurring');
  const stripeInterval = str(recurring, 'interval');
  const interval =
    stripeInterval === 'month' || stripeInterval === 'year'
      ? stripeInterval
      : (localPrice?.interval ?? null);
  const currency = str(price, 'currency');
  const amount = num(price, 'unit_amount');
  const quantity = num(item, 'quantity') ?? 1;

  const billed = amount === null ? null : Math.max(0, Math.round(amount * quantity));
  const normalizedCurrency = currency && currency.length === 3 ? currency.toLowerCase() : null;
  const discount = (await recurringDiscount(scope, sub, billed, normalizedCurrency)) ?? {
    amount: existing?.discounted_amount ?? null,
    end: existing?.discount_end ?? null,
  };

  let graceUntil = existing?.grace_until ?? null;
  if (status === 'past_due') graceUntil ??= now + scope.graceDays * DAY_MS;
  else if (status === 'active' || status === 'trialing') graceUntil = null;

  const values = {
    level_id: levelId,
    price_id: priceId,
    status,
    stripe_customer_id: customerId ?? existing?.stripe_customer_id ?? null,
    interval,
    currency: normalizedCurrency,
    amount: billed,
    current_period_end: periodEnd(sub),
    trial_end: ms(num(sub, 'trial_end')),
    cancel_at: ms(num(sub, 'cancel_at')),
    cancel_at_period_end: sub.cancel_at_period_end === true ? 1 : 0,
    canceled_at: ms(num(sub, 'canceled_at')) ?? (options.ended ? now : null),
    grace_until: graceUntil,
    discounted_amount: discount.amount,
    discount_end: discount.end,
  };

  if (existing) {
    const revoke = options.ended && existing.revoked_at === null;
    await run(
      db,
      `UPDATE member_subscriptions SET level_id = ?1, price_id = ?2, status = ?3, stripe_customer_id = ?4,
              interval = ?5, currency = ?6, amount = ?7, current_period_end = ?8, trial_end = ?9,
              cancel_at = ?10, cancel_at_period_end = ?11, canceled_at = ?12, grace_until = ?13,
              revoked_at = CASE WHEN ?14 THEN ?15 ELSE revoked_at END,
              revoke_reason = CASE WHEN ?14 THEN 'canceled' ELSE revoke_reason END,
              stripe_updated_at = ?16, updated_at = ?15, discounted_amount = ?19, discount_end = ?20
        WHERE id = ?17 AND channel_id = ?18`,
      values.level_id,
      values.price_id,
      values.status,
      values.stripe_customer_id,
      values.interval,
      values.currency,
      values.amount,
      values.current_period_end,
      values.trial_end,
      values.cancel_at,
      values.cancel_at_period_end,
      values.canceled_at,
      values.grace_until,
      revoke ? 1 : 0,
      now,
      at,
      existing.id,
      scope.channelId,
      values.discounted_amount,
      values.discount_end,
    );
    return { applied: true, memberId, subscriptionId: existing.id, status };
  }

  if (!localPrice && !options.hint) {
    // A subscription to a price that isn't one of this Channel's levels: not ours to grant.
    return { applied: false, memberId, reason: 'unknown' };
  }
  const id = newIdFor('memberSubscription', now);
  await run(
    db,
    `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, price_id, source, status,
            stripe_subscription_id, stripe_customer_id, interval, currency, amount, current_period_end,
            trial_end, cancel_at, cancel_at_period_end, canceled_at, grace_until, revoked_at,
            revoke_reason, stripe_updated_at, created_at, updated_at, discounted_amount, discount_end)
     VALUES (?1, ?2, ?3, ?4, ?5, 'stripe', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
             ?18, ?19, ?20, ?21, ?21, ?22, ?23)`,
    id,
    scope.channelId,
    memberId,
    values.level_id,
    values.price_id,
    values.status,
    stripeId,
    values.stripe_customer_id,
    values.interval,
    values.currency,
    values.amount,
    values.current_period_end,
    values.trial_end,
    values.cancel_at,
    values.cancel_at_period_end,
    values.canceled_at,
    values.grace_until,
    options.ended ? now : null,
    options.ended ? 'canceled' : null,
    at,
    now,
    values.discounted_amount,
    values.discount_end,
  );
  return { applied: true, memberId, subscriptionId: id, status };
}

/** Reads a subscription on the connected account; null when the answer isn't a subscription. */
export async function fetchSubscription(
  scope: EventScope,
  stripeSubscriptionId: string,
): Promise<StripeObject | null> {
  const fetched = await scope.ctx.stripe.request<StripeObject>(
    'GET',
    `/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
    { expand: ['discounts'] },
    { account: scope.accountId },
  );
  return isSubscription(fetched) ? fetched : null;
}

export async function recompute(scope: LedgerScope, memberId: string | null): Promise<void> {
  if (memberId) await recomputeEntitlement(scope.ctx.db, scope.channelId, memberId, scope.ctx.now);
}

export async function handleSubscriptionEvent(
  scope: EventScope,
  ended: boolean,
): Promise<'processed' | 'ignored'> {
  const result = await applyStripeSubscription(scope, scope.object, scope.eventAt, { ended });
  if (!result.applied) return 'ignored';
  await recompute(scope, result.memberId);
  if (ended) {
    const subscriptionId = str(scope.object, 'id');
    const row = subscriptionId ? await subscriptionByStripeId(scope.ctx.db, subscriptionId) : null;
    await sendPaymentNotice(scope.ctx, {
      key: 'subscription_cancelled',
      channelId: scope.channelId,
      memberId: result.memberId,
      levelId: row?.level_id ?? null,
      dedupe: subscriptionId ?? scope.event.id,
    });
  }
  return 'processed';
}

export async function handleTrialWillEnd(scope: EventScope): Promise<'processed' | 'ignored'> {
  const stripeId = str(scope.object, 'id');
  const row = stripeId ? await subscriptionByStripeId(scope.ctx.db, stripeId) : null;
  if (!row || row.channel_id !== scope.channelId) return 'ignored';
  const trialEnd = ms(num(scope.object, 'trial_end')) ?? row.stripe_updated_at;
  if (scope.ctx.mail && row.revoked_at === null && trialEnd) {
    await sendTrialEndingMail(scope.ctx, {
      channelId: scope.channelId,
      memberId: row.member_id,
      levelId: row.level_id,
      trialEnd,
    });
  }
  return 'processed';
}

// ---------------------------------------------------------------------------------------------
// Invoices

export async function recordPayment(
  scope: LedgerScope,
  input: {
    memberId: string | null;
    subscriptionId: string | null;
    kind: 'invoice' | 'one_time' | 'refund';
    stripeObjectId: string;
    currency: string | null;
    amount: number;
    occurredAt: number;
  },
): Promise<void> {
  if (!input.currency || input.currency.length !== 3) return;
  // Unique per Channel: a redelivered object never adds a second row, and another Channel's row
  // for the same id (a forged own-key event, say) can't block this one.
  await run(
    scope.ctx.db,
    `INSERT INTO payments (id, channel_id, member_id, subscription_id, kind, stripe_object_id, currency, amount, occurred_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (channel_id, stripe_object_id) DO NOTHING`,
    newIdFor('payment', scope.ctx.now),
    scope.channelId,
    input.memberId,
    input.subscriptionId,
    input.kind,
    input.stripeObjectId,
    input.currency.toLowerCase(),
    input.amount,
    input.occurredAt,
  );
}

async function memberForCustomer(scope: EventScope, customerId: string | null) {
  if (!customerId) return null;
  const row = await first<{ member_id: string }>(
    scope.ctx.db,
    'SELECT member_id FROM stripe_customers WHERE channel_id = ?1 AND stripe_customer_id = ?2',
    scope.channelId,
    customerId,
  );
  return row?.member_id ?? null;
}

export async function handleInvoicePaid(scope: EventScope): Promise<'processed' | 'ignored'> {
  const invoice = scope.object;
  const invoiceId = str(invoice, 'id');
  if (!invoiceId?.startsWith('in_')) return 'ignored';
  const stripeSubId = invoiceSubscriptionId(invoice);
  const row = stripeSubId ? await subscriptionByStripeId(scope.ctx.db, stripeSubId) : null;
  const own = row && row.channel_id === scope.channelId ? row : null;
  const memberId = own?.member_id ?? (await memberForCustomer(scope, idOf(invoice, 'customer')));

  const amount = num(invoice, 'amount_paid') ?? 0;
  if (amount > 0) {
    await recordPayment(scope, {
      memberId,
      subscriptionId: own?.id ?? null,
      kind: 'invoice',
      stripeObjectId: invoiceId,
      currency: str(invoice, 'currency'),
      amount,
      occurredAt: ms(num(obj(invoice, 'status_transitions'), 'paid_at')) ?? scope.eventAt,
    });
    const currency = str(invoice, 'currency') ?? 'usd';
    await sendPaymentNotice(scope.ctx, {
      key: 'payment_receipt',
      channelId: scope.channelId,
      memberId,
      levelId: own?.level_id ?? null,
      amount: new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount / 100),
      dedupe: invoiceId,
    });
  }
  if (!own || !stripeSubId) return memberId ? 'processed' : 'ignored';

  // A paid invoice ends any grace. Read the subscription for its new period; when the read
  // gives nothing usable (the dev fake), settle the status here.
  const fresh = await fetchSubscription(scope, stripeSubId);
  if (fresh) await applyStripeSubscription(scope, fresh, scope.ctx.now);
  await run(
    scope.ctx.db,
    `UPDATE member_subscriptions
        SET grace_until = NULL,
            status = CASE WHEN status IN ('past_due', 'unpaid', 'incomplete') THEN 'active' ELSE status END,
            updated_at = ?1
      WHERE id = ?2 AND channel_id = ?3 AND status <> 'canceled'`,
    scope.ctx.now,
    own.id,
    scope.channelId,
  );
  await recompute(scope, own.member_id);
  return 'processed';
}

export async function handleInvoicePaymentFailed(
  scope: EventScope,
): Promise<'processed' | 'ignored'> {
  const stripeSubId = invoiceSubscriptionId(scope.object);
  const row = stripeSubId ? await subscriptionByStripeId(scope.ctx.db, stripeSubId) : null;
  if (!row || row.channel_id !== scope.channelId) return 'ignored';
  // The grace clock starts at the first failure and is never pushed back by later ones.
  await run(
    scope.ctx.db,
    `UPDATE member_subscriptions SET grace_until = coalesce(grace_until, ?1), updated_at = ?2
      WHERE id = ?3 AND channel_id = ?4`,
    scope.ctx.now + scope.graceDays * DAY_MS,
    scope.ctx.now,
    row.id,
    scope.channelId,
  );
  await recompute(scope, row.member_id);
  // Only the first failure of a run of them; later retries say nothing new.
  if (row.grace_until === null) {
    await sendPaymentNotice(scope.ctx, {
      key: 'payment_failed',
      channelId: scope.channelId,
      memberId: row.member_id,
      levelId: row.level_id,
      dedupe: `${row.id}:${scope.ctx.now - (scope.ctx.now % DAY_MS)}`,
    });
  }
  return 'processed';
}

// ---------------------------------------------------------------------------------------------
// Refunds and disputes

/** A best-effort list call: a failure means "not found", never a stuck event. */
async function lookup(
  scope: EventScope,
  path: string,
  params: Record<string, unknown>,
): Promise<{ data?: unknown }> {
  try {
    return await scope.ctx.stripe.request<{ data?: unknown }>('GET', path, params, {
      account: scope.accountId,
    });
  } catch {
    return {};
  }
}

/**
 * The subscription row a charge paid for: through the invoice or payment intent we recorded, then
 * Stripe's invoice payments, then the customer's only subscription on this Channel. A payment
 * intent we recorded as a one-time purchase (a tip, a good, a Gift Pass) paid for no subscription.
 */
async function subscriptionForCharge(
  scope: EventScope,
  charge: { invoiceId: string | null; paymentIntentId: string | null; customerId: string | null },
): Promise<SubscriptionRow | null> {
  const { db } = scope.ctx;
  const byPayment = async (objectId: string | null) => {
    if (!objectId) return null;
    return first<SubscriptionRow>(
      db,
      `SELECT s.* FROM payments p JOIN member_subscriptions s ON s.id = p.subscription_id
        WHERE p.stripe_object_id = ?1 AND p.channel_id = ?2 AND s.channel_id = ?2`,
      objectId,
      scope.channelId,
    );
  };
  const direct = (await byPayment(charge.invoiceId)) ?? (await byPayment(charge.paymentIntentId));
  if (direct) return direct;
  if (charge.paymentIntentId) {
    // Checkout reuses the Member's customer for every purchase, so the customer fallback below
    // would otherwise pin a refunded tip or good on their unrelated subscription.
    const oneTime = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM payments
        WHERE stripe_object_id = ?1 AND channel_id = ?2 AND kind = 'one_time' AND subscription_id IS NULL`,
      charge.paymentIntentId,
      scope.channelId,
    );
    if (oneTime) return null;
  }

  if (charge.paymentIntentId) {
    const listed = await lookup(scope, '/v1/invoice_payments', {
      payment: { type: 'payment_intent', payment_intent: charge.paymentIntentId },
      limit: 1,
    });
    const entry = Array.isArray(listed.data) ? listed.data[0] : null;
    const invoiceId = idOf(entry, 'invoice');
    const viaInvoice = await byPayment(invoiceId);
    if (viaInvoice) return viaInvoice;
  }

  if (charge.customerId) {
    const rows = await all<SubscriptionRow>(
      db,
      `SELECT * FROM member_subscriptions
        WHERE channel_id = ?1 AND stripe_customer_id = ?2 AND revoked_at IS NULL
          AND source IN ('stripe', 'lifetime')`,
      scope.channelId,
      charge.customerId,
    );
    if (rows.length === 1) return rows[0] as SubscriptionRow;
  }
  return null;
}

/** Ends access now and stops further billing on Stripe. */
async function revokeNow(
  scope: EventScope,
  row: SubscriptionRow,
  reason: 'refund' | 'dispute',
): Promise<void> {
  const { db, now } = scope.ctx;
  const updated = await first<{ id: string }>(
    db,
    `UPDATE member_subscriptions SET revoked_at = ?1, revoke_reason = ?2, grace_until = NULL, updated_at = ?1
      WHERE id = ?3 AND channel_id = ?4 AND revoked_at IS NULL RETURNING id`,
    now,
    reason,
    row.id,
    scope.channelId,
  );
  if (!updated) return;
  if (row.source === 'stripe' && row.stripe_subscription_id && row.status !== 'canceled') {
    // A revoked subscription must not keep charging. Already canceled on Stripe is fine.
    try {
      await scope.ctx.stripe.request(
        'DELETE',
        `/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
        {},
        { account: scope.accountId, idempotencyKey: `revoke:${row.stripe_subscription_id}` },
      );
    } catch {
      // The revocation stands either way; customer.subscription.deleted follows when it works.
    }
  }
  await appendAudit(db, {
    workspaceId: scope.workspaceId,
    actorId: null,
    action: 'member_subscription.revoked',
    targetType: 'member_subscription',
    targetId: row.id,
    metadata: { reason, memberId: row.member_id, stripeEvent: scope.event.id },
  });
  await recompute(scope, row.member_id);
}

/**
 * A refunded or disputed Gift Pass stops being claimable, and a claimed one loses the access it
 * gave. The claim wrote the pass's claimed_at and its subscription's created_at from one clock
 * reading, which is how the grant is found again.
 */
async function endGiftPass(
  scope: EventScope,
  paymentIntentId: string | null,
  reason: 'refund' | 'dispute',
): Promise<boolean> {
  if (!paymentIntentId) return false;
  const listed = await lookup(scope, '/v1/checkout/sessions', {
    payment_intent: paymentIntentId,
    limit: 1,
  });
  const sessionId = idOf(Array.isArray(listed.data) ? listed.data[0] : null, 'id');
  if (!sessionId) return false;
  const pass = await first<{ claimed_member_id: string | null; claimed_at: number | null }>(
    scope.ctx.db,
    `UPDATE gift_passes SET status = 'refunded'
      WHERE channel_id = ?1 AND checkout_session_id = ?2 AND status IN ('paid', 'claimed')
      RETURNING claimed_member_id, claimed_at`,
    scope.channelId,
    sessionId,
  );
  if (!pass) return false;
  if (pass.claimed_member_id && pass.claimed_at !== null) {
    const grant = await first<SubscriptionRow>(
      scope.ctx.db,
      `SELECT * FROM member_subscriptions
        WHERE channel_id = ?1 AND member_id = ?2 AND source = 'gift' AND created_at = ?3`,
      scope.channelId,
      pass.claimed_member_id,
      pass.claimed_at,
    );
    if (grant) await revokeNow(scope, grant, reason);
  }
  return true;
}

export async function handleChargeRefunded(scope: EventScope): Promise<'processed' | 'ignored'> {
  const charge = scope.object;
  const chargeId = str(charge, 'id');
  if (!chargeId?.startsWith('ch_') && !chargeId?.startsWith('py_')) return 'ignored';
  const amount = num(charge, 'amount') ?? 0;
  const refunded = num(charge, 'amount_refunded') ?? 0;
  const links = {
    invoiceId: idOf(charge, 'invoice'),
    paymentIntentId: idOf(charge, 'payment_intent'),
    customerId: idOf(charge, 'customer'),
  };
  const row = await subscriptionForCharge(scope, links);
  const memberId = row?.member_id ?? (await memberForCustomer(scope, links.customerId));

  // amount_refunded is cumulative: record what this event adds.
  const prior = await first<{ total: number | null }>(
    scope.ctx.db,
    `SELECT sum(amount) AS total FROM payments
      WHERE channel_id = ?1 AND kind = 'refund' AND stripe_object_id LIKE ?2`,
    scope.channelId,
    `${chargeId}:refund:%`,
  );
  const delta = refunded + (prior?.total ?? 0);
  if (delta > 0) {
    await recordPayment(scope, {
      memberId,
      subscriptionId: row?.id ?? null,
      kind: 'refund',
      stripeObjectId: `${chargeId}:refund:${refunded}`,
      currency: str(charge, 'currency'),
      amount: -delta,
      occurredAt: scope.eventAt,
    });
  }

  const full = charge.refunded === true || (amount > 0 && refunded >= amount);
  if (!full) return delta > 0 || row ? 'processed' : 'ignored';
  // What the charge itself bought comes first, as for a dispute.
  const good = await endGoodOrder(scope.ctx.db, {
    channelId: scope.channelId,
    workspaceId: scope.workspaceId,
    paymentIntentId: links.paymentIntentId,
    status: 'refunded',
    now: scope.ctx.now,
  });
  if (good || (await endGiftPass(scope, links.paymentIntentId, 'refund'))) return 'processed';
  if (row) {
    await revokeNow(scope, row, 'refund');
    return 'processed';
  }
  return delta > 0 ? 'processed' : 'ignored';
}

export async function handleDisputeCreated(scope: EventScope): Promise<'processed' | 'ignored'> {
  const dispute = scope.object;
  let paymentIntentId = idOf(dispute, 'payment_intent');
  let customerId: string | null = null;
  let invoiceId: string | null = null;
  const chargeId = idOf(dispute, 'charge');
  const expanded = obj(dispute, 'charge');
  if (expanded) {
    customerId = idOf(expanded, 'customer');
    invoiceId = idOf(expanded, 'invoice');
    paymentIntentId ??= idOf(expanded, 'payment_intent');
  } else if (chargeId) {
    const charge = await scope.ctx.stripe.request<StripeObject>(
      'GET',
      `/v1/charges/${encodeURIComponent(chargeId)}`,
      {},
      { account: scope.accountId },
    );
    customerId = idOf(charge, 'customer');
    invoiceId = idOf(charge, 'invoice');
    paymentIntentId ??= idOf(charge, 'payment_intent');
  }
  const good = await endGoodOrder(scope.ctx.db, {
    channelId: scope.channelId,
    workspaceId: scope.workspaceId,
    paymentIntentId,
    status: 'disputed',
    now: scope.ctx.now,
  });
  if (good || (await endGiftPass(scope, paymentIntentId, 'dispute'))) return 'processed';
  const row = await subscriptionForCharge(scope, { invoiceId, paymentIntentId, customerId });
  if (!row) return 'ignored';
  await revokeNow(scope, row, 'dispute');
  return 'processed';
}

// ---------------------------------------------------------------------------------------------
// Connected account

export async function handleAccountUpdated(scope: EventScope): Promise<'processed' | 'ignored'> {
  const account = scope.object;
  // The object must be the account the event came from.
  if (str(account, 'id') !== scope.accountId) return 'ignored';
  const currency = str(account, 'default_currency');
  await run(
    scope.ctx.db,
    `UPDATE stripe_accounts SET charges_enabled = ?1, payouts_enabled = ?2, details_submitted = ?3,
            default_currency = coalesce(?4, default_currency), updated_at = ?5
      WHERE channel_id = ?6 AND stripe_account_id = ?7`,
    account.charges_enabled === true ? 1 : 0,
    account.payouts_enabled === true ? 1 : 0,
    account.details_submitted === true ? 1 : 0,
    currency && currency.length === 3 ? currency.toLowerCase() : null,
    scope.ctx.now,
    scope.channelId,
    scope.accountId,
  );
  return 'processed';
}
