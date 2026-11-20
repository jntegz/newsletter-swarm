// Where website code may run (migrations/0065_site_code_rules.sql): saving scripts on the platform
// address, the instance rules in Settings > Instance, and confirming a tracking tool as necessary.
import { env } from 'cloudflare:test';
import {
  newId,
  type EmailCheckStatus,
  type InstanceSiteCode,
  type SiteCodeEntry,
  type SiteSettings,
} from '@swarm/domain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  freshFactor,
  json,
  seatAs,
  signIn,
  signInWithFactor,
  type Session,
} from './helpers';

const GA: SiteCodeEntry = {
  name: 'Analytics',
  preset: 'google_analytics',
  category: 'analytics',
  value: 'G-ABC123DEF4',
};
const VERIFY: SiteCodeEntry = {
  name: 'Verify',
  preset: 'verification',
  category: 'necessary',
  value: '<meta name="site-verification" content="abc123">',
};
const hex = () => crypto.randomUUID().replace(/-/g, '');

interface Publication {
  owner: Session;
  channelId: string;
}

async function publication(): Promise<Publication> {
  const owner = await signIn();
  const { id: channelId } = await createChannel(owner);
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'site_custom_code', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), channelId)
    .run();
  return { owner, channelId };
}

const saveCode = (pub: Publication, code: SiteCodeEntry[], session = pub.owner) =>
  call('PATCH', `/api/v1/channels/${pub.channelId}/site/settings`, {
    cookie: session.cookie,
    body: { code },
  });

async function errorOf(res: Response) {
  return (await json<{ error: { code: string; message: string } }>(res)).error;
}

async function makeInstanceAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(session);
}

async function addCustomDomain(pub: Publication, status = 'active') {
  await env.DB.prepare(
    `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, is_primary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'web', ?5, ?6, 0, 0)`,
  )
    .bind(
      `hn_${hex()}`,
      pub.owner.workspaceId,
      pub.channelId,
      `n-${hex()}.example`,
      status,
      status === 'active' ? 1 : 0,
    )
    .run();
}

const settingsOf = async (pub: Publication) =>
  (
    await json<{ data: SiteSettings }>(
      await call('GET', `/api/v1/channels/${pub.channelId}/site/settings`, {
        cookie: pub.owner.cookie,
      }),
    )
  ).data;

const cacheVersion = async (channelId: string) =>
  (
    await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
      .bind(channelId)
      .first<{ cache_version: number }>()
  )?.cache_version;

let admin: Session;
beforeAll(async () => {
  admin = await signIn();
  await makeInstanceAdmin(admin);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM site_code_rules'),
    env.DB.prepare('DELETE FROM site_code_workspaces'),
    env.DB.prepare('DELETE FROM site_code_held'),
  ]);
});

