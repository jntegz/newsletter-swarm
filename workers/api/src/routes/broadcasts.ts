// Broadcasts: the sends of a Dispatch, their progress, statistics and cancellation.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  BroadcastClickMapSchema,
  BroadcastReportSchema,
  BroadcastSchema,
  BroadcastStatsSchema,
  idPattern,
  type BroadcastReport,
} from '@swarm/domain';
import {
  broadcastClickMap,
  broadcastStats,
  cancelBroadcast,
  cohortSampleView,
  publishProgress,
  resumeSend,
  splitTestView,
  toSendWait,
  type BroadcastRow,
  type CohortSampleRow,
  type SplitTestRow,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { flagOn } from '../lib/copilot';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, ok } from '../lib/openapi';
import { requireOwned, sendQueue, toBroadcast } from '../lib/send';
import { createUnopenedDraft } from './dispatches';

export const broadcasts = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const broadcastParam = idParam('broadcastId', idPattern('broadcast'));
const COLUMNS = `id, dispatch_id, channel_id, workspace_id, status, subject, from_name, from_address, recipient_count,
  sent_count, failed_count, failure_reason, created_at, completed_at, canceled_at,
  best_time, personal_time_count, default_time_count`;
/** The report also says whether the send waits for a sending limit (send-waits.ts). */
const REPORT_COLUMNS = `${COLUMNS}, split_test_id, cohort_sample_id, waiting_for, waiting_since, wait_detail,
  resume_at, last_progress_at, share_wait_since, share_wait_until`;

/** The send report: the Broadcast, its Split Test or Cohort Sample, and its wait. */
async function broadcastReport(db: D1Database, broadcastId: string): Promise<BroadcastReport> {
  const row = (await first<BroadcastRow>(
    db,
    `SELECT ${REPORT_COLUMNS} FROM broadcasts WHERE id = ?1`,
    broadcastId,
  )) as BroadcastRow;
  const test = row.split_test_id
    ? await first<SplitTestRow>(db, 'SELECT * FROM split_tests WHERE id = ?1', row.split_test_id)
    : null;
  const sample = row.cohort_sample_id
    ? await first<CohortSampleRow>(
        db,
        'SELECT * FROM cohort_samples WHERE id = ?1',
        row.cohort_sample_id,
      )
    : null;
  return {
    ...toBroadcast(row),
    splitTest: test ? await splitTestView(db, test) : null,
    cohortSample: sample ? await cohortSampleView(db, sample) : null,
    waiting: toSendWait(row),
  };
}

