import { env } from 'cloudflare:test';
import type {
  BotRules,
  Dispatch,
  MediaAsset,
  Member,
  RedirectImportResult,
  SeatRole,
  SiteAnalytics,
  SitePage,
  SiteRedirect,
  SiteSection,
  SiteSettings,
  WebDomainList,
} from '@swarm/domain';
import { DevWebHostnames, refreshPendingHostnames } from '@swarm/engine';
import type { FlagKey } from '@swarm/flags';
import { beforeAll, describe, expect, it } from 'vitest';
import { isBareDomain, registrableDomain } from '../src/routes/webDomains';
import {
  call,
  createChannel,
  json,
  pngBytes,
  seatAs,
  signIn,
  uniqueEmail,
  uploadForm,
  type Session,
} from './helpers';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...paragraphs: string[]) => ({ type: 'doc', content: paragraphs.map(p) });
const gated = (free: string, secret: string) => ({
  type: 'doc',
  content: [p(free), { type: 'gate' }, p(secret)],
});

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function errorCode(res: Response): Promise<string> {
  return (await json<{ error: { code: string } }>(res)).error.code;
}

async function newDispatch(s: Session, channelId: string, body: Record<string, unknown> = {}) {
  return data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: s.cookie,
      body: { subject: 'Issue 1', content: doc('Hello'), ...body },
    }),
    201,
  );
}

async function addMember(s: Session, channelId: string) {
  return data<Member>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: s.cookie,
      body: { email: uniqueEmail('member'), consent: true },
    }),
    201,
  );
}

const patch = (s: Session, id: string, body: Record<string, unknown>) =>
  call('PATCH', `/api/v1/dispatches/${id}`, { cookie: s.cookie, body });

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

async function slugs(dispatchId: string) {
  const { results } = await env.DB.prepare(
    'SELECT slug, is_current FROM dispatch_slugs WHERE dispatch_id = ?1 ORDER BY created_at, slug',
  )
    .bind(dispatchId)
    .all<{ slug: string; is_current: number }>();
  return results;
}

async function searchRow(dispatchId: string) {
  return env.DB.prepare('SELECT title, subtitle, body FROM dispatch_search WHERE dispatch_id = ?1')
    .bind(dispatchId)
    .first<{ title: string; subtitle: string; body: string }>();
}

const send = (s: Session, id: string) =>
  call('POST', `/api/v1/dispatches/${id}/send`, { cookie: s.cookie });

