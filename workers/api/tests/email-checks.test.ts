// Email checks (docs/email-verification.md): who may use the install's DeBounce key, the
// workspace's rules, planning and starting a check, a publication's results and red actions,
// one subscriber's check, the import option, the file DeBounce fetches, roles and other tenants.
import { env } from 'cloudflare:test';
import {
  EMAIL_CHECK_DEFAULTS,
  newId,
  type EmailCheckRedResult,
  type EmailCheckRun,
  type EmailCheckStatus,
  type EmailCheckSummary,
  type InstanceEmailChecks,
  type MemberListItem,
} from '@swarm/domain';
import { sha256Hex } from '@swarm/db';
import { EMAIL_CHECK_DAILY_CHECKS, EMAIL_CHECK_MONTHLY_LIST_CHECKS } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, freshFactor, seatAs, signIn, type Session } from './helpers';
import { data, errorCode } from './money-helpers';

let owner: Session;
let admin: Session;
let editor: Session;
let viewer: Session;
let stranger: Session;
let channelId: string;
let otherChannel: string;

const ws = () => `/api/v1/workspaces/${owner.workspaceId}/email-checks`;

async function addMember(channel: string, email: string, status = 'active') {
  const id = newId('member');
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(id, channel, email, status, Date.now())
    .run();
  return id;
}

async function result(email: string, state: string, code: number, workspaceId = owner.workspaceId) {
  await env.DB.prepare(
    `INSERT INTO email_checks (workspace_id, email, state, code, source, checked_at)
     VALUES (?1, ?2, ?3, ?4, 'debounce', ?5)
     ON CONFLICT (workspace_id, email) DO UPDATE SET state = excluded.state, code = excluded.code`,
  )
    .bind(workspaceId, email, state, code, Date.now())
    .run();
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  admin = await seatAs(owner.workspaceId, 'admin');
  editor = await seatAs(owner.workspaceId, 'editor');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  stranger = await signIn();
  otherChannel = (await createChannel(stranger)).id;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'email_verification', 'platform', NULL, 1, 0)`,
    ).bind(newId('featureFlag')),
    // The owner runs this Swarm: making them an instance admin allows the workspace they made
    // (an explicit email_check_workspaces row, written by the trigger in 0069).
    env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)').bind(
      owner.me.operator.id,
      Date.now(),
    ),
  ]);
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(owner);
});

describe('the install’s DeBounce', () => {
  it('shows instance admins whether the key is set and the balance, never the key', async () => {
    const res = await call('GET', '/api/v1/instance/email-checks', { cookie: owner.cookie });
    const text = await res.clone().text();
    const body = await data<InstanceEmailChecks>(res);
    expect(body).toMatchObject({
      keySet: true,
      balance: 1_000_000,
      keyRejected: false,
      everyWorkspace: false,
    });
    expect(text).not.toContain('"dev"');
    expect(body.workspaces.find((w) => w.id === owner.workspaceId)).toMatchObject({
      allowed: true,
      ownedByInstanceAdmin: true,
    });
    expect(
      (await call('GET', '/api/v1/instance/email-checks', { cookie: admin.cookie })).status,
    ).toBe(403);
  });

  it('lets instance admins allow one workspace, or every one', async () => {
    const allow = await call(
      'PUT',
      `/api/v1/instance/email-checks/workspaces/${stranger.workspaceId}`,
      {
        cookie: owner.cookie,
        body: { allowed: true },
      },
    );
    const body = await data<InstanceEmailChecks>(allow);
    expect(body.workspaces.find((w) => w.id === stranger.workspaceId)?.allowed).toBe(true);
    expect(
      (
        await data<EmailCheckStatus>(
          await call('GET', `/api/v1/workspaces/${stranger.workspaceId}/email-checks`, {
            cookie: stranger.cookie,
          }),
        )
      ).access,
    ).toBe('allowed');
    await call('PUT', `/api/v1/instance/email-checks/workspaces/${stranger.workspaceId}`, {
      cookie: owner.cookie,
      body: { allowed: false },
    });
    const off = await data<EmailCheckStatus>(
      await call('GET', `/api/v1/workspaces/${stranger.workspaceId}/email-checks`, {
        cookie: stranger.cookie,
      }),
    );
    expect(off).toMatchObject({ access: 'not_allowed', available: false, balance: null });
    // Only instance admins may change it.
    expect(
      (
        await call('PUT', '/api/v1/instance/email-checks', {
          cookie: stranger.cookie,
          body: { everyWorkspace: true },
        })
      ).status,
    ).toBe(403);
  });
});

describe('a workspace’s share of the checks', () => {
  it('is set by instance admins only, and the workspace sees what it has used', async () => {
    const set = await call(
      'PUT',
      `/api/v1/instance/email-checks/workspaces/${stranger.workspaceId}`,
      { cookie: owner.cookie, body: { allowed: true, dailyChecks: 2 } },
    );
    const listed = (await data<InstanceEmailChecks>(set)).workspaces.find(
      (w) => w.id === stranger.workspaceId,
    );
    expect(listed).toMatchObject({ allowed: true, dailyChecks: 2, usedToday: 0 });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO usage_windows (scope, window_start, count) VALUES (?1, ?2, 2)
       ON CONFLICT (scope) DO UPDATE SET window_start = excluded.window_start, count = 2`,
    )
      .bind(`email_check:${stranger.workspaceId}`, now - (now % 86_400_000))
      .run();
    const status = await data<EmailCheckStatus>(
      await call('GET', `/api/v1/workspaces/${stranger.workspaceId}/email-checks`, {
        cookie: stranger.cookie,
      }),
    );
    expect(status.budget).toMatchObject({ dailyChecks: 2, usedToday: 2, exhausted: true });
    // A workspace can't raise its own share.
    expect(
      (
        await call('PUT', `/api/v1/instance/email-checks/workspaces/${stranger.workspaceId}`, {
          cookie: stranger.cookie,
          body: { allowed: true, dailyChecks: 1_000_000 },
        })
      ).status,
    ).toBe(403);
    // Back to the default.
    const reset = await call(
      'PUT',
      `/api/v1/instance/email-checks/workspaces/${stranger.workspaceId}`,
      { cookie: owner.cookie, body: { allowed: false, dailyChecks: null } },
    );
    expect(
      (await data<InstanceEmailChecks>(reset)).workspaces.find((w) => w.id === stranger.workspaceId)
        ?.dailyChecks,
    ).toBe(EMAIL_CHECK_DAILY_CHECKS);
  });
});

