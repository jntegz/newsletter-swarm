// Uploaded fonts on a site (docs/site-themes.md, "Uploaded fonts"): the design's stylesheet and its
// preview load each one from the site's own /media/, after an @font-face with the setting's default
// as the fallback; the files are served as fonts; a font that is gone, or isn't this Channel's,
// falls back to the default.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { standardSettings, uploadedFontFamily, type ThemeFiles } from '@swarm/site-themes';
import { signSitePreview } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { createSite, mountSite } from '../src/index';
import { call, seedChannel, type SeededChannel } from './helpers';

const site = createSite((s) => mountSite(s));

const FILES: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Fonts',
    settings: standardSettings({ heading_font: 'archivo', body_font: 'serif' }),
    sections: [{ type: 'hero' }],
  }),
  'sections/hero.html': `<section><h1>{{ site.name }}</h1>{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}</section>
{% schema %}{"name":"Hero","settings":[]}{% endschema %}`,
  'theme.css': '.t-fonts-marker{display:block}',
};

const flagOn = (ch: SeededChannel) =>
  env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), ch.channelId)
    .run();

/** A font in a Channel's media library: the row and the stored file. */
async function addFont(ch: SeededChannel, ext: 'woff2' | 'woff' = 'woff2', type = `font/${ext}`) {
  const id = newId('media');
  const key = `ws/${ch.workspaceId}/ch/${ch.channelId}/${id}.${ext}`;
  await env.DB.prepare(
    `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, alt_text, visibility, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 64, 'Brand Sans', 'public', 0)`,
  )
    .bind(id, ch.workspaceId, ch.channelId, key, type)
    .run();
  await env.MEDIA.put(key, new Uint8Array(64), {
    httpMetadata: { contentType: type },
    customMetadata: { visibility: 'public' },
  });
  return { id, key };
}

/** Publishes a design with these settings (and stores the same as the draft), as the API does. */
async function publish(ch: SeededChannel, settings: Record<string, unknown>) {
  const json = JSON.stringify({ theme: 'launch', files: FILES, settings, sections: null });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO site_designs (channel_id, draft_json, draft_updated_at, published_json, published_version, published_at)
       VALUES (?1, ?2, ?3, ?2, 1, ?3)
       ON CONFLICT (channel_id) DO UPDATE SET draft_json = excluded.draft_json,
         published_json = excluded.published_json,
         published_version = site_designs.published_version + 1`,
    ).bind(ch.channelId, json, now),
    env.DB.prepare(
      `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
    ).bind(ch.channelId, now),
  ]);
}

const get = (ch: SeededChannel, path: string) => call(site, `${ch.origin}${path}`);

async function stylesheet(ch: SeededChannel) {
  const home = await get(ch, '/');
  const html = await home.text();
  const href = /href="(\/_swarm\/site\.css[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, '&');
  return { home, css: await (await get(ch, href)).text() };
}

describe('uploaded fonts on the site', () => {
  it('loads the font from the site’s own /media/, the default after it, allowed by the CSP', async () => {
    const ch = await seedChannel();
    await flagOn(ch);
    const font = await addFont(ch);
    await publish(ch, { heading_font: font.id });
    const { home, css } = await stylesheet(ch);
    const family = uploadedFontFamily(font.id);
    expect(css).toContain(
      `@font-face{font-family:'${family}';src:url('/media/${font.key}') format('woff2');font-weight:100 900;font-display:swap}`,
    );
    expect(css).toContain(`--font-heading:'${family}','Swarm Archivo',`);
    expect(css).toContain('.t-fonts-marker');
    // Nothing from another server, and the owner's name for the font stays out.
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('Brand Sans');
    expect(home.headers.get('content-security-policy')).toMatch(/font-src 'self'(;|$)/);

    const file = await get(ch, `/media/${font.key}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    // For the dashboard, which draws the font's name from the media origin.
    expect(file.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves WOFF too, and keeps CORS off images', async () => {
    const ch = await seedChannel();
    await flagOn(ch);
    const font = await addFont(ch, 'woff');
    await publish(ch, { body_font: font.id });
    const { css } = await stylesheet(ch);
    expect(css).toContain(`src:url('/media/${font.key}') format('woff')`);
    expect(css).toContain(`--font:'${uploadedFontFamily(font.id)}',Charter,`);
    const file = await get(ch, `/media/${font.key}`);
    expect(file.headers.get('content-type')).toBe('font/woff');

    const image = `ws/${ch.workspaceId}/ch/${ch.channelId}/${newId('media')}.png`;
    await env.MEDIA.put(image, 'png', {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { visibility: 'public' },
    });
    expect(
      (await get(ch, `/media/${image}`)).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('falls back to the setting’s default for a deleted font, another Channel’s, or an image', async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    await flagOn(ch);
    const deleted = await addFont(ch);
    await env.DB.prepare('UPDATE media SET deleted_at = 1 WHERE id = ?1').bind(deleted.id).run();
    const theirs = await addFont(other);
    const picture = await addFont(ch, 'woff2', 'image/png');
    for (const id of [deleted.id, theirs.id, picture.id]) {
      await publish(ch, { heading_font: id });
      const { css } = await stylesheet(ch);
      expect(css, id).not.toContain('Swarm Upload');
      expect(css, id).not.toContain('/media/');
      expect(css, id).toContain("--font-heading:'Swarm Archivo',");
    }
  });

  it('shows the draft’s font in the preview', async () => {
    const ch = await seedChannel();
    await flagOn(ch);
    const font = await addFont(ch);
    await publish(ch, { heading_font: font.id });
    const { token } = await signSitePreview(testLinks(), {
      channelId: ch.channelId,
      as: 'visitor',
    });
    const res = await get(ch, `/_swarm/preview?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`src:url('/media/${font.key}') format('woff2')`);
    expect(res.headers.get('content-security-policy')).toContain("font-src 'self'");
  });
});
