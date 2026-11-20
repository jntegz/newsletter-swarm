// The engagement rollup against real D1: who gets what, batching with a cursor, the flag, and that
// the Segment condition reads the same rows.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  ENGAGEMENT_FRESH_MS,
  compileCircle,
  engagementSummary,
  readMemberEngagement,
  runEngagementRollup,
  scoreEngagementBatch,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { addMember, jobsEnv, one, seedChannel } from './helpers';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4, 12);

async function turnOn(channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'engagement_scores', 'channel', ?2, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
    .run();
}

async function broadcast(channelId: string, workspaceId: string) {
  const dispatchId = newId('dispatch');
  const id = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{}', 'sent', 0, 0)`,
    ).bind(dispatchId, channelId),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Post', '', '', '', 'A', 'a@example.com', 1, 0, 0)`,
    ).bind(id, dispatchId, channelId, workspaceId),
  ]);
  return id;
}

interface Delivered {
  sentAgo: number;
  status?: string;
  human?: boolean;
  machine?: boolean;
  click?: boolean;
}

async function deliver(
  world: { channelId: string; workspaceId: string },
  memberId: string,
  list: Delivered[],
) {
  for (const d of list) {
    const sent = now - d.sentAgo;
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at,
         opened_at, human_opened_at, clicked_at, human_clicked_at)
       VALUES (?1, ?2, ?3, ?4, 'x@example.com', ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
      .bind(
        newId('delivery'),
        await broadcast(world.channelId, world.workspaceId),
        world.channelId,
        memberId,
        d.status ?? 'delivered',
        sent,
        d.human || d.machine || d.click ? sent : null,
        d.human || d.click ? sent : null,
        d.click ? sent : null,
      )
      .run();
  }
}

let serial = 0;
const person = (channelId: string, options?: { status?: 'unsubscribed' }) =>
  addMember(channelId, `p${++serial}@example.com`, options);

const score = async (channelId: string, memberId: string) =>
  (await readMemberEngagement(env.DB, channelId, [memberId], now)).get(memberId);

