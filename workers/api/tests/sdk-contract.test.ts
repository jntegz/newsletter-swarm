// Contract tests (Phase 7 exit gate): the TypeScript SDK generated from docs/openapi-v2.json,
// run against the worker. Responses are also parsed with the domain schemas the document was
// built from, so the SDK's types, the document and the runtime agree.
import { SELF } from 'cloudflare:test';
import {
  ApiChannelSchema,
  ApiCircleCountSchema,
  ApiPreviewSchema,
  AuditEventSchema,
  DispatchSchema,
  ImportJobSchema,
  MemberDetailSchema,
  MemberFieldSchema,
  MemberSchema,
  MembershipLevelListSchema,
  TagSchema,
  page,
} from '@swarm/domain';
import { OPERATIONS, SwarmApiError, SwarmClient } from '@swarm/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import committed from '../../../docs/openapi-v2.json';
import { v2OpenApiDocument } from '../src/v2/docs';
import { addField, data } from './audience-helpers';
import { call, createChannel, signIn, uniqueEmail, type Session } from './helpers';
import { createKey, setPlan } from './v2-helpers';

let owner: Session;
let channelId: string;
let client: SwarmClient;

const sdk = (token: string) =>
  new SwarmClient({
    baseUrl: 'http://localhost',
    token,
    fetch: (request) => SELF.fetch(request),
  });

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  const { secret } = await createKey(owner, {
    scopes: [
      'channels:read',
      'members:write',
      'fields:read',
      'dispatches:write',
      'circles:read',
      'levels:read',
      'imports:write',
      'audit:read',
    ],
  });
  client = sdk(secret);
});

describe('the SDK', () => {
  it('is generated from the current document', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(v2OpenApiDocument())));
    const doc = v2OpenApiDocument();
    const fromDoc = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { operationId: string; 'x-swarm-scope': string }>).map(
        ([method, op]) => [
          op.operationId,
          { method: method.toUpperCase(), path, scope: op['x-swarm-scope'] },
        ],
      ),
    );
    expect(Object.fromEntries(fromDoc)).toEqual(OPERATIONS);
  });

  it('reads Channels, fields, tags and levels', async () => {
    const channels = await client.listChannels();
    expect(channels.map((c) => ApiChannelSchema.parse(c).id)).toEqual([channelId]);
    expect(ApiChannelSchema.parse(await client.getChannel({ channelId })).id).toBe(channelId);
    await addField(owner, channelId, { key: 'company', label: 'Company' });
    const fields = await client.listMemberFields({ channelId });
    expect(fields.map((f) => MemberFieldSchema.parse(f).key)).toContain('company');
    MembershipLevelListSchema.parse(await client.listLevels({ channelId }));
    expect(await client.listTags({ channelId })).toEqual([]);
  });

  it('manages a Member end to end', async () => {
    const email = uniqueEmail('sdk');
    const created = await client.createMember(
      {
        channelId,
        body: { email, firstName: 'Ada', consent: true, fields: { company: 'Analytical' } },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(MemberDetailSchema.parse(created)).toMatchObject({ email, status: 'active' });
    const memberId = created.id;
    expect((await client.lookupMember({ channelId, query: { email } })).id).toBe(memberId);
    const tagged = await client.addMemberTags({
      channelId,
      memberId,
      body: { tags: ['vip', 'beta'] },
    });
    expect(tagged.tags).toEqual(['beta', 'vip']);
    const untagged = await client.removeMemberTag({ channelId, memberId, tagName: 'beta' });
    expect(untagged.tags).toEqual(['vip']);
    const fields = await client.setMemberFields({
      channelId,
      memberId,
      body: { fields: { company: null } },
    });
    expect(fields.fields).toEqual({});
    const updated = await client.updateMember({
      channelId,
      memberId,
      body: { lastName: 'Lovelace' },
    });
    expect(MemberDetailSchema.parse(updated).lastName).toBe('Lovelace');
    const list = await client.listMembers({ channelId, query: { limit: 10, tag: 'vip' } });
    expect(
      page(MemberSchema)
        .parse(list)
        .items.map((m) => m.id),
    ).toEqual([memberId]);
    expect((await client.unsubscribeMember({ channelId, memberId })).status).toBe('unsubscribed');
    expect(await client.deleteMember({ channelId, memberId })).toBeUndefined();
    TagSchema.array().parse(await client.listTags({ channelId }));
  });

  it('drafts, previews and lists Dispatches', async () => {
    const draft = await client.createDispatch({ channelId, body: { subject: 'From the SDK' } });
    expect(DispatchSchema.parse(draft).status).toBe('draft');
    const saved = await client.updateDispatch({
      channelId,
      dispatchId: draft.id,
      body: { preheader: 'Typed' },
    });
    expect(saved.preheader).toBe('Typed');
    ApiPreviewSchema.parse(
      await client.previewDispatch({ channelId, dispatchId: draft.id, body: {} }),
    );
    const list = await client.listDispatches({ channelId });
    expect(list.items.map((d) => d.id)).toContain(draft.id);
  });

  it('counts Circles and starts a bulk import', async () => {
    const circle = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/circles`, {
        cookie: owner.cookie,
        body: { name: 'Named', rule: { field: 'first_name', cmp: 'is_set' } },
      }),
      201,
    );
    ApiCircleCountSchema.parse(await client.countCircle({ channelId, circleId: circle.id }));
    const job = await client.bulkUpsertMembers({
      channelId,
      body: { consentAttested: false, members: [{ email: uniqueEmail('bulk') }] },
    });
    expect(ImportJobSchema.parse(job).status).toBe('analyzing');
    expect((await client.getImport({ channelId, importId: job.id })).id).toBe(job.id);
  });

  it('pages the audit log', async () => {
    const first = await client.listAuditEvents({ query: { limit: 2 } });
    expect(page(AuditEventSchema).parse(first).items).toHaveLength(2);
    const next = await client.listAuditEvents({
      query: { limit: 2, cursor: first.nextCursor as string },
    });
    expect(next.items[0]!.seq).toBeLessThan(first.items[1]!.seq);
  });

  it('throws typed errors and tracks the rate limit', async () => {
    expect(client.rateLimit).toMatchObject({ limit: 900 });
    const missing = await client
      .getMember({ channelId, memberId: `mb_${'0'.repeat(32)}` })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SwarmApiError);
    expect(missing).toMatchObject({ status: 404, code: 'not_found' });
    const invalid = await client
      .createMember({ channelId, body: { email: 'not an address' } })
      .catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 400, code: 'invalid_input' });
    expect((invalid as SwarmApiError).details.length).toBeGreaterThan(0);
    const scoped = await sdk((await createKey(owner, { scopes: ['channels:read'] })).secret)
      .listMembers({ channelId })
      .catch((error: unknown) => error);
    expect(scoped).toMatchObject({ status: 403, code: 'insufficient_scope' });
    const capped = sdk((await createKey(owner, { scopes: ['channels:read'], rateCap: 1 })).secret);
    let limited: unknown;
    for (let i = 0; i < 4 && !limited; i++) {
      limited = await capped.listChannels().then(
        () => undefined,
        (error: unknown) => error,
      );
    }
    expect(limited).toMatchObject({ status: 429, code: 'rate_limited' });
    expect((limited as SwarmApiError).retryAfter).toBeGreaterThan(0);
  });
});
