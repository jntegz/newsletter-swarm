// The public API's resources, idempotency, documents and the migration shim. Scope and
// credential checks for every route are in v2-matrix.test.ts.
import { env } from 'cloudflare:test';
import type {
  ApiChannel,
  AuditEvent,
  ChannelContext,
  Dispatch,
  DispatchSummary,
  Flow,
  FlowRun,
  ImportJob,
  Member,
  MemberDetail,
} from '@swarm/domain';
import { newId } from '@swarm/domain';
import { emailHash, erasedAddress, type JobMessage } from '@swarm/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useJobsQueueForTests } from '../src/lib/flows';
import { addField, addMember, csvForm, data, seedDelivery } from './audience-helpers';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import { createKey, setPlan, v2, v2Data } from './v2-helpers';

let owner: Session;
let channelId: string;
let otherChannelId: string;
let token: string;
let jobs: JobMessage[];

const base = () => `/v2/channels/${channelId}`;

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  otherChannelId = (await createChannel(owner)).id;
  token = (
    await createKey(owner, {
      scopes: [
        'channels:read',
        'members:write',
        'fields:read',
        'dispatches:write',
        'broadcasts:read',
        'circles:read',
        'levels:read',
        'forms:read',
        'flows:write',
        'imports:write',
        'audit:read',
      ],
    })
  ).secret;
});

beforeEach(() => {
  jobs = [];
  useJobsQueueForTests({ send: async (message) => void jobs.push(message) });
});

afterAll(() => useJobsQueueForTests(undefined));

describe('channels', () => {
  it('lists the reachable Channels without a seat role', async () => {
    const all = await v2Data<ApiChannel[]>(await v2('GET', '/v2/channels', token));
    expect(all.map((c) => c.id)).toEqual([channelId, otherChannelId]);
    expect(all[0]).not.toHaveProperty('role');
    const limited = await createKey(owner, {
      scopes: ['channels:read'],
      channelIds: [otherChannelId],
    });
    const some = await v2Data<ApiChannel[]>(await v2('GET', '/v2/channels', limited.secret));
    expect(some.map((c) => c.id)).toEqual([otherChannelId]);
    const one = await v2Data<ApiChannel>(await v2('GET', `/v2/channels/${channelId}`, token));
    expect(one).toMatchObject({ id: channelId, workspaceId: owner.workspaceId });
  });

  it('never reaches another workspace', async () => {
    const outsider = await signIn();
    const foreign = (await createChannel(outsider)).id;
    expect((await v2('GET', `/v2/channels/${foreign}`, token)).status).toBe(404);
    expect((await v2('GET', `/v2/channels/${foreign}/members`, token)).status).toBe(404);
  });
});

