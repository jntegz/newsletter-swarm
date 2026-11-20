// App Directory (Phase 8.12): developers' listings of their OAuth apps (admin), the directory
// operators browse (any seat), the staff review queue, and the public read-only endpoint.
// Install itself is the app's own PKCE authorization request and the existing consent page;
// installed apps are the existing oauth-grants routes. Contract: docs/app-directory.md.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, run } from '@swarm/db';
import {
  APP_DIRECTORY_CACHE_CONTROL,
  APP_DIRECTORY_PUBLIC_RATE,
  APP_MANIFEST_VERSION,
  AppListingSchema,
  AppManifestSchema,
  CreateAppListingSchema,
  DirectoryListingSchema,
  DirectoryQuerySchema,
  ImportAppManifestSchema,
  ReviewDecisionSchema,
  ReviewQueueSchema,
  UpdateAppListingSchema,
  WorkspaceDirectoryListingSchema,
  appManifestJsonSchema,
  idPattern,
  listingUrlProblem,
  newId,
  reviewOutcome,
  slugifyAppName,
  type ApiScope,
  type AppManifest,
} from '@swarm/domain';
import { manifestProblems } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { isLocal } from '../env';
import { requireWorkspace } from '../lib/access';
import {
  LISTING_SELECT,
  REVIEW_SELECT,
  auditReview,
  directoryPublic,
  directoryRows,
  listingMediaIds,
  loadImages,
  requireDirectoryFlag,
  requireStaff,
  reviewVersion,
  toDirectoryListing,
  toListing,
  toSubmission,
  type ListingRow,
  type RecipeRow,
  type ReviewRow,
} from '../lib/appDirectory';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const appDirectory = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const listingParams = workspaceParam.extend(idParam('listingId', idPattern('appListing')).shape);
const slugParam = z.object({
  slug: z
    .string()
    .max(50)
    .openapi({ param: { name: 'slug', in: 'path' } }),
});

type Access = Awaited<ReturnType<typeof requireWorkspace>>;

/** Admin of the workspace with the flag on: everything a developer does with a listing. */
async function developerAccess(c: AppContext, workspaceId: string): Promise<Access> {
  const access = await requireWorkspace(c, workspaceId, 'admin');
  await requireDirectoryFlag(c, workspaceId);
  return access;
}

async function loadListing(c: AppContext, workspaceId: string, listingId: string) {
  const row = await first<ListingRow>(
    env(c).DB,
    `${LISTING_SELECT} WHERE l.id = ?1 AND l.workspace_id = ?2`,
    listingId,
    workspaceId,
  );
  if (!row) throw new ApiError('not_found', 'Listing not found.');
  return row;
}

async function listingOut(c: AppContext, row: ListingRow) {
  return toListing(row, await loadImages(c, listingMediaIds([row])));
}

/** The workspace's own unrevoked OAuth app. */
async function loadOwnApp(c: AppContext, workspaceId: string, appId: string) {
  const app = await first<{
    id: string;
    client_secret_hash: string | null;
    redirect_uris_json: string;
    scopes_json: string;
    homepage_url: string | null;
  }>(
    env(c).DB,
    `SELECT id, client_secret_hash, redirect_uris_json, scopes_json, homepage_url FROM oauth_apps
      WHERE id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL AND metadata_url IS NULL`,
    appId,
    workspaceId,
  );
  if (!app) throw new ApiError('not_found', 'OAuth app not found.');
  return {
    id: app.id,
    clientType: app.client_secret_hash ? ('confidential' as const) : ('public' as const),
    redirectUris: JSON.parse(app.redirect_uris_json) as string[],
    scopes: JSON.parse(app.scopes_json) as ApiScope[],
    homepageUrl: app.homepage_url,
  };
}

type ListingFields = z.output<typeof UpdateAppListingSchema>;

