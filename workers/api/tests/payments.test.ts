// Phase 5 payments: the Stripe webhook, the subscription lifecycle and Settings → Payments.
// Legacy defects (00-audit.md B6, "Stripe webhook", "Checkout") each have a test named after them.
import { SELF, env } from 'cloudflare:test';
import { sha256Hex as sha256HexForTest } from '@swarm/db';
import { newId, type PaymentsStatus } from '@swarm/domain';
import {
  createLinkKeys,
  DevStripe,
  HANDLED_STRIPE_EVENTS,
  entitledLevel,
  handleStripeEvent,
  localGoodsLinks,
  localMemberLinks,
  newCheckoutReference,
  runPaymentsLifecycle,
  signCheckoutReference,
  signStripePayload,
  type PaymentsContext,
  type StripeEvent,
  type StripeParams,
  type StripeRequestOptions,
} from '@swarm/engine';
import { DevMailbox } from '@swarm/mail';
import { newEd25519Secret, parseKeyring, signToken } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { ApiEnvSchema } from '../src/env';
import { useStripeForTests } from '../src/lib/levels';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import { legacyKeys, testLinks } from './links';

const DAY = 86_400_000;
const SECRET_A = `whsec_${'a'.repeat(32)}`;
const SECRET_B = `whsec_${'b'.repeat(32)}`;
/** The site's link keys and the api's in one: the site signs references, the api checks them. */
const memberKeys = () => testLinks();
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/** The dev fake plus Stripe's current subscription state, which the webhook re-reads. */
class TestStripe extends DevStripe {
  readonly subs = new Map<string, Record<string, unknown>>();
  override async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    const id = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (method === 'GET' && id && this.subs.has(id)) {
      this.calls.push({ method, path, params, options });
      return this.subs.get(id) as T;
    }
    return super.request<T>(method, path, params, options);
  }
}

function mail() {
  return {
    adapter: new DevMailbox(env.DEV_MAILBOX),
    platformMailDomain: 'mail.swarm.localhost',
    site: { scheme: 'http' as const, platformDomain: 'site.localhost' },
    captureOrigin: 'http://localhost:8791',
  };
}

function ctx(now: number, stripe = new TestStripe()): PaymentsContext & { stripe: TestStripe } {
  return {
    db: env.DB,
    stripe,
    links: testLinks(),
    memberLinks: localMemberLinks(testLinks()),
    goodsLinks: localGoodsLinks(testLinks()),
    fieldKeys: parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS),
    now,
    mail: mail(),
  };
}

const at = (ms: number) => Math.floor(ms / 1000);

function event(
  type: string,
  object: Record<string, unknown>,
  options: { account?: string | undefined; created: number },
): StripeEvent {
  return {
    id: `evt_${rand()}${rand()}`,
    type,
    ...(options.account ? { account: options.account } : {}),
    created: at(options.created),
    livemode: false,
    data: { object },
  };
}

interface SubInput {
  id: string;
  customer: string;
  status: string;
  price: string;
  periodEnd: number;
  trialEnd?: number;
  cancelAtPeriodEnd?: boolean;
  interval?: 'month' | 'year';
}