describe('web publishing', () => {
  let owner: Session;
  let channel: { id: string; slug: string };
  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
    await addMember(owner, channel.id);
  });

  it('publishes a Dispatch when it starts sending: slug, web_published_at, search, cache', async () => {
    const before = await cacheVersion(channel.id);
    const dispatch = await newDispatch(owner, channel.id, {
      subject: 'Hello, World! {{ channel.name }}',
      preheader: 'A first look',
      content: gated('Free opening words', 'Secret closing words'),
    });
    expect(dispatch).toMatchObject({
      webVisibility: 'public',
      webPublishedAt: null,
      slug: null,
      onSite: false,
      webUrl: null,
      sectionId: null,
    });
    await data(await send(owner, dispatch.id), 202);

    const row = await env.DB.prepare(
      'SELECT status, web_published_at FROM dispatches WHERE id = ?1',
    )
      .bind(dispatch.id)
      .first<{ status: string; web_published_at: number | null }>();
    expect(row?.status).toBe('sending');
    expect(row?.web_published_at).toBeGreaterThan(0);
    expect(await slugs(dispatch.id)).toEqual([{ slug: 'hello-world-channel-name', is_current: 1 }]);
    // A public Dispatch is readable in full by anyone, so all of it is searchable.
    const search = await searchRow(dispatch.id);
    expect(search).toMatchObject({ title: 'Hello, World! Field Notes', subtitle: 'A first look' });
    expect(search?.body).toContain('Free opening words');
    expect(search?.body).toContain('Secret closing words');
    expect(await cacheVersion(channel.id)).toBeGreaterThan(before);

    const loaded = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie }),
    );
    expect(loaded.slug).toBe('hello-world-channel-name');
    expect(loaded.onSite).toBe(true);
    expect(loaded.webPublishedAt).not.toBeNull();
    expect(loaded.webUrl).toBe(`http://${channel.slug}.site.localhost/p/hello-world-channel-name`);
    const list = await data<Dispatch[]>(
      await call('GET', `/api/v1/channels/${channel.id}/dispatches`, { cookie: owner.cookie }),
    );
    expect(list.find((d) => d.id === dispatch.id)).toMatchObject({ webVisibility: 'public' });
  });

  it('indexes only the free part of a paid Dispatch, and its teaser email stops at the gate', async () => {
    const dispatch = await newDispatch(owner, channel.id, {
      subject: 'Paid Notes',
      content: gated('Teaser words', 'Paid only words'),
    });
    const saved = await data<Dispatch>(await patch(owner, dispatch.id, { webVisibility: 'paid' }));
    expect(saved.html).not.toContain('Paid only words');
    const { broadcastId } = await data<{ broadcastId: string }>(
      await send(owner, dispatch.id),
      202,
    );
    const search = await searchRow(dispatch.id);
    expect(search?.body).toContain('Teaser words');
    expect(search?.body).not.toContain('Paid only words');
    // Two emails: the full one for Members the Gate admits, and the teaser for everyone else.
    const broadcast = await env.DB.prepare(
      'SELECT html, teaser_html, teaser_text FROM broadcasts WHERE id = ?1',
    )
      .bind(broadcastId)
      .first<{ html: string; teaser_html: string; teaser_text: string }>();
    expect(broadcast?.html).toContain('Paid only words');
    expect(broadcast?.teaser_html).toContain('Teaser words');
    expect(broadcast?.teaser_html).not.toContain('Paid only words');
    expect(broadcast?.teaser_text).not.toContain('Paid only words');
    const webUrl = `http://${channel.slug}.site.localhost/p/paid-notes`;
    expect(saved.html).toContain(webUrl);
    const links = await env.DB.prepare('SELECT url FROM link_targets WHERE broadcast_id = ?1')
      .bind(broadcastId)
      .all<{ url: string }>();
    expect(links.results.map((l) => l.url)).toContain(webUrl);
  });

  it('indexes only the title of a members-only Dispatch without a gate', async () => {
    const dispatch = await newDispatch(owner, channel.id, {
      subject: 'Members Notes',
      content: doc('Members only words'),
    });
    await data(await patch(owner, dispatch.id, { webVisibility: 'members' }));
    await data(await send(owner, dispatch.id), 202);
    expect(await searchRow(dispatch.id)).toMatchObject({ title: 'Members Notes', body: '' });
  });

  it('does not put a hidden Dispatch on the web when it is sent', async () => {
    const dispatch = await newDispatch(owner, channel.id, { subject: 'Email only' });
    await data(await patch(owner, dispatch.id, { webVisibility: 'hidden' }));
    await data(await send(owner, dispatch.id), 202);
    const loaded = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie }),
    );
    expect(loaded).toMatchObject({ webPublishedAt: null, onSite: false, slug: 'email-only' });
    expect(await searchRow(dispatch.id)).toBeNull();
  });

  it('gives colliding and reserved subjects unique slugs', async () => {
    const { id: ch } = await createChannel(owner);
    const publish = async (subject: string) => {
      const d = await newDispatch(owner, ch, { subject });
      return data<Dispatch>(
        await call('POST', `/api/v1/dispatches/${d.id}/publish-web`, { cookie: owner.cookie }),
      );
    };
    expect((await publish('Same Title')).slug).toBe('same-title');
    expect((await publish('Same title!')).slug).toBe('same-title-2');
    expect((await publish('Same Title')).slug).toBe('same-title-3');
    expect((await publish('Archive')).slug).toBe('archive-2');
    expect((await publish('Search')).slug).toBe('search-2');
    expect((await publish('¡¡!!')).slug).toBe('dispatch');
  });

  it('renames a slug, keeps the old one redirecting, refuses reserved and taken slugs', async () => {
    const { id: ch } = await createChannel(owner);
    const a = await newDispatch(owner, ch, { subject: 'First Post' });
    const b = await newDispatch(owner, ch, { subject: 'Second Post' });
    for (const d of [a, b]) {
      await data(
        await call('POST', `/api/v1/dispatches/${d.id}/publish-web`, { cookie: owner.cookie }),
      );
    }
    const before = await cacheVersion(ch);
    const renamed = await data<Dispatch>(await patch(owner, a.id, { slug: 'better-name' }));
    expect(renamed.slug).toBe('better-name');
    expect(renamed.webUrl).toMatch(/\/p\/better-name$/);
    expect(await slugs(a.id)).toEqual([
      { slug: 'first-post', is_current: 0 },
      { slug: 'better-name', is_current: 1 },
    ]);
    expect(await cacheVersion(ch)).toBeGreaterThan(before);

    const taken = await patch(owner, a.id, { slug: 'second-post' });
    expect(taken.status).toBe(409);
    // b's slug history belongs to b, even its old slugs.
    await data(await patch(owner, b.id, { slug: 'second-renamed' }));
    expect((await patch(owner, a.id, { slug: 'second-post' })).status).toBe(409);
    expect((await patch(owner, a.id, { slug: 'archive' })).status).toBe(400);
    expect((await patch(owner, a.id, { slug: 'Not A Slug!' })).status).toBe(400);

    // Taking back an old slug of its own makes it current again.
    await data(await patch(owner, a.id, { slug: 'first-post' }));
    expect(await slugs(a.id)).toEqual([
      { slug: 'first-post', is_current: 1 },
      { slug: 'better-name', is_current: 0 },
    ]);
  });

  it('publishes to the web only, re-indexes edits and unpublishes', async () => {
    const dispatch = await newDispatch(owner, channel.id, {
      subject: 'Web only',
      content: doc('Original words'),
    });
    const published = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, {
        cookie: owner.cookie,
      }),
    );
    expect(published).toMatchObject({ status: 'draft', onSite: true, slug: 'web-only' });
    expect(published.webPublishedAt).not.toBeNull();
    const broadcasts = await env.DB.prepare(
      'SELECT count(*) AS n FROM broadcasts WHERE dispatch_id = ?1',
    )
      .bind(dispatch.id)
      .first<{ n: number }>();
    expect(broadcasts?.n).toBe(0);
    expect((await searchRow(dispatch.id))?.body).toContain('Original words');

    // Publishing again changes nothing.
    const again = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, {
        cookie: owner.cookie,
      }),
    );
    expect(again.webPublishedAt).toBe(published.webPublishedAt);

    const version = await cacheVersion(channel.id);
    await data(await patch(owner, dispatch.id, { content: doc('Edited words') }));
    expect((await searchRow(dispatch.id))?.body).toContain('Edited words');
    expect(await cacheVersion(channel.id)).toBeGreaterThan(version);

    const hidden = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/unpublish-web`, {
        cookie: owner.cookie,
      }),
    );
    expect(hidden).toMatchObject({ webVisibility: 'hidden', onSite: false });
    expect(await searchRow(dispatch.id)).toBeNull();
    const refused = await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, {
      cookie: owner.cookie,
    });
    expect(refused.status).toBe(409);
    // Choosing who can read it brings it back at the same address.
    const back = await data<Dispatch>(await patch(owner, dispatch.id, { webVisibility: 'public' }));
    expect(back).toMatchObject({ onSite: true, slug: 'web-only' });
    expect((await searchRow(dispatch.id))?.body).toContain('Edited words');

    // Deleting the draft removes it from search too.
    expect(
      (await call('DELETE', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(await searchRow(dispatch.id)).toBeNull();
  });

  it('changes web fields after sending (editor role), never the content', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    const author = await seatAs(owner.workspaceId, 'author');
    const dispatch = await newDispatch(owner, channel.id, {
      subject: 'Sent then changed',
      content: gated('Open words', 'Closed words'),
    });
    await data(await send(owner, dispatch.id), 202);
    expect((await patch(editor, dispatch.id, { subject: 'Late' })).status).toBe(409);
    expect((await patch(author, dispatch.id, { webVisibility: 'paid' })).status).toBe(403);
    const changed = await data<Dispatch>(
      await patch(editor, dispatch.id, { webVisibility: 'paid', slug: 'changed-later' }),
    );
    expect(changed).toMatchObject({ webVisibility: 'paid', slug: 'changed-later', onSite: true });
    expect((await searchRow(dispatch.id))?.body).not.toContain('Closed words');
  });

  it('accepts only sections of the same Channel', async () => {
    await enableFlag('site_sections', owner.workspaceId, channel.id);
    const section = await data<SiteSection>(
      await call('POST', `/api/v1/channels/${channel.id}/site/sections`, {
        cookie: owner.cookie,
        body: { name: 'Essays' },
      }),
      201,
    );
    const other = await createChannel(owner);
    await enableFlag('site_sections', owner.workspaceId, other.id);
    const foreign = await data<SiteSection>(
      await call('POST', `/api/v1/channels/${other.id}/site/sections`, {
        cookie: owner.cookie,
        body: { name: 'Elsewhere' },
      }),
      201,
    );
    const dispatch = await newDispatch(owner, channel.id);
    const res = await patch(owner, dispatch.id, { sectionId: foreign.id });
    expect(res.status).toBe(404);
    const set = await data<Dispatch>(await patch(owner, dispatch.id, { sectionId: section.id }));
    expect(set.sectionId).toBe(section.id);
    const cleared = await data<Dispatch>(await patch(owner, dispatch.id, { sectionId: null }));
    expect(cleared.sectionId).toBeNull();
  });
});

describe('site settings', () => {
  let owner: Session;
  let editor: Session;
  let channel: { id: string; slug: string };
  beforeAll(async () => {
    owner = await signIn();
    editor = await seatAs(owner.workspaceId, 'editor');
    channel = await createChannel(owner);
  });
  const path = () => `/api/v1/channels/${channel.id}/site/settings`;

  it('starts from defaults and saves changes, bumping the cache version', async () => {
    const defaults = await data<SiteSettings>(await call('GET', path(), { cookie: owner.cookie }));
    expect(defaults).toMatchObject({
      layout: 'magazine',
      pinned: [],
      aiBots: 'unset',
      exposeGated: false,
      prevNextNav: true,
      cacheVersion: 1,
      url: `http://${channel.slug}.site.localhost`,
      platformUrl: `http://${channel.slug}.site.localhost`,
      updatedAt: null,
    });
    const saved = await data<SiteSettings>(
      await call('PATCH', path(), {
        cookie: editor.cookie,
        body: {
          nav: [{ label: 'About', href: '/about' }],
          theme: { font: 'inter', colorScheme: 'dark' },
          about: doc('Who we are'),
          prevNextNav: false,
        },
      }),
    );
    expect(saved).toMatchObject({
      nav: [{ label: 'About', href: '/about' }],
      theme: { font: 'inter', colorScheme: 'dark' },
      prevNextNav: false,
    });
    expect(saved.cacheVersion).toBe(2);
    const again = await data<SiteSettings>(
      await call('PATCH', path(), { cookie: editor.cookie, body: { prevNextNav: true } }),
    );
    expect(again.cacheVersion).toBe(3);
    expect(again.nav).toHaveLength(1);
  });

  it('validates input and checks roles and flags', async () => {
    const bad = (body: unknown, cookie = owner.cookie) => call('PATCH', path(), { cookie, body });
    expect((await bad({})).status).toBe(400);
    expect((await bad({ nav: [{ label: 'x', href: 'javascript:alert(1)' }] })).status).toBe(400);
    expect((await bad({ about: { type: 'doc', content: [{ type: 'script' }] } })).status).toBe(400);
    expect((await bad({ aiBots: 'block' }, editor.cookie)).status).toBe(403);
    expect((await bad({ aiBots: 'block' })).status).toBe(200);

    const exposeOff = await bad({ exposeGated: true });
    expect(exposeOff.status).toBe(404);
    expect(await errorCode(exposeOff)).toBe('feature_disabled');
    const newspaperOff = await bad({ layout: 'newspaper' });
    expect(newspaperOff.status).toBe(404);
    expect(await errorCode(newspaperOff)).toBe('feature_disabled');
    await enableFlag('gated_seo_exposure', owner.workspaceId, channel.id);
    await enableFlag('site_homepage_layouts', owner.workspaceId, channel.id);
    expect((await bad({ exposeGated: true }, editor.cookie)).status).toBe(403);
    const on = await data<SiteSettings>(await bad({ exposeGated: true, layout: 'newspaper' }));
    expect(on).toMatchObject({ exposeGated: true, layout: 'newspaper' });
  });

  it('pins only Dispatches on this Channel’s site', async () => {
    const draft = await newDispatch(owner, channel.id, { subject: 'Not yet' });
    expect(
      (await call('PATCH', path(), { cookie: owner.cookie, body: { pinned: [draft.id] } })).status,
    ).toBe(400);
    await data(
      await call('POST', `/api/v1/dispatches/${draft.id}/publish-web`, { cookie: owner.cookie }),
    );
    const other = await createChannel(owner);
    const foreign = await newDispatch(owner, other.id, { subject: 'Elsewhere' });
    await data(
      await call('POST', `/api/v1/dispatches/${foreign.id}/publish-web`, { cookie: owner.cookie }),
    );
    expect(
      (await call('PATCH', path(), { cookie: owner.cookie, body: { pinned: [foreign.id] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', path(), {
          cookie: owner.cookie,
          body: { pinned: [draft.id, draft.id] },
        })
      ).status,
    ).toBe(400);
    const pinned = await data<SiteSettings>(
      await call('PATCH', path(), { cookie: owner.cookie, body: { pinned: [draft.id] } }),
    );
    expect(pinned.pinned).toEqual([draft.id]);
  });

  it('takes a social image only from this workspace’s media', async () => {
    const own = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${channel.id}/media`, {
        cookie: owner.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    const stranger = await signIn();
    const strangerChannel = await createChannel(stranger);
    const foreign = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${strangerChannel.id}/media`, {
        cookie: stranger.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    expect(
      (
        await call('PATCH', path(), {
          cookie: owner.cookie,
          body: { seo: { ogMediaId: foreign.id } },
        })
      ).status,
    ).toBe(400);
    const saved = await data<SiteSettings>(
      await call('PATCH', path(), { cookie: owner.cookie, body: { seo: { ogMediaId: own.id } } }),
    );
    expect(saved.seo.ogMediaId).toBe(own.id);
  });
});

