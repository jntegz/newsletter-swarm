// Phase 6 follow-ups: Dispatches say whether they are Flow emails, the per-Channel flags
// endpoint, and Flow builder steps that are saved before they are set up.
import { env } from 'cloudflare:test';
import { FLAG_KEYS } from '@swarm/flags';
import { newId, type Dispatch, type Flags, type Flow } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { data, errorCode } from './money-helpers';

let owner: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
});

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};

describe('Dispatch kind', () => {
  it('marks Flow emails and their Flow; Broadcast Dispatches are kind broadcast', async () => {
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: owner.cookie,
        body: { name: 'Welcome', trigger: { event: 'confirmed' }, reentry: 'never' },
      }),
      201,
    );
    const email = await data<Dispatch>(
      await call('POST', `/api/v1/flows/${flow.id}/emails`, {
        cookie: owner.cookie,
        body: { subject: 'Hello', content: doc },
      }),
      201,
    );
    const read = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${email.id}`, { cookie: owner.cookie }),
    );
    expect(read.kind).toBe('flow');
    expect(read.flowId).toBe(flow.id);

    const plain = await data<Dispatch>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: owner.cookie,
        body: { subject: 'Weekly' },
      }),
      201,
    );
    expect(plain.kind).toBe('broadcast');
    expect(plain.flowId).toBeNull();
  });
});

describe('GET /api/v1/channels/{channelId}/flags', () => {
  it('resolves every flag for the Channel, most specific scope winning', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
         VALUES (?1, 'smart_blocks', 'workspace', ?2, 1, ?3)`,
      ).bind(newId('featureFlag'), owner.workspaceId, now),
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
         VALUES (?1, 'split_tests', 'workspace', ?2, 1, ?3)`,
      ).bind(newId('featureFlag'), owner.workspaceId, now),
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
         VALUES (?1, 'split_tests', 'channel', ?2, 0, ?3)`,
      ).bind(newId('featureFlag'), channelId, now),
    ]);
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${channelId}`);
    const { flags } = await data<Flags>(
      await call('GET', `/api/v1/channels/${channelId}/flags`, { cookie: viewer.cookie }),
    );
    expect(Object.keys(flags).sort()).toEqual([...FLAG_KEYS].sort());
    expect(flags.smart_blocks).toBe(true);
    expect(flags.split_tests).toBe(false);
    expect(flags.cohort_sampling).toBe(false);
  });

  it('hides Channels outside the operator’s workspaces', async () => {
    const res = await call('GET', `/api/v1/channels/${channelId}/flags`, {
      cookie: outsider.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe('Flow steps not set up yet', () => {
  it('are saved beside the draft, returned, cleared, and block publishing', async () => {
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: owner.cookie,
        body: { name: 'Pending', trigger: { event: 'confirmed' }, reentry: 'never' },
      }),
      201,
    );
    const triggerId = flow.draftGraph.nodes[0]!.id;
    const draftPending = {
      nodes: [{ id: 'tag_1', type: 'add_tag', config: {}, position: { x: 0, y: 120 } }],
      edges: [{ from: triggerId, to: 'tag_1', label: 'default' }],
    };
    const saved = await data<Flow>(
      await call('PATCH', `/api/v1/flows/${flow.id}`, {
        cookie: owner.cookie,
        body: { draftGraph: flow.draftGraph, draftPending },
      }),
    );
    expect(saved.draftPending).toEqual(draftPending);

    // A rename leaves them alone.
    const renamed = await data<Flow>(
      await call('PATCH', `/api/v1/flows/${flow.id}`, {
        cookie: owner.cookie,
        body: { name: 'Pending steps' },
      }),
    );
    expect(renamed.draftPending).toEqual(draftPending);

    const publish = await call('POST', `/api/v1/flows/${flow.id}/publish`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(publish.status).toBe(400);
    expect(await errorCode(publish)).toBe('invalid_input');

    const cleared = await data<Flow>(
      await call('PATCH', `/api/v1/flows/${flow.id}`, {
        cookie: owner.cookie,
        body: { draftPending: { nodes: [], edges: [] } },
      }),
    );
    expect(cleared.draftPending).toBeNull();
  });

  it('refuses an oversized or malformed pending list', async () => {
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: owner.cookie,
        body: { name: 'Bad pending', trigger: { event: 'confirmed' }, reentry: 'never' },
      }),
      201,
    );
    const res = await call('PATCH', `/api/v1/flows/${flow.id}`, {
      cookie: owner.cookie,
      body: { draftPending: { nodes: [{ id: 'x', type: 'not_a_step', config: {} }], edges: [] } },
    });
    expect(res.status).toBe(400);
  });
});
