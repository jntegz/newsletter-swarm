/**
 * Data requests: the sealed address of a request (dsr_requests.email_enc) or of an address
 * confirmation (address_confirmations.email_enc), the erasure-marker forms of an address (an
 * HMAC under a key derived from FIELD_KEYS), and the export a request produces. Opening a
 * request's address or building its export is recorded in the workspace's own audit log.
 */
import { first, sha256Hex } from '@swarm/db';
import { addressMarkers as engineMarkers, buildMemberExport, markerSalt } from '@swarm/engine';
import type { AddressMarkerSet, FieldMap } from '../api';
import { recordBulkOpen } from './audit';
import { invalid, notFound, plainRecord, refuse, VaultRefusal, type VaultContext } from './context';
import { openMemberFields } from './fields';
import { take } from './ratelimit';
import { openValue, sealValue } from './sealing';

const normal = (email: string) => email.trim().toLowerCase();

function addressArg(value: unknown): string {
  const email = typeof value === 'string' ? normal(value) : '';
  if (!email || email.length > 254 || !email.includes('@')) return invalid('email');
  return email;
}

/** Seals a request's address for its row (the request id may be the one about to be inserted). */
export async function sealRequestAddress(
  ctx: VaultContext,
  workspaceId: string,
  requestId: unknown,
  email: unknown,
): Promise<string> {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 120) invalid('request');
  const address = addressArg(email);
  const row = await first<{ workspace_id: string }>(
    ctx.db,
    'SELECT workspace_id FROM dsr_requests WHERE id = ?1',
    requestId,
  );
  if (row && row.workspace_id !== workspaceId) notFound('request');
  return sealValue(ctx, 'dsr-address', { w: workspaceId, r: requestId as string }, address);
}

/**
 * The erasure-marker forms of an address in a workspace. Rate-limited per caller and workspace:
 * the markers exist so that someone holding only the database can't test an address, and this
 * must not become an oracle for it.
 */
export async function addressMarkers(
  ctx: VaultContext,
  workspaceId: unknown,
  email: unknown,
): Promise<AddressMarkerSet> {
  if (typeof workspaceId !== 'string' || !workspaceId) return invalid('workspace');
  const address = addressArg(email);
  if (!(await take(ctx, 'markers', `${ctx.caller}:${workspaceId}`))) {
    throw new VaultRefusal('rate_limited', 'markers');
  }
  const workspace = await first(ctx.db, 'SELECT 1 FROM workspaces WHERE id = ?1', workspaceId);
  if (!workspace) notFound('workspace');
  const markers = await engineMarkers(ctx.db, workspaceId, address, ctx.keys.field);
  return { keyed: markers.keyed, legacy: markers.legacy, forms: markers.forms };
}

/** Addresses per bulk marker call. */
const MARKERS_PER_BULK = 500;

/** The marker forms of many addresses of a workspace, each counted against the bulk limit. */
export async function addressMarkersBulk(
  ctx: VaultContext,
  workspaceId: unknown,
  emails: unknown,
): Promise<Record<string, AddressMarkerSet>> {
  if (typeof workspaceId !== 'string' || !workspaceId) return invalid('workspace');
  if (!Array.isArray(emails) || emails.length > MARKERS_PER_BULK) return invalid('emails');
  const addresses = [...new Set(emails.map(addressArg))];
  if (!(await take(ctx, 'markers:bulk', `${ctx.caller}:${workspaceId}`, addresses.length))) {
    throw new VaultRefusal('rate_limited', 'markers');
  }
  const workspace = await first(ctx.db, 'SELECT 1 FROM workspaces WHERE id = ?1', workspaceId);
  if (!workspace) notFound('workspace');
  const salt = await markerSalt(ctx.db, workspaceId);
  const out: Record<string, AddressMarkerSet> = Object.create(null) as Record<
    string,
    AddressMarkerSet
  >;
  for (const address of addresses) {
    const markers = await engineMarkers(ctx.db, workspaceId, address, ctx.keys.field, salt);
    out[address] = { keyed: markers.keyed, legacy: markers.legacy, forms: markers.forms };
  }
  return plainRecord(out);
}

/**
 * Seals a typed address for an address confirmation (the public rights form), bound to the
 * workspace and the address's keyed marker, which the confirmation row stores as email_hash.
 */
