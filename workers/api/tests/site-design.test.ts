import { env } from 'cloudflare:test';
import type {
  SiteDesign,
  SiteDesignPublished,
  SiteDesignRefused,
  SiteDesignSaved,
  SiteDesignState,
  SiteDesignStats,
  SiteDesignVersionList,
  SitePreview,
  SiteThemeFile,
} from '@swarm/domain';
import type { FlagKey } from '@swarm/flags';
import { standardSettings, type ThemeFiles } from '@swarm/site-themes';
import { verifySitePreview } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { testLinks } from './links';

// A small theme of the site's own, as Edit code would leave it.
const FILES: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Own theme',
    settings: standardSettings(),
    sections: [{ type: 'hero' }],
  }),
  'sections/hero.html': `<section><h1>{{ section.settings.heading | default: site.name }}</h1>{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}</section>
{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","label":"Heading","max":80}]}{% endschema %}`,
  'sections/note.html': `<p>{{ section.settings.text }}</p>
{% schema %}{"name":"Note","settings":[{"id":"text","type":"text","label":"Text"}]}{% endschema %}`,
  'theme.css': '.own{color:var(--ink)}',
};

const own = (overrides: Partial<SiteDesign> = {}): SiteDesign => ({
  theme: 'launch',
  files: FILES,
  settings: {},
  sections: null,
  ...overrides,
});

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

const errorCode = async (res: Response) =>
  (await json<{ error: { code: string } }>(res)).error.code;

async function enableFlag(key: FlagKey, workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, key, channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
}

async function cacheVersion(channelId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
    .bind(channelId)
    .first<{ cache_version: number }>();
  return row?.cache_version ?? 1;
}

const base = (channelId: string) => `/api/v1/channels/${channelId}/site/design`;

