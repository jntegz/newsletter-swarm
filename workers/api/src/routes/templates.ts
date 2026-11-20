// Template Library (Phase 6): saved Dispatch layouts, per Channel or shared with every Channel of
// the workspace (channel_id NULL). Never across workspaces. Kind 'design' (a look without
// content) needs the design_templates flag. Imported HTML becomes one raw HTML block: it can be
// saved and edited anywhere, and sent only where raw_html_mode is on (the send checklist).
//
// Starter templates ship in code (STARTER_TEMPLATES in @swarm/domain): the same for every
// workspace, read-only, and listed per Channel so the preview wears that Channel's design. Using
// one creates an ordinary draft, exactly as using a saved template does.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  CreateTemplateSchema,
  DispatchSchema,
  ImportTemplateSchema,
  SaveAsTemplateSchema,
  StarterTemplateKeySchema,
  StarterTemplateSchema,
  StarterTemplateSummarySchema,
  TemplateListQuerySchema,
  TemplateSchema,
  TemplateSummarySchema,
  UpdateTemplateSchema,
  UseTemplateSchema,
  idPattern,
  newId,
  starterTemplate,
  starterTemplateSummaries,
  type CoverImageRef,
  type SeatRole,
  type Template,
  type TemplateSummary,
} from '@swarm/domain';
import { coverOf, previewHtml, renderForWorkspace } from '@swarm/engine';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { RenderError, personalize } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { requireChannel, requireWorkspace } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { checkCoverImage, engine, rawHtmlAllowed, requireOwned } from '../lib/send';
import { audit } from '../lib/site';
import { createDispatchRow, dispatchOut } from './dispatches';

export const templates = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const templateParam = idParam('templateId', idPattern('template'));
const dispatchParam = idParam('dispatchId', idPattern('dispatch'));

const MAX_CONTENT_BYTES = 512 * 1024;

