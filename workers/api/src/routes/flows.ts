// Flows (Phase 6): the draft graph, Flow emails, publishing versions, pause/resume/archive,
// test runs, runs and per-node stats, and Flow Recipes. The engine (jobs worker) runs them;
// publishing lives in @swarm/engine flow-publish.ts so auto-promotion shares it.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, roleAtLeast, run, toIso } from '@swarm/db';
import {
  BulkJobSchema,
  CreateFlowEmailSchema,
  CreateFlowSchema,
  DispatchSchema,
  FLOW_RECIPES,
  FLOW_RECIPE_DEFS,
  FLOW_REHEARSAL_MAX_SAMPLE,
  FlowEmailSchema,
  FlowEnrolPreviewRequestSchema,
  FlowEnrolPreviewSchema,
  FlowEnrolStartSchema,
  FlowGraphSchema,
  FlowRecipeInfoSchema,
  FlowRehearsalResultSchema,
  FlowRehearseSchema,
  FlowRunDetailSchema,
  FlowRunListQuerySchema,
  FlowRunPageSchema,
  FlowRunSchema,
  FlowSchema,
  FlowStatsQuerySchema,
  FlowStatsSchema,
  FlowStatusSchema,
  FlowSummarySchema,
  FlowTestRunSchema,
  FlowWebhookSecretSchema,
  PublishFlowResultSchema,
  PublishFlowSchema,
  UpdateFlowSchema,
  emptyFlowGraph,
  idPattern,
  newId,
  triggerOf,
  triggersOf,
  type BulkSelection,
  type Flow,
  type FlowGraph,
} from '@swarm/domain';
import {
  FLOW_RUN_HOLD_COLUMN,
  FlowPublishError,
  broadcastStats,
  checkFlowReferences,
  closeRetiredFlowBroadcasts,
  enrolmentCounts,
  loadFlowRow,
  loadVersionGraph,
  migrateRuns as migrateFlowRuns,
  publishFlowVersion,
  rehearseFlow,
  resumeFlowRuns,
  sampleCircle,
  startFlowRun,
  referenceDetails,
  toFlowRunHold,
  type FlowHoldRow,
  type FlowRunRow,
  type FlowTableRow,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { requireAuth, requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { apiVault, credentialOf } from '../lib/vault';
import { BULK_COLUMNS, toBulkJob, type BulkJobRow } from '../lib/audience';
import {
  changesGrantSteps,
  draftIssues,
  graphGrantsLevel,
  runCounts,
  flowsEnvFor,
  toFlowRun,
  toFlowSummary,
  triggerTypes,
} from '../lib/flows';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { engine, rawHtmlAllowed, requireOwned } from '../lib/send';
import { audit } from '../lib/site';
import { NO_STORE } from '../v2/idempotency';
import { createDispatchRow, dispatchOut } from './dispatches';

export const flows = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const flowParam = idParam('flowId', idPattern('flow'));
const runParams = flowParam.extend(idParam('runId', idPattern('flowRun')).shape);

type Access = Awaited<ReturnType<typeof requireChannel>>;

/** The Flow and the operator's access to its Channel; deleted Flows are not found. */
async function flowAccess(
  c: AppContext,
  flowId: string,
  minimum: Parameters<typeof requireOwned>[3],
): Promise<{ access: Access; flow: FlowTableRow }> {
  const access = await requireOwned(c, 'flow', flowId, minimum);
  const flow = await loadFlowRow(env(c).DB, flowId);
  if (!flow) throw new ApiError('not_found', 'Automation not found.');
  return { access, flow };
}

const parseDraft = (flow: FlowTableRow) => JSON.parse(flow.draft_graph_json) as FlowGraph;

async function toFlow(c: AppContext, flowId: string): Promise<Flow> {
  const db = env(c).DB;
  const flow = await loadFlowRow(db, flowId);
  if (!flow) throw new ApiError('not_found', 'Automation not found.');
  const draft = parseDraft(flow);
  const versions = await all<{
    version: number;
    trigger_type: string;
    extra_trigger_types: string | null;
    published_by: string | null;
    published_at: number;
    retired_at: number | null;
  }>(
    db,
    `SELECT version, trigger_type, extra_trigger_types, published_by, published_at, retired_at
       FROM flow_versions
      WHERE flow_id = ?1 ORDER BY version DESC`,
    flowId,
  );
  const emails = await all<{
    id: string;
    subject: string;
    preheader: string;
    updated_at: number;
  }>(
    db,
    `SELECT id, subject, preheader, updated_at FROM dispatches
      WHERE flow_id = ?1 AND kind = 'flow' ORDER BY created_at`,
    flowId,
  );
  const counts = await runCounts(db, [flowId]);
  return {
    ...toFlowSummary(flow, counts.get(flowId)!),
    draftGraph: draft,
    draftPending: flow.draft_pending_json
      ? (JSON.parse(flow.draft_pending_json) as Flow['draftPending'])
      : null,
    issues: draftIssues(draft),
    versions: versions.map((v) => ({
      version: v.version,
      triggerType: v.trigger_type as Flow['versions'][number]['triggerType'],
      triggerTypes: triggerTypes(v),
      publishedBy: v.published_by,
      publishedAt: toIso(v.published_at),
      retiredAt: v.retired_at === null ? null : toIso(v.retired_at),
    })),
    emails: emails.map((e) => ({
      dispatchId: e.id,
      subject: e.subject,
      preheader: e.preheader,
      nodeIds: draft.nodes
        .filter((n) => n.type === 'send_email' && n.config.dispatchId === e.id)
        .map((n) => n.id),
      updatedAt: toIso(e.updated_at),
    })),
    webhookSecretSet: flow.webhook_secret_enc !== null,
  };
}

/** Refuses a graph that refers to anything outside the Flow's Channel. */
async function requireSameChannel(
  db: D1Database,
  flow: Pick<FlowTableRow, 'id' | 'channel_id' | 'workspace_id'>,
  graph: FlowGraph,
): Promise<void> {
  const problems = await checkFlowReferences(db, flow, graph);
  if (problems.length) {
    throw new ApiError(
      'invalid_input',
      'The automation refers to things outside this publication.',
      referenceDetails(problems),
    );
  }
}

/** Comp grants need the admin role (the comp route's floor), and so does a Flow step that makes one. */
function requireGrantRole(access: Access, refusal: string): void {
  if (!roleAtLeast(access.role, 'admin')) throw new ApiError('forbidden', refusal);
}

function notArchived(flow: FlowTableRow): void {
  if (flow.status === 'archived') throw new ApiError('conflict', 'This automation is archived.');
}

// ---- Recipes ---------------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flow-recipes',
    tags: ['Flows'],
    summary: 'Flow Recipes: ready-made Flows with their emails written',
    responses: {
      200: ok(z.array(FlowRecipeInfoSchema), 'Recipes'),
      ...errors('unauthorized'),
    },
  }),
  async (c) => {
    requireAuth(c);
    const data = FLOW_RECIPES.map((key) => {
      const def = FLOW_RECIPE_DEFS[key];
      const graph = def.graph(Object.fromEntries(def.emails.map((e) => [e.key, 'x'])));
      return {
        key,
        name: def.name,
        description: def.description,
        triggerType: triggerOf(graph)!.config.event,
        emailCount: def.emails.length,
      };
    });
    return c.json({ data }, 200);
  },
);

