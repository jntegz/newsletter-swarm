// Capture Forms: builder CRUD, publish and version history, the embed snippet, daily stats, and
// (re)sending a confirmation to a pending Member. Authors edit drafts; editors publish, delete and
// resend confirmations; viewers read. The public side lives in the capture worker.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  CaptureFormConfigSchema,
  consentHtmlProblem,
  CaptureFormSchema,
  CaptureFormSnippetSchema,
  CaptureFormStatsSchema,
  CaptureFormVersionSchema,
  CreateCaptureFormSchema,
  SmartPromptPlacementSchema,
  UpdateCaptureFormSchema,
  defaultCaptureFormConfig,
  idPattern,
  newId,
  type CaptureForm,
  type CaptureFormConfig,
  type CaptureFormKind,
  type SeatRole,
  type SmartPromptPlacement,
} from '@swarm/domain';
import {
  embedSnippet,
  linksFor,
  mailAdapter,
  sendConfirmation,
  type SnippetFieldDef,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { requireOwned } from '../lib/send';
import { checkFormRosters } from '../lib/rosters';
import { requireFlag } from '../lib/site';

export const captureForms = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const formParam = idParam('formId', idPattern('captureForm'));
const memberParam = idParam('memberId', idPattern('member'));

export interface FormRow {
  id: string;
  channel_id: string;
  workspace_id: string;
  name: string;
  kind: CaptureFormKind;
  placement_json: string | null;
  status: CaptureForm['status'];
  draft_config_json: string;
  published_config_json: string | null;
  version: number;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export const FORM_COLUMNS = `id, channel_id, workspace_id, name, kind, placement_json, status, draft_config_json,
  published_config_json, version, published_at, created_at, updated_at`;

const parseConfig = (json: string): CaptureFormConfig => {
  const parsed = CaptureFormConfigSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : defaultCaptureFormConfig();
};

const parsePlacement = (json: string | null): SmartPromptPlacement | null => {
  if (!json) return null;
  const parsed = SmartPromptPlacementSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
};

const PROMPTS_OFF = 'Smart Prompts are not available.';

/**
 * A placement the site can use: paths are site paths (`/p/*`), scroll needs a percentage and
 * delay a number of seconds; a Gate prompt is for readers who don't pay.
 */
function checkPlacement(placement: SmartPromptPlacement): void {
  const fail = (path: string, message: string): never => {
    throw new ApiError('invalid_input', message, [{ path: `placement.${path}`, message }]);
  };
  placement.paths.forEach((glob, i) => {
    if (!/^\/[A-Za-z0-9._~\-/*]*$/.test(glob) || glob.startsWith('//')) {
      fail(`paths.${i}`, 'Paths start with / and may use * as a wildcard.');
    }
  });
  const value = placement.value;
  if (placement.trigger === 'scroll' && (value === undefined || value < 1 || value > 100)) {
    fail('value', 'Give the scroll depth as a percentage from 1 to 100.');
  }
  if (placement.trigger === 'delay' && value === undefined) {
    fail('value', 'Give the delay in seconds.');
  }
  if (placement.trigger === 'gate_hit' && placement.readers === 'everyone') {
    fail('readers', 'A paywall prompt is for anonymous or free readers.');
  }
}

export function toForm(row: FormRow): CaptureForm {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    kind: row.kind,
    placement: parsePlacement(row.placement_json),
    status: row.status,
    version: row.version,
    draft: parseConfig(row.draft_config_json),
    published: row.published_config_json ? parseConfig(row.published_config_json) : null,
    hasUnpublishedChanges: row.published_config_json !== row.draft_config_json,
    publishedAt: row.published_at === null ? null : toIso(row.published_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Resolves a form to its Channel and applies the tenancy check. A form in a Channel the operator
 * can't see answers 404 exactly like one that doesn't exist.
 */
async function requireForm(c: AppContext, formId: string, minimum: SeatRole) {
  const notFound = new ApiError('not_found', 'Signup form not found.');
  const row = await first<FormRow>(
    env(c).DB,
    `SELECT ${FORM_COLUMNS} FROM capture_forms WHERE id = ?1 AND deleted_at IS NULL`,
    formId,
  );
  if (!row) throw notFound;
  try {
    return { row, access: await requireChannel(c, row.channel_id, minimum) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
}

/** Every profile field a config asks for must exist in the Channel. */
async function checkFields(db: D1Database, channelId: string, config: CaptureFormConfig) {
  const keys = config.fields
    .filter((f) => f.key.startsWith('field:'))
    .map((f) => f.key.slice('field:'.length));
  if (!keys.length) return;
  const found = await all<{ key: string }>(
    db,
    `SELECT key FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL
        AND key IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(keys),
  );
  const missing = keys.filter((k) => !found.some((f) => f.key === k));
  if (missing.length) {
    throw new ApiError(
      'invalid_input',
      `The profile field "${missing[0]}" doesn't exist in this publication. Remove it from the form.`,
      missing.map((k) => ({ path: 'config.fields', message: `Unknown profile field "${k}".` })),
    );
  }
}

/** The profile fields a config uses, for the no-JS form in the snippet. */
/** The embed code of a form's published version (the dashboard's route and /v2). */
export async function formSnippet(c: AppContext, row: FormRow) {
  if (!row.published_config_json || row.version < 1) {
    throw new ApiError('conflict', 'Publish the form to get its embed code.');
  }
  const config = parseConfig(row.published_config_json);
  return embedSnippet(
    env(c).CAPTURE_ORIGIN,
    row.id,
    row.version,
    config,
    await snippetFieldDefs(env(c).DB, row.channel_id, config),
  );
}

async function snippetFieldDefs(db: D1Database, channelId: string, config: CaptureFormConfig) {
  const keys = config.fields
    .filter((f) => f.key.startsWith('field:'))
    .map((f) => f.key.slice('field:'.length));
  if (!keys.length) return new Map<string, SnippetFieldDef>();
  const rows = await all<{ key: string; type: SnippetFieldDef['type']; options_json: string }>(
    db,
    `SELECT key, type, options_json FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL
        AND key IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(keys),
  );
  return new Map(
    rows.map((r) => [
      r.key,
      { key: r.key, type: r.type, options: JSON.parse(r.options_json) as string[] },
    ]),
  );
}

const audit = (
  c: AppContext,
  access: { workspaceId: string; auth: { operatorId: string } },
  action: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType: action.startsWith('member.') ? 'member' : 'capture_form',
    targetId,
    ...(metadata ? { metadata } : {}),
    ipPrefix: ipPrefix(clientIp(c)),
  });

captureForms.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/capture-forms',
    tags: ['Capture forms'],
    summary: 'Capture forms of a Channel',
    description: 'Forms and Smart Prompts; filter with kind.',
    request: {
      params: channelParam,
      query: z.object({ kind: z.enum(['form', 'prompt']).optional() }),
    },
    responses: {
      200: ok(z.array(CaptureFormSchema), 'Capture forms'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { kind } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<FormRow>(
      env(c).DB,
      `SELECT ${FORM_COLUMNS} FROM capture_forms WHERE channel_id = ?1 AND deleted_at IS NULL
          AND (?2 IS NULL OR kind = ?2) ORDER BY created_at DESC`,
      channelId,
      kind ?? null,
    );
    return c.json({ data: rows.map(toForm) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/capture-forms',
    tags: ['Capture forms'],
    summary: 'Create a capture form',
    description:
      'Starts as a draft. Without a config, the default form (email only, inline). kind "prompt" makes a Smart Prompt (smart_prompts flag), which needs a placement: gate_hit, dispatch_end, scroll (value = percent), exit_intent or delay (value = seconds), path globs, readers and a cooldown after dismissal. The kind is fixed once created.',
    request: { params: channelParam, body: jsonBody(CreateCaptureFormSchema) },
    responses: {
      201: ok(CaptureFormSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'author');
    const e = env(c);
    if (input.kind === 'prompt') {
      await requireFlag(c, access, 'smart_prompts', PROMPTS_OFF);
      checkPlacement(input.placement as SmartPromptPlacement);
    }
    const config = input.config ?? defaultCaptureFormConfig();
    await checkFields(e.DB, channelId, config);
    await checkFormRosters(c, access, config.rosterIds);
    const now = Date.now();
    const id = newId('captureForm');
    const row = await first<FormRow>(
      e.DB,
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, kind, placement_json, draft_config_json, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) RETURNING ${FORM_COLUMNS}`,
      id,
      access.workspaceId,
      channelId,
      input.name,
      input.kind,
      input.placement ? JSON.stringify(input.placement) : null,
      JSON.stringify(config),
      access.auth.operatorId,
      now,
    );
    await audit(c, access, 'capture_form.created', id, { name: input.name, kind: input.kind });
    return c.json({ data: toForm(row as FormRow) }, 201);
  },
);

captureForms.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/capture-forms/{formId}',
    tags: ['Capture forms'],
    summary: 'One capture form',
    request: { params: formParam },
    responses: {
      200: ok(CaptureFormSchema, 'Capture form'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { row } = await requireForm(c, c.req.valid('param').formId, 'viewer');
    return c.json({ data: toForm(row) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/capture-forms/{formId}',
    tags: ['Capture forms'],
    summary: 'Update a capture form draft',
    description: 'Changes the name or the draft. The live form changes only when it is published.',
    request: { params: formParam, body: jsonBody(UpdateCaptureFormSchema) },
    responses: {
      200: ok(CaptureFormSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { formId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await requireForm(c, formId, 'author');
    const e = env(c);
    if (input.kind && input.kind !== row.kind) {
      throw new ApiError(
        'invalid_input',
        'A form can’t become a Smart Prompt, or the other way round.',
        [{ path: 'kind', message: 'The kind is fixed' }],
      );
    }
    if (input.placement) {
      if (row.kind !== 'prompt') {
        throw new ApiError('invalid_input', 'Only Smart Prompts have a placement.', [
          { path: 'placement', message: 'Not a Smart Prompt' },
        ]);
      }
      checkPlacement(input.placement);
    }
    if (row.kind === 'prompt') await requireFlag(c, access, 'smart_prompts', PROMPTS_OFF);
    if (input.config) {
      await checkFields(e.DB, row.channel_id, input.config);
      await checkFormRosters(c, access, input.config.rosterIds);
    }
    const updated = await first<FormRow>(
      e.DB,
      `UPDATE capture_forms SET name = ?1, draft_config_json = ?2, placement_json = ?3, updated_at = ?4
        WHERE id = ?5 AND deleted_at IS NULL RETURNING ${FORM_COLUMNS}`,
      input.name ?? row.name,
      input.config ? JSON.stringify(input.config) : row.draft_config_json,
      input.placement ? JSON.stringify(input.placement) : row.placement_json,
      Date.now(),
      formId,
    );
    await audit(c, access, 'capture_form.updated', formId, { fields: Object.keys(input) });
    return c.json({ data: toForm(updated as FormRow) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/capture-forms/{formId}',
    tags: ['Capture forms'],
    summary: 'Delete a capture form',
    description:
      'The embed stops showing at once. Members who joined through it keep their source.',
    request: { params: formParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { formId } = c.req.valid('param');
    const { access } = await requireForm(c, formId, 'editor');
    const now = Date.now();
    await env(c)
      .DB.prepare(
        `UPDATE capture_forms SET deleted_at = ?1, status = 'archived', updated_at = ?1 WHERE id = ?2`,
      )
      .bind(now, formId)
      .run();
    await audit(c, access, 'capture_form.deleted', formId);
    return c.body(null, 204);
  },
);

captureForms.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/capture-forms/{formId}/publish',
    tags: ['Capture forms'],
    summary: 'Publish the draft',
    description:
      'The draft becomes the next version and goes live. Earlier versions keep serving to pages pinned to them, so their SRI hashes stay valid.',
    request: { params: formParam },
    responses: {
      200: ok(CaptureFormSchema, 'Published'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { formId } = c.req.valid('param');
    const { row, access } = await requireForm(c, formId, 'editor');
    const e = env(c);
    const config = CaptureFormConfigSchema.safeParse(JSON.parse(row.draft_config_json));
    if (!config.success)
      throw new ApiError('invalid_input', 'The draft is not valid. Edit it first.');
    // Here, not in the schema: a form published before links were allowed must keep loading.
    const consentProblem = config.data.consent && consentHtmlProblem(config.data.consent.text);
    if (consentProblem) throw new ApiError('invalid_input', consentProblem);
    await checkFields(e.DB, row.channel_id, config.data);
    await checkFormRosters(c, access, config.data.rosterIds);
    const now = Date.now();
    const [updated] = await e.DB.batch<FormRow>([
      e.DB.prepare(
        `UPDATE capture_forms SET status = 'published', version = version + 1, published_config_json = draft_config_json,
                published_at = ?1, updated_at = ?1
          WHERE id = ?2 AND deleted_at IS NULL RETURNING ${FORM_COLUMNS}`,
      ).bind(now, formId),
      e.DB.prepare(
        `INSERT INTO capture_form_versions (form_id, version, config_json, published_by, published_at)
         SELECT id, version, published_config_json, ?1, ?2 FROM capture_forms WHERE id = ?3`,
      ).bind(access.auth.operatorId, now, formId),
      // Site pages render the form, so cached copies must not keep showing the old wording.
      e.DB.prepare(
        `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
           ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1, updated_at = ?2`,
      ).bind(row.channel_id, now),
    ]);
    const published = updated!.results[0] as FormRow;
    await audit(c, access, 'capture_form.published', formId, { version: published.version });
    return c.json({ data: toForm(published) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/capture-forms/{formId}/versions',
    tags: ['Capture forms'],
    summary: 'Published versions, newest first',
    request: { params: formParam },
    responses: {
      200: ok(z.array(CaptureFormVersionSchema), 'Versions'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { formId } = c.req.valid('param');
    await requireForm(c, formId, 'viewer');
    const rows = await all<{
      version: number;
      config_json: string;
      published_by: string | null;
      published_at: number;
    }>(
      env(c).DB,
      'SELECT version, config_json, published_by, published_at FROM capture_form_versions WHERE form_id = ?1 ORDER BY version DESC LIMIT 100',
      formId,
    );
    return c.json(
      {
        data: rows.map((r) => ({
          version: r.version,
          config: parseConfig(r.config_json),
          publishedBy: r.published_by,
          publishedAt: toIso(r.published_at),
        })),
      },
      200,
    );
  },
);

captureForms.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/capture-forms/{formId}/versions/{version}/restore',
    tags: ['Capture forms'],
    summary: 'Restore a version as the draft',
    description: 'Copies a published version into the draft. Publish to make it live again.',
    request: {
      params: formParam.extend({
        version: z.coerce
          .number()
          .int()
          .min(1)
          .openapi({ param: { name: 'version', in: 'path' } }),
      }),
    },
    responses: {
      200: ok(CaptureFormSchema, 'Restored'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { formId, version } = c.req.valid('param');
    const { access } = await requireForm(c, formId, 'author');
    const e = env(c);
    const updated = await first<FormRow>(
      e.DB,
      `UPDATE capture_forms
          SET draft_config_json = (SELECT config_json FROM capture_form_versions WHERE form_id = ?1 AND version = ?2),
              updated_at = ?3
        WHERE id = ?1 AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM capture_form_versions WHERE form_id = ?1 AND version = ?2)
       RETURNING ${FORM_COLUMNS}`,
      formId,
      version,
      Date.now(),
    );
    if (!updated) throw new ApiError('not_found', 'That version does not exist.');
    await audit(c, access, 'capture_form.restored', formId, { version });
    return c.json({ data: toForm(updated) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/capture-forms/{formId}/snippet',
    tags: ['Capture forms'],
    summary: 'Embed code for the published version',
    description:
      'The script tag carries an SRI hash of the exact bytes served for this version, so paste it again after each publish to pick up changes.',
    request: { params: formParam },
    responses: {
      200: ok(CaptureFormSnippetSchema, 'Snippet'),
      ...errors('unauthorized', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { row } = await requireForm(c, c.req.valid('param').formId, 'viewer');
    return c.json({ data: await formSnippet(c, row) }, 200);
  },
);

captureForms.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/capture-forms/{formId}/stats',
    tags: ['Capture forms'],
    summary: 'Views, submissions and confirmed Members per day',
    request: {
      params: formParam,
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
    },
    responses: { 200: ok(CaptureFormStatsSchema, 'Stats'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { formId } = c.req.valid('param');
    const { days } = c.req.valid('query');
    await requireForm(c, formId, 'viewer');
    const today = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const span = Array.from({ length: days }, (_, i) =>
      new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    );
    const rows = await all<{ day: string; views: number; submissions: number; confirmed: number }>(
      env(c).DB,
      'SELECT day, views, submissions, confirmed FROM capture_form_daily WHERE form_id = ?1 AND day >= ?2 ORDER BY day',
      formId,
      span[0],
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = span.map(
      (day) => byDay.get(day) ?? { day, views: 0, submissions: 0, confirmed: 0 },
    );
    const totals = series.reduce(
      (t, d) => ({
        views: t.views + d.views,
        submissions: t.submissions + d.submissions,
        confirmed: t.confirmed + d.confirmed,
      }),
      { views: 0, submissions: 0, confirmed: 0 },
    );
    return c.json(
      {
        data: {
          days: series,
          totals,
          conversion: totals.views
            ? Math.round((totals.confirmed / totals.views) * 10_000) / 10_000
            : null,
        },
      },
      200,
    );
  },
);

captureForms.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/members/{memberId}/confirmation',
    tags: ['Members'],
    summary: 'Send a pending Member their confirmation again',
    description:
      'Only for pending Members; the Member still has to confirm. Rate limited per Member: at most one send every 10 minutes and five per request.',
    request: { params: memberParam },
    responses: {
      202: ok(z.object({ sent: z.literal(true) }), 'Sent'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'rate_limited'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const access = await requireOwned(c, 'member', memberId, 'editor');
    const e = env(c);
    const row = await first<{ status: string }>(
      e.DB,
      'SELECT status FROM members WHERE id = ?1',
      memberId,
    );
    if (row?.status !== 'pending') {
      throw new ApiError('conflict', 'Only pending subscribers can be sent a confirmation.');
    }
    const result = await sendConfirmation(
      {
        db: e.DB,
        mail: mailAdapter(e, e.PLATFORM_MAIL_DOMAIN),
        links: linksFor(e),
        captureOrigin: e.CAPTURE_ORIGIN.replace(/\/$/, ''),
        platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
      },
      { memberId, kind: 'subscribe' },
    );
    if (result === 'rate_limited') {
      throw new ApiError('rate_limited', 'A confirmation went out recently. Try again later.');
    }
    if (result === 'skipped') {
      throw new ApiError('conflict', 'This address is suppressed, so nothing can be sent to it.');
    }
    await audit(c, access, 'member.confirmation_sent', memberId);
    return c.json({ data: { sent: true as const } }, 202);
  },
);
