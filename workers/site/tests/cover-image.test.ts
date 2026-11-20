import { SELF, env } from 'cloudflare:test';
import type { WebMedia } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SiteChannel } from '../src/context';
import type { SiteDispatch } from '../src/render/data';
import { dispatchArticle, dispatchImage, renderDispatch } from '../src/render/dispatch';
import { seedChannel, type SeededChannel } from './helpers';

const MEDIA_ORIGIN = 'http://localhost:8792';
const hex = () => crypto.randomUUID().replace(/-/g, '');
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

const COVER_URL = `${MEDIA_ORIGIN}/media/cover.png`;
const media = new Map<string, WebMedia>([
  ['md_cover', { url: COVER_URL, alt: 'From the library', width: 1600, height: 900, focalX: 0.2 }],
]);
const context = { channelName: 'Field Notes', media, allowHtmlBlocks: false };

const channel = {
  id: 'ch_x',
  name: 'Field Notes',
  origin: 'https://notes.example',
  branding: {},
  settings: { seo: {} },
} as unknown as SiteChannel;

const dispatch: SiteDispatch = {
  id: 'dp_x',
  subject: 'S',
  preheader: '',
  publishedAt: 1,
  updatedAt: 2,
  sectionId: null,
  slug: 's',
  createdBy: null,
  visibility: 'paid',
  contentJson: doc(p('Free intro.'), { type: 'gate' }, p('Secret text.')),
  coverMediaId: 'md_cover',
  coverAlt: 'A fox at dawn',
};

const article = (d: SiteDispatch, reader: 'anonymous' | 'member' | 'paid', images = false) =>
  dispatchArticle({
    channel,
    dispatch: d,
    rendered: renderDispatch(d, context),
    reader,
    crawlerFullAccess: false,
    subscribeForm: '<form></form>',
    image: null,
    images,
  }).html;

describe('cover image on the post page', () => {
  it('shows above the header for every reader, with the body still gated', () => {
    for (const reader of ['anonymous', 'member', 'paid'] as const) {
      const html = article(dispatch, reader);
      expect(html, reader).toContain(`src="${COVER_URL}"`);
      expect(html, reader).toContain('alt="A fox at dawn"');
      expect(html.indexOf('sw-cover'), reader).toBeLessThan(html.indexOf('<h1>'));
      expect(html, reader).toContain(reader === 'paid' ? 'Secret text.' : 'class="sw-gate');
    }
    expect(article(dispatch, 'anonymous')).not.toContain('Secret text.');
  });

  it('holds its space and loads straight away', () => {
    const html = article(dispatch, 'anonymous');
    expect(html).toContain('width="1600" height="900"');
    const img = /<figure class="sw-cover">(<img[^>]*>)/.exec(html)![1]!;
    expect(img).not.toContain('loading="lazy"');
    expect(img).not.toContain('style=');
  });

  it('applies the focal point through the page’s generated class', () => {
    const rendered = renderDispatch(dispatch, context);
    expect(rendered.css).toContain('.sw-fp-20-50{object-position:20% 50%}');
    expect(article(dispatch, 'anonymous')).toContain('class="sw-fp-20-50"');
  });

  it('offers resized copies only with the Images binding', () => {
    expect(article(dispatch, 'anonymous')).not.toContain('srcset');
    expect(article(dispatch, 'anonymous', true)).toContain(`${COVER_URL}?w=640 640w`);
  });

  it('shows nothing without a cover, or once the media item is gone', () => {
    const none = { ...dispatch, coverMediaId: null, coverAlt: '' };
    const gone = { ...dispatch, coverMediaId: 'md_gone' };
    for (const d of [none, gone]) {
      expect(article(d, 'anonymous')).not.toContain('sw-cover');
      expect(renderDispatch(d, context).cover).toBeNull();
    }
  });

  it('falls back to the library’s alt text, and escapes alt text', () => {
    expect(article({ ...dispatch, coverAlt: ' ' }, 'anonymous')).toContain(
      'alt="From the library"',
    );
    const html = article({ ...dispatch, coverAlt: `"><script>x('y')</script>` }, 'anonymous');
    expect(html).not.toContain('<script');
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;');
  });

  it('never shows a merge tag as written', () => {
    expect(article({ ...dispatch, coverAlt: 'For {{ first_name | you }}' }, 'anonymous')).toContain(
      'alt="For you"',
    );
  });

  it('survives a document the renderer refuses', () => {
    const broken = { ...dispatch, contentJson: doc({ type: 'script' }) };
    const rendered = renderDispatch(broken, context);
    expect(rendered.freeHtml).toBe('');
    expect(rendered.cover?.url).toBe(COVER_URL);
  });

  it('is the social image, ahead of the first image and the fallback', () => {
    const withImage: SiteDispatch = {
      ...dispatch,
      visibility: 'public',
      contentJson: doc({ type: 'image', attrs: { mediaId: 'md_inline', alt: 'Inline' } }),
    };
    const both = new Map(media).set('md_inline', { url: `${MEDIA_ORIGIN}/media/inline.png` });
    const fallback = { url: 'https://fallback.example/x.png', alt: 'F', width: 1, height: 1 };
    const rendered = renderDispatch(withImage, { ...context, media: both });
    expect(dispatchImage(rendered, MEDIA_ORIGIN, fallback)).toMatchObject({
      url: COVER_URL,
      alt: 'A fox at dawn',
      width: 1600,
      height: 900,
      focal: [20, 50],
    });
    const uncovered = renderDispatch(
      { ...withImage, coverMediaId: null },
      { ...context, media: both },
    );
    expect(dispatchImage(uncovered, MEDIA_ORIGIN, fallback)?.alt).toBe('Inline');
    const plain = renderDispatch({ ...dispatch, coverMediaId: 'md_gone' }, context);
    expect(dispatchImage(plain, MEDIA_ORIGIN, fallback)).toBe(fallback);
  });
});

