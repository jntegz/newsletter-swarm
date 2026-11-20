// Engagement scores through the API: on Members, the summary, Segment rules and the flag.
import { env } from 'cloudflare:test';
import type { EngagementSummary, MemberDetail, MemberListItem } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, signIn, trackReaders, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let channelId: string;
let memberId: string;

const rule = { field: 'engagement_band', cmp: 'eq', value: 'cold' };

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await trackReaders(owner, channelId);
  const member = await data<MemberDetail>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: 'reader@example.com', consent: true },
    }),
    201,
  );
  memberId = member.id;
  await env.DB.prepare(
    `INSERT INTO member_engagement (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, computed_at)
     VALUES (?1, ?2, 5, 'cold', 4, 0, 0, ?3)`,
  )
    .bind(memberId, channelId, Date.now())
    .run();
});

describe('engagement scores', () => {
  it('shows nothing and refuses rules while the flag is off', async () => {
    const summary = await call('GET', `/api/v1/channels/${channelId}/members/engagement`, {
      cookie: owner.cookie,
    });
    expect(summary.status).toBe(404);
    expect(await errorCode(summary)).toBe('feature_disabled');
    const detail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${memberId}`, { cookie: owner.cookie }),
    );
    expect(detail.engagement).toBeNull();
    const list = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channelId}/members`, { cookie: owner.cookie }),
    );
    expect(list.items[0]?.engagement).toBeNull();
    const saved = await call('POST', `/api/v1/channels/${channelId}/circles`, {
      cookie: owner.cookie,
      body: { name: 'Cold', rule },
    });
    expect(saved.status).toBe(400);
  });

  it('shows the score on the list, the detail and the summary when on', async () => {
    await enableFlag('engagement_scores', owner.workspaceId, channelId);
    const detail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${memberId}`, { cookie: owner.cookie }),
    );
    expect(detail.engagement).toMatchObject({ score: 5, band: 'cold', sentCount: 4 });
    const list = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channelId}/members`, { cookie: owner.cookie }),
    );
    expect(list.items[0]?.engagement).toMatchObject({ band: 'cold' });
    const summary = await data<EngagementSummary>(
      await call('GET', `/api/v1/channels/${channelId}/members/engagement`, {
        cookie: owner.cookie,
      }),
    );
    expect(summary.bands.cold).toBe(1);
    expect(summary.bands.engaged).toBe(0);
  });

  it('lets a Segment use it, and finds the same people', async () => {
    const preview = await data<{ count: number }>(
      await call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        cookie: owner.cookie,
        body: { rule },
      }),
    );
    expect(preview.count).toBe(1);
    const saved = await call('POST', `/api/v1/channels/${channelId}/circles`, {
      cookie: owner.cookie,
      body: { name: 'Cold', rule },
    });
    expect(saved.status).toBe(201);
  });

  it('keeps one publication’s scores out of another’s', async () => {
    const other = await createChannel(owner);
    await trackReaders(owner, other.id);
    await enableFlag('engagement_scores', owner.workspaceId, other.id);
    const summary = await data<EngagementSummary>(
      await call('GET', `/api/v1/channels/${other.id}/members/engagement`, {
        cookie: owner.cookie,
      }),
    );
    expect(summary.bands.cold).toBe(0);
    expect(summary.computedAt).toBeNull();
  });

  it('removes the score with the Member', async () => {
    await call('DELETE', `/api/v1/members/${memberId}`, { cookie: owner.cookie });
    const row = await env.DB.prepare('SELECT 1 FROM member_engagement WHERE member_id = ?1')
      .bind(memberId)
      .first();
    expect(row).toBeNull();
  });
});
