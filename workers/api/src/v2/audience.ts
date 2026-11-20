// /v2 Circles (circles:read), membership levels (levels:read), capture forms (forms:read) and
// Flows (flows:read, flows:write: enrol a Member). Read shapes are the dashboard's.
import { z } from '@hono/zod-openapi';
import { all, first, roleAtLeast } from '@swarm/db';
import {
  ApiCircleCountSchema,
  ApiEnrolSchema,
  CaptureFormSchema,
  CaptureFormSnippetSchema,
  CircleSchema,
  CursorQuerySchema,
  FlowRunSchema,
  FlowSummarySchema,
  MembershipLevelListSchema,
  idPattern,
  page,
  type FlowGraph,
} from '@swarm/domain';
import { loadFlowRow, startFlowRun, type FlowRunRow, type FlowTableRow } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { appendAudit } from '../lib/audit';
import { actorAudit, apiActor } from '../lib/actor';
import { createRouter, env } from '../lib/context';
import { flowsEnvFor, graphGrantsLevel, runCounts, toFlowRun, toFlowSummary } from '../lib/flows';
import { readLevels } from '../lib/levels';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { FORM_COLUMNS, formSnippet, toForm, type FormRow } from '../routes/captureForms';
import { compile, toCircle, type CircleRow } from '../routes/circles';
import { decodeCursor, encodeCursor, guard, requireInChannel, v2Route } from './route';

export const v2Audience = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const circleParams = channelParam.extend(idParam('circleId', idPattern('circle')).shape);
const formParams = channelParam.extend(idParam('formId', idPattern('captureForm')).shape);
const flowParams = channelParam.extend(idParam('flowId', idPattern('flow')).shape);
const notFound = errors('not_found');

// ---- Circles ---------------------------------------------------------------------------------

const listCircles = v2Route('circles:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/circles',
  operationId: 'listCircles',
  tags: ['Circles'],
  summary: 'Circles of a Channel, newest first',
  request: { params: channelParam, query: CursorQuerySchema },
  responses: { 200: ok(page(CircleSchema), 'Circles'), ...errors('invalid_input', 'not_found') },
});
v2Audience.openapi(listCircles, async (c) => {
  await guard(c, listCircles);
  const { channelId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const after = decodeCursor(cursor);
  if (after !== undefined && !idPattern('circle').test(after)) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
  const rows = await all<CircleRow>(
    env(c).DB,
    `SELECT * FROM circles WHERE channel_id = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id < ?2)
      ORDER BY id DESC LIMIT ?3`,
    channelId,
    after ?? null,
    limit + 1,
  );
  const items = rows.slice(0, limit).map(toCircle);
  const nextCursor = rows.length > limit ? encodeCursor(items.at(-1)?.id ?? null) : null;
  return c.json({ data: { items, nextCursor } }, 200);
});

async function circleIn(c: Parameters<typeof guard>[0], channelId: string, circleId: string) {
  await requireInChannel(c, 'circles', circleId, channelId);
  return (await first<CircleRow>(env(c).DB, 'SELECT * FROM circles WHERE id = ?1', circleId))!;
}

const getCircle = v2Route('circles:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/circles/{circleId}',
  operationId: 'getCircle',
  tags: ['Circles'],
  summary: 'One Circle',
  description: '`memberCount` is as of the last evaluation; `/count` evaluates the rule now.',
  request: { params: circleParams },
  responses: { 200: ok(CircleSchema, 'Circle'), ...notFound },
});
v2Audience.openapi(getCircle, async (c) => {
  await guard(c, getCircle);
  const { channelId, circleId } = c.req.valid('param');
  return c.json({ data: toCircle(await circleIn(c, channelId, circleId)) }, 200);
});

const countCircle = v2Route('circles:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/circles/{circleId}/count',
  operationId: 'countCircle',
  tags: ['Circles'],
  summary: 'How many Members match a Circle now',
  request: { params: circleParams },
  responses: { 200: ok(ApiCircleCountSchema, 'Count'), ...notFound },
});
v2Audience.openapi(countCircle, async (c) => {
  await guard(c, countCircle);
  const { channelId, circleId } = c.req.valid('param');
  const circle = await circleIn(c, channelId, circleId);
  const compiled = await compile(c, JSON.parse(circle.rule_json), channelId);
  // ?1 carries the rule's values (see compileCircle); the Channel is ?2.
  const counts = await first<{ n: number; active: number }>(
    env(c).DB,
    `SELECT count(*) AS n, ifnull(sum(m.status = 'active'), 0) AS active
       FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})`,
    ...compiled.params,
    channelId,
  );
  return c.json(
    { data: { circleId, count: counts?.n ?? 0, activeCount: counts?.active ?? 0 } },
    200,
  );
});