describe('website design', () => {
  let owner: Session;
  let editor: Session;
  let viewer: Session;
  let author: Session;
  let channel: { id: string };

  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, channel.id);
    editor = await seatAs(owner.workspaceId, 'editor');
    viewer = await seatAs(owner.workspaceId, 'viewer');
    author = await seatAs(owner.workspaceId, 'author');
  });

  const get = (s: Session, path = '') =>
    call('GET', `${base(channel.id)}${path}`, { cookie: s.cookie });
  const put = (s: Session, body: unknown) =>
    call('PUT', `${base(channel.id)}/draft`, { cookie: s.cookie, body });
  const post = (s: Session, path: string, body?: unknown) =>
    call('POST', `${base(channel.id)}${path}`, { cookie: s.cookie, body });

  it('is behind the site_templates flag', async () => {
    const other = await createChannel(owner);
    const res = await call('GET', base(other.id), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    const save = await call('PUT', `${base(other.id)}/draft`, {
      cookie: owner.cookie,
      body: own(),
    });
    expect(await errorCode(save)).toBe('feature_disabled');
  });

  it('starts with a draft of the default theme, and reads for viewers', async () => {
    const state = await data<SiteDesignState>(await get(viewer));
    expect(state.draft).toEqual({ theme: 'launch', files: null, settings: {}, sections: null });
    expect(state.published).toBeNull();
    expect(state.draftUpdatedAt).toBeNull();
    expect(Array.isArray(state.themes)).toBe(true);
    expect(Array.isArray(state.problems)).toBe(true);
  });

  it('makes the first draft from the old template settings', async () => {
    const legacy = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, legacy.id);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_settings (channel_id, theme_json, updated_at) VALUES (?1, ?2, 0)
         ON CONFLICT (channel_id) DO UPDATE SET theme_json = excluded.theme_json`,
      ).bind(
        legacy.id,
        JSON.stringify({
          template: 'letter',
          headline: 'Old words',
          font: 'serif',
          colorScheme: 'dark',
          pageColor: '#fafaf0',
        }),
      ),
      env.DB.prepare('UPDATE channels SET branding_json = ?1 WHERE id = ?2').bind(
        JSON.stringify({ accentColor: '#AA3311', logoMediaId: null }),
        legacy.id,
      ),
    ]);
    const state = await data<SiteDesignState>(
      await call('GET', base(legacy.id), { cookie: owner.cookie }),
    );
    expect(state.draft.theme).toBe('letter');
    expect(state.draft.files).toBeNull();
    expect(state.draft.settings).toEqual({
      accent: '#aa3311',
      page: '#fafaf0',
      ink: '#0f0f12',
      heading_font: 'serif',
      body_font: 'serif',
      scheme: 'light',
    });
    expect(state.draft.sections?.find((s) => s.type === 'hero')?.settings.heading).toBe(
      'Old words',
    );
  });

  it('saves the draft for editors, and keeps code changes for admins', async () => {
    // Editors change settings and sections of the built-in theme.
    const saved = await data<SiteDesignSaved>(
      await put(editor, {
        theme: 'gate',
        files: null,
        settings: { accent: '#123456' },
        sections: null,
      }),
    );
    expect(saved.draft.settings).toEqual({ accent: '#123456' });
    expect(saved.draftUpdatedAt).toBeTruthy();

    // Changing files needs an admin.
    const refused = await put(editor, own());
    expect(refused.status).toBe(403);
    expect((await json<{ error: { message: string } }>(refused)).error.message).toMatch(
      /theme’s code needs the admin role/,
    );
    expect((await put(author, own({ files: null }))).status).toBe(403);
    expect((await put(viewer, own({ files: null }))).status).toBe(403);

    const mine = await data<SiteDesignSaved>(await put(owner, own()));
    expect(mine.problems.filter((p) => p.severity === 'error')).toEqual([]);

    // With the same files, an editor may change the rest; not the files, and not back to none.
    const settings = await data<SiteDesignSaved>(
      await put(editor, own({ settings: { accent: '#654321' } })),
    );
    expect(settings.draft.files).toEqual(FILES);
    const changed = { ...FILES, 'theme.css': '.own{color:red}' };
    expect((await put(editor, own({ files: changed }))).status).toBe(403);
    expect((await put(editor, own({ files: null }))).status).toBe(403);

    const state = await data<SiteDesignState>(await get(viewer));
    expect(state.draft.settings).toEqual({ accent: '#654321' });
    expect(state.draft.files).toEqual(FILES);
  });

  it('always stores a draft of the right shape, with its problems, and refuses wrong shapes', async () => {
    const broken = own({
      settings: { accent: 'red' },
      sections: [{ id: 'n', type: 'nope', settings: {} }],
    });
    const saved = await data<SiteDesignSaved>(await put(owner, broken));
    const messages = saved.problems.map((p) => p.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Accent: use a colour/),
        expect.stringMatching(/no “nope” section/),
      ]),
    );
    expect(saved.problems.every((p) => typeof p.line === 'number' && p.file)).toBe(true);
    const bad = await put(owner, { ...own(), theme: 'unknown' });
    expect(bad.status).toBe(400);
    const tooMany = await put(owner, {
      ...own(),
      files: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`snippets/s${i}.html`, ''])),
    });
    expect(tooMany.status).toBe(400);
  });

  it('refuses to publish while the draft has errors (422, with the problems)', async () => {
    await data(await put(owner, own({ sections: [{ id: 'n', type: 'note', settings: {} }] })));
    const before = await cacheVersion(channel.id);
    const res = await post(editor, '/publish');
    expect(res.status).toBe(422);
    const body = await json<SiteDesignRefused>(res);
    expect(body.error.code).toBe('invalid_input');
    expect(body.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Visitors have no way to subscribe/)]),
    );
    expect(await cacheVersion(channel.id)).toBe(before);
    expect((await data<SiteDesignState>(await get(viewer))).published).toBeNull();
  });

  it('publishes: the live design, a version, an audit entry and a new cache version', async () => {
    const draft = own({ sections: [{ id: 'h', type: 'hero', settings: { heading: 'Live' } }] });
    await data(await put(owner, draft));
    const before = await cacheVersion(channel.id);
    expect((await post(viewer, '/publish')).status).toBe(403);
    expect((await post(author, '/publish')).status).toBe(403);
    const published = await data<SiteDesignPublished>(await post(editor, '/publish'));
    expect(published.published).toEqual(draft);
    expect(published.publishedBy).toBe(editor.me.operator.id);
    expect(published.version.theme).toBe('launch');
    expect(await cacheVersion(channel.id)).toBe(before + 1);

    const row = await env.DB.prepare(
      'SELECT published_version, published_json FROM site_designs WHERE channel_id = ?1',
    )
      .bind(channel.id)
      .first<{ published_version: number; published_json: string }>();
    expect(row?.published_version).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(row!.published_json)).toEqual(draft);

    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'site.design_published' AND target_id = ?1",
    )
      .bind(channel.id)
      .first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(1);

    const state = await data<SiteDesignState>(await get(viewer));
    expect(state.published).toEqual(draft);
    expect(state.publishedAt).toBe(published.publishedAt);
  });

  it('keeps the last 20 published designs, and restores one into the draft', async () => {
    const ch = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, ch.id);
    const path = base(ch.id);
    for (let i = 1; i <= 22; i++) {
      await data(
        await call('PUT', `${path}/draft`, {
          cookie: owner.cookie,
          body: own({ sections: [{ id: 'h', type: 'hero', settings: { heading: `Take ${i}` } }] }),
        }),
      );
      await data(await call('POST', `${path}/publish`, { cookie: owner.cookie }));
    }
    const { items } = await data<SiteDesignVersionList>(
      await call('GET', `${path}/versions`, { cookie: viewer.cookie }),
    );
    expect(items).toHaveLength(20);
    const stored = await env.DB.prepare(
      'SELECT count(*) AS n FROM site_design_versions WHERE channel_id = ?1',
    )
      .bind(ch.id)
      .first<{ n: number }>();
    expect(stored?.n).toBe(20);

    // Newest first; the oldest two are gone.
    const oldest = items[items.length - 1]!;
    const design = await env.DB.prepare(
      'SELECT design_json FROM site_design_versions WHERE id = ?1',
    )
      .bind(oldest.id)
      .first<{ design_json: string }>();
    expect(JSON.parse(design!.design_json).sections[0].settings.heading).toBe('Take 3');

    expect(
      (await call('POST', `${path}/versions/${oldest.id}/restore`, { cookie: viewer.cookie }))
        .status,
    ).toBe(403);
    const restored = await data<SiteDesignSaved>(
      await call('POST', `${path}/versions/${oldest.id}/restore`, { cookie: editor.cookie }),
    );
    expect(restored.draft.sections?.[0]?.settings.heading).toBe('Take 3');
    // The live site keeps the latest until the next publish.
    const state = await data<SiteDesignState>(await call('GET', path, { cookie: owner.cookie }));
    expect(state.published?.sections?.[0]?.settings.heading).toBe('Take 22');

    // A version of another Channel is not found here.
    const missing = await call('POST', `${base(channel.id)}/versions/${oldest.id}/restore`, {
      cookie: owner.cookie,
    });
    expect(missing.status).toBe(404);
  });

  it('mints a preview address for editors, scoped to the Channel and the audience', async () => {
    expect((await post(viewer, '/preview', { as: 'visitor' })).status).toBe(403);
    const before = Date.now();
    const preview = await data<SitePreview>(await post(editor, '/preview', { as: 'paid' }));
    const url = new URL(preview.url);
    expect(url.pathname).toBe('/_swarm/preview');
    const token = url.searchParams.get('token')!;
    const claims = await verifySitePreview(testLinks(), token);
    expect(claims).toEqual({ channelId: channel.id, as: 'paid' });
    const expires = Date.parse(preview.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
    // The audience defaults to a visitor, and must be one of the three.
    const plain = await data<SitePreview>(await post(editor, '/preview', {}));
    const plainToken = new URL(plain.url).searchParams.get('token')!;
    expect((await verifySitePreview(testLinks(), plainToken))?.as).toBe('visitor');
    expect((await post(editor, '/preview', { as: 'owner' })).status).toBe(400);
  });

  it('exports the theme as one file and imports it elsewhere (admin)', async () => {
    await data(await put(owner, own()));
    const file = await data<SiteThemeFile>(await get(viewer, '/export'));
    expect(file).toEqual({ format: 'swarm-theme', version: 1, name: 'Own theme', files: FILES });

    const target = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, target.id);
    const importPath = `${base(target.id)}/import`;
    expect((await call('POST', importPath, { cookie: editor.cookie, body: file })).status).toBe(
      403,
    );
    const imported = await data<SiteDesignSaved>(
      await call('POST', importPath, { cookie: owner.cookie, body: file }),
    );
    expect(imported.draft.files).toEqual(FILES);
    expect(imported.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const again = await data<SiteThemeFile>(
      await call('GET', `${base(target.id)}/export`, { cookie: owner.cookie }),
    );
    expect(again.files).toEqual(FILES);
    const bad = await call('POST', importPath, {
      cookie: owner.cookie,
      body: { ...file, format: 'other' },
    });
    expect(bad.status).toBe(400);
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'site.design_imported' AND target_id = ?1",
    )
      .bind(target.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('answers 404 to people outside the workspace', async () => {
    const stranger = await signIn();
    const theirs = await createChannel(stranger);
    await enableFlag('site_templates', stranger.workspaceId, theirs.id);
    const calls: [string, string, unknown?][] = [
      ['GET', ''],
      ['PUT', '/draft', own({ files: null })],
      ['POST', '/publish'],
      ['GET', '/versions'],
      ['POST', '/preview', { as: 'visitor' }],
      ['GET', '/export'],
      ['POST', '/import', { format: 'swarm-theme', version: 1, name: 'X', files: FILES }],
      ['GET', '/stats?days=7'],
    ];
    for (const [method, path, body] of calls) {
      const res = await call(method, `${base(channel.id)}${path}`, {
        cookie: stranger.cookie,
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // And the stranger's own Channel stays theirs.
    expect((await call('GET', base(theirs.id), { cookie: owner.cookie })).status).toBe(404);
  });
});

describe('website design: section analytics and A/B tests', () => {
  let owner: Session;
  let editor: Session;
  let viewer: Session;
  let channel: { id: string };

  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, channel.id);
    editor = await seatAs(owner.workspaceId, 'editor');
    viewer = await seatAs(owner.workspaceId, 'viewer');
  });

  const path = (p = '') => `${base(channel.id)}${p}`;
  const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const running = (variantB: Record<string, unknown>, startedAt = `${day(-3)}T08:00:00.000Z`) => ({
    id: 'exp-1',
    status: 'running' as const,
    variantB,
    startedAt,
  });
  const saveDraft = (s: Session, channelId: string, sections: unknown[]) =>
    call('PUT', `${base(channelId)}/draft`, {
      cookie: s.cookie,
      body: { theme: 'launch', files: null, settings: {}, sections },
    });

  it('checks a test in the draft: B against the schema, and 3 running at most', async () => {
    const ok = await data<SiteDesignSaved>(
      await saveDraft(editor, channel.id, [
        { id: 'hero-1', type: 'hero', settings: {}, experiment: running({ heading: 'B' }) },
      ]),
    );
    expect(
      ok.problems.filter((p) => p.message.includes('A/B') || p.message.includes('variant B')),
    ).toEqual([]);
    expect(ok.draft.sections?.[0]?.experiment?.variantB).toEqual({ heading: 'B' });

    const many = await data<SiteDesignSaved>(
      await saveDraft(editor, channel.id, [
        {
          id: 'hero-1',
          type: 'hero',
          settings: {},
          experiment: running({ heading: 'x'.repeat(500) }),
        },
        ...['a', 'b', 'c'].map((n) => ({
          id: `text-${n}`,
          type: 'text',
          settings: {},
          experiment: { ...running({}), id: `exp-${n}` },
        })),
      ]),
    );
    expect(many.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Hero, variant B: /),
        expect.stringMatching(/at most 3 A\/B tests at once; 4 are running/),
      ]),
    );
    expect((await call('POST', path('/publish'), { cookie: editor.cookie })).status).toBe(422);

    // A wrong shape is refused before it is stored.
    const bad = await saveDraft(editor, channel.id, [
      {
        id: 'hero-1',
        type: 'hero',
        settings: {},
        experiment: { ...running({}), status: 'paused' },
      },
    ]);
    expect(bad.status).toBe(400);
  });

  it('publishes the running tests for the site, and ends a test as a draft change', async () => {
    const hero = {
      id: 'hero-1',
      type: 'hero',
      settings: { heading: 'A' },
      experiment: running({ heading: 'B' }),
    };
    await data(await saveDraft(editor, channel.id, [hero]));
    await data(await call('POST', path('/publish'), { cookie: editor.cookie }));
    const tests = async () => {
      const row = await env.DB.prepare(
        'SELECT published_tests FROM site_designs WHERE channel_id = ?1',
      )
        .bind(channel.id)
        .first<{ published_tests: string }>();
      return JSON.parse(row!.published_tests) as string[];
    };
    expect(await tests()).toEqual(['hero-1']);

    // "Use B": B's settings into the section, the test ended with its winner.
    const ended = {
      ...hero,
      settings: { heading: 'B' },
      experiment: {
        ...hero.experiment,
        status: 'ended',
        endedAt: new Date().toISOString(),
        winner: 'b',
      },
    };
    const saved = await data<SiteDesignSaved>(await saveDraft(editor, channel.id, [ended]));
    expect(saved.problems.filter((p) => p.severity === 'error')).toEqual([]);
    // Until it is published, the site keeps running the test.
    expect(await tests()).toEqual(['hero-1']);
    await data(await call('POST', path('/publish'), { cookie: editor.cookie }));
    expect(await tests()).toEqual([]);
  });

  it('answers per section and variant, totals, and each test’s result, for viewers', async () => {
    const ch = await createChannel(owner);
    await enableFlag('site_templates', owner.workspaceId, ch.id);
    const at = (p = '') => `${base(ch.id)}${p}`;
    const hero = {
      id: 'hero-1',
      type: 'hero',
      settings: {},
      experiment: running({ heading: 'B' }),
    };
    const band = {
      id: 'band-1',
      type: 'subscribe_band',
      settings: {},
      experiment: {
        id: 'exp-old',
        status: 'ended' as const,
        variantB: {},
        startedAt: `${day(-20)}T08:00:00.000Z`,
        endedAt: `${day(-10)}T08:00:00.000Z`,
        winner: 'a' as const,
      },
    };
    await data(await saveDraft(owner, ch.id, [hero, band]));
    const put = (
      channelId: string,
      sectionId: string,
      variant: 'a' | 'b',
      reached: number,
      signups: number,
      d = day(),
    ) =>
      env.DB.prepare(
        `INSERT INTO site_section_daily (channel_id, day, section_id, variant, reached, signups)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(channelId, d, sectionId, variant, reached, signups);
    await env.DB.batch([
      put(ch.id, 'hero-1', 'a', 2000, 64),
      put(ch.id, 'hero-1', 'b', 2000, 82),
      put(ch.id, 'hero-1', 'a', 2000, 64, day(-1)),
      put(ch.id, 'hero-1', 'b', 2000, 82, day(-1)),
      // Before the test started: in the period's numbers, not in the test's.
      put(ch.id, 'hero-1', 'a', 500, 5, day(-5)),
      put(ch.id, 'band-1', 'a', 300, 9, day(-12)),
      put(ch.id, 'band-1', 'b', 300, 3, day(-12)),
      // Long ago: outside 30 days.
      put(ch.id, 'hero-1', 'a', 9999, 99, day(-60)),
      // Another Channel's numbers never show.
      put(channel.id, 'hero-1', 'a', 77, 7),
    ]);

    expect((await call('GET', at('/stats?days=14'), { cookie: viewer.cookie })).status).toBe(400);
    const week = await data<SiteDesignStats>(
      await call('GET', at('/stats?days=7'), { cookie: viewer.cookie }),
    );
    expect(week.days).toBe(7);
    expect(week.to).toBe(day());
    expect(week.from).toBe(day(-6));
    expect(week.sections).toEqual([
      { sectionId: 'hero-1', variant: 'a', reached: 4500, signups: 133 },
      { sectionId: 'hero-1', variant: 'b', reached: 4000, signups: 164 },
    ]);
    expect(week.totals).toEqual({ reached: 8500, signups: 297 });

    const month = await data<SiteDesignStats>(
      await call('GET', at('/stats'), { cookie: viewer.cookie }),
    );
    expect(month.days).toBe(30);
    expect(month.sections.map((s) => s.sectionId)).toEqual([
      'band-1',
      'band-1',
      'hero-1',
      'hero-1',
    ]);

    const test = month.tests.find((t) => t.sectionId === 'hero-1')!;
    expect(test).toMatchObject({
      experimentId: 'exp-1',
      status: 'running',
      endedAt: null,
      winner: null,
      a: { reached: 4000, signups: 128, rate: 0.032 },
      b: { reached: 4000, signups: 164, rate: 0.041 },
      leader: 'b',
      decided: true,
      viewsNeeded: 0,
    });
    expect(test.confidence).toBeGreaterThan(0.96);
    const old = month.tests.find((t) => t.sectionId === 'band-1')!;
    expect(old).toMatchObject({
      status: 'ended',
      winner: 'a',
      a: { reached: 300, signups: 9 },
      b: { reached: 300, signups: 3 },
    });
  });

  it('mints a preview of variant B, for every test or one section', async () => {
    const preview = (body: unknown) =>
      call('POST', path('/preview'), { cookie: editor.cookie, body });
    const all = new URL((await data<SitePreview>(await preview({ variant: 'b' }))).url);
    expect(all.searchParams.get('variant')).toBe('b');
    expect(all.searchParams.get('section')).toBeNull();
    const one = new URL(
      (await data<SitePreview>(await preview({ variant: 'b', section: 'hero-1' }))).url,
    );
    expect(one.searchParams.get('section')).toBe('hero-1');
    expect((await preview({ variant: 'b', section: 'Bad id' })).status).toBe(400);
  });

  it('is behind the flag and the viewer role, and 404s across workspaces', async () => {
    const other = await createChannel(owner);
    const off = await call('GET', `${base(other.id)}/stats`, { cookie: owner.cookie });
    expect(off.status).toBe(404);
    expect(await errorCode(off)).toBe('feature_disabled');
    expect((await call('GET', path('/stats'), { cookie: viewer.cookie })).status).toBe(200);
    const stranger = await signIn();
    expect((await call('GET', path('/stats'), { cookie: stranger.cookie })).status).toBe(404);
  });
});
