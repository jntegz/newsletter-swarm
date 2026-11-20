// Community Flow Recipes (Phase 8.12, App Directory): an editor shares one of the Channel's Flows
// as a sanitised recipe (no ids, addresses, URLs or secrets of the Channel), staff review it in
// the App Directory queue, and approved recipes are offered next to the built-in Flow Recipes.
// Flag app_directory, per Channel. Contract: docs/app-directory.md.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  CommunityRecipeInfoSchema,
  CreateRecipeSubmissionSchema,
  FlowGraphSchema,
  RecipeSubmissionSchema,
  idPattern,
  newId,
  type CommunityRecipeGraph,
  type DispatchDocument,
} from '@swarm/domain';
import {
  loadFlowRow,
  recipeSetupSteps,
  recipeToFlowDraft,
  sanitizeFlowRecipe,
  type FlowEmailSource,
  resolveSnippetsJson,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { DIRECTORY_OFF, toSubmission, type RecipeRow } from '../lib/appDirectory';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { rawHtmlAllowed } from '../lib/send';
import { audit, requireFlag } from '../lib/site';
import { createDispatchRow } from './dispatches';

export const recipeSubmissions = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const submissionParams = channelParam.extend(
  idParam('submissionId', idPattern('recipeSubmission')).shape,
);
const recipeParams = channelParam.extend(idParam('recipeId', idPattern('recipeSubmission')).shape);

type Access = Awaited<ReturnType<typeof requireChannel>>;

async function recipeAccess(c: AppContext, channelId: string, minimum: 'viewer' | 'editor') {
  const access = await requireChannel(c, channelId, minimum);
  await requireFlag(c, access, 'app_directory', DIRECTORY_OFF);
  return access;
}

/** A submission made from this Channel. */
async function loadSubmission(c: AppContext, channelId: string, id: string): Promise<RecipeRow> {
  const row = await first<RecipeRow>(
    env(c).DB,
    'SELECT * FROM recipe_submissions WHERE id = ?1 AND channel_id = ?2',
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Recipe not found.');
  return row;
}

/** An approved recipe, from any workspace. */
async function loadApproved(c: AppContext, id: string): Promise<RecipeRow> {
  const row = await first<RecipeRow>(
    env(c).DB,
    "SELECT * FROM recipe_submissions WHERE id = ?1 AND status = 'approved'",
    id,
  );
  if (!row) throw new ApiError('not_found', 'Recipe not found.');
  return row;
}

// ---- Sharing a Flow --------------------------------------------------------------------------

recipeSubmissions.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/recipe-submissions',
    tags: ['App Directory'],
    summary: 'Flows this Channel shared as community recipes',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(RecipeSubmissionSchema), 'Submissions, newest first'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await recipeAccess(c, channelId, 'viewer');
    const rows = await all<RecipeRow>(
      env(c).DB,
      'SELECT * FROM recipe_submissions WHERE channel_id = ?1 ORDER BY created_at DESC LIMIT 200',
      channelId,
    );
    return c.json({ data: rows.map(toSubmission) }, 200);
  },
);

