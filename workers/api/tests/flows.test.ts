import { env } from 'cloudflare:test';
import {
  FLOW_RECIPES,
  FlowGraphSchema,
  newId,
  type Dispatch,
  type Flow,
  type FlowGraph,
  type FlowRun,
  type FlowStats,
  type FlowSummary,
  type MemberFlowHistory,
  type SeatRole,
} from '@swarm/domain';
import {
  addManualSuppression,
  promoteWelcomeSplits,
  runStep,
  type FlowsEnv,
  type JobMessage,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt } from '@swarm/vault/testing';
import { useJobsQueueForTests } from '../src/lib/flows';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { addMember, data, enableFlag, errorCode } from './money-helpers';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

let owner: Session;
let admin: Session;
let editor: Session;
let author: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;
let otherChannelId: string;
let foreignChannelId: string;
let jobs: JobMessage[];

const flowsPath = (id = channelId) => `/api/v1/channels/${id}/flows`;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  otherChannelId = (await createChannel(owner)).id;
  admin = await seatAs(owner.workspaceId, 'admin');
  editor = await seatAs(owner.workspaceId, 'editor');
  author = await seatAs(owner.workspaceId, 'author');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
  foreignChannelId = (await createChannel(outsider)).id;
});

beforeEach(() => {
  jobs = [];
  useJobsQueueForTests({ send: async (message) => void jobs.push(message) });
});

afterAll(() => useJobsQueueForTests(undefined));

async function createFlow(body: Record<string, unknown>, s: Session = editor, ch = channelId) {
  return data<Flow>(await call('POST', flowsPath(ch), { cookie: s.cookie, body }), 201);
}

const blank = (name = 'Onboarding') =>
  createFlow({ name, trigger: { event: 'confirmed' }, reentry: 'never' });

async function patchGraph(flowId: string, graph: unknown, s: Session = editor) {
  return call('PATCH', `/api/v1/flows/${flowId}`, {
    cookie: s.cookie,
    body: { draftGraph: graph },
  });
}

async function flowEmail(flowId: string, subject = 'Hello', s: Session = editor) {
  return data<Dispatch>(
    await call('POST', `/api/v1/flows/${flowId}/emails`, {
      cookie: s.cookie,
      body: { subject, content: doc('Welcome to the Channel.') },
    }),
    201,
  );
}

const publish = (flowId: string, body: Record<string, unknown> = {}, s: Session = editor) =>
  call('POST', `/api/v1/flows/${flowId}/publish`, { cookie: s.cookie, body });

/** trigger(confirmed) → send_email(dispatchId). */
const oneEmail = (dispatchId: string, extra: Partial<FlowGraph> = {}): FlowGraph => ({
  schema: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
    { id: 'mail', type: 'send_email', config: { dispatchId, audience: 'any' } },
    ...(extra.nodes ?? []),
  ],
  edges: [{ from: 'trigger', to: 'mail', label: 'default' }, ...(extra.edges ?? [])],
});

async function insertRow(sql: string, ...params: unknown[]) {
  await env.DB.prepare(sql)
    .bind(...params)
    .run();
}

async function tagIn(ch: string, name = `tag-${crypto.randomUUID().slice(0, 6)}`) {
  const id = newId('tag');
  await insertRow(
    'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)',
    id,
    ch,
    name,
    Date.now(),
  );
  return id;
}

async function circleIn(ch: string, workspaceId: string) {
  const id = newId('circle');
  await insertRow(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Readers', '{"op":"and","children":[]}', ?4, ?4)`,
    id,
    workspaceId,
    ch,
    Date.now(),
  );
  return id;
}

async function levelIn(ch: string) {
  const id = newId('membershipLevel');
  await insertRow(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Gold', ?3, ?3)`,
    id,
    ch,
    Date.now(),
  );
  return id;
}

async function formIn(ch: string, workspaceId: string) {
  const id = newId('captureForm');
  await insertRow(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Form', '{}', ?4, ?4)`,
    id,
    workspaceId,
    ch,
    Date.now(),
  );
  return id;
}