describe('engagement rollup', () => {
  it('scores people from human activity only, within the window', async () => {
    const world = await seedChannel();
    await turnOn(world.channelId);
    const reader = await person(world.channelId);
    const proxy = await person(world.channelId);
    const silent = await person(world.channelId);
    const fresh = await person(world.channelId);
    const lapsed = await person(world.channelId, { status: 'unsubscribed' });
    const three = [2, 3, 4].map((d) => d * DAY);
    await deliver(
      world,
      reader,
      three.map((sentAgo) => ({ sentAgo, human: true, click: true })),
    );
    await deliver(
      world,
      proxy,
      three.map((sentAgo) => ({ sentAgo, machine: true })),
    );
    await deliver(
      world,
      silent,
      three.map((sentAgo) => ({ sentAgo })),
    );
    // Too recent, too old, and a bounce: none of them count, so this one has too few posts.
    await deliver(world, fresh, [
      { sentAgo: DAY / 2 },
      { sentAgo: 100 * DAY, human: true },
      { sentAgo: 5 * DAY, status: 'bounced' },
      { sentAgo: 5 * DAY, human: true },
    ]);
    await deliver(
      world,
      lapsed,
      three.map((sentAgo) => ({ sentAgo, human: true })),
    );

    await runEngagementRollup(env.DB, now);

    expect(await score(world.channelId, reader)).toMatchObject({
      band: 'very_engaged',
      sentCount: 3,
      openedCount: 3,
      clickedCount: 3,
    });
    expect(await score(world.channelId, proxy)).toMatchObject({
      score: null,
      band: 'opens_hidden',
    });
    expect(await score(world.channelId, silent)).toMatchObject({ score: 0, band: 'cold' });
    expect(await score(world.channelId, fresh)).toMatchObject({
      score: null,
      band: 'too_few_posts',
      sentCount: 1,
    });
    expect(await score(world.channelId, lapsed)).toBeUndefined();

    const summary = await engagementSummary(env.DB, world.channelId, now);
    expect(summary.bands).toMatchObject({
      very_engaged: 1,
      opens_hidden: 1,
      cold: 1,
      too_few_posts: 1,
    });
  });

  it('feeds Segment conditions, leaving out people with no score', async () => {
    const world = await seedChannel();
    await turnOn(world.channelId);
    const proxy = await person(world.channelId);
    const silent = await person(world.channelId);
    const three = [2, 3, 4].map((d) => d * DAY);
    await deliver(
      world,
      proxy,
      three.map((sentAgo) => ({ sentAgo, machine: true })),
    );
    await deliver(
      world,
      silent,
      three.map((sentAgo) => ({ sentAgo })),
    );
    await runEngagementRollup(env.DB, now);

    const ids = async (rule: unknown, at = now) => {
      const compiled = await compileCircle(env.DB, rule, world.channelId, at);
      const { results } = await env.DB.prepare(
        `SELECT m.id FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})`,
      )
        .bind(...compiled.params, world.channelId)
        .all<{ id: string }>();
      return results.map((r) => r.id);
    };
    expect(await ids({ field: 'engagement_score', cmp: 'lt', value: 10 })).toEqual([silent]);
    expect(await ids({ field: 'engagement_band', cmp: 'eq', value: 'cold' })).toEqual([silent]);
    expect(await ids({ field: 'engagement_band', cmp: 'neq', value: 'cold' })).toEqual([proxy]);
    // Stale scores count as missing, so a stopped rollup can't keep steering sends.
    const later = now + ENGAGEMENT_FRESH_MS + DAY;
    expect(await ids({ field: 'engagement_band', cmp: 'eq', value: 'cold' }, later)).toEqual([]);
    await expect(ids({ field: 'engagement_score', cmp: 'lt', value: 101 })).rejects.toThrow(
      /0 to 100/,
    );
    await expect(ids({ field: 'engagement_band', cmp: 'eq', value: 'nope' })).rejects.toThrow(
      /Pick one/,
    );
  });

  it('works through a long list in batches, once a day', async () => {
    const world = await seedChannel();
    await turnOn(world.channelId);
    const members = [];
    for (let i = 0; i < 5; i++) members.push(await person(world.channelId));
    const first = await scoreEngagementBatch(env.DB, world.channelId, null, now, 2);
    expect(first).toBe([...members].sort()[1]);
    const second = await scoreEngagementBatch(env.DB, world.channelId, first, now, 2);
    const third = await scoreEngagementBatch(env.DB, world.channelId, second, now, 2);
    expect(third).toBeNull();
    expect((await readMemberEngagement(env.DB, world.channelId, members, now)).size).toBe(5);

    await runEngagementRollup(env.DB, now);
    const row = await one<{ day: string; finished: number }>(
      'SELECT day, finished FROM engagement_rollups WHERE channel_id = ?1',
      world.channelId,
    );
    expect(row).toMatchObject({ day: '2026-11-04', finished: 1 });
    await env.DB.prepare('UPDATE member_engagement SET computed_at = 1 WHERE channel_id = ?1')
      .bind(world.channelId)
      .run();
    await runEngagementRollup(env.DB, now + 60_000);
    expect((await readMemberEngagement(env.DB, world.channelId, members, now)).size).toBe(0);
    await runEngagementRollup(env.DB, now + DAY);
    expect((await readMemberEngagement(env.DB, world.channelId, members, now + DAY)).size).toBe(5);
  });

  it('resumes from its cursor when the budget runs out', async () => {
    const world = await seedChannel();
    await turnOn(world.channelId);
    const members = [await person(world.channelId), await person(world.channelId)];
    const row = () =>
      one<{ cursor: string | null; finished: number }>(
        'SELECT cursor, finished FROM engagement_rollups WHERE channel_id = ?1',
        world.channelId,
      );
    // Finish every other Channel first, so the budget of one batch goes to this one.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO engagement_rollups (channel_id, day, cursor, finished)
       SELECT id, '2026-11-04', NULL, 1 FROM channels WHERE id <> ?1`,
    )
      .bind(world.channelId)
      .run();
    await runEngagementRollup(env.DB, now, { budget: 1, batch: 1 });
    expect(await row()).toMatchObject({ cursor: [...members].sort()[0], finished: 0 });
    expect((await readMemberEngagement(env.DB, world.channelId, members, now)).size).toBe(1);
    await runEngagementRollup(env.DB, now, { budget: 2, batch: 1 });
    expect((await readMemberEngagement(env.DB, world.channelId, members, now)).size).toBe(2);
    await runEngagementRollup(env.DB, now, { budget: 1, batch: 1 });
    expect(await row()).toMatchObject({ cursor: null, finished: 1 });
  });

  it('keeps no scores while the flag is off', async () => {
    const world = await seedChannel();
    const member = await person(world.channelId);
    await env.DB.prepare(
      `INSERT INTO member_engagement (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, computed_at)
       VALUES (?1, ?2, 50, 'engaged', 3, 1, 0, ?3)`,
    )
      .bind(member, world.channelId, now)
      .run();
    await runEngagementRollup(env.DB, now);
    expect(await score(world.channelId, member)).toBeUndefined();
  });

  it('runs from the minute cron', async () => {
    const world = await seedChannel();
    await turnOn(world.channelId);
    const member = await person(world.channelId);
    await runScheduled(jobsEnv().env, MINUTE_CRON, now);
    expect(await score(world.channelId, member)).toMatchObject({ band: 'too_few_posts' });
  });
});
