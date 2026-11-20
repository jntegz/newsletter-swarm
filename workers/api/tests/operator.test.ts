// Open Operator (Phase 8): the MCP endpoint (both protocol eras, headers, auth, flags, Origin),
// tools derived from /v2 (scopes, annotations, cross-tenant), the agent audit log (masking, chain)
// and approvals (hold, approve exactly once with re-checked authorisation, reject, expiry), plus
// the dashboard routes' role matrix and tenancy. Contract: docs/open-operator.md.
import { env } from 'cloudflare:test';
import { canonicalJson, sha256Hex } from '@swarm/db';
import {
  CONDITIONAL_HOLD_OPERATIONS,
  DESTRUCTIVE_OPERATIONS,
  MCP_MODERN_VERSION,
  OPEN_WORLD_OPERATIONS,
  THIRD_PARTY_TEXT_OPERATIONS,
  newId,
  type AgentAction,
  type AgentApproval,
  type AgentSettings,
  type ApiScope,
  type SeatRole,
} from '@swarm/domain';
import {
  appendAgentAction,
  deriveAgentTools,
  pruneAgentLog,
  toolName,
  verifyAgentLog,
} from '@swarm/engine';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp as createApiApp } from '../src/app';
import type { AppContext } from '../src/lib/context';
import type { ApiPrincipal } from '../src/v2/context';
import { v2OpenApiDocument } from '../src/v2/docs';
import { internalV2Fetch } from '../src/v2/internal';
import { SCOPE_EXTENSION } from '../src/v2/route';
import { addField, addMember, data } from './audience-helpers';
import { call, createChannel, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import { MCP_RESOURCE, connect, createApp } from './oauth-helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let channelId: string;
let outsider: Session;
let outsiderChannel: string;

async function enableFlag(key: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'workspace', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, workspaceId)
    .run();
  // Flags are cached in KV for a minute.
  await env.CACHE.delete(`flags:v1:${workspaceId}:-`);
}

const key = async (scopes: ApiScope[], extra: Record<string, unknown> = {}) =>
  (await createKey(owner, { scopes, ...extra })).secret;

interface McpOptions {
  headers?: Record<string, string>;
  legacy?: boolean;
  meta?: Record<string, unknown> | null;
  raw?: string;
}

/** A modern (2026-07-28) request with matching headers, unless `legacy` or overrides. */
function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  options: McpOptions = {},
): Promise<Response> {
  const meta =
    options.meta === null
      ? undefined
      : (options.meta ?? {
          'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'TestClient', version: '1.2.3' },
          'io.modelcontextprotocol/clientCapabilities': {},
        });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (!options.legacy) {
    headers['mcp-protocol-version'] = MCP_MODERN_VERSION;
    headers['mcp-method'] = method;
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  Object.assign(headers, options.headers);
  const body =
    options.raw ??
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: options.legacy || !meta ? params : { ...params, _meta: meta },
    });
  return SELF.fetch('http://localhost/mcp', { method: 'POST', headers, body });
}

interface RpcBody {
  result?: Record<string, unknown> & {
    tools?: { name: string; annotations: Record<string, boolean>; inputSchema: unknown }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
}
const rpc = async (res: Response) => (await res.json()) as RpcBody;

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  mcp(token, 'tools/call', { name, arguments: args });

async function lastAction(workspaceId: string): Promise<Record<string, unknown>> {
  return (await env.DB.prepare(
    'SELECT * FROM agent_actions WHERE workspace_id = ?1 ORDER BY seq DESC LIMIT 1',
  )
    .bind(workspaceId)
    .first()) as Record<string, unknown>;
}

async function createMemberV2(token: string, email = uniqueEmail('member')): Promise<string> {
  const res = await v2('POST', `/v2/channels/${channelId}/members`, token, {
    body: { email, consent: true },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

const settingsPath = (ws = owner.workspaceId) => `/api/v1/workspaces/${ws}/agent-settings`;
const approvalsPath = (ws = owner.workspaceId) => `/api/v1/workspaces/${ws}/agent-approvals`;

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  outsider = await signIn();
  outsiderChannel = (await createChannel(outsider)).id;
  await enableFlag('open_operator_mcp', owner.workspaceId);
});

describe('tools derived from /v2', () => {
  const tools = deriveAgentTools(v2OpenApiDocument(), SCOPE_EXTENSION);

  it('has one tool per operation, with the route scope and self-contained schemas', () => {
    const doc = v2OpenApiDocument();
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, { operationId?: string }>).filter((o) => o.operationId),
    );
    expect(tools.length).toBe(operations.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z0-9_]{1,128}$/);
      expect(JSON.stringify(tool.inputSchema)).not.toContain('$ref');
    }
  });

  it('names every destructive operation that exists, and marks reads and deletes', () => {
    const ids = new Set(tools.map((t) => t.operationId));
    for (const id of DESTRUCTIVE_OPERATIONS) expect(ids, id).toContain(id);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('delete_member')?.risk).toBe('destructive');
    expect(byName.get(toolName('scheduleDispatch'))?.annotations.destructiveHint).toBe(true);
    expect(byName.get('preview_dispatch')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('create_member')?.risk).toBe('destructive');
    expect(byName.get('send_member_event')?.risk).toBe('destructive');
  });

  it('names real operations in every effect list, and publishes hints that match effects', () => {
    const ids = new Set(tools.map((t) => t.operationId));
    for (const id of [
      ...Object.keys(CONDITIONAL_HOLD_OPERATIONS),
      ...OPEN_WORLD_OPERATIONS,
      ...Object.keys(THIRD_PARTY_TEXT_OPERATIONS),
    ]) {
      expect(ids, id).toContain(id);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['update_member', 'update_dispatch', 'add_member_tags']) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
    for (const name of ['check_feed_source', 'send_webhook_test', 'send_dispatch_test']) {
      expect(byName.get(name)?.annotations.openWorldHint, name).toBe(true);
    }
    expect(byName.get('check_feed_source')?.description).toContain('resumeRequired');
    // The published definitions, per release: a change here is a reviewed change.
    expect(
      Object.fromEntries(
        tools.map((t) => [
          t.name,
          `${t.risk} ro=${t.annotations.readOnlyHint} d=${t.annotations.destructiveHint} ow=${t.annotations.openWorldHint}`,
        ]),
      ),
    ).toMatchSnapshot();
  });

  it('dispatches in process only to the path it checked, never one a dot segment moves', async () => {
    createApiApp(); // registers the in-process fetch in this isolate
    const principal: ApiPrincipal = {
      kind: 'key',
      id: 'ak_test',
      workspaceId: owner.workspaceId,
      channelIds: null,
      scopes: ['channels:read'],
      plan: 'pro',
      rateCap: null,
    };
    const c = {
      req: { url: 'http://localhost/mcp', header: () => undefined },
      env,
      get: () => undefined,
      get executionCtx(): never {
        throw new Error('no execution context');
      },
    } as unknown as AppContext;
    for (const path of ['/v2/channels/x/../../api/v1/me', '/v2/./channels', '/v2/%2e%2e/api']) {
      await expect(
        internalV2Fetch(c, principal, { method: 'GET', path, body: null }),
        path,
      ).rejects.toThrow('internal dispatch path must already be normalised');
    }
    const listed = await internalV2Fetch(c, principal, {
      method: 'GET',
      path: '/v2/channels?limit=5',
      body: null,
    });
    expect(listed.status).toBe(200);
  });
});

