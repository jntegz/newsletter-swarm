import { env } from 'cloudflare:test';
import {
  STARTER_TEMPLATE_KEYS,
  type Dispatch,
  type Preflight,
  type StarterTemplate,
  type StarterTemplateSummary,
  type Template,
  type TemplateSummary,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

let owner: Session;
let editor: Session;
let author: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;
let siblingId: string;
let foreignChannelId: string;

const listPath = (workspaceId = owner.workspaceId) => `/api/v1/workspaces/${workspaceId}/templates`;

async function createTemplate(body: Record<string, unknown>, s: Session = editor) {
  return data<Template>(
    await call('POST', listPath(), {
      cookie: s.cookie,
      body: { name: 'Monthly letter', subject: 'Our month', content: doc('Hello'), ...body },
    }),
    201,
  );
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  siblingId = (await createChannel(owner)).id;
  editor = await seatAs(owner.workspaceId, 'editor');
  author = await seatAs(owner.workspaceId, 'author');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  outsider = await signIn();
  foreignChannelId = (await createChannel(outsider)).id;
});

describe('Template Library', () => {
  it('saves Channel and workspace-wide templates and lists them by scope', async () => {
    const own = await createTemplate({ channelId, name: 'Channel only' }, author);
    const shared = await createTemplate({ name: 'Shared' });
    expect(own).toMatchObject({ channelId, kind: 'dispatch', subject: 'Our month' });
    expect(shared.channelId).toBeNull();
    const workspaceList = await data<TemplateSummary[]>(
      await call('GET', listPath(), { cookie: viewer.cookie }),
    );
    expect(workspaceList.map((t) => t.id)).toContain(shared.id);
    expect(workspaceList.map((t) => t.id)).not.toContain(own.id);
    const channelList = await data<TemplateSummary[]>(
      await call('GET', `${listPath()}?channelId=${channelId}`, { cookie: viewer.cookie }),
    );
    expect(channelList.map((t) => t.id)).toEqual(expect.arrayContaining([own.id, shared.id]));
    const siblingList = await data<TemplateSummary[]>(
      await call('GET', `${listPath()}?channelId=${siblingId}`, { cookie: viewer.cookie }),
    );
    expect(siblingList.map((t) => t.id)).not.toContain(own.id);
    const one = await data<Template>(
      await call('GET', `/api/v1/templates/${own.id}`, { cookie: viewer.cookie }),
    );
    expect(one.content).toEqual(doc('Hello'));
  });

  it('validates input', async () => {
    const bad = [
      { name: '' },
      { name: 'x'.repeat(81) },
      { content: { type: 'paragraph' } },
      { subject: 'x'.repeat(201) },
      { kind: 'layout' },
      { channelId: 'ch_nope' },
    ];
    for (const body of bad) {
      const res = await call('POST', listPath(), {
        cookie: editor.cookie,
        body: { name: 'T', content: doc('x'), ...body },
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const t = await createTemplate({ channelId });
    for (const body of [{}, { name: '' }, { description: 'x'.repeat(281) }]) {
      const res = await call('PATCH', `/api/v1/templates/${t.id}`, { cookie: editor.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('applies roles: authors keep Channel templates, editors share with the workspace', async () => {
    expect(
      (
        await call('POST', listPath(), {
          cookie: viewer.cookie,
          body: { channelId, name: 'x', content: doc('x') },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', listPath(), {
          cookie: author.cookie,
          body: { name: 'x', content: doc('x') },
        })
      ).status,
    ).toBe(403);
    const own = await createTemplate({ channelId }, author);
    // Sharing needs the editor role on the workspace.
    const share = (s: Session) =>
      call('PATCH', `/api/v1/templates/${own.id}`, { cookie: s.cookie, body: { channelId: null } });
    expect((await share(author)).status).toBe(403);
    const shared = await data<Template>(await share(editor));
    expect(shared.channelId).toBeNull();
    expect(
      (await call('DELETE', `/api/v1/templates/${own.id}`, { cookie: author.cookie })).status,
    ).toBe(403);
    expect(
      (await call('DELETE', `/api/v1/templates/${own.id}`, { cookie: editor.cookie })).status,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/templates/${own.id}`, { cookie: editor.cookie })).status,
    ).toBe(404);
  });

  it('starts Dispatches from templates, shared ones in any Channel of the workspace only', async () => {
    const own = await createTemplate({ channelId, subject: 'From the library' });
    const shared = await createTemplate({ subject: 'Shared subject' });
    const use = (templateId: string, ch: string, s: Session = author) =>
      call('POST', `/api/v1/templates/${templateId}/use`, {
        cookie: s.cookie,
        body: { channelId: ch },
      });

    const dispatch = await data<Dispatch>(await use(own.id, channelId), 201);
    expect(dispatch).toMatchObject({ channelId, subject: 'From the library', status: 'draft' });
    expect(dispatch.content).toEqual(doc('Hello'));
    expect((await use(own.id, siblingId)).status).toBe(404);
    const elsewhere = await data<Dispatch>(await use(shared.id, siblingId), 201);
    expect(elsewhere.channelId).toBe(siblingId);
    // Never across workspaces, even for a shared template.
    expect((await use(shared.id, foreignChannelId, outsider)).status).toBe(404);
    expect((await use(shared.id, channelId, viewer)).status).toBe(403);
  });

  it('saves a Dispatch as a template', async () => {
    const dispatch = await data<Dispatch>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: author.cookie,
        body: { subject: 'Issue 7', preheader: 'Inside', content: doc('Body text') },
      }),
      201,
    );
    const path = `/api/v1/dispatches/${dispatch.id}/save-as-template`;
    const saved = await data<Template>(
      await call('POST', path, { cookie: author.cookie, body: { name: 'Issue layout' } }),
      201,
    );
    expect(saved).toMatchObject({ channelId, subject: 'Issue 7', preheader: 'Inside' });
    expect(saved.content).toEqual(doc('Body text'));
    expect(
      (await call('POST', path, { cookie: author.cookie, body: { name: 'x', shared: true } }))
        .status,
    ).toBe(403);
    const shared = await data<Template>(
      await call('POST', path, { cookie: editor.cookie, body: { name: 'x', shared: true } }),
      201,
    );
    expect(shared.channelId).toBeNull();
    expect(
      (await call('POST', path, { cookie: outsider.cookie, body: { name: 'x' } })).status,
    ).toBe(404);
  });

  it('imports HTML as a raw HTML block that sends only with raw_html_mode', async () => {
    const html =
      '<!doctype html><html><head><title>Spring sale</title></head><body><table><tr><td><a href="https://example.com">Shop</a></td></tr></table></body></html>';
    const imported = await data<Template>(
      await call('POST', `${listPath()}/import`, {
        cookie: author.cookie,
        body: { channelId, html, name: 'Imported' },
      }),
      201,
    );
    expect(imported.subject).toBe('Spring sale');
    expect(imported.content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'htmlBlock',
          attrs: {
            html: '<table><tr><td><a href="https://example.com">Shop</a></td></tr></table>',
          },
        },
      ],
    });
    expect(
      (
        await call('POST', `${listPath()}/import`, {
          cookie: author.cookie,
          body: { channelId, html: '' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `${listPath()}/import`, {
          cookie: author.cookie,
          body: { channelId, html: 'x'.repeat(50_001) },
        })
      ).status,
    ).toBe(400);

    // Used without raw_html_mode: a draft that can't be sent.
    const draft = await data<Dispatch>(
      await call('POST', `/api/v1/templates/${imported.id}/use`, {
        cookie: author.cookie,
        body: { channelId },
      }),
      201,
    );
    const blocked = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${draft.id}/preflight`, { cookie: author.cookie }),
    );
    expect(blocked.checks.find((c) => c.key === 'content')?.ok).toBe(false);
    await enableFlag('raw_html_mode', owner.workspaceId, channelId);
    const allowed = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${draft.id}/preflight`, { cookie: author.cookie }),
    );
    expect(allowed.checks.find((c) => c.key === 'content')?.ok).toBe(true);
  });

  it('exports a template as an HTML download', async () => {
    const t = await createTemplate({ channelId, name: 'Export me!' });
    const res = await call('GET', `/api/v1/templates/${t.id}/export`, { cookie: viewer.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-disposition')).toContain('export-me.html');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const html = await res.text();
    expect(html).toContain('Hello');
    expect(html).not.toContain('{{@');
    expect(
      (await call('GET', `/api/v1/templates/${t.id}/export`, { cookie: outsider.cookie })).status,
    ).toBe(404);
  });

  it('gates design templates behind design_templates', async () => {
    const res = await call('POST', listPath(), {
      cookie: editor.cookie,
      body: { channelId: siblingId, name: 'Look', kind: 'design', content: doc('x') },
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    await enableFlag('design_templates', owner.workspaceId, siblingId);
    const design = await createTemplate({ channelId: siblingId, kind: 'design', name: 'Look' });
    expect(design.kind).toBe('design');
    const listed = await data<TemplateSummary[]>(
      await call('GET', `${listPath()}?channelId=${siblingId}`, { cookie: viewer.cookie }),
    );
    expect(listed.map((t) => t.id)).toContain(design.id);
    // Off elsewhere: not listed, not readable.
    const other = await data<TemplateSummary[]>(
      await call('GET', `${listPath()}?channelId=${channelId}`, { cookie: viewer.cookie }),
    );
    expect(other.map((t) => t.id)).not.toContain(design.id);
    await env.DB.prepare(
      `UPDATE feature_flags SET enabled = 0 WHERE key = 'design_templates' AND scope_id = ?1`,
    )
      .bind(siblingId)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${siblingId}`);
    expect(
      (await call('GET', `/api/v1/templates/${design.id}`, { cookie: viewer.cookie })).status,
    ).toBe(404);
  });

  it('keeps templates inside their workspace', async () => {
    const own = await createTemplate({ channelId });
    const shared = await createTemplate({});
    for (const [method, path, body] of [
      ['GET', `/api/v1/templates/${own.id}`, undefined],
      ['GET', `/api/v1/templates/${shared.id}`, undefined],
      ['PATCH', `/api/v1/templates/${shared.id}`, { name: 'Mine now' }],
      ['DELETE', `/api/v1/templates/${shared.id}`, undefined],
      ['GET', listPath(), undefined],
      ['POST', listPath(), { name: 'x', content: doc('x') }],
    ] as const) {
      const res = await call(method, path, { cookie: outsider.cookie, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // A Channel of another workspace can't be named as a template's scope.
    const res = await call('POST', listPath(), {
      cookie: owner.cookie,
      body: { channelId: foreignChannelId, name: 'x', content: doc('x') },
    });
    expect(res.status).toBe(404);
    const move = await call('PATCH', `/api/v1/templates/${own.id}`, {
      cookie: owner.cookie,
      body: { channelId: foreignChannelId },
    });
    expect(move.status).toBe(404);
  });
});

describe('starter templates', () => {
  const starters = (id = channelId) => `/api/v1/channels/${id}/starter-templates`;

  it('lists the built-in starters for anyone who can see the Channel, with no setup', async () => {
    const list = await data<StarterTemplateSummary[]>(
      await call('GET', starters(), { cookie: viewer.cookie }),
    );
    expect(list.map((s) => s.key)).toEqual([...STARTER_TEMPLATE_KEYS]);
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const starter of list) {
      expect(starter.name).toBeTruthy();
      expect(starter.description).toBeTruthy();
      expect(starter.subject).toBeTruthy();
      expect(starter.preheader).toBeTruthy();
      expect(starter).not.toHaveProperty('content');
    }
    // A Channel that has saved nothing of its own still has them.
    const fresh = await data<StarterTemplateSummary[]>(
      await call('GET', starters(siblingId), { cookie: viewer.cookie }),
    );
    expect(fresh).toEqual(list);
  });

  it('previews a starter as this Channel’s email, with merge tags at their fallbacks', async () => {
    const starter = await data<StarterTemplate>(
      await call('GET', `${starters()}/welcome`, { cookie: viewer.cookie }),
    );
    expect(starter).toMatchObject({ key: 'welcome', name: 'Welcome issue' });
    expect(starter.content.type).toBe('doc');
    expect(starter.html).toContain('<!doctype html>');
    expect(starter.html).toContain('Hi there,');
    expect(starter.html).not.toContain('{{');
    expect(starter.html).toContain('href="#unsubscribe"');
  });

  it('starts an ordinary draft the author owns, and leaves the starter as it was', async () => {
    const res = await call('POST', `${starters()}/weekly-roundup/use`, { cookie: author.cookie });
    const draft = await data<Dispatch>(res, 201);
    expect(draft).toMatchObject({
      channelId,
      status: 'draft',
      kind: 'broadcast',
      subject: 'Five things worth your time this week',
    });
    expect(draft.preheader).toBeTruthy();
    expect(draft.warnings).toEqual([]);
    expect(draft.html).toContain('Quick links');
    // It is edited like any other Dispatch.
    const edited = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${draft.id}`, {
        cookie: author.cookie,
        body: { subject: 'My own subject', content: doc('My own words') },
      }),
    );
    expect(edited.subject).toBe('My own subject');
    const again = await data<StarterTemplate>(
      await call('GET', `${starters()}/weekly-roundup`, { cookie: viewer.cookie }),
    );
    expect(again.subject).toBe('Five things worth your time this week');
    // A second use is a second draft.
    const second = await data<Dispatch>(
      await call('POST', `${starters()}/weekly-roundup/use`, { cookie: author.cookie }),
      201,
    );
    expect(second.id).not.toBe(draft.id);
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'dispatch.created'`,
    )
      .bind(draft.id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ starterTemplate: 'weekly-roundup' });
  });

  it('every starter can be used, and none of them trips a render warning', async () => {
    for (const key of STARTER_TEMPLATE_KEYS) {
      const draft = await data<Dispatch>(
        await call('POST', `${starters()}/${key}/use`, { cookie: author.cookie }),
        201,
      );
      expect(draft.warnings, key).toEqual([]);
    }
  });

  it('needs the author role to use one, and signing in to see any', async () => {
    const use = await call('POST', `${starters()}/welcome/use`, { cookie: viewer.cookie });
    expect(use.status).toBe(403);
    expect((await call('GET', starters())).status).toBe(401);
    expect((await call('POST', `${starters()}/welcome/use`)).status).toBe(401);
  });

  it('refuses a key that is not a starter', async () => {
    for (const [method, path] of [
      ['GET', `${starters()}/nope`],
      ['POST', `${starters()}/nope/use`],
      ['POST', `${starters()}/constructor/use`],
    ] as const) {
      const res = await call(method, path, { cookie: owner.cookie });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(await errorCode(res)).toBe('invalid_input');
    }
  });

  it('keeps another workspace’s Channel out of reach', async () => {
    for (const [method, path] of [
      ['GET', starters(foreignChannelId)],
      ['GET', `${starters(foreignChannelId)}/welcome`],
      ['POST', `${starters(foreignChannelId)}/welcome/use`],
    ] as const) {
      const res = await call(method, path, { cookie: owner.cookie });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const before = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM dispatches WHERE channel_id = ?1',
    )
      .bind(foreignChannelId)
      .first<{ n: number }>();
    expect(before!.n).toBe(0);
  });
});