/** Field checks every write shares: URLs, the workspace's own images, scopes within the app's. */
async function checkFields(
  c: AppContext,
  workspaceId: string,
  appScopes: readonly ApiScope[],
  input: ListingFields,
): Promise<void> {
  const details: { path: string; message: string }[] = [];
  const allowHttp = isLocal(env(c));
  for (const key of ['websiteUrl', 'supportUrl', 'privacyUrl', 'installUrl'] as const) {
    const value = input[key];
    if (!value) continue;
    const problem = listingUrlProblem(value, { allowHttp, allowMailto: key === 'supportUrl' });
    if (problem) details.push({ path: key, message: problem });
  }
  const wanted = [
    ...(input.iconMediaId ? [input.iconMediaId] : []),
    ...(input.screenshotMediaIds ?? []),
  ];
  const images = await loadImages(c, wanted, workspaceId);
  if (input.iconMediaId && !images.has(input.iconMediaId)) {
    details.push({ path: 'iconMediaId', message: 'Pick an image from this workspace’s Media.' });
  }
  (input.screenshotMediaIds ?? []).forEach((id, i) => {
    if (!images.has(id)) {
      details.push({
        path: `screenshotMediaIds.${i}`,
        message: 'Pick an image from this workspace’s Media.',
      });
    }
  });
  (input.scopes ?? []).forEach((scope, i) => {
    if (!appScopes.includes(scope)) {
      details.push({ path: `scopes.${i}`, message: `The app is not registered for ${scope}.` });
    }
  });
  if (details.length) throw new ApiError('invalid_input', details[0]!.message, details);
}

/** What a listing needs before staff can review it. */
function submitProblems(row: ListingRow): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const need = (ok: unknown, path: string, message: string) => {
    if (!ok) problems.push({ path, message });
  };
  need(row.tagline.trim(), 'tagline', 'Add a tagline.');
  need(row.icon_media_id, 'iconMediaId', 'Add an icon.');
  need(JSON.parse(row.categories_json).length, 'categories', 'Pick at least one category.');
  need(JSON.parse(row.scopes_json).length, 'scopes', 'List the scopes the app asks for.');
  need(row.website_url, 'websiteUrl', 'Add the app’s website.');
  need(row.support_url, 'supportUrl', 'Add a support address.');
  need(row.privacy_url, 'privacyUrl', 'Add the privacy policy.');
  need(row.install_url, 'installUrl', 'Add the address that starts the install.');
  const appScopes = new Set(JSON.parse(row.app_scopes) as string[]);
  (JSON.parse(row.scopes_json) as string[]).forEach((scope, i) => {
    if (!appScopes.has(scope)) {
      problems.push({
        path: `scopes.${i}`,
        message: `The app is no longer registered for ${scope}.`,
      });
    }
  });
  return problems;
}

async function uniqueSlug(c: AppContext, wanted: string | undefined, name: string) {
  if (wanted) return wanted;
  const base = slugifyAppName(name);
  const taken = await first(env(c).DB, 'SELECT 1 AS x FROM app_listings WHERE slug = ?1', base);
  return taken ? `${base.slice(0, 45)}-${crypto.randomUUID().slice(0, 4)}` : base;
}

function slugTaken(error: unknown): never {
  if (isUniqueViolation(error) && String(error).includes('slug')) {
    throw new ApiError('conflict', 'Another listing uses that address. Pick another slug.', [
      { path: 'slug', message: 'taken' },
    ]);
  }
  if (isUniqueViolation(error)) throw new ApiError('conflict', 'This app already has a listing.');
  throw error;
}

const json = (value: unknown) => JSON.stringify(value);

/** Every field an edit can set, applied on top of the row; the listing returns to draft. */
async function writeListing(
  c: AppContext,
  row: ListingRow,
  input: ListingFields,
  status: 'draft',
): Promise<void> {
  const pick = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
  try {
    await run(
      env(c).DB,
      `UPDATE app_listings SET status = ?1, name = ?2, slug = ?3, tagline = ?4, description = ?5,
         icon_media_id = ?6, screenshots_json = ?7, categories_json = ?8, scopes_json = ?9,
         webhook_events_json = ?10, website_url = ?11, support_url = ?12, privacy_url = ?13,
         install_url = ?14, updated_at = ?15
       WHERE id = ?16`,
      status,
      pick(input.name, row.name),
      pick(input.slug, row.slug),
      pick(input.tagline, row.tagline),
      pick(input.description, row.description),
      pick(input.iconMediaId, row.icon_media_id),
      input.screenshotMediaIds ? json(input.screenshotMediaIds) : row.screenshots_json,
      input.categories ? json(input.categories) : row.categories_json,
      input.scopes ? json(input.scopes) : row.scopes_json,
      input.webhookEvents ? json(input.webhookEvents) : row.webhook_events_json,
      pick(input.websiteUrl, row.website_url),
      pick(input.supportUrl, row.support_url),
      pick(input.privacyUrl, row.privacy_url),
      pick(input.installUrl, row.install_url),
      Date.now(),
      row.id,
    );
  } catch (error) {
    slugTaken(error);
  }
}

