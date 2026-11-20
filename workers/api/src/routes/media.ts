import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run } from '@swarm/db';
import { MediaAssetSchema, UpdateMediaSchema, idPattern, newId } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { requireAuth, requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { toMedia, type MediaRow } from '../lib/mappers';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { scanUpload } from '../lib/scan';
import { isFont, sniff } from '../lib/sniff';

const MAX_BYTES = 10 * 1024 * 1024;
const FONT_MAX_BYTES = 2 * 1024 * 1024;
const COLUMNS =
  'id, channel_id, r2_key, content_type, bytes, width, height, alt_text, focal_x, focal_y, created_at';

export const media = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));

media.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/media',
    tags: ['Media'],
    summary: 'Upload an image, a PDF or a font',
    description:
      'The type is identified from the file bytes. JPEG, PNG, GIF, WebP, AVIF and PDF up to 10 MB, and WOFF2 and WOFF fonts up to 2 MB. SVG and HTML are refused. For a font, `alt` is its name.',
    request: {
      params: channelParam,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: z.any().openapi({ type: 'string', format: 'binary' }),
              alt: z.string().max(300).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: ok(MediaAssetSchema, 'Uploaded'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'unsupported_media_type',
      ),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'author');
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new ApiError('invalid_input', 'Attach a file.');
    if (file.size === 0) throw new ApiError('invalid_input', 'The file is empty.');
    if (file.size > MAX_BYTES) throw new ApiError('invalid_input', 'Files can be up to 10 MB.');
    const alt = form.get('alt');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes);
    if (!kind) {
      throw new ApiError(
        'unsupported_media_type',
        'Upload a JPEG, PNG, GIF, WebP, AVIF or PDF file, or a WOFF2 or WOFF font.',
      );
    }
    if (isFont(kind.contentType) && bytes.byteLength > FONT_MAX_BYTES) {
      throw new ApiError('invalid_input', 'Fonts can be up to 2 MB.');
    }

    const verdict = await scanUpload(bytes, kind.contentType);
    if (!verdict.clean) throw new ApiError('invalid_input', 'This file can’t be uploaded.');

    const e = env(c);
    const id = newId('media');
    const key = `ws/${access.workspaceId}/ch/${channelId}/${id}.${kind.extension}`;
    await e.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: kind.contentType },
      customMetadata: { visibility: 'public', workspace: access.workspaceId },
    });
    const now = Date.now();
    await run(
      e.DB,
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, width, height, alt_text, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      id,
      access.workspaceId,
      channelId,
      key,
      kind.contentType,
      bytes.byteLength,
      kind.width,
      kind.height,
      typeof alt === 'string' && alt.trim() ? alt.trim().slice(0, 300) : null,
      access.auth.operatorId,
      now,
    );
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'media.uploaded',
      targetType: 'media',
      targetId: id,
      metadata: { contentType: kind.contentType, bytes: bytes.byteLength },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const row = await first<MediaRow>(e.DB, `SELECT ${COLUMNS} FROM media WHERE id = ?1`, id);
    return c.json({ data: toMedia(row as MediaRow, e.MEDIA_ORIGIN) }, 201);
  },
);

media.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/media',
    tags: ['Media'],
    summary: 'Media in a Channel, newest first',
    request: {
      params: channelParam,
      query: z.object({
        q: z.string().trim().max(100).optional().openapi({ description: 'Search alt text' }),
        kind: z
          .enum(['image', 'font', 'file'])
          .optional()
          .openapi({ description: 'image, font, or file (anything else: PDFs)' }),
      }),
    },
    responses: {
      200: ok(z.array(MediaAssetSchema), 'Media'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { q, kind } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const pattern = q ? `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%` : null;
    const rows = await all<MediaRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM media WHERE channel_id = ?1 AND deleted_at IS NULL
         AND (?2 IS NULL OR alt_text LIKE ?2 ESCAPE '!')
         AND (?3 IS NULL
           OR (?3 = 'image' AND content_type LIKE 'image/%')
           OR (?3 = 'font' AND content_type LIKE 'font/%')
           OR (?3 = 'file' AND content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'font/%'))
       ORDER BY created_at DESC LIMIT 200`,
      channelId,
      pattern,
      kind ?? null,
    );
    return c.json({ data: rows.map((row) => toMedia(row, e.MEDIA_ORIGIN)) }, 200);
  },
);

media.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/media/{mediaId}',
    tags: ['Media'],
    summary: 'Edit alt text or the focal point',
    request: { params: idParam('mediaId', idPattern('media')), body: jsonBody(UpdateMediaSchema) },
    responses: {
      200: ok(MediaAssetSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { mediaId } = c.req.valid('param');
    const input = c.req.valid('json');
    requireAuth(c);
    const e = env(c);
    const row = await first<MediaRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM media WHERE id = ?1 AND deleted_at IS NULL`,
      mediaId,
    );
    if (!row?.channel_id) throw new ApiError('not_found', 'Media not found.');
    await requireChannel(c, row.channel_id, 'author');
    const alt = input.altText === undefined ? row.alt_text : input.altText || null;
    const focal =
      input.focalPoint === undefined
        ? { x: row.focal_x, y: row.focal_y }
        : { x: input.focalPoint?.x ?? null, y: input.focalPoint?.y ?? null };
    await run(
      e.DB,
      'UPDATE media SET alt_text = ?1, focal_x = ?2, focal_y = ?3 WHERE id = ?4',
      alt,
      focal.x,
      focal.y,
      mediaId,
    );
    const updated = await first<MediaRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM media WHERE id = ?1`,
      mediaId,
    );
    return c.json({ data: toMedia(updated as MediaRow, e.MEDIA_ORIGIN) }, 200);
  },
);

media.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/media/{mediaId}',
    tags: ['Media'],
    summary: 'Delete a media file',
    request: { params: idParam('mediaId', idPattern('media')) },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { mediaId } = c.req.valid('param');
    requireAuth(c);
    const e = env(c);
    const row = await first<{ channel_id: string | null; r2_key: string }>(
      e.DB,
      'SELECT channel_id, r2_key FROM media WHERE id = ?1 AND deleted_at IS NULL',
      mediaId,
    );
    if (!row?.channel_id) throw new ApiError('not_found', 'Media not found.');
    const access = await requireChannel(c, row.channel_id, 'editor');
    const sold = await first(e.DB, 'SELECT 1 FROM good_files WHERE media_id = ?1', mediaId);
    if (sold) {
      throw new ApiError('conflict', 'A product uses this file. Remove it from the product first.');
    }
    await run(e.DB, 'UPDATE media SET deleted_at = ?1 WHERE id = ?2', Date.now(), mediaId);
    await e.MEDIA.delete(row.r2_key);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'media.deleted',
      targetType: 'media',
      targetId: mediaId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);
