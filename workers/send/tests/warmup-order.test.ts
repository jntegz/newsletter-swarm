// During warm-up the daily cap only reaches some readers, so it should reach the engaged ones.
import { env } from 'cloudflare:test';
import { decideCohortSample, reap, startBroadcast } from '@swarm/engine';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  broadcastRow,
  CaptureMail,
  completeRamp,
  config,
  context,
  drain,
  seedChannel,
  seedDispatch,
} from './harness';

const DAY = 86_400_000;
const FIRST_DAY = Date.parse('2026-10-27T09:00:00Z');
const NEXT_DAY = Date.parse('2026-10-28T00:05:00Z');
/** The shared platform domain starts at 100 a day. */
const CAP = 100;

async function memberIds(channelId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, email FROM members WHERE channel_id = ?1 ORDER BY id',
  )
    .bind(channelId)
    .all<{ id: string; email: string }>();
  return results;
}

async function score(
  members: { id: string }[],
  channelId: string,
  band: string,
  computedAt: number,
) {
  await env.DB.batch(
    members.map((member) =>
      env.DB.prepare(
        `INSERT INTO member_engagement (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, computed_at)
         VALUES (?1, ?2, ?3, ?4, 10, 1, 0, ?5)`,
      ).bind(member.id, channelId, band === 'cold' ? 1 : 80, band, computedAt),
    ),
  );
}

