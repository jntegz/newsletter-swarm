/**
 * PayPal for paid memberships: connect, subscribe, cancel, renewals, refunds and access. Coupons,
 * tax, plan changes and Products stay Stripe-only. Written from PayPal's API documentation and
 * covered with a fake: it has never run against PayPal itself. docs/deployment.md.
 */
import { appendAudit } from '@swarm/db';
import { askBuyerToConfirm, resolveBuyer, type BuyerRow } from './payments-checkout';
import { DAY_MS, recompute, recordPayment, type LedgerScope } from './payments-sync';
import { all, first, newIdFor, run } from './db';
import type { PaymentsContext } from './payments';
import { sendPaymentNotice } from './payments-mail';
import { takeUsage } from './usage';
import type { PrivacyKeys, ProviderFetch } from './vault-ports';
export type PayPalMode = 'live' | 'sandbox';

const API: Record<PayPalMode, string> = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};
const GRACE_DAYS = 7;
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export const PAYPAL_WEBHOOK_EVENTS = [
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
] as const;

/** PayPal's subscription currencies. These three have no decimals there. */
const CURRENCIES = new Set(
  'AUD BRL CAD CNY CZK DKK EUR HKD HUF ILS JPY MYR MXN TWD NZD NOK PHP PLN GBP SGD SEK CHF THB USD'.split(
    ' ',
  ),
);
const NO_DECIMALS = new Set(['HUF', 'JPY', 'TWD']);

export const isPayPalCurrency = (currency: string) => CURRENCIES.has(currency.toUpperCase());

const toValue = (amount: number, currency: string) =>
  NO_DECIMALS.has(currency.toUpperCase())
    ? String(Math.round(amount / 100))
    : (amount / 100).toFixed(2);

const toMinor = (value: unknown, currency: string): number | null => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return NO_DECIMALS.has(currency.toUpperCase())
    ? Math.round(number) * 100
    : Math.round(number * 100);
};

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}

/** Every call to PayPal gives up after this long, so a hung answer can't hold a request. */
export const PAYPAL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Access tokens by account, shared by the clients this isolate builds (the webhook route builds
 * one per request). Keyed by the credentials themselves, so a changed secret never reuses a
 * token, and dropped a minute before PayPal says it expires.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_CACHE_MAX = 500;

/** Drops every cached access token (tests, and after credentials change). */
export function forgetPayPalTokens(): void {
  tokenCache.clear();
}

export class PayPalApi {
  private token: string | null = null;

  /**
   * `secret` null: the fetcher is the vault's PayPal proxy (vaultFetch), which gets the access
   * token and attaches it itself, so this client sends no credential of its own.
   */
  constructor(
    private readonly mode: PayPalMode,
    private readonly clientId: string,
    private readonly secret: string | null,
    private readonly fetcher: typeof fetch = defaultFetch,
  ) {}

  private get cacheKey() {
    return `${this.mode}\u0000${this.clientId}\u0000${this.secret}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    if (this.secret === null) throw new PayPalError('PayPal isn’t available here.', 503);
    const cached = tokenCache.get(this.cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.token = cached.token;
      return this.token;
    }
    const res = await this.fetcher(`${API[this.mode]}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.clientId}:${this.secret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new PayPalError('PayPal didn’t accept this client ID and secret.', res.status);
    }
    this.token = body.access_token;
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 0;
    if (lifetime > 120_000) {
      if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
      tokenCache.set(this.cacheKey, {
        token: this.token,
        expiresAt: Date.now() + lifetime - 60_000,
      });
    }
    return this.token;
  }

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: string | Record<string, unknown>,
    requestId?: string,
  ): Promise<T> {
    const res = await this.fetcher(`${API[this.mode]}${path}`, {
      method,
      headers: {
        ...(this.secret === null ? {} : { authorization: `Bearer ${await this.accessToken()}` }),
        'content-type': 'application/json',
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS),
    });
    const answer = (await res.json().catch(() => ({}))) as { message?: unknown };
    if (!res.ok) {
      if (res.status === 401) tokenCache.delete(this.cacheKey);
      throw new PayPalError(
        typeof answer.message === 'string' ? answer.message : `PayPal answered ${res.status}.`,
        res.status,
      );
    }
    return answer as T;
  }
}

export interface PayPalAccountRow {
  channel_id: string;
  workspace_id: string;
  mode: PayPalMode;
  client_id: string;
  secret_enc: string;
  secret_last4: string;
  webhook_id: string;
  connected_at: number;
}

export const readPayPalAccount = (db: D1Database, channelId: string) =>
  first<PayPalAccountRow>(db, 'SELECT * FROM paypal_accounts WHERE channel_id = ?1', channelId);