broadcasts.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/broadcasts',
    tags: ['Broadcasts'],
    summary: 'Broadcasts in a Channel, newest first',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(BroadcastSchema), 'Broadcasts'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<BroadcastRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM broadcasts WHERE channel_id = ?1 AND kind = 'broadcast' ORDER BY created_at DESC LIMIT 100`,
      channelId,
    );
    return c.json({ data: rows.map(toBroadcast) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/broadcasts/{broadcastId}',
    tags: ['Broadcasts'],
    summary: 'One Broadcast and its progress',
    description:
      'With its Split Test (variants with delivered, conversions and rate each, and the winner) or its Cohort Sample (status and health), when it has one, and `waiting` while it waits for a sending limit or the email service.',
    request: { params: broadcastParam },
    responses: {
      200: ok(BroadcastReportSchema, 'Broadcast'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    await requireOwned(c, 'broadcast', broadcastId, 'viewer');
    return c.json({ data: await broadcastReport(env(c).DB, broadcastId) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/broadcasts/{broadcastId}/resume',
    tags: ['Broadcasts'],
    summary: 'Resume a send that waits for a sending limit',
    description:
      'For a send whose `waiting` is set: sending tries again now, from every recipient still unsent. If the limit or the email service still says no, it waits again. Use it after fixing the email service or raising a limit or plan. A send the email service stopped (`service_stopped`) is also tried again by itself, less often as time goes on (`waiting.until` is the next try), and ends as failed if the service still refuses mail 7 days after it stopped. Admins of the publication.',
    request: { params: broadcastParam },
    responses: {
      200: ok(BroadcastReportSchema, 'Resumed'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    const access = await requireOwned(c, 'broadcast', broadcastId, 'admin');
    const e = env(c);
    if (!(await resumeSend(e.DB, sendQueue(c), broadcastId, Date.now()))) {
      throw new ApiError('conflict', 'This send isn’t waiting.');
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'broadcast.resumed',
      targetType: 'broadcast',
      targetId: broadcastId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    c.executionCtx.waitUntil(publishProgress(e.DB, e.SEND_MONITOR, [broadcastId]));
    return c.json({ data: await broadcastReport(e.DB, broadcastId) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/broadcasts/{broadcastId}/stats',
    tags: ['Broadcasts'],
    summary: 'Delivery, engagement, per-link clicks and cost',
    description:
      'Opens and clicks are split into human and machine (privacy proxies, link scanners).',
    request: { params: broadcastParam },
    responses: {
      200: ok(BroadcastStatsSchema, 'Statistics'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    await requireOwned(c, 'broadcast', broadcastId, 'viewer');
    return c.json({ data: await broadcastStats(env(c).DB, broadcastId) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/broadcasts/{broadcastId}/click-map',
    tags: ['Broadcasts'],
    summary: 'The sent email with clicks marked on each link',
    description:
      'Clicks by people only, as counts; never who clicked. Each view is one way the email went out (a Split Test version, the full email or the teaser), and its html is for a sandboxed frame: nothing in it can register an open or a click. Needs the click_map flag.',
    request: { params: broadcastParam },
    responses: {
      200: ok(BroadcastClickMapSchema, 'The click map'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    const access = await requireOwned(c, 'broadcast', broadcastId, 'viewer');
    const scope = { workspaceId: access.workspaceId, channelId: access.channelId };
    if (!(await flagOn(c, 'click_map', scope))) {
      throw new ApiError(
        'feature_disabled',
        'The click map is not turned on for this publication.',
      );
    }
    return c.json({ data: await broadcastClickMap(env(c).DB, broadcastId) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/broadcasts/{broadcastId}/cancel',
    tags: ['Broadcasts'],
    summary: 'Stop a Broadcast',
    description:
      'Messages already handed to the mail provider are not recalled; nothing further is sent.',
    request: { params: broadcastParam },
    responses: {
      200: ok(BroadcastSchema, 'Canceled'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    const access = await requireOwned(c, 'broadcast', broadcastId, 'editor');
    const e = env(c);
    if (!(await cancelBroadcast(e.DB, broadcastId))) {
      throw new ApiError('conflict', 'This send has already finished.');
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'broadcast.canceled',
      targetType: 'broadcast',
      targetId: broadcastId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    c.executionCtx.waitUntil(publishProgress(e.DB, e.SEND_MONITOR, [broadcastId]));
    const row = await first<BroadcastRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM broadcasts WHERE id = ?1`,
      broadcastId,
    );
    return c.json({ data: toBroadcast(row as BroadcastRow) }, 200);
  },
);

broadcasts.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/broadcasts/{broadcastId}/resend-unopened',
    tags: ['Broadcasts'],
    summary: 'Start a draft for people who didn’t open',
    description:
      'A draft copy, off the website, for the people this Broadcast reached who neither opened nor clicked it. Asking again gives the same draft. Sending it takes the usual steps. Needs the resend_unopens flag.',
    request: { params: broadcastParam },
    responses: {
      200: ok(z.object({ dispatchId: z.string() }), 'The draft'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { broadcastId } = c.req.valid('param');
    const access = await requireOwned(c, 'broadcast', broadcastId, 'editor');
    const scope = { workspaceId: access.workspaceId, channelId: access.channelId };
    if (!(await flagOn(c, 'resend_unopens', scope))) {
      throw new ApiError('feature_disabled', 'Resending is not turned on for this publication.');
    }
    const dispatchId = await createUnopenedDraft(c, access, broadcastId);
    return c.json({ data: { dispatchId } }, 200);
  },
);

/**
 * Live progress over WebSocket, forwarded to the Broadcast's SendMonitor. Browsers send cookies
 * on cross-site WebSocket handshakes and the CSRF guard skips GETs, so the Origin is checked here.
 * Not in the OpenAPI document: it is a socket, not a JSON route.
 */
broadcasts.get('/api/v1/broadcasts/:broadcastId/live', async (c) => {
  const broadcastId = c.req.param('broadcastId');
  if (!idPattern('broadcast').test(broadcastId)) {
    throw new ApiError('not_found', 'Send not found.');
  }
  if (c.req.header('origin') !== env(c).APP_ORIGIN) {
    throw new ApiError('forbidden', 'Cross-site request blocked.');
  }
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError('invalid_input', 'Expected a WebSocket upgrade.');
  }
  await requireOwned(c, 'broadcast', broadcastId, 'viewer');
  const monitors = env(c).SEND_MONITOR;
  if (!monitors) throw new ApiError('not_found', 'Live progress is not available here.');
  const res = await monitors.get(monitors.idFromName(broadcastId)).fetch(c.req.raw);
  // Re-wrapped so the response middleware can add its headers to the 101.
  return new Response(null, { status: res.status, webSocket: res.webSocket, headers: res.headers });
});
