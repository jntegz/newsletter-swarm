// Link Hub click sources (Phase 8, docs/link-hub.md "Source").
//
// A click's own referrer is the /links page, which says nothing about where the visitor found it.
// So, after the edge cache, every link on a /links response gets `?s=<source>` for this request,
// the source worked out as for page views (utm_source, else the referrer's host, else "direct").
// The cached page never carries a source, and the click redirect only uses `s` as a label.
import { HUB_PATH } from '@swarm/domain';
import { hubClickSource } from '@swarm/engine';
import type { SiteContext } from '../context';

/** Marks the links on /links that get the source (routes/hub.ts renders it). */
export const HUB_LINK_ATTRIBUTE = 'data-hub-link';

export function carryHubSource(c: SiteContext): void {
  if (c.req.method !== 'GET') return;
  const url = new URL(c.req.url);
  if (url.pathname !== HUB_PATH) return;
  const res = c.res;
  if (
    res.status !== 200 ||
    !res.body ||
    !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
  ) {
    return;
  }
  const source = encodeURIComponent(
    hubClickSource(url.searchParams.get('utm_source'), c.req.header('referer'), url.hostname),
  );
  c.res = new HTMLRewriter()
    .on(`a[${HUB_LINK_ATTRIBUTE}]`, {
      element(link) {
        const href = link.getAttribute('href');
        if (href) link.setAttribute('href', `${href}?s=${source}`);
      },
    })
    .transform(res);
  // The body grew; a stored length would cut it off.
  c.header('content-length', undefined);
}