describe('discovery', () => {
  it('publishes protected resource metadata pointing at the authorization server', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await SELF.fetch(`http://localhost${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe('http://localhost:5273/mcp');
      expect(body.authorization_servers).toEqual(['http://localhost:5273']);
      expect(body.scopes_supported).toContain('members:read');
    }
  });

  it('answers 401 with a resource metadata challenge, and 405 to GET and DELETE', async () => {
    const res = await mcp(null, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://localhost:5273/.well-known/oauth-protected-resource/mcp"',
    );
    expect((await rpc(res)).error?.code).toBe(-31001);
    expect((await mcp('sk_live_' + 'x'.repeat(40), 'tools/list')).status).toBe(401);
    for (const method of ['GET', 'DELETE']) {
      expect((await SELF.fetch('http://localhost/mcp', { method })).status).toBe(405);
    }
  });

  it('refuses a foreign Origin', async () => {
    const token = await key(['channels:read']);
    const res = await mcp(token, 'tools/list', {}, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('the flag and settings', () => {
  it('answers 404 when open_operator_mcp is off for the workspace', async () => {
    const other = await signIn();
    const token = (await createKey(other, { scopes: ['channels:read'] })).secret;
    const res = await mcp(token, 'tools/list');
    expect(res.status).toBe(404);
    expect((await rpc(res)).error?.code).toBe(-31004);
  });

  it('settings: admin only, the flag enforced, audited, and MCP can be turned off', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await call('GET', settingsPath(), { cookie: editor.cookie })).status).toBe(403);
    expect((await call('GET', settingsPath(), { cookie: outsider.cookie })).status).toBe(404);
    const view = await data<AgentSettings>(
      await call('GET', settingsPath(), { cookie: owner.cookie }),
    );
    expect(view).toMatchObject({
      mcpEnabled: true,
      approvalMode: 'destructive',
      approvalTtlHours: 24,
      flags: { openOperatorMcp: true, copilotActions: false },
      mcpUrl: 'http://localhost:5273/mcp',
    });
    // The approval mode belongs to the MCP server: it doesn't need Copilot.
    const changed = await call('PUT', settingsPath(), {
      cookie: owner.cookie,
      body: { approvalMode: 'writes' },
    });
    expect(changed.status).toBe(200);
    await call('PUT', settingsPath(), {
      cookie: owner.cookie,
      body: { approvalMode: 'destructive' },
    });
    // Another workspace without the flag can't save at all.
    expect(
      (
        await call('PUT', settingsPath(outsider.workspaceId), {
          cookie: outsider.cookie,
          body: { mcpEnabled: false },
        })
      ).status,
    ).toBe(404);

    const token = await key(['channels:read']);
    await data(
      await call('PUT', settingsPath(), { cookie: owner.cookie, body: { mcpEnabled: false } }),
    );
    expect((await mcp(token, 'tools/list')).status).toBe(403);
    await data(
      await call('PUT', settingsPath(), { cookie: owner.cookie, body: { mcpEnabled: true } }),
    );
    expect((await mcp(token, 'tools/list')).status).toBe(200);
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND action = 'agent_settings.updated'",
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(4);
  });
});

describe('the protocol', () => {
  let token: string;
  beforeAll(async () => {
    token = await key(['channels:read', 'members:read']);
  });

  it('server/discover lists versions and capabilities', async () => {
    const res = await mcp(token, 'server/discover');
    expect(res.status).toBe(200);
    const { result } = await rpc(res);
    expect(result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: { listChanged: false } },
    });
    expect(result?._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: 'swarm-open-operator' },
    });
  });

  it('tools/list shows only what the scopes allow', async () => {
    const { result } = await rpc(await mcp(token, 'tools/list'));
    const names = result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('list_channels');
    expect(names).toContain('get_channel_context');
    expect(names).toContain('get_member');
    expect(names).not.toContain('delete_member');
    expect(names).not.toContain('list_dispatches');
    expect(names).toContain('get_agent_approval');
    expect(names).toEqual([...names].sort());
  });

  it('checks headers against the body, the _meta fields and the version', async () => {
    const mismatch = await mcp(token, 'tools/list', {}, { headers: { 'mcp-method': 'ping' } });
    expect(mismatch.status).toBe(400);
    expect((await rpc(mismatch)).error?.code).toBe(-32020);
    const noName = await mcp(
      token,
      'tools/call',
      { name: 'list_channels', arguments: {} },
      { headers: { 'mcp-name': 'list_members' } },
    );
    expect((await rpc(noName)).error?.code).toBe(-32020);
    const encoded = await mcp(
      token,
      'tools/call',
      { name: 'list_channels', arguments: {} },
      { headers: { 'mcp-name': `=?base64?${btoa('list_channels')}?=` } },
    );
    expect(encoded.status).toBe(200);
    const noMeta = await mcp(
      token,
      'tools/list',
      {},
      {
        meta: { 'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION },
      },
    );
    expect(noMeta.status).toBe(400);
    expect((await rpc(noMeta)).error?.code).toBe(-32602);
    const future = await mcp(
      token,
      'tools/list',
      {},
      {
        meta: {
          'io.modelcontextprotocol/protocolVersion': '2099-01-01',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
        headers: { 'mcp-protocol-version': '2099-01-01' },
      },
    );
    expect(future.status).toBe(400);
    expect((await rpc(future)).error).toMatchObject({
      code: -32022,
      data: { requested: '2099-01-01' },
    });
    const unknown = await mcp(token, 'resources/list');
    expect(unknown.status).toBe(404);
    expect((await rpc(unknown)).error?.code).toBe(-32601);
  });

  it('answers notifications with 202 and refuses batches and bad JSON', async () => {
    const note = await mcp(
      token,
      'x',
      {},
      {
        raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        legacy: true,
      },
    );
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    const batch = await mcp(token, 'x', {}, { raw: '[]', legacy: true });
    expect((await rpc(batch)).error?.code).toBe(-32600);
    const bad = await mcp(token, 'x', {}, { raw: '{', legacy: true });
    expect((await rpc(bad)).error?.code).toBe(-32700);
  });

  it('serves handshake clients (2025-11-25) without sessions', async () => {
    const init = await mcp(
      token,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'Legacy', version: '1' },
      },
      { legacy: true },
    );
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const { result } = await rpc(init);
    expect(result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'swarm-open-operator' },
      capabilities: { tools: { listChanged: false } },
    });
    const old = await rpc(
      await mcp(token, 'initialize', { protocolVersion: '2024-11-05' }, { legacy: true }),
    );
    expect(old.result?.protocolVersion).toBe('2025-11-25');
    const list = await mcp(
      token,
      'tools/list',
      {},
      {
        legacy: true,
        headers: { 'mcp-protocol-version': '2025-11-25' },
      },
    );
    expect(list.status).toBe(200);
    expect((await rpc(list)).result?.resultType).toBeUndefined();
  });
});

describe('tool calls and the agent log', () => {
  it('runs the /v2 route, returns its data and logs the call', async () => {
    const token = await key(['channels:read']);
    const res = await callTool(token, 'get_channel', { channelId });
    expect(res.status).toBe(200);
    const { result } = await rpc(res);
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent).toMatchObject({ data: { id: channelId } });
    const row = await lastAction(owner.workspaceId);
    expect(row).toMatchObject({
      source: 'mcp',
      principal_kind: 'key',
      tool: 'get_channel',
      channel_id: channelId,
      risk: 'read',
      outcome: 'ok',
      status_code: 200,
      client_name: 'TestClient',
      client_version: '1.2.3',
    });
    expect(res.headers.get('ratelimit-limit')).not.toBeNull();
  });

  it('gives an agent the publication context, with the operator’s style guide', async () => {
    await env.DB.prepare(
      `UPDATE channels SET settings_json = json_set(settings_json, '$.styleGuide', 'Plain sentences only.')
       WHERE id = ?1`,
    )
      .bind(channelId)
      .run();
    const token = await key(['channels:read', 'members:read']);
    const { result } = await rpc(await callTool(token, 'get_channel_context', { channelId }));
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent).toMatchObject({
      data: {
        publication: { slug: expect.any(String) },
        styleGuide: 'Plain sentences only.',
        audience: { activeMembers: expect.any(Number) },
        recentDispatches: null,
      },
    });
  });

  it('keeps Members and post stats from a key with only channels:read', async () => {
    const token = await key(['channels:read']);
    const { result } = await rpc(await callTool(token, 'get_channel_context', { channelId }));
    expect(result?.structuredContent).toMatchObject({
      data: { audience: null, recentDispatches: null },
    });
  });

  it('marks a draft an agent starts as agent work', async () => {
    const token = await key(['dispatches:write', 'dispatches:read']);
    const res = await callTool(token, 'create_dispatch', {
      channelId,
      body: { subject: 'Written by an agent' },
    });
    expect(res.status).toBe(200);
    const { result } = await rpc(res);
    const id = ((result?.structuredContent as { data?: { id?: string } } | undefined)?.data ?? {})
      .id;
    expect(id).toMatch(/^dp_/);
    const row = await env.DB.prepare('SELECT created_via FROM dispatches WHERE id = ?1')
      .bind(id)
      .first<{ created_via: string | null }>();
    expect(row?.created_via).toBe('agent');
    const seen = await rpc(await callTool(token, 'get_dispatch', { channelId, dispatchId: id }));
    expect(seen.result?.structuredContent).toMatchObject({ data: { createdVia: 'agent' } });
  });

  it('refuses a tool outside the scopes with a step-up challenge, and logs it', async () => {
    const token = await key(['channels:read']);
    const res = await callTool(token, 'list_members', { channelId });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain(
      'error="insufficient_scope", scope="members:read"',
    );
    expect((await lastAction(owner.workspaceId)).outcome).toBe('denied');
  });

  it('keeps tenancy: another workspace’s Channel is a 404 tool error', async () => {
    const token = await key(['channels:read']);
    const { result } = await rpc(
      await callTool(token, 'get_channel', { channelId: outsiderChannel }),
    );
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: { code: 'not_found' } });
    const limited = await key(['channels:read'], {
      channelIds: [(await createChannel(owner)).id],
    });
    const again = await rpc(await callTool(limited, 'get_channel', { channelId }));
    expect(again.result?.isError).toBe(true);
  });

  it('an unknown tool is -32602 and still logged; bad arguments are a tool error', async () => {
    const token = await key(['channels:read']);
    const res = await callTool(token, 'no_such_tool', {});
    expect((await rpc(res)).error?.code).toBe(-32602);
    expect(await lastAction(owner.workspaceId)).toMatchObject({
      tool: 'no_such_tool',
      outcome: 'error',
      error_code: 'unknown_tool',
    });
    const bad = await rpc(await callTool(token, 'get_channel', { channelId, extra: 1 }));
    expect(bad.result?.isError).toBe(true);
  });

  it('masks personal data in the stored arguments', async () => {
    const token = await key(['members:write']);
    const email = uniqueEmail('masked');
    const { result } = await rpc(
      await callTool(token, 'create_member', {
        channelId,
        body: { email, firstName: 'Ada', consent: true, tags: ['vip'] },
      }),
    );
    expect(result?.isError).toBe(false);
    const row = await lastAction(owner.workspaceId);
    expect(row.arguments_json).not.toContain(email);
    expect(row.arguments_json).not.toContain('Ada');
    expect(JSON.parse(row.arguments_json as string)).toEqual({
      channelId,
      body: { email: '[redacted]', firstName: '[redacted]', consent: true, tags: ['vip'] },
    });
  });

  it('the dashboard lists the log with credential labels and verifies the chain', async () => {
    const page = await data<{ items: AgentAction[] }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/agent-actions?limit=5`, {
        cookie: owner.cookie,
      }),
    );
    expect(page.items.length).toBe(5);
    expect(page.items[0]!.credential.label).toMatch(/^Test key \(/);
    const verify = `/api/v1/workspaces/${owner.workspaceId}/agent-actions/verify`;
    const whole = await data<{ checked: number }>(
      await call('GET', verify, { cookie: owner.cookie }),
    );
    expect(whole).toMatchObject({ ok: true, brokenAtSeq: null, complete: true, nextCursor: null });
    // A smaller page: the client follows nextCursor until the check is complete.
    let step = await data<{ ok: boolean; checked: number; complete: boolean; nextCursor: string }>(
      await call('GET', `${verify}?limit=2`, { cookie: owner.cookie }),
    );
    expect(step).toMatchObject({ ok: true, checked: 2, complete: false });
    while (!step.complete) {
      step = await data(
        await call('GET', `${verify}?limit=2&cursor=${step.nextCursor}`, { cookie: owner.cookie }),
      );
    }
    expect(step).toMatchObject({ ok: true, checked: whole.checked });
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    expect((await call('GET', verify, { cookie: viewer.cookie })).status).toBe(403);
    expect(
      (
        await call('GET', `/api/v1/workspaces/${owner.workspaceId}/agent-actions`, {
          cookie: outsider.cookie,
        })
      ).status,
    ).toBe(404);
    // Editing a row breaks verification from there on.
    await env.DB.prepare(
      "UPDATE agent_actions SET outcome = 'ok' WHERE workspace_id = ?1 AND outcome = 'denied'",
    )
      .bind(owner.workspaceId)
      .run();
    const broken = await data<{ ok: boolean; brokenAtSeq: number }>(
      await call('GET', verify, { cookie: owner.cookie }),
    );
    expect(broken.ok).toBe(false);
  });
});