describe('sections', () => {
  it('needs the site_sections flag, then supports CRUD with unique, unreserved slugs', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const base = `/api/v1/channels/${channel.id}/site/sections`;
    const off = await call('GET', base, { cookie: owner.cookie });
    expect(off.status).toBe(404);
    expect(await errorCode(off)).toBe('feature_disabled');
    expect((await call('POST', base, { cookie: owner.cookie, body: { name: 'X' } })).status).toBe(
      404,
    );

    await enableFlag('site_sections', owner.workspaceId, channel.id);
    const created = await data<SiteSection>(
      await call('POST', base, {
        cookie: owner.cookie,
        body: { name: 'Long Reads', description: 'Deep dives' },
      }),
      201,
    );
    expect(created).toMatchObject({ slug: 'long-reads', name: 'Long Reads', dispatchCount: 0 });
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { name: 'Long reads' } })).status,
    ).toBe(409);
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { name: 'Feed', slug: 'feed' } }))
        .status,
    ).toBe(400);
    expect((await call('POST', base, { cookie: owner.cookie, body: { name: '' } })).status).toBe(
      400,
    );

    const dispatch = await newDispatch(owner, channel.id, { subject: 'In a section' });
    await data(await patch(owner, dispatch.id, { sectionId: created.id }));
    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, { cookie: owner.cookie }),
    );

    const renamed = await data<SiteSection>(
      await call('PATCH', `${base}/${created.id}`, {
        cookie: owner.cookie,
        body: { name: 'Features', slug: 'features', description: null },
      }),
    );
    expect(renamed).toMatchObject({ slug: 'features', description: null, dispatchCount: 1 });
    const list = await data<SiteSection[]>(await call('GET', base, { cookie: owner.cookie }));
    expect(list.map((s) => s.slug)).toEqual(['features']);

    expect((await call('DELETE', `${base}/${created.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    const after = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie }),
    );
    expect(after.sectionId).toBeNull();
    expect((await call('DELETE', `${base}/${created.id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
  });
});

describe('pages', () => {
  it('creates, edits and removes pages within the plan limit', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const base = `/api/v1/channels/${channel.id}/site/pages`;
    const page = await data<SitePage>(
      await call('POST', base, {
        cookie: owner.cookie,
        body: {
          title: 'Contact Us',
          content: doc('Write to us'),
          status: 'published',
          inNav: true,
        },
      }),
      201,
    );
    expect(page).toMatchObject({
      slug: 'contact-us',
      status: 'published',
      inNav: true,
      url: `http://${channel.slug}.site.localhost/contact-us`,
    });
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { title: 'About' } })).status,
    ).toBe(400);
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { title: 'Contact us' } })).status,
    ).toBe(409);
    expect(
      (
        await call('POST', base, {
          cookie: owner.cookie,
          body: { title: 'Bad', content: { type: 'doc', content: [{ type: 'iframe' }] } },
        })
      ).status,
    ).toBe(400);

    const edited = await data<SitePage>(
      await call('PATCH', `${base}/${page.id}`, {
        cookie: owner.cookie,
        body: { title: 'Contact', slug: 'contact', status: 'draft' },
      }),
    );
    expect(edited).toMatchObject({ title: 'Contact', slug: 'contact', status: 'draft' });
    expect(
      (
        await call('PATCH', `${base}/${page.id}`, {
          cookie: owner.cookie,
          body: { slug: 'search' },
        })
      ).status,
    ).toBe(400);
    const one = await data<SitePage>(
      await call('GET', `${base}/${page.id}`, { cookie: owner.cookie }),
    );
    expect(one.content).toEqual(doc('Write to us'));

    for (const title of ['Two', 'Three', 'Four', 'Five']) {
      await data(await call('POST', base, { cookie: owner.cookie, body: { title } }), 201);
    }
    const list = await data<{ items: unknown[]; limit: number | null }>(
      await call('GET', base, { cookie: owner.cookie }),
    );
    expect(list).toMatchObject({ limit: 5 });
    expect(list.items).toHaveLength(5);
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { title: 'Six' } })).status,
    ).toBe(409);

    // Paid plans have no page limit.
    await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1")
      .bind(owner.workspaceId)
      .run();
    await data(await call('POST', base, { cookie: owner.cookie, body: { title: 'Six' } }), 201);
    expect(
      (await data<{ limit: number | null }>(await call('GET', base, { cookie: owner.cookie })))
        .limit,
    ).toBeNull();

    expect((await call('DELETE', `${base}/${page.id}`, { cookie: owner.cookie })).status).toBe(204);
    expect((await call('GET', `${base}/${page.id}`, { cookie: owner.cookie })).status).toBe(404);
  });
});

