// Encrypted profile fields through the vault: who may open and seal them (the credential the api
// passes through, resolved here; stored jobs), the row binding that keeps a copied value shut,
// legacy opening, and the records each bulk open leaves.
import { env } from 'cloudflare:workers';
import { encrypt, openV3, sealedBinding } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addApiKey,
  addChannel,
  addField,
  addMember,
  addOAuthToken,
  addOperator,
  rows,
  seedChannel,
  session,
  sql,
  storeValue,
  vault,
} from './helpers';

const fieldKeys = parseKeyring(env.FIELD_KEYS);

describe('api: openMemberFields and sealMemberFields', () => {
  let workspaceId: string;
  let channelId: string;
  let fieldId: string;
  let memberId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
    fieldId = await addField(channelId, 'tax_id');
    await addField(channelId, 'city', { encrypted: false });
    memberId = await addMember(channelId);
    await storeValue(memberId, fieldId, await encrypt(fieldKeys, JSON.stringify('DE-123')));
  });

  it('opens for a viewer of the Channel, encrypted fields only', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'viewer');
    const result = await vault('api').openMemberFields(session(sessionToken), {
      channelId,
      memberIds: [memberId],
    });
    expect(result).toEqual({ ok: true, value: { [memberId]: { tax_id: 'DE-123' } } });
  });

  it('refuses a session waiting for its second factor, expired or revoked', async () => {
    for (const options of [{ mfaPending: true }, { expired: true }, { revoked: true }]) {
      const { sessionToken } = await addOperator(workspaceId, 'owner', options);
      const result = await vault('api').openMemberFields(session(sessionToken), {
        channelId,
        memberIds: [memberId],
      });
      expect(result, JSON.stringify(options)).toEqual({ ok: false, reason: 'refused' });
    }
  });

  it('refuses an operator of another workspace, and a Channel role that lowers the seat', async () => {
    const other = await seedChannel();
    const stranger = await addOperator(other.workspaceId, 'owner');
    expect(
      await vault('api').openMemberFields(session(stranger.sessionToken), {
        channelId,
        memberIds: [memberId],
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
    const lowered = await addOperator(workspaceId, 'editor', {
      channelRole: { channelId, role: 'viewer' },
    });
    expect(
      await vault('api').sealMemberFields(session(lowered.sessionToken), {
        channelId,
        memberId,
        values: { tax_id: 'X' },
      }),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('opens nothing when one Member is in another Channel', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'owner');
    const elsewhere = await addMember(await addChannel(workspaceId));
    const result = await vault('api').openMemberFields(session(sessionToken), {
      channelId,
      memberIds: [memberId, elsewhere],
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('resolves API keys: scope, Channel list, revocation, expiry, a demoted creator, IP', async () => {
    const admin = await addOperator(workspaceId, 'admin');
    const read = { channelId, memberIds: [memberId] };
    const open = async (secret: string, ip?: string) =>
      vault('api').openMemberFields({ kind: 'api-key', secret, ...(ip ? { ip } : {}) }, read);
    expect((await open(await addApiKey(workspaceId, ['members:read']))).ok).toBe(true);
    // members:write implies members:read.
    expect((await open(await addApiKey(workspaceId, ['members:write']))).ok).toBe(true);
    expect(await open(await addApiKey(workspaceId, ['sends:write']))).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(
      await open(await addApiKey(workspaceId, ['members:read'], { channelIds: ['ch_other'] })),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(await open(await addApiKey(workspaceId, ['members:read'], { revoked: true }))).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(await open(await addApiKey(workspaceId, ['members:read'], { expired: true }))).toEqual({
      ok: false,
      reason: 'refused',
    });
    const backed = await addApiKey(workspaceId, ['members:read'], { createdBy: admin.operatorId });
    expect((await open(backed)).ok).toBe(true);
    await sql("UPDATE seats SET role = 'editor' WHERE operator_id = ?1", admin.operatorId);
    expect(await open(backed)).toEqual({ ok: false, reason: 'refused' });
    const fenced = await addApiKey(workspaceId, ['members:read'], {
      ipAllowlist: ['203.0.113.0/24'],
    });
    expect((await open(fenced, '203.0.113.9')).ok).toBe(true);
    expect(await open(fenced)).toEqual({ ok: false, reason: 'refused' });
    const mcpOnly = await addApiKey(workspaceId, ['members:read'], { surface: 'mcp' });
    expect(await open(mcpOnly)).toEqual({ ok: false, reason: 'refused' });
    expect(
      (
        await vault('api').openMemberFields(
          { kind: 'api-key', secret: mcpOnly, resource: 'mcp' },
          read,
        )
      ).ok,
    ).toBe(true);
  });

  it('resolves OAuth tokens for their own resource and scopes', async () => {
    const admin = await addOperator(workspaceId, 'admin');
    const token = await addOAuthToken(workspaceId, admin.operatorId, ['members:read'], 'mcp');
    const read = { channelId, memberIds: [memberId] };
    expect(
      (
        await vault('api').openMemberFields(
          { kind: 'oauth', accessToken: token, resource: 'mcp' },
          read,
        )
      ).ok,
    ).toBe(true);
    expect(
      await vault('api').openMemberFields(
        { kind: 'oauth', accessToken: token, resource: 'v2' },
        read,
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await vault('api').sealMemberFields(
        { kind: 'oauth', accessToken: token, resource: 'mcp' },
        { channelId, memberId, values: { tax_id: 'X' } },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses principals that are not credentials, and malformed ones', async () => {
    const api = vault('api');
    expect(
      await api.openMemberFields({ kind: 'export-job', jobId: 'ej_x' } as never, {
        channelId,
        memberIds: [memberId],
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await api.openMemberFields(
        { kind: 'operator-session', sessionToken: 'x'.repeat(500) },
        { channelId, memberIds: [memberId] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const { sessionToken } = await addOperator(workspaceId, 'owner');
    expect(
      await api.openMemberFields(session(sessionToken), { channelId, memberIds: ['nope'] }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('seals for editors, in the legacy format callers still read', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'editor');
    const result = await vault('api').sealMemberFields(session(sessionToken), {
      channelId,
      memberId,
      values: { tax_id: '  FR-9 ' },
    });
    if (!result.ok) throw new Error(result.reason);
    const sealed = result.value.tax_id as string;
    expect(sealed.startsWith('f1.')).toBe(true);
    // Normalised as the field's type says.
    const { decrypt } = await import('@swarm/engine');
    expect(await decrypt(fieldKeys, sealed)).toBe('"FR-9"');
  });

  it('hands back the stored ciphertext for an unchanged value, never to a sign-up', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'editor');
    const stored = (
      await rows<{ value_enc: string }>(
        'SELECT value_enc FROM member_field_values WHERE member_id = ?1',
        memberId,
      )
    )[0]!.value_enc;
    // The same value: the stored string itself, so the caller's write and field_changed see no
    // change, and the comparison happened here, on plaintext (engine events.ts).
    const same = await vault('api').sealMemberFields(session(sessionToken), {
      channelId,
      memberId,
      values: { tax_id: 'DE-123' },
    });
    expect(same).toEqual({ ok: true, value: { tax_id: stored } });
    const changed = await vault('api').sealMemberFields(session(sessionToken), {
      channelId,
      memberId,
      values: { tax_id: 'DE-124' },
    });
    if (!changed.ok) throw new Error(changed.reason);
    expect(changed.value.tax_id).not.toBe(stored);
    // An anonymous sign-up never learns whether a value equals what is stored.
    const formId = `cf_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Form', 'published', '{}', ?4, ?4)`,
      formId,
      workspaceId,
      channelId,
      Date.now(),
    );
    const signup = await vault('capture').sealSignupFields({
      formId,
      memberId,
      values: { tax_id: 'DE-123' },
    });
    if (!signup.ok) throw new Error(signup.reason);
    expect(signup.value.tax_id).not.toBe(stored);
  });

  it('refuses unknown or unencrypted fields, bad values and a Member of another Channel', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'editor');
    const seal = (args: { memberId: string; values: Record<string, unknown> }) =>
      vault('api').sealMemberFields(session(sessionToken), { channelId, ...args } as never);
    expect(await seal({ memberId, values: { city: 'Berlin' } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await seal({ memberId, values: { tax_id: 12 } })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const elsewhere = await addMember(await addChannel(workspaceId));
    expect(await seal({ memberId: elsewhere, values: { tax_id: 'X' } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('seals v3 bound to the row, and a value copied to another Member does not open', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'owner');
    const v3 = vault('api', { vars: { VAULT_WRITE_FORMAT: 'v3' } });
    const sealed = await v3.sealMemberFields(session(sessionToken), {
      channelId,
      memberId,
      values: { tax_id: 'NL-1' },
    });
    if (!sealed.ok) throw new Error(sealed.reason);
    const value = sealed.value.tax_id as string;
    expect(value.startsWith('fv3.member-field.f1.')).toBe(true);
    expect(
      await openV3(
        fieldKeys,
        'member-field',
        sealedBinding({ w: workspaceId, c: channelId, m: memberId, f: fieldId }),
        value,
      ),
    ).toBe('"NL-1"');
    await storeValue(memberId, fieldId, value);
    const victim = await addMember(channelId);
    await storeValue(victim, fieldId, value);
    // And into a Member of another tenant, whose operator is allowed there.
    const other = await seedChannel();
    const otherField = await addField(other.channelId, 'tax_id');
    const otherMember = await addMember(other.channelId);
    await storeValue(otherMember, otherField, value);
    const otherOwner = await addOperator(other.workspaceId, 'owner');

    const opened = await v3.openMemberFields(session(sessionToken), {
      channelId,
      memberIds: [memberId, victim],
    });
    expect(opened).toEqual({
      ok: true,
      value: { [memberId]: { tax_id: 'NL-1' }, [victim]: { tax_id: null } },
    });
    expect(
      await v3.openMemberFields(session(otherOwner.sessionToken), {
        channelId: other.channelId,
        memberIds: [otherMember],
      }),
    ).toEqual({ ok: true, value: { [otherMember]: { tax_id: null } } });
  });

  it('opens legacy values only while VAULT_LEGACY_OPEN is on', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'owner');
    const closed = vault('api', { vars: { VAULT_LEGACY_OPEN: 'off' } });
    expect(
      await closed.openMemberFields(session(sessionToken), { channelId, memberIds: [memberId] }),
    ).toEqual({ ok: true, value: { [memberId]: { tax_id: null } } });
  });
});

describe('jobs: openMemberFields and sealMemberFieldsBulk', () => {
  let workspaceId: string;
  let channelId: string;
  let fieldId: string;
  let memberId: string;
  let creator: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
    fieldId = await addField(channelId, 'tax_id');
    memberId = await addMember(channelId);
    await storeValue(memberId, fieldId, await encrypt(fieldKeys, JSON.stringify('DE-1')));
    creator = (await addOperator(workspaceId, 'admin')).operatorId;
  });

  const exportJob = async (status = 'running') => {
    const id = `ej_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO export_jobs (id, workspace_id, channel_id, format, status, created_by, created_at)
       VALUES (?1, ?2, ?3, 'csv', ?4, ?5, ?6)`,
      id,
      workspaceId,
      channelId,
      status,
      creator,
      Date.now(),
    );
    return id;
  };

  it('opens for a running export, and writes the workspace audit once per job', async () => {
    const jobId = await exportJob();
    const jobs = vault('jobs');
    for (let i = 0; i < 2; i++) {
      const result = await jobs.openMemberFields(
        { kind: 'export-job', jobId },
        { channelId, memberIds: [memberId] },
      );
      expect(result).toEqual({ ok: true, value: { [memberId]: { tax_id: 'DE-1' } } });
    }
    const audit = await rows<{ action: string; metadata_json: string }>(
      'SELECT action, metadata_json FROM audit_events WHERE workspace_id = ?1',
      workspaceId,
    );
    expect(audit).toEqual([
      { action: 'vault.export_open', metadata_json: JSON.stringify({ caller: 'jobs', count: 1 }) },
    ]);
    const own = await rows<{ count: number; decision: string }>(
      "SELECT count, decision FROM vault_audit WHERE principal_id = ?1 AND op = 'openMemberFields'",
      jobId,
    );
    expect(own).toEqual([
      { count: 1, decision: 'allowed' },
      { count: 1, decision: 'allowed' },
    ]);
  });

  it('refuses an export that is done, of another Channel, or whose creator lost admin', async () => {
    const jobs = vault('jobs');
    const done = await exportJob('done');
    expect(
      await jobs.openMemberFields(
        { kind: 'export-job', jobId: done },
        { channelId, memberIds: [memberId] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const jobId = await exportJob();
    const otherChannel = await addChannel(workspaceId);
    expect(
      await jobs.openMemberFields(
        { kind: 'export-job', jobId },
        { channelId: otherChannel, memberIds: [] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    await sql("UPDATE seats SET role = 'editor' WHERE operator_id = ?1", creator);
    expect(
      await jobs.openMemberFields(
        { kind: 'export-job', jobId },
        { channelId, memberIds: [memberId] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const refusals = await rows<{ decision: string; reason: string }>(
      "SELECT decision, reason FROM vault_audit WHERE principal_kind = 'export-job' AND decision = 'refused'",
    );
    expect(refusals.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses credentials and cron on the jobs entrypoint', async () => {
    const { sessionToken } = await addOperator(workspaceId, 'owner');
    expect(
      await vault('jobs').openMemberFields(session(sessionToken) as never, {
        channelId,
        memberIds: [memberId],
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await vault('jobs').openMemberFields(
        { kind: 'cron', task: 'paypal-reconcile' },
        {
          channelId,
          memberIds: [memberId],
        },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('seals each row of a bulk edit on its own, for running jobs only', async () => {
    const jobId = `bj_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, selection_json, status, created_at)
       VALUES (?1, ?2, ?3, 'set_field', '{}', 'running', ?4)`,
      jobId,
      workspaceId,
      channelId,
      Date.now(),
    );
    const second = await addMember(channelId);
    const result = await vault('jobs', { vars: { VAULT_WRITE_FORMAT: 'v3' } }).sealMemberFieldsBulk(
      { kind: 'bulk-job', jobId },
      {
        channelId,
        rows: [
          { memberId, values: { tax_id: 'same' } },
          { memberId: second, values: { tax_id: 'same' } },
        ],
      },
    );
    if (!result.ok) throw new Error(result.reason);
    const a = result.value[memberId]?.tax_id as string;
    const b = result.value[second]?.tax_id as string;
    expect(a).not.toBe(b);
    const bind = (m: string) => sealedBinding({ w: workspaceId, c: channelId, m, f: fieldId });
    expect(await openV3(fieldKeys, 'member-field', bind(second), b)).toBe('"same"');
    expect(await openV3(fieldKeys, 'member-field', bind(second), a)).toBeNull();
    await sql("UPDATE bulk_jobs SET status = 'done' WHERE id = ?1", jobId);
    expect(
      await vault('jobs').sealMemberFieldsBulk(
        { kind: 'bulk-job', jobId },
        { channelId, rows: [{ memberId, values: { tax_id: 'x' } }] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('opens for a Flow run only at its current node, and for an import while it runs', async () => {
    const now = Date.now();
    const flowId = `fl_${crypto.randomUUID().replaceAll('-', '')}`;
    const runId = `fr_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO flows (id, workspace_id, channel_id, name, draft_graph_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'F', '{}', ?4, ?4)`,
      flowId,
      workspaceId,
      channelId,
      now,
    );
    await sql(
      `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, current_node_id, started_at, updated_at)
       VALUES (?1, ?2, 1, ?3, ?4, 'running', 'n1', ?5, ?5)`,
      runId,
      flowId,
      channelId,
      memberId,
      now,
    );
    const jobs = vault('jobs');
    const read = { channelId, memberIds: [memberId] };
    expect((await jobs.openMemberFields({ kind: 'flow-run', runId, nodeId: 'n1' }, read)).ok).toBe(
      true,
    );
    expect(await jobs.openMemberFields({ kind: 'flow-run', runId, nodeId: 'n2' }, read)).toEqual({
      ok: false,
      reason: 'refused',
    });
    const importId = `ij_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'importing', 'a.csv', 'k', 1, ?4, ?4)`,
      importId,
      workspaceId,
      channelId,
      now,
    );
    expect((await jobs.openMemberFields({ kind: 'import-job', jobId: importId }, read)).ok).toBe(
      true,
    );
    await sql("UPDATE import_jobs SET status = 'done' WHERE id = ?1", importId);
    expect(await jobs.openMemberFields({ kind: 'import-job', jobId: importId }, read)).toEqual({
      ok: false,
      reason: 'refused',
    });
  });
});
