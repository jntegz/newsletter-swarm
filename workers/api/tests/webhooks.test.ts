// Event Webhooks (Phase 7): /api/v1 endpoints (role matrix, cross-tenant, plan limit, SSRF,
// secrets, rotation, test events, the delivery log and redrive), /v2 with an injected principal
// (scopes, Channel-limited keys) and the API's emission sites.
import { env } from 'cloudflare:test';
import {
  newId,
  type ApiScope,
  type Dispatch,
  type Member,
  type SeatRole,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
} from '@swarm/domain';
import { type WebhookMessage } from '@swarm/engine';
import { useRuntime } from '@swarm/runtime';
import { parseKeyring } from '@swarm/tokens';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt } from '@swarm/vault/testing';
import { createRouter } from '../src/lib/context';
import { parseApiEnv } from '../src/env';
import { useWebhooksQueueForTests } from '../src/lib/webhooks';
import type { ApiPrincipal } from '../src/v2/context';
import { webhooksV2 } from '../src/v2/webhooks';
import { call, createChannel, freshFactor, seatAs, signIn, type Session } from './helpers';
import { addMember, data, errorCode } from './money-helpers';

let owner: Session;
let admin: Session;
let outsider: Session;
let channelId: string;
let otherChannelId: string;
let foreignChannelId: string;
let queued: WebhookMessage[];

const base = (workspaceId = owner.workspaceId) => `/api/v1/workspaces/${workspaceId}/webhooks`;
const body = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://hooks.example.com/swarm',
  events: ['member.created', 'member.updated'],
  ...overrides,
});

beforeAll(async () => {
  // Adding or repointing an endpoint needs a fresh factor of the operator's own.
  owner = await freshFactor(await signIn());
  channelId = (await createChannel(owner)).id;
  otherChannelId = (await createChannel(owner)).id;
  admin = await freshFactor(await seatAs(owner.workspaceId, 'admin'));
  outsider = await freshFactor(await signIn());
  foreignChannelId = (await createChannel(outsider)).id;
  // Room for every test's endpoints.
  await env.DB.prepare("UPDATE workspaces SET plan = 'scale' WHERE id = ?1")
    .bind(owner.workspaceId)
    .run();
});

beforeEach(() => {
  queued = [];
  useWebhooksQueueForTests({
    send: async (message) => void queued.push(message),
    sendBatch: async (messages) => void queued.push(...messages.map((m) => m.body)),
  });
});

afterAll(() => useWebhooksQueueForTests(undefined));

async function create(
  overrides: Record<string, unknown> = {},
  s: Session = admin,
): Promise<WebhookEndpointWithSecret> {
  return data(
    await call('POST', base(s === admin ? owner.workspaceId : s.workspaceId), {
      cookie: s.cookie,
      body: body(overrides),
    }),
    201,
  );
}