describe('saving code on the platform address', () => {
  it('refuses new scripts for a workspace nobody allowed, and says how to fix it', async () => {
    const pub = await publication();
    const res = await saveCode(pub, [GA]);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/only on your own domain/);
    expect((await settingsOf(pub)).codeAccess).toEqual({
      platformAddress: false,
      reason: 'not_allowed',
      customDomain: false,
    });
  });

  it('still saves verification tags and the popup, which load nothing', async () => {
    const pub = await publication();
    expect((await saveCode(pub, [VERIFY])).status).toBe(200);
    const res = await call('PATCH', `/api/v1/channels/${pub.channelId}/site/settings`, {
      cookie: pub.owner.cookie,
      body: { consent: { enabled: true } },
    });
    expect(res.status).toBe(200);
  });

  it('keeps code saved before, and refuses a change to it', async () => {
    const pub = await publication();
    await env.DB.prepare(
      `INSERT INTO site_settings (channel_id, code_json, updated_at) VALUES (?1, ?2, 0)
       ON CONFLICT (channel_id) DO UPDATE SET code_json = excluded.code_json`,
    )
      .bind(pub.channelId, JSON.stringify([GA]))
      .run();
    // Renaming it, or changing when it runs, keeps the same code.
    expect((await saveCode(pub, [{ ...GA, name: 'Visits', category: 'marketing' }])).status).toBe(
      200,
    );
    expect((await saveCode(pub, [{ ...GA, value: 'G-ZZZ999ZZZ9' }])).status).toBe(403);
    expect((await saveCode(pub, [])).status).toBe(200);
  });

  it('saves on a publication with an active custom domain, where the code will run', async () => {
    const pub = await publication();
    await addCustomDomain(pub, 'pending');
    expect((await saveCode(pub, [GA])).status).toBe(403);
    await addCustomDomain(pub);
    expect((await saveCode(pub, [GA])).status).toBe(200);
    expect((await settingsOf(pub)).codeAccess).toEqual({
      platformAddress: false,
      reason: 'not_allowed',
      customDomain: true,
    });
  });

  it('saves in a workspace an instance admin made: it is allowed when they become one', async () => {
    const pub = await publication();
    await makeInstanceAdmin(pub.owner);
    expect((await saveCode(pub, [GA])).status).toBe(200);
    expect((await settingsOf(pub)).codeAccess.reason).toBe('allowed');
    expect(
      await env.DB.prepare('SELECT allowed_by FROM site_code_workspaces WHERE workspace_id = ?1')
        .bind(pub.owner.workspaceId)
        .first(),
    ).toEqual({ allowed_by: pub.owner.me.operator.id });
  });

  it('does not count an instance admin who only has an admin seat', async () => {
    const pub = await publication();
    const helper = await seatAs(pub.owner.workspaceId, 'admin');
    await makeInstanceAdmin(helper);
    expect((await saveCode(pub, [GA], helper)).status).toBe(403);
  });

  it('still needs the admin role, whatever the instance allows', async () => {
    const pub = await publication();
    await call('PUT', `/api/v1/instance/site-code/workspaces/${pub.owner.workspaceId}`, {
      cookie: admin.cookie,
      body: { allowed: true },
    });
    const editor = await seatAs(pub.owner.workspaceId, 'editor');
    expect((await saveCode(pub, [GA], editor)).status).toBe(403);
    expect((await saveCode(pub, [GA])).status).toBe(200);
  });
});

