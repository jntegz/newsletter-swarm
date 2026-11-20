// Access that ends with the person: removing a seat (or leaving) revokes the API keys that
// teammate created in that workspace and the apps they authorised for it, with audit entries;
// the team page asks first how many (GET …/seats/{seatId}/access). Deleting an operator row
// revokes them too (a trigger in 0064). Roles and other workspaces are checked.
import { env } from 'cloudflare:test';
import type { AuditEvent, SeatAccess } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { data } from './audience-helpers';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { connect, createApp, v2 as oauthV2 } from './oauth-helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await setPlan(owner.workspaceId, 'pro');
});

/** `s` acting in `workspaceId` (a seated teammate's session, pointed at another workspace). */
const inWorkspace = (s: Session, workspaceId: string): Session => ({ ...s, workspaceId });

async function seatIdOf(workspaceId: string, operatorId: string): Promise<string> {
  const seats = await json<{ data: { id: string; operator: { id: string } }[] }>(
    await call('GET', `/api/v1/workspaces/${workspaceId}/seats`, { cookie: owner.cookie }),
  );
  return seats.data.find((s) => s.operator.id === operatorId)!.id;
}

const accessPath = (workspaceId: string, seatId: string) =>
  `/api/v1/workspaces/${workspaceId}/seats/${seatId}/access`;

const membersPath = () => `/v2/channels/${channelId}/members`;

async function keyRevoked(id: string) {
  return (
    await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?1')
      .bind(id)
      .first<{ revoked_at: number | null }>()
  )?.revoked_at;
}

async function auditOf(workspaceId: string): Promise<AuditEvent[]> {
  const log = await json<{ data: { items: AuditEvent[] } }>(
    await call('GET', `/api/v1/workspaces/${workspaceId}/audit?limit=100`, {
      cookie: owner.cookie,
    }),
  );
  return log.data.items;
}