describe('endpoints', () => {
  it('creates with a show-once secret, stored sealed', async () => {
    const { endpoint, secret } = await create({ description: 'CRM sync', channelId });
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(endpoint).toMatchObject({
      workspaceId: owner.workspaceId,
      channelId,
      url: 'https://hooks.example.com/swarm',
      description: 'CRM sync',
      events: ['member.created', 'member.updated'],
      status: 'active',
      failureCount: 0,
      previousSecretExpiresAt: null,
      lastDeliveryAt: null,
    });
    expect(JSON.stringify(endpoint)).not.toContain(secret);
    const row = await env.DB.prepare('SELECT secret_enc FROM webhook_endpoints WHERE id = ?1')
      .bind(endpoint.id)
      .first<{ secret_enc: string }>();
    expect(row!.secret_enc).not.toContain(secret);
    expect(
      await decrypt(
        parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS),
        row!.secret_enc,
      ),
    ).toBe(secret);
    // Never readable again.
    const read = await call('GET', `${base()}/${endpoint.id}`, { cookie: admin.cookie });
    expect(await read.text()).not.toContain(secret);
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE target_id = ?1 AND action = 'webhook.created'",
    )
      .bind(endpoint.id)
      .first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('refuses http, IP addresses, private hosts and credentials in the URL', async () => {
    for (const url of [
      'http://hooks.example.com/in',
      'https://127.0.0.1/in',
      'https://169.254.169.254/latest',
      'https://[::1]/in',
      'https://93.184.216.34/in',
      'https://localhost/in',
      'https://intranet/in',
      'https://svc.internal/in',
      'https://user:pw@hooks.example.com/in',
    ]) {
      const res = await call('POST', base(), { cookie: admin.cookie, body: body({ url }) });
      expect(res.status, url).toBe(400);
    }
    const patch = await create();
    const res = await call('PATCH', `${base()}/${patch.endpoint.id}`, {
      cookie: admin.cookie,
      body: { url: 'https://10.0.0.2/in' },
    });
    expect(res.status).toBe(400);
  });

  it('validates events and the Channel filter', async () => {
    expect(
      (await call('POST', base(), { cookie: admin.cookie, body: body({ events: [] }) })).status,
    ).toBe(400);
    expect(
      (await call('POST', base(), { cookie: admin.cookie, body: body({ events: ['nope'] }) }))
        .status,
    ).toBe(400);
    const foreign = await call('POST', base(), {
      cookie: admin.cookie,
      body: body({ channelId: foreignChannelId }),
    });
    expect(foreign.status).toBe(400);
  });

  it('updates, pauses and resumes (resuming clears failures), and deletes', async () => {
    const { endpoint } = await create();
    const path = `${base()}/${endpoint.id}`;
    const updated = await data<WebhookEndpoint>(
      await call('PATCH', path, {
        cookie: admin.cookie,
        body: {
          url: 'https://hooks.example.com/v2',
          events: ['dispatch.sent'],
          channelId: otherChannelId,
          description: null,
          status: 'paused',
        },
      }),
    );
    expect(updated).toMatchObject({
      url: 'https://hooks.example.com/v2',
      events: ['dispatch.sent'],
      channelId: otherChannelId,
      status: 'paused',
    });
    await env.DB.prepare(
      "UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'x', failure_count = 50, first_failure_at = 1 WHERE id = ?1",
    )
      .bind(endpoint.id)
      .run();
    const resumed = await data<WebhookEndpoint>(
      await call('PATCH', path, { cookie: admin.cookie, body: { status: 'active' } }),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      disabledReason: null,
      failureCount: 0,
      firstFailureAt: null,
    });
    expect(
      (await call('PATCH', path, { cookie: admin.cookie, body: { status: 'disabled' } })).status,
    ).toBe(400);
    expect((await call('DELETE', path, { cookie: admin.cookie })).status).toBe(204);
    expect((await call('GET', path, { cookie: admin.cookie })).status).toBe(404);
  });

  it('rotates the secret, keeping the previous one for 24 hours', async () => {
    const { endpoint, secret } = await create();
    const rotated = await data<WebhookEndpointWithSecret>(
      await call('POST', `${base()}/${endpoint.id}/rotate-secret`, { cookie: admin.cookie }),
    );
    expect(rotated.secret).not.toBe(secret);
    const ends = Date.parse(rotated.endpoint.previousSecretExpiresAt!);
    expect(ends - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(ends - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    const row = await env.DB.prepare(
      'SELECT secret_enc, previous_secret_enc FROM webhook_endpoints WHERE id = ?1',
    )
      .bind(endpoint.id)
      .first<{ secret_enc: string; previous_secret_enc: string }>();
    const keys = parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS);
    expect(await decrypt(keys, row!.secret_enc)).toBe(rotated.secret);
    expect(await decrypt(keys, row!.previous_secret_enc)).toBe(secret);
  });

  it('enforces the plan limit on create', async () => {
    const s = await freshFactor(await signIn());
    for (let i = 0; i < 2; i++) await create({}, s);
    const res = await call('POST', base(s.workspaceId), { cookie: s.cookie, body: body() });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
  });

  it('keeps to the plan limit when many endpoints are added at once', async () => {
    const s = await freshFactor(await signIn());
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call('POST', base(s.workspaceId), { cookie: s.cookie, body: body() }),
      ),
    );
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM webhook_endpoints WHERE workspace_id = ?1',
    )
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect({
      added: results.filter((res) => res.status === 201).length,
      refused: results.filter((res) => res.status === 409).length,
      rows: rows?.n,
    }).toEqual({ added: 2, refused: 4, rows: 2 });
  });
});