describe('redirects', () => {
  it('creates, edits and removes redirects', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const base = `/api/v1/channels/${channel.id}/site/redirects`;
    const created = await data<SiteRedirect>(
      await call('POST', base, {
        cookie: owner.cookie,
        body: { from: '/old-post/', to: '/p/new-post' },
      }),
      201,
    );
    expect(created).toMatchObject({ from: '/old-post', to: '/p/new-post', statusCode: 301 });
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { from: '/old-post', to: '/x' } }))
        .status,
    ).toBe(409);
    for (const body of [
      { from: 'old', to: '/x' },
      { from: '/', to: '/x' },
      { from: '/_swarm/x', to: '/x' },
      { from: '/a', to: 'http://insecure.example' },
      { from: '/a', to: '/a' },
      { from: '/a', to: '/b', statusCode: 404 },
    ]) {
      expect(
        (await call('POST', base, { cookie: owner.cookie, body })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    const edited = await data<SiteRedirect>(
      await call('PATCH', `${base}/${created.id}`, {
        cookie: owner.cookie,
        body: { to: 'https://elsewhere.example/post', statusCode: 302 },
      }),
    );
    expect(edited).toMatchObject({ to: 'https://elsewhere.example/post', statusCode: 302 });
    expect((await call('DELETE', `${base}/${created.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    expect((await call('DELETE', `${base}/${created.id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
  });

  it('imports CSV, reporting problems per line and applying the plan limit', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const base = `/api/v1/channels/${channel.id}/site/redirects`;
    await data(
      await call('POST', base, { cookie: owner.cookie, body: { from: '/existing', to: '/old' } }),
      201,
    );
    const csv = [
      'from,to,status',
      '/one,/p/one,',
      '/two,https://example.com/two,302',
      'no-slash,/x,',
      '/three,/p/three,999',
      '/one,/p/again,',
      '/existing,/p/new,308',
      '',
      '/self,/self,',
    ].join('\n');
    const result = await data<RedirectImportResult>(
      await call('POST', `${base}/import`, { cookie: owner.cookie, body: { csv } }),
    );
    expect(result.created).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.errors.map((e) => e.line)).toEqual([4, 5, 6, 9]);
    expect(result.errors[1]!.message).toMatch(/301, 302, 307 or 308/);
    expect(result.errors[2]!.message).toMatch(/line 2/);
    const list = await data<{ items: SiteRedirect[]; limit: number | null }>(
      await call('GET', base, { cookie: owner.cookie }),
    );
    expect(list.limit).toBe(50);
    expect(list.items.map((r) => [r.from, r.to, r.statusCode])).toEqual([
      ['/existing', '/p/new', 308],
      ['/one', '/p/one', 301],
      ['/two', 'https://example.com/two', 302],
    ]);

    // Without a header, and past the free plan's 50: the rest of the lines are refused.
    const many = Array.from({ length: 50 }, (_, i) => `/bulk-${i},/p/bulk-${i}`).join('\n');
    const limited = await data<RedirectImportResult>(
      await call('POST', `${base}/import`, { cookie: owner.cookie, body: { csv: many } }),
    );
    expect(limited.created).toBe(47);
    expect(limited.errors).toHaveLength(3);
    expect(limited.errors[0]).toMatchObject({
      line: 48,
      message: expect.stringMatching(/50 redirects/),
    });
    expect(
      (await call('POST', base, { cookie: owner.cookie, body: { from: '/more', to: '/x' } }))
        .status,
    ).toBe(409);
  });
});

describe('bot rules', () => {
  it('reads and writes the policy and per-crawler overrides (admin)', async () => {
    const owner = await signIn();
    const editor = await seatAs(owner.workspaceId, 'editor');
    const channel = await createChannel(owner);
    const base = `/api/v1/channels/${channel.id}/site/bot-rules`;
    const initial = await data<BotRules>(await call('GET', base, { cookie: editor.cookie }));
    expect(initial.policy).toBe('unset');
    expect(initial.agents.every((a) => a.action === 'allow')).toBe(true);

    expect(
      (await call('PUT', base, { cookie: editor.cookie, body: { policy: 'block' } })).status,
    ).toBe(403);
    expect(
      (
        await call('PUT', base, {
          cookie: owner.cookie,
          body: { policy: 'custom', overrides: { 'not-a-bot': 'block' } },
        })
      ).status,
    ).toBe(400);
    const version = await cacheVersion(channel.id);
    const custom = await data<BotRules>(
      await call('PUT', base, {
        cookie: owner.cookie,
        body: { policy: 'custom', overrides: { gptbot: 'block', claudebot: 'allow' } },
      }),
    );
    expect(custom.overrides).toEqual({ gptbot: 'block', claudebot: 'allow' });
    expect(custom.agents.find((a) => a.key === 'gptbot')?.action).toBe('block');
    expect(custom.agents.find((a) => a.key === 'ccbot')?.action).toBe('allow');
    expect(await cacheVersion(channel.id)).toBeGreaterThan(version);
    const settings = await data<SiteSettings>(
      await call('GET', `/api/v1/channels/${channel.id}/site/settings`, { cookie: owner.cookie }),
    );
    expect(settings.aiBots).toBe('custom');

    const blocked = await data<BotRules>(
      await call('PUT', base, { cookie: owner.cookie, body: { policy: 'block' } }),
    );
    expect(blocked.overrides).toEqual({});
    expect(blocked.agents.every((a) => a.action === 'block')).toBe(true);
  });
});

describe('web domains', () => {
  let owner: Session;
  let channel: { id: string; slug: string };
  const unique = () => `d${crypto.randomUUID().slice(0, 8)}.example`;
  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
  });
  const base = () => `/api/v1/channels/${channel.id}/domains/web`;

  it('adds a bare domain as www plus an apex redirect, activates on refresh, picks a primary', async () => {
    const domain = unique();
    const added = await data<WebDomainList>(
      await call('POST', base(), { cookie: owner.cookie, body: { hostname: domain } }),
      201,
    );
    expect(added.available).toBe(true);
    expect(added.cnameTarget).toBe('sites.site.localhost');
    const web = added.hostnames.find((h) => h.hostname === `www.${domain}`)!;
    const apex = added.hostnames.find((h) => h.hostname === domain)!;
    expect(web).toMatchObject({ role: 'web', status: 'pending', isPrimary: true });
    expect(web.records).toEqual([
      { type: 'CNAME', name: `www.${domain}`, value: 'sites.site.localhost' },
    ]);
    expect(apex).toMatchObject({ role: 'apex_redirect', status: 'pending', isPrimary: false });
    expect(apex.records[0]).toMatchObject({ type: 'ALIAS', name: domain });
    expect(added.domains.find((d) => d.domain === domain)).toMatchObject({
      web: { hostname: `www.${domain}`, status: 'pending', id: web.id },
      apexRedirect: { hostname: domain, status: 'pending', id: apex.id },
      email: { hostname: null, status: 'not_set_up' },
      link: { hostname: null, status: 'not_set_up' },
    });

    // Pending hostnames aren't served, so the site still uses the platform address.
    const before = await data<SiteSettings>(
      await call('GET', `/api/v1/channels/${channel.id}/site/settings`, { cookie: owner.cookie }),
    );
    expect(before.url).toBe(`http://${channel.slug}.site.localhost`);

    const refreshed = await data<WebDomainList>(
      await call('POST', `${base()}/${web.id}/refresh`, { cookie: owner.cookie }),
    );
    expect(refreshed.hostnames.find((h) => h.id === web.id)?.status).toBe('active');
    const after = await data<SiteSettings>(
      await call('GET', `/api/v1/channels/${channel.id}/site/settings`, { cookie: owner.cookie }),
    );
    expect(after.url).toBe(`http://www.${domain}`);
    expect(after.platformUrl).toBe(`http://${channel.slug}.site.localhost`);

    // A second domain; making it primary leaves exactly one primary.
    const second = unique();
    const both = await data<WebDomainList>(
      await call('POST', base(), {
        cookie: owner.cookie,
        body: { hostname: `www.${second}`, redirectApex: true },
      }),
      201,
    );
    const web2 = both.hostnames.find((h) => h.hostname === `www.${second}`)!;
    expect(web2.isPrimary).toBe(false);
    expect(both.hostnames.some((h) => h.hostname === second && h.role === 'apex_redirect')).toBe(
      true,
    );
    const switched = await data<WebDomainList>(
      await call('POST', `${base()}/${web2.id}/primary`, { cookie: owner.cookie }),
    );
    expect(switched.hostnames.filter((h) => h.isPrimary).map((h) => h.id)).toEqual([web2.id]);
    expect(
      (await call('POST', `${base()}/${apex.id}/primary`, { cookie: owner.cookie })).status,
    ).toBe(400);

    // Removing the primary www hostname removes its apex redirect and promotes the other one.
    expect((await call('DELETE', `${base()}/${web2.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    const left = await data<WebDomainList>(await call('GET', base(), { cookie: owner.cookie }));
    expect(left.hostnames.map((h) => h.hostname).sort()).toEqual([domain, `www.${domain}`].sort());
    expect(left.hostnames.find((h) => h.id === web.id)?.isPrimary).toBe(true);
  });

  it('refuses duplicates, platform hostnames and bad input', async () => {
    const domain = unique();
    await data(
      await call('POST', base(), { cookie: owner.cookie, body: { hostname: domain } }),
      201,
    );
    expect(
      (await call('POST', base(), { cookie: owner.cookie, body: { hostname: `www.${domain}` } }))
        .status,
    ).toBe(409);
    const stranger = await signIn();
    const strangerChannel = await createChannel(stranger);
    expect(
      (
        await call('POST', `/api/v1/channels/${strangerChannel.id}/domains/web`, {
          cookie: stranger.cookie,
          body: { hostname: domain },
        })
      ).status,
    ).toBe(409);
    for (const hostname of ['news.site.localhost', 'x.mail.swarm.localhost', 'not a domain']) {
      expect(
        (await call('POST', base(), { cookie: owner.cookie, body: { hostname } })).status,
        hostname,
      ).toBe(400);
    }
    expect(
      (
        await call('POST', base(), {
          cookie: owner.cookie,
          body: { hostname: `blog.${unique()}`, redirectApex: true },
        })
      ).status,
    ).toBe(400);
  });

  it('tells bare domains from subdomains with the public suffix list', async () => {
    expect(isBareDomain('example.com')).toBe(true);
    expect(isBareDomain('example.co.uk')).toBe(true);
    expect(isBareDomain('www.example.co.uk')).toBe(false);
    expect(isBareDomain('blog.example.com.au')).toBe(false);
    expect(isBareDomain('example.com.au')).toBe(true);
    // A private suffix: its owner can't set apex records, so it is a subdomain here.
    expect(isBareDomain('alice.github.io')).toBe(false);
    expect(registrableDomain('co.uk')).toBeNull();

    const { id: ch } = await createChannel(owner);
    const label = `d${crypto.randomUUID().slice(0, 8)}`;
    const added = await data<WebDomainList>(
      await call('POST', `/api/v1/channels/${ch}/domains/web`, {
        cookie: owner.cookie,
        body: { hostname: `${label}.co.uk` },
      }),
      201,
    );
    expect(added.hostnames.map((h) => [h.hostname, h.role]).sort()).toEqual(
      [
        [`${label}.co.uk`, 'apex_redirect'],
        [`www.${label}.co.uk`, 'web'],
      ].sort(),
    );
    expect(added.domains.map((d) => d.domain)).toEqual([`${label}.co.uk`]);
    const sub = await data<WebDomainList>(
      await call('POST', `/api/v1/channels/${ch}/domains/web`, {
        cookie: owner.cookie,
        body: { hostname: `news.${label}x.co.uk` },
      }),
      201,
    );
    expect(sub.hostnames.find((h) => h.hostname === `news.${label}x.co.uk`)?.role).toBe('web');
    expect(sub.hostnames.some((h) => h.hostname === `www.news.${label}x.co.uk`)).toBe(false);
    expect(
      (
        await call('POST', `/api/v1/channels/${ch}/domains/web`, {
          cookie: owner.cookie,
          body: { hostname: 'co.uk' },
        })
      ).status,
    ).toBe(400);
  });

  it('shows email and link domains as roles of the same domain', async () => {
    const { id: ch } = await createChannel(owner);
    const domain = unique();
    await data(
      await call('POST', `/api/v1/channels/${ch}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: `news.${domain}`, kind: 'email' },
      }),
      201,
    );
    await data(
      await call('POST', `/api/v1/channels/${ch}/domains/web`, {
        cookie: owner.cookie,
        body: { hostname: domain },
      }),
      201,
    );
    const list = await data<WebDomainList>(
      await call('GET', `/api/v1/channels/${ch}/domains/web`, { cookie: owner.cookie }),
    );
    expect(list.domains).toHaveLength(1);
    expect(list.domains[0]).toMatchObject({
      domain,
      email: { hostname: `news.${domain}`, status: 'pending' },
      link: { hostname: null, status: 'not_set_up' },
    });
  });

  describe('a claim nobody has proven', () => {
    const DAY = 86_400_000;
    const web = (s: Session, channelId: string, hostname: string) =>
      call('POST', `/api/v1/channels/${channelId}/domains/web`, {
        cookie: s.cookie,
        body: { hostname },
      });
    const rows = async (hostname: string) =>
      (
        await env.DB.prepare(
          `SELECT channel_id FROM custom_hostnames WHERE hostname = ?1
           UNION ALL SELECT channel_id FROM sending_domains WHERE domain = ?1`,
        )
          .bind(hostname)
          .all<{ channel_id: string }>()
      ).results.map((r) => r.channel_id);

    /** Publishes, in the dev resolver, every TXT record a refusal asks for. */
    async function publishProofs(res: Response) {
      expect(res.status).toBe(409);
      const { message } = (await json<{ error: { message: string } }>(res)).error;
      const proofs = [...message.matchAll(/(_swarm-claim\.\S+?) .*?(swarm-claim=[0-9a-f]+)/g)];
      expect(proofs.length, message).toBeGreaterThan(0);
      for (const [, name, value] of proofs) {
        await env.CACHE.put(`dev:txt:${name}`, JSON.stringify([value]));
      }
    }

    it('lets the owner add a web domain someone claimed as a link domain a week ago', async () => {
      const squatter = await signIn();
      const theirs = await createChannel(squatter);
      const domain = unique();
      const link = await data<{ id: string }>(
        await call('POST', `/api/v1/channels/${theirs.id}/sending-domains`, {
          cookie: squatter.cookie,
          body: { domain: `www.${domain}`, kind: 'link' },
        }),
        201,
      );
      await env.DB.prepare('UPDATE sending_domains SET created_at = created_at - ?1 WHERE id = ?2')
        .bind(8 * DAY, link.id)
        .run();
      await publishProofs(await web(owner, channel.id, domain));
      await data(await web(owner, channel.id, domain), 201);
      expect(await rows(`www.${domain}`)).toEqual([channel.id]);
    });

    it('asks another workspace for the TXT proof even after the claim stopped being re-checked', async () => {
      const first = await signIn();
      const theirs = await createChannel(first);
      const { id: ours } = await createChannel(owner);
      const domain = unique();
      await data(await web(first, theirs.id, domain), 201);
      const link = await data<{ id: string }>(
        await call('POST', `/api/v1/channels/${theirs.id}/sending-domains`, {
          cookie: first.cookie,
          body: { domain: `links.${domain}`, kind: 'link' },
        }),
        201,
      );
      // Long past both windows (two weeks for web hostnames, one for link domains).
      await env.DB.prepare(
        'UPDATE custom_hostnames SET created_at = created_at - ?1 WHERE channel_id = ?2',
      )
        .bind(30 * DAY, theirs.id)
        .run();
      await env.DB.prepare('UPDATE sending_domains SET created_at = created_at - ?1 WHERE id = ?2')
        .bind(30 * DAY, link.id)
        .run();
      for (const hostname of [domain, `links.${domain}`]) {
        const res = await web(owner, ours, hostname);
        expect(res.status).toBe(409);
        expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
          /never verified\. If it’s yours, publish a TXT record named _swarm-claim\./,
        );
      }
      expect(await rows(`www.${domain}`)).toEqual([theirs.id]);
      expect(await rows(`links.${domain}`)).toEqual([theirs.id]);
    });

    it('lets the Channel that publishes the TXT proof take over pending web hostnames', async () => {
      const squatter = await signIn();
      const theirs = await createChannel(squatter);
      const { id: ours } = await createChannel(owner);
      const domain = unique();
      await data(await web(squatter, theirs.id, domain), 201);
      const refused = await web(owner, ours, domain);
      expect(refused.status).toBe(409);
      const { message } = (await json<{ error: { message: string } }>(refused)).error;
      // One record per hostname it holds: www and the bare domain.
      const proofs = [...message.matchAll(/(_swarm-claim\.\S+?) .*?(swarm-claim=[0-9a-f]+)/g)];
      expect(proofs.map((m) => m[1]).sort(), message).toEqual(
        [`_swarm-claim.${domain}`, `_swarm-claim.www.${domain}`].sort(),
      );
      for (const [, name, value] of proofs) {
        await env.CACHE.put(`dev:txt:${name}`, JSON.stringify([value]));
      }
      await data(await web(owner, ours, domain), 201);
      expect(await rows(domain)).toEqual([ours]);
      expect(await rows(`www.${domain}`)).toEqual([ours]);
    });

    it('never takes over a hostname that has been active', async () => {
      const first = await signIn();
      const theirs = await createChannel(first);
      const { id: ours } = await createChannel(owner);
      const domain = unique();
      const added = await data<WebDomainList>(await web(first, theirs.id, domain), 201);
      for (const hostname of added.hostnames) {
        await call('POST', `/api/v1/channels/${theirs.id}/domains/web/${hostname.id}/refresh`, {
          cookie: first.cookie,
        });
      }
      // Pending again (a certificate renewal, say), and long past its first two weeks.
      await env.DB.prepare(
        `UPDATE custom_hostnames SET status = 'pending', created_at = created_at - ?1 WHERE channel_id = ?2`,
      )
        .bind(30 * DAY, theirs.id)
        .run();
      const res = await web(owner, ours, domain);
      expect(res.status).toBe(409);
      expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
        /is already set up/,
      );
      expect(await rows(`www.${domain}`)).toEqual([theirs.id]);
    });

    it('needs the TXT proof for hostnames whose DNS already points at the platform', async () => {
      const TARGET = 'sites.site.localhost';
      const { id: ours } = await createChannel(owner);
      const domain = unique();
      // An earlier Channel removed the domain but left its records: www by CNAME, the bare domain
      // flattened to the target's addresses. Either would activate for whoever adds it next.
      await env.CACHE.put(`dev:cname:www.${domain}`, JSON.stringify([TARGET]));
      await env.CACHE.put(`dev:a:${TARGET}`, JSON.stringify(['192.0.2.10']));
      await env.CACHE.put(`dev:a:${domain}`, JSON.stringify(['192.0.2.10']));
      const refused = await web(owner, ours, domain);
      expect(refused.status).toBe(409);
      const { error } = await json<{
        error: { message: string; details: { path: string; message: string }[] };
      }>(refused.clone());
      expect(error.message).toMatch(
        /^\S+ and \S+ already point at Swarm, so we need to check they’re yours\. Publish a TXT record named _swarm-claim\./,
      );
      expect(error.message).not.toMatch(/another Channel/);
      expect(error.details.map((d) => d.message.split(' ')[1]).sort()).toEqual(
        [`_swarm-claim.${domain}`, `_swarm-claim.www.${domain}`].sort(),
      );
      expect(error.details.every((d) => d.path === 'hostname')).toBe(true);
      expect(await rows(`www.${domain}`)).toEqual([]);
      await publishProofs(refused);
      await data(await web(owner, ours, domain), 201);
      expect(await rows(domain)).toEqual([ours]);
      expect(await rows(`www.${domain}`)).toEqual([ours]);
      await env.CACHE.delete(`dev:a:${TARGET}`);
    });

    it('says which names were claimed and which already point at the platform', async () => {
      const TARGET = 'sites.site.localhost';
      const squatter = await signIn();
      const theirs = await createChannel(squatter);
      const { id: ours } = await createChannel(owner);
      const domain = unique();
      await data(
        await call('POST', `/api/v1/channels/${theirs.id}/sending-domains`, {
          cookie: squatter.cookie,
          body: { domain: `www.${domain}`, kind: 'link' },
        }),
        201,
      );
      await env.CACHE.put(`dev:a:${TARGET}`, JSON.stringify(['192.0.2.10']));
      await env.CACHE.put(`dev:a:${domain}`, JSON.stringify(['192.0.2.10']));
      try {
        const refused = await web(owner, ours, domain);
        expect(refused.status).toBe(409);
        const { message } = (await json<{ error: { message: string } }>(refused.clone())).error;
        expect(message).toMatch(
          new RegExp(
            `^www\\.${domain.replace('.', '\\.')} was added by another Channel but never verified, and ${domain.replace('.', '\\.')} already points at Swarm\\. If they’re yours, publish `,
          ),
        );
        await publishProofs(refused);
        await data(await web(owner, ours, domain), 201);
        expect(await rows(`www.${domain}`)).toEqual([ours]);
      } finally {
        await env.CACHE.delete(`dev:a:${TARGET}`);
      }
    });

    it('needs the TXT proof for a hostname whose CNAME chain reaches the platform', async () => {
      const TARGET = 'sites.site.localhost';
      const { id: ours } = await createChannel(owner);
      // www's own CNAME is the owner's alias; the alias was left pointing at the target.
      const name = `www.${unique()}`;
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify([`alias.${name}`]));
      await env.CACHE.put(`dev:cname:alias.${name}`, JSON.stringify([`${TARGET}.`]));
      const refused = await web(owner, ours, name);
      expect(refused.status).toBe(409);
      expect((await json<{ error: { message: string } }>(refused.clone())).error.message).toMatch(
        new RegExp(`^${name.replaceAll('.', '\\.')} already points at Swarm`),
      );
      expect(await rows(name)).toEqual([]);
      await publishProofs(refused);
      await data(await web(owner, ours, name), 201);
      expect(await rows(name)).toEqual([ours]);
    });

    it('needs the TXT proof for a hostname whose CNAME ends at a name flattened to the platform', async () => {
      const TARGET = 'sites.site.localhost';
      const { id: ours } = await createChannel(owner);
      // www points at the bare domain, which has no CNAME of its own: it was flattened (or an
      // ALIAS) to the target's addresses.
      const domain = unique();
      const name = `www.${domain}`;
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify([`${domain}.`]));
      await env.CACHE.put(`dev:a:${TARGET}`, JSON.stringify(['192.0.2.10', '192.0.2.11']));
      await env.CACHE.put(`dev:a:${domain}`, JSON.stringify(['192.0.2.11', '192.0.2.10']));
      try {
        const refused = await web(owner, ours, name);
        expect(refused.status).toBe(409);
        expect(await rows(name)).toEqual([]);
        await publishProofs(refused);
        await data(await web(owner, ours, name), 201);
        expect(await rows(name)).toEqual([ours]);
      } finally {
        await env.CACHE.delete(`dev:a:${TARGET}`);
      }
    });

    it('needs the TXT proof for a hostname whose CNAME a link domain left behind', async () => {
      const { id: ours } = await createChannel(owner);
      // Both are custom hostnames in the same zone: the track host activates a web hostname too.
      const name = `blog.${unique()}`;
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify(['localhost']));
      const refused = await web(owner, ours, name);
      expect(refused.status).toBe(409);
      expect(await rows(name)).toEqual([]);
      await publishProofs(refused);
      await data(await web(owner, ours, name), 201);
      expect(await rows(name)).toEqual([ours]);
    });

    it('refuses a hostname whose DNS cannot be checked', async () => {
      const { id: ours } = await createChannel(owner);
      const name = `blog.${unique()}`;
      // The dev double fails the lookup for a non-list answer.
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify({ error: 'SERVFAIL' }));
      const res = await web(owner, ours, name);
      expect(res.status).toBe(503);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
        `DNS for ${name} couldn’t be checked. Try again in a minute.`,
      );
      expect(await rows(name)).toEqual([]);
    });

    it('needs no proof for a hostname whose DNS points elsewhere or nowhere yet', async () => {
      const { id: ours } = await createChannel(owner);
      const elsewhere = `blog.${unique()}`;
      await env.CACHE.put(`dev:cname:${elsewhere}`, JSON.stringify(['cdn.example.net']));
      await data(await web(owner, ours, elsewhere), 201);
      const chained = `news.${unique()}`;
      await env.CACHE.put(`dev:cname:${chained}`, JSON.stringify([`alias.${chained}`]));
      await env.CACHE.put(`dev:cname:alias.${chained}`, JSON.stringify(['cdn.example.net']));
      await data(await web(owner, ours, chained), 201);
      // Sharing an address with the target is not pointing at it (anycast addresses are shared).
      const TARGET = 'sites.site.localhost';
      const shared = `shop.${unique()}`;
      await env.CACHE.put(`dev:a:${TARGET}`, JSON.stringify(['192.0.2.10', '192.0.2.11']));
      await env.CACHE.put(`dev:a:${shared}`, JSON.stringify(['192.0.2.10', '198.51.100.7']));
      try {
        await data(await web(owner, ours, shared), 201);
      } finally {
        await env.CACHE.delete(`dev:a:${TARGET}`);
      }
      const fresh = unique();
      await data(await web(owner, ours, fresh), 201);
      expect(await rows(`www.${fresh}`)).toEqual([ours]);
    });
  });

  it('activates pending hostnames from the jobs cron, in bounded batches', async () => {
    const { id: ch } = await createChannel(owner);
    const domain = unique();
    await data(
      await call('POST', `/api/v1/channels/${ch}/domains/web`, {
        cookie: owner.cookie,
        body: { hostname: domain },
      }),
      201,
    );
    const now = Date.now() + 10 * 60_000;
    const first = await refreshPendingHostnames(env.DB, new DevWebHostnames(), now, 1);
    expect(first).toEqual({ checked: 1, activated: 1 });
    await refreshPendingHostnames(env.DB, new DevWebHostnames(), now, 100);
    const { results } = await env.DB.prepare(
      'SELECT status FROM custom_hostnames WHERE channel_id = ?1',
    )
      .bind(ch)
      .all<{ status: string }>();
    expect(results.map((r) => r.status)).toEqual(['active', 'active']);
  });
});

