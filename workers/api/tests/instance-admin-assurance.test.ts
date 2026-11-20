// Platform-wide authority needs a factor of the instance admin's own (S04-P1-V-instance-admin-
// assurance): no factor, a grace period or an identity provider's claim can't change install-wide
// settings, whatever seats the person holds; a change needs fresh proof and is announced.
import { env } from 'cloudflare:test';
import { DevMailbox } from '@swarm/mail';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import { call, freshFactor, json, seatAs, signIn, type Session } from './helpers';

const FLAG = '/api/v1/instance/features/link_hub';

async function makeAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
}

async function setSession(s: Session, sql: string, ...values: unknown[]) {
  const hash = await sha256Hex(s.cookie.split('=')[1] as string);
  await env.DB.prepare(sql.replace('$hash', `'${hash}'`))
    .bind(...values)
    .run();
  await env.CACHE.delete(`sess:v2:${hash}`);
}

const flagRow = () =>
  env.DB.prepare(
    "SELECT enabled, updated_at FROM feature_flags WHERE key = 'link_hub' AND scope = 'platform'",
  ).first<{ enabled: number; updated_at: number }>();

afterAll(async () => {
  await env.DB.prepare('DELETE FROM instance_admins').run();
});

describe('instance admin assurance', () => {
  it('refuses a weak session, whatever seats the person holds, and lets a fresh own factor through', async () => {
    const owner = await signIn();
    // Only a viewer seat elsewhere, and no factor.
    const viewerOnly = await seatAs(owner.workspaceId, 'viewer');
    await env.DB.prepare('DELETE FROM seats WHERE operator_id = ?1 AND role = ?2')
      .bind(viewerOnly.me.operator.id, 'owner')
      .run();
    await makeAdmin(viewerOnly);
    // An owner inside their grace period, with no factor.
    const inGrace = await signIn();
    await makeAdmin(inGrace);
    // A session whose only proof is an identity provider's MFA claim.
    const viaIdp = await freshFactor(await signIn());
    await makeAdmin(viaIdp);
    await setSession(
      viaIdp,
      "UPDATE sessions SET mfa_method = 'sso', mfa_verified_at = ?1 WHERE token_hash = $hash",
      Date.now(),
    );
    // A real factor, proved an hour ago: may read, not change.
    const stale = await freshFactor(await signIn());
    await makeAdmin(stale);
    await setSession(
      stale,
      'UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = $hash',
      Date.now() - 60 * 60_000,
    );
    const control = await freshFactor(await signIn());
    await makeAdmin(control);

    const before = await flagRow();
    for (const [session, detail] of [
      [viewerOnly, 'factor_required'],
      [inGrace, 'factor_required'],
      [viaIdp, 'step_up_required'],
      [stale, 'step_up_required'],
    ] as const) {
      const res = await call('PUT', FLAG, { cookie: session.cookie, body: { enabled: true } });
      expect.soft(res.status).toBe(403);
      expect.soft(await res.json()).toMatchObject({
        error: { details: [{ path: 'secondFactor', message: detail }] },
      });
    }
    expect(await flagRow()).toEqual(before);
    expect((await call('GET', '/api/v1/instance/features', { cookie: stale.cookie })).status).toBe(
      200,
    );
    expect(
      (await call('GET', '/api/v1/instance/features', { cookie: viewerOnly.cookie })).status,
    ).toBe(403);

    // The allowed change is stored and announced to the other instance admins.
    const allowed = await call('PUT', FLAG, { cookie: control.cookie, body: { enabled: true } });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect((await flagRow())?.enabled).toBe(1);
    const [notice] = await new DevMailbox(env.DEV_MAILBOX).list({ to: stale.email, limit: 1 });
    expect(notice).toMatchObject({ category: 'instance_setting_changed' });
    expect(notice?.text).toContain(control.email);
    const [own] = await new DevMailbox(env.DEV_MAILBOX).list({ to: control.email, limit: 1 });
    expect(own?.category).not.toBe('instance_setting_changed');
  });

  it('an instance admin with no owner or admin seat is still required to have a factor', async () => {
    const owner = await signIn();
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    await env.DB.prepare('DELETE FROM seats WHERE operator_id = ?1 AND role = ?2')
      .bind(viewer.me.operator.id, 'owner')
      .run();
    await makeAdmin(viewer);
    await setSession(viewer, 'UPDATE sessions SET mfa_verified_at = NULL WHERE token_hash = $hash');
    const status = await call('GET', '/api/v1/auth/session', { cookie: viewer.cookie });
    const me = await json<{ data: { secondFactor: { required: boolean } } }>(status);
    expect(me.data.secondFactor.required).toBe(true);
  });
});
