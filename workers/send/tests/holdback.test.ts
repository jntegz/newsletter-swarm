// Phase 6 on the Broadcast pipeline: Smart Block visibility in the snapshot and the batch, Split
// Tests (assignment, holding back, promotion) and Cohort Sampling (extend or halt).
import { env } from 'cloudflare:test';
import { newId, splitAssignment } from '@swarm/domain';
import {
  decideCohortSample,
  decideHoldBacks,
  decideSplitTest,
  preflight,
  smartBlockVisibility,
  startBroadcast,
  type DispatchRow,
  type SendFeatures,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { completeRamp, config, context, count, drain, seedChannel, seedDispatch } from './harness';

const ALL: SendFeatures = { splitTests: true, cohortSampling: true, smartBlocks: true };
const HOUR = 3_600_000;

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

async function tagMembers(channelId: string, name: string, memberIds: string[]) {
  const tagId = newId('tag');
  await env.DB.prepare('INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, 0)')
    .bind(tagId, channelId, name)
    .run();
  for (const id of memberIds) {
    await env.DB.prepare(
      'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
    )
      .bind(id, tagId)
      .run();
  }
}

async function memberIds(channelId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM members WHERE channel_id = ?1 ORDER BY id',
  )
    .bind(channelId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function start(dispatch: DispatchRow, queue: Parameters<typeof startBroadcast>[1]) {
  return startBroadcast(env.DB, queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
    features: ALL,
  });
}

async function addSplitTest(
  dispatchId: string,
  channelId: string,
  options: {
    variable?: 'subject' | 'content';
    testPercent: number;
    metric?: 'opens' | 'clicks' | 'goal';
    goal?: Record<string, unknown>;
    variants: { subject?: string; content?: unknown }[];
  },
) {
  const id = newId('splitTest');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO split_tests (id, channel_id, dispatch_id, variable, test_percent, metric, goal_json, window_minutes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, 60, ?7, ?7)`,
  )
    .bind(
      id,
      channelId,
      dispatchId,
      options.variable ?? 'subject',
      options.testPercent,
      options.metric ?? 'opens',
      now,
      options.goal ? JSON.stringify(options.goal) : null,
    )
    .run();
  const ids: string[] = [];
  for (const [i, v] of options.variants.entries()) {
    const vid = newId('splitTestVariant');
    ids.push(vid);
    await env.DB.prepare(
      `INSERT INTO split_test_variants (id, split_test_id, label, subject, content_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        vid,
        id,
        'ABCD'[i],
        v.subject ?? null,
        v.content ? JSON.stringify(v.content) : null,
        now,
      )
      .run();
  }
  return { id, variantIds: ids };
}

const GOAL_LEVEL = newId('membershipLevel');

async function addCohortSample(dispatchId: string, channelId: string, samplePercent: number) {
  const id = newId('cohortSample');
  await env.DB.prepare(
    `INSERT INTO cohort_samples (id, channel_id, dispatch_id, sample_percent, window_minutes, min_open_rate,
       max_bounce_rate, max_complaint_rate, max_unsubscribe_rate, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 60, NULL, 0.05, 0.001, 0.02, 0, 0)`,
  )
    .bind(id, channelId, dispatchId, samplePercent)
    .run();
  return id;
}

