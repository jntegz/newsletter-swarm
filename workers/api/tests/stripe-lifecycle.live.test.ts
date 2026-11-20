// The Stripe test-clock lifecycle suite (Phase 5 exit gate). It runs against a real Stripe account
// in test mode, never in `pnpm test`: see vitest.stripe-live.config.ts for the variables and
// docs/deployment.md ("Stripe lifecycle suite") for setting the account up.
//
// Every scenario uses its own test clock on the connected account. The suite acts on Stripe the way
// a reader or Stripe's billing would (subscriptions, card changes, clock advances, refunds), then
// fetches the resulting events from the account's event log, adds `account` as a Connect delivery
// does, signs them with the endpoint secret and posts them to our webhook, in the order they
// happened. It asserts D1 (member_subscriptions, payments, gift_passes) and the entitlement.
//
// Our side runs on the real clock while Stripe's runs on the test clock, so time-based steps of
// ours (the grace downgrade, scheduled price promotion, Gift Pass expiry) are driven by calling
// the payments cron with the time they're due.
import { SELF, env } from 'cloudflare:test';
import { newId, type MembershipLevel } from '@swarm/domain';
import {
  HANDLED_STRIPE_EVENTS,
  HttpStripe,
  entitledLevel,
  newCheckoutReference,
  runPaymentsLifecycle,
  signCheckoutReference,
  signStripePayload,
  type StripeParams,
} from '@swarm/engine';
import { DevMailbox } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, signIn, uniqueEmail, type Session } from './helpers';
import { addMember, data } from './money-helpers';
import { testLinks } from './links';

const ENABLED = env.LIVE_STRIPE_ENABLED === '1';
const DAY = 86_400_000;
const SECRET = `whsec_${'l'.repeat(32)}`;
const HANDLED = new Set<string>(HANDLED_STRIPE_EVENTS);
const POLL_MS = 2_000;
const WAIT_MS = 4 * 60_000;

type Obj = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => Math.floor(ms / 1000);

let stripe: HttpStripe;
let account: string;
let owner: Session;
let channelId: string;
let level: MembershipLevel;

/** The level's monthly price now (a scheduled change replaces it during the suite). */
async function monthlyPrice(): Promise<{ id: string; stripe_price_id: string }> {
  const price = await env.DB.prepare(
    `SELECT id, stripe_price_id FROM level_prices
      WHERE level_id = ?1 AND interval = 'month' AND status = 'active'`,
  )
    .bind(level.id)
    .first<{ id: string; stripe_price_id: string }>();
  if (!price?.stripe_price_id) throw new Error('the level has no monthly Stripe Price');
  return price;
}

/** A call on the connected account. */
function api<T = Obj>(method: 'GET' | 'POST' | 'DELETE', path: string, params: StripeParams = {}) {
  return stripe.request<T>(method, path, params, { account });
}

// ---------------------------------------------------------------------------------------------
// Test clocks

async function newClock(name: string, frozenTime = Date.now()): Promise<Obj & { id: string }> {
  return api('POST', '/v1/test_helpers/test_clocks', {
    frozen_time: seconds(frozenTime),
    name: `swarm lifecycle: ${name}`,
  });
}