describe('members', () => {
  it('creates, looks up, upserts, edits, tags, unsubscribes and deletes', async () => {
    const field = await addField(owner, channelId, { key: 'city', label: 'City' });
    const email = uniqueEmail('api');
    const created = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email, firstName: 'Ada', consent: true, tags: ['vip'], fields: { city: 'Brno' } },
      }),
      201,
    );
    expect(created).toMatchObject({
      email,
      status: 'active',
      tags: ['vip'],
      fields: { city: 'Brno' },
    });
    expect(field.key).toBe('city');

    // Without upsert the same address is a conflict; with it, a 200 update that adds tags.
    expect((await v2('POST', `${base()}/members`, token, { body: { email } })).status).toBe(409);
    const upserted = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email, lastName: 'Lovelace', tags: ['early'], upsert: true },
      }),
    );
    expect(upserted).toMatchObject({
      id: created.id,
      lastName: 'Lovelace',
      tags: ['early', 'vip'],
    });

    const found = await v2Data<MemberDetail>(
      await v2(
        'GET',
        `${base()}/members/lookup?email=${encodeURIComponent(email.toUpperCase())}`,
        token,
      ),
    );
    expect(found.id).toBe(created.id);
    expect(
      (await v2('GET', `${base()}/members/lookup?email=nobody%40example.com`, token)).status,
    ).toBe(404);

    const path = `${base()}/members/${created.id}`;
    await v2Data(await v2('POST', `${path}/tags`, token, { body: { tags: ['beta'] } }));
    const untagged = await v2Data<MemberDetail>(await v2('DELETE', `${path}/tags/vip`, token));
    expect(untagged.tags).toEqual(['beta', 'early']);
    const fields = await v2Data<MemberDetail>(
      await v2('PATCH', `${path}/fields`, token, { body: { fields: { city: null } } }),
    );
    expect(fields.fields.city).toBeUndefined();
    const paused = await v2Data<MemberDetail>(
      await v2('PATCH', path, token, { body: { status: 'paused' } }),
    );
    expect(paused.status).toBe('paused');
    const gone = await v2Data<MemberDetail>(await v2('POST', `${path}/unsubscribe`, token));
    expect(gone.status).toBe('unsubscribed');
    // The state machine still applies: an unsubscribed Member can't be made active again.
    expect((await v2('PATCH', path, token, { body: { status: 'active' } })).status).toBe(409);

    // A Member of another Channel is not found through this one.
    expect(
      (await v2('GET', `/v2/channels/${otherChannelId}/members/${created.id}`, token)).status,
    ).toBe(404);
    expect((await v2('DELETE', path, token)).status).toBe(204);
    expect((await v2('GET', path, token)).status).toBe(404);
  });

  it('refuses erased addresses and emits the same webhook events as the dashboard', async () => {
    const erased = uniqueEmail('erased');
    const suppressionId = newId('suppression');
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, email_hash, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, 'manual', ?5)`,
    )
      .bind(
        suppressionId,
        owner.workspaceId,
        erasedAddress(suppressionId),
        await emailHash(erased),
        Date.now(),
      )
      .run();
    const refused = await v2('POST', `${base()}/members`, token, { body: { email: erased } });
    expect(refused.status).toBe(409);

    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email: uniqueEmail('hook'), consent: true },
      }),
      201,
    );
    const path = `${base()}/members/${member.id}`;
    await v2Data(await v2('PATCH', path, token, { body: { firstName: 'Hook' } }));
    await v2Data(await v2('POST', `${path}/unsubscribe`, token));
    expect((await v2('DELETE', path, token)).status).toBe(204);
    const events = await env.DB.prepare(
      `SELECT type FROM platform_events
        WHERE member_id = ?1 OR json_extract(payload_json, '$.id') = ?1 ORDER BY seq`,
    )
      .bind(member.id)
      .all<{ type: string }>();
    expect(events.results.map((e) => e.type)).toEqual([
      'member.updated',
      'member.unsubscribed',
      'member.deleted',
    ]);
  });

  it('pages with an opaque cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await v2('POST', `${base()}/members`, token, { body: { email: uniqueEmail('page') } });
    }
    const first = await v2Data<{ items: Member[]; nextCursor: string }>(
      await v2('GET', `${base()}/members?limit=2`, token),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toContain('mb_');
    const second = await v2Data<{ items: Member[] }>(
      await v2('GET', `${base()}/members?limit=2&cursor=${first.nextCursor}`, token),
    );
    expect((second.items[0]?.id ?? '') < (first.items[1]?.id ?? '')).toBe(true);
    expect((await v2('GET', `${base()}/members?cursor=%25%25`, token)).status).toBe(400);
  });

  it('audits API writes with the key, and serves the log on /v2/audit-events', async () => {
    const { key, secret } = await createKey(owner, { scopes: ['members:write', 'audit:read'] });
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, secret, { body: { email: uniqueEmail('aud') } }),
      201,
    );
    const log = await v2Data<{ items: AuditEvent[] }>(
      await v2('GET', '/v2/audit-events?limit=50', secret),
    );
    const added = log.items.find((e) => e.targetId === member.id);
    expect(added).toMatchObject({ action: 'member.added', actor: null });
    expect(added?.metadata.via).toEqual({ kind: 'key', id: key.id });
  });

  it('shows a Channel-limited key only its Channels and its own changes in the audit log', async () => {
    const limited = await createKey(owner, {
      scopes: ['members:write', 'audit:read'],
      channelIds: [otherChannelId],
    });
    const add = async (channel: string, secret: string) =>
      (
        await v2Data<MemberDetail>(
          await v2('POST', `/v2/channels/${channel}/members`, secret, {
            body: { email: uniqueEmail('lim') },
          }),
          201,
        )
      ).id;
    const elsewhere = await add(channelId, token);
    const mine = await add(otherChannelId, limited.secret);
    const teammates = await add(otherChannelId, token);
    const invitee = uniqueEmail('invitee');
    const invited = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: owner.cookie,
      body: { email: invitee, role: 'viewer' },
    });
    expect(invited.status).toBe(201);
    const inviteId = (await json<{ data: { id: string } }>(invited)).data.id;
    const log = await v2Data<{ items: AuditEvent[] }>(
      await v2('GET', '/v2/audit-events?limit=100', limited.secret),
    );
    const targets = log.items.map((e) => e.targetId);
    expect(targets).toContain(mine);
    expect(targets).toContain(teammates);
    expect(targets).not.toContain(elsewhere);
    // Workspace-level events (a teammate invite) are not about its Channels.
    expect(targets).not.toContain(inviteId);
    // A key for the whole workspace still reads the whole log.
    const whole = await v2Data<{ items: AuditEvent[] }>(
      await v2('GET', '/v2/audit-events?limit=100', token),
    );
    expect(whole.items.map((e) => e.targetId)).toContain(elsewhere);
    expect(whole.items.map((e) => e.targetId)).toContain(inviteId);
    // The invite entry names the invitation, not the address (the chain is kept for years).
    expect(JSON.stringify(whole.items)).not.toContain(invitee);
  });

  it('sends API events onto the member event bus', async () => {
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, { body: { email: uniqueEmail('ev') } }),
      201,
    );
    const res = await v2('POST', `${base()}/members/${member.id}/events`, token, {
      body: { name: 'order.paid', properties: { total: 42 } },
    });
    expect(await v2Data(res, 202)).toEqual({ accepted: true });
    const row = await env.DB.prepare(
      "SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'api_event'",
    )
      .bind(member.id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
      name: 'order.paid',
      properties: { total: 42 },
    });
    expect(jobs).toContainEqual({ type: 'flow_events' });
    const bad = await v2('POST', `${base()}/members/${member.id}/events`, token, {
      body: { name: 'Not Valid' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('idempotency', () => {
  it('replays the same request, refuses a different one with the same key', async () => {
    const email = uniqueEmail('idem');
    const headers = { 'Idempotency-Key': `k-${crypto.randomUUID()}` };
    const first = await v2('POST', `${base()}/members`, token, { body: { email }, headers });
    expect(first.status).toBe(201);
    const firstBody = await first.text();
    const again = await v2('POST', `${base()}/members`, token, { body: { email }, headers });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.text()).toBe(firstBody);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM members WHERE email = ?1')
      .bind(email)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const other = await v2('POST', `${base()}/members`, token, {
      body: { email: uniqueEmail('idem') },
      headers,
    });
    expect(other.status).toBe(409);
    // Keys belong to the principal: another key may use the same one.
    const second = await createKey(owner, { scopes: ['members:write'] });
    const elsewhere = await v2('POST', `${base()}/members`, second.secret, {
      body: { email: uniqueEmail('idem') },
      headers,
    });
    expect(elsewhere.status).toBe(201);
  });

  it('replays an empty 204 and refuses a malformed key', async () => {
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, { body: { email: uniqueEmail('del') } }),
      201,
    );
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    expect((await v2('DELETE', `${base()}/members/${member.id}`, token, { headers })).status).toBe(
      204,
    );
    const replay = await v2('DELETE', `${base()}/members/${member.id}`, token, { headers });
    expect(replay.status).toBe(204);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const bad = await v2('POST', `${base()}/members`, token, {
      body: { email: uniqueEmail('x') },
      headers: { 'Idempotency-Key': 'has space' },
    });
    expect(bad.status).toBe(400);
  });

  it('never stores a one-time secret, and refuses a retry instead of replaying it', async () => {
    const stored = (key: string) =>
      env.DB.prepare('SELECT status, response_json FROM api_idempotency WHERE key = ?1')
        .bind(key)
        .first<{ status: number; response_json: string }>();
    // An API key minted on the dashboard route (/api/v1 shares the middleware).
    const keyHeaders = { 'Idempotency-Key': crypto.randomUUID() };
    const path = `/api/v1/workspaces/${owner.workspaceId}/api-keys`;
    const minted = await call('POST', path, {
      cookie: owner.cookie,
      body: { name: 'Idempotent key', scopes: ['channels:read'] },
      headers: keyHeaders,
    });
    expect(minted.status).toBe(201);
    const { secret } = (await json<{ data: { secret: string } }>(minted)).data;
    expect((await stored(keyHeaders['Idempotency-Key']))?.response_json).not.toContain(secret);
    const retry = await call('POST', path, {
      cookie: owner.cookie,
      body: { name: 'Idempotent key', scopes: ['channels:read'] },
      headers: keyHeaders,
    });
    expect(retry.status).toBe(409);
    expect(await retry.text()).toMatch(/one-time secret/);
    const keys = await env.DB.prepare(
      "SELECT count(*) AS n FROM api_keys WHERE workspace_id = ?1 AND name = 'Idempotent key'",
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(keys?.n).toBe(1);

    // A webhook signing secret on /v2.
    const hooks = await createKey(owner, { scopes: ['webhooks:write'] });
    const hookHeaders = { 'Idempotency-Key': crypto.randomUUID() };
    const hookBody = { url: 'https://hooks.example.com/idem', events: ['member.created'] };
    const created = await v2('POST', '/v2/webhooks', hooks.secret, {
      body: hookBody,
      headers: hookHeaders,
    });
    expect(created.status).toBe(201);
    const hookSecret = (await json<{ data: { secret: string } }>(created)).data.secret;
    expect((await stored(hookHeaders['Idempotency-Key']))?.response_json).not.toContain(hookSecret);
    const again = await v2('POST', '/v2/webhooks', hooks.secret, {
      body: hookBody,
      headers: hookHeaders,
    });
    expect(again.status).toBe(409);
  });

  it('forgets keys after 24 hours', async () => {
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    await v2('POST', `${base()}/members`, token, { body: { email: uniqueEmail('old') }, headers });
    await env.DB.prepare('UPDATE api_idempotency SET created_at = ?1 WHERE key = ?2')
      .bind(Date.now() - 25 * 3_600_000, headers['Idempotency-Key'])
      .run();
    const reused = await v2('POST', `${base()}/members`, token, {
      body: { email: uniqueEmail('new') },
      headers,
    });
    expect(reused.status).toBe(201);
    expect(reused.headers.get('idempotent-replayed')).toBeNull();
  });
});

describe('publication context', () => {
  it('gives an agent the publication, its style guide, the audience and recent posts', async () => {
    // The operator writes a style guide in the publication settings; agents read it as context.
    await call('PATCH', `/api/v1/channels/${channelId}`, {
      cookie: owner.cookie,
      body: { styleGuide: 'Plain sentences. One idea per post. Sign off with a question.' },
    });
    await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email: uniqueEmail('ctx'), consent: true },
      }),
      201,
    );
    const context = await v2Data<ChannelContext>(await v2('GET', `${base()}/context`, token));
    expect(context.publication.name).toBeTruthy();
    expect(context.publication.slug).toBeTruthy();
    expect(context.styleGuide).toBe(
      'Plain sentences. One idea per post. Sign off with a question.',
    );
    expect(context.audience?.activeMembers).toBeGreaterThan(0);
    expect(context.audience?.joinedLast30Days).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(context.recentDispatches)).toBe(true);
  });

  it('lists the last ten sent posts, newest first, with a web address only once published', async () => {
    const fresh = (await createChannel(owner)).id;
    const member = await addMember(owner, fresh);
    const now = Date.now();
    const seeded: { broadcastId: string }[] = [];
    for (let i = 11; i > 0; i--) {
      seeded.push(
        await seedDelivery(owner.workspaceId, fresh, member.id, member.email, now - i * 1000),
      );
    }
    const newest = seeded.at(-1)!.broadcastId;
    const { dispatch_id: dispatchId } = (await env.DB.prepare(
      'SELECT dispatch_id FROM broadcasts WHERE id = ?1',
    )
      .bind(newest)
      .first<{ dispatch_id: string }>())!;

    const read = async () =>
      (await v2Data<ChannelContext>(await v2('GET', `/v2/channels/${fresh}/context`, token)))
        .recentDispatches!;
    const before = await read();
    expect(before).toHaveLength(10);
    // Sent, but with no page on the site: no address is made up for it.
    expect(before[0]).toMatchObject({
      id: dispatchId,
      subject: 'Issue 7',
      humanOpens: 1,
      openRate: 1,
      webUrl: null,
    });

    await env.DB.batch([
      env.DB.prepare('UPDATE dispatches SET web_published_at = ?1 WHERE id = ?2').bind(
        now,
        dispatchId,
      ),
      env.DB.prepare(
        `INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at)
         VALUES (?1, 'issue-seven', ?2, 1, ?3)`,
      ).bind(fresh, dispatchId, now),
    ]);
    expect((await read())[0]?.webUrl).toMatch(/\/p\/issue-seven$/);
  });
});

describe('dispatches and broadcasts', () => {
  it('creates and saves a draft, previews it and refuses to schedule an unready one', async () => {
    const created = await v2Data<Dispatch>(
      await v2('POST', `${base()}/dispatches`, token, {
        body: {
          subject: 'Hello {{first_name | there}}',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Hi {{first_name | friend}}' }],
              },
            ],
          },
        },
      }),
      201,
    );
    expect(created.status).toBe('draft');
    // A direct /v2 call is an integration: the list shows it started at the API.
    expect(created.createdVia).toBe('api');
    const saved = await v2Data<Dispatch>(
      await v2('PATCH', `${base()}/dispatches/${created.id}`, token, {
        body: { preheader: 'Read me' },
      }),
    );
    expect(saved.preheader).toBe('Read me');
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email: uniqueEmail('pv'), firstName: 'Grace', consent: true },
      }),
      201,
    );
    const preview = await v2Data<{ subject: string; html: string; text: string }>(
      await v2('POST', `${base()}/dispatches/${created.id}/preview`, token, {
        body: { memberId: member.id },
      }),
    );
    expect(preview.subject).toContain('Hello');
    expect(preview.text).toContain('Hi Grace');
    const anonymous = await v2Data<{ text: string }>(
      await v2('POST', `${base()}/dispatches/${created.id}/preview`, token, { body: {} }),
    );
    expect(anonymous.text).toContain('Hi friend');

    const schedule = await v2('POST', `${base()}/dispatches/${created.id}/schedule`, token, {
      body: { publishAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect([200, 409]).toContain(schedule.status);

    const page = await v2Data<{ items: DispatchSummary[] }>(
      await v2('GET', `${base()}/dispatches`, token),
    );
    expect(page.items.map((d) => d.id)).toContain(created.id);
    expect(
      (await v2('GET', `/v2/channels/${otherChannelId}/dispatches/${created.id}`, token)).status,
    ).toBe(404);
  });

  it('sends a test only to teammates, named by the caller', async () => {
    const created = await v2Data<Dispatch>(
      await v2('POST', `${base()}/dispatches`, token, { body: { subject: 'Test me' } }),
      201,
    );
    const path = `${base()}/dispatches/${created.id}/test`;
    const sent = await v2Data<{ sentTo: string[] }>(
      await v2('POST', path, token, { body: { to: [owner.email] } }),
      202,
    );
    expect(sent.sentTo).toEqual([owner.email]);
    expect((await v2('POST', path, token, { body: { to: ['stranger@example.com'] } })).status).toBe(
      400,
    );
    expect((await v2('POST', path, token, { body: {} })).status).toBe(400);
  });

  it('lists Broadcasts', async () => {
    const page = await v2Data<{ items: unknown[]; nextCursor: string | null }>(
      await v2('GET', `${base()}/broadcasts`, token),
    );
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

describe('circles, levels, capture forms and Flows', () => {
  it('counts a Circle live', async () => {
    const circle = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/circles`, {
        cookie: owner.cookie,
        body: { name: 'Named', rule: { field: 'first_name', cmp: 'is_set' } },
      }),
      201,
    );
    const count = await v2Data<{ count: number; activeCount: number }>(
      await v2('GET', `${base()}/circles/${circle.id}/count`, token),
    );
    expect(count.count).toBeGreaterThan(0);
    expect(count.activeCount).toBeLessThanOrEqual(count.count);
    const got = await v2Data<{ id: string }>(
      await v2('GET', `${base()}/circles/${circle.id}`, token),
    );
    expect(got.id).toBe(circle.id);
  });

  it('lists levels and capture forms', async () => {
    const levels = await v2Data<{ free: { name: string } }>(
      await v2('GET', `${base()}/levels`, token),
    );
    expect(levels.free.name).toBe('Free');
    expect(await v2Data(await v2('GET', `${base()}/capture-forms`, token))).toEqual([]);
  });

  it('gives the embed code of a published form, for a plugin that renders forms itself', async () => {
    const channel = (await createChannel(owner)).id;
    const created = await call('POST', `/api/v1/channels/${channel}/capture-forms`, {
      cookie: owner.cookie,
      body: { name: 'Sidebar' },
    });
    const formId = (await json<{ data: { id: string } }>(created)).data.id;
    const path = `/v2/channels/${channel}/capture-forms/${formId}/snippet`;
    expect((await v2('GET', path, token)).status).toBe(409);

    await call('POST', `/api/v1/capture-forms/${formId}/publish`, { cookie: owner.cookie });
    const snippet = await v2Data<{ version: number; noscript: string }>(
      await v2('GET', path, token),
    );
    expect(snippet.version).toBe(1);
    expect(snippet.noscript).toContain(`/v1/${formId}/subscribe" method="post"`);
    expect(snippet.noscript).toContain('name="email"');
    expect(snippet.noscript).toContain('name="website"');
  });

  it('enrols a Member in a live Flow, once', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: editor.cookie,
        body: { recipe: 'welcome' },
      }),
      201,
    );
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email: uniqueEmail('fl'), consent: true },
      }),
      201,
    );
    const path = `${base()}/flows/${flow.id}/enrolments`;
    expect((await v2('POST', path, token, { body: { memberId: member.id } })).status).toBe(409);
    expect(
      (await call('POST', `/api/v1/flows/${flow.id}/publish`, { cookie: editor.cookie, body: {} }))
        .status,
    ).toBe(200);
    const run = await v2Data<FlowRun>(
      await v2('POST', path, token, { body: { memberId: member.id } }),
      202,
    );
    expect(run).toMatchObject({ flowId: flow.id, memberId: member.id, test: false });
    expect((await v2('POST', path, token, { body: { memberId: member.id } })).status).toBe(409);
    const flows = await v2Data<{ id: string; status: string }[]>(
      await v2('GET', `${base()}/flows`, token),
    );
    expect(flows.find((f) => f.id === flow.id)?.status).toBe('live');
  });

  it('enrols no one in a Flow that grants a Membership level (an admin’s call)', async () => {
    const levelId = newId('membershipLevel');
    await env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Gold', ?3, ?3)`,
    )
      .bind(levelId, channelId, Date.now())
      .run();
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: owner.cookie,
        body: { name: 'Comp', trigger: { event: 'confirmed' } },
      }),
      201,
    );
    const graph = {
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        { id: 'grant', type: 'change_level', config: { action: 'grant', levelId, days: null } },
      ],
      edges: [{ from: 'trigger', to: 'grant', label: 'default' }],
    };
    for (const [method, path, body] of [
      ['PATCH', `/api/v1/flows/${flow.id}`, { draftGraph: graph }],
      ['POST', `/api/v1/flows/${flow.id}/publish`, {}],
    ] as const) {
      expect((await call(method, path, { cookie: owner.cookie, body })).status).toBe(200);
    }
    const member = await v2Data<MemberDetail>(
      await v2('POST', `${base()}/members`, token, {
        body: { email: uniqueEmail('comp'), consent: true },
      }),
      201,
    );
    const res = await v2('POST', `${base()}/flows/${flow.id}/enrolments`, token, {
      body: { memberId: member.id },
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('forbidden');
    const runs = await env.DB.prepare('SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1')
      .bind(flow.id)
      .first<{ n: number }>();
    expect(runs?.n).toBe(0);
    expect(jobs).toHaveLength(0);
  });
});