describe('Smart Blocks in a Broadcast', () => {
  it('stores each recipient’s visible blocks at snapshot and strips the rest when sending', async () => {
    const { channelId } = await seedChannel({ members: 6 });
    await completeRamp(channelId);
    const ids = await memberIds(channelId);
    const vips = ids.slice(0, 2);
    await tagMembers(channelId, 'VIP', vips);
    const content = doc(
      para('Hello'),
      {
        type: 'smartBlock',
        attrs: { condition: { field: 'tag', cmp: 'eq', value: 'vip' }, anonymous: 'hide' },
        content: [para('VIP lounge')],
      },
      {
        type: 'smartBlock',
        attrs: { condition: { field: 'tag', cmp: 'neq', value: 'VIP' } },
        content: [para('Upgrade to VIP')],
      },
    );
    const dispatch = await seedDispatch(channelId, { content_json: JSON.stringify(content) });
    const { ctx, queue, mail } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);

    const { results } = await env.DB.prepare(
      'SELECT member_id, smart_blocks_json FROM broadcast_recipients WHERE broadcast_id = ?1',
    )
      .bind(broadcastId)
      .all<{ member_id: string; smart_blocks_json: string }>();
    expect(results).toHaveLength(6);
    for (const row of results) {
      expect(JSON.parse(row.smart_blocks_json)).toEqual(vips.includes(row.member_id) ? [0] : [1]);
    }
    // The helper the Flow send uses agrees with the snapshot.
    expect(await smartBlockVisibility(env.DB, channelId, vips[0]!, content)).toEqual([0]);
    expect(await smartBlockVisibility(env.DB, channelId, ids[5]!, content)).toEqual([1]);

    expect(mail.sent).toHaveLength(6);
    for (const sent of mail.sent) {
      const vip = vips.some((id) => sent.to.startsWith(`m${ids.indexOf(id) + 1}-`));
      for (const part of [sent.html, sent.text]) {
        expect(part).not.toContain('swarm:sb');
        expect(part.includes('VIP lounge')).toBe(vip);
        expect(part.includes('Upgrade to VIP')).toBe(!vip);
        expect(part).toContain('Hello');
      }
    }
  });

  it('refuses to send Smart Blocks when the flag is off, or with another Channel’s Circle', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const other = await seedChannel();
    const foreign = newId('circle');
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Other', '{"field":"email","cmp":"is_set"}', 0, 0)`,
    )
      .bind(foreign, other.workspaceId, other.channelId)
      .run();
    const block = (condition: unknown) =>
      JSON.stringify(doc({ type: 'smartBlock', attrs: { condition }, content: [para('x')] }));
    const valid = await seedDispatch(channelId, {
      content_json: block({ field: 'tag', cmp: 'is_set' }),
    });
    const off = await preflight(env.DB, config, valid, { allowHtmlBlocks: false });
    expect(off.ready).toBe(false);
    expect(off.checks.find((c) => c.key === 'content')?.message).toMatch(/Smart blocks are off/);
    expect(
      (
        await preflight(env.DB, config, valid, { allowHtmlBlocks: false, features: ALL })
      ).checks.find((c) => c.key === 'content')?.ok,
    ).toBe(true);

    const crossTenant = await seedDispatch(channelId, {
      content_json: block({ field: 'circle', cmp: 'eq', value: foreign }),
    });
    const refused = await preflight(env.DB, config, crossTenant, {
      allowHtmlBlocks: false,
      features: ALL,
    });
    expect(refused.ready).toBe(false);
    expect(refused.checks.find((c) => c.key === 'content')?.message).toMatch(/this publication/);
  });
});