describe('removing a teammate', () => {
  it('revokes the API keys they created and the apps they installed, and says how many first', async () => {
    const admin = await seatAs(owner.workspaceId, 'admin');
    const asAdmin = inWorkspace(admin, owner.workspaceId);
    const first = await createKey(asAdmin, { scopes: ['members:read'] });
    const second = await createKey(asAdmin, { scopes: ['members:read'] });
    // An already revoked key isn't counted; a key the owner made isn't touched.
    const old = await createKey(asAdmin, { scopes: ['members:read'] });
    await call('DELETE', `/api/v1/workspaces/${owner.workspaceId}/api-keys/${old.key.id}`, {
      cookie: owner.cookie,
    });
    const ownersKey = await createKey(owner, { scopes: ['members:read'] });
    const app = await createApp(owner, { scopes: ['members:read'] });
    const tokens = await connect(asAdmin, app.app.clientId, 'members:read');
    expect((await oauthV2('GET', membersPath(), tokens.access_token)).status).toBe(200);
    expect((await v2('GET', membersPath(), first.secret)).status).toBe(200);

    const seatId = await seatIdOf(owner.workspaceId, admin.me.operator.id);
    const access = await data<SeatAccess>(
      await call('GET', accessPath(owner.workspaceId, seatId), { cookie: owner.cookie }),
    );
    expect(access).toEqual({ apiKeys: 2, apps: 1 });
    // Asking changes nothing.
    expect(await keyRevoked(first.key.id)).toBeNull();

    const removed = await call(
      'DELETE',
      `/api/v1/workspaces/${owner.workspaceId}/seats/${seatId}`,
      {
        cookie: owner.cookie,
      },
    );
    expect(removed.status).toBe(204);
    for (const key of [first, second]) {
      expect(await keyRevoked(key.key.id)).toEqual(expect.any(Number));
      expect((await v2('GET', membersPath(), key.secret)).status).toBe(401);
    }
    expect((await oauthV2('GET', membersPath(), tokens.access_token)).status).toBe(401);
    const grant = await env.DB.prepare(
      'SELECT revoked_at FROM oauth_grants WHERE app_id = ?1 AND operator_id = ?2',
    )
      .bind(app.app.id, admin.me.operator.id)
      .first<{ revoked_at: number | null }>();
    expect(grant?.revoked_at).toEqual(expect.any(Number));
    // Inviting them back later doesn't bring the grant back.
    await env.DB.prepare(
      "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'admin', 0, 0)",
    )
      .bind(`st_${crypto.randomUUID().replace(/-/g, '')}`, owner.workspaceId, admin.me.operator.id)
      .run();
    expect((await oauthV2('GET', membersPath(), tokens.access_token)).status).toBe(401);
    expect((await v2('GET', membersPath(), first.secret)).status).toBe(401);
    // The owner's key still works.
    expect((await v2('GET', membersPath(), ownersKey.secret)).status).toBe(200);

    const events = await auditOf(owner.workspaceId);
    const removal = events.find((e) => e.action === 'seat.removed' && e.targetId === seatId);
    expect(removal?.metadata).toMatchObject({ apiKeysRevoked: 2, appsRevoked: 1 });
    const revokedKeys = events
      .filter((e) => e.action === 'api_key.revoked' && e.metadata?.reason === 'seat_removed')
      .map((e) => e.targetId);
    expect(revokedKeys.sort()).toEqual([first.key.id, second.key.id].sort());
    expect(
      events.some(
        (e) =>
          e.action === 'oauth_grant.revoked' &&
          e.metadata?.reason === 'seat_removed' &&
          e.metadata?.seatId === seatId,
      ),
    ).toBe(true);
  });

  it('leaving the workspace revokes your own keys there, and nowhere else', async () => {
    const editor = await seatAs(owner.workspaceId, 'admin');
    // Their own workspace (they own it) and the shared one.
    await setPlan(editor.workspaceId, 'pro');
    const own = await createKey(editor, { scopes: ['channels:read'] });
    const shared = await createKey(inWorkspace(editor, owner.workspaceId), {
      scopes: ['members:read'],
    });
    const seatId = await seatIdOf(owner.workspaceId, editor.me.operator.id);
    // They may ask about their own seat.
    expect(
      await data<SeatAccess>(
        await call('GET', accessPath(owner.workspaceId, seatId), { cookie: editor.cookie }),
      ),
    ).toEqual({ apiKeys: 1, apps: 0 });
    const left = await call('DELETE', `/api/v1/workspaces/${owner.workspaceId}/seats/${seatId}`, {
      cookie: editor.cookie,
    });
    expect(left.status).toBe(204);
    expect(await keyRevoked(shared.key.id)).toEqual(expect.any(Number));
    expect(await keyRevoked(own.key.id)).toBeNull();
    expect((await v2('GET', '/v2/channels', own.secret)).status).toBe(200);
  });

  it('only the teammate or an admin may see what removing them revokes', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const other = await seatAs(owner.workspaceId, 'editor');
    const admin = await seatAs(owner.workspaceId, 'admin');
    const otherSeat = await seatIdOf(owner.workspaceId, other.me.operator.id);
    const ownerSeat = await seatIdOf(owner.workspaceId, owner.me.operator.id);
    const viewerSeat = await seatIdOf(owner.workspaceId, viewer.me.operator.id);
    const status = async (s: Session, seatId: string) =>
      (await call('GET', accessPath(owner.workspaceId, seatId), { cookie: s.cookie })).status;
    expect(await status(viewer, otherSeat)).toBe(403);
    expect(await status(viewer, viewerSeat)).toBe(200);
    expect(await status(admin, otherSeat)).toBe(200);
    // An owner's seat is the owners' business.
    expect(await status(admin, ownerSeat)).toBe(403);
    expect(await status(owner, ownerSeat)).toBe(200);
  });

  it('another workspace sees neither the seat nor its access', async () => {
    const stranger = await signIn();
    const admin = await seatAs(owner.workspaceId, 'admin');
    const key = await createKey(inWorkspace(admin, owner.workspaceId), {
      scopes: ['members:read'],
    });
    const seatId = await seatIdOf(owner.workspaceId, admin.me.operator.id);
    expect(
      (await call('GET', accessPath(owner.workspaceId, seatId), { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
    // The seat id under the stranger's own workspace is not found either.
    expect(
      (await call('GET', accessPath(stranger.workspaceId, seatId), { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('DELETE', `/api/v1/workspaces/${stranger.workspaceId}/seats/${seatId}`, {
          cookie: stranger.cookie,
        })
      ).status,
    ).toBe(404);
    expect(await keyRevoked(key.key.id)).toBeNull();
  });
});

describe('deleting an operator', () => {
  it('revokes their keys and grants before created_by and operator_id go null', async () => {
    const admin = await seatAs(owner.workspaceId, 'admin');
    const key = await createKey(inWorkspace(admin, owner.workspaceId), {
      scopes: ['members:read'],
    });
    const app = await createApp(owner, { scopes: ['members:read'] });
    const tokens = await connect(
      inWorkspace(admin, owner.workspaceId),
      app.app.clientId,
      'members:read',
    );
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE operator_id = ?1').bind(admin.me.operator.id),
      env.DB.prepare('DELETE FROM seats WHERE operator_id = ?1').bind(admin.me.operator.id),
    ]);
    await env.DB.prepare('DELETE FROM operators WHERE id = ?1').bind(admin.me.operator.id).run();
    expect(await keyRevoked(key.key.id)).toEqual(expect.any(Number));
    expect((await v2('GET', membersPath(), key.secret)).status).toBe(401);
    expect((await oauthV2('GET', membersPath(), tokens.access_token)).status).toBe(401);
    const tokenRows = await env.DB.prepare(
      `SELECT count(*) AS n FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
        WHERE g.app_id = ?1 AND t.revoked_at IS NULL`,
    )
      .bind(app.app.id)
      .first<{ n: number }>();
    expect(tokenRows?.n).toBe(0);
  });
});
