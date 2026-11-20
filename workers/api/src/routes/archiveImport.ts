// Past issues from another platform (flag archive_import). The dashboard reads the export in the
// browser and sends batches here. Each becomes a post on the website only, dated when it first went
// out, under its old address where that's free. Nothing is emailed: readers already had these.
import { createRoute, z } from '@hono/zod-openapi';
import { first, run } from '@swarm/db';
import { DispatchDocumentSchema, WebVisibilitySchema } from '@swarm/domain';
import { changeSlug, publishToWeb, SlugError } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { createRouter, env } from '../lib/context';
import { errors, jsonBody, ok } from '../lib/openapi';
import { rawHtmlAllowed } from '../lib/send';
import { requireFlag } from '../lib/site';
import { createDispatchRow } from './dispatches';

export const archiveImport = createRouter();

const ImportItemSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  preheader: z.string().trim().max(500).default(''),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  publishedAt: z.iso.datetime(),
  visibility: WebVisibilitySchema.exclude(['hidden']),
  content: DispatchDocumentSchema,
});

const ImportRequestSchema = z
  .object({
    /** Checks each address without changing anything. */
    dryRun: z.boolean().default(false),
    items: z.array(ImportItemSchema).min(1).max(25),
  })
  .openapi('ArchiveImportRequest');

const ImportResultSchema = z.object({
  slug: z.string(),
  outcome: z.enum(['ready', 'imported', 'exists', 'failed']),
  message: z.string().nullable(),
});

archiveImport.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/archive-import',
    tags: ['Site'],
    summary: 'Add past issues to the website, without emailing them',
    description:
      'Admin role and the archive_import flag. An address already in use is left alone, so running an import again is safe.',
    request: { params: z.object({ channelId: z.string() }), body: jsonBody(ImportRequestSchema) },
    responses: {
      200: ok(z.object({ results: z.array(ImportResultSchema) }), 'What happened to each'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    await requireFlag(c, access, 'archive_import', 'Importing past issues is not available.');
    const e = env(c);
    const allowHtml = await rawHtmlAllowed(c, access);
    const results: z.infer<typeof ImportResultSchema>[] = [];
    for (const item of input.items) {
      const taken = await first(
        e.DB,
        'SELECT 1 FROM dispatch_slugs WHERE channel_id = ?1 AND slug = ?2',
        channelId,
        item.slug,
      );
      if (taken) {
        results.push({ slug: item.slug, outcome: 'exists', message: null });
        continue;
      }
      if (input.dryRun) {
        results.push({ slug: item.slug, outcome: 'ready', message: null });
        continue;
      }
      try {
        const id = await createDispatchRow(c, access, {
          subject: item.subject,
          preheader: item.preheader,
          content: item.content,
          allowHtml,
          lenient: true,
        });
        // Marked first: whatever happens next, this row is never a draft waiting to be sent.
        await run(
          e.DB,
          'UPDATE dispatches SET web_visibility = ?1, imported_at = ?2 WHERE id = ?3',
          item.visibility,
          Date.now(),
          id,
        );
        const at = Date.parse(item.publishedAt);
        await changeSlug(e.DB, { id, channel_id: channelId }, item.slug, at);
        // Dated when it first went out, so the archive keeps its order.
        await publishToWeb(e.DB, id, at);
        results.push({ slug: item.slug, outcome: 'imported', message: null });
      } catch (error) {
        if (!(error instanceof SlugError || error instanceof ApiError)) throw error;
        results.push({ slug: item.slug, outcome: 'failed', message: error.message });
      }
    }
    if (!input.dryRun) {
      await appendAudit(e.DB, {
        workspaceId: access.workspaceId,
        actorId: access.auth.operatorId,
        action: 'site.archive_imported',
        targetType: 'channel',
        targetId: channelId,
        metadata: { count: results.filter((r) => r.outcome === 'imported').length },
      });
    }
    return c.json({ data: { results } }, 200);
  },
);