function sub(input: SubInput): Record<string, unknown> {
  return {
    id: input.id,
    object: 'subscription',
    customer: input.customer,
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    cancel_at: input.cancelAtPeriodEnd ? at(input.periodEnd) : null,
    canceled_at: null,
    trial_end: input.trialEnd ? at(input.trialEnd) : null,
    items: {
      object: 'list',
      data: [
        {
          id: `si_${input.id.slice(4)}`,
          quantity: 1,
          current_period_end: at(input.periodEnd),
          price: {
            id: input.price,
            currency: 'usd',
            unit_amount: 500,
            recurring: { interval: input.interval ?? 'month' },
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Seeding

interface Shop {
  session: Session;
  channelId: string;
  workspaceId: string;
  account: string;
  levelA: string;
  levelB: string;
  priceA: string;
  priceB: string;
  stripePriceA: string;
  stripePriceB: string;
}

async function connect(channelId: string, workspaceId: string, account = `acct_${rand()}`) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled, connected_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
  )
    .bind(channelId, workspaceId, account, now)
    .run();
  return account;
}

async function level(channelId: string, name: string, stripePriceId: string) {
  const now = Date.now();
  const levelId = newId('membershipLevel', now);
  const priceId = newId('levelPrice', now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, trial_days, created_at, updated_at)
       VALUES (?1, ?2, ?3, 14, ?4, ?4)`,
    ).bind(levelId, channelId, name, now),
    env.DB.prepare(
      `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, stripe_price_id, created_at)
       VALUES (?1, ?2, ?3, 'month', 'usd', 500, ?4, ?5)`,
    ).bind(priceId, levelId, channelId, stripePriceId, now),
  ]);
  return { levelId, priceId };
}

async function shop(): Promise<Shop> {
  const session = await signIn();
  const channel = await createChannel(session);
  const account = await connect(channel.id, session.workspaceId);
  const stripePriceA = `price_${rand()}`;
  const stripePriceB = `price_${rand()}`;
  const a = await level(channel.id, 'Supporter', stripePriceA);
  const b = await level(channel.id, 'Patron', stripePriceB);
  return {
    session,
    channelId: channel.id,
    workspaceId: session.workspaceId,
    account,
    levelA: a.levelId,
    levelB: b.levelId,
    priceA: a.priceId,
    priceB: b.priceId,
    stripePriceA,
    stripePriceB,
  };
}

async function checkoutRow(
  channelId: string,
  input: {
    intent: 'subscribe' | 'lifetime' | 'gift' | 'tip' | 'pledge';
    levelId?: string | null;
    priceId?: string | null;
    subjectId?: string | null;
    email?: string | null;
    memberId?: string | null;
    /** The site marks a checkout the row's Member made signed in. */
    signedIn?: boolean;
  },
): Promise<{ reference: string; signed: string }> {
  const reference = newCheckoutReference();
  await env.DB.prepare(
    `INSERT INTO checkout_sessions (reference, channel_id, subject_id, level_id, price_id, member_id, email, intent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      reference,
      channelId,
      input.subjectId ?? null,
      input.levelId ?? null,
      input.priceId ?? null,
      input.memberId ?? null,
      input.email ?? null,
      input.intent,
      Date.now(),
    )
    .run();
  return {
    reference,
    signed: await signCheckoutReference(memberKeys(), reference, Date.now(), {
      signedIn: input.signedIn ?? false,
    }),
  };
}

function session(input: {
  ref: unknown;
  email: string;
  customer: string;
  subscription?: string;
  mode?: 'subscription' | 'payment';
  amount?: number;
  paymentIntent?: string;
}): Record<string, unknown> {
  return {
    id: `cs_${rand()}`,
    object: 'checkout.session',
    // As the site sends it: a v2 reference in metadata, anything else where it was.
    ...(typeof input.ref === 'string' && input.ref.startsWith('v2.')
      ? { client_reference_id: 'plain-reference', metadata: { swarm_ref: input.ref } }
      : { client_reference_id: input.ref }),
    customer: input.customer,
    customer_details: { email: input.email },
    mode: input.mode ?? 'subscription',
    subscription: input.subscription ?? null,
    payment_intent: input.paymentIntent ?? null,
    payment_status: 'paid',
    amount_total: input.amount ?? 500,
    currency: 'usd',
  };
}

/** Subscribes a new buyer to level A; returns the Member and the Stripe ids. */
async function subscribe(
  s: Shop,
  c: ReturnType<typeof ctx>,
  options: { status?: string; email?: string; trialEnd?: number; periodEnd?: number } = {},
) {
  const email = options.email ?? uniqueEmail('buyer');
  const subId = `sub_${rand()}`;
  const customer = `cus_${rand()}`;
  const state = sub({
    id: subId,
    customer,
    status: options.status ?? 'active',
    price: s.stripePriceA,
    periodEnd: options.periodEnd ?? c.now + 30 * DAY,
    ...(options.trialEnd ? { trialEnd: options.trialEnd } : {}),
  });
  c.stripe.subs.set(subId, state);
  const row = await checkoutRow(s.channelId, {
    intent: 'subscribe',
    levelId: s.levelA,
    priceId: s.priceA,
    email,
  });
  const outcome = await handleStripeEvent(
    c,
    event(
      'checkout.session.completed',
      session({ ref: row.signed, email, customer, subscription: subId }),
      { account: s.account, created: c.now },
    ),
  );
  expect(outcome).toBe('processed');
  const member = await env.DB.prepare(
    'SELECT id, status, source_json FROM members WHERE channel_id = ?1 AND email = ?2',
  )
    .bind(s.channelId, email)
    .first<{ id: string; status: string; source_json: string }>();
  return {
    email,
    subId,
    customer,
    memberId: member!.id,
    member: member!,
    reference: row.reference,
  };
}

const subRow = (subId: string) =>
  env.DB.prepare('SELECT * FROM member_subscriptions WHERE stripe_subscription_id = ?1')
    .bind(subId)
    .first<Record<string, unknown>>();

const eventStatus = (id: string) =>
  env.DB.prepare('SELECT status, error FROM stripe_events WHERE event_id = ?1 LIMIT 1')
    .bind(id)
    .first<{ status: string; error: string | null }>();

// ---------------------------------------------------------------------------------------------
// The webhook endpoint

/** Posts raw bytes the way Stripe does: no Origin, no cookie, JSON content type. */
function fetchRaw(body: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch('http://localhost/api/v1/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('Stripe webhook endpoint', () => {
  const payload = (account?: string) =>
    JSON.stringify(
      event('account.updated', { id: account ?? 'acct_none' }, { created: Date.now(), account }),
    );

  it('legacy: refuses a request with no signature (never a dev bypass)', async () => {
    const res = await fetchRaw(payload(), { 'content-type': 'application/json' });
    expect(res.status).toBe(400);
  });

  it('refuses a wrong secret, a changed body and a malformed header', async () => {
    const body = payload();
    const wrong = await signStripePayload(body, `whsec_${'z'.repeat(32)}`);
    expect((await fetchRaw(body, { 'stripe-signature': wrong })).status).toBe(400);
    const good = await signStripePayload(body, SECRET_A);
    expect((await fetchRaw(`${body} `, { 'stripe-signature': good })).status).toBe(400);
    expect((await fetchRaw(body, { 'stripe-signature': 'v1=abc' })).status).toBe(400);
  });

  it('legacy: refuses a signature outside the 300-second tolerance', async () => {
    const body = payload();
    const old = await signStripePayload(body, SECRET_A, Date.now() - 301_000);
    expect((await fetchRaw(body, { 'stripe-signature': old })).status).toBe(400);
  });

  it('legacy: accepts when any of several v1 signatures matches, with either rotated secret', async () => {
    const body = payload();
    const good = await signStripePayload(body, SECRET_B);
    const [t, v1] = good.split(',');
    const header = `${t},v1=${'0'.repeat(64)},${v1}`;
    const res = await fetchRaw(body, { 'stripe-signature': header });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('legacy: a replayed event id is processed once', async () => {
    const s = await shop();
    const body = JSON.stringify(
      event(
        'account.updated',
        { id: s.account, charges_enabled: true, payouts_enabled: true, details_submitted: true },
        { account: s.account, created: Date.now() },
      ),
    );
    const sign = async () => ({ 'stripe-signature': await signStripePayload(body, SECRET_A) });
    const first = await fetchRaw(body, await sign());
    expect((await json<{ data: { outcome: string } }>(first)).data.outcome).toBe('processed');
    const again = await fetchRaw(body, await sign());
    expect(again.status).toBe(200);
    expect((await json<{ data: { outcome: string } }>(again)).data.outcome).toBe('duplicate');
  });

  it('answers 500 on a processing error, records it, and reprocesses the retry', async () => {
    const s = await shop();
    const object = { id: s.account, charges_enabled: true, default_currency: 'xxx' };
    const evt = event('account.updated', object, { account: s.account, created: Date.now() });
    const body = JSON.stringify(evt);
    await env.DB.prepare(
      `CREATE TRIGGER fail_account_update BEFORE UPDATE ON stripe_accounts
       WHEN NEW.default_currency = 'xxx' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    ).run();
    try {
      const res = await fetchRaw(body, {
        'stripe-signature': await signStripePayload(body, SECRET_A),
      });
      expect(res.status).toBe(500);
      expect(await eventStatus(evt.id)).toMatchObject({ status: 'failed' });
      expect((await eventStatus(evt.id))?.error).toContain('simulated failure');
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_account_update').run();
    }
    const retry = await fetchRaw(body, {
      'stripe-signature': await signStripePayload(body, SECRET_A),
    });
    expect(retry.status).toBe(200);
    expect((await json<{ data: { outcome: string } }>(retry)).data.outcome).toBe('processed');
    expect(await eventStatus(evt.id)).toMatchObject({ status: 'processed', error: null });
  });

  it('legacy: an empty webhook secret is refused when the environment is parsed', () => {
    const base = {
      ...env,
      PAYMENTS: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_0123456789',
      STRIPE_CONNECT_CLIENT_ID: 'ca_0123456789',
    };
    for (const secrets of ['', ' , ', 'whsec_short', 'not-a-secret-at-all-0000000000']) {
      const parsed = ApiEnvSchema.safeParse({ ...base, STRIPE_WEBHOOK_SECRETS: secrets });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(
        'STRIPE_WEBHOOK_SECRETS',
      );
    }
    const { STRIPE_WEBHOOK_SECRETS: _, ...missing } = base;
    expect(ApiEnvSchema.safeParse(missing).success).toBe(false);
    expect(ApiEnvSchema.safeParse({ ...base, STRIPE_WEBHOOK_SECRETS: SECRET_A }).success).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Event processing

describe('handleStripeEvent', () => {
  it('ignores events from unknown accounts and platform events', async () => {
    const c = ctx(Date.now());
    expect(
      await handleStripeEvent(c, event('account.updated', { id: 'acct_x' }, { created: c.now })),
    ).toBe('ignored');
    expect(
      await handleStripeEvent(
        c,
        event(
          'account.updated',
          { id: 'acct_unknown' },
          { account: 'acct_unknown', created: c.now },
        ),
      ),
    ).toBe('ignored');
  });

  it("tenancy: account A's events can never touch Channel B", async () => {
    const a = await shop();
    const b = await shop();
    const now = Date.now();
    const c = ctx(now);

    // B's checkout reference delivered through A's account.
    const rowB = await checkoutRow(b.channelId, {
      intent: 'subscribe',
      levelId: b.levelA,
      priceId: b.priceA,
    });
    const email = uniqueEmail('crossed');
    const subId = `sub_${rand()}`;
    c.stripe.subs.set(
      subId,
      sub({
        id: subId,
        customer: 'cus_x',
        status: 'active',
        price: b.stripePriceA,
        periodEnd: now + 30 * DAY,
      }),
    );
    const crossed = event(
      'checkout.session.completed',
      session({ ref: rowB.signed, email, customer: 'cus_x', subscription: subId }),
      { account: a.account, created: now },
    );
    expect(await handleStripeEvent(c, crossed)).toBe('ignored');
    const open = await env.DB.prepare('SELECT status FROM checkout_sessions WHERE reference = ?1')
      .bind(rowB.reference)
      .first<{ status: string }>();
    expect(open?.status).toBe('open');
    expect(await subRow(subId)).toBeNull();
    for (const channel of [a.channelId, b.channelId]) {
      const member = await env.DB.prepare(
        'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
      )
        .bind(channel, email)
        .first();
      expect(member).toBeNull();
    }

    // B's real subscription, deleted through A's account.
    const bought = await subscribe(b, c);
    const deleted = event(
      'customer.subscription.deleted',
      sub({
        id: bought.subId,
        customer: bought.customer,
        status: 'canceled',
        price: b.stripePriceA,
        periodEnd: now,
      }),
      { account: a.account, created: now + 1000 },
    );
    expect(await handleStripeEvent(ctx(now + 1000, c.stripe), deleted)).toBe('ignored');
    expect((await subRow(bought.subId))?.status).toBe('active');
    expect(await entitledLevel(env.DB, b.channelId, bought.memberId, now + 2000)).toBe(b.levelA);

    // A's account object can't rewrite B's account flags.
    const flags = event(
      'account.updated',
      { id: b.account, charges_enabled: false },
      { account: a.account, created: now },
    );
    expect(await handleStripeEvent(c, flags)).toBe('ignored');
    const accountB = await env.DB.prepare(
      'SELECT charges_enabled FROM stripe_accounts WHERE channel_id = ?1',
    )
      .bind(b.channelId)
      .first<{ charges_enabled: number }>();
    expect(accountB?.charges_enabled).toBe(1);
  });

  it("tenancy: another account's event with the same id never takes over or settles a claim", async () => {
    const a = await shop();
    const b = await shop();
    const flagsOf = (channelId: string) =>
      env.DB.prepare('SELECT charges_enabled FROM stripe_accounts WHERE channel_id = ?1')
        .bind(channelId)
        .first<{ charges_enabled: number }>();
    const claimOf = (account: string, id: string) =>
      env.DB.prepare(
        'SELECT status, channel_id FROM stripe_events WHERE stripe_account_id = ?1 AND event_id = ?2',
      )
        .bind(account, id)
        .first<{ status: string; channel_id: string | null }>();
    for (const seeded of ['failed', 'stale'] as const) {
      const now = Date.now();
      // A's genuine event, left failed or stuck in 'received' past the window.
      const genuine = event(
        'account.updated',
        { id: a.account, charges_enabled: false },
        { account: a.account, created: now },
      );
      await env.DB.prepare(
        `INSERT INTO stripe_events (event_id, stripe_account_id, type, livemode, status, created_at, received_at)
         VALUES (?1, ?2, 'account.updated', 0, ?3, ?4, ?4)`,
      )
        .bind(genuine.id, a.account, seeded === 'failed' ? 'failed' : 'received', now - 3_600_000)
        .run();
      // B signs an event with that id for its own endpoint (the own-key route sets B's account).
      const forged = { ...genuine, account: b.account, data: { object: { id: b.account } } };
      expect(await handleStripeEvent(ctx(now), forged)).toBe('processed');
      expect(await claimOf(a.account, genuine.id)).toEqual({
        status: seeded === 'failed' ? 'failed' : 'received',
        channel_id: null,
      });
      // A's redelivery is applied in A.
      expect(await handleStripeEvent(ctx(now + 1000), genuine)).toBe('processed');
      expect(await claimOf(a.account, genuine.id)).toEqual({
        status: 'processed',
        channel_id: a.channelId,
      });
      expect((await flagsOf(a.channelId))?.charges_enabled).toBe(0);
      await env.DB.prepare('UPDATE stripe_accounts SET charges_enabled = 1 WHERE channel_id = ?1')
        .bind(a.channelId)
        .run();
    }
  });

  it('legacy B6: an empty, unsigned or forged client_reference_id is ignored', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const row = await checkoutRow(s.channelId, {
      intent: 'subscribe',
      levelId: s.levelA,
      priceId: s.priceA,
    });
    // Another Ed25519 key, as a holder of any key but the site's own would sign it.
    const otherKey = `x1:${await newEd25519Secret()}`;
    const otherKeys = createLinkKeys({
      mode: { signing: 'v2', legacyCutoffMs: 0 },
      rings: { CHECKOUT_SIGNING_KEYS: otherKey },
    });
    const forged = [
      '',
      null,
      `${s.channelId}:`,
      `${s.channelId}:${s.levelA}`,
      row.reference,
      await signCheckoutReference(otherKeys, row.reference),
      await signCheckoutReference(memberKeys(), newCheckoutReference()),
      // MEMBER_KEYS after the cutover: nothing signs with it any more.
      await signToken(
        legacyKeys(),
        'checkout-ref',
        { r: row.reference },
        { expiresInSeconds: 3600 },
      ),
    ];
    for (const ref of forged) {
      const evt = event(
        'checkout.session.completed',
        session({
          ref,
          email: uniqueEmail('forged'),
          customer: 'cus_f',
          subscription: 'sub_forged',
        }),
        { account: s.account, created: c.now },
      );
      expect(await handleStripeEvent(c, evt)).toBe('ignored');
      expect((await eventStatus(evt.id))?.status).toBe('ignored');
    }
    expect(await subRow('sub_forged')).toBeNull();
  });

  /** What a checkout left on a Member: status, consent and confirmation, history and mail. */
  async function buyerRecord(memberId: string) {
    const member = await env.DB.prepare(
      'SELECT status, consent_at, confirmed_at, source_json FROM members WHERE id = ?1',
    )
      .bind(memberId)
      .first<{
        status: string;
        consent_at: number | null;
        confirmed_at: number | null;
        source_json: string | null;
      }>();
    const confirmed = await env.DB.prepare(
      `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'confirmed'`,
    )
      .bind(memberId)
      .first<{ n: number }>();
    const consents = await env.DB.prepare(
      'SELECT source, must_confirm FROM member_consents WHERE member_id = ?1 ORDER BY id',
    )
      .bind(memberId)
      .all<{ source: string; must_confirm: number }>();
    const requests = await env.DB.prepare(
      `SELECT count(*) AS n FROM confirm_requests WHERE member_id = ?1 AND kind = 'subscribe'`,
    )
      .bind(memberId)
      .first<{ n: number }>();
    return {
      ...member!,
      confirmedEvents: confirmed!.n,
      consents: consents.results,
      confirmMails: requests!.n,
    };
  }

  async function addMember(channelId: string, email: string, status: string) {
    const id = newId('member');
    await env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(id, channelId, email, status, Date.now())
      .run();
    return id;
  }

  it('takes a reference the site signed, and a v1 one from before the cutover, as an older site sent it', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    // The site signs with its private key; the api holds only the public one.
    await expect(
      signCheckoutReference(
        createLinkKeys({
          mode: { signing: 'v2', legacyCutoffMs: 0 },
          rings: {
            CHECKOUT_VERIFY_KEYS: (env as unknown as Record<string, string>).CHECKOUT_VERIFY_KEYS!,
          },
        }),
        'x',
      ),
    ).rejects.toThrow(/CHECKOUT_SIGNING_KEYS/);
    const row = await checkoutRow(s.channelId, {
      intent: 'subscribe',
      levelId: s.levelA,
      priceId: s.priceA,
    });
    const old = await signToken(
      legacyKeys(),
      'checkout-ref',
      { r: row.reference },
      {
        expiresInSeconds: 30 * 86_400,
        now: Number(env.LINK_LEGACY_CUTOFF) - 60_000,
      },
    );
    const subId = `sub_${rand()}`;
    c.stripe.subs.set(
      subId,
      sub({
        id: subId,
        customer: 'cus_old',
        status: 'active',
        price: s.stripePriceA,
        periodEnd: c.now + 30 * DAY,
      }),
    );
    const evt = event(
      'checkout.session.completed',
      session({ ref: old, email: uniqueEmail('old'), customer: 'cus_old', subscription: subId }),
      { account: s.account, created: c.now },
    );
    expect(await handleStripeEvent(c, evt)).toBe('processed');
  });

  it('a new buyer is a pending Member with a checkout consent record, mailed to confirm', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const fresh = await subscribe(s, c);
    expect(JSON.parse(fresh.member.source_json)).toMatchObject({ kind: 'checkout' });
    // Paid for: the purchase is the Member's from the start.
    expect(await entitledLevel(env.DB, s.channelId, fresh.memberId, c.now)).toBe(s.levelA);
    // But nobody confirmed the address, so nothing says they did.
    expect(await buyerRecord(fresh.memberId)).toMatchObject({
      status: 'pending',
      consent_at: null,
      confirmed_at: null,
      confirmedEvents: 0,
      consents: [{ source: 'checkout', must_confirm: 1 }],
      confirmMails: 1,
    });
    const customer = await env.DB.prepare(
      'SELECT stripe_customer_id FROM stripe_customers WHERE member_id = ?1',
    )
      .bind(fresh.memberId)
      .first<{ stripe_customer_id: string }>();
    expect(customer?.stripe_customer_id).toBe(fresh.customer);
    const checkout = await env.DB.prepare(
      'SELECT status, member_id FROM checkout_sessions WHERE reference = ?1',
    )
      .bind(fresh.reference)
      .first<{ status: string; member_id: string }>();
    expect(checkout).toEqual({ status: 'complete', member_id: fresh.memberId });
  });

  it("paying with a pending Member's address leaves them pending until the address confirms", async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const pendingEmail = uniqueEmail('pending');
    const pendingId = await addMember(s.channelId, pendingEmail, 'pending');
    const pending = await subscribe(s, c, { email: pendingEmail });
    expect(pending.memberId).toBe(pendingId);
    expect(await buyerRecord(pendingId)).toMatchObject({
      status: 'pending',
      consent_at: null,
      confirmed_at: null,
      confirmedEvents: 0,
      consents: [],
      confirmMails: 1,
    });
    // The purchase is held for that Member: it is usable once they confirm and sign in.
    expect(await entitledLevel(env.DB, s.channelId, pendingId, c.now)).toBe(s.levelA);

    // An unsubscribed Member keeps their email status but gets what they paid for.
    const goneEmail = uniqueEmail('gone');
    const goneId = await addMember(s.channelId, goneEmail, 'unsubscribed');
    await subscribe(s, c, { email: goneEmail });
    expect(await buyerRecord(goneId)).toMatchObject({
      status: 'unsubscribed',
      confirmed_at: null,
      confirmedEvents: 0,
      confirmMails: 0,
    });
    expect(await entitledLevel(env.DB, s.channelId, goneId, c.now)).toBe(s.levelA);
  });

  it('a suppressed pending Member stays pending and is not mailed', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const email = uniqueEmail('suppressed');
    const id = await addMember(s.channelId, email, 'pending');
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', ?4)`,
    )
      .bind(newId('suppression'), s.workspaceId, email, c.now)
      .run();
    await subscribe(s, c, { email });
    expect(await buyerRecord(id)).toMatchObject({
      status: 'pending',
      confirmed_at: null,
      confirmedEvents: 0,
      confirmMails: 0,
    });
  });

  it("the row's pending Member is untouched when the session reports another address or no entitlement", async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const typed = uniqueEmail('typed');
    const pendingId = await addMember(s.channelId, typed, 'pending');
    for (const status of ['incomplete', 'unpaid', 'active']) {
      const subId = `sub_${rand()}`;
      const customer = `cus_${rand()}`;
      c.stripe.subs.set(
        subId,
        sub({ id: subId, customer, status, price: s.stripePriceA, periodEnd: c.now + 30 * DAY }),
      );
      // The site set member_id from the typed address; Stripe reports what the payer entered.
      const row = await checkoutRow(s.channelId, {
        intent: 'subscribe',
        levelId: s.levelA,
        priceId: s.priceA,
        email: typed,
        memberId: pendingId,
      });
      const evt = event(
        'checkout.session.completed',
        {
          ...session({
            ref: row.signed,
            email: uniqueEmail('payer'),
            customer,
            subscription: subId,
          }),
          payment_status: status === 'active' ? 'paid' : 'unpaid',
        },
        { account: s.account, created: c.now },
      );
      expect(await handleStripeEvent(c, evt)).toBe('processed');
      expect(await buyerRecord(pendingId)).toMatchObject({
        status: 'pending',
        consent_at: null,
        confirmed_at: null,
        confirmedEvents: 0,
      });
    }
  });

  it('a signed-in buyer keeps their confirmed membership and gets access at once', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const email = uniqueEmail('reader');
    const id = await addMember(s.channelId, email, 'active');
    const subId = `sub_${rand()}`;
    const customer = `cus_${rand()}`;
    c.stripe.subs.set(
      subId,
      sub({
        id: subId,
        customer,
        status: 'active',
        price: s.stripePriceA,
        periodEnd: c.now + 30 * DAY,
      }),
    );
    const row = await checkoutRow(s.channelId, {
      intent: 'subscribe',
      levelId: s.levelA,
      priceId: s.priceA,
      email,
      memberId: id,
      signedIn: true,
    });
    expect(
      await handleStripeEvent(
        c,
        event(
          'checkout.session.completed',
          session({ ref: row.signed, email, customer, subscription: subId }),
          { account: s.account, created: c.now },
        ),
      ),
    ).toBe('processed');
    expect(await buyerRecord(id)).toMatchObject({ status: 'active', confirmMails: 0 });
    expect(await entitledLevel(env.DB, s.channelId, id, c.now)).toBe(s.levelA);
  });

  it("an anonymous checkout with a Member's email never links its customer to that Member", async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const email = uniqueEmail('victim');
    const memberId = newId('member');
    await env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    )
      .bind(memberId, s.channelId, email, c.now)
      .run();
    const customerOf = (id: string) =>
      env.DB.prepare('SELECT stripe_customer_id FROM stripe_customers WHERE member_id = ?1')
        .bind(id)
        .first<{ stripe_customer_id: string }>();
    const complete = async (
      intent: 'subscribe' | 'lifetime' | 'tip',
      options: { memberId?: string; signedIn?: boolean } = {},
    ) => {
      const customer = `cus_${rand()}`;
      const subId = `sub_${rand()}`;
      if (intent === 'subscribe') {
        c.stripe.subs.set(
          subId,
          sub({
            id: subId,
            customer,
            status: 'active',
            price: s.stripePriceA,
            periodEnd: c.now + 30 * DAY,
          }),
        );
      }
      // The site sets member_id for a typed email that matches a Member, signed in or not.
      const row = await checkoutRow(s.channelId, {
        intent,
        levelId: intent === 'tip' ? null : s.levelA,
        priceId: intent === 'tip' ? null : s.priceA,
        email,
        memberId: options.memberId ?? memberId,
        signedIn: options.signedIn ?? false,
      });
      const outcome = await handleStripeEvent(
        c,
        event(
          'checkout.session.completed',
          session({
            ref: row.signed,
            email,
            customer,
            ...(intent === 'subscribe'
              ? { subscription: subId }
              : { mode: 'payment' as const, paymentIntent: `pi_${rand()}` }),
          }),
          { account: s.account, created: c.now },
        ),
      );
      expect(outcome).toBe('processed');
      return customer;
    };

    // Anyone typing the address: the purchase is still the Member's, the customer is not.
    for (const intent of ['subscribe', 'lifetime', 'tip'] as const) {
      await complete(intent);
      expect(await customerOf(memberId)).toBeNull();
    }
    expect(await entitledLevel(env.DB, s.channelId, memberId, c.now)).toBe(s.levelA);

    // The Member signed in: their checkout links its customer.
    const own = await complete('tip', { signedIn: true });
    expect((await customerOf(memberId))?.stripe_customer_id).toBe(own);

    // A Member the checkout created is linked as before.
    const fresh = await subscribe(s, c);
    expect((await customerOf(fresh.memberId))?.stripe_customer_id).toBe(fresh.customer);
  });

  it('lifecycle: trial → active → payment failed → grace → cron downgrade → paid again', async () => {
    const s = await shop();
    const t0 = Date.now();
    const stripe = new TestStripe();
    const seen = new Set<string>();
    const send = async (now: number, type: string, object: Record<string, unknown>) => {
      const outcome = await handleStripeEvent(
        ctx(now, stripe),
        event(type, object, { account: s.account, created: now }),
      );
      if (outcome === 'processed') seen.add(type);
      return outcome;
    };

    // Trial (card required): entitled, and the email has used its trial.
    const trialEnd = t0 + 14 * DAY;
    const bought = await subscribe(s, ctx(t0, stripe), {
      status: 'trialing',
      trialEnd,
      periodEnd: trialEnd,
    });
    seen.add('checkout.session.completed');
    expect((await subRow(bought.subId))?.status).toBe('trialing');
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, t0)).toBe(s.levelA);
    const claim = await env.DB.prepare(
      'SELECT level_id FROM trial_claims WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(s.channelId, bought.email)
      .first<{ level_id: string }>();
    expect(claim?.level_id).toBe(s.levelA);

    const state = (status: string, periodEnd: number) => {
      const object = sub({
        id: bought.subId,
        customer: bought.customer,
        status,
        price: s.stripePriceA,
        periodEnd,
      });
      stripe.subs.set(bought.subId, object);
      return object;
    };
    const invoice = (id: string, amount: number) => ({
      id,
      object: 'invoice',
      customer: bought.customer,
      amount_paid: amount,
      currency: 'usd',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: bought.subId },
      },
      status_transitions: { paid_at: null },
    });

    // Trial notice.
    expect(
      await send(trialEnd - 3 * DAY, 'customer.subscription.trial_will_end', {
        ...state('trialing', trialEnd),
      }),
    ).toBe('processed');
    const notice = (await mail().adapter.list({ to: bought.email, limit: 1 }))[0];
    expect(notice?.category).toBe('trial_ending');

    // Trial converts.
    const t1 = trialEnd;
    expect(await send(t1, 'customer.subscription.updated', state('active', t1 + 30 * DAY))).toBe(
      'processed',
    );
    expect(await send(t1 + 1000, 'invoice.paid', invoice(`in_${rand()}`, 500))).toBe('processed');
    expect((await subRow(bought.subId))?.status).toBe('active');
    const paid = await env.DB.prepare(
      `SELECT count(*) AS n FROM payments WHERE member_id = ?1 AND kind = 'invoice'`,
    )
      .bind(bought.memberId)
      .first<{ n: number }>();
    expect(paid?.n).toBe(1);

    // Renewal fails: grace starts at the first failure.
    const t2 = t1 + 30 * DAY;
    expect(await send(t2, 'invoice.payment_failed', invoice(`in_${rand()}`, 0))).toBe('processed');
    expect(
      await send(t2 + 1000, 'customer.subscription.updated', state('past_due', t2 + 30 * DAY)),
    ).toBe('processed');
    const graced = await subRow(bought.subId);
    expect(graced?.status).toBe('past_due');
    expect(graced?.grace_until).toBe(t2 + 7 * DAY);
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, t2 + 6 * DAY)).toBe(s.levelA);

    // A second failure doesn't push grace back.
    await send(t2 + 3 * DAY, 'invoice.payment_failed', invoice(`in_${rand()}`, 0));
    expect((await subRow(bought.subId))?.grace_until).toBe(t2 + 7 * DAY);

    // Grace runs out: the cron downgrades.
    const t3 = t2 + 8 * DAY;
    await runPaymentsLifecycle(env.DB, stripe, t3);
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, t3)).toBeUndefined();
    const cached = await env.DB.prepare('SELECT 1 FROM member_entitlements WHERE member_id = ?1')
      .bind(bought.memberId)
      .first();
    expect(cached).toBeNull();

    // The card is updated and the invoice paid: access is back.
    state('active', t2 + 30 * DAY);
    expect(await send(t3 + 1000, 'invoice.paid', invoice(`in_${rand()}`, 500))).toBe('processed');
    const recovered = await subRow(bought.subId);
    expect(recovered).toMatchObject({ status: 'active', grace_until: null });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, t3 + 2000)).toBe(s.levelA);

    // Legacy: more than checkout.session.completed is handled.
    for (const type of [
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.trial_will_end',
      'invoice.paid',
      'invoice.payment_failed',
    ]) {
      expect(seen.has(type), type).toBe(true);
    }
    expect([...HANDLED_STRIPE_EVENTS].sort()).toEqual(
      [
        'account.updated',
        'charge.dispute.created',
        'charge.refunded',
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'customer.subscription.trial_will_end',
        'customer.subscription.updated',
        'invoice.paid',
        'invoice.payment_failed',
      ].sort(),
    );
  });

  it('upgrade: a new price moves the Member to its level', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const upgraded = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'active',
      price: s.stripePriceB,
      periodEnd: now + 30 * DAY,
    });
    c.stripe.subs.set(bought.subId, upgraded);
    expect(
      await handleStripeEvent(
        ctx(now + 1000, c.stripe),
        event('customer.subscription.updated', upgraded, {
          account: s.account,
          created: now + 1000,
        }),
      ),
    ).toBe('processed');
    expect(await subRow(bought.subId)).toMatchObject({ level_id: s.levelB, price_id: s.priceB });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, now + 2000)).toBe(s.levelB);
  });

  it('captures recurring discounts for MRR: forever, repeating with its end, never once', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const base = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'active',
      price: s.stripePriceA,
      periodEnd: now + 30 * DAY,
    });
    let created = now;
    const update = async (discounts: unknown[], expanded?: unknown[]) => {
      created += 1000;
      // The event carries discount ids; the webhook reads them again, expanded.
      c.stripe.subs.set(bought.subId, { ...base, discounts: expanded ?? discounts });
      const outcome = await handleStripeEvent(
        ctx(created, c.stripe),
        event(
          'customer.subscription.updated',
          { ...base, discounts },
          { account: s.account, created },
        ),
      );
      expect(outcome).toBe('processed');
      return subRow(bought.subId);
    };
    const repeatingEnd = at(now + 90 * DAY);

    // 'forever' 20% off, clover shape (discount.source.coupon), expanded in the payload.
    const forever = {
      id: 'di_forever',
      end: null,
      source: { type: 'coupon', coupon: { id: 'c1', percent_off: 20, duration: 'forever' } },
    };
    expect(await update([forever])).toMatchObject({
      amount: 500,
      discounted_amount: 400,
      discount_end: null,
    });

    // 'repeating' 150 off for three months, as ids: read again with expand[]=discounts.
    const repeating = {
      id: 'di_repeating',
      end: repeatingEnd,
      source: {
        type: 'coupon',
        coupon: { id: 'c2', amount_off: 150, currency: 'usd', duration: 'repeating' },
      },
    };
    expect(await update(['di_repeating'], [repeating])).toMatchObject({
      discounted_amount: 350,
      discount_end: repeatingEnd * 1000,
    });
    const reread = [...c.stripe.calls]
      .reverse()
      .find((call) => call.method === 'GET' && call.path === `/v1/subscriptions/${bought.subId}`);
    expect(reread?.params).toEqual({ expand: ['discounts'] });

    // A coupon id only (pre-clover shape) resolves through our coupons table.
    await env.DB.prepare(
      `INSERT INTO coupons (id, channel_id, code, percent_off, duration, stripe_coupon_id, created_at)
       VALUES (?1, ?2, ?3, 10, 'forever', 'c_ours', ?4)`,
    )
      .bind(newId('coupon', now), s.channelId, `TEN${rand().slice(0, 6)}`, now)
      .run();
    expect(await update([{ id: 'di_ours', end: null, coupon: 'c_ours' }])).toMatchObject({
      discounted_amount: 450,
    });

    // 'once' never changes recurring revenue.
    const once = {
      id: 'di_once',
      end: null,
      coupon: { id: 'c3', percent_off: 50, duration: 'once' },
    };
    expect(await update([once])).toMatchObject({ discounted_amount: null, discount_end: null });

    // Ids that can't be read keep what the row had; no discount clears it.
    await update([forever]);
    expect(await update(['di_unreadable'], ['di_unreadable'])).toMatchObject({
      discounted_amount: 400,
    });
    expect(await update([])).toMatchObject({ discounted_amount: null });
  });

  it('cancel at period end: access until the end, none after the deletion', async () => {
    const s = await shop();
    const now = Date.now();
    const periodEnd = now + 30 * DAY;
    const c = ctx(now);
    const bought = await subscribe(s, c, { periodEnd });
    const canceling = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'active',
      price: s.stripePriceA,
      periodEnd,
      cancelAtPeriodEnd: true,
    });
    await handleStripeEvent(
      ctx(now + 1000, c.stripe),
      event('customer.subscription.updated', canceling, {
        account: s.account,
        created: now + 1000,
      }),
    );
    expect(await subRow(bought.subId)).toMatchObject({ cancel_at_period_end: 1, status: 'active' });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, periodEnd - DAY)).toBe(
      s.levelA,
    );

    const ended = { ...canceling, status: 'canceled', canceled_at: at(periodEnd) };
    expect(
      await handleStripeEvent(
        ctx(periodEnd, c.stripe),
        event('customer.subscription.deleted', ended, { account: s.account, created: periodEnd }),
      ),
    ).toBe('processed');
    expect(await subRow(bought.subId)).toMatchObject({
      status: 'canceled',
      revoke_reason: 'canceled',
    });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, periodEnd)).toBeUndefined();
  });

  it('legacy: a full refund revokes immediately and stops billing', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const invoiceId = `in_${rand()}`;
    await handleStripeEvent(
      c,
      event(
        'invoice.paid',
        {
          id: invoiceId,
          customer: bought.customer,
          amount_paid: 500,
          currency: 'usd',
          parent: { subscription_details: { subscription: bought.subId } },
        },
        { account: s.account, created: now },
      ),
    );
    const charge = {
      id: `ch_${rand()}`,
      object: 'charge',
      amount: 500,
      amount_refunded: 500,
      refunded: true,
      currency: 'usd',
      customer: bought.customer,
      invoice: invoiceId,
    };
    expect(
      await handleStripeEvent(
        ctx(now + 1000, c.stripe),
        event('charge.refunded', charge, { account: s.account, created: now + 1000 }),
      ),
    ).toBe('processed');
    expect(await subRow(bought.subId)).toMatchObject({ revoke_reason: 'refund' });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, now + 2000)).toBeUndefined();
    expect(
      c.stripe.calls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.path === `/v1/subscriptions/${bought.subId}` &&
          call.options.account === s.account,
      ),
    ).toBe(true);
    const refund = await env.DB.prepare(
      `SELECT amount FROM payments WHERE member_id = ?1 AND kind = 'refund'`,
    )
      .bind(bought.memberId)
      .first<{ amount: number }>();
    expect(refund?.amount).toBe(-500);

    // A later renewal webhook can't bring access back.
    const later = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'active',
      price: s.stripePriceA,
      periodEnd: now + 60 * DAY,
    });
    await handleStripeEvent(
      ctx(now + 3000, c.stripe),
      event('customer.subscription.updated', later, { account: s.account, created: now + 3000 }),
    );
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, now + 4000)).toBeUndefined();
  });

  it('a partial refund records money but keeps access', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const charge = {
      id: `ch_${rand()}`,
      amount: 500,
      amount_refunded: 200,
      refunded: false,
      currency: 'usd',
      customer: bought.customer,
    };
    await handleStripeEvent(
      c,
      event('charge.refunded', charge, { account: s.account, created: now }),
    );
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, now)).toBe(s.levelA);
    const refund = await env.DB.prepare(
      `SELECT sum(amount) AS total FROM payments WHERE channel_id = ?1 AND kind = 'refund'`,
    )
      .bind(s.channelId)
      .first<{ total: number }>();
    expect(refund?.total).toBe(-200);
  });

  it("a full refund or dispute of a one-time purchase leaves the buyer's subscription alone", async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const kept = async (at: number) => {
      expect((await subRow(bought.subId))?.revoked_at).toBeNull();
      expect(await entitledLevel(env.DB, s.channelId, bought.memberId, at)).toBe(s.levelA);
      expect(
        c.stripe.calls.some(
          (call) => call.method === 'DELETE' && call.path === `/v1/subscriptions/${bought.subId}`,
        ),
      ).toBe(false);
    };
    // Two tips on the subscriber's own Stripe customer: one refunded in full, one disputed.
    const tip = async () => {
      const paymentIntent = `pi_${rand()}`;
      const row = await checkoutRow(s.channelId, { intent: 'tip', email: bought.email });
      await handleStripeEvent(
        c,
        event(
          'checkout.session.completed',
          session({
            ref: row.signed,
            email: bought.email,
            customer: bought.customer,
            mode: 'payment',
            amount: 300,
            paymentIntent,
          }),
          { account: s.account, created: now },
        ),
      );
      const paid = await env.DB.prepare(
        'SELECT kind, subscription_id FROM payments WHERE stripe_object_id = ?1',
      )
        .bind(paymentIntent)
        .first();
      expect(paid).toEqual({ kind: 'one_time', subscription_id: null });
      return paymentIntent;
    };
    const refunded = await tip();
    await handleStripeEvent(
      ctx(now + 1000, c.stripe),
      event(
        'charge.refunded',
        {
          id: `ch_${rand()}`,
          object: 'charge',
          amount: 300,
          amount_refunded: 300,
          refunded: true,
          currency: 'usd',
          customer: bought.customer,
          payment_intent: refunded,
          invoice: null,
        },
        { account: s.account, created: now + 1000 },
      ),
    );
    await kept(now + 2000);
    const disputed = await tip();
    await handleStripeEvent(
      ctx(now + 3000, c.stripe),
      event(
        'charge.dispute.created',
        {
          id: `dp_${rand()}`,
          object: 'dispute',
          payment_intent: disputed,
          charge: {
            id: `ch_${rand()}`,
            customer: bought.customer,
            invoice: null,
            payment_intent: disputed,
          },
        },
        { account: s.account, created: now + 3000 },
      ),
    );
    await kept(now + 4000);

    // A good refunded in Stripe ends the order, not the subscription.
    const goodId = `good_${rand()}`;
    const orderId = `go_${rand()}`;
    const goodIntent = `pi_${rand()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO goods (id, channel_id, slug, name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Guide', 'published', ?4, ?4)`,
      ).bind(goodId, s.channelId, `guide-${rand()}`, now),
      env.DB.prepare(
        `INSERT INTO good_orders (id, channel_id, good_id, member_id, email, amount, currency, status, payment_intent_id, created_at, paid_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 900, 'usd', 'paid', ?6, ?7, ?7)`,
      ).bind(orderId, s.channelId, goodId, bought.memberId, bought.email, goodIntent, now),
      env.DB.prepare(
        `INSERT INTO payments (id, channel_id, member_id, subscription_id, kind, stripe_object_id, currency, amount, occurred_at)
         VALUES (?1, ?2, ?3, NULL, 'one_time', ?4, 'usd', 900, ?5)`,
      ).bind(newId('payment', now), s.channelId, bought.memberId, goodIntent, now),
    ]);
    expect(
      await handleStripeEvent(
        ctx(now + 5000, c.stripe),
        event(
          'charge.refunded',
          {
            id: `ch_${rand()}`,
            object: 'charge',
            amount: 900,
            amount_refunded: 900,
            refunded: true,
            currency: 'usd',
            customer: bought.customer,
            payment_intent: goodIntent,
            invoice: null,
          },
          { account: s.account, created: now + 5000 },
        ),
      ),
    ).toBe('processed');
    await kept(now + 6000);
    const order = await env.DB.prepare('SELECT status FROM good_orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string }>();
    expect(order?.status).toBe('refunded');
  });

  it('out-of-order events: an older update never overwrites newer state', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const newer = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'active',
      price: s.stripePriceB,
      periodEnd: now + 60 * DAY,
    });
    const older = sub({
      id: bought.subId,
      customer: bought.customer,
      status: 'past_due',
      price: s.stripePriceA,
      periodEnd: now + 30 * DAY,
    });
    await handleStripeEvent(
      ctx(now + 10_000, c.stripe),
      event('customer.subscription.updated', newer, { account: s.account, created: now + 10_000 }),
    );
    expect(
      await handleStripeEvent(
        ctx(now + 20_000, c.stripe),
        event('customer.subscription.updated', older, { account: s.account, created: now + 5_000 }),
      ),
    ).toBe('ignored');
    expect(await subRow(bought.subId)).toMatchObject({
      status: 'active',
      level_id: s.levelB,
      grace_until: null,
    });

    // A deletion is final: a late update doesn't revive it.
    const deleted = { ...newer, status: 'canceled' };
    await handleStripeEvent(
      ctx(now + 30_000, c.stripe),
      event('customer.subscription.deleted', deleted, {
        account: s.account,
        created: now + 30_000,
      }),
    );
    await handleStripeEvent(
      ctx(now + 40_000, c.stripe),
      event('customer.subscription.updated', newer, { account: s.account, created: now + 40_000 }),
    );
    expect((await subRow(bought.subId))?.status).toBe('canceled');
  });

  it('lifetime: a one-time payment grants access with no end; a dispute revokes it', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const email = uniqueEmail('lifetime');
    const row = await checkoutRow(s.channelId, {
      intent: 'lifetime',
      levelId: s.levelB,
      priceId: s.priceB,
    });
    const paymentIntent = `pi_${rand()}`;
    expect(
      await handleStripeEvent(
        c,
        event(
          'checkout.session.completed',
          session({
            ref: row.signed,
            email,
            customer: `cus_${rand()}`,
            mode: 'payment',
            amount: 20000,
            paymentIntent,
          }),
          { account: s.account, created: now },
        ),
      ),
    ).toBe('processed');
    const member = await env.DB.prepare(
      'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(s.channelId, email)
      .first<{ id: string }>();
    expect(await entitledLevel(env.DB, s.channelId, member!.id, now + 3650 * DAY)).toBe(s.levelB);
    const entitlement = await env.DB.prepare(
      'SELECT expires_at, source FROM member_entitlements WHERE member_id = ?1',
    )
      .bind(member!.id)
      .first();
    expect(entitlement).toEqual({ expires_at: null, source: 'lifetime' });

    const dispute = {
      id: `dp_${rand()}`,
      object: 'dispute',
      charge: `ch_${rand()}`,
      payment_intent: paymentIntent,
      amount: 20000,
      currency: 'usd',
    };
    expect(
      await handleStripeEvent(
        ctx(now + 1000, c.stripe),
        event('charge.dispute.created', dispute, { account: s.account, created: now + 1000 }),
      ),
    ).toBe('processed');
    expect(await entitledLevel(env.DB, s.channelId, member!.id, now + 2000)).toBeUndefined();
    const revoked = await env.DB.prepare(
      'SELECT revoke_reason FROM member_subscriptions WHERE member_id = ?1',
    )
      .bind(member!.id)
      .first<{ revoke_reason: string }>();
    expect(revoked?.revoke_reason).toBe('dispute');
  });

  it('Gift Pass: payment marks it paid and mails the claim link, which expires unclaimed', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const purchaser = uniqueEmail('giver');
    const recipient = uniqueEmail('friend');
    const giftId = newId('giftPass', now);
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, recipient_email, message, created_at)
       VALUES (?1, ?2, ?3, 3, ?4, ?5, 'Enjoy <b>this</b>', ?6)`,
    )
      .bind(giftId, s.channelId, s.levelA, purchaser, recipient, now)
      .run();
    const row = await checkoutRow(s.channelId, {
      intent: 'gift',
      subjectId: giftId,
      email: purchaser,
    });
    expect(
      await handleStripeEvent(
        c,
        event(
          'checkout.session.completed',
          session({
            ref: row.signed,
            email: purchaser,
            customer: `cus_${rand()}`,
            mode: 'payment',
            amount: 1500,
            paymentIntent: `pi_${rand()}`,
          }),
          { account: s.account, created: now },
        ),
      ),
    ).toBe('processed');
    const pass = await env.DB.prepare(
      'SELECT status, claim_token_hash, claim_by FROM gift_passes WHERE id = ?1',
    )
      .bind(giftId)
      .first<{ status: string; claim_token_hash: string; claim_by: number }>();
    expect(pass?.status).toBe('paid');
    expect(pass?.claim_by).toBe(now + 90 * DAY);

    const message = (await mail().adapter.list({ to: recipient, limit: 1 }))[0];
    expect(message?.category).toBe('gift_pass');
    expect(message?.html).not.toContain('<b>this</b>');
    const token = /\/_swarm\/gift\/([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1];
    expect(message?.text).toContain(`http://`);
    expect(token).toBeTruthy();
    expect(await sha256HexForTest(token!)).toBe(pass?.claim_token_hash);
    // Buying a gift doesn't sign the buyer up.
    const giver = await env.DB.prepare(
      'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(s.channelId, purchaser)
      .first();
    expect(giver).toBeNull();

    await runPaymentsLifecycle(env.DB, null, now + 91 * DAY);
    const expired = await env.DB.prepare('SELECT status FROM gift_passes WHERE id = ?1')
      .bind(giftId)
      .first<{ status: string }>();
    expect(expired?.status).toBe('expired');
  });

  it('a Gift Pass event fails (for a retry) when mail is not configured', async () => {
    const s = await shop();
    const now = Date.now();
    const giftId = newId('giftPass', now);
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, created_at)
       VALUES (?1, ?2, ?3, 1, 'giver@example.com', ?4)`,
    )
      .bind(giftId, s.channelId, s.levelA, now)
      .run();
    const row = await checkoutRow(s.channelId, { intent: 'gift', subjectId: giftId });
    const evt = event(
      'checkout.session.completed',
      session({
        ref: row.signed,
        email: 'giver@example.com',
        customer: 'cus_g',
        mode: 'payment',
        amount: 500,
      }),
      { account: s.account, created: now },
    );
    const { mail: _, ...noMail } = ctx(now);
    await expect(handleStripeEvent(noMail, evt)).rejects.toThrow(/mail/);
    expect((await eventStatus(evt.id))?.status).toBe('failed');
    const pass = await env.DB.prepare(
      'SELECT status, claim_token_hash FROM gift_passes WHERE id = ?1',
    )
      .bind(giftId)
      .first();
    expect(pass).toEqual({ status: 'pending_payment', claim_token_hash: null });
    // The retry, now with mail, goes through.
    expect(await handleStripeEvent(ctx(now + 1000), evt)).toBe('processed');
  });

  it('account.updated refreshes the connected account flags', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    await handleStripeEvent(
      c,
      event(
        'account.updated',
        {
          id: s.account,
          charges_enabled: false,
          payouts_enabled: true,
          details_submitted: true,
          default_currency: 'EUR',
        },
        { account: s.account, created: c.now },
      ),
    );
    const row = await env.DB.prepare(
      'SELECT charges_enabled, payouts_enabled, details_submitted, default_currency FROM stripe_accounts WHERE channel_id = ?1',
    )
      .bind(s.channelId)
      .first();
    expect(row).toEqual({
      charges_enabled: 0,
      payouts_enabled: 1,
      details_submitted: 1,
      default_currency: 'eur',
    });
  });

  it("ignores an event whose mode isn't the connected account's", async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const live = {
      ...event(
        'account.updated',
        { id: s.account, charges_enabled: false },
        { account: s.account, created: c.now },
      ),
      livemode: true,
    };
    expect(await handleStripeEvent(c, live)).toBe('ignored');
    const row = await env.DB.prepare(
      'SELECT charges_enabled FROM stripe_accounts WHERE channel_id = ?1',
    )
      .bind(s.channelId)
      .first();
    expect(row).toEqual({ charges_enabled: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle cron

describe('runPaymentsLifecycle', () => {
  it('ends comp grants at their end date', async () => {
    const s = await shop();
    const now = Date.now();
    const memberId = newId('member', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      ).bind(memberId, s.channelId, uniqueEmail('comp'), now),
      env.DB.prepare(
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status, current_period_end, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'comp', 'active', ?5, ?6, ?6)`,
      ).bind(newId('memberSubscription', now), s.channelId, memberId, s.levelA, now + DAY, now),
    ]);
    const { recomputeEntitlement } = await import('@swarm/engine');
    await recomputeEntitlement(env.DB, s.channelId, memberId, now);
    expect(await entitledLevel(env.DB, s.channelId, memberId, now)).toBe(s.levelA);
    const result = await runPaymentsLifecycle(env.DB, null, now + 2 * DAY);
    expect(result.ended).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare(
      'SELECT status, revoke_reason FROM member_subscriptions WHERE member_id = ?1',
    )
      .bind(memberId)
      .first();
    expect(row).toEqual({ status: 'ended', revoke_reason: 'expired' });
    expect(await entitledLevel(env.DB, s.channelId, memberId, now + 2 * DAY)).toBeUndefined();
  });

  it('promotes a scheduled price and migrates subscriptions on Stripe without proration', async () => {
    const s = await shop();
    const now = Date.now();
    const c = ctx(now);
    const bought = await subscribe(s, c);
    const newPrice = newId('levelPrice', now);
    const stripeNew = `price_${rand()}`;
    await env.DB.prepare(
      `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, status, effective_at, existing, stripe_price_id, created_at)
       VALUES (?1, ?2, ?3, 'month', 'usd', 700, 'scheduled', ?4, 'migrate', ?5, ?6)`,
    )
      .bind(newPrice, s.levelA, s.channelId, now + DAY, stripeNew, now)
      .run();

    // Not yet due.
    await runPaymentsLifecycle(env.DB, c.stripe, now);
    expect(
      (await env.DB.prepare('SELECT status FROM level_prices WHERE id = ?1').bind(newPrice).first())
        ?.status,
    ).toBe('scheduled');

    const result = await runPaymentsLifecycle(env.DB, c.stripe, now + 2 * DAY);
    expect(result.pricesPromoted).toBeGreaterThanOrEqual(1);
    // Both prices can be created in the same millisecond, so compare by id, not by order.
    const prices = await env.DB.prepare('SELECT id, status FROM level_prices WHERE level_id = ?1')
      .bind(s.levelA)
      .all<{ id: string; status: string }>();
    expect(Object.fromEntries(prices.results.map((p) => [p.id, p.status]))).toEqual({
      [s.priceA]: 'retired',
      [newPrice]: 'active',
    });
    const update = c.stripe.calls.find(
      (call) => call.method === 'POST' && call.path === `/v1/subscriptions/${bought.subId}`,
    );
    expect(update?.params).toMatchObject({
      items: [{ id: `si_${bought.subId.slice(4)}`, price: stripeNew }],
      proration_behavior: 'none',
    });
    expect(update?.options.account).toBe(s.account);
    expect(await subRow(bought.subId)).toMatchObject({ price_id: newPrice, amount: 700 });
    expect(await entitledLevel(env.DB, s.channelId, bought.memberId, now + 2 * DAY)).toBe(s.levelA);
  });
});

