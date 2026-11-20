import { env } from 'cloudflare:test';
import type {
  CompGrant,
  Dispatch,
  Gate,
  GateSettings,
  GiftPass,
  MemberDetail,
  MembershipLevel,
  MeterGrant,
  Pledge,
  Revenue,
} from '@swarm/domain';
import { meterPeriodKey } from '@swarm/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStripeForTests } from '../src/lib/levels';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import {
  addMember,
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
let level: MembershipLevel;

const base = (id = channelId) => `/api/v1/channels/${id}`;

async function newDispatch(s: Session, id = channelId) {
  return data<Dispatch>(
    await call('POST', `${base(id)}/dispatches`, {
      cookie: s.cookie,
      body: { subject: 'Issue 1', content: { type: 'doc', content: [] } },
    }),
    201,
  );
}

async function cacheVersion(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
    .bind(id)
    .first<{ cache_version: number }>();
  return row?.cache_version ?? 1;
}

async function entitlement(memberId: string) {
  return env.DB.prepare(
    `SELECT level_id, source, expires_at FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
  )
    .bind(memberId)
    .first<{ level_id: string | null; source: string; expires_at: number | null }>();
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  admin = await seatAs(owner.workspaceId, 'admin');
  editor = await seatAs(owner.workspaceId, 'editor');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
  await connectAccount(owner, channelId);
  freshStripe();
  level = await data<MembershipLevel>(
    await call('POST', `${base()}/levels`, { cookie: owner.cookie, body: levelBody() }),
    201,
  );
});

beforeEach(() => {
  freshStripe();
});

afterAll(() => useStripeForTests(undefined));

describe('comp access', () => {
  it('grants a level, recomputes the entitlement and revokes it', async () => {
    const member = await addMember(owner, channelId);
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const grant = await data<CompGrant>(
      await call('POST', `${base()}/members/${member.id}/comp`, {
        cookie: admin.cookie,
        body: { levelId: level.id, expiresAt, note: 'Podcast guest' },
      }),
      201,
    );
    expect(grant).toMatchObject({
      memberId: member.id,
      levelId: level.id,
      levelName: 'Supporter',
      expiresAt,
      note: 'Podcast guest',
      active: true,
      revokedAt: null,
    });
    const sub = await env.DB.prepare('SELECT * FROM member_subscriptions WHERE id = ?1')
      .bind(grant.subscriptionId)
      .first<{ source: string; status: string; current_period_end: number; level_id: string }>();
    expect(sub).toMatchObject({
      source: 'comp',
      status: 'active',
      level_id: level.id,
      current_period_end: Date.parse(expiresAt),
    });
    expect(await entitlement(member.id)).toMatchObject({
      level_id: level.id,
      source: 'comp',
      expires_at: Date.parse(expiresAt),
    });
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1 ORDER BY created_at`,
    )
      .bind(member.id)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toContain('member.comp_granted');

    // Lists, per Member and per Channel.
    const forMember = await data<{ items: CompGrant[] }>(
      await call('GET', `${base()}/members/${member.id}/comp`, { cookie: viewer.cookie }),
    );
    expect(forMember.items.map((g) => g.id)).toEqual([grant.id]);
    const forChannel = await data<{ items: CompGrant[] }>(
      await call('GET', `${base()}/comp-grants?memberId=${member.id}`, { cookie: viewer.cookie }),
    );
    expect(forChannel.items.map((g) => g.id)).toEqual([grant.id]);

    // Revoke.
    expect(
      (await call('DELETE', `${base()}/comp-grants/${grant.id}`, { cookie: editor.cookie })).status,
    ).toBe(403);
    expect(
      (await call('DELETE', `${base()}/comp-grants/${grant.id}`, { cookie: admin.cookie })).status,
    ).toBe(204);
    expect(await entitlement(member.id)).toBeNull();
    const revoked = await env.DB.prepare(
      'SELECT revoked_at, revoke_reason FROM member_subscriptions WHERE id = ?1',
    )
      .bind(grant.subscriptionId)
      .first<{ revoked_at: number | null; revoke_reason: string }>();
    expect(revoked?.revoked_at).not.toBeNull();
    expect(revoked?.revoke_reason).toBe('operator');
    const active = await data<{ items: CompGrant[] }>(
      await call('GET', `${base()}/comp-grants`, { cookie: owner.cookie }),
    );
    expect(active.items.some((g) => g.id === grant.id)).toBe(false);
    const withRevoked = await data<{ items: CompGrant[] }>(
      await call('GET', `${base()}/comp-grants?includeRevoked=true`, { cookie: owner.cookie }),
    );
    expect(withRevoked.items.find((g) => g.id === grant.id)).toMatchObject({ active: false });
  });

  it('grants without an end', async () => {
    const member = await addMember(owner, channelId);
    await data(
      await call('POST', `${base()}/members/${member.id}/comp`, {
        cookie: owner.cookie,
        body: { levelId: level.id },
      }),
      201,
    );
    expect(await entitlement(member.id)).toMatchObject({ level_id: level.id, expires_at: null });
    const detail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: viewer.cookie }),
    );
    expect(detail.membership).toMatchObject({
      levelId: level.id,
      levelName: 'Supporter',
      source: 'comp',
      expiresAt: null,
    });
    const free = await addMember(owner, channelId);
    const freeDetail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${free.id}`, { cookie: viewer.cookie }),
    );
    expect(freeDetail.membership).toBeNull();
  });

  it('validates, enforces roles and tenancy', async () => {
    const member = await addMember(owner, channelId);
    const path = `${base()}/members/${member.id}/comp`;
    const otherChannel = (await createChannel(outsider)).id;
    await connectAccount(outsider, otherChannel);
    const theirLevel = await data<MembershipLevel>(
      await call('POST', `${base(otherChannel)}/levels`, {
        cookie: outsider.cookie,
        body: levelBody(),
      }),
      201,
    );
    for (const body of [
      {},
      { levelId: 'lv_nope' },
      { levelId: theirLevel.id },
      { levelId: level.id, expiresAt: new Date(Date.now() - 1000).toISOString() },
      { levelId: level.id, note: 'x'.repeat(281) },
      { levelId: level.id, tier: 'gold' },
    ]) {
      const res = await call('POST', path, { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const ok = { levelId: level.id };
    expect((await call('POST', path, { cookie: editor.cookie, body: ok })).status).toBe(403);
    expect((await call('POST', path, { cookie: outsider.cookie, body: ok })).status).toBe(404);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
    // A Member of another Channel through this Channel's path.
    const theirMember = await addMember(outsider, otherChannel);
    const cross = await call('POST', `${base()}/members/${theirMember.id}/comp`, {
      cookie: owner.cookie,
      body: ok,
    });
    expect(cross.status).toBe(404);
    const grant = await data<CompGrant>(
      await call('POST', path, { cookie: owner.cookie, body: ok }),
      201,
    );
    const crossRevoke = await call('DELETE', `${base(otherChannel)}/comp-grants/${grant.id}`, {
      cookie: outsider.cookie,
    });
    expect(crossRevoke.status).toBe(404);
  });
});

describe('Gates', () => {
  it('saves a Gate with this Channel’s levels and bumps the site cache', async () => {
    const dispatch = await newDispatch(owner);
    const path = `/api/v1/dispatches/${dispatch.id}/gate`;
    const fresh = await data<Gate>(await call('GET', path, { cookie: viewer.cookie }));
    expect(fresh).toMatchObject({ levelIds: [], metered: true, design: {}, saved: false });
    const before = await cacheVersion(channelId);
    const saved = await data<Gate>(
      await call('PUT', path, {
        cookie: editor.cookie,
        body: {
          levelIds: [level.id],
          metered: false,
          design: { headline: 'Members only', ctaLabel: 'Join', benefits: ['The archive'] },
        },
      }),
    );
    expect(saved).toMatchObject({
      levelIds: [level.id],
      metered: false,
      design: { headline: 'Members only', ctaLabel: 'Join', benefits: ['The archive'] },
      saved: true,
    });
    expect(await cacheVersion(channelId)).toBe(before + 1);
  });

  it('refuses levels of another Channel, bad input, low roles and other tenants', async () => {
    const dispatch = await newDispatch(owner);
    const path = `/api/v1/dispatches/${dispatch.id}/gate`;
    const otherChannel = (await createChannel(owner)).id;
    await connectAccount(owner, otherChannel);
    const otherLevel = await data<MembershipLevel>(
      await call('POST', `${base(otherChannel)}/levels`, {
        cookie: owner.cookie,
        body: levelBody(),
      }),
      201,
    );
    for (const body of [
      { levelIds: [otherLevel.id] },
      { levelIds: [level.id, level.id] },
      { levelIds: ['nope'] },
      { design: { headline: 'x'.repeat(121) } },
      { design: { color: 'red' } },
      { metered: 'yes' },
    ]) {
      const res = await call('PUT', path, { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', path, { cookie: viewer.cookie, body: {} })).status).toBe(403);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('PUT', path, { cookie: outsider.cookie, body: {} })).status).toBe(404);
  });

  it('changes the meter, the default design and the Gate coupon', async () => {
    const path = `${base()}/gate-settings`;
    const defaults = await data<GateSettings>(await call('GET', path, { cookie: viewer.cookie }));
    expect(defaults).toMatchObject({
      meterLimit: 0,
      meterPeriod: 'month',
      meterMode: 'hard',
      gateCouponId: null,
      currentPeriod: meterPeriodKey('month'),
      updatedAt: null,
    });
    const before = await cacheVersion(channelId);
    const saved = await data<GateSettings>(
      await call('PATCH', path, {
        cookie: editor.cookie,
        body: { meterLimit: 3, meterPeriod: 'week', meterMode: 'soft', design: { headline: 'Hi' } },
      }),
    );
    expect(saved).toMatchObject({
      meterLimit: 3,
      meterPeriod: 'week',
      meterMode: 'soft',
      design: { headline: 'Hi' },
      currentPeriod: meterPeriodKey('week'),
    });
    expect(await cacheVersion(channelId)).toBe(before + 1);
    for (const body of [
      {},
      { meterLimit: 101 },
      { meterPeriod: 'day' },
      { gateCouponId: 'cp_x' },
    ]) {
      const res = await call('PATCH', path, { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await call('PATCH', path, { cookie: viewer.cookie, body: { meterLimit: 1 } })).status,
    ).toBe(403);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);

    // The Gate coupon needs the paywall_coupon flag and an active coupon of this Channel.
    const coupon = await data<{ id: string }>(
      await call('POST', `${base()}/coupons`, {
        cookie: owner.cookie,
        body: { code: `GATE${Date.now() % 100000}`, percentOff: 20, duration: 'once' },
      }),
      201,
    );
    const off = await call('PATCH', path, {
      cookie: owner.cookie,
      body: { gateCouponId: coupon.id },
    });
    expect(off.status).toBe(404);
    expect(await errorCode(off)).toBe('feature_disabled');
    await enableFlag('paywall_coupon', owner.workspaceId, channelId);
    const withCoupon = await data<GateSettings>(
      await call('PATCH', path, { cookie: owner.cookie, body: { gateCouponId: coupon.id } }),
    );
    expect(withCoupon.gateCouponId).toBe(coupon.id);
    // Archiving the coupon takes it out of the Gate.
    await data(
      await call('PATCH', `${base()}/coupons/${coupon.id}`, {
        cookie: owner.cookie,
        body: { status: 'archived' },
      }),
    );
    const after = await data<GateSettings>(await call('GET', path, { cookie: owner.cookie }));
    expect(after.gateCouponId).toBeNull();
  });

  it('gives a Member extra reads for the current period', async () => {
    const id = (await createChannel(owner)).id;
    const member = await addMember(owner, id);
    const path = `${base(id)}/members/${member.id}/meter-grants`;
    const off = await call('POST', path, { cookie: editor.cookie, body: { extra: 2 } });
    expect(off.status).toBe(409);
    await data(
      await call('PATCH', `${base(id)}/gate-settings`, {
        cookie: owner.cookie,
        body: { meterLimit: 2 },
      }),
    );
    const grant = await data<MeterGrant>(
      await call('POST', path, { cookie: editor.cookie, body: { extra: 2 } }),
      201,
    );
    expect(grant).toMatchObject({ memberId: member.id, extra: 2, period: meterPeriodKey('month') });
    for (const body of [{}, { extra: 0 }, { extra: 101 }]) {
      expect((await call('POST', path, { cookie: owner.cookie, body })).status).toBe(400);
    }
    expect((await call('POST', path, { cookie: viewer.cookie, body: { extra: 1 } })).status).toBe(
      403,
    );
    expect((await call('POST', path, { cookie: outsider.cookie, body: { extra: 1 } })).status).toBe(
      404,
    );
    const otherMember = await addMember(owner, channelId);
    const cross = await call('POST', `${base(id)}/members/${otherMember.id}/meter-grants`, {
      cookie: owner.cookie,
      body: { extra: 1 },
    });
    expect(cross.status).toBe(404);
  });

  it('shows how often gift article links were read, and stops them all', async () => {
    const id = (await createChannel(owner)).id;
    const dispatch = await newDispatch(owner, id);
    const member = await addMember(owner, id);
    const now = Date.now();
    for (const [hash, reads] of [
      [`h-${crypto.randomUUID()}`, 3],
      [`h-${crypto.randomUUID()}`, 0],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO gift_article_links (token_hash, channel_id, member_id, dispatch_id, period, created_at, expires_at, reads)
         VALUES (?1, ?2, ?3, ?4, '2026-11', ?5, ?6, ?7)`,
      )
        .bind(hash, id, member.id, dispatch.id, now, now + 86_400_000, reads)
        .run();
    }
    const path = `/api/v1/dispatches/${dispatch.id}/gift-links`;
    expect((await call('GET', path, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
    const listed = await data<{ items: { reads: number; revokedAt: string | null }[] }>(
      await call('GET', path, { cookie: editor.cookie }),
    );
    expect(listed.items.map((l) => l.reads).sort()).toEqual([0, 3]);
    expect(listed.items.every((l) => l.revokedAt === null)).toBe(true);
    expect((await call('POST', `${path}/revoke`, { cookie: viewer.cookie })).status).toBe(403);
    const stopped = await data<{ stopped: number }>(
      await call('POST', `${path}/revoke`, { cookie: editor.cookie }),
    );
    expect(stopped.stopped).toBe(2);
    const after = await data<{ items: { revokedAt: string | null }[] }>(
      await call('GET', path, { cookie: editor.cookie }),
    );
    expect(after.items.every((l) => l.revokedAt !== null)).toBe(true);
  });
});