describe('Settings > Instance: code on websites', () => {
  it('is for instance admins only', async () => {
    const owner = await signIn();
    for (const [method, path, body] of [
      ['GET', '/api/v1/instance/site-code', undefined],
      ['PUT', '/api/v1/instance/site-code', { everyWorkspace: true }],
      ['PUT', `/api/v1/instance/site-code/workspaces/${owner.workspaceId}`, { allowed: true }],
    ] as const) {
      expect((await call(method, path, { body })).status, path).toBe(401);
      // Owning the workspace is not enough to allow it.
      const res = await call(method, path, { cookie: owner.cookie, body });
      expect(res.status, path).toBe(403);
    }
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM site_code_workspaces').first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('allows one workspace without touching another, and logs it in that workspace', async () => {
    const pub = await publication();
    const other = await publication();
    await env.DB.prepare(
      'INSERT INTO site_settings (channel_id, updated_at) VALUES (?1, 0) ON CONFLICT DO NOTHING',
    )
      .bind(pub.channelId)
      .run();
    const before = await cacheVersion(pub.channelId);
    const res = await call(
      'PUT',
      `/api/v1/instance/site-code/workspaces/${pub.owner.workspaceId}`,
      { cookie: admin.cookie, body: { allowed: true } },
    );
    expect(res.status).toBe(200);
    const { data } = await json<{ data: InstanceSiteCode }>(res);
    expect(data.workspaces.find((w) => w.id === pub.owner.workspaceId)?.allowed).toBe(true);
    expect(data.workspaces.find((w) => w.id === other.owner.workspaceId)?.allowed).toBe(false);
    expect(await cacheVersion(pub.channelId)).toBe((before ?? 0) + 1);

    expect((await saveCode(pub, [GA])).status).toBe(200);
    expect((await saveCode(other, [GA])).status).toBe(403);

    const audit = await env.DB.prepare(
      'SELECT action, actor_operator_id FROM audit_events WHERE workspace_id = ?1 AND action LIKE ?2',
    )
      .bind(pub.owner.workspaceId, 'instance.site_code_%')
      .all<{ action: string; actor_operator_id: string }>();
    expect(audit.results).toEqual([
      { action: 'instance.site_code_allowed', actor_operator_id: admin.me.operator.id },
    ]);

    // Stopping it again keeps the saved code, which then only runs on a custom domain.
    await call('PUT', `/api/v1/instance/site-code/workspaces/${pub.owner.workspaceId}`, {
      cookie: admin.cookie,
      body: { allowed: false },
    });
    expect((await settingsOf(pub)).code).toEqual([GA]);
    expect((await settingsOf(pub)).codeAccess.platformAddress).toBe(false);
  });

  it('answers 404 for a workspace that does not exist', async () => {
    const res = await call('PUT', `/api/v1/instance/site-code/workspaces/ws_${'0'.repeat(32)}`, {
      cookie: admin.cookie,
      body: { allowed: true },
    });
    expect(res.status).toBe(404);
  });

  it('lets every workspace add code with the instance-wide switch, off by default', async () => {
    const pub = await publication();
    const read = await call('GET', '/api/v1/instance/site-code', { cookie: admin.cookie });
    expect((await json<{ data: InstanceSiteCode }>(read)).data.everyWorkspace).toBe(false);
    const on = await call('PUT', '/api/v1/instance/site-code', {
      cookie: admin.cookie,
      body: { everyWorkspace: true },
    });
    expect((await json<{ data: InstanceSiteCode }>(on)).data.everyWorkspace).toBe(true);
    expect((await saveCode(pub, [GA])).status).toBe(200);
    expect((await settingsOf(pub)).codeAccess.reason).toBe('every_workspace');
  });

  it('turning the switch on does not release code that was withheld', async () => {
    const waiting = await publication();
    await env.DB.prepare(
      `INSERT INTO site_settings (channel_id, code_json, updated_at) VALUES (?1, ?2, 0)
       ON CONFLICT (channel_id) DO UPDATE SET code_json = excluded.code_json`,
    )
      .bind(waiting.channelId, JSON.stringify([GA]))
      .run();
    const fresh = await publication();
    const on = await call('PUT', '/api/v1/instance/site-code', {
      cookie: admin.cookie,
      body: { everyWorkspace: true },
    });
    const rules = (await json<{ data: InstanceSiteCode }>(on)).data;
    expect(rules.workspaces.find((w) => w.id === waiting.owner.workspaceId)).toMatchObject({
      allowed: false,
      held: true,
    });
    expect(rules.workspaces.find((w) => w.id === fresh.owner.workspaceId)?.held).toBe(false);
    // The waiting code stays off, and can't be changed into something else meanwhile.
    expect((await settingsOf(waiting)).codeAccess).toMatchObject({
      reason: 'held',
      platformAddress: false,
    });
    expect((await saveCode(waiting, [{ ...GA, value: 'G-ZZZ999ZZZ9' }])).status).toBe(403);
    // A workspace with nothing waiting may add code under the new rule.
    expect((await saveCode(fresh, [GA])).status).toBe(200);
    expect((await settingsOf(fresh)).codeAccess.reason).toBe('every_workspace');
    // Saving the switch again holds nobody new; allowing the workspace by itself releases it.
    await call('PUT', '/api/v1/instance/site-code', {
      cookie: admin.cookie,
      body: { everyWorkspace: true },
    });
    expect((await settingsOf(fresh)).codeAccess.reason).toBe('every_workspace');
    await call('PUT', `/api/v1/instance/site-code/workspaces/${waiting.owner.workspaceId}`, {
      cookie: admin.cookie,
      body: { allowed: true },
    });
    expect((await settingsOf(waiting)).codeAccess.reason).toBe('allowed');
  });

  it('records each change in a hash-chained install audit log', async () => {
    await call('PUT', '/api/v1/instance/site-code', {
      cookie: admin.cookie,
      body: { everyWorkspace: true },
    });
    const pub = await publication();
    await call('PUT', `/api/v1/instance/site-code/workspaces/${pub.owner.workspaceId}`, {
      cookie: admin.cookie,
      body: { allowed: true },
    });
    const read = async () =>
      (
        await json<{
          data: {
            items: {
              seq: number;
              action: string;
              actorEmail: string;
              metadata: Record<string, unknown>;
            }[];
            nextCursor: string | null;
            verification: { ok: boolean; brokenAtSeq: number | null };
          };
        }>(await call('GET', '/api/v1/instance/audit', { cookie: admin.cookie }))
      ).data;
    const log = await read();
    expect(log.verification.ok).toBe(true);
    expect(log.items[0]).toMatchObject({
      action: 'instance.setting_changed',
      actorEmail: admin.email,
      metadata: {
        method: 'PUT',
        path: `/api/v1/instance/site-code/workspaces/${pub.owner.workspaceId}`,
        request: { allowed: true },
      },
    });
    expect(log.items[1]?.metadata).toMatchObject({ request: { everyWorkspace: true } });
    // A page at a time, newest first; the chain is verified whole on every page.
    const pageOf = async (query: string) =>
      (
        await json<{
          data: {
            items: { seq: number }[];
            nextCursor: string | null;
            verification: { ok: boolean };
          };
        }>(await call('GET', `/api/v1/instance/audit?${query}`, { cookie: admin.cookie }))
      ).data;
    const newest = await pageOf('limit=1');
    expect(newest.items.map((i) => i.seq)).toEqual([log.items[0]?.seq]);
    expect(newest.nextCursor).toBe(String(log.items[0]?.seq));
    expect(newest.verification.ok).toBe(true);
    const older = await pageOf(`limit=1&cursor=${newest.nextCursor}`);
    expect(older.items.map((i) => i.seq)).toEqual([log.items[1]?.seq]);
    expect(older.nextCursor).toBe(String(log.items[1]?.seq));
    // Past the oldest entry there is nothing more.
    const last = await pageOf('cursor=2');
    expect(last.items.map((i) => i.seq)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    expect(
      (await call('GET', '/api/v1/instance/audit?cursor=nope', { cookie: admin.cookie })).status,
    ).toBe(400);
    // Someone with a seat elsewhere can't read it.
    expect((await call('GET', '/api/v1/instance/audit', { cookie: pub.owner.cookie })).status).toBe(
      403,
    );
    // Editing a past entry is detected.
    await env.DB.prepare(
      `UPDATE instance_audit_events SET metadata_json = '{"request":{"everyWorkspace":false}}'
        WHERE seq = (SELECT min(seq) FROM instance_audit_events)`,
    ).run();
    expect((await read()).verification).toMatchObject({ ok: false, brokenAtSeq: 1 });
    await env.DB.prepare('DELETE FROM instance_audit_events').run();
  });

  it('marks workspaces an instance admin owns, for information', async () => {
    const res = await call('GET', '/api/v1/instance/site-code', { cookie: admin.cookie });
    const { data } = await json<{ data: InstanceSiteCode }>(res);
    expect(data.workspaces.find((w) => w.id === admin.workspaceId)?.ownedByInstanceAdmin).toBe(
      true,
    );
  });
});

describe('an instance admin made an owner of someone else’s workspace', () => {
  it('allows that workspace nothing on the install, and tells the instance admin', async () => {
    const tenant = await publication();
    const installOwner = await signIn();
    await makeInstanceAdmin(installOwner);
    // The tenant invited the install owner as a viewer, then made them an owner without asking.
    const seatId = `st_${hex()}`;
    await env.DB.prepare(
      'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
    )
      .bind(seatId, tenant.owner.workspaceId, installOwner.me.operator.id, 'viewer', Date.now())
      .run();
    const promoted = await call(
      'PATCH',
      `/api/v1/workspaces/${tenant.owner.workspaceId}/seats/${seatId}`,
      { cookie: tenant.owner.cookie, body: { role: 'owner' } },
    );
    expect(promoted.status).toBe(200);
    // The instance admin hears about it.
    const mail = await json<{ data: { category: string; subject: string; text: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(installOwner.email)}`),
    );
    expect(mail.data).toMatchObject({
      category: 'seat_role_changed',
      subject: 'Your role in My workspace changed',
    });
    expect(mail.data.text).toContain(
      `${tenant.owner.email} changed your role in My workspace from viewer to owner`,
    );
    expect(mail.data.text).not.toContain('\u2014');
    // Neither code on the install's own domain nor the install's DeBounce credits.
    expect((await saveCode(tenant, [GA])).status).toBe(403);
    expect((await settingsOf(tenant)).codeAccess.reason).toBe('not_allowed');
    const checks = await call(
      'GET',
      `/api/v1/workspaces/${tenant.owner.workspaceId}/email-checks`,
      {
        cookie: tenant.owner.cookie,
      },
    );
    expect((await json<{ data: EmailCheckStatus }>(checks)).data.access).toBe('not_allowed');
    // Settings > Instance shows where an instance admin is an owner, next to its switch. (The
    // role change ended the install owner's sessions, so they sign in again.)
    const back = await signInWithFactor(installOwner.email);
    const listed = await json<{ data: InstanceSiteCode }>(
      await call('GET', '/api/v1/instance/site-code', { cookie: back.cookie }),
    );
    expect(listed.data.workspaces.find((w) => w.id === tenant.owner.workspaceId)).toMatchObject({
      allowed: false,
      ownedByInstanceAdmin: true,
    });
    // Only an explicit row allows it.
    await call('PUT', `/api/v1/instance/site-code/workspaces/${tenant.owner.workspaceId}`, {
      cookie: back.cookie,
      body: { allowed: true },
    });
    expect((await saveCode(tenant, [GA])).status).toBe(200);
    expect((await settingsOf(tenant)).codeAccess.reason).toBe('allowed');
  });

  it('tells a teammate who is not an instance admin about the change, without the instance note', async () => {
    const tenant = await publication();
    const teammate = await seatAs(tenant.owner.workspaceId, 'viewer');
    const seat = await env.DB.prepare(
      'SELECT id FROM seats WHERE operator_id = ?1 AND workspace_id = ?2',
    )
      .bind(teammate.me.operator.id, tenant.owner.workspaceId)
      .first<{ id: string }>();
    expect(
      (
        await call('PATCH', `/api/v1/workspaces/${tenant.owner.workspaceId}/seats/${seat!.id}`, {
          cookie: tenant.owner.cookie,
          body: { role: 'owner' },
        })
      ).status,
    ).toBe(200);
    // Every teammate hears about a role change someone else made (it signs them out too); only
    // an instance admin gets the note about Settings > Instance.
    const mail = await json<{ data: { category: string; text: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(teammate.email)}`),
    );
    expect(mail.data.category).toBe('seat_role_changed');
    expect(mail.data.text).not.toContain('instance admin');
  });
});