// ---------------------------------------------------------------------------------------------
// Settings → Payments

const data = async <T>(res: Response, status = 200): Promise<T> => {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
};

async function startConnect(s: Session, channelId: string): Promise<string> {
  const { url } = await data<{ url: string }>(
    await call('POST', `/api/v1/channels/${channelId}/payments/connect`, { cookie: s.cookie }),
  );
  const state = new URL(url).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

async function callback(s: Session | null, query: Record<string, string>): Promise<URL> {
  const res = await call('GET', `/api/v1/payments/connect/callback?${new URLSearchParams(query)}`, {
    ...(s ? { cookie: s.cookie } : {}),
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

describe('Settings → Payments', () => {
  it('connects through Stripe OAuth, changes settings and disconnects, all audited', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const status = await data<PaymentsStatus>(
      await call('GET', `/api/v1/channels/${channel.id}/payments`, { cookie: owner.cookie }),
    );
    expect(status).toMatchObject({
      available: true,
      connected: false,
      state: 'not_connected',
      graceDays: 7,
    });

    const state = await startConnect(owner, channel.id);
    const account = `acct_${rand()}`;
    const back = await callback(owner, { code: `dev_${account}`, state });
    expect(back.pathname).toBe('/settings/payments');
    expect(back.searchParams.get('channel')).toBe(channel.id);
    expect(back.searchParams.get('connected')).toBe('1');

    const connected = await data<PaymentsStatus>(
      await call('GET', `/api/v1/channels/${channel.id}/payments`, { cookie: owner.cookie }),
    );
    expect(connected).toMatchObject({
      connected: true,
      state: 'connected',
      stripeAccountId: account,
    });

    // Already connected: disconnect first.
    const again = await call('POST', `/api/v1/channels/${channel.id}/payments/connect`, {
      cookie: owner.cookie,
    });
    expect(again.status).toBe(409);

    const patched = await data<PaymentsStatus>(
      await call('PATCH', `/api/v1/channels/${channel.id}/payments`, {
        cookie: owner.cookie,
        body: { taxEnabled: true, graceDays: 10 },
      }),
    );
    expect(patched).toMatchObject({ taxEnabled: true, graceDays: 10 });
    const invalid = await call('PATCH', `/api/v1/channels/${channel.id}/payments`, {
      cookie: owner.cookie,
      body: { graceDays: 31 },
    });
    expect(invalid.status).toBe(400);

    const disconnected = await data<PaymentsStatus>(
      await call('POST', `/api/v1/channels/${channel.id}/payments/disconnect`, {
        cookie: owner.cookie,
      }),
    );
    expect(disconnected).toMatchObject({ connected: false, state: 'disconnected' });

    const actions = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE workspace_id = ?1 AND action LIKE 'payments.%' ORDER BY seq`,
    )
      .bind(owner.workspaceId)
      .all<{ action: string }>();
    expect(actions.results.map((row) => row.action)).toEqual([
      'payments.connected',
      'payments.settings_changed',
      'payments.disconnected',
    ]);
  });

  it('refuses an account already connected to another Channel', async () => {
    const owner = await signIn();
    const first = await createChannel(owner);
    const second = await createChannel(owner);
    const account = `acct_${rand()}`;
    await callback(owner, { code: `dev_${account}`, state: await startConnect(owner, first.id) });
    const refused = await callback(owner, {
      code: `dev_${account}`,
      state: await startConnect(owner, second.id),
    });
    expect(refused.searchParams.get('error')).toBe('account_in_use');
    const row = await env.DB.prepare(
      'SELECT channel_id FROM stripe_accounts WHERE stripe_account_id = ?1',
    )
      .bind(account)
      .first<{ channel_id: string }>();
    expect(row?.channel_id).toBe(first.id);
  });

  it('removes the platform from an account it refused, unless a Channel is connected through it', async () => {
    class RevokeStripe extends DevStripe {
      readonly revoked: string[] = [];
      // DevStripe's own takes no arguments; the route passes the client id and the account.
      override async connectRevoke(_clientId?: string, accountId?: string): Promise<void> {
        this.revoked.push(accountId ?? '');
      }
    }
    const fake = new RevokeStripe();
    useStripeForTests(fake);
    try {
      const owner = await signIn();
      const first = await createChannel(owner);
      const second = await createChannel(owner);
      const shared = `acct_${rand()}`;
      await callback(owner, { code: `dev_${shared}`, state: await startConnect(owner, first.id) });
      // In use by another Channel through Connect: revoking would disconnect that Channel too.
      const inUse = await callback(owner, {
        code: `dev_${shared}`,
        state: await startConnect(owner, second.id),
      });
      expect(inUse.searchParams.get('error')).toBe('account_in_use');
      expect(fake.revoked).toEqual([]);

      // A link started before the Channel was connected is refused, and its account let go.
      const early = await startConnect(owner, second.id);
      await callback(owner, {
        code: `dev_acct_${rand()}`,
        state: await startConnect(owner, second.id),
      });
      const late = `acct_${rand()}`;
      const refused = await callback(owner, { code: `dev_${late}`, state: early });
      expect(refused.searchParams.get('error')).toBe('state');
      expect(fake.revoked).toEqual([late]);

      // Connected to another Channel by its own key only: nothing relies on this authorization.
      const keyed = await createChannel(owner);
      const ownKey = `acct_${rand()}`;
      await env.DB.prepare(
        `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled,
           own_key_enc, connected_at, updated_at)
         VALUES (?1, ?2, ?3, 1, 'sealed', 0, 0)`,
      )
        .bind(keyed.id, owner.workspaceId, ownKey)
        .run();
      const third = await createChannel(owner);
      const taken = await callback(owner, {
        code: `dev_${ownKey}`,
        state: await startConnect(owner, third.id),
      });
      expect(taken.searchParams.get('error')).toBe('account_in_use');
      expect(fake.revoked).toEqual([late, ownKey]);

      // Disconnected from another Channel: the disconnect already removed the platform.
      const left = await createChannel(owner);
      const gone = `acct_${rand()}`;
      await callback(owner, { code: `dev_${gone}`, state: await startConnect(owner, left.id) });
      await call('POST', `/api/v1/channels/${left.id}/payments/disconnect`, {
        cookie: owner.cookie,
      });
      const fourth = await createChannel(owner);
      const reused = await callback(owner, {
        code: `dev_${gone}`,
        state: await startConnect(owner, fourth.id),
      });
      expect(reused.searchParams.get('error')).toBe('account_in_use');
      expect(fake.revoked).toEqual([late, ownKey, gone]);
      // Its own Channel can still connect it again, and the connected account is never let go.
      const back = await callback(owner, {
        code: `dev_${gone}`,
        state: await startConnect(owner, left.id),
      });
      expect(back.searchParams.get('connected')).toBe('1');
      await callback(owner, { code: `dev_${gone}`, state: await startConnect(owner, fourth.id) });
      expect(fake.revoked).toEqual([late, ownKey, gone]);
    } finally {
      useStripeForTests(undefined);
    }
  });

  it('refuses a forged state, a state started by someone else and a cancelled flow', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const state = await startConnect(owner, channel.id);
    const other = await signIn();
    expect((await callback(other, { code: 'dev_acct_x1', state })).searchParams.get('error')).toBe(
      'state',
    );
    expect((await callback(null, { code: 'dev_acct_x2', state })).searchParams.get('error')).toBe(
      'state',
    );
    expect(
      (await callback(owner, { code: 'dev_acct_x3', state: `${state}x` })).searchParams.get(
        'error',
      ),
    ).toBe('state');
    expect(
      (await callback(owner, { error: 'access_denied', state })).searchParams.get('error'),
    ).toBe('cancelled');
    const row = await env.DB.prepare('SELECT 1 FROM stripe_accounts WHERE channel_id = ?1')
      .bind(channel.id)
      .first();
    expect(row).toBeNull();
  });

  it('an operator who lost the admin role before the callback is refused', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const admin = await seatAs(owner.workspaceId, 'admin');
    const state = await startConnect(admin, channel.id);
    await env.DB.prepare(`UPDATE seats SET role = 'editor' WHERE operator_id = ?1`)
      .bind(admin.me.operator.id)
      .run();
    const back = await callback(admin, { code: `dev_acct_${rand()}`, state });
    expect(back.searchParams.get('error')).toBe('forbidden');
  });

  it('roles: viewers read; editors and authors cannot connect, change or disconnect', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    for (const role of ['viewer', 'author', 'editor'] as const) {
      const s = await seatAs(owner.workspaceId, role);
      expect(
        (await call('GET', `/api/v1/channels/${channel.id}/payments`, { cookie: s.cookie })).status,
      ).toBe(200);
      expect(
        (
          await call('POST', `/api/v1/channels/${channel.id}/payments/connect`, {
            cookie: s.cookie,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('PATCH', `/api/v1/channels/${channel.id}/payments`, {
            cookie: s.cookie,
            body: { graceDays: 3 },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('POST', `/api/v1/channels/${channel.id}/payments/disconnect`, {
            cookie: s.cookie,
          })
        ).status,
      ).toBe(403);
    }
  });

  it('cross-tenant: another workspace gets 404 everywhere', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const stranger = await signIn();
    expect(
      (await call('GET', `/api/v1/channels/${channel.id}/payments`, { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('POST', `/api/v1/channels/${channel.id}/payments/connect`, {
          cookie: stranger.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('PATCH', `/api/v1/channels/${channel.id}/payments`, {
          cookie: stranger.cookie,
          body: { graceDays: 3 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', `/api/v1/channels/${channel.id}/payments/disconnect`, {
          cookie: stranger.cookie,
        })
      ).status,
    ).toBe(404);
    expect((await call('GET', `/api/v1/channels/${channel.id}/payments`)).status).toBe(401);
  });

  it('disconnecting keeps existing subscriptions', async () => {
    const s = await shop();
    const c = ctx(Date.now());
    const bought = await subscribe(s, c);
    await data(
      await call('POST', `/api/v1/channels/${s.channelId}/payments/disconnect`, {
        cookie: s.session.cookie,
      }),
    );
    expect((await subRow(bought.subId))?.status).toBe('active');
  });
});