async function insertListing(
  c: AppContext,
  access: Access,
  appId: string,
  input: ListingFields & { name: string },
): Promise<string> {
  const now = Date.now();
  const id = newId('appListing', now);
  try {
    await run(
      env(c).DB,
      `INSERT INTO app_listings (id, app_id, workspace_id, status, name, slug, tagline, description,
         icon_media_id, screenshots_json, categories_json, scopes_json, webhook_events_json, website_url,
         support_url, privacy_url, install_url, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)`,
      id,
      appId,
      access.workspaceId,
      input.name,
      await uniqueSlug(c, input.slug, input.name),
      input.tagline ?? '',
      input.description ?? '',
      input.iconMediaId ?? null,
      json(input.screenshotMediaIds ?? []),
      json(input.categories ?? []),
      json(input.scopes ?? []),
      json(input.webhookEvents ?? []),
      input.websiteUrl ?? null,
      input.supportUrl ?? null,
      input.privacyUrl ?? null,
      input.installUrl ?? null,
      access.auth.operatorId,
      now,
    );
  } catch (error) {
    slugTaken(error);
  }
  return id;
}

// ---- Developer: listings ---------------------------------------------------------------------

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/app-listings',
    tags: ['App Directory'],
    summary: 'Listings of this workspace’s OAuth apps',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(AppListingSchema), 'Listings, newest first'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await developerAccess(c, workspaceId);
    const rows = await all<ListingRow>(
      env(c).DB,
      `${LISTING_SELECT} WHERE l.workspace_id = ?1 ORDER BY l.created_at DESC`,
      workspaceId,
    );
    const media = await loadImages(c, listingMediaIds(rows));
    return c.json({ data: rows.map((r) => toListing(r, media)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/app-listings',
    tags: ['App Directory'],
    summary: 'Create a draft listing for an OAuth app',
    description: 'One listing per app. Images come from this workspace’s Media.',
    request: { params: workspaceParam, body: jsonBody(CreateAppListingSchema) },
    responses: {
      201: ok(AppListingSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { appId, ...input } = c.req.valid('json');
    const access = await developerAccess(c, workspaceId);
    const app = await loadOwnApp(c, workspaceId, appId);
    await checkFields(c, workspaceId, app.scopes, input);
    const id = await insertListing(c, access, appId, input);
    await audit(c, access, 'app_listing.created', 'app_listing', id, { appId });
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, id)) }, 201);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/import',
    tags: ['App Directory'],
    summary: 'Create or replace a listing from an app manifest',
    description:
      'The manifest (docs/app-directory.md) must match the app’s registration: client type, redirect URIs and scopes. The listing becomes a draft.',
    request: { params: workspaceParam, body: jsonBody(ImportAppManifestSchema) },
    responses: {
      200: ok(AppListingSchema, 'Imported'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await developerAccess(c, workspaceId);
    const app = await loadOwnApp(c, workspaceId, input.appId);
    const parsed = AppManifestSchema.safeParse(input.manifest);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: ['manifest', ...issue.path.map(String)].join('.'),
        message: issue.message,
      }));
      throw new ApiError('invalid_input', 'The manifest is not valid.', details);
    }
    const manifest = parsed.data;
    const problems = manifestProblems(manifest, app);
    if (problems.length) {
      throw new ApiError('invalid_input', 'The manifest does not match the app.', problems);
    }
    const fields: ListingFields & { name: string } = {
      name: manifest.listing.name,
      ...(manifest.listing.slug ? { slug: manifest.listing.slug } : {}),
      tagline: manifest.listing.tagline,
      description: manifest.listing.description,
      categories: [...new Set(manifest.listing.categories)],
      scopes: [...new Set(manifest.oauth.scopes)].sort(),
      webhookEvents: [...new Set(manifest.webhooks.events)].sort(),
      websiteUrl: manifest.listing.websiteUrl,
      supportUrl: manifest.listing.supportUrl,
      privacyUrl: manifest.listing.privacyUrl,
      installUrl: manifest.listing.installUrl,
    };
    await checkFields(c, workspaceId, app.scopes, fields);
    const existing = await first<{ id: string }>(
      env(c).DB,
      'SELECT id FROM app_listings WHERE app_id = ?1',
      app.id,
    );
    let id: string;
    if (existing) {
      id = existing.id;
      await writeListing(c, await loadListing(c, workspaceId, id), fields, 'draft');
    } else {
      id = await insertListing(c, access, app.id, fields);
    }
    await audit(
      c,
      access,
      existing ? 'app_listing.updated' : 'app_listing.created',
      'app_listing',
      id,
      {
        appId: app.id,
        manifestVersion: manifest.manifestVersion,
      },
    );
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, id)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}',
    tags: ['App Directory'],
    summary: 'One listing',
    request: { params: listingParams },
    responses: {
      200: ok(AppListingSchema, 'Listing'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    await developerAccess(c, workspaceId);
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, listingId)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}',
    tags: ['App Directory'],
    summary: 'Change a listing',
    description:
      'Any change returns the listing to draft; an approved listing leaves the directory until it is approved again.',
    request: { params: listingParams, body: jsonBody(UpdateAppListingSchema) },
    responses: {
      200: ok(AppListingSchema, 'Changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await developerAccess(c, workspaceId);
    const row = await loadListing(c, workspaceId, listingId);
    await checkFields(c, workspaceId, JSON.parse(row.app_scopes) as ApiScope[], input);
    await writeListing(c, row, input, 'draft');
    await audit(c, access, 'app_listing.updated', 'app_listing', listingId, {
      fields: Object.keys(input),
      from: row.status,
    });
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, listingId)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}/submit',
    tags: ['App Directory'],
    summary: 'Send a listing for review',
    request: { params: listingParams },
    responses: {
      200: ok(AppListingSchema, 'Submitted'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    const access = await developerAccess(c, workspaceId);
    const row = await loadListing(c, workspaceId, listingId);
    if (row.app_revoked_at !== null) throw new ApiError('conflict', 'The OAuth app was revoked.');
    if (!['draft', 'rejected', 'delisted'].includes(row.status)) {
      throw new ApiError(
        'conflict',
        'Only a draft, rejected or delisted listing can be submitted.',
      );
    }
    const problems = submitProblems(row);
    // The images may have been deleted since they were picked.
    const images = await loadImages(c, listingMediaIds([row]), workspaceId);
    if (row.icon_media_id && !images.has(row.icon_media_id)) {
      problems.push({ path: 'iconMediaId', message: 'The icon was deleted. Pick another.' });
    }
    if (problems.length) throw new ApiError('invalid_input', problems[0]!.message, problems);
    const now = Date.now();
    const result = await run(
      env(c).DB,
      `UPDATE app_listings SET status = 'submitted', submitted_at = ?1, review_note = NULL, updated_at = ?1
        WHERE id = ?2 AND status = ?3`,
      now,
      listingId,
      row.status,
    );
    if (!result.meta.changes) throw new ApiError('conflict', 'The listing changed. Reload it.');
    await audit(c, access, 'app_listing.submitted', 'app_listing', listingId);
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, listingId)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}/withdraw',
    tags: ['App Directory'],
    summary: 'Withdraw a listing from review or from the directory',
    description: 'A submitted listing returns to draft; an approved one is delisted.',
    request: { params: listingParams },
    responses: {
      200: ok(AppListingSchema, 'Withdrawn'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    const access = await developerAccess(c, workspaceId);
    const row = await loadListing(c, workspaceId, listingId);
    const next = { submitted: 'draft', approved: 'delisted' }[row.status as string];
    if (!next)
      throw new ApiError('conflict', 'Only a submitted or approved listing can be withdrawn.');
    await run(
      env(c).DB,
      'UPDATE app_listings SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4',
      next,
      Date.now(),
      listingId,
      row.status,
    );
    await audit(c, access, 'app_listing.withdrawn', 'app_listing', listingId, { from: row.status });
    return c.json({ data: await listingOut(c, await loadListing(c, workspaceId, listingId)) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}',
    tags: ['App Directory'],
    summary: 'Delete a listing',
    description: 'The app stays registered and its grants keep working.',
    request: { params: listingParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    const access = await developerAccess(c, workspaceId);
    const row = await loadListing(c, workspaceId, listingId);
    await run(env(c).DB, 'DELETE FROM app_listings WHERE id = ?1', listingId);
    await audit(c, access, 'app_listing.deleted', 'app_listing', listingId, {
      appId: row.app_id,
      status: row.status,
    });
    return c.body(null, 204);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/app-listings/{listingId}/manifest',
    tags: ['App Directory'],
    summary: 'The listing and its app as an app manifest',
    request: { params: listingParams },
    responses: {
      200: ok(AppManifestSchema, 'Manifest'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, listingId } = c.req.valid('param');
    await developerAccess(c, workspaceId);
    const row = await loadListing(c, workspaceId, listingId);
    const app = await first<{ client_secret_hash: string | null; redirect_uris_json: string }>(
      env(c).DB,
      'SELECT client_secret_hash, redirect_uris_json FROM oauth_apps WHERE id = ?1',
      row.app_id,
    );
    const manifest: AppManifest = {
      $schema: `${env(c).APP_ORIGIN}/api/v1/public/app-manifest.schema.json`,
      manifestVersion: APP_MANIFEST_VERSION,
      listing: {
        name: row.name,
        slug: row.slug,
        tagline: row.tagline,
        description: row.description,
        categories: JSON.parse(row.categories_json) as AppManifest['listing']['categories'],
        websiteUrl: row.website_url ?? '',
        supportUrl: row.support_url ?? '',
        privacyUrl: row.privacy_url ?? '',
        installUrl: row.install_url ?? '',
      },
      oauth: {
        clientType: app?.client_secret_hash ? 'confidential' : 'public',
        redirectUris: JSON.parse(app?.redirect_uris_json ?? '[]') as string[],
        scopes: JSON.parse(row.scopes_json) as ApiScope[],
      },
      webhooks: {
        events: JSON.parse(row.webhook_events_json) as AppManifest['webhooks']['events'],
      },
    };
    return c.json({ data: manifest }, 200);
  },
);

// ---- Operators: the directory ----------------------------------------------------------------

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/app-directory',
    tags: ['App Directory'],
    summary: 'Approved apps, searchable, with whether each is installed here',
    request: { params: workspaceParam, query: DirectoryQuerySchema },
    responses: {
      200: ok(z.array(WorkspaceDirectoryListingSchema), 'Listings, newest approval first'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const query = c.req.valid('query');
    await requireWorkspace(c, workspaceId, 'viewer');
    await requireDirectoryFlag(c, workspaceId);
    const rows = await directoryRows(c, query);
    return c.json({ data: await workspaceListings(c, workspaceId, rows) }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/app-directory/{slug}',
    tags: ['App Directory'],
    summary: 'One approved app',
    request: { params: workspaceParam.extend(slugParam.shape) },
    responses: {
      200: ok(WorkspaceDirectoryListingSchema, 'Listing'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, slug } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'viewer');
    await requireDirectoryFlag(c, workspaceId);
    const [listing] = await workspaceListings(c, workspaceId, await directoryRows(c, { slug }));
    if (!listing) throw new ApiError('not_found', 'App not found.');
    return c.json({ data: listing }, 200);
  },
);

async function workspaceListings(c: AppContext, workspaceId: string, rows: ListingRow[]) {
  const media = await loadImages(c, listingMediaIds(rows));
  const grants = await all<{ id: string; app_id: string }>(
    env(c).DB,
    `SELECT id, app_id FROM oauth_grants
      WHERE workspace_id = ?1 AND revoked_at IS NULL AND code_consumed_at IS NOT NULL
      ORDER BY created_at DESC`,
    workspaceId,
  );
  const byApp = new Map<string, string>();
  for (const grant of grants) if (!byApp.has(grant.app_id)) byApp.set(grant.app_id, grant.id);
  return rows.map((row) => ({
    ...toDirectoryListing(row, media),
    appId: row.app_id,
    installedGrantId: byApp.get(row.app_id) ?? null,
  }));
}

// ---- Staff: review ---------------------------------------------------------------------------

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/app-directory/review',
    tags: ['App Directory'],
    summary: 'The review queue (platform staff)',
    description:
      'Submitted listings and community recipes, oldest first, and the approved ones (to delist). Needs platform staff on a session that proved a second factor; anyone else gets 404.',
    responses: {
      200: ok(ReviewQueueSchema, 'Queue'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    await requireStaff(c);
    const db = env(c).DB;
    const listings = await all<ReviewRow>(
      db,
      `${REVIEW_SELECT} WHERE l.status IN ('submitted', 'approved')
        ORDER BY l.submitted_at, l.id LIMIT 500`,
    );
    const recipes = await all<RecipeRow>(
      db,
      `SELECT * FROM recipe_submissions WHERE status IN ('submitted', 'approved')
        ORDER BY submitted_at, id LIMIT 500`,
    );
    const media = await loadImages(c, listingMediaIds(listings));
    const queued = listings.filter((r) => r.status === 'submitted');
    return c.json(
      {
        data: {
          listings: await Promise.all(
            queued.map(async (r) => ({
              ...toListing(r, media),
              app: {
                clientType: r.client_secret_hash ? ('confidential' as const) : ('public' as const),
                scopes: JSON.parse(r.app_scopes) as ApiScope[],
                redirectUris: JSON.parse(r.redirect_uris_json) as string[],
                homepageUrl: r.homepage_url,
              },
              reviewVersion: await reviewVersion(r),
            })),
          ),
          approvedListings: listings
            .filter((r) => r.status === 'approved')
            .map((r) => toListing(r, media)),
          recipes: recipes.filter((r) => r.status === 'submitted').map(toSubmission),
          approvedRecipes: recipes.filter((r) => r.status === 'approved').map(toSubmission),
        },
      },
      200,
    );
  },
);

const decisionResponses = (schema: z.ZodType) => ({
  200: ok(schema, 'Decided'),
  ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
});

/**
 * Moves a submitted or approved row on, conditional on the row (and a listing's app) being as it
 * was read, so nothing changes between the version check and the decision.
 */
async function decide(
  c: AppContext,
  table: 'app_listings' | 'recipe_submissions',
  row: { id: string; status: ListingRow['status']; updated_at: number; app_updated_at?: number },
  decision: { decision: 'approve' | 'reject' | 'delist'; note?: string | undefined },
  operatorId: string,
): Promise<string> {
  const next = reviewOutcome(row.status, decision.decision);
  if (!next) {
    throw new ApiError(
      'conflict',
      decision.decision === 'delist'
        ? 'Only an approved item can be delisted.'
        : 'Only a submitted item can be approved or rejected.',
    );
  }
  const now = Date.now();
  const listing = table === 'app_listings';
  const result = await run(
    env(c).DB,
    `UPDATE ${table} SET status = ?1, review_note = ?2, reviewed_at = ?3, reviewed_by = ?4, updated_at = ?3
      WHERE id = ?5 AND status = ?6 AND updated_at = ?7${
        listing
          ? ' AND (SELECT updated_at FROM oauth_apps WHERE id = app_listings.app_id) = ?8'
          : ''
      }`,
    next,
    decision.note || null,
    now,
    operatorId,
    row.id,
    row.status,
    row.updated_at,
    ...(listing ? [row.app_updated_at] : []),
  );
  if (!result.meta.changes) throw new ApiError('conflict', 'It changed while you were reviewing.');
  return next;
}

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/app-directory/review/listings/{listingId}',
    tags: ['App Directory'],
    summary: 'Approve, reject or delist a listing (platform staff)',
    request: {
      params: idParam('listingId', idPattern('appListing')),
      body: jsonBody(ReviewDecisionSchema),
    },
    responses: decisionResponses(AppListingSchema),
  }),
  async (c) => {
    const { listingId } = c.req.valid('param');
    const input = c.req.valid('json');
    const auth = await requireStaff(c);
    const row = await first<ReviewRow>(env(c).DB, `${REVIEW_SELECT} WHERE l.id = ?1`, listingId);
    if (!row) throw new ApiError('not_found', 'Listing not found.');
    if (input.decision === 'approve' && row.app_revoked_at !== null) {
      throw new ApiError('conflict', 'The OAuth app was revoked.');
    }
    // A status check alone can't tell a listing staff saw from one changed and resubmitted since.
    if (input.decision === 'approve' && !input.version) {
      throw new ApiError('invalid_input', 'Approve from the review queue.', [
        { path: 'version', message: 'Send the reviewVersion the queue showed.' },
      ]);
    }
    if (input.version !== undefined && input.version !== (await reviewVersion(row))) {
      throw new ApiError('conflict', 'It changed while you were reviewing.');
    }
    const next = await decide(c, 'app_listings', row, input, auth.operatorId);
    await auditReview(c, auth, row.workspace_id, `app_listing.${next}`, 'app_listing', listingId, {
      note: input.note ?? null,
    });
    return c.json(
      { data: await listingOut(c, await loadListing(c, row.workspace_id, listingId)) },
      200,
    );
  },
);

appDirectory.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/app-directory/review/recipes/{submissionId}',
    tags: ['App Directory'],
    summary: 'Approve, reject or delist a community recipe (platform staff)',
    request: {
      params: idParam('submissionId', idPattern('recipeSubmission')),
      body: jsonBody(ReviewDecisionSchema),
    },
    responses: decisionResponses(z.object({ id: z.string(), status: z.string() })),
  }),
  async (c) => {
    const { submissionId } = c.req.valid('param');
    const input = c.req.valid('json');
    const auth = await requireStaff(c);
    const row = await first<RecipeRow>(
      env(c).DB,
      'SELECT * FROM recipe_submissions WHERE id = ?1',
      submissionId,
    );
    if (!row) throw new ApiError('not_found', 'Recipe not found.');
    const next = await decide(c, 'recipe_submissions', row, input, auth.operatorId);
    await auditReview(
      c,
      auth,
      row.workspace_id,
      `recipe_submission.${next}`,
      'recipe_submission',
      submissionId,
      { note: input.note ?? null },
    );
    return c.json({ data: { id: submissionId, status: next } }, 200);
  },
);

