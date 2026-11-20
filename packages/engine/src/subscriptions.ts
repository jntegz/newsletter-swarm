/**
 * Reader self-serve billing in the Member Center (Phase 5): the Member's paid level and what they
 * can do about it.
 *
 * Only a Stripe subscription can be changed here, and only on the Channel's own connected account:
 * cancel at period end and resume, change level (with a proration preview), update the payment
 * method in a Billing Portal session, and list invoices. Lifetime, gift and comp access only show
 * when they end.
 *
 * The subscription is always the one `memberBilling` finds for the Member named by the signed
 * Member Center token; nothing a form posts can point at another subscription. Changes are written
 * to member_subscriptions optimistically (without touching stripe_updated_at), so the webhook
 * that follows still applies Stripe's version.
 */
import { all, first, run } from './db';
import { currentEntitlement, recomputeEntitlement } from './entitlements';
import type { StripeApi } from './stripe';

export type SubscriptionSource = 'stripe' | 'lifetime' | 'gift' | 'comp';

export interface BillingSubscription {
  id: string;
  channelId: string;
  memberId: string;
  levelId: string | null;
  levelName: string | null;
  priceId: string | null;
  source: SubscriptionSource;
  status: string;
  interval: 'month' | 'year' | 'lifetime' | null;
  currency: string | null;
  amount: number | null;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  /** Set on a PayPal subscription; stripeSubscriptionId is null then. */
  paypalSubscriptionId: string | null;
}

/** Another price the Member can move to. */
export interface LevelChoice {
  priceId: string;
  levelId: string;
  levelName: string;
  interval: 'month' | 'year';
  currency: string;
  amount: number;
  stripePriceId: string;
}

export interface MemberBilling {
  subscription: BillingSubscription;
  /** The Channel's connected account, or null when it is no longer connected. */
  account: string | null;
  /** True when the reader can act on it here (a live Stripe subscription on a connected account). */
  manageable: boolean;
  /** Prices of other levels (or the other interval) in the same currency. */
  choices: LevelChoice[];
}

interface SubscriptionRow {
  id: string;
  channel_id: string;
  member_id: string;
  level_id: string | null;
  level_name: string | null;
  price_id: string | null;
  source: SubscriptionSource;
  status: string;
  interval: BillingSubscription['interval'];
  currency: string | null;
  amount: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at: number | null;
  cancel_at_period_end: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  paypal_subscription_id: string | null;
}

const LIVE_STRIPE_STATUSES = ['trialing', 'active', 'past_due', 'unpaid'];

function toSubscription(row: SubscriptionRow): BillingSubscription {
  return {
    id: row.id,
    channelId: row.channel_id,
    memberId: row.member_id,
    levelId: row.level_id,
    levelName: row.level_name,
    priceId: row.price_id,
    source: row.source,
    status: row.status,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    currentPeriodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    cancelAt: row.cancel_at,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
    paypalSubscriptionId: row.paypal_subscription_id,
  };
}

/**
 * The subscription that gives the Member their access now (the same one the entitlement cache is
 * computed from), with what they can do about it. A Member whose payment failed and whose grace
 * has run out still sees that Stripe subscription, so they can update the payment method. Null
 * for a free Member.
 */