/**
 * The vault's PayPal proxy for a Channel's account (@swarm/vault vaultFetch), and the erasure
 * markers its events check (privacy.ts).
 */
export interface PayPalVault {
  fetchFor(channelId: string): ProviderFetch;
  markers: PrivacyKeys;
}

/**
 * The client for a connected account, through the vault (which holds the account's secret), or
 * null when this worker has no vault for it.
 */
export async function payPalClient(
  vault: Pick<PayPalVault, 'fetchFor'> | undefined,
  account: PayPalAccountRow,
): Promise<PayPalApi | null> {
  if (!vault) return null;
  return new PayPalApi(account.mode, account.client_id, null, vault.fetchFor(account.channel_id));
}

const PAYPAL_SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

/**
 * How far a delivery's transmission time may be from now. PayPal retries a delivery for up to
 * three days; a day more allows for clocks and queues. Owner/provider check: tighten once
 * PayPal's retry behaviour is known (S04-P3-V-paypal-edge-and-provider-limits).
 */
export const PAYPAL_TRANSMISSION_TOLERANCE_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * Signature checks a Channel's webhook may ask PayPal for per minute. Each check spends the
 * tenant's PayPal credentials, and anyone can post to the route, so past this the route answers
 * 503 without calling PayPal and PayPal's retry delivers a genuine event later.
 */
export const PAYPAL_VERIFICATIONS_PER_MINUTE = 30;

/**
 * Free checks of a delivery before anything is sent to PayPal: the signature headers PayPal
 * always sends, in the shape it sends them, a transmission time near now, and a certificate on a
 * PayPal host. Null when it may be genuine, else why not.
 */
export function payPalDeliveryProblem(
  headers: { get(name: string): string | null | undefined },
  now: number,
): string | null {
  const field = (name: string) => (headers.get(name) ?? '').trim();
  if (PAYPAL_SIGNATURE_HEADERS.some((name) => !field(name) || field(name).length > 2048)) {
    return 'missing_headers';
  }
  if (!/^[A-Za-z0-9]{1,40}$/.test(field('paypal-auth-algo'))) return 'bad_algo';
  let cert: URL;
  try {
    cert = new URL(field('paypal-cert-url'));
  } catch {
    return 'bad_cert_url';
  }
  const host = cert.hostname.toLowerCase();
  if (cert.protocol !== 'https:' || !(host === 'paypal.com' || host.endsWith('.paypal.com'))) {
    return 'bad_cert_url';
  }
  const sent = Date.parse(field('paypal-transmission-time'));
  if (!Number.isFinite(sent) || Math.abs(now - sent) > PAYPAL_TRANSMISSION_TOLERANCE_MS) {
    return 'stale';
  }
  return null;
}

/** Takes one of the Channel's signature checks for this minute; false when they are used up. */
export async function admitPayPalVerification(
  db: D1Database,
  channelId: string,
  now: number,
): Promise<boolean> {
  const take = await takeUsage(db, {
    scope: `paypal_verify:${channelId}`,
    windowMs: 60_000,
    limit: PAYPAL_VERIFICATIONS_PER_MINUTE,
    now,
  });
  return take.ok;
}

export type PayPalVerification = 'verified' | 'refused' | 'unavailable';

/**
 * Asks PayPal whether a delivery is genuine. The body goes back exactly as it arrived, spliced in as
 * raw text, because PayPal's check fails on an event that was parsed and written out again.
 * 'refused' only when PayPal says the signature is wrong (or a header is missing); a PayPal that
 * can't be reached, throttles or times out is 'unavailable', so a genuine delivery is answered as
 * temporary and PayPal sends it again rather than being refused as forged.
 */
export async function verifyPayPalWebhook(
  api: PayPalApi,
  webhookId: string,
  headers: { get(name: string): string | null | undefined },
  rawBody: string,
): Promise<PayPalVerification> {
  const field = (name: string) => headers.get(name) ?? '';
  if (PAYPAL_SIGNATURE_HEADERS.some((name) => !field(name))) return 'refused';
  const start = JSON.stringify({
    auth_algo: field('paypal-auth-algo'),
    cert_url: field('paypal-cert-url'),
    transmission_id: field('paypal-transmission-id'),
    transmission_sig: field('paypal-transmission-sig'),
    transmission_time: field('paypal-transmission-time'),
    webhook_id: webhookId,
  });
  try {
    const answer = await api.request<{ verification_status?: unknown }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      `${start.slice(0, -1)},"webhook_event":${rawBody}}`,
    );
    return answer.verification_status === 'SUCCESS' ? 'verified' : 'refused';
  } catch {
    return 'unavailable';
  }
}