describe('approvals', () => {
  let ws: Session;
  let token: string;

  const approvals = (s: Session) => approvalsPath(s.workspaceId);

  beforeAll(async () => {
    ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    channelId = (await createChannel(ws)).id;
    // Copilot stays off: approvals belong to the MCP server.
    await enableFlag('open_operator_mcp', ws.workspaceId);
    token = (await createKey(ws, { scopes: ['members:write', 'channels:read'] })).secret;
  });

  const memberExists = async (id: string) =>
    !!(await env.DB.prepare('SELECT 1 FROM members WHERE id = ?1').bind(id).first());

  it('holds an agent’s send with Copilot off: the post stays a draft until a person approves', async () => {
    // Its own workspace: the tests below count what is waiting in theirs.
    const own = await signIn();
    await enableFlag('open_operator_mcp', own.workspaceId);
    const ownChannel = (await createChannel(own)).id;
    const writer = (await createKey(own, { scopes: ['dispatches:write'] })).secret;
    const created = await rpc(
      await callTool(writer, 'create_dispatch', {
        channelId: ownChannel,
        body: { subject: 'Not yet' },
      }),
    );
    const dispatchId = (created.result?.structuredContent as { data: { id: string } }).data.id;
    const { result } = await rpc(
      await callTool(writer, 'schedule_dispatch', {
        channelId: ownChannel,
        dispatchId,
        body: { publishAt: new Date(Date.now() + 86_400_000).toISOString() },
      }),
    );
    expect(result?.structuredContent).toMatchObject({ status: 'pending_approval' });
    const row = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatchId)
      .first<{ status: string }>();
    expect(row?.status).toBe('draft');
  });

  it('won’t let an agent change what a scheduled post sends, and holds new webhook endpoints', async () => {
    const own = await signIn();
    await enableFlag('open_operator_mcp', own.workspaceId);
    const ownChannel = (await createChannel(own)).id;
    const writer = (await createKey(own, { scopes: ['dispatches:write', 'webhooks:write'] }))
      .secret;
    const created = await rpc(
      await callTool(writer, 'create_dispatch', { channelId: ownChannel, body: { subject: 'Hi' } }),
    );
    const dispatchId = (created.result?.structuredContent as { data: { id: string } }).data.id;
    // A person scheduled it (the approval path, or the dashboard).
    await env.DB.prepare(
      "UPDATE dispatches SET status = 'scheduled', publish_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now() + 86_400_000, dispatchId)
      .run();

    for (const body of [{ subject: 'Something else' }, { preheader: 'Read this' }]) {
      const { result } = await rpc(
        await callTool(writer, 'update_dispatch', { channelId: ownChannel, dispatchId, body }),
      );
      expect(result?.isError, JSON.stringify(body)).toBe(true);
      expect(JSON.stringify(result?.structuredContent)).toContain('conflict');
    }
    const subject = await env.DB.prepare('SELECT subject FROM dispatches WHERE id = ?1')
      .bind(dispatchId)
      .first<{ subject: string }>();
    expect(subject?.subject).toBe('Hi');

    // The web fields can still change, and a direct /v2 integration is not an agent.
    const web = await rpc(
      await callTool(writer, 'update_dispatch', {
        channelId: ownChannel,
        dispatchId,
        body: { webVisibility: 'hidden' },
      }),
    );
    expect(web.result?.isError).toBe(false);
    const direct = await v2(
      'PATCH',
      `/v2/channels/${ownChannel}/dispatches/${dispatchId}`,
      writer,
      {
        body: { subject: 'Changed by an integration' },
      },
    );
    expect(direct.status, await direct.clone().text()).toBe(200);

    // Sending subscriber data somewhere new waits for a person.
    const hook = await rpc(
      await callTool(writer, 'create_webhook_endpoint', {
        body: { url: 'https://hooks.example.com/swarm', events: ['member.created'] },
      }),
    );
    expect(hook.result?.structuredContent).toMatchObject({ status: 'pending_approval' });
  });

  async function hold(memberId: string): Promise<string> {
    const res = await callTool(token, 'delete_member', { channelId, memberId });
    expect(res.status).toBe(200);
    const { result } = await rpc(res);
    expect(result?.isError).toBe(false);
    const structured = result?.structuredContent as { status: string; approvalId: string };
    expect(structured.status).toBe('pending_approval');
    return structured.approvalId;
  }

  it('holds a destructive call; an admin approves it and it runs exactly once', async () => {
    const memberId = await createMemberV2(token);
    const approvalId = await hold(memberId);
    expect(await memberExists(memberId)).toBe(true);
    expect((await lastAction(ws.workspaceId)).outcome).toBe('pending_approval');

    // Reads and plain writes are not held in `destructive` mode.
    const read = await rpc(await callTool(token, 'get_member', { channelId, memberId }));
    expect(read.result?.isError).toBe(false);

    const pending = await data<{ items: AgentApproval[] }>(
      await call('GET', approvals(ws), { cookie: ws.cookie }),
    );
    expect(pending.items.map((a) => a.id)).toEqual([approvalId]);
    expect(pending.items[0]!.request).toMatchObject({
      method: 'DELETE',
      path: `/v2/channels/${channelId}/members/${memberId}`,
    });

    // Roles and tenancy.
    for (const role of ['viewer', 'editor'] as SeatRole[]) {
      const s = await seatAs(ws.workspaceId, role);
      expect(
        (await call('POST', `${approvals(ws)}/${approvalId}/approve`, { cookie: s.cookie })).status,
      ).toBe(403);
    }
    expect(
      (
        await call('POST', `${approvals(outsider)}/${approvalId}/approve`, {
          cookie: outsider.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `${approvals(ws)}/${approvalId}`, { cookie: outsider.cookie })).status,
    ).toBe(404);

    const admin = await seatAs(ws.workspaceId, 'admin');
    const [first, second] = await Promise.all([
      call('POST', `${approvals(ws)}/${approvalId}/approve`, { cookie: admin.cookie }),
      call('POST', `${approvals(ws)}/${approvalId}/approve`, { cookie: ws.cookie }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const done = (await (first.status === 200 ? first : second).json()) as { data: AgentApproval };
    expect(done.data).toMatchObject({
      status: 'executed',
      request: null,
      result: { statusCode: 204 },
    });
    expect(await memberExists(memberId)).toBe(false);

    const ran = await env.DB.prepare(
      "SELECT count(*) AS n FROM agent_actions WHERE approval_id = ?1 AND source = 'approval'",
    )
      .bind(approvalId)
      .first<{ n: number }>();
    expect(ran?.n).toBe(1);
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE target_id = ?1 AND action = 'agent_approval.approved'",
    )
      .bind(approvalId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);

    // The agent can read the outcome.
    const status = await rpc(await callTool(token, 'get_agent_approval', { approvalId }));
    expect(status.result?.structuredContent).toMatchObject({ data: { status: 'executed' } });
    const otherKey = (await createKey(ws, { scopes: ['members:write'] })).secret;
    const hidden = await rpc(await callTool(otherKey, 'get_agent_approval', { approvalId }));
    expect(hidden.result?.isError).toBe(true);
  });

  it('re-checks the credential at approval time', async () => {
    const memberId = await createMemberV2(token);
    const second = await createKey(ws, { scopes: ['members:write'] });
    const res = await callTool(second.secret, 'delete_member', { channelId, memberId });
    const approvalId = ((await rpc(res)).result?.structuredContent as { approvalId: string })
      .approvalId;
    expect(
      (
        await call('DELETE', `/api/v1/workspaces/${ws.workspaceId}/api-keys/${second.key.id}`, {
          cookie: ws.cookie,
        })
      ).status,
    ).toBe(204);
    const done = await data<AgentApproval>(
      await call('POST', `${approvals(ws)}/${approvalId}/approve`, { cookie: ws.cookie }),
    );
    expect(done.status).toBe('failed');
    expect(done.reason).toMatch(/no longer valid/);
    expect(await memberExists(memberId)).toBe(true);
  });

  it('rejects, and expired approvals can be neither approved nor rejected', async () => {
    const memberId = await createMemberV2(token);
    const rejectedId = await hold(memberId);
    const rejected = await data<AgentApproval>(
      await call('POST', `${approvals(ws)}/${rejectedId}/reject`, {
        cookie: ws.cookie,
        body: { reason: 'Not today' },
      }),
    );
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'Not today', request: null });
    expect(
      (await call('POST', `${approvals(ws)}/${rejectedId}/approve`, { cookie: ws.cookie })).status,
    ).toBe(409);
    expect(await memberExists(memberId)).toBe(true);

    const expiredId = await hold(memberId);
    await env.DB.prepare('UPDATE agent_approvals SET expires_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 1000, expiredId)
      .run();
    const view = await data<AgentApproval>(
      await call('GET', `${approvals(ws)}/${expiredId}`, { cookie: ws.cookie }),
    );
    expect(view.status).toBe('expired');
    expect(view.request).toBeNull();
    for (const action of ['approve', 'reject']) {
      const res = await call('POST', `${approvals(ws)}/${expiredId}/${action}`, {
        cookie: ws.cookie,
        body: {},
      });
      expect(res.status).toBe(409);
    }
    const expired = await data<{ items: AgentApproval[] }>(
      await call('GET', `${approvals(ws)}?status=expired`, { cookie: ws.cookie }),
    );
    expect(expired.items.map((a) => a.id)).toContain(expiredId);
  });

  it('refuses to queue a call it could not run, and holds every write in `writes` mode', async () => {
    const res = await callTool(token, 'delete_member', {
      channelId: outsiderChannel,
      memberId: `mb_${'0'.repeat(32)}`,
    });
    const { result } = await rpc(res);
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: { code: 'not_found' } });

    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { approvalMode: 'writes', approvalTtlHours: 2 },
      }),
    );
    const held = await rpc(
      await callTool(token, 'create_member', {
        channelId,
        body: { email: uniqueEmail('held'), consent: true },
      }),
    );
    expect(held.result?.structuredContent).toMatchObject({ status: 'pending_approval' });
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { approvalMode: 'never' },
      }),
    );
    const direct = await rpc(
      await callTool(token, 'delete_member', { channelId, memberId: await createMemberV2(token) }),
    );
    expect(direct.result?.isError).toBe(false);
    // A 204 has no body: the result names the status.
    expect(direct.result?.structuredContent).toEqual({ status: 204 });
  });

  it('works with OAuth access tokens, and a revoked grant fails its approvals', async () => {
    const app = await createApp(ws, { scopes: ['members:write', 'channels:read'] });
    const tokens = await connect(ws, app.app.clientId, 'members:write channels:read', {
      resource: MCP_RESOURCE,
    });
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { approvalMode: 'destructive' },
      }),
    );
    const listed = await rpc(await callTool(tokens.access_token, 'list_channels', {}));
    expect(listed.result?.isError).toBe(false);
    expect((await lastAction(ws.workspaceId)).principal_kind).toBe('oauth');

    const memberId = await createMemberV2(token);
    const held = await rpc(
      await callTool(tokens.access_token, 'delete_member', { channelId, memberId }),
    );
    const approvalId = (held.result?.structuredContent as { approvalId: string }).approvalId;
    const grant = await env.DB.prepare(
      'SELECT grant_id FROM oauth_tokens WHERE kind = ?1 ORDER BY created_at DESC LIMIT 1',
    )
      .bind('access')
      .first<{ grant_id: string }>();
    await call('DELETE', `/api/v1/workspaces/${ws.workspaceId}/oauth-grants/${grant!.grant_id}`, {
      cookie: ws.cookie,
    });
    const done = await data<AgentApproval>(
      await call('POST', `${approvals(ws)}/${approvalId}/approve`, { cookie: ws.cookie }),
    );
    expect(done.status).toBe('failed');
    expect(done.credential.label).toBe('Sync tool');
    expect(await memberExists(memberId)).toBe(true);
  });
});

