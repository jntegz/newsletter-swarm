/**
 * The click map of a send: its frozen email(s) with clicks marked on each link, in counts only.
 *
 * A send can have several emails. Who got which was fixed per recipient in broadcast_recipients, and
 * the pipeline picks the same way this does: the teaser wins, then the Split Test version's own
 * render, then the Broadcast's. A recipient with no version got the Broadcast's email, which is A.
 *
 * Numbers agree with broadcastStats: same clicks, same exclusions, one row per link target. A person
 * who has been deleted has no recipient row, so where there are several views their clicks go in
 * `unplaced`; a single view needs no placing and counts them.
 */
import type { BroadcastClickMap, ClickMapView } from '@swarm/domain';
import { markClickMap } from '@swarm/mail';
import { all, first } from './db';
import { OLD_TEST_SENDS_SQL } from './stats';

interface VersionRow {
  id: string;
  label: string;
  subject: string | null;
  html: string | null;
}

interface CountRow {
  placed: number;
  variant: string | null;
  split_variant_id: string | null;
  link_target_id?: string;
  people: number;
  clicks: number;
}

const humanClicksBy = (columns: string) => `
  SELECT r.member_id IS NOT NULL AS placed, r.variant, r.split_variant_id${columns},
         count(DISTINCT c.delivery_id) AS people, count(*) AS clicks
    FROM clicks c
    JOIN link_targets l ON l.id = c.link_target_id AND l.broadcast_id = ?1
    JOIN deliveries d ON d.id = c.delivery_id
    LEFT JOIN broadcast_recipients r ON r.broadcast_id = ?1 AND r.member_id = d.member_id
   WHERE c.classification = 'human'
     AND c.delivery_id NOT IN (SELECT id FROM deliveries WHERE broadcast_id = ?1 AND member_id IN ${OLD_TEST_SENDS_SQL})
   GROUP BY placed, r.variant, r.split_variant_id${columns}`;

export async function broadcastClickMap(
  db: D1Database,
  broadcastId: string,
): Promise<BroadcastClickMap> {
  const broadcast = await first<{
    subject: string;
    html: string;
    teaser_html: string | null;
    split_test_id: string | null;
  }>(
    db,
    'SELECT subject, html, teaser_html, split_test_id FROM broadcasts WHERE id = ?1',
    broadcastId,
  );
  if (!broadcast) return { views: [], unplaced: { people: 0, clicks: 0 } };
  const versions = broadcast.split_test_id
    ? await all<VersionRow>(
        db,
        'SELECT id, label, subject, html FROM split_test_variants WHERE split_test_id = ?1 ORDER BY label',
        broadcast.split_test_id,
      )
    : [];
  const targets = await all<{
    id: string;
    url: string;
    position: number;
    destination: string | null;
  }>(
    db,
    `SELECT l.id, l.url, l.position, (SELECT s.url FROM app_short_links s WHERE s.short_url = l.url LIMIT 1) AS destination
       FROM link_targets l WHERE l.broadcast_id = ?1 ORDER BY l.position`,
    broadcastId,
  );
  const [perLink, perView] = await Promise.all([
    all<CountRow>(db, humanClicksBy(', c.link_target_id'), broadcastId),
    all<CountRow>(db, humanClicksBy(''), broadcastId),
  ]);

  const hasTeaser = broadcast.teaser_html !== null;
  const versionA = versions.find((version) => version.label === 'A') ?? versions[0];
  const versionIds = new Set(versions.map((version) => version.id));
  const single = versions.length === 0 && !hasTeaser;
  /** The view a row of counts belongs to, or null when it can't be placed. */
  const viewOf = (row: CountRow): string | null => {
    if (single) return viewKey(null, false);
    if (!row.placed) return null;
    if (versions.length && row.split_variant_id && !versionIds.has(row.split_variant_id)) {
      return null;
    }
    return viewKey(
      versions.length ? (row.split_variant_id ?? versionA?.id ?? null) : null,
      hasTeaser && row.variant === 'teaser',
    );
  };

  const views: ClickMapView[] = [];
  for (const version of versions.length ? versions : [null]) {
    for (const teaser of hasTeaser ? [false, true] : [false]) {
      const key = viewKey(version?.id ?? null, teaser);
      const clicks = new Map<string, { people: number; clicks: number }>();
      for (const row of perLink) {
        if (viewOf(row) !== key || !row.link_target_id) continue;
        const sum = clicks.get(row.link_target_id) ?? { people: 0, clicks: 0 };
        // A person has one recipient row, so these add up without counting anyone twice.
        sum.people += row.people;
        sum.clicks += row.clicks;
        clicks.set(row.link_target_id, sum);
      }
      const template = teaser ? broadcast.teaser_html : (version?.html ?? broadcast.html);
      const stored = !!template?.trim();
      const marked = markClickMap(
        stored ? (template as string) : '',
        targets.map((target) => ({
          position: target.position,
          people: clicks.get(target.id)?.people ?? 0,
          clicks: clicks.get(target.id)?.clicks ?? 0,
        })),
        { listEvery: single },
      );
      const byPosition = new Map(targets.map((target) => [target.position, target]));
      const totals = perView
        .filter((row) => viewOf(row) === key)
        .reduce(
          (sum, row) => ({ people: sum.people + row.people, clicks: sum.clicks + row.clicks }),
          { people: 0, clicks: 0 },
        );
      views.push({
        key,
        label: viewLabel(version?.label ?? null, teaser, hasTeaser),
        subject: version?.subject ?? broadcast.subject,
        html: stored ? marked.html : null,
        totalPeople: totals.people,
        totalClicks: totals.clicks,
        uncountedLinks: marked.uncountedLinks,
        hasSmartBlocks: marked.hasSmartBlocks,
        links: marked.links.map((link) => {
          const target = byPosition.get(link.position);
          return {
            number: link.number,
            position: link.position,
            url: target?.url ?? '',
            destination: target?.destination ?? null,
            people: link.people,
            clicks: link.clicks,
            share: link.share,
            level: link.level,
            occurrences: link.occurrences,
          };
        }),
      });
    }
  }
  const unplaced = perView
    .filter((row) => viewOf(row) === null)
    .reduce((sum, row) => ({ people: sum.people + row.people, clicks: sum.clicks + row.clicks }), {
      people: 0,
      clicks: 0,
    });
  return { views, unplaced };
}

const viewKey = (versionId: string | null, teaser: boolean) =>
  `${versionId ?? 'email'}:${teaser ? 'teaser' : 'full'}`;

function viewLabel(version: string | null, teaser: boolean, hasTeaser: boolean): string {
  const part = hasTeaser ? (teaser ? 'Teaser' : 'Full email') : null;
  if (version) return part ? `Version ${version}, ${part.toLowerCase()}` : `Version ${version}`;
  return part ?? 'The email';
}
