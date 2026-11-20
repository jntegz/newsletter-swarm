// GET /_swarm/r?d=<designVersion>&s=<sectionId>&v=<a|b> : the section analytics beacon
// (docs/site-themes.md). Each section of the published design's home page ends with a 1×1 lazy
// image here (render/design.ts sectionBeacon), so the browser asks for it only when the reader
// scrolls near the section. It answers a transparent GIF that nothing may store, and after the
// response adds one "reached" to site_section_daily, but only for what a page view would count:
// a person's browser (not a bot, a verified crawler, a prefetch or a prerender), not a design
// preview, for the design version that is published now and a section and variant it has.
// Nothing about the reader is stored.
import { sectionCountStatement, sectionVariantOf } from '@swarm/engine';
import { runningTests, sectionsOf } from '@swarm/site-themes';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { REACH_PATH } from '../edge/cache';
import { humanRequest } from '../middleware/edge';
import { later } from '../readers/later';
import { activate, publishedDesign } from '../render/design';
import { PREVIEW_PATH } from './preview';

export const reach = new Hono<SiteBindings>();

/** A transparent 1×1 GIF. */
const GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (ch) => ch.charCodeAt(0),
);

/** Whether the page that asked was a design preview (the Referer, when the browser sends it). */
function fromPreview(c: SiteContext): boolean {
  const referer = c.req.header('referer');
  if (!referer) return false;
  try {
    return new URL(referer).pathname === PREVIEW_PATH;
  } catch {
    return false;
  }
}

/** Adds the reach when the published design has this section, and B only while it is tested. */
async function countReach(
  c: SiteContext,
  version: number,
  sectionId: string,
  variant: 'a' | 'b',
): Promise<void> {
  const env = c.get('env');
  const channel = c.get('channel');
  const design = await publishedDesign(env, channel);
  if (!design || channel.settings.designVersion !== version) return;
  const active = activate(design, 'published');
  if (!active) return;
  const shown = sectionsOf(active.theme, design).filter((s) => !s.hidden);
  const known =
    variant === 'b'
      ? runningTests(active.theme, design).some((s) => s.id === sectionId)
      : shown.some((s) => s.id === sectionId);
  if (!known) return;
  await sectionCountStatement(env.DB, 'reached', {
    channelId: channel.id,
    sectionId,
    variant,
  }).run();
}

reach.get(REACH_PATH, (c) => {
  const channel = c.get('channel');
  const version = Number(c.req.query('d'));
  const named = sectionVariantOf(c.req.query('s'), c.req.query('v'));
  if (
    named &&
    Number.isSafeInteger(version) &&
    version === channel.settings.designVersion &&
    !fromPreview(c) &&
    humanRequest(c)
  ) {
    later(c, countReach(c, version, named.sectionId, named.variant));
  }
  return c.body(GIF, 200, {
    'content-type': 'image/gif',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  });
});
