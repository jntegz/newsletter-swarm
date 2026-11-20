// App Directory (Phase 8.12): listings, review by platform staff, the directory, the public
// endpoint, manifests and community Flow Recipes, with the flag, role and tenancy checks.
import { env } from 'cloudflare:test';
import { sha256Hex } from '@swarm/db';
import {
  newId,
  type AppListing,
  type AppManifest,
  type CommunityRecipeInfo,
  type DirectoryListing,
  type Flow,
  type RecipeSubmission,
  type ReviewQueue,
  type WorkspaceDirectoryListing,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  json,
  pngBytes,
  seatAs,
  signIn,
  uploadForm,
  type Session,
} from './helpers';
import { REDIRECT, connect, createApp } from './oauth-helpers';

const data = async <T>(res: Response, status = 200): Promise<T> => {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
};

async function flagOn(scope: 'workspace' | 'platform', scopeId: string | null) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'app_directory', ?2, ?3, 1, ?4)`,
  )
    .bind(newId('featureFlag'), scope, scopeId, Date.now())
    .run();
  await env.CACHE.delete(`flags:v1:${scopeId ?? '-'}:-`);
}

async function forgetSession(cookie: string) {
  await env.CACHE.delete(`sess:v2:${await sha256Hex(cookie.split('=')[1] as string)}`);
}

/** Makes the operator platform staff; `proved` marks the session as second-factor verified. */
async function makeStaff(s: Session, proved = true) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO platform_staff (operator_id, created_at) VALUES (?1, ?2)',
  )
    .bind(s.me.operator.id, Date.now())
    .run();
  if (proved) {
    await env.DB.prepare(
      "UPDATE sessions SET mfa_method = 'totp', mfa_verified_at = ?1 WHERE operator_id = ?2",
    )
      .bind(Date.now(), s.me.operator.id)
      .run();
  }
  await forgetSession(s.cookie);
}

async function uploadImage(s: Session, channelId: string): Promise<string> {
  const res = await call('POST', `/api/v1/channels/${channelId}/media`, {
    cookie: s.cookie,
    form: uploadForm(pngBytes()),
  });
  return (await data<{ id: string }>(res, 201)).id;
}

const listingsPath = (s: Session) => `/api/v1/workspaces/${s.workspaceId}/app-listings`;

/** The listing as the staff review queue shows it now. */
async function queued(listingId: string) {
  const queue = await data<ReviewQueue>(
    await call('GET', '/api/v1/app-directory/review', { cookie: staff.cookie }),
  );
  return queue.listings.find((l) => l.id === listingId)!;
}

/** An approval of what the queue shows now. */
const approval = async (listingId: string) => ({
  decision: 'approve',
  version: (await queued(listingId)).reviewVersion,
});

const complete = (iconMediaId: string) => ({
  tagline: 'Rows for every Member',
  description: 'Adds a spreadsheet row for each new Member.',
  iconMediaId,
  categories: ['productivity', 'import_export'],
  scopes: ['members:read'],
  webhookEvents: ['member.created'],
  websiteUrl: 'https://sheets.example',
  supportUrl: 'mailto:help@sheets.example',
  privacyUrl: 'https://sheets.example/privacy',
  installUrl: 'https://sheets.example/install',
});

let dev: Session;
let devChannel: string;
let icon: string;
let appId: string;
let clientId: string;
let listing: AppListing;
let staff: Session;
let operator: Session;

beforeAll(async () => {
  dev = await signIn();
  devChannel = (await createChannel(dev)).id;
  icon = await uploadImage(dev, devChannel);
  const app = await createApp(dev, { scopes: ['members:read', 'channels:read'] });
  appId = app.app.id;
  clientId = app.app.clientId;
  staff = await signIn();
  operator = await signIn();
  await createChannel(operator);
});

describe('the flag', () => {
  it('is off by default, enforced on every workspace route', async () => {
    const off = await call('GET', listingsPath(dev), { cookie: dev.cookie });
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: { code: 'feature_disabled' } });
    const directory = await call('GET', `/api/v1/workspaces/${dev.workspaceId}/app-directory`, {
      cookie: dev.cookie,
    });
    expect(directory.status).toBe(404);
    await flagOn('workspace', dev.workspaceId);
    await flagOn('workspace', operator.workspaceId);
  });
});

describe('listings', () => {
  it('creates a draft listing for the workspace’s own app', async () => {
    listing = await data<AppListing>(
      await call('POST', listingsPath(dev), {
        cookie: dev.cookie,
        body: { appId, name: 'Sheet Sync' },
      }),
      201,
    );
    expect(listing).toMatchObject({ status: 'draft', slug: 'sheet-sync', appName: 'Sync tool' });
    const again = await call('POST', listingsPath(dev), {
      cookie: dev.cookie,
      body: { appId, name: 'Again' },
    });
    expect(again.status).toBe(409);
  });

  it('needs admin; other workspaces get 404 for the listing, the app and the media', async () => {
    const editor = await seatAs(dev.workspaceId, 'editor');
    expect((await call('GET', listingsPath(dev), { cookie: editor.cookie })).status).toBe(403);
    const other = await signIn();
    await flagOn('workspace', other.workspaceId);
    const foreign = await call('GET', `${listingsPath(dev)}/${listing.id}`, {
      cookie: other.cookie,
    });
    expect(foreign.status).toBe(404);
    const viaOwn = await call('PATCH', `${listingsPath(other)}/${listing.id}`, {
      cookie: other.cookie,
      body: { name: 'Mine now' },
    });
    expect(viaOwn.status).toBe(404);
    const theirApp = await call('POST', listingsPath(other), {
      cookie: other.cookie,
      body: { appId, name: 'Stolen' },
    });
    expect(theirApp.status).toBe(404);
    const otherChannel = (await createChannel(other)).id;
    const otherImage = await uploadImage(other, otherChannel);
    const media = await call('PATCH', `${listingsPath(dev)}/${listing.id}`, {
      cookie: dev.cookie,
      body: { iconMediaId: otherImage },
    });
    expect(media.status).toBe(400);
  });

  it('checks URLs and scopes against the app', async () => {
    const res = await call('PATCH', `${listingsPath(dev)}/${listing.id}`, {
      cookie: dev.cookie,
      body: { websiteUrl: 'https://u:p@sheets.example', scopes: ['members:write'] },
    });
    expect(res.status).toBe(400);
    const { error } = await json<{ error: { details: { path: string }[] } }>(res);
    expect(error.details.map((d) => d.path)).toEqual(['websiteUrl', 'scopes.0']);
  });

  it('refuses to submit an incomplete listing, then submits a complete one', async () => {
    const early = await call('POST', `${listingsPath(dev)}/${listing.id}/submit`, {
      cookie: dev.cookie,
    });
    expect(early.status).toBe(400);
    await data(
      await call('PATCH', `${listingsPath(dev)}/${listing.id}`, {
        cookie: dev.cookie,
        body: complete(icon),
      }),
    );
    listing = await data<AppListing>(
      await call('POST', `${listingsPath(dev)}/${listing.id}/submit`, { cookie: dev.cookie }),
    );
    expect(listing.status).toBe('submitted');
    expect(listing.icon?.mediaId).toBe(icon);
  });
});

describe('review', () => {
  it('is hidden from everyone but staff, and staff need a proved second factor', async () => {
    expect((await call('GET', '/api/v1/app-directory/review', { cookie: dev.cookie })).status).toBe(
      404,
    );
    await makeStaff(staff, false);
    const unproved = await call('GET', '/api/v1/app-directory/review', { cookie: staff.cookie });
    expect(unproved.status).toBe(403);
    expect(await unproved.json()).toMatchObject({
      error: { details: [{ path: 'secondFactor', message: 'staff_second_factor_required' }] },
    });
    await makeStaff(staff);
    const queue = await data<ReviewQueue>(
      await call('GET', '/api/v1/app-directory/review', { cookie: staff.cookie }),
    );
    const item = queue.listings.find((l) => l.id === listing.id);
    expect(item?.app.scopes).toEqual(['channels:read', 'members:read']);
  });

  it('needs a note to reject, and only decides on the right status', async () => {
    const path = `/api/v1/app-directory/review/listings/${listing.id}`;
    const noNote = await call('POST', path, {
      cookie: staff.cookie,
      body: { decision: 'reject' },
    });
    expect(noNote.status).toBe(400);
    const delist = await call('POST', path, {
      cookie: staff.cookie,
      body: { decision: 'delist', note: 'x' },
    });
    expect(delist.status).toBe(409);
    const notStaff = await call('POST', path, {
      cookie: dev.cookie,
      body: { decision: 'approve' },
    });
    expect(notStaff.status).toBe(404);
    listing = await data<AppListing>(
      await call('POST', path, { cookie: staff.cookie, body: await approval(listing.id) }),
    );
    expect(listing.status).toBe('approved');
  });

  it('is audited in the developer’s workspace', async () => {
    const row = await env.DB.prepare(
      "SELECT actor_operator_id FROM audit_events WHERE workspace_id = ?1 AND action = 'app_listing.approved'",
    )
      .bind(dev.workspaceId)
      .first<{ actor_operator_id: string }>();
    expect(row?.actor_operator_id).toBe(staff.me.operator.id);
  });

  it('refuses an approval when the app or listing changed after the queue was loaded', async () => {
    const other = await signIn();
    await flagOn('workspace', other.workspaceId);
    const otherIcon = await uploadImage(other, (await createChannel(other)).id);
    const { app } = await createApp(other, { scopes: ['members:read'] });
    const created = await data<AppListing>(
      await call('POST', listingsPath(other), {
        cookie: other.cookie,
        body: { appId: app.id, name: 'Row Writer' },
      }),
      201,
    );
    const mine = `${listingsPath(other)}/${created.id}`;
    await data(await call('PATCH', mine, { cookie: other.cookie, body: complete(otherIcon) }));
    await data(await call('POST', `${mine}/submit`, { cookie: other.cookie }));
    const seen = await queued(created.id);
    expect(seen.appName).toBe('Sync tool');

    // The developer renames the app (the listing returns to draft) and submits it again at once.
    await data(
      await call('PATCH', `/api/v1/workspaces/${other.workspaceId}/oauth-apps/${app.id}`, {
        cookie: other.cookie,
        body: { name: 'Official Swarm Sync' },
      }),
    );
    await data(await call('POST', `${mine}/submit`, { cookie: other.cookie }));

    const path = `/api/v1/app-directory/review/listings/${created.id}`;
    const stale = await call('POST', path, {
      cookie: staff.cookie,
      body: { decision: 'approve', version: seen.reviewVersion },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', message: 'It changed while you were reviewing.' },
    });
    const unbound = await call('POST', path, {
      cookie: staff.cookie,
      body: { decision: 'approve' },
    });
    expect(unbound.status).toBe(400);
    const now = await queued(created.id);
    expect(now.appName).toBe('Official Swarm Sync');
    expect(now.reviewVersion).not.toBe(seen.reviewVersion);
    const approved = await data<AppListing>(
      await call('POST', path, {
        cookie: staff.cookie,
        body: { decision: 'approve', version: now.reviewVersion },
      }),
    );
    expect(approved.status).toBe('approved');
  });
});

describe('the directory', () => {
  // The viewer holds a seat in the operator's workspace.
  const directory = (s: Session, query = '') =>
    call('GET', `/api/v1/workspaces/${operator.workspaceId}/app-directory${query}`, {
      cookie: s.cookie,
    });

  it('shows approved listings to any seat, searchable, with scopes in plain language', async () => {
    const viewer = await seatAs(operator.workspaceId, 'viewer');
    const all = await data<WorkspaceDirectoryListing[]>(await directory(viewer));
    const mine = all.find((l) => l.slug === 'sheet-sync')!;
    expect(mine.scopes).toEqual([
      { scope: 'members:read', label: 'See subscribers, their tags and profile fields' },
    ]);
    expect(mine.extraScopes.map((s) => s.scope)).toEqual(['channels:read']);
    expect(mine.installedGrantId).toBeNull();
    expect(mine.iconUrl).toContain('/media/');
    expect(mine).not.toHaveProperty('workspaceId');
    expect((await data<unknown[]>(await directory(viewer, '?q=SPREADSHEET'))).length).toBe(
      all.filter((l) => /spreadsheet/i.test(l.description)).length,
    );
    expect(
      (await data<DirectoryListing[]>(await directory(viewer, '?q=nothing-matches-this'))).length,
    ).toBe(0);
    const byCategory = await data<DirectoryListing[]>(await directory(viewer, '?category=crm'));
    expect(byCategory.some((l) => l.slug === 'sheet-sync')).toBe(false);
  });

  it('marks an app installed once the workspace authorised it', async () => {
    await connect(operator, clientId, 'members:read');
    const one = await data<WorkspaceDirectoryListing>(
      await call('GET', `/api/v1/workspaces/${operator.workspaceId}/app-directory/sheet-sync`, {
        cookie: operator.cookie,
      }),
    );
    expect(one.installedGrantId).toMatch(/^og_/);
    expect(one.installUrl).toBe('https://sheets.example/install');
  });

  it('a workspace the operator has no seat in is 404', async () => {
    const res = await call('GET', `/api/v1/workspaces/${operator.workspaceId}/app-directory`, {
      cookie: dev.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe('the public endpoint', () => {
  it('follows the platform flag only, is cacheable and shows no private fields', async () => {
    expect((await call('GET', '/api/v1/public/apps', { origin: null })).status).toBe(404);
    await flagOn('platform', null);
    await env.CACHE.delete('flags:v1:-:-');
    try {
      const res = await call('GET', '/api/v1/public/apps', { origin: null });
      expect(res.headers.get('cache-control')).toContain('max-age=300');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const listings = await data<DirectoryListing[]>(res);
      const text = JSON.stringify(listings);
      expect(text).toContain('sheet-sync');
      expect(text).not.toContain(clientId);
      expect(text).not.toContain('workspaceId');
      const one = await data<DirectoryListing>(
        await call('GET', '/api/v1/public/apps/sheet-sync', { origin: null }),
      );
      expect(one.name).toBe('Sheet Sync');
      expect((await call('GET', '/api/v1/public/apps/no-such-app', { origin: null })).status).toBe(
        404,
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM feature_flags WHERE key = 'app_directory' AND scope = 'platform'",
      ).run();
      await env.CACHE.delete('flags:v1:-:-');
    }
  });

  it('publishes the manifest JSON Schema', async () => {
    const res = await call('GET', '/api/v1/public/app-manifest.schema.json', { origin: null });
    expect(res.status).toBe(200);
    const schema = await json<{ $schema: string; properties: Record<string, unknown> }>(res);
    expect(schema.$schema).toContain('2020-12');
    expect(Object.keys(schema.properties)).toContain('manifestVersion');
  });
});

describe('editing and withdrawing', () => {
  it('an edit returns an approved listing to draft and out of the directory', async () => {
    listing = await data<AppListing>(
      await call('PATCH', `${listingsPath(dev)}/${listing.id}`, {
        cookie: dev.cookie,
        body: { tagline: 'Rows for every new Member' },
      }),
    );
    expect(listing.status).toBe('draft');
    const res = await call(
      'GET',
      `/api/v1/workspaces/${operator.workspaceId}/app-directory/sheet-sync`,
      {
        cookie: operator.cookie,
      },
    );
    expect(res.status).toBe(404);
  });

  it('withdraws an approved listing to delisted; staff delist needs a note', async () => {
    await data(
      await call('POST', `${listingsPath(dev)}/${listing.id}/submit`, { cookie: dev.cookie }),
    );
    const path = `/api/v1/app-directory/review/listings/${listing.id}`;
    await data(
      await call('POST', path, { cookie: staff.cookie, body: await approval(listing.id) }),
    );
    const withdrawn = await data<AppListing>(
      await call('POST', `${listingsPath(dev)}/${listing.id}/withdraw`, { cookie: dev.cookie }),
    );
    expect(withdrawn.status).toBe('delisted');
  });
});

describe('manifests', () => {
  const manifest = (overrides: Partial<AppManifest['oauth']> = {}) => ({
    manifestVersion: 1,
    listing: {
      name: 'Sheet Sync',
      slug: 'sheet-sync',
      tagline: 'From the manifest',
      categories: ['productivity'],
      websiteUrl: 'https://sheets.example',
      supportUrl: 'https://sheets.example/help',
      privacyUrl: 'https://sheets.example/privacy',
      installUrl: 'https://sheets.example/install',
    },
    oauth: {
      clientType: 'public',
      redirectUris: [REDIRECT],
      scopes: ['members:read'],
      ...overrides,
    },
    webhooks: { events: ['member.created'] },
  });

  it('refuses a manifest that does not match the app, naming each problem', async () => {
    const res = await call('POST', `${listingsPath(dev)}/import`, {
      cookie: dev.cookie,
      body: {
        appId,
        manifest: manifest({
          clientType: 'confidential',
          redirectUris: ['https://elsewhere.example/cb'],
          scopes: ['members:write'],
        }),
      },
    });
    expect(res.status).toBe(400);
    const { error } = await json<{ error: { details: { path: string }[] } }>(res);
    expect(error.details.map((d) => d.path)).toEqual([
      'manifest.oauth.clientType',
      'manifest.oauth.redirectUris.0',
      'manifest.oauth.scopes.0',
    ]);
    const unknown = await call('POST', `${listingsPath(dev)}/import`, {
      cookie: dev.cookie,
      body: { appId, manifest: { ...manifest(), manifestVersion: 9 } },
    });
    expect(unknown.status).toBe(400);
  });

  it('replaces the listing as a draft and exports it back', async () => {
    const imported = await data<AppListing>(
      await call('POST', `${listingsPath(dev)}/import`, {
        cookie: dev.cookie,
        body: { appId, manifest: manifest() },
      }),
    );
    expect(imported).toMatchObject({
      id: listing.id,
      status: 'draft',
      tagline: 'From the manifest',
    });
    const exported = await data<AppManifest>(
      await call('GET', `${listingsPath(dev)}/${listing.id}/manifest`, { cookie: dev.cookie }),
    );
    expect(exported.oauth).toEqual(manifest().oauth);
    expect(exported.listing.tagline).toBe('From the manifest');
    expect(exported.webhooks.events).toEqual(['member.created']);
  });

  it('deletes a listing', async () => {
    const res = await call('DELETE', `${listingsPath(dev)}/${listing.id}`, { cookie: dev.cookie });
    expect(res.status).toBe(204);
  });
});

describe('community Flow Recipes', () => {
  let submission: RecipeSubmission;
  let flowId: string;
  const base = () => `/api/v1/channels/${devChannel}/recipe-submissions`;

  beforeAll(async () => {
    const flow = await data<Flow>(
      await call('POST', `/api/v1/channels/${devChannel}/flows`, {
        cookie: dev.cookie,
        body: { recipe: 'welcome_series' },
      }),
      201,
    );
    flowId = flow.id;
    // A webhook step whose address carries a secret, after the last email.
    const graph = flow.draftGraph;
    const last = graph.nodes[graph.nodes.length - 1]!;
    graph.nodes.push({
      id: 'hook',
      type: 'webhook_call',
      config: { url: 'https://hooks.example.com/in?key=sk_secret_value', includeFields: false },
    });
    graph.edges.push({ from: last.id, to: 'hook', label: 'default' });
    await data(
      await call('PATCH', `/api/v1/flows/${flowId}`, {
        cookie: dev.cookie,
        body: { draftGraph: graph },
      }),
    );
  });

  it('shares a Flow without its webhook address, ids or secrets', async () => {
    submission = await data<RecipeSubmission>(
      await call('POST', base(), {
        cookie: dev.cookie,
        body: { flowId, name: 'Three-email welcome', description: 'A first week for new Members.' },
      }),
      201,
    );
    expect(submission.status).toBe('draft');
    const text = JSON.stringify(submission.recipe);
    expect(text).not.toContain('hooks.example.com');
    expect(text).not.toContain('sk_secret_value');
    expect(text).not.toMatch(/[a-z]{2}_[0-9a-f]{32}/);
    expect(submission.recipe.emails).toHaveLength(3);
    expect(submission.removed.some((r) => r.nodeId === 'hook')).toBe(true);
  });

  it('needs an editor of the Channel; another workspace gets 404', async () => {
    const viewer = await seatAs(dev.workspaceId, 'viewer');
    const asViewer = await call('POST', base(), {
      cookie: viewer.cookie,
      body: { flowId, name: 'x', description: 'y' },
    });
    expect(asViewer.status).toBe(403);
    expect((await call('GET', base(), { cookie: operator.cookie })).status).toBe(404);
    const operatorChannel = (await createChannel(operator)).id;
    const foreignFlow = await call(
      'POST',
      `/api/v1/channels/${operatorChannel}/recipe-submissions`,
      {
        cookie: operator.cookie,
        body: { flowId, name: 'x', description: 'y' },
      },
    );
    expect(foreignFlow.status).toBe(404);
  });

  it('is reviewed by staff and then offered to every Channel', async () => {
    submission = await data<RecipeSubmission>(
      await call('POST', `${base()}/${submission.id}/submit`, { cookie: dev.cookie }),
    );
    expect(submission.status).toBe('submitted');
    const queue = await data<ReviewQueue>(
      await call('GET', '/api/v1/app-directory/review', { cookie: staff.cookie }),
    );
    expect(queue.recipes.some((r) => r.id === submission.id)).toBe(true);
    await data(
      await call('POST', `/api/v1/app-directory/review/recipes/${submission.id}`, {
        cookie: staff.cookie,
        body: { decision: 'approve' },
      }),
    );

    const channel = (await createChannel(operator)).id;
    const recipes = await data<CommunityRecipeInfo[]>(
      await call('GET', `/api/v1/channels/${channel}/community-recipes`, {
        cookie: operator.cookie,
      }),
    );
    const shared = recipes.find((r) => r.id === submission.id)!;
    expect(shared).toMatchObject({ emailCount: 3, setupSteps: 1, triggerType: 'confirmed' });

    const created = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channel}/community-recipes/${submission.id}/flows`, {
        cookie: operator.cookie,
      }),
      201,
    );
    const flow = await data<Flow>(
      await call('GET', `/api/v1/flows/${created.id}`, { cookie: operator.cookie }),
    );
    expect(flow.status).toBe('draft');
    expect(flow.emails).toHaveLength(3);
    expect(flow.draftPending?.nodes.map((n) => n.id)).toEqual(['hook']);
    expect(flow.draftGraph.nodes.some((n) => n.type === 'trigger')).toBe(true);
  });

  it('is off where the flag is off', async () => {
    const stranger = await signIn();
    const channel = (await createChannel(stranger)).id;
    const res = await call('GET', `/api/v1/channels/${channel}/community-recipes`, {
      cookie: stranger.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('a withdrawn recipe leaves the gallery', async () => {
    await data(await call('POST', `${base()}/${submission.id}/withdraw`, { cookie: dev.cookie }));
    const channel = (await createChannel(operator)).id;
    const recipes = await data<CommunityRecipeInfo[]>(
      await call('GET', `/api/v1/channels/${channel}/community-recipes`, {
        cookie: operator.cookie,
      }),
    );
    expect(recipes.some((r) => r.id === submission.id)).toBe(false);
  });
});