describe('holds that follow the effect', () => {
  let ws: Session;
  let ch: string;
  let token: string;

  beforeAll(async () => {
    ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    ch = (await createChannel(ws)).id;
    await enableFlag('open_operator_mcp', ws.workspaceId);
    token = (
      await createKey(ws, {
        scopes: ['members:write', 'dispatches:write', 'flows:write', 'channels:read'],
      })
    ).secret;
  });

  const pending = (body: RpcBody) =>
    (body.result?.structuredContent as { status?: string } | undefined)?.status ===
    'pending_approval';

  async function memberIn(tags: string[] = ['vip']): Promise<string> {
    const res = await v2('POST', `/v2/channels/${ch}/members`, token, {
      body: { email: uniqueEmail('effect'), consent: true, tags },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }
  const memberRow = (id: string) =>
    env.DB.prepare('SELECT status FROM members WHERE id = ?1').bind(id).first<{ status: string }>();

  it('holds an unsubscribe or a tag replacement through update_member, not a name change', async () => {
    const [a, b, c] = [await memberIn(), await memberIn(), await memberIn()];
    expect(
      pending(
        await rpc(await callTool(token, 'unsubscribe_member', { channelId: ch, memberId: a })),
      ),
    ).toBe(true);
    const status = await rpc(
      await callTool(token, 'update_member', {
        channelId: ch,
        memberId: b,
        body: { status: 'unsubscribed' },
      }),
    );
    expect(pending(status)).toBe(true);
    expect((await memberRow(b))?.status).toBe('active');
    const tags = await rpc(
      await callTool(token, 'update_member', { channelId: ch, memberId: c, body: { tags: [] } }),
    );
    expect(pending(tags)).toBe(true);
    const name = await rpc(
      await callTool(token, 'update_member', {
        channelId: ch,
        memberId: c,
        body: { firstName: 'Ada' },
      }),
    );
    expect(name.result?.isError).toBe(false);
    expect(pending(name)).toBe(false);
    const approval = await env.DB.prepare(
      "SELECT risk, hold_reason, target_json FROM agent_approvals WHERE tool = 'update_member' AND path LIKE ?1",
    )
      .bind(`%${b}`)
      .first<{ risk: string; hold_reason: string; target_json: string }>();
    expect(approval?.risk).toBe('destructive');
    expect(approval?.hold_reason).toMatch(/subscription status/);
    // The approver sees the Member by id and status, never by address.
    expect(JSON.parse(approval!.target_json)).toEqual({ type: 'member', id: b, status: 'active' });
  });

  it('holds tagging while a live Flow starts on a tag, and every API event and new Member', async () => {
    const id = await memberIn();
    const plain = await rpc(
      await callTool(token, 'add_member_tags', {
        channelId: ch,
        memberId: id,
        body: { tags: ['a'] },
      }),
    );
    expect(pending(plain)).toBe(false);
    await env.DB.prepare(
      `INSERT INTO flows (id, workspace_id, channel_id, name, status, draft_graph_json, live_version,
         trigger_type, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'On tag', 'live', '{}', 1, 'tag_added', 0, 0)`,
    )
      .bind(newId('flow'), ws.workspaceId, ch)
      .run();
    const flowing = await rpc(
      await callTool(token, 'add_member_tags', {
        channelId: ch,
        memberId: id,
        body: { tags: ['b'] },
      }),
    );
    expect(pending(flowing)).toBe(true);
    const event = await rpc(
      await callTool(token, 'send_member_event', {
        channelId: ch,
        memberId: id,
        body: { name: 'purchased' },
      }),
    );
    expect(pending(event)).toBe(true);
    const created = await rpc(
      await callTool(token, 'create_member', {
        channelId: ch,
        body: { email: uniqueEmail('agent'), consent: true },
      }),
    );
    expect(pending(created)).toBe(true);
  });

  it('holds widening a post’s web visibility, and narrowing runs', async () => {
    const draft = await rpc(
      await callTool(token, 'create_dispatch', { channelId: ch, body: { subject: 'Paid' } }),
    );
    const dispatchId = (draft.result?.structuredContent as { data: { id: string } }).data.id;
    await env.DB.prepare("UPDATE dispatches SET web_visibility = 'paid' WHERE id = ?1")
      .bind(dispatchId)
      .run();
    const wider = await rpc(
      await callTool(token, 'update_dispatch', {
        channelId: ch,
        dispatchId,
        body: { webVisibility: 'public' },
      }),
    );
    expect(pending(wider)).toBe(true);
    const row = await env.DB.prepare('SELECT web_visibility FROM dispatches WHERE id = ?1')
      .bind(dispatchId)
      .first<{ web_visibility: string }>();
    expect(row?.web_visibility).toBe('paid');
    const narrower = await rpc(
      await callTool(token, 'update_dispatch', {
        channelId: ch,
        dispatchId,
        body: { webVisibility: 'hidden' },
      }),
    );
    expect(pending(narrower)).toBe(false);
    expect(narrower.result?.isError).toBe(false);
  });

  it('runs an approved schedule only for the post the approver saw', async () => {
    const schedule = async (subject: string) => {
      const draft = await rpc(
        await callTool(token, 'create_dispatch', { channelId: ch, body: { subject } }),
      );
      const dispatchId = (draft.result?.structuredContent as { data: { id: string } }).data.id;
      const held = await rpc(
        await callTool(token, 'schedule_dispatch', {
          channelId: ch,
          dispatchId,
          body: { publishAt: new Date(Date.now() + 86_400_000).toISOString() },
        }),
      );
      return {
        dispatchId,
        approvalId: (held.result?.structuredContent as { approvalId: string }).approvalId,
      };
    };
    const edited = await schedule('Subject A');
    const view = await data<AgentApproval>(
      await call('GET', `${approvalsPath(ws.workspaceId)}/${edited.approvalId}`, {
        cookie: ws.cookie,
      }),
    );
    expect(view.target).toMatchObject({ type: 'dispatch', subject: 'Subject A', status: 'draft' });
    expect(view.targetChanged).toBeNull();
    // While it waits, an unheld edit changes what it would send.
    const edit = await rpc(
      await callTool(token, 'update_dispatch', {
        channelId: ch,
        dispatchId: edited.dispatchId,
        body: { subject: 'Subject B' },
      }),
    );
    expect(edit.result?.isError).toBe(false);
    const stale = await data<AgentApproval>(
      await call('GET', `${approvalsPath(ws.workspaceId)}/${edited.approvalId}`, {
        cookie: ws.cookie,
      }),
    );
    expect(stale.targetChanged).toMatch(/changed after this call was held/);
    const done = await data<AgentApproval>(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${edited.approvalId}/approve`, {
        cookie: ws.cookie,
      }),
    );
    expect(done.status).toBe('failed');
    expect(done.reason).toMatch(/changed after this call was held/);
    const row = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(edited.dispatchId)
      .first<{ status: string }>();
    expect(row?.status).toBe('draft');

    // The unedited control reaches the route (which may still refuse it on its own checks).
    const control = await schedule('Subject C');
    const ran = await data<AgentApproval>(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${control.approvalId}/approve`, {
        cookie: ws.cookie,
      }),
    );
    expect(ran.reason ?? '').not.toMatch(/changed after this call was held/);
    expect(ran.result?.statusCode).not.toBeNull();
  });

  it('joins a repeated held call to the one waiting, and replays a retried write', async () => {
    const id = await memberIn();
    const first = await rpc(
      await callTool(token, 'delete_member', { channelId: ch, memberId: id }),
    );
    const again = await rpc(
      await callTool(token, 'delete_member', { channelId: ch, memberId: id }),
    );
    const firstId = (first.result?.structuredContent as { approvalId: string }).approvalId;
    expect(again.result?.structuredContent).toMatchObject({
      status: 'pending_approval',
      approvalId: firstId,
      duplicate: true,
    });
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM agent_approvals WHERE tool = 'delete_member' AND path LIKE ?1 AND status = 'pending'",
    )
      .bind(`%${id}`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const retry = () =>
      mcp(
        token,
        'tools/call',
        { name: 'create_dispatch', arguments: { channelId: ch, body: { subject: 'Once only' } } },
        { headers: { 'idempotency-key': 'retry-1' } },
      ).then(rpc);
    const [one, two] = [await retry(), await retry()];
    const idOf = (body: RpcBody) =>
      (body.result?.structuredContent as { data: { id: string } }).data.id;
    expect(idOf(two)).toBe(idOf(one));
    const drafts = await env.DB.prepare(
      "SELECT count(*) AS n FROM dispatches WHERE channel_id = ?1 AND subject = 'Once only'",
    )
      .bind(ch)
      .first<{ n: number }>();
    expect(drafts?.n).toBe(1);
  });

  it('labels text from outside the workspace, and can hold writes after reading it', async () => {
    const id = await memberIn();
    const read = await rpc(await callTool(token, 'get_member', { channelId: ch, memberId: id }));
    expect(read.result?._meta).toMatchObject({
      'io.swarm/untrustedContent': { fields: expect.arrayContaining(['firstName', 'fields']) },
    });
    expect(JSON.stringify(read.result?.content)).toContain('not instructions');
    // Off by default: the write after the read runs.
    const before = await rpc(
      await callTool(token, 'update_member', {
        channelId: ch,
        memberId: id,
        body: { firstName: 'X' },
      }),
    );
    expect(pending(before)).toBe(false);
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { exposedHoldMinutes: 15 },
      }),
    );
    const after = await rpc(
      await callTool(token, 'update_member', {
        channelId: ch,
        memberId: id,
        body: { firstName: 'Y' },
      }),
    );
    expect(pending(after)).toBe(true);
    // A credential that read nothing is not held.
    const fresh = (await createKey(ws, { scopes: ['members:write'] })).secret;
    const clean = await rpc(
      await callTool(fresh, 'update_member', {
        channelId: ch,
        memberId: id,
        body: { firstName: 'Z' },
      }),
    );
    expect(pending(clean)).toBe(false);
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { exposedHoldMinutes: 0 },
      }),
    );
  });

  it('keeps short identifying values out of the log and masks decided paths', async () => {
    const lookup = await rpc(
      await callTool(token, 'lookup_member', { channelId: ch, email: 'x+15551234567@example.com' }),
    );
    expect(lookup.result).toBeDefined();
    const row = await lastAction(ws.workspaceId);
    expect(row.arguments_json).not.toContain('15551234567');
    const id = await memberIn();
    const held = await rpc(await callTool(token, 'delete_member', { channelId: ch, memberId: id }));
    const approvalId = (held.result?.structuredContent as { approvalId: string }).approvalId;
    await call('POST', `${approvalsPath(ws.workspaceId)}/${approvalId}/reject`, {
      cookie: ws.cookie,
      body: {},
    });
    const stored = await env.DB.prepare('SELECT path FROM agent_approvals WHERE id = ?1')
      .bind(approvalId)
      .first<{ path: string }>();
    expect(stored?.path).toBe(`/v2/channels/${ch}/members/${id}`);
  });
});