describe('a tracking tool marked strictly necessary', () => {
  it('needs the owner to confirm it, and the audit log keeps the confirmation', async () => {
    const pub = await publication();
    await makeInstanceAdmin(pub.owner);
    const necessary: SiteCodeEntry = { ...GA, category: 'necessary' };
    const refused = await saveCode(pub, [necessary]);
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).message).toContain('looks like Google Analytics');

    const pixel: SiteCodeEntry = {
      name: 'Pixel',
      preset: 'custom',
      category: 'necessary',
      value: '<script src="https://connect.facebook.net/en_US/fbevents.js"></script>',
    };
    expect((await saveCode(pub, [pixel])).status).toBe(400);

    const ok = await saveCode(pub, [{ ...necessary, necessaryConfirmed: true }]);
    expect(ok.status).toBe(200);
    // Not moved: it is saved as the owner chose.
    expect((await settingsOf(pub)).code[0]).toMatchObject({
      category: 'necessary',
      necessaryConfirmed: true,
    });
    const row = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'site.settings_updated'
        ORDER BY seq DESC LIMIT 1`,
    )
      .bind(pub.owner.workspaceId)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(row!.metadata_json).necessaryConfirmed).toEqual([
      { name: 'Analytics', tools: ['Google Analytics'] },
    ]);
  });

  it('asks nothing for code that looks like no known tool', async () => {
    const pub = await publication();
    await makeInstanceAdmin(pub.owner);
    const own: SiteCodeEntry = {
      name: 'Theme switch',
      preset: 'custom',
      category: 'necessary',
      value: '<script>document.documentElement.dataset.ready = "1"</script>',
    };
    expect((await saveCode(pub, [own])).status).toBe(200);
  });
});