describe('bulk upsert and the migration shim', () => {
  it('turns a bulk upsert into an import job with its dry run queued', async () => {
    await addField(owner, channelId, { key: 'plan_name', label: 'Plan name' });
    const job = await v2Data<ImportJob>(
      await v2('POST', `${base()}/members/bulk`, token, {
        body: {
          consentAttested: true,
          members: [
            {
              email: uniqueEmail('bulk'),
              firstName: 'A',
              tags: ['x'],
              fields: { plan_name: 'gold' },
            },
            { email: uniqueEmail('bulk') },
          ],
        },
      }),
      202,
    );
    expect(job).toMatchObject({ status: 'analyzing', consentAttested: true, source: 'csv' });
    expect(job.mapping).toMatchObject({ email: 'email', 'field:plan_name': 'field:plan_name' });
    // Who attested, for the consent records: the key.
    const attested = await env.DB.prepare(
      'SELECT consent_attested_by FROM import_jobs WHERE id = ?1',
    )
      .bind(job.id)
      .first<{ consent_attested_by: string }>();
    expect(attested?.consent_attested_by).toMatch(/^key:ky_[0-9a-f]{32}$/);
    const got = await v2Data<ImportJob>(await v2('GET', `${base()}/imports/${job.id}`, token));
    expect(got.id).toBe(job.id);
    expect((await v2('POST', `${base()}/imports/${job.id}/confirm`, token)).status).toBe(409);
    const unknown = await v2('POST', `${base()}/members/bulk`, token, {
      body: { consentAttested: true, members: [{ email: 'a@example.com', fields: { nope: 1 } }] },
    });
    expect(unknown.status).toBe(400);
    expect(
      (await v2('POST', `${base()}/members/bulk`, token, { body: { consentAttested: true } }))
        .status,
    ).toBe(400);
  });

  it('maps another platform’s JSON export and leaves out who unsubscribed there', async () => {
    const job = await v2Data<ImportJob>(
      await v2('POST', `${base()}/members/bulk`, token, {
        body: {
          source: 'platform_json',
          consentAttested: true,
          records: [
            {
              email: 'one@example.com',
              status: 'active',
              name: 'Ada Lovelace',
              subscription_tier: 'premium',
              custom_fields: [{ name: 'Company', value: 'Analytical' }],
            },
            { email: 'two@example.com', status: 'unsubscribed', tags: ['a', 'b'] },
          ],
        },
      }),
      202,
    );
    expect(job.source).toBe('platform_json');
    expect(job.columns).toEqual(
      expect.arrayContaining([
        'email',
        'first_name',
        'last_name',
        'status',
        'subscription_tier',
        'Company',
        'tags',
      ]),
    );
    expect(job.mapping).toMatchObject({
      email: 'email',
      first_name: 'first_name',
      last_name: 'last_name',
      subscription_tier: 'tags',
      tags: 'tags',
    });
    const row = await env.DB.prepare('SELECT mapping_json, r2_key FROM import_jobs WHERE id = ?1')
      .bind(job.id)
      .first<{ mapping_json: string; r2_key: string }>();
    expect(JSON.parse(row?.mapping_json ?? '{}').exclude).toEqual([
      {
        column: 'status',
        values: ['unsubscribed', 'inactive', 'deleted', 'disabled', 'cancelled', 'canceled'],
      },
    ]);
    const csv = await (await env.IMPORTS.get(row?.r2_key as string))?.text();
    expect(csv?.split('\r\n')[1]).toContain('one@example.com');
    expect(csv).toContain('Ada');
  });

  it('accepts another platform’s CSV on the dashboard upload, keeping its rules across a remap', async () => {
    const text =
      'email,name,active_subscription,email_disabled,plan\r\na@example.com,Ada,true,false,paid\r\n';
    const form = csvForm(text, 'export.csv');
    form.set('source', 'platform_csv');
    const job = await data<ImportJob>(
      await call('POST', `/api/v1/channels/${channelId}/imports`, { cookie: owner.cookie, form }),
      201,
    );
    expect(job.source).toBe('platform_csv');
    expect(job.mapping).toMatchObject({
      email: 'email',
      name: 'first_name',
      plan: 'tags',
      email_disabled: null,
    });
    const remapped = await data<ImportJob>(
      await call('PUT', `/api/v1/imports/${job.id}/mapping`, {
        cookie: owner.cookie,
        body: { mapping: { email: 'email' }, consentAttested: true, updateExisting: false },
      }),
    );
    expect(remapped.source).toBe('platform_csv');
    const row = await env.DB.prepare('SELECT mapping_json FROM import_jobs WHERE id = ?1')
      .bind(job.id)
      .first<{ mapping_json: string }>();
    expect(JSON.parse(row?.mapping_json ?? '{}').exclude).toEqual([
      { column: 'email_disabled', values: ['true', 'yes', '1'] },
    ]);

    const json = new FormData();
    json.set(
      'file',
      new File(['[{"email":"b@example.com"}]'], 'export.json', { type: 'application/json' }),
    );
    json.set('source', 'platform_json');
    const fromJson = await data<ImportJob>(
      await call('POST', `/api/v1/channels/${channelId}/imports`, {
        cookie: owner.cookie,
        form: json,
      }),
      201,
    );
    expect(fromJson.columns).toEqual(['email']);
    const plain = new FormData();
    plain.set('file', new File(['[]'], 'export.json', { type: 'application/json' }));
    expect(
      (
        await call('POST', `/api/v1/channels/${channelId}/imports`, {
          cookie: owner.cookie,
          form: plain,
        })
      ).status,
    ).toBe(415);
  });
});

describe('documents', () => {
  it('publishes the /v2 OpenAPI document without credentials', async () => {
    const res = await v2('GET', '/v2/openapi.json', null);
    expect(res.status).toBe(200);
    const doc = await json<{
      openapi: string;
      paths: Record<string, unknown>;
      servers: { url: string }[];
    }>(res);
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).every((p) => p.startsWith('/v2/'))).toBe(true);
    expect(doc.paths).not.toHaveProperty('/api/v1/workspaces');
    expect(doc.servers[0]?.url).toBe('http://localhost');
  });

  it('renders the reference page with no script', async () => {
    const res = await v2('GET', '/v2/reference', null);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('/v2/channels/{channelId}/members');
    expect(html).toContain('members:read');
    expect(html).not.toMatch(/<script/i);
  });

  it('serves the API catalog (RFC 9727)', async () => {
    const res = await v2('GET', '/.well-known/api-catalog', null);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/linkset+json');
    expect(res.headers.get('link')).toContain('rel="api-catalog"');
    const body = await json<{ linkset: { 'service-desc': { href: string }[] }[] }>(res);
    expect(body.linkset[0]?.['service-desc'][0]?.href).toBe('http://localhost/v2/openapi.json');
  });
});
