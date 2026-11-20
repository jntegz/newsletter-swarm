// Bulk actions over Members (a picked set of up to 1,000, or a whole Circle), run as jobs with
// progress. The jobs worker applies them in chunks; see workers/jobs/src/handlers/bulk.ts.
import { createRoute } from '@hono/zod-openapi';
import { first } from '@swarm/db';
import { BulkJobSchema, CreateBulkJobSchema, idPattern, newId, type BulkJob } from '@swarm/domain';
import { channelFields, normalizeFieldValue } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import {
  BULK_COLUMNS,
  fieldInputError,
  requireRow,
  toBulkJob,
  type BulkJobRow,
} from '../lib/audience';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';

export const bulk = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));

bulk.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/bulk-jobs',
    tags: ['Members'],
    summary: 'Start a bulk action',
    description:
      'Tag, untag, set a profile field, unsubscribe or delete a selection: up to 1,000 Member ids, or every Member of a Circle. Unsubscribe only moves Members an operator may move (pending, active, paused); the rest are counted but left alone.',
    request: { params: channelParam, body: jsonBody(CreateBulkJobSchema) },
    responses: {
      202: ok(BulkJobSchema, 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);

    const params: BulkJob['params'] = {};
    if (input.action === 'tag' || input.action === 'untag') params.tag = input.tag as string;
    if (input.action === 'set_field') {
      const key = input.field as string;
      const field = (await channelFields(e.DB, channelId)).get(key);
      if (!field) {
        throw new ApiError('invalid_input', 'There is no profile field with this key.', [
          { path: 'field', message: 'There is no profile field with this key.' },
        ]);
      }
      try {
        params.value = normalizeFieldValue(field, input.value);
      } catch (error) {
        fieldInputError(error, 'value');
      }
      params.field = key;
    }

    let total: number;
    if ('circleId' in input.selection) {
      const circle = await first<{ id: string }>(
        e.DB,
        'SELECT id FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
        input.selection.circleId,
        channelId,
      );
      if (!circle) throw new ApiError('not_found', 'Segment not found.');
      total =
        (
          await first<{ n: number }>(
            e.DB,
            'SELECT count(*) AS n FROM circle_members WHERE circle_id = ?1',
            circle.id,
          )
        )?.n ?? 0;
    } else {
      const ids = [...new Set(input.selection.memberIds)];
      input.selection = { memberIds: ids };
      total =
        (
          await first<{ n: number }>(
            e.DB,
            'SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))',
            channelId,
            JSON.stringify(ids),
          )
        )?.n ?? 0;
    }

    const now = Date.now();
    const id = newId('bulkJob', now);
    await e.DB.prepare(
      `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, params_json, selection_json, total, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        id,
        access.workspaceId,
        channelId,
        input.action,
        JSON.stringify(params),
        JSON.stringify(input.selection),
        total,
        access.auth.operatorId,
        now,
      )
      .run();
    await e.JOBS_QUEUE.send({ type: 'bulk', jobId: id });
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'members.bulk_started',
      targetType: 'bulk_job',
      targetId: id,
      metadata: {
        channelId,
        action: input.action,
        total,
        ...('circleId' in input.selection ? { circleId: input.selection.circleId } : {}),
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const row = await first<BulkJobRow>(
      e.DB,
      `SELECT channel_id, ${BULK_COLUMNS} FROM bulk_jobs WHERE id = ?1`,
      id,
    );
    return c.json({ data: toBulkJob(row as BulkJobRow) }, 202);
  },
);

bulk.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/bulk-jobs/{jobId}',
    tags: ['Members'],
    summary: 'Progress of a bulk action',
    request: { params: idParam('jobId', idPattern('bulkJob')) },
    responses: { 200: ok(BulkJobSchema, 'Bulk action'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { jobId } = c.req.valid('param');
    const { row } = await requireRow<BulkJobRow>(c, 'bulk_jobs', BULK_COLUMNS, jobId, 'viewer');
    return c.json({ data: toBulkJob(row) }, 200);
  },
);
