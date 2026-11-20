// Suppressions API: Channel and workspace scope, roles, tenancy, removal rules and the SES
// removal queue; and the ramp PATCH clearing an owed pause notice.
import { env } from 'cloudflare:test';
import { newId, type Suppression } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

const path = (channelId: string) => `/api/v1/channels/${channelId}/suppressions`;

describe('suppressions', () => {
  let owner: Session;
  let channelId: string;
  let otherChannelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    otherChannelId = (await createChannel(owner)).id;
  });

  it('adds Channel and workspace suppressions, idempotently, and lists what applies', async () => {
    const address = uniqueEmail('reader');
    const scoped = await data<Suppression>(
      await call('POST', path(channelId), { cookie: owner.cookie, body: { email: address } }),
      201,
    );
    expect(scoped).toMatchObject({
      email: address,
      scope: 'channel',
      reason: 'manual',
      removable: true,
    });
    const again = await data<Suppression>(
      await call('POST', path(channelId), { cookie: owner.cookie, body: { email: address } }),
    );
    expect(again.id).toBe(scoped.id);

    // The other Channel doesn't see the Channel-scoped row.
    const other = await data<Suppression[]>(
      await call('GET', `${path(otherChannelId)}?email=${encodeURIComponent(address)}`, {
        cookie: owner.cookie,
      }),
    );
    expect(other).toEqual([]);

    const wide = await data<Suppression>(
      await call('POST', path(otherChannelId), {
        cookie: owner.cookie,
        body: { email: address, scope: 'workspace', note: 'Asked by phone' },
      }),
      201,
    );
    const listed = await data<Suppression[]>(
      await call('GET', `${path(channelId)}?email=${encodeURIComponent(address)}`, {
        cookie: owner.cookie,
      }),
    );
    expect(listed.map((s) => s.id).sort()).toEqual([scoped.id, wide.id].sort());
  });

  it('needs admin to change, a workspace admin for workspace scope, and hides other tenants', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const editor = await seatAs(owner.workspaceId, 'editor');
    const outsider = await signIn();
    const body = { email: uniqueEmail('x') };
    expect((await call('GET', path(channelId), { cookie: viewer.cookie })).status).toBe(200);
    expect((await call('POST', path(channelId), { cookie: viewer.cookie, body })).status).toBe(403);
    expect((await call('POST', path(channelId), { cookie: editor.cookie, body })).status).toBe(403);
    expect((await call('GET', path(channelId), { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('POST', path(channelId), { cookie: outsider.cookie, body })).status).toBe(
      404,
    );

    // A per-Channel role only lowers a seat: an author seat with an admin Channel role stays an
    // author there, and an admin seat with a viewer Channel role is a viewer on that Channel.
    const raised = await seatAs(owner.workspaceId, 'author');
    await env.DB.prepare(
      `INSERT INTO channel_roles (id, channel_id, operator_id, role, created_at) VALUES (?1, ?2, ?3, 'admin', 0)`,
    )
      .bind(newId('channelRole'), channelId, raised.me.operator.id)
      .run();
    expect((await call('POST', path(channelId), { cookie: raised.cookie, body })).status).toBe(403);
    const lowered = await seatAs(owner.workspaceId, 'admin');
    await env.DB.prepare(
      `INSERT INTO channel_roles (id, channel_id, operator_id, role, created_at) VALUES (?1, ?2, ?3, 'viewer', 0)`,
    )
      .bind(newId('channelRole'), channelId, lowered.me.operator.id)
      .run();
    expect((await call('GET', path(channelId), { cookie: lowered.cookie })).status).toBe(200);
    expect((await call('POST', path(channelId), { cookie: lowered.cookie, body })).status).toBe(
      403,
    );
    expect(
      (await call('POST', path(otherChannelId), { cookie: lowered.cookie, body })).status,
    ).toBe(201);
    const listed = await data<{ id: string; role: string }[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/channels`, {
        cookie: raised.cookie,
      }),
    );
    expect(listed.find((ch) => ch.id === channelId)?.role).toBe('author');

    // A suppression of another workspace is not found through this Channel.
    const theirs = await data<Suppression>(
      await call('POST', path((await createChannel(outsider)).id), {
        cookie: outsider.cookie,
        body: { email: uniqueEmail('y') },
      }),
      201,
    );
    expect(
      (await call('DELETE', `${path(channelId)}/${theirs.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);
  });

  it('removes bounces (queueing the SES removal) but keeps complaints', async () => {
    const bounced = uniqueEmail('bounced');
    const complained = uniqueEmail('complained');
    const ids = { bounce: newId('suppression'), complaint: newId('suppression') };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', 0)`,
      ).bind(ids.bounce, owner.workspaceId, bounced),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', 0)`,
      ).bind(ids.complaint, owner.workspaceId, complained),
    ]);
    const res = await call('DELETE', `${path(channelId)}/${ids.bounce}`, { cookie: owner.cookie });
    expect(res.status).toBe(204);
    const queued = await env.DB.prepare(
      'SELECT action FROM provider_suppression_sync WHERE email = ?1',
    )
      .bind(bounced)
      .first<{ action: string }>();
    expect(queued?.action).toBe('delete');
    expect(
      (await call('DELETE', `${path(channelId)}/${ids.complaint}`, { cookie: owner.cookie }))
        .status,
    ).toBe(409);
    const audit = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE target_id = ?1 AND action = 'suppression.removed'`,
    )
      .bind(ids.bounce)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('clears an owed pause notice when an operator resumes the ramp', async () => {
    const ramps = await data<{ id: string }[]>(
      await call('GET', `/api/v1/channels/${channelId}/ramps`, { cookie: owner.cookie }),
    );
    const rampId = ramps[0]!.id;
    // The shared domain paused itself, so only an instance admin may resume it.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)',
    )
      .bind(owner.me.operator.id, Date.now())
      .run();
    await env.DB.prepare(
      `UPDATE reputation_ramps SET status = 'paused', pause_notice = 'due' WHERE id = ?1`,
    )
      .bind(rampId)
      .run();
    await data(
      await call('PATCH', `/api/v1/ramps/${rampId}`, {
        cookie: owner.cookie,
        body: { status: 'warming' },
      }),
    );
    const row = await env.DB.prepare('SELECT pause_notice FROM reputation_ramps WHERE id = ?1')
      .bind(rampId)
      .first<{ pause_notice: string | null }>();
    expect(row?.pause_notice).toBeNull();
  });
});
