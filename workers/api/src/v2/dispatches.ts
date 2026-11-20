// /v2 Dispatches (dispatches:read, dispatches:write) and Broadcasts (broadcasts:read). Saving,
// test sends, previews and scheduling are the dashboard's own functions in routes/dispatches.ts,
// run with an API actor. Sending now is not part of the public API: a schedule runs the same
// checklist when its time comes.
import { z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  ApiPreviewRequestSchema,
  ApiPreviewSchema,
  ApiTestSendSchema,
  BroadcastDetailSchema,
  BroadcastSchema,
  BroadcastStatsSchema,
  CreateDispatchSchema,
  CursorQuerySchema,
  DispatchSchema,
  DispatchSummarySchema,
  ScheduleDispatchSchema,
  UpdateDispatchSchema,
  idPattern,
  page,
} from '@swarm/domain';
import {
  broadcastStats,
  cohortSampleView,
  splitTestView,
  type BroadcastRow,
  type CohortSampleRow,
  type DispatchRow,
  type SplitTestRow,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { apiActor } from '../lib/actor';
import { flagOn } from '../lib/copilot';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { rawHtmlAllowed, toBroadcast, toDispatchSummary } from '../lib/send';
import {
  DISPATCH_SUMMARY_COLUMNS,
  createDispatchRow,
  createUnopenedDraft,
  dispatchOut,
  renderPersonalised,
  scheduleDispatch,
  testSendDispatch,
  updateDispatch,
} from '../routes/dispatches';
import { internalPrincipal } from './internal';
import { decodeCursor, encodeCursor, guard, requireInChannel, v2Route } from './route';

export const v2Dispatches = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const dispatchParams = channelParam.extend(idParam('dispatchId', idPattern('dispatch')).shape);
const broadcastParams = channelParam.extend(idParam('broadcastId', idPattern('broadcast')).shape);
const BROADCAST_COLUMNS = `id, dispatch_id, channel_id, workspace_id, status, subject, from_name, from_address, recipient_count,
  sent_count, failed_count, failure_reason, created_at, completed_at, canceled_at,
  best_time, personal_time_count, default_time_count`;

/** A Broadcast Dispatch of the path's Channel (Flow emails belong to their Flow). */
async function dispatchIn(
  c: AppContext,
  channelId: string,
  dispatchId: string,
): Promise<{ status: string }> {
  const row = await first<{ kind: string; status: string }>(
    env(c).DB,
    'SELECT kind, status FROM dispatches WHERE id = ?1 AND channel_id = ?2',
    dispatchId,
    channelId,
  );
  if (!row || row.kind !== 'broadcast') throw new ApiError('not_found', 'Post not found.');
  return { status: row.status };
}

/**
 * What a scheduled post sends and to whom. A person approved the schedule for one version of
 * these; an agent changing them afterwards would send something nobody approved.
 */
const SEND_FIELDS = [
  'subject',
  'preheader',
  'content',
  'coverImage',
  'senderIdentityId',
  'audience',
] as const;

const out = async (c: AppContext, workspaceId: string, channelId: string, id: string) =>
  dispatchOut(c, id, await rawHtmlAllowed(c, { workspaceId, channelId }));

// ---- Dispatches ------------------------------------------------------------------------------

const listRoute = v2Route('dispatches:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/dispatches',
  operationId: 'listDispatches',
  tags: ['Dispatches'],
  summary: 'Dispatches of a Channel, newest first',
  request: { params: channelParam, query: CursorQuerySchema },
  responses: {
    200: ok(page(DispatchSummarySchema), 'Dispatches'),
    ...errors('invalid_input', 'not_found'),
  },
});
v2Dispatches.openapi(listRoute, async (c) => {
  await guard(c, listRoute);
  const { channelId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const after = decodeCursor(cursor);
  if (after !== undefined && !idPattern('dispatch').test(after)) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
  const rows = await all<DispatchRow & { latest_broadcast_id: string | null }>(
    env(c).DB,
    `SELECT ${DISPATCH_SUMMARY_COLUMNS} FROM dispatches d
      WHERE d.channel_id = ?1 AND d.kind = 'broadcast' AND (?2 IS NULL OR d.id < ?2)
      ORDER BY d.id DESC LIMIT ?3`,
    channelId,
    after ?? null,
    limit + 1,
  );
  const items = rows.slice(0, limit).map(toDispatchSummary);
  const nextCursor = rows.length > limit ? encodeCursor(items.at(-1)?.id ?? null) : null;
  return c.json({ data: { items, nextCursor } }, 200);
});

const getRoute = v2Route('dispatches:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/dispatches/{dispatchId}',
  operationId: 'getDispatch',
  tags: ['Dispatches'],
  summary: 'One Dispatch with its document, rendered HTML and lint warnings',
  request: { params: dispatchParams },
  responses: { 200: ok(DispatchSchema, 'Dispatch'), ...errors('not_found') },
});
v2Dispatches.openapi(getRoute, async (c) => {
  const principal = await guard(c, getRoute);
  const { channelId, dispatchId } = c.req.valid('param');
  await dispatchIn(c, channelId, dispatchId);
  return c.json({ data: await out(c, principal.workspaceId, channelId, dispatchId) }, 200);
});

