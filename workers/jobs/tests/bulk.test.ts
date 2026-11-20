import { env } from 'cloudflare:test';
import { InboxRulesSchema, newId, type BulkJob, type FlowGraph } from '@swarm/domain';
import {
  addManualSuppression,
  channelFields,
  readFieldValues,
  saveInboxRules,
} from '@swarm/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBulk } from '../src/handlers/bulk';
import { dispatchId, harness, publishFlow } from './flows-helpers';
import { addField, addMember, count, jobsEnv, one, seedChannel, testFieldVault } from './helpers';

let seed: { workspaceId: string; channelId: string };
let ids: string[];

async function bulkJob(
  action: BulkJob['action'],
  selection: { memberIds: string[] } | { circleId: string },
  params: Record<string, unknown> = {},
): Promise<string> {
  const id = newId('bulkJob');
  await env.DB.prepare(
    `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, params_json, selection_json, total, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`,
  )
    .bind(
      id,
      seed.workspaceId,
      seed.channelId,
      action,
      JSON.stringify(params),
      JSON.stringify(selection),
      Date.now(),
    )
    .run();
  return id;
}

const tagCount = (name: string) =>
  count(
    'SELECT count(*) AS n FROM member_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.channel_id = ?1 AND t.name = ?2',
    seed.channelId,
    name,
  );

beforeEach(async () => {
  seed = await seedChannel();
  ids = [];
  for (let i = 0; i < 5; i++) ids.push(await addMember(seed.channelId, `b${i}@example.com`));
});

describe('bulk actions', () => {
  it('tags and untags a picked set, ignoring Members of other Channels', async () => {
    const other = await seedChannel();
    const stranger = await addMember(other.channelId, 'stranger@example.com');
    const { env: jobs } = jobsEnv();
    const tag = await bulkJob('tag', { memberIds: [...ids.slice(0, 3), stranger] }, { tag: 'VIP' });
    await runBulk(jobs, tag);
    expect(await tagCount('VIP')).toBe(3);
    expect(
      await count('SELECT count(*) AS n FROM member_tags WHERE member_id = ?1', stranger),
    ).toBe(0);
    expect(await one('SELECT status, processed FROM bulk_jobs WHERE id = ?1', tag)).toEqual({
      status: 'done',
      processed: 3,
    });

    const untag = await bulkJob('untag', { memberIds: ids.slice(0, 2) }, { tag: 'vip' });
    await runBulk(jobs, untag);
    expect(await tagCount('VIP')).toBe(1);
  });

  it('sets an encrypted field', async () => {
    await addField(seed.channelId, 'note', 'text', { encrypted: true });
    const { env: jobs } = jobsEnv();
    await runBulk(
      jobs,
      await bulkJob('set_field', { memberIds: ids }, { field: 'note', value: 'hush' }),
    );
    const fields = await channelFields(env.DB, seed.channelId);
    const values = await readFieldValues(env.DB, ids, fields, testFieldVault(fields));
    expect([...values.values()].map((v) => v.note)).toEqual(Array(5).fill('hush'));

    await runBulk(
      jobs,
      await bulkJob('set_field', { memberIds: ids.slice(0, 1) }, { field: 'note', value: null }),
    );
    expect(
      await count('SELECT count(*) AS n FROM member_field_values WHERE member_id = ?1', ids[0]),
    ).toBe(0);
  });

  it('unsubscribes only where an operator may, leaving bounced and complained alone', async () => {
    await env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(ids[0]).run();
    await env.DB.prepare("UPDATE members SET status = 'complained' WHERE id = ?1")
      .bind(ids[1])
      .run();
    await env.DB.prepare("UPDATE members SET status = 'paused', paused_until = 1 WHERE id = ?1")
      .bind(ids[2])
      .run();
    await env.DB.prepare("UPDATE members SET status = 'pending' WHERE id = ?1").bind(ids[3]).run();
    const { env: jobs } = jobsEnv();
    await runBulk(jobs, await bulkJob('unsubscribe', { memberIds: ids }));
    const statuses = await env.DB.prepare(
      'SELECT id, status, paused_until FROM members WHERE id IN (SELECT value FROM json_each(?1))',
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string; status: string; paused_until: number | null }>();
    const byId = new Map(statuses.results.map((r) => [r.id, r]));
    expect(ids.map((id) => byId.get(id)?.status)).toEqual([
      'bounced',
      'complained',
      'unsubscribed',
      'unsubscribed',
      'unsubscribed',
    ]);
    expect(byId.get(ids[2]!)?.paused_until).toBeNull();
  });

  it('deletes a whole Circle in resumable chunks', async () => {
    const circleId = newId('circle');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Lapsed', '{}', 'ready', ?4, ?4)`,
    )
      .bind(circleId, seed.workspaceId, seed.channelId, now)
      .run();
    for (const id of ids.slice(0, 4)) {
      await env.DB.prepare(
        'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 0)',
      )
        .bind(circleId, id)
        .run();
    }
    const { env: jobs, queue } = jobsEnv();
    const job = await bulkJob('delete', { circleId });
    await runBulk(jobs, job, { chunkSize: 3, maxChunks: 1 });
    expect(await one('SELECT status, processed FROM bulk_jobs WHERE id = ?1', job)).toEqual({
      status: 'running',
      processed: 3,
    });
    expect(queue.items).toEqual([{ type: 'bulk', jobId: job }]);

    await runBulk(jobs, job, { chunkSize: 3 });
    expect(await one('SELECT status, processed FROM bulk_jobs WHERE id = ?1', job)).toEqual({
      status: 'done',
      processed: 4,
    });
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', seed.channelId),
    ).toBe(1);

    // A redelivered message after completion does nothing.
    await runBulk(jobs, job);
    expect(await one('SELECT processed FROM bulk_jobs WHERE id = ?1', job)).toEqual({
      processed: 4,
    });
  });

  it('applies a chunk twice without changing the result', async () => {
    const { env: jobs } = jobsEnv();
    const job = await bulkJob('tag', { memberIds: ids }, { tag: 'twice' });
    await runBulk(jobs, job);
    await env.DB.prepare("UPDATE bulk_jobs SET status = 'running', cursor = NULL WHERE id = ?1")
      .bind(job)
      .run();
    await runBulk(jobs, job);
    expect(await tagCount('twice')).toBe(5);
  });
});

