// Targeted sends: the preflight count, the snapshot and the Circles a Dispatch is addressed to.
import { env } from 'cloudflare:test';
import type { CircleRule, DispatchAudience } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { preflight, startBroadcast, StartError } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import {
  broadcastRow,
  completeRamp,
  config,
  context,
  drain,
  seedChannel,
  seedDispatch,
} from './harness';

async function addCircle(channelId: string, rule: CircleRule) {
  const channel = await env.DB.prepare('SELECT workspace_id FROM channels WHERE id = ?1')
    .bind(channelId)
    .first<{ workspace_id: string }>();
  const id = newId('circle');
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Circle', ?4, 0, 0)`,
  )
    .bind(id, channel!.workspace_id, channelId, JSON.stringify(rule))
    .run();
  return id;
}

async function tag(channelId: string, name: string, memberIds: string[]) {
  const tagId = newId('tag');
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, 0)',
    ).bind(tagId, channelId, name),
    ...memberIds.map((id) =>
      env.DB.prepare(
        'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
      ).bind(id, tagId),
    ),
  ]);
}

async function memberIds(channelId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM members WHERE channel_id = ?1 ORDER BY id',
  )
    .bind(channelId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function addressed(channelId: string, audience: DispatchAudience) {
  const dispatch = await seedDispatch(channelId);
  await env.DB.prepare('UPDATE dispatches SET audience_json = ?1 WHERE id = ?2')
    .bind(JSON.stringify(audience), dispatch.id)
    .run();
  return { ...dispatch, audience_json: JSON.stringify(audience) };
}

/** Preflight, send, and return the preflight count with who actually received it. */
async function send(channelId: string, audience: DispatchAudience) {
  const dispatch = await addressed(channelId, audience);
  const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
  const run = context();
  const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  await drain(run.ctx, run.queue);
  const { results } = await env.DB.prepare(
    'SELECT member_id FROM broadcast_recipients WHERE broadcast_id = ?1 ORDER BY member_id',
  )
    .bind(broadcastId)
    .all<{ member_id: string }>();
  return {
    check,
    broadcastId,
    recipients: results.map((r) => r.member_id),
    mailed: run.mail.sent.length,
  };
}

describe('targeted sends', () => {
  it('sends only to Members in an included Circle, and counts them exactly', async () => {
    const { channelId } = await seedChannel({ members: 1500 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    const vips = ids.filter((_, i) => i % 3 === 0);
    await tag(channelId, 'VIP', vips);
    const circle = await addCircle(channelId, { field: 'tag', cmp: 'eq', value: 'vip' });

    const result = await send(channelId, { include: [circle], exclude: [] });
    expect(result.check.recipientCount).toBe(vips.length);
    expect(result.check.checks.find((c) => c.key === 'audience')?.message).toMatch(
      /500 subscribers in this audience/,
    );
    expect(result.recipients).toEqual(vips);
    expect(result.mailed).toBe(vips.length);
    expect(await broadcastRow(result.broadcastId)).toMatchObject({
      status: 'sent',
      recipient_count: vips.length,
    });
  });

  it('excludes Circles, dedupes overlapping ones, and leaves out suppressed and inactive Members', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 1200 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    // Two overlapping include Circles (even first names, tagged beta) and one exclusion.
    const beta = ids.filter((_, i) => i % 4 === 0 || i % 5 === 0);
    await tag(channelId, 'beta', beta);
    const adas = await addCircle(channelId, { field: 'first_name', cmp: 'eq', value: 'ada' });
    const betas = await addCircle(channelId, { field: 'tag', cmp: 'eq', value: 'beta' });
    const blocked = ids.filter((_, i) => i % 7 === 0);
    await tag(channelId, 'blocked', blocked);
    const exclude = await addCircle(channelId, { field: 'tag', cmp: 'eq', value: 'blocked' });

    const { results: rows } = await env.DB.prepare(
      'SELECT id, email, first_name FROM members WHERE channel_id = ?1 ORDER BY id',
    )
      .bind(channelId)
      .all<{ id: string; email: string; first_name: string | null }>();
    const suppressed = rows.find((r) => r.first_name === 'Ada' && !blocked.includes(r.id))!;
    const inactive = rows.find(
      (r) => beta.includes(r.id) && r.id !== suppressed.id && !blocked.includes(r.id),
    )!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', 0)`,
      ).bind(newId('suppression'), workspaceId, suppressed.email.toUpperCase()),
      env.DB.prepare(`UPDATE members SET status = 'paused' WHERE id = ?1`).bind(inactive.id),
    ]);

    const want = rows
      .filter((r) => r.first_name === 'Ada' || beta.includes(r.id))
      .filter((r) => !blocked.includes(r.id))
      .filter((r) => r.id !== suppressed.id && r.id !== inactive.id)
      .map((r) => r.id);

    const result = await send(channelId, { include: [adas, betas], exclude: [exclude] });
    expect(result.recipients).toEqual(want);
    expect(new Set(result.recipients).size).toBe(result.recipients.length);
    expect(result.check.recipientCount).toBe(want.length);
    expect(result.mailed).toBe(want.length);
  });

  it('sends to everyone except an excluded Circle', async () => {
    const { channelId } = await seedChannel({ members: 300 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    const out = await addCircle(channelId, { field: 'first_name', cmp: 'is_set' });
    const result = await send(channelId, { include: [], exclude: [out] });
    // addMembers gives every second Member a first name.
    expect(result.recipients).toEqual(ids.filter((_, i) => i % 2 === 0));
    expect(result.check.recipientCount).toBe(150);
  });

  it('freezes the rules at start, so editing a Circle mid-send changes nothing', async () => {
    const { channelId } = await seedChannel({ members: 2100 });
    await completeRamp(channelId);
    const circle = await addCircle(channelId, { field: 'first_name', cmp: 'eq', value: 'Ada' });
    const dispatch = await addressed(channelId, { include: [circle], exclude: [] });
    const run = context();
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
    });
    // The first chunk goes out, then someone widens the Circle and deletes it.
    await drain(run.ctx, run.queue, { maxSteps: 1 }).catch(() => undefined);
    await env.DB.prepare(`UPDATE circles SET rule_json = ?1, deleted_at = 1 WHERE id = ?2`)
      .bind(JSON.stringify({ field: 'email', cmp: 'is_set' }), circle)
      .run();
    await drain(run.ctx, run.queue);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'sent',
      recipient_count: 1050,
    });
  });

  it('refuses to start when a Circle is gone or belongs to another Channel', async () => {
    const { channelId } = await seedChannel({ members: 10 });
    const { channelId: otherChannel } = await seedChannel({ members: 10 });
    const foreign = await addCircle(otherChannel, { field: 'email', cmp: 'is_set' });
    const deleted = await addCircle(channelId, { field: 'email', cmp: 'is_set' });
    await env.DB.prepare('UPDATE circles SET deleted_at = 1 WHERE id = ?1').bind(deleted).run();
    for (const audience of [
      { include: [foreign], exclude: [] },
      { include: [], exclude: [deleted] },
    ]) {
      const dispatch = await addressed(channelId, audience);
      const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
      expect(check.ready).toBe(false);
      expect(check.checks.find((c) => c.key === 'audience')).toMatchObject({
        ok: false,
        message: expect.stringMatching(/no longer exists/),
      });
      const run = context();
      await expect(
        startBroadcast(env.DB, run.queue, config, {
          dispatch,
          operatorId: null,
          allowHtmlBlocks: false,
        }),
      ).rejects.toBeInstanceOf(StartError);
    }
  });

  it('reads the audience from the database when the row passed in lacks it', async () => {
    const { channelId } = await seedChannel({ members: 20 });
    const circle = await addCircle(channelId, { field: 'first_name', cmp: 'eq', value: 'Ada' });
    const { audience_json: _omitted, ...dispatch } = await addressed(channelId, {
      include: [circle],
      exclude: [],
    });
    const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(check.recipientCount).toBe(10);
  });
});