interface TemplateRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  name: string;
  description: string | null;
  kind: 'dispatch' | 'design';
  subject: string;
  preheader: string;
  content_json: string;
  cover_media_id: string | null;
  cover_alt: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, workspace_id, channel_id, name, description, kind, subject, preheader, content_json,
  cover_media_id, cover_alt, created_at, updated_at`;

const toSummary = (row: TemplateRow): TemplateSummary => ({
  id: row.id,
  workspaceId: row.workspace_id,
  channelId: row.channel_id,
  name: row.name,
  description: row.description,
  kind: row.kind,
  subject: row.subject,
  preheader: row.preheader,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const toTemplate = (row: TemplateRow): Template => ({
  ...toSummary(row),
  content: JSON.parse(row.content_json) as Template['content'],
  coverImage: coverOf(row),
});

function contentJson(content: unknown): string {
  const json = JSON.stringify(content);
  if (new TextEncoder().encode(json).length > MAX_CONTENT_BYTES) {
    throw new ApiError('invalid_input', 'The template is too large.', [
      { path: 'content', message: 'The template is too large.' },
    ]);
  }
  return json;
}

async function designTemplatesOn(
  c: AppContext,
  workspaceId: string,
  channelId: string | null,
): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('design_templates', {
    workspaceId,
    ...(channelId ? { channelId } : {}),
  });
}

async function requireDesignFlag(c: AppContext, workspaceId: string, channelId: string | null) {
  if (!(await designTemplatesOn(c, workspaceId, channelId))) {
    throw new ApiError('feature_disabled', 'Design templates are not enabled.');
  }
}

/**
 * The one tenancy check for a scope: a Channel (requireChannel, `channelMinimum`) or the whole
 * workspace (seat role, `workspaceMinimum`). A Channel of another workspace is not found.
 */
async function requireScope(
  c: AppContext,
  workspaceId: string,
  channelId: string | null,
  minimum: { channel: SeatRole; workspace: SeatRole },
): Promise<{ workspaceId: string; channelId: string | null; auth: { operatorId: string } }> {
  if (channelId) {
    const access = await requireChannel(c, channelId, minimum.channel);
    if (access.workspaceId !== workspaceId)
      throw new ApiError('not_found', 'Publication not found.');
    return { workspaceId, channelId, auth: access.auth };
  }
  const access = await requireWorkspace(c, workspaceId, minimum.workspace);
  return { workspaceId, channelId: null, auth: access.auth };
}

const READ = { channel: 'viewer', workspace: 'viewer' } as const;
/** Channel templates: authors (who write Dispatches); shared ones: editors of the workspace. */
const WRITE = { channel: 'author', workspace: 'editor' } as const;

/** Loads a template and checks access to its scope; others' templates are not found. */
async function templateAccess(
  c: AppContext,
  templateId: string,
  minimum: { channel: SeatRole; workspace: SeatRole },
) {
  const row = await first<TemplateRow>(
    env(c).DB,
    `SELECT ${COLUMNS} FROM templates WHERE id = ?1 AND deleted_at IS NULL`,
    templateId,
  );
  const notFound = new ApiError('not_found', 'Template not found.');
  if (!row) throw notFound;
  let access;
  try {
    access = await requireScope(c, row.workspace_id, row.channel_id, minimum);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
  if (row.kind === 'design') await requireDesignFlag(c, row.workspace_id, row.channel_id);
  return { row, access };
}

async function insertTemplate(
  c: AppContext,
  scope: { workspaceId: string; channelId: string | null; auth: { operatorId: string } },
  input: {
    name: string;
    description?: string | null | undefined;
    kind: 'dispatch' | 'design';
    subject: string;
    preheader: string;
    content: unknown;
    coverImage?: CoverImageRef | null | undefined;
  },
  auditMetadata: Record<string, unknown> = {},
): Promise<Template> {
  const db = env(c).DB;
  const now = Date.now();
  const id = newId('template', now);
  await run(
    db,
    `INSERT INTO templates (id, workspace_id, channel_id, name, description, kind, subject, preheader, content_json,
       created_by, created_at, updated_at, cover_media_id, cover_alt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13)`,
    id,
    scope.workspaceId,
    scope.channelId,
    input.name,
    input.description ?? null,
    input.kind,
    input.subject,
    input.preheader,
    contentJson(input.content),
    scope.auth.operatorId,
    now,
    input.coverImage?.mediaId ?? null,
    input.coverImage?.alt ?? '',
  );
  await audit(c, scope, 'template.created', 'template', id, {
    channelId: scope.channelId,
    kind: input.kind,
    ...auditMetadata,
  });
  const row = await first<TemplateRow>(db, `SELECT ${COLUMNS} FROM templates WHERE id = ?1`, id);
  return toTemplate(row!);
}

templates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/templates',
    tags: ['Templates'],
    summary: 'Templates shared with the workspace, plus one Channel’s own',
    request: { params: workspaceParam, query: TemplateListQuerySchema },
    responses: {
      200: ok(z.array(TemplateSummarySchema), 'Templates'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { channelId } = c.req.valid('query');
    await requireScope(c, workspaceId, channelId ?? null, READ);
    const design = await designTemplatesOn(c, workspaceId, channelId ?? null);
    const rows = await all<TemplateRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM templates
        WHERE workspace_id = ?1 AND deleted_at IS NULL AND (channel_id IS NULL OR channel_id = ?2)
          AND (?3 = 1 OR kind = 'dispatch')
        ORDER BY updated_at DESC LIMIT 200`,
      workspaceId,
      channelId ?? null,
      design ? 1 : 0,
    );
    return c.json({ data: rows.map(toSummary) }, 200);
  },
);

templates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/templates',
    tags: ['Templates'],
    summary: 'Save a template',
    description:
      'With a channelId it belongs to that Channel (author role); without one it is shared with every Channel of the workspace (editor role). Kind design needs the design_templates flag.',
    request: { params: workspaceParam, body: jsonBody(CreateTemplateSchema) },
    responses: {
      201: ok(TemplateSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const scope = await requireScope(c, workspaceId, input.channelId ?? null, WRITE);
    if (input.kind === 'design') await requireDesignFlag(c, workspaceId, scope.channelId);
    if (input.coverImage) await checkCoverImage(c, workspaceId, input.coverImage.mediaId);
    return c.json({ data: await insertTemplate(c, scope, input) }, 201);
  },
);