/** Can this price be sold through PayPal? Trials and chosen amounts stay on Stripe. */
export const payPalSellable = (
  price: { interval: string; customAmount: boolean; currency: string },
  trialDays: number,
) =>
  (price.interval === 'month' || price.interval === 'year') &&
  !price.customAmount &&
  trialDays === 0 &&
  isPayPalCurrency(price.currency);

interface PlanPrice {
  id: string;
  channel_id: string;
  interval: string;
  currency: string;
  amount: number;
  paypal_plan_id: string | null;
  level_name: string;
}

async function ensurePlan(db: D1Database, api: PayPalApi, price: PlanPrice): Promise<string> {
  if (price.paypal_plan_id) return price.paypal_plan_id;
  const product = await api.request<{ id: string }>(
    'POST',
    '/v1/catalogs/products',
    { name: price.level_name.slice(0, 127), type: 'SERVICE', category: 'SOFTWARE' },
    `product-${price.id}`,
  );
  const plan = await api.request<{ id: string }>(
    'POST',
    '/v1/billing/plans',
    {
      product_id: product.id,
      name: price.level_name.slice(0, 127),
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {
            interval_unit: price.interval === 'year' ? 'YEAR' : 'MONTH',
            interval_count: 1,
          },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: toValue(price.amount, price.currency),
              currency_code: price.currency.toUpperCase(),
            },
          },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
    `plan-${price.id}`,
  );
  await run(db, 'UPDATE level_prices SET paypal_plan_id = ?1 WHERE id = ?2', plan.id, price.id);
  return plan.id;
}

/** Writes the checkout row, makes the subscription and returns where to send the reader. */
export async function startPayPalSubscription(
  db: D1Database,
  api: PayPalApi,
  input: {
    channelId: string;
    levelId: string;
    priceId: string;
    memberId: string | null;
    email: string | null;
    reference: string;
    returnUrl: string;
    cancelUrl: string;
    now: number;
  },
): Promise<string> {
  const price = await first<PlanPrice>(
    db,
    `SELECT p.id, p.channel_id, p.interval, p.currency, p.amount, p.paypal_plan_id, l.name AS level_name
       FROM level_prices p JOIN membership_levels l ON l.id = p.level_id
      WHERE p.id = ?1 AND p.channel_id = ?2 AND p.level_id = ?3 AND p.status = 'active'`,
    input.priceId,
    input.channelId,
    input.levelId,
  );
  if (!price) throw new PayPalError('This price is not available.', 404);
  const planId = await ensurePlan(db, api, price);
  // The row first: the webhook only ever trusts what it says.
  await run(
    db,
    `INSERT INTO checkout_sessions (reference, channel_id, level_id, price_id, member_id, email, intent, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'subscribe', 'open', ?7)`,
    input.reference,
    input.channelId,
    input.levelId,
    input.priceId,
    input.memberId,
    input.email,
    input.now,
  );
  const created = await api.request<{ id?: unknown; links?: { rel?: unknown; href?: unknown }[] }>(
    'POST',
    '/v1/billing/subscriptions',
    {
      plan_id: planId,
      custom_id: input.reference,
      ...(input.email ? { subscriber: { email_address: input.email } } : {}),
      application_context: {
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    },
    `subscribe-${input.reference}`,
  );
  const href = created.links?.find((link) => link.rel === 'approve')?.href;
  if (typeof href !== 'string' || !isPayPalApprovalUrl(href)) {
    throw new PayPalError('PayPal didn’t send a page to approve the subscription.', 502);
  }
  // The row remembers PayPal's subscription id (in subject_id, which a subscribe checkout
  // otherwise leaves empty), so a missed activation can be found again by reconcilePayPal.
  const subscriptionId = text((created as { id?: unknown }).id);
  if (subscriptionId && PAYPAL_SUBSCRIPTION_ID.test(subscriptionId)) {
    await run(
      db,
      `UPDATE checkout_sessions SET subject_id = ?1
        WHERE reference = ?2 AND channel_id = ?3 AND intent = 'subscribe' AND subject_id IS NULL`,
      subscriptionId,
      input.reference,
      input.channelId,
    );
  }
  return href;
}

const PAYPAL_SUBSCRIPTION_ID = /^I-[A-Z0-9]{1,40}$/;

/** Readers are only ever redirected to PayPal itself. */
const isPayPalApprovalUrl = (href: string) => {
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'www.paypal.com' || url.hostname === 'www.sandbox.paypal.com')
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// Webhook events

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}

export interface PayPalContext {
  db: D1Database;
  api: PayPalApi;
  account: PayPalAccountRow;
  now: number;
  /** The vault's erasure markers, to recognise erased addresses (privacy.ts addressMarkers). */
  fieldKeys: PrivacyKeys;
  /** Lets payment notices go out; without it the events still change access. */
  notices?: Pick<PaymentsContext, 'links' | 'memberLinks' | 'mail'>;
}