/** Advances the clock and waits until Stripe has run everything due (status 'ready'). */
async function advance(clockId: string, to: number): Promise<void> {
  await api('POST', `/v1/test_helpers/test_clocks/${clockId}/advance`, {
    frozen_time: seconds(to),
  });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const clock = await api<{ status: string }>('GET', `/v1/test_helpers/test_clocks/${clockId}`);
    if (clock.status === 'ready') return;
    if (clock.status === 'internal_failure') throw new Error(`test clock ${clockId} failed`);
    if (Date.now() > deadline) throw new Error(`test clock ${clockId} still ${clock.status}`);
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// Readers on Stripe

interface Reader {
  clockId: string;
  customerId: string;
  memberId: string;
  email: string;
  since: number;
}

/** A card on the customer, made its default for invoices. pm_card_chargeCustomerFail declines. */
async function useCard(customerId: string, card: 'pm_card_visa' | 'pm_card_chargeCustomerFail') {
  const pm = await api<{ id: string }>('POST', `/v1/payment_methods/${card}/attach`, {
    customer: customerId,
  });
  await api('POST', `/v1/customers/${customerId}`, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

/** A Member on our side and a customer on a fresh test clock, linked as checkout would link them. */
async function reader(name: string): Promise<Reader> {
  const since = Date.now();
  const clock = await newClock(name);
  const email = uniqueEmail(name);
  const member = await addMember(owner, channelId, email);
  const customer = await api<{ id: string }>('POST', '/v1/customers', {
    email,
    test_clock: clock.id,
  });
  await useCard(customer.id, 'pm_card_visa');
  await env.DB.prepare(
    `INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(member.id, channelId, customer.id, Date.now())
    .run();
  return { clockId: clock.id, customerId: customer.id, memberId: member.id, email, since };
}

async function subscribeOnStripe(
  r: Reader,
  options: { trialDays?: number; stripePriceId?: string; coupon?: string } = {},
): Promise<string> {
  const sub = await api<{ id: string }>('POST', '/v1/subscriptions', {
    customer: r.customerId,
    items: [{ price: options.stripePriceId ?? (await monthlyPrice()).stripe_price_id }],
    ...(options.trialDays ? { trial_period_days: options.trialDays } : {}),
    ...(options.coupon ? { discounts: [{ coupon: options.coupon }] } : {}),
  });
  return sub.id;
}

// ---------------------------------------------------------------------------------------------
// Delivering Stripe's events to our webhook

const delivered = new Set<string>();

function belongsTo(event: Obj, customerId: string): boolean {
  const object = (event.data as { object?: Obj } | undefined)?.object;
  if (!object) return false;
  const customer = object.customer;
  const id = typeof customer === 'string' ? customer : (customer as Obj | null)?.id;
  return id === customerId || object.id === customerId;
}

async function post(event: Obj): Promise<string> {
  // A Connect delivery names the account; an event read through Stripe-Account doesn't.
  const payload = JSON.stringify({ ...event, account });
  const res = await SELF.fetch('http://localhost/api/v1/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': await signStripePayload(payload, SECRET),
    },
    body: payload,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { data: { outcome: string } }).data.outcome;
}

/**
 * Delivers the reader's new events, oldest first, until one of `type` (matching `match`) has
 * been delivered. Returns that event's object.
 */
async function deliverUntil(
  r: Reader,
  type: string,
  match: (object: Obj) => boolean = () => true,
): Promise<Obj> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const events: Obj[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await api<{ data: Obj[]; has_more: boolean }>('GET', '/v1/events', {
        created: { gte: seconds(r.since) - 5 },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      events.push(...page.data);
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data.at(-1)?.id as string;
    }
    // The list is newest first.
    let found: Obj | null = null;
    for (const event of events.reverse()) {
      const id = event.id as string;
      if (
        delivered.has(id) ||
        !HANDLED.has(event.type as string) ||
        !belongsTo(event, r.customerId)
      ) {
        continue;
      }
      expect(event.livemode, 'a live-mode event reached the test-mode suite').toBe(false);
      delivered.add(id);
      await post(event);
      const object = (event.data as { object: Obj }).object;
      if (event.type === type && match(object)) found = object;
    }
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no ${type} event for ${r.customerId}`);
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// Our state

const subRow = (stripeSubscriptionId: string) =>
  env.DB.prepare('SELECT * FROM member_subscriptions WHERE stripe_subscription_id = ?1')
    .bind(stripeSubscriptionId)
    .first<Obj>();

const entitled = (memberId: string, at = Date.now()) =>
  entitledLevel(env.DB, channelId, memberId, at);

function mail() {
  return {
    adapter: new DevMailbox(env.DEV_MAILBOX),
    platformMailDomain: 'mail.swarm.localhost',
    site: { scheme: 'http' as const, platformDomain: 'site.localhost' },
    captureOrigin: 'http://localhost:8791',
  };
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(!ENABLED)('Stripe lifecycle on test clocks (live, test mode)', () => {
  beforeAll(async () => {
    const key = env.STRIPE_SECRET_KEY;
    // The config refuses a live key already; this is the second lock.
    if (!key?.startsWith('sk_test_')) throw new Error('refusing to run without a sk_test_ key');
    stripe = new HttpStripe(key, (input, init) => fetch(input, init));
    account = env.LIVE_STRIPE_ACCOUNT as string;
    const connected = await stripe.request<{ id: string; charges_enabled: boolean }>(
      'GET',
      `/v1/accounts/${account}`,
    );
    expect(connected.charges_enabled, `${account} can't take charges yet`).toBe(true);

    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled,
         default_currency, connected_at, updated_at) VALUES (?1, ?2, ?3, 1, 'usd', ?4, ?4)`,
    )
      .bind(channelId, owner.workspaceId, account, now)
      .run();
    // The level and its prices are made on Stripe by our levels route.
    level = await data<MembershipLevel>(
      await call('POST', `/api/v1/channels/${channelId}/levels`, {
        cookie: owner.cookie,
        body: {
          name: `Lifecycle ${now}`,
          benefits: ['Every Dispatch in full'],
          trialDays: 7,
          prices: [
            { interval: 'month', amount: 800 },
            { interval: 'year', amount: 8000 },
          ],
        },
      }),
      201,
    );
    expect((await monthlyPrice()).stripe_price_id).toMatch(/^price_/);
  });

  it('trial → paid → payment failed → grace → downgrade → recovery', async () => {
    const r = await reader('trial');
    const price = await monthlyPrice();
    const subId = await subscribeOnStripe(r, { trialDays: 7 });
    await deliverUntil(r, 'customer.subscription.created');
    expect(await subRow(subId)).toMatchObject({
      status: 'trialing',
      level_id: level.id,
      price_id: price.id,
      amount: 800,
    });
    expect(await entitled(r.memberId)).toBe(level.id);

    // The trial ends and the first invoice is paid.
    const clockStart = r.since;
    await advance(r.clockId, clockStart + 8 * DAY);
    await deliverUntil(r, 'invoice.paid', (invoice) => invoice.amount_paid === 800);
    expect(await subRow(subId)).toMatchObject({ status: 'active', grace_until: null });
    const paid = await env.DB.prepare(
      `SELECT amount FROM payments WHERE channel_id = ?1 AND member_id = ?2 AND kind = 'invoice'`,
    )
      .bind(channelId, r.memberId)
      .all<{ amount: number }>();
    expect(paid.results.map((p) => p.amount)).toEqual([800]);

    // The card starts declining; the renewal fails and grace starts.
    await useCard(r.customerId, 'pm_card_chargeCustomerFail');
    await advance(r.clockId, clockStart + 8 * DAY + 32 * DAY);
    const failed = await deliverUntil(r, 'invoice.payment_failed');
    await deliverUntil(r, 'customer.subscription.updated', (s) => s.status === 'past_due');
    const graced = await subRow(subId);
    expect(graced).toMatchObject({ status: 'past_due' });
    const graceUntil = graced!.grace_until as number;
    expect(graceUntil).toBeGreaterThan(Date.now());
    expect(await entitled(r.memberId)).toBe(level.id);

    // Grace runs out: the cron downgrades.
    await runPaymentsLifecycle(env.DB, stripe, graceUntil + 1000);
    expect(await entitled(r.memberId, graceUntil + 2000)).toBeUndefined();

    // The reader fixes the card and the open invoice is paid: access is back.
    const visa = await useCard(r.customerId, 'pm_card_visa');
    await api('POST', `/v1/invoices/${failed.id as string}/pay`, { payment_method: visa });
    await deliverUntil(r, 'invoice.paid', (invoice) => invoice.id === failed.id);
    expect(await subRow(subId)).toMatchObject({ status: 'active', grace_until: null });
    expect(await entitled(r.memberId)).toBe(level.id);

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
  });

  it('cancel at period end: access until the end, none after', async () => {
    const r = await reader('cancel');
    const subId = await subscribeOnStripe(r);
    await deliverUntil(r, 'invoice.paid');
    expect(await subRow(subId)).toMatchObject({ status: 'active' });

    await api('POST', `/v1/subscriptions/${subId}`, { cancel_at_period_end: true });
    await deliverUntil(r, 'customer.subscription.updated', (s) => s.cancel_at_period_end === true);
    expect(await subRow(subId)).toMatchObject({ status: 'active', cancel_at_period_end: 1 });
    expect(await entitled(r.memberId)).toBe(level.id);

    await advance(r.clockId, r.since + 32 * DAY);
    await deliverUntil(r, 'customer.subscription.deleted');
    expect(await subRow(subId)).toMatchObject({ status: 'canceled', revoke_reason: 'canceled' });
    expect(await entitled(r.memberId)).toBeUndefined();

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
  });

  it('a full refund revokes now, records the refund and stops billing', async () => {
    const r = await reader('refund');
    const subId = await subscribeOnStripe(r);
    await deliverUntil(r, 'invoice.paid');
    expect(await entitled(r.memberId)).toBe(level.id);

    const charges = await api<{ data: { id: string }[] }>('GET', '/v1/charges', {
      customer: r.customerId,
      limit: 1,
    });
    const chargeId = charges.data[0]?.id;
    expect(chargeId).toMatch(/^(ch|py)_/);
    await api('POST', '/v1/refunds', { charge: chargeId });
    await deliverUntil(r, 'charge.refunded');
    expect(await subRow(subId)).toMatchObject({ revoke_reason: 'refund' });
    expect(await entitled(r.memberId)).toBeUndefined();
    const refund = await env.DB.prepare(
      `SELECT amount FROM payments WHERE channel_id = ?1 AND member_id = ?2 AND kind = 'refund'`,
    )
      .bind(channelId, r.memberId)
      .first<{ amount: number }>();
    expect(refund?.amount).toBe(-800);
    // Our revocation canceled the subscription on Stripe.
    await deliverUntil(r, 'customer.subscription.deleted');
    expect(await subRow(subId)).toMatchObject({ status: 'canceled' });

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
  });

  it('a scheduled price change migrates the subscription and bills the new price at renewal', async () => {
    const r = await reader('price');
    const subId = await subscribeOnStripe(r);
    await deliverUntil(r, 'invoice.paid', (invoice) => invoice.amount_paid === 800);

    const effectiveAt = Date.now() + 2 * 60_000;
    const next = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/levels/${level.id}/prices`, {
        cookie: owner.cookie,
        body: {
          interval: 'month',
          amount: 1200,
          effectiveAt: new Date(effectiveAt).toISOString(),
          existing: 'migrate',
        },
      }),
      201,
    );
    const result = await runPaymentsLifecycle(env.DB, stripe, effectiveAt + 1000);
    expect(result.pricesPromoted).toBeGreaterThanOrEqual(1);
    expect(result.migrationFailures).toBe(0);
    await deliverUntil(r, 'customer.subscription.updated', (s) => {
      const item = (s.items as { data: { price: { unit_amount: number } }[] }).data[0];
      return item?.price.unit_amount === 1200;
    });
    expect(await subRow(subId)).toMatchObject({ price_id: next.id, amount: 1200 });

    // No proration: the renewal is the first invoice at the new price.
    await advance(r.clockId, r.since + 32 * DAY);
    await deliverUntil(r, 'invoice.paid', (invoice) => invoice.amount_paid === 1200);
    expect(await subRow(subId)).toMatchObject({ status: 'active', amount: 1200 });

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
  });

  it('a coupon lowers MRR to what the subscription bills; trials stay out of MRR', async () => {
    type Report = { mrr: Money[]; trialMrr: Money[] };
    type Money = { currency: string; amount: number };
    const usd = (list: Money[]) => list.find((m) => m.currency === 'usd')?.amount ?? 0;
    const revenue = async () =>
      data<Report>(
        await call('GET', `/api/v1/channels/${channelId}/revenue`, { cookie: owner.cookie }),
      );
    const coupon = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/coupons`, {
        cookie: owner.cookie,
        body: { code: `LIFE${Date.now() % 1_000_000}`, percentOff: 25, duration: 'forever' },
      }),
      201,
    );
    const stripeCoupon = (await env.DB.prepare('SELECT stripe_coupon_id FROM coupons WHERE id = ?1')
      .bind(coupon.id)
      .first<{ stripe_coupon_id: string }>())!.stripe_coupon_id;
    // The scheduled change above made the monthly price 1200.
    const before = await revenue();

    const r = await reader('coupon');
    const subId = await subscribeOnStripe(r, { coupon: stripeCoupon });
    await deliverUntil(r, 'invoice.paid', (invoice) => invoice.amount_paid === 900);
    expect(await subRow(subId)).toMatchObject({
      amount: 1200,
      discounted_amount: 900,
      discount_end: null,
    });
    const paying = await revenue();
    expect(usd(paying.mrr) - usd(before.mrr)).toBe(900);

    const t = await reader('coupon-trial');
    const trialSub = await subscribeOnStripe(t, { trialDays: 7 });
    await deliverUntil(t, 'customer.subscription.created');
    expect(await subRow(trialSub)).toMatchObject({ status: 'trialing' });
    const trialing = await revenue();
    expect(usd(trialing.mrr)).toBe(usd(paying.mrr));
    expect(usd(trialing.trialMrr) - usd(paying.trialMrr)).toBe(1200);

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
    await api('DELETE', `/v1/test_helpers/test_clocks/${t.clockId}`);
  });

  it('Gift Pass: paid, claim link mailed, reminded, expires unclaimed; a refund is recorded', async () => {
    // Checkout can't be completed without a browser, so the payment is a real PaymentIntent on a
    // clock customer and checkout.session.completed is the one event the suite writes itself.
    const r = await reader('gift');
    const intent = await api<{ id: string; status: string; latest_charge: string }>(
      'POST',
      '/v1/payment_intents',
      {
        amount: 2400,
        currency: 'usd',
        customer: r.customerId,
        payment_method: 'pm_card_visa',
        payment_method_types: ['card'],
        confirm: true,
      },
    );
    expect(intent.status).toBe('succeeded');

    const now = Date.now();
    const giftId = newId('giftPass', now);
    const recipient = uniqueEmail('friend');
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, recipient_email, created_at)
       VALUES (?1, ?2, ?3, 3, ?4, ?5, ?6)`,
    )
      .bind(giftId, channelId, level.id, r.email, recipient, now)
      .run();
    const reference = newCheckoutReference();
    await env.DB.prepare(
      `INSERT INTO checkout_sessions (reference, channel_id, subject_id, level_id, email, intent, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'gift', ?6)`,
    )
      .bind(reference, channelId, giftId, level.id, r.email, now)
      .run();
    const outcome = await post({
      id: `evt_lifecycle${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'event',
      type: 'checkout.session.completed',
      created: seconds(now),
      livemode: false,
      data: {
        object: {
          id: `cs_test_lifecycle${crypto.randomUUID().replace(/-/g, '')}`,
          object: 'checkout.session',
          client_reference_id: reference,
          metadata: { swarm_ref: await signCheckoutReference(testLinks(), reference) },
          customer: r.customerId,
          customer_details: { email: r.email },
          mode: 'payment',
          payment_intent: intent.id,
          payment_status: 'paid',
          amount_total: 2400,
          currency: 'usd',
        },
      },
    });
    expect(outcome).toBe('processed');
    const pass = await env.DB.prepare('SELECT status, claim_by FROM gift_passes WHERE id = ?1')
      .bind(giftId)
      .first<{ status: string; claim_by: number }>();
    expect(pass?.status).toBe('paid');
    const box = mail();
    expect((await box.adapter.list({ to: recipient, limit: 5 }))[0]?.category).toBe('gift_pass');

    await runPaymentsLifecycle(env.DB, stripe, pass!.claim_by - 10 * DAY, box);
    const reminders = await box.adapter.list({ to: recipient, limit: 5 });
    expect(reminders.some((m) => m.category === 'gift_pass_reminder')).toBe(true);
    await runPaymentsLifecycle(env.DB, stripe, pass!.claim_by + 1000, box);
    const expired = await env.DB.prepare('SELECT status FROM gift_passes WHERE id = ?1')
      .bind(giftId)
      .first<{ status: string }>();
    expect(expired?.status).toBe('expired');

    await api('POST', '/v1/refunds', { payment_intent: intent.id });
    await deliverUntil(r, 'charge.refunded');
    const refund = await env.DB.prepare(
      `SELECT amount FROM payments WHERE channel_id = ?1 AND kind = 'refund' AND stripe_object_id LIKE ?2`,
    )
      .bind(channelId, `${intent.latest_charge}:refund:%`)
      .first<{ amount: number }>();
    expect(refund?.amount).toBe(-2400);

    await api('DELETE', `/v1/test_helpers/test_clocks/${r.clockId}`);
  });
});

// Without the variables the file still has to report something.
describe.skipIf(ENABLED)('Stripe lifecycle on test clocks', () => {
  it.skip('set STRIPE_TEST_SECRET_KEY and STRIPE_TEST_ACCOUNT to run it', () => {});
});
