// PayPal memberships against a stand-in for PayPal: who may connect, what a webhook must prove, and
// what each event does to a Member's access. It says nothing about how PayPal really behaves.
import { SELF, env } from 'cloudflare:test';
import type { PayPalStatus } from '@swarm/domain';
import {
  cancelPayPalSubscription,
  forgetPayPalTokens,
  handlePayPalEvent,
  localMemberLinks,
  payPalSellable,
  readPayPalAccount,
  reconcilePayPal,
  PAYPAL_RECONCILE_READS_PER_CHANNEL,
  runPaymentsLifecycle,
  startPayPalSubscription,
  PayPalApi,
  type PayPalEvent,
} from '@swarm/engine';
import type { OutgoingMail } from '@swarm/mail';
import { parseKeyring } from '@swarm/tokens';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetProviderTokens } from '@swarm/vault';
import { usePayPalFetchForTests } from '../src/routes/paypal';
import { useVaultProviderFetch } from './vault-fetch';
import { call, createChannel, seatAs, signIn } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';
import { testLinks } from './links';

const SECRET = 'paypal_secret_abcd';
const CLIENT = 'paypal_client_id_1';
const path = (id: string) => `/api/v1/channels/${id}/payments/paypal`;
const hook = (id: string) => `/api/v1/paypal/webhook/${id}`;
const uid = () => crypto.randomUUID().replace(/-/g, '');

const paypal = {
  verified: true,
  /** Set to make PayPal fail: an HTTP status on the token or check call, or a hang. */
  failToken: 0,
  failVerify: 0 as number | 'hang',
  tokens: 0,
  signals: 0,
  /** What PayPal says about a subscription when it is read. */
  states: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  verifications: [] as string[],
  cancelled: [] as string[],
  nextBilling: '2030-01-01T00:00:00Z',
};

const fake: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const route = `${init?.method ?? 'GET'} ${url.pathname}`;
  if (init?.signal) paypal.signals++;
  if (route === 'POST /v1/oauth2/token') {
    paypal.tokens++;
    if (paypal.failToken) return Response.json({}, { status: paypal.failToken });
    return new Headers(init?.headers).get('authorization')?.includes(btoa(`${CLIENT}:${SECRET}`))
      ? Response.json({ access_token: 'token', expires_in: 32400 })
      : Response.json({ error: 'invalid_client' }, { status: 401 });
  }
  if (route === 'POST /v1/notifications/webhooks') return Response.json({ id: `wh_${uid()}` });
  if (route.startsWith('DELETE /v1/notifications/webhooks/')) return new Response('{}');
  if (route === 'POST /v1/notifications/verify-webhook-signature') {
    paypal.verifications.push(String(init?.body));
    if (paypal.failVerify === 'hang') {
      // Never answers: what the request's own time limit then does.
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (paypal.failVerify) return Response.json({}, { status: paypal.failVerify });
    return Response.json({ verification_status: paypal.verified ? 'SUCCESS' : 'FAILURE' });
  }
  if (route === 'POST /v1/catalogs/products') return Response.json({ id: 'PROD-1' });
  if (route === 'POST /v1/billing/plans') return Response.json({ id: `P-${uid()}` });
  if (route === 'POST /v1/billing/subscriptions') {
    return Response.json({
      id: 'I-NEW',
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve?x=1' }],
    });
  }
  const cancel = /^POST \/v1\/billing\/subscriptions\/([^/]+)\/cancel$/.exec(route);
  if (cancel) {
    paypal.cancelled.push(cancel[1]!);
    return new Response('{}');
  }
  if (route.startsWith('GET /v1/billing/subscriptions/')) {
    const id = decodeURIComponent(route.slice('GET /v1/billing/subscriptions/'.length));
    paypal.reads.push(id);
    const state = paypal.states.get(id);
    if (state) return Response.json({ id, ...state });
    return Response.json({ billing_info: { next_billing_time: paypal.nextBilling } });
  }
  return Response.json({ message: `unexpected ${route}` }, { status: 500 });
};

/**
 * What a caller hands the engine for PayPal: requests on the account's credentials (the vault's
 * proxy; here the fake PayPal itself, which doesn't check the bearer) and the erasure markers.
 */
const payPalVault = () => ({
  fetchFor: () => fake,
  markers: parseKeyring(`f1:${'f'.repeat(64)}`),
});

