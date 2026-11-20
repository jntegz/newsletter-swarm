// The member event bus (Phase 6): appends, the conditional statements and the emitters wired
// into existing code paths, against real D1.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  ensureTags,
  fieldValueStatements,
  markMemberEventsProcessed,
  pendingMemberEvents,
  pruneMemberEvents,
  recomputeEntitlement,
  recordMemberEvent,
  recordMemberEvents,
  tagStatements,
  MEMBER_EVENT_RETENTION_MS,
  type ChannelField,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { toStored } from '@swarm/vault/testing';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { refreshCircle } from '../src/handlers/circles';
import { addField, addMember, count, jobsEnv, seedChannel, testFieldKeys } from './helpers';

const events = async (memberId: string) =>
  (
    await env.DB.prepare(
      'SELECT type, payload_json, channel_id FROM member_events WHERE member_id = ?1 ORDER BY seq',
    )
      .bind(memberId)
      .all<{ type: string; payload_json: string; channel_id: string }>()
  ).results.map((r) => ({
    type: r.type,
    payload: JSON.parse(r.payload_json),
    channel: r.channel_id,
  }));

describe('member event bus', () => {
  it('appends with the Member’s Channel and drops events for other Channels or no Member', async () => {
    const { channelId } = await seedChannel();
    const other = await seedChannel();
    const memberId = await addMember(channelId, `bus-${crypto.randomUUID()}@example.com`);
    await recordMemberEvent(env.DB, {
      type: 'api_event',
      memberId,
      payload: { name: 'trial.started' },
    });
    await recordMemberEvents(env.DB, [
      { type: 'gate_hit', memberId, channelId: other.channelId, payload: { dispatchId: 'dp_x' } },
      { type: 'gate_hit', memberId: newId('member'), payload: { dispatchId: 'dp_x' } },
    ]);
    expect(await events(memberId)).toEqual([
      { type: 'api_event', payload: { name: 'trial.started' }, channel: channelId },
    ]);
  });

  it('drains, stamps and prunes', async () => {
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId, `drain-${crypto.randomUUID()}@example.com`);
    await recordMemberEvent(env.DB, { type: 'unengaged', memberId, payload: { days: 30 } });
    const pending = (await pendingMemberEvents(env.DB, 10_000)).filter(
      (e) => e.member_id === memberId,
    );
    expect(pending).toHaveLength(1);
    const now = Date.now();
    await markMemberEventsProcessed(env.DB, [pending[0]!.seq], now);
    expect((await pendingMemberEvents(env.DB, 10_000)).some((e) => e.member_id === memberId)).toBe(
      false,
    );
    await pruneMemberEvents(env.DB, now + MEMBER_EVENT_RETENTION_MS + 1);
    expect(
      await count('SELECT count(*) AS n FROM member_events WHERE member_id = ?1', memberId),
    ).toBe(0);
  });

  it('emits tag_added and tag_removed only for real changes', async () => {
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId, `tags-${crypto.randomUUID()}@example.com`);
    const now = Date.now();
    const tags = await ensureTags(env.DB, channelId, ['alpha', 'beta'], now);
    const alpha = tags.get('alpha')!;
    const beta = tags.get('beta')!;
    await env.DB.batch(tagStatements(env.DB, memberId, [alpha], now));
    await env.DB.batch(tagStatements(env.DB, memberId, [alpha], now)); // already tagged
    await env.DB.batch(tagStatements(env.DB, memberId, [beta], now, true)); // replace
    expect((await events(memberId)).map((e) => [e.type, e.payload.tagId])).toEqual([
      ['tag_added', alpha],
      ['tag_removed', alpha],
      ['tag_added', beta],
    ]);
  });

  it('emits field_changed only when the value changes', async () => {
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId, `fields-${crypto.randomUUID()}@example.com`);
    const fieldId = await addField(channelId, 'company', 'text');
    const field: ChannelField = {
      id: fieldId,
      key: 'company',
      type: 'text',
      options: [],
      encrypted: false,
      label: 'company',
    };
    const write = async (value: string | null) => {
      const stored = await toStored(field, value, testFieldKeys);
      await env.DB.batch(
        fieldValueStatements(env.DB, memberId, [{ field, value, stored }], Date.now()),
      );
    };
    await write('Acme');
    await write('Acme');
    await write('Globex');
    await write(null);
    await write(null);
    expect((await events(memberId)).map((e) => e.type)).toEqual([
      'field_changed',
      'field_changed',
      'field_changed',
    ]);
  });

  it('emits circle_entered and circle_exited from a refresh, but not on the first one', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const ada = await addMember(channelId, `ada-${crypto.randomUUID()}@example.com`, {
      firstName: 'Ada',
    });
    const bob = await addMember(channelId, `bob-${crypto.randomUUID()}@example.com`, {
      firstName: 'Bob',
    });
    const circleId = newId('circle');
    const now = Date.now();
    const rule = (name: string) => JSON.stringify({ field: 'first_name', cmp: 'eq', value: name });
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Test', ?4, 1, 'pending', ?5, ?5)`,
    )
      .bind(circleId, workspaceId, channelId, rule('Ada'), now)
      .run();
    const { env: jobs } = jobsEnv();
    await refreshCircle(jobs, circleId, 1, now);
    expect(await events(ada)).toEqual([]);

    await env.DB.prepare('UPDATE circles SET rule_json = ?1, generation = 2 WHERE id = ?2')
      .bind(rule('Bob'), circleId)
      .run();
    await refreshCircle(jobs, circleId, 2, now + 1000);
    expect(await events(ada)).toEqual([
      { type: 'circle_exited', payload: { circleId }, channel: channelId },
    ]);
    expect(await events(bob)).toEqual([
      { type: 'circle_entered', payload: { circleId }, channel: channelId },
    ]);
  });

  it('emits level_purchased and level_canceled from recomputeEntitlement', async () => {
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId, `paid-${crypto.randomUUID()}@example.com`);
    const now = Date.now();
    const levelId = newId('membershipLevel', now);
    const subscriptionId = newId('memberSubscription', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at)
         VALUES (?1, ?2, 'Pro', ?3, ?3)`,
      ).bind(levelId, channelId, now),
      env.DB.prepare(
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'comp', 'active', ?5, ?5)`,
      ).bind(subscriptionId, channelId, memberId, levelId, now),
    ]);
    await recomputeEntitlement(env.DB, channelId, memberId, now);
    await recomputeEntitlement(env.DB, channelId, memberId, now); // unchanged
    await env.DB.prepare('UPDATE member_subscriptions SET revoked_at = ?1 WHERE id = ?2')
      .bind(now, subscriptionId)
      .run();
    await recomputeEntitlement(env.DB, channelId, memberId, now);
    expect(await events(memberId)).toEqual([
      {
        type: 'level_purchased',
        payload: { levelId, source: 'comp' },
        channel: channelId,
      },
      { type: 'level_canceled', payload: { levelId }, channel: channelId },
    ]);
  });

  it('runs the every-minute Flows hook', async () => {
    await expect(runScheduled(jobsEnv().env, MINUTE_CRON, Date.now())).resolves.toBeUndefined();
  });
});