// ---- Membership levels -----------------------------------------------------------------------

const listLevels = v2Route('levels:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/levels',
  operationId: 'listLevels',
  tags: ['Membership levels'],
  summary: 'Membership levels of a Channel',
  description:
    'The implicit free level, then the paid levels (Founding Level first) with their active prices. Archived levels are left out.',
  request: { params: channelParam },
  responses: { 200: ok(MembershipLevelListSchema, 'Levels'), ...notFound },
});
v2Audience.openapi(listLevels, async (c) => {
  await guard(c, listLevels);
  const { channelId } = c.req.valid('param');
  const db = env(c).DB;
  const items = await readLevels(db, channelId);
  const members = await first<{ total: number; paid: number }>(
    db,
    `SELECT (SELECT count(*) FROM members WHERE channel_id = ?1 AND status IN ('active', 'paused')) AS total,
            (SELECT count(*) FROM member_entitlements e JOIN members m ON m.id = e.member_id
              WHERE e.channel_id = ?1 AND e.kind = 'paid' AND m.status IN ('active', 'paused')
                AND (e.expires_at IS NULL OR e.expires_at > ?2)) AS paid`,
    channelId,
    Date.now(),
  );
  const free = Math.max(0, (members?.total ?? 0) - (members?.paid ?? 0));
  return c.json({ data: { free: { name: 'Free', memberCount: free }, items } }, 200);
});

// ---- Capture forms ---------------------------------------------------------------------------

const listForms = v2Route('forms:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/capture-forms',
  operationId: 'listCaptureForms',
  tags: ['Capture forms'],
  summary: 'Capture forms and Smart Prompts of a Channel',
  request: {
    params: channelParam,
    query: z.object({ kind: z.enum(['form', 'prompt']).optional() }),
  },
  responses: { 200: ok(z.array(CaptureFormSchema), 'Capture forms'), ...notFound },
});
v2Audience.openapi(listForms, async (c) => {
  await guard(c, listForms);
  const { channelId } = c.req.valid('param');
  const { kind } = c.req.valid('query');
  const rows = await all<FormRow>(
    env(c).DB,
    `SELECT ${FORM_COLUMNS} FROM capture_forms WHERE channel_id = ?1 AND deleted_at IS NULL
        AND (?2 IS NULL OR kind = ?2) ORDER BY created_at DESC`,
    channelId,
    kind ?? null,
  );
  return c.json({ data: rows.map(toForm) }, 200);
});

const getForm = v2Route('forms:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/capture-forms/{formId}',
  operationId: 'getCaptureForm',
  tags: ['Capture forms'],
  summary: 'One capture form',
  request: { params: formParams },
  responses: { 200: ok(CaptureFormSchema, 'Capture form'), ...notFound },
});
v2Audience.openapi(getForm, async (c) => {
  await guard(c, getForm);
  const { channelId, formId } = c.req.valid('param');
  await requireInChannel(c, 'capture_forms', formId, channelId);
  const row = await first<FormRow>(
    env(c).DB,
    `SELECT ${FORM_COLUMNS} FROM capture_forms WHERE id = ?1`,
    formId,
  );
  return c.json({ data: toForm(row as FormRow) }, 200);
});

const getFormSnippet = v2Route('forms:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/capture-forms/{formId}/snippet',
  operationId: 'getCaptureFormSnippet',
  tags: ['Capture forms'],
  summary: 'Embed code for the published version',
  description:
    'The script tag, and `noscript`: a plain HTML form that posts straight to the capture endpoint, for a page or plugin that renders forms itself. The script tag pins this version, so fetch it again after each publish.',
  request: { params: formParams },
  responses: {
    200: ok(CaptureFormSnippetSchema, 'Snippet'),
    ...notFound,
    ...errors('conflict'),
  },
});
v2Audience.openapi(getFormSnippet, async (c) => {
  await guard(c, getFormSnippet);
  const { channelId, formId } = c.req.valid('param');
  await requireInChannel(c, 'capture_forms', formId, channelId);
  const row = await first<FormRow>(
    env(c).DB,
    `SELECT ${FORM_COLUMNS} FROM capture_forms WHERE id = ?1`,
    formId,
  );
  return c.json({ data: await formSnippet(c, row as FormRow) }, 200);
});

