// Open Operator, pure parts: deriving tools from an OpenAPI document, building the /v2 request
// from arguments, masking, risk and the approval policy. The D1 parts (log, chain, approvals) are
// covered end to end in workers/api/tests/operator.test.ts.
import { describe, expect, it } from 'vitest';
import {
  agentLogRetentionDays,
  bodyEffect,
  classifyCall,
  deriveAgentTools,
  maskArguments,
  maskPath,
  needsApproval,
  toolName,
  toolRequest,
  toolRisk,
  toolsFor,
} from '../src/index';

const doc = {
  paths: {
    '/v2/channels/{channelId}/members': {
      get: {
        operationId: 'listMembers',
        summary: 'Members',
        'x-swarm-scope': 'members:read',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createMember',
        summary: 'Add a Member',
        'x-swarm-scope': 'members:write',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/New' } } },
        },
      },
    },
    '/v2/channels/{channelId}/members/{memberId}': {
      delete: {
        operationId: 'deleteMember',
        summary: 'Delete',
        'x-swarm-scope': 'members:write',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
    },
  },
  components: {
    schemas: {
      New: {
        type: 'object',
        properties: { email: { type: 'string' }, node: { $ref: '#/components/schemas/Node' } },
        required: ['email'],
        example: { email: 'a@example.com' },
      },
      Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
    },
  },
};