describe('Split Tests', () => {
  it('assigns deterministically and evenly', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `mb_${i.toString(36).padStart(26, '0')}`);
    const counts = [0, 0, 0, 0];
    let held = 0;
    for (const id of ids) {
      const a = splitAssignment('xt_test', id, 40, 4);
      expect(splitAssignment('xt_test', id, 40, 4)).toBe(a);
      if (a === null) held++;
      else counts[a]!++;
    }
    expect(held / ids.length).toBeGreaterThan(0.56);
    expect(held / ids.length).toBeLessThan(0.64);
    for (const n of counts) expect(Math.abs(n - 400)).toBeLessThan(70);
    // A different test splits the same Members differently.
    const moved = ids.filter(
      (id) => splitAssignment('xt_other', id, 40, 4) !== splitAssignment('xt_test', id, 40, 4),
    );
    expect(moved.length).toBeGreaterThan(1000);
  });

  it('holds the rest back, promotes the winner once, and sends it to the held Members', async () => {
    const { channelId } = await seedChannel({ members: 200 });
    await completeRamp(channelId);
    const dispatch = await seedDispatch(channelId, { subject: 'Subject A' });
    const test = await addSplitTest(dispatch.id, channelId, {
      testPercent: 40,
      variants: [{}, { subject: 'Subject B' }],
    });
    const { ctx, queue, mail } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);

    const ids = await memberIds(channelId);
    const placed = new Map(ids.map((id) => [id, splitAssignment(test.id, id, 40, 2)]));
    const testIds = ids.filter((id) => placed.get(id) !== null);
    const rows = await env.DB.prepare(
      'SELECT member_id, held, split_variant_id, status FROM broadcast_recipients WHERE broadcast_id = ?1',
    )
      .bind(broadcastId)
      .all<{ member_id: string; held: number; split_variant_id: string | null; status: string }>();
    for (const row of rows.results) {
      const index = placed.get(row.member_id)!;
      expect(row.held).toBe(index === null ? 1 : 0);
      expect(row.split_variant_id).toBe(index === null ? null : test.variantIds[index]);
      expect(row.status).toBe(index === null ? 'pending' : 'sent');
    }
    // Only the test part went out, each with its variant's subject.
    expect(mail.sent).toHaveLength(testIds.length);
    expect(mail.sent.filter((m) => m.subject === 'Subject B').length).toBe(
      testIds.filter((id) => placed.get(id) === 1).length,
    );
    expect(
      (
        await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
          .bind(broadcastId)
          .first<{ status: string }>()
      )?.status,
    ).toBe('sending');

    // Not due yet: nothing happens.
    const jobs = { DB: env.DB, SEND_QUEUE: queue };
    expect(await decideSplitTest(jobs, test.id, Date.now())).toBeNull();

    // B gets the opens.
    await env.DB.prepare(
      `UPDATE deliveries SET human_opened_at = sent_at, opened_at = sent_at
        WHERE broadcast_id = ?1 AND member_id IN (
          SELECT member_id FROM broadcast_recipients WHERE broadcast_id = ?1 AND split_variant_id = ?2)`,
    )
      .bind(broadcastId, test.variantIds[1])
      .run();
    const later = Date.now() + 2 * HOUR;
    const [first, second] = await Promise.all([
      decideSplitTest(jobs, test.id, later),
      decideSplitTest(jobs, test.id, later),
    ]);
    expect([first, second].filter(Boolean)).toEqual([test.variantIds[1]]);
    expect(await decideSplitTest(jobs, test.id, later + HOUR)).toBeNull();
    expect(queue.items.filter((i) => i.body.type === 'fanout')).toHaveLength(1);
    const decided = await env.DB.prepare(
      'SELECT status, winner_variant_id, decision_json FROM split_tests WHERE id = ?1',
    )
      .bind(test.id)
      .first<{ status: string; winner_variant_id: string; decision_json: string }>();
    expect(decided?.status).toBe('promoted');
    expect(JSON.parse(decided!.decision_json).winner).toBe('B');

    mail.sent.length = 0;
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(ids.length - testIds.length);
    expect(mail.sent.every((m) => m.subject === 'Subject B')).toBe(true);
    expect(
      await count('SELECT count(*) AS n FROM deliveries WHERE broadcast_id = ?1', broadcastId),
    ).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
          .bind(broadcastId)
          .first<{ status: string }>()
      )?.status,
    ).toBe('sent');
  });

  it.each([
    [
      'a level purchase',
      { event: 'level_purchased', levelId: GOAL_LEVEL },
      { levelId: GOAL_LEVEL, source: 'stripe' },
      { levelId: newId('membershipLevel'), source: 'stripe' },
    ],
    [
      'an API event',
      { event: 'api_event', name: 'trial.started' },
      { name: 'trial.started' },
      { name: 'trial.ended' },
    ],
    [
      'a link click',
      { event: 'link_clicked', url: 'https://x.example/buy' },
      { url: 'https://x.example/buy' },
      { url: 'https://x.example/about' },
    ],
  ])('promotes on a custom goal, %s, counting only that goal', async (_, goal, matching, other) => {
    const { channelId } = await seedChannel({ members: 60 });
    await completeRamp(channelId);
    const dispatch = await seedDispatch(channelId, { subject: 'Subject A' });
    const test = await addSplitTest(dispatch.id, channelId, {
      testPercent: 50,
      metric: 'goal',
      goal,
      variants: [{}, { subject: 'Subject B' }],
    });
    const { ctx, queue } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);
    const recipients = async (variantId: string) =>
      (
        await env.DB.prepare(
          'SELECT member_id FROM broadcast_recipients WHERE broadcast_id = ?1 AND split_variant_id = ?2',
        )
          .bind(broadcastId, variantId)
          .all<{ member_id: string }>()
      ).results.map((r) => r.member_id);
    const event = (memberId: string, payload: unknown, at: number) =>
      env.DB.prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(channelId, memberId, goal.event, JSON.stringify(payload), at);
    const at = Date.now() + 60_000;
    const a = await recipients(test.variantIds[0]!);
    const b = await recipients(test.variantIds[1]!);
    await env.DB.batch([
      // A gets more events, but of the wrong kind; B's one match is what wins.
      ...a.map((memberId) => event(memberId, other, at)),
      event(b[0]!, matching, at),
    ]);
    const jobs = { DB: env.DB, SEND_QUEUE: queue };
    expect(await decideSplitTest(jobs, test.id, Date.now() + 2 * HOUR)).toBe(test.variantIds[1]);
  });

  it('regression: a deleted Channel’s Split Test promotes nobody and the send is canceled', async () => {
    const { channelId } = await seedChannel({ members: 200 });
    await completeRamp(channelId);
    const dispatch = await seedDispatch(channelId, { subject: 'Subject A' });
    const test = await addSplitTest(dispatch.id, channelId, {
      testPercent: 40,
      variants: [{}, { subject: 'Subject B' }],
    });
    const { ctx, queue, mail } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);
    const tested = mail.sent.length;
    expect(tested).toBeGreaterThan(0);
    expect(tested).toBeLessThan(200);

    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channelId)
      .run();
    mail.sent.length = 0;
    const jobs = { DB: env.DB, SEND_QUEUE: queue };
    expect(await decideSplitTest(jobs, test.id, Date.now() + 2 * HOUR)).toBeNull();
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(0);
    expect(
      await count('SELECT count(*) AS n FROM deliveries WHERE broadcast_id = ?1', broadcastId),
    ).toBe(tested);
    expect(
      await env.DB.prepare('SELECT status FROM split_tests WHERE id = ?1').bind(test.id).first(),
    ).toEqual({ status: 'canceled' });
    expect(
      await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1').bind(broadcastId).first(),
    ).toEqual({ status: 'canceled' });
  });

  it('sends content variants with their own render and links; 100% tests only report', async () => {
    const { channelId } = await seedChannel({ members: 40 });
    await completeRamp(channelId);
    const dispatch = await seedDispatch(channelId);
    const variantB = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Version B',
          marks: [{ type: 'link', attrs: { href: 'https://b.example/only-b' } }],
        },
      ],
    });
    const test = await addSplitTest(dispatch.id, channelId, {
      variable: 'content',
      testPercent: 100,
      metric: 'clicks',
      variants: [{}, { content: variantB }],
    });
    const { ctx, queue, mail } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(40);
    const b = mail.sent.filter((m) => m.html.includes('Version B'));
    expect(b.length).toBeGreaterThan(5);
    expect(b.length).toBeLessThan(35);
    // B's link is a tracked link target of the Broadcast.
    expect(
      await count(
        `SELECT count(*) AS n FROM link_targets WHERE broadcast_id = ?1 AND url = 'https://b.example/only-b'`,
        broadcastId,
      ),
    ).toBe(1);
    expect(b.every((m) => !m.html.includes('b.example') && m.html.includes('/c/'))).toBe(true);
    expect(
      await count(
        'SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND held = 1',
        broadcastId,
      ),
    ).toBe(0);
    // The Broadcast finished on its own; the decision only reports.
    const result = await decideHoldBacks({ DB: env.DB, SEND_QUEUE: queue }, Date.now() + 2 * HOUR);
    expect(result.promoted).toBe(1);
    const row = await env.DB.prepare('SELECT status FROM split_tests WHERE id = ?1')
      .bind(test.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('promoted');
  });

  it('keeps the full/teaser split on a gated paid Dispatch and refuses content tests there', async () => {
    const { channelId } = await seedChannel({ members: 20 });
    await completeRamp(channelId);
    const gated = doc(para('Free part'), { type: 'gate' }, para('Paid part'));
    const dispatch = await seedDispatch(channelId, {
      content_json: JSON.stringify(gated),
      subject: 'Paid A',
    });
    await env.DB.prepare(`UPDATE dispatches SET web_visibility = 'paid' WHERE id = ?1`)
      .bind(dispatch.id)
      .run();
    const paid = { ...dispatch, web_visibility: 'paid' as const };
    const ids = await memberIds(channelId);
    await env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at)
       VALUES (?1, ?2, 'paid', 'stripe', 0, NULL)`,
    )
      .bind(ids[0], channelId)
      .run();

    const content = await addSplitTest(dispatch.id, channelId, {
      variable: 'content',
      testPercent: 100,
      variants: [{}, { content: doc(para('B')) }],
    });
    const refused = await preflight(env.DB, config, paid, {
      allowHtmlBlocks: false,
      features: ALL,
    });
    expect(refused.ready).toBe(false);
    expect(refused.checks.find((c) => c.key === 'test')?.message).toMatch(/paywall break/);
    await env.DB.prepare('DELETE FROM split_tests WHERE id = ?1').bind(content.id).run();

    await addSplitTest(dispatch.id, channelId, {
      testPercent: 100,
      variants: [{}, { subject: 'Paid B' }],
    });
    const { ctx, queue, mail } = context();
    await start(paid, ctx.queue);
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(20);
    const full = mail.sent.filter((m) => m.html.includes('Paid part'));
    expect(full).toHaveLength(1);
    expect(full[0]!.to.startsWith('m1-')).toBe(true);
    expect(mail.sent.filter((m) => m.subject === 'Paid B').length).toBeGreaterThan(0);
    expect(mail.sent.filter((m) => m.subject === 'Paid A').length).toBeGreaterThan(0);
  });
});

describe('Cohort Sampling', () => {
  async function sampled(members: number) {
    const { channelId, workspaceId } = await seedChannel({ members });
    await completeRamp(channelId);
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
    const sampleId = await addCohortSample(dispatch.id, channelId, 25);
    const { ctx, queue, mail } = context();
    const { broadcastId } = await start(dispatch, ctx.queue);
    await drain(ctx, queue);
    return { channelId, sampleId, broadcastId, ctx, queue, mail, operator };
  }

  it('extends to everyone when the sample is healthy', async () => {
    const s = await sampled(120);
    const first = s.mail.sent.length;
    expect(first).toBeGreaterThan(10);
    expect(first).toBeLessThan(50);
    const jobs = { DB: env.DB, SEND_QUEUE: s.queue };
    expect(await decideCohortSample(jobs, s.sampleId, Date.now() + 2 * HOUR)).toBe('extended');
    expect(await decideCohortSample(jobs, s.sampleId, Date.now() + 3 * HOUR)).toBeNull();
    await drain(s.ctx, s.queue);
    expect(s.mail.sent).toHaveLength(120);
    expect(new Set(s.mail.sent.map((m) => m.to)).size).toBe(120);
  });

  it('regression: a deleted Channel’s Cohort Sample does not extend to the rest', async () => {
    const s = await sampled(120);
    const first = s.mail.sent.length;
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), s.channelId)
      .run();
    const jobs = { DB: env.DB, SEND_QUEUE: s.queue };
    expect(await decideCohortSample(jobs, s.sampleId, Date.now() + 2 * HOUR)).toBeNull();
    await drain(s.ctx, s.queue);
    expect(s.mail.sent).toHaveLength(first);
    expect(
      await env.DB.prepare('SELECT status FROM cohort_samples WHERE id = ?1')
        .bind(s.sampleId)
        .first(),
    ).toEqual({ status: 'canceled' });
    expect(
      await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
        .bind(s.broadcastId)
        .first(),
    ).toEqual({ status: 'canceled' });
  });

  it('halts when the sample bounces, leaves the rest unsent and emails the operators', async () => {
    const s = await sampled(120);
    const first = s.mail.sent.length;
    await env.DB.prepare(`UPDATE deliveries SET status = 'bounced' WHERE broadcast_id = ?1`)
      .bind(s.broadcastId)
      .run();
    const jobs = { DB: env.DB, SEND_QUEUE: s.queue };
    expect(await decideCohortSample(jobs, s.sampleId, Date.now() + 2 * HOUR)).toBe('halted');
    await drain(s.ctx, s.queue);
    const members = s.mail.sent.filter((m) => m.category === 'broadcast');
    expect(members).toHaveLength(first);
    const notice = s.mail.sent.filter((m) => m.category === 'operator');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.to).toBe(`owner-${s.operator}@team.example`);
    expect(notice[0]!.text).toMatch(/Bounces 100%/);
    const sample = await env.DB.prepare(
      'SELECT status, metrics_json FROM cohort_samples WHERE id = ?1',
    )
      .bind(s.sampleId)
      .first<{ status: string; metrics_json: string }>();
    expect(sample?.status).toBe('halted');
    expect(JSON.parse(sample!.metrics_json).passed).toBe(false);
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND held = 1 AND status = 'skipped'`,
        s.broadcastId,
      ),
    ).toBe(120 - first);
    const broadcast = await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
      .bind(s.broadcastId)
      .first<{ status: string }>();
    expect(broadcast?.status).toBe('sent');
  });
});
