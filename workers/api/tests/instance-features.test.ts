// Self-hosting: turning features on and off for the whole Swarm (platform-scope feature_flags rows,
// Settings → Instance). Who may, which keys, that an off survives the installer's re-run, and that
// a change reaches a feature's own gate once its cached copy is gone.
import { env } from 'cloudflare:test';
import { newId, type InstanceFeature } from '@swarm/domain';
import { applyInstallDefaults, FLAG_REGISTRY, SWITCHABLE_FLAG_KEYS } from '@swarm/flags';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, freshFactor, json, signIn, type Session } from './helpers';

const LIST = '/api/v1/instance/features';
const one = (key: string) => `${LIST}/${key}`;

let admin: Session;

async function makeAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(session);
}

const put = (key: string, enabled: unknown, cookie = admin.cookie) =>
  call('PUT', one(key), { cookie, body: { enabled } });

async function list(): Promise<InstanceFeature[]> {
  const res = await call('GET', LIST, { cookie: admin.cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: InstanceFeature[] }>(res)).data;
}

const rowsFor = async (key: string) =>
  (
    await env.DB.prepare(
      `SELECT key, scope, scope_id, enabled, updated_by, updated_at
         FROM feature_flags WHERE key = ?1`,
    )
      .bind(key)
      .all<{
        key: string;
        scope: string;
        scope_id: string | null;
        enabled: number;
        updated_by: string | null;
        updated_at: number;
      }>()
  ).results;

const installDefaults = () =>
  applyInstallDefaults(env.DB, { newId: () => newId('featureFlag'), now: Date.now() });

/** What the 60-second expiry does on a real install, for one scope's cached copy. */
const expireCache = (workspaceId?: string) => env.CACHE.delete(`flags:v1:${workspaceId ?? '-'}:-`);

beforeEach(async () => {
  admin = await signIn();
  await makeAdmin(admin);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feature_flags WHERE scope = 'platform'"),
    env.DB.prepare('DELETE FROM instance_admins'),
  ]);
  await expireCache();
});

describe('who can see and change features', () => {
  it('refuses someone signed out', async () => {
    expect((await call('GET', LIST)).status).toBe(401);
    expect((await call('PUT', one('split_tests'), { body: { enabled: true } })).status).toBe(401);
    expect(await rowsFor('split_tests')).toEqual([]);
  });

  it('refuses a signed-in person who is not an instance admin, workspace owner or not', async () => {
    const owner = await signIn();
    expect(owner.me.workspaces[0]?.role).toBe('owner');
    expect((await call('GET', LIST, { cookie: owner.cookie })).status).toBe(403);
    expect((await put('split_tests', true, owner.cookie)).status).toBe(403);
    expect(await rowsFor('split_tests')).toEqual([]);
  });

  it('does not tell a non-admin which keys exist', async () => {
    const someone = await signIn();
    expect((await put('nope', true, someone.cookie)).status).toBe(403);
    expect((await put('split_tests', true, someone.cookie)).status).toBe(403);
  });
});

describe('the list', () => {
  it('has every "build" feature and nothing else, off when no row is stored', async () => {
    const features = await list();
    expect(features.map((f) => f.key)).toEqual(SWITCHABLE_FLAG_KEYS);
    expect(features.every((f) => f.enabled === false && f.updatedAt === null)).toBe(true);
  });

  it('reads past the cache, so the screen shows what was just saved', async () => {
    await list();
    await call('GET', '/api/v1/flags'); // fills the gates' cache with "off"
    expect((await put('split_tests', true)).status).toBe(200);
    expect((await list()).find((f) => f.key === 'split_tests')?.enabled).toBe(true);
  });

  it('never returns the registry descriptions', async () => {
    const res = await call('GET', LIST, { cookie: admin.cookie });
    const text = await res.text();
    for (const key of SWITCHABLE_FLAG_KEYS) {
      expect(text).not.toContain(FLAG_REGISTRY[key].description);
    }
    expect(text).not.toContain('origin');
  });
});