describe('a workspace’s list checks (S04-P3-TR-list-check-tenant-budget)', () => {
  it('are set by instance admins, shown to the workspace, and stop a check that needs more', async () => {
    const set = await call('PUT', `/api/v1/instance/email-checks/workspaces/${owner.workspaceId}`, {
      cookie: owner.cookie,
      body: { allowed: true, listChecks: 40 },
    });
    expect(set.status).toBe(200);
    expect(
      (await data<InstanceEmailChecks>(set)).workspaces.find((w) => w.id === owner.workspaceId),
    ).toMatchObject({ listChecks: 40, listUsedThisMonth: 0, customListChecks: true });
    const status = await data<EmailCheckStatus>(await call('GET', ws(), { cookie: admin.cookie }));
    expect(status.budget).toMatchObject({ listChecks: 40, listUsedThisMonth: 0 });
    expect(Date.parse(status.budget.listResetsAt)).toBeGreaterThan(Date.now());
    // A workspace can't raise its own.
    expect(
      (
        await call('PUT', `/api/v1/instance/email-checks/workspaces/${owner.workspaceId}`, {
          cookie: admin.cookie,
          body: { allowed: true, listChecks: 1_000_000 },
        })
      ).status,
    ).toBe(403);

    // A planned check that needs 50 addresses checked is refused before it starts.
    const runId = newId('emailCheckRun');
    await env.DB.prepare(
      `INSERT INTO email_check_runs (id, workspace_id, scope, status, to_check, parts, method, created_at, updated_at)
       VALUES (?1, ?2, 'workspace', 'planned', 50, 1, 'single', ?3, ?3)`,
    )
      .bind(runId, owner.workspaceId, Date.now())
      .run();
    const start = await call('POST', `${ws()}/runs/${runId}/start`, { cookie: admin.cookie });
    expect(start.status).toBe(409);
    const body = (await start.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(
      /needs 50 DeBounce credits, and this workspace has 40 of its 40/,
    );
    const row = await env.DB.prepare('SELECT status FROM email_check_runs WHERE id = ?1')
      .bind(runId)
      .first<{ status: string }>();
    expect(row?.status).toBe('planned');
    await env.DB.prepare("UPDATE email_check_runs SET status = 'canceled' WHERE id = ?1")
      .bind(runId)
      .run();
    // Back to the default.
    const reset = await call(
      'PUT',
      `/api/v1/instance/email-checks/workspaces/${owner.workspaceId}`,
      { cookie: owner.cookie, body: { allowed: true, listChecks: null } },
    );
    expect(
      (await data<InstanceEmailChecks>(reset)).workspaces.find((w) => w.id === owner.workspaceId),
    ).toMatchObject({ listChecks: EMAIL_CHECK_MONTHLY_LIST_CHECKS, customListChecks: false });
  });
});

describe('a workspace’s rules', () => {
  it('shows the balance to admins only and saves rules for admins only', async () => {
    const forAdmin = await data<EmailCheckStatus>(
      await call('GET', ws(), { cookie: admin.cookie }),
    );
    expect(forAdmin).toMatchObject({
      enabled: true,
      keySet: true,
      access: 'allowed',
      available: true,
      balance: 1_000_000,
    });
    const forViewer = await data<EmailCheckStatus>(
      await call('GET', ws(), { cookie: viewer.cookie }),
    );
    expect(forViewer.balance).toBeNull();
    const settings = { ...EMAIL_CHECK_DEFAULTS, validMonths: 3 };
    expect(
      (await call('PUT', `${ws()}/settings`, { cookie: editor.cookie, body: settings })).status,
    ).toBe(403);
    const saved = await data<EmailCheckStatus>(
      await call('PUT', `${ws()}/settings`, { cookie: admin.cookie, body: settings }),
    );
    expect(saved.settings.validMonths).toBe(3);
    // Added by hand can't be refused afterwards.
    const bad = await call('PUT', `${ws()}/settings`, {
      cookie: admin.cookie,
      body: { ...settings, manual: { green: 'accept', orange: 'accept', red: 'refuse' } },
    });
    expect(bad.status).toBe(400);
    await call('PUT', `${ws()}/settings`, { cookie: admin.cookie, body: EMAIL_CHECK_DEFAULTS });
  });

  it('is invisible to other workspaces', async () => {
    expect((await call('GET', ws(), { cookie: stranger.cookie })).status).toBe(404);
    expect(
      (await call('GET', `/api/v1/channels/${channelId}/email-checks`, { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
  });
});

describe('checking a list', () => {
  it('plans, refuses a second one, starts, and is for workspace admins', async () => {
    await addMember(channelId, `plan-a-${crypto.randomUUID().slice(0, 6)}@example.org`);
    await addMember(channelId, 'info@plan.example');
    expect(
      (await call('POST', `${ws()}/runs`, { cookie: editor.cookie, body: { scope: 'workspace' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('POST', `${ws()}/runs`, {
          cookie: admin.cookie,
          body: { scope: 'channel', channelId: otherChannel },
        })
      ).status,
    ).toBe(404);
    const planned = await data<EmailCheckRun>(
      await call('POST', `${ws()}/runs`, {
        cookie: admin.cookie,
        body: { scope: 'channel', channelId },
      }),
      202,
    );
    expect(planned.status).toBe('planning');
    const again = await call('POST', `${ws()}/runs`, {
      cookie: admin.cookie,
      body: { scope: 'workspace' },
    });
    expect(again.status).toBe(409);
    // Another workspace can't read or move it.
    expect(
      (
        await call(
          'GET',
          `/api/v1/workspaces/${stranger.workspaceId}/email-checks/runs/${planned.id}`,
          {
            cookie: stranger.cookie,
          },
        )
      ).status,
    ).toBe(404);
    // Not planned yet (the jobs worker does that): starting is refused; stop cancels the plan.
    expect(
      (await call('POST', `${ws()}/runs/${planned.id}/start`, { cookie: admin.cookie })).status,
    ).toBe(409);
    const canceled = await data<EmailCheckRun>(
      await call('POST', `${ws()}/runs/${planned.id}/stop`, { cookie: admin.cookie }),
    );
    expect(canceled.status).toBe('canceled');
  });

  it('is refused for a workspace the owner hasn’t allowed', async () => {
    const res = await call('POST', `/api/v1/workspaces/${stranger.workspaceId}/email-checks/runs`, {
      cookie: stranger.cookie,
      body: { scope: 'workspace' },
    });
    expect(res.status).toBe(403);
  });
});

describe('a publication’s results', () => {
  it('counts colours and reasons, filters the list, and shows each subscriber’s colour', async () => {
    const channel = (await createChannel(owner)).id;
    const red = `red-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const green = `green-${crypto.randomUUID().slice(0, 6)}@example.org`;
    await addMember(channel, red);
    await addMember(channel, green);
    await addMember(channel, `none-${crypto.randomUUID().slice(0, 6)}@example.org`);
    await result(red, 'red', 6);
    await result(green, 'green', 5);
    const summary = await data<EmailCheckSummary>(
      await call('GET', `/api/v1/channels/${channel}/email-checks`, { cookie: viewer.cookie }),
    );
    expect(summary).toMatchObject({
      subscribers: 3,
      counts: { green: 1, orange: 0, red: 1, unchecked: 1, stale: 0 },
      reasons: expect.arrayContaining([{ code: 6, state: 'red', label: 'Will bounce', count: 1 }]),
    });
    const list = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channel}/members?emailCheck=red`, {
        cookie: viewer.cookie,
      }),
    );
    expect(list.items.map((m) => m.email)).toEqual([red]);
    expect(list.items[0]?.emailCheck).toMatchObject({
      state: 'red',
      code: 6,
      reason: 'Will bounce',
    });
    const unchecked = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channel}/members?emailCheck=unchecked`, {
        cookie: viewer.cookie,
      }),
    );
    expect(unchecked.items).toHaveLength(1);
    const byCode = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channel}/members?emailCheckCode=5`, {
        cookie: viewer.cookie,
      }),
    );
    expect(byCode.items.map((m) => m.email)).toEqual([green]);
  });

  it('stops mailing red subscribers after a count, and never touches paying ones', async () => {
    const channel = (await createChannel(owner)).id;
    const red = `red-x-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const payer = `red-pay-${crypto.randomUUID().slice(0, 6)}@example.org`;
    await addMember(channel, red);
    const payerId = await addMember(channel, payer);
    await result(red, 'red', 6);
    await result(payer, 'red', 6);
    await env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at)
       VALUES (?1, ?2, 'paid', 'comp', ?3)`,
    )
      .bind(payerId, channel, Date.now() - 1000)
      .run();
    const path = `/api/v1/channels/${channel}/email-checks/red`;
    expect(
      (await call('POST', path, { cookie: editor.cookie, body: { action: 'suppress' } })).status,
    ).toBe(403);
    const preview = await data<EmailCheckRedResult>(
      await call('POST', path, { cookie: admin.cookie, body: { action: 'suppress' } }),
    );
    expect(preview).toMatchObject({ done: 0, actionable: 1, paying: 1 });
    expect(preview.needsAttention.map((m) => m.email)).toEqual([payer]);
    const done = await data<EmailCheckRedResult>(
      await call('POST', path, {
        cookie: admin.cookie,
        body: { action: 'suppress', confirm: true },
      }),
    );
    expect(done).toMatchObject({ done: 1, remaining: 0 });
    const suppressed = await env.DB.prepare(
      'SELECT email, channel_id, reason FROM suppressions WHERE channel_id = ?1 ORDER BY email',
    )
      .bind(channel)
      .all();
    expect(suppressed.results).toEqual([{ email: red, channel_id: channel, reason: 'manual' }]);
    // A second run finds nothing left to do.
    expect(
      (
        await data<EmailCheckRedResult>(
          await call('POST', path, { cookie: admin.cookie, body: { action: 'suppress' } }),
        )
      ).actionable,
    ).toBe(0);
  });
});

describe('one subscriber', () => {
  it('shows the check to viewers and queues a new one for editors', async () => {
    const email = `one-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const id = await addMember(channelId, email);
    await result(email, 'orange', 4);
    const view = await data<{ available: boolean; check: { state: string } | null }>(
      await call('GET', `/api/v1/members/${id}/email-check`, { cookie: viewer.cookie }),
    );
    expect(view).toMatchObject({
      available: true,
      check: { state: 'orange', reason: 'Can’t be confirmed' },
    });
    expect(
      (await call('POST', `/api/v1/members/${id}/email-check`, { cookie: viewer.cookie })).status,
    ).toBe(403);
    expect(
      (await call('POST', `/api/v1/members/${id}/email-check`, { cookie: editor.cookie })).status,
    ).toBe(202);
    // "Check again" is a stored request the jobs worker reads, never a flag on the message.
    const request = await env.DB.prepare(
      'SELECT member_id, requested_by FROM email_check_requests WHERE member_id = ?1',
    )
      .bind(id)
      .first<{ member_id: string; requested_by: string }>();
    expect(request).toEqual({ member_id: id, requested_by: editor.me.operator.id });
    expect(
      (await call('GET', `/api/v1/members/${id}/email-check`, { cookie: stranger.cookie })).status,
    ).toBe(404);
  });
});

describe('the file DeBounce fetches', () => {
  it('serves a part by its token until it expires, and nothing else', async () => {
    const runId = newId('emailCheckRun');
    const token = 'A'.repeat(43);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_check_runs (id, workspace_id, scope, status, created_at, updated_at)
         VALUES (?1, ?2, 'workspace', 'running', ?3, ?3)`,
      ).bind(runId, owner.workspaceId, Date.now()),
      env.DB.prepare(
        `INSERT INTO email_check_parts (run_id, part, status, file_key, token_hash, file_expires_at)
         VALUES (?1, 1, 'submitted', ?2, ?3, ?4)`,
      ).bind(runId, `email-checks/${runId}/1.csv`, await sha256Hex(token), Date.now() + 60_000),
    ]);
    await env.IMPORTS.put(`email-checks/${runId}/1.csv`, 'jan@example.org\n');
    const res = await call('GET', `/api/v1/public/email-check-lists/${token}.csv`, {
      origin: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('jan@example.org\n');
    expect(
      (
        await call('GET', `/api/v1/public/email-check-lists/${'B'.repeat(43)}.csv`, {
          origin: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', '/api/v1/public/email-check-lists/short.csv', { origin: null })).status,
    ).toBe(400);
    await env.DB.prepare('UPDATE email_check_parts SET file_expires_at = ?1 WHERE run_id = ?2')
      .bind(Date.now() - 1, runId)
      .run();
    expect(
      (await call('GET', `/api/v1/public/email-check-lists/${token}.csv`, { origin: null })).status,
    ).toBe(404);
  });
});

describe('imports', () => {
  it('turns the check on before the import starts, for editors of this workspace', async () => {
    const id = newId('importJob');
    await env.DB.prepare(
      `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'analyzed', 'list.csv', 'x', 1, ?4, ?4)`,
    )
      .bind(id, owner.workspaceId, channelId, Date.now())
      .run();
    const path = `/api/v1/imports/${id}/email-check`;
    expect(
      (await call('PUT', path, { cookie: viewer.cookie, body: { checkAddresses: true } })).status,
    ).toBe(403);
    expect(
      (await call('PUT', path, { cookie: stranger.cookie, body: { checkAddresses: true } })).status,
    ).toBe(404);
    const job = await data<{ checkAddresses: boolean }>(
      await call('PUT', path, { cookie: editor.cookie, body: { checkAddresses: true } }),
    );
    expect(job.checkAddresses).toBe(true);
    // The import's own check: viewers follow it, editors resume or stop it.
    expect(
      await data(await call('GET', `/api/v1/imports/${id}/email-check`, { cookie: viewer.cookie })),
    ).toBeNull();
    const runId = newId('emailCheckRun');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_check_runs (id, workspace_id, scope, channel_id, import_id, status, paused_reason, created_at, updated_at)
         VALUES (?1, ?2, 'import', ?3, ?4, 'paused', 'credits', ?5, ?5)`,
      ).bind(runId, owner.workspaceId, channelId, id, Date.now()),
      env.DB.prepare('UPDATE import_jobs SET email_check_run_id = ?1 WHERE id = ?2').bind(
        runId,
        id,
      ),
    ]);
    const followed = await data<EmailCheckRun>(
      await call('GET', `/api/v1/imports/${id}/email-check`, { cookie: viewer.cookie }),
    );
    expect(followed.status).toBe('paused');
    const stop = `/api/v1/imports/${id}/email-check/stop`;
    expect((await call('POST', stop, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call('POST', stop, { cookie: stranger.cookie })).status).toBe(404);
    const stopped = await data<EmailCheckRun>(await call('POST', stop, { cookie: editor.cookie }));
    expect(stopped.status).toBe('stopped');
    await env.DB.prepare("UPDATE import_jobs SET status = 'importing' WHERE id = ?1")
      .bind(id)
      .run();
    expect(
      await errorCode(
        await call('PUT', path, { cookie: editor.cookie, body: { checkAddresses: false } }),
      ),
    ).toBe('conflict');
  });
});
