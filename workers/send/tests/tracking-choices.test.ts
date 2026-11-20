// Tracking choices in the send pipeline (docs/privacy-controls.md): the publication's switches,
// checked again at each batch, and a subscriber's own "don't track my opens and clicks".
import { env } from 'cloudflare:test';
import { broadcastStats, startBroadcast } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import {
  completeRamp,
  config,
  context,
  drain,
  seedChannel,
  seedDispatch,
  type MemoryQueue,
} from './harness';

async function start(channelId: string, queue: MemoryQueue) {
  const dispatch = await seedDispatch(channelId);
  return startBroadcast(env.DB, queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
}

const setSettings = (channelId: string, settings: Record<string, unknown>) =>
  env.DB.prepare('UPDATE channels SET settings_json = ?1 WHERE id = ?2')
    .bind(JSON.stringify(settings), channelId)
    .run();

describe('tracking choices when sending', () => {
  it('sends plain links, still with a pixel, when click tracking is off', async () => {
    const { channelId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    await setSettings(channelId, { trackClicks: false });
    const run = context();
    const { broadcastId } = await start(channelId, run.queue);
    await drain(run.ctx, run.queue);
    const html = run.mail.sent[0]!.html;
    expect(html).toContain('href="https://essay.example/1"');
    expect(html).not.toContain('/c/');
    expect(html).toContain('/o/');
    // The unsubscribe link is not tracking and stays.
    expect(html).toContain('https://link.swarm.test/u/');
    const row = await env.DB.prepare('SELECT track_clicks FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ track_clicks: number }>();
    expect(row?.track_clicks).toBe(0);
    const stats = await broadcastStats(env.DB, broadcastId);
    expect(stats.tracking).toEqual({ opens: true, clicks: false, untracked: 0 });
  });

  it('applies a switch turned off after the send started', async () => {
    const { channelId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    const run = context();
    await start(channelId, run.queue);
    await setSettings(channelId, { trackOpens: false, trackClicks: false });
    await drain(run.ctx, run.queue);
    const html = run.mail.sent[0]!.html;
    expect(html).not.toContain('/o/');
    expect(html).not.toContain('/c/');
  });

  it("sends at the chosen time when the publication doesn't profile its readers", async () => {
    const { channelId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    await setSettings(channelId, { profileReaders: false });
    const run = context();
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch: await seedDispatch(channelId),
      operatorId: null,
      allowHtmlBlocks: false,
      features: { bestTime: true },
      bestTime: true,
    });
    const row = await env.DB.prepare('SELECT best_time FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ best_time: number }>();
    expect(row?.best_time).toBe(0);
  });

  it('sends a subscriber who asked not to be tracked no pixel and plain links', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    await completeRamp(channelId);
    const members = await env.DB.prepare(
      'SELECT id, email FROM members WHERE channel_id = ?1 ORDER BY id',
    )
      .bind(channelId)
      .all<{ id: string; email: string }>();
    const [asked, other] = members.results;
    await env.DB.prepare('UPDATE members SET tracking_opt_out_at = ?1 WHERE id = ?2')
      .bind(Date.now(), asked!.id)
      .run();
    const run = context();
    const { broadcastId } = await start(channelId, run.queue);
    await drain(run.ctx, run.queue);

    const theirs = run.mail.sent.find((mail) => mail.to === asked!.email)!;
    expect(theirs.html).not.toContain('/o/');
    expect(theirs.html).not.toContain('/c/');
    expect(theirs.html).toContain('href="https://essay.example/1"');
    expect(theirs.html).toContain('https://link.swarm.test/u/');
    const others = run.mail.sent.find((mail) => mail.to === other!.email)!;
    expect(others.html).toContain('/o/');
    expect(others.html).toContain('/c/');

    const rows = await env.DB.prepare(
      'SELECT member_id, tracked FROM deliveries WHERE broadcast_id = ?1',
    )
      .bind(broadcastId)
      .all<{ member_id: string; tracked: number }>();
    const tracked = Object.fromEntries(rows.results.map((r) => [r.member_id, r.tracked]));
    expect(tracked).toEqual({ [asked!.id]: 0, [other!.id]: 1 });

    // The open rate is over the emails that could show an open.
    await env.DB.prepare(
      'UPDATE deliveries SET opened_at = ?1, human_opened_at = ?1 WHERE broadcast_id = ?2 AND member_id = ?3',
    )
      .bind(Date.now(), broadcastId, other!.id)
      .run();
    const stats = await broadcastStats(env.DB, broadcastId);
    expect(stats.delivered).toBe(2);
    expect(stats.humanOpens).toBe(1);
    expect(stats.openRate).toBe(1);
    expect(stats.tracking.untracked).toBe(1);
  });
});
