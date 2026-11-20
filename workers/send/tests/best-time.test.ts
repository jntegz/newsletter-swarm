// Sending at each reader's best time: where the hour comes from, how a slot is held through the
// pipeline, and how it lives with warm-up, split tests, cancel and the flag.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  bestHour,
  cancelBroadcast,
  fitsWarmUp,
  preflight,
  pruneMemberSendHours,
  releaseBestTimeSlots,
  slotFor,
  StartError,
  startBroadcast,
  toBroadcast,
  type BroadcastRow,
  type DispatchRow,
  type SendFeatures,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { startDue } from '../src/index';
import { parseSendEnv } from '../src/env';
import {
  CaptureMail,
  completeRamp,
  config,
  context,
  count,
  drain,
  seedChannel,
  seedDispatch,
} from './harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ON: SendFeatures = { bestTime: true };
/** 09:20 UTC, later than the history below. */
const START = Date.UTC(2026, 10, 3, 9, 20);

const at = (hour: number, daysAgo: number) => Date.UTC(2026, 10, 3 - daysAgo, hour, 15);

async function members(channelId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, email FROM members WHERE channel_id = ?1 ORDER BY id',
  )
    .bind(channelId)
    .all<{ id: string; email: string }>();
  return results;
}

/** One past send to one Member, with how a person engaged with it. */
async function pastSend(
  channel: { channelId: string; workspaceId: string },
  member: { id: string; email: string },
  when: { opened?: number; clicked?: number; machine?: number; sent?: number },
) {
  const sent = when.sent ?? (when.opened ?? when.clicked ?? when.machine ?? START) - HOUR;
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Old', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, channel.channelId, sent),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Old', '', '<p>Hi</p>', 'Hi', 'N', 'n@example.com', 1, ?5, ?5)`,
    ).bind(broadcastId, dispatchId, channel.channelId, channel.workspaceId, sent),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at, human_clicked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?7, ?8, ?9)`,
    ).bind(
      newId('delivery'),
      broadcastId,
      channel.channelId,
      member.id,
      member.email,
      sent,
      when.machine ?? when.opened ?? null,
      when.opened ?? null,
      when.clicked ?? null,
    ),
  ]);
}

/** A Member who opened at this UTC hour on `posts` past posts. */
async function habit(
  channel: { channelId: string; workspaceId: string },
  member: { id: string; email: string },
  hour: number,
  posts = 3,
) {
  for (let i = 1; i <= posts; i++) await pastSend(channel, member, { opened: at(hour, i * 7) });
}

async function start(
  dispatch: DispatchRow,
  queue: Parameters<typeof startBroadcast>[1],
  options: { bestTime?: boolean; features?: SendFeatures; now?: number } = {},
) {
  return startBroadcast(env.DB, queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
    features: options.features ?? ON,
    bestTime: options.bestTime ?? true,
    now: options.now ?? START,
  });
}