async function insertRun(
  flowId: string,
  version: number,
  memberId: string,
  status: FlowRun['status'],
  options: { test?: boolean; node?: string; reason?: string } = {},
) {
  const id = newId('flowRun');
  const now = Date.now();
  await insertRow(
    `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, exit_reason, current_node_id, test,
       started_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    id,
    flowId,
    version,
    channelId,
    memberId,
    status,
    options.reason ?? null,
    options.node ?? 'trigger',
    options.test ? 1 : 0,
    now,
  );
  return id;
}

async function insertStep(
  runId: string,
  flowId: string,
  version: number,
  nodeId: string,
  status: string,
  outcome: string | null,
) {
  await insertRow(
    `INSERT INTO flow_run_steps (run_id, node_id, attempt, flow_id, version, status, outcome, started_at, finished_at)
     VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?7)`,
    runId,
    nodeId,
    flowId,
    version,
    status,
    outcome,
    Date.now(),
  );
}

// ---------------------------------------------------------------------------------------------

describe('Flow Recipes', () => {
  it('lists every recipe', async () => {
    const list = await data<{ key: string; emailCount: number }[]>(
      await call('GET', '/api/v1/flow-recipes', { cookie: viewer.cookie }),
    );
    expect(list.map((r) => r.key)).toEqual([...FLOW_RECIPES]);
    expect(list.every((r) => r.emailCount > 0)).toBe(true);
    expect((await call('GET', '/api/v1/flow-recipes', { origin: null })).status).toBe(401);
  });

  it('creates a valid, publishable draft with its emails for every recipe', async () => {
    for (const recipe of FLOW_RECIPES) {
      const flow = await createFlow({ recipe });
      expect(flow.recipe).toBe(recipe);
      expect(flow.status).toBe('draft');
      expect(flow.issues, recipe).toEqual([]);
      expect(FlowGraphSchema.safeParse(flow.draftGraph).success, recipe).toBe(true);
      const sends = flow.draftGraph.nodes.filter((n) => n.type === 'send_email');
      expect(flow.emails).toHaveLength(sends.length);
      expect(flow.emails.every((e) => e.nodeIds.length === 1 && e.subject.length > 0)).toBe(true);
      const res = await publish(flow.id);
      expect(res.status, `${recipe}: ${await res.clone().text()}`).toBe(200);
    }
  });

  it('builds the Welcome email as confirmed → A/B split → two variants', async () => {
    const flow = await createFlow({ recipe: 'welcome' });
    expect(flow.name).toBe('Welcome email');
    expect(flow.draftGraph.nodes.map((n) => n.type)).toEqual([
      'trigger',
      'ab_split',
      'send_email',
      'send_email',
    ]);
    const split = flow.draftGraph.nodes.find((n) => n.type === 'ab_split');
    expect(split?.config).toMatchObject({ percentA: 50, autoPromote: { metric: 'opens' } });
  });
});

describe('Flows: create, read, save', () => {
  it('creates a blank Flow with its trigger and lists it with run counts', async () => {
    const flow = await blank('Blank one');
    expect(flow).toMatchObject({
      name: 'Blank one',
      status: 'draft',
      liveVersion: null,
      triggerType: null,
      reentry: 'never',
      issues: [],
      runs: { running: 0, completed: 0 },
    });
    const list = await data<FlowSummary[]>(
      await call('GET', flowsPath(), { cookie: viewer.cookie }),
    );
    expect(list.some((f) => f.id === flow.id)).toBe(true);
    const drafts = await data<FlowSummary[]>(
      await call('GET', `${flowsPath()}?status=live`, { cookie: viewer.cookie }),
    );
    expect(drafts.some((f) => f.id === flow.id)).toBe(false);
  });

  it('validates create input', async () => {
    const bad = [
      {},
      { name: 'x' },
      { recipe: 'welcome', trigger: { event: 'confirmed' } },
      { recipe: 'nope' },
      { name: '', trigger: { event: 'confirmed' } },
      { name: 'x'.repeat(81), trigger: { event: 'confirmed' } },
      { name: 'x', trigger: { event: 'unengaged', days: 2 } },
      { name: 'x', trigger: { event: 'confirmed' }, reentry: 'always' },
    ];
    for (const body of bad) {
      const res = await call('POST', flowsPath(), { cookie: editor.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a trigger that points at another Channel', async () => {
    const form = await formIn(foreignChannelId, outsider.workspaceId);
    const res = await call('POST', flowsPath(), {
      cookie: editor.cookie,
      body: { name: 'x', trigger: { event: 'confirmed', formId: form } },
    });
    expect(res.status).toBe(400);
  });

  it('saves a draft with structural issues and returns them', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    const graph = oneEmail(email.id, {
      nodes: [{ id: 'orphan', type: 'exit', config: {} }],
    });
    const saved = await data<Flow>(await patchGraph(flow.id, graph));
    expect(saved.issues).toEqual([
      expect.objectContaining({ code: 'unreachable', nodeId: 'orphan' }),
    ]);
    // Publishing needs a clean graph.
    const res = await publish(flow.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { path: string }[] } };
    expect(body.error.details).toContainEqual(expect.objectContaining({ path: 'nodes.orphan' }));
  });

  it('refuses malformed graphs', async () => {
    const flow = await blank();
    const bad = [
      { schema: 2, nodes: [], edges: [] },
      { schema: 1, nodes: [{ id: 'has space', type: 'exit', config: {} }], edges: [] },
      { schema: 1, nodes: [{ id: 't', type: 'teleport', config: {} }], edges: [] },
      {
        schema: 1,
        nodes: [{ id: 't', type: 'trigger', config: { event: 'confirmed' } }],
        edges: [{ from: 't', to: 'x', label: 'sideways' }],
      },
    ];
    for (const graph of bad) {
      expect((await patchGraph(flow.id, graph)).status, JSON.stringify(graph)).toBe(400);
    }
  });

  it('refuses references outside the Flow’s Channel at save (the legacy defect)', async () => {
    const flow = await blank();
    const own = await flowEmail(flow.id);
    const foreignTag = await tagIn(foreignChannelId);
    const siblingTag = await tagIn(otherChannelId);
    const foreignCircle = await circleIn(foreignChannelId, outsider.workspaceId);
    const foreignLevel = await levelIn(foreignChannelId);
    const foreignForm = await formIn(otherChannelId, owner.workspaceId);
    const broadcastDispatch = await data<Dispatch>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: editor.cookie,
        body: { subject: 'Regular', content: doc('Hi') },
      }),
      201,
    );
    const otherFlow = await blank('Other');
    const otherFlowsEmail = await flowEmail(otherFlow.id);
    const withNode = (node: Record<string, unknown>) =>
      oneEmail(own.id, {
        nodes: [{ id: 'x', ...node } as FlowGraph['nodes'][number]],
        edges: [{ from: 'mail', to: 'x', label: 'default' }],
      });
    const cases: [string, unknown][] = [
      ['foreign tag', withNode({ type: 'add_tag', config: { tagId: foreignTag } })],
      ['sibling Channel tag', withNode({ type: 'remove_tag', config: { tagId: siblingTag } })],
      [
        'foreign level',
        withNode({ type: 'change_level', config: { action: 'revoke', levelId: foreignLevel } }),
      ],
      ['self enrol', withNode({ type: 'enrol_flow', config: { flowId: flow.id } })],
      [
        'foreign Circle trigger',
        {
          schema: 1,
          nodes: [
            {
              id: 'trigger',
              type: 'trigger',
              config: { event: 'circle_entered', circleId: foreignCircle },
            },
          ],
          edges: [],
        },
      ],
      [
        'form in a sibling Channel',
        {
          schema: 1,
          nodes: [
            { id: 'trigger', type: 'trigger', config: { event: 'confirmed', formId: foreignForm } },
          ],
          edges: [],
        },
      ],
      ['a Broadcast Dispatch as a Flow email', oneEmail(broadcastDispatch.id)],
      ['another Flow’s email', oneEmail(otherFlowsEmail.id)],
    ];
    for (const [name, graph] of cases) {
      const res = await patchGraph(flow.id, graph);
      expect(res.status, name).toBe(400);
      expect(await errorCode(res)).toBe('invalid_input');
    }
    // The draft was never changed.
    const current = await data<Flow>(
      await call('GET', `/api/v1/flows/${flow.id}`, { cookie: viewer.cookie }),
    );
    expect(current.draftGraph.nodes).toHaveLength(1);
  });

  it('takes Roster triggers only with the rosters flag and a Roster of the Channel', async () => {
    const ch = (await createChannel(owner)).id;
    const rosterIn = async (channel: string) => {
      const id = newId('roster');
      await insertRow(
        `INSERT INTO rosters (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)`,
        id,
        channel,
        `Roster ${id.slice(-6)}`,
      );
      return id;
    };
    const own = await rosterIn(ch);
    const sibling = await rosterIn(otherChannelId);
    const trigger = (event: string, rosterId: string) => ({
      name: 'Roster',
      trigger: { event, rosterId },
    });
    const create = (body: Record<string, unknown>) =>
      call('POST', flowsPath(ch), { cookie: editor.cookie, body });

    // Flag off: refused, even for the Channel's own Roster.
    const off = await create(trigger('roster_joined', own));
    expect(off.status).toBe(400);
    expect(JSON.stringify(await off.json())).toContain('Rosters are turned off');

    await enableFlag('rosters', owner.workspaceId, ch);
    expect((await create(trigger('roster_left', sibling))).status).toBe(400);
    const flow = await data<Flow>(await create(trigger('roster_joined', own)), 201);
    expect(flow.draftGraph.nodes[0]!.config).toMatchObject({
      event: 'roster_joined',
      rosterId: own,
    });
  });

  it('re-checks references at publish', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    const tag = await tagIn(channelId);
    const graph = oneEmail(email.id, {
      nodes: [{ id: 'tag', type: 'add_tag', config: { tagId: tag } }],
      edges: [{ from: 'mail', to: 'tag', label: 'default' }],
    });
    await data<Flow>(await patchGraph(flow.id, graph));
    await insertRow('DELETE FROM tags WHERE id = ?1', tag);
    const res = await publish(flow.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { path: string }[] } };
    expect(body.error.details).toContainEqual(expect.objectContaining({ path: 'nodes.tag' }));
  });

  it('updates name, description and re-entry', async () => {
    const flow = await blank();
    const saved = await data<Flow>(
      await call('PATCH', `/api/v1/flows/${flow.id}`, {
        cookie: editor.cookie,
        body: { name: 'Renamed', description: 'About it', reentry: 'after_exit' },
      }),
    );
    expect(saved).toMatchObject({
      name: 'Renamed',
      description: 'About it',
      reentry: 'after_exit',
    });
    for (const body of [{}, { name: '' }, { description: 'x'.repeat(281) }]) {
      const res = await call('PATCH', `/api/v1/flows/${flow.id}`, { cookie: editor.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('deletes a never-published Flow', async () => {
    const flow = await blank();
    const res = await call('DELETE', `/api/v1/flows/${flow.id}`, { cookie: editor.cookie });
    expect(res.status).toBe(204);
    expect((await call('GET', `/api/v1/flows/${flow.id}`, { cookie: editor.cookie })).status).toBe(
      404,
    );
  });
});

describe('Flow emails and the Dispatch editor', () => {
  it('creates Flow emails that the editor edits but never sends, schedules or publishes', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id, 'First');
    expect(email.webVisibility).toBe('hidden');
    const saved = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${email.id}`, {
        cookie: editor.cookie,
        body: { subject: 'Edited' },
      }),
    );
    expect(saved.subject).toBe('Edited');
    for (const [method, path, body] of [
      ['POST', 'send', undefined],
      ['POST', 'schedule', { publishAt: new Date(Date.now() + 3_600_000).toISOString() }],
      ['POST', 'publish-web', undefined],
    ] as const) {
      const res = await call(method, `/api/v1/dispatches/${email.id}/${path}`, {
        cookie: owner.cookie,
        ...(body ? { body } : {}),
      });
      expect(res.status, path).toBe(409);
    }
    const web = await call('PATCH', `/api/v1/dispatches/${email.id}`, {
      cookie: owner.cookie,
      body: { webVisibility: 'public' },
    });
    expect(web.status).toBe(409);
    const list = await data<{ id: string }[]>(
      await call('GET', `/api/v1/channels/${channelId}/dispatches`, { cookie: owner.cookie }),
    );
    expect(list.some((d) => d.id === email.id)).toBe(false);
    const emails = await data<{ dispatchId: string }[]>(
      await call('GET', `/api/v1/flows/${flow.id}/emails`, { cookie: viewer.cookie }),
    );
    expect(emails.map((e) => e.dispatchId)).toEqual([email.id]);
  });
});

