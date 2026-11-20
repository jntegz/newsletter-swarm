// Tags: list with Member counts, create, rename, delete. Bulk tagging runs through bulk jobs.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation } from '@swarm/db';
import { CreateTagSchema, TagSchema, UpdateTagSchema, idPattern, newId } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { TAG_COLUMNS, requireRow, toTag, type TagRow } from '../lib/audience';
import { appendAudit } from '../lib/audit';
import { refreshCircles } from '../lib/circles';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const tags = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const tagParam = idParam('tagId', idPattern('tag'));
const duplicate = () => new ApiError('conflict', 'A tag with this name already exists.');

async function readTag(db: D1Database, id: string): Promise<TagRow> {
  const row = await first<TagRow>(
    db,
    `SELECT channel_id, ${TAG_COLUMNS} FROM tags WHERE id = ?1`,
    id,
  );
  return row as TagRow;
}

tags.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/tags',
    tags: ['Tags'],
    summary: 'Tags of a Channel, by name, with Member counts',
    request: { params: channelParam },
    responses: { 200: ok(z.array(TagSchema), 'Tags'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<TagRow>(
      env(c).DB,
      `SELECT channel_id, ${TAG_COLUMNS} FROM tags WHERE channel_id = ?1 ORDER BY name LIMIT 2000`,
      channelId,
    );
    return c.json({ data: rows.map(toTag) }, 200);
  },
);

tags.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/tags',
    tags: ['Tags'],
    summary: 'Create a tag',
    request: { params: channelParam, body: jsonBody(CreateTagSchema) },
    responses: {
      201: ok(TagSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { name } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const id = newId('tag');
    try {
      await e.DB.prepare(
        'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)',
      )
        .bind(id, channelId, name, Date.now())
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'tag.created',
      targetType: 'tag',
      targetId: id,
      metadata: { channelId, name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toTag(await readTag(e.DB, id)) }, 201);
  },
);

tags.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/tags/{tagId}',
    tags: ['Tags'],
    summary: 'Rename a tag',
    request: { params: tagParam, body: jsonBody(UpdateTagSchema) },
    responses: {
      200: ok(TagSchema, 'Renamed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { tagId } = c.req.valid('param');
    const { name } = c.req.valid('json');
    const { row, access } = await requireRow<TagRow>(c, 'tags', 'name', tagId, 'editor');
    const e = env(c);
    try {
      await e.DB.prepare('UPDATE tags SET name = ?1 WHERE id = ?2').bind(name, tagId).run();
      refreshCircles(c, row.channel_id);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'tag.renamed',
      targetType: 'tag',
      targetId: tagId,
      metadata: { from: row.name, to: name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toTag(await readTag(e.DB, tagId)) }, 200);
  },
);

tags.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/tags/{tagId}',
    tags: ['Tags'],
    summary: 'Delete a tag',
    description: 'The tag is removed from every Member who has it.',
    request: { params: tagParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { tagId } = c.req.valid('param');
    const { row, access } = await requireRow<TagRow>(c, 'tags', 'name', tagId, 'editor');
    const e = env(c);
    await e.DB.prepare('DELETE FROM tags WHERE id = ?1').bind(tagId).run();
    refreshCircles(c, row.channel_id);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'tag.deleted',
      targetType: 'tag',
      targetId: tagId,
      metadata: { name: row.name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);
