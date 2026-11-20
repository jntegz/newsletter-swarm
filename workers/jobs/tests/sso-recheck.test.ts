// The daily re-check of verified SSO domains (S04-P1-V-sso-stale-domain, the jobs part): with the
// dev resolver double, a record that stays keeps the proof fresh; a missing one warns the
// workspace's owners and admins once, and after SSO_DOMAIN_LAPSE_DAYS the proof lapses so the
// domain stops capturing sign-in and another workspace can verify it.
import { env } from 'cloudflare:test';
import { SSO_DOMAIN_LAPSE_DAYS, newId } from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import { recheckSsoDomainProofs } from '../src/handlers/sso';
import { jobsEnv, one, seedChannel, seedFeedAdmin } from './helpers';

const DAY = 86_400_000;

async function seedDomain(workspaceId: string, domain: string, checkedAt: number) {
  const connectionId = newId('ssoConnection');
  const domainId = newId('ssoDomain');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sso_connections (id, workspace_id, protocol, domains_json, config_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'oidc', ?3, '{"issuer":"https://idp.example.com","clientId":"swarm"}', 'active', 0, 0)`,
    ).bind(connectionId, workspaceId, JSON.stringify([domain])),
    env.DB.prepare(
      `INSERT INTO sso_domains (id, connection_id, workspace_id, domain, verification_token, verified_at, created_at, checked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)`,
    ).bind(domainId, connectionId, workspaceId, domain, `tok-${domainId.slice(-8)}`, checkedAt),
  ]);
  return { connectionId, domainId, token: `tok-${domainId.slice(-8)}` };
}

const publish = (domain: string, token: string) =>
  env.CACHE.put(`dev:txt:_swarm-sso.${domain}`, JSON.stringify([`swarm-sso=${token}`]));
const unpublish = (domain: string) => env.CACHE.delete(`dev:txt:_swarm-sso.${domain}`);

const domainRow = (id: string) =>
  one<{ verified_at: number | null; checked_at: number | null; failing_since: number | null }>(
    'SELECT verified_at, checked_at, failing_since FROM sso_domains WHERE id = ?1',
    id,
  );

describe('the daily SSO domain re-check', () => {
  it('keeps a present record, warns once about a missing one and lapses it after the period', async () => {
    const start = Date.now() + 400 * DAY;
    const { workspaceId } = await seedChannel();
    const admin = await seedFeedAdmin(workspaceId, 'admin');
    const adminEmail = (await one<{ email: string }>(
      'SELECT email FROM operators WHERE id = ?1',
      admin,
    ))!.email;
    const tag = crypto.randomUUID().slice(0, 8);
    const kept = {
      name: `kept-${tag}.example`,
      ...(await seedDomain(workspaceId, `kept-${tag}.example`, start - 2 * DAY)),
    };
    const gone = {
      name: `gone-${tag}.example`,
      ...(await seedDomain(workspaceId, `gone-${tag}.example`, start - 2 * DAY)),
    };
    await publish(kept.name, kept.token);
    await publish(gone.name, gone.token);
    const { env: jobs } = jobsEnv();

    // Both records there: both proofs are fresh.
    await recheckSsoDomainProofs(jobs, start);
    expect(await domainRow(gone.domainId)).toMatchObject({
      checked_at: start,
      failing_since: null,
    });
    // Checked within the day: not looked up again.
    await unpublish(gone.name);
    await recheckSsoDomainProofs(jobs, start + 1000);
    expect((await domainRow(gone.domainId))?.failing_since).toBeNull();

    // A day later the missing record is noticed: failing, still verified, admins warned once.
    const day1 = start + DAY + 1000;
    await recheckSsoDomainProofs(jobs, day1);
    expect(await domainRow(gone.domainId)).toMatchObject({ failing_since: day1 });
    expect((await domainRow(gone.domainId))?.verified_at).not.toBeNull();
    const warned = async () =>
      (await new DevMailbox(env.DEV_MAILBOX).list({ to: adminEmail })).filter((m) =>
        m.subject.includes(gone.name),
      );
    expect(await warned()).toHaveLength(1);
    await recheckSsoDomainProofs(jobs, day1 + DAY + 1000);
    expect(await warned()).toHaveLength(1);

    // After the lapse period: no longer verified, and the connection no longer captures it.
    const lapse = day1 + SSO_DOMAIN_LAPSE_DAYS * DAY;
    await recheckSsoDomainProofs(jobs, lapse);
    expect((await domainRow(gone.domainId))?.verified_at).toBeNull();
    const connection = await one<{ domains_json: string }>(
      'SELECT domains_json FROM sso_connections WHERE id = ?1',
      gone.connectionId,
    );
    expect(JSON.parse(connection!.domains_json)).toEqual([]);
    const actions = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE workspace_id = ?1 AND action LIKE 'sso.%' ORDER BY seq",
    )
      .bind(workspaceId)
      .all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual([
      'sso.domain_proof_failing',
      'sso.domain_lapsed',
    ]);
    // The record that stayed kept its proof throughout.
    expect(await domainRow(kept.domainId)).toMatchObject({ failing_since: null });
    expect((await domainRow(kept.domainId))?.verified_at).not.toBeNull();
  });
});
