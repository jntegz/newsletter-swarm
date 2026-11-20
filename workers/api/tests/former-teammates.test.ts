// Former teammates (packages/engine/src/lifetimes.ts redactFormerTeammate): an owner removes the
// details of someone who no longer works in the workspace, without rewriting the audit chain.
import { env } from 'cloudflare:test';
import { newId, type AuditEvent, type FormerTeammate } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { appendAudit } from '../src/lib/audit';
import { call, json, seatAs, signIn } from './helpers';

const list = (path: string, cookie: string) => call('GET', path, { cookie });

async function formerAdmin() {
  const owner = await signIn();
  const admin = await seatAs(owner.workspaceId, 'admin');
  const operatorId = admin.me.operator.id;
  // Something they did here, naming their own address (as invitations once did).
  await appendAudit(env.DB, {
    workspaceId: owner.workspaceId,
    actorId: operatorId,
    action: 'invite.revoked',
    metadata: { email: admin.email },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invites (id, workspace_id, email, role, token_hash, created_at, expires_at, accepted_at)
       VALUES (?1, ?2, ?3, 'admin', ?4, 0, 1, 1)`,
    ).bind(`inv_${crypto.randomUUID()}`, owner.workspaceId, admin.email, crypto.randomUUID()),
    env.DB.prepare(
      `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, created_by, created_at)
       VALUES (?1, ?2, 'Their key', 'pfx', ?3, '[]', ?4, 0)`,
    ).bind(`key_${crypto.randomUUID()}`, owner.workspaceId, crypto.randomUUID(), operatorId),
  ]);
  return { owner, admin, operatorId };
}

describe('former teammates', () => {
  it('can be redacted by an owner once they hold no seat, without breaking the audit chain', async () => {
    const { owner, admin, operatorId } = await formerAdmin();
    const base = `/api/v1/workspaces/${owner.workspaceId}/former-teammates`;
    // Still seated: not listed, and refused.
    expect((await json<{ data: FormerTeammate[] }>(await list(base, owner.cookie))).data).toEqual(
      [],
    );
    expect(
      (await call('POST', `${base}/${operatorId}/redact`, { cookie: owner.cookie })).status,
    ).toBe(409);

    await env.DB.prepare('DELETE FROM seats WHERE workspace_id = ?1 AND operator_id = ?2')
      .bind(owner.workspaceId, operatorId)
      .run();
    const listed = (await json<{ data: FormerTeammate[] }>(await list(base, owner.cookie))).data;
    expect(listed).toMatchObject([{ id: operatorId, email: admin.email, redacted: false }]);

    const done = await call('POST', `${base}/${operatorId}/redact`, { cookie: owner.cookie });
    expect(done.status).toBe(200);
    const placeholder = (await json<{ data: FormerTeammate }>(done)).data.email;
    expect(placeholder).toMatch(/^former-teammate-[0-9a-f]{12}@redacted\.invalid$/);
    // Stable: a second request changes nothing.
    const again = await call('POST', `${base}/${operatorId}/redact`, { cookie: owner.cookie });
    expect((await json<{ data: FormerTeammate }>(again)).data.email).toBe(placeholder);

    // The audit log shows the placeholder for who did it and inside the entry.
    const audit = await json<{ data: { items: AuditEvent[] } }>(
      await list(`/api/v1/workspaces/${owner.workspaceId}/audit?limit=50`, owner.cookie),
    );
    const text = JSON.stringify(audit.data.items);
    expect(text).not.toContain(admin.email);
    const revoked = audit.data.items.find((e) => e.action === 'invite.revoked')!;
    expect(revoked.actor?.email).toBe(placeholder);
    expect(revoked.metadata).toEqual({ email: placeholder });
    expect(audit.data.items.filter((e) => e.action === 'teammate.redacted')).toHaveLength(1);
    // Stored entries were not rewritten, so the chain still verifies.
    const verify = await json<{ data: { ok: boolean } }>(
      await list(`/api/v1/workspaces/${owner.workspaceId}/audit/verify`, owner.cookie),
    );
    expect(verify.data.ok).toBe(true);

    // The invitation no longer holds the address, and their key shows the placeholder.
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM invites WHERE workspace_id = ?1 AND email = ?2',
      )
        .bind(owner.workspaceId, admin.email)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const keys = await json<{ data: { createdBy: { email: string } | null }[] }>(
      await list(`/api/v1/workspaces/${owner.workspaceId}/api-keys`, owner.cookie),
    );
    expect(keys.data.map((k) => k.createdBy?.email)).toContain(placeholder);
    // Their account is untouched.
    expect(
      await env.DB.prepare('SELECT email FROM operators WHERE id = ?1')
        .bind(operatorId)
        .first<{ email: string }>(),
    ).toEqual({ email: admin.email });
  });

  it('shows the placeholder for what they did through Copilot in the agent log and approvals', async () => {
    const { owner, admin, operatorId } = await formerAdmin();
    const now = Date.now();
    const approvalId = newId('agentApproval');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_actions (id, workspace_id, seq, source, principal_kind, principal_id, tool,
                                    arguments_json, outcome, latency_ms, created_at, prev_hash, hash)
         VALUES (?1, ?2, 1, 'copilot', 'copilot', ?3, 'list_members', '{}', 'ok', 5, ?4, 'x', 'y')`,
      ).bind(`act_${crypto.randomUUID()}`, owner.workspaceId, operatorId, now),
      env.DB.prepare(
        `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
                                      scope, risk, method, path, arguments_json, status, expires_at,
                                      decided_by, decided_at, created_at)
         VALUES (?1, ?2, 'act_x', 'copilot', ?3, 'delete_member', 'members:write', 'destructive',
                 'DELETE', '/v2/members/x', '{}', 'rejected', ?4, ?3, ?4, ?4)`,
      ).bind(approvalId, owner.workspaceId, operatorId, now),
      env.DB.prepare('DELETE FROM seats WHERE workspace_id = ?1 AND operator_id = ?2').bind(
        owner.workspaceId,
        operatorId,
      ),
    ]);
    const base = `/api/v1/workspaces/${owner.workspaceId}`;
    const views = async () => {
      const actions = await json<{ data: { items: { credential: { label: string } }[] } }>(
        await list(`${base}/agent-actions`, owner.cookie),
      );
      const approval = await json<{
        data: { credential: { label: string }; decidedBy: { email: string } | null };
      }>(await list(`${base}/agent-approvals/${approvalId}`, owner.cookie));
      return { actions: actions.data.items, approval: approval.data };
    };
    // Before: their address, as for any teammate.
    const before = await views();
    expect(before.actions[0]?.credential.label).toBe(`${admin.email} via Copilot`);
    expect(before.approval.credential.label).toBe(`${admin.email} via Copilot`);

    const done = await call('POST', `${base}/former-teammates/${operatorId}/redact`, {
      cookie: owner.cookie,
    });
    const placeholder = (await json<{ data: FormerTeammate }>(done)).data.email;
    const after = await views();
    expect(JSON.stringify(after)).not.toContain(admin.email);
    expect(after.actions[0]?.credential.label).toBe(`${placeholder} via Copilot`);
    expect(after.approval.credential.label).toBe(`${placeholder} via Copilot`);
    expect(after.approval.decidedBy?.email).toBe(placeholder);
  });

  it('is for owners, and only for people who worked in this workspace', async () => {
    const { owner, operatorId } = await formerAdmin();
    const base = `/api/v1/workspaces/${owner.workspaceId}/former-teammates`;
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await list(base, admin.cookie)).status).toBe(403);
    expect(
      (await call('POST', `${base}/${operatorId}/redact`, { cookie: admin.cookie })).status,
    ).toBe(403);
    const stranger = await signIn();
    const res = await call('POST', `${base}/${stranger.me.operator.id}/redact`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
  });
});