describe('changing a feature', () => {
  it('stores who changed what, as one platform-scope row', async () => {
    const before = Date.now();
    const res = await put('split_tests', true);
    expect(res.status).toBe(200);
    const { data } = await json<{ data: InstanceFeature }>(res);
    expect(data).toMatchObject({
      key: 'split_tests',
      enabled: true,
      updatedBy: admin.me.operator.id,
    });
    const [row] = await rowsFor('split_tests');
    expect(row).toMatchObject({
      scope: 'platform',
      scope_id: null,
      enabled: 1,
      updated_by: admin.me.operator.id,
    });
    expect(row?.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('stores off as a row with enabled = 0, and goes through the unique index on a change', async () => {
    await put('split_tests', true);
    expect((await put('split_tests', false)).status).toBe(200);
    const rows = await rowsFor('split_tests');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(0);
    expect((await list()).find((f) => f.key === 'split_tests')).toMatchObject({
      enabled: false,
      updatedBy: admin.me.operator.id,
    });
  });

  it('stores off for a feature that never had a row', async () => {
    expect((await put('pledges', false)).status).toBe(200);
    expect((await rowsFor('pledges'))[0]?.enabled).toBe(0);
  });

  it.each([
    ['deferred', 'digest'],
    ['deferred', 'group_seats'],
    ['undecided', 'site_comments'],
    ['dropped', 'pulse'],
    ['unknown', 'no_such_feature'],
    ['an object internal', 'constructor'],
  ])('refuses %s (%s)', async (_, key) => {
    const res = await put(key, true);
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('invalid_input');
    expect(await rowsFor(key)).toEqual([]);
  });

  it('accepts every "build" key', async () => {
    for (const key of SWITCHABLE_FLAG_KEYS) expect((await put(key, true)).status, key).toBe(200);
  });

  it('needs a true or false', async () => {
    expect((await put('split_tests', 'yes')).status).toBe(400);
    expect((await put('split_tests', 1)).status).toBe(400);
    expect((await call('PUT', one('split_tests'), { cookie: admin.cookie, body: {} })).status).toBe(
      400,
    );
    expect(await rowsFor('split_tests')).toEqual([]);
  });
});

describe("the installer's defaults", () => {
  it('turn on every "build" feature but the off-at-install ones', async () => {
    await installDefaults();
    const features = await list();
    const off = features.filter((f) => !f.enabled).map((f) => f.key);
    expect(off.sort()).toEqual([
      'copilot',
      'copilot_actions',
      'copilot_byok',
      'goods',
      'partner_exchange',
      'paypal_memberships',
      'sponsor_match',
      'sso',
      'stripe_own_key',
      'subscribe_attribution_fields',
    ]);
  });

  it('an off row survives a re-run, and so does Copilot turned on', async () => {
    await installDefaults();
    await put('split_tests', false);
    await put('copilot', true);

    const { added } = await installDefaults();

    expect(added).toEqual([]);
    const features = await list();
    expect(features.find((f) => f.key === 'split_tests')).toMatchObject({
      enabled: false,
      updatedBy: admin.me.operator.id,
    });
    expect(features.find((f) => f.key === 'copilot')?.enabled).toBe(true);
    expect(await rowsFor('split_tests')).toHaveLength(1);
  });

  it('an off stored before the first run is kept too', async () => {
    await put('split_tests', false);
    const { added } = await installDefaults();
    expect(added).not.toContain('split_tests');
    expect((await rowsFor('split_tests'))[0]?.enabled).toBe(0);
  });
});

describe("a feature's own gate", () => {
  const directory = () => call('GET', '/api/v1/public/apps', { origin: null });

  it('follows a platform change once the cached copy is gone: the App Directory', async () => {
    await expireCache();
    expect((await directory()).status).toBe(404); // Off with no row, and now cached.

    expect((await put('app_directory', true)).status).toBe(200);
    // Still the cached answer: this is the "up to a minute" the screen talks about.
    expect((await directory()).status).toBe(404);

    await expireCache();
    expect((await directory()).status).toBe(200);

    expect((await put('app_directory', false)).status).toBe(200);
    expect((await directory()).status).toBe(200);
    await expireCache();
    expect((await directory()).status).toBe(404);
  });

  it('follows a platform change inside a workspace: Copilot', async () => {
    const settings = () =>
      call('GET', `/api/v1/workspaces/${admin.workspaceId}/copilot`, { cookie: admin.cookie });
    await installDefaults();
    await expireCache(admin.workspaceId);
    expect((await settings()).status).toBe(404); // Copilot starts off.

    expect((await put('copilot', true)).status).toBe(200);
    await expireCache(admin.workspaceId);
    expect((await settings()).status).toBe(200);

    expect((await put('copilot', false)).status).toBe(200);
    await expireCache(admin.workspaceId);
    const refused = await settings();
    expect(refused.status).toBe(404);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('feature_disabled');
  });

  it('reports the same value through /flags', async () => {
    await put('split_tests', true);
    await expireCache();
    const res = await call('GET', '/api/v1/flags');
    const { data } = await json<{ data: { flags: Record<string, boolean> } }>(res);
    expect(data.flags.split_tests).toBe(true);
    expect(data.flags.pledges).toBe(false);
  });
});