const SIGNED = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.paypal.com/cert',
  'paypal-transmission-id': 'tx',
  'paypal-transmission-sig': 'sig',
  get 'paypal-transmission-time'() {
    return new Date().toISOString();
  },
};
const deliver = (id: string, body: unknown, headers: Record<string, string> = SIGNED) =>
  SELF.fetch(`http://localhost${hook(id)}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...{ ...headers } },
  });

async function connected() {
  const owner = await signIn();
  const channel = await createChannel(owner);
  await enableFlag('paypal_memberships', owner.workspaceId, channel.id);
  await data(
    await call('PUT', path(channel.id), {
      cookie: owner.cookie,
      body: { mode: 'sandbox', clientId: CLIENT, secret: SECRET },
    }),
  );
  const levelId = `ml_${uid()}`;
  const priceId = `lp_${uid()}`;
  const planId = `P-${uid()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, position, created_at, updated_at)
       VALUES (?1, ?2, 'Member', 0, ?3, ?3)`,
    ).bind(levelId, channel.id, now),
    env.DB.prepare(
      `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, created_at, paypal_plan_id)
       VALUES (?1, ?2, ?3, 'month', 'usd', 500, ?4, ?5)`,
    ).bind(priceId, levelId, channel.id, now, planId),
  ]);
  return { owner, channel, levelId, priceId, planId };
}

async function checkoutRow(
  world: Awaited<ReturnType<typeof connected>>,
  email = `${uid()}@example.com`,
) {
  const reference = uid();
  await env.DB.prepare(
    `INSERT INTO checkout_sessions (reference, channel_id, level_id, price_id, email, intent, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'subscribe', 'open', ?6)`,
  )
    .bind(reference, world.channel.id, world.levelId, world.priceId, email, Date.now())
    .run();
  return { reference, email };
}

const activated = (paypalId: string, reference: string, planId: string, email: string) => ({
  id: `WH-${uid()}`,
  event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
  resource: {
    id: paypalId,
    custom_id: reference,
    plan_id: planId,
    subscriber: { email_address: email },
    billing_info: { next_billing_time: '2030-01-01T00:00:00Z' },
  },
});

const event = (event_type: string, resource: Record<string, unknown>) => ({
  id: `WH-${uid()}`,
  event_type,
  resource,
});

const subscription = (paypalId: string) =>
  env.DB.prepare('SELECT * FROM member_subscriptions WHERE paypal_subscription_id = ?1')
    .bind(paypalId)
    .first<Record<string, string | number | null>>();

async function subscribed(world: Awaited<ReturnType<typeof connected>>) {
  const { reference, email } = await checkoutRow(world);
  const paypalId = `I-${uid()}`;
  const res = await deliver(world.channel.id, activated(paypalId, reference, world.planId, email));
  expect((await data<{ outcome: string }>(res)).outcome).toBe('processed');
  return { paypalId, email };
}

const hasAccess = async (memberId: unknown) =>
  (await env.DB.prepare(
    `SELECT 1 AS ok FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
  )
    .bind(memberId)
    .first()) !== null;

beforeEach(() => {
  forgetPayPalTokens();
  usePayPalFetchForTests(fake);
  useVaultProviderFetch(fake);
  paypal.verified = true;
  paypal.failToken = 0;
  paypal.failVerify = 0;
  paypal.tokens = 0;
  paypal.signals = 0;
  paypal.states = new Map();
  paypal.reads = [];
  paypal.verifications = [];
  paypal.cancelled = [];
});
afterEach(() => {
  usePayPalFetchForTests(null);
  useVaultProviderFetch(null);
});

describe('connecting PayPal', () => {
  it('is behind its switch', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const res = await call('PUT', path(channel.id), {
      cookie: owner.cookie,
      body: { mode: 'sandbox', clientId: CLIENT, secret: SECRET },
    });
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('is for owners only', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    await enableFlag('paypal_memberships', owner.workspaceId, channel.id);
    const admin = await seatAs(owner.workspaceId, 'admin');
    const res = await call('PUT', path(channel.id), {
      cookie: admin.cookie,
      body: { mode: 'sandbox', clientId: CLIENT, secret: SECRET },
    });
    expect(res.status).toBe(403);
  });

  it('refuses credentials PayPal refuses, and saves nothing', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    await enableFlag('paypal_memberships', owner.workspaceId, channel.id);
    const res = await call('PUT', path(channel.id), {
      cookie: owner.cookie,
      body: { mode: 'sandbox', clientId: CLIENT, secret: 'wrong_secret_1234' },
    });
    expect(res.status).toBe(400);
    const status = await data<PayPalStatus>(
      await call('GET', path(channel.id), { cookie: owner.cookie }),
    );
    expect(status.connected).toBe(false);
  });

  it('seals the secret and never gives it back', async () => {
    const { owner, channel } = await connected();
    const res = await call('GET', path(channel.id), { cookie: owner.cookie });
    const text = await res.clone().text();
    expect(text).not.toContain(SECRET);
    expect((await data<PayPalStatus>(res)).secretLast4).toBe('abcd');
    const row = await env.DB.prepare('SELECT secret_enc FROM paypal_accounts WHERE channel_id = ?1')
      .bind(channel.id)
      .first<{ secret_enc: string }>();
    expect(row!.secret_enc).not.toContain(SECRET);
  });

  it('forgets the secret and the plans when disconnected', async () => {
    const { owner, channel, priceId } = await connected();
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await call('DELETE', path(channel.id), { cookie: admin.cookie })).status).toBe(403);
    await data(await call('DELETE', path(channel.id), { cookie: owner.cookie }));
    const row = await env.DB.prepare('SELECT 1 AS ok FROM paypal_accounts WHERE channel_id = ?1')
      .bind(channel.id)
      .first();
    expect(row).toBeNull();
    const price = await env.DB.prepare('SELECT paypal_plan_id FROM level_prices WHERE id = ?1')
      .bind(priceId)
      .first<{ paypal_plan_id: string | null }>();
    expect(price!.paypal_plan_id).toBeNull();
  });
});

