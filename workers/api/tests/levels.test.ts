import { env } from 'cloudflare:test';
import type { Coupon, LevelPrice, MembershipLevel, MembershipLevelList } from '@swarm/domain';
import type { DevStripe } from '@swarm/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStripeForTests } from '../src/lib/levels';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import {
  connectAccount,
  data,
  enableFlag,
  errorCode,
  freshStripe,
  levelBody,
} from './money-helpers';

let owner: Session;
let admin: Session;
let editor: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;
let accountId: string;
let stripe: DevStripe;

const levelsPath = (id = channelId) => `/api/v1/channels/${id}/levels`;

async function createLevel(body: Record<string, unknown> = {}, s: Session = owner) {
  return data<MembershipLevel>(
    await call('POST', levelsPath(), { cookie: s.cookie, body: levelBody(body) }),
    201,
  );
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  admin = await seatAs(owner.workspaceId, 'admin');
  editor = await seatAs(owner.workspaceId, 'editor');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
  accountId = await connectAccount(owner, channelId);
});

beforeEach(() => {
  stripe = freshStripe();
});

afterAll(() => useStripeForTests(undefined));

describe('Membership levels', () => {
  it('needs a connected account that can take payments', async () => {
    const other = (await createChannel(owner)).id;
    let res = await call('POST', levelsPath(other), { cookie: owner.cookie, body: levelBody() });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    await connectAccount(owner, other, { chargesEnabled: false });
    res = await call('POST', levelsPath(other), { cookie: owner.cookie, body: levelBody() });
    expect(res.status).toBe(409);
    expect(stripe.calls).toHaveLength(0);
  });

  it('is unavailable when payments are off for the deployment', async () => {
    useStripeForTests(null);
    const res = await call('POST', levelsPath(), { cookie: owner.cookie, body: levelBody() });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('unavailable');
  });

  it('creates a Stripe Product and Prices on the connected account', async () => {
    const level = await createLevel({ trialDays: 7, visibility: 'hidden' });
    expect(level).toMatchObject({
      name: 'Supporter',
      benefits: ['Every Dispatch in full', 'The archive'],
      founding: false,
      visibility: 'hidden',
      trialDays: 7,
      status: 'active',
      currency: 'usd',
      memberCount: 0,
    });
    expect(level.prices.map((p) => [p.interval, p.amount, p.status])).toEqual([
      ['month', 800, 'active'],
      ['year', 8000, 'active'],
    ]);
    const [product, ...prices] = stripe.calls;
    expect(product).toMatchObject({
      method: 'POST',
      path: '/v1/products',
      params: { name: 'Supporter', metadata: { swarm_level_id: level.id } },
      options: { account: accountId, idempotencyKey: level.id },
    });
    expect(level.stripeProductId).toMatch(/^prod_/);
    expect(prices).toHaveLength(2);
    for (const price of level.prices) {
      const callFor = prices.find((p) => p.options.idempotencyKey === price.id);
      expect(callFor).toMatchObject({
        path: '/v1/prices',
        params: {
          product: level.stripeProductId,
          currency: 'usd',
          unit_amount: price.amount,
          recurring: { interval: price.interval },
        },
        options: { account: accountId },
      });
      expect(price.stripePriceId).toMatch(/^price_/);
    }
  });

  it('lists the free level and the paid levels', async () => {
    const list = await data<MembershipLevelList>(
      await call('GET', levelsPath(), { cookie: viewer.cookie }),
    );
    expect(list.free.name).toBe('Free');
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((l) => l.status === 'active')).toBe(true);
  });

  it('validates create input', async () => {
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { name: 'x'.repeat(61) },
      { prices: [] },
      {
        prices: [
          { interval: 'month', amount: 500 },
          { interval: 'month', amount: 600 },
        ],
      },
      { prices: [{ interval: 'month', amount: 10 }] },
      { prices: [{ interval: 'week', amount: 500 }] },
      { prices: [{ interval: 'month', amount: 500, minAmount: 100 }] },
      { currency: 'EUR' },
      { trialDays: 400 },
      { benefits: ['x'.repeat(121)] },
    ];
    for (const body of bad) {
      const res = await call('POST', levelsPath(), { cookie: owner.cookie, body: levelBody(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('needs a currency when the account has none', async () => {
    const other = (await createChannel(owner)).id;
    await connectAccount(owner, other, { currency: null });
    const res = await call('POST', levelsPath(other), { cookie: owner.cookie, body: levelBody() });
    expect(res.status).toBe(400);
    const ok = await call('POST', levelsPath(other), {
      cookie: owner.cookie,
      body: levelBody({ currency: 'eur' }),
    });
    expect((await data<MembershipLevel>(ok, 201)).currency).toBe('eur');
  });

  it('validates updates (no unvalidated PATCH)', async () => {
    const level = await createLevel();
    const path = `${levelsPath()}/${level.id}`;
    for (const body of [
      {},
      { name: '' },
      { trialDays: -1 },
      { visibility: 'secret' },
      { prices: [{ interval: 'month', amount: 1 }] },
      { stripeProductId: 'prod_x' },
      { status: 'deleted' },
    ]) {
      const res = await call('PATCH', path, { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('renames the Stripe Product and archives the level', async () => {
    const level = await createLevel();
    stripe.calls.length = 0;
    const path = `${levelsPath()}/${level.id}`;
    const renamed = await data<MembershipLevel>(
      await call('PATCH', path, { cookie: admin.cookie, body: { name: 'Patron', position: 4 } }),
    );
    expect(renamed).toMatchObject({ name: 'Patron', position: 4 });
    expect(stripe.calls).toEqual([
      expect.objectContaining({
        path: `/v1/products/${level.stripeProductId}`,
        params: { name: 'Patron' },
        options: expect.objectContaining({ account: accountId }),
      }),
    ]);
    const archived = await data<MembershipLevel>(
      await call('PATCH', path, { cookie: admin.cookie, body: { status: 'archived' } }),
    );
    expect(archived.status).toBe('archived');
    expect(stripe.calls.at(-1)).toMatchObject({ params: { active: false } });
    const list = await data<MembershipLevelList>(
      await call('GET', levelsPath(), { cookie: owner.cookie }),
    );
    expect(list.items.some((l) => l.id === level.id)).toBe(false);
    const all = await data<MembershipLevelList>(
      await call('GET', `${levelsPath()}?includeArchived=true`, { cookie: owner.cookie }),
    );
    expect(all.items.some((l) => l.id === level.id)).toBe(true);
    // Archived levels can't change price.
    const res = await call('POST', `${path}/prices`, {
      cookie: owner.cookie,
      body: { interval: 'month', amount: 900 },
    });
    expect(res.status).toBe(409);
  });

  it('enforces roles and tenancy', async () => {
    const level = await createLevel();
    const path = `${levelsPath()}/${level.id}`;
    expect(
      (await call('POST', levelsPath(), { cookie: editor.cookie, body: levelBody() })).status,
    ).toBe(403);
    expect(
      (await call('PATCH', path, { cookie: editor.cookie, body: { name: 'No' } })).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `${path}/prices`, {
          cookie: editor.cookie,
          body: { interval: 'month', amount: 900 },
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', path, { cookie: viewer.cookie })).status).toBe(200);
    // Another workspace: the Channel and its levels don't exist.
    expect((await call('GET', levelsPath(), { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
    expect(
      (await call('PATCH', path, { cookie: outsider.cookie, body: { name: 'Mine' } })).status,
    ).toBe(404);
    // A level addressed through another Channel the caller owns is not found either.
    const theirs = (await createChannel(outsider)).id;
    expect(
      (await call('GET', `${levelsPath(theirs)}/${level.id}`, { cookie: outsider.cookie })).status,
    ).toBe(404);
    expect(
      (
        await call('PATCH', `${levelsPath(theirs)}/${level.id}`, {
          cookie: outsider.cookie,
          body: { name: 'Mine' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('Level prices', () => {
  it('a change creates a new price and never edits the old one', async () => {
    const level = await createLevel();
    const old = level.prices.find((p) => p.interval === 'month')!;
    stripe.calls.length = 0;
    const created = await data<LevelPrice>(
      await call('POST', `${levelsPath()}/${level.id}/prices`, {
        cookie: owner.cookie,
        body: { interval: 'month', amount: 1000 },
      }),
      201,
    );
    expect(created).toMatchObject({ interval: 'month', amount: 1000, status: 'active' });
    expect(created.id).not.toBe(old.id);
    expect(stripe.calls[0]).toMatchObject({
      path: '/v1/prices',
      params: { unit_amount: 1000, product: level.stripeProductId },
      options: { account: accountId, idempotencyKey: created.id },
    });
    // The old Stripe Price is only deactivated: existing subscribers keep it.
    const touchingOld = stripe.calls.filter((c) => c.path === `/v1/prices/${old.stripePriceId}`);
    expect(touchingOld).toEqual([expect.objectContaining({ params: { active: false } })]);
    const detail = await data<MembershipLevel>(
      await call('GET', `${levelsPath()}/${level.id}`, { cookie: owner.cookie }),
    );
    const retired = detail.prices.find((p) => p.id === old.id)!;
    expect(retired).toMatchObject({ status: 'retired', amount: 800 });
    expect(retired.retiredAt).not.toBeNull();
    const active = detail.prices.filter((p) => p.interval === 'month' && p.status === 'active');
    expect(active.map((p) => p.id)).toEqual([created.id]);
  });

  it('schedules a change with grandfather or migrate', async () => {
    const level = await createLevel();
    const effectiveAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const path = `${levelsPath()}/${level.id}/prices`;
    const first = await data<LevelPrice>(
      await call('POST', path, {
        cookie: owner.cookie,
        body: { interval: 'year', amount: 9000, effectiveAt, existing: 'migrate' },
      }),
      201,
    );
    expect(first).toMatchObject({ status: 'scheduled', existing: 'migrate', effectiveAt });
    // A second scheduled change for the interval replaces the first.
    const second = await data<LevelPrice>(
      await call('POST', path, {
        cookie: owner.cookie,
        body: { interval: 'year', amount: 9500, effectiveAt },
      }),
      201,
    );
    expect(second.existing).toBe('grandfather');
    const rows = await env.DB.prepare(
      `SELECT id, status FROM level_prices WHERE level_id = ?1 AND interval = 'year' ORDER BY created_at, id`,
    )
      .bind(level.id)
      .all<{ id: string; status: string }>();
    expect(rows.results.map((r) => r.status).sort()).toEqual(['active', 'retired', 'scheduled']);
    expect(rows.results.find((r) => r.id === first.id)?.status).toBe('retired');

    // Validation.
    for (const body of [
      { interval: 'year', amount: 9000, existing: 'migrate' },
      { interval: 'year', amount: 9000, effectiveAt: new Date(Date.now() - 1000).toISOString() },
      { interval: 'lifetime', amount: 9000, effectiveAt, existing: 'migrate' },
      { interval: 'year', amount: 9000, effectiveAt: 'tomorrow' },
      { interval: 'year', amount: 10 },
    ]) {
      const res = await call('POST', path, { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    // Canceling the scheduled change; the last active price can't go.
    expect((await call('DELETE', `${path}/${second.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    const month = level.prices.find((p) => p.interval === 'month')!;
    const yearActive = level.prices.find((p) => p.interval === 'year')!;
    expect((await call('DELETE', `${path}/${month.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    const last = await call('DELETE', `${path}/${yearActive.id}`, { cookie: owner.cookie });
    expect(last.status).toBe(409);
  });
});

describe('Founding Level', () => {
  it('needs the founding_level flag', async () => {
    const res = await call('POST', levelsPath(), {
      cookie: owner.cookie,
      body: levelBody({ founding: true }),
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('costs at least the highest regular price and is the only one', async () => {
    const id = (await createChannel(owner)).id;
    await connectAccount(owner, id);
    await enableFlag('founding_level', owner.workspaceId, id);
    const post = (body: Record<string, unknown>) =>
      call('POST', levelsPath(id), { cookie: owner.cookie, body: levelBody(body) });
    await data(await post({}), 201); // 800/month (9600 a year), 8000/year
    const cheap = await post({ founding: true, prices: [{ interval: 'year', amount: 9000 }] });
    expect(cheap.status).toBe(400);
    const lifetimeOnly = await post({
      founding: true,
      prices: [{ interval: 'lifetime', amount: 50000 }],
    });
    expect(lifetimeOnly.status).toBe(400);
    const founding = await data<MembershipLevel>(
      await post({
        name: 'Founding',
        founding: true,
        prices: [{ interval: 'year', amount: 25000 }],
      }),
      201,
    );
    expect(founding.founding).toBe(true);
    const list = await data<MembershipLevelList>(
      await call('GET', levelsPath(id), { cookie: owner.cookie }),
    );
    expect(list.items[0]!.id).toBe(founding.id);
    const second = await post({ founding: true, prices: [{ interval: 'year', amount: 30000 }] });
    expect(second.status).toBe(409);
    // Lowering the Founding price below the regular one is refused.
    const lower = await call('POST', `${levelsPath(id)}/${founding.id}/prices`, {
      cookie: owner.cookie,
      body: { interval: 'year', amount: 5000 },
    });
    expect(lower.status).toBe(400);
  });
});

describe('Pay what you want', () => {
  it('needs the flag', async () => {
    const res = await call('POST', levelsPath(), {
      cookie: owner.cookie,
      body: levelBody({
        prices: [{ interval: 'lifetime', amount: 2000, customAmount: true, minAmount: 500 }],
      }),
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('uses custom_unit_amount one-time and price_data for recurring', async () => {
    const id = (await createChannel(owner)).id;
    const acct = await connectAccount(owner, id);
    await enableFlag('pay_what_you_want', owner.workspaceId, id);
    const bad = await call('POST', levelsPath(id), {
      cookie: owner.cookie,
      body: levelBody({
        prices: [{ interval: 'month', amount: 300, customAmount: true, minAmount: 500 }],
      }),
    });
    expect(bad.status).toBe(400);
    const level = await data<MembershipLevel>(
      await call('POST', levelsPath(id), {
        cookie: owner.cookie,
        body: levelBody({
          prices: [
            { interval: 'month', amount: 800, customAmount: true, minAmount: 300 },
            { interval: 'lifetime', amount: 20000, customAmount: true, minAmount: 5000 },
          ],
        }),
      }),
      201,
    );
    const month = level.prices.find((p) => p.interval === 'month')!;
    const lifetime = level.prices.find((p) => p.interval === 'lifetime')!;
    expect(month).toMatchObject({ customAmount: true, minAmount: 300, stripePriceId: null });
    expect(lifetime.stripePriceId).toMatch(/^price_/);
    const priceCalls = stripe.calls.filter((c) => c.path === '/v1/prices');
    expect(priceCalls).toHaveLength(1);
    expect(priceCalls[0]).toMatchObject({
      params: { custom_unit_amount: { enabled: true, minimum: 5000, preset: 20000 } },
      options: { account: acct, idempotencyKey: lifetime.id },
    });
    expect(priceCalls[0]!.params.recurring).toBeUndefined();
  });
});

describe('Coupons', () => {
  const couponsPath = (id = channelId) => `/api/v1/channels/${id}/coupons`;

  it('creates a Stripe coupon and promotion code limited to levels', async () => {
    const level = await createLevel();
    stripe.calls.length = 0;
    const coupon = await data<Coupon>(
      await call('POST', couponsPath(), {
        cookie: admin.cookie,
        body: {
          code: 'Spring25',
          percentOff: 25,
          duration: 'repeating',
          durationMonths: 3,
          maxRedemptions: 100,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          levelIds: [level.id],
        },
      }),
      201,
    );
    expect(coupon).toMatchObject({
      code: 'Spring25',
      percentOff: 25,
      amountOff: null,
      duration: 'repeating',
      durationMonths: 3,
      levelIds: [level.id],
      status: 'active',
    });
    expect(stripe.calls[0]).toMatchObject({
      path: '/v1/coupons',
      params: {
        percent_off: 25,
        duration: 'repeating',
        duration_in_months: 3,
        applies_to: { products: [level.stripeProductId] },
      },
      options: { account: accountId, idempotencyKey: coupon.id },
    });
    expect(stripe.calls[1]).toMatchObject({
      path: '/v1/promotion_codes',
      params: {
        promotion: { type: 'coupon', coupon: coupon.stripeCouponId },
        code: 'Spring25',
        max_redemptions: 100,
      },
      options: { account: accountId, idempotencyKey: `${coupon.id}:promotion_code` },
    });

    // The code is unique among active coupons, ignoring case.
    const dup = await call('POST', couponsPath(), {
      cookie: admin.cookie,
      body: { code: 'SPRING25', percentOff: 10, duration: 'once' },
    });
    expect(dup.status).toBe(409);

    // Archive deactivates the promotion code; then the code is free again.
    stripe.calls.length = 0;
    const archived = await data<Coupon>(
      await call('PATCH', `${couponsPath()}/${coupon.id}`, {
        cookie: admin.cookie,
        body: { status: 'archived' },
      }),
    );
    expect(archived.status).toBe('archived');
    expect(stripe.calls).toEqual([
      expect.objectContaining({
        path: `/v1/promotion_codes/${coupon.stripePromotionCodeId}`,
        params: { active: false },
      }),
    ]);
    await data(
      await call('POST', couponsPath(), {
        cookie: admin.cookie,
        body: { code: 'spring25', amountOff: 500, currency: 'usd', duration: 'once' },
      }),
      201,
    );
    const restore = await call('PATCH', `${couponsPath()}/${coupon.id}`, {
      cookie: admin.cookie,
      body: { status: 'active' },
    });
    expect(restore.status).toBe(409);
  });

  it('validates create and update', async () => {
    const other = (await createChannel(outsider)).id;
    await connectAccount(outsider, other);
    const theirLevel = await data<MembershipLevel>(
      await call('POST', levelsPath(other), { cookie: outsider.cookie, body: levelBody() }),
      201,
    );
    for (const body of [
      { code: 'ab', percentOff: 10, duration: 'once' },
      { code: 'has space', percentOff: 10, duration: 'once' },
      { code: 'BOTH', percentOff: 10, amountOff: 100, currency: 'usd', duration: 'once' },
      { code: 'NONE', duration: 'once' },
      { code: 'NOCUR', amountOff: 100, duration: 'once' },
      { code: 'REP', percentOff: 10, duration: 'repeating' },
      { code: 'ONCEM', percentOff: 10, duration: 'once', durationMonths: 2 },
      { code: 'PCT', percentOff: 101, duration: 'once' },
      { code: 'PAST', percentOff: 10, duration: 'once', expiresAt: new Date(0).toISOString() },
      { code: 'THEIRS', percentOff: 10, duration: 'once', levelIds: [theirLevel.id] },
    ]) {
      const res = await call('POST', couponsPath(), { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const coupon = await data<Coupon>(
      await call('POST', couponsPath(), {
        cookie: owner.cookie,
        body: { code: 'VALID1', percentOff: 10, duration: 'forever' },
      }),
      201,
    );
    for (const body of [{}, { percentOff: 20 }, { code: 'OTHER' }, { status: 'gone' }]) {
      const res = await call('PATCH', `${couponsPath()}/${coupon.id}`, {
        cookie: owner.cookie,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const renamed = await data<Coupon>(
      await call('PATCH', `${couponsPath()}/${coupon.id}`, {
        cookie: owner.cookie,
        body: { name: 'Friends' },
      }),
    );
    expect(renamed.name).toBe('Friends');
    expect(stripe.calls.at(-1)).toMatchObject({
      path: `/v1/coupons/${coupon.stripeCouponId}`,
      params: { name: 'Friends' },
    });
  });

  it('enforces roles, tenancy and a connected account', async () => {
    const body = { code: 'ROLE10', percentOff: 10, duration: 'once' };
    expect((await call('POST', couponsPath(), { cookie: editor.cookie, body })).status).toBe(403);
    expect((await call('GET', couponsPath(), { cookie: viewer.cookie })).status).toBe(200);
    expect((await call('GET', couponsPath(), { cookie: outsider.cookie })).status).toBe(404);
    const coupon = await data<Coupon>(
      await call('POST', couponsPath(), { cookie: owner.cookie, body }),
      201,
    );
    const theirs = (await createChannel(outsider)).id;
    expect(
      (await call('GET', `${couponsPath(theirs)}/${coupon.id}`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('PATCH', `${couponsPath()}/${coupon.id}`, {
          cookie: outsider.cookie,
          body: { status: 'archived' },
        })
      ).status,
    ).toBe(404);
    const unconnected = (await createChannel(owner)).id;
    const res = await call('POST', couponsPath(unconnected), { cookie: owner.cookie, body });
    expect(res.status).toBe(409);
  });
});