recipeSubmissions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/recipe-submissions',
    tags: ['App Directory'],
    summary: 'Share a Flow as a community recipe (draft)',
    description:
      'Copies the Flow’s draft graph and emails without anything specific to this Channel; `removed` lists what was taken out. The Flow must have an email step and no issues or unfinished steps.',
    request: { params: channelParam, body: jsonBody(CreateRecipeSubmissionSchema) },
    responses: {
      201: ok(RecipeSubmissionSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await recipeAccess(c, channelId, 'editor');
    const db = env(c).DB;
    const flow = await loadFlowRow(db, input.flowId);
    if (!flow || flow.channel_id !== channelId)
      throw new ApiError('not_found', 'Automation not found.');
    if (flow.draft_pending_json) {
      throw new ApiError('conflict', 'Finish setting up the automation’s steps first.');
    }
    const parsed = FlowGraphSchema.safeParse(JSON.parse(flow.draft_graph_json));
    if (!parsed.success) throw new ApiError('conflict', 'Fix the automation’s issues first.');
    if (!parsed.data.nodes.some((n) => n.type === 'send_email')) {
      throw new ApiError('conflict', 'A recipe needs at least one email step.');
    }
    const rows = await all<{
      id: string;
      subject: string;
      preheader: string;
      content_json: string;
    }>(
      db,
      "SELECT id, subject, preheader, content_json FROM dispatches WHERE flow_id = ?1 AND kind = 'flow'",
      flow.id,
    );
    // A recipe leaves this Channel, so linked snippets travel as their content.
    const emails = new Map<string, FlowEmailSource>(
      await Promise.all(
        rows.map(
          async (r) =>
            [
              r.id,
              {
                subject: r.subject,
                preheader: r.preheader,
                content: JSON.parse(
                  await resolveSnippetsJson(db, channelId, r.content_json),
                ) as DispatchDocument,
              },
            ] as const,
        ),
      ),
    );
    const { recipe, removed } = sanitizeFlowRecipe({
      graph: parsed.data,
      reentry: flow.reentry,
      emails,
    });
    const now = Date.now();
    const id = newId('recipeSubmission', now);
    await run(
      db,
      `INSERT INTO recipe_submissions (id, workspace_id, channel_id, flow_id, status, name, description,
         trigger_type, email_count, setup_steps, recipe_json, removed_json, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
      id,
      access.workspaceId,
      channelId,
      flow.id,
      input.name,
      input.description,
      recipe.triggerType,
      recipe.emails.length,
      recipeSetupSteps(recipe),
      JSON.stringify(recipe),
      JSON.stringify(removed),
      access.auth.operatorId,
      now,
    );
    await audit(c, access, 'recipe_submission.created', 'recipe_submission', id, {
      flowId: flow.id,
    });
    return c.json({ data: toSubmission(await loadSubmission(c, channelId, id)) }, 201);
  },
);

async function move(
  c: AppContext,
  access: Access,
  row: RecipeRow,
  next: RecipeRow['status'],
  action: string,
) {
  const now = Date.now();
  const result = await run(
    env(c).DB,
    `UPDATE recipe_submissions SET status = ?1, updated_at = ?2,
       submitted_at = CASE WHEN ?1 = 'submitted' THEN ?2 ELSE submitted_at END,
       review_note = CASE WHEN ?1 = 'submitted' THEN NULL ELSE review_note END
     WHERE id = ?3 AND status = ?4`,
    next,
    now,
    row.id,
    row.status,
  );
  if (!result.meta.changes) throw new ApiError('conflict', 'The recipe changed. Reload it.');
  await audit(c, access, action, 'recipe_submission', row.id, { from: row.status });
}

recipeSubmissions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/recipe-submissions/{submissionId}/submit',
    tags: ['App Directory'],
    summary: 'Send a community recipe for review',
    request: { params: submissionParams },
    responses: {
      200: ok(RecipeSubmissionSchema, 'Submitted'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, submissionId } = c.req.valid('param');
    const access = await recipeAccess(c, channelId, 'editor');
    const row = await loadSubmission(c, channelId, submissionId);
    if (!['draft', 'rejected', 'delisted'].includes(row.status)) {
      throw new ApiError('conflict', 'Only a draft, rejected or delisted recipe can be submitted.');
    }
    await move(c, access, row, 'submitted', 'recipe_submission.submitted');
    return c.json({ data: toSubmission(await loadSubmission(c, channelId, submissionId)) }, 200);
  },
);

recipeSubmissions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/recipe-submissions/{submissionId}/withdraw',
    tags: ['App Directory'],
    summary: 'Withdraw a community recipe from review or from the gallery',
    description: 'A submitted recipe returns to draft; an approved one is delisted.',
    request: { params: submissionParams },
    responses: {
      200: ok(RecipeSubmissionSchema, 'Withdrawn'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, submissionId } = c.req.valid('param');
    const access = await recipeAccess(c, channelId, 'editor');
    const row = await loadSubmission(c, channelId, submissionId);
    const next = ({ submitted: 'draft', approved: 'delisted' } as const)[
      row.status as 'submitted' | 'approved'
    ];
    if (!next)
      throw new ApiError('conflict', 'Only a submitted or approved recipe can be withdrawn.');
    await move(c, access, row, next, 'recipe_submission.withdrawn');
    return c.json({ data: toSubmission(await loadSubmission(c, channelId, submissionId)) }, 200);
  },
);

recipeSubmissions.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/recipe-submissions/{submissionId}',
    tags: ['App Directory'],
    summary: 'Delete a community recipe',
    description: 'Flows already made from it are not affected.',
    request: { params: submissionParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, submissionId } = c.req.valid('param');
    const access = await recipeAccess(c, channelId, 'editor');
    const row = await loadSubmission(c, channelId, submissionId);
    await run(env(c).DB, 'DELETE FROM recipe_submissions WHERE id = ?1', submissionId);
    await audit(c, access, 'recipe_submission.deleted', 'recipe_submission', submissionId, {
      status: row.status,
    });
    return c.body(null, 204);
  },
);

// ---- Using an approved recipe ----------------------------------------------------------------

const toInfo = (row: RecipeRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  triggerType: row.trigger_type as z.infer<typeof CommunityRecipeInfoSchema>['triggerType'],
  emailCount: row.email_count,
  setupSteps: row.setup_steps,
  approvedAt: toIso(row.reviewed_at ?? row.updated_at),
});

recipeSubmissions.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/community-recipes',
    tags: ['App Directory'],
    summary: 'Approved community Flow Recipes',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(CommunityRecipeInfoSchema), 'Recipes, newest approval first'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await recipeAccess(c, channelId, 'viewer');
    const rows = await all<RecipeRow>(
      env(c).DB,
      `SELECT * FROM recipe_submissions WHERE status = 'approved'
        ORDER BY reviewed_at DESC, id LIMIT 200`,
    );
    return c.json({ data: rows.map(toInfo) }, 200);
  },
);

recipeSubmissions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/community-recipes/{recipeId}/flows',
    tags: ['App Directory'],
    summary: 'Create a draft Flow from a community recipe',
    description:
      'The recipe’s emails become Flow emails; steps that need this Channel’s own settings (a tag, a Circle, a webhook address…) are saved as pending steps to finish in the builder.',
    request: { params: recipeParams },
    responses: {
      201: ok(z.object({ id: z.string() }), 'The new Flow'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, recipeId } = c.req.valid('param');
    const access = await recipeAccess(c, channelId, 'editor');
    const row = await loadApproved(c, recipeId);
    const recipe = JSON.parse(row.recipe_json) as CommunityRecipeGraph;
    const db = env(c).DB;
    const now = Date.now();
    const id = newId('flow', now);
    await run(
      db,
      `INSERT INTO flows (id, workspace_id, channel_id, name, description, status, recipe, draft_graph_json, reentry,
         created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', NULL, ?6, ?7, ?8, ?9, ?9)`,
      id,
      access.workspaceId,
      channelId,
      row.name,
      row.description,
      JSON.stringify({ schema: 1, nodes: [], edges: [] }),
      recipe.reentry,
      access.auth.operatorId,
      now,
    );
    const allowHtml = await rawHtmlAllowed(c, access);
    const ids: Record<string, string> = {};
    for (const email of recipe.emails) {
      ids[email.key] = await createDispatchRow(c, access, {
        subject: email.subject,
        preheader: email.preheader,
        content: email.content,
        allowHtml,
        kind: 'flow',
        flowId: id,
        lenient: true,
      });
    }
    const draft = recipeToFlowDraft(recipe, ids);
    await run(
      db,
      'UPDATE flows SET draft_graph_json = ?1, draft_pending_json = ?2 WHERE id = ?3',
      JSON.stringify(draft.graph),
      draft.pending ? JSON.stringify(draft.pending) : null,
      id,
    );
    await audit(c, access, 'flow.created', 'flow', id, { communityRecipe: recipeId });
    return c.json({ data: { id } }, 201);
  },
);