const broadcast = async (id: string) =>
  (await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?1').bind(id).first<BroadcastRow>())!;
const recipient = (broadcastId: string, memberId: string) =>
  env.DB.prepare(
    'SELECT status, held, send_after FROM broadcast_recipients WHERE broadcast_id = ?1 AND member_id = ?2',
  )
    .bind(broadcastId, memberId)
    .first<{ status: string; held: number; send_after: number | null }>();

/** Three readers, each with a different history, on a finished warm-up. */
async function world(sendNowClock = START) {
  const channel = await seedChannel({ members: 3 });
  await completeRamp(channel.channelId);
  const [regular, newcomer, hidden] = await members(channel.channelId);
  // Reads at 14:00 UTC.
  await habit(channel, regular!, 14);
  // Two posts is too few.
  await habit(channel, newcomer!, 16, 2);
  // Machines open everything; no person has ever been seen.
  for (let i = 1; i <= 5; i++) await pastSend(channel, hidden!, { machine: at(3, i * 7) });
  const clock = { now: sendNowClock };
  const mail = new CaptureMail();
  const { ctx, queue } = context(mail, () => clock.now);
  return {
    channel,
    regular: regular!,
    newcomer: newcomer!,
    hidden: hidden!,
    clock,
    mail,
    ctx,
    queue,
  };
}

describe('working out an hour', () => {
  it('takes the hour with the most, the earliest on a tie', () => {
    expect(
      bestHour(
        new Map([
          [14, 3],
          [9, 1],
        ]),
      ),
    ).toEqual({ hour: 14, samples: 4 });
    expect(
      bestHour(
        new Map([
          [14, 2],
          [9, 2],
        ]),
      ),
    ).toEqual({ hour: 9, samples: 4 });
  });

  it('places a slot inside the 24 hours from the start', () => {
    expect(slotFor(START, 14)).toBe(Date.UTC(2026, 10, 3, 14, 0));
    // Earlier in the day means tomorrow, before the window ends.
    expect(slotFor(START, 8)).toBe(Date.UTC(2026, 10, 4, 8, 0));
    expect(slotFor(START, 8)).toBeLessThan(START + DAY);
    // Their hour now: straight away.
    expect(slotFor(START, 9)).toBe(START);
    for (let hour = 0; hour < 24; hour++) {
      const slot = slotFor(START, hour);
      expect(slot).toBeGreaterThanOrEqual(START);
      expect(slot).toBeLessThan(START + DAY);
      expect(new Date(slot).getUTCHours()).toBe(hour);
    }
  });

  it('reads a warm-up limit, ignoring yesterday’s use', () => {
    const ramp = { status: 'warming' as const, day: '2026-11-03', cap_today: 100, sent_today: 90 };
    expect(fitsWarmUp(ramp, 10, START)).toBe(true);
    expect(fitsWarmUp(ramp, 11, START)).toBe(false);
    expect(fitsWarmUp({ ...ramp, day: '2026-11-02' }, 100, START)).toBe(true);
    expect(fitsWarmUp({ ...ramp, status: 'complete' }, 1_000_000, START)).toBe(true);
  });
});

describe('a send at each reader’s best time', () => {
  it('holds a regular reader for their hour and sends the others at the chosen time', async () => {
    const { channel, regular, newcomer, hidden, clock, mail, ctx, queue } = await world();
    const dispatch = await seedDispatch(channel.channelId);
    const { broadcastId } = await start(dispatch, queue);

    await drain(ctx, queue);

    // Only people count: the stored hour is UTC, and only for someone with enough history.
    const stored = await env.DB.prepare(
      'SELECT member_id, best_hour_utc, samples FROM member_send_hours WHERE channel_id = ?1',
    )
      .bind(channel.channelId)
      .all();
    expect(stored.results).toEqual([{ member_id: regular.id, best_hour_utc: 14, samples: 3 }]);

    const slot = Date.UTC(2026, 10, 3, 14, 0);
    expect(await recipient(broadcastId, regular.id)).toEqual({
      status: 'pending',
      held: 1,
      send_after: slot,
    });
    expect(await recipient(broadcastId, newcomer.id)).toMatchObject({
      status: 'sent',
      send_after: null,
    });
    expect(await recipient(broadcastId, hidden.id)).toMatchObject({
      status: 'sent',
      send_after: null,
    });
    expect(mail.sent.map((m) => m.to).sort()).toEqual([newcomer.email, hidden.email].sort());

    // The send stays open, and the report has its counts.
    let row = await broadcast(broadcastId);
    expect(row.status).toBe('sending');
    expect(toBroadcast(row).bestTime).toEqual({
      personal: 1,
      chosenTime: 2,
      limitedByWarmUp: false,
    });
    expect(row).toMatchObject({ recipient_count: 3, sent_count: 2, failed_count: 0 });

    // Not yet.
    clock.now = slot - 60_000;
    expect(await releaseBestTimeSlots(ctx)).toEqual([]);

    // Its hour.
    clock.now = slot;
    expect(await releaseBestTimeSlots(ctx)).toEqual([broadcastId]);
    await drain(ctx, queue);
    expect(mail.sent.map((m) => m.to)).toContain(regular.email);
    row = await broadcast(broadcastId);
    expect(row).toMatchObject({ status: 'sent', sent_count: 3, failed_count: 0 });
    // The report keeps saying who got what.
    expect(toBroadcast(row).bestTime).toMatchObject({ personal: 1, chosenTime: 2 });
    // Nothing more to do on the next minute.
    clock.now = slot + 60_000;
    expect(await releaseBestTimeSlots(ctx)).toEqual([]);
  });

  it('is off unless asked for, and a normal send is exactly as before', async () => {
    const { channel, regular, mail, ctx, queue } = await world();
    const dispatch = await seedDispatch(channel.channelId);
    const { broadcastId } = await start(dispatch, queue, { bestTime: false });
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(3);
    const row = await broadcast(broadcastId);
    expect(row).toMatchObject({ status: 'sent', best_time: 0, personal_time_count: 0 });
    expect(toBroadcast(row).bestTime).toBeNull();
    expect(await recipient(broadcastId, regular.id)).toMatchObject({ send_after: null, held: 0 });
    expect(
      await count(
        'SELECT count(*) AS n FROM member_send_hours WHERE channel_id = ?1',
        channel.channelId,
      ),
    ).toBe(0);
  });

  it('goes as a normal send while the flag is off', async () => {
    const { channel, mail, ctx, queue } = await world();
    const dispatch = await seedDispatch(channel.channelId);
    const { broadcastId } = await start(dispatch, queue, { features: {} });
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(3);
    expect(await broadcast(broadcastId)).toMatchObject({ status: 'sent', best_time: 0 });
  });

  it('sends straight away when the reader’s hour is the chosen hour, and counts it as personal', async () => {
    const { channel, regular, mail, ctx, queue } = await world();
    await env.DB.prepare('DELETE FROM deliveries WHERE member_id = ?1').bind(regular.id).run();
    await habit(channel, regular, 9);
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(3);
    const row = await broadcast(broadcastId);
    expect(row.status).toBe('sent');
    expect(toBroadcast(row).bestTime).toMatchObject({ personal: 1, chosenTime: 2 });
    expect(await recipient(broadcastId, regular.id)).toEqual({
      status: 'sent',
      held: 0,
      send_after: START,
    });
  });

  it('counts a first-time click, and only history from the last 90 days', async () => {
    const channel = await seedChannel({ members: 2 });
    await completeRamp(channel.channelId);
    const [clicker, old] = await members(channel.channelId);
    for (let i = 1; i <= 3; i++) await pastSend(channel, clicker!, { clicked: at(20, i * 7) });
    for (let i = 1; i <= 3; i++) await pastSend(channel, old!, { opened: at(20, 100 + i) });
    const { ctx, queue } = context(new CaptureMail(), () => START);
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    expect((await recipient(broadcastId, clicker!.id))?.send_after).toBe(
      Date.UTC(2026, 10, 3, 20, 0),
    );
    expect((await recipient(broadcastId, old!.id))?.send_after).toBeNull();
  });

  it('skips a held reader who leaves before their hour', async () => {
    const { channel, regular, clock, mail, ctx, queue } = await world();
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    await env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`)
      .bind(regular.id)
      .run();
    clock.now = Date.UTC(2026, 10, 3, 14, 0);
    await releaseBestTimeSlots(ctx);
    await drain(ctx, queue);
    expect(mail.sent.map((m) => m.to)).not.toContain(regular.email);
    expect(await broadcast(broadcastId)).toMatchObject({
      status: 'sent',
      sent_count: 2,
      recipient_count: 2,
    });
  });

  it('sends no one held when the send is stopped', async () => {
    const { channel, regular, clock, mail, ctx, queue } = await world();
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    const before = mail.sent.length;
    expect(await cancelBroadcast(env.DB, broadcastId, START + 1000)).toBe(true);
    expect((await recipient(broadcastId, regular.id))?.status).toBe('skipped');
    clock.now = Date.UTC(2026, 10, 3, 14, 0);
    expect(await releaseBestTimeSlots(ctx)).toEqual([]);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(before);
    expect((await broadcast(broadcastId)).status).toBe('canceled');
  });

  it('regression: releases no held reader once the Channel is deleted', async () => {
    const { channel, regular, clock, mail, ctx, queue } = await world();
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    const before = mail.sent.length;
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(START + 1000, channel.channelId)
      .run();
    clock.now = Date.UTC(2026, 10, 3, 14, 0);
    expect(await releaseBestTimeSlots(ctx)).toEqual([]);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(before);
    expect((await recipient(broadcastId, regular.id))?.status).toBe('skipped');
    expect((await broadcast(broadcastId)).status).toBe('canceled');
  });

  it('survives the reaper while readers wait for their hour', async () => {
    const { reap } = await import('@swarm/engine');
    const { channel, clock, mail, ctx, queue } = await world();
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    const sent = mail.sent.length;
    // Hours later, with nothing happening: normal for this send.
    clock.now = START + 2 * HOUR;
    expect(await reap(ctx)).toContain(broadcastId);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(sent);
    expect((await broadcast(broadcastId)).status).toBe('sending');
  });

  it('survives a lost fan-out after a release', async () => {
    const { reap } = await import('@swarm/engine');
    const { channel, regular, clock, mail, ctx, queue } = await world();
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    clock.now = Date.UTC(2026, 10, 3, 14, 0);
    await releaseBestTimeSlots(ctx);
    queue.items.length = 0;
    clock.now += 20 * 60_000;
    await reap(ctx);
    await drain(ctx, queue);
    expect(mail.sent.map((m) => m.to)).toContain(regular.email);
    expect((await broadcast(broadcastId)).status).toBe('sent');
  });
});

describe('with other sending rules', () => {
  it('refuses a split test or cohort sample, and says why', async () => {
    const { channel, queue } = await world();
    const dispatch = await seedDispatch(channel.channelId);
    await env.DB.prepare(
      `INSERT INTO cohort_samples (id, channel_id, dispatch_id, sample_percent, window_minutes, max_bounce_rate, max_complaint_rate, max_unsubscribe_rate, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 20, 60, 0.1, 0.1, 0.1, 'draft', 0, 0)`,
    )
      .bind(newId('cohortSample'), channel.channelId, dispatch.id)
      .run();
    const features = { ...ON, cohortSampling: true };
    const error = await start(dispatch, queue, { features }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartError);
    expect((error as StartError).checks[0]?.message).toContain('can’t run with a split test');
    expect(
      await count('SELECT count(*) AS n FROM broadcasts WHERE dispatch_id = ?1', dispatch.id),
    ).toBe(0);

    const check = await preflight(env.DB, config, dispatch, {
      allowHtmlBlocks: false,
      features,
    });
    expect(check.ready).toBe(true);
    expect(check.bestTime).toMatchObject({ available: false });
    expect(check.bestTime?.reason).toContain('can’t run with a split test');
    // The same send without the choice still goes.
    await start(dispatch, queue, { features, bestTime: false });
  });

  it('says nothing about it to a preflight while the flag is off', async () => {
    const { channel } = await world();
    const check = await preflight(env.DB, config, await seedDispatch(channel.channelId), {
      allowHtmlBlocks: false,
    });
    expect(check.bestTime).toBeNull();
  });

  it('keeps warm-up order and sends everyone at the chosen time when the limit can’t reach them', async () => {
    // The shared domain starts at 100 a day.
    const channel = await seedChannel({ members: 101 });
    const [regular] = await members(channel.channelId);
    await habit(channel, regular!, 14);
    const mail = new CaptureMail();
    const { ctx, queue } = context(mail, () => START);
    const dispatch = await seedDispatch(channel.channelId);
    const check = await preflight(env.DB, config, dispatch, {
      allowHtmlBlocks: false,
      features: ON,
    });
    expect(check.bestTime?.note).toContain('warm-up limit');
    const { broadcastId } = await start(dispatch, queue);
    await drain(ctx, queue, { stopAtDelay: true });
    const row = await broadcast(broadcastId);
    expect(row.best_time).toBe(2);
    expect(toBroadcast(row).bestTime).toEqual({
      personal: 0,
      chosenTime: 101,
      limitedByWarmUp: true,
    });
    // The engaged reader is first through the limit, and is not held for 14:00.
    expect(await recipient(broadcastId, regular!.id)).toMatchObject({
      status: 'sent',
      send_after: null,
      held: 0,
    });
    expect(mail.sent).toHaveLength(100);
    expect(
      await count(
        'SELECT count(*) AS n FROM member_send_hours WHERE channel_id = ?1',
        channel.channelId,
      ),
    ).toBe(0);
  });

  it('gives personal times while warming when the limit reaches everyone, and counts them when they go', async () => {
    const channel = await seedChannel({ members: 2 });
    const [regular, other] = await members(channel.channelId);
    await habit(channel, regular!, 14);
    const clock = { now: START };
    const mail = new CaptureMail();
    const { ctx, queue } = context(mail, () => clock.now);
    const { broadcastId } = await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    const row = await broadcast(broadcastId);
    expect(row.best_time).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual([other!.email]);
    const sentToday = () =>
      env.DB.prepare('SELECT sent_today FROM reputation_ramps WHERE id = ?1')
        .bind(row.ramp_id)
        .first<number>('sent_today');
    // The daily limit is only spent as each reader really goes.
    expect(await sentToday()).toBe(1);
    clock.now = Date.UTC(2026, 10, 3, 14, 0);
    await releaseBestTimeSlots(ctx);
    await drain(ctx, queue);
    expect(await sentToday()).toBe(2);
    expect((await broadcast(broadcastId)).status).toBe('sent');
  });
});

describe('scheduling', () => {
  const sendEnv = () =>
    parseSendEnv({
      ...env,
      ENVIRONMENT: 'development',
      TRACK_ORIGIN: 'https://link.swarm.test',
      PLATFORM_MAIL_DOMAIN: 'mail.swarm.test',
      UNSUBSCRIBE_MAIL_DOMAIN: 'unsubscribe.swarm.test',
      MEDIA_ORIGIN: 'https://media.swarm.test',
      CAPTURE_ORIGIN: 'https://forms.swarm.test',
      MAIL_ADAPTER: 'dev',
      DNS_RESOLVER: 'dev',
      LINK_HOSTNAMES: 'dev',
    });

  const enable = (channelId: string, workspaceId: string) =>
    Promise.all([
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'best_time_send', 'channel', ?2, 1, 0)`,
      )
        .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
        .run(),
      env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`),
    ]);

  async function due(channelId: string, bestTime: number) {
    const dispatch = await seedDispatch(channelId, { status: 'scheduled', publish_at: START - 1 });
    await env.DB.prepare('UPDATE dispatches SET best_time = ?1 WHERE id = ?2')
      .bind(bestTime, dispatch.id)
      .run();
    return dispatch.id;
  }

  it('carries the choice from a scheduled post to its send, and clears it', async () => {
    const { channel } = await world();
    await enable(channel.channelId, channel.workspaceId);
    const id = await due(channel.channelId, 1);
    const [broadcastId] = await startDue(sendEnv(), START);
    expect(
      await env.DB.prepare('SELECT dispatch_id, best_time FROM broadcasts WHERE id = ?1')
        .bind(broadcastId)
        .first(),
    ).toEqual({ dispatch_id: id, best_time: 1 });
    expect(
      await env.DB.prepare('SELECT status, best_time FROM dispatches WHERE id = ?1')
        .bind(id)
        .first(),
    ).toEqual({ status: 'sending', best_time: 0 });
  });

  it('goes as a normal send when the flag was turned off meanwhile', async () => {
    const { channel } = await world();
    const id = await due(channel.channelId, 1);
    const [broadcastId] = await startDue(sendEnv(), START);
    expect(
      await env.DB.prepare('SELECT dispatch_id, best_time FROM broadcasts WHERE id = ?1')
        .bind(broadcastId)
        .first(),
    ).toEqual({ dispatch_id: id, best_time: 0 });
  });

  it('regression: starts nothing for a deleted Channel', async () => {
    const channel = await seedChannel({ members: 1 });
    await completeRamp(channel.channelId);
    const dispatch = await seedDispatch(channel.channelId, {
      status: 'scheduled',
      publish_at: START - 1,
    });
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(START, channel.channelId)
      .run();
    expect(await startDue(sendEnv(), START)).toEqual([]);
    expect(
      await count('SELECT COUNT(*) AS n FROM broadcasts WHERE dispatch_id = ?1', dispatch.id),
    ).toBe(0);
    expect(
      await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1').bind(dispatch.id).first(),
    ).toEqual({ status: 'scheduled' });
  });
});

describe('the stored hour', () => {
  it('is dropped 90 days after a send last worked it out', async () => {
    const { channel, regular, ctx, queue } = await world();
    await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    const stored = () =>
      count('SELECT count(*) AS n FROM member_send_hours WHERE member_id = ?1', regular.id);
    await pruneMemberSendHours(env.DB, START + 89 * DAY);
    expect(await stored()).toBe(1);
    await pruneMemberSendHours(env.DB, START + 91 * DAY);
    expect(await stored()).toBe(0);
  });

  it('goes when the history falls too low', async () => {
    const { channel, regular, ctx, queue } = await world();
    await start(await seedDispatch(channel.channelId), queue);
    await drain(ctx, queue);
    await env.DB.prepare('DELETE FROM deliveries WHERE member_id = ?1 AND sent_at < ?2')
      .bind(regular.id, START)
      .run();
    const { queue: next, ctx: nextCtx } = context(new CaptureMail(), () => START + DAY);
    await start(await seedDispatch(channel.channelId), next, { now: START + DAY });
    await drain(nextCtx, next);
    expect(
      await count('SELECT count(*) AS n FROM member_send_hours WHERE member_id = ?1', regular.id),
    ).toBe(0);
  });
});
