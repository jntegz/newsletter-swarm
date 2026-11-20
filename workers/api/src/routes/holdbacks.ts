// Phase 6 send options on a Dispatch before it goes out: Split Tests (flag split_tests), Cohort
// Sampling (flag cohort_sampling), and the "as Member X" preview of Smart Blocks (flag
// smart_blocks). The engine side is packages/engine/src/holdback.ts and smartblocks.ts.
import { createRoute, z } from '@hono/zod-openapi';
import { first } from '@swarm/db';
import {
  CohortSampleSchema,
  DispatchPreviewSchema,
  PutCohortSampleSchema,
  PutSplitTestSchema,
  SPLIT_TEST_LABELS,
  SavedCohortSampleSchema,
  SavedSplitTestSchema,
  SplitTestSchema,
  idPattern,
  newId,
  type SplitTestVariantInput,
} from '@swarm/domain';
import {
  cohortSampleView,
  loadCohortSample,
  loadSplitTest,
  pendingCohortSample,
  pendingSplitTest,
  coverOf,
  renderForWorkspace,
  smartBlockVisibility,
  splitTestView,
  splitsByEntitlement,
  webUrlFor,
  type DispatchRow,
} from '@swarm/engine';
import { personalize, RenderError, smartBlocksOf } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { sessionActor } from '../lib/actor';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import {
  checkBlockVisibility,
  checkSnippets,
  editorDecisionsUndone,
  engine,
  rawHtmlAllowed,
  requireOwned,
  undoEditorDecisions,
} from '../lib/send';
import { requireFlag } from '../lib/site';

export const holdbacks = createRouter();

const dispatchParam = idParam('dispatchId', idPattern('dispatch'));
const EDITABLE = new Set(['draft', 'scheduled']);

type Access = Awaited<ReturnType<typeof requireOwned>>;

async function loadDispatch(db: D1Database, id: string) {
  const row = await first<DispatchRow & { kind: string }>(
    db,
    'SELECT * FROM dispatches WHERE id = ?1',
    id,
  );
  if (!row) throw new ApiError('not_found', 'Post not found.');
  return row;
}

/** Split Tests and Cohort Samples are set up on a Broadcast's Dispatch before it is sent. */
function assertConfigurable(dispatch: DispatchRow & { kind: string }, what: string) {
  if (dispatch.kind !== 'broadcast') {
    throw new ApiError(
      'conflict',
      `A ${what} is set up on a post you send, not on an automation email.`,
    );
  }
  if (!EDITABLE.has(dispatch.status)) {
    throw new ApiError('conflict', `A ${dispatch.status} post can’t change its ${what}.`);
  }
}

const invalid = (path: string, message: string) =>
  new ApiError('invalid_input', message, [{ path, message }]);

async function audit(c: AppContext, access: Access, action: string, dispatchId: string) {
  await appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType: 'dispatch',
    targetId: dispatchId,
    ipPrefix: ipPrefix(clientIp(c)),
  });
}

/** Renders an editor document for this Channel the way a send would, or refuses it. */
async function renderChecked(
  c: AppContext,
  access: Access,
  dispatch: DispatchRow,
  content: unknown,
  path: string,
) {
  const e = env(c);
  const channel = (await first<{ workspace_id: string; name: string; branding_json: string }>(
    e.DB,
    'SELECT workspace_id, name, branding_json FROM channels WHERE id = ?1',
    dispatch.channel_id,
  ))!;
  const branding = JSON.parse(channel.branding_json) as { accentColor?: string | null };
  try {
    return await renderForWorkspace({
      db: e.DB,
      workspaceId: channel.workspace_id,
      channelName: channel.name,
      accentColor: branding.accentColor ?? null,
      preheader: dispatch.preheader,
      content,
      cover: coverOf(dispatch),
      mediaOrigin: engine(c).mediaOrigin,
      allowHtmlBlocks: await rawHtmlAllowed(c, access),
    });
  } catch (error) {
    if (error instanceof RenderError) throw invalid(path, error.message);
    throw error;
  }
}

// ---- Split Tests ---------------------------------------------------------------------------

