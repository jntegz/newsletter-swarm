// Small helpers shared by every site template: escaping, dates, URLs and response headers.
import { escapeHtml } from '@swarm/mail';
import type { SiteChannel, SiteContext } from '../context';

export const h = escapeHtml;

/** XML text and attribute escaping (feeds and sitemaps). */
export function x(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Characters XML 1.0 does not allow at all.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  );
}

const DEFAULT_ACCENT = '#6c4cf1';

/** The Channel's accent colour when it is a valid #rrggbb, else Swarm indigo. */
export function accentOf(channel: SiteChannel): string {
  const accent = channel.branding.accentColor;
  return accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : DEFAULT_ACCENT;
}

const DATE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

/** A `<time>` element for a millisecond timestamp. */
export function time(ms: number): string {
  return `<time datetime="${new Date(ms).toISOString()}">${h(DATE.format(new Date(ms)))}</time>`;
}

/** An absolute URL on the Channel's canonical origin. */
export const absolute = (channel: SiteChannel, path: string) => `${channel.origin}${path}`;

/** Dispatch pages live at /p/<slug>. */
export const dispatchPath = (slug: string) => `/p/${encodeURIComponent(slug)}`;

/**
 * Cache headers for the edge layer.
 *
 * - 'public': the same bytes for every reader. Shared caches may keep it for 5 minutes and serve
 *   it stale for a day while revalidating.
 * - 'reader': depends on the reader class (a gated Dispatch read by a Member). Browsers and other
 *   shared caches must not keep it; the edge may, under its per-class cache key.
 * - 'private': never cached anywhere (gated content served to a verified crawler).
 *
 * `x-swarm-cacheable: 1` tells the edge middleware the response may go in its cache; `cache-tag`
 * lets it purge everything for a Channel (and a Dispatch) at once.
 */
export type Cacheability = 'public' | 'reader' | 'private';

export function cacheHeaders(
  c: SiteContext,
  kind: Cacheability,
  tags: string[] = [],
): Record<string, string> {
  if (kind === 'private') return { 'cache-control': 'private, no-store' };
  const channel = c.get('channel');
  return {
    'cache-control':
      kind === 'public'
        ? 'public, s-maxage=300, stale-while-revalidate=86400'
        : 'private, no-cache',
    'x-swarm-cacheable': '1',
    'cache-tag': [channel.id, ...tags].join(','),
  };
}