export async function memberBilling(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<MemberBilling | null> {
  const entitlement = await currentEntitlement(db, channelId, memberId, now);
  // ?1 null: the newest Stripe subscription waiting on a payment, if any.
  const row = await first<SubscriptionRow>(
    db,
    `SELECT s.id, s.channel_id, s.member_id, s.level_id, l.name AS level_name, s.price_id, s.source,
            s.status, s.interval, s.currency, s.amount, s.current_period_end, s.trial_end, s.cancel_at,
            s.cancel_at_period_end, s.stripe_subscription_id, s.stripe_customer_id,
            s.paypal_subscription_id
       FROM member_subscriptions s LEFT JOIN membership_levels l ON l.id = s.level_id
      WHERE s.member_id = ?2 AND s.channel_id = ?3
        AND (s.id = ?1 OR (?1 IS NULL AND s.source = 'stripe' AND s.revoked_at IS NULL
                           AND s.status IN ('past_due', 'unpaid')))
      ORDER BY s.created_at DESC LIMIT 1`,
    entitlement?.subscriptionId ?? null,
    memberId,
    channelId,
  );
  if (!row) return null;
  const subscription = toSubscription(row);
  const account = await first<{ stripe_account_id: string }>(
    db,
    `SELECT stripe_account_id FROM stripe_accounts WHERE channel_id = ?1 AND status = 'connected'`,
    channelId,
  );
  const manageable =
    subscription.source === 'stripe' &&
    account !== null &&
    subscription.stripeSubscriptionId !== null &&
    subscription.stripeCustomerId !== null &&
    LIVE_STRIPE_STATUSES.includes(subscription.status);
  const choices =
    manageable && subscription.currency
      ? await levelChoices(db, channelId, subscription.currency, subscription.priceId)
      : [];
  return { subscription, account: account?.stripe_account_id ?? null, manageable, choices };
}

async function levelChoices(
  db: D1Database,
  channelId: string,
  currency: string,
  currentPriceId: string | null,
): Promise<LevelChoice[]> {
  const rows = await all<{
    id: string;
    level_id: string;
    name: string;
    interval: 'month' | 'year';
    currency: string;
    amount: number;
    stripe_price_id: string;
  }>(
    db,
    `SELECT p.id, p.level_id, l.name, p.interval, p.currency, p.amount, p.stripe_price_id
       FROM level_prices p JOIN membership_levels l ON l.id = p.level_id
      WHERE p.channel_id = ?1 AND l.channel_id = ?1 AND p.status = 'active' AND l.status = 'active'
        AND p.interval IN ('month', 'year') AND p.custom_amount = 0 AND p.stripe_price_id IS NOT NULL
        AND lower(p.currency) = lower(?2) AND p.id IS NOT ?3
      ORDER BY l.position, l.created_at, p.interval`,
    channelId,
    currency,
    currentPriceId,
  );
  return rows.map((row) => ({
    priceId: row.id,
    levelId: row.level_id,
    levelName: row.name,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    stripePriceId: row.stripe_price_id,
  }));
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

function stripeTarget(billing: MemberBilling): { account: string; sub: string; customer: string } {
  const { subscription, account } = billing;
  if (
    !billing.manageable ||
    !account ||
    !subscription.stripeSubscriptionId ||
    !subscription.stripeCustomerId
  ) {
    throw new BillingError('This subscription can’t be changed here.');
  }
  return {
    account,
    sub: subscription.stripeSubscriptionId,
    customer: subscription.stripeCustomerId,
  };
}

export interface BillingContext {
  db: D1Database;
  stripe: StripeApi;
  now: number;
}

/** Cancels at the end of the paid period (`cancel: true`) or takes that back. */
export async function setCancelAtPeriodEnd(
  ctx: BillingContext,
  billing: MemberBilling,
  cancel: boolean,
): Promise<void> {
  const target = stripeTarget(billing);
  if (billing.subscription.cancelAtPeriodEnd === cancel) return;
  await ctx.stripe.request(
    'POST',
    `/v1/subscriptions/${encodeURIComponent(target.sub)}`,
    { cancel_at_period_end: cancel },
    { account: target.account },
  );
  await run(
    ctx.db,
    `UPDATE member_subscriptions
        SET cancel_at_period_end = ?1, cancel_at = CASE WHEN ?1 = 1 THEN current_period_end END,
            canceled_at = CASE WHEN ?1 = 1 THEN ?2 END, updated_at = ?2
      WHERE id = ?3 AND member_id = ?4 AND channel_id = ?5`,
    cancel ? 1 : 0,
    ctx.now,
    billing.subscription.id,
    billing.subscription.memberId,
    billing.subscription.channelId,
  );
}

/** A choice by its level_prices id, only from the Member's own choices. */
export function findChoice(billing: MemberBilling, priceId: unknown): LevelChoice | null {
  if (typeof priceId !== 'string') return null;
  return billing.choices.find((choice) => choice.priceId === priceId) ?? null;
}

async function subscriptionItem(stripe: StripeApi, account: string, sub: string): Promise<string> {
  const remote = await stripe.request<{ items?: { data?: { id?: unknown }[] } }>(
    'GET',
    `/v1/subscriptions/${encodeURIComponent(sub)}`,
    {},
    { account },
  );
  const items = remote.items?.data ?? [];
  const id = items.length === 1 ? items[0]?.id : undefined;
  if (typeof id !== 'string') throw new BillingError('This subscription can’t be changed here.');
  return id;
}

export interface LevelChangePreview {
  /** What the next invoice comes to with the proration, in minor units. */
  amountDue: number;
  currency: string;
  /** Seconds; pass back to applyLevelChange so the charge matches the preview. */
  prorationDate: number;
  /** When that invoice is due (milliseconds), when Stripe says. */
  nextPaymentAt: number | null;
}

/** How long a preview's proration date stays usable. */
export const PRORATION_PREVIEW_TTL_MS = 30 * 60 * 1000;

/** The upcoming invoice if the Member moved to `choice` now. */
export async function previewLevelChange(
  ctx: BillingContext,
  billing: MemberBilling,
  choice: LevelChoice,
): Promise<LevelChangePreview> {
  const target = stripeTarget(billing);
  const item = await subscriptionItem(ctx.stripe, target.account, target.sub);
  const prorationDate = Math.floor(ctx.now / 1000);
  const invoice = await ctx.stripe.request<{
    amount_due?: unknown;
    currency?: unknown;
    next_payment_attempt?: unknown;
  }>(
    'POST',
    '/v1/invoices/create_preview',
    {
      customer: target.customer,
      subscription: target.sub,
      subscription_details: {
        items: [{ id: item, price: choice.stripePriceId }],
        proration_behavior: 'create_prorations',
        proration_date: prorationDate,
      },
    },
    { account: target.account },
  );
  return {
    amountDue: typeof invoice.amount_due === 'number' ? invoice.amount_due : 0,
    currency: typeof invoice.currency === 'string' ? invoice.currency : choice.currency,
    prorationDate,
    nextPaymentAt:
      typeof invoice.next_payment_attempt === 'number' ? invoice.next_payment_attempt * 1000 : null,
  };
}

/** A proration date from a preview form, if it is recent enough to honour. */
export function usableProrationDate(value: unknown, now: number): number | null {
  const seconds = typeof value === 'string' && /^\d{9,11}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  return ms <= now && ms > now - PRORATION_PREVIEW_TTL_MS ? seconds : null;
}

/** Moves the subscription to `choice`, prorated, and updates the cached level. */
export async function applyLevelChange(
  ctx: BillingContext,
  billing: MemberBilling,
  choice: LevelChoice,
  prorationDate: number | null,
): Promise<void> {
  const target = stripeTarget(billing);
  const item = await subscriptionItem(ctx.stripe, target.account, target.sub);
  await ctx.stripe.request(
    'POST',
    `/v1/subscriptions/${encodeURIComponent(target.sub)}`,
    {
      items: [{ id: item, price: choice.stripePriceId }],
      proration_behavior: 'create_prorations',
      ...(prorationDate ? { proration_date: prorationDate } : {}),
    },
    {
      account: target.account,
      idempotencyKey: `level-change:${billing.subscription.id}:${choice.priceId}:${prorationDate ?? Math.floor(ctx.now / 60_000)}`,
    },
  );
  await run(
    ctx.db,
    `UPDATE member_subscriptions
        SET level_id = ?1, price_id = ?2, interval = ?3, currency = ?4, amount = ?5, updated_at = ?6
      WHERE id = ?7 AND member_id = ?8 AND channel_id = ?9`,
    choice.levelId,
    choice.priceId,
    choice.interval,
    choice.currency,
    choice.amount,
    ctx.now,
    billing.subscription.id,
    billing.subscription.memberId,
    billing.subscription.channelId,
  );
  await recomputeEntitlement(
    ctx.db,
    billing.subscription.channelId,
    billing.subscription.memberId,
    ctx.now,
  );
}

/** A Billing Portal session on the connected account, for updating the payment method. */
export async function billingPortalUrl(
  stripe: StripeApi,
  billing: MemberBilling,
  returnUrl: string,
): Promise<string> {
  const target = stripeTarget(billing);
  const session = await stripe.request<{ url?: unknown }>(
    'POST',
    '/v1/billing_portal/sessions',
    { customer: target.customer, return_url: returnUrl },
    { account: target.account },
  );
  const url = typeof session.url === 'string' ? safeHttpUrl(session.url) : null;
  if (!url) throw new BillingError('The payment page could not be opened.');
  return url;
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  /** Milliseconds. */
  createdAt: number;
  amount: number;
  currency: string;
  status: string;
  /** Stripe's hosted page for the invoice, when there is one. */
  url: string | null;
}

/** The customer's latest invoices on the connected account. */
export async function listInvoices(
  stripe: StripeApi,
  billing: MemberBilling,
  limit = 12,
): Promise<InvoiceSummary[]> {
  const target = stripeTarget(billing);
  const list = await stripe.request<{ data?: Record<string, unknown>[] }>(
    'GET',
    '/v1/invoices',
    { customer: target.customer, limit },
    { account: target.account },
  );
  const out: InvoiceSummary[] = [];
  for (const invoice of list.data ?? []) {
    if (typeof invoice.id !== 'string' || invoice.status === 'draft') continue;
    const paid = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0;
    const due = typeof invoice.amount_due === 'number' ? invoice.amount_due : 0;
    out.push({
      id: invoice.id,
      number: typeof invoice.number === 'string' ? invoice.number : null,
      createdAt: typeof invoice.created === 'number' ? invoice.created * 1000 : 0,
      amount: invoice.status === 'paid' ? paid : due,
      currency: typeof invoice.currency === 'string' ? invoice.currency : 'usd',
      status: typeof invoice.status === 'string' ? invoice.status : 'open',
      url:
        typeof invoice.hosted_invoice_url === 'string'
          ? safeHttpUrl(invoice.hosted_invoice_url)
          : null,
    });
  }
  return out;
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** An amount in minor units as the reader reads it, e.g. 500 usd → "$5.00", 500 jpy → "¥500". */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}