describe('Publishing', () => {
  it('creates a version, a Flow Broadcast per email step and flow_emails', async () => {
    const flow = await createFlow({ recipe: 'welcome' });
    const result = await data<{
      version: number;
      flow: Flow;
      emails: { nodeId: string; broadcastId: string; dispatchId: string }[];
    }>(await publish(flow.id));
    expect(result.version).toBe(1);
    expect(result.flow).toMatchObject({ status: 'live', liveVersion: 1, triggerType: 'confirmed' });
    expect(result.emails.map((e) => e.nodeId).sort()).toEqual(['welcome_a', 'welcome_b']);
    for (const email of result.emails) {
      const b = await env.DB.prepare(
        'SELECT kind, status, flow_id, dispatch_id, html FROM broadcasts WHERE id = ?1',
      )
        .bind(email.broadcastId)
        .first<{
          kind: string;
          status: string;
          flow_id: string;
          dispatch_id: string;
          html: string;
        }>();
      expect(b).toMatchObject({
        kind: 'flow',
        status: 'sending',
        flow_id: flow.id,
        dispatch_id: email.dispatchId,
      });
      expect(b!.html).toContain('{{@unsubscribe}}');
    }
    const rows = await env.DB.prepare(
      'SELECT node_id FROM flow_emails WHERE flow_id = ?1 AND version = 1 ORDER BY node_id',
    )
      .bind(flow.id)
      .all<{ node_id: string }>();
    expect(rows.results.map((r) => r.node_id)).toEqual(['welcome_a', 'welcome_b']);
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1 AND action = 'flow.published'`,
    )
      .bind(flow.id)
      .first();
    expect(audit).not.toBeNull();
  });

  it('refuses an email that is not ready to send', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id, '');
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    const res = await publish(flow.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { path: string }[] } };
    expect(body.error.details).toContainEqual(expect.objectContaining({ path: 'nodes.mail' }));
  });

  it('pins open runs to their version when a new one is published', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    const v1 = await data<{ version: number; emails: { broadcastId: string }[] }>(
      await publish(flow.id),
    );
    const member = await addMember(owner, channelId);
    const runId = await insertRun(flow.id, 1, member.id, 'waiting', { node: 'mail' });
    const v2 = await data<{ version: number; flow: Flow }>(await publish(flow.id));
    expect(v2.version).toBe(2);
    expect(v2.flow.versions.map((v) => [v.version, v.retiredAt === null])).toEqual([
      [2, true],
      [1, false],
    ]);
    const pinned = await env.DB.prepare('SELECT version, status FROM flow_runs WHERE id = ?1')
      .bind(runId)
      .first();
    expect(pinned).toEqual({ version: 1, status: 'waiting' });
    // v1's email stays open while a run can still send it…
    const status = async () =>
      (
        await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
          .bind(v1.emails[0]!.broadcastId)
          .first<{ status: string }>()
      )?.status;
    expect(await status()).toBe('sending');
    // …and closes once the last run on it has ended.
    await data(
      await call('POST', `/api/v1/flows/${flow.id}/runs/${runId}/exit`, { cookie: editor.cookie }),
    );
    await data(await publish(flow.id));
    expect(await status()).toBe('sent');
  });

  it('moves open runs to the new version when asked', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    await data(await publish(flow.id));
    const member = await addMember(owner, channelId);
    const runId = await insertRun(flow.id, 1, member.id, 'waiting', { node: 'mail' });
    const res = await publish(flow.id, { migrateRuns: true });
    expect(res.status).toBe(200);
    const run = await env.DB.prepare('SELECT version FROM flow_runs WHERE id = ?1')
      .bind(runId)
      .first<{ version: number }>();
    expect(run?.version).toBe(2);
  });
});

describe('Lifecycle', () => {
  it('pauses, resumes and archives', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    expect(
      (await call('POST', `/api/v1/flows/${flow.id}/pause`, { cookie: editor.cookie })).status,
    ).toBe(409);
    await data(await publish(flow.id));
    const member = await addMember(owner, channelId);
    const runId = await insertRun(flow.id, 1, member.id, 'waiting', { node: 'mail' });

    const paused = await data<Flow>(
      await call('POST', `/api/v1/flows/${flow.id}/pause`, { cookie: editor.cookie }),
    );
    expect(paused.status).toBe('paused');
    // Runs stay where they are.
    const run = await env.DB.prepare('SELECT status FROM flow_runs WHERE id = ?1')
      .bind(runId)
      .first();
    expect(run).toEqual({ status: 'waiting' });
    expect(
      (await call('POST', `/api/v1/flows/${flow.id}/pause`, { cookie: editor.cookie })).status,
    ).toBe(409);
    const resumed = await data<Flow>(
      await call('POST', `/api/v1/flows/${flow.id}/resume`, { cookie: editor.cookie }),
    );
    expect(resumed.status).toBe('live');

    const archived = await data<Flow>(
      await call('POST', `/api/v1/flows/${flow.id}/archive`, { cookie: editor.cookie }),
    );
    expect(archived.status).toBe('archived');
    const ended = await env.DB.prepare('SELECT status, exit_reason FROM flow_runs WHERE id = ?1')
      .bind(runId)
      .first();
    expect(ended).toEqual({ status: 'exited', exit_reason: 'flow_archived' });
    const open = await env.DB.prepare(
      `SELECT count(*) AS n FROM broadcasts WHERE flow_id = ?1 AND status = 'sending'`,
    )
      .bind(flow.id)
      .first<{ n: number }>();
    expect(open?.n).toBe(0);
    expect((await patchGraph(flow.id, oneEmail(email.id))).status).toBe(409);
    expect((await publish(flow.id)).status).toBe(409);
    const actions = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1 ORDER BY seq`,
    )
      .bind(flow.id)
      .all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual(
      expect.arrayContaining(['flow.paused', 'flow.resumed', 'flow.archived']),
    );
    expect(
      (await call('DELETE', `/api/v1/flows/${flow.id}`, { cookie: editor.cookie })).status,
    ).toBe(204);
  });

  it('rotates the webhook secret for admins only and stores it sealed', async () => {
    const flow = await blank();
    const path = `/api/v1/flows/${flow.id}/webhook-secret`;
    expect((await call('POST', path, { cookie: editor.cookie })).status).toBe(403);
    const { secret } = await data<{ secret: string }>(
      await call('POST', path, { cookie: admin.cookie }),
    );
    expect(secret).toMatch(/^whsec_/);
    const row = await env.DB.prepare('SELECT webhook_secret_enc FROM flows WHERE id = ?1')
      .bind(flow.id)
      .first<{ webhook_secret_enc: string }>();
    expect(row!.webhook_secret_enc).not.toContain(secret);
    expect(await decrypt(parseKeyring(`f1:${'f'.repeat(64)}`), row!.webhook_secret_enc)).toBe(
      secret,
    );
    const read = await data<Flow>(
      await call('GET', `/api/v1/flows/${flow.id}`, { cookie: viewer.cookie }),
    );
    expect(read.webhookSecretSet).toBe(true);
    expect(JSON.stringify(read)).not.toContain(secret);
  });
});