describe('keys for agents', () => {
  it('an MCP-only key is refused on /v2 but works through /mcp, where holds apply', async () => {
    const ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    const ch = (await createChannel(ws)).id;
    await enableFlag('open_operator_mcp', ws.workspaceId);
    const agent = await createKey(ws, { scopes: ['members:write'], surface: 'mcp' });
    expect(agent.key.surface).toBe('mcp');
    const integration = await createKey(ws, { scopes: ['members:write'] });
    expect(integration.key.surface).toBe('both');

    const created = await v2('POST', `/v2/channels/${ch}/members`, integration.secret, {
      body: { email: uniqueEmail('surface'), consent: true },
    });
    const memberId = ((await created.json()) as { data: { id: string } }).data.id;
    // Directly, the agent key can't delete (or do anything else).
    const direct = await v2('DELETE', `/v2/channels/${ch}/members/${memberId}`, agent.secret);
    expect(direct.status).toBe(401);
    expect(
      await env.DB.prepare('SELECT 1 FROM members WHERE id = ?1').bind(memberId).first(),
    ).not.toBeNull();
    // Through /mcp the same call waits for a person.
    const held = await rpc(
      await callTool(agent.secret, 'delete_member', { channelId: ch, memberId }),
    );
    expect(held.result?.structuredContent).toMatchObject({ status: 'pending_approval' });

    // An admin can widen or narrow it later, and it is audited with the key.
    const updated = await data<{ surface: string }>(
      await call('PATCH', `/api/v1/workspaces/${ws.workspaceId}/api-keys/${integration.key.id}`, {
        cookie: ws.cookie,
        body: { surface: 'mcp' },
      }),
    );
    expect(updated.surface).toBe('mcp');
    expect((await v2('GET', `/v2/channels/${ch}/members`, integration.secret)).status).toBe(401);
  });

  it('records a forwarding site’s claim about its user beside the verified key', async () => {
    const token = await key(['channels:read']);
    const res = await mcp(
      token,
      'tools/call',
      { name: 'list_channels', arguments: {} },
      { headers: { 'x-swarm-acting-for': 'WordPress blog.example.com user 7 (editor)' } },
    );
    expect(res.status).toBe(200);
    const row = await lastAction(owner.workspaceId);
    expect(row.client_name).toBe('TestClient for WordPress blog.example.com user 7 (editor)');
    expect(row.principal_kind).toBe('key');
  });
});

