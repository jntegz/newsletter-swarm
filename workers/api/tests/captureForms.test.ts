import { env } from 'cloudflare:test';
import { defaultCaptureFormConfig, newId, type SeatRole } from '@swarm/domain';
import { buildEmbedScript, integrityOf, loaderConfig } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const rank = (role: SeatRole) => ROLES.indexOf(role);

let owner: Session;
let channelId: string;
const seats = {} as Record<SeatRole, Session>;
let outsider: Session;

interface FormBody {
  id: string;
  version: number;
  status: string;
  hasUnpublishedChanges: boolean;
  draft: ReturnType<typeof defaultCaptureFormConfig>;
}

async function createForm(name = 'Footer form', config?: unknown): Promise<FormBody> {
  const res = await call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
    cookie: owner.cookie,
    body: { name, ...(config ? { config } : {}) },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ data: FormBody }>(res)).data;
}

async function publishedForm(): Promise<FormBody> {
  const form = await createForm();
  const res = await call('POST', `/api/v1/capture-forms/${form.id}/publish`, {
    cookie: owner.cookie,
  });
  expect(res.status).toBe(200);
  return (await json<{ data: FormBody }>(res)).data;
}

async function pendingMember(): Promise<string> {
  const id = newId('member');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)`,
  )
    .bind(id, channelId, uniqueEmail('pending'), now)
    .run();
  return id;
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  seats.owner = owner;
  for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
    seats[role] = await seatAs(owner.workspaceId, role);
  }
  outsider = await signIn();
});

interface RouteCase {
  name: string;
  minimum: SeatRole;
  request: (session: Session) => Promise<Response>;
}

const ROUTES: RouteCase[] = [
  {
    name: 'list capture forms',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/channels/${channelId}/capture-forms`, { cookie: s.cookie }),
  },
  {
    name: 'create a capture form',
    minimum: 'author',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
        cookie: s.cookie,
        body: { name: 'Sidebar' },
      }),
  },
  {
    name: 'read a capture form',
    minimum: 'viewer',
    request: async (s) =>
      call('GET', `/api/v1/capture-forms/${(await createForm()).id}`, { cookie: s.cookie }),
  },
  {
    name: 'edit a draft',
    minimum: 'author',
    request: async (s) =>
      call('PATCH', `/api/v1/capture-forms/${(await createForm()).id}`, {
        cookie: s.cookie,
        body: { name: 'Renamed' },
      }),
  },
  {
    name: 'publish',
    minimum: 'editor',
    request: async (s) =>
      call('POST', `/api/v1/capture-forms/${(await createForm()).id}/publish`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'delete',
    minimum: 'editor',
    request: async (s) =>
      call('DELETE', `/api/v1/capture-forms/${(await createForm()).id}`, { cookie: s.cookie }),
  },
  {
    name: 'list versions',
    minimum: 'viewer',
    request: async (s) =>
      call('GET', `/api/v1/capture-forms/${(await publishedForm()).id}/versions`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'restore a version',
    minimum: 'author',
    request: async (s) =>
      call('POST', `/api/v1/capture-forms/${(await publishedForm()).id}/versions/1/restore`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'get the snippet',
    minimum: 'viewer',
    request: async (s) =>
      call('GET', `/api/v1/capture-forms/${(await publishedForm()).id}/snippet`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'read stats',
    minimum: 'viewer',
    request: async (s) =>
      call('GET', `/api/v1/capture-forms/${(await createForm()).id}/stats`, { cookie: s.cookie }),
  },
  {
    name: 'resend a confirmation',
    minimum: 'editor',
    request: async (s) =>
      call('POST', `/api/v1/members/${await pendingMember()}/confirmation`, { cookie: s.cookie }),
  },
  {
    name: 'turn double opt-in off for the Channel',
    minimum: 'editor',
    request: (s) =>
      call('PATCH', `/api/v1/channels/${channelId}`, {
        cookie: s.cookie,
        body: { doubleOptIn: true },
      }),
  },
];

describe('capture forms: role matrix', () => {
  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = rank(role) >= rank(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
  }
});

describe('capture forms: tenancy', () => {
  for (const route of ROUTES) {
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('signed-out requests get 401', async () => {
    for (const route of ROUTES) {
      expect((await route.request({ ...owner, cookie: '' })).status).toBe(401);
    }
  });

  it('names the form, not the Channel, in a cross-workspace 404', async () => {
    const form = await createForm();
    const res = await call('GET', `/api/v1/capture-forms/${form.id}`, { cookie: outsider.cookie });
    expect(await json(res)).toMatchObject({ error: { message: 'Signup form not found.' } });
  });
});

describe('capture forms', () => {
  it('publishes drafts as numbered versions and restores one as the draft', async () => {
    const form = await createForm();
    expect(form).toMatchObject({ status: 'draft', version: 0, hasUnpublishedChanges: true });

    const first = await call('POST', `/api/v1/capture-forms/${form.id}/publish`, {
      cookie: owner.cookie,
    });
    expect((await json<{ data: FormBody }>(first)).data).toMatchObject({
      status: 'published',
      version: 1,
      hasUnpublishedChanges: false,
    });

    const edited = await call('PATCH', `/api/v1/capture-forms/${form.id}`, {
      cookie: owner.cookie,
      body: { config: { ...defaultCaptureFormConfig(), placement: 'popup' } },
    });
    expect((await json<{ data: FormBody }>(edited)).data.hasUnpublishedChanges).toBe(true);
    await call('POST', `/api/v1/capture-forms/${form.id}/publish`, { cookie: owner.cookie });

    const versions = await json<{ data: { version: number; config: { placement: string } }[] }>(
      await call('GET', `/api/v1/capture-forms/${form.id}/versions`, { cookie: owner.cookie }),
    );
    expect(versions.data.map((v) => [v.version, v.config.placement])).toEqual([
      [2, 'popup'],
      [1, 'inline'],
    ]);

    const restored = await call('POST', `/api/v1/capture-forms/${form.id}/versions/1/restore`, {
      cookie: owner.cookie,
    });
    const body = (await json<{ data: FormBody }>(restored)).data;
    expect(body.draft.placement).toBe('inline');
    expect(body.version).toBe(2);
    expect(
      (
        await call('POST', `/api/v1/capture-forms/${form.id}/versions/9/restore`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('validates configs: one required email field, short messages, https redirects', async () => {
    const base = defaultCaptureFormConfig();
    const bad = [
      { ...base, fields: [{ key: 'first_name', label: 'Name', required: false }] },
      { ...base, success: { type: 'message', message: 'x'.repeat(81) } },
      { ...base, success: { type: 'redirect', url: 'http://news.example.com/thanks' } },
      { ...base, success: { type: 'redirect', url: 'javascript:alert(1)' } },
      { ...base, trigger: { type: 'delay', seconds: 0 } },
      { ...base, allowedOrigins: ['news.example.com/path'] },
      { ...base, fields: [...base.fields, { key: 'field:nope', label: 'Nope', required: false }] },
    ];
    for (const config of bad) {
      const res = await call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
        cookie: owner.cookie,
        body: { name: 'Bad', config },
      });
      expect(res.status, JSON.stringify(config)).toBe(400);
    }
    const ok = await createForm('Good', {
      ...base,
      allowedOrigins: ['https://News.Example.com/'],
      trigger: { type: 'scroll_velocity' },
      frequency: { type: 'once_per_days', days: 7 },
    });
    expect(ok.draft.allowedOrigins).toEqual(['https://news.example.com']);
  });

  it('hashes the exact script the capture worker serves for the published version', async () => {
    const form = await publishedForm();
    const snippet = await json<{
      data: { integrity: string; script: string; scriptUrl: string; noscript: string };
    }>(await call('GET', `/api/v1/capture-forms/${form.id}/snippet`, { cookie: owner.cookie }));
    const served = buildEmbedScript(loaderConfig('http://localhost:8791', form.id, 1, form.draft));
    expect(snippet.data.integrity).toBe(await integrityOf(served));
    expect(snippet.data.scriptUrl).toBe(`http://localhost:8791/v1/${form.id}.js?v=1`);
    expect(snippet.data.script).toContain(
      `integrity="${snippet.data.integrity}" crossorigin="anonymous"`,
    );
    expect(snippet.data.noscript).toContain(
      `action="http://localhost:8791/v1/${form.id}/subscribe" method="post"`,
    );

    const draft = await createForm();
    const none = await call('GET', `/api/v1/capture-forms/${draft.id}/snippet`, {
      cookie: owner.cookie,
    });
    expect(none.status).toBe(409);
  });

  it('reports daily stats with conversion', async () => {
    const form = await createForm();
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO capture_form_daily (form_id, day, views, submissions, confirmed) VALUES (?1, ?2, 200, 20, 10)',
    )
      .bind(form.id, today)
      .run();
    const stats = await json<{
      data: {
        days: { day: string; views: number }[];
        totals: { views: number };
        conversion: number;
      };
    }>(
      await call('GET', `/api/v1/capture-forms/${form.id}/stats?days=7`, { cookie: owner.cookie }),
    );
    expect(stats.data.days).toHaveLength(7);
    expect(stats.data.days.at(-1)).toEqual({
      day: today,
      views: 200,
      submissions: 20,
      confirmed: 10,
    });
    expect(stats.data.totals).toEqual({ views: 200, submissions: 20, confirmed: 10 });
    expect(stats.data.conversion).toBe(0.05);
  });

  it('resends a confirmation to a pending Member, rate limited, and only to pending ones', async () => {
    const memberId = await pendingMember();
    const send = () =>
      call('POST', `/api/v1/members/${memberId}/confirmation`, { cookie: owner.cookie });
    expect((await send()).status).toBe(202);
    const email = (await env.DB.prepare('SELECT email FROM members WHERE id = ?1')
      .bind(memberId)
      .first<string>('email'))!;
    const mail = await json<{
      data: { category: string; text: string; headers: Record<string, string> };
    }>(await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`));
    expect(mail.data.category).toBe('confirm');
    expect(mail.data.text).toContain('http://localhost:8791/v1/confirm/v2.confirm.');
    expect(mail.data.headers['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:8791\/v1\/leave\//);
    expect((await send()).status).toBe(429);

    await env.DB.prepare(`UPDATE members SET status = 'active' WHERE id = ?1`).bind(memberId).run();
    expect((await send()).status).toBe(409);
  });

  it('keeps double opt-in on by default and lets editors turn it off', async () => {
    const channel = await createChannel(owner);
    const read = async () =>
      (
        await json<{ data: { doubleOptIn: boolean } }>(
          await call('GET', `/api/v1/channels/${channel.id}`, { cookie: owner.cookie }),
        )
      ).data.doubleOptIn;
    expect(await read()).toBe(true);
    const res = await call('PATCH', `/api/v1/channels/${channel.id}`, {
      cookie: owner.cookie,
      body: { doubleOptIn: false },
    });
    expect((await json<{ data: { doubleOptIn: boolean } }>(res)).data.doubleOptIn).toBe(false);
    expect(await read()).toBe(false);
    const settings = await env.DB.prepare('SELECT settings_json FROM channels WHERE id = ?1')
      .bind(channel.id)
      .first<string>('settings_json');
    expect(JSON.parse(settings!)).toMatchObject({ doubleOptIn: false });
  });

  it('hides deleted forms', async () => {
    const form = await createForm();
    expect(
      (await call('DELETE', `/api/v1/capture-forms/${form.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/capture-forms/${form.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);
  });
});