describe('Runs', () => {
  it('starts a test run on the live version and queues its first step', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    const member = await addMember(owner, channelId);
    const testRun = (memberId: string) =>
      call('POST', `/api/v1/flows/${flow.id}/test-run`, {
        cookie: editor.cookie,
        body: { memberId },
      });
    expect((await testRun(member.id)).status).toBe(409); // not published yet
    await data(await publish(flow.id));
    const run = await data<FlowRun>(await testRun(member.id), 202);
    expect(run).toMatchObject({
      flowId: flow.id,
      version: 1,
      memberId: member.id,
      status: 'running',
      currentNodeId: 'trigger',
      test: true,
    });
    expect(jobs).toEqual([{ type: 'flow_step', runId: run.id, nodeId: 'trigger', attempt: 1 }]);
    // One open run per Member and Flow.
    expect((await testRun(member.id)).status).toBe(409);
    // Members of other Channels are refused.
    const stranger = await addMember(owner, otherChannelId);
    expect((await testRun(stranger.id)).status).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/flows/${flow.id}/test-run`, {
          cookie: viewer.cookie,
          body: { memberId: member.id },
        })
      ).status,
    ).toBe(403);
  });

  it('lists runs with paging and a status filter, shows steps and exits a run', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await data<Flow>(await patchGraph(flow.id, oneEmail(email.id)));
    await data(await publish(flow.id));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const member = await addMember(owner, channelId);
      ids.push(await insertRun(flow.id, 1, member.id, i === 0 ? 'completed' : 'waiting'));
    }
    await insertStep(ids[0]!, flow.id, 1, 'trigger', 'done', 'default');
    const page1 = await data<{ items: FlowRun[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/flows/${flow.id}/runs?limit=2`, { cookie: viewer.cookie }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await data<{ items: FlowRun[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/flows/${flow.id}/runs?limit=2&cursor=${page1.nextCursor}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((r) => r.id))).toEqual(new Set(ids));
    const waiting = await data<{ items: FlowRun[] }>(
      await call('GET', `/api/v1/flows/${flow.id}/runs?status=waiting`, { cookie: viewer.cookie }),
    );
    expect(waiting.items.map((r) => r.status)).toEqual(['waiting', 'waiting']);
    expect(
      (await call('GET', `/api/v1/flows/${flow.id}/runs?status=lost`, { cookie: viewer.cookie }))
        .status,
    ).toBe(400);

    const detail = await data<{
      steps: { nodeId: string; outcome: string }[];
      memberEmail: string;
    }>(await call('GET', `/api/v1/flows/${flow.id}/runs/${ids[0]}`, { cookie: viewer.cookie }));
    expect(detail.steps).toEqual([
      expect.objectContaining({ nodeId: 'trigger', outcome: 'default' }),
    ]);
    expect(detail.memberEmail).toContain('@');

    const exitPath = `/api/v1/flows/${flow.id}/runs/${ids[1]}/exit`;
    expect((await call('POST', exitPath, { cookie: viewer.cookie })).status).toBe(403);
    const exited = await data<FlowRun>(await call('POST', exitPath, { cookie: editor.cookie }));
    expect(exited).toMatchObject({ status: 'exited', exitReason: 'operator' });
    expect((await call('POST', exitPath, { cookie: editor.cookie })).status).toBe(409);
    // A run of another Flow is not found under this one.
    const other = await blank();
    expect(
      (await call('GET', `/api/v1/flows/${other.id}/runs/${ids[0]}`, { cookie: viewer.cookie }))
        .status,
    ).toBe(404);
  });
});

describe('Stats', () => {
  it('aggregates per node and per edge, without test runs', async () => {
    const flow = await createFlow({ recipe: 'welcome' });
    await data(await publish(flow.id));
    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const member = await addMember(owner, channelId);
      const test = i === 3;
      runs.push(
        await insertRun(
          flow.id,
          1,
          member.id,
          i === 2 ? 'exited' : 'completed',
          i === 2 ? { node: 'welcome_b', reason: 'suppressed' } : { test },
        ),
      );
    }
    const [r1, r2, r3, rTest] = runs as [string, string, string, string];
    for (const r of [r1, r2, r3, rTest])
      await insertStep(r, flow.id, 1, 'trigger', 'done', 'default');
    await insertStep(r1, flow.id, 1, 'split', 'done', 'a');
    await insertStep(r2, flow.id, 1, 'split', 'done', 'a');
    await insertStep(r3, flow.id, 1, 'split', 'done', 'b');
    await insertStep(rTest, flow.id, 1, 'split', 'done', 'b');
    await insertStep(r1, flow.id, 1, 'welcome_a', 'done', 'default');
    await insertStep(r2, flow.id, 1, 'welcome_a', 'done', 'default');
    await insertStep(r3, flow.id, 1, 'welcome_b', 'failed', null);

    const stats = await data<FlowStats>(
      await call('GET', `/api/v1/flows/${flow.id}/stats`, { cookie: viewer.cookie }),
    );
    expect(stats.version).toBe(1);
    const node = (id: string) => stats.nodes.find((n) => n.nodeId === id)!;
    expect(node('trigger')).toMatchObject({ entered: 3, completed: 3, exited: 0, failed: 0 });
    expect(node('split')).toMatchObject({ entered: 3, completed: 3 });
    expect(node('welcome_a')).toMatchObject({ entered: 2, completed: 2, failed: 0 });
    expect(node('welcome_b')).toMatchObject({ entered: 1, completed: 0, exited: 1, failed: 1 });
    expect(node('welcome_a').email).toMatchObject({ sent: 0, delivered: 0 });
    expect(node('welcome_a').email?.broadcastId).toMatch(/^bc_/);
    expect(node('split').email).toBeNull();
    const edge = (from: string, label: string) =>
      stats.edges.find((e) => e.from === from && e.label === label)!;
    expect(edge('split', 'a')).toMatchObject({ to: 'welcome_a', runs: 2 });
    expect(edge('split', 'b')).toMatchObject({ to: 'welcome_b', runs: 1 });
    expect(edge('split', 'a').dropOff).toBeCloseTo(1 / 3, 3);
    expect(edge('trigger', 'default')).toMatchObject({ runs: 3, dropOff: 0 });

    const none = await data<FlowStats>(
      await call('GET', `/api/v1/flows/${(await blank()).id}/stats`, { cookie: viewer.cookie }),
    );
    expect(none).toEqual({ version: null, triggers: [], nodes: [], edges: [] });
    expect(
      (await call('GET', `/api/v1/flows/${flow.id}/stats?version=9`, { cookie: viewer.cookie }))
        .status,
    ).toBe(404);
  });

  it('leaves test sends out of an email’s numbers, including ones sent before the fix', async () => {
    const flow = await createFlow({ recipe: 'welcome' });
    const published = await data<{ emails: { nodeId: string; broadcastId: string }[] }>(
      await publish(flow.id),
    );
    const broadcastId = published.emails.find((e) => e.nodeId === 'welcome_a')!.broadcastId;
    const now = Date.now();
    const send = async (test: boolean) => {
      const member = await addMember(owner, channelId);
      const run = await insertRun(flow.id, 1, member.id, 'completed', { test });
      await insertRow(
        `INSERT INTO flow_run_steps (run_id, node_id, attempt, flow_id, version, status, outcome, result_json, started_at, finished_at)
         VALUES (?1, 'welcome_a', 1, ?2, 1, 'done', 'default', ?3, ?4, ?4)`,
        run,
        flow.id,
        JSON.stringify({ broadcastId }),
        now,
      );
      const delivery = newId('delivery', now);
      await insertRow(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?6, ?6)`,
        delivery,
        broadcastId,
        channelId,
        member.id,
        member.email,
        now,
      );
      return delivery;
    };
    await send(false);
    const testDelivery = await send(true);
    const link = newId('linkTarget', now);
    await insertRow(
      `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://example.com/a', 90)`,
      link,
      broadcastId,
    );
    await insertRow(
      `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, created_at)
       VALUES (?1, ?2, ?3, ?4, 'human', ?5)`,
      newId('click', now),
      testDelivery,
      broadcastId,
      link,
      now,
    );

    const stats = await data<FlowStats>(
      await call('GET', `/api/v1/flows/${flow.id}/stats`, { cookie: viewer.cookie }),
    );
    const email = stats.nodes.find((n) => n.nodeId === 'welcome_a')!.email!;
    expect(email).toMatchObject({ sent: 1, delivered: 1, uniqueOpens: 1, humanOpens: 1 });
    expect(email.links.find((l) => l.position === 90)).toMatchObject({ clicks: 0, humanClicks: 0 });
  });
});