// ---- Flows -----------------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/flows',
    tags: ['Flows'],
    summary: 'Flows of a Channel with their status, live version and run counts',
    request: {
      params: channelParam,
      query: z.object({ status: FlowStatusSchema.optional() }),
    },
    responses: {
      200: ok(z.array(FlowSummarySchema), 'Flows'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { status } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const rows = await all<FlowTableRow>(
      db,
      `SELECT * FROM flows WHERE channel_id = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR status = ?2)
        ORDER BY created_at DESC LIMIT 200`,
      channelId,
      status ?? null,
    );
    const counts = await runCounts(
      db,
      rows.map((r) => r.id),
    );
    return c.json({ data: rows.map((r) => toFlowSummary(r, counts.get(r.id)!)) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/flows',
    tags: ['Flows'],
    summary: 'Create a Flow, blank or from a Flow Recipe',
    description:
      'A recipe creates the draft graph and its Flow emails, ready to review and publish. A blank Flow starts with its trigger.',
    request: { params: channelParam, body: jsonBody(CreateFlowSchema) },
    responses: {
      201: ok(FlowSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const db = env(c).DB;
    const now = Date.now();
    const id = newId('flow', now);
    const scope = { id, channel_id: channelId, workspace_id: access.workspaceId };
    const def = input.recipe ? FLOW_RECIPE_DEFS[input.recipe] : null;
    const initial = input.trigger
      ? emptyFlowGraph(input.trigger)
      : emptyFlowGraph({ event: 'confirmed' });
    if (input.trigger) await requireSameChannel(db, scope, initial);
    await run(
      db,
      `INSERT INTO flows (id, workspace_id, channel_id, name, description, status, recipe, draft_graph_json, reentry,
         created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?10)`,
      id,
      access.workspaceId,
      channelId,
      input.name ?? def?.name ?? 'Automation',
      input.description ?? def?.description ?? null,
      input.recipe ?? null,
      JSON.stringify(initial),
      input.reentry ?? def?.reentry ?? 'never',
      access.auth.operatorId,
      now,
    );
    if (def) {
      // The recipe's emails become this Flow's Dispatches, then the graph points at them.
      const allowHtml = await rawHtmlAllowed(c, access);
      const ids: Record<string, string> = {};
      for (const email of def.emails) {
        ids[email.key] = await createDispatchRow(c, access, {
          subject: email.subject,
          preheader: email.preheader,
          content: email.content,
          allowHtml,
          kind: 'flow',
          flowId: id,
        });
      }
      await run(
        db,
        'UPDATE flows SET draft_graph_json = ?1 WHERE id = ?2',
        JSON.stringify(def.graph(ids)),
        id,
      );
    }
    await audit(c, access, 'flow.created', 'flow', id, { recipe: input.recipe ?? null });
    return c.json({ data: await toFlow(c, id) }, 201);
  },
);

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flows/{flowId}',
    tags: ['Flows'],
    summary: 'One Flow: its draft graph and issues, versions and emails',
    request: { params: flowParam },
    responses: { 200: ok(FlowSchema, 'Flow'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    await flowAccess(c, flowId, 'viewer');
    return c.json({ data: await toFlow(c, flowId) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/flows/{flowId}',
    tags: ['Flows'],
    summary: 'Save a Flow’s name, description, re-entry rule or draft graph',
    description:
      'The draft is saved even with structural issues (returned in `issues`); publishing needs none. A graph that refers to a Circle, tag, level, form, field, Ask, Flow or Dispatch outside this Channel, or to an email that is not this Flow’s, is refused.',
    request: { params: flowParam, body: jsonBody(UpdateFlowSchema) },
    responses: {
      200: ok(FlowSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    notArchived(flow);
    const db = env(c).DB;
    if (input.draftGraph) await requireSameChannel(db, flow, input.draftGraph);
    // Editors keep editing the rest of a Flow; only the grant steps themselves are an admin's.
    if (input.draftGraph && changesGrantSteps(parseDraft(flow), input.draftGraph)) {
      requireGrantRole(
        access,
        'Only an admin can add or change a step that gives a Membership level for free.',
      );
    }
    const pending =
      input.draftPending === undefined
        ? flow.draft_pending_json
        : input.draftPending && input.draftPending.nodes.length
          ? JSON.stringify(input.draftPending)
          : null;
    await run(
      db,
      `UPDATE flows SET name = ?1, description = CASE WHEN ?2 = 1 THEN ?3 ELSE description END,
              draft_graph_json = ?4, reentry = ?5, updated_at = ?6, draft_pending_json = ?8
        WHERE id = ?7`,
      input.name ?? flow.name,
      input.description === undefined ? 0 : 1,
      input.description ?? null,
      input.draftGraph ? JSON.stringify(input.draftGraph) : flow.draft_graph_json,
      input.reentry ?? flow.reentry,
      Date.now(),
      flowId,
      pending,
    );
    return c.json({ data: await toFlow(c, flowId) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/flows/{flowId}',
    tags: ['Flows'],
    summary: 'Delete a Flow that was never published, or an archived one',
    request: { params: flowParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    if (flow.live_version !== null && flow.status !== 'archived') {
      throw new ApiError('conflict', 'Archive a published automation before deleting it.');
    }
    await run(
      env(c).DB,
      'UPDATE flows SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2',
      Date.now(),
      flowId,
    );
    await audit(c, access, 'flow.deleted', 'flow', flowId);
    return c.body(null, 204);
  },
);

// ---- Flow emails -----------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flows/{flowId}/emails',
    tags: ['Flows'],
    summary: 'The Flow’s emails (Dispatches of kind flow)',
    request: { params: flowParam },
    responses: {
      200: ok(z.array(FlowEmailSchema), 'Emails'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    await flowAccess(c, flowId, 'viewer');
    return c.json({ data: (await toFlow(c, flowId)).emails }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/emails',
    tags: ['Flows'],
    summary: 'Write a new Flow email',
    description:
      'Creates a Dispatch of kind flow owned by this Flow. Edit it with the Dispatch editor routes (/dispatches/{id}); only the Flow sends it, so it can’t be scheduled, sent as a Broadcast or published on the site. Use its id in a send_email node.',
    request: { params: flowParam, body: jsonBody(CreateFlowEmailSchema) },
    responses: {
      201: ok(DispatchSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    notArchived(flow);
    const allowHtml = await rawHtmlAllowed(c, access);
    const id = await createDispatchRow(c, access, {
      ...input,
      allowHtml,
      kind: 'flow',
      flowId,
    });
    return c.json({ data: await dispatchOut(c, id, allowHtml) }, 201);
  },
);

// ---- Lifecycle -------------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/publish',
    tags: ['Flows'],
    summary: 'Publish the draft as a new version',
    description:
      'Validates the graph and that everything it refers to belongs to this Channel, freezes one Flow Broadcast per email step (the same checklist and renderer as a Broadcast), and makes the new version live. Runs in progress finish on their own version unless migrateRuns is set.',
    request: { params: flowParam, body: jsonBody(PublishFlowSchema) },
    responses: {
      200: ok(PublishFlowResultSchema, 'Published'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'not_implemented',
      ),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { migrateRuns, resendNodeIds } = c.req.valid('json');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    notArchived(flow);
    let published;
    try {
      published = await publishFlowVersion(env(c).DB, engine(c), {
        flowId,
        operatorId: access.auth.operatorId,
        allowHtmlBlocks: await rawHtmlAllowed(c, access),
        resendNodeIds,
        // The whole graph, not only its grant steps: new edges or start events widen who gets one.
        authorize: async (graph) => {
          if (roleAtLeast(access.role, 'admin') || !(await graphGrantsLevel(env(c).DB, graph))) {
            return;
          }
          requireGrantRole(
            access,
            'Only an admin can publish a Flow that gives a Membership level for free.',
          );
        },
      });
    } catch (error) {
      if (!(error instanceof FlowPublishError)) throw error;
      const code =
        error.code === 'not_found'
          ? 'not_found'
          : error.code === 'conflict' || error.code === 'wrong_status'
            ? 'conflict'
            : 'invalid_input';
      throw new ApiError(code, error.message, error.details.length ? error.details : undefined);
    }
    let migrated = { moved: 0, exited: 0 };
    if (migrateRuns) {
      for (const from of published.retired) {
        const result = await migrateFlowRuns(flowsEnvFor(c), flowId, from, published.version);
        migrated = {
          moved: migrated.moved + result.moved,
          exited: migrated.exited + result.exited,
        };
      }
    }
    await audit(c, access, 'flow.published', 'flow', flowId, {
      version: published.version,
      retired: published.retired,
      emails: published.emails.length,
      ...(resendNodeIds.length ? { resendNodeIds } : {}),
      ...(migrateRuns ? { migrated } : {}),
    });
    return c.json(
      {
        data: {
          flow: await toFlow(c, flowId),
          version: published.version,
          emails: published.emails,
        },
      },
      200,
    );
  },
);

/** One status change, guarded on the current status. */
async function moveStatus(
  c: AppContext,
  flowId: string,
  from: string[],
  to: 'live' | 'paused' | 'archived',
  refusal: string,
): Promise<{ access: Access; flow: FlowTableRow }> {
  const found = await flowAccess(c, flowId, 'editor');
  const now = Date.now();
  const moved = await first<{ id: string }>(
    env(c).DB,
    `UPDATE flows SET status = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN (SELECT value FROM json_each(?4)) RETURNING id`,
    to,
    now,
    flowId,
    JSON.stringify(from),
  );
  if (!moved) throw new ApiError('conflict', refusal);
  return found;
}

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/pause',
    tags: ['Flows'],
    summary: 'Pause a live Flow',
    description:
      'No new Members enrol and no step advances; runs keep their place and carry on when the Flow resumes.',
    request: { params: flowParam },
    responses: {
      200: ok(FlowSchema, 'Paused'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { access } = await moveStatus(
      c,
      flowId,
      ['live'],
      'paused',
      'Only a live automation can be paused.',
    );
    await audit(c, access, 'flow.paused', 'flow', flowId);
    return c.json({ data: await toFlow(c, flowId) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/resume',
    tags: ['Flows'],
    summary: 'Resume a paused Flow',
    request: { params: flowParam },
    responses: {
      200: ok(FlowSchema, 'Live again'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { access } = await moveStatus(
      c,
      flowId,
      ['paused'],
      'live',
      'This automation is not paused.',
    );
    // Runs the pause stopped (and runs paused by a failed step) carry on from where they were.
    const resumed = await resumeFlowRuns(flowsEnvFor(c), flowId);
    await audit(c, access, 'flow.resumed', 'flow', flowId, { runs: resumed });
    return c.json({ data: await toFlow(c, flowId) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/archive',
    tags: ['Flows'],
    summary: 'Archive a Flow',
    description:
      'Stops it for good: open runs exit (flow_archived), every version is retired and its Flow Broadcasts close. Archived Flows can be deleted.',
    request: { params: flowParam },
    responses: {
      200: ok(FlowSchema, 'Archived'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { access } = await moveStatus(
      c,
      flowId,
      ['draft', 'live', 'paused'],
      'archived',
      'This automation is already archived.',
    );
    const db = env(c).DB;
    const now = Date.now();
    const exited = await all<{ id: string }>(
      db,
      `UPDATE flow_runs SET status = 'exited', exit_reason = 'flow_archived', ended_at = ?1, updated_at = ?1,
              next_at = NULL, wait_json = NULL
        WHERE flow_id = ?2 AND status IN ('running', 'waiting', 'paused') RETURNING id`,
      now,
      flowId,
    );
    await run(
      db,
      'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND retired_at IS NULL',
      now,
      flowId,
    );
    await closeRetiredFlowBroadcasts(db, flowId, now);
    await audit(c, access, 'flow.archived', 'flow', flowId, { runsExited: exited.length });
    return c.json({ data: await toFlow(c, flowId) }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/webhook-secret',
    tags: ['Flows'],
    summary: 'Create or rotate the webhook signing secret',
    description:
      'Returns the new secret once; it is stored encrypted. webhook_call steps sign their requests with it from now on.',
    request: { params: flowParam },
    responses: {
      200: ok(FlowWebhookSecretSchema, 'New secret'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { access, flow } = await flowAccess(c, flowId, 'admin');
    notArchived(flow);
    const e = env(c);
    // Made and sealed by the vault; the plaintext is shown here once and never stored.
    const { secretOnce: secret, sealed } = vaultValue(
      await apiVault(c).createFlowWebhookSecret(credentialOf(c), { flowId }),
    );
    await run(
      e.DB,
      'UPDATE flows SET webhook_secret_enc = ?1, updated_at = ?2 WHERE id = ?3',
      sealed,
      Date.now(),
      flowId,
    );
    await audit(c, access, 'flow.webhook_secret_rotated', 'flow', flowId, {
      replaced: flow.webhook_secret_enc !== null,
    });
    return c.json({ data: { secret } }, 200, NO_STORE);
  },
);

// ---- Runs ------------------------------------------------------------------------------------

const RUN_COLUMNS = `r.*, m.email AS member_email, ${FLOW_RUN_HOLD_COLUMN}`;

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/test-run',
    tags: ['Flows'],
    summary: 'Start a test run for one Member',
    description:
      'Runs the live version for a Member of this Channel, marked as a test (left out of stats). The Flow must have been published. Sends follow the same checks as real runs, from the test run’s own copy of each email, so the Member’s real run and real emails are untouched.',
    request: { params: flowParam, body: jsonBody(FlowTestRunSchema) },
    responses: {
      202: ok(FlowRunSchema, 'Started'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const { memberId } = c.req.valid('json');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    notArchived(flow);
    if (flow.live_version === null) {
      throw new ApiError('conflict', 'Publish the automation before starting a test run.');
    }
    const db = env(c).DB;
    const member = await first(
      db,
      'SELECT 1 FROM members WHERE id = ?1 AND channel_id = ?2',
      memberId,
      flow.channel_id,
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
    const runId = await startFlowRun(flowsEnvFor(c), {
      flowId,
      version: flow.live_version,
      memberId,
      channelId: flow.channel_id,
      graph: JSON.parse(version!.graph_json) as FlowGraph,
      test: true,
      now: Date.now(),
    });
    if (!runId) throw new ApiError('conflict', 'This subscriber is already in this automation.');
    await audit(c, access, 'flow.test_run_started', 'flow', flowId, { runId, memberId });
    const row = await first<FlowRunRow & { member_email: string | null }>(
      db,
      `SELECT ${RUN_COLUMNS} FROM flow_runs r LEFT JOIN members m ON m.id = r.member_id WHERE r.id = ?1`,
      runId,
    );
    return c.json({ data: toFlowRun(row!) }, 202);
  },
);

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flows/{flowId}/runs',
    tags: ['Flows'],
    summary: 'Runs of a Flow, newest first',
    request: { params: flowParam, query: FlowRunListQuerySchema },
    responses: {
      200: ok(FlowRunPageSchema, 'Runs'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const query = c.req.valid('query');
    await flowAccess(c, flowId, 'viewer');
    const rows = await all<FlowRunRow & { member_email: string | null }>(
      env(c).DB,
      `SELECT ${RUN_COLUMNS} FROM flow_runs r LEFT JOIN members m ON m.id = r.member_id
        WHERE r.flow_id = ?1 AND (?2 IS NULL OR r.status = ?2) AND (?3 IS NULL OR r.version = ?3)
          AND (?4 IS NULL OR r.id < ?4)
        ORDER BY r.id DESC LIMIT ?5`,
      flowId,
      query.status ?? null,
      query.version ?? null,
      query.cursor ?? null,
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit).map(toFlowRun);
    const nextCursor = rows.length > query.limit ? (items[items.length - 1]?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

async function loadRun(db: D1Database, flowId: string, runId: string) {
  const row = await first<FlowRunRow & { member_email: string | null }>(
    db,
    `SELECT ${RUN_COLUMNS} FROM flow_runs r LEFT JOIN members m ON m.id = r.member_id
      WHERE r.id = ?1 AND r.flow_id = ?2`,
    runId,
    flowId,
  );
  if (!row) throw new ApiError('not_found', 'Run not found.');
  return row;
}

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flows/{flowId}/runs/{runId}',
    tags: ['Flows'],
    summary: 'One run with its steps',
    request: { params: runParams },
    responses: { 200: ok(FlowRunDetailSchema, 'Run'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { flowId, runId } = c.req.valid('param');
    await flowAccess(c, flowId, 'viewer');
    const db = env(c).DB;
    const row = await loadRun(db, flowId, runId);
    const steps = await all<{
      node_id: string;
      attempt: number;
      status: 'pending' | 'done' | 'failed' | 'skipped';
      outcome: string | null;
      error: string | null;
      started_at: number;
      finished_at: number | null;
    }>(
      db,
      `SELECT node_id, attempt, status, outcome, error, started_at, finished_at FROM flow_run_steps
        WHERE run_id = ?1 ORDER BY started_at, attempt`,
      runId,
    );
    const holds = await all<FlowHoldRow>(
      db,
      `SELECT node_id, reason, until, zone, held_at, released_at, outcome FROM flow_holds
        WHERE run_id = ?1 ORDER BY held_at`,
      runId,
    );
    return c.json(
      {
        data: {
          ...toFlowRun(row),
          holds: holds.map(toFlowRunHold),
          steps: steps.map((s) => ({
            nodeId: s.node_id,
            attempt: s.attempt,
            status: s.status,
            outcome: s.outcome,
            error: s.error,
            startedAt: toIso(s.started_at),
            finishedAt: s.finished_at === null ? null : toIso(s.finished_at),
          })),
        },
      },
      200,
    );
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/runs/{runId}/exit',
    tags: ['Flows'],
    summary: 'Stop a run',
    description: 'The run exits (reason operator); nothing further is sent to the Member.',
    request: { params: runParams },
    responses: {
      200: ok(FlowRunSchema, 'Exited'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId, runId } = c.req.valid('param');
    const { access } = await flowAccess(c, flowId, 'editor');
    const db = env(c).DB;
    await loadRun(db, flowId, runId);
    const now = Date.now();
    const exited = await first<{ id: string }>(
      db,
      `UPDATE flow_runs SET status = 'exited', exit_reason = 'operator', ended_at = ?1, updated_at = ?1,
              next_at = NULL, wait_json = NULL
        WHERE id = ?2 AND flow_id = ?3 AND status IN ('running', 'waiting', 'paused') RETURNING id`,
      now,
      runId,
      flowId,
    );
    if (!exited) throw new ApiError('conflict', 'This run has already ended.');
    await audit(c, access, 'flow.run_exited', 'flow', flowId, { runId });
    return c.json({ data: toFlowRun(await loadRun(db, flowId, runId)) }, 200);
  },
);

// ---- Rehearse --------------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/rehearse',
    tags: ['Flows'],
    summary: 'See what a Flow would do for a Member, with nothing sent or changed',
    description:
      'Takes the same decisions a real run takes, step by step, on the draft or the live version, for one Member or a random sample of a Circle. Nothing is written, sent or called: no run, no email, no webhook, no count, not even an audit entry. What it can’t know is an input: `answers` says whether they open or click at a wait and can pick an A/B arm, and `startEvent` picks which start event to imagine.',
    request: { params: flowParam, body: jsonBody(FlowRehearseSchema) },
    responses: {
      200: ok(FlowRehearsalResultSchema, 'What would happen'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { flow } = await flowAccess(c, flowId, 'editor');
    notArchived(flow);
    const e = env(c);
    const db = e.DB;
    const now = Date.now();

    let graph: FlowGraph | null;
    let version: number;
    if (input.source === 'live') {
      if (flow.live_version === null) {
        throw new ApiError('conflict', 'This automation has no live version yet.');
      }
      version = flow.live_version;
      graph = await loadVersionGraph(db, flowId, version);
    } else {
      // A draft is saved with whatever is unfinished in it. It reads like the version it would become.
      const newest = await first<{ v: number | null }>(
        db,
        'SELECT max(version) AS v FROM flow_versions WHERE flow_id = ?1',
        flowId,
      );
      version = (newest?.v ?? 0) + 1;
      const parsed = FlowGraphSchema.safeParse(parseDraft(flow));
      graph = parsed.success ? parsed.data : null;
    }
    if (!graph) throw new ApiError('conflict', 'This version of the automation can’t be read.');

    let memberIds: string[];
    let circleSize: number | null = null;
    if (input.circleId) {
      const circle = await first(
        db,
        'SELECT 1 AS ok FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
        input.circleId,
        flow.channel_id,
      );
      if (!circle) throw new ApiError('not_found', 'Segment not found.');
      const sample = await sampleCircle(
        db,
        flow.channel_id,
        input.circleId,
        FLOW_REHEARSAL_MAX_SAMPLE,
      );
      memberIds = sample.memberIds;
      circleSize = sample.circleSize;
    } else {
      const member = await first(
        db,
        'SELECT 1 AS ok FROM members WHERE id = ?1 AND channel_id = ?2',
        input.memberId,
        flow.channel_id,
      );
      if (!member) {
        throw new ApiError('invalid_input', 'That subscriber is not in this publication.', [
          { path: 'memberId', message: 'That subscriber is not in this publication.' },
        ]);
      }
      memberIds = [input.memberId as string];
    }

    const people = [];
    for (const memberId of memberIds) {
      people.push(
        await rehearseFlow(db, {
          flow,
          graph,
          source: input.source,
          version,
          memberId,
          now,
          // The run's vault opens encrypted fields and the webhook secret (jobs).
          hasFieldKeys: true,
          ...(input.answers ? { answers: input.answers } : {}),
          ...(input.startEvent === undefined ? {} : { startEvent: input.startEvent }),
        }),
      );
    }
    const pending = flow.draft_pending_json
      ? (JSON.parse(flow.draft_pending_json) as { nodes?: unknown[] })
      : null;
    return c.json(
      {
        data: {
          source: input.source,
          version: input.source === 'live' ? version : null,
          flowStatus: flow.status,
          pendingSteps: input.source === 'draft' ? (pending?.nodes?.length ?? 0) : 0,
          circleSize,
          people,
        },
      },
      200,
    );
  },
);

// ---- Add people ------------------------------------------------------------------------------

/** The live version people can be added to, and a selection known to be of this Channel. */
async function addPeopleScope(flow: FlowTableRow, selection: BulkSelection, db: D1Database) {
  if (flow.status !== 'live' || flow.live_version === null) {
    throw new ApiError('conflict', 'People can only be added to a live automation.');
  }
  if ('circleId' in selection) {
    const circle = await first(
      db,
      'SELECT 1 AS ok FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
      selection.circleId,
      flow.channel_id,
    );
    if (!circle) throw new ApiError('not_found', 'Segment not found.');
    return { version: flow.live_version, selection };
  }
  return {
    version: flow.live_version,
    selection: { memberIds: [...new Set(selection.memberIds)] } as BulkSelection,
  };
}

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/people/preview',
    tags: ['Flows'],
    summary: 'Count who would enter a live Flow, and why the others wouldn’t',
    description:
      'Applies the enrolment rules to a selection without changing anything: anyone who can’t be mailed, is already in the Flow, can’t enter it again, started it too often in the last hour, or matches none of its start event filters is left out, by reason.',
    request: { params: flowParam, body: jsonBody(FlowEnrolPreviewRequestSchema) },
    responses: {
      200: ok(FlowEnrolPreviewSchema, 'Who would enter'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { flow } = await flowAccess(c, flowId, 'editor');
    const db = env(c).DB;
    const { version, selection } = await addPeopleScope(flow, input.selection, db);
    const counts = await enrolmentCounts(db, flow, version, selection, Date.now());
    return c.json({ data: { version, ...counts } }, 200);
  },
);

flows.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/flows/{flowId}/people',
    tags: ['Flows'],
    summary: 'Add a selection of Members to a live Flow',
    description:
      'Starts a bulk job (see GET /api/v1/bulk-jobs/{jobId}). `confirmCount` is the `entering` number the operator agreed to; if the count has changed since, the answer is 409 and nothing starts. The rules are applied again to each Member as the job reaches them. Each run then behaves like any other: its emails recheck the Member and obey the inbox rules.',
    request: { params: flowParam, body: jsonBody(FlowEnrolStartSchema) },
    responses: {
      202: ok(BulkJobSchema, 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { access, flow } = await flowAccess(c, flowId, 'editor');
    const e = env(c);
    const { version, selection } = await addPeopleScope(flow, input.selection, e.DB);
    if (!roleAtLeast(access.role, 'admin')) {
      const graph = await loadVersionGraph(e.DB, flowId, version);
      if (graph && (await graphGrantsLevel(e.DB, graph))) {
        requireGrantRole(
          access,
          'Only an admin can add people to a Flow that gives a Membership level for free.',
        );
      }
    }
    const now = Date.now();
    const counts = await enrolmentCounts(e.DB, flow, version, selection, now);
    if (counts.entering !== input.confirmCount) {
      throw new ApiError(
        'conflict',
        `The count has changed: ${counts.entering} would enter now. Check it and confirm again.`,
      );
    }
    const id = newId('bulkJob', now);
    await run(
      e.DB,
      `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, params_json, selection_json, total, created_by, created_at)
       VALUES (?1, ?2, ?3, 'flow_enrol', ?4, ?5, ?6, ?7, ?8)`,
      id,
      access.workspaceId,
      flow.channel_id,
      JSON.stringify({ flowId }),
      JSON.stringify(selection),
      counts.total,
      access.auth.operatorId,
      now,
    );
    await flowsEnvFor(c).JOBS_QUEUE.send({ type: 'bulk', jobId: id });
    await audit(c, access, 'flow.people_added', 'flow', flowId, {
      jobId: id,
      version,
      total: counts.total,
      entering: counts.entering,
      skipped: Object.fromEntries(counts.skipped.map((s) => [s.reason, s.count])),
      ...('circleId' in selection ? { circleId: selection.circleId } : {}),
    });
    const row = await first<BulkJobRow>(
      e.DB,
      `SELECT channel_id, ${BULK_COLUMNS} FROM bulk_jobs WHERE id = ?1`,
      id,
    );
    return c.json({ data: toBulkJob(row as BulkJobRow) }, 202);
  },
);

// ---- Stats -----------------------------------------------------------------------------------

flows.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/flows/{flowId}/stats',
    tags: ['Flows'],
    summary: 'Per-node and per-edge numbers for one version',
    description:
      'For each start event: the runs it started. For each node: runs that entered, completed, exited there and failed; email steps add their Flow Broadcast’s metrics. Each edge has the runs that took it and the drop-off from its source node. Test runs are left out.',
    request: { params: flowParam, query: FlowStatsQuerySchema },
    responses: {
      200: ok(FlowStatsSchema, 'Stats'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { flowId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { flow } = await flowAccess(c, flowId, 'viewer');
    const db = env(c).DB;
    const versionNo =
      query.version ??
      flow.live_version ??
      (
        await first<{ v: number | null }>(
          db,
          'SELECT max(version) AS v FROM flow_versions WHERE flow_id = ?1',
          flowId,
        )
      )?.v ??
      null;
    if (versionNo === null) {
      return c.json({ data: { version: null, triggers: [], nodes: [], edges: [] } }, 200);
    }
    const version = await first<{ graph_json: string }>(
      db,
      'SELECT graph_json FROM flow_versions WHERE flow_id = ?1 AND version = ?2',
      flowId,
      versionNo,
    );
    if (!version) throw new ApiError('not_found', 'Version not found.');
    const graph = JSON.parse(version.graph_json) as FlowGraph;
    const notTest = `run_id NOT IN (SELECT id FROM flow_runs WHERE flow_id = ?1 AND version = ?2 AND test = 1)`;
    const steps = await all<{
      node_id: string;
      entered: number;
      completed: number;
      failed: number;
    }>(
      db,
      `SELECT node_id, count(DISTINCT run_id) AS entered,
              count(DISTINCT CASE WHEN status IN ('done', 'skipped') THEN run_id END) AS completed,
              count(DISTINCT CASE WHEN status = 'failed' THEN run_id END) AS failed
         FROM flow_run_steps WHERE flow_id = ?1 AND version = ?2 AND ${notTest}
        GROUP BY node_id`,
      flowId,
      versionNo,
    );
    const exits = await all<{ node_id: string; n: number }>(
      db,
      `SELECT current_node_id AS node_id, count(*) AS n FROM flow_runs
        WHERE flow_id = ?1 AND version = ?2 AND status = 'exited' AND test = 0 GROUP BY current_node_id`,
      flowId,
      versionNo,
    );
    const taken = await all<{ f: string; l: string; runs: number }>(
      db,
      `WITH e AS (SELECT json_extract(value, '$[0]') AS f, json_extract(value, '$[1]') AS l
                    FROM json_each(?3))
       SELECT e.f, e.l, count(DISTINCT s.run_id) AS runs
         FROM e JOIN flow_run_steps s
           ON s.flow_id = ?1 AND s.version = ?2 AND s.node_id = e.f AND s.status = 'done'
          AND s.outcome = e.l AND s.${notTest}
        GROUP BY e.f, e.l`,
      flowId,
      versionNo,
      JSON.stringify(graph.edges.map((e) => [e.from, e.label])),
    );
    const emails = await all<{ node_id: string; broadcast_id: string }>(
      db,
      'SELECT node_id, broadcast_id FROM flow_emails WHERE flow_id = ?1 AND version = ?2',
      flowId,
      versionNo,
    );
    const holds = await all<{ node_id: string; now: number; total: number; expired: number }>(
      db,
      `SELECT h.node_id, count(*) AS total,
              coalesce(sum(CASE WHEN h.released_at IS NULL AND h.node_id = r.current_node_id
                                 AND r.status IN ('running', 'waiting', 'paused') THEN 1 ELSE 0 END), 0) AS now,
              coalesce(sum(CASE WHEN h.outcome = 'expired' THEN 1 ELSE 0 END), 0) AS expired
         FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
        WHERE h.flow_id = ?1 AND h.version = ?2 GROUP BY h.node_id`,
      flowId,
      versionNo,
    );
    const heldBy = new Map(holds.map((h) => [h.node_id, h]));
    // A run from before there could be several start events has no index: it is the first one's.
    const started = await all<{ trigger_index: number; n: number }>(
      db,
      `SELECT coalesce(json_extract(context_json, '$.trigger.index'), 0) AS trigger_index, count(*) AS n
         FROM flow_runs
        WHERE flow_id = ?1 AND version = ?2 AND test = 0
          AND json_extract(context_json, '$.trigger.type') IS NOT NULL
        GROUP BY trigger_index`,
      flowId,
      versionNo,
    );
    const startedBy = new Map(started.map((s) => [s.trigger_index, s.n]));
    const triggers = triggersOf(graph).map((config, index) => ({
      index,
      config,
      runs: startedBy.get(index) ?? 0,
    }));
    const byNode = new Map(steps.map((s) => [s.node_id, s]));
    const exitsBy = new Map(exits.map((x) => [x.node_id, x.n]));
    const emailBy = new Map(emails.map((x) => [x.node_id, x.broadcast_id]));
    const nodes = [];
    for (const node of graph.nodes) {
      const s = byNode.get(node.id);
      const broadcastId = emailBy.get(node.id);
      nodes.push({
        nodeId: node.id,
        type: node.type,
        entered: s?.entered ?? 0,
        completed: s?.completed ?? 0,
        exited: exitsBy.get(node.id) ?? 0,
        failed: s?.failed ?? 0,
        held: {
          now: heldBy.get(node.id)?.now ?? 0,
          total: heldBy.get(node.id)?.total ?? 0,
          expired: heldBy.get(node.id)?.expired ?? 0,
        },
        email: broadcastId ? { ...(await broadcastStats(db, broadcastId)), broadcastId } : null,
      });
    }
    const takenBy = new Map(taken.map((t) => [`${t.f}\u0000${t.l}`, t.runs]));
    const edges = graph.edges.map((e) => {
      const runs = takenBy.get(`${e.from}\u0000${e.label}`) ?? 0;
      const entered = byNode.get(e.from)?.entered ?? 0;
      return {
        from: e.from,
        to: e.to,
        label: e.label,
        runs,
        dropOff: entered > 0 ? Math.round((1 - runs / entered) * 10_000) / 10_000 : 0,
      };
    });
    return c.json({ data: { version: versionNo, triggers, nodes, edges } }, 200);
  },
);