describe('cover image through the site', () => {
  let site: SeededChannel;
  let mediaId: string;

  const seedPost = async (slug: string, visibility: string, coverId: string | null) => {
    const id = `dp_${hex()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at,
           web_visibility, web_published_at, cover_media_id, cover_alt)
         VALUES (?1, ?2, ?3, '', ?4, 'sent', 0, 1, ?5, 1, ?6, 'A fox at dawn')`,
      ).bind(
        id,
        site.channelId,
        `Post ${slug}`,
        doc(p('Free.'), { type: 'gate' }, p('Secret.')),
        visibility,
        coverId,
      ),
      env.DB.prepare(
        'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
      ).bind(site.channelId, slug, id),
    ]);
  };
  const addMedia = async (id: string, workspaceId: string) =>
    env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, width, height, alt_text, visibility, created_at)
       VALUES (?1, ?2, NULL, ?3, 'image/png', 10, 1600, 900, NULL, 'public', 0)`,
    )
      .bind(id, workspaceId, `ws/${workspaceId}/${id}.png`)
      .run();

  beforeAll(async () => {
    site = await seedChannel();
    mediaId = `md_${hex()}`;
    await addMedia(mediaId, site.workspaceId);
    await seedPost('free-one', 'public', mediaId);
    await seedPost('paid-one', 'paid', mediaId);
    await seedPost('no-cover', 'public', null);
  });

  const page = async (slug: string) => {
    const res = await SELF.fetch(`${site.origin}/p/${slug}`);
    expect(res.status).toBe(200);
    return res.text();
  };

  it('puts the cover on the page and in the sharing tags, first-party only', async () => {
    const html = await page('free-one');
    const url = `${MEDIA_ORIGIN}/media/ws/${site.workspaceId}/${mediaId}.png`;
    expect(html).toContain(`src="${url}"`);
    expect(html).toContain('width="1600" height="900"');
    expect(html).toContain(`<meta property="og:image" content="${url}">`);
    expect(html).toContain('summary_large_image');
  });

  it('shows it above the paywall to an anonymous reader', async () => {
    const html = await page('paid-one');
    expect(html).toContain('sw-cover');
    expect(html).not.toContain('Secret.');
    expect(html).toContain('summary_large_image');
  });

  it('has no cover, and no image of its own to share, without one', async () => {
    const html = await page('no-cover');
    expect(html).not.toContain('sw-cover');
    expect(html).not.toContain('<meta property="og:image"');
  });

  it('leaves out a deleted item, and another workspace’s item', async () => {
    const deleted = `md_${hex()}`;
    await addMedia(deleted, site.workspaceId);
    await env.DB.prepare('UPDATE media SET deleted_at = 1 WHERE id = ?1').bind(deleted).run();
    await seedPost('deleted-one', 'public', deleted);
    const foreign = await seedChannel();
    const theirs = `md_${hex()}`;
    await addMedia(theirs, foreign.workspaceId);
    await seedPost('foreign-one', 'public', theirs);
    for (const slug of ['deleted-one', 'foreign-one']) {
      const html = await page(slug);
      expect(html, slug).toContain(`Post ${slug}`);
      expect(html, slug).not.toContain('sw-cover');
    }
  });

  it('uses the cover on the archive card', async () => {
    const res = await SELF.fetch(`${site.origin}/`);
    expect(await res.text()).toContain(`/media/ws/${site.workspaceId}/${mediaId}.png`);
  });
});