describe('Several start events', () => {
  async function twoStarts() {
    const flow = await blank('Two starts');
    const tagId = await tagIn(channelId);
    const email = await flowEmail(flow.id);
    const graph = {
      schema: 1,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          config: {
            event: 'confirmed',
            alsoStartOn: [{ event: 'tag_added', tagId }, { event: 'referral_succeeded' }],
          },
        },
        { id: 'mail', type: 'send_email', config: { dispatchId: email.id } },
      ],
      edges: [{ from: 'trigger', to: 'mail' }],
    };
    return { flow, graph, tagId };
  }

  it('publishes, lists the event types and counts runs per start event', async () => {
    const { flow, graph, tagId } = await twoStarts();
    const saved = await data<Flow>(await patchGraph(flow.id, graph));
    expect(saved.issues).toEqual([]);
    expect(saved.triggerTypes).toEqual([]);
    const published = await data<{ flow: Flow }>(await publish(flow.id));
    expect(published.flow.triggerType).toBe('confirmed');
    expect(published.flow.triggerTypes).toEqual(['confirmed', 'tag_added', 'referral_succeeded']);
    expect(published.flow.versions[0]?.triggerTypes).toEqual([
      'confirmed',
      'tag_added',
      'referral_succeeded',
    ]);

    const member = await addMember(owner, channelId);
    const other = await addMember(owner, channelId);
    const old = await addMember(owner, channelId);
    const start = (index: number | undefined, type: string, payload = {}) =>
      JSON.stringify({
        trigger: { type, payload, seq: 1, ...(index === undefined ? {} : { index }) },
      });
    const runA = await insertRun(flow.id, 1, member.id, 'completed');
    const runB = await insertRun(flow.id, 1, other.id, 'completed');
    // A run from before start events had an index counts as the first.
    const runOld = await insertRun(flow.id, 1, old.id, 'completed');
    await env.DB.batch([
      env.DB.prepare('UPDATE flow_runs SET context_json = ?1 WHERE id = ?2').bind(
        start(1, 'tag_added', { tagId, secret: 'x' }),
        runA,
      ),
      env.DB.prepare('UPDATE flow_runs SET context_json = ?1 WHERE id = ?2').bind(
        start(2, 'referral_succeeded'),
        runB,
      ),
      env.DB.prepare('UPDATE flow_runs SET context_json = ?1 WHERE id = ?2').bind(
        start(undefined, 'confirmed'),
        runOld,
      ),
    ]);

    const stats = await data<FlowStats>(
      await call('GET', `/api/v1/flows/${flow.id}/stats`, { cookie: viewer.cookie }),
    );
    expect(stats.triggers.map((t) => [t.index, t.config.event, t.runs])).toEqual([
      [0, 'confirmed', 1],
      [1, 'tag_added', 1],
      [2, 'referral_succeeded', 1],
    ]);

    const page = await data<{ items: FlowRun[] }>(
      await call('GET', `/api/v1/flows/${flow.id}/runs`, { cookie: viewer.cookie }),
    );
    const startedBy = page.items.find((r) => r.id === runA)?.startedBy;
    // Only what a trigger selects on leaves the context.
    expect(startedBy).toEqual({ index: 1, event: 'tag_added', details: { tagId } });
  });

  it('refuses two identical start events at publish, and a foreign reference on save', async () => {
    const { flow, graph, tagId } = await twoStarts();
    const twice = structuredClone(graph);
    twice.nodes[0]!.config = {
      event: 'tag_added',
      tagId,
      alsoStartOn: [{ event: 'tag_added', tagId }],
    } as never;
    const saved = await data<Flow>(await patchGraph(flow.id, twice));
    expect(saved.issues.map((i) => i.code)).toContain('duplicate_trigger');
    expect((await publish(flow.id)).status).toBe(400);

    const foreign = structuredClone(graph);
    foreign.nodes[0]!.config = {
      event: 'confirmed',
      alsoStartOn: [{ event: 'tag_added', tagId: await tagIn(otherChannelId) }],
    } as never;
    expect((await patchGraph(flow.id, foreign)).status).toBe(400);
  });

  it('refuses a milestone from another publication', async () => {
    const flow = await blank('Milestone');
    const graph = (milestoneId: string) => ({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'referral_milestone', milestoneId } },
      ],
      edges: [],
    });
    const mine = newId('championMilestone');
    const theirs = newId('championMilestone');
    await env.DB.batch(
      [
        [mine, channelId],
        [theirs, otherChannelId],
      ].map(([id, ch]) =>
        env.DB.prepare(
          `INSERT INTO champion_milestones (id, channel_id, name, referrals_required, status, created_at, updated_at)
           VALUES (?1, ?2, 'Five', 5, 'active', 0, 0)`,
        ).bind(id!, ch!),
      ),
    );
    expect((await patchGraph(flow.id, graph(mine))).status).toBe(200);
    expect((await patchGraph(flow.id, graph(theirs))).status).toBe(400);
  });
});

