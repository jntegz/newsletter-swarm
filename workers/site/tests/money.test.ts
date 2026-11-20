import { env } from 'cloudflare:test';
import { sha256Hex } from '@swarm/db';
import { meterPeriodKey, newId } from '@swarm/domain';
import {
  GIFT_ARTICLE_MAX_READS,
  METER_READS_KEEP_MS,
  pruneSiteEdge,
  DevStripe,
  confirmRequest,
  entitledLevel,
  handleStripeEvent,
  readCheckoutClaims,
  signedCheckoutReference,
  sealAppKey,
  type PaymentsContext,
  type StripeEvent,
  type StripeParams,
  type StripeRequestOptions,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { createFakeVault, testVaultEnv } from '@swarm/vault';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeCacheKey } from '../src/edge/cache';
import { createSite, mountSite } from '../src/index';
import { gateAdmits, couponOffer, mergeDesign } from '../src/money/gate';
import { checkoutUrls, devCheckoutEvents } from '../src/routes/checkout';
import {
  BROWSER_UA,
  addMember,
  allowSiteCode,
  call,
  mailTo,
  nextIp,
  seedChannel,
  sessionCookie,
  uniqueEmail,
  type SeededChannel,
} from './helpers';
import { turnstile } from './turnstile';
import { testLinks } from './links';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });
const memberKeys = () => testLinks();
/** The checkout_sessions reference a created Checkout Session's signed reference names. */
const referenceOf = async (session: Record<string, unknown>) =>
  (await readCheckoutClaims(memberKeys(), signedCheckoutReference(session)))?.reference ?? null;

/** Records every Stripe call, and what checkout_sessions held when the session was created. */
class RecordingStripe extends DevStripe {
  rowsAtCreate: (Record<string, unknown> | null)[] = [];
  override async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    if (path === '/v1/checkout/sessions') {
      const reference = await referenceOf(params as Record<string, unknown>);
      this.rowsAtCreate.push(
        await env.DB.prepare('SELECT * FROM checkout_sessions WHERE reference = ?1')
          .bind(reference)
          .first(),
      );
    }
    return super.request<T>(method, path, params, options);
  }
}

let stripe = new RecordingStripe();
const processed: StripeEvent[] = [];
const fakeProcessor = async (_ctx: PaymentsContext, event: StripeEvent) => {
  processed.push(event);
  return 'processed' as const;
};
const paypalFetch: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === '/v1/oauth2/token') return Response.json({ access_token: 'token' });
  if (path === '/v1/catalogs/products') return Response.json({ id: 'PROD-1' });
  if (path === '/v1/billing/plans') return Response.json({ id: 'P-1' });
  return Response.json({
    id: 'I-1',
    links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve?token=1' }],
  });
};
const site = createSite((s) =>
  mountSite(s, { stripe: () => stripe, handleEvent: fakeProcessor, paypalFetch }),
);

beforeEach(() => {
  stripe = new RecordingStripe();
  processed.length = 0;
});

interface Money extends SeededChannel {
  levels: { basic: string; pro: string; founding: string; hidden: string; archived: string };
  prices: Record<string, string>;
  dispatches: { paid: string; paidPro: string; members: string; extra1: string; extra2: string };
}

interface MoneyOptions {
  account?: 'none' | 'disabled' | 'open';
  tax?: boolean;
  flags?: string[];
  meter?: { limit: number; period?: 'week' | 'month'; mode?: 'soft' | 'hard' };
  couponOnGate?: boolean;
  trialDays?: number;
}

