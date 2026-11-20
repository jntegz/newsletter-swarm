// Where an owner's website code (scripts, not CSS; flag site_custom_code) may run. Tables:
// migrations/0065_site_code_rules.sql. Code always runs on a publication's own custom domain. On
// this install's own domain (<slug>.PLATFORM_SITE_DOMAIN) every publication shares the install
// owner's name, so there it runs only for a workspace an instance admin allowed: otherwise any
// workspace admin on a shared install could put scripts on the owner's domain.
//
// Only rows an instance admin wrote count (site_code_workspaces, site_code_rules), never seats:
// any owner can make any teammate an owner, so an owner seat held by an instance admin says nothing
// about whether the instance admin agreed. A workspace an instance admin makes gets its row when it
// is made (the installer, and the instance_admins trigger in migrations/0069_review_fixes.sql).
import type { SiteCodeReason } from '@swarm/domain';
import { first } from './db';

/**
 * Why code may run on this install's own domain for a workspace, or why not: 'not_allowed', or
 * 'held' when every workspace is allowed but this one's code was withheld when that was turned on
 * (site_code_held, 0113), so relaxing the rule doesn't release code nobody reviewed.
 */
export async function siteCodeReason(db: D1Database, workspaceId: string): Promise<SiteCodeReason> {
  const row = await first<{ allowed: number; every: number; held: number }>(
    db,
    `SELECT
       EXISTS (SELECT 1 FROM site_code_workspaces WHERE workspace_id = ?1) AS allowed,
       EXISTS (SELECT 1 FROM site_code_rules WHERE id = 1 AND every_workspace = 1) AS every,
       EXISTS (SELECT 1 FROM site_code_held WHERE workspace_id = ?1) AS held`,
    workspaceId,
  );
  if (row?.allowed) return 'allowed';
  if (row?.every) return row.held ? 'held' : 'every_workspace';
  return 'not_allowed';
}

/** Whether a reason lets code run on this install's own domain. */
export const siteCodeRuns = (reason: SiteCodeReason) =>
  reason === 'allowed' || reason === 'every_workspace';

/** Whether code may run on this install's own domain for a workspace. */
export const siteCodeOnPlatform = async (db: D1Database, workspaceId: string) =>
  siteCodeRuns(await siteCodeReason(db, workspaceId));

/**
 * Turning on "every workspace": the workspaces whose saved code (anything but verification tags)
 * is withheld right now are recorded as held, so it stays off until each is allowed by itself.
 */
export function holdWithheldSiteCodeStatement(db: D1Database, now: number) {
  return db
    .prepare(
      `INSERT INTO site_code_held (workspace_id, held_at)
       SELECT DISTINCT c.workspace_id, ?1 FROM site_settings s JOIN channels c ON c.id = s.channel_id
        WHERE EXISTS (SELECT 1 FROM json_each(s.code_json) j
                       WHERE coalesce(json_extract(j.value, '$.preset'), '') <> 'verification')
          AND NOT EXISTS (SELECT 1 FROM site_code_workspaces a WHERE a.workspace_id = c.workspace_id)
          AND NOT EXISTS (SELECT 1 FROM site_code_rules r WHERE r.id = 1 AND r.every_workspace = 1)
       ON CONFLICT (workspace_id) DO NOTHING`,
    )
    .bind(now);
}

/** Whether the publication has an active custom web domain, where its code always runs. */
export async function hasCustomWebDomain(db: D1Database, channelId: string): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM custom_hostnames WHERE channel_id = ?1 AND status = 'active' AND role = 'web'
      LIMIT 1`,
    channelId,
  ));
}

/**
 * Makes every cached page of these workspaces' websites stale, so a change to where code may run
 * shows on the next request instead of after the edge cache expires. All websites when null.
 */
export function bumpSiteCachesStatement(db: D1Database, workspaceId: string | null) {
  return workspaceId === null
    ? db.prepare('UPDATE site_settings SET cache_version = cache_version + 1')
    : db
        .prepare(
          `UPDATE site_settings SET cache_version = cache_version + 1
            WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1)`,
        )
        .bind(workspaceId);
}
