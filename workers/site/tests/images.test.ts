// Media variants through the Images binding (edge/images.ts): sizes are a fixed list, the format
// follows Accept, variants are made once and kept in the edge cache, and without a binding every
// URL serves the original. The OG card and favicon links come from the same module.
import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import type { SiteChannel } from '../src/context';
import { cardBackground, parseVariant, serveMedia, variantQuery } from '../src/edge/images';
import { headMeta, iconLinks, socialImage, type SeoImage } from '../src/render/seo';
import { seedChannel } from './helpers';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const mediaKey = (ext = 'png') => `ws/ws_${hex()}/ch/ch_${hex()}/md_${hex()}.${ext}`;

async function putMedia(key: string, type: string, visibility = 'public') {
  await env.MEDIA.put(key, `bytes of ${key}`, {
    httpMetadata: { contentType: type },
    customMetadata: { visibility },
  });
}

/** A stand-in for the Images binding that records each transform. */
function fakeImages(fail = false) {
  const calls: { transform: ImageTransform; format: string }[] = [];
  const binding = {
    input(stream: ReadableStream<Uint8Array>) {
      void stream.cancel();
      let transform: ImageTransform = {};
      const handle = {
        transform(t: ImageTransform) {
          transform = t;
          return handle;
        },
        async output(options: ImageOutputOptions) {
          if (fail) throw new Error('9412: not an image');
          calls.push({ transform, format: options.format });
          const bytes = new TextEncoder().encode(`${options.format} ${JSON.stringify(transform)}`);
          return {
            contentType: () => options.format,
            image: () => new Response(bytes).body!,
            response: () => new Response(bytes),
          };
        },
      };
      return handle;
    },
  };
  return { binding: binding as unknown as ImagesBinding, calls };
}

/** The body as text, without the runtime's warning about reading an image as text. */
const bytesOf = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

function memoryCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response);
    },
  };
  return { cache: cache as unknown as Cache, store };
}

async function variant(
  key: string,
  query: string,
  options: { images?: ImagesBinding; cache?: Cache; accept?: string } = {},
) {
  const parsed = parseVariant(new URLSearchParams(query));
  if (parsed === 'invalid') throw new Error('invalid variant');
  const pending: Promise<unknown>[] = [];
  const res = await serveMedia({
    bucket: env.MEDIA,
    images: options.images,
    key,
    variant: parsed,
    accept: options.accept ?? 'image/avif,image/webp,*/*',
    origin: 'http://localhost',
    waitUntil: (work) => pending.push(work),
    cache: options.cache,
  });
  await Promise.all(pending);
  return res;
}

