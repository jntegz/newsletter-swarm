// What each queue may carry (security review S04-P1-TR-public-worker-queue-narrowing): the jobs
// worker reads every body against the queue it came from. Capture and events can write only to
// the public queue, so anything there other than "this publication changed" and a confirmed
// signup's check is refused, logged and acked, never run.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { queueRole, readQueueMessage } from '@swarm/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consume } from '../src/index';
import { addMember, seedChannel } from './helpers';

afterEach(() => vi.restoreAllMocks());

interface Outcome {
  acked: string[];
  retried: string[];
  refused: { queue: string; type: string | null; reason: string }[];
  queued: unknown[];
}

/** Runs one batch through the consumer, with the jobs queue as a list. */
async function run(queue: string, bodies: Record<string, unknown>): Promise<Outcome> {
  const out: Outcome = { acked: [], retried: [], refused: [], queued: [] };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const messages = Object.entries(bodies).map(([id, body]) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => out.acked.push(id),
    retry: () => out.retried.push(id),
  }));
  const jobsQueue = { send: async (message: unknown) => void out.queued.push(message) };
  await consume({ queue, messages } as unknown as MessageBatch<unknown>, {
    ...env,
    JOBS_QUEUE: jobsQueue,
  });
  for (const [line] of warn.mock.calls) {
    const parsed = JSON.parse(String(line)) as { message: string } & Outcome['refused'][number];
    if (parsed.message === 'message refused') {
      out.refused.push({ queue: parsed.queue, type: parsed.type, reason: parsed.reason });
    }
  }
  warn.mockRestore();
  return out;
}