/** Keeps the body of an HTML document (or the fragment as given). */
function htmlBody(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (body?.[1] ?? html).trim();
}

templates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/templates/import',
    tags: ['Templates'],
    summary: 'Import an HTML email as a template',
    description:
      'The HTML body becomes one raw HTML block. Dispatches made from it can be edited anywhere but sent only where raw HTML is enabled (raw_html_mode).',
    request: { params: workspaceParam, body: jsonBody(ImportTemplateSchema) },
    responses: {
      201: ok(TemplateSchema, 'Imported'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const scope = await requireScope(c, workspaceId, input.channelId ?? null, WRITE);
    const html = htmlBody(input.html);
    if (!html) {
      throw new ApiError('invalid_input', 'The HTML has no body.', [
        { path: 'html', message: 'The HTML has no body.' },
      ]);
    }
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(input.html)?.[1]?.trim() ?? '';
    const template = await insertTemplate(
      c,
      scope,
      {
        name: input.name,
        kind: 'dispatch',
        subject: title.slice(0, 200),
        preheader: '',
        content: { type: 'doc', content: [{ type: 'htmlBlock', attrs: { html } }] },
      },
      { imported: true },
    );
    return c.json({ data: template }, 201);
  },
);

templates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/templates/{templateId}',
    tags: ['Templates'],
    summary: 'One template with its document',
    request: { params: templateParam },
    responses: { 200: ok(TemplateSchema, 'Template'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { templateId } = c.req.valid('param');
    const { row } = await templateAccess(c, templateId, READ);
    return c.json({ data: toTemplate(row) }, 200);
  },
);

templates.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/templates/{templateId}',
    tags: ['Templates'],
    summary: 'Edit a template, or share it with the workspace',
    description:
      'channelId null shares it with every Channel of the workspace; a Channel id of the same workspace keeps it to that Channel. Changing who sees it needs write access to both scopes.',
    request: { params: templateParam, body: jsonBody(UpdateTemplateSchema) },
    responses: {
      200: ok(TemplateSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { templateId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await templateAccess(c, templateId, WRITE);
    let channelId = row.channel_id;
    if (input.channelId !== undefined && input.channelId !== row.channel_id) {
      // The new scope is checked like a create, in the same workspace only.
      channelId = (await requireScope(c, row.workspace_id, input.channelId, WRITE)).channelId;
      if (row.kind === 'design') await requireDesignFlag(c, row.workspace_id, channelId);
    }
    if (input.coverImage && input.coverImage.mediaId !== row.cover_media_id) {
      await checkCoverImage(c, row.workspace_id, input.coverImage.mediaId);
    }
    const cover = input.coverImage === undefined ? coverOf(row) : input.coverImage;
    const db = env(c).DB;
    await run(
      db,
      `UPDATE templates SET channel_id = ?1, name = ?2, description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
              subject = ?5, preheader = ?6, content_json = ?7, updated_at = ?8, cover_media_id = ?10, cover_alt = ?11
        WHERE id = ?9`,
      channelId,
      input.name ?? row.name,
      input.description === undefined ? 0 : 1,
      input.description ?? null,
      input.subject ?? row.subject,
      input.preheader ?? row.preheader,
      input.content ? contentJson(input.content) : row.content_json,
      Date.now(),
      templateId,
      cover?.mediaId ?? null,
      cover?.alt ?? '',
    );
    if (channelId !== row.channel_id) {
      await audit(c, access, 'template.scope_changed', 'template', templateId, {
        from: row.channel_id,
        to: channelId,
      });
    }
    const saved = await first<TemplateRow>(
      db,
      `SELECT ${COLUMNS} FROM templates WHERE id = ?1`,
      templateId,
    );
    return c.json({ data: toTemplate(saved!) }, 200);
  },
);

templates.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/templates/{templateId}',
    tags: ['Templates'],
    summary: 'Delete a template',
    request: { params: templateParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { templateId } = c.req.valid('param');
    const { access } = await templateAccess(c, templateId, WRITE);
    await run(
      env(c).DB,
      'UPDATE templates SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2',
      Date.now(),
      templateId,
    );
    await audit(c, access, 'template.deleted', 'template', templateId);
    return c.body(null, 204);
  },
);