describe('the webhook', () => {
  it('reads nothing until PayPal confirms the delivery', async () => {
    const world = await connected();
    const { reference, email } = await checkoutRow(world);
    paypal.verified = false;
    const paypalId = `I-${uid()}`;
    const res = await deliver(
      world.channel.id,
      activated(paypalId, reference, world.planId, email),
    );
    expect(res.status).toBe(400);
    expect(await subscription(paypalId)).toBeNull();
  });

  it('refuses a delivery with no signature without asking PayPal', async () => {
    const world = await connected();
    const res = await deliver(world.channel.id, event('X', {}), {});
    expect(res.status).toBe(400);
    expect(paypal.verifications).toHaveLength(0);
  });

  it('sends the body back exactly as it arrived', async () => {
    const world = await connected();
    const raw =
      '{ "id":"WH-raw-1",  "event_type":"PAYMENT.SALE.COMPLETED", "resource":{"amount":"5.00"} }';
    await deliver(world.channel.id, raw);
    expect(paypal.verifications[0]).toContain(`"webhook_event":${raw}`);
  });

  it('answers the same for a publication with no PayPal', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    expect((await deliver(channel.id, event('X', {}))).status).toBe(400);
  });
});

describe('what a delivery may cost', () => {
  const forged = () => event('PAYMENT.SALE.COMPLETED', { id: `SALE-${uid()}` });

  it('checks the headers, the time and the certificate host before asking PayPal', async () => {
    const world = await connected();
    paypal.tokens = 0;
    const cases: Record<string, string>[] = [
      { ...SIGNED, 'paypal-transmission-time': '2001-01-01T00:00:00Z' },
      { ...SIGNED, 'paypal-transmission-time': 'yesterday-ish' },
      { ...SIGNED, 'paypal-cert-url': 'https://paypal.com.evil.example/cert' },
      { ...SIGNED, 'paypal-cert-url': 'http://api.paypal.com/cert' },
      { ...SIGNED, 'paypal-auth-algo': 'SHA256 with RSA; drop' },
    ];
    for (const headers of cases) {
      expect((await deliver(world.channel.id, forged(), headers)).status).toBe(400);
    }
    // A type Swarm doesn't handle is acknowledged without a check: it changes nothing.
    const other = await deliver(world.channel.id, event('CUSTOMER.DISPUTE.CREATED', {}));
    expect((await data<{ outcome: string }>(other)).outcome).toBe('ignored');
    expect(paypal.verifications).toHaveLength(0);
    expect(paypal.tokens).toBe(0);
  });

  it("bounds the checks one Channel's forged posts can cost, without touching another's", async () => {
    const a = await connected();
    const b = await connected();
    paypal.verified = false;
    paypal.tokens = 0;
    paypal.signals = 0;
    const answers: number[] = [];
    for (let i = 0; i < 35; i++) answers.push((await deliver(a.channel.id, forged())).status);
    // Refused while checks remain, then answered as temporary without calling PayPal.
    expect(answers.filter((s) => s === 400)).toHaveLength(30);
    expect(answers.slice(30)).toEqual([503, 503, 503, 503, 503]);
    expect(paypal.verifications).toHaveLength(30);
    for (let i = 0; i < 5; i++) expect((await deliver(b.channel.id, forged())).status).toBe(400);
    expect(paypal.verifications).toHaveLength(35);
    // Every call carries a time limit, and the access token is reused rather than asked for
    // on every post.
    expect(paypal.signals).toBe(paypal.verifications.length + paypal.tokens);
    expect(paypal.tokens).toBeLessThanOrEqual(1);

    // A genuine event: B's is applied; A's is asked to come again, not refused as forged.
    paypal.verified = true;
    const rowA = await checkoutRow(a);
    const rowB = await checkoutRow(b);
    const subA = `I-${uid()}`;
    const subB = `I-${uid()}`;
    expect(
      (await deliver(a.channel.id, activated(subA, rowA.reference, a.planId, rowA.email))).status,
    ).toBe(503);
    const okB = await deliver(b.channel.id, activated(subB, rowB.reference, b.planId, rowB.email));
    expect((await data<{ outcome: string }>(okB)).outcome).toBe('processed');
    expect(await subscription(subA)).toBeNull();
    expect(await subscription(subB)).not.toBeNull();
  });

  it('answers a PayPal outage as temporary, keeps no claim, and applies the redelivery once', async () => {
    const world = await connected();
    for (const failure of ['token', 'verify', 'hang'] as const) {
      const { reference, email } = await checkoutRow(world);
      const paypalId = `I-${uid()}`;
      const body = activated(paypalId, reference, world.planId, email);
      forgetPayPalTokens();
      forgetProviderTokens();
      if (failure === 'token') paypal.failToken = 429;
      else paypal.failVerify = failure === 'hang' ? 'hang' : 429;
      const res = await deliver(world.channel.id, body);
      expect(res.status).toBe(503);
      const claim = await env.DB.prepare('SELECT status FROM paypal_events WHERE event_id = ?1')
        .bind(body.id)
        .first();
      expect(claim).toBeNull();
      paypal.failToken = 0;
      paypal.failVerify = 0;
      const again = await deliver(world.channel.id, body);
      expect((await data<{ outcome: string }>(again)).outcome).toBe('processed');
      expect(await subscription(paypalId)).toMatchObject({ status: 'active' });
      expect((await data<{ outcome: string }>(await deliver(world.channel.id, body))).outcome).toBe(
        'duplicate',
      );
    }
  });
});