holdbacks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/split-test',
    tags: ['Split Tests'],
    summary: 'A Dispatch’s Split Test, with results per variant',
    description:
      'While the test runs, results count human opens, clicks or goal events of the test part so far; once decided, as they were at the decision (decision in winnerVariantId).',
    request: { params: dispatchParam },
    responses: {
      200: ok(SplitTestSchema, 'Split Test'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    await requireFlag(c, access, 'split_tests', 'Split tests are off for this publication.');
    const loaded = await loadSplitTest(env(c).DB, dispatchId);
    if (!loaded) throw new ApiError('not_found', 'This post has no split test.');
    return c.json({ data: await splitTestView(env(c).DB, loaded.test) }, 200);
  },
);

/** Checks the variants against the test's variable and the Dispatch. Returns them as stored. */
async function variantRows(
  c: AppContext,
  access: Access,
  dispatch: DispatchRow,
  variable: 'subject' | 'content',
  variants: SplitTestVariantInput[],
) {
  const [a, ...others] = variants;
  if (a && Object.values(a).some((value) => value !== undefined)) {
    throw invalid('variants.0', 'Variant A is the post as written. Edit the post to change it.');
  }
  const gated = splitsByEntitlement(dispatch);
  if (variable === 'content' && gated) {
    throw invalid(
      'variable',
      'Content split tests can’t run on a paid post with a paywall break. Test the subject instead.',
    );
  }
  const rows: { subject: string | null; preheader: string | null; content: string | null }[] = [
    { subject: null, preheader: null, content: null },
  ];
  for (const [i, variant] of others.entries()) {
    const path = `variants.${i + 1}`;
    if (variable === 'subject') {
      if (!variant.subject) throw invalid(`${path}.subject`, 'Give this variant a subject.');
      if (variant.content) throw invalid(`${path}.content`, 'A subject test keeps the content.');
      if (gated && variant.preheader !== undefined && variant.preheader !== dispatch.preheader) {
        throw invalid(
          `${path}.preheader`,
          'A paid post with a paywall break can only test its subject.',
        );
      }
      rows.push({
        subject: variant.subject,
        preheader: variant.preheader ?? null,
        content: null,
      });
    } else {
      if (!variant.content) throw invalid(`${path}.content`, 'Give this variant its content.');
      if (variant.subject || variant.preheader !== undefined) {
        throw invalid(`${path}.subject`, 'A content test keeps the subject and preview text.');
      }
      if (smartBlocksOf(variant.content).length) {
        throw invalid(
          `${path}.content`,
          'Only variant A (the post) can have Smart blocks. Remove them from this variant.',
        );
      }
      await checkSnippets(c, access, variant.content);
      await checkBlockVisibility(c, access, variant.content);
      await renderChecked(c, access, dispatch, variant.content, `${path}.content`);
      const json = JSON.stringify(variant.content);
      if (json.length > 512 * 1024) throw invalid(`${path}.content`, 'This variant is too large.');
      rows.push({ subject: null, preheader: null, content: json });
    }
  }
  return rows;
}

