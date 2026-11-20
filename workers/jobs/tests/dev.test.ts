import { env } from 'cloudflare:test';
import { newId, type FlowGraph } from '@swarm/domain';
import { recordMemberEvent } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { DAY, harness, makeTag, publishFlow, runsOf, stepsOf, type Harness } from './flows-helpers';
import { addMember, seedChannel } from './helpers';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** POST /__dev/flows/advance on the jobs app, with this environment name and the harness queues. */
function advance(
  environment: string,
  body: unknown,
  options: { h?: Harness; contentType?: string; method?: string; host?: string } = {},
) {
  const queues = options.h ? { JOBS_QUEUE: options.h.jobs, SEND_QUEUE: options.h.sends } : {};
  // A deployed environment can't use the dev providers, so it gets the real ones' settings.
  const deployed =
    environment === 'development'
      ? {}
      : {
          MAIL_ADAPTER: 'ses',
          AWS_ACCESS_KEY_ID: 'AKIA0000000000000000',
          AWS_SECRET_ACCESS_KEY: 's'.repeat(40),
          SES_CONFIGURATION_SET: 'swarm-staging-transactional',
          WEB_HOSTNAMES: 'off',
          SITE_SCHEME: 'https',
          PAYMENTS: 'off',
          DNS_RESOLVER: 'doh',
          // A local .dev.vars from before the vault may still carry it; a deployed jobs refuses it.
          FIELD_KEYS: undefined,
        };
  const method = options.method ?? 'POST';
  return app.fetch(
    new Request(`http://${options.host ?? 'jobs.test'}/__dev/flows/advance`, {
      method,
      headers: { 'content-type': options.contentType ?? 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    { ...env, ENVIRONMENT: environment, ...deployed, ...queues },
    ctx,
  );
}

const graph = (tagId: string): FlowGraph => ({
  schema: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
    { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 3, unit: 'days' } },
    { id: 'tag', type: 'add_tag', config: { tagId } },
  ],
  edges: [
    { from: 'trigger', to: 'wait', label: 'default' },
    { from: 'wait', to: 'tag', label: 'default' },
  ],
});

describe('dev Flow clock', () => {
  it('is refused outside development and test', async () => {
    const channelId = newId('channel');
    for (const environment of ['staging', 'production']) {
      expect((await advance(environment, { channelId })).status).toBe(404);
    }
    expect((await advance('development', null, { method: 'GET' })).status).toBe(404);
    expect(
      (await advance('development', { channelId }, { contentType: 'text/plain' })).status,
    ).toBe(400);
    expect((await advance('development', { channelId: 'nope' })).status).toBe(400);
  });

  it('is refused in development too, on any host a deployed Worker could be reached on', async () => {
    const channelId = newId('channel');
    for (const host of [
      'swarm-jobs-local.someone.workers.dev',
      'jobs.example.com',
      'localhost.example.com',
      'test.example.org',
    ]) {
      for (const environment of ['development', 'test']) {
        expect((await advance(environment, { channelId }, { host })).status, host).toBe(404);
      }
    }
    // The positive control: a local name reaches the route, which then checks its input.
    for (const host of ['localhost:8793', '127.0.0.1:8793', 'jobs.localhost']) {
      expect((await advance('development', { channelId: 'nope' }, { host })).status, host).toBe(
        400,
      );
    }
  });

  it('enrols from pending events, then runs one Channel’s due steps as of the given time', async () => {
    const seed = await seedChannel();
    const other = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, graph(await makeTag(seed.channelId)));
    const member = await addMember(seed.channelId, `clock-${Date.now()}@example.org`);
    await recordMemberEvent(env.DB, {
      channelId: seed.channelId,
      memberId: member,
      type: 'confirmed',
      payload: { method: 'double_opt_in' },
    });

    const enrolled = await advance('development', { channelId: seed.channelId }, { h });
    expect(await enrolled.json()).toMatchObject({ data: { enrolled: 1 } });
    // The trigger step went to the queue; the consumer runs it on the real clock.
    h.clock.now = Date.now();
    await h.drain();
    let [run] = await runsOf(flow.flowId, member);
    expect([run!.status, run!.current_node_id]).toEqual(['waiting', 'wait']);

    // Another Channel's advance leaves the run alone; this Channel's, three days on, ends the delay.
    const later = Date.now() + 3 * DAY + 60_000;
    await advance('development', { channelId: other.channelId, at: later }, { h });
    expect((await runsOf(flow.flowId, member))[0]!.current_node_id).toBe('wait');
    const res = await advance('development', { channelId: seed.channelId, at: later }, { h });
    expect(await res.json()).toMatchObject({ data: { steps: 1 } });
    [run] = await runsOf(flow.flowId, member);
    expect(run!.current_node_id).toBe('tag');
    expect((await stepsOf(run!.id)).map((s) => [s.node_id, s.status])).toContainEqual([
      'wait',
      'done',
    ]);
  });
});