describe('consent an agent asserts', () => {
  it('needs a person who approved the call before an agent-added Member is active', async () => {
    const ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    const ch = (await createChannel(ws)).id;
    await enableFlag('open_operator_mcp', ws.workspaceId);
    const agent = await createKey(ws, { scopes: ['members:write'] });
    const member = (email: string) =>
      env.DB.prepare(
        `SELECT m.status, c.ticked, c.attested_by FROM members m
           JOIN member_consents c ON c.member_id = m.id WHERE m.email = ?1`,
      )
        .bind(email)
        .first<{ status: string; ticked: number; attested_by: string | null }>();

    // Nothing holds it (mode never): the agent's word alone leaves the Member pending.
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { approvalMode: 'never' },
      }),
    );
    const unheld = uniqueEmail('agent-only');
    const ran = await rpc(
      await callTool(agent.secret, 'create_member', {
        channelId: ch,
        body: { email: unheld, consent: true },
      }),
    );
    expect(ran.result?.isError).toBe(false);
    expect(await member(unheld)).toEqual({
      status: 'pending',
      ticked: 1,
      attested_by: `key:${agent.key.id}`,
    });

    // Held and approved: the approver takes responsibility, and the record names both.
    await data(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { approvalMode: 'destructive' },
      }),
    );
    const approved = uniqueEmail('agent-approved');
    const held = await rpc(
      await callTool(agent.secret, 'create_member', {
        channelId: ch,
        body: { email: approved, consent: true },
      }),
    );
    const approvalId = (held.result?.structuredContent as { approvalId: string }).approvalId;
    await data(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${approvalId}/approve`, {
        cookie: ws.cookie,
      }),
    );
    expect(await member(approved)).toEqual({
      status: 'active',
      ticked: 1,
      attested_by: `${ws.me.operator.id}+key:${agent.key.id}`,
    });

    // A direct /v2 integration call is the integration's own attestation, as before.
    const direct = uniqueEmail('direct');
    await v2('POST', `/v2/channels/${ch}/members`, agent.secret, {
      body: { email: direct, consent: true },
    });
    expect((await member(direct))?.status).toBe('active');
  });
});

describe('an approved call whose outcome is unknown', () => {
  let ws: Session;
  let ch: string;
  let token: string;

  beforeAll(async () => {
    ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    ch = (await createChannel(ws)).id;
    await enableFlag('open_operator_mcp', ws.workspaceId);
    token = (await createKey(ws, { scopes: ['members:write'] })).secret;
  });

  const newMember = async () => {
    const res = await v2('POST', `/v2/channels/${ch}/members`, token, {
      body: { email: uniqueEmail('stuck'), consent: true },
    });
    return ((await res.json()) as { data: { id: string } }).data.id;
  };
  const hold = async (memberId: string) =>
    (
      (await rpc(await callTool(token, 'delete_member', { channelId: ch, memberId }))).result
        ?.structuredContent as { approvalId: string }
    ).approvalId;
  /** As a worker that died after claiming the row leaves it. */
  const interrupt = (approvalId: string, at = Date.now() - 15 * 60 * 1000) =>
    env.DB.prepare(
      `UPDATE agent_approvals SET status = 'approved', result_status = NULL, result_json = NULL,
         executed_action_id = NULL, decided_by = ?2, decided_at = ?3 WHERE id = ?1`,
    )
      .bind(approvalId, ws.me.operator.id, at)
      .run();
  const resolve = (approvalId: string) =>
    call('POST', `${approvalsPath(ws.workspaceId)}/${approvalId}/resolve`, { cookie: ws.cookie });
  const exists = async (id: string) =>
    !!(await env.DB.prepare('SELECT 1 FROM members WHERE id = ?1').bind(id).first());

  it('runs a call that never reached the API, once, and not while it may still be running', async () => {
    const memberId = await newMember();
    const approvalId = await hold(memberId);
    await interrupt(approvalId, Date.now());
    expect((await resolve(approvalId)).status).toBe(409);
    await interrupt(approvalId);
    const done = await data<AgentApproval>(await resolve(approvalId));
    expect(done.status).toBe('executed');
    expect(await exists(memberId)).toBe(false);
    // Finished: it can't be resolved again.
    expect((await resolve(approvalId)).status).toBe(409);
  });

  it('records the first attempt’s answer instead of running it again', async () => {
    const memberId = await newMember();
    const approvalId = await hold(memberId);
    // The first run went through, and the worker died before writing the result.
    await data(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${approvalId}/approve`, {
        cookie: ws.cookie,
      }),
    );
    expect(await exists(memberId)).toBe(false);
    await interrupt(approvalId);
    const done = await data<AgentApproval>(await resolve(approvalId));
    expect(done.status).toBe('executed');
    expect(done.result?.summary).toMatchObject({ replayed: true });
    const runs = await env.DB.prepare(
      "SELECT count(*) AS n FROM agent_actions WHERE approval_id = ?1 AND source = 'approval'",
    )
      .bind(approvalId)
      .first<{ n: number }>();
    expect(runs?.n).toBe(2);
  });

  it('runs nothing while the first attempt’s claim has no answer', async () => {
    const memberId = await newMember();
    const approvalId = await hold(memberId);
    await data(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${approvalId}/approve`, {
        cookie: ws.cookie,
      }),
    );
    await env.DB.prepare("UPDATE api_idempotency SET status = 0, response_json = '' WHERE key = ?1")
      .bind(`agent-approval-${approvalId}`)
      .run();
    await interrupt(approvalId);
    const still = await data<AgentApproval>(await resolve(approvalId));
    expect(still.status).toBe('approved');
    expect(still.reason).toMatch(/may have taken effect/);
    expect(still.result).toBeNull();
  });
});

describe('a second person approves', () => {
  it('refuses the key’s creator when the workspace asks for it, and lets another admin approve', async () => {
    const ws = await signIn();
    await setPlan(ws.workspaceId, 'pro');
    const ch = (await createChannel(ws)).id;
    await enableFlag('open_operator_mcp', ws.workspaceId);
    const token = (await createKey(ws, { scopes: ['members:write'] })).secret;
    const hold = async () => {
      const created = await v2('POST', `/v2/channels/${ch}/members`, token, {
        body: { email: uniqueEmail('two'), consent: true },
      });
      const memberId = ((await created.json()) as { data: { id: string } }).data.id;
      const res = await rpc(await callTool(token, 'delete_member', { channelId: ch, memberId }));
      return (res.result?.structuredContent as { approvalId: string }).approvalId;
    };
    // Off (the default): the creator may approve their own key's call.
    const own = await hold();
    expect(
      (await call('POST', `${approvalsPath(ws.workspaceId)}/${own}/approve`, { cookie: ws.cookie }))
        .status,
    ).toBe(200);

    const settings = await data<AgentSettings>(
      await call('PUT', settingsPath(ws.workspaceId), {
        cookie: ws.cookie,
        body: { separateApprover: true },
      }),
    );
    expect(settings.separateApprover).toBe(true);
    const second = await hold();
    const refused = await call('POST', `${approvalsPath(ws.workspaceId)}/${second}/approve`, {
      cookie: ws.cookie,
    });
    expect(refused.status).toBe(403);
    const still = await env.DB.prepare('SELECT status FROM agent_approvals WHERE id = ?1')
      .bind(second)
      .first<{ status: string }>();
    expect(still?.status).toBe('pending');
    const other = await seatAs(ws.workspaceId, 'admin');
    const approved = await data<AgentApproval>(
      await call('POST', `${approvalsPath(ws.workspaceId)}/${second}/approve`, {
        cookie: other.cookie,
      }),
    );
    expect(approved.status).toBe('executed');
    expect(approved.decidedBy?.id).toBe(other.me.operator.id);
  });
});

describe('retention', () => {
  it('prunes past the plan retention behind a verified anchor, and keeps the chain verifiable', async () => {
    const free = await signIn();
    const day = 86_400_000;
    const now = Date.now();
    const entry = (createdAt: number) => ({
      workspaceId: free.workspaceId,
      source: 'mcp' as const,
      principalKind: 'key' as const,
      principalId: 'ky_x',
      clientName: null,
      clientVersion: null,
      tool: 'list_channels',
      channelId: null,
      risk: 'read' as const,
      arguments: {},
      outcome: 'ok' as const,
      statusCode: 200,
      errorCode: null,
      latencyMs: 1,
      approvalId: null,
      createdAt,
    });
    for (const age of [200, 150, 95, 10]) await appendAgentAction(env.DB, entry(now - age * day));
    await pruneAgentLog(env.DB, now);
    const left = await env.DB.prepare(
      'SELECT seq FROM agent_actions WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(free.workspaceId)
      .all<{ seq: number }>();
    expect(left.results.map((r) => r.seq)).toEqual([4]);
    expect(await verifyAgentLog(env.DB, free.workspaceId)).toMatchObject({
      ok: true,
      anchorSeq: 3,
    });
    await appendAgentAction(env.DB, entry(now));
    expect(await verifyAgentLog(env.DB, free.workspaceId)).toMatchObject({ ok: true, checked: 2 });
  });

  it('refuses a prune whose edited rows were re-hashed up to the prune point', async () => {
    const free = await signIn();
    const now = Date.now();
    for (const age of [200, 150, 95, 10]) {
      await appendAgentAction(env.DB, {
        workspaceId: free.workspaceId,
        source: 'mcp',
        principalKind: 'key',
        principalId: 'ky_x',
        clientName: null,
        clientVersion: null,
        tool: 'list_channels',
        channelId: null,
        risk: 'read',
        arguments: {},
        outcome: 'ok',
        statusCode: 200,
        errorCode: null,
        latencyMs: 1,
        approvalId: null,
        createdAt: now - age * 86_400_000,
      });
    }
    // Edit a row the prune would delete and recompute the hashes through the prune point (seq 3):
    // the one break left is the link to the first kept row.
    await env.DB.prepare(
      "UPDATE agent_actions SET tool = 'delete_channel' WHERE workspace_id = ?1 AND seq = 2",
    )
      .bind(free.workspaceId)
      .run();
    await rehashAgentLog(free.workspaceId, 3);
    const result = await pruneAgentLog(env.DB, now);
    expect(result.refused).toContain(free.workspaceId);
    const left = await env.DB.prepare(
      'SELECT seq FROM agent_actions WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(free.workspaceId)
      .all<{ seq: number }>();
    expect(left.results.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(await verifyAgentLog(env.DB, free.workspaceId)).toMatchObject({
      ok: false,
      brokenAtSeq: 4,
    });
  });

  it('refuses a prune whose re-hashed rows were linked to the first kept row', async () => {
    const free = await signIn();
    const now = Date.now();
    for (const age of [200, 150, 95, 10]) {
      await appendAgentAction(env.DB, {
        workspaceId: free.workspaceId,
        source: 'mcp',
        principalKind: 'key',
        principalId: 'ky_x',
        clientName: null,
        clientVersion: null,
        tool: 'list_channels',
        channelId: null,
        risk: 'read',
        arguments: {},
        outcome: 'ok',
        statusCode: 200,
        errorCode: null,
        latencyMs: 1,
        approvalId: null,
        createdAt: now - age * 86_400_000,
      });
    }
    // As above, and the first kept row's prev_hash rewritten to the new hash of seq 3, so only
    // that row's own hash shows the edit.
    await env.DB.prepare(
      "UPDATE agent_actions SET tool = 'delete_channel' WHERE workspace_id = ?1 AND seq = 2",
    )
      .bind(free.workspaceId)
      .run();
    await rehashAgentLog(free.workspaceId, 3);
    await env.DB.prepare(
      `UPDATE agent_actions SET prev_hash = (SELECT hash FROM agent_actions WHERE workspace_id = ?1 AND seq = 3)
        WHERE workspace_id = ?1 AND seq = 4`,
    )
      .bind(free.workspaceId)
      .run();
    const result = await pruneAgentLog(env.DB, now);
    expect(result.refused).toContain(free.workspaceId);
    const left = await env.DB.prepare(
      'SELECT seq FROM agent_actions WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(free.workspaceId)
      .all<{ seq: number }>();
    expect(left.results.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });
});

/** Recomputes a workspace's agent log hashes through `throughSeq`, as an attacker with D1 access could. */
async function rehashAgentLog(workspaceId: string, throughSeq: number): Promise<void> {
  const rows = await env.DB.prepare(
    'SELECT * FROM agent_actions WHERE workspace_id = ?1 AND seq <= ?2 ORDER BY seq',
  )
    .bind(workspaceId, throughSeq)
    .all<Record<string, unknown>>();
  let prev = '0'.repeat(64);
  for (const row of rows.results) {
    const body = canonicalJson({
      id: row.id,
      seq: row.seq,
      workspaceId: row.workspace_id,
      source: row.source,
      principalKind: row.principal_kind,
      principalId: row.principal_id,
      clientName: row.client_name,
      clientVersion: row.client_version,
      tool: row.tool,
      channelId: row.channel_id,
      risk: row.risk,
      arguments: JSON.parse(row.arguments_json as string) as unknown,
      outcome: row.outcome,
      statusCode: row.status_code,
      errorCode: row.error_code,
      latencyMs: row.latency_ms,
      approvalId: row.approval_id,
      createdAt: row.created_at,
    });
    const hash = await sha256Hex(`${prev}\n${body}`);
    await env.DB.prepare('UPDATE agent_actions SET prev_hash = ?1, hash = ?2 WHERE id = ?3')
      .bind(prev, hash, row.id)
      .run();
    prev = hash;
  }
}

describe('the vault behind the member tools', () => {
  it('opens encrypted fields for an MCP call with the caller’s own key', async () => {
    const channel = (await createChannel(owner)).id;
    const field = await addField(owner, channel, { type: 'text', encrypted: true });
    const member = await addMember(owner, channel, { fields: { [field.key]: 'DE-9' } });
    // The tool runs in process as the key's /v2 request; the vault is handed that same key and
    // resolves it itself, so the value opens only because this key may read this Channel.
    const token = await key(['members:read']);
    const read = await rpc(
      await callTool(token, 'get_member', { channelId: channel, memberId: member.id }),
    );
    expect(read.result?.isError).toBe(false);
    expect(read.result?.structuredContent).toMatchObject({
      data: { fields: { [field.key]: 'DE-9' } },
    });
  });
});