// ---- Public, read-only -----------------------------------------------------------------------

interface RateLimiterStub {
  take(
    perMinute: number,
    capacity: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/** 60 a minute per client network; unlimited when the realtime binding is absent (local). */
async function publicRateLimit(c: AppContext): Promise<void> {
  const namespace = env(c).API_RATE_LIMITER;
  if (!namespace) return;
  const network = ipPrefix(clientIp(c)) ?? 'unknown';
  const stub = namespace.get(
    namespace.idFromName(`app-directory:${network}`),
  ) as unknown as RateLimiterStub;
  const result = await stub.take(APP_DIRECTORY_PUBLIC_RATE, APP_DIRECTORY_PUBLIC_RATE);
  if (!result.allowed) {
    c.header('Retry-After', String(result.retryAfterSeconds));
    throw new ApiError('rate_limited', 'Too many requests. Wait and try again.');
  }
}

function publicHeaders(c: AppContext): void {
  c.header('Cache-Control', APP_DIRECTORY_CACHE_CONTROL);
  c.header('Access-Control-Allow-Origin', '*');
}

async function publicDirectory(c: AppContext, filter: Parameters<typeof directoryRows>[1]) {
  await publicRateLimit(c);
  if (!(await directoryPublic(c))) throw new ApiError('not_found', 'Not found.');
  const rows = await directoryRows(c, filter);
  const media = await loadImages(c, listingMediaIds(rows));
  publicHeaders(c);
  return rows.map((row) => toDirectoryListing(row, media));
}

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/public/apps',
    tags: ['App Directory'],
    summary: 'Approved apps (public, no sign-in)',
    description:
      'Rate-limited per client network and cacheable for 5 minutes. Answers 404 while the platform has the App Directory off.',
    request: { query: DirectoryQuerySchema },
    responses: {
      200: ok(z.array(DirectoryListingSchema), 'Listings'),
      ...errors('invalid_input', 'not_found', 'rate_limited'),
    },
  }),
  async (c) => c.json({ data: await publicDirectory(c, c.req.valid('query')) }, 200),
);

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/public/apps/{slug}',
    tags: ['App Directory'],
    summary: 'One approved app (public, no sign-in)',
    request: { params: slugParam },
    responses: {
      200: ok(DirectoryListingSchema, 'Listing'),
      ...errors('not_found', 'rate_limited'),
    },
  }),
  async (c) => {
    const { slug } = c.req.valid('param');
    const [listing] = await publicDirectory(c, { slug });
    if (!listing) throw new ApiError('not_found', 'App not found.');
    return c.json({ data: listing }, 200);
  },
);

appDirectory.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/public/app-manifest.schema.json',
    tags: ['App Directory'],
    summary: 'The app manifest JSON Schema (public)',
    responses: {
      200: {
        description: 'JSON Schema, draft 2020-12',
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
  }),
  (c) => {
    publicHeaders(c);
    return c.json(appManifestJsonSchema() as Record<string, never>, 200);
  },
);
