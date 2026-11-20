// A Dispatch on the site: its web rendering, gating and article markup. Pure functions (no
// request, no database), so tests can render any reader class directly.
//
// Gating:
// - A reader sees the gated part when the route says they are entitled (Phase 5: Gate levels,
//   meters, soft Gates and gift links, see money/access.ts), else when canReadFull(visibility,
//   reader class) holds, or when the request is a verified search crawler on a Channel that
//   exposes gated content. The gated part is
//   then wrapped in <div class="sw-gated">, which the Article JSON-LD's hasPart points at.
// - Otherwise the page shows the free part, then a gate panel (sign in, or subscribe).
// - A Member-only or paid Dispatch without a gate divider would otherwise be free in full, so it
//   gets an implicit divider: the free part is its first blocks, at most 3 and at most half of
//   them (a one-block Dispatch shows no body at all). The same preview is used everywhere the
//   Dispatch appears (cards, feeds, excerpts), so no surface shows more than the page does.
import { canReadFull, type ReaderClass } from '@swarm/domain';
import {
  RenderError,
  collectMediaIds,
  renderWeb,
  webMergeTags,
  webShare,
  type AskPollView,
  type WebImage,
  type WebMedia,
  type WebRendered,
} from '@swarm/mail';
import type { SiteChannel } from '../context';
import type { SiteDispatch } from './data';
import { gatePanel } from '../money/gate';
import { dispatchPath, h, time } from './html';
import { responsiveImage } from './image';
import { articleLd, type SeoImage } from './seo';

const GATED_SELECTOR = '.sw-gated';

/** The editor document as the site renders it: with an implicit gate where one is needed. */
export function webDocument(dispatch: Pick<SiteDispatch, 'contentJson' | 'visibility'>): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(dispatch.contentJson);
  } catch {
    return { type: 'doc', content: [] };
  }
  // Site search indexes the free part from the same split (searchBody in @swarm/engine).
  return webShare(doc, dispatch.visibility).document;
}

const EMPTY: WebRendered = {
  freeHtml: '',
  gatedHtml: '',
  hasGate: false,
  text: '',
  freeText: '',
  excerpt: '',
  readingMinutes: 1,
  firstImage: null,
  css: '',
  freePlayers: [],
  gatedPlayers: [],
  warnings: [],
};

/** The cover image is outside the document, so it shows even when the document can't render. */
type Renderable = Pick<SiteDispatch, 'contentJson' | 'visibility'> &
  Partial<Pick<SiteDispatch, 'coverMediaId' | 'coverAlt'>>;

export interface SiteRendered extends WebRendered {
  /** The cover image; null without one, or once its media item is gone. */
  cover: WebImage | null;
}

/** Media ids used by these Dispatches, for one lookup. */
export function dispatchMediaIds(
  dispatches: (Pick<SiteDispatch, 'contentJson'> & Partial<Pick<SiteDispatch, 'coverMediaId'>>)[],
): Set<string> {
  const ids = new Set<string>();
  for (const dispatch of dispatches) {
    if (dispatch.coverMediaId) ids.add(dispatch.coverMediaId);
    try {
      collectMediaIds(JSON.parse(dispatch.contentJson), ids);
    } catch {
      // An unreadable document renders empty below.
    }
  }
  return ids;
}

interface RenderContext {
  channelName: string;
  media: Map<string, WebMedia>;
  allowHtmlBlocks: boolean;
  /** Highlighted code and the table of contents block (the code_embeds flag). */
  codeEmbeds?: boolean;
  /** Poll blocks' questions, keyed `askId:questionId` (askBlocksFor in @swarm/engine). */
  polls?: Map<string, AskPollView>;
  /** Embeds can load their player: the Dispatch page only, never a feed or a preview. */
  players?: boolean;
}

const percentOf = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value * 100)))
    : 50;

/** The cover image of a Dispatch, with its alt text or else the media library's. */
function coverImage(dispatch: Renderable, context: RenderContext): WebImage | null {
  const media = dispatch.coverMediaId ? context.media.get(dispatch.coverMediaId) : undefined;
  if (!media) return null;
  return {
    url: media.url,
    alt: webMergeTags(dispatch.coverAlt?.trim() || media.alt?.trim() || '', context.channelName),
    width: media.width ?? null,
    height: media.height ?? null,
    objectPosition: `${percentOf(media.focalX)}% ${percentOf(media.focalY)}%`,
  };
}

