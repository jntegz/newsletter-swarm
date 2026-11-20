// Exports: CSV or JSONL jobs over a Channel's Members, written to the private EXPORTS bucket and
// downloaded through a signed link that also needs a signed-in admin. Audited on create and on
// every download.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  CreateExportSchema,
  EXPORT_LINK_HOURS,
  ExportJobSchema,
  idPattern,
  newId,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { signToken, verifyToken } from '@swarm/tokens';
import { requireChannel } from '../lib/access';
import { EXPORT_COLUMNS, requireRow, toExportJob, type ExportJobRow } from '../lib/audience';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { ROSTERS_OFF, requireRoster } from '../lib/rosters';
import { flagEnabled } from '../lib/site';

export const exports = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const exportParam = idParam('exportId', idPattern('exportJob'));
const PURPOSE = 'export';

const available = (row: ExportJobRow, now: number) =>
  row.status === 'done' && row.r2_key !== null && (row.expires_at ?? 0) > now;

/** A fresh 24-hour link for a finished export, or null while it isn't downloadable. */
async function downloadUrl(c: AppContext, row: ExportJobRow): Promise<string | null> {
  const now = Date.now();
  if (!available(row, now)) return null;
  const ttl = Math.min(
    EXPORT_LINK_HOURS * 3600,
    Math.floor(((row.expires_at ?? now) - now) / 1000),
  );
  const token = await signToken(
    env(c).AUTH_KEYS,
    PURPOSE,
    { exportId: row.id },
    {
      expiresInSeconds: Math.max(1, ttl),
    },
  );
  return `/api/v1/exports/${row.id}/download?token=${encodeURIComponent(token)}`;
}

