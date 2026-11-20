/**
 * Link Hub (Phase 8, flag link_hub): cookieless click counts for the links on a Channel's /links
 * page, and the report that reads them. Contract: docs/link-hub.md.
 *
 * - A click is one increment of hub_link_clicks_daily (channel, UTC day, link, source, country).
 *   Nothing identifies the visitor: no cookie, no IP, no User-Agent, no hash.
 * - Source matches the site's page views: `s` (the source the edge put on the link for this page
 *   view, see the site worker's edge/hub.ts) normalised like utm_source, else the click's referrer
 *   host without "www." ("internal" for the site's own host), else "direct".
 * - The site decides what counts (no bots, no prefetches) before calling recordHubClick.
 */
import { HUB_PATH } from '@swarm/domain';
import { all, first } from './db';
import { funnelSource } from './funnel';
import { analyticsDay } from './readers';

const DAY_MS = 86_400_000;
const TOP = 20;

export interface HubClick {
  channelId: string;
  linkId: string;
  /** The `s` query parameter of the click, if any. */
  source: string | null;
  referrer: string | null;
  /** The host the click arrived on. */
  host: string;
  /** Two letters, 'XX' when unknown. */
  country: string;
  now: number;
}

/** The source a click is counted under (see the file comment). */
export function hubClickSource(
  source: string | null | undefined,
  referrer: string | null | undefined,
  host: string,
): string {
  return funnelSource(source, referrer, host);
}

export async function recordHubClick(db: D1Database, click: HubClick): Promise<void> {
  await db
    .prepare(
      `INSERT INTO hub_link_clicks_daily (channel_id, day, link_id, source, country, clicks)
       VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT (channel_id, day, link_id, source, country) DO UPDATE SET clicks = clicks + 1`,
    )
    .bind(
      click.channelId,
      analyticsDay(click.now),
      click.linkId,
      hubClickSource(click.source, click.referrer, click.host),
      /^[A-Z0-9]{2}$/.test(click.country) ? click.country : 'XX',
    )
    .run();
}

export interface HubReport {
  from: string;
  to: string;
  clicks: number;
  pageViews: number;
  pageVisitors: number;
  byDay: { day: string; clicks: number }[];
  byLink: { linkId: string; title: string | null; clicks: number }[];
  sources: { source: string; clicks: number }[];
  countries: { country: string; clicks: number }[];
}

/**
 * Clicks of a Channel's links between two UTC days (both included), optionally for one link, with
 * the page's own views from the site analytics. `from` and `to` are checked by the caller.
 */
export async function linkHubReport(
  db: D1Database,
  channelId: string,
  range: { from: string; to: string; linkId?: string | null },
): Promise<HubReport> {
  // ?1 channel, ?2 from, ?3 to, ?4 link or null.
  const where = 'channel_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR link_id = ?4)';
  const params = [channelId, range.from, range.to, range.linkId ?? null];
  const grouped = <K extends string>(column: K, limit: number | null) =>
    all<Record<K, string> & { clicks: number }>(
      db,
      `SELECT ${column}, sum(clicks) AS clicks FROM hub_link_clicks_daily WHERE ${where}
        GROUP BY ${column} ORDER BY ${limit === null ? column : `clicks DESC, ${column}`}${limit === null ? '' : ` LIMIT ${limit}`}`,
      ...params,
    );
  const [days, links, sources, countries, page, current] = await Promise.all([
    grouped('day', null),
    grouped('link_id', null),
    grouped('source', TOP),
    grouped('country', TOP),
    first<{ views: number | null; visitors: number | null }>(
      db,
      `SELECT sum(views) AS views, sum(visitors) AS visitors FROM site_page_views_daily
        WHERE channel_id = ?1 AND day BETWEEN ?2 AND ?3 AND path = ?4`,
      channelId,
      range.from,
      range.to,
      HUB_PATH,
    ),
    all<{ id: string; title: string }>(
      db,
      'SELECT id, title FROM hub_links WHERE channel_id = ?1 ORDER BY position, created_at',
      channelId,
    ),
  ]);

  const byDayMap = new Map(days.map((row) => [row.day, row.clicks]));
  const byDay: HubReport['byDay'] = [];
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const end = Date.parse(`${range.to}T00:00:00Z`);
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    byDay.push({ day, clicks: byDayMap.get(day) ?? 0 });
  }

  // Links on the page now, in page order (with zeros), then deleted links that had clicks.
  const clicksOf = new Map(links.map((row) => [row.link_id, row.clicks]));
  const byLink: HubReport['byLink'] = current
    .filter((link) => !range.linkId || link.id === range.linkId)
    .map((link) => ({ linkId: link.id, title: link.title, clicks: clicksOf.get(link.id) ?? 0 }));
  const known = new Set(current.map((link) => link.id));
  for (const row of links) {
    if (!known.has(row.link_id))
      byLink.push({ linkId: row.link_id, title: null, clicks: row.clicks });
  }

  return {
    from: range.from,
    to: range.to,
    clicks: days.reduce((sum, row) => sum + row.clicks, 0),
    pageViews: page?.views ?? 0,
    pageVisitors: page?.visitors ?? 0,
    byDay,
    byLink,
    sources: sources.map((row) => ({ source: row.source, clicks: row.clicks })),
    countries: countries.map((row) => ({ country: row.country, clicks: row.clicks })),
  };
}
