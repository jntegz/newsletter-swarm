// Public media and its variants, made with the Cloudflare Images binding (IMAGES):
// - ?w=<width>: a resized copy (widths from WIDTHS), AVIF or WebP when the browser accepts it;
// - ?og=cover: a 1200×630 social card cropped around the image's focal point (?fx=&fy=, 0–100,
//   made in steps of FOCAL_STEP, so there are at most 121 crops of one image);
// - ?og=card&bg=<hex>: the image (a logo) centred on a 1200×630 card in the Channel's colour. The
//   colour made is always the owning Channel's current accent (cardBackground), whatever `bg` says,
//   so there is one card per image;
// - ?icon=<size>: a square PNG favicon or touch icon (sizes from ICON_SIZES).
// Variants are stored in the edge cache (caches.default) under a key on the media origin (never
// the request's host) that names the variant and output format, so each is made once per data
// centre, and the number of variants of one object is fixed whatever hosts or values are asked for. Without the binding (tests, local dev) or
// for a GIF or PDF, every URL serves the original, and pages link the original (render/seo.ts).
// Every object is public by design: see docs/security.md, "Media".
import { createLogger } from '@swarm/runtime';

const log = createLogger({ service: 'site' });

const WIDTHS = [160, 320, 480, 640, 960, 1280, 1600, 1920, 2560] as const;
export const ICON_SIZES = [16, 32, 48, 96, 180, 192, 512, 1024] as const;
export const OG_SIZE = { width: 1200, height: 630 } as const;

type Variant =
  | { kind: 'width'; width: number }
  | { kind: 'og'; fx: number; fy: number }
  | { kind: 'card'; background: string }
  | { kind: 'icon'; size: number };

const PERCENT = /^(?:100|[1-9]?\d)$/;
const HEX = /^[0-9a-f]{6}$/i;
/** Focal points are made in steps of this many percent. */
const FOCAL_STEP = 10;

/** A focal percentage on the FOCAL_STEP grid. */
export const focalStep = (n: number) =>
  Math.min(100, Math.max(0, Math.round(n / FOCAL_STEP) * FOCAL_STEP));

/** The card colour for a Channel's accent (as stored in branding): the accent, else white. */
export function cardBackground(accent: unknown): string {
  return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)
    ? accent.slice(1).toLowerCase()
    : 'ffffff';
}

/**
 * The variant a media URL asks for: null for the original, 'invalid' for a value outside the
 * allowed sizes (answered 404, so nobody can fill the cache with arbitrary sizes).
 */
export function parseVariant(params: URLSearchParams): Variant | null | 'invalid' {
  const w = params.get('w');
  const og = params.get('og');
  const icon = params.get('icon');
  if ([w, og, icon].filter((v) => v !== null).length > 1) return 'invalid';
  if (w !== null) {
    const width = Number(w);
    return (WIDTHS as readonly number[]).includes(width) ? { kind: 'width', width } : 'invalid';
  }
  if (icon !== null) {
    const size = Number(icon);
    return (ICON_SIZES as readonly number[]).includes(size) ? { kind: 'icon', size } : 'invalid';
  }
  if (og === 'cover') {
    const fx = params.get('fx') ?? '50';
    const fy = params.get('fy') ?? '50';
    if (!PERCENT.test(fx) || !PERCENT.test(fy)) return 'invalid';
    // Any value still works (links already shared keep their image), but only grid points are made.
    return { kind: 'og', fx: focalStep(Number(fx)), fy: focalStep(Number(fy)) };
  }
  if (og === 'card') {
    const bg = params.get('bg') ?? 'ffffff';
    return HEX.test(bg) ? { kind: 'card', background: bg.toLowerCase() } : 'invalid';
  }
  return og === null ? null : 'invalid';
}

/** The canonical query for a variant: the same variant always has the same URL. */
export function variantQuery(variant: Variant): string {
  switch (variant.kind) {
    case 'width':
      return `w=${variant.width}`;
    case 'og':
      return variant.fx === 50 && variant.fy === 50
        ? 'og=cover'
        : `og=cover&fx=${variant.fx}&fy=${variant.fy}`;
    case 'card':
      return `og=card&bg=${variant.background}`;
    case 'icon':
      return `icon=${variant.size}`;
  }
}

type OutputFormat = 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png';

/**
 * What a variant is encoded as. Social cards are JPEG (link previews rarely read AVIF or WebP),
 * icons PNG; a resized copy follows the browser's Accept header, else keeps the original type.
 */