exports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/exports',
    tags: ['Members'],
    summary: 'Export Members',
    description:
      'Queues a CSV or JSONL export of the Channel’s Members, optionally only one status, one Circle or one Roster (rosters flag; the file then also lists each Member’s Rosters). Profile fields are included, decrypted. Admins and owners only.',
    request: { params: channelParam, body: jsonBody(CreateExportSchema) },
    responses: {
      202: ok(ExportJobSchema, 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    if (input.circleId) {
      const circle = await first<{ id: string }>(
        e.DB,
        'SELECT id FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
        input.circleId,
        channelId,
      );
      if (!circle) throw new ApiError('not_found', 'Segment not found.');
    }
    // Rosters (Phase 8): with the flag on, the file has a rosters column and can be one Roster.
    const withRosters = await flagEnabled(c, access, 'rosters');
    if (input.rosterId) {
      if (!withRosters) throw new ApiError('feature_disabled', ROSTERS_OFF);
      await requireRoster(e.DB, channelId, input.rosterId);
    }
    const now = Date.now();
    const id = newId('exportJob', now);
    const filter = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.circleId ? { circleId: input.circleId } : {}),
      ...(input.rosterId ? { rosterId: input.rosterId } : {}),
    };
    await e.DB.prepare(
      `INSERT INTO export_jobs (id, workspace_id, channel_id, format, filter_json, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        id,
        access.workspaceId,
        channelId,
        input.format,
        JSON.stringify(withRosters ? { ...filter, rosters: true } : filter),
        access.auth.operatorId,
        now,
      )
      .run();
    await e.JOBS_QUEUE.send({ type: 'export', jobId: id });
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'members.export_created',
      targetType: 'export_job',
      targetId: id,
      metadata: { channelId, format: input.format, ...filter },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const row = await first<ExportJobRow>(
      e.DB,
      `SELECT channel_id, ${EXPORT_COLUMNS} FROM export_jobs WHERE id = ?1`,
      id,
    );
    return c.json({ data: toExportJob(row as ExportJobRow, null) }, 202);
  },
);

exports.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/exports',
    tags: ['Members'],
    summary: 'Recent exports of a Channel',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(ExportJobSchema), 'Exports'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'admin');
    const rows = await all<ExportJobRow>(
      env(c).DB,
      `SELECT channel_id, ${EXPORT_COLUMNS} FROM export_jobs WHERE channel_id = ?1
        ORDER BY created_at DESC LIMIT 50`,
      channelId,
    );
    const data = await Promise.all(
      rows.map(async (row) => toExportJob(row, await downloadUrl(c, row))),
    );
    return c.json({ data }, 200);
  },
);

exports.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/exports/{exportId}',
    tags: ['Members'],
    summary: 'An export’s progress, with a download link once it is ready',
    request: { params: exportParam },
    responses: {
      200: ok(ExportJobSchema, 'Export'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { exportId } = c.req.valid('param');
    const { row } = await requireRow<ExportJobRow>(
      c,
      'export_jobs',
      EXPORT_COLUMNS,
      exportId,
      'admin',
    );
    return c.json({ data: toExportJob(row, await downloadUrl(c, row)) }, 200);
  },
);

exports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/exports/{exportId}/cancel',
    tags: ['Members'],
    summary: 'Cancel an export that has not finished',
    description:
      'Admins on the Channel. The job stops as failed with the reason, and the parts written so far are deleted. A finished export is not affected (it is deleted when it expires). The jobs worker also stops an export itself when whoever asked for it no longer has the admin role, or the Channel is deleted.',
    request: { params: exportParam },
    responses: {
      200: ok(ExportJobSchema, 'Canceled'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { exportId } = c.req.valid('param');
    const { row, access } = await requireRow<ExportJobRow & { workspace_id: string }>(
      c,
      'export_jobs',
      `${EXPORT_COLUMNS}, workspace_id`,
      exportId,
      'admin',
    );
    const e = env(c);
    const canceled = await first(
      e.DB,
      `UPDATE export_jobs SET status = 'failed', error = ?1, completed_at = ?2
        WHERE id = ?3 AND status IN ('queued', 'running') RETURNING id`,
      `Canceled by ${access.auth.email}.`,
      Date.now(),
      exportId,
    );
    if (!canceled) throw new ApiError('conflict', 'This export has already finished.');
    // The worker also cleans up a chunk it was writing when the cancel landed.
    const prefix = `ws/${row.workspace_id}/ch/${row.channel_id}/${exportId}/`;
    let cursor: string | undefined;
    do {
      const listed = await e.EXPORTS.list({ prefix, ...(cursor ? { cursor } : {}) });
      if (listed.objects.length) await e.EXPORTS.delete(listed.objects.map((o) => o.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export.canceled',
      targetType: 'export',
      targetId: exportId,
      metadata: { channelId: row.channel_id },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const updated = await requireRow<ExportJobRow>(
      c,
      'export_jobs',
      EXPORT_COLUMNS,
      exportId,
      'admin',
    );
    return c.json({ data: toExportJob(updated.row, null) }, 200);
  },
);

exports.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/exports/{exportId}/download',
    tags: ['Members'],
    summary: 'Download an export',
    description:
      'Needs the signed `token` from the export’s `downloadUrl` (valid 24 hours) and a signed-in admin of the Channel. Every download is audited.',
    request: {
      params: exportParam,
      query: z.object({ token: z.string().min(1).max(2048) }),
    },
    responses: {
      200: {
        description: 'The file',
        content: {
          'text/csv': { schema: z.string() },
          'application/x-ndjson': { schema: z.string() },
        },
      },
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { exportId } = c.req.valid('param');
    const { token } = c.req.valid('query');
    const { row, access } = await requireRow<ExportJobRow>(
      c,
      'export_jobs',
      EXPORT_COLUMNS,
      exportId,
      'admin',
    );
    const e = env(c);
    const verified = await verifyToken<{ exportId?: string }>(e.AUTH_KEYS, PURPOSE, token);
    if (!verified.ok || verified.payload.exportId !== exportId) {
      throw new ApiError('forbidden', 'This download link is not valid or has expired.');
    }
    if (!available(row, Date.now())) {
      throw new ApiError('not_found', 'This export is no longer available.');
    }

    // The file is stored as numbered parts (one per chunk the job wrote); stream them in order.
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const listed = await e.EXPORTS.list({
        prefix: row.r2_key as string,
        ...(cursor ? { cursor } : {}),
      });
      keys.push(...listed.objects.map((o) => o.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    keys.sort();
    if (!keys.length) throw new ApiError('not_found', 'This export is no longer available.');

    let index = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (!reader) {
            const key = keys[index++];
            if (key === undefined) return controller.close();
            const object = await e.EXPORTS.get(key);
            if (!object) continue;
            reader = object.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            continue;
          }
          return controller.enqueue(value);
        }
      },
    });

    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'members.export_downloaded',
      targetType: 'export_job',
      targetId: exportId,
      metadata: { rows: row.row_count, format: row.format },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': row.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
        'content-disposition': `attachment; filename="members-${day}.${row.format}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