describe('adding people to a Flow', () => {
  const graph = (): FlowGraph =>
    ({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId(), audience: 'any' } },
      ],
      edges: [{ from: 'trigger', to: 'mail', label: 'default' }],
    }) as FlowGraph;

  const job = (flowId: string, memberIds: string[]) =>
    bulkJob('flow_enrol', { memberIds }, { flowId });
  const entered = (id: string) =>
    one<{ status: string; processed: number; entered: number; error: string | null }>(
      'SELECT status, processed, entered, error FROM bulk_jobs WHERE id = ?1',
      id,
    );

  it('starts runs only for who the rules let in, as they stand when the job gets there', async () => {
    const flow = await publishFlow(seed, graph());
    await env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`)
      .bind(ids[1])
      .run();
    await addManualSuppression(env.DB, {
      workspaceId: seed.workspaceId,
      channelId: null,
      email: 'b2@example.com',
      now: Date.now(),
    });
    const { env: jobs } = jobsEnv();
    const id = await job(flow.flowId, ids.slice(0, 4));
    await runBulk(jobs, id);
    expect(await entered(id)).toMatchObject({ status: 'done', processed: 4, entered: 2 });
    const runs = await env.DB.prepare(
      'SELECT member_id, context_json FROM flow_runs WHERE flow_id = ?1 ORDER BY member_id',
    )
      .bind(flow.flowId)
      .all<{ member_id: string; context_json: string }>();
    expect(runs.results.map((r) => r.member_id).sort()).toEqual([ids[0], ids[3]].sort());
    expect(JSON.parse(runs.results[0]!.context_json)).toEqual({ addedByJob: id });
  });

  it('starts nobody twice when a chunk is delivered again', async () => {
    const flow = await publishFlow(seed, graph(), { reentry: 'after_exit' });
    const { env: jobs } = jobsEnv();
    const id = await job(flow.flowId, ids);
    await runBulk(jobs, id, { maxChunks: 1, chunkSize: 2 });
    // The runs finish, so only the job's own record could stop a second start.
    await env.DB.prepare(`UPDATE flow_runs SET status = 'completed' WHERE flow_id = ?1`)
      .bind(flow.flowId)
      .run();
    // The cursor move was lost: the same chunk comes again.
    await env.DB.prepare(
      'UPDATE bulk_jobs SET cursor = NULL, processed = 0, entered = 0 WHERE id = ?1',
    )
      .bind(id)
      .run();
    await runBulk(jobs, id);
    expect(await entered(id)).toMatchObject({ status: 'done', processed: 5, entered: 5 });
    expect(await count('SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1', flow.flowId)).toBe(
      5,
    );
  });

  it('stops when the Flow is no longer live', async () => {
    const flow = await publishFlow(seed, graph());
    await env.DB.prepare(`UPDATE flows SET status = 'paused' WHERE id = ?1`)
      .bind(flow.flowId)
      .run();
    const { env: jobs } = jobsEnv();
    const id = await job(flow.flowId, ids);
    await runBulk(jobs, id);
    expect(await entered(id)).toMatchObject({ status: 'failed', entered: 0 });
    expect(await count('SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1', flow.flowId)).toBe(
      0,
    );
  });

  it('holds someone added during quiet hours like anyone else', async () => {
    const start = Date.UTC(2026, 10, 2, 23, 0, 0);
    await saveInboxRules(
      env.DB,
      seed.channelId,
      {
        rules: InboxRulesSchema.parse({
          perDay: null,
          perWeek: null,
          quietHours: { start: '22:00', end: '08:00' },
          newsletterDay: null,
          maxHoldDays: 14,
        }),
        timezone: 'UTC',
      },
      start,
    );
    const flow = await publishFlow(seed, graph());
    const h = harness(start);
    const { env: base } = jobsEnv();
    vi.setSystemTime(start);
    const id = await job(flow.flowId, [ids[0]!]);
    await runBulk({ ...base, JOBS_QUEUE: h.env.JOBS_QUEUE, SEND_QUEUE: h.env.SEND_QUEUE }, id);
    vi.useRealTimers();
    await h.drain();
    expect(await entered(id)).toMatchObject({ status: 'done', entered: 1 });
    expect(h.sends.for(ids[0]!)).toHaveLength(0);
    const hold = await one<{ reason: string; until: number }>(
      'SELECT reason, until FROM flow_holds WHERE member_id = ?1',
      ids[0],
    );
    expect(hold).toEqual({ reason: 'quiet_hours', until: Date.UTC(2026, 10, 3, 8, 0, 0) });
    expect(
      await count('SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1', ids[0]),
    ).toBe(0);
  });
});