interface PayPalSubscriptionRow {
  id: string;
  channel_id: string;
  member_id: string;
  status: string;
  current_period_end: number | null;
  revoked_at: number | null;
  paypal_subscription_id: string;
  level_id: string | null;
  grace_until: number | null;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const timeOf = (value: unknown) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const nextBilling = (resource: Record<string, unknown>) =>
  timeOf((resource.billing_info as { next_billing_time?: unknown } | undefined)?.next_billing_time);

const notify = (ctx: PayPalContext, input: Parameters<typeof sendPaymentNotice>[1]) =>
  ctx.notices
    ? sendPaymentNotice({ db: ctx.db, now: ctx.now, ...ctx.notices }, input)
    : Promise.resolve();

const subscriptionRow = (ctx: PayPalContext, paypalId: string) =>
  first<PayPalSubscriptionRow>(
    ctx.db,
    `SELECT id, channel_id, member_id, status, current_period_end, revoked_at, paypal_subscription_id,
            level_id, grace_until
       FROM member_subscriptions WHERE paypal_subscription_id = ?1 AND channel_id = ?2`,
    paypalId,
    ctx.account.channel_id,
  );

const scopeOf = (ctx: PayPalContext): LedgerScope => ({
  ctx: { db: ctx.db, now: ctx.now, fieldKeys: ctx.fieldKeys },
  channelId: ctx.account.channel_id,
  workspaceId: ctx.account.workspace_id,
});

async function onActivated(ctx: PayPalContext, resource: Record<string, unknown>) {
  const paypalId = text(resource.id);
  if (!paypalId) return 'ignored' as const;
  const scope = scopeOf(ctx);
  const known = await subscriptionRow(ctx, paypalId);
  if (known) {
    await run(
      ctx.db,
      `UPDATE member_subscriptions SET status = 'active', grace_until = NULL, cancel_at = NULL,
              cancel_at_period_end = 0, canceled_at = NULL,
              current_period_end = coalesce(?1, current_period_end), updated_at = ?2
        WHERE id = ?3 AND revoked_at IS NULL`,
      nextBilling(resource),
      ctx.now,
      known.id,
    );
    await recompute(scope, known.member_id);
    return 'processed' as const;
  }
  const reference = text(resource.custom_id);
  if (!reference) return 'ignored' as const;
  const row = await first<
    BuyerRow & { price_id: string | null; level_id: string | null; status: string }
  >(
    ctx.db,
    `SELECT reference, member_id, email, level_id, price_id, status FROM checkout_sessions
      WHERE reference = ?1 AND channel_id = ?2 AND intent = 'subscribe'`,
    reference,
    ctx.account.channel_id,
  );
  if (!row || row.status === 'complete' || !row.price_id) return 'ignored' as const;
  const price = await first<{
    interval: string;
    currency: string;
    amount: number;
    paypal_plan_id: string | null;
  }>(
    ctx.db,
    'SELECT interval, currency, amount, paypal_plan_id FROM level_prices WHERE id = ?1 AND channel_id = ?2',
    row.price_id,
    ctx.account.channel_id,
  );
  // Access follows the plan Swarm chose, so a subscription on another plan grants nothing.
  if (!price?.paypal_plan_id || resource.plan_id !== price.paypal_plan_id)
    return 'ignored' as const;
  const subscriber = resource.subscriber as { email_address?: unknown } | undefined;
  const email = text(subscriber?.email_address)?.toLowerCase() ?? row.email;
  const memberId = await resolveBuyer(scope, row, email, true);
  if (!memberId) return 'ignored' as const;
  await run(
    ctx.db,
    `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, price_id, source, status,
            paypal_subscription_id, interval, currency, amount, current_period_end, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'stripe', 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    newIdFor('memberSubscription', ctx.now),
    ctx.account.channel_id,
    memberId,
    row.level_id,
    row.price_id,
    paypalId,
    price.interval,
    price.currency.toLowerCase(),
    price.amount,
    nextBilling(resource),
    ctx.now,
  );
  await run(
    ctx.db,
    `UPDATE checkout_sessions SET status = 'complete', completed_at = ?1, member_id = coalesce(member_id, ?2)
      WHERE reference = ?3 AND channel_id = ?4`,
    ctx.now,
    memberId,
    reference,
    ctx.account.channel_id,
  );
  await recompute(scope, memberId);
  // A pending buyer (PayPal's address or a typed one proves nothing) confirms before reading.
  if (ctx.notices) {
    await askBuyerToConfirm({ db: ctx.db, now: ctx.now, ...ctx.notices }, memberId);
  }
  return 'processed' as const;
}

/** Billing has stopped. Access lasts for what was paid: the lifecycle job ends it after that. */
export async function markPayPalCanceled(
  ctx: Pick<PayPalContext, 'db' | 'now' | 'account'>,
  row: PayPalSubscriptionRow,
): Promise<void> {
  const end = row.current_period_end;
  const over = end === null || end <= ctx.now;
  await run(
    ctx.db,
    `UPDATE member_subscriptions SET cancel_at_period_end = 1, cancel_at = ?1, canceled_at = ?2, updated_at = ?2,
            status = CASE WHEN ?3 THEN 'canceled' ELSE status END,
            revoked_at = CASE WHEN ?3 AND revoked_at IS NULL THEN ?2 ELSE revoked_at END,
            revoke_reason = CASE WHEN ?3 AND revoked_at IS NULL THEN 'canceled' ELSE revoke_reason END
      WHERE id = ?4 AND channel_id = ?5`,
    end,
    ctx.now,
    over ? 1 : 0,
    row.id,
    ctx.account.channel_id,
  );
}

async function endNow(ctx: PayPalContext, row: PayPalSubscriptionRow) {
  await run(
    ctx.db,
    `UPDATE member_subscriptions SET status = 'canceled', canceled_at = coalesce(canceled_at, ?1), updated_at = ?1,
            revoke_reason = CASE WHEN revoked_at IS NULL THEN 'canceled' ELSE revoke_reason END,
            revoked_at = coalesce(revoked_at, ?1)
      WHERE id = ?2 AND channel_id = ?3`,
    ctx.now,
    row.id,
    ctx.account.channel_id,
  );
}

async function startGrace(ctx: PayPalContext, row: PayPalSubscriptionRow) {
  await run(
    ctx.db,
    `UPDATE member_subscriptions SET status = 'past_due', grace_until = coalesce(grace_until, ?1), updated_at = ?2
      WHERE id = ?3 AND channel_id = ?4 AND status <> 'canceled'`,
    ctx.now + GRACE_DAYS * DAY_MS,
    ctx.now,
    row.id,
    ctx.account.channel_id,
  );
}

async function onSale(ctx: PayPalContext, resource: Record<string, unknown>) {
  const saleId = text(resource.id);
  const agreement = text(resource.billing_agreement_id);
  if (!saleId || !agreement) return 'ignored' as const;
  const row = await subscriptionRow(ctx, agreement);
  // The payment can arrive before the activation. Failing makes PayPal deliver it again.
  if (!row) throw new PayPalError('The subscription for this payment isn’t here yet.', 409);
  const amount = resource.amount as { total?: unknown; currency?: unknown } | undefined;
  const currency = text(amount?.currency);
  const minor = currency ? toMinor(amount?.total, currency) : null;
  if (currency && minor !== null && minor > 0) {
    await recordPayment(scopeOf(ctx), {
      memberId: row.member_id,
      subscriptionId: row.id,
      kind: 'invoice',
      stripeObjectId: `paypal:${saleId}`,
      currency,
      amount: minor,
      occurredAt: timeOf(resource.create_time) ?? ctx.now,
    });
  }
  let next: number | null = null;
  try {
    next = nextBilling(
      await ctx.api.request('GET', `/v1/billing/subscriptions/${encodeURIComponent(agreement)}`),
    );
  } catch {
    // The payment stands. The period moves on with the next event that names it.
  }
  await run(
    ctx.db,
    `UPDATE member_subscriptions SET grace_until = NULL,
            status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END,
            current_period_end = coalesce(?1, current_period_end), updated_at = ?2
      WHERE id = ?3 AND channel_id = ?4 AND status <> 'canceled'`,
    next,
    ctx.now,
    row.id,
    ctx.account.channel_id,
  );
  await recompute(scopeOf(ctx), row.member_id);
  if (currency && minor !== null && minor > 0) {
    await notify(ctx, {
      key: 'payment_receipt',
      channelId: row.channel_id,
      memberId: row.member_id,
      levelId: row.level_id,
      amount: formatAmount(minor, currency),
      dedupe: `paypal:${saleId}`,
    });
  }
  return 'processed' as const;
}

/** Minor units as this module keeps them (toMinor), so a yen total of 500 reads ¥500. */
const formatAmount = (minor: number, currency: string) => {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
  } catch {
    // PayPal named a currency Intl can't format. The receipt must not stop the event.
    return `${value.toFixed(2)} ${currency}`;
  }
};

/** A full refund (in one go or adding up), or a reversal, ends access at once and stops charging. */
async function onMoneyBack(
  ctx: PayPalContext,
  resource: Record<string, unknown>,
  reason: 'refund' | 'dispute',
) {
  const backId = text(resource.id);
  const saleId = text(resource.sale_id) ?? backId;
  if (!backId || !saleId) return 'ignored' as const;
  const paid = await first<{
    subscription_id: string | null;
    member_id: string | null;
    amount: number;
  }>(
    ctx.db,
    'SELECT subscription_id, member_id, amount FROM payments WHERE stripe_object_id = ?1 AND channel_id = ?2',
    `paypal:${saleId}`,
    ctx.account.channel_id,
  );
  if (!paid) return 'ignored' as const;
  const amount = resource.amount as { total?: unknown; currency?: unknown } | undefined;
  const currency = text(amount?.currency);
  const minor = currency ? (toMinor(amount?.total, currency) ?? 0) : 0;
  // Refunds are keyed under their sale so that several partial ones can be added up. Rows written
  // before that carry `paypal:<refund id>:refund`; one of those means this refund is recorded.
  const refundsOf = `paypal:${saleId}:refund:`;
  const recorded =
    reason === 'refund' &&
    (await first<{ id: string }>(
      ctx.db,
      'SELECT id FROM payments WHERE stripe_object_id = ?1 AND channel_id = ?2',
      `paypal:${backId}:refund`,
      ctx.account.channel_id,
    ));
  if (!recorded) {
    await recordPayment(scopeOf(ctx), {
      memberId: paid.member_id,
      subscriptionId: paid.subscription_id,
      kind: 'refund',
      stripeObjectId: reason === 'refund' ? `${refundsOf}${backId}` : `paypal:${backId}:${reason}`,
      currency,
      amount: -Math.abs(minor),
      occurredAt: timeOf(resource.create_time) ?? ctx.now,
    });
  }
  const refunded = await first<{ total: number | null }>(
    ctx.db,
    `SELECT sum(amount) AS total FROM payments
      WHERE channel_id = ?1 AND kind = 'refund' AND substr(stripe_object_id, 1, length(?2)) = ?2`,
    ctx.account.channel_id,
    refundsOf,
  );
  const whole =
    reason === 'dispute' ||
    Math.abs(minor) >= paid.amount ||
    -(refunded?.total ?? 0) >= paid.amount;
  if (!whole || !paid.subscription_id) return 'processed' as const;
  const row = await first<PayPalSubscriptionRow>(
    ctx.db,
    `SELECT id, channel_id, member_id, status, current_period_end, revoked_at, paypal_subscription_id
       FROM member_subscriptions WHERE id = ?1 AND channel_id = ?2 AND paypal_subscription_id IS NOT NULL`,
    paid.subscription_id,
    ctx.account.channel_id,
  );
  if (!row || row.revoked_at !== null) return 'processed' as const;
  await run(
    ctx.db,
    `UPDATE member_subscriptions SET revoked_at = ?1, revoke_reason = ?2, grace_until = NULL, updated_at = ?1
      WHERE id = ?3 AND channel_id = ?4 AND revoked_at IS NULL`,
    ctx.now,
    reason,
    row.id,
    ctx.account.channel_id,
  );
  if (row.status !== 'canceled') {
    try {
      await ctx.api.request(
        'POST',
        `/v1/billing/subscriptions/${encodeURIComponent(row.paypal_subscription_id)}/cancel`,
        { reason: 'Refunded' },
      );
    } catch {
      // The revocation stands either way; the Owner can also cancel it in PayPal.
    }
  }
  await appendAudit(ctx.db, {
    workspaceId: ctx.account.workspace_id,
    actorId: null,
    action: 'member_subscription.revoked',
    targetType: 'member_subscription',
    targetId: row.id,
    metadata: { reason, memberId: row.member_id, paypal: true },
  });
  await recompute(scopeOf(ctx), row.member_id);
  return 'processed' as const;
}

async function dispatch(ctx: PayPalContext, event: PayPalEvent) {
  const { resource } = event;
  switch (event.event_type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
      return onActivated(ctx, resource);
    case 'PAYMENT.SALE.COMPLETED':
      return onSale(ctx, resource);
    case 'PAYMENT.SALE.REFUNDED':
      return onMoneyBack(ctx, resource, 'refund');
    case 'PAYMENT.SALE.REVERSED':
      return onMoneyBack(ctx, resource, 'dispute');
  }
  const paypalId = text(resource.id);
  const row = paypalId ? await subscriptionRow(ctx, paypalId) : null;
  if (!row) return 'ignored' as const;
  switch (event.event_type) {
    case 'BILLING.SUBSCRIPTION.CANCELLED':
      await markPayPalCanceled(ctx, row);
      break;
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      await endNow(ctx, row);
      await notify(ctx, {
        key: 'subscription_cancelled',
        channelId: row.channel_id,
        memberId: row.member_id,
        levelId: row.level_id,
        dedupe: row.id,
      });
      break;
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
      await startGrace(ctx, row);
      if (row.grace_until === null) {
        await notify(ctx, {
          key: 'payment_failed',
          channelId: row.channel_id,
          memberId: row.member_id,
          levelId: row.level_id,
          dedupe: `${row.id}:${ctx.now - (ctx.now % 86_400_000)}`,
        });
      }
      break;
    default:
      return 'ignored' as const;
  }
  await recompute(scopeOf(ctx), row.member_id);
  return 'processed' as const;
}

/** A claim left in 'received' this long is taken to have died mid-way, as with Stripe. */
export const PAYPAL_STUCK_EVENT_MS = 5 * 60 * 1000;

/**
 * Each event once per Channel. One that fails is recorded and thrown, so PayPal delivers it again;
 * so is one whose run died after claiming it (still 'received' after PAYPAL_STUCK_EVENT_MS). The
 * claim is keyed by the Channel whose webhook verified the event, so a delivery to another
 * Channel, even one sharing the same PayPal app, neither consumes nor blocks this one's.
 */
export async function handlePayPalEvent(
  ctx: PayPalContext,
  event: PayPalEvent,
): Promise<'processed' | 'ignored' | 'duplicate'> {
  const channelId = ctx.account.channel_id;
  const claimed = await first(
    ctx.db,
    `INSERT INTO paypal_events (event_id, channel_id, type, status, received_at)
     VALUES (?1, ?2, ?3, 'received', ?4)
     ON CONFLICT (channel_id, event_id) DO UPDATE SET status = 'received', error = NULL,
                                           received_at = excluded.received_at
       WHERE paypal_events.status = 'failed'
          OR (paypal_events.status = 'received' AND paypal_events.received_at < ?5)
     RETURNING event_id`,
    event.id,
    channelId,
    event.event_type,
    ctx.now,
    ctx.now - PAYPAL_STUCK_EVENT_MS,
  );
  if (!claimed) return 'duplicate';
  try {
    const outcome = await dispatch(ctx, event);
    await run(
      ctx.db,
      `UPDATE paypal_events SET status = ?1, processed_at = ?2 WHERE event_id = ?3 AND channel_id = ?4`,
      outcome,
      ctx.now,
      event.id,
      channelId,
    );
    return outcome;
  } catch (error) {
    // If even this write fails, the claim stays 'received' and becomes reclaimable once stale.
    await run(
      ctx.db,
      `UPDATE paypal_events SET status = 'failed', error = ?1 WHERE event_id = ?2 AND channel_id = ?3`,
      (error instanceof Error ? error.message : String(error)).slice(0, 500),
      event.id,
      channelId,
    ).catch(() => undefined);
    throw error;
  }
}

/** A reader cancels from the Member Center. They keep what they paid for. */
export async function cancelPayPalSubscription(
  db: D1Database,
  vault: Pick<PayPalVault, 'fetchFor'> | undefined,
  input: { channelId: string; subscriptionId: string; now: number },
): Promise<void> {
  const account = await readPayPalAccount(db, input.channelId);
  const api = account ? await payPalClient(vault, account) : null;
  const row = await first<PayPalSubscriptionRow>(
    db,
    `SELECT id, channel_id, member_id, status, current_period_end, revoked_at, paypal_subscription_id
       FROM member_subscriptions WHERE id = ?1 AND channel_id = ?2 AND paypal_subscription_id IS NOT NULL`,
    input.subscriptionId,
    input.channelId,
  );
  if (!account || !api || !row) throw new PayPalError('PayPal isn’t available here.', 503);
  await api.request(
    'POST',
    `/v1/billing/subscriptions/${encodeURIComponent(row.paypal_subscription_id)}/cancel`,
    { reason: 'Canceled by the subscriber' },
  );
  await markPayPalCanceled({ db, now: input.now, account }, row);
}

// ---- Reconciliation ---------------------------------------------------------------------------

/** Subscriptions and missed checkouts each Channel's PayPal is asked about per lifecycle run. */
export const PAYPAL_RECONCILE_READS_PER_CHANNEL = 4;
/** Channels with PayPal looked at per run; the rest wait for the next one. */
const PAYPAL_RECONCILE_CHANNELS_PER_RUN = 25;
/** A checkout PayPal hasn't told Swarm about is looked for after this long, for this long. */
const MISSED_ACTIVATION_AFTER_MS = 10 * 60 * 1000;
const MISSED_ACTIVATION_WINDOW_MS = 3 * DAY_MS;

const RECONCILED_EVENT: Record<string, string> = {
  ACTIVE: 'BILLING.SUBSCRIPTION.ACTIVATED',
  CANCELLED: 'BILLING.SUBSCRIPTION.CANCELLED',
  EXPIRED: 'BILLING.SUBSCRIPTION.EXPIRED',
  SUSPENDED: 'BILLING.SUBSCRIPTION.SUSPENDED',
};

export interface PayPalReconcileResult {
  channels: number;
  reads: number;
  applied: number;
  /** Claims left unfinished past the stuck window, for operators (paypal_events). */
  unfinished: number;
}

/**
 * Access must not depend on every PayPal webhook arriving and finishing. Each run (a random
 * sample of Channels) asks PayPal, within PAYPAL_RECONCILE_READS_PER_CHANNEL reads per Channel,
 * about (1) recent checkouts that PayPal never reported as activated, and (2) a random share of
 * the subscriptions Swarm thinks are running. What PayPal
 * says goes through handlePayPalEvent as a synthetic event (`RECONCILE-<id>-<status>`), so it is
 * applied once, by the same rules as the webhook, and recorded in paypal_events. A missed
 * activation grants access late rather than never; a missed cancellation, expiry or suspension
 * ends or suspends it. A known subscription PayPal reports active is left alone: only ends are
 * taken from a read. Never run against PayPal itself (docs/deployment.md); the state names are
 * PayPal's documented ones.
 */
export async function reconcilePayPal(
  db: D1Database,
  vault: PayPalVault | undefined,
  now: number,
): Promise<PayPalReconcileResult> {
  const result: PayPalReconcileResult = { channels: 0, reads: 0, applied: 0, unfinished: 0 };
  const unfinished = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM paypal_events
      WHERE status = 'failed' OR (status = 'received' AND received_at < ?1)`,
    now - PAYPAL_STUCK_EVENT_MS,
  );
  result.unfinished = unfinished?.n ?? 0;
  // A random sample each run, so every Channel and subscription comes round without a cursor.
  const accounts = await all<PayPalAccountRow>(
    db,
    'SELECT * FROM paypal_accounts ORDER BY random() LIMIT ?1',
    PAYPAL_RECONCILE_CHANNELS_PER_RUN,
  );
  for (const account of accounts) {
    const api = await payPalClient(vault, account).catch(() => null);
    if (!api || !vault) continue;
    result.channels++;
    let reads = 0;
    const ctx: PayPalContext = { db, api, account, now, fieldKeys: vault.markers };
    /** Reads one subscription and applies what PayPal says, once; `endsOnly` ignores ACTIVE. */
    const reconcile = async (paypalId: string, endsOnly: boolean) => {
      if (reads >= PAYPAL_RECONCILE_READS_PER_CHANNEL) return;
      reads++;
      result.reads++;
      let resource: Record<string, unknown>;
      try {
        resource = await api.request<Record<string, unknown>>(
          'GET',
          `/v1/billing/subscriptions/${encodeURIComponent(paypalId)}`,
        );
      } catch {
        return;
      }
      const status = text(resource.status)?.toUpperCase() ?? '';
      const type = RECONCILED_EVENT[status];
      if (!type || text(resource.id) !== paypalId || (endsOnly && status === 'ACTIVE')) return;
      const outcome = await handlePayPalEvent(ctx, {
        id: `RECONCILE-${paypalId}-${status}`,
        event_type: type,
        resource,
      }).catch(() => 'failed' as const);
      if (outcome === 'processed') result.applied++;
    };
    // (1) Checkouts PayPal never reported as activated.
    const missed = await all<{ subject_id: string }>(
      db,
      `SELECT subject_id FROM checkout_sessions
        WHERE channel_id = ?1 AND intent = 'subscribe' AND status = 'open'
          AND subject_id LIKE 'I-%' AND created_at BETWEEN ?2 AND ?3
        ORDER BY created_at LIMIT ?4`,
      account.channel_id,
      now - MISSED_ACTIVATION_WINDOW_MS,
      now - MISSED_ACTIVATION_AFTER_MS,
      PAYPAL_RECONCILE_READS_PER_CHANNEL,
    );
    for (const row of missed) await reconcile(row.subject_id, false);
    // (2) A rotating share of the subscriptions Swarm thinks are still running: only an end is
    // taken from these reads.
    const known = await all<{ paypal_subscription_id: string }>(
      db,
      `SELECT paypal_subscription_id FROM member_subscriptions
        WHERE channel_id = ?1 AND paypal_subscription_id IS NOT NULL AND revoked_at IS NULL
          AND status <> 'canceled' AND cancel_at IS NULL
        ORDER BY random() LIMIT ?2`,
      account.channel_id,
      PAYPAL_RECONCILE_READS_PER_CHANNEL,
    );
    for (const row of known) await reconcile(row.paypal_subscription_id, true);
  }
  return result;
}