async function seedCircle(channel: { workspaceId: string; channelId: string }) {
  const id = newId('circle');
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'All', '{"field":"email","cmp":"is_set"}', 1, 'ready', 0, 0)`,
  )
    .bind(id, channel.workspaceId, channel.channelId)
    .run();
  return id;
}

const circle = (id: string) =>
  env.DB.prepare('SELECT status, evaluated_at FROM circles WHERE id = ?1')
    .bind(id)
    .first<{ status: string; evaluated_at: number | null }>();

describe('queue roles', () => {
  it('come from the queue name in every environment, and nothing else', () => {
    expect(queueRole('swarm-jobs')).toBe('jobs');
    expect(queueRole('swarm-production-jobs')).toBe('jobs');
    expect(queueRole('swarm-staging-webhooks')).toBe('webhooks');
    expect(queueRole('swarm-public')).toBe('public');
    expect(queueRole('swarm-production-public')).toBe('public');
    expect(queueRole('swarm-production-public-dlq')).toBeNull();
    expect(queueRole('swarm-production-send')).toBeNull();
    expect(queueRole('something-else')).toBeNull();
  });
});

describe('the public queue', () => {
  it('runs channel_changed: the jobs worker marks the Circles pending and queues their refresh', async () => {
    const channel = await seedChannel();
    const id = await seedCircle(channel);
    const out = await run('swarm-production-public', {
      m1: { type: 'channel_changed', channelId: channel.channelId },
    });
    expect(out.acked).toEqual(['m1']);
    expect(out.refused).toEqual([]);
    expect((await circle(id))?.status).toBe('pending');
    expect(out.queued).toEqual([{ type: 'circle_refresh', circleId: id, generation: 1 }]);
  });

  it('refuses every other job type, logs it and never runs it', async () => {
    const channel = await seedChannel();
    const id = await seedCircle(channel);
    const member = await addMember(channel.channelId, `r-${crypto.randomUUID()}@example.org`);
    const requestId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO email_check_requests (id, workspace_id, channel_id, member_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(requestId, channel.workspaceId, channel.channelId, member, Date.now())
      .run();
    const out = await run('swarm-public', {
      refresh: { type: 'circle_refresh', circleId: id, generation: 1 },
      export: { type: 'export', jobId: 'ej_missing' },
      step: { type: 'flow_step', runId: 'fr_x', nodeId: 'n1', attempt: 1 },
      events: { type: 'flow_events' },
      delivery: { type: 'webhook_delivery', deliveryId: 'wd_x' },
      // "Check again" is the api's stored request; a public worker can't name one.
      again: {
        type: 'email_check',
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        requestId,
      },
      // Only the signup rules, for one Member who confirmed.
      byHand: {
        type: 'email_check',
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        memberIds: [member],
      },
    });
    expect(out.acked.sort()).toEqual(
      ['again', 'byHand', 'delivery', 'events', 'export', 'refresh', 'step'].sort(),
    );
    expect(out.retried).toEqual([]);
    expect(out.queued).toEqual([]);
    expect(out.refused).toHaveLength(7);
    expect(out.refused).toContainEqual({
      queue: 'swarm-public',
      type: 'circle_refresh',
      reason: 'not_allowed',
    });
    expect(out.refused).toContainEqual({
      queue: 'swarm-public',
      type: 'email_check',
      reason: 'malformed',
    });
    // Nothing ran: the Circle was not evaluated, the stored request is still there.
    expect(await circle(id)).toEqual({ status: 'ready', evaluated_at: null });
    const stored = await env.DB.prepare('SELECT id FROM email_check_requests WHERE id = ?1')
      .bind(requestId)
      .first();
    expect(stored).not.toBeNull();
  });

  it('refuses a malformed body and a type it does not know', async () => {
    const out = await run('swarm-public', {
      noId: { type: 'channel_changed' },
      notAnId: { type: 'channel_changed', channelId: "x' OR 1=1" },
      extra: { type: 'channel_changed', channelId: newId('channel'), circleId: 'c' },
      unknown: { type: 'drop_tables' },
      text: 'channel_changed',
      none: null,
    });
    expect(out.acked.sort()).toEqual(['extra', 'noId', 'none', 'notAnId', 'text', 'unknown']);
    expect(out.retried).toEqual([]);
    expect(out.refused).toHaveLength(6);
    expect(out.queued).toEqual([]);
  });

  it('accepts the check capture queues for a confirmed signup', () => {
    const message = {
      type: 'email_check',
      workspaceId: newId('workspace'),
      channelId: newId('channel'),
      memberIds: [newId('member')],
      confirmed: true,
    };
    expect(readQueueMessage('public', message)).toEqual({ ok: true, message });
    // Two Members, or none, is not what capture sends.
    const two = { ...message, memberIds: [newId('member'), newId('member')] };
    expect(readQueueMessage('public', two)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('the jobs and webhooks queues', () => {
  it('refuse channel_changed, which only the public queue carries', async () => {
    const channel = await seedChannel();
    const id = await seedCircle(channel);
    const out = await run('swarm-jobs', {
      m1: { type: 'channel_changed', channelId: channel.channelId },
    });
    expect(out.acked).toEqual(['m1']);
    expect(out.refused).toEqual([
      { queue: 'swarm-jobs', type: 'channel_changed', reason: 'not_allowed' },
    ]);
    expect((await circle(id))?.status).toBe('ready');
    const hooks = await run('swarm-webhooks', {
      m2: { type: 'channel_changed', channelId: channel.channelId },
    });
    expect(hooks.refused).toHaveLength(1);
  });

  it('refuse a job whose fields are the wrong shape', async () => {
    const out = await run('swarm-staging-jobs', {
      m1: { type: 'circle_refresh', circleId: 'c1', generation: 'one' },
      m2: { type: 'flow_step', runId: 'r', nodeId: 'n' },
    });
    expect(out.acked.sort()).toEqual(['m1', 'm2']);
    expect(out.refused.map((r) => r.reason)).toEqual(['malformed', 'malformed']);
  });

  it('still run circle_refresh from api and jobs', async () => {
    const channel = await seedChannel();
    const id = await seedCircle(channel);
    const out = await run('swarm-jobs', {
      m1: { type: 'circle_refresh', circleId: id, generation: 1 },
    });
    expect(out.acked).toEqual(['m1']);
    expect(out.refused).toEqual([]);
    expect((await circle(id))?.status).toBe('ready');
    expect((await circle(id))?.evaluated_at).not.toBeNull();
  });
});

describe('a queue the worker does not know', () => {
  it('retries the whole batch and runs nothing', async () => {
    const error = vi.spyOn(console, 'error');
    const out = await run('swarm-production-send', {
      m1: { type: 'flow_events' },
      m2: { type: 'export', jobId: 'ej_missing' },
    });
    expect(out.retried.sort()).toEqual(['m1', 'm2']);
    expect(out.acked).toEqual([]);
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)).message)).toContain(
      'batch from an unknown queue; retrying',
    );
  });
});