describe('deriveAgentTools', () => {
  const tools = deriveAgentTools(doc);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it('names tools after operationIds, sorted, with risks and annotations', () => {
    expect(tools.map((t) => t.name)).toEqual(['create_member', 'delete_member', 'list_members']);
    expect(byName.get('list_members')).toMatchObject({
      risk: 'read',
      scope: 'members:read',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
    expect(byName.get('delete_member')?.annotations.destructiveHint).toBe(true);
    // Adding a Member mails a person and can start Flows: held like a destructive call.
    expect(byName.get('create_member')).toMatchObject({
      risk: 'destructive',
      annotations: { destructiveHint: true, openWorldHint: true },
    });
    expect(byName.get('list_members')?.annotations.openWorldHint).toBe(false);
  });

  it('says when a write can be held and when it reaches outside Swarm', () => {
    const more = deriveAgentTools({
      paths: {
        '/v2/channels/{channelId}/members/{memberId}': {
          patch: {
            operationId: 'updateMember',
            summary: 'Change a Member',
            'x-swarm-scope': 'members:write',
            parameters: [],
          },
        },
        '/v2/channels/{channelId}/feed-sources/{feedSourceId}/check': {
          post: {
            operationId: 'checkFeedSource',
            summary: 'Check a feed now',
            'x-swarm-scope': 'dispatches:write',
            parameters: [],
          },
        },
      },
    });
    const update = more.find((t) => t.name === 'update_member')!;
    expect(update.risk).toBe('write');
    expect(update.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false });
    expect(update.description).toContain('changes the Member’s status');
    const check = more.find((t) => t.name === 'check_feed_source')!;
    expect(check.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
    expect(check.description).toContain('Reaches outside Swarm');
  });

  it('inlines references (stopping self-reference) and drops OpenAPI-only keywords', () => {
    const schema = byName.get('create_member')!.inputSchema;
    const text = JSON.stringify(schema);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('example');
    expect(schema).toMatchObject({
      type: 'object',
      required: ['channelId', 'body'],
      additionalProperties: false,
      properties: { body: { type: 'object', required: ['email'] } },
    });
  });

  it('filters by scope: a write scope grants its read', () => {
    expect(toolsFor(tools, ['members:write']).length).toBe(3);
    expect(toolsFor(tools, ['members:read']).map((t) => t.name)).toEqual(['list_members']);
    expect(toolsFor(tools, ['channels:read'])).toEqual([]);
  });

  it('builds the request: encoded path, query, body; refuses unknown and missing arguments', () => {
    const list = byName.get('list_members')!;
    expect(toolRequest(list, { channelId: 'ch/1', limit: 5, tag: ['a', 'b'] })).toEqual({
      ok: true,
      request: {
        method: 'GET',
        path: '/v2/channels/ch%2F1/members?limit=5&tag=a&tag=b',
        body: null,
      },
    });
    expect(toolRequest(list, {})).toEqual({ ok: false, message: 'channelId is required.' });
    expect(toolRequest(list, { channelId: 'c', nope: 1 })).toMatchObject({ ok: false });
    const create = byName.get('create_member')!;
    expect(toolRequest(create, { channelId: 'c', body: { email: 'x' } })).toMatchObject({
      ok: true,
      request: { method: 'POST', path: '/v2/channels/c/members', body: { email: 'x' } },
    });
  });

  it('refuses a path parameter that is a dot segment, which a URL would resolve away', () => {
    const remove = byName.get('delete_member')!;
    for (const memberId of ['..', '.', 'a/..', './b']) {
      expect(toolRequest(remove, { channelId: 'c', memberId })).toEqual({
        ok: false,
        message: 'memberId is not a valid id.',
      });
    }
    expect(toolRequest(remove, { channelId: '..', memberId: 'm' })).toMatchObject({ ok: false });
    // Dots inside a value are fine: they stay in one segment.
    expect(toolRequest(remove, { channelId: 'c', memberId: 'a..b' })).toMatchObject({
      ok: true,
      request: { path: '/v2/channels/c/members/a..b' },
    });
  });
});

describe('maskArguments', () => {
  it('keeps ids, numbers, booleans and short tokens; redacts personal fields and text', () => {
    const id = `mb_${'a'.repeat(32)}`;
    expect(
      maskArguments({
        memberId: id,
        limit: 10,
        consent: true,
        status: 'active',
        email: 'ada@example.com',
        firstName: 'Ada',
        fields: { city: 'Paris' },
        note: null,
        title: 'A longer title with spaces in it',
        other: 'reach me at ada@example.com',
        tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      }),
    ).toEqual({
      memberId: id,
      limit: 10,
      consent: true,
      status: 'active',
      email: '[redacted]',
      firstName: '[redacted]',
      fields: '[redacted]',
      note: null,
      title: '[text, 32 chars]',
      other: '[email]',
      tags: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', '[+2 more]'],
    });
  });

  it('keeps short values only under listed argument names', () => {
    expect(
      maskArguments({
        licenseKey: 'ABCDE-FGHIJ-KLMNO-PQRST',
        q: '+15551234567',
        search: 'ada',
        status: 'unsubscribed',
        newThing: 'abc123',
        body: { webVisibility: 'public', code: 'X1' },
      }),
    ).toEqual({
      licenseKey: '[text, 23 chars]',
      q: '[text, 12 chars]',
      search: '[text, 3 chars]',
      status: 'unsubscribed',
      newThing: '[text, 6 chars]',
      body: { webVisibility: 'public', code: '[text, 2 chars]' },
    });
  });

  it('masks a decided request path: ids and route words stay', () => {
    const id = `ch_${'a'.repeat(32)}`;
    expect(maskPath(`/v2/channels/${id}/goods/licenses/ABCDE-FGHIJ-KLMNO-PQRST`)).toBe(
      `/v2/channels/${id}/goods/licenses/[value]`,
    );
    expect(maskPath(`/v2/channels/${id}/members?q=ada%40example.com&status=active&limit=5`)).toBe(
      `/v2/channels/${id}/members?q=[value]&status=active&limit=[value]`,
    );
    expect(maskPath(`/v2/channels/${id}/feed-sources`)).toBe(`/v2/channels/${id}/feed-sources`);
  });

  it('bounds depth and size', () => {
    expect(maskArguments({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({
      a: { b: { c: { d: { e: '[…]' } } } },
    });
    const wide = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i]));
    expect(maskArguments(wide)).toMatchObject({ truncated: true });
  });
});

describe('policy', () => {
  it('classifies risk', () => {
    expect(toolRisk('get', 'members:read', 'getMember')).toBe('read');
    expect(toolRisk('post', 'dispatches:read', 'previewDispatch')).toBe('read');
    expect(toolRisk('post', 'dispatches:write', 'scheduleDispatch')).toBe('destructive');
    expect(toolRisk('delete', 'members:write', 'removeMemberTag')).toBe('destructive');
    expect(toolRisk('patch', 'members:write', 'updateMember')).toBe('write');
    expect(toolRisk('post', 'members:write', 'createMember')).toBe('destructive');
    expect(toolRisk('post', 'flows:write', 'sendMemberEvent')).toBe('destructive');
    expect(toolName('getBroadcastStats')).toBe('get_broadcast_stats');
  });

  it('holds a write by its effect: status or tags through update_member, state rules', async () => {
    expect(bodyEffect('updateMember', { status: 'unsubscribed' })).toMatch(/status/);
    expect(bodyEffect('updateMember', { tags: [] })).toMatch(/tags/);
    expect(bodyEffect('updateMember', { firstName: 'Ada' })).toBeNull();
    expect(bodyEffect('updateDispatch', { status: 'x' })).toBeNull();

    const tool = (operationId: string, risk: 'write' | 'read' | 'destructive') =>
      ({ operationId, risk }) as Parameters<typeof classifyCall>[2];
    const principal = {
      kind: 'key' as const,
      id: 'ak_1',
      workspaceId: 'ws_1',
      channelIds: null,
      scopes: [],
    };
    const seen: string[] = [];
    const deps = {
      effectOf: async (_p: unknown, t: { operationId: string }) => {
        seen.push(t.operationId);
        return t.operationId === 'addMemberTags' ? 'A live Flow starts on it.' : null;
      },
    };
    expect(
      await classifyCall(deps, principal, tool('updateMember', 'write'), {
        body: { status: 'unsubscribed' },
      }),
    ).toMatchObject({ risk: 'destructive' });
    expect(
      await classifyCall(deps, principal, tool('addMemberTags', 'write'), { body: {} }),
    ).toEqual({ risk: 'destructive', reason: 'A live Flow starts on it.' });
    expect(
      await classifyCall(deps, principal, tool('updateMember', 'write'), {
        body: { firstName: 'Ada' },
      }),
    ).toEqual({ risk: 'write', reason: null });
    // Reads and destructive tools are never asked about.
    await classifyCall(deps, principal, tool('getMember', 'read'), {});
    await classifyCall(deps, principal, tool('deleteMember', 'destructive'), {});
    expect(seen).toEqual(['addMemberTags', 'updateMember']);
  });

  it('holds calls by mode', () => {
    const on = (mode: 'never' | 'destructive' | 'writes') => ({
      mode,
      ttlHours: 24,
    });
    expect(needsApproval('destructive', on('destructive'))).toBe(true);
    expect(needsApproval('write', on('destructive'))).toBe(false);
    expect(needsApproval('write', on('writes'))).toBe(true);
    expect(needsApproval('read', on('writes'))).toBe(false);
    expect(needsApproval('destructive', on('never'))).toBe(false);
  });

  it('keeps the agent log at least 90 days on every plan', () => {
    expect(agentLogRetentionDays('free')).toBe(90);
    expect(agentLogRetentionDays('pro')).toBe(365);
    expect(agentLogRetentionDays('enterprise')).toBeNull();
  });
});