// ---- Flows -----------------------------------------------------------------------------------

const listFlows = v2Route('flows:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/flows',
  operationId: 'listFlows',
  tags: ['Flows'],
  summary: 'Flows of a Channel with their status, live version and run counts',
  request: { params: channelParam },
  responses: { 200: ok(z.array(FlowSummarySchema), 'Flows'), ...notFound },
});
v2Audience.openapi(listFlows, async (c) => {
  await guard(c, listFlows);
  const db = env(c).DB;
  const rows = await all<FlowTableRow>(
    db,
    `SELECT * FROM flows WHERE channel_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    c.req.valid('param').channelId,
  );
  const counts = await runCounts(
    db,
    rows.map((r) => r.id),
  );
  return c.json({ data: rows.map((r) => toFlowSummary(r, counts.get(r.id)!)) }, 200);
});

const getFlow = v2Route('flows:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/flows/{flowId}',
  operationId: 'getFlow',
  tags: ['Flows'],
  summary: 'One Flow',
  request: { params: flowParams },
  responses: { 200: ok(FlowSummarySchema, 'Flow'), ...notFound },
});
v2Audience.openapi(getFlow, async (c) => {
  await guard(c, getFlow);
  const { channelId, flowId } = c.req.valid('param');
  await requireInChannel(c, 'flows', flowId, channelId);
  const db = env(c).DB;
  const flow = (await loadFlowRow(db, flowId)) as FlowTableRow;
  const counts = await runCounts(db, [flowId]);
  return c.json({ data: toFlowSummary(flow, counts.get(flowId)!) }, 200);
});

const enrol = v2Route('flows:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/flows/{flowId}/enrolments',
  operationId: 'enrolInFlow',
  tags: ['Flows'],
  summary: 'Enrol a Member in a live Flow',
  description:
    'Starts a run of the live version for a Member of this Channel, as if the trigger had fired. The Flow’s re-entry rule applies: a Member already in it answers 409.',
  request: { params: flowParams, body: jsonBody(ApiEnrolSchema) },
  responses: {
    202: ok(FlowRunSchema, 'Started'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Audience.openapi(enrol, async (c) => {
  const principal = await guard(c, enrol);
  const { channelId, flowId } = c.req.valid('param');
  const { memberId } = c.req.valid('json');
  await requireInChannel(c, 'flows', flowId, channelId);
  const db = env(c).DB;
  const flow = (await loadFlowRow(db, flowId)) as FlowTableRow;
  if (flow.status !== 'live' || flow.live_version === null) {
    throw new ApiError('conflict', 'Only a live automation can take enrolments.');
  }
  const member = await first(
    db,
    'SELECT 1 FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
  if (!member) {
    throw new ApiError('invalid_input', 'That subscriber is not in this publication.', [
      { path: 'memberId', message: 'That subscriber is not in this publication.' },
    ]);
  }
  const version = await first<{ graph_json: string }>(
    db,
    'SELECT graph_json FROM flow_versions WHERE flow_id = ?1 AND version = ?2',
    flowId,
    flow.live_version,
  );
  const graph = JSON.parse(version!.graph_json) as FlowGraph;
  // A comp grant needs the admin role; keys and OAuth tokens act as editor (apiActor).
  if (!roleAtLeast(apiActor(c, principal).role, 'admin') && (await graphGrantsLevel(db, graph))) {
    throw new ApiError(
      'forbidden',
      'This automation gives a paid plan for free, so only an admin can add people to it.',
    );
  }
  const runId = await startFlowRun(flowsEnvFor(c), {
    flowId,
    version: flow.live_version,
    memberId,
    channelId,
    graph,
    now: Date.now(),
  });
  if (!runId) throw new ApiError('conflict', 'This subscriber is already in this automation.');
  await appendAudit(
    db,
    actorAudit(apiActor(c, principal), {
      action: 'flow.enrolled',
      targetType: 'flow',
      targetId: flowId,
      metadata: { runId, memberId },
    }),
  );
  const row = await first<FlowRunRow & { member_email: string | null }>(
    db,
    `SELECT r.*, m.email AS member_email FROM flow_runs r LEFT JOIN members m ON m.id = r.member_id
      WHERE r.id = ?1`,
    runId,
  );
  return c.json({ data: toFlowRun(row!) }, 202);
});