/**
 * Renders a Dispatch for the web. A document the renderer refuses (it was valid when published)
 * renders empty rather than failing the page.
 */
export function renderDispatch(dispatch: Renderable, context: RenderContext): SiteRendered {
  const cover = coverImage(dispatch, context);
  let rendered = EMPTY;
  try {
    rendered = renderWeb(webDocument(dispatch), {
      channelName: context.channelName,
      media: (id) => context.media.get(id) ?? null,
      allowHtmlBlocks: context.allowHtmlBlocks,
      codeEmbeds: context.codeEmbeds === true,
      players: context.players === true,
      ask: (askId, questionId) => context.polls?.get(`${askId}:${questionId}`) ?? null,
    });
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
  }
  if (!cover) return { ...rendered, cover };
  const [x, y] = cover.objectPosition.split(' ').map((p) => Number.parseInt(p, 10));
  return {
    ...rendered,
    cover,
    // The same generated class the renderer uses for images in the document.
    css: `${rendered.css}.sw-fp-${x}-${y}{object-position:${x}% ${y}%}`,
  };
}

/** A short description for cards, meta tags and feeds: the subtitle, else the free excerpt. */
export const summaryOf = (dispatch: SiteDispatch, rendered: WebRendered) =>
  dispatch.preheader.trim() || rendered.excerpt;

export function visibilityBadge(visibility: SiteDispatch['visibility']): string {
  if (visibility === 'members') return '<span class="sw-badge">Subscribers</span>';
  if (visibility === 'paid') return '<span class="sw-badge">Paid</span>';
  return '';
}

/**
 * The social image: the cover image, else the Dispatch's first image when it is in the media
 * library, else a default.
 */
export function dispatchImage(
  rendered: SiteRendered,
  mediaOrigin: string,
  fallback: SeoImage | null,
): SeoImage | null {
  const first = rendered.cover ?? rendered.firstImage;
  if (first && first.url.startsWith(`${mediaOrigin.replace(/\/$/, '')}/`)) {
    const [x, y] = first.objectPosition.split(' ').map((p) => Number.parseFloat(p));
    return {
      url: first.url,
      alt: first.alt,
      width: first.width,
      height: first.height,
      focal: Number.isFinite(x) && Number.isFinite(y) ? [x!, y!] : null,
    };
  }
  return fallback;
}

interface ArticleInput {
  channel: SiteChannel;
  dispatch: SiteDispatch;
  rendered: SiteRendered;
  reader: ReaderClass;
  /** A verified search crawler on a Channel that exposes gated content. */
  crawlerFullAccess: boolean;
  /** The subscribe form markup for the gate panel. */
  subscribeForm: string;
  /** Overrides canReadFull: the route's decision (Gate levels, meter, soft Gate, gift link). */
  entitled?: boolean;
  /** The gate panel to show instead of the default one. */
  gate?: string;
  /** Shown above the Dispatch body (a metered read, a gift link). */
  notice?: string;
  /** Shown after the Dispatch body (the gift form). */
  after?: string;
  neighbours?: {
    older: { slug: string; subject: string } | null;
    newer: { slug: string; subject: string } | null;
  } | null;
  image: SeoImage | null;
  /** The Series this Dispatch is part of (flag post_series): "Part N of M" and the next part. */
  series?: SeriesPlace | null;
  /** The byline, linking to the author page (flag author_pages). */
  author?: { name: string; slug: string } | null;
  /** The Images binding is there, so the cover image can offer resized copies. */
  images?: boolean;
}

interface SeriesPlace {
  name: string;
  slug: string;
  /** 1-based, among the Series' Dispatches on the site. */
  part: number;
  total: number;
  next: { slug: string; subject: string } | null;
}

/** "Part N of M in <Series>" under the title, and a "Next in series" link at the end. */
function seriesNav(place: SeriesPlace): { head: string; foot: string } {
  const series = `<a href="/series/${h(place.slug)}">${h(place.name)}</a>`;
  return {
    head: `<p class="sw-series">Part ${place.part} of ${place.total} in ${series}</p>`,
    foot: place.next
      ? `<nav class="sw-series-next" aria-label="Series"><a href="${h(dispatchPath(place.next.slug))}" rel="next"><span>Next in series</span>${h(place.next.subject || 'Untitled post')}</a></nav>`
      : `<p class="sw-series-end">This is the latest part of ${series}.</p>`,
  };
}

