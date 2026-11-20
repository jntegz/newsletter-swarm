// Profile fields: typed, optionally encrypted, per Channel. A field's key, type and encryption
// are fixed once created; label, choices and position can change.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation } from '@swarm/db';
import {
  CreateMemberFieldSchema,
  MemberFieldSchema,
  UpdateMemberFieldSchema,
  idPattern,
  newId,
} from '@swarm/domain';
import { FIELD_COLUMNS, type FieldRow } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { requireRow, toMemberField } from '../lib/audience';
import { refreshCircles } from '../lib/circles';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const fields = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const fieldParam = idParam('fieldId', idPattern('memberField'));
const MAX_FIELDS = 100;

fields.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/member-fields',
    tags: ['Profile fields'],
    summary: 'Profile fields of a Channel, in display order',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(MemberFieldSchema), 'Profile fields'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<FieldRow>(
      env(c).DB,
      `SELECT ${FIELD_COLUMNS} FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL
        ORDER BY position, created_at`,
      channelId,
    );
    return c.json({ data: rows.map(toMemberField) }, 200);
  },
);

fields.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/member-fields',
    tags: ['Profile fields'],
    summary: 'Add a profile field',
    description:
      'Keys are unique per Channel. Type and encryption can’t change later. Encrypted values (AES-256-GCM) can only be tested for presence in Circle rules.',
    request: { params: channelParam, body: jsonBody(CreateMemberFieldSchema) },
    responses: {
      201: ok(MemberFieldSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const count = await first<{ n: number; top: number | null }>(
      e.DB,
      'SELECT count(*) AS n, max(position) AS top FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL',
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_FIELDS) {
      throw new ApiError('conflict', `A publication can have up to ${MAX_FIELDS} profile fields.`);
    }
    const now = Date.now();
    const id = newId('memberField', now);
    try {
      await e.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, encrypted, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
        .bind(
          id,
          channelId,
          input.key,
          input.label,
          input.type,
          JSON.stringify(input.options ?? []),
          input.encrypted ? 1 : 0,
          input.position ?? (count?.top ?? -1) + 1,
          now,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'A profile field with this key already exists.');
      }
      throw error;
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'member_field.created',
      targetType: 'member_field',
      targetId: id,
      metadata: { channelId, key: input.key, type: input.type, encrypted: !!input.encrypted },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const row = await first<FieldRow>(
      e.DB,
      `SELECT ${FIELD_COLUMNS} FROM member_fields WHERE id = ?1`,
      id,
    );
    return c.json({ data: toMemberField(row as FieldRow) }, 201);
  },
);

/** How many Members hold `option` in a choice field (stored canonical text, or in a JSON list). */
async function optionUses(db: D1Database, field: FieldRow, option: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    field.type === 'multi_select'
      ? `SELECT count(*) AS n FROM member_field_values v
          WHERE v.field_id = ?1 AND EXISTS (SELECT 1 FROM json_each(v.value_text) j WHERE j.value = ?2)`
      : 'SELECT count(*) AS n FROM member_field_values WHERE field_id = ?1 AND value_text = ?2',
    field.id,
    option,
  );
  return row?.n ?? 0;
}

fields.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/member-fields/{fieldId}',
    tags: ['Profile fields'],
    summary: 'Edit a profile field’s label, choices or position',
    description:
      'A choice that Members hold can’t be removed (409 with the count): change their values first. Encrypted fields can’t be checked, so a removed choice stays on the Members who hold it until their value is edited. Sending a different `type` or `encrypted` answers 409.',
    request: { params: fieldParam, body: jsonBody(UpdateMemberFieldSchema) },
    responses: {
      200: ok(MemberFieldSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { fieldId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await requireRow<FieldRow>(
      c,
      'member_fields',
      FIELD_COLUMNS,
      fieldId,
      'editor',
    );
    const e = env(c);
    if (input.type !== undefined && input.type !== row.type) {
      throw new ApiError('conflict', 'A field’s type can’t change. Add a new field instead.');
    }
    if (input.encrypted !== undefined && input.encrypted !== (row.encrypted === 1)) {
      throw new ApiError('conflict', 'Encryption is set when a field is created and can’t change.');
    }
    const choice = row.type === 'select' || row.type === 'multi_select';
    if (input.options !== undefined) {
      if (!choice && input.options.length) {
        throw new ApiError('invalid_input', 'Only choice fields have choices.');
      }
      if (choice && !input.options.length) {
        throw new ApiError('invalid_input', 'Keep at least one choice.');
      }
      if (row.encrypted === 0) {
        const kept = new Set(input.options);
        for (const removed of (JSON.parse(row.options_json) as string[]).filter(
          (o) => !kept.has(o),
        )) {
          const uses = await optionUses(e.DB, row, removed);
          if (uses > 0) {
            throw new ApiError(
              'conflict',
              `${uses.toLocaleString('en-US')} ${uses === 1 ? 'subscriber has' : 'subscribers have'} “${removed}”. Change their value before removing it.`,
            );
          }
        }
      }
    }
    await e.DB.prepare(
      `UPDATE member_fields SET label = ?1, options_json = ?2, position = ?3, updated_at = ?4 WHERE id = ?5`,
    )
      .bind(
        input.label ?? row.label,
        input.options ? JSON.stringify(input.options) : row.options_json,
        input.position ?? row.position,
        Date.now(),
        fieldId,
      )
      .run();
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'member_field.updated',
      targetType: 'member_field',
      targetId: fieldId,
      metadata: { changed: Object.keys(input) },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const updated = await first<FieldRow>(
      e.DB,
      `SELECT ${FIELD_COLUMNS} FROM member_fields WHERE id = ?1`,
      fieldId,
    );
    return c.json({ data: toMemberField(updated as FieldRow) }, 200);
  },
);

fields.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/member-fields/{fieldId}',
    tags: ['Profile fields'],
    summary: 'Remove a profile field',
    description:
      'The field is retired and every Member’s value for it is erased. Its key can be used again.',
    request: { params: fieldParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { fieldId } = c.req.valid('param');
    const { row, access } = await requireRow<FieldRow>(
      c,
      'member_fields',
      FIELD_COLUMNS,
      fieldId,
      'editor',
    );
    const e = env(c);
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare('UPDATE member_fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2').bind(
        now,
        fieldId,
      ),
      e.DB.prepare('DELETE FROM member_field_values WHERE field_id = ?1').bind(fieldId),
    ]);
    refreshCircles(c, row.channel_id);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'member_field.deleted',
      targetType: 'member_field',
      targetId: fieldId,
      metadata: { key: row.key },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);