describe('subscribers who turned emails off (S03-P5-G-paid-mail-choice)', () => {
  it('are left out of the count and the snapshot, and keep their status', async () => {
    const { channelId } = await seedChannel({ members: 30 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    const off = ids.filter((_, i) => i % 5 === 0);
    await env.DB.prepare(
      'UPDATE members SET emails_off_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))',
    )
      .bind(Date.now(), JSON.stringify(off))
      .run();
    const result = await send(channelId, { include: [], exclude: [] });
    const want = ids.filter((id) => !off.includes(id));
    expect(result.check.recipientCount).toBe(want.length);
    expect(result.recipients).toEqual(want);
    expect(result.mailed).toBe(want.length);
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT status FROM members WHERE id IN (SELECT value FROM json_each(?1))',
    )
      .bind(JSON.stringify(off))
      .all<{ status: string }>();
    expect(results).toEqual([{ status: 'active' }]);
  });

  it('are skipped when they turn emails off after the snapshot, before their batch goes', async () => {
    const { channelId } = await seedChannel({ members: 10 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    const dispatch = await addressed(channelId, { include: [], exclude: [] });
    const run = context();
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
    });
    // Let the snapshot run and hold the batches; turn emails off; then let the batches go.
    const late = ids[3]!;
    const held: (typeof run.queue.items)[number][] = [];
    await drain(run.ctx, run.queue, {
      filter: (body) => {
        if (body.type !== 'batch') return true;
        held.push({ body, delaySeconds: 0 });
        return false;
      },
    });
    expect(held.length).toBeGreaterThan(0);
    await env.DB.prepare('UPDATE members SET emails_off_at = ?1 WHERE id = ?2')
      .bind(Date.now(), late)
      .run();
    run.queue.items.push(...held);
    await drain(run.ctx, run.queue);
    const row = await env.DB.prepare(
      'SELECT status FROM broadcast_recipients WHERE broadcast_id = ?1 AND member_id = ?2',
    )
      .bind(broadcastId, late)
      .first<{ status: string }>();
    expect(row?.status).toBe('skipped');
    expect(run.mail.sent.length).toBe(ids.length - 1);
  });
});
