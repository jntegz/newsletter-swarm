// Head metadata and structured data: canonical URL, Open Graph and Twitter cards, verification
// tokens, feed discovery, favicons and JSON-LD (WebSite with SearchAction, Organization, Article).
import { textOn } from '@swarm/domain';
import { scriptJson } from '@swarm/engine';
import type { SiteChannel } from '../context';
import { ICON_SIZES, OG_SIZE, cardBackground, focalStep, variantUrl } from '../edge/images';
import { absolute, accentOf, h } from './html';

export interface SeoImage {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** Focal point in percent ([x, y]), for the social card crop. */
  focal?: [number, number] | null;
}

/**
 * The og:image for a page. With the Images binding: the page's image cropped to 1200×630 around
 * its focal point, else the logo centred on a card in the Channel's colour. Without it: the page's
 * image as uploaded, and no card.
 */
export function socialImage(
  channel: SiteChannel,
  image: SeoImage | null | undefined,
  logo: SeoImage | null,
  imagesOn: boolean,
): SeoImage | null {
  if (!imagesOn) return image ?? null;
  if (image) {
    const [fx, fy] = image.focal ?? [50, 50];
    return {
      url: variantUrl(image.url, { kind: 'og', fx: focalStep(fx), fy: focalStep(fy) }, true),
      alt: image.alt,
      ...OG_SIZE,
    };
  }
  if (!logo) return null;
  const background = cardBackground(channel.branding.accentColor);
  return {
    url: variantUrl(logo.url, { kind: 'card', background }, true),
    alt: channel.name,
    ...OG_SIZE,
  };
}

/**
 * A tab icon for a Channel without a logo: its initial on the accent colour, as an SVG in a data:
 * URL, so nothing is requested and the browser doesn't ask for a /favicon.ico that isn't there.
 */
