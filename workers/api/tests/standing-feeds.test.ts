// Standing feeds and credentials (docs/security.md "Standing feeds"): creating or repointing an
// export destination, a webhook endpoint or an API key needs a fresh check with a factor of the
// operator's own; a /v2 principal can only propose an endpoint; each one runs only while the admin
// behind it keeps the role; the rest of the team is told where data now goes.
// S04-X-V-feed-activation-gate (local part), S04-P1-V-demotion-key-invite, S04-P1-V-role-grant-matrix.
import { env } from 'cloudflare:test';
import type {
  ApiKey,
  ExportDestination,
  SeatRole,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import {
  call,
  createChannel,
  freshFactor,
  json,
  seatAs,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await freshFactor(await signIn());
  await setPlan(owner.workspaceId, 'scale');
  channelId = (await createChannel(owner)).id;
});

const webhooksPath = () => `/api/v1/workspaces/${owner.workspaceId}/webhooks`;
const keysPath = () => `/api/v1/workspaces/${owner.workspaceId}/api-keys`;
const destinationsPath = () => `/api/v1/channels/${channelId}/export-destinations`;
const webhookBody = (url = 'https://hooks.example.com/feed') => ({
  url,
  events: ['member.created'],
});
const keyBody = { name: 'Warehouse sync', scopes: ['members:read'] };
const destinationBody = (bucket = 'warehouse') => ({
  kind: 'r2',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket,
  prefix: 'swarm/',
  schedule: 'hourly',
  accessKeyId: 'AKIDEXAMPLE1234',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

/** An admin of the owner's workspace (as the workspace's own Session). */
async function admin(): Promise<Session> {
  return { ...(await seatAs(owner.workspaceId, 'admin')), workspaceId: owner.workspaceId };
}

const hashOf = (s: Session) => sha256Hex(s.cookie.split('=')[1] as string);

/** Changes the session row and drops its cached copy. */
async function setSession(s: Session, sql: string, ...values: unknown[]) {
  const hash = await hashOf(s);
  await env.DB.prepare(sql.replace('$hash', `'${hash}'`))
    .bind(...values)
    .run();
  await env.CACHE.delete(`sess:v2:${hash}`);
}

const creates = (s: Session) => [
  () => call('POST', webhooksPath(), { cookie: s.cookie, body: webhookBody() }),
  () => call('POST', keysPath(), { cookie: s.cookie, body: keyBody }),
  () => call('POST', destinationsPath(), { cookie: s.cookie, body: destinationBody() }),
];

async function expectRefused(s: Session, detail: string) {
  for (const attempt of creates(s)) {
    const res = await attempt();
    expect.soft(res.status).toBe(403);
    expect.soft(await res.json()).toMatchObject({
      error: { details: [{ path: 'secondFactor', message: detail }] },
    });
  }
}

async function mailsTo(address: string) {
  return new DevMailbox(env.DEV_MAILBOX).list({ to: address, limit: 20 });
}

describe('creating a standing feed or key', () => {
  it('refuses an admin whose factor was proved too long ago', async () => {
    const a = await freshFactor(await admin());
    await setSession(
      a,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    await expectRefused(a, 'step_up_required');
  });

  it('refuses an admin with no factor of their own, grace period or not', async () => {
    const a = await admin();
    await expectRefused(a, 'factor_required');
  });

  it("refuses a session whose only proof is an identity provider's MFA claim", async () => {
    const a = await freshFactor(await admin());
    await setSession(
      a,
      "UPDATE sessions SET mfa_method = 'sso', mfa_verified_at = ?1 WHERE token_hash = $hash",
      Date.now(),
    );
    await expectRefused(a, 'step_up_required');
  });

  it('lets an admin with a fresh factor create each one, and tells the owner where data goes', async () => {
    const a = await freshFactor(await admin());
    const endpoint = await call('POST', webhooksPath(), {
      cookie: a.cookie,
      body: webhookBody('https://hooks.example.com/fresh'),
    });
    expect(endpoint.status).toBe(201);
    expect(
      (await json<{ data: WebhookEndpointWithSecret }>(endpoint)).data.endpoint.suspendedReason,
    ).toBeNull();
    expect((await call('POST', keysPath(), { cookie: a.cookie, body: keyBody })).status).toBe(201);
    const destination = await call('POST', destinationsPath(), {
      cookie: a.cookie,
      body: destinationBody('fresh-bucket'),
    });
    expect(destination.status).toBe(201);
    expect((await json<{ data: ExportDestination }>(destination)).data.suspendedReason).toBeNull();

    const notices = (await mailsTo(owner.email)).filter(
      (m) => m.category === 'standing_feed_changed',
    );
    const text = notices.map((m) => m.text).join('\n');
    expect(text).toContain('https://hooks.example.com/fresh');
    expect(text).toContain('fresh-bucket');
    expect(text).toContain('Warehouse sync');
    // The admin who made them is not mailed about their own change.
    expect((await mailsTo(a.email)).some((m) => m.category === 'standing_feed_changed')).toBe(
      false,
    );
  });

  it('repointing a webhook endpoint or destination needs the same check, and records the new target', async () => {
    const a = await freshFactor(await admin());
    const created = await call('POST', webhooksPath(), { cookie: a.cookie, body: webhookBody() });
    const { endpoint } = (await json<{ data: WebhookEndpointWithSecret }>(created)).data;
    const added = await call('POST', destinationsPath(), {
      cookie: a.cookie,
      body: destinationBody(),
    });
    const destination = (await json<{ data: ExportDestination }>(added)).data;
    await setSession(
      a,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    const moved = await call('PATCH', `${webhooksPath()}/${endpoint.id}`, {
      cookie: a.cookie,
      body: { url: 'https://elsewhere.example.com/in' },
    });
    expect(moved.status).toBe(403);
    const rebucket = await call('PATCH', `/api/v1/export-destinations/${destination.id}`, {
      cookie: a.cookie,
      body: { bucket: 'elsewhere' },
    });
    expect(rebucket.status).toBe(403);
    // Ordinary changes need no fresh check.
    const described = await call('PATCH', `${webhooksPath()}/${endpoint.id}`, {
      cookie: a.cookie,
      body: { description: 'Warehouse' },
    });
    expect(described.status).toBe(200);

    await freshFactor(a);
    const again = await call('PATCH', `${webhooksPath()}/${endpoint.id}`, {
      cookie: a.cookie,
      body: { url: 'https://elsewhere.example.com/in' },
    });
    expect(again.status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'webhook.updated' ORDER BY seq DESC LIMIT 1",
    )
      .bind(endpoint.id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      url: 'https://elsewhere.example.com/in',
    });
    const [notice] = (await mailsTo(owner.email)).filter((m) =>
      m.text.includes('https://elsewhere.example.com/in'),
    );
    expect(notice?.category).toBe('standing_feed_changed');
  });
});

describe('what an export destination sends (S04-P5-V-destination-scope)', () => {
  it('defaults to subscribed people without fields; sending more needs a fresh check', async () => {
    const a = await freshFactor(await admin());
    const added = await call('POST', destinationsPath(), {
      cookie: a.cookie,
      body: destinationBody('scoped'),
    });
    const destination = (await json<{ data: ExportDestination }>(added)).data;
    expect(destination).toMatchObject({
      scope: { members: 'active', fields: [] },
      legacyScope: false,
    });
    await setSession(
      a,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    const path = `/api/v1/export-destinations/${destination.id}`;
    const wider = { scope: { members: 'all', fields: ['city'] } };
    const refused = await call('PATCH', path, { cookie: a.cookie, body: wider });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { details: [{ path: 'secondFactor', message: 'step_up_required' }] },
    });
    // Narrowing, or keeping the same scope, needs no fresh check.
    const same = await call('PATCH', path, {
      cookie: a.cookie,
      body: { scope: { members: 'active', fields: [] } },
    });
    expect(same.status).toBe(200);

    await freshFactor(a);
    const widened = await call('PATCH', path, { cookie: a.cookie, body: wider });
    expect(widened.status).toBe(200);
    expect((await json<{ data: ExportDestination }>(widened)).data.scope).toEqual(wider.scope);
    const notice = (await mailsTo(owner.email)).find((m) =>
      m.text.includes('changed an export destination to send more'),
    );
    expect(notice?.category).toBe('standing_feed_changed');
    expect(notice?.text).toContain('including people who left');
  });

  it('marks a destination from before scopes and lets an admin narrow it without a fresh check', async () => {
    const a = await freshFactor(await admin());
    const added = await call('POST', destinationsPath(), {
      cookie: a.cookie,
      body: destinationBody('older'),
    });
    const { id } = (await json<{ data: ExportDestination }>(added)).data;
    // What 0111_export_destination_scope.sql makes of a destination that existed before it.
    await env.DB.prepare(
      `UPDATE export_destinations SET scope_json = '{"members":"all","fields":"all"}', scope_legacy = 1
        WHERE id = ?1`,
    )
      .bind(id)
      .run();
    const listed = (
      await json<{ data: ExportDestination[] }>(
        await call('GET', destinationsPath(), { cookie: a.cookie }),
      )
    ).data.find((d) => d.id === id);
    expect(listed).toMatchObject({ scope: { members: 'all', fields: 'all' }, legacyScope: true });
    await setSession(
      a,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    const narrowed = await call('PATCH', `/api/v1/export-destinations/${id}`, {
      cookie: a.cookie,
      body: { scope: { members: 'active', fields: ['city'] } },
    });
    expect(narrowed.status).toBe(200);
    expect((await json<{ data: ExportDestination }>(narrowed)).data).toMatchObject({
      scope: { members: 'active', fields: ['city'] },
      legacyScope: false,
    });
  });
});

describe('an endpoint a /v2 principal creates', () => {
  it('is only a proposal until an admin confirms it with a fresh factor', async () => {
    const { secret } = await createKey(owner, { scopes: ['webhooks:write', 'webhooks:read'] });
    const res = await v2('POST', '/v2/webhooks', secret, {
      body: webhookBody('https://proposed.example.com/in'),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { endpoint } = (await json<{ data: WebhookEndpointWithSecret }>(res)).data;
    expect(endpoint.suspendedReason).toBe('unconfirmed');
    const row = await env.DB.prepare(
      'SELECT confirmed_by, proposed_via, proposed_by_id FROM webhook_endpoints WHERE id = ?1',
    )
      .bind(endpoint.id)
      .first<{ confirmed_by: string | null; proposed_via: string; proposed_by_id: string }>();
    expect(row).toMatchObject({ confirmed_by: null, proposed_via: 'key' });
    const notice = (await mailsTo(owner.email)).find((m) =>
      m.text.includes('https://proposed.example.com/in'),
    );
    expect(notice?.text).toContain('until an admin confirms it');

    const a = await admin();
    const confirmPath = `${webhooksPath()}/${endpoint.id}/confirm`;
    expect((await call('POST', confirmPath, { cookie: a.cookie })).status).toBe(403);
    await freshFactor(a);
    const confirmed = await call('POST', confirmPath, { cookie: a.cookie });
    expect(confirmed.status).toBe(200);
    expect((await json<{ data: WebhookEndpoint }>(confirmed)).data.suspendedReason).toBeNull();
  });
});

describe('when the admin behind a key or feed is demoted (S04-P1-V-demotion-key-invite)', () => {
  it('their key is refused and shown suspended until an admin takes it over', async () => {
    const a = await freshFactor(await admin());
    const created = await call('POST', keysPath(), {
      cookie: a.cookie,
      body: { name: 'Sync', scopes: ['channels:read', 'members:write'] },
    });
    const { key, secret } = (await json<{ data: { key: ApiKey; secret: string } }>(created)).data;
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(200);

    const watcher = await admin();
    await demote(a, 'editor');
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(401);
    // A write made with it changes nothing.
    const address = uniqueEmail('via-key');
    const write = await v2('POST', `/v2/channels/${channelId}/members`, secret, {
      body: { email: address },
    });
    expect(write.status).toBe(401);
    const member = await env.DB.prepare(
      'SELECT 1 FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(channelId, address)
      .first();
    expect(member).toBeNull();
    const listed = await call('GET', keysPath(), { cookie: owner.cookie });
    const shown = (await json<{ data: ApiKey[] }>(listed)).data.find((k) => k.id === key.id);
    expect(shown?.status).toBe('suspended');
    // The other admins hear about it (the owner made the change, so is not mailed).
    const notice = (await mailsTo(watcher.email)).find(
      (m) => m.category === 'standing_feed_suspended',
    );
    expect(notice?.text).toContain('1 API key');

    // Keeping it: an admin changes it (with a fresh factor) and stands behind it from then on.
    await freshFactor(owner);
    const kept = await call('PATCH', `${keysPath()}/${key.id}`, {
      cookie: owner.cookie,
      body: { name: 'Sync (kept)' },
    });
    expect(kept.status).toBe(200);
    expect((await json<{ data: ApiKey }>(kept)).data.status).toBe('active');
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(200);
  });

  it('invites they sent can no longer be accepted', async () => {
    const a = await admin();
    const invitee = uniqueEmail('invitee');
    const sent = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: a.cookie,
      body: { email: invitee, role: 'editor' },
    });
    expect(sent.status).toBe(201);
    const [mail] = await mailsTo(invitee);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;
    await demote(a, 'viewer');
    const joiner = await signIn(invitee);
    const accepted = await call('POST', '/api/v1/invites/accept', {
      cookie: joiner.cookie,
      body: { token },
    });
    expect(accepted.status).toBe(404);
    const seat = await env.DB.prepare(
      'SELECT 1 FROM seats WHERE workspace_id = ?1 AND operator_id = ?2',
    )
      .bind(owner.workspaceId, joiner.me.operator.id)
      .first();
    expect(seat).toBeNull();
  });
});

async function seatIdOf(s: Session): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT id FROM seats WHERE workspace_id = ?1 AND operator_id = ?2',
  )
    .bind(owner.workspaceId, s.me.operator.id)
    .first<{ id: string }>();
  return row!.id;
}

async function demote(s: Session, role: SeatRole) {
  const res = await call(
    'PATCH',
    `/api/v1/workspaces/${owner.workspaceId}/seats/${await seatIdOf(s)}`,
    { cookie: owner.cookie, body: { role } },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

describe('who grants the admin role (S04-P1-V-role-grant-matrix)', () => {
  it('only owners give, take away or remove the admin role, on every path', async () => {
    const a = await admin();
    const peer = await admin();
    const editor = await seatAs(owner.workspaceId, 'editor');
    const seat = (s: Session) => seatIdOf(s);
    const patch = async (actor: Session, target: Session, role: SeatRole) =>
      call('PATCH', `/api/v1/workspaces/${owner.workspaceId}/seats/${await seat(target)}`, {
        cookie: actor.cookie,
        body: { role },
      });
    const roleOf = async (target: Session) =>
      (
        await env.DB.prepare('SELECT role FROM seats WHERE id = ?1')
          .bind(await seat(target))
          .first<{ role: SeatRole }>()
      )?.role;

    // An admin can't raise a teammate to admin (the invite rule, reached in two steps before).
    expect((await patch(a, editor, 'admin')).status).toBe(403);
    expect(await roleOf(editor)).toBe('editor');
    // Nor demote or remove a peer admin.
    expect((await patch(a, peer, 'viewer')).status).toBe(403);
    expect(await roleOf(peer)).toBe('admin');
    const remove = await call(
      'DELETE',
      `/api/v1/workspaces/${owner.workspaceId}/seats/${await seat(peer)}`,
      { cookie: a.cookie },
    );
    expect(remove.status).toBe(403);
    expect(await roleOf(peer)).toBe('admin');
    // Nor invite an admin (unchanged).
    const invite = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: a.cookie,
      body: { email: uniqueEmail('adm'), role: 'admin' },
    });
    expect(invite.status).toBe(403);
    // Admins still manage the roles below admin.
    expect((await patch(a, editor, 'author')).status).toBe(200);
    expect(await roleOf(editor)).toBe('author');
    // Owners may do each of these.
    expect((await patch(owner, editor, 'admin')).status).toBe(200);
    expect(await roleOf(editor)).toBe('admin');
    expect((await patch(owner, peer, 'viewer')).status).toBe(200);
    expect(await roleOf(peer)).toBe('viewer');
  });
});

describe('repeated role changes aimed at one teammate (S04-P1-V-role-change-other-workspace)', () => {
  it('are bounded for raises, never for lowering, and the teammate is told each time', async () => {
    const target = await seatAs(owner.workspaceId, 'editor');
    const path = `/api/v1/workspaces/${owner.workspaceId}/seats/${await seatIdOf(target)}`;
    const to = (role: SeatRole) => call('PATCH', path, { cookie: owner.cookie, body: { role } });
    for (const role of ['author', 'editor', 'author', 'editor'] as SeatRole[]) {
      expect((await to(role)).status).toBe(200);
    }
    const held = await to('admin');
    expect(held.status).toBe(429);
    // A reduction always goes through.
    expect((await to('viewer')).status).toBe(200);
    const notices = (await mailsTo(target.email)).filter((m) => m.category === 'seat_role_changed');
    expect(notices.length).toBe(5);
    expect(notices[0]?.text).toContain('signed you out');
  });
});

describe('pausing every outbound feed at once (incident response)', () => {
  it('needs a fresh factor, pauses each feed, can revoke keys and apps, and tells the team', async () => {
    const boss = await freshFactor(await signIn());
    await setPlan(boss.workspaceId, 'scale');
    const channel = (await createChannel(boss)).id;
    const deputy = await freshFactor({
      ...(await seatAs(boss.workspaceId, 'admin')),
      workspaceId: boss.workspaceId,
    });
    const destination = (
      await json<{ data: ExportDestination }>(
        await call('POST', `/api/v1/channels/${channel}/export-destinations`, {
          cookie: boss.cookie,
          body: destinationBody('incident'),
        }),
      )
    ).data;
    const hooks = `/api/v1/workspaces/${boss.workspaceId}/webhooks`;
    const { endpoint } = (
      await json<{ data: WebhookEndpointWithSecret }>(
        await call('POST', hooks, {
          cookie: boss.cookie,
          body: webhookBody('https://hooks.example.com/incident'),
        }),
      )
    ).data;
    const { secret } = await createKey(boss, { scopes: ['members:read'] });
    const path = `/api/v1/workspaces/${boss.workspaceId}/security/pause-feeds`;

    // An editor can't, and an admin needs a fresh factor of their own.
    const editor = await freshFactor({
      ...(await seatAs(boss.workspaceId, 'editor')),
      workspaceId: boss.workspaceId,
    });
    expect((await call('POST', path, { cookie: editor.cookie, body: {} })).status).toBe(403);
    await setSession(
      deputy,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    const stale = await call('POST', path, {
      cookie: deputy.cookie,
      body: { revokeApiKeys: true },
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { details: [{ path: 'secondFactor', message: 'step_up_required' }] },
    });

    await freshFactor(deputy);
    const res = await call('POST', path, {
      cookie: deputy.cookie,
      body: { revokeApiKeys: true, revokeApps: true },
    });
    expect(res.status).toBe(200);
    const result = (
      await json<{
        data: { paused: { kind: string; id: string; target: string }[]; apiKeysRevoked: number };
      }>(res)
    ).data;
    expect(result.paused.map((f) => [f.kind, f.id]).sort()).toEqual(
      [
        ['export_destination', destination.id],
        ['webhook_endpoint', endpoint.id],
      ].sort(),
    );
    expect(result.paused.find((f) => f.id === endpoint.id)?.target).toBe(
      'https://hooks.example.com/incident',
    );
    expect(result.apiKeysRevoked).toBe(1);
    const statuses = await env.DB.prepare(
      `SELECT status FROM export_destinations WHERE id = ?1
       UNION ALL SELECT status FROM webhook_endpoints WHERE id = ?2`,
    )
      .bind(destination.id, endpoint.id)
      .all<{ status: string }>();
    expect(statuses.results.map((r) => r.status)).toEqual(['paused', 'paused']);
    expect((await v2('GET', `/v2/channels/${channel}/members`, secret)).status).toBe(401);

    const actions = await env.DB.prepare(
      'SELECT action FROM audit_events WHERE workspace_id = ?1 AND actor_operator_id = ?2',
    )
      .bind(boss.workspaceId, deputy.me.operator.id)
      .all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'feeds.paused_all',
        'export_destination.paused',
        'webhook.paused',
        'api_key.revoked',
      ]),
    );
    for (const person of [boss.email, deputy.email]) {
      const mail = (await mailsTo(person)).find(
        (m) => m.subject === 'All outbound feeds were paused',
      );
      expect(mail?.text).toContain('https://hooks.example.com/incident');
    }

    // Nothing left to pause; each feed is resumed on its own.
    const again = await call('POST', path, { cookie: deputy.cookie, body: {} });
    expect((await json<{ data: { paused: unknown[] } }>(again)).data.paused).toEqual([]);
    const resumed = await call('PATCH', `/api/v1/export-destinations/${destination.id}`, {
      cookie: deputy.cookie,
      body: { status: 'active' },
    });
    expect((await json<{ data: ExportDestination }>(resumed)).data.status).toBe('active');
    const hook = await env.DB.prepare('SELECT status FROM webhook_endpoints WHERE id = ?1')
      .bind(endpoint.id)
      .first<{ status: string }>();
    expect(hook?.status).toBe('paused');
  });
});
