/**
 * Member writes shared by the API (add, edit) and the jobs worker (imports, bulk actions):
 * profile fields by key, tags by name, field values in and out of storage, and the warm-import
 * hand-off to the Reputation Ramp.
 */
import type { FieldType, FieldValue } from '@swarm/domain';
import { all, newIdFor, run } from './db';
import {
  fieldChangedEventStatement,
  tagAddedEventStatement,
  tagRemovedEventStatement,
} from './events';
import {
  FieldValueError,
  normalizeFieldValue,
  plainFromStored,
  storedValue,
  type FieldDef,
  type StoredValue,
} from './fields';
import { utcDay } from './ramp';
import type { FieldValues, FieldVault } from './vault-ports';

export interface FieldRow {
  id: string;
  channel_id: string;
  key: string;
  label: string;
  type: FieldType;
  options_json: string;
  encrypted: number;
  position: number;
  created_at: number;
}

export interface ChannelField extends FieldDef {
  id: string;
  label: string;
}

export const FIELD_COLUMNS =
  'id, channel_id, key, label, type, options_json, encrypted, position, created_at';

export const toFieldDef = (row: FieldRow): ChannelField => ({
  id: row.id,
  key: row.key,
  label: row.label,
  type: row.type,
  options: JSON.parse(row.options_json) as string[],
  encrypted: row.encrypted === 1,
});

/** The Channel's live profile fields, by key. */
export async function channelFields(
  db: D1Database,
  channelId: string,
): Promise<Map<string, ChannelField>> {
  const rows = await all<FieldRow>(
    db,
    `SELECT ${FIELD_COLUMNS} FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL
      ORDER BY position, created_at`,
    channelId,
  );
  return new Map(rows.map((row) => [row.key, toFieldDef(row)]));
}

export interface PreparedValue {
  field: ChannelField;
  value: FieldValue;
  /** Null clears the value. */
  stored: StoredValue | null;
}

/**
 * Validates `input` (by field key) against the Channel's fields. Throws FieldValueError naming
 * the first bad key; unknown keys are refused too. Encrypted values are sealed for `memberId` by
 * the vault, in one call; when it can't, this throws and nothing is written.
 */
export async function prepareFieldValues(
  fields: Map<string, ChannelField>,
  input: Record<string, unknown>,
  vault: Pick<FieldVault, 'seal'>,
  memberId: string,
): Promise<PreparedValue[]> {
  const normalised: { field: ChannelField; value: FieldValue }[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const field = fields.get(key);
    if (!field) throw new FieldValueError(key, 'There is no profile field with this key.');
    normalised.push({ field, value: normalizeFieldValue(field, raw) });
  }
  const sealed = await sealEncrypted(vault, memberId, normalised);
  return normalised.map(({ field, value }) => ({
    field,
    value,
    stored: storedValue(field, value, sealed[field.key]),
  }));
}

/** Seals the encrypted ones among `values` for one Member (nothing to seal: no vault call). */
export async function sealEncrypted(
  vault: Pick<FieldVault, 'seal'>,
  memberId: string,
  values: { field: FieldDef; value: FieldValue }[],
): Promise<Record<string, string>> {
  const toSeal: FieldValues = {};
  for (const { field, value } of values) {
    if (field.encrypted && value !== null) toSeal[field.key] = value;
  }
  if (!Object.keys(toSeal).length) return {};
  return vault.seal(memberId, toSeal);
}