function initialIcon(channel: SiteChannel): string {
  const accent = accentOf(channel);
  const initial = [...channel.name.trim()][0]?.toUpperCase() ?? '';
  // Only a letter or digit is drawn; anything else (an emoji, a symbol) leaves a plain tile.
  const glyph = /^[\p{L}\p{N}]$/u.test(initial) ? initial : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${accent}"/><text x="32" y="33" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="${textOn(accent)}" text-anchor="middle" dominant-baseline="central">${glyph}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Favicon and touch icon links: every size from the logo with the binding, else the logo. */
export function iconLinks(
  logo: SeoImage | null,
  imagesOn: boolean,
  channel?: SiteChannel,
): string[] {
  if (!logo) return channel ? [`<link rel="icon" href="${h(initialIcon(channel))}">`] : [];
  if (!imagesOn) {
    return [
      `<link rel="icon" href="${h(logo.url)}">`,
      `<link rel="apple-touch-icon" href="${h(logo.url)}">`,
    ];
  }
  const icon = (size: number) => h(variantUrl(logo.url, { kind: 'icon', size }, true));
  return [
    ...ICON_SIZES.filter((size) => size !== 180).map(
      (size) => `<link rel="icon" type="image/png" sizes="${size}x${size}" href="${icon(size)}">`,
    ),
    `<link rel="apple-touch-icon" sizes="180x180" href="${icon(180)}">`,
  ];
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path on the canonical origin, with any query that identifies the page (e.g. ?page=2). */
  path: string;
  type?: 'website' | 'article' | 'profile';
  image?: SeoImage | null;
  noindex?: boolean;
  publishedAt?: number;
  modifiedAt?: number;
}

/** A verification token is a short opaque value; anything else is ignored. */
const TOKEN = /^[A-Za-z0-9_\-.=]{1,120}$/;
const VERIFICATION_META: Record<string, string> = {
  google: 'google-site-verification',
  bing: 'msvalidate.01',
};

export function headMeta(
  channel: SiteChannel,
  meta: PageMeta,
  logo: SeoImage | null,
  pageTitle: string,
  imagesOn = false,
): string {
  const url = absolute(channel, meta.path);
  const image = socialImage(channel, meta.image, logo, imagesOn);
  const description = meta.description.slice(0, 300);
  const tags = [
    `<meta name="description" content="${h(description)}">`,
    `<link rel="canonical" href="${h(url)}">`,
    meta.noindex ? '<meta name="robots" content="noindex">' : '',
    `<meta property="og:site_name" content="${h(channel.name)}">`,
    `<meta property="og:type" content="${meta.type ?? 'website'}">`,
    `<meta property="og:title" content="${h(meta.title)}">`,
    `<meta property="og:description" content="${h(description)}">`,
    `<meta property="og:url" content="${h(url)}">`,
    '<meta property="og:locale" content="en_US">',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${h(meta.title)}">`,
    `<meta name="twitter:description" content="${h(description)}">`,
  ];
  if (image) {
    tags.push(
      `<meta property="og:image" content="${h(image.url)}">`,
      image.alt ? `<meta property="og:image:alt" content="${h(image.alt)}">` : '',
      image.width ? `<meta property="og:image:width" content="${image.width}">` : '',
      image.height ? `<meta property="og:image:height" content="${image.height}">` : '',
      `<meta name="twitter:image" content="${h(image.url)}">`,
    );
  }
  if (meta.type === 'article' && meta.publishedAt) {
    tags.push(
      `<meta property="article:published_time" content="${new Date(meta.publishedAt).toISOString()}">`,
    );
    if (meta.modifiedAt) {
      tags.push(
        `<meta property="article:modified_time" content="${new Date(meta.modifiedAt).toISOString()}">`,
      );
    }
  }
  for (const [engine, token] of Object.entries(channel.settings.seo.verification ?? {})) {
    const name = VERIFICATION_META[engine];
    if (name && typeof token === 'string' && TOKEN.test(token)) {
      tags.push(`<meta name="${name}" content="${h(token)}">`);
    }
  }
  tags.push(...iconLinks(logo, imagesOn, channel));
  tags.push(
    `<link rel="alternate" type="application/rss+xml" title="${h(channel.name)}" href="${h(absolute(channel, '/feed'))}">`,
    `<link rel="alternate" type="application/feed+json" title="${h(channel.name)}" href="${h(absolute(channel, '/feed.json'))}">`,
    `<title>${h(pageTitle)}</title>`,
  );
  return tags.filter(Boolean).join('\n');
}

type Json = Record<string, unknown>;

const orgId = (channel: SiteChannel) => `${channel.origin}/#organization`;
const siteId = (channel: SiteChannel) => `${channel.origin}/#website`;

export function websiteLd(channel: SiteChannel): Json {
  return {
    '@type': 'WebSite',
    '@id': siteId(channel),
    url: `${channel.origin}/`,
    name: channel.name,
    ...(channel.description ? { description: channel.description } : {}),
    publisher: { '@id': orgId(channel) },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${channel.origin}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function organizationLd(channel: SiteChannel, logo: SeoImage | null): Json {
  const sameAs = (channel.settings.seo.sameAs ?? []).filter(
    (u) => typeof u === 'string' && u.startsWith('https://'),
  );
  return {
    '@type': 'Organization',
    '@id': orgId(channel),
    name: channel.name,
    url: `${channel.origin}/`,
    ...(logo ? { logo: { '@type': 'ImageObject', url: logo.url } } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

interface ArticleLdInput {
  headline: string;
  description: string;
  path: string;
  publishedAt: number;
  modifiedAt: number;
  image: SeoImage | null;
  /** False for Member-only and paid Dispatches. */
  free: boolean;
  /** The selector of the gated region, when the page carries it. */
  gatedSelector: string | null;
  /** The byline's author page (flag author_pages); else the Channel is the author. */
  author?: { name: string; path: string } | null;
}

export function articleLd(channel: SiteChannel, input: ArticleLdInput): Json {
  const url = absolute(channel, input.path);
  return {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: input.headline.slice(0, 110),
    ...(input.description ? { description: input.description } : {}),
    url,
    mainEntityOfPage: url,
    datePublished: new Date(input.publishedAt).toISOString(),
    dateModified: new Date(Math.max(input.modifiedAt, input.publishedAt)).toISOString(),
    author: input.author
      ? { '@type': 'Person', name: input.author.name, url: absolute(channel, input.author.path) }
      : { '@id': orgId(channel) },
    publisher: { '@id': orgId(channel) },
    isPartOf: { '@id': siteId(channel) },
    ...(input.image ? { image: [input.image.url] } : {}),
    isAccessibleForFree: input.free,
    ...(!input.free && input.gatedSelector
      ? {
          hasPart: {
            '@type': 'WebPageElement',
            isAccessibleForFree: false,
            cssSelector: input.gatedSelector,
          },
        }
      : {}),
  };
}

/** One JSON-LD block with a @graph; safe inside a script element. */
export function jsonLdScript(nodes: Json[], nonce: string): string {
  const graph = { '@context': 'https://schema.org', '@graph': nodes };
  return `<script type="application/ld+json" nonce="${h(nonce)}">${scriptJson(graph)}</script>`;
}
