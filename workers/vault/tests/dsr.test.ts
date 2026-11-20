// Data requests through the vault: addresses sealed for their row, opened only for a request
// being processed (and recorded in the workspace's audit log), the export with its fields
// opened by the vault, and erasure markers that do not become an address oracle.
import { env } from 'cloudflare:workers';
import { addressMarkers, encrypt, encryptFor, openDsrAddress } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addField,
  addMember,
  addOperator,
  memberLinkV1,
  rows,
  seedChannel,
  session,
  sql,
  storeValue,
  vault,
} from './helpers';

const fieldKeys = parseKeyring(env.FIELD_KEYS);

async function addRequest(workspaceId: string, emailEnc: string, status = 'processing') {
  const id = `pr_${crypto.randomUUID().replaceAll('-', '')}`;
  const now = Date.now();
  await sql(
    `INSERT INTO dsr_requests (id, workspace_id, email_hash, kind, source, status, due_at, created_at, updated_at, email_enc)
     VALUES (?1, ?2, 'h', 'export', 'operator', ?3, ?4, ?4, ?4, ?5)`,
    id,
    workspaceId,
    status,
    now,
    emailEnc,
  );
  return id;
}

describe('data requests', () => {
  let workspaceId: string;
  let channelId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
  });

  it('seals an operator’s request address for admins, readable as before while writes are legacy', async () => {
    const admin = await addOperator(workspaceId, 'admin');
    const editor = await addOperator(workspaceId, 'editor');
    const args = { workspaceId, requestId: 'pr_new', email: ' Ada@Example.test ' };
    expect(await vault('api').sealDsrAddress(session(editor.sessionToken), args)).toEqual({
      ok: false,
      reason: 'refused',
    });
    const sealed = await vault('api').sealDsrAddress(session(admin.sessionToken), args);
    if (!sealed.ok) throw new Error(sealed.reason);
    expect(await openDsrAddress(fieldKeys, sealed.value)).toBe('ada@example.test');
  });

  it('opens the address only while the request is processing, and audits it', async () => {
    const requestId = await addRequest(
      workspaceId,
      await encryptFor(fieldKeys, 'dsr-address', 'p@example.test'),
    );
    const jobs = vault('jobs');
    expect(await jobs.openDsrAddress({ kind: 'dsr-request', requestId })).toEqual({
      ok: true,
      value: 'p@example.test',
    });
    const audit = await rows<{ action: string }>(
      'SELECT action FROM audit_events WHERE workspace_id = ?1',
      workspaceId,
    );
    expect(audit).toEqual([{ action: 'vault.dsr_open' }]);
    await sql("UPDATE dsr_requests SET status = 'pending' WHERE id = ?1", requestId);
    expect(await jobs.openDsrAddress({ kind: 'dsr-request', requestId })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('builds the export with encrypted fields opened by the vault', async () => {
    const fieldId = await addField(channelId, 'tax_id');
    const memberId = await addMember(channelId, 'e@example.test');
    await storeValue(memberId, fieldId, await encrypt(fieldKeys, JSON.stringify('DE-7')));
    const requestId = await addRequest(
      workspaceId,
      await encryptFor(fieldKeys, 'dsr-address', 'e@example.test'),
    );
    const built = await vault('jobs').buildDsrExport({ kind: 'dsr-request', requestId });
    if (!built.ok) throw new Error(built.reason);
    const channels = (built.value as { channels: { fields: Record<string, { value: unknown }> }[] })
      .channels;
    expect(channels[0]?.fields.tax_id?.value).toBe('DE-7');
    // With legacy opening off, the engine's own legacy open is overridden: the field is null.
    const closed = await vault('jobs', { vars: { VAULT_LEGACY_OPEN: 'off' } }).buildDsrExport({
      kind: 'dsr-request',
      requestId,
    });
    expect(closed).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('seals a Member’s own address for capture from a member link', async () => {
    const memberId = await addMember(channelId, 'm@example.test');
    const sealed = await vault('capture').sealMemberDsrAddress({
      token: await memberLinkV1(memberId),
      requestId: 'pr_from_member',
    });
    if (!sealed.ok) throw new Error(sealed.reason);
    expect(await openDsrAddress(fieldKeys, sealed.value)).toBe('m@example.test');
    expect(
      await vault('capture').sealMemberDsrAddress({ token: 'forged', requestId: 'pr_x' }),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('seals a typed address for a confirmation, bound to its marker, and opens it once confirmed', async () => {
    const capture = vault('capture', { vars: { VAULT_WRITE_FORMAT: 'v3' } });
    const sealed = await capture.sealAddressConfirmation({ channelId, email: 'T@example.test' });
    if (!sealed.ok) throw new Error(sealed.reason);
    const markers = await addressMarkers(env.DB, workspaceId, 't@example.test', fieldKeys);
    expect(sealed.value.emailHash).toBe(markers.keyed);
    const now = Date.now();
    const insert = await env.DB.prepare(
      `INSERT INTO address_confirmations (workspace_id, channel_id, kind, email_enc, email_hash, created_at, expires_at)
       VALUES (?1, ?2, 'export', ?3, ?4, ?5, ?6) RETURNING id`,
    )
      .bind(
        workspaceId,
        channelId,
        sealed.value.sealed,
        sealed.value.emailHash,
        now,
        now + 86_400_000,
      )
      .first<{ id: number }>();
    const confirmationId = insert?.id as number;
    expect(await capture.openAddressConfirmation({ confirmationId, workspaceId })).toEqual({
      ok: true,
      value: 't@example.test',
    });
    // The same sealed value under another address's marker does not open.
    await sql(
      "UPDATE address_confirmations SET email_hash = 'k1:other' WHERE id = ?1",
      confirmationId,
    );
    expect(await capture.openAddressConfirmation({ confirmationId, workspaceId })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    await sql('UPDATE address_confirmations SET used_at = ?1 WHERE id = ?2', now, confirmationId);
    expect(await capture.openAddressConfirmation({ confirmationId, workspaceId })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('seals the address of a confirmation for the request it files, only while it is open', async () => {
    const capture = vault('capture', { vars: { VAULT_WRITE_FORMAT: 'v3' } });
    const sealed = await capture.sealAddressConfirmation({ channelId, email: 'c@example.test' });
    if (!sealed.ok) throw new Error(sealed.reason);
    const now = Date.now();
    const insert = await env.DB.prepare(
      `INSERT INTO address_confirmations (workspace_id, channel_id, kind, email_enc, email_hash, created_at, expires_at)
       VALUES (?1, ?2, 'erase', ?3, ?4, ?5, ?6) RETURNING id`,
    )
      .bind(
        workspaceId,
        channelId,
        sealed.value.sealed,
        sealed.value.emailHash,
        now,
        now + 86_400_000,
      )
      .first<{ id: number }>();
    const confirmationId = insert?.id as number;
    const requestId = `pr_${crypto.randomUUID().replaceAll('-', '')}`;
    const forRequest = await capture.sealConfirmedAddress({
      confirmationId,
      workspaceId,
      requestId,
    });
    if (!forRequest.ok) throw new Error(forRequest.reason);
    await sql(
      `INSERT INTO dsr_requests (id, workspace_id, email_hash, kind, source, status, due_at, created_at, updated_at, email_enc)
       VALUES (?1, ?2, 'h', 'erase', 'address_form', 'processing', ?3, ?3, ?3, ?4)`,
      requestId,
      workspaceId,
      now,
      forRequest.value,
    );
    expect(await vault('jobs').openDsrAddress({ kind: 'dsr-request', requestId })).toEqual({
      ok: true,
      value: 'c@example.test',
    });
    await sql('UPDATE address_confirmations SET used_at = ?1 WHERE id = ?2', now, confirmationId);
    expect(
      await capture.sealConfirmedAddress({ confirmationId, workspaceId, requestId: 'pr_other' }),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('gives the markers of many addresses in one call (jobs), as the single lookup does', async () => {
    const one = await vault('jobs').addressMarkers({ workspaceId, email: 'b1@example.test' });
    const many = await vault('jobs').addressMarkersBulk({
      workspaceId,
      emails: ['B1@example.test', 'b2@example.test'],
    });
    if (!one.ok || !many.ok) throw new Error('markers');
    expect(many.value['b1@example.test']).toEqual(one.value);
    expect(Object.keys(many.value).sort()).toEqual(['b1@example.test', 'b2@example.test']);
    expect(
      await vault('jobs').addressMarkersBulk({
        workspaceId,
        emails: Array.from({ length: 501 }, (_, i) => `n${i}@example.test`),
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('gives the erasure markers the engine computes, rate-limited per caller and workspace', async () => {
    const expected = await addressMarkers(env.DB, workspaceId, 'x@example.test', fieldKeys);
    const result = await vault('jobs').addressMarkers({ workspaceId, email: 'X@example.test' });
    expect(result).toEqual({
      ok: true,
      value: { keyed: expected.keyed, legacy: expected.legacy, forms: expected.forms },
    });
    const { sha256Hex } = await import('@swarm/db');
    await sql(
      `INSERT INTO vault_rate (scope, subject_hash, window_start, used) VALUES ('markers', ?1, ?2, 5000)`,
      await sha256Hex(`markers\ncapture:${workspaceId}`),
      Date.now() - (Date.now() % 60_000),
    );
    expect(await vault('capture').addressMarkers({ workspaceId, email: 'x@example.test' })).toEqual(
      {
        ok: false,
        reason: 'rate_limited',
      },
    );
    // Other callers keep their own budget.
    expect((await vault('api').addressMarkers({ workspaceId, email: 'x@example.test' })).ok).toBe(
      true,
    );
  });
});