describe('A Member’s automations', () => {
  it('lists every live Flow to anyone who can read the Member, and nobody else', async () => {
    const live = await createFlow({ recipe: 'welcome', name: 'A live one' });
    await data(await publish(live.id));
    await blank('A draft one');
    const member = await addMember(owner, channelId);
    await env.DB.prepare(
      `INSERT INTO flow_enrol_decisions (member_id, flow_id, version, reason, trigger_event, decided_at)
       VALUES (?1, ?2, 1, 'not_in_segment', 'confirmed', ?3)`,
    )
      .bind(member.id, live.id, Date.parse('2026-05-03T10:00:00Z'))
      .run();

    const path = `/api/v1/members/${member.id}/flows`;
    const items = await data<MemberFlowHistory[]>(
      await call('GET', path, { cookie: viewer.cookie }),
    );
    expect(items.map((i) => i.flowName)).toContain('A live one');
    expect(items.map((i) => i.flowName)).not.toContain('A draft one');
    expect(items.find((i) => i.flowId === live.id)).toEqual({
      flowId: live.id,
      flowName: 'A live one',
      run: null,
      decision: {
        reason: 'not_in_segment',
        version: 1,
        event: 'confirmed',
        decidedAt: '2026-05-03T10:00:00.000Z',
      },
    });
    expect((await call('GET', path, { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('GET', path)).status).toBe(401);
  });
});

describe('Rehearse', () => {
  /** A live Flow, its one email reading "Hello {{first_name}}", and one active Member. */
  async function liveFlow() {
    const flow = await blank();
    const email = await flowEmail(flow.id, 'Hello there');
    expect((await patchGraph(flow.id, oneEmail(email.id))).status).toBe(200);
    expect((await publish(flow.id)).status).toBe(200);
    const member = await addMember(owner, channelId);
    return { flow, email, member };
  }
  const rehearse = (flowId: string, body: Record<string, unknown>, s: Session = editor) =>
    call('POST', `/api/v1/flows/${flowId}/rehearse`, { cookie: s.cookie, body });

  it('says what the live version would do, and writes nothing', async () => {
    const { flow, member } = await liveFlow();
    const rows = () =>
      env.DB.prepare(
        `SELECT (SELECT count(*) FROM flow_runs WHERE flow_id = ?1) AS runs,
                (SELECT count(*) FROM flow_run_steps WHERE flow_id = ?1) AS steps,
                (SELECT count(*) FROM broadcast_recipients WHERE member_id = ?2) AS recipients,
                (SELECT count(*) FROM audit_events WHERE target_id = ?1) AS audit`,
      )
        .bind(flow.id, member.id)
        .first();
    const before = await rows();
    const queued = jobs.length;
    const result = await data<{
      source: string;
      version: number;
      people: {
        entry: { allowed: boolean };
        steps: { nodeId: string; outcome: string; detail: { kind: string; subject?: string } }[];
        end: { status: string };
      }[];
    }>(await rehearse(flow.id, { source: 'live', memberId: member.id }));
    expect(result).toMatchObject({ source: 'live', version: 1 });
    expect(result.people).toHaveLength(1);
    expect(result.people[0]!.entry.allowed).toBe(true);
    expect(result.people[0]!.steps.map((step) => step.nodeId)).toEqual(['trigger', 'mail']);
    expect(result.people[0]!.steps[1]!.detail).toMatchObject({
      kind: 'email',
      state: 'would_send',
      subject: 'Hello there',
    });
    expect(result.people[0]!.end.status).toBe('completed');
    expect(await rows()).toEqual(before);
    expect(jobs.length).toBe(queued);
  });

  it('rehearses a draft that has never been published', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id, 'A draft');
    await patchGraph(flow.id, oneEmail(email.id));
    const member = await addMember(owner, channelId);
    const result = await data<{
      flowStatus: string;
      people: { steps: { detail: { subject?: string } }[] }[];
    }>(await rehearse(flow.id, { source: 'draft', memberId: member.id }));
    expect(result.flowStatus).toBe('draft');
    expect(result.people[0]!.steps[1]!.detail.subject).toBe('A draft');
    expect((await rehearse(flow.id, { source: 'live', memberId: member.id })).status).toBe(409);
  });

  it('is for editors and up, and keeps to the Channel', async () => {
    const { flow, member } = await liveFlow();
    const body = { source: 'live', memberId: member.id };
    expect((await rehearse(flow.id, body, author)).status).toBe(403);
    expect((await rehearse(flow.id, body, viewer)).status).toBe(403);
    expect((await rehearse(flow.id, body, outsider)).status).toBe(404);
    expect((await rehearse(flow.id, body, admin)).status).toBe(200);
    const elsewhere = await addMember(owner, otherChannelId);
    expect((await rehearse(flow.id, { source: 'live', memberId: elsewhere.id })).status).toBe(400);
    const foreign = await circleIn(foreignChannelId, outsider.workspaceId);
    expect((await rehearse(flow.id, { source: 'live', circleId: foreign })).status).toBe(404);
    expect((await rehearse(flow.id, { source: 'live' })).status).toBe(400);
  });

  it('takes a sample of a Circle', async () => {
    const { flow } = await liveFlow();
    const circle = await circleIn(channelId, owner.workspaceId);
    for (let i = 0; i < 12; i++) {
      const member = await addMember(owner, channelId);
      await insertRow(
        'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 1)',
        circle,
        member.id,
      );
    }
    const result = await data<{ circleSize: number; people: unknown[] }>(
      await rehearse(flow.id, { source: 'live', circleId: circle }),
    );
    expect(result.circleSize).toBe(12);
    expect(result.people).toHaveLength(10);
  });
});

describe('Add people', () => {
  async function liveFlow() {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    await patchGraph(flow.id, oneEmail(email.id));
    expect((await publish(flow.id)).status).toBe(200);
    return flow;
  }
  const preview = (flowId: string, selection: unknown, s: Session = editor) =>
    call('POST', `/api/v1/flows/${flowId}/people/preview`, {
      cookie: s.cookie,
      body: { selection },
    });
  const start = (flowId: string, selection: unknown, confirmCount: number, s: Session = editor) =>
    call('POST', `/api/v1/flows/${flowId}/people`, {
      cookie: s.cookie,
      body: { selection, confirmCount },
    });

  it('counts first, says who is left out and why, and starts only on the right number', async () => {
    const flow = await liveFlow();
    const a = await addMember(owner, channelId);
    const b = await addMember(owner, channelId);
    const gone = await addMember(owner, channelId);
    const blocked = await addMember(owner, channelId);
    const inIt = await addMember(owner, channelId);
    await insertRow(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`, gone.id);
    await addManualSuppression(env.DB, {
      workspaceId: owner.workspaceId,
      channelId: null,
      email: blocked.email,
      now: Date.now(),
    });
    await insertRun(flow.id, 1, inIt.id, 'running');
    const elsewhere = await addMember(owner, otherChannelId);
    const selection = {
      memberIds: [a.id, b.id, gone.id, blocked.id, inIt.id, elsewhere.id, a.id],
    };

    const counted = await data<{
      total: number;
      entering: number;
      skipped: { reason: string; count: number }[];
    }>(await preview(flow.id, selection));
    expect(counted.total).toBe(5);
    expect(counted.entering).toBe(2);
    expect(Object.fromEntries(counted.skipped.map((s) => [s.reason, s.count]))).toEqual({
      unsubscribed: 1,
      suppressed: 1,
      already_in: 1,
    });

    // A number that isn't the count any more starts nothing.
    const stale = await start(flow.id, selection, 3);
    expect(stale.status).toBe(409);
    expect(jobs).toHaveLength(0);

    const job = await data<{ id: string; action: string; total: number; entered: number }>(
      await start(flow.id, selection, 2),
      202,
    );
    expect(job).toMatchObject({ action: 'flow_enrol', total: 5, entered: 0 });
    expect(jobs).toEqual([{ type: 'bulk', jobId: job.id }]);
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE action = 'flow.people_added' AND target_id = ?1`,
    )
      .bind(flow.id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      jobId: job.id,
      total: 5,
      entering: 2,
    });
  });

  it('is for editors and up, on a live Flow', async () => {
    const flow = await liveFlow();
    const member = await addMember(owner, channelId);
    const selection = { memberIds: [member.id] };
    expect((await preview(flow.id, selection, author)).status).toBe(403);
    expect((await start(flow.id, selection, 1, viewer)).status).toBe(403);
    expect((await preview(flow.id, selection, outsider)).status).toBe(404);
    const draft = await blank();
    expect((await preview(draft.id, selection)).status).toBe(409);
    await call('POST', `/api/v1/flows/${flow.id}/pause`, { cookie: editor.cookie });
    expect((await start(flow.id, selection, 1)).status).toBe(409);
    const foreign = await circleIn(foreignChannelId, outsider.workspaceId);
    await call('POST', `/api/v1/flows/${flow.id}/resume`, { cookie: editor.cookie });
    expect((await preview(flow.id, { circleId: foreign })).status).toBe(404);
  });

  it('asks the start event’s filter, in the words Why uses', async () => {
    const flow = await blank();
    const email = await flowEmail(flow.id);
    const circle = await circleIn(channelId, owner.workspaceId);
    const graph = oneEmail(email.id);
    (graph.nodes[0]!.config as { filter?: unknown }).filter = {
      field: 'circle',
      cmp: 'eq',
      value: circle,
    };
    expect((await patchGraph(flow.id, graph)).status).toBe(200);
    expect((await publish(flow.id)).status).toBe(200);
    const inside = await addMember(owner, channelId);
    const outside = await addMember(owner, channelId);
    await insertRow(
      'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 1)',
      circle,
      inside.id,
    );
    const counted = await data<{ entering: number; skipped: { reason: string }[] }>(
      await preview(flow.id, { memberIds: [inside.id, outside.id] }),
    );
    expect(counted.entering).toBe(1);
    expect(counted.skipped).toEqual([{ reason: 'not_in_segment', count: 1 }]);
  });
});