describe('a subscription', () => {
  it('grants access on activation, once', async () => {
    const world = await connected();
    const { reference, email } = await checkoutRow(world);
    const paypalId = `I-${uid()}`;
    const body = activated(paypalId, reference, world.planId, email);
    await data(await deliver(world.channel.id, body));
    const row = await subscription(paypalId);
    expect(row).toMatchObject({
      status: 'active',
      source: 'stripe',
      amount: 500,
      interval: 'month',
    });
    expect(row!.stripe_subscription_id).toBeNull();
    expect(await hasAccess(row!.member_id)).toBe(true);
    const again = await data<{ outcome: string }>(await deliver(world.channel.id, body));
    expect(again.outcome).toBe('duplicate');
  });

  it('never confirms a pending Member by address alone, whatever PayPal reports', async () => {
    const world = await connected();
    const state = (email: string) =>
      env.DB.prepare(
        `SELECT m.id, m.status, m.consent_at, m.confirmed_at,
                (SELECT count(*) FROM member_events e WHERE e.member_id = m.id AND e.type = 'confirmed') AS confirmed,
                (SELECT count(*) FROM confirm_requests q WHERE q.member_id = m.id) AS mailed
           FROM members m WHERE m.channel_id = ?1 AND m.email = ?2`,
      )
        .bind(world.channel.id, email)
        .first<Record<string, string | number | null>>();
    for (const reported of ['same', 'other', 'none'] as const) {
      const typed = `${uid()}@example.com`;
      await env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?4)`,
      )
        .bind(`mb_${uid()}`, world.channel.id, typed, Date.now())
        .run();
      // A signed-out checkout: the row carries the typed address and no Member.
      const { reference } = await checkoutRow(world, typed);
      const paypalId = `I-${uid()}`;
      const payer = `${uid()}@example.com`;
      const body = activated(
        paypalId,
        reference,
        world.planId,
        reported === 'other' ? payer : typed,
      );
      if (reported === 'none') delete (body.resource as { subscriber?: unknown }).subscriber;
      expect((await data<{ outcome: string }>(await deliver(world.channel.id, body))).outcome).toBe(
        'processed',
      );
      expect(await state(typed)).toMatchObject({
        status: 'pending',
        consent_at: null,
        confirmed_at: null,
        confirmed: 0,
      });
      const owner = (await subscription(paypalId))!.member_id;
      expect(await hasAccess(owner)).toBe(true);
      // Whoever the purchase went to is pending and has been asked to confirm.
      const holder = await env.DB.prepare('SELECT email FROM members WHERE id = ?1')
        .bind(owner)
        .first<{ email: string }>();
      expect(holder!.email).toBe(reported === 'other' ? payer : typed);
      expect(await state(holder!.email)).toMatchObject({
        status: 'pending',
        confirmed_at: null,
        mailed: 1,
      });
    }
  });

  it('grants nothing on a plan Swarm didn’t choose, or another publication’s checkout', async () => {
    const world = await connected();
    const other = await connected();
    const { reference, email } = await checkoutRow(world);
    const wrongPlan = `I-${uid()}`;
    await data(await deliver(world.channel.id, activated(wrongPlan, reference, 'P-CHEAP', email)));
    expect(await subscription(wrongPlan)).toBeNull();
    const crossed = `I-${uid()}`;
    await data(await deliver(other.channel.id, activated(crossed, reference, world.planId, email)));
    expect(await subscription(crossed)).toBeNull();
  });

  it('can’t touch another publication’s subscription', async () => {
    const world = await connected();
    const attacker = await connected();
    const { paypalId } = await subscribed(world);
    await data(
      await deliver(attacker.channel.id, event('BILLING.SUBSCRIPTION.EXPIRED', { id: paypalId })),
    );
    expect((await subscription(paypalId))!.status).toBe('active');
  });

  it('records a renewal and moves the period on', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    paypal.nextBilling = '2031-06-01T00:00:00Z';
    await data(
      await deliver(
        world.channel.id,
        event('PAYMENT.SALE.COMPLETED', {
          id: `SALE-${paypalId}`,
          billing_agreement_id: paypalId,
          amount: { total: '5.00', currency: 'USD' },
        }),
      ),
    );
    const payment = await env.DB.prepare(
      'SELECT amount, currency FROM payments WHERE stripe_object_id = ?1',
    )
      .bind(`paypal:SALE-${paypalId}`)
      .first();
    expect(payment).toEqual({ amount: 500, currency: 'usd' });
    expect((await subscription(paypalId))!.current_period_end).toBe(
      Date.parse('2031-06-01T00:00:00Z'),
    );
  });

  it('asks for a payment that arrives before the activation to be sent again', async () => {
    const world = await connected();
    const res = await deliver(
      world.channel.id,
      event('PAYMENT.SALE.COMPLETED', {
        id: `SALE-${uid()}`,
        billing_agreement_id: `I-${uid()}`,
        amount: { total: '5.00', currency: 'USD' },
      }),
    );
    expect(res.status).toBe(500);
  });

  it('gives grace when a payment fails, and a payment ends it', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    await data(
      await deliver(
        world.channel.id,
        event('BILLING.SUBSCRIPTION.PAYMENT.FAILED', { id: paypalId }),
      ),
    );
    const failing = await subscription(paypalId);
    expect(failing).toMatchObject({ status: 'past_due' });
    expect(failing!.grace_until).not.toBeNull();
    expect(await hasAccess(failing!.member_id)).toBe(true);
    await data(
      await deliver(
        world.channel.id,
        event('PAYMENT.SALE.COMPLETED', {
          id: `SALE-${uid()}`,
          billing_agreement_id: paypalId,
          amount: { total: '5.00', currency: 'USD' },
        }),
      ),
    );
    expect(await subscription(paypalId)).toMatchObject({ status: 'active', grace_until: null });
  });

  it('keeps access after canceling until the paid period ends', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    const row = await subscription(paypalId);
    await cancelPayPalSubscription(env.DB, payPalVault(), {
      channelId: world.channel.id,
      subscriptionId: row!.id as string,
      now: Date.now(),
    });
    expect(paypal.cancelled).toEqual([paypalId]);
    const canceled = await subscription(paypalId);
    expect(canceled).toMatchObject({ status: 'active', cancel_at_period_end: 1 });
    expect(await hasAccess(canceled!.member_id)).toBe(true);

    await runPaymentsLifecycle(env.DB, null, Date.parse('2030-01-02T00:00:00Z'));
    const ended = await subscription(paypalId);
    expect(ended).toMatchObject({ status: 'canceled', revoke_reason: 'canceled' });
    expect(await hasAccess(ended!.member_id)).toBe(false);
  });

  it('ends access on a full refund and stops charging, but not on a partial one', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    const saleId = `SALE-${uid()}`;
    await data(
      await deliver(
        world.channel.id,
        event('PAYMENT.SALE.COMPLETED', {
          id: saleId,
          billing_agreement_id: paypalId,
          amount: { total: '5.00', currency: 'USD' },
        }),
      ),
    );
    const refund = (total: string) =>
      deliver(
        world.channel.id,
        event('PAYMENT.SALE.REFUNDED', {
          id: `RF-${uid()}`,
          sale_id: saleId,
          amount: { total, currency: 'USD' },
        }),
      );
    await data(await refund('1.00'));
    expect((await subscription(paypalId))!.revoked_at).toBeNull();
    await data(await refund('5.00'));
    const row = await subscription(paypalId);
    expect(row).toMatchObject({ revoke_reason: 'refund' });
    expect(paypal.cancelled).toEqual([paypalId]);
    expect(await hasAccess(row!.member_id)).toBe(false);
  });

  it('ends access when partial refunds add up to the whole sale', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    const saleId = `SALE-${uid()}`;
    await data(
      await deliver(
        world.channel.id,
        event('PAYMENT.SALE.COMPLETED', {
          id: saleId,
          billing_agreement_id: paypalId,
          amount: { total: '5.00', currency: 'USD' },
        }),
      ),
    );
    const first = event('PAYMENT.SALE.REFUNDED', {
      id: `RF-${uid()}`,
      sale_id: saleId,
      amount: { total: '2.50', currency: 'USD' },
    });
    await data(await deliver(world.channel.id, first));
    // A redelivered partial refund is not a second one.
    await data(await deliver(world.channel.id, first));
    expect((await subscription(paypalId))!.revoked_at).toBeNull();
    await data(
      await deliver(
        world.channel.id,
        event('PAYMENT.SALE.REFUNDED', {
          id: `RF-${uid()}`,
          sale_id: saleId,
          amount: { total: '2.50', currency: 'USD' },
        }),
      ),
    );
    const row = await subscription(paypalId);
    expect(row).toMatchObject({ revoke_reason: 'refund' });
    expect(await hasAccess(row!.member_id)).toBe(false);
  });
});

describe('event claims', () => {
  const engine = async (
    world: Awaited<ReturnType<typeof connected>>,
    body: PayPalEvent,
    now: number,
  ) =>
    handlePayPalEvent(
      {
        db: env.DB,
        api: new PayPalApi('sandbox', CLIENT, SECRET, fake),
        account: (await readPayPalAccount(env.DB, world.channel.id))!,
        now,
        fieldKeys: parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS),
      },
      body,
    );
  const claim = (channelId: string, id: string) =>
    env.DB.prepare('SELECT status FROM paypal_events WHERE channel_id = ?1 AND event_id = ?2')
      .bind(channelId, id)
      .first<{ status: string }>();
  const seedReceived = (channelId: string, body: PayPalEvent, at: number) =>
    env.DB.prepare(
      `INSERT INTO paypal_events (event_id, channel_id, type, status, received_at) VALUES (?1, ?2, ?3, 'received', ?4)`,
    )
      .bind(body.id, channelId, body.event_type, at)
      .run();

  it('recovers an activation whose earlier run died after claiming it', async () => {
    const world = await connected();
    const { reference, email } = await checkoutRow(world);
    const paypalId = `I-${uid()}`;
    const body = activated(paypalId, reference, world.planId, email) as PayPalEvent;
    const now = Date.now();
    // Claimed a moment ago: plausibly still running, so a redelivery waits.
    await seedReceived(world.channel.id, body, now - 1000);
    expect(await engine(world, body, now)).toBe('duplicate');
    expect(await subscription(paypalId)).toBeNull();
    // Claimed long ago and never finished: the redelivery is applied, once.
    expect(await engine(world, body, now + 10 * 60_000)).toBe('processed');
    const row = await subscription(paypalId);
    expect(row).toMatchObject({ status: 'active' });
    expect(await hasAccess(row!.member_id)).toBe(true);
    expect(await claim(world.channel.id, body.id)).toEqual({ status: 'processed' });
    expect(await engine(world, body, now + 20 * 60_000)).toBe('duplicate');
  });

  it('recovers when the failure itself could not be recorded', async () => {
    const world = await connected();
    const { reference, email } = await checkoutRow(world);
    const paypalId = `I-${uid()}`;
    const body = activated(paypalId, reference, world.planId, email) as PayPalEvent;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TRIGGER pp_fail_insert BEFORE INSERT ON member_subscriptions
         WHEN NEW.paypal_subscription_id = '${paypalId}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
      ),
      env.DB.prepare(
        `CREATE TRIGGER pp_fail_status BEFORE UPDATE ON paypal_events
         WHEN NEW.event_id = '${body.id}' BEGIN SELECT RAISE(ABORT, 'status write failed'); END`,
      ),
    ]);
    try {
      await expect(engine(world, body, now)).rejects.toThrow('simulated failure');
    } finally {
      await env.DB.batch([
        env.DB.prepare('DROP TRIGGER pp_fail_insert'),
        env.DB.prepare('DROP TRIGGER pp_fail_status'),
      ]);
    }
    expect(await claim(world.channel.id, body.id)).toEqual({ status: 'received' });
    expect(await engine(world, body, now + 10 * 60_000)).toBe('processed');
    expect(await hasAccess((await subscription(paypalId))!.member_id)).toBe(true);
  });

  it('recovers a cancellation whose earlier run died, ending access at the period end', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    const body = event('BILLING.SUBSCRIPTION.CANCELLED', { id: paypalId }) as PayPalEvent;
    const now = Date.now();
    await seedReceived(world.channel.id, body, now - 60 * 60_000);
    expect(await engine(world, body, now)).toBe('processed');
    expect(await subscription(paypalId)).toMatchObject({ cancel_at_period_end: 1 });
  });

  it('handles one event id once per Channel, even for two Channels on one PayPal app', async () => {
    const a = await connected();
    const b = await connected();
    const id = `WH-${uid()}`;
    const rowA = await checkoutRow(a);
    const rowB = await checkoutRow(b);
    const subA = `I-${uid()}`;
    const subB = `I-${uid()}`;
    const bodyA = { ...activated(subA, rowA.reference, a.planId, rowA.email), id };
    const bodyB = { ...activated(subB, rowB.reference, b.planId, rowB.email), id };
    expect((await data<{ outcome: string }>(await deliver(a.channel.id, bodyA))).outcome).toBe(
      'processed',
    );
    expect((await data<{ outcome: string }>(await deliver(b.channel.id, bodyB))).outcome).toBe(
      'processed',
    );
    expect((await subscription(subA))!.channel_id).toBe(a.channel.id);
    expect((await subscription(subB))!.channel_id).toBe(b.channel.id);
    expect(await claim(a.channel.id, id)).toEqual({ status: 'processed' });
    expect(await claim(b.channel.id, id)).toEqual({ status: 'processed' });
    // A's redelivery is still A's duplicate, and changes nothing in B.
    expect((await data<{ outcome: string }>(await deliver(a.channel.id, bodyA))).outcome).toBe(
      'duplicate',
    );
  });
});

describe('reconciling with PayPal', () => {
  it('grants a checkout whose activation never arrived, once', async () => {
    const world = await connected();
    const { reference, email } = await checkoutRow(world);
    const paypalId = `I-${uid().slice(0, 12).toUpperCase()}`;
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE checkout_sessions SET subject_id = ?1, created_at = ?2 WHERE reference = ?3',
    )
      .bind(paypalId, now - 20 * 60_000, reference)
      .run();
    paypal.states.set(paypalId, {
      status: 'ACTIVE',
      custom_id: reference,
      plan_id: world.planId,
      subscriber: { email_address: email },
      billing_info: { next_billing_time: '2030-01-01T00:00:00Z' },
    });
    for (let run = 0; run < 25 && !(await subscription(paypalId)); run++) {
      await reconcilePayPal(env.DB, payPalVault(), now + run);
    }
    const row = await subscription(paypalId);
    expect(row).toMatchObject({ status: 'active', channel_id: world.channel.id });
    expect(await hasAccess(row!.member_id)).toBe(true);
    // Recorded like a webhook event, and applied once.
    const claim = await env.DB.prepare(
      'SELECT status FROM paypal_events WHERE channel_id = ?1 AND event_id = ?2',
    )
      .bind(world.channel.id, `RECONCILE-${paypalId}-ACTIVE`)
      .first();
    expect(claim).toEqual({ status: 'processed' });
    await reconcilePayPal(env.DB, payPalVault(), now + 60_000);
    const count = await env.DB.prepare(
      'SELECT count(*) AS n FROM member_subscriptions WHERE paypal_subscription_id = ?1',
    )
      .bind(paypalId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('ends access PayPal ended without telling Swarm, and leaves a running one alone', async () => {
    const world = await connected();
    const ended = await subscribed(world);
    const running = await subscribed(world);
    paypal.states.set(ended.paypalId, { status: 'CANCELLED' });
    paypal.states.set(running.paypalId, { status: 'ACTIVE' });
    const before = await subscription(running.paypalId);
    let now = Date.now();
    // Channels are sampled at random each run; enough runs reach this one.
    for (let run = 0; run < 25; run++) {
      paypal.reads = [];
      await reconcilePayPal(env.DB, payPalVault(), now);
      const mine = paypal.reads.filter((id) => id === ended.paypalId || id === running.paypalId);
      expect(paypal.reads.length).toBeLessThanOrEqual(PAYPAL_RECONCILE_READS_PER_CHANNEL * 25);
      expect(mine.length).toBeLessThanOrEqual(PAYPAL_RECONCILE_READS_PER_CHANNEL);
      now += 5 * 60_000;
    }
    expect(await subscription(ended.paypalId)).toMatchObject({ cancel_at_period_end: 1 });
    expect(await subscription(running.paypalId)).toMatchObject({
      status: before!.status,
      cancel_at_period_end: before!.cancel_at_period_end,
      current_period_end: before!.current_period_end,
    });
  });

  it('counts unfinished event claims for operators', async () => {
    const world = await connected();
    await env.DB.prepare(
      `INSERT INTO paypal_events (event_id, channel_id, type, status, received_at)
       VALUES (?1, ?2, 'BILLING.SUBSCRIPTION.ACTIVATED', 'received', ?3)`,
    )
      .bind(`WH-${uid()}`, world.channel.id, Date.now() - 60 * 60_000)
      .run();
    expect((await reconcilePayPal(env.DB, payPalVault(), Date.now())).unfinished).toBeGreaterThan(
      0,
    );
  });
});

describe('receipts', () => {
  const sale = (paypalId: string, total: string, currency: string, id = `SALE-${uid()}`) =>
    event('PAYMENT.SALE.COMPLETED', {
      id,
      billing_agreement_id: paypalId,
      amount: { total, currency },
    });

  /** The owner's own receipt wording, which is what turns receipts on. */
  async function saveReceipt(world: Awaited<ReturnType<typeof connected>>) {
    const channelId = world.channel.id;
    await enableFlag('message_templates', world.owner.workspaceId, channelId);
    await env.DB.prepare(
      `INSERT INTO channel_messages (channel_id, key, subject, mode, heading, body, button_label, updated_at)
       VALUES (?1, 'payment_receipt', 'Thanks', 'text', 'Thanks', 'You paid {{amount}} for {{level}}.', 'Manage', 0)`,
    )
      .bind(channelId)
      .run();
  }

  /** Runs one event through the engine with a mailer that records, or one that fails. */
  async function run(
    world: Awaited<ReturnType<typeof connected>>,
    body: PayPalEvent,
    fail = false,
  ) {
    const sent: OutgoingMail[] = [];
    const account = (await readPayPalAccount(env.DB, world.channel.id))!;
    const outcome = await handlePayPalEvent(
      {
        db: env.DB,
        api: new PayPalApi('sandbox', CLIENT, SECRET, fake),
        account,
        now: Date.now(),
        fieldKeys: parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS),
        notices: {
          links: testLinks(),
          memberLinks: localMemberLinks(testLinks()),
          mail: {
            adapter: {
              send: async (mail: OutgoingMail) => {
                if (fail) throw new Error('the mail service is down');
                sent.push(mail);
                return { messageId: 'x' };
              },
            },
            platformMailDomain: 'mail.swarm.localhost',
            site: { scheme: 'http', platformDomain: 'site.localhost' },
            captureOrigin: 'http://localhost:8791',
          },
        },
      },
      body,
    );
    return { outcome, sent };
  }

  it('sends the receipt once the owner has saved it, with the amount and currency', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId, email } = await subscribed(world);
    const { outcome, sent } = await run(world, sale(paypalId, '5.00', 'USD'));
    expect(outcome).toBe('processed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ category: 'payment_receipt', to: email, subject: 'Thanks' });
    expect(sent[0]!.text).toContain('You paid $5.00 for Member.');
  });

  it('says nothing until the owner saves it', async () => {
    const world = await connected();
    const { paypalId } = await subscribed(world);
    const { outcome, sent } = await run(world, sale(paypalId, '5.00', 'USD'));
    expect(outcome).toBe('processed');
    expect(sent).toEqual([]);
  });

  it('sends once per sale, even in a new event for the same sale', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId } = await subscribed(world);
    const id = `SALE-${uid()}`;
    const first = sale(paypalId, '5.00', 'USD', id);
    expect((await run(world, first)).sent).toHaveLength(1);
    expect(await run(world, first)).toMatchObject({ outcome: 'duplicate', sent: [] });
    expect((await run(world, sale(paypalId, '5.00', 'USD', id))).sent).toEqual([]);
    // The next month is a new sale.
    expect((await run(world, sale(paypalId, '5.00', 'USD'))).sent).toHaveLength(1);
  });

  it('reads a currency with no decimals correctly', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId } = await subscribed(world);
    const { sent } = await run(world, sale(paypalId, '500', 'JPY'));
    expect(sent[0]!.text).toContain('You paid ¥500 for Member.');
  });

  it('reads the euro, not a dollar sign', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId } = await subscribed(world);
    const { sent } = await run(world, sale(paypalId, '8.50', 'EUR'));
    expect(sent[0]!.text).toContain('You paid €8.50 for Member.');
  });

  it('sends nothing for a sale with no amount', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId } = await subscribed(world);
    const { outcome, sent } = await run(
      world,
      event('PAYMENT.SALE.COMPLETED', { id: `SALE-${uid()}`, billing_agreement_id: paypalId }),
    );
    expect(outcome).toBe('processed');
    expect(sent).toEqual([]);
  });

  it('keeps the event when the mail fails, or the currency makes no sense', async () => {
    const world = await connected();
    await saveReceipt(world);
    const { paypalId } = await subscribed(world);
    const id = `SALE-${uid()}`;
    const { outcome } = await run(world, sale(paypalId, '5.00', 'USD', id), true);
    expect(outcome).toBe('processed');
    const payment = await env.DB.prepare('SELECT amount FROM payments WHERE stripe_object_id = ?1')
      .bind(`paypal:${id}`)
      .first();
    expect(payment).toEqual({ amount: 500 });
    const strange = await run(world, sale(paypalId, '5.00', 'X'));
    expect(strange.outcome).toBe('processed');
    expect(strange.sent[0]!.text).toContain('You paid 5.00 X for Member.');
  });
});

describe('starting a subscription', () => {
  it('makes the plan once and sends the reader to PayPal', async () => {
    const world = await connected();
    await env.DB.prepare('UPDATE level_prices SET paypal_plan_id = NULL WHERE id = ?1')
      .bind(world.priceId)
      .run();
    const reference = uid();
    const url = await startPayPalSubscription(
      env.DB,
      new PayPalApi('sandbox', CLIENT, SECRET, fake),
      {
        channelId: world.channel.id,
        levelId: world.levelId,
        priceId: world.priceId,
        memberId: null,
        email: null,
        reference,
        returnUrl: 'https://site.example/subscribe/thanks',
        cancelUrl: 'https://site.example/subscribe',
        now: Date.now(),
      },
    );
    expect(new URL(url).hostname).toBe('www.sandbox.paypal.com');
    const price = await env.DB.prepare('SELECT paypal_plan_id FROM level_prices WHERE id = ?1')
      .bind(world.priceId)
      .first<{ paypal_plan_id: string }>();
    expect(price!.paypal_plan_id).toMatch(/^P-/);
    // The checkout remembers PayPal's subscription id, for reconciliation.
    const row = await env.DB.prepare(
      'SELECT subject_id FROM checkout_sessions WHERE reference = ?1',
    )
      .bind(reference)
      .first<{ subject_id: string }>();
    expect(row!.subject_id).toBe('I-NEW');
  });

  it('refuses a redirect anywhere but PayPal', async () => {
    const world = await connected();
    const evil: typeof fetch = async (input, init) =>
      String(input).endsWith('/v1/billing/subscriptions')
        ? Response.json({ links: [{ rel: 'approve', href: 'https://evil.example/pay' }] })
        : fake(input, init);
    await expect(
      startPayPalSubscription(env.DB, new PayPalApi('sandbox', CLIENT, SECRET, evil), {
        channelId: world.channel.id,
        levelId: world.levelId,
        priceId: world.priceId,
        memberId: null,
        email: null,
        reference: uid(),
        returnUrl: 'https://site.example/a',
        cancelUrl: 'https://site.example/b',
        now: Date.now(),
      }),
    ).rejects.toThrow(/approve/);
  });

  it('only sells fixed monthly and yearly prices with no trial', () => {
    const base = { interval: 'month', customAmount: false, currency: 'usd' };
    expect(payPalSellable(base, 0)).toBe(true);
    expect(payPalSellable(base, 7)).toBe(false);
    expect(payPalSellable({ ...base, interval: 'lifetime' }, 0)).toBe(false);
    expect(payPalSellable({ ...base, customAmount: true }, 0)).toBe(false);
    expect(payPalSellable({ ...base, currency: 'inr' }, 0)).toBe(false);
  });
});
