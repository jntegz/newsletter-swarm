// Sending limits (Settings > Instance, 0066_sending_limits.sql): instance admins read and change
// them, and a send waiting for a limit shows it on its report and can be resumed by the
// publication's admins. The pacer is the scriptable stub in tests/fixtures/realtime-stub.js.
import { env } from 'cloudflare:test';
import type { BroadcastReport, InstanceSendingLimits } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { forgetSendingLimits } from '@swarm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { call, createChannel, freshFactor, json, seatAs, signIn, type Session } from './helpers';

const URL_LIMITS = '/api/v1/instance/sending-limits';
const NONE = { perSecond: null, perHour: null, perDay: null, perMonth: null };

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sending_limits'),
    env.DB.prepare('DELETE FROM instance_admins'),
  ]);
  forgetSendingLimits();
});

async function makeAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(session);
}

/** A send of the session's workspace in the given wait (null: sending normally). */
async function seedSend(
  session: Session,
  wait: { reason: string; resumeAt: number | null; detail?: string } | null,
) {
  const { id: channelId } = await createChannel(session);
  const dispatch = newId('dispatch');
  const broadcast = newId('broadcast');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Issue 9', '{"type":"doc","content":[]}', 'sending', ?3, ?3)`,
    ).bind(dispatch, channelId, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at, recipient_count, sent_count,
         snapshot_done, fanout_done, fanout_cursor, waiting_for, waiting_since, resume_at, wait_detail)
       VALUES (?1, ?2, ?3, ?4, 'sending', 'Issue 9', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5, 2000, 760,
         1, 1, 'mb_zzz', ?6, ?7, ?8, ?9)`,
    ).bind(
      broadcast,
      dispatch,
      channelId,
      session.workspaceId,
      now,
      wait?.reason ?? null,
      wait ? now : null,
      wait?.resumeAt ?? null,
      wait?.detail ?? null,
    ),
  ]);
  return { channelId, broadcastId: broadcast };
}

const waitOf = async (broadcastId: string) =>
  env.DB.prepare(
    'SELECT waiting_for, resume_at, fanout_done, fanout_cursor FROM broadcasts WHERE id = ?1',
  )
    .bind(broadcastId)
    .first<{
      waiting_for: string | null;
      resume_at: number | null;
      fanout_done: number;
      fanout_cursor: string | null;
    }>();

describe('who can see and change the sending limits', () => {
  it('is for instance admins only', async () => {
    expect((await call('GET', URL_LIMITS)).status).toBe(401);
    expect((await call('PUT', URL_LIMITS, { body: NONE })).status).toBe(401);
    const someone = await signIn();
    expect((await call('GET', URL_LIMITS, { cookie: someone.cookie })).status).toBe(403);
    const put = await call('PUT', URL_LIMITS, { cookie: someone.cookie, body: NONE });
    expect(put.status).toBe(403);
    // A workspace owner is not an instance admin, and nothing was saved.
    expect(await env.DB.prepare('SELECT 1 FROM sending_limits').first()).toBeNull();
  });
});

describe('the sending limits', () => {
  it('start with none, and show what the pacer has counted', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const res = await call('GET', URL_LIMITS, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: InstanceSendingLimits }>(res);
    expect(data.limits).toEqual(NONE);
    expect(data.updatedAt).toBeNull();
    // The stub reports MAIL_MAX_PER_SECOND as 2 and counts every turn, sign-in links included.
    expect(data.ceiling).toBe(2);
    expect(data.usage?.day.used).toBeGreaterThan(0);
    expect(data.usage?.day.limit).toBeNull();
    expect(Date.parse(data.usage!.day.resetsAt)).toBeGreaterThan(Date.now());
  });

  it('saves limits, says who changed them, and validates them', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const limits = { perSecond: 2, perHour: null, perDay: 100, perMonth: 3000 };
    const res = await call('PUT', URL_LIMITS, { cookie: admin.cookie, body: limits });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: InstanceSendingLimits }>(res);
    expect(data.limits).toEqual(limits);
    expect(data.updatedBy).toBe(admin.me.operator.id);
    expect(data.usage?.day).toMatchObject({ limit: 100, forSends: 90 });
    expect(data.usage?.month).toMatchObject({ limit: 3000, forSends: 2700 });
    const again = await json<{ data: InstanceSendingLimits }>(
      await call('GET', URL_LIMITS, { cookie: admin.cookie }),
    );
    expect(again.data.limits).toEqual(limits);

    for (const bad of [
      { ...NONE, perHour: 500, perDay: 100 },
      { ...NONE, perDay: 5 },
      { ...NONE, perSecond: 0.25 },
      { ...NONE, perSecond: 0 },
      { perDay: 100 },
    ]) {
      const refused = await call('PUT', URL_LIMITS, { cookie: admin.cookie, body: bad });
      expect(refused.status).toBe(400);
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('invalid_input');
    }
    expect(
      (
        await json<{ data: InstanceSendingLimits }>(
          await call('GET', URL_LIMITS, { cookie: admin.cookie }),
        )
      ).data.limits,
    ).toEqual(limits);
  });

  it('tells the pacer the new limits at once, so no worker’s cache can undo them', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const pacer = env.SEND_PACER.get(env.SEND_PACER.idFromName('install')) as unknown as {
      counts(): Promise<{ told: { limits: unknown; limitsSavedAt: number } | null }>;
    };
    const first = { ...NONE, perMonth: 3000 };
    const saved = await json<{ data: InstanceSendingLimits }>(
      await call('PUT', URL_LIMITS, { cookie: admin.cookie, body: first }),
    );
    expect((await pacer.counts()).told).toEqual({
      limits: first,
      limitsSavedAt: Date.parse(saved.data.updatedAt!),
    });
    // Saved again in the same millisecond or not, the date only grows, so the newer one wins.
    const raised = { ...NONE, perMonth: 50_000 };
    await call('PUT', URL_LIMITS, { cookie: admin.cookie, body: raised });
    const told = (await pacer.counts()).told!;
    expect(told.limits).toEqual(raised);
    expect(told.limitsSavedAt).toBeGreaterThan(Date.parse(saved.data.updatedAt!));
  });

  it('lets sends waiting for this Swarm’s own limits try again when they change', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const tomorrow = Date.now() + 86_400_000;
    const daily = await seedSend(admin, { reason: 'day', resumeAt: tomorrow });
    const stopped = await seedSend(admin, {
      reason: 'service_stopped',
      resumeAt: null,
      detail: 'AccountSuspendedException: suspended',
    });
    const before = await json<{ data: InstanceSendingLimits }>(
      await call('GET', URL_LIMITS, { cookie: admin.cookie }),
    );
    expect(before.data.waitingSends).toBeGreaterThanOrEqual(2);
    const res = await call('PUT', URL_LIMITS, {
      cookie: admin.cookie,
      body: { ...NONE, perDay: 500 },
    });
    expect(res.status).toBe(200);
    // The daily wait walks its fan-out again now; the stopped service still needs a person.
    expect(await waitOf(daily.broadcastId)).toEqual({
      waiting_for: null,
      resume_at: null,
      fanout_done: 0,
      fanout_cursor: null,
    });
    expect((await waitOf(stopped.broadcastId))?.waiting_for).toBe('service_stopped');
  });
});

describe('a send waiting for a limit', () => {
  it('says so on its report, with who is left and when it continues', async () => {
    const owner = await signIn();
    const midnight = Date.now() - (Date.now() % 86_400_000) + 86_400_000;
    const { broadcastId } = await seedSend(owner, { reason: 'service_day', resumeAt: midnight });
    const res = await call('GET', `/api/v1/broadcasts/${broadcastId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: BroadcastReport }>(res);
    expect(data.status).toBe('sending');
    expect(data.waiting).toMatchObject({
      reason: 'service_day',
      until: new Date(midnight).toISOString(),
      left: 1240,
    });
    const sending = await seedSend(owner, null);
    const normal = await json<{ data: BroadcastReport }>(
      await call('GET', `/api/v1/broadcasts/${sending.broadcastId}`, { cookie: owner.cookie }),
    );
    expect(normal.data.waiting).toBeNull();
  });

  it('can be resumed by the publication’s admins, not editors or other workspaces', async () => {
    const owner = await signIn();
    const { broadcastId } = await seedSend(owner, {
      reason: 'service_stopped',
      resumeAt: null,
      detail: 'invalid_api_key: API key is invalid',
    });
    const path = `/api/v1/broadcasts/${broadcastId}/resume`;
    expect((await call('POST', path)).status).toBe(401);
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await call('POST', path, { cookie: editor.cookie })).status).toBe(403);
    const stranger = await signIn();
    expect((await call('POST', path, { cookie: stranger.cookie })).status).toBe(404);
    expect((await waitOf(broadcastId))?.waiting_for).toBe('service_stopped');

    const admin = await seatAs(owner.workspaceId, 'admin');
    const res = await call('POST', path, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect((await json<{ data: BroadcastReport }>(res)).data.waiting).toBeNull();
    expect(await waitOf(broadcastId)).toMatchObject({ waiting_for: null, fanout_done: 0 });
    const audit = await env.DB.prepare(
      `SELECT actor_operator_id AS actor_id FROM audit_events WHERE action = 'broadcast.resumed' AND target_id = ?1`,
    )
      .bind(broadcastId)
      .first<{ actor_id: string }>();
    expect(audit?.actor_id).toBe(admin.me.operator.id);
    // Nothing left to resume.
    expect((await call('POST', path, { cookie: admin.cookie })).status).toBe(409);
  });
});