holdbacks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/dispatches/{dispatchId}/split-test',
    tags: ['Split Tests'],
    summary: 'Set up a Split Test',
    description:
      'Before sending. Set up by an author on a scheduled Dispatch, it takes the Dispatch back to draft (unscheduled: true) for an editor to schedule again. When the send starts, testPercent of the audience is split evenly across the variants (by a hash of each Member, so the split is stable), and the rest is held back. After windowMinutes, once the test part has gone out, the variant with the best rate of human opens, clicks or goal events wins (ties: more delivered, then the earlier label) and the held Members get it. Content tests are refused for paid Dispatches with a gate divider. A Dispatch can have a Split Test or a Cohort Sample, not both (409).',
    request: { params: dispatchParam, body: jsonBody(PutSplitTestSchema) },
    responses: {
      200: ok(SavedSplitTestSchema, 'Saved'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    await requireFlag(c, access, 'split_tests', 'Split tests are off for this publication.');
    const db = env(c).DB;
    const dispatch = await loadDispatch(db, dispatchId);
    assertConfigurable(dispatch, 'split test');
    const sample = await loadCohortSample(db, dispatchId);
    if (sample) {
      throw new ApiError(
        'conflict',
        'A post can have a split test or a cohort sample, not both. Remove the cohort sample first.',
      );
    }
    const existing = await loadSplitTest(db, dispatchId);
    if (existing && !pendingSplitTest(existing.test)) {
      throw new ApiError('conflict', 'This split test has already run.');
    }
    if (input.metric === 'goal') {
      if (!input.goal) throw invalid('goal', 'Choose the goal that counts as a conversion.');
      if (input.goal.levelId) {
        const level = await first(
          db,
          'SELECT 1 FROM membership_levels WHERE id = ?1 AND channel_id = ?2',
          input.goal.levelId,
          dispatch.channel_id,
        );
        if (!level) throw invalid('goal.levelId', 'Choose a paid plan of this publication.');
      }
    } else if (input.goal) {
      throw invalid('goal', 'A goal applies only to the goal metric.');
    }
    const rows = await variantRows(c, access, dispatch, input.variable, input.variants);

    const now = Date.now();
    const id = existing?.test.id ?? newId('splitTest', now);
    const goal = input.metric === 'goal' && input.goal ? JSON.stringify(input.goal) : null;
    // The variants are part of what goes out, so an author's test unschedules (undoEditorDecisions).
    const undo = undoEditorDecisions(db, dispatchId, access.role, { email: true, page: false });
    const results = await db.batch([
      ...undo,
      existing
        ? db
            .prepare(
              `UPDATE split_tests SET variable = ?1, test_percent = ?2, metric = ?3, goal_json = ?4,
                      window_minutes = ?5, status = 'draft', broadcast_id = NULL, winner_variant_id = NULL,
                      decision_json = NULL, started_at = NULL, decide_at = NULL, decided_at = NULL, updated_at = ?6
                WHERE id = ?7 AND status IN ('draft', 'canceled')`,
            )
            .bind(
              input.variable,
              input.testPercent,
              input.metric,
              goal,
              input.windowMinutes,
              now,
              id,
            )
        : db
            .prepare(
              `INSERT INTO split_tests (id, channel_id, dispatch_id, variable, test_percent, metric, goal_json,
                 window_minutes, status, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'draft', ?9, ?9)`,
            )
            .bind(
              id,
              dispatch.channel_id,
              dispatchId,
              input.variable,
              input.testPercent,
              input.metric,
              goal,
              input.windowMinutes,
              now,
            ),
      db.prepare('DELETE FROM split_test_variants WHERE split_test_id = ?1').bind(id),
      ...rows.map((row, i) =>
        db
          .prepare(
            `INSERT INTO split_test_variants (id, split_test_id, label, subject, preheader, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            newId('splitTestVariant', now),
            id,
            SPLIT_TEST_LABELS[i],
            row.subject,
            row.preheader,
            row.content,
            now,
          ),
      ),
    ]);
    const { unscheduled } = await editorDecisionsUndone(
      db,
      sessionActor(c, access),
      dispatchId,
      results.slice(0, undo.length),
    );
    await audit(c, access, 'split_test.saved', dispatchId);
    const saved = (await loadSplitTest(db, dispatchId))!;
    const view = await splitTestView(db, saved.test);
    return c.json({ data: unscheduled ? { ...view, unscheduled } : view }, 200);
  },
);

holdbacks.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/dispatches/{dispatchId}/split-test',
    tags: ['Split Tests'],
    summary: 'Remove a Split Test before sending',
    description:
      'Removed by an author from a scheduled Dispatch, it takes the Dispatch back to draft for an editor to schedule again.',
    request: { params: dispatchParam },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    await requireFlag(c, access, 'split_tests', 'Split tests are off for this publication.');
    const db = env(c).DB;
    const loaded = await loadSplitTest(db, dispatchId);
    if (!loaded) throw new ApiError('not_found', 'This post has no split test.');
    if (!pendingSplitTest(loaded.test)) {
      throw new ApiError('conflict', 'A split test that has run is kept with its results.');
    }
    // Removing the variants changes what goes out, so an author's removal unschedules too.
    const undo = undoEditorDecisions(db, dispatchId, access.role, { email: true, page: false });
    const results = await db.batch([
      ...undo,
      db
        .prepare(`DELETE FROM split_tests WHERE id = ?1 AND status IN ('draft', 'canceled')`)
        .bind(loaded.test.id),
    ]);
    await editorDecisionsUndone(db, sessionActor(c, access), dispatchId, results);
    await audit(c, access, 'split_test.deleted', dispatchId);
    return c.body(null, 204);
  },
);

// ---- Cohort Sampling -----------------------------------------------------------------------

holdbacks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/cohort-sample',
    tags: ['Cohort Sampling'],
    summary: 'A Dispatch’s Cohort Sample and its health',
    request: { params: dispatchParam },
    responses: {
      200: ok(CohortSampleSchema, 'Cohort Sample'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    await requireFlag(c, access, 'cohort_sampling', 'Cohort sampling is off for this publication.');
    const sample = await loadCohortSample(env(c).DB, dispatchId);
    if (!sample) throw new ApiError('not_found', 'This post has no cohort sample.');
    return c.json({ data: await cohortSampleView(env(c).DB, sample) }, 200);
  },
);

holdbacks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/dispatches/{dispatchId}/cohort-sample',
    tags: ['Cohort Sampling'],
    summary: 'Send to a sample first',
    description:
      'Set up by an author on a scheduled Dispatch, it takes the Dispatch back to draft (unscheduled: true) for an editor to schedule again. When the send starts, samplePercent of the audience (by a hash of each Member) gets it first and the rest is held back. After windowMinutes, once the sample has gone out, the rest is sent if the sample stayed within the thresholds (rates of delivered messages; bounces of sent ones); otherwise the send halts, the held Members stay unsent and the workspace owners and admins are emailed. Omitted fields take the defaults. A Dispatch can have a Split Test or a Cohort Sample, not both (409).',
    request: { params: dispatchParam, body: jsonBody(PutCohortSampleSchema) },
    responses: {
      200: ok(SavedCohortSampleSchema, 'Saved'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    await requireFlag(c, access, 'cohort_sampling', 'Cohort sampling is off for this publication.');
    const db = env(c).DB;
    const dispatch = await loadDispatch(db, dispatchId);
    assertConfigurable(dispatch, 'cohort sample');
    if (await loadSplitTest(db, dispatchId)) {
      throw new ApiError(
        'conflict',
        'A post can have a split test or a cohort sample, not both. Remove the split test first.',
      );
    }
    const existing = await loadCohortSample(db, dispatchId);
    if (existing && !pendingCohortSample(existing)) {
      throw new ApiError('conflict', 'This cohort sample has already run.');
    }
    const now = Date.now();
    // The thresholds decide who gets it, so an author's sample unschedules (undoEditorDecisions).
    const undo = undoEditorDecisions(db, dispatchId, access.role, { email: true, page: false });
    const results = await db.batch([
      ...undo,
      db
        .prepare(
          `INSERT INTO cohort_samples (id, channel_id, dispatch_id, sample_percent, window_minutes, min_open_rate,
           max_bounce_rate, max_complaint_rate, max_unsubscribe_rate, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?10)
         ON CONFLICT (dispatch_id) DO UPDATE SET
           sample_percent = excluded.sample_percent, window_minutes = excluded.window_minutes,
           min_open_rate = excluded.min_open_rate, max_bounce_rate = excluded.max_bounce_rate,
           max_complaint_rate = excluded.max_complaint_rate, max_unsubscribe_rate = excluded.max_unsubscribe_rate,
           status = 'draft', broadcast_id = NULL, metrics_json = NULL, decide_at = NULL, decided_at = NULL,
           updated_at = excluded.updated_at
         WHERE cohort_samples.status IN ('draft', 'canceled')`,
        )
        .bind(
          existing?.id ?? newId('cohortSample', now),
          dispatch.channel_id,
          dispatchId,
          input.samplePercent,
          input.windowMinutes,
          input.minOpenRate,
          input.maxBounceRate,
          input.maxComplaintRate,
          input.maxUnsubscribeRate,
          now,
        ),
    ]);
    const { unscheduled } = await editorDecisionsUndone(
      db,
      sessionActor(c, access),
      dispatchId,
      results.slice(0, undo.length),
    );
    await audit(c, access, 'cohort_sample.saved', dispatchId);
    const saved = (await loadCohortSample(db, dispatchId))!;
    const view = await cohortSampleView(db, saved);
    return c.json({ data: unscheduled ? { ...view, unscheduled } : view }, 200);
  },
);

holdbacks.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/dispatches/{dispatchId}/cohort-sample',
    tags: ['Cohort Sampling'],
    summary: 'Remove a Cohort Sample before sending',
    description:
      'Removed by an author from a scheduled Dispatch, it takes the Dispatch back to draft for an editor to schedule again.',
    request: { params: dispatchParam },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    await requireFlag(c, access, 'cohort_sampling', 'Cohort sampling is off for this publication.');
    const db = env(c).DB;
    const sample = await loadCohortSample(db, dispatchId);
    if (!sample) throw new ApiError('not_found', 'This post has no cohort sample.');
    if (!pendingCohortSample(sample)) {
      throw new ApiError('conflict', 'A cohort sample that has run is kept with its results.');
    }
    // Removing the sample removes its bounce and complaint halt, so an author's removal unschedules.
    const undo = undoEditorDecisions(db, dispatchId, access.role, { email: true, page: false });
    const results = await db.batch([
      ...undo,
      db
        .prepare(`DELETE FROM cohort_samples WHERE id = ?1 AND status IN ('draft', 'canceled')`)
        .bind(sample.id),
    ]);
    await editorDecisionsUndone(db, sessionActor(c, access), dispatchId, results);
    await audit(c, access, 'cohort_sample.deleted', dispatchId);
    return c.body(null, 204);
  },
);

// ---- Preview as a Member (Smart Blocks) ----------------------------------------------------

holdbacks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/preview',
    tags: ['Dispatches'],
    summary: 'Preview the email, optionally as one Member',
    description:
      'Renders the saved version. With memberId, Smart Blocks show as that Member would see them right now and merge tags use their name; without it every block shows. Links are not tracked. A paid Dispatch with a gate divider previews its full email.',
    request: {
      params: dispatchParam,
      query: z.object({
        memberId: z
          .string()
          .regex(idPattern('member'))
          .optional()
          .openapi({ param: { name: 'memberId', in: 'query' } }),
      }),
    },
    responses: {
      200: ok(DispatchPreviewSchema, 'Preview'),
      ...errors('invalid_input', 'unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const { memberId } = c.req.valid('query');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    await requireFlag(c, access, 'smart_blocks', 'Smart blocks are off for this publication.');
    const e = env(c);
    const dispatch = await loadDispatch(e.DB, dispatchId);
    const channel = (await first<{ workspace_id: string; name: string; branding_json: string }>(
      e.DB,
      'SELECT workspace_id, name, branding_json FROM channels WHERE id = ?1',
      dispatch.channel_id,
    ))!;
    const content = JSON.parse(dispatch.content_json) as unknown;
    let template;
    try {
      template = await renderForWorkspace({
        db: e.DB,
        workspaceId: channel.workspace_id,
        channelName: channel.name,
        accentColor:
          (JSON.parse(channel.branding_json) as { accentColor?: string | null }).accentColor ??
          null,
        preheader: dispatch.preheader,
        content,
        cover: coverOf(dispatch),
        mediaOrigin: engine(c).mediaOrigin,
        allowHtmlBlocks: await rawHtmlAllowed(c, access),
        webVisibility: dispatch.web_visibility,
        webUrl:
          dispatch.web_visibility === 'paid' ? await webUrlFor(e.DB, engine(c), dispatch) : null,
        paidVariant: 'full',
      });
    } catch (error) {
      if (error instanceof RenderError) throw invalid('content', error.message);
      throw error;
    }
    let member: { email: string; firstName: string | null; lastName: string | null } = {
      email: access.auth.email,
      firstName: null,
      lastName: null,
    };
    let visible: number[] | undefined;
    if (memberId) {
      const row = await first<{
        email: string;
        first_name: string | null;
        last_name: string | null;
      }>(
        e.DB,
        'SELECT email, first_name, last_name FROM members WHERE id = ?1 AND channel_id = ?2',
        memberId,
        dispatch.channel_id,
      );
      if (!row) throw invalid('memberId', 'That subscriber is not in this publication.');
      member = { email: row.email, firstName: row.first_name, lastName: row.last_name };
      visible = await smartBlockVisibility(e.DB, dispatch.channel_id, memberId, content);
    }
    const filled = personalize(
      { html: template.html, text: template.text, subject: dispatch.subject },
      {
        ...(visible ? { smartBlocks: visible } : {}),
        link: (n) => template.links[n] ?? '#',
        unsubscribeUrl: '#unsubscribe',
        memberCenterUrl: '#member-center',
        pixelUrl: null,
        member,
      },
    );
    return c.json(
      {
        data: {
          memberId: memberId ?? null,
          subject: filled.subject,
          html: filled.html,
          text: filled.text,
          smartBlocks: (template.smartBlocks ?? []).map((block) => ({
            index: block.index,
            label: block.label,
            visible: visible ? visible.includes(block.index) : true,
          })),
        },
      },
      200,
    );
  },
);
