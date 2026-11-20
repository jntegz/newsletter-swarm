// Listing components: Dispatch cards and rows, the two home page layouts and pagination. Cards
// only ever show the free part of a Dispatch (its subtitle, excerpt and first free image).
import type { WebImage } from '@swarm/mail';
import type { SiteContext } from '../context';
import { mediaMap, siteFlags, type SiteDispatch } from './data';
import {
  dispatchMediaIds,
  renderDispatch,
  summaryOf,
  visibilityBadge,
  type SiteRendered,
} from './dispatch';
import { dispatchPath, h, time } from './html';
import { responsiveImage } from './image';

export interface Preview {
  dispatch: SiteDispatch;
  rendered: SiteRendered;
  summary: string;
  image: WebImage | null;
  /** The Images binding is there, so card images can offer resized copies. */
  images: boolean;
}

/** Renders the free part of each Dispatch for listing, with one media lookup. */
export async function previews(c: SiteContext, dispatches: SiteDispatch[]): Promise<Preview[]> {
  if (dispatches.length === 0) return [];
  const env = c.get('env');
  const channel = c.get('channel');
  const [media, flags] = await Promise.all([
    mediaMap(env, channel.workspaceId, dispatchMediaIds(dispatches)),
    siteFlags(c),
  ]);
  return dispatches.map((dispatch) => {
    const rendered = renderDispatch(dispatch, {
      channelName: channel.name,
      media,
      allowHtmlBlocks: flags.raw_html_mode,
      codeEmbeds: flags.code_embeds,
    });
    return {
      dispatch,
      rendered,
      summary: summaryOf(dispatch, rendered),
      // A writer who moves their lead image to the cover keeps it on the card.
      image: rendered.cover ?? rendered.firstImage,
      images: !!env.IMAGES,
    };
  });
}

/** Focal-point rules for the images the previews show. */
export const previewCss = (items: Preview[]) => items.map((p) => p.rendered.css).join('');

function img(image: WebImage | null, eager = false, images = false): string {
  if (!image) return '';
  return responsiveImage(image, { eager, images, sizes: '(min-width: 960px) 33vw, 100vw' });
}

const meta = (p: Preview) =>
  `<p class="sw-meta">${time(p.dispatch.publishedAt)}<span>${p.rendered.readingMinutes} min read</span>${visibilityBadge(p.dispatch.visibility)}</p>`;

const link = (p: Preview) =>
  `<a href="${h(dispatchPath(p.dispatch.slug))}">${h(p.dispatch.subject || 'Untitled post')}</a>`;

export function card(p: Preview, level: 2 | 3 = 2, eager = false): string {
  return `<article class="sw-card">${img(p.image, eager, p.images)}<div class="sw-card-body"><h${level}>${link(p)}</h${level}>${p.summary ? `<p>${h(p.summary)}</p>` : ''}${meta(p)}</div></article>`;
}

export function row(p: Preview, level: 2 | 3 = 2): string {
  return `<li><h${level}>${link(p)}</h${level}>${p.summary ? `<p>${h(p.summary)}</p>` : ''}${meta(p)}</li>`;
}

export const list = (items: Preview[], level: 2 | 3 = 2) =>
  items.length ? `<ul class="sw-list">${items.map((p) => row(p, level)).join('')}</ul>` : '';

const cards = (items: Preview[], level: 2 | 3 = 2) =>
  items.length
    ? `<ul class="sw-cards">${items.map((p) => `<li>${card(p, level)}</li>`).join('')}</ul>`
    : '';

/**
 * Magazine: a wide hero card, then a grid of cards. Pinned Dispatches come first, so the first
 * pin is the hero; without pins it is the newest Dispatch.
 */
export function magazine(pinned: Preview[], latest: Preview[]): string {
  const [lead, ...rest] = [...pinned, ...latest];
  return [
    lead ? `<div class="sw-hero">${card(lead, 2, true)}</div>` : '',
    rest.length
      ? `<section aria-labelledby="sw-latest"><h2 class="sw-section-title" id="sw-latest">${pinned.length > 1 ? 'More to read' : 'Latest'}</h2>${cards(rest, 3)}</section>`
      : '',
  ].join('\n');
}

/** Newspaper: a lead story with a column of headlines beside it, then a dense list. */
export function newspaper(pinned: Preview[], latest: Preview[]): string {
  const [lead, ...rest] = [...pinned, ...latest];
  if (!lead) return '';
  const side = rest.slice(0, 5);
  const more = rest.slice(5);
  return `<div class="sw-paper">
<article class="sw-paper-lead">${img(lead.image, true, lead.images)}<h2>${link(lead)}</h2>${lead.summary ? `<p>${h(lead.summary)}</p>` : ''}${meta(lead)}</article>
<aside class="sw-paper-side" aria-label="More posts">${list(side, 3)}</aside>
</div>
${more.length ? `<h2 class="sw-section-title">More</h2>${list(more, 3)}` : ''}`;
}

/** Previous/next page links for paginated lists. */
export function pager(base: string, page: number, hasMore: boolean, extra = ''): string {
  if (page <= 1 && !hasMore) return '';
  const href = (n: number) => `${base}?${extra ? `${extra}&` : ''}page=${n}`;
  const newer =
    page > 1
      ? `<a class="sw-button sw-ghost" href="${h(page === 2 && !extra ? base : href(page - 1))}" rel="prev">Newer</a>`
      : '<span></span>';
  const older = hasMore
    ? `<a class="sw-button sw-ghost" href="${h(href(page + 1))}" rel="next">Older</a>`
    : '';
  return `<nav class="sw-pager" aria-label="Pages">${newer}${older}</nav>`;
}

/** An empty state for lists. */
export const empty = (text: string) => `<p class="sw-muted">${h(text)}</p>`;

/**
 * A page with nothing to list yet: a heading, a line and, usually, a way to subscribe, so a new
 * site looks deliberate and still collects readers.
 */
export function emptyState(
  title: string,
  text: string,
  action: { label: string; href: string } | null = null,
): string {
  return `<div class="sw-empty"><h2>${h(title)}</h2><p>${h(text)}</p>${
    action ? `<p><a class="sw-button" href="${h(action.href)}">${h(action.label)}</a></p>` : ''
  }</div>`;
}
