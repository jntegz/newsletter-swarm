/**
 * Encrypted profile fields (member_field_values.value_enc): opened and sealed only here. The vault
 * reads the ciphertext and the field definitions from D1 itself, checks that every Member is in
 * the Channel the principal reaches, and binds each value to its workspace, Channel, Member and
 * field, so a value copied into another row does not open.
 */
import { all, first } from '@swarm/db';
import type { FieldType } from '@swarm/domain';
import { FieldValueError, normalizeFieldValue, type FieldDef } from '@swarm/engine';
import type { FieldMap, Sealed } from '../api';
import { invalid, notFound, plainRecord, VaultRefusal, type VaultContext } from './context';
import { openValue, sealValue } from './sealing';

/** Members per open: one export chunk. */
const MAX_MEMBERS_PER_CALL = 1000;
/** D1 allows 100 bound parameters; ids go in batches below that. */
const ID_BATCH = 90;

const MEMBER_ID = /^mb_[0-9a-f]{32}$/;

interface FieldRow {
  id: string;
  key: string;
  type: FieldType;
  options_json: string;
}

interface ChannelReach {
  workspaceId: string;
  channelId: string;
}

/** The Channel's live encrypted fields, optionally only these keys. */
async function encryptedFields(
  ctx: VaultContext,
  channelId: string,
  keys?: readonly string[],
): Promise<(FieldDef & { id: string })[]> {
  const rows = await all<FieldRow>(
    ctx.db,
    `SELECT id, key, type, options_json FROM member_fields
      WHERE channel_id = ?1 AND encrypted = 1 AND deleted_at IS NULL ORDER BY position, key`,
    channelId,
  );
  return rows
    .filter((row) => !keys || keys.includes(row.key))
    .map((row) => ({
      id: row.id,
      key: row.key,
      type: row.type,
      options: JSON.parse(row.options_json) as string[],
      encrypted: true,
    }));
}

function memberIdList(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_MEMBERS_PER_CALL) return invalid('member ids');
  const unique = [...new Set(ids as unknown[])];
  for (const id of unique) if (typeof id !== 'string' || !MEMBER_ID.test(id)) invalid('member id');
  return unique as string[];
}

const batches = <T>(list: readonly T[]) => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += ID_BATCH) out.push(list.slice(i, i + ID_BATCH));
  return out;
};

/**
 * Opens the encrypted fields of Members of `reach.channelId`. Every Member must be in that Channel
 * (otherwise nothing is opened: not_found). Every encrypted field is in each result, null when it
 * has no value or the value does not open. Returns the values and how many were opened.
 */
export async function openMemberFields(
  ctx: VaultContext,
  reach: ChannelReach,
  memberIds: unknown,
  fieldKeys?: unknown,
): Promise<{ values: Record<string, FieldMap>; opened: number }> {
  const ids = memberIdList(memberIds);
  if (
    fieldKeys !== undefined &&
    (!Array.isArray(fieldKeys) || fieldKeys.some((k) => typeof k !== 'string'))
  ) {
    invalid('field keys');
  }
  const fields = await encryptedFields(ctx, reach.channelId, fieldKeys as string[] | undefined);
  const values: Record<string, FieldMap> = Object.create(null) as Record<string, FieldMap>;
  for (const group of batches(ids)) {
    const found = await all<{ id: string }>(
      ctx.db,
      `SELECT id FROM members WHERE channel_id = ?1 AND id IN (${group.map((_, i) => `?${i + 2}`).join(', ')})`,
      reach.channelId,
      ...group,
    );
    if (found.length !== group.length) notFound('member');
  }
  for (const id of ids) {
    values[id] = Object.fromEntries(fields.map((field) => [field.key, null]));
  }
  if (!fields.length || !ids.length) return { values: plainRecord(values), opened: 0 };
  const byId = new Map(fields.map((field) => [field.id, field]));
  let opened = 0;
  for (const group of batches(ids)) {
    const rows = await all<{ member_id: string; field_id: string; value_enc: string }>(
      ctx.db,
      `SELECT member_id, field_id, value_enc FROM member_field_values
        WHERE value_enc IS NOT NULL AND member_id IN (${group.map((_, i) => `?${i + 1}`).join(', ')})`,
      ...group,
    );
    await Promise.all(
      rows.map(async (row) => {
        const field = byId.get(row.field_id);
        const target = values[row.member_id];
        if (!field || !target) return;
        const plain = await openValue(
          ctx,
          'member-field',
          { w: reach.workspaceId, c: reach.channelId, m: row.member_id, f: field.id },
          row.value_enc,
        );
        if (plain === null) return;
        try {
          target[field.key] = JSON.parse(plain) as FieldMap[string];
          opened++;
        } catch {
          // A value that opens but is not JSON stays null, like one that does not open.
        }
      }),
    );
  }
  return { values: plainRecord(values), opened };
}

/**
 * Seals encrypted field values for one Member of the Channel: the Member is in it, or does not
 * exist yet (the id the caller will insert). Each key must be a live encrypted field of the
 * Channel; values are normalised as the field's type says. A cleared value (null) is left out:
 * the caller deletes its row.
 *
 * With `keepUnchanged` (principals that may also read the Member's fields), a value equal to the
 * one stored comes back as the stored ciphertext itself, so the caller's write changes nothing
 * and emits no field_changed (engine events.ts): the comparison is made here, on plaintext, never
 * by the caller on ciphertexts. Anonymous sign-ups don't get it, so it can't serve as an oracle.
 */
export async function sealMemberFields(
  ctx: VaultContext,
  reach: ChannelReach,
  memberId: unknown,
  values: unknown,
  options: { mustExist?: boolean; keepUnchanged?: boolean } = {},
): Promise<Record<string, Sealed>> {
  if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) return invalid('member id');
  if (typeof values !== 'object' || values === null || Array.isArray(values)) invalid('values');
  const member = await first<{ channel_id: string }>(
    ctx.db,
    'SELECT channel_id FROM members WHERE id = ?1',
    memberId,
  );
  if (member ? member.channel_id !== reach.channelId : options.mustExist) notFound('member');
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > 100) invalid('too many fields');
  const fields = await encryptedFields(ctx, reach.channelId);
  const current = new Map<string, string>();
  if (options.keepUnchanged && member) {
    const rows = await all<{ field_id: string; value_enc: string }>(
      ctx.db,
      'SELECT field_id, value_enc FROM member_field_values WHERE member_id = ?1 AND value_enc IS NOT NULL',
      memberId,
    );
    for (const row of rows) current.set(row.field_id, row.value_enc);
  }
  const sealed: Record<string, Sealed> = Object.create(null) as Record<string, Sealed>;
  for (const [key, raw] of entries) {
    const field = fields.find((f) => f.key === key);
    if (!field) return notFound(`field ${key}`);
    let value: FieldMap[string];
    try {
      value = normalizeFieldValue(field, raw);
    } catch (error) {
      if (error instanceof FieldValueError) throw new VaultRefusal('invalid', `field ${key}`);
      throw error;
    }
    if (value === null) continue;
    const parts = { w: reach.workspaceId, c: reach.channelId, m: memberId, f: field.id };
    const plain = JSON.stringify(value);
    const stored = current.get(field.id);
    if (stored && (await openValue(ctx, 'member-field', parts, stored)) === plain) {
      sealed[key] = stored;
      continue;
    }
    sealed[key] = await sealValue(ctx, 'member-field', parts, plain);
  }
  return plainRecord(sealed);
}