describe('Gift Passes and pledges', () => {
  it('lists Gift Passes behind the flag', async () => {
    const path = `${base()}/gift-passes`;
    const off = await call('GET', path, { cookie: owner.cookie });
    expect(off.status).toBe(404);
    expect(await errorCode(off)).toBe('feature_disabled');
    await enableFlag('gift_passes', owner.workspaceId, channelId);
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, recipient_email, status, created_at)
       VALUES (?1, ?2, ?3, 3, 'buyer@example.com', 'friend@example.com', 'paid', ?4)`,
    )
      .bind(`gp_${crypto.randomUUID().replace(/-/g, '')}`, channelId, level.id, Date.now())
      .run();
    const list = await data<{ items: GiftPass[] }>(
      await call('GET', path, { cookie: viewer.cookie }),
    );
    expect(list.items).toEqual([
      expect.objectContaining({ months: 3, purchaserEmail: 'buyer@example.com', status: 'paid' }),
    ]);
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
  });

  it('notifies open pledgers once a public level is on sale', async () => {
    const id = (await createChannel(owner)).id;
    const notify = () => call('POST', `${base(id)}/pledges/notify`, { cookie: owner.cookie });
    expect(await errorCode(await notify())).toBe('feature_disabled');
    await enableFlag('pledges', owner.workspaceId, id);
    const email = uniqueEmail('pledger');
    const member = await addMember(owner, id, email);
    const quiet = await addMember(owner, id);
    await env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`)
      .bind(quiet.id)
      .run();
    for (const m of [member, quiet]) {
      await env.DB.prepare(
        `INSERT INTO pledges (id, channel_id, member_id, interval, currency, amount, created_at)
         VALUES (?1, ?2, ?3, 'month', 'usd', 700, ?4)`,
      )
        .bind(`pl_${crypto.randomUUID().replace(/-/g, '')}`, id, m.id, Date.now())
        .run();
    }
    const early = await notify();
    expect(early.status).toBe(409);
    await connectAccount(owner, id);
    await data(
      await call('POST', `${base(id)}/levels`, { cookie: owner.cookie, body: levelBody() }),
      201,
    );
    expect(
      (await call('POST', `${base(id)}/pledges/notify`, { cookie: editor.cookie })).status,
    ).toBe(403);
    const result = await data<{ notified: number; emailed: number; remaining: number }>(
      await notify(),
    );
    expect(result).toEqual({ notified: 2, emailed: 1, remaining: 0 });
    const mail = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
    const { data: sent } = await json<{ data: { text: string; category: string } }>(mail);
    expect(sent.category).toBe('pledge');
    expect(sent.text).toContain('/subscribe');
    const list = await data<{ items: Pledge[] }>(
      await call('GET', `${base(id)}/pledges`, { cookie: viewer.cookie }),
    );
    expect(list.items.map((p) => p.status)).toEqual(['notified', 'notified']);
    expect((await notify()).status).toBe(200);
    expect((await call('GET', `${base(id)}/pledges`, { cookie: outsider.cookie })).status).toBe(
      404,
    );
  });
});