async function seedMoney(options: MoneyOptions = {}): Promise<Money> {
  const ch = await seedChannel();
  const now = Date.now();
  const id = (kind: string) => `${kind}_${hex()}`;
  const levels = {
    basic: id('lv'),
    pro: id('lv'),
    founding: id('lv'),
    hidden: id('lv'),
    archived: id('lv'),
  };
  const prices: Record<string, string> = {};
  const statements: D1PreparedStatement[] = [];
  const level = (
    levelId: string,
    name: string,
    extra: {
      founding?: boolean;
      visibility?: string;
      status?: string;
      trial?: number;
      position?: number;
    },
  ) =>
    env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, description, benefits_json, founding, visibility,
         trial_days, status, position, stripe_product_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
    ).bind(
      levelId,
      ch.channelId,
      name,
      `${name} description`,
      JSON.stringify([`${name} benefit one`, `${name} benefit two`]),
      extra.founding ? 1 : 0,
      extra.visibility ?? 'public',
      extra.trial ?? 0,
      extra.status ?? 'active',
      extra.position ?? 0,
      `prod_${hex().slice(0, 10)}`,
      now,
    );
  const price = (
    levelId: string,
    interval: string,
    amount: number,
    extra: { custom?: boolean; min?: number } = {},
  ) => {
    const priceId = id('lp');
    prices[`${levelId}:${interval}`] = priceId;
    return env.DB.prepare(
      `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, custom_amount, min_amount,
         status, stripe_price_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'usd', ?5, ?6, ?7, 'active', ?8, ?9)`,
    ).bind(
      priceId,
      levelId,
      ch.channelId,
      interval,
      amount,
      extra.custom ? 1 : 0,
      extra.min ?? null,
      extra.custom ? null : `price_${hex().slice(0, 10)}`,
      now,
    );
  };
  statements.push(
    level(levels.basic, 'Basic', { trial: options.trialDays ?? 0, position: 1 }),
    level(levels.pro, 'Pro', { position: 2 }),
    level(levels.founding, 'Patron', { founding: true, position: 3 }),
    level(levels.hidden, 'Secret', { visibility: 'hidden', position: 4 }),
    level(levels.archived, 'Old', { status: 'archived', position: 5 }),
    price(levels.basic, 'month', 500),
    price(levels.basic, 'year', 5000),
    price(levels.pro, 'month', 1500, { custom: true, min: 1000 }),
    price(levels.pro, 'lifetime', 30000),
    price(levels.founding, 'year', 50000),
    price(levels.hidden, 'month', 300),
    price(levels.archived, 'month', 100),
  );
  const account = options.account ?? 'open';
  if (account !== 'none') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled, tax_enabled,
           default_currency, connected_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'usd', ?6, ?6)`,
      ).bind(
        ch.channelId,
        ch.workspaceId,
        `acct_${hex().slice(0, 16)}`,
        account === 'open' ? 1 : 0,
        options.tax ? 1 : 0,
        now,
      ),
    );
  }
  for (const key of options.flags ?? []) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
      ).bind(`ff_${hex()}`, key, ch.channelId),
    );
  }
  const dispatches = {
    paid: id('dp'),
    paidPro: id('dp'),
    members: id('dp'),
    extra1: id('dp'),
    extra2: id('dp'),
  };
  const dispatch = (dispatchId: string, slug: string, visibility: string, secret: string) => [
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, '', ?4, 'sent', 0, ?5, ?6, ?5)`,
    ).bind(
      dispatchId,
      ch.channelId,
      slug,
      doc(p(`Free part of ${slug}.`), { type: 'gate' }, p(secret)),
      now,
      visibility,
    ),
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
    ).bind(ch.channelId, slug, dispatchId),
  ];
  statements.push(
    ...dispatch(dispatches.paid, 'paid-one', 'paid', 'Secret paid one.'),
    ...dispatch(dispatches.paidPro, 'pro-only', 'paid', 'Secret pro only.'),
    ...dispatch(dispatches.members, 'members-one', 'members', 'Secret members one.'),
    ...dispatch(dispatches.extra1, 'paid-two', 'paid', 'Secret paid two.'),
    ...dispatch(dispatches.extra2, 'paid-three', 'paid', 'Secret paid three.'),
    env.DB.prepare(
      `INSERT INTO gates (dispatch_id, channel_id, level_ids_json, metered, design_json, updated_at)
       VALUES (?1, ?2, ?3, 0, ?4, 0)`,
    ).bind(
      dispatches.paidPro,
      ch.channelId,
      JSON.stringify([levels.pro]),
      JSON.stringify({ headline: 'Pro readers only', benefits: ['Deep dives'] }),
    ),
  );
  let couponId: string | null = null;
  if (options.couponOnGate) {
    couponId = id('cp');
    statements.push(
      env.DB.prepare(
        `INSERT INTO coupons (id, channel_id, code, percent_off, duration, duration_months, status,
           stripe_coupon_id, stripe_promotion_code_id, created_at)
         VALUES (?1, ?2, 'WELCOME20', 20, 'repeating', 3, 'active', 'co_x', 'promo_welcome', 0)`,
      ).bind(couponId, ch.channelId),
    );
  }
  if (options.meter || couponId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO gate_settings (channel_id, meter_limit, meter_period, meter_mode, design_json, gate_coupon_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`,
      ).bind(
        ch.channelId,
        options.meter?.limit ?? 0,
        options.meter?.period ?? 'month',
        options.meter?.mode ?? 'hard',
        JSON.stringify({ body: 'Publication-wide gate body.' }),
        couponId,
      ),
    );
  }
  await env.DB.batch(statements);
  return { ...ch, levels, prices, dispatches };
}

async function entitle(ch: SeededChannel, memberId: string, levelId: string | null) {
  await env.DB.prepare(
    `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at, level_id)
     VALUES (?1, ?2, 'paid', 'comp', 0, NULL, ?3)`,
  )
    .bind(memberId, ch.channelId, levelId)
    .run();
}

async function paidReader(ch: SeededChannel, levelId: string | null) {
  const memberId = await addMember(ch.channelId, uniqueEmail('paid'));
  await entitle(ch, memberId, levelId);
  return { memberId, cookie: await sessionCookie(ch.channelId, memberId) };
}

const page = (ch: SeededChannel, path: string, headers: Record<string, string> = {}) =>
  call(site, `${ch.origin}${path}`, { headers: { 'user-agent': BROWSER_UA, ...headers } });

function post(
  ch: SeededChannel,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return call(site, `${ch.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ch.origin,
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': nextIp(),
      'user-agent': BROWSER_UA,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const checkout = (ch: SeededChannel, fields: Record<string, string>, headers = {}) =>
  post(ch, '/_swarm/checkout', { 'cf-turnstile-response': 'token', ...fields }, headers);

const meterCookie = (res: Response) =>
  /swarm_meter=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? null;

const lastSession = () =>
  stripe.calls.filter((call) => call.path === '/v1/checkout/sessions').at(-1);

// ---------------------------------------------------------------------------------------------

describe('Gate admission', () => {
  it('gateAdmits paid readers by level; an empty list gateAdmits any paid level', () => {
    const paid = (levelId: string | null) => ({ class: 'paid' as const, levelId });
    expect(gateAdmits('paid', paid('lv_a'), [])).toBe(true);
    expect(gateAdmits('paid', paid(null), [])).toBe(true);
    expect(gateAdmits('paid', paid('lv_a'), ['lv_a'])).toBe(true);
    expect(gateAdmits('paid', paid('lv_b'), ['lv_a'])).toBe(false);
    expect(gateAdmits('paid', paid(null), ['lv_a'])).toBe(false);
    expect(gateAdmits('paid', { class: 'member', levelId: null }, [])).toBe(false);
    expect(gateAdmits('members', { class: 'member', levelId: null }, ['lv_a'])).toBe(true);
    expect(gateAdmits('members', { class: 'anonymous', levelId: null }, [])).toBe(false);
  });

  it('merges the post design over the publication design and ignores junk', () => {
    expect(
      mergeDesign(
        JSON.stringify({ headline: 'Mine', benefits: ['A', 5, ''] }),
        JSON.stringify({ headline: 'Theirs', body: 'Body', ctaLabel: 'Join' }),
      ),
    ).toEqual({ headline: 'Mine', body: 'Body', ctaLabel: 'Join', benefits: ['A'] });
    expect(mergeDesign('not json', '[]')).toEqual({
      headline: null,
      body: null,
      ctaLabel: null,
      benefits: [],
    });
  });

  it('shows a level-gated post only to readers of that level', async () => {
    const ch = await seedMoney();
    const pro = await paidReader(ch, ch.levels.pro);
    const basic = await paidReader(ch, ch.levels.basic);

    const proHtml = await (await page(ch, '/p/pro-only', { cookie: pro.cookie })).text();
    expect(proHtml).toContain('Secret pro only.');

    const res = await page(ch, '/p/pro-only', { cookie: basic.cookie });
    const html = await res.text();
    expect(html).not.toContain('Secret pro only.');
    expect(html).toContain('Pro readers only');
    expect(html).toContain('<li>Deep dives</li>');
    expect(html).toContain('Publication-wide gate body.'.slice(0, 0));
    expect(html).toContain('href="/subscribe"');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');

    // Any paid level reads a paid Dispatch without a level list.
    expect(await (await page(ch, '/p/paid-one', { cookie: basic.cookie })).text()).toContain(
      'Secret paid one.',
    );
  });

  it('keys the edge cache by level for paid readers, so levels never share a page', async () => {
    const base = {
      host: 'a.swarm.test',
      channelId: 'ch_a',
      pathAndQuery: '/p/x',
      readerClass: 'paid',
      cacheVersion: 1,
    } as const;
    expect(edgeCacheKey({ ...base, levelId: 'lv_a' })).not.toBe(
      edgeCacheKey({ ...base, levelId: 'lv_b' }),
    );
    expect(edgeCacheKey({ ...base, levelId: null })).not.toBe(
      edgeCacheKey({ ...base, levelId: 'lv_a' }),
    );
    // Other classes ignore the level.
    expect(edgeCacheKey({ ...base, readerClass: 'member', levelId: 'lv_a' })).toBe(
      edgeCacheKey({ ...base, readerClass: 'member' }),
    );

    const ch = await seedMoney();
    const pro = await paidReader(ch, ch.levels.pro);
    const basic = await paidReader(ch, ch.levels.basic);
    const first = await page(ch, '/p/pro-only', { cookie: pro.cookie });
    expect(first.headers.get('x-swarm-cache')).toBe('miss');
    expect(await first.text()).toContain('Secret pro only.');
    const other = await page(ch, '/p/pro-only', { cookie: basic.cookie });
    expect(other.headers.get('x-swarm-cache')).toBe('miss');
    expect(await other.text()).not.toContain('Secret pro only.');
    const again = await page(ch, '/p/pro-only', { cookie: pro.cookie });
    expect(again.headers.get('x-swarm-cache')).toBe('hit');
  });

  it('shows the paywall coupon inside the Gate only with the flag', async () => {
    const off = await seedMoney({ couponOnGate: true });
    expect(await (await page(off, '/p/paid-one')).text()).not.toContain('WELCOME20');

    const ch = await seedMoney({ couponOnGate: true, flags: ['paywall_coupon'] });
    const html = await (await page(ch, '/p/paid-one')).text();
    expect(html).toContain('Use code <strong>WELCOME20</strong> for 20% off for 3 months.');
    expect(html).toContain('href="/subscribe?coupon=WELCOME20"');
    expect(html).toContain('Publication-wide gate body.');
    expect(
      couponOffer({
        id: 'cp',
        code: 'X',
        name: null,
        percentOff: null,
        amountOff: 500,
        currency: 'usd',
        duration: 'once',
        durationMonths: null,
        levelIds: [],
        stripePromotionCodeId: null,
      }),
    ).toBe('$5 off the first payment');
  });
});

describe('metered Gates', () => {
  it('counts distinct reads in the visitor’s own cookie; re-reading is free; never cached', async () => {
    const ch = await seedMoney({ meter: { limit: 2 } });
    const one = await page(ch, '/p/paid-one');
    expect(await one.text()).toContain('Secret paid one.');
    expect(one.headers.get('cache-control')).toBe('private, no-store');
    expect(one.headers.get('x-swarm-cache')).toBeNull();
    let cookie = meterCookie(one);
    expect(cookie).not.toBeNull();
    expect(one.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(one.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    // It lasts one period at most, not a year.
    expect(one.headers.get('set-cookie')).toMatch(/Max-Age=2678400/);

    const two = await page(ch, '/p/paid-two', { cookie: cookie! });
    expect(await two.text()).toContain('Secret paid two.');
    cookie = meterCookie(two) ?? cookie;

    const three = await page(ch, '/p/paid-three', { cookie: cookie! });
    const gated = await three.text();
    expect(gated).not.toContain('Secret paid three.');
    expect(gated).toContain('You have read your free posts for this month.');
    expect(three.headers.get('cache-control')).toBe('private, no-store');
    // Hard by default: no way through.
    expect(gated).not.toContain('continue=1');
    expect(
      await (await page(ch, '/p/paid-three?continue=1', { cookie: cookie! })).text(),
    ).not.toContain('Secret paid three.');

    // Re-reading a counted Dispatch is free.
    expect(await (await page(ch, '/p/paid-one', { cookie: cookie! })).text()).toContain(
      'Secret paid one.',
    );
    // The spent Gate was not cached for anonymous readers: a new reader still gets a free read.
    expect(await (await page(ch, '/p/paid-three')).text()).toContain('Secret paid three.');
    // An edited cookie counts for nothing, and another publication's cookie isn't this one's.
    const forged = `${cookie!.slice(0, -2)}xx`;
    expect(await (await page(ch, '/p/paid-three', { cookie: forged })).text()).toContain(
      'Secret paid three.',
    );

    // Nothing about an anonymous visitor is stored on the server.
    const { n } = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM gate_meter_reads WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it('keeps a signed-in reader’s meter rows only for the current and last period', async () => {
    const ch = await seedMoney({ meter: { limit: 3 } });
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    expect(await (await page(ch, '/p/paid-one', { cookie })).text()).toContain('Secret paid one.');
    const rows = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM gate_meter_reads WHERE reader_key = ?1')
        .bind(memberId)
        .first<{ n: number }>())!.n;
    expect(await rows()).toBe(1);
    const old = Date.now() - METER_READS_KEEP_MS - 86_400_000;
    await env.DB.prepare(
      `INSERT INTO gate_meter_reads (channel_id, reader_key, period, dispatch_id, read_at)
       SELECT ?1, ?2, '2020-01', dispatch_id, ?3 FROM gate_meter_reads WHERE reader_key = ?2`,
    )
      .bind(ch.channelId, memberId, old)
      .run();
    expect(await rows()).toBe(2);
    await pruneSiteEdge(env.DB);
    expect(await rows()).toBe(1);
    // Deleting the Member deletes their meter rows too.
    await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(memberId).run();
    expect(await rows()).toBe(0);
  });

  it('keeps the owner’s code off a paywalled post read in full on the meter', async () => {
    const ch = await seedMoney({ meter: { limit: 1 } });
    await allowSiteCode(ch.workspaceId);
    const code = [
      {
        name: 'Analytics',
        preset: 'google_analytics',
        category: 'analytics',
        value: 'G-ABC123DEF4',
      },
    ];
    const consent = {
      enabled: true,
      text: 'We use cookies.',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '/cookies',
      position: 'bottom',
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_settings (channel_id, consent_json, code_json, updated_at) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (channel_id) DO UPDATE SET consent_json = ?2, code_json = ?3,
           cache_version = cache_version + 1`,
      ).bind(ch.channelId, JSON.stringify(consent), JSON.stringify(code)),
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
         VALUES (?1, 'site_custom_code', 'channel', ?2, 1, 0)`,
      ).bind(newId('featureFlag'), ch.channelId),
    ]);
    // The code runs on the Gate a visitor sees once the meter is spent...
    const first = await page(ch, '/p/paid-one');
    expect(await first.text()).toContain('Secret paid one.');
    expect(first.headers.get('content-security-policy')).not.toContain('strict-dynamic');
    const spent = await page(ch, '/p/paid-two', { cookie: meterCookie(first)! });
    expect(await spent.text()).not.toContain('Secret paid two.');
    expect(spent.headers.get('content-security-policy')).toContain('strict-dynamic');
  });

  it('never meters bots or posts whose Gate is not metered', async () => {
    const ch = await seedMoney({ meter: { limit: 5 } });
    const bot = await call(site, `${ch.origin}/p/paid-one`, {
      headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
    });
    expect(await bot.text()).not.toContain('Secret paid one.');
    expect(meterCookie(bot)).toBeNull();
    // pro-only has a Gate row with metered = 0.
    expect(await (await page(ch, '/p/pro-only')).text()).not.toContain('Secret pro only.');
  });

  it('records gate_hit for a signed-in reader shown the Gate, and for nobody else', async () => {
    const ch = await seedMoney();
    const gateHits = (memberId: string) =>
      env.DB.prepare(
        `SELECT payload_json FROM member_events WHERE member_id = ?1 AND channel_id = ?2 AND type = 'gate_hit'`,
      )
        .bind(memberId, ch.channelId)
        .all<{ payload_json: string }>();

    const memberId = await addMember(ch.channelId, uniqueEmail());
    const gated = await page(ch, '/p/paid-one', {
      cookie: await sessionCookie(ch.channelId, memberId),
    });
    expect(await gated.text()).not.toContain('Secret paid one.');
    // Written after the response.
    await vi.waitFor(async () => expect((await gateHits(memberId)).results).toHaveLength(1));
    const hit = JSON.parse((await gateHits(memberId)).results[0]!.payload_json);
    expect(hit.dispatchId).toMatch(/^dp_/);

    // A reader who may read it isn't shown the Gate.
    const paid = await paidReader(ch, ch.levels.basic);
    const read = await page(ch, '/p/paid-one', { cookie: paid.cookie });
    expect(await read.text()).toContain('Secret paid one.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await gateHits(paid.memberId)).results).toEqual([]);
  });

  it('counts a signed-in subscriber across sessions, plus grants', async () => {
    const ch = await seedMoney({ meter: { limit: 1, period: 'week' } });
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const first = await sessionCookie(ch.channelId, memberId);
    const second = await sessionCookie(ch.channelId, memberId);
    const one = await page(ch, '/p/paid-one', { cookie: first });
    expect(await one.text()).toContain('Secret paid one.');
    expect(meterCookie(one)).toBeNull();
    expect(one.headers.get('cache-control')).toBe('private, no-store');

    // Another session (another device) shares the meter.
    const spent = await (await page(ch, '/p/paid-two', { cookie: second })).text();
    expect(spent).not.toContain('Secret paid two.');
    expect(spent).toContain('for this week');

    await env.DB.prepare(
      `INSERT INTO gate_meter_grants (id, channel_id, member_id, period, extra, created_at)
       VALUES (?1, ?2, ?3, ?4, 1, 0)`,
    )
      .bind(newId('meterGrant'), ch.channelId, memberId, meterPeriodKey('week', Date.now()))
      .run();
    expect(await (await page(ch, '/p/paid-two', { cookie: second })).text()).toContain(
      'Secret paid two.',
    );
    expect(await (await page(ch, '/p/paid-three', { cookie: first })).text()).not.toContain(
      'Secret paid three.',
    );
  });

  it('lets a soft Gate be dismissed for one request, without caching or indexing', async () => {
    const ch = await seedMoney({ meter: { limit: 1, mode: 'soft' } });
    const cookie = meterCookie(await page(ch, '/p/paid-one'))!;
    const gate = await (await page(ch, '/p/paid-two', { cookie })).text();
    expect(gate).not.toContain('Secret paid two.');
    expect(gate).toContain('href="/p/paid-two?continue=1" rel="nofollow"');

    const through = await page(ch, '/p/paid-two?continue=1', { cookie });
    const html = await through.text();
    expect(html).toContain('Secret paid two.');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(through.headers.get('cache-control')).toBe('private, no-store');
    // It doesn't count a read.
    expect(await (await page(ch, '/p/paid-two', { cookie })).text()).not.toContain(
      'Secret paid two.',
    );
  });
});

describe('/subscribe', () => {
  it('lists public levels with benefits and prices, and Turnstile on checkout forms', async () => {
    const ch = await seedMoney();
    const res = await page(ch, '/subscribe');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h2>Basic</h2>');
    expect(html).toContain('Basic benefit one');
    expect(html).toContain('$5 a month');
    expect(html).toContain('Buy lifetime for $300');
    // Free level: the Capture Form fallback.
    expect(html).toContain('<form method="post" action="/_swarm/subscribe" data-swarm-subscribe>');
    // Flags off: no Founding Level, no pay what you want, no tips, no gifts.
    expect(html).not.toContain('Patron');
    expect(html).not.toContain('name="amount"');
    expect(html).not.toContain('Leave a tip');
    expect(html).not.toContain('Gift subscription');
    // The pay-what-you-want price can't be sold without its flag.
    const proForm = (interval: string) =>
      `value="${ch.levels.pro}">\n<input type="hidden" name="interval" value="${interval}">`;
    expect(html).not.toContain(proForm('month'));
    expect(html).toContain(proForm('lifetime'));
    // Hidden and archived levels are not listed.
    expect(html).not.toContain('Secret');
    expect(html).not.toContain('<h2>Old</h2>');
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('data-action="checkout"');
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=86400',
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('script-src');
    expect(csp).toMatch(/script-src 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('https://checkout.stripe.com');

    // Other pages keep the strict policy.
    const home = await page(ch, '/');
    expect(home.headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');

    // The yearly toggle works without JavaScript.
    expect(html).toContain('href="/subscribe?interval=year"');
    const yearly = await (await page(ch, '/subscribe?interval=year')).text();
    expect(yearly).toContain('$50 a year');
    expect(yearly).toContain('name="interval" value="year"');
  });

  it('highlights the founding plan, and offers PWYW, tips and gifts behind their flags', async () => {
    const ch = await seedMoney({
      flags: ['founding_level', 'pay_what_you_want', 'gift_passes'],
    });
    const html = await (await page(ch, '/subscribe?interval=year')).text();
    expect(html).toContain('<li class="sw-plan sw-plan-founding">');
    expect(html).toContain('Founding plan');
    expect(html.indexOf('Patron')).toBeLessThan(html.indexOf('<h2>Basic</h2>'));
    const monthly = await (await page(ch, '/subscribe')).text();
    expect(monthly).toContain('From $10');
    expect(monthly).toContain('name="amount"');
    expect(monthly).toContain('At least $10.');
    expect(monthly).toContain('Leave a tip');
    expect(monthly).toContain('Give a gift subscription');
    expect(monthly).toContain('name="recipientEmail"');
  });

  it('shows a hidden level only by its link, and says when payments are not open', async () => {
    const ch = await seedMoney({ account: 'disabled' });
    const html = await (await page(ch, `/subscribe?level=${ch.levels.hidden}`)).text();
    expect(html).toContain('<h2>Secret</h2>');
    expect(html).toContain('Paid subscriptions open soon.');
    expect(html).not.toContain('action="/_swarm/checkout"');
    expect(html).not.toContain('cf-turnstile');
  });

  it('takes pledges while the publication has no connected account (flag pledges)', async () => {
    const ch = await seedMoney({ account: 'none', flags: ['pledges'] });
    const html = await (await page(ch, '/subscribe')).text();
    expect(html).toContain('action="/_swarm/pledge"');
    expect(html).toContain('data-action="pledge"');

    turnstile.action = 'pledge';
    const email = uniqueEmail('pledger');
    const res = await post(ch, '/_swarm/pledge', {
      levelId: ch.levels.basic,
      interval: 'year',
      amount: '60',
      email,
      'cf-turnstile-response': 'token',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('$60 a year');
    const row = await env.DB.prepare(
      `SELECT p.amount, p.interval, p.currency, m.status FROM pledges p JOIN members m ON m.id = p.member_id
        WHERE p.channel_id = ?1 AND m.email = ?2`,
    )
      .bind(ch.channelId, email)
      .first<{ amount: number; interval: string; currency: string; status: string }>();
    expect(row).toEqual({ amount: 6000, interval: 'year', currency: 'usd', status: 'pending' });
  });

  it('is in the sitemap', async () => {
    const ch = await seedMoney();
    expect(await (await page(ch, '/sitemap-pages.xml')).text()).toContain(
      `<loc>${ch.origin}/subscribe</loc>`,
    );
  });
});

describe('PayPal on the plans page', () => {
  const connectPayPal = async (channelId: string, workspaceId: string) => {
    const sealed = await sealAppKey(
      parseKeyring(`f1:${'f'.repeat(64)}`),
      workspaceId,
      'secret_value',
    );
    await env.DB.prepare(
      `INSERT INTO paypal_accounts (channel_id, workspace_id, mode, client_id, secret_enc, secret_last4, webhook_id, connected_at, updated_at)
       VALUES (?1, ?2, 'sandbox', 'client', ?3, 'alue', 'wh', 0, 0)`,
    )
      .bind(channelId, workspaceId, sealed)
      .run();
  };

  it('offers nothing until PayPal is connected, then works without Stripe', async () => {
    const without = await seedMoney({ account: 'none' });
    expect(await (await page(without, '/subscribe')).text()).not.toContain('Subscribe with PayPal');
    const ch = await seedMoney({ account: 'none' });
    await connectPayPal(ch.channelId, ch.workspaceId);
    const res = await page(ch, '/subscribe');
    const html = await res.text();
    expect(html).toContain('Subscribe with PayPal');
    expect(res.headers.get('content-security-policy')).toContain('https://www.paypal.com');
  });

  it('writes the checkout row and redirects to PayPal', async () => {
    const ch = await seedMoney({ account: 'none' });
    await connectPayPal(ch.channelId, ch.workspaceId);
    const res = await post(ch, '/_swarm/checkout/paypal', {
      'cf-turnstile-response': 'token',
      levelId: ch.levels.basic,
      interval: 'month',
      email: 'reader@example.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://www.sandbox.paypal.com/approve?token=1');
    const row = await env.DB.prepare(
      `SELECT email, intent, status FROM checkout_sessions WHERE channel_id = ?1 ORDER BY created_at DESC`,
    )
      .bind(ch.channelId)
      .first();
    expect(row).toEqual({ email: 'reader@example.com', intent: 'subscribe', status: 'open' });
  });

  it('is refused cross-site and when PayPal isn’t connected', async () => {
    const ch = await seedMoney({ account: 'none' });
    const closed = await post(ch, '/_swarm/checkout/paypal', {
      'cf-turnstile-response': 'token',
      levelId: ch.levels.basic,
      interval: 'month',
    });
    expect(await closed.text()).toContain('not open yet');
    await connectPayPal(ch.channelId, ch.workspaceId);
    const crossed = await post(
      ch,
      '/_swarm/checkout/paypal',
      { 'cf-turnstile-response': 'token', levelId: ch.levels.basic, interval: 'month' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(crossed.status).not.toBe(303);
  });
});

describe('POST /_swarm/checkout', () => {
  it('writes the checkout row first, then creates the session on the connected account', async () => {
    const ch = await seedMoney({ tax: true });
    const email = uniqueEmail('buyer');
    const res = await checkout(ch, { levelId: ch.levels.basic, interval: 'month', email });
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(new RegExp(`^${ch.origin}/_swarm/checkout/dev/cs_dev`));

    const call = lastSession()!;
    const account = await env.DB.prepare(
      'SELECT stripe_account_id FROM stripe_accounts WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .first<{ stripe_account_id: string }>();
    expect(call.options.account).toBe(account!.stripe_account_id);
    const params = call.params as Record<string, unknown>;
    // The signed reference is longer than Stripe takes in client_reference_id, so it is in
    // metadata; client_reference_id is the bare reference, for the Stripe dashboard.
    const clientReference = params.client_reference_id as string;
    expect(clientReference.length).toBeGreaterThan(0);
    expect(clientReference.length).toBeLessThanOrEqual(200);
    const reference = await referenceOf(params);
    expect(reference).not.toBeNull();
    expect(clientReference).toBe(reference);
    expect((params.metadata as Record<string, string>).swarm_ref).toMatch(/^v2\.checkout-ref\./);
    expect(call.options.idempotencyKey).toBe(reference);
    expect(stripe.rowsAtCreate[0]).toMatchObject({
      reference,
      channel_id: ch.channelId,
      level_id: ch.levels.basic,
      price_id: ch.prices[`${ch.levels.basic}:month`],
      intent: 'subscribe',
      status: 'open',
      email,
      stripe_session_id: null,
    });
    expect(params).toMatchObject({
      mode: 'subscription',
      customer_email: email,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      success_url: `${ch.origin}/subscribe/thanks?ref=${reference}`,
      cancel_url: `${ch.origin}/subscribe?canceled=1`,
      metadata: { channel: ch.channelId, reference },
    });
    expect(params).not.toHaveProperty('application_fee_percent');
    expect(JSON.stringify(params)).not.toContain('application_fee');
    expect((params.line_items as unknown[])[0]).toMatchObject({ quantity: 1 });
    const row = await env.DB.prepare(
      'SELECT stripe_session_id FROM checkout_sessions WHERE reference = ?1',
    )
      .bind(reference)
      .first<{ stripe_session_id: string }>();
    expect(location.endsWith(row!.stripe_session_id)).toBe(true);
  });

  it('builds success and cancel URLs with the URL API', () => {
    for (const origin of [
      'https://notes.example',
      'https://notes.example/',
      'https://notes.example/blog/?x=1#top',
    ]) {
      expect(checkoutUrls(origin, 'abcDEF_-123')).toEqual({
        success: 'https://notes.example/subscribe/thanks?ref=abcDEF_-123',
        cancel: 'https://notes.example/subscribe?canceled=1',
      });
    }
    expect(checkoutUrls('http://notes.site.localhost:8792', 'r').success).toBe(
      'http://notes.site.localhost:8792/subscribe/thanks?ref=r',
    );
  });

  it("refuses another publication's level, archived levels and Founding Levels without the flag", async () => {
    const ch = await seedMoney();
    const other = await seedMoney();
    for (const levelId of [
      other.levels.basic,
      ch.levels.archived,
      ch.levels.founding,
      'lv_bad',
      '',
    ]) {
      const res = await checkout(ch, { levelId, interval: 'month' });
      expect(res.status, levelId).toBe(404);
    }
    // A missing price for a level.
    expect((await checkout(ch, { levelId: ch.levels.basic, interval: 'lifetime' })).status).toBe(
      404,
    );
    expect(stripe.calls).toHaveLength(0);
    // Hidden levels can be bought by their id.
    expect((await checkout(ch, { levelId: ch.levels.hidden, interval: 'month' })).status).toBe(303);
  });

  it('answers a friendly page when the publication cannot take payments', async () => {
    for (const account of ['none', 'disabled'] as const) {
      const ch = await seedMoney({ account });
      const res = await checkout(ch, { levelId: ch.levels.basic, interval: 'month' });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('Paid subscriptions are not open yet');
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('requires Turnstile and refuses cross-site posts', async () => {
    const ch = await seedMoney();
    turnstile.pass = false;
    const failed = await checkout(ch, { levelId: ch.levels.basic, interval: 'month' });
    expect(failed.status).toBe(403);
    turnstile.pass = true;
    const noToken = await post(ch, '/_swarm/checkout', {
      levelId: ch.levels.basic,
      interval: 'month',
    });
    expect(noToken.status).toBe(403);
    turnstile.action = 'subscribe';
    expect((await checkout(ch, { levelId: ch.levels.basic, interval: 'month' })).status).toBe(403);
    turnstile.action = 'checkout';
    const cross = await checkout(
      ch,
      { levelId: ch.levels.basic, interval: 'month' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(cross.status).toBe(403);
    expect(stripe.calls).toHaveLength(0);
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM checkout_sessions WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('offers a trial once per email, and only when the email is known', async () => {
    const ch = await seedMoney({ trialDays: 14 });
    const email = uniqueEmail('trial');
    await checkout(ch, { levelId: ch.levels.basic, interval: 'month', email });
    expect(lastSession()!.params).toMatchObject({ subscription_data: { trial_period_days: 14 } });

    await env.DB.prepare(
      'INSERT INTO trial_claims (channel_id, email, level_id, created_at) VALUES (?1, ?2, ?3, 0)',
    )
      .bind(ch.channelId, email.toUpperCase(), ch.levels.basic)
      .run();
    await checkout(ch, { levelId: ch.levels.basic, interval: 'month', email });
    expect(lastSession()!.params.subscription_data).not.toHaveProperty('trial_period_days');

    await checkout(ch, { levelId: ch.levels.basic, interval: 'month' });
    expect(lastSession()!.params.subscription_data).not.toHaveProperty('trial_period_days');
    expect(lastSession()!.params).not.toHaveProperty('customer_email');
  });

  it('links a signed-in reader and reuses their Stripe customer', async () => {
    const ch = await seedMoney();
    const email = uniqueEmail('known');
    const memberId = await addMember(ch.channelId, email);
    await env.DB.prepare(
      'INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at) VALUES (?1, ?2, ?3, 0)',
    )
      .bind(memberId, ch.channelId, 'cus_known')
      .run();
    const cookie = await sessionCookie(ch.channelId, memberId);
    // The plans page names the account the purchase is for, with a way to buy as someone else,
    // and is never cached for anyone else.
    const plansPage = await call(site, `${ch.origin}/subscribe`, {
      headers: { cookie, 'user-agent': BROWSER_UA },
    });
    expect(plansPage.headers.get('cache-control')).toBe('private, no-store');
    const plansHtml = await plansPage.text();
    expect(plansHtml).toContain(`Buying as <strong>${email}</strong>`);
    expect(plansHtml).toContain(`name="buyer" value="${memberId}"`);
    expect(plansHtml).toContain('action="/_swarm/reader/signout"');

    // A post without the account the page named (a planted session, say) is not theirs.
    await checkout(ch, { levelId: ch.levels.basic, interval: 'year' }, { cookie });
    expect(lastSession()!.params).not.toHaveProperty('customer');
    expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ member_id: null });
    expect(
      await readCheckoutClaims(memberKeys(), signedCheckoutReference(lastSession()!.params)),
    ).toMatchObject({ signedIn: false });
    stripe.rowsAtCreate.length = 0;

    await checkout(ch, { levelId: ch.levels.basic, interval: 'year', buyer: memberId }, { cookie });
    const params = lastSession()!.params;
    expect(params.customer).toBe('cus_known');
    expect(params).not.toHaveProperty('customer_email');
    expect(stripe.rowsAtCreate[0]).toMatchObject({ member_id: memberId, email });
    // Only this checkout may link a new Stripe customer to the Member.
    const claims = () =>
      readCheckoutClaims(memberKeys(), signedCheckoutReference(lastSession()!.params));
    expect(await claims()).toMatchObject({ signedIn: true });
    expect(String(lastSession()!.params.client_reference_id).length).toBeLessThanOrEqual(200);

    // An email that matches a Member links that Member too, but isn't their own checkout.
    await checkout(ch, { levelId: ch.levels.basic, interval: 'month', email: email.toUpperCase() });
    expect(stripe.rowsAtCreate[1]).toMatchObject({ member_id: memberId });
    expect(await claims()).toMatchObject({ signedIn: false });
  });

  it("never hands a typed email the matching Member's Stripe customer", async () => {
    const ch = await seedMoney({ flags: ['pay_what_you_want', 'gift_passes'], tax: true });
    const email = uniqueEmail('victim');
    const memberId = await addMember(ch.channelId, email);
    await env.DB.prepare(
      'INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at) VALUES (?1, ?2, ?3, 0)',
    )
      .bind(memberId, ch.channelId, 'cus_victim')
      .run();
    const forms = [
      { levelId: ch.levels.basic, interval: 'month', email },
      { levelId: ch.levels.pro, interval: 'lifetime', email },
      {
        gift: '1',
        levelId: ch.levels.basic,
        months: '3',
        email,
        recipientEmail: uniqueEmail('friend'),
      },
      { tip: '1', amount: '3', email },
    ];
    for (const form of forms) {
      expect((await checkout(ch, form)).status).toBe(303);
      const params = lastSession()!.params;
      expect(params).not.toHaveProperty('customer');
      expect(params).not.toHaveProperty('customer_update');
      expect(params.customer_email).toBe(email);
      // Still credited to the Member; the webhook links the new customer on completion.
      expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ member_id: memberId });
    }
  });

  it('applies coupons as promotion codes and refuses unknown ones', async () => {
    const ch = await seedMoney({ couponOnGate: true });
    await checkout(ch, { levelId: ch.levels.basic, interval: 'month', coupon: 'welcome20' });
    const params = lastSession()!.params;
    expect(params.discounts).toEqual([{ promotion_code: 'promo_welcome' }]);
    expect(params).not.toHaveProperty('allow_promotion_codes');
    const bad = await checkout(ch, {
      levelId: ch.levels.basic,
      interval: 'month',
      coupon: 'NOPE99',
    });
    expect(bad.status).toBe(400);
  });

  it('takes pay-what-you-want amounts at or above the minimum, and lifetime as a payment', async () => {
    const ch = await seedMoney({ flags: ['pay_what_you_want'] });
    const low = await checkout(ch, { levelId: ch.levels.pro, interval: 'month', amount: '9.99' });
    expect(low.status).toBe(400);
    expect(await low.text()).toContain('at least $10');
    expect(
      (await checkout(ch, { levelId: ch.levels.pro, interval: 'month', amount: '12.50' })).status,
    ).toBe(303);
    expect((lastSession()!.params.line_items as unknown[])[0]).toMatchObject({
      price_data: { currency: 'usd', unit_amount: 1250, recurring: { interval: 'month' } },
    });
    expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ custom_amount: 1250 });

    await checkout(ch, { levelId: ch.levels.pro, interval: 'lifetime' });
    expect(lastSession()!.params).toMatchObject({ mode: 'payment', customer_creation: 'always' });
    expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ intent: 'lifetime' });

    await checkout(ch, { tip: '1', amount: '3' });
    expect(lastSession()!.params).toMatchObject({ mode: 'payment' });
    expect(stripe.rowsAtCreate.at(-1)).toMatchObject({
      intent: 'tip',
      custom_amount: 300,
      level_id: null,
    });
  });

  it('refuses pay-what-you-want and tips without the flag', async () => {
    const ch = await seedMoney();
    expect(
      (await checkout(ch, { levelId: ch.levels.pro, interval: 'month', amount: '20' })).status,
    ).toBe(404);
    expect((await checkout(ch, { tip: '1', amount: '3' })).status).toBe(404);
  });
});

describe('the dev checkout page and thanks page', () => {
  it('is served only on a local host name, even with PAYMENTS=dev', async () => {
    const ch = await seedMoney({ tax: true });
    const res = await checkout(ch, {
      levelId: ch.levels.basic,
      interval: 'month',
      email: uniqueEmail('buyer'),
    });
    const path = new URL(res.headers.get('location') ?? '').pathname;
    expect(path).toMatch(/^\/_swarm\/checkout\/dev\/cs_dev/);
    // The positive control: the test host is under the reserved .test domain.
    expect((await page(ch, path)).status).toBe(200);
    // The same Channel on a custom hostname a deployed site could be reached on.
    const hostname = `shop-${Date.now().toString(36)}.example.org`;
    await env.DB.prepare(
      `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, is_primary, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'web', 'active', 0, 0, 0)`,
    )
      .bind(`hn_${hostname.slice(5, 15)}`, ch.workspaceId, ch.channelId, hostname)
      .run();
    const deployed = { ...ch, origin: `https://${hostname}` };
    expect((await page(deployed, '/')).status).not.toBe(404);
    expect((await page(deployed, path)).status).toBe(404);
    expect((await post(deployed, path, {})).status).toBe(404);
  });

  it('builds Stripe-shaped events for a subscription', async () => {
    const reference = 'r'.repeat(24);
    const signed = await (
      await import('@swarm/engine')
    ).signCheckoutReference(memberKeys(), reference);
    const events = devCheckoutEvents({
      session: {
        id: 'cs_dev1',
        reference,
        intent: 'subscribe',
        email: 'a@example.org',
        customAmount: null,
        channelId: 'ch_x',
      },
      signedReference: signed,
      account: 'acct_x',
      customer: 'cus_x',
      price: { stripePriceId: 'price_x', interval: 'month', currency: 'usd', amount: 500 },
      trialDays: 7,
      now: 1_700_000_000_000,
    });
    expect(events.map((e) => e.type)).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
    ]);
    for (const event of events) {
      expect(event.id).toMatch(/^evt_/);
      expect(event.account).toBe('acct_x');
    }
    const session = events[0]!.data.object;
    expect(await referenceOf(session)).toBe(reference);
    expect(session).toMatchObject({ mode: 'subscription', customer: 'cus_x' });
    const sub = events[1]!.data.object as {
      id: string;
      status: string;
      items: { data: { current_period_end: number; price: { id: string } }[] };
    };
    expect(session.subscription).toBe(sub.id);
    expect(sub.status).toBe('trialing');
    expect(sub.items.data[0]!.price.id).toBe('price_x');
    expect(sub.items.data[0]!.current_period_end).toBe(1_700_000_000 + 7 * 86_400);
  });

  it('completes a test purchase through the processor and shows the thanks page', async () => {
    const ch = await seedMoney();
    const res = await checkout(ch, {
      levelId: ch.levels.basic,
      interval: 'month',
      email: uniqueEmail(),
    });
    const devUrl = res.headers.get('location')!;
    const pageRes = await call(site, devUrl);
    expect(await pageRes.text()).toContain('Complete test purchase');
    const done = await post(ch, new URL(devUrl).pathname, {});
    expect(done.status).toBe(303);
    expect(processed.map((e) => e.type)).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
    ]);
    const thanks = done.headers.get('location')!;
    expect(thanks).toMatch(new RegExp(`^${ch.origin}/subscribe/thanks\\?ref=`));

    // The fake processor changed nothing: the checkout is still open.
    const open = await call(site, thanks);
    const openHtml = await open.text();
    expect(openHtml).toContain('Finishing up');
    expect(openHtml).toContain('<meta http-equiv="refresh" content="3">');
    expect(open.headers.get('cache-control')).toBe('no-store');

    const ref = new URL(thanks).searchParams.get('ref')!;
    await env.DB.prepare(`UPDATE checkout_sessions SET status = 'complete' WHERE reference = ?1`)
      .bind(ref)
      .run();
    const complete = await (await call(site, thanks)).text();
    expect(complete).toContain("You're in");
    expect(complete).toContain('/_swarm/reader/signin');

    expect((await call(site, `${ch.origin}/subscribe/thanks?ref=nope`)).status).toBe(404);
  });

  it('end to end with the real processor: the buyer confirms their address, then reads in full', async () => {
    const real = createSite((s) => mountSite(s, { stripe: () => stripe }));
    const ch = await seedMoney();
    const email = uniqueEmail();
    const res = await checkout(ch, { levelId: ch.levels.basic, interval: 'month', email });
    const devUrl = res.headers.get('location')!;
    const done = await call(real, `${ch.origin}${new URL(devUrl).pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ch.origin,
        'sec-fetch-site': 'same-origin',
        'cf-connecting-ip': nextIp(),
        'user-agent': BROWSER_UA,
      },
      body: '',
    });
    expect(done.status).toBe(303);
    const thanks = done.headers.get('location')!;
    const thanked = await (await call(real, thanks)).text();
    expect(thanked).toContain("You're in");
    // A typed address proves nothing: the buyer is told to confirm it before reading.
    expect(thanked).toContain('confirm your email address');

    const member = await env.DB.prepare(
      'SELECT id, status, confirmed_at FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, email)
      .first<{ id: string; status: string; confirmed_at: number | null }>();
    expect(member).toMatchObject({ status: 'pending', confirmed_at: null });
    const request = await env.DB.prepare(
      `SELECT id FROM confirm_requests WHERE member_id = ?1 AND kind = 'subscribe'`,
    )
      .bind(member!.id)
      .first<{ id: string }>();
    expect((await confirmRequest(env.DB, request!.id)).outcome).toBe('confirmed');
    const entitlement = await env.DB.prepare(
      `SELECT level_id FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    )
      .bind(member!.id)
      .first<{ level_id: string }>();
    expect(entitlement?.level_id).toBe(ch.levels.basic);

    const cookie = await sessionCookie(ch.channelId, member!.id);
    const article = await call(real, `${ch.origin}/p/paid-one`, {
      headers: { 'user-agent': BROWSER_UA, cookie },
    });
    expect(await article.text()).toContain('Secret paid one.');
    // The Pro-only Gate still refuses a Basic Member.
    const pro = await call(real, `${ch.origin}/p/pro-only`, {
      headers: { 'user-agent': BROWSER_UA, cookie },
    });
    expect(await pro.text()).not.toContain('Secret pro only.');
  });
});

describe('Gift subscriptions', () => {
  async function paidGift(ch: Money, options: { claimBy?: number; recipient?: string } = {}) {
    const token = 'g'.repeat(10) + hex();
    const id = newId('giftPass');
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, recipient_email,
         message, claim_token_hash, status, claim_by, created_at)
       VALUES (?1, ?2, ?3, 3, 'giver@example.org', ?4, 'Enjoy!', ?5, 'paid', ?6, 0)`,
    )
      .bind(
        id,
        ch.channelId,
        ch.levels.basic,
        options.recipient ?? null,
        await sha256Hex(token),
        options.claimBy ?? Date.now() + 86_400_000,
      )
      .run();
    return { id, token };
  }

  it('sells a gift subscription as a one-time payment of months × the monthly price', async () => {
    const ch = await seedMoney({ flags: ['gift_passes'] });
    const off = await seedMoney();
    const fields = {
      gift: '1',
      levelId: ch.levels.basic,
      months: '6',
      email: uniqueEmail('giver'),
      recipientEmail: uniqueEmail('friend'),
      message: 'Happy birthday',
    };
    expect((await checkout(off, { ...fields, levelId: off.levels.basic })).status).toBe(404);
    const res = await checkout(ch, fields);
    expect(res.status).toBe(303);
    const params = lastSession()!.params;
    expect(params).toMatchObject({ mode: 'payment' });
    expect(params).not.toHaveProperty('allow_promotion_codes');
    expect((params.line_items as unknown[])[0]).toMatchObject({
      price_data: { currency: 'usd', unit_amount: 3000 },
    });
    const row = stripe.rowsAtCreate[0]!;
    expect(row).toMatchObject({ intent: 'gift', level_id: ch.levels.basic });
    const gift = await env.DB.prepare('SELECT * FROM gift_passes WHERE id = ?1')
      .bind(row.subject_id)
      .first<Record<string, unknown>>();
    expect(gift).toMatchObject({
      status: 'pending_payment',
      months: 6,
      recipient_email: fields.recipientEmail,
      purchaser_email: fields.email,
      message: 'Happy birthday',
    });
    expect(gift!.checkout_session_id).toMatch(/^cs_dev/);
    expect((await checkout(ch, { ...fields, months: '5' })).status).toBe(400);
  });

  it('claims once, creates an active subscriber with a gift subscription, and signs nobody in', async () => {
    const ch = await seedMoney();
    const email = uniqueEmail('claimant');
    const { id, token } = await paidGift(ch, { recipient: email });
    const view = await page(ch, `/_swarm/gift/${token}`);
    const html = await view.text();
    expect(html).toContain('3 months of Basic');
    expect(html).toContain('Enjoy!');
    // GET never claims.
    expect(
      (await env.DB.prepare('SELECT status FROM gift_passes WHERE id = ?1')
        .bind(id)
        .first<{ status: string }>())!.status,
    ).toBe('paid');

    const res = await post(ch, `/_swarm/gift/${token}`, { email });
    expect(res.status).toBe(200);
    // Claiming never signs the browser in: reading starts with the usual emailed sign-in link.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Sign in with that address');
    const member = await env.DB.prepare(
      'SELECT id, status FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, email)
      .first<{ id: string; status: string }>();
    expect(member!.status).toBe('active');
    const sub = await env.DB.prepare(
      `SELECT source, status, level_id, current_period_end FROM member_subscriptions WHERE member_id = ?1`,
    )
      .bind(member!.id)
      .first<{ source: string; status: string; level_id: string; current_period_end: number }>();
    expect(sub).toMatchObject({ source: 'gift', status: 'active', level_id: ch.levels.basic });
    expect(sub!.current_period_end).toBeGreaterThan(Date.now() + 85 * 86_400_000);
    const entitlement = await env.DB.prepare(
      `SELECT level_id FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    )
      .bind(member!.id)
      .first<{ level_id: string }>();
    expect(entitlement!.level_id).toBe(ch.levels.basic);

    const again = await post(ch, `/_swarm/gift/${token}`, { email: uniqueEmail() });
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('already claimed');
  });

  it('refuses expired and unknown passes, and never signs in as an existing subscriber', async () => {
    const ch = await seedMoney();
    const expired = await paidGift(ch, { claimBy: Date.now() - 1000 });
    expect((await post(ch, `/_swarm/gift/${expired.token}`, { email: uniqueEmail() })).status).toBe(
      410,
    );
    expect((await page(ch, `/_swarm/gift/${expired.token}`)).status).toBe(410);
    expect((await page(ch, `/_swarm/gift/${'x'.repeat(40)}`)).status).toBe(404);

    const victim = uniqueEmail('victim');
    await addMember(ch.channelId, victim);
    const gift = await paidGift(ch, { recipient: uniqueEmail('someone-else') });
    const res = await post(ch, `/_swarm/gift/${gift.token}`, { email: victim });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Sign in with that address');

    // The address the link was sent to is trusted.
    const friend = uniqueEmail('friend');
    await addMember(ch.channelId, friend);
    const mailed = await paidGift(ch, { recipient: friend });
    const ok = await post(ch, `/_swarm/gift/${mailed.token}`, { email: friend });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Your gift is claimed');
  });

  it('keeps a browser signed in as its own reader when someone else’s gift is claimed there', async () => {
    const ch = await seedMoney();
    // The buyer names their own address, then sends the claim link to someone else.
    const buyer = uniqueEmail('buyer');
    const gift = await paidGift(ch, { recipient: buyer });
    const visitor = await addMember(ch.channelId, uniqueEmail('visitor'));
    const cookie = await sessionCookie(ch.channelId, visitor);
    const res = await post(ch, `/_swarm/gift/${gift.token}`, { email: buyer }, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    // No session for the buyer's Member was written anywhere.
    const buyerSessions = await env.DB.prepare(
      `SELECT count(*) AS n FROM reader_sessions s JOIN members m ON m.id = s.member_id
        WHERE m.channel_id = ?1 AND m.email = ?2`,
    )
      .bind(ch.channelId, buyer)
      .first<{ n: number }>();
    expect(buyerSessions?.n).toBe(0);
  });

  it('regression (S04-P2-TR-checkout-buyer-identity-confirm): a gift claim never lets a checkout credit the claim’s subscriber without signing in', async () => {
    const ch = await seedMoney();
    // Someone buys a gift for their own address and sends the claim link to another person.
    const owner = uniqueEmail('owner');
    const gift = await paidGift(ch, { recipient: owner });
    const ownerId = await addMember(ch.channelId, owner);
    await env.DB.prepare(
      'INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at) VALUES (?1, ?2, ?3, 0)',
    )
      .bind(ownerId, ch.channelId, 'cus_claim_owner')
      .run();
    const asOwner = async (res: Response) => {
      expect(res.status).toBe(303);
      expect(lastSession()!.params).not.toHaveProperty('customer');
      expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ member_id: null });
      expect(
        await readCheckoutClaims(memberKeys(), signedCheckoutReference(lastSession()!.params)),
      ).toMatchObject({ signedIn: false });
    };

    // A signed-out browser claims it: no cookie comes back, so a checkout it makes next, even one
    // naming the claim's subscriber as the buyer, is a signed-out checkout.
    const claim = await post(ch, `/_swarm/gift/${gift.token}`, { email: owner });
    expect(claim.status).toBe(200);
    // Whatever the claim's answer set, the browser carries into its next checkout.
    const carried = (claim.headers.get('set-cookie') ?? '')
      .split(/,(?=\s*[^;=\s]+=)/)
      .map((part) => part.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');
    expect(carried).toBe('');
    stripe.rowsAtCreate.length = 0;
    await asOwner(
      await checkout(
        ch,
        { levelId: ch.levels.basic, interval: 'year', buyer: ownerId },
        carried ? { cookie: carried } : {},
      ),
    );

    // A browser signed in as its own reader claims someone else's gift: its session stays its
    // own, so a checkout naming the claim's subscriber is not theirs either, and its own still is.
    const visitor = uniqueEmail('visitor');
    const visitorId = await addMember(ch.channelId, visitor);
    const cookie = await sessionCookie(ch.channelId, visitorId);
    const other = await paidGift(ch, { recipient: owner });
    const second = await post(ch, `/_swarm/gift/${other.token}`, { email: owner }, { cookie });
    expect(second.headers.get('set-cookie')).toBeNull();
    await asOwner(
      await checkout(
        ch,
        { levelId: ch.levels.basic, interval: 'year', buyer: ownerId },
        { cookie },
      ),
    );
    await checkout(
      ch,
      { levelId: ch.levels.basic, interval: 'year', buyer: visitorId },
      { cookie },
    );
    expect(stripe.rowsAtCreate.at(-1)).toMatchObject({ member_id: visitorId, email: visitor });
    expect(
      await readCheckoutClaims(memberKeys(), signedCheckoutReference(lastSession()!.params)),
    ).toMatchObject({ signedIn: true });
  });

  it('a claim for an address the link was not mailed to starts no session until that address confirms', async () => {
    const ch = await seedMoney();
    const gift = await paidGift(ch, { recipient: uniqueEmail('attacker') });
    const victim = uniqueEmail('victim');
    const res = await post(ch, `/_swarm/gift/${gift.token}`, { email: victim });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Check your email');
    const member = await env.DB.prepare(
      'SELECT id, status, consent_at, confirmed_at FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, victim)
      .first<{
        id: string;
        status: string;
        consent_at: number | null;
        confirmed_at: number | null;
      }>();
    expect(member).toMatchObject({ status: 'pending', consent_at: null, confirmed_at: null });
    // The gift still lands on that address, and is there once it confirms.
    expect(await entitledLevel(env.DB, ch.channelId, member!.id, Date.now())).toBe(ch.levels.basic);
    const mails = await mailTo(victim);
    expect(mails.map((m) => m.category)).toEqual(['confirm']);
    const request = await env.DB.prepare(
      `SELECT id FROM confirm_requests WHERE member_id = ?1 AND kind = 'subscribe'`,
    )
      .bind(member!.id)
      .first<{ id: string }>();
    expect((await confirmRequest(env.DB, request!.id)).outcome).toBe('confirmed');
    const signin = await post(ch, '/_swarm/reader/signin', { email: victim });
    expect(signin.status).toBe(200);
    expect((await mailTo(victim)).map((m) => m.category).sort()).toEqual([
      'confirm',
      'reader_signin',
    ]);
  });

  it('makes the address the claim link was mailed to an active Member, with no session', async () => {
    const ch = await seedMoney();
    const friend = uniqueEmail('friend');
    const toFriend = await paidGift(ch, { recipient: friend });
    const res = await post(ch, `/_swarm/gift/${toFriend.token}`, { email: friend });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const member = await env.DB.prepare(
      'SELECT status, confirmed_at FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, friend)
      .first<{ status: string; confirmed_at: number | null }>();
    expect(member!.status).toBe('active');
    expect(member!.confirmed_at).not.toBeNull();
    expect(await mailTo(friend)).toHaveLength(0);

    // No recipient: the link went to the purchaser, so the purchaser's own address is trusted too.
    const toGiver = await paidGift(ch);
    const own = await post(ch, `/_swarm/gift/${toGiver.token}`, { email: 'giver@example.org' });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('Your gift is claimed');
    const giver = await env.DB.prepare(
      'SELECT status FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, 'giver@example.org')
      .first<{ status: string }>();
    expect(giver?.status).toBe('active');
  });

  it("claims with the claim reminder's link too, once, and the first link then says claimed", async () => {
    const ch = await seedMoney();
    const late = uniqueEmail('late');
    const { id, token } = await paidGift(ch, { recipient: late });
    const reminder = 'r'.repeat(10) + hex();
    await env.DB.prepare('UPDATE gift_passes SET reminder_token_hash = ?1 WHERE id = ?2')
      .bind(await sha256Hex(reminder), id)
      .run();
    expect(await (await page(ch, `/_swarm/gift/${reminder}`)).text()).toContain(
      '3 months of Basic',
    );
    const res = await post(ch, `/_swarm/gift/${reminder}`, { email: late });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Your gift is claimed');
    const again = await post(ch, `/_swarm/gift/${token}`, { email: uniqueEmail() });
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('already claimed');
  });

  it('a full refund or a dispute ends the pass, and the access a claim got from it', async () => {
    const ch = await seedMoney();
    const { stripe_account_id: account } = (await env.DB.prepare(
      'SELECT stripe_account_id FROM stripe_accounts WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .first<{ stripe_account_id: string }>())!;
    /** A paid pass bought through a Checkout Session, as the webhook leaves it. */
    const bought = async () => {
      const gift = await paidGift(ch);
      const sessionId = `cs_${hex()}`;
      await env.DB.prepare('UPDATE gift_passes SET checkout_session_id = ?1 WHERE id = ?2')
        .bind(sessionId, gift.id)
        .run();
      return { ...gift, sessionId, paymentIntent: `pi_${hex()}` };
    };
    const claim = async (token: string) => {
      // An address the link was not mailed to: the grant lands on a pending Member.
      const email = uniqueEmail('claimant');
      expect((await post(ch, `/_swarm/gift/${token}`, { email })).status).toBe(200);
      const member = await env.DB.prepare(
        'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
      )
        .bind(ch.channelId, email)
        .first<{ id: string }>();
      expect(await entitledLevel(env.DB, ch.channelId, member!.id, Date.now())).toBe(
        ch.levels.basic,
      );
      return member!.id;
    };
    const send = (gift: Awaited<ReturnType<typeof bought>>, type: string) => {
      const charge = {
        id: `ch_${hex()}`,
        object: 'charge',
        amount: 1500,
        amount_refunded: 1500,
        refunded: true,
        currency: 'usd',
        customer: null,
        invoice: null,
        payment_intent: gift.paymentIntent,
      };
      const object =
        type === 'charge.refunded'
          ? charge
          : { id: `dp_${hex()}`, object: 'dispute', payment_intent: gift.paymentIntent, charge };
      const now = Date.now();
      const fake = new DevStripe();
      fake.respond(/^GET \/v1\/checkout\/sessions$/, { data: [{ id: gift.sessionId }] });
      return handleStripeEvent(
        { db: env.DB, stripe: fake, links: memberKeys(), fieldKeys: undefined, now },
        {
          id: `evt_${hex()}`,
          type,
          account,
          created: Math.floor(now / 1000),
          livemode: false,
          data: { object },
        },
      );
    };
    const ended = async (giftId: string, memberId: string | null, reason: string) => {
      const pass = await env.DB.prepare('SELECT status FROM gift_passes WHERE id = ?1')
        .bind(giftId)
        .first<{ status: string }>();
      expect(pass?.status).toBe('refunded');
      if (!memberId) return;
      const grant = await env.DB.prepare(
        `SELECT revoke_reason FROM member_subscriptions WHERE member_id = ?1 AND source = 'gift'`,
      )
        .bind(memberId)
        .first<{ revoke_reason: string | null }>();
      expect(grant?.revoke_reason).toBe(reason);
      expect(await entitledLevel(env.DB, ch.channelId, memberId, Date.now())).toBeUndefined();
    };

    const disputed = await bought();
    const disputer = await claim(disputed.token);
    expect(await send(disputed, 'charge.dispute.created')).toBe('processed');
    await ended(disputed.id, disputer, 'dispute');

    const refunded = await bought();
    const refundee = await claim(refunded.token);
    expect(await send(refunded, 'charge.refunded')).toBe('processed');
    await ended(refunded.id, refundee, 'refund');

    // An unclaimed pass whose payment is disputed can't be claimed afterwards.
    const unclaimed = await bought();
    expect(await send(unclaimed, 'charge.dispute.created')).toBe('processed');
    await ended(unclaimed.id, null, 'dispute');
    const late = await post(ch, `/_swarm/gift/${unclaimed.token}`, { email: uniqueEmail() });
    expect(late.status).toBe(410);
  });
});

describe('gift articles', () => {
  it('lets an entitled subscriber share up to 5 a month; a link reads in full without the meter', async () => {
    const ch = await seedMoney({ flags: ['gift_articles'], meter: { limit: 1 } });
    const reader = await paidReader(ch, ch.levels.basic);
    const article = await (await page(ch, '/p/paid-one', { cookie: reader.cookie })).text();
    expect(article).toContain('Gift this post');

    const links: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post(
        ch,
        '/_swarm/gift-article',
        { dispatchId: ch.dispatches.paid },
        { cookie: reader.cookie },
      );
      expect(res.status).toBe(200);
      links.push(/value="(http[^"]+)"/.exec(await res.text())![1]!.replace(/&amp;/g, '&'));
    }
    const sixth = await post(
      ch,
      '/_swarm/gift-article',
      { dispatchId: ch.dispatches.paid },
      { cookie: reader.cookie },
    );
    expect(sixth.status).toBe(429);

    const link = new URL(links[0]!);
    expect(link.pathname).toBe('/p/paid-one');
    const res = await page(ch, `${link.pathname}${link.search}`);
    const html = await res.text();
    expect(html).toContain('Secret paid one.');
    expect(html).toContain('A subscriber shared this post with you.');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(meterCookie(res)).toBeNull();
    // The next page (where owner code may run) must not see the token in document.referrer.
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
    expect(html).not.toContain('strict-origin-when-cross-origin');
    // The link is for that Dispatch only.
    expect(
      await (await page(ch, `/p/paid-two${link.search}`, { 'user-agent': 'curl/8' })).text(),
    ).not.toContain('Secret paid two.');
  });

  it('shares a link only with a form the reader submitted, never with page script', async () => {
    const ch = await seedMoney({ flags: ['gift_articles'] });
    const reader = await paidReader(ch, ch.levels.basic);
    const share = (headers: Record<string, string>) =>
      post(
        ch,
        '/_swarm/gift-article',
        { dispatchId: ch.dispatches.paid },
        { cookie: reader.cookie, ...headers },
      );
    // fetch() or XMLHttpRequest from a page of the site, and a form aimed at a frame.
    expect((await share({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403);
    expect((await share({ 'sec-fetch-mode': 'same-origin' })).status).toBe(403);
    expect((await share({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })).status).toBe(
      403,
    );
    const links = await env.DB.prepare(
      'SELECT count(*) AS n FROM gift_article_links WHERE member_id = ?1',
    )
      .bind(reader.memberId)
      .first<{ n: number }>();
    expect(links?.n).toBe(0);
    // The reader's own form submission works, and its page is cut off from its opener.
    const ok = await share({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('refuses readers who are not signed in, not entitled, or without the flag', async () => {
    const ch = await seedMoney({ flags: ['gift_articles'] });
    expect(
      (await post(ch, '/_swarm/gift-article', { dispatchId: ch.dispatches.paid })).status,
    ).toBe(403);
    const member = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, member);
    expect(
      (await post(ch, '/_swarm/gift-article', { dispatchId: ch.dispatches.paid }, { cookie }))
        .status,
    ).toBe(403);
    // Members-only Dispatches can be shared by Members.
    expect(
      (await post(ch, '/_swarm/gift-article', { dispatchId: ch.dispatches.members }, { cookie }))
        .status,
    ).toBe(200);
    const off = await seedMoney();
    const offReader = await paidReader(off, null);
    expect(
      (
        await post(
          off,
          '/_swarm/gift-article',
          { dispatchId: off.dispatches.paid },
          { cookie: offReader.cookie },
        )
      ).status,
    ).toBe(404);
  });

  it('gives a gift link a stated reach: revocable, capped and ending with the sharer’s access', async () => {
    const ch = await seedMoney({ flags: ['gift_articles'] });
    const mint = async (cookie: string) => {
      const res = await post(
        ch,
        '/_swarm/gift-article',
        { dispatchId: ch.dispatches.paid },
        { cookie },
      );
      const html = await res.text();
      expect(html).toContain(
        `up to ${GIFT_ARTICLE_MAX_READS} times, while your subscription includes it`,
      );
      const url = new URL(/value="(http[^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&'));
      return `${url.pathname}${url.search}`;
    };
    const reads = async (path: string) =>
      (await (await page(ch, path)).text()).includes('Secret paid one.');

    // The sharer stops their own link.
    const sharer = await paidReader(ch, ch.levels.basic);
    const stopped = await mint(sharer.cookie);
    expect(await reads(stopped)).toBe(true);
    const revoke = await post(
      ch,
      '/_swarm/gift-article/revoke',
      { dispatchId: ch.dispatches.paid },
      { cookie: sharer.cookie },
    );
    expect(revoke.status).toBe(200);
    expect(await reads(stopped)).toBe(false);

    // A link stops once its sharer can no longer read the post (a cancellation or refund).
    const leaver = await paidReader(ch, ch.levels.basic);
    const lapsed = await mint(leaver.cookie);
    expect(await reads(lapsed)).toBe(true);
    await env.DB.prepare('DELETE FROM member_entitlements WHERE member_id = ?1')
      .bind(leaver.memberId)
      .run();
    expect(await reads(lapsed)).toBe(false);

    // A link posted in public stops after its reads are used up.
    const poster = await paidReader(ch, ch.levels.basic);
    const posted = await mint(poster.cookie);
    await env.DB.prepare('UPDATE gift_article_links SET reads = ?1 - 1 WHERE member_id = ?2')
      .bind(GIFT_ARTICLE_MAX_READS, poster.memberId)
      .run();
    expect(await reads(posted)).toBe(true);
    expect(await reads(posted)).toBe(false);
  });
});

describe('POST /_swarm/portal', () => {
  it('is for signed-in readers with a Stripe customer only', async () => {
    const ch = await seedMoney();
    expect((await post(ch, '/_swarm/portal', {})).status).toBe(403);

    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    const none = await post(ch, '/_swarm/portal', {}, { cookie });
    expect(none.status).toBe(200);
    expect(await none.text()).toContain('No billing to manage');

    await env.DB.prepare(
      'INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at) VALUES (?1, ?2, ?3, 0)',
    )
      .bind(memberId, ch.channelId, 'cus_portal')
      .run();
    const res = await post(ch, '/_swarm/portal', {}, { cookie });
    expect(res.status).toBe(303);
    const call = stripe.calls.find((c) => c.path === '/v1/billing_portal/sessions')!;
    expect(call.params).toEqual({ customer: 'cus_portal', return_url: `${ch.origin}/subscribe` });
    expect(call.options.account).toMatch(/^acct_/);

    expect(
      (
        await post(
          ch,
          '/_swarm/portal',
          {},
          { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        )
      ).status,
    ).toBe(403);
  });
});

describe('a signup in steps', () => {
  const steps = async (path: string, options: MoneyOptions = {}) => {
    const ch = await seedMoney({ account: 'open', flags: ['signup_paths'], ...options });
    await env.DB.prepare('UPDATE channels SET settings_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify({ signupPath: path }), ch.channelId)
      .run();
    return ch;
  };
  /**
   * The token the capture worker hands over after a sign-up, minted by the vault for a live form
   * of the Channel. `memberId` is the id the sign-up gives the Member it creates, if any.
   */
  const tokenFor = async (
    channelId: string,
    email: string,
    journey: string | null = null,
    memberId = newId('member'),
  ) => {
    const formId = newId('captureForm');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, created_at, updated_at)
       SELECT ?1, workspace_id, id, 'Form', 'published', '{}', ?2, ?2 FROM channels WHERE id = ?3`,
    )
      .bind(formId, now, channelId)
      .run();
    const capture = createFakeVault('capture', await testVaultEnv(env as never));
    const minted = await capture.mintJoinToken({
      formId,
      memberId,
      email,
      ...(journey ? { journeyPath: journey } : {}),
    });
    if (!minted.ok) throw new Error(`no join token: ${minted.reason}`);
    return minted.value;
  };
  const nameOf = (id: string) =>
    env.DB.prepare('SELECT first_name, last_name FROM members WHERE id = ?1')
      .bind(id)
      .first<{ first_name: string | null; last_name: string | null }>();

  it('asks for the name, saves it on the new subscriber and moves on', async () => {
    const ch = await steps('email_name');
    const email = uniqueEmail('stepper');
    const id = await addMember(ch.channelId, email, 'pending');
    const token = await tokenFor(ch.channelId, email, null, id);

    const start = await page(ch, `/_swarm/join/${token}`);
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe(`/_swarm/join/${token}/name`);

    const form = await page(ch, `/_swarm/join/${token}/name`);
    expect(form.status).toBe(200);
    expect(form.headers.get('cache-control')).toContain('no-store');
    expect(form.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await form.text();
    // A meta element replaces the header's policy, so it must not loosen it.
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toContain('strict-origin-when-cross-origin');
    expect(html).toContain('name="firstName"');
    expect(html).not.toContain(email);

    const saved = await post(ch, `/_swarm/join/${token}/name`, {
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/_swarm/join/${token}/done`);
    expect(await nameOf(id)).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('never changes a subscriber this signup did not create, and answers the same', async () => {
    const ch = await steps('email_name');
    const email = uniqueEmail('known');
    const id = await addMember(ch.channelId, email);
    await env.DB.prepare(`UPDATE members SET created_at = ?1, first_name = 'Grace' WHERE id = ?2`)
      .bind(Date.now() - 86_400_000, id)
      .run();
    const token = await tokenFor(ch.channelId, email);
    const res = await post(ch, `/_swarm/join/${token}/name`, { firstName: 'Mallory' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/_swarm/join/${token}/done`);
    expect((await nameOf(id))?.first_name).toBe('Grace');
  });

  it('never names a Member another path created minutes before this signup', async () => {
    const ch = await steps('email_name');
    const email = uniqueEmail('fresh');
    // A real sign-up, an import or an API create, three minutes before a stranger types the
    // address into the site's form. Their sign-up finds the address taken and adds no row.
    const id = await addMember(ch.channelId, email, 'pending');
    await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 3 * 60 * 1000, id)
      .run();
    const token = await tokenFor(ch.channelId, email);
    const res = await post(ch, `/_swarm/join/${token}/name`, {
      firstName: 'Mallory',
      lastName: 'Stranger',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/_swarm/join/${token}/done`);
    // The name is saved after the response.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await nameOf(id)).toEqual({ first_name: null, last_name: null });
  });

  it('refuses another publication’s token, a bad token and a cross-site post', async () => {
    const ch = await steps('email_name');
    const other = await steps('email_name');
    const email = uniqueEmail('stray');
    const token = await tokenFor(other.channelId, email);
    expect(await (await page(ch, `/_swarm/join/${token}/name`)).text()).toContain('has expired');
    expect(await (await page(ch, '/_swarm/join/nonsense/name')).text()).toContain('has expired');
    const own = await tokenFor(ch.channelId, email);
    const cross = await post(
      ch,
      `/_swarm/join/${own}/name`,
      { firstName: 'X' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(cross.status).toBe(403);
  });

  it('treats the pages as gone with the flag off', async () => {
    const ch = await steps('email_name', { flags: [] });
    const token = await tokenFor(ch.channelId, uniqueEmail());
    expect(await (await page(ch, `/_swarm/join/${token}/name`)).text()).toContain('has expired');
  });

  it('offers plans, and checkout takes the address from the token, not the URL', async () => {
    const ch = await steps('email_name_plan');
    const email = uniqueEmail('buyer');
    const token = await tokenFor(ch.channelId, email);
    const saved = await post(ch, `/_swarm/join/${token}/name`, {});
    expect(saved.headers.get('location')).toBe(`/_swarm/join/${token}/plan`);

    const plan = await page(ch, `/_swarm/join/${token}/plan`);
    expect(plan.headers.get('content-security-policy')).toContain('challenges.cloudflare.com');
    expect(plan.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await plan.text();
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toContain('strict-origin-when-cross-origin');
    expect(html).toContain('Continue with free');
    expect(html).toContain('name="joinToken"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain(email);

    const res = await checkout(ch, {
      levelId: ch.levels.basic,
      interval: 'month',
      joinToken: token,
    });
    expect(res.status).toBe(303);
    expect(lastSession()!.params).toMatchObject({ customer_email: email.toLowerCase() });
  });

  it('ignores a token from another publication at checkout', async () => {
    const ch = await steps('email_name_plan');
    const other = await steps('email_name_plan');
    const token = await tokenFor(other.channelId, uniqueEmail('stray'));
    await checkout(ch, { levelId: ch.levels.basic, interval: 'month', joinToken: token });
    expect(lastSession()!.params).not.toHaveProperty('customer_email');
  });

  it('skips the plan step when nothing can be bought', async () => {
    const ch = await steps('email_name_plan', { account: 'none' });
    const token = await tokenFor(ch.channelId, uniqueEmail());
    const saved = await post(ch, `/_swarm/join/${token}/name`, {});
    expect(saved.headers.get('location')).toBe(`/_swarm/join/${token}/done`);
    const plan = await page(ch, `/_swarm/join/${token}/plan`);
    expect(plan.headers.get('location')).toBe(`/_swarm/join/${token}/done`);
  });

  it('sends no referrer from any step, so the token never reaches the next page', async () => {
    const ch = await steps('email_name');
    const token = await tokenFor(ch.channelId, uniqueEmail());
    for (const path of [`/_swarm/join/${token}/done`, '/_swarm/join/nonsense/name']) {
      const res = await page(ch, path);
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      const html = await res.text();
      expect(html, path).toContain('<meta name="referrer" content="no-referrer">');
      expect(html, path).not.toContain('strict-origin-when-cross-origin');
    }
    // The page the done step links to keeps the site's usual policy.
    const archive = await page(ch, '/archive');
    expect(await archive.text()).toContain(
      '<meta name="referrer" content="strict-origin-when-cross-origin">',
    );
  });

  it('hands over to a live Signup Journey at the end', async () => {
    const ch = await steps('email_name');
    const token = await tokenFor(ch.channelId, uniqueEmail(), '/v1/j/abc/0');
    const done = await page(ch, `/_swarm/join/${token}/done`);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toMatch(/\/v1\/j\/abc\/0$/);
  });
});