export async function sealAddressConfirmation(
  ctx: VaultContext,
  channelId: unknown,
  email: unknown,
): Promise<{ sealed: string; emailHash: string; workspaceId: string }> {
  if (typeof channelId !== 'string' || !channelId) return invalid('channel');
  const address = addressArg(email);
  const channel = await first<{ workspace_id: string }>(
    ctx.db,
    'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if (!channel) return notFound('channel');
  const markers = await engineMarkers(ctx.db, channel.workspace_id, address, ctx.keys.field);
  const sealed = await sealValue(
    ctx,
    'dsr-address',
    { w: channel.workspace_id, ac: markers.keyed },
    address,
  );
  return { sealed, emailHash: markers.keyed, workspaceId: channel.workspace_id };
}

/** The address of an address confirmation that is still unused and unexpired. */
export async function openAddressConfirmation(
  ctx: VaultContext,
  confirmationId: unknown,
  workspaceId: unknown,
): Promise<string> {
  if (!Number.isInteger(confirmationId) || typeof workspaceId !== 'string') {
    return invalid('confirmation');
  }
  const row = await first<{ email_enc: string; email_hash: string }>(
    ctx.db,
    `SELECT email_enc, email_hash FROM address_confirmations
      WHERE id = ?1 AND workspace_id = ?2 AND used_at IS NULL AND expires_at > ?3`,
    confirmationId,
    workspaceId,
    ctx.now(),
  );
  if (!row) return refuse('confirmation');
  const email = await openValue(
    ctx,
    'dsr-address',
    { w: workspaceId, ac: row.email_hash },
    row.email_enc,
  );
  if (!email) throw new VaultRefusal('unreadable', 'confirmation address');
  return email;
}

/**
 * Seals the address of an unused, unexpired confirmation for the data request it files: read
 * from the confirmation's row, bound to the request's.
 */
export async function sealConfirmedAddress(
  ctx: VaultContext,
  confirmationId: unknown,
  workspaceId: unknown,
  requestId: unknown,
): Promise<string> {
  const email = await openAddressConfirmation(ctx, confirmationId, workspaceId);
  return sealRequestAddress(ctx, workspaceId as string, requestId, email);
}

/** How long after an erasure confirmation is used its request may still be sealed. */
const CONFIRMED_ERASURE_MS = 10 * 60_000;

/**
 * Seals the address of the Member an erasure confirmation names, for the request it files. The
 * confirmation must carry the link's nonce (its hash) and be unused, or used a moment ago (the
 * engine marks it used before it files the request).
 */
export async function sealErasureAddress(
  ctx: VaultContext,
  args: { confirmationId: unknown; memberId: unknown; nonce: unknown; requestId: unknown },
): Promise<{ sealed: string; workspaceId: string }> {
  const { confirmationId, memberId, nonce } = args;
  if (!Number.isInteger(confirmationId) || typeof memberId !== 'string') {
    return invalid('confirmation');
  }
  if (nonce !== null && (typeof nonce !== 'string' || nonce.length > 64)) invalid('nonce');
  const row = await first<{ email: string; workspace_id: string }>(
    ctx.db,
    `SELECT m.email, c.workspace_id FROM dsr_confirmations d
       JOIN members m ON m.id = d.member_id JOIN channels c ON c.id = m.channel_id
      WHERE d.id = ?1 AND d.member_id = ?2 AND d.kind = 'erase' AND d.expires_at > ?3
        AND (d.used_at IS NULL OR d.used_at > ?4)
        AND coalesce(d.nonce_hash, '') = coalesce(?5, '') AND c.deleted_at IS NULL`,
    confirmationId,
    memberId,
    ctx.now() - CONFIRMED_ERASURE_MS,
    ctx.now() - CONFIRMED_ERASURE_MS,
    nonce === null ? null : await sha256Hex(nonce as string),
  );
  if (!row) return refuse('erasure confirmation');
  return {
    sealed: await sealRequestAddress(ctx, row.workspace_id, args.requestId, row.email),
    workspaceId: row.workspace_id,
  };
}

/** The address of a data request (a dsr-request principal already checked its status). */
export async function openRequestAddress(
  ctx: VaultContext,
  requestId: string,
): Promise<{ email: string; workspaceId: string }> {
  const row = await first<{ workspace_id: string; email_enc: string | null }>(
    ctx.db,
    'SELECT workspace_id, email_enc FROM dsr_requests WHERE id = ?1',
    requestId,
  );
  if (!row?.email_enc) return notFound('request address');
  const email = await openValue(
    ctx,
    'dsr-address',
    { w: row.workspace_id, r: requestId },
    row.email_enc,
  );
  if (!email) throw new VaultRefusal('unreadable', 'request address');
  await recordBulkOpen(ctx, {
    op: 'openDsrAddress',
    action: 'vault.dsr_open',
    principalKind: 'dsr-request',
    principalId: requestId,
    workspaceId: row.workspace_id,
    count: 1,
    targetType: 'dsr_request',
  });
  return { email, workspaceId: row.workspace_id };
}

interface ExportChannel {
  member?: { id?: unknown; channel_id?: unknown };
  fields?: Record<string, { label: string; value: unknown }>;
}

/**
 * Everything the workspace holds about the request's address (engine buildMemberExport), with
 * encrypted fields opened by the vault: bound to their rows, and legacy values only while
 * legacy opening is on.
 */
export async function buildRequestExport(
  ctx: VaultContext,
  requestId: string,
): Promise<Record<string, unknown>> {
  const { email, workspaceId } = await openRequestAddress(ctx, requestId);
  const data = await buildMemberExport(ctx.db, ctx.keys.field, workspaceId, email, ctx.now());
  const channels = (data.channels ?? []) as ExportChannel[];
  let opened = 0;
  for (const entry of channels) {
    const memberId = entry.member?.id;
    const channelId = entry.member?.channel_id;
    if (typeof memberId !== 'string' || typeof channelId !== 'string' || !entry.fields) continue;
    const result = await openMemberFields(ctx, { workspaceId, channelId }, [memberId]);
    const values: FieldMap = result.values[memberId] ?? {};
    for (const [key, value] of Object.entries(values)) {
      const field = entry.fields[key];
      if (field) field.value = value;
    }
    opened += result.opened;
  }
  await recordBulkOpen(ctx, {
    op: 'buildDsrExport',
    action: 'vault.dsr_open',
    principalKind: 'dsr-request',
    principalId: requestId,
    workspaceId,
    count: opened,
    targetType: 'dsr_request',
  });
  return data;
}