describe('Membership grants need admin, like the comp route', () => {
  /** trigger(confirmed) → change_level grant (no end) → add_tag. */
  const grantGraph = (levelId: string, tagId: string, days: number | null = null): FlowGraph => ({
    schema: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
      { id: 'grant', type: 'change_level', config: { action: 'grant', levelId, days } },
      { id: 'tag', type: 'add_tag', config: { tagId } },
    ],
    edges: [
      { from: 'trigger', to: 'grant', label: 'default' },
      { from: 'grant', to: 'tag', label: 'default' },
    ],
  });
  const compRows = async (memberId: string) => ({
    grants: await env.DB.prepare('SELECT count(*) AS n FROM comp_grants WHERE member_id = ?1')
      .bind(memberId)
      .first<{ n: number }>(),
    subscriptions: await env.DB.prepare(
      `SELECT count(*) AS n FROM member_subscriptions WHERE member_id = ?1 AND source = 'comp'`,
    )
      .bind(memberId)
      .first<{ n: number }>(),
    entitlements: await env.DB.prepare(
      `SELECT count(*) AS n FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    )
      .bind(memberId)
      .first<{ n: number }>(),
  });
  async function drainSteps() {
    const queue = { send: async (message: JobMessage) => void jobs.push(message) };
    const flowsEnv = {
      DB: env.DB,
      JOBS_QUEUE: queue as unknown as FlowsEnv['JOBS_QUEUE'],
      SEND_QUEUE: { send: async () => {} } as unknown as FlowsEnv['SEND_QUEUE'],
    };
    for (let i = 0; i < 20; i++) {
      const next = jobs.findIndex((m) => m.type === 'flow_step');
      if (next < 0) return;
      const [msg] = jobs.splice(next, 1);
      await runStep(flowsEnv, msg as Extract<JobMessage, { type: 'flow_step' }>);
    }
  }
  /** A live Flow with a grant step, saved and published by an admin. */
  async function liveGrantFlow() {
    const flow = await blank('Comp');
    const levelId = await levelIn(channelId);
    const tagId = await tagIn(channelId);
    expect((await patchGraph(flow.id, grantGraph(levelId, tagId), admin)).status).toBe(200);
    expect((await publish(flow.id, {}, admin)).status).toBe(200);
    return { flow, levelId, tagId };
  }

  it('lets only an admin add or change a grant step; editors still edit the rest', async () => {
    const flow = await blank('Comp');
    const levelId = await levelIn(channelId);
    const tagId = await tagIn(channelId);
    const member = await addMember(owner, channelId);
    // The comp route itself is admin only.
    expect(
      (
        await call('POST', `/api/v1/channels/${channelId}/members/${member.id}/comp`, {
          cookie: editor.cookie,
          body: { levelId },
        })
      ).status,
    ).toBe(403);
    const added = await patchGraph(flow.id, grantGraph(levelId, tagId));
    expect(added.status).toBe(403);
    expect(await errorCode(added)).toBe('forbidden');
    expect((await patchGraph(flow.id, grantGraph(levelId, tagId), admin)).status).toBe(200);
    // Changing the grant (here its length) is an admin's call too.
    expect((await patchGraph(flow.id, grantGraph(levelId, tagId, 30))).status).toBe(403);
    // Other steps, the grant step's place on the canvas and the Flow's name stay editable.
    const otherTag = await tagIn(channelId);
    const edited = grantGraph(levelId, otherTag);
    edited.nodes[1]!.position = { x: 40, y: 80 };
    edited.nodes[1]!.name = 'Free month';
    expect((await patchGraph(flow.id, edited)).status).toBe(200);
    expect(
      (
        await call('PATCH', `/api/v1/flows/${flow.id}`, {
          cookie: editor.cookie,
          body: { name: 'Comp, renamed' },
        })
      ).status,
    ).toBe(200);
    // Taking the grant out grants nothing, so an editor may.
    expect((await patchGraph(flow.id, oneEmail((await flowEmail(flow.id)).id))).status).toBe(200);
  });

  it('lets only an admin publish a Flow that grants, or one that enrols into it', async () => {
    const { flow: granting } = await liveGrantFlow();
    // A new version of the granting Flow, even with only other steps changed, is an admin's.
    const draft = await data<Flow>(
      await call('GET', `/api/v1/flows/${granting.id}`, { cookie: editor.cookie }),
    );
    const tagged = structuredClone(draft.draftGraph);
    (tagged.nodes[2]!.config as { tagId: string }).tagId = await tagIn(channelId);
    expect((await patchGraph(granting.id, tagged)).status).toBe(200);
    const refused = await publish(granting.id);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('forbidden');
    expect((await publish(granting.id, {}, admin)).status).toBe(200);

    // A Flow that enrols people into the granting one reaches the grant the same way.
    const funnel = await blank('Funnel');
    const enrolGraph: FlowGraph = {
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        { id: 'enrol', type: 'enrol_flow', config: { flowId: granting.id } },
      ],
      edges: [{ from: 'trigger', to: 'enrol', label: 'default' }],
    };
    expect((await patchGraph(funnel.id, enrolGraph)).status).toBe(200);
    expect((await publish(funnel.id)).status).toBe(403);
    expect((await publish(funnel.id, {}, admin)).status).toBe(200);
  });

  it('lets only an admin add people to a Flow that grants', async () => {
    const { flow } = await liveGrantFlow();
    const member = await addMember(owner, channelId);
    const selection = { memberIds: [member.id] };
    const refused = await call('POST', `/api/v1/flows/${flow.id}/people`, {
      cookie: editor.cookie,
      body: { selection, confirmCount: 1 },
    });
    expect(refused.status).toBe(403);
    expect(jobs).toHaveLength(0);
    expect(
      (
        await call('POST', `/api/v1/flows/${flow.id}/people`, {
          cookie: admin.cookie,
          body: { selection, confirmCount: 1 },
        })
      ).status,
    ).toBe(202);
  });

  it('never makes a real comp grant in a test run', async () => {
    const { flow, tagId } = await liveGrantFlow();
    const member = await addMember(owner, channelId);
    const run = await data<FlowRun>(
      await call('POST', `/api/v1/flows/${flow.id}/test-run`, {
        cookie: editor.cookie,
        body: { memberId: member.id },
      }),
      202,
    );
    await drainSteps();
    expect(await compRows(member.id)).toEqual({
      grants: { n: 0 },
      subscriptions: { n: 0 },
      entitlements: { n: 0 },
    });
    const steps = await env.DB.prepare(
      `SELECT node_id, status FROM flow_run_steps WHERE run_id = ?1 ORDER BY started_at, node_id`,
    )
      .bind(run.id)
      .all<{ node_id: string; status: string }>();
    expect(steps.results).toEqual(
      expect.arrayContaining([
        { node_id: 'grant', status: 'skipped' },
        { node_id: 'tag', status: 'done' },
      ]),
    );
    const tagged = await env.DB.prepare(
      'SELECT 1 AS x FROM member_tags WHERE member_id = ?1 AND tag_id = ?2',
    )
      .bind(member.id, tagId)
      .first();
    expect(tagged).not.toBeNull();
  });
});

describe('Welcome A/B auto-promotion', () => {
  async function liveWelcome(minPerVariant = 2) {
    const flow = await createFlow({ recipe: 'welcome' });
    const graph = structuredClone(flow.draftGraph);
    const split = graph.nodes.find((n) => n.type === 'ab_split')!;
    if (split.type === 'ab_split') {
      split.config.autoPromote = { metric: 'opens', minPerVariant, afterHours: 1 };
    }
    await data<Flow>(await patchGraph(flow.id, graph));
    const published = await data<{ emails: { nodeId: string; broadcastId: string }[] }>(
      await publish(flow.id),
    );
    const broadcastOf = (node: string) =>
      published.emails.find((e) => e.nodeId === node)!.broadcastId;
    return { flow, a: broadcastOf('welcome_a'), b: broadcastOf('welcome_b') };
  }

  async function deliveries(broadcastId: string, delivered: number, opened: number) {
    for (let i = 0; i < delivered; i++) {
      await insertRow(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, email, status, sent_at, human_opened_at)
         VALUES (?1, ?2, ?3, ?4, 'delivered', ?5, ?6)`,
        newId('delivery'),
        broadcastId,
        channelId,
        `r${i}@example.com`,
        Date.now(),
        i < opened ? Date.now() : null,
      );
    }
  }

  const ageVersion = (flowId: string, hours: number) =>
    insertRow(
      'UPDATE flow_versions SET published_at = ?1 WHERE flow_id = ?2',
      Date.now() - hours * 3_600_000,
      flowId,
    );

  it('waits for enough data and time, then publishes the winner as a direct edge', async () => {
    const { flow, a, b } = await liveWelcome(3);
    await deliveries(a, 3, 1);
    await deliveries(b, 2, 2);
    const now = Date.now();
    // Too early.
    expect((await promoteWelcomeSplits(env.DB, now)).filter((p) => p.flowId === flow.id)).toEqual(
      [],
    );
    await ageVersion(flow.id, 2);
    // B has too little data.
    expect((await promoteWelcomeSplits(env.DB, now)).filter((p) => p.flowId === flow.id)).toEqual(
      [],
    );
    await deliveries(b, 1, 0);
    const promoted = (await promoteWelcomeSplits(env.DB, now)).filter((p) => p.flowId === flow.id);
    expect(promoted).toEqual([
      expect.objectContaining({ splitNodeId: 'split', winner: 'b', winnerNodeId: 'welcome_b' }),
    ]);

    const read = await data<Flow>(
      await call('GET', `/api/v1/flows/${flow.id}`, { cookie: viewer.cookie }),
    );
    expect(read.liveVersion).toBe(2);
    const v2 = await env.DB.prepare(
      'SELECT graph_json, published_by FROM flow_versions WHERE flow_id = ?1 AND version = 2',
    )
      .bind(flow.id)
      .first<{ graph_json: string; published_by: string | null }>();
    const graph = JSON.parse(v2!.graph_json) as FlowGraph;
    expect(graph.nodes.map((n) => n.id)).toEqual(['trigger', 'welcome_b']);
    expect(graph.edges).toEqual([{ from: 'trigger', to: 'welcome_b', label: 'default' }]);
    expect(v2!.published_by).toBeNull();
    expect(read.draftGraph.nodes.map((n) => n.id)).toEqual(['trigger', 'welcome_b']);
    // The winner's frozen email is carried forward; the loser's is closed with v1.
    const emails = await env.DB.prepare(
      `SELECT fe.node_id, b.html = old.html AS same FROM flow_emails fe JOIN broadcasts b ON b.id = fe.broadcast_id
         JOIN broadcasts old ON old.id = ?2 WHERE fe.flow_id = ?1 AND fe.version = 2`,
    )
      .bind(flow.id, b)
      .all<{ node_id: string; same: number }>();
    expect(emails.results).toEqual([{ node_id: 'welcome_b', same: 1 }]);
    const v1Open = await env.DB.prepare(
      `SELECT count(*) AS n FROM broadcasts WHERE id IN (?1, ?2) AND status = 'sending'`,
    )
      .bind(a, b)
      .first<{ n: number }>();
    expect(v1Open?.n).toBe(0);
    const audit = await env.DB.prepare(
      `SELECT actor_operator_id, metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'flow.split_promoted'`,
    )
      .bind(flow.id)
      .first<{ actor_operator_id: string | null; metadata_json: string }>();
    expect(audit?.actor_operator_id).toBeNull();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      winner: 'b',
      fromVersion: 1,
      toVersion: 2,
    });
    // Nothing left to promote.
    expect((await promoteWelcomeSplits(env.DB, now)).filter((p) => p.flowId === flow.id)).toEqual(
      [],
    );
  });

  it('breaks a tie deterministically in favour of A', async () => {
    const { flow, a, b } = await liveWelcome(2);
    await deliveries(a, 2, 1);
    await deliveries(b, 2, 1);
    await ageVersion(flow.id, 5);
    const promoted = (await promoteWelcomeSplits(env.DB, Date.now())).filter(
      (p) => p.flowId === flow.id,
    );
    expect(promoted).toEqual([expect.objectContaining({ winner: 'a', winnerNodeId: 'welcome_a' })]);
  });
});