const createRouteDef = v2Route('dispatches:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/dispatches',
  operationId: 'createDispatch',
  tags: ['Dispatches'],
  summary: 'Start a draft Dispatch',
  description: '`content` is the editor document (the same JSON the dashboard saves).',
  request: { params: channelParam, body: jsonBody(CreateDispatchSchema) },
  responses: { 201: ok(DispatchSchema, 'Created'), ...errors('invalid_input', 'not_found') },
});
v2Dispatches.openapi(createRouteDef, async (c) => {
  const principal = await guard(c, createRouteDef);
  const { channelId } = c.req.valid('param');
  const actor = apiActor(c, principal);
  const scope = { workspaceId: principal.workspaceId, channelId };
  const allowHtml = await rawHtmlAllowed(c, scope);
  // An in-process request is an agent tool call (an MCP client or an approved call); a direct
  // /v2 request is an integration. The dashboard's own route leaves it unset.
  const internal = internalPrincipal(c.req.raw) !== null;
  const createdVia = internal ? (principal.kind === 'copilot' ? 'copilot' : 'agent') : 'api';
  const id = await createDispatchRow(
    c,
    { ...scope, auth: { operatorId: null }, via: actor.via },
    { ...c.req.valid('json'), allowHtml, createdVia },
  );
  return c.json({ data: await dispatchOut(c, id, allowHtml) }, 201);
});

const resendRoute = v2Route('dispatches:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/broadcasts/{broadcastId}/resend-unopened',
  operationId: 'createUnopenedDraft',
  tags: ['Dispatches'],
  summary: 'Start a draft for people who didn’t open a Broadcast',
  description:
    'A draft copy, off the website, for the people this Broadcast reached who neither opened nor clicked it. Asking again gives the same draft. Sending it takes the usual steps. Needs the resend_unopens flag.',
  request: { params: broadcastParams },
  responses: {
    201: ok(DispatchSchema, 'The draft'),
    ...errors('not_found', 'conflict', 'feature_disabled'),
  },
});
v2Dispatches.openapi(resendRoute, async (c) => {
  const principal = await guard(c, resendRoute);
  const { channelId, broadcastId } = c.req.valid('param');
  const scope = { workspaceId: principal.workspaceId, channelId };
  if (!(await flagOn(c, 'resend_unopens', scope))) {
    throw new ApiError('feature_disabled', 'Resending is not turned on for this publication.');
  }
  const actor = apiActor(c, principal);
  const internal = internalPrincipal(c.req.raw) !== null;
  const id = await createUnopenedDraft(
    c,
    { ...scope, auth: { operatorId: null }, via: actor.via },
    broadcastId,
    internal ? (principal.kind === 'copilot' ? 'copilot' : 'agent') : 'api',
  );
  return c.json({ data: await dispatchOut(c, id, await rawHtmlAllowed(c, scope)) }, 201);
});

