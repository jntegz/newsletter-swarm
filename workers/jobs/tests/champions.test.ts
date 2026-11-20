import { env } from 'cloudflare:test';
import { CHAMPION_CODE, newId } from '@swarm/domain';
import {
  checkMilestones,
  countReferrals,
  ensureChampionCode,
  entitledLevel,
  recordReferral,
  reviewReferral,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { championDeps } from '../src/handlers/champions';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { jobsEnv, seedChannel } from './helpers';

const DAY = 86_400_000;

/** Mail the dev mailbox holds for an address, newest first. */
async function mailTo(to: string): Promise<{ category: string; text: string }[]> {
  const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
  const keys = listing.objects.filter((o) => o.customMetadata?.to === to).map((o) => o.key);
  return Promise.all(
    keys.map(async (key) =>
      (await env.DEV_MAILBOX.get(key))!.json<{ category: string; text: string }>(),
    ),
  );
}
const HOUR = 3_600_000;

const email = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const deps = () => championDeps(jobsEnv().env);

async function member(
  channelId: string,
  options: {
    email?: string;
    status?: string;
    confirmedAt?: number | null;
    firstName?: string | null;
    createdAt?: number;
  } = {},
): Promise<{ id: string; email: string }> {
  const now = options.createdAt ?? Date.now();
  const id = newId('member', now);
  const address = options.email ?? email('m');
  const status = options.status ?? 'active';
  const confirmedAt = options.confirmedAt === undefined ? now : options.confirmedAt;
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, first_name, status, confirmed_at, consent_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)`,
  )
    .bind(id, channelId, address, options.firstName ?? null, status, confirmedAt, now)
    .run();
  return { id, email: address };
}

async function open(workspaceId: string, channelId: string, memberId: string, at: number) {
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Issue 7', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Issue 7', '', '', '', 'Field Notes', 'notes@example.com', 1, ?5, ?5)`,
    ).bind(broadcastId, dispatchId, channelId, workspaceId, at),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at, opened_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, 'x@example.com', ?5, ?5, ?5)`,
    ).bind(newId('delivery'), broadcastId, channelId, memberId, at),
  ]);
}

async function referral(referredId: string) {
  return env.DB.prepare(
    'SELECT status, review_reason, ip_prefix, counted_at FROM referrals WHERE referred_id = ?1',
  )
    .bind(referredId)
    .first<{
      status: string;
      review_reason: string | null;
      ip_prefix: string | null;
      counted_at: number | null;
    }>();
}

async function enable(channelId: string, extra: Record<string, number> = {}) {
  const values = {
    enabled: 1,
    engagement_days: 14,
    cluster_limit: 3,
    cluster_window_hours: 24,
    block_disposable: 1,
    ...extra,
  };
  await env.DB.prepare(
    `INSERT INTO champion_settings (channel_id, enabled, engagement_days, cluster_limit, cluster_window_hours,
       block_disposable, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
     ON CONFLICT (channel_id) DO UPDATE SET enabled = ?2, engagement_days = ?3, cluster_limit = ?4,
       cluster_window_hours = ?5, block_disposable = ?6`,
  )
    .bind(
      channelId,
      values.enabled,
      values.engagement_days,
      values.cluster_limit,
      values.cluster_window_hours,
      values.block_disposable,
    )
    .run();
}

async function refer(
  channelId: string,
  referrerId: string,
  options: { ip?: string; at?: number; confirmedAt?: number | null; status?: string } = {},
) {
  const at = options.at ?? Date.now();
  const referred = await member(channelId, {
    createdAt: at,
    confirmedAt: options.confirmedAt === undefined ? at : options.confirmedAt,
    ...(options.status ? { status: options.status } : {}),
  });
  const result = await recordReferral(
    env.DB,
    {
      channelId,
      referrerId,
      referredId: referred.id,
      referredEmail: referred.email,
      ip: options.ip ?? `198.51.${Math.floor(Math.random() * 200)}.7`,
    },
    at,
  );
  return { ...referred, result };
}

describe('champion codes', () => {
  it('are assigned once, match CHAMPION_CODE and retry on a collision', async () => {
    const { channelId } = await seedChannel();
    const a = await member(channelId);
    const b = await member(channelId);
    const codeA = await ensureChampionCode(env.DB, channelId, a.id);
    expect(codeA).toMatch(CHAMPION_CODE);
    expect(await ensureChampionCode(env.DB, channelId, a.id)).toBe(codeA);

    // The generator first returns A's code: the unique index refuses it and a new one is drawn.
    const drawn = [codeA as string, 'zzzz2222'];
    const codeB = await ensureChampionCode(env.DB, channelId, b.id, () => drawn.shift()!);
    expect(codeB).toBe('zzzz2222');

    // Concurrent first use for one Member settles on one code.
    const c = await member(channelId);
    const codes = await Promise.all(
      Array.from({ length: 5 }, () => ensureChampionCode(env.DB, channelId, c.id)),
    );
    expect(new Set(codes).size).toBe(1);
    expect(await ensureChampionCode(env.DB, channelId, newId('member'))).toBeNull();
  });
});

describe('recording referrals', () => {
  it('stores only the network prefix and refuses self-referrals', async () => {
    const { channelId } = await seedChannel();
    const champion = await member(channelId, { email: 'ada.lovelace@example.com' });
    const v4 = await refer(channelId, champion.id, { ip: '203.0.113.77' });
    expect(v4.result).toBe('recorded');
    expect(await referral(v4.id)).toMatchObject({ status: 'pending', ip_prefix: '203.0.113.0/24' });
    const v6 = await refer(channelId, champion.id, { ip: '2001:db8:abcd:12::1' });
    expect((await referral(v6.id))?.ip_prefix).toBe('2001:db8:abcd::/48');

    // The same person under a tag or dots, and the same id, are refused.
    const self = await member(channelId, { email: 'adalovelace+news@example.com' });
    expect(
      await recordReferral(env.DB, {
        channelId,
        referrerId: champion.id,
        referredId: self.id,
        referredEmail: self.email,
      }),
    ).toBe('self');
    expect(
      await recordReferral(env.DB, {
        channelId,
        referrerId: champion.id,
        referredId: champion.id,
        referredEmail: champion.email,
      }),
    ).toBe('self');
    expect(await referral(self.id)).toBeNull();
  });

  it('rejects disposable addresses when block_disposable is on', async () => {
    const { channelId } = await seedChannel();
    const champion = await member(channelId);
    const throwaway = await member(channelId, { email: `x${Date.now()}@mailinator.com` });
    expect(
      await recordReferral(env.DB, {
        channelId,
        referrerId: champion.id,
        referredId: throwaway.id,
        referredEmail: throwaway.email,
      }),
    ).toBe('rejected');
    expect(await referral(throwaway.id)).toMatchObject({
      status: 'rejected',
      review_reason: 'disposable_domain',
    });

    await enable(channelId, { block_disposable: 0 });
    const other = await member(channelId, { email: `y${Date.now()}@mailinator.com` });
    expect(
      await recordReferral(env.DB, {
        channelId,
        referrerId: champion.id,
        referredId: other.id,
        referredEmail: other.email,
      }),
    ).toBe('recorded');
  });
});

describe('counting referrals', () => {
  it('counts confirmed and engaged referrals, waits for the rest, rejects the stale', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const now = Date.now();
    const champion = await member(channelId);
    const engaged = await refer(channelId, champion.id, { at: now - 3 * DAY });
    await open(workspaceId, channelId, engaged.id, now - 2 * DAY);
    const waiting = await refer(channelId, champion.id, { at: now - 3 * DAY });
    const unconfirmed = await refer(channelId, champion.id, {
      at: now - 3 * DAY,
      confirmedAt: null,
      status: 'pending',
    });
    const late = await refer(channelId, champion.id, { at: now - 30 * DAY });
    await open(workspaceId, channelId, late.id, now - 10 * DAY); // 20 days after confirming
    const silent = await refer(channelId, champion.id, { at: now - 20 * DAY });
    const neverConfirmed = await refer(channelId, champion.id, {
      at: now - 20 * DAY,
      confirmedAt: null,
      status: 'pending',
    });
    const left = await refer(channelId, champion.id, { at: now - DAY, status: 'unsubscribed' });

    const result = await countReferrals(deps(), now);
    expect(result.counted).toBeGreaterThanOrEqual(1);
    expect(await referral(engaged.id)).toMatchObject({ status: 'counted', counted_at: now });
    expect((await referral(waiting.id))?.status).toBe('pending');
    expect((await referral(unconfirmed.id))?.status).toBe('pending');
    expect(await referral(late.id)).toMatchObject({
      status: 'rejected',
      review_reason: 'not_engaged',
    });
    expect(await referral(silent.id)).toMatchObject({
      status: 'rejected',
      review_reason: 'not_engaged',
    });
    expect((await referral(neverConfirmed.id))?.status).toBe('rejected');
    expect(await referral(left.id)).toMatchObject({
      status: 'rejected',
      review_reason: 'unsubscribed',
    });

    // The waiting one counts once it opens within the window, on the minute cron.
    await open(workspaceId, channelId, waiting.id, now + HOUR);
    await runScheduled(jobsEnv().env, MINUTE_CRON, now + 2 * HOUR);
    expect((await referral(waiting.id))?.status).toBe('counted');
  });

  it('holds a cluster from one network and lets an operator approve it', async () => {
    const { workspaceId, channelId } = await seedChannel();
    await enable(channelId);
    const now = Date.now();
    const champion = await member(channelId);
    const other = await member(channelId);
    const cluster = [];
    for (let i = 0; i < 5; i++) {
      cluster.push(
        await refer(channelId, champion.id, { ip: `192.0.2.${10 + i}`, at: now - 5 * HOUR + i }),
      );
    }
    // Another Champion on the same network, and the first Champion a day later, are fine.
    const elsewhere = await refer(channelId, other.id, { ip: '192.0.2.99', at: now - HOUR });
    const nextDay = await refer(channelId, champion.id, { ip: '192.0.2.50', at: now + 25 * HOUR });
    for (const r of [...cluster, elsewhere]) await open(workspaceId, channelId, r.id, now);
    await open(workspaceId, channelId, nextDay.id, now + 26 * HOUR);

    await countReferrals(deps(), now + 27 * HOUR);
    const statuses = await Promise.all(cluster.map(async (r) => (await referral(r.id))?.status));
    expect(statuses).toEqual(['counted', 'counted', 'counted', 'held', 'held']);
    expect((await referral(cluster[3]!.id))?.review_reason).toBe('ip_cluster');
    expect((await referral(elsewhere.id))?.status).toBe('counted');
    expect((await referral(nextDay.id))?.status).toBe('counted');

    const held = await env.DB.prepare('SELECT id FROM referrals WHERE referred_id = ?1')
      .bind(cluster[3]!.id)
      .first<{ id: string }>();
    const operatorId = newId('operator');
    await env.DB.prepare(
      'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, 0, 0)',
    )
      .bind(operatorId, email('op'))
      .run();
    const review = await reviewReferral(deps(), {
      channelId,
      referralId: held!.id,
      operatorId,
      approve: true,
    });
    expect(review?.referrerId).toBe(champion.id);
    expect((await referral(cluster[3]!.id))?.status).toBe('counted');
    // Reviewing again does nothing: it is no longer held.
    expect(
      await reviewReferral(deps(), {
        channelId,
        referralId: held!.id,
        operatorId,
        approve: false,
      }),
    ).toBeNull();
    const rejected = await env.DB.prepare('SELECT id FROM referrals WHERE referred_id = ?1')
      .bind(cluster[4]!.id)
      .first<{ id: string }>();
    await reviewReferral(deps(), {
      channelId,
      referralId: rejected!.id,
      operatorId,
      approve: false,
    });
    expect(await referral(cluster[4]!.id)).toMatchObject({
      status: 'rejected',
      review_reason: 'operator',
    });
  });
});

describe('milestones and rewards', () => {
  async function setup(kind: 'comp_level' | 'coupon' | 'manual') {
    const { workspaceId, channelId } = await seedChannel();
    await enable(channelId);
    const now = Date.now();
    const levelId = newId('membershipLevel', now);
    const couponId = newId('coupon', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Supporter', ?3, ?3)`,
      ).bind(levelId, channelId, now),
      env.DB.prepare(
        `INSERT INTO coupons (id, channel_id, code, percent_off, duration, created_at)
         VALUES (?1, ?2, 'THANKS50', 50, 'once', ?3)`,
      ).bind(couponId, channelId, now),
    ]);
    const rewardId = newId('championReward', now);
    await env.DB.prepare(
      `INSERT INTO champion_rewards (id, channel_id, kind, name, level_id, comp_days, coupon_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Thank you', ?4, ?5, ?6, ?7, ?7)`,
    )
      .bind(
        rewardId,
        channelId,
        kind,
        kind === 'comp_level' ? levelId : null,
        kind === 'comp_level' ? 30 : null,
        kind === 'coupon' ? couponId : null,
        now,
      )
      .run();
    const milestoneId = newId('championMilestone', now);
    await env.DB.prepare(
      `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, reward_id, created_at, updated_at)
       VALUES (?1, ?2, 2, 'Two friends', ?3, ?4, ?4)`,
    )
      .bind(milestoneId, channelId, rewardId, now)
      .run();
    const champion = await member(channelId, { firstName: 'Ada' });
    for (let i = 0; i < 2; i++) {
      const r = await refer(channelId, champion.id, { at: now - DAY });
      await open(workspaceId, channelId, r.id, now - HOUR);
    }
    return { channelId, champion, levelId, milestoneId, now };
  }

  async function awards(memberId: string) {
    return (
      await env.DB.prepare('SELECT * FROM champion_awards WHERE member_id = ?1')
        .bind(memberId)
        .all<{ id: string; status: string; comp_grant_id: string | null }>()
    ).results;
  }

  it('grants a comp level exactly once, however many runs race', async () => {
    const { channelId, champion, levelId, now } = await setup('comp_level');
    const results = await Promise.all([
      countReferrals(deps(), now),
      countReferrals(deps(), now),
      checkMilestones(deps(), channelId, champion.id, now),
    ]);
    await Promise.all(
      Array.from({ length: 4 }, () => checkMilestones(deps(), channelId, champion.id, now)),
    );
    await countReferrals(deps(), now + 1000);
    expect(results.length).toBe(3);

    const rows = await awards(champion.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('fulfilled');
    const grants = await env.DB.prepare('SELECT * FROM comp_grants WHERE member_id = ?1')
      .bind(champion.id)
      .all<{ id: string; expires_at: number; granted_by: string | null }>();
    expect(grants.results).toHaveLength(1);
    expect(grants.results[0]).toMatchObject({ id: rows[0]!.comp_grant_id, granted_by: null });
    expect(grants.results[0]!.expires_at).toBe(now + 30 * DAY);
    expect(await entitledLevel(env.DB, channelId, champion.id, now)).toBe(levelId);

    const mail = await mailTo(champion.email);
    expect(mail.filter((m) => m.category === 'champion_award')).toHaveLength(1);
    expect(mail[0]!.text).toContain('Supporter for 30 days');
  });

  it('emails a coupon code and leaves manual rewards for the operator', async () => {
    const coupon = await setup('coupon');
    await countReferrals(deps(), coupon.now);
    expect((await awards(coupon.champion.id))[0]?.status).toBe('fulfilled');
    const mail = await mailTo(coupon.champion.email);
    expect(mail[0]?.text).toContain('THANKS50');

    const manual = await setup('manual');
    await countReferrals(deps(), manual.now);
    expect((await awards(manual.champion.id))[0]?.status).toBe('pending');
  });

  it('still checks the other Champions when one Champion’s milestone check throws', async () => {
    const a = await setup('manual');
    const b = await setup('manual');
    // The first Champion checked fails; which one that is depends on the counting order.
    let failed = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === 'prepare') {
          return (sql: string) => {
            if (!failed && sql.includes('FROM members m WHERE m.id = ?1 AND m.channel_id = ?2')) {
              failed = true;
              throw new Error('D1_ERROR: boom');
            }
            return target.prepare(sql);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await countReferrals({ ...deps(), db }, Math.max(a.now, b.now));
    expect(failed).toBe(true);
    expect(result.counted).toBeGreaterThanOrEqual(4);
    const awarded = [
      (await awards(a.champion.id)).length,
      (await awards(b.champion.id)).length,
    ].sort();
    expect(awarded).toEqual([0, 1]);
  });

  it('awards nothing while Champions is off', async () => {
    const { channelId, champion, now } = await setup('comp_level');
    await enable(channelId, { enabled: 0 });
    await countReferrals(deps(), now);
    expect(await awards(champion.id)).toHaveLength(0);
    await enable(channelId);
    expect(await checkMilestones(deps(), channelId, champion.id, now)).toHaveLength(1);
  });
});
