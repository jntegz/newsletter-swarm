// Inbox rules through the API: who can read and set them, that nothing is on by default, what a
// publish can ask for, and what stats and run history say. The decisions themselves are tested in
// packages/engine and workers/jobs.
import { env } from 'cloudflare:test';
import { newId, type Dispatch, type Flow, type FlowRun, type FlowStats } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { addMember, data, errorCode } from './money-helpers';

let owner: Session;
let editor: Session;
let author: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;

const path = (id = channelId) => `/api/v1/channels/${id}/inbox-rules`;
const rulesBody = (rules: Record<string, unknown>, timezone: string | null = null) => ({
  rules,
  timezone,
});
const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there.' }] }],
};

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  editor = await seatAs(owner.workspaceId, 'editor');
  author = await seatAs(owner.workspaceId, 'author');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
});

/** A live Flow of one email, and its email's node id. */
async function liveFlow() {
  const flow = await data<Flow>(
    await call('POST', `/api/v1/channels/${channelId}/flows`, {
      cookie: editor.cookie,
      body: { name: 'Rules', trigger: { event: 'api_event', name: 'go' }, reentry: 'never' },
    }),
    201,
  );
  const email = await data<Dispatch>(
    await call('POST', `/api/v1/flows/${flow.id}/emails`, {
      cookie: editor.cookie,
      body: { subject: 'Hello', content: doc },
    }),
    201,
  );
  await call('PATCH', `/api/v1/flows/${flow.id}`, {
    cookie: editor.cookie,
    body: {
      draftGraph: {
        schema: 1,
        nodes: [
          { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
          { id: 'mail', type: 'send_email', config: { dispatchId: email.id, audience: 'any' } },
        ],
        edges: [{ from: 'trigger', to: 'mail', label: 'default' }],
      },
    },
  });
  return flow.id;
}

describe('inbox rule settings', () => {
  it('are all off for a new publication, and anyone with a seat can read them', async () => {
    const fresh = (await createChannel(owner)).id;
    const settings = await data<{
      rules: Record<string, unknown>;
      timezone: string | null;
      heldNow: number;
    }>(await call('GET', path(fresh), { cookie: viewer.cookie }));
    expect(settings).toEqual({
      rules: {
        perDay: null,
        perWeek: null,
        quietHours: null,
        newsletterDay: null,
        maxHoldDays: 14,
      },
      timezone: null,
      heldNow: 0,
    });
  });

  it('need the editor role to change, and stay private to the workspace', async () => {
    const body = rulesBody({ perDay: 2 });
    for (const session of [viewer, author]) {
      const refused = await call('PUT', path(), { cookie: session.cookie, body });
      expect(refused.status).toBe(403);
    }
    expect((await call('GET', path(), { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('PUT', path(), { cookie: outsider.cookie, body })).status).toBe(404);
    const saved = await data<{ rules: { perDay: number } }>(
      await call('PUT', path(), { cookie: editor.cookie, body }),
    );
    expect(saved.rules.perDay).toBe(2);
    await call('PUT', path(), { cookie: editor.cookie, body: rulesBody({}) });
  });

  it('refuse what the rules cannot mean', async () => {
    const put = (body: unknown) => call('PUT', path(), { cookie: editor.cookie, body });
    const zone = await put(rulesBody({}, 'Mars/Olympus'));
    expect(zone.status).toBe(400);
    expect(await errorCode(zone)).toBe('invalid_input');
    for (const rules of [
      { perDay: 0 },
      { perWeek: 100_000 },
      { quietHours: { start: '08:00', end: '08:00' } },
      { quietHours: { start: '8am', end: '09:00' } },
      { newsletterDay: { hoursAround: 500 } },
      { maxHoldDays: 0 },
    ]) {
      expect((await put(rulesBody(rules))).status, JSON.stringify(rules)).toBe(400);
    }
  });

  it('keep the publication’s other settings, and set and clear its time zone', async () => {
    const id = (await createChannel(owner)).id;
    await env.DB.prepare(`UPDATE channels SET settings_json = '{"keep":"me"}' WHERE id = ?1`)
      .bind(id)
      .run();
    const set = await data<{ timezone: string | null }>(
      await call('PUT', path(id), {
        cookie: editor.cookie,
        body: rulesBody({}, 'Europe/Prague'),
      }),
    );
    expect(set.timezone).toBe('Europe/Prague');
    const cleared = await data<{ timezone: string | null }>(
      await call('PUT', path(id), { cookie: editor.cookie, body: rulesBody({}) }),
    );
    expect(cleared.timezone).toBeNull();
    const row = await env.DB.prepare('SELECT settings_json FROM channels WHERE id = ?1')
      .bind(id)
      .first<{ settings_json: string }>();
    expect(JSON.parse(row!.settings_json)).toMatchObject({ keep: 'me' });
  });
});

describe('publishing and repeat sends', () => {
  it('records which email steps may be sent again', async () => {
    const flowId = await liveFlow();
    const publish = (body: Record<string, unknown>) =>
      call('POST', `/api/v1/flows/${flowId}/publish`, { cookie: editor.cookie, body });
    expect((await publish({})).status).toBe(200);
    expect((await publish({ resendNodeIds: ['mail'] })).status).toBe(200);
    const rows = await env.DB.prepare(
      'SELECT version, resend FROM flow_emails WHERE flow_id = ?1 ORDER BY version',
    )
      .bind(flowId)
      .all();
    expect(rows.results).toEqual([
      { version: 1, resend: 0 },
      { version: 2, resend: 1 },
    ]);
  });

  it('refuses a step that sends no email', async () => {
    const flowId = await liveFlow();
    const refused = await call('POST', `/api/v1/flows/${flowId}/publish`, {
      cookie: editor.cookie,
      body: { resendNodeIds: ['trigger'] },
    });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe('invalid_input');
  });
});

describe('what stats and run history say', () => {
  it('counts held emails on the step, and a waiting run says why', async () => {
    const flowId = await liveFlow();
    await call('POST', `/api/v1/flows/${flowId}/publish`, { cookie: editor.cookie, body: {} });
    const member = (await addMember(owner, channelId)).id;
    const now = Date.now();
    const runId = newId('flowRun', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, current_node_id, next_at, context_json, started_at, updated_at)
         VALUES (?1, ?2, 1, ?3, ?4, 'waiting', 'mail', ?5, '{}', ?6, ?6)`,
      ).bind(runId, flowId, channelId, member, now + 3_600_000, now),
      env.DB.prepare(
        `INSERT INTO flow_holds (run_id, node_id, flow_id, version, channel_id, member_id, reason, until, zone, held_at)
         VALUES (?1, 'mail', ?2, 1, ?3, ?4, 'quiet_hours', ?5, 'Europe/Prague', ?6)`,
      ).bind(runId, flowId, channelId, member, now + 3_600_000, now),
    ]);

    const stats = await data<FlowStats>(
      await call('GET', `/api/v1/flows/${flowId}/stats`, { cookie: viewer.cookie }),
    );
    expect(stats.nodes.find((n) => n.nodeId === 'mail')?.held).toEqual({
      now: 1,
      total: 1,
      expired: 0,
    });
    expect(stats.nodes.find((n) => n.nodeId === 'trigger')?.held).toEqual({
      now: 0,
      total: 0,
      expired: 0,
    });

    const list = await data<{ items: FlowRun[] }>(
      await call('GET', `/api/v1/flows/${flowId}/runs`, { cookie: viewer.cookie }),
    );
    expect(list.items[0]?.hold).toMatchObject({ reason: 'quiet_hours', zone: 'Europe/Prague' });
    const detail = await data<FlowRun & { holds: unknown[] }>(
      await call('GET', `/api/v1/flows/${flowId}/runs/${runId}`, { cookie: viewer.cookie }),
    );
    expect(detail.holds).toHaveLength(1);
    expect(detail.hold).toMatchObject({ nodeId: 'mail', outcome: null });
    const settings = await data<{ heldNow: number }>(
      await call('GET', path(), { cookie: viewer.cookie }),
    );
    expect(settings.heldNow).toBe(1);
  });
});