describe('roles and tenancy', () => {
  it('needs admin or owner on every route; other workspaces answer 404', async () => {
    const { endpoint } = await create();
    const delivery = await data<WebhookDelivery>(
      await call('POST', `${base()}/${endpoint.id}/test`, { cookie: admin.cookie, body: {} }),
      202,
    );
    const e = `${base()}/${endpoint.id}`;
    const routes: [string, string, unknown?][] = [
      ['GET', base()],
      ['POST', base(), body()],
      ['GET', e],
      ['PATCH', e, { description: 'x' }],
      ['POST', `${e}/rotate-secret`],
      ['POST', `${e}/test`, {}],
      ['GET', `${e}/deliveries`],
      ['GET', `${e}/deliveries/${delivery.id}`],
      ['POST', `${e}/deliveries/${delivery.id}/redrive`],
      ['POST', `${e}/redrive`, { since: new Date(0).toISOString() }],
      ['DELETE', e],
    ];
    const roles: SeatRole[] = ['editor', 'author', 'viewer'];
    const lower = await Promise.all(roles.map((r) => seatAs(owner.workspaceId, r)));
    for (const [method, path, payload] of routes) {
      for (const s of lower) {
        const res = await call(method, path, { cookie: s.cookie, body: payload });
        expect(res.status, `${method} ${path} as ${s.email}`).toBe(403);
      }
      const foreign = await call(method, path, { cookie: outsider.cookie, body: payload });
      expect(foreign.status, `${method} ${path} as outsider`).toBe(404);
      expect((await call(method, path, { body: payload })).status).toBe(401);
    }
    // The outsider's own workspace path cannot reach this endpoint either.
    const cross = `${base(outsider.workspaceId)}/${endpoint.id}`;
    expect((await call('GET', cross, { cookie: outsider.cookie })).status).toBe(404);
    expect(
      (await call('GET', `${cross}/deliveries/${delivery.id}`, { cookie: outsider.cookie })).status,
    ).toBe(404);
    // The owner may do everything the admin may.
    expect((await call('GET', e, { cookie: owner.cookie })).status).toBe(200);
    expect((await call('DELETE', e, { cookie: owner.cookie })).status).toBe(204);
  });
});