describe('revenue', () => {
  const day = 86_400_000;
  const insertMember = async (id: string, source: Record<string, string>, createdAt: number) => {
    const memberId = `mb_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, source_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5)`,
    )
      .bind(memberId, id, uniqueEmail('rev'), JSON.stringify(source), createdAt)
      .run();
    return memberId;
  };
  const insertSub = async (
    id: string,
    memberId: string,
    fields: {
      source?: string;
      status: string;
      interval?: string | null;
      amount?: number | null;
      createdAt: number;
      canceledAt?: number | null;
      graceUntil?: number | null;
      periodEnd?: number | null;
      trialEnd?: number | null;
      cancelAtPeriodEnd?: boolean;
      discountedAmount?: number | null;
      discountEnd?: number | null;
    },
  ) => {
    const subId = `ms_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, interval, currency,
         amount, current_period_end, canceled_at, grace_until, trial_end, cancel_at_period_end,
         discounted_amount, discount_end, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'usd', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`,
    )
      .bind(
        subId,
        id,
        memberId,
        fields.source ?? 'stripe',
        fields.status,
        fields.interval === undefined ? 'month' : fields.interval,
        fields.amount === undefined ? 1000 : fields.amount,
        fields.periodEnd ?? null,
        fields.canceledAt ?? null,
        fields.graceUntil ?? null,
        fields.trialEnd ?? null,
        fields.cancelAtPeriodEnd ? 1 : 0,
        fields.discountedAmount ?? null,
        fields.discountEnd ?? null,
        fields.createdAt,
      )
      .run();
    return subId;
  };
  const payment = async (
    id: string,
    amount: number,
    at: number,
    kind = 'invoice',
    subscriptionId: string | null = null,
  ) =>
    env.DB.prepare(
      `INSERT INTO payments (id, channel_id, subscription_id, kind, stripe_object_id, currency, amount, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'usd', ?6, ?7)`,
    )
      .bind(
        `py_${crypto.randomUUID().replace(/-/g, '')}`,
        id,
        subscriptionId,
        kind,
        `in_${crypto.randomUUID()}`,
        amount,
        at,
      )
      .run();

  it('computes MRR, counts, churn, conversion and revenue by day', async () => {
    const id = (await createChannel(owner)).id;
    const now = Date.now();
    const old = now - 60 * day;
    // Active before the range: monthly 1000, yearly 12000 (1000 a month).
    const a = await insertMember(id, { utm_source: 'twitter' }, old);
    await insertSub(id, a, { status: 'active', createdAt: old });
    const b = await insertMember(id, {}, old);
    await insertSub(id, b, { status: 'active', interval: 'year', amount: 12000, createdAt: old });
    // Canceled within the range.
    const c = await insertMember(id, {}, old);
    await insertSub(id, c, { status: 'canceled', createdAt: old, canceledAt: now - 5 * day });
    // Past due, still in grace: counts in MRR and as paid.
    const d = await insertMember(id, {}, old);
    await insertSub(id, d, { status: 'past_due', createdAt: old, graceUntil: now + 2 * day });
    // Past due, grace over: not counted.
    const e = await insertMember(id, {}, old);
    await insertSub(id, e, { status: 'past_due', createdAt: old, graceUntil: now - day });
    // New in range: a trial (500/month, not paying yet) from a newsletter link, and a lifetime
    // purchase.
    const f = await insertMember(id, { utm_source: 'newsletter' }, now - 3 * day);
    await insertSub(id, f, {
      status: 'trialing',
      amount: 500,
      createdAt: now - 3 * day,
      trialEnd: now + 11 * day,
    });
    const g = await insertMember(id, { utm_source: 'newsletter' }, now - 2 * day);
    await insertSub(id, g, {
      source: 'lifetime',
      status: 'lifetime',
      interval: 'lifetime',
      amount: 30000,
      createdAt: now - 2 * day,
    });
    await insertMember(id, { utm_source: 'newsletter' }, now - day);
    // Comp access.
    const h = await insertMember(id, {}, old);
    await insertSub(id, h, {
      source: 'comp',
      status: 'active',
      interval: null,
      amount: null,
      createdAt: old,
    });
    // Payments.
    await payment(id, 1000, old);
    await payment(id, 30000, now - 2 * day, 'one_time');
    await payment(id, 1000, now - 2 * day);
    await payment(id, -1000, now - day, 'refund');

    const from = new Date(now - 10 * day).toISOString().slice(0, 10);
    const to = new Date(now).toISOString().slice(0, 10);
    const report = await data<Revenue>(
      await call('GET', `${base(id)}/revenue?from=${from}&to=${to}`, { cookie: viewer.cookie }),
    );
    // The trial is not revenue yet: it shows apart.
    expect(report.mrr).toEqual([{ currency: 'usd', amount: 1000 + 1000 + 1000 }]);
    expect(report.trialMrr).toEqual([{ currency: 'usd', amount: 500 }]);
    expect(report.activePaid).toBe(4); // a, b, d, g
    expect(report.trialing).toBe(1);
    expect(report.complimentary).toBe(1);
    expect(report.churn).toEqual({ activeAtStart: 5, canceled: 1, rate: 0.2 });
    expect(report.newPaid).toBe(1); // g; the trial hasn't paid
    expect(report.conversionBySource).toEqual([
      { source: 'newsletter', members: 3, paid: 1, rate: 0.3333 },
    ]);
    const twoDaysAgo = new Date(now - 2 * day).toISOString().slice(0, 10);
    expect(report.revenueByDay).toContainEqual({ day: twoDaysAgo, currency: 'usd', amount: 31000 });
    expect(report.revenueByDay.reduce((sum, r) => sum + r.amount, 0)).toBe(30000);
    expect(report.lifetimeRevenue).toEqual([{ currency: 'usd', amount: 31000 }]);

    for (const query of [
      'from=2026-13-01',
      `from=${to}&to=${from}`,
      'from=2020-01-01&to=2026-01-01',
    ]) {
      expect(
        (await call('GET', `${base(id)}/revenue?${query}`, { cookie: owner.cookie })).status,
      ).toBe(400);
    }
    expect((await call('GET', `${base(id)}/revenue`, { cookie: outsider.cookie })).status).toBe(
      404,
    );
    const defaults = await data<Revenue>(
      await call('GET', `${base(id)}/revenue`, { cookie: owner.cookie }),
    );
    expect(defaults.to).toBe(to);
  });

  it('counts only paying subscriptions in MRR, after recurring coupons, with trials apart', async () => {
    const id = (await createChannel(owner)).id;
    const now = Date.now();
    const old = now - 90 * day;
    const member = () => insertMember(id, {}, old);
    // Monthly 1000 with a 'forever' 25% coupon: 750.
    await insertSub(id, await member(), {
      status: 'active',
      createdAt: old,
      discountedAmount: 750,
    });
    // Yearly 12000 with a 'repeating' 50% coupon still running: 6000 a year, 500 a month.
    await insertSub(id, await member(), {
      status: 'active',
      interval: 'year',
      amount: 12000,
      createdAt: old,
      discountedAmount: 6000,
      discountEnd: now + 30 * day,
    });
    // Monthly 1000 whose 'repeating' 200-off coupon has ended: full price.
    await insertSub(id, await member(), {
      status: 'active',
      createdAt: old,
      discountedAmount: 800,
      discountEnd: now - day,
    });
    // Yearly 24000 with no coupon (a 'once' coupon never sets one): 2000 a month.
    await insertSub(id, await member(), {
      status: 'active',
      interval: 'year',
      amount: 24000,
      createdAt: old,
    });
    // Trials: one yearly 6000 with a 'forever' coupon to 3000 (250 a month), one monthly 1000
    // whose 3-month coupon ends before the trial does (full 1000), and one set to cancel.
    await insertSub(id, await member(), {
      status: 'trialing',
      interval: 'year',
      amount: 6000,
      createdAt: now - day,
      trialEnd: now + 13 * day,
      discountedAmount: 3000,
    });
    await insertSub(id, await member(), {
      status: 'trialing',
      createdAt: now - day,
      trialEnd: now + 13 * day,
      discountedAmount: 500,
      discountEnd: now + 5 * day,
    });
    await insertSub(id, await member(), {
      status: 'trialing',
      createdAt: now - day,
      trialEnd: now + 13 * day,
      cancelAtPeriodEnd: true,
    });
    // A trial that ended in the range and converted (its first invoice is paid), and one that
    // ended in the range without paying and was canceled: neither is churn at the start, only
    // the first is a new paid Member.
    const converted = await member();
    const convertedSub = await insertSub(id, converted, {
      status: 'past_due',
      graceUntil: now - day,
      createdAt: now - 20 * day,
      trialEnd: now - 6 * day,
    });
    await payment(id, 1000, now - 6 * day, 'invoice', convertedSub);
    await insertSub(id, await member(), {
      status: 'canceled',
      createdAt: now - 20 * day,
      trialEnd: now - 6 * day,
      canceledAt: now - 7 * day,
    });
    // A trial that ended before the range and converted, then churned in the range.
    await insertSub(id, await member(), {
      status: 'canceled',
      createdAt: now - 60 * day,
      trialEnd: now - 46 * day,
      canceledAt: now - 3 * day,
    }).then((subId) => payment(id, 1000, now - 46 * day, 'invoice', subId));
    // A trial still running at the start of the range and canceled in it: not churn.
    await insertSub(id, await member(), {
      status: 'canceled',
      createdAt: now - 12 * day,
      trialEnd: now + 2 * day,
      canceledAt: now - 2 * day,
    });

    const from = new Date(now - 10 * day).toISOString().slice(0, 10);
    const to = new Date(now).toISOString().slice(0, 10);
    const report = await data<Revenue>(
      await call('GET', `${base(id)}/revenue?from=${from}&to=${to}`, { cookie: viewer.cookie }),
    );
    expect(report.mrr).toEqual([{ currency: 'usd', amount: 750 + 500 + 1000 + 2000 }]);
    expect(report.trialMrr).toEqual([{ currency: 'usd', amount: 250 + 1000 }]);
    expect(report.activePaid).toBe(4);
    expect(report.trialing).toBe(3);
    // Paying at the start: the four active ones and the trial that converted before the range.
    expect(report.churn).toEqual({ activeAtStart: 5, canceled: 1, rate: 0.2 });
    expect(report.newPaid).toBe(1);
  });
});
