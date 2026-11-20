// Uploaded fonts (docs/site-themes.md, "Uploaded fonts"): WOFF2 and WOFF in the media library,
// identified by their bytes, and usable as a design's font by media id.
import { env } from 'cloudflare:test';
import type { MediaAsset, SiteDesign, SiteDesignSaved } from '@swarm/domain';
import { standardSettings } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import { setUploadScanner } from '../src/lib/scan';
import { call, createChannel, json, pngBytes, signIn, uploadForm } from './helpers';

/** A file that starts like a WOFF2 or WOFF font and whose header gives its own length. */
function fontBytes(signature: 'wOF2' | 'wOFF', size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(signature));
  bytes.set(new TextEncoder().encode('OTTO'), 4);
  new DataView(bytes.buffer).setUint32(8, size);
  return bytes;
}

const upload = (channelId: string, cookie: string, form: FormData) =>
  call('POST', `/api/v1/channels/${channelId}/media`, { cookie, form });

describe('font uploads', () => {
  it('takes WOFF2 and WOFF by their bytes, whatever they are called', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const woff2 = uploadForm(fontBytes('wOF2'), 'brand.png', 'image/png');
    woff2.set('alt', 'Brand Sans');
    const res = await upload(id, owner.cookie, woff2);
    expect(res.status, await res.clone().text()).toBe(201);
    const { data } = await json<{ data: MediaAsset }>(res);
    expect(data).toMatchObject({ contentType: 'font/woff2', kind: 'font', altText: 'Brand Sans' });
    expect(data.url).toMatch(
      /\/media\/ws\/ws_[0-9a-f]{32}\/ch\/ch_[0-9a-f]{32}\/md_[0-9a-f]{32}\.woff2$/,
    );
    const stored = await env.MEDIA.head(data.url.split('/media/')[1]!);
    expect(stored?.httpMetadata?.contentType).toBe('font/woff2');
    expect(stored?.customMetadata?.visibility).toBe('public');

    const woff = await upload(id, owner.cookie, uploadForm(fontBytes('wOFF'), 'x.bin', 'x/y'));
    expect(woff.status).toBe(201);
    expect((await json<{ data: MediaAsset }>(woff)).data).toMatchObject({
      contentType: 'font/woff',
      kind: 'font',
    });
  });

  it('refuses fonts over 2 MB, a lying header and other font formats, naming fonts', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const big = await upload(id, owner.cookie, uploadForm(fontBytes('wOF2', 2 * 1024 * 1024 + 1)));
    expect(big.status).toBe(400);
    expect((await json<{ error: { message: string } }>(big)).error.message).toBe(
      'Fonts can be up to 2 MB.',
    );
    const lying = fontBytes('wOF2', 64);
    new DataView(lying.buffer).setUint32(8, 1000);
    const ttf = new Uint8Array(64);
    ttf.set([0x00, 0x01, 0x00, 0x00]);
    for (const bytes of [lying, ttf, new TextEncoder().encode('wOF2')]) {
      const res = await upload(id, owner.cookie, uploadForm(bytes, 'font.woff2', 'font/woff2'));
      expect(res.status).toBe(415);
      expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
        /WOFF2 or WOFF font/,
      );
    }
  });

  it('sends fonts through the upload scan like any file', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const seen: string[] = [];
    setUploadScanner(async (_bytes, type) => {
      seen.push(type);
      return { clean: type !== 'font/woff' };
    });
    try {
      expect((await upload(id, owner.cookie, uploadForm(fontBytes('wOF2')))).status).toBe(201);
      expect((await upload(id, owner.cookie, uploadForm(fontBytes('wOFF')))).status).toBe(400);
    } finally {
      setUploadScanner(async () => ({ clean: true }));
    }
    expect(seen).toEqual(['font/woff2', 'font/woff']);
  });

  it('lists fonts on their own, apart from images and other files', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    await upload(id, owner.cookie, uploadForm(pngBytes()));
    await upload(id, owner.cookie, uploadForm(fontBytes('wOF2')));
    await upload(id, owner.cookie, uploadForm(new TextEncoder().encode('%PDF-1.4 x'), 'a.pdf'));
    const kinds = async (kind?: string) =>
      (
        await json<{ data: MediaAsset[] }>(
          await call('GET', `/api/v1/channels/${id}/media${kind ? `?kind=${kind}` : ''}`, {
            cookie: owner.cookie,
          }),
        )
      ).data
        .map((m) => m.kind)
        .sort();
    expect(await kinds()).toEqual(['file', 'font', 'image']);
    expect(await kinds('font')).toEqual(['font']);
    expect(await kinds('image')).toEqual(['image']);
    expect(await kinds('file')).toEqual(['file']);
  });
});

describe('a design with an uploaded font', () => {
  it('saves a media id in a font setting, and still refuses a made-up font', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
    )
      .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channel.id)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${channel.id}`);
    const font = (
      await json<{ data: MediaAsset }>(
        await upload(channel.id, owner.cookie, uploadForm(fontBytes('wOF2'))),
      )
    ).data;
    const design = (heading: string): SiteDesign => ({
      theme: 'launch',
      files: {
        'theme.json': JSON.stringify({ name: 'Own', settings: standardSettings(), sections: [] }),
        'sections/hero.html': `<section><h1>{{ site.name }}</h1>{% subscribe_form %}</section>
{% schema %}{"name":"Hero","settings":[]}{% endschema %}`,
      },
      settings: { heading_font: heading },
      sections: [{ id: 'h', type: 'hero', settings: {} }],
    });
    const save = (body: SiteDesign) =>
      call('PUT', `/api/v1/channels/${channel.id}/site/design/draft`, {
        cookie: owner.cookie,
        body,
      });
    const ok = await save(design(font.id));
    expect(ok.status, await ok.clone().text()).toBe(200);
    const saved = (await json<{ data: SiteDesignSaved }>(ok)).data;
    expect(saved.draft.settings.heading_font).toBe(font.id);
    expect(saved.problems.filter((p) => p.message.includes('Headings'))).toEqual([]);

    const bad = (await json<{ data: SiteDesignSaved }>(await save(design('comic-sans')))).data;
    expect(bad.problems.some((p) => /Headings: choose one of/.test(p.message))).toBe(true);
  });
});