describe('test events, the delivery log and redrive', () => {
  it('queues a test event and shows it in the log with payload and headers', async () => {
    const { endpoint } = await create({ events: ['dispatch.sent'] });
    const path = `${base()}/${endpoint.id}`;
    const test = await data<WebhookDelivery>(
      await call('POST', `${path}/test`, { cookie: admin.cookie, body: {} }),
      202,
    );
    expect(test).toMatchObject({ eventType: 'dispatch.sent', status: 'pending', test: true });
    expect(queued).toEqual([{ type: 'webhook_delivery', deliveryId: test.id }]);
    const chosen = await data<WebhookDelivery>(
      await call('POST', `${path}/test`, {
        cookie: admin.cookie,
        body: { type: 'member.deleted' },
      }),
      202,
    );
    expect(chosen.eventType).toBe('member.deleted');

    const detail = await data<WebhookDeliveryDetail>(
      await call('GET', `${path}/deliveries/${test.id}`, { cookie: admin.cookie }),
    );
    expect(detail.payload).toMatchObject({
      id: test.eventId,
      type: 'dispatch.sent',
      workspaceId: owner.workspaceId,
    });
    expect(detail.requestHeaders).toMatchObject({
      'Content-Type': 'application/json',
      'Swarm-Event-Id': test.eventId,
      'Swarm-Event-Type': 'dispatch.sent',
    });
    expect(detail.requestHeaders['Swarm-Signature']).toMatch(/^t=\d+,v1=…$/);
    expect(detail.attemptLog).toEqual([]);
  });

  it('pages and filters the log', async () => {
    const { endpoint } = await create();
    const path = `${base()}/${endpoint.id}`;
    for (const type of ['member.created', 'member.updated', 'member.created']) {
      await call('POST', `${path}/test`, { cookie: admin.cookie, body: { type } });
    }
    const first = await data<{ items: WebhookDelivery[]; nextCursor: string }>(
      await call('GET', `${path}/deliveries?limit=2`, { cookie: admin.cookie }),
    );
    expect(first.items).toHaveLength(2);
    const second = await data<{ items: WebhookDelivery[]; nextCursor: string | null }>(
      await call('GET', `${path}/deliveries?limit=2&cursor=${first.nextCursor}`, {
        cookie: admin.cookie,
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((d) => d.id);
    expect(new Set(ids).size).toBe(3);
    const created = await data<{ items: WebhookDelivery[] }>(
      await call('GET', `${path}/deliveries?eventType=member.created`, { cookie: admin.cookie }),
    );
    expect(created.items).toHaveLength(2);
    const failed = await data<{ items: WebhookDelivery[] }>(
      await call('GET', `${path}/deliveries?status=failed`, { cookie: admin.cookie }),
    );
    expect(failed.items).toHaveLength(0);
    expect(
      (await call('GET', `${path}/deliveries?cursor=nope`, { cookie: admin.cookie })).status,
    ).toBe(400);
  });

  it('redrive is idempotent and refused while the endpoint is paused', async () => {
    const { endpoint } = await create();
    const path = `${base()}/${endpoint.id}`;
    // A real delivery that failed.
    const id = newId('webhookDelivery');
    const eventId = newId('webhookEvent');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json,
         status, attempts, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'member.created', '{"id":"x"}', 'failed', 9, ?5, ?5)`,
    )
      .bind(id, endpoint.id, owner.workspaceId, eventId, now)
      .run();
    const redrive = () =>
      call('POST', `${path}/deliveries/${id}/redrive`, { cookie: admin.cookie });
    const once = await data<WebhookDelivery>(await redrive(), 202);
    expect(once).toMatchObject({ status: 'pending', eventId, attempts: 9 });
    expect(queued).toHaveLength(1);
    const twice = await data<WebhookDelivery>(await redrive(), 202);
    expect(twice.status).toBe('pending');
    expect(queued).toHaveLength(1);
    const row = await env.DB.prepare(
      'SELECT payload_json, attempts_base FROM webhook_deliveries WHERE id = ?1',
    )
      .bind(id)
      .first<{ payload_json: string; attempts_base: number }>();
    expect(row).toEqual({ payload_json: '{"id":"x"}', attempts_base: 9 });

    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?1")
      .bind(id)
      .run();
    const since = await data<{ redriven: number }>(
      await call('POST', `${path}/redrive`, {
        cookie: admin.cookie,
        body: { since: new Date(now - 1000).toISOString() },
      }),
      202,
    );
    expect(since.redriven).toBe(1);

    await call('PATCH', path, { cookie: admin.cookie, body: { status: 'paused' } });
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?1")
      .bind(id)
      .run();
    expect((await redrive()).status).toBe(409);
  });
});

describe('/v2 webhooks', () => {
  const principal = (scopes: ApiScope[], channelIds: string[] | null = null): ApiPrincipal => ({
    kind: 'key',
    id: newId('apiKey'),
    workspaceId: owner.workspaceId,
    channelIds,
    scopes,
    plan: 'scale',
    rateCap: null,
  });

  /**
   * The /v2 router behind a stand-in for authenticateV2 (key resolution is not built here). The
   * vault, which resolves credentials itself, is handed the owner's session.
   */
  function v2(p: ApiPrincipal) {
    const app = createRouter();
    useRuntime(app, { service: 'api', parseEnv: parseApiEnv });
    app.use('/v2/*', async (c, next) => {
      c.set('principal', p);
      c.set('credential', {
        kind: 'operator-session',
        sessionToken: owner.cookie.slice(owner.cookie.indexOf('=') + 1),
      });
      await next();
    });
    app.route('/', webhooksV2);
    return (method: string, path: string, payload?: unknown) =>
      app.request(
        path,
        {
          method,
          headers: payload === undefined ? {} : { 'content-type': 'application/json' },
          body: payload === undefined ? null : JSON.stringify(payload),
        },
        env,
      );
  }

  it('reads with webhooks:read and writes with webhooks:write', async () => {
    const reader = v2(principal(['webhooks:read']));
    const writer = v2(principal(['webhooks:write']));
    const created = await data<WebhookEndpointWithSecret>(
      await writer('POST', '/v2/webhooks', body()),
      201,
    );
    expect(created.secret).toMatch(/^whsec_/);
    const list = await data<WebhookEndpoint[]>(await reader('GET', '/v2/webhooks'));
    expect(list.map((e) => e.id)).toContain(created.endpoint.id);
    const refused = await reader('POST', '/v2/webhooks', body());
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('insufficient_scope');
    const nothing = v2(principal(['members:read']));
    expect((await nothing('GET', '/v2/webhooks')).status).toBe(403);
    const id = created.endpoint.id;
    expect((await writer('POST', `/v2/webhooks/${id}/test`, {})).status).toBe(202);
    expect((await reader('GET', `/v2/webhooks/${id}/deliveries`)).status).toBe(200);
    expect((await reader('DELETE', `/v2/webhooks/${id}`)).status).toBe(403);
    expect((await writer('DELETE', `/v2/webhooks/${id}`)).status).toBe(204);
    const audit = await env.DB.prepare(
      "SELECT actor_operator_id, metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'webhook.deleted'",
    )
      .bind(id)
      .first<{ actor_operator_id: string | null; metadata_json: string }>();
    expect(audit!.actor_operator_id).toBeNull();
    expect(JSON.parse(audit!.metadata_json)).toHaveProperty('via');
  });

  it('keeps another workspace’s endpoints out of reach', async () => {
    const theirs = await create({}, outsider);
    const writer = v2(principal(['webhooks:write']));
    expect((await writer('GET', `/v2/webhooks/${theirs.endpoint.id}`)).status).toBe(404);
    expect((await writer('DELETE', `/v2/webhooks/${theirs.endpoint.id}`)).status).toBe(404);
    const list = await data<WebhookEndpoint[]>(await writer('GET', '/v2/webhooks'));
    expect(list.map((e) => e.id)).not.toContain(theirs.endpoint.id);
  });

  it('limits a Channel-limited key to endpoints of its Channels', async () => {
    const limited = v2(principal(['webhooks:write'], [channelId]));
    const wide = await create();
    const mine = await create({ channelId });
    expect((await limited('POST', '/v2/webhooks', body())).status).toBe(400);
    expect(
      (await limited('POST', '/v2/webhooks', body({ channelId: otherChannelId }))).status,
    ).toBe(400);
    const ids = (await data<WebhookEndpoint[]>(await limited('GET', '/v2/webhooks'))).map(
      (e) => e.id,
    );
    expect(ids).toContain(mine.endpoint.id);
    expect(ids).not.toContain(wide.endpoint.id);
    expect((await limited('GET', `/v2/webhooks/${wide.endpoint.id}`)).status).toBe(404);
  });
});

describe('emission from the API', () => {
  const outbox = (type: string, memberId?: string) =>
    env.DB.prepare(
      'SELECT count(*) AS n FROM platform_events WHERE type = ?1 AND (?2 IS NULL OR member_id = ?2)',
    )
      .bind(type, memberId ?? null)
      .first<{ n: number }>()
      .then((r) => r!.n);

  it('member edits, unsubscribes and deletes go to the outbox', async () => {
    const member = await addMember(owner, channelId);
    const path = `/api/v1/members/${member.id}`;
    await data<Member>(
      await call('PATCH', path, { cookie: owner.cookie, body: { firstName: 'Bo' } }),
    );
    expect(await outbox('member.updated', member.id)).toBe(1);
    await data<Member>(
      await call('PATCH', path, { cookie: owner.cookie, body: { status: 'unsubscribed' } }),
    );
    expect(await outbox('member.unsubscribed', member.id)).toBe(1);
    expect(await outbox('member.updated', member.id)).toBe(1);
    expect((await call('DELETE', path, { cookie: owner.cookie })).status).toBe(204);
    const deleted = await env.DB.prepare(
      "SELECT payload_json, member_id FROM platform_events WHERE type = 'member.deleted' AND json_extract(payload_json, '$.id') = ?1",
    )
      .bind(member.id)
      .first<{ payload_json: string; member_id: string | null }>();
    expect(JSON.parse(deleted!.payload_json)).toEqual({ id: member.id, channelId });
    expect(deleted!.member_id).toBeNull();
  });

  it('scheduling a Dispatch emits dispatch.scheduled with the Dispatch', async () => {
    const { id: ch } = await createChannel(owner);
    await addMember(owner, ch);
    const dispatch = await data<Dispatch>(
      await call('POST', `/api/v1/channels/${ch}/dispatches`, {
        cookie: owner.cookie,
        body: {
          subject: 'Issue 1',
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
          },
        },
      }),
      201,
    );
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: at },
      }),
    );
    const row = await env.DB.prepare(
      "SELECT workspace_id, channel_id, payload_json FROM platform_events WHERE type = 'dispatch.scheduled' AND json_extract(payload_json, '$.id') = ?1",
    )
      .bind(dispatch.id)
      .first<{ workspace_id: string; channel_id: string; payload_json: string }>();
    expect(row).toMatchObject({ workspace_id: owner.workspaceId, channel_id: ch });
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      id: dispatch.id,
      status: 'scheduled',
      publishAt: at,
      subject: 'Issue 1',
    });
  });
});