const updateRoute = v2Route('dispatches:write', {
  method: 'patch',
  path: '/v2/channels/{channelId}/dispatches/{dispatchId}',
  operationId: 'updateDispatch',
  tags: ['Dispatches'],
  summary: 'Save a Dispatch',
  description:
    'Every save is a revision. Content, subject, sender and audience change only before sending; the web fields (webVisibility, sectionId, slug) can change at any time. An Open Operator tool call cannot change subject, preheader, content, coverImage, senderIdentityId or audience of a scheduled Dispatch (409), because its schedule was approved for what it held then.',
  request: { params: dispatchParams, body: jsonBody(UpdateDispatchSchema) },
  responses: {
    200: ok(DispatchSchema, 'Saved'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Dispatches.openapi(updateRoute, async (c) => {
  const principal = await guard(c, updateRoute);
  const { channelId, dispatchId } = c.req.valid('param');
  const { status } = await dispatchIn(c, channelId, dispatchId);
  const body = c.req.valid('json');
  if (
    status === 'scheduled' &&
    internalPrincipal(c.req.raw) !== null &&
    SEND_FIELDS.some((field) => body[field] !== undefined)
  ) {
    throw new ApiError(
      'conflict',
      'This post is scheduled to send. An agent can’t change what it says or who gets it: a person must unschedule it first, and scheduling it again needs approval.',
    );
  }
  await updateDispatch(c, apiActor(c, principal), dispatchId, body);
  return c.json({ data: await out(c, principal.workspaceId, channelId, dispatchId) }, 200);
});

const testRoute = v2Route('dispatches:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/dispatches/{dispatchId}/test',
  operationId: 'sendDispatchTest',
  tags: ['Dispatches'],
  summary: 'Send a test',
  description:
    'Renders the saved version and sends it to teammates of this workspace only, optionally personalised as a Member. Links are not tracked and the subject starts with [Test]. Limited to 10 a minute.',
  request: { params: dispatchParams, body: jsonBody(ApiTestSendSchema) },
  responses: {
    202: ok(z.object({ sentTo: z.array(z.string()) }), 'Sent'),
    ...errors('invalid_input', 'not_found', 'rate_limited'),
  },
});
v2Dispatches.openapi(testRoute, async (c) => {
  const principal = await guard(c, testRoute);
  const { channelId, dispatchId } = c.req.valid('param');
  await dispatchIn(c, channelId, dispatchId);
  const sentTo = await testSendDispatch(c, apiActor(c, principal), dispatchId, c.req.valid('json'));
  return c.json({ data: { sentTo } }, 202);
});

const previewRoute = v2Route('dispatches:read', {
  method: 'post',
  path: '/v2/channels/{channelId}/dispatches/{dispatchId}/preview',
  operationId: 'previewDispatch',
  tags: ['Dispatches'],
  summary: 'Render the email as a reader would get it',
  description:
    'The saved version, personalised as a Member when `memberId` is given (their merge tags and Smart Blocks); otherwise merge tags show their fallbacks. Nothing is sent or saved. Links are not tracked.',
  request: { params: dispatchParams, body: jsonBody(ApiPreviewRequestSchema) },
  responses: { 200: ok(ApiPreviewSchema, 'Preview'), ...errors('invalid_input', 'not_found') },
});
v2Dispatches.openapi(previewRoute, async (c) => {
  const principal = await guard(c, previewRoute);
  const { channelId, dispatchId } = c.req.valid('param');
  await dispatchIn(c, channelId, dispatchId);
  const { subject, html, text, warnings } = await renderPersonalised(
    c,
    principal.workspaceId,
    dispatchId,
    c.req.valid('json'),
    { email: 'reader@example.com' },
  );
  return c.json({ data: { subject, html, text, warnings } }, 200);
});

const scheduleRoute = v2Route('dispatches:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/dispatches/{dispatchId}/schedule',
  operationId: 'scheduleDispatch',
  tags: ['Dispatches'],
  summary: 'Schedule a Dispatch',
  description:
    'The pre-send checklist must pass now; it runs again when the time comes, and a Dispatch that fails it then goes back to draft. At least a minute and at most a year ahead.',
  request: { params: dispatchParams, body: jsonBody(ScheduleDispatchSchema) },
  responses: {
    200: ok(DispatchSchema, 'Scheduled'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Dispatches.openapi(scheduleRoute, async (c) => {
  const principal = await guard(c, scheduleRoute);
  const { channelId, dispatchId } = c.req.valid('param');
  await dispatchIn(c, channelId, dispatchId);
  const publishAt = Date.parse(c.req.valid('json').publishAt);
  await scheduleDispatch(c, apiActor(c, principal), dispatchId, publishAt);
  return c.json({ data: await out(c, principal.workspaceId, channelId, dispatchId) }, 200);
});

// ---- Broadcasts ------------------------------------------------------------------------------

const listBroadcastsRoute = v2Route('broadcasts:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/broadcasts',
  operationId: 'listBroadcasts',
  tags: ['Broadcasts'],
  summary: 'Broadcasts of a Channel, newest first',
  request: { params: channelParam, query: CursorQuerySchema },
  responses: {
    200: ok(page(BroadcastSchema), 'Broadcasts'),
    ...errors('invalid_input', 'not_found'),
  },
});
v2Dispatches.openapi(listBroadcastsRoute, async (c) => {
  await guard(c, listBroadcastsRoute);
  const { channelId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const after = decodeCursor(cursor);
  if (after !== undefined && !idPattern('broadcast').test(after)) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
  const rows = await all<BroadcastRow>(
    env(c).DB,
    `SELECT ${BROADCAST_COLUMNS} FROM broadcasts
      WHERE channel_id = ?1 AND kind = 'broadcast' AND (?2 IS NULL OR id < ?2)
      ORDER BY id DESC LIMIT ?3`,
    channelId,
    after ?? null,
    limit + 1,
  );
  const items = rows.slice(0, limit).map(toBroadcast);
  const nextCursor = rows.length > limit ? encodeCursor(items.at(-1)?.id ?? null) : null;
  return c.json({ data: { items, nextCursor } }, 200);
});

const getBroadcastRoute = v2Route('broadcasts:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/broadcasts/{broadcastId}',
  operationId: 'getBroadcast',
  tags: ['Broadcasts'],
  summary: 'One Broadcast and its progress',
  description: 'With its Split Test or Cohort Sample, when it has one.',
  request: { params: broadcastParams },
  responses: { 200: ok(BroadcastDetailSchema, 'Broadcast'), ...errors('not_found') },
});
v2Dispatches.openapi(getBroadcastRoute, async (c) => {
  await guard(c, getBroadcastRoute);
  const { channelId, broadcastId } = c.req.valid('param');
  await requireInChannel(c, 'broadcasts', broadcastId, channelId);
  const db = env(c).DB;
  const row = (await first<BroadcastRow>(
    db,
    `SELECT ${BROADCAST_COLUMNS}, split_test_id, cohort_sample_id FROM broadcasts WHERE id = ?1`,
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
  return c.json(
    {
      data: {
        ...toBroadcast(row),
        splitTest: test ? await splitTestView(db, test) : null,
        cohortSample: sample ? await cohortSampleView(db, sample) : null,
      },
    },
    200,
  );
});

const statsRoute = v2Route('broadcasts:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/broadcasts/{broadcastId}/stats',
  operationId: 'getBroadcastStats',
  tags: ['Broadcasts'],
  summary: 'Delivery, engagement and per-link clicks',
  description:
    'Opens and clicks are split into human and machine (privacy proxies, link scanners).',
  request: { params: broadcastParams },
  responses: { 200: ok(BroadcastStatsSchema, 'Statistics'), ...errors('not_found') },
});
v2Dispatches.openapi(statsRoute, async (c) => {
  await guard(c, statsRoute);
  const { channelId, broadcastId } = c.req.valid('param');
  await requireInChannel(c, 'broadcasts', broadcastId, channelId);
  return c.json({ data: await broadcastStats(env(c).DB, broadcastId) }, 200);
});