describe('site analytics', () => {
  it('aggregates daily rollups with filters and a default 30-day range', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const rows: [string, string, string, string, string, number, number][] = [
      [today, '/p/a', 'google', 'desktop', 'US', 10, 8],
      [today, '/p/a', 'direct', 'mobile', 'DE', 5, 5],
      [yesterday, '/p/b', 'google', 'mobile', 'US', 3, 2],
      [old, '/p/a', 'google', 'desktop', 'US', 100, 90],
    ];
    for (const row of rows) {
      await env.DB.prepare(
        `INSERT INTO site_page_views_daily (channel_id, day, path, source, device, country, views, visitors)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
        .bind(channel.id, ...row)
        .run();
    }
    const base = `/api/v1/channels/${channel.id}/site/analytics`;
    const all = await data<SiteAnalytics>(await call('GET', base, { cookie: owner.cookie }));
    expect(all.to).toBe(today);
    expect(all.byDay).toHaveLength(30);
    expect(all.totals).toEqual({ views: 18, visitors: 15 });
    expect(all.byDay.at(-1)).toEqual({ day: today, views: 15, visitors: 13 });
    expect(all.topPaths[0]).toEqual({ path: '/p/a', views: 15, visitors: 13 });
    expect(all.topSources.map((s) => s.source)).toEqual(['google', 'direct']);
    expect(all.devices.map((d) => [d.device, d.views])).toEqual([
      ['desktop', 10],
      ['mobile', 8],
    ]);
    expect(all.countries[0]).toEqual({ country: 'US', views: 13, visitors: 10 });

    const filtered = await data<SiteAnalytics>(
      await call('GET', `${base}?source=google&path=/p/a&from=${old}&to=${today}`, {
        cookie: owner.cookie,
      }),
    );
    expect(filtered.totals).toEqual({ views: 110, visitors: 98 });

    for (const query of [
      'from=2026-13-01',
      'from=2026-10-20&to=2026-10-01',
      'from=2020-01-01&to=2026-01-01',
    ]) {
      expect((await call('GET', `${base}?${query}`, { cookie: owner.cookie })).status, query).toBe(
        400,
      );
    }
  });
});

describe('roles and tenancy for Site Studio routes', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let outsider: Session;
  const seats = {} as Record<SeatRole, Session>;
  let ctx: {
    channelId: string;
    sectionId: string;
    pageId: string;
    redirectId: string;
    hostnameId: string;
    dispatchId: string;
  };

  beforeAll(async () => {
    const owner = await signIn();
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const)
      seats[role] = await seatAs(owner.workspaceId, role);
    outsider = await signIn();
    const { id: channelId } = await createChannel(owner);
    await enableFlag('site_sections', owner.workspaceId, channelId);
    await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1")
      .bind(owner.workspaceId)
      .run();
    const section = await data<SiteSection>(
      await call('POST', `/api/v1/channels/${channelId}/site/sections`, {
        cookie: owner.cookie,
        body: { name: 'Base' },
      }),
      201,
    );
    const page = await data<SitePage>(
      await call('POST', `/api/v1/channels/${channelId}/site/pages`, {
        cookie: owner.cookie,
        body: { title: 'Base page' },
      }),
      201,
    );
    const redirect = await data<SiteRedirect>(
      await call('POST', `/api/v1/channels/${channelId}/site/redirects`, {
        cookie: owner.cookie,
        body: { from: '/base', to: '/p/base' },
      }),
      201,
    );
    const domains = await data<WebDomainList>(
      await call('POST', `/api/v1/channels/${channelId}/domains/web`, {
        cookie: owner.cookie,
        body: { hostname: `www.r${crypto.randomUUID().slice(0, 8)}.example` },
      }),
      201,
    );
    const dispatch = await newDispatch(owner, channelId, { subject: 'Roles' });
    ctx = {
      channelId,
      sectionId: section.id,
      pageId: page.id,
      redirectId: redirect.id,
      hostnameId: domains.hostnames[0]!.id,
      dispatchId: dispatch.id,
    };
  });

  let counter = 0;
  const next = () => `n${++counter}-${crypto.randomUUID().slice(0, 6)}`;
  const ch = () => `/api/v1/channels/${ctx.channelId}`;
  const ROUTES: {
    name: string;
    minimum: SeatRole;
    request: (s: Session) => Promise<Response>;
  }[] = [
    {
      name: 'read settings',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/settings`, { cookie: s.cookie }),
    },
    {
      name: 'save settings',
      minimum: 'editor',
      request: (s) =>
        call('PATCH', `${ch()}/site/settings`, { cookie: s.cookie, body: { prevNextNav: true } }),
    },
    {
      name: 'set AI crawler policy in settings',
      minimum: 'admin',
      request: (s) =>
        call('PATCH', `${ch()}/site/settings`, { cookie: s.cookie, body: { aiBots: 'allow' } }),
    },
    {
      name: 'list sections',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/sections`, { cookie: s.cookie }),
    },
    {
      name: 'add section',
      minimum: 'editor',
      request: (s) =>
        call('POST', `${ch()}/site/sections`, { cookie: s.cookie, body: { name: next() } }),
    },
    {
      name: 'change section',
      minimum: 'editor',
      request: (s) =>
        call('PATCH', `${ch()}/site/sections/${ctx.sectionId}`, {
          cookie: s.cookie,
          body: { position: 1 },
        }),
    },
    {
      name: 'list pages',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/pages`, { cookie: s.cookie }),
    },
    {
      name: 'read page',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/pages/${ctx.pageId}`, { cookie: s.cookie }),
    },
    {
      name: 'add page',
      minimum: 'editor',
      request: (s) =>
        call('POST', `${ch()}/site/pages`, { cookie: s.cookie, body: { title: next() } }),
    },
    {
      name: 'change page',
      minimum: 'editor',
      request: (s) =>
        call('PATCH', `${ch()}/site/pages/${ctx.pageId}`, {
          cookie: s.cookie,
          body: { position: 2 },
        }),
    },
    {
      name: 'list redirects',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/redirects`, { cookie: s.cookie }),
    },
    {
      name: 'add redirect',
      minimum: 'editor',
      request: (s) =>
        call('POST', `${ch()}/site/redirects`, {
          cookie: s.cookie,
          body: { from: `/${next()}`, to: '/' },
        }),
    },
    {
      name: 'change redirect',
      minimum: 'editor',
      request: (s) =>
        call('PATCH', `${ch()}/site/redirects/${ctx.redirectId}`, {
          cookie: s.cookie,
          body: { statusCode: 302 },
        }),
    },
    {
      name: 'import redirects',
      minimum: 'editor',
      request: (s) =>
        call('POST', `${ch()}/site/redirects/import`, {
          cookie: s.cookie,
          body: { csv: `/${next()},/p/x` },
        }),
    },
    {
      name: 'read bot rules',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/bot-rules`, { cookie: s.cookie }),
    },
    {
      name: 'set bot rules',
      minimum: 'admin',
      request: (s) =>
        call('PUT', `${ch()}/site/bot-rules`, { cookie: s.cookie, body: { policy: 'allow' } }),
    },
    {
      name: 'analytics',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/site/analytics`, { cookie: s.cookie }),
    },
    {
      name: 'list web domains',
      minimum: 'viewer',
      request: (s) => call('GET', `${ch()}/domains/web`, { cookie: s.cookie }),
    },
    {
      name: 'add web domain',
      minimum: 'admin',
      request: (s) =>
        call('POST', `${ch()}/domains/web`, {
          cookie: s.cookie,
          body: { hostname: `www.${next()}.example` },
        }),
    },
    {
      name: 'refresh web domain',
      minimum: 'admin',
      request: (s) =>
        call('POST', `${ch()}/domains/web/${ctx.hostnameId}/refresh`, { cookie: s.cookie }),
    },
    {
      name: 'make web domain primary',
      minimum: 'admin',
      request: (s) =>
        call('POST', `${ch()}/domains/web/${ctx.hostnameId}/primary`, { cookie: s.cookie }),
    },
    {
      name: 'publish to the web',
      minimum: 'editor',
      request: (s) =>
        call('POST', `/api/v1/dispatches/${ctx.dispatchId}/publish-web`, { cookie: s.cookie }),
    },
    {
      name: 'change web fields',
      minimum: 'editor',
      request: (s) => patch(s, ctx.dispatchId, { webVisibility: 'public' }),
    },
  ];

  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('hides other Channels’ rows behind 404, even inside a Channel the operator can see', async () => {
    const own = await createChannel(outsider);
    await enableFlag('site_sections', outsider.workspaceId, own.id);
    const theirs = `/api/v1/channels/${own.id}`;
    for (const [method, path] of [
      ['GET', `${theirs}/site/pages/${ctx.pageId}`],
      ['PATCH', `${theirs}/site/sections/${ctx.sectionId}`],
      ['DELETE', `${theirs}/site/pages/${ctx.pageId}`],
      ['DELETE', `${theirs}/site/redirects/${ctx.redirectId}`],
      ['DELETE', `${theirs}/site/sections/${ctx.sectionId}`],
      ['POST', `${theirs}/domains/web/${ctx.hostnameId}/refresh`],
      ['DELETE', `${theirs}/domains/web/${ctx.hostnameId}`],
      ['POST', `/api/v1/dispatches/${ctx.dispatchId}/unpublish-web`],
    ] as const) {
      const res = await call(method, path, {
        cookie: outsider.cookie,
        ...(method === 'PATCH' ? { body: { name: 'Taken' } } : {}),
      });
      expect(res.status, path).toBe(404);
    }
  });

  it('lets only editors and above remove sections, pages and redirects, and admins domains', async () => {
    const c = ch();
    expect(
      (await call('DELETE', `${c}/site/sections/${ctx.sectionId}`, { cookie: seats.author.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await call('DELETE', `${c}/site/pages/${ctx.pageId}`, { cookie: seats.author.cookie }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('DELETE', `${c}/site/redirects/${ctx.redirectId}`, {
          cookie: seats.author.cookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('DELETE', `${c}/domains/web/${ctx.hostnameId}`, { cookie: seats.editor.cookie }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/dispatches/${ctx.dispatchId}/unpublish-web`, {
          cookie: seats.author.cookie,
        })
      ).status,
    ).toBe(403);
  });
});