/** Statements that write prepared values for one Member. */
export function fieldValueStatements(
  db: D1Database,
  memberId: string,
  values: PreparedValue[],
  now: number,
): D1PreparedStatement[] {
  return values.flatMap(({ field, stored }) => [
    // Before the write: emits field_changed only when the value really changes.
    fieldChangedEventStatement(db, memberId, field.id, stored, now),
    stored === null
      ? db
          .prepare('DELETE FROM member_field_values WHERE member_id = ?1 AND field_id = ?2')
          .bind(memberId, field.id)
      : db
          .prepare(
            `INSERT INTO member_field_values (member_id, field_id, value_text, value_num, value_enc, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (member_id, field_id) DO UPDATE SET value_text = excluded.value_text,
               value_num = excluded.value_num, value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
          )
          .bind(memberId, field.id, stored.value_text, stored.value_num, stored.value_enc, now),
  ]);
}

interface ValueRow {
  member_id: string;
  field_id: string;
  value_text: string | null;
  value_num: number | null;
  value_enc: string | null;
}

/**
 * Field values for several Members, by Member id then field key. Encrypted ones are opened by the
 * vault in one call; when it answers null (down), they read as null, never as anything else.
 */
export async function readFieldValues(
  db: D1Database,
  memberIds: string[],
  fields: Map<string, ChannelField>,
  vault: Pick<FieldVault, 'open'> | null,
): Promise<Map<string, Record<string, FieldValue>>> {
  const byId = new Map([...fields.values()].map((f) => [f.id, f]));
  // No prototype: a field keyed "constructor" that a Member has no value for reads as missing.
  const out = new Map<string, Record<string, FieldValue>>(
    memberIds.map((id) => [id, Object.create(null) as Record<string, FieldValue>]),
  );
  if (!memberIds.length || !fields.size) return out;
  const rows = await all<ValueRow>(
    db,
    `SELECT member_id, field_id, value_text, value_num, value_enc FROM member_field_values
      WHERE member_id IN (SELECT value FROM json_each(?1))`,
    JSON.stringify(memberIds),
  );
  const sealedFor = new Set<string>();
  for (const row of rows) {
    const field = byId.get(row.field_id);
    const target = out.get(row.member_id);
    if (!field || !target) continue;
    target[field.key] = plainFromStored(field, row);
    if (row.value_enc !== null && field.encrypted) sealedFor.add(row.member_id);
  }
  const encrypted = [...fields.values()].filter((f) => f.encrypted).map((f) => f.key);
  if (!sealedFor.size || !encrypted.length || !vault) return out;
  const opened = await vault.open([...sealedFor], encrypted);
  if (!opened) return out;
  for (const [memberId, values] of Object.entries(opened)) {
    const target = out.get(memberId);
    if (!target) continue;
    for (const key of encrypted) {
      const value = values[key];
      if (value !== undefined && value !== null) target[key] = value;
    }
  }
  return out;
}

/** Tag ids by lower-cased name, creating any that don't exist yet. */
export async function ensureTags(
  db: D1Database,
  channelId: string,
  names: string[],
  now: number,
): Promise<Map<string, string>> {
  const unique = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()];
  if (!unique.length) return new Map();
  await db.batch(
    unique.map((name) =>
      db
        .prepare(
          `INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (channel_id, name) DO NOTHING`,
        )
        .bind(newIdFor('tag', now), channelId, name, now),
    ),
  );
  const rows = await all<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM tags WHERE channel_id = ?1 AND name IN (SELECT value FROM json_each(?2))',
    channelId,
    JSON.stringify(unique),
  );
  return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

/** Adds tags to a Member; with `replace`, removes every other tag first. */
export function tagStatements(
  db: D1Database,
  memberId: string,
  tagIds: string[],
  now: number,
  replace = false,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (replace) {
    statements.push(
      tagRemovedEventStatement(db, memberId, tagIds, 'except', now),
      db
        .prepare(
          'DELETE FROM member_tags WHERE member_id = ?1 AND tag_id NOT IN (SELECT value FROM json_each(?2))',
        )
        .bind(memberId, JSON.stringify(tagIds)),
    );
  }
  for (const tagId of tagIds) {
    statements.push(
      tagAddedEventStatement(db, memberId, tagId, now),
      db
        .prepare(
          'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING',
        )
        .bind(memberId, tagId, now),
    );
  }
  return statements;
}

/** The tag every Member created or updated by an import carries. */
export const importTag = (importId: string) => `import:${importId}`;

/**
 * Warm import: a list of WARM_IMPORT_THRESHOLD or more new Members must not hit mailbox
 * providers all at once from a sender whose ramp already finished. Every completed Reputation
 * Ramp of the Channel goes back to warming, with today's cap at the number of Members who were
 * already active (so the existing audience keeps getting every Broadcast) and a target of the
 * whole list. The ramp then grows by its usual factor on healthy days and completes once the cap
 * covers everyone; bounce and complaint thresholds pause it as usual. Ramps still warming or
 * paused already limit volume and are left alone; a Channel with no ramp yet gets a fresh one at
 * its first send.
 *
 * Broadcasts over the cap wait for the next day, exactly as they do on any warming ramp.
 */
export async function startWarmImport(
  db: D1Database,
  channelId: string,
  newMembers: number,
  now = Date.now(),
): Promise<string[]> {
  const active = await all<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND status = 'active'",
    channelId,
  );
  const existing = active[0]?.n ?? 0;
  const rows = await all<{ id: string }>(
    db,
    `UPDATE reputation_ramps
        SET status = 'warming', day = ?1, cap_today = max(start_cap, ?2),
            sent_today = CASE WHEN day = ?1 THEN sent_today ELSE 0 END,
            max_cap = max(start_cap + 1, ?3), paused_reason = NULL, updated_at = ?4,
            skipped_at = NULL, started_day = ?1
      WHERE channel_id = ?5 AND status = 'complete'
      RETURNING id`,
    utcDay(now),
    existing,
    existing + newMembers,
    now,
    channelId,
  );
  return rows.map((r) => r.id);
}

/** Moves paused Members whose pause has ended back to active (a system transition). */
export async function resumePausedMembers(db: D1Database, now: number, limit = 1000) {
  const result = await run(
    db,
    `UPDATE members SET status = 'active', paused_until = NULL, updated_at = ?1
      WHERE id IN (SELECT id FROM members WHERE status = 'paused' AND paused_until IS NOT NULL
                     AND paused_until <= ?1 LIMIT ?2)`,
    now,
    limit,
  );
  return result.meta.changes ?? 0;
}