interface ArticleOutput {
  html: string;
  /** The gated part is in the page. */
  showsGated: boolean;
  /** The gate panel (with its own subscribe form) is in the page. */
  showsGate: boolean;
  jsonLd: Record<string, unknown>;
}

function shareLinks(url: string, title: string): string {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  const links = [
    ['Email', `mailto:?subject=${t}&body=${u}`],
    ['X', `https://x.com/intent/post?text=${t}&url=${u}`],
    ['Bluesky', `https://bsky.app/intent/compose?text=${encodeURIComponent(`${title} ${url}`)}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
  ];
  return `<nav class="sw-share" aria-label="Share"><span>Share</span>${links
    .map(([label, href]) => `<a href="${h(href!)}" rel="noopener noreferrer">${label}</a>`)
    .join('')}</nav>`;
}

/** The <article> for a Dispatch page and its Article JSON-LD. */
export function dispatchArticle(input: ArticleInput): ArticleOutput {
  const { channel, dispatch, rendered } = input;
  const path = dispatchPath(dispatch.slug);
  const url = `${channel.origin}${path}`;
  const free = dispatch.visibility === 'public';
  const entitled =
    input.entitled ?? (canReadFull(dispatch.visibility, input.reader) || input.crawlerFullAccess);
  const showsGated = entitled && rendered.gatedHtml.length > 0;
  const showsGate = !entitled && rendered.hasGate;

  const parts = [
    // Outside the gated part: every reader gets the cover image, whatever they may read.
    rendered.cover
      ? `<figure class="sw-cover">${responsiveImage(rendered.cover, {
          eager: true,
          images: input.images === true,
          sizes: '(min-width: 760px) 720px, 100vw',
        })}</figure>`
      : '',
    `<header class="sw-article-head">`,
    `<h1>${h(dispatch.subject || 'Untitled post')}</h1>`,
    dispatch.preheader ? `<p class="sw-subtitle">${h(dispatch.preheader)}</p>` : '',
    input.author
      ? `<p class="sw-byline">By <a href="/authors/${h(input.author.slug)}" rel="author">${h(input.author.name)}</a></p>`
      : '',
    `<p class="sw-meta">${time(dispatch.publishedAt)}<span>${rendered.readingMinutes} min read</span>${visibilityBadge(dispatch.visibility)}</p>`,
    input.series ? seriesNav(input.series).head : '',
    `</header>`,
    input.notice ?? '',
    `<div class="sw-prose">${rendered.freeHtml}`,
    showsGated ? `<div class="${GATED_SELECTOR.slice(1)}">${rendered.gatedHtml}</div>` : '',
    `</div>`,
    showsGate
      ? (input.gate ??
        gatePanel({
          channelName: channel.name,
          visibility: dispatch.visibility === 'paid' ? 'paid' : 'members',
          reader: input.reader,
          path,
          subscribeForm: input.subscribeForm,
        }))
      : '',
    showsGated ? (input.after ?? '') : '',
    input.series ? seriesNav(input.series).foot : '',
    shareLinks(url, dispatch.subject),
  ];
  const n = input.neighbours;
  if (n && (n.older || n.newer)) {
    parts.push(
      `<nav class="sw-prevnext" aria-label="More posts">`,
      n.older
        ? `<a class="sw-prev" href="${h(dispatchPath(n.older.slug))}" rel="prev"><span>Previous</span>${h(n.older.subject)}</a>`
        : '',
      n.newer
        ? `<a class="sw-next" href="${h(dispatchPath(n.newer.slug))}" rel="next"><span>Next</span>${h(n.newer.subject)}</a>`
        : '',
      `</nav>`,
    );
  }

  return {
    html: `<article class="sw-article">${parts.filter(Boolean).join('\n')}</article>`,
    showsGated,
    showsGate,
    jsonLd: articleLd(channel, {
      headline: dispatch.subject || 'Untitled post',
      description: dispatch.preheader.trim() || rendered.excerpt,
      path,
      publishedAt: dispatch.publishedAt,
      modifiedAt: dispatch.updatedAt,
      image: input.image,
      free,
      gatedSelector: showsGated ? GATED_SELECTOR : null,
      author: input.author
        ? { name: input.author.name, path: `/authors/${input.author.slug}` }
        : null,
    }),
  };
}