describe('Tenancy and roles', () => {
  let flowId: string;
  beforeAll(async () => {
    flowId = (await blank('Guarded')).id;
  });

  it('hides Flows from other workspaces', async () => {
    for (const [method, path] of [
      ['GET', `/api/v1/flows/${flowId}`],
      ['PATCH', `/api/v1/flows/${flowId}`],
      ['POST', `/api/v1/flows/${flowId}/publish`],
      ['POST', `/api/v1/flows/${flowId}/pause`],
      ['POST', `/api/v1/flows/${flowId}/archive`],
      ['POST', `/api/v1/flows/${flowId}/emails`],
      ['GET', `/api/v1/flows/${flowId}/runs`],
      ['GET', `/api/v1/flows/${flowId}/stats`],
      ['POST', `/api/v1/flows/${flowId}/webhook-secret`],
      ['GET', flowsPath()],
      ['POST', flowsPath()],
    ] as const) {
      const res = await call(method, path, {
        cookie: outsider.cookie,
        ...(method === 'GET' ? {} : { body: { name: 'x', trigger: { event: 'confirmed' } } }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // The outsider can't use their own Flow to reach this Channel's things either.
    const theirs = await createFlow(
      { name: 'Theirs', trigger: { event: 'confirmed' } },
      outsider,
      foreignChannelId,
    );
    const tag = await tagIn(channelId);
    const res = await patchGraph(
      theirs.id,
      {
        schema: 1,
        nodes: [{ id: 'trigger', type: 'trigger', config: { event: 'tag_added', tagId: tag } }],
        edges: [],
      },
      outsider,
    );
    expect(res.status).toBe(400);
  });

  const cases: { name: string; minimum: SeatRole; run: (s: Session) => Promise<Response> }[] = [
    {
      name: 'read',
      minimum: 'viewer',
      run: (s) => call('GET', `/api/v1/flows/${flowId}`, { cookie: s.cookie }),
    },
    { name: 'list', minimum: 'viewer', run: (s) => call('GET', flowsPath(), { cookie: s.cookie }) },
    {
      name: 'save',
      minimum: 'editor',
      run: (s) =>
        call('PATCH', `/api/v1/flows/${flowId}`, { cookie: s.cookie, body: { name: 'Guarded' } }),
    },
    {
      name: 'create',
      minimum: 'editor',
      run: (s) =>
        call('POST', flowsPath(), {
          cookie: s.cookie,
          body: { name: 'R', trigger: { event: 'confirmed' } },
        }),
    },
    {
      name: 'write an email',
      minimum: 'editor',
      run: (s) =>
        call('POST', `/api/v1/flows/${flowId}/emails`, {
          cookie: s.cookie,
          body: { subject: 'x' },
        }),
    },
    {
      name: 'webhook secret',
      minimum: 'admin',
      run: (s) => call('POST', `/api/v1/flows/${flowId}/webhook-secret`, { cookie: s.cookie }),
    },
  ];
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin'];
  for (const route of cases) {
    it(`${route.name} needs ${route.minimum}`, async () => {
      const sessions: Record<string, Session> = { viewer, author, editor, admin };
      for (const role of ROLES) {
        const res = await route.run(sessions[role]!);
        const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
        expect(res.status === 403, `${route.name} as ${role}: ${res.status}`).toBe(!allowed);
        if (allowed) expect(res.status, `${route.name} as ${role}`).toBeLessThan(300);
      }
    });
  }
});