templates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/templates/{templateId}/use',
    tags: ['Templates'],
    summary: 'Start a draft Dispatch from a template',
    description:
      'In the template’s Channel, or in any Channel of the workspace for a shared template (author role there).',
    request: { params: templateParam, body: jsonBody(UseTemplateSchema) },
    responses: {
      201: ok(DispatchSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { templateId } = c.req.valid('param');
    const { channelId } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'author');
    const row = await first<TemplateRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM templates WHERE id = ?1 AND deleted_at IS NULL
         AND workspace_id = ?2 AND (channel_id IS NULL OR channel_id = ?3)`,
      templateId,
      access.workspaceId,
      channelId,
    );
    if (!row) throw new ApiError('not_found', 'Template not found.');
    if (row.kind === 'design') await requireDesignFlag(c, row.workspace_id, channelId);
    const allowHtml = await rawHtmlAllowed(c, access);
    const id = await createDispatchRow(c, access, {
      subject: row.subject,
      preheader: row.preheader,
      content: JSON.parse(row.content_json),
      coverImage: coverOf(row),
      allowHtml,
      // A raw HTML block is kept even where raw HTML is off; the checklist stops the send.
      lenient: true,
      auditMetadata: { templateId },
    });
    return c.json({ data: await dispatchOut(c, id, allowHtml) }, 201);
  },
);

templates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/templates/{templateId}/export',
    tags: ['Templates'],
    summary: 'Export a template as an HTML email',
    description:
      'The email as Swarm renders it, links as written, without personalisation or tracking. Served as a download.',
    request: { params: templateParam },
    responses: {
      200: { description: 'The HTML file', content: { 'text/html': { schema: z.string() } } },
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { templateId } = c.req.valid('param');
    const { row } = await templateAccess(c, templateId, READ);
    const db = env(c).DB;
    const owner = await first<{ name: string; branding_json: string | null }>(
      db,
      row.channel_id
        ? 'SELECT name, branding_json FROM channels WHERE id = ?1'
        : 'SELECT name, NULL AS branding_json FROM workspaces WHERE id = ?1',
      row.channel_id ?? row.workspace_id,
    );
    const branding = owner?.branding_json
      ? (JSON.parse(owner.branding_json) as { accentColor?: string | null })
      : {};
    let html: string;
    try {
      html = previewHtml(
        await renderForWorkspace({
          db,
          workspaceId: row.workspace_id,
          channelName: owner?.name ?? 'Swarm',
          accentColor: branding.accentColor ?? null,
          preheader: row.preheader,
          content: JSON.parse(row.content_json),
          cover: coverOf(row),
          mediaOrigin: engine(c).mediaOrigin,
          snippetChannelId: row.channel_id,
          // The export goes to the operator only; raw HTML blocks are their own markup.
          allowHtmlBlocks: true,
        }),
      );
    } catch (error) {
      if (!(error instanceof RenderError)) throw error;
      throw new ApiError('invalid_input', error.message, [
        { path: 'content', message: error.message },
      ]);
    }
    const file =
      row.name
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'template';
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${file}.html"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        // Opened directly, it runs no script on the API's origin.
        'content-security-policy':
          "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'",
      },
    });
  },
);

templates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/save-as-template',
    tags: ['Templates'],
    summary: 'Save a Dispatch as a template',
    description:
      'For the Dispatch’s Channel, or shared with the whole workspace (editor role on the workspace).',
    request: { params: dispatchParam, body: jsonBody(SaveAsTemplateSchema) },
    responses: {
      201: ok(TemplateSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    const scope = await requireScope(
      c,
      access.workspaceId,
      input.shared ? null : access.channelId,
      WRITE,
    );
    const dispatch = await first<{
      subject: string;
      preheader: string;
      content_json: string;
      cover_media_id: string | null;
      cover_alt: string;
    }>(
      env(c).DB,
      'SELECT subject, preheader, content_json, cover_media_id, cover_alt FROM dispatches WHERE id = ?1',
      dispatchId,
    );
    const template = await insertTemplate(
      c,
      scope,
      {
        name: input.name,
        description: input.description,
        kind: 'dispatch',
        subject: dispatch!.subject,
        preheader: dispatch!.preheader,
        content: JSON.parse(dispatch!.content_json),
        coverImage: coverOf(dispatch!),
      },
      { dispatchId },
    );
    return c.json({ data: template }, 201);
  },
);

// ---- Starter templates -----------------------------------------------------------------------

const channelParam = idParam('channelId', idPattern('channel'));
const starterParam = z.object({
  channelId: z.string().regex(idPattern('channel')),
  starterKey: StarterTemplateKeySchema,
});

templates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/starter-templates',
    tags: ['Templates'],
    summary: 'The starter templates that ship with Swarm',
    description:
      'Built-in starting points for a Dispatch. They are the same for every Channel and cannot be edited; use one to get a draft of your own.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(StarterTemplateSummarySchema), 'Starter templates'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    await requireChannel(c, c.req.valid('param').channelId, 'viewer');
    return c.json({ data: starterTemplateSummaries() }, 200);
  },
);

templates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/starter-templates/{starterKey}',
    tags: ['Templates'],
    summary: 'One starter template, with its document and a preview',
    description:
      'The preview is the email as this Channel would send it (its name, accent colour and email design), with merge tags showing their fallbacks.',
    request: { params: starterParam },
    responses: {
      200: ok(StarterTemplateSchema, 'Starter template'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, starterKey } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    const starter = starterTemplate(starterKey);
    if (!starter) throw new ApiError('not_found', 'Template not found.');
    const db = env(c).DB;
    const channel = await first<{ name: string; branding_json: string | null }>(
      db,
      'SELECT name, branding_json FROM channels WHERE id = ?1',
      channelId,
    );
    const branding = channel?.branding_json
      ? (JSON.parse(channel.branding_json) as { accentColor?: string | null })
      : {};
    const rendered = await renderForWorkspace({
      db,
      workspaceId: access.workspaceId,
      channelId,
      channelName: channel?.name ?? 'Swarm',
      accentColor: branding.accentColor ?? null,
      preheader: starter.preheader,
      content: starter.content,
      mediaOrigin: engine(c).mediaOrigin,
      allowHtmlBlocks: false,
    });
    // A preview for the operator: links as written, no tracking, merge tags at their fallbacks.
    const { html } = personalize(
      { html: previewHtml(rendered), text: '', subject: '' },
      { link: () => '#', unsubscribeUrl: '#unsubscribe', pixelUrl: null, member: { email: '' } },
    );
    return c.json({ data: { ...starter, html } }, 200);
  },
);

templates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/starter-templates/{starterKey}/use',
    tags: ['Templates'],
    summary: 'Start a draft Dispatch from a starter template',
    description:
      'Creates a draft in the Channel with the starter’s subject, preview text and content (author role). The draft is an ordinary Dispatch; the starter is unchanged.',
    request: { params: starterParam },
    responses: {
      201: ok(DispatchSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, starterKey } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'author');
    const starter = starterTemplate(starterKey);
    if (!starter) throw new ApiError('not_found', 'Template not found.');
    const allowHtml = await rawHtmlAllowed(c, access);
    const id = await createDispatchRow(c, access, {
      subject: starter.subject,
      preheader: starter.preheader,
      content: starter.content,
      allowHtml,
      auditMetadata: { starterTemplate: starter.key },
    });
    return c.json({ data: await dispatchOut(c, id, allowHtml) }, 201);
  },
);