/** A past Broadcast that these Members opened (a person, not a mail scanner), on the given day. */
async function opened(
  members: { id: string; email: string }[],
  workspaceId: string,
  channelId: string,
  at: number,
) {
  const dispatch = newId('dispatch');
  const broadcast = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(broadcast, dispatch, channelId, workspaceId, at),
    ...members.map((member) =>
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, human_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?6)`,
      ).bind(newId('delivery'), broadcast, channelId, member.id, member.email, at),
    ),
  ]);
}

async function begin(channelId: string, clock: { now: number }) {
  const run = context(new CaptureMail(), () => clock.now);
  const dispatch = await seedDispatch(channelId);
  const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
    now: clock.now,
  });
  return { ...run, broadcastId, dispatch };
}

describe('sending order during warm-up', () => {
  it('reaches engaged readers first and cold readers last, and everyone exactly once', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    const cold = members.slice(0, 30);
    const engaged = members.slice(-30);
    await score(cold, channelId, 'cold', FIRST_DAY - DAY);
    await score(engaged, channelId, 'very_engaged', FIRST_DAY - DAY);
    const clock = { now: FIRST_DAY };
    const run = await begin(channelId, clock);

    const first = await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(CAP);
    const today = new Set(run.mail.sent.map((mail) => mail.to));
    for (const member of engaged) expect(today.has(member.email), member.email).toBe(true);
    for (const member of cold) expect(today.has(member.email), member.email).toBe(false);

    clock.now = NEXT_DAY;
    run.queue.items.push({ body: first.delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(180);
    expect(new Set(run.mail.sent.map((mail) => mail.to)).size).toBe(180);
    expect((await broadcastRow(run.broadcastId))?.status).toBe('sent');
  });

  it('uses opens from the last 90 days when there are no scores', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    const recent = members.slice(-20);
    const longAgo = members.slice(-40, -20);
    await opened(recent, workspaceId, channelId, FIRST_DAY - 30 * DAY);
    await opened(longAgo, workspaceId, channelId, FIRST_DAY - 120 * DAY);
    const run = await begin(channelId, { now: FIRST_DAY });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    const today = new Set(run.mail.sent.map((mail) => mail.to));
    for (const member of recent) expect(today.has(member.email), member.email).toBe(true);
    for (const member of longAgo) expect(today.has(member.email), member.email).toBe(false);
  });

  it('ignores scores gone stale, such as after the feature was switched off', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    await score(members.slice(-30), channelId, 'very_engaged', FIRST_DAY - 30 * DAY);
    await score(members.slice(0, 30), channelId, 'cold', FIRST_DAY - 30 * DAY);
    const run = await begin(channelId, { now: FIRST_DAY });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    const expected = members.slice(0, CAP).map((member) => member.email);
    expect(new Set(run.mail.sent.map((mail) => mail.to))).toEqual(new Set(expected));
  });

  it('sends in the usual order with no engagement data at all', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    const run = await begin(channelId, { now: FIRST_DAY });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    const expected = members.slice(0, CAP).map((member) => member.email);
    expect(new Set(run.mail.sent.map((mail) => mail.to))).toEqual(new Set(expected));
  });

  it('leaves a Broadcast alone once warm-up is over', async () => {
    const { channelId } = await seedChannel({ members: 12 });
    await completeRamp(channelId);
    const members = await memberIds(channelId);
    await score(members.slice(-2), channelId, 'very_engaged', Date.now());
    await score(members.slice(0, 2), channelId, 'cold', Date.now());
    const clock = { now: Date.now() };
    const run = await begin(channelId, clock);
    await drain(run.ctx, run.queue);
    expect(run.mail.sent).toHaveLength(12);
    const row = await env.DB.prepare('SELECT fanout_tier FROM broadcasts WHERE id = ?1')
      .bind(run.broadcastId)
      .first<{ fanout_tier: number | null }>();
    expect(row?.fanout_tier).toBeNull();
  });
});

describe('recovering a Broadcast walking its tiers', () => {
  const stuck = (broadcastId: string, at: number) =>
    env.DB.prepare('UPDATE broadcasts SET last_progress_at = ?1, resume_at = NULL WHERE id = ?2')
      .bind(at - 3_600_000, broadcastId)
      .run();

  it('never lets the reaper go over the day’s cap', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    // Cold readers with low ids are the ones a plain `member_id <= cursor` would hand out.
    await score(members.slice(0, 30), channelId, 'cold', FIRST_DAY - DAY);
    await score(members.slice(-30), channelId, 'very_engaged', FIRST_DAY - DAY);
    const clock = { now: FIRST_DAY };
    const run = await begin(channelId, clock);
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(CAP);

    clock.now = FIRST_DAY + 3_600_000;
    await stuck(run.broadcastId, clock.now);
    expect(await reap(run.ctx)).toContain(run.broadcastId);
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(CAP);
    const cold = new Set(members.slice(0, 30).map((member) => member.email));
    expect(run.mail.sent.filter((mail) => cold.has(mail.to))).toEqual([]);
  });

  it('finishes after losing a message partway through', async () => {
    const { channelId } = await seedChannel({ members: 60 });
    const members = await memberIds(channelId);
    await score(members.slice(0, 10), channelId, 'cold', FIRST_DAY - DAY);
    await score(members.slice(-10), channelId, 'engaged', FIRST_DAY - DAY);
    const clock = { now: FIRST_DAY };
    const run = await begin(channelId, clock);
    // Everything up to the first batches, then the queue loses whatever is left.
    await drain(run.ctx, run.queue, { maxSteps: 10_000, filter: (_body, step) => step < 4 });
    expect(run.queue.items).toHaveLength(0);
    expect(run.mail.sent.length).toBeLessThan(60);

    clock.now = FIRST_DAY + 3_600_000;
    await stuck(run.broadcastId, clock.now);
    await reap(run.ctx);
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(new Set(run.mail.sent.map((mail) => mail.to)).size).toBe(60);
    expect(run.mail.sent).toHaveLength(60);
    expect((await broadcastRow(run.broadcastId))?.status).toBe('sent');
  });

  it('keeps going when the Member at the cursor is erased', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    const members = await memberIds(channelId);
    await score(members.slice(-10), channelId, 'engaged', FIRST_DAY - DAY);
    const clock = { now: FIRST_DAY };
    const run = await begin(channelId, clock);
    const first = await drain(run.ctx, run.queue, { stopAtDelay: true });
    const row = await env.DB.prepare('SELECT fanout_cursor FROM broadcasts WHERE id = ?1')
      .bind(run.broadcastId)
      .first<{ fanout_cursor: string }>();
    // What the erasure in privacy.ts does: the row goes, and the cursor moves to the one below.
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM broadcast_recipients WHERE broadcast_id = ?1 AND member_id = ?2',
      ).bind(run.broadcastId, row?.fanout_cursor),
      env.DB.prepare('UPDATE broadcasts SET fanout_cursor = ?1 WHERE id = ?2').bind(
        `${row?.fanout_cursor.slice(0, -1)}!`,
        run.broadcastId,
      ),
    ]);
    clock.now = NEXT_DAY;
    run.queue.items.push({ body: first.delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect((await broadcastRow(run.broadcastId))?.status).toBe('sent');
    expect(new Set(run.mail.sent.map((mail) => mail.to)).size).toBe(run.mail.sent.length);
  });
});

describe('a Cohort Sample during warm-up', () => {
  it('releases held readers from the first tier again, without double sends', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 80 });
    const members = await memberIds(channelId);
    await score(members.slice(0, 10), channelId, 'cold', Date.now() - DAY);
    await score(members.slice(-10), channelId, 'very_engaged', Date.now() - DAY);
    const operator = newId('operator');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, 'Owner', 0, 0)`,
      ).bind(operator, `owner-${operator}@team.example`),
      env.DB.prepare(
        `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', 0, 0)`,
      ).bind(newId('seat'), workspaceId, operator),
    ]);
    const dispatch = await seedDispatch(channelId);
    const sampleId = newId('cohortSample');
    await env.DB.prepare(
      `INSERT INTO cohort_samples (id, channel_id, dispatch_id, sample_percent, window_minutes, min_open_rate,
         max_bounce_rate, max_complaint_rate, max_unsubscribe_rate, created_at, updated_at)
       VALUES (?1, ?2, ?3, 25, 60, NULL, 0.05, 0.001, 0.02, 0, 0)`,
    )
      .bind(sampleId, channelId, dispatch.id)
      .run();
    const run = context();
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
      features: { splitTests: false, cohortSampling: true, smartBlocks: false },
    });
    await drain(run.ctx, run.queue);
    const sampled = run.mail.sent.length;
    expect(sampled).toBeLessThan(40);

    const jobs = { DB: env.DB, SEND_QUEUE: run.queue };
    const hour = 3_600_000;
    expect(await decideCohortSample(jobs, sampleId, Date.now() + 2 * hour)).toBe('extended');
    const released = await env.DB.prepare(
      'SELECT fanout_tier, fanout_cursor FROM broadcasts WHERE id = ?1',
    )
      .bind(broadcastId)
      .first<{ fanout_tier: number; fanout_cursor: string | null }>();
    expect(released).toEqual({ fanout_tier: 1, fanout_cursor: null });

    await drain(run.ctx, run.queue);
    expect(run.mail.sent).toHaveLength(80);
    expect(new Set(run.mail.sent.map((mail) => mail.to)).size).toBe(80);
  });
});