describe('media variants', () => {
  it('accepts only the listed sizes and one variant at a time', () => {
    expect(parseVariant(new URLSearchParams(''))).toBeNull();
    expect(parseVariant(new URLSearchParams('w=640'))).toEqual({ kind: 'width', width: 640 });
    expect(parseVariant(new URLSearchParams('w=641'))).toBe('invalid');
    expect(parseVariant(new URLSearchParams('icon=180'))).toEqual({ kind: 'icon', size: 180 });
    expect(parseVariant(new URLSearchParams('icon=17'))).toBe('invalid');
    expect(parseVariant(new URLSearchParams('og=cover&fx=20&fy=80'))).toEqual({
      kind: 'og',
      fx: 20,
      fy: 80,
    });
    expect(parseVariant(new URLSearchParams('og=cover&fx=101'))).toBe('invalid');
    expect(parseVariant(new URLSearchParams('og=card&bg=0A7D5A'))).toEqual({
      kind: 'card',
      background: '0a7d5a',
    });
    expect(parseVariant(new URLSearchParams('og=card&bg=red'))).toBe('invalid');
    expect(parseVariant(new URLSearchParams('og=other'))).toBe('invalid');
    expect(parseVariant(new URLSearchParams('w=640&icon=32'))).toBe('invalid');
    expect(variantQuery({ kind: 'og', fx: 50, fy: 50 })).toBe('og=cover');
  });

  it('resizes to AVIF or WebP by Accept, keeps it in the edge cache, and says Vary: Accept', async () => {
    const key = mediaKey();
    await putMedia(key, 'image/png');
    const images = fakeImages();
    const { cache, store } = memoryCache();
    const avif = (await variant(key, 'w=640', { images: images.binding, cache }))!;
    expect(avif.status).toBe(200);
    expect(avif.headers.get('content-type')).toBe('image/avif');
    expect(avif.headers.get('vary')).toBe('accept');
    expect(avif.headers.get('content-security-policy')).toContain('sandbox');
    expect(images.calls).toEqual([
      { transform: { width: 640, fit: 'scale-down' }, format: 'image/avif' },
    ]);

    const again = (await variant(key, 'w=640', { images: images.binding, cache }))!;
    expect(await bytesOf(again)).toContain('image/avif');
    expect(images.calls).toHaveLength(1);

    const webp = (await variant(key, 'w=640', {
      images: images.binding,
      cache,
      accept: 'image/webp',
    }))!;
    expect(webp.headers.get('content-type')).toBe('image/webp');
    const plain = (await variant(key, 'w=640', { images: images.binding, cache, accept: '*/*' }))!;
    expect(plain.headers.get('content-type')).toBe('image/png');
    expect(store.size).toBe(3);
    for (const stored of store.values()) expect(stored.headers.get('vary')).toBeNull();
  });

  it('makes 1200×630 OG cards and square PNG icons', async () => {
    const key = mediaKey('jpg');
    await putMedia(key, 'image/jpeg');
    const images = fakeImages();
    const og = (await variant(key, 'og=cover&fx=20&fy=80', { images: images.binding }))!;
    expect(og.headers.get('content-type')).toBe('image/jpeg');
    expect(og.headers.get('vary')).toBeNull();
    const card = (await variant(key, 'og=card&bg=0a7d5a', { images: images.binding }))!;
    expect(card.headers.get('content-type')).toBe('image/jpeg');
    const icon = (await variant(key, 'icon=32', { images: images.binding }))!;
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect(images.calls.map((c) => c.transform)).toEqual([
      {
        width: 1200,
        height: 630,
        fit: 'cover',
        gravity: { x: 0.2, y: 0.8, mode: 'remainder' },
      },
      { width: 1200, height: 630, fit: 'pad', background: '#0a7d5a' },
      { width: 32, height: 32, fit: 'pad', background: '#00000000' },
    ]);
  });

  it('serves the original without a binding, for GIFs and PDFs, and when the binding fails', async () => {
    const key = mediaKey();
    await putMedia(key, 'image/png');
    const plain = (await variant(key, 'w=640'))!;
    expect(plain.headers.get('content-type')).toBe('image/png');
    expect(await bytesOf(plain)).toBe(`bytes of ${key}`);

    const gif = mediaKey('gif');
    await putMedia(gif, 'image/gif');
    const images = fakeImages();
    expect(await bytesOf((await variant(gif, 'w=320', { images: images.binding }))!)).toBe(
      `bytes of ${gif}`,
    );
    expect(images.calls).toHaveLength(0);

    const broken = fakeImages(true);
    expect(await bytesOf((await variant(key, 'w=320', { images: broken.binding }))!)).toBe(
      `bytes of ${key}`,
    );
  });

  it('never makes a variant of a private object', async () => {
    const key = mediaKey();
    await putMedia(key, 'image/png', 'private');
    const images = fakeImages();
    expect(await variant(key, 'w=640', { images: images.binding })).toBeNull();
    expect(images.calls).toHaveLength(0);
  });

  it('answers 404 for sizes outside the list, and the original in tests (no binding)', async () => {
    const key = mediaKey();
    await putMedia(key, 'image/png');
    const ok = await SELF.fetch(`http://localhost/media/${key}?w=640`);
    expect(ok.status).toBe(200);
    expect(await bytesOf(ok)).toBe(`bytes of ${key}`);
    expect((await SELF.fetch(`http://localhost/media/${key}?w=650`)).status).toBe(404);
    expect((await SELF.fetch(`http://localhost/media/${key}?icon=5000`)).status).toBe(404);
  });
});