function outputFormat(variant: Variant, accept: string, original: string): OutputFormat {
  if (variant.kind === 'icon') return 'image/png';
  if (variant.kind !== 'width') return 'image/jpeg';
  if (/image\/avif/i.test(accept)) return 'image/avif';
  if (/image\/webp/i.test(accept)) return 'image/webp';
  return original === 'image/png' ? 'image/png' : 'image/jpeg';
}

function transformOf(variant: Variant): ImageTransform {
  switch (variant.kind) {
    case 'width':
      return { width: variant.width, fit: 'scale-down' };
    case 'og':
      return {
        ...OG_SIZE,
        fit: 'cover',
        gravity: { x: variant.fx / 100, y: variant.fy / 100, mode: 'remainder' },
      };
    case 'card':
      return { ...OG_SIZE, fit: 'pad', background: `#${variant.background}` };
    case 'icon':
      return { width: variant.size, height: variant.size, fit: 'pad', background: '#00000000' };
  }
}

/** Raster types the binding transforms. GIFs keep their animation by being served as they are. */
const TRANSFORMABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

const mediaHeaders = (contentType: string, etag: string): Record<string, string> => ({
  'content-type': contentType,
  'cache-control': 'public, max-age=31536000, immutable',
  etag,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  // Fonts load in CORS mode. A site's own pages are the same origin and need nothing, but the
  // dashboard draws each uploaded font's name in its face from the media origin. Media is public.
  ...(contentType.startsWith('font/') ? { 'access-control-allow-origin': '*' } : {}),
});

interface MediaRequest {
  bucket: R2Bucket;
  images: ImagesBinding | undefined;
  key: string;
  variant: Variant | null;
  accept: string;
  /** The media origin (MEDIA_ORIGIN), for the edge cache key: never the request's host. */
  origin: string;
  waitUntil: (work: Promise<unknown>) => void;
  /** The edge cache; tests pass their own. */
  cache?: Cache | undefined;
}

/** A public object from the media bucket, or null when there is none (or it isn't public). */
async function publicObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  const object = await bucket.get(key);
  return object && object.customMetadata?.visibility === 'public' ? object : null;
}

const original = (object: R2ObjectBody) =>
  new Response(object.body, {
    headers: mediaHeaders(
      object.httpMetadata?.contentType ?? 'application/octet-stream',
      object.httpEtag,
    ),
  });

/** Serves an original or one of its variants. Null means 404. */
export async function serveMedia(input: MediaRequest): Promise<Response | null> {
  const { variant, images } = input;
  if (!variant || !images) {
    const object = await publicObject(input.bucket, input.key);
    return object ? original(object) : null;
  }
  const cache = input.cache ?? caches.default;
  // The format depends on Accept, so it is part of the key; Vary tells browsers the same.
  const head = await input.bucket.head(input.key);
  if (!head || head.customMetadata?.visibility !== 'public') return null;
  const type = head.httpMetadata?.contentType ?? '';
  if (!TRANSFORMABLE.has(type)) {
    const object = await publicObject(input.bucket, input.key);
    return object ? original(object) : null;
  }
  const format = outputFormat(variant, input.accept, type);
  const cacheKey = new Request(
    `${input.origin}/media/${input.key}?${variantQuery(variant)}&format=${encodeURIComponent(format)}&etag=${encodeURIComponent(head.etag)}`,
  );
  // The edge cache keys on the URL alone, so Vary is added on the way out, never stored.
  const vary = (response: Response) => {
    if (variant.kind !== 'width') return response;
    const headers = new Headers(response.headers);
    headers.set('vary', 'accept');
    return new Response(response.body, { status: response.status, headers });
  };
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return vary(hit);

  const object = await publicObject(input.bucket, input.key);
  if (!object) return null;
  let body: ReadableStream<Uint8Array>;
  try {
    const result = await images
      .input(object.body)
      .transform(transformOf(variant))
      .output({ format, quality: variant.kind === 'icon' ? 100 : 82 });
    body = result.image();
  } catch (error) {
    // A file the binding can't read still loads: the original instead of a broken image.
    log.warn('image variant failed', { key: input.key, error: (error as Error).message });
    const again = await publicObject(input.bucket, input.key);
    return again ? original(again) : null;
  }
  const tag = variantQuery(variant).replace(/[^a-z0-9]/gi, '');
  const response = new Response(body, {
    headers: mediaHeaders(format, `"${head.etag}-${tag}-${format.slice(6)}"`),
  });
  if (cache) input.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  return vary(response);
}

/** A media URL for a variant, or the original's URL when there is no binding to make it. */
export function variantUrl(url: string, variant: Variant, imagesOn: boolean): string {
  return imagesOn ? `${url}?${variantQuery(variant)}` : url;
}
