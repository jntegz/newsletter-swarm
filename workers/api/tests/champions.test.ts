import { env } from 'cloudflare:test';
import type {
  ChampionAward,
  ChampionMilestone,
  ChampionReward,
  ChampionSettings,
  MemberChampion,
  Referral,
  Series,
} from '@swarm/domain';
import { CHAMPION_CODE, newId } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { addMember, data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let admin: Session;
let editor: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;
let channelSlug: string;
let otherChannelId: string;
let levelId: string;

const base = (id = channelId) => `/api/v1/channels/${id}`;

async function cacheVersion(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
    .bind(id)
    .first<{ cache_version: number }>();
  return row?.cache_version ?? 1;
}

async function level(id: string): Promise<string> {
  const levelId = newId('membershipLevel');
  await env.DB.prepare(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Supporter', 0, 0)`,
  )
    .bind(levelId, id)
    .run();
  return levelId;
}

/** A referral of `referrerId` in `status`, as the counting job would leave it. */
async function seedReferral(s: Session, id: string, referrerId: string, status: string) {
  const friend = await addMember(s, id);
  const referralId = newId('referral');
  await env.DB.prepare(
    `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at, status, review_reason, ip_prefix)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '192.0.2.0/24')`,
  )
    .bind(
      referralId,
      id,
      referrerId,
      friend.id,
      Date.now(),
      status,
      status === 'held' ? 'ip_cluster' : null,
    )
    .run();
  return referralId;
}

beforeAll(async () => {
  owner = await signIn();
  const channel = await createChannel(owner);
  channelId = channel.id;
  channelSlug = channel.slug;
  admin = await seatAs(owner.workspaceId, 'admin');
  editor = await seatAs(owner.workspaceId, 'editor');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
  otherChannelId = (await createChannel(outsider)).id;
  levelId = await level(channelId);
});

describe('Champions settings', () => {
  it('reads defaults, lets admins change them and bumps the site cache', async () => {
    const defaults = await data<ChampionSettings>(
      await call('GET', `${base()}/champions/settings`, { cookie: viewer.cookie }),
    );
    expect(defaults).toMatchObject({
      enabled: false,
      engagementDays: 14,
      clusterLimit: 3,
      clusterWindowHours: 24,
      blockDisposable: true,
      publicLeaderboard: false,
      updatedAt: null,
    });
    for (const s of [viewer, editor]) {
      const res = await call('PATCH', `${base()}/champions/settings`, {
        cookie: s.cookie,
        body: { enabled: true },
      });
      expect(res.status).toBe(403);
    }
    const before = await cacheVersion(channelId);
    const saved = await data<ChampionSettings>(
      await call('PATCH', `${base()}/champions/settings`, {
        cookie: admin.cookie,
        body: { enabled: true, engagementDays: 7, publicLeaderboard: true, shareText: 'Share it' },
      }),
    );
    expect(saved).toMatchObject({ enabled: true, engagementDays: 7, publicLeaderboard: true });
    expect(await cacheVersion(channelId)).toBe(before + 1);
    const invalid = await call('PATCH', `${base()}/champions/settings`, {
      cookie: admin.cookie,
      body: { engagementDays: 365 },
    });
    expect(invalid.status).toBe(400);
    const cross = await call('GET', `${base(otherChannelId)}/champions/settings`, {
      cookie: owner.cookie,
    });
    expect(cross.status).toBe(404);
  });
});

describe('rewards and milestones', () => {
  it('checks references, roles and duplicate thresholds', async () => {
    const otherLevel = await level(otherChannelId);
    const foreign = await call('POST', `${base()}/champions/rewards`, {
      cookie: admin.cookie,
      body: { kind: 'comp_level', name: 'A month', levelId: otherLevel, compDays: 30 },
    });
    expect(foreign.status).toBe(400);
    const missing = await call('POST', `${base()}/champions/rewards`, {
      cookie: admin.cookie,
      body: { kind: 'coupon', name: 'Coupon' },
    });
    expect(missing.status).toBe(400);
    expect(
      (
        await call('POST', `${base()}/champions/rewards`, {
          cookie: editor.cookie,
          body: { kind: 'manual', name: 'Stickers' },
        })
      ).status,
    ).toBe(403);
    const reward = await data<ChampionReward>(
      await call('POST', `${base()}/champions/rewards`, {
        cookie: admin.cookie,
        body: { kind: 'comp_level', name: 'A month', levelId, compDays: 30 },
      }),
      201,
    );
    expect(reward).toMatchObject({ kind: 'comp_level', levelId, compDays: 30, status: 'active' });

    const milestone = await data<ChampionMilestone>(
      await call('POST', `${base()}/champions/milestones`, {
        cookie: admin.cookie,
        body: { referralsRequired: 1, name: 'First friend', rewardId: reward.id },
      }),
      201,
    );
    expect(milestone).toMatchObject({ referralsRequired: 1, rewardId: reward.id });
    const duplicate = await call('POST', `${base()}/champions/milestones`, {
      cookie: admin.cookie,
      body: { referralsRequired: 1, name: 'Again' },
    });
    expect(duplicate.status).toBe(409);
    const crossReward = await call('POST', `${base(otherChannelId)}/champions/milestones`, {
      cookie: outsider.cookie,
      body: { referralsRequired: 2, name: 'Theirs', rewardId: reward.id },
    });
    expect(crossReward.status).toBe(400);
    const list = await data<{ items: ChampionMilestone[] }>(
      await call('GET', `${base()}/champions/milestones`, { cookie: viewer.cookie }),
    );
    expect(list.items.map((m) => m.id)).toContain(milestone.id);
    expect(
      (
        await call('PATCH', `${base(otherChannelId)}/champions/milestones/${milestone.id}`, {
          cookie: outsider.cookie,
          body: { name: 'Mine now' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('a Member’s share link', () => {
  it('assigns a code on first use and links to the site', async () => {
    const champion = await addMember(owner, channelId);
    const first = await data<MemberChampion>(
      await call('GET', `${base()}/members/${champion.id}/champion`, { cookie: viewer.cookie }),
    );
    expect(first.code).toMatch(CHAMPION_CODE);
    expect(first.shareUrl).toBe(`http://${channelSlug}.site.localhost/?ref=${first.code}`);
    expect(first.shortUrl).toBe(`http://${channelSlug}.site.localhost/r/${first.code}`);
    const again = await data<MemberChampion>(
      await call('GET', `${base()}/members/${champion.id}/champion`, { cookie: viewer.cookie }),
    );
    expect(again.code).toBe(first.code);
    const cross = await call('GET', `${base(otherChannelId)}/members/${champion.id}/champion`, {
      cookie: outsider.cookie,
    });
    expect(cross.status).toBe(404);
    const outside = await call('GET', `${base()}/members/${champion.id}/champion`, {
      cookie: outsider.cookie,
    });
    expect(outside.status).toBe(404);
  });
});

describe('referral review and awards', () => {
  it('lets editors approve held referrals, which awards and grants the reward once', async () => {
    const champion = await addMember(owner, channelId);
    const held = await seedReferral(owner, channelId, champion.id, 'held');
    const list = await data<{ items: Referral[] }>(
      await call('GET', `${base()}/champions/referrals?status=held`, { cookie: viewer.cookie }),
    );
    expect(list.items.find((r) => r.id === held)).toMatchObject({
      status: 'held',
      reviewReason: 'ip_cluster',
      ipPrefix: '192.0.2.0/24',
      referrerId: champion.id,
    });
    expect(
      (
        await call('POST', `${base()}/champions/referrals/${held}/approve`, {
          cookie: viewer.cookie,
        })
      ).status,
    ).toBe(403);
    // Through another Channel the referral doesn't exist.
    const cross = await call(
      'POST',
      `${base(otherChannelId)}/champions/referrals/${held}/approve`,
      {
        cookie: outsider.cookie,
      },
    );
    expect(cross.status).toBe(404);

    const approved = await data<Referral>(
      await call('POST', `${base()}/champions/referrals/${held}/approve`, {
        cookie: editor.cookie,
      }),
    );
    expect(approved).toMatchObject({ status: 'counted', reviewedBy: editor.me.operator.id });
    const repeat = await call('POST', `${base()}/champions/referrals/${held}/reject`, {
      cookie: editor.cookie,
    });
    expect(repeat.status).toBe(409);

    // The "First friend" milestone (1 referral, comp_level for 30 days) was awarded.
    const awards = await data<{ items: ChampionAward[] }>(
      await call('GET', `${base()}/champions/awards?memberId=${champion.id}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(awards.items).toHaveLength(1);
    expect(awards.items[0]).toMatchObject({ status: 'fulfilled', rewardKind: 'comp_level' });
    const entitlement = await env.DB.prepare(
      `SELECT level_id, source FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    )
      .bind(champion.id)
      .first<{ level_id: string; source: string }>();
    expect(entitlement).toMatchObject({ level_id: levelId, source: 'comp' });
    const audit = await env.DB.prepare(
      'SELECT action FROM audit_events WHERE workspace_id = ?1 AND action LIKE ?2',
    )
      .bind(owner.workspaceId, 'champions.%')
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(
      expect.arrayContaining(['champions.referral_approved', 'champions.award_granted']),
    );

    const board = await data<{ items: { memberId: string; counted: number }[] }>(
      await call('GET', `${base()}/champions/leaderboard?limit=100`, { cookie: viewer.cookie }),
    );
    expect(board.items.find((e) => e.memberId === champion.id)?.counted).toBe(1);
  });

  it('lets admins complete a manual award', async () => {
    const champion = await addMember(owner, channelId);
    const rewardId = newId('championReward');
    const milestoneId = newId('championMilestone');
    const awardId = newId('championAward');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO champion_rewards (id, channel_id, kind, name, created_at, updated_at) VALUES (?1, ?2, 'manual', 'Mug', 0, 0)`,
      ).bind(rewardId, channelId),
      env.DB.prepare(
        `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, reward_id, status, created_at, updated_at)
         VALUES (?1, ?2, 50, 'Fifty', ?3, 'archived', 0, 0)`,
      ).bind(milestoneId, channelId, rewardId),
      env.DB.prepare(
        `INSERT INTO champion_awards (id, channel_id, member_id, milestone_id, reward_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0)`,
      ).bind(awardId, channelId, champion.id, milestoneId, rewardId),
    ]);
    const path = `${base()}/champions/awards/${awardId}/fulfil`;
    expect((await call('POST', path, { cookie: editor.cookie, body: {} })).status).toBe(403);
    expect(
      (
        await call('POST', `${base(otherChannelId)}/champions/awards/${awardId}/fulfil`, {
          cookie: outsider.cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
    const done = await data<ChampionAward>(
      await call('POST', path, { cookie: admin.cookie, body: { detail: 'Posted on Monday' } }),
    );
    expect(done).toMatchObject({ status: 'fulfilled', detail: 'Posted on Monday' });
    const again = await call('POST', path, { cookie: admin.cookie, body: {} });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('conflict');
  });
});

describe('Series', () => {
  async function dispatch(s: Session, id = channelId) {
    return data<{ id: string }>(
      await call('POST', `${base(id)}/dispatches`, {
        cookie: s.cookie,
        body: { subject: 'A part', content: { type: 'doc', content: [] } },
      }),
      201,
    );
  }

  it('is behind the post_series flag', async () => {
    const res = await call('GET', `${base()}/series`, { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('orders Dispatches, keeps each in one Series and bumps the site cache', async () => {
    await enableFlag('post_series', owner.workspaceId, channelId);
    const [a, b, c] = [await dispatch(editor), await dispatch(editor), await dispatch(editor)];
    expect(
      (
        await call('POST', `${base()}/series`, {
          cookie: viewer.cookie,
          body: { name: 'Fox Season' },
        })
      ).status,
    ).toBe(403);
    const before = await cacheVersion(channelId);
    const created = await data<Series>(
      await call('POST', `${base()}/series`, {
        cookie: editor.cookie,
        body: { name: 'Fox Season', dispatchIds: [b!.id, a!.id] },
      }),
      201,
    );
    expect(created).toMatchObject({ slug: 'fox-season', dispatchIds: [b!.id, a!.id] });
    expect(await cacheVersion(channelId)).toBe(before + 1);

    const reordered = await data<Series>(
      await call('PATCH', `${base()}/series/${created.id}`, {
        cookie: editor.cookie,
        body: { dispatchIds: [a!.id, c!.id, b!.id] },
      }),
    );
    expect(reordered.dispatchIds).toEqual([a!.id, c!.id, b!.id]);

    // A Dispatch in this Series can't join another; a slug is taken once.
    const taken = await call('POST', `${base()}/series`, {
      cookie: editor.cookie,
      body: { name: 'Other', dispatchIds: [c!.id] },
    });
    expect(taken.status).toBe(409);
    const sameSlug = await call('POST', `${base()}/series`, {
      cookie: editor.cookie,
      body: { name: 'Fox season' },
    });
    expect(sameSlug.status).toBe(409);
    // Another Channel's Dispatch is refused; another Channel can't see this Series.
    await enableFlag('post_series', outsider.workspaceId, otherChannelId);
    const theirs = await dispatch(outsider, otherChannelId);
    const foreign = await call('PATCH', `${base()}/series/${created.id}`, {
      cookie: editor.cookie,
      body: { dispatchIds: [theirs.id] },
    });
    expect(foreign.status).toBe(400);
    const cross = await call('GET', `${base(otherChannelId)}/series/${created.id}`, {
      cookie: outsider.cookie,
    });
    expect(cross.status).toBe(404);

    const removed = await call('DELETE', `${base()}/series/${created.id}`, {
      cookie: editor.cookie,
    });
    expect(removed.status).toBe(204);
    // Its Dispatches are free to join a new Series.
    await data<Series>(
      await call('POST', `${base()}/series`, {
        cookie: editor.cookie,
        body: { name: 'Fox Season', dispatchIds: [c!.id] },
      }),
      201,
    );
  });
});