describe('OG cards and favicons', () => {
  const channel = {
    name: 'Field Notes',
    origin: 'https://notes.swarm.page',
    branding: { accentColor: '#0A7D5A' },
    settings: { seo: {} },
  } as unknown as SiteChannel;
  const logo: SeoImage = {
    url: 'https://media.example/media/logo.png',
    alt: 'Field Notes',
    width: 400,
    height: 400,
  };
  const hero: SeoImage = {
    url: 'https://media.example/media/hero.jpg',
    alt: 'A fox',
    width: 2000,
    height: 1500,
    focal: [30, 60],
  };

  it('crops the page image around its focal point, or puts the logo on a card', () => {
    expect(socialImage(channel, hero, logo, true)).toEqual({
      url: 'https://media.example/media/hero.jpg?og=cover&fx=30&fy=60',
      alt: 'A fox',
      width: 1200,
      height: 630,
    });
    expect(socialImage(channel, null, logo, true)).toEqual({
      url: 'https://media.example/media/logo.png?og=card&bg=0a7d5a',
      alt: 'Field Notes',
      width: 1200,
      height: 630,
    });
    // Without the binding: the image as uploaded, and no card.
    expect(socialImage(channel, hero, logo, false)).toBe(hero);
    expect(socialImage(channel, null, logo, false)).toBeNull();
  });

  it('links every favicon size from 16 to 1024 px and a 180 px touch icon', () => {
    const links = iconLinks(logo, true).join('\n');
    for (const size of [16, 32, 48, 96, 192, 512, 1024]) {
      expect(links).toContain(
        `<link rel="icon" type="image/png" sizes="${size}x${size}" href="${logo.url}?icon=${size}">`,
      );
    }
    expect(links).toContain(
      `<link rel="apple-touch-icon" sizes="180x180" href="${logo.url}?icon=180">`,
    );
    expect(iconLinks(logo, false)).toEqual([
      `<link rel="icon" href="${logo.url}">`,
      `<link rel="apple-touch-icon" href="${logo.url}">`,
    ]);
  });

  it('puts the card in og:image and twitter:image', () => {
    const html = headMeta(
      channel,
      { title: 'Hello', description: 'Hi', path: '/p/hello', image: hero },
      logo,
      'Hello',
      true,
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://media.example/media/hero.jpg?og=cover&amp;fx=30&amp;fy=60">',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });
});

describe('which host serves an object, and which objects', () => {
  /** An uploaded object of `channel`, with its media row. */
  async function upload(
    channel: { workspaceId: string; channelId: string },
    ext: string,
    type: string,
  ) {
    const mediaId = newId('media');
    const key = `ws/${channel.workspaceId}/ch/${channel.channelId}/${mediaId}.${ext}`;
    await putMedia(key, type);
    await env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 10, ?6)`,
    )
      .bind(mediaId, channel.workspaceId, channel.channelId, key, type, Date.now())
      .run();
    return { mediaId, key };
  }

  it('serves a Channel’s object on the media host and its own site, not another tenant’s', async () => {
    const ours = await seedChannel();
    const theirs = await seedChannel();
    const { key } = await upload(ours, 'png', 'image/png');
    expect((await SELF.fetch(`http://localhost/media/${key}`)).status).toBe(200);
    expect((await SELF.fetch(`${ours.origin}/media/${key}`)).status).toBe(200);
    // Another publication's name is never lent to this file.
    expect((await SELF.fetch(`${theirs.origin}/media/${key}`)).status).toBe(404);
    expect((await SELF.fetch(`http://unknown.example/media/${key}`)).status).toBe(404);
  });

  it('never serves a PDF sold as a Good from its public URL', async () => {
    const ch = await seedChannel();
    const free = await upload(ch, 'pdf', 'application/pdf');
    expect((await SELF.fetch(`http://localhost/media/${free.key}`)).status).toBe(200);

    const sold = await upload(ch, 'pdf', 'application/pdf');
    const goodId = newId('good');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO goods (id, channel_id, slug, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Field guide', ?4, ?4)`,
      ).bind(goodId, ch.channelId, `guide-${goodId.slice(-6)}`, now),
      env.DB.prepare(
        `INSERT INTO good_files (id, good_id, media_id, name) VALUES (?1, ?2, ?3, 'guide.pdf')`,
      ).bind(newId('goodFile'), goodId, sold.mediaId),
    ]);
    expect((await SELF.fetch(`http://localhost/media/${sold.key}`)).status).toBe(404);
    expect((await SELF.fetch(`${ch.origin}/media/${sold.key}`)).status).toBe(404);
  });

  it('makes a small, fixed set of variants: focal points on a grid, the Channel’s own card colour', () => {
    expect(parseVariant(new URLSearchParams('og=cover&fx=31&fy=79'))).toEqual({
      kind: 'og',
      fx: 30,
      fy: 80,
    });
    const crops = new Set<string>();
    for (let fx = 0; fx <= 100; fx++) {
      for (let fy = 0; fy <= 100; fy++) {
        const v = parseVariant(new URLSearchParams(`og=cover&fx=${fx}&fy=${fy}`));
        if (v !== 'invalid' && v !== null) crops.add(variantQuery(v));
      }
    }
    expect(crops.size).toBe(121);
    expect(cardBackground('#0A7D5A')).toBe('0a7d5a');
    expect(cardBackground('red')).toBe('ffffff');
  });
});
