// Publishing a website design (docs/site-themes.md, "Draft, preview, publish"): one function for
// what a publish does, called by the API's Publish and by the jobs worker's scheduled publishes,
// so both store the same thing, keep the same versions, bump the cache the same way and write the
// same audit entry. Not in the package's index: it brings the theme engine and the built-in
// themes, which only the API and the jobs worker need. Import it from '@swarm/engine/site-design'.
import { appendAudit } from '@swarm/db';
import {
  SITE_DESIGN_VERSIONS_KEPT,
  newId,
  type SiteDesign,
  type SiteDesignVersion,
  type ThemeProblem,
} from '@swarm/domain';
import { compileDesign, runningTests, type Design } from '@swarm/site-themes';
import { BUILT_IN_THEMES } from '@swarm/site-themes/themes';
import { toIso } from './db';

/** A built-in theme's files, or null when there is no theme of that id. */
export const builtInThemeFiles = (theme: string) =>
  BUILT_IN_THEMES[theme as keyof typeof BUILT_IN_THEMES]?.files ?? null;

/** A design's problems: its theme's files compiled, then the design checked against them. */
export const designProblems = (design: SiteDesign): ThemeProblem[] =>
  compileDesign(design as Design, builtInThemeFiles(design.theme)).problems;

export const hasDesignErrors = (problems: ThemeProblem[]) =>
  problems.some((p) => p.severity === 'error');

/** A scheduled publish's claim on its schedule row (site_design_schedules). */
interface ScheduleClaim {
  token: string;
  /** When it was due, for the audit entry. */
  publishAt: number;
}

interface PublishDesignInput {
  channelId: string;
  workspaceId: string;
  design: SiteDesign;
  /** The design as stored, so the published copy is exactly what was saved. */
  json?: string;
  /** Who publishes: the person, or for a scheduled publish the person who scheduled it. */
  operatorId: string | null;
  now: number;
  ipPrefix?: string | null;
  /**
   * A scheduled publish: every write happens only while this claim still holds the Channel's
   * schedule, and the same batch deletes the schedule, so it publishes at most once.
   */
  schedule?: ScheduleClaim;
}

type PublishDesignResult =
  | { status: 'published'; version: SiteDesignVersion; json: string; problems: ThemeProblem[] }
  /** The design has errors; nothing was written. */
  | { status: 'refused'; problems: ThemeProblem[] }
  /** The schedule was cancelled, replaced or claimed by another run first; nothing was written. */
  | { status: 'lost' };

/**
 * Checks a design and publishes it: the published copy and its version number, the running A/B
 * tests for the site (published_tests), a version kept (the last 20), the site's cache version
 * bumped, and the audit entry. Refused while the design has errors.
 */
export async function publishSiteDesign(
  db: D1Database,
  input: PublishDesignInput,
): Promise<PublishDesignResult> {
  const { channelId, design, operatorId, now, schedule } = input;
  const compiled = compileDesign(design as Design, builtInThemeFiles(design.theme));
  if (hasDesignErrors(compiled.problems)) return { status: 'refused', problems: compiled.problems };
  const json = input.json ?? JSON.stringify(design);
  const versionId = newId('siteDesignVersion', now);
  // The running A/B tests, for the site to give each home page view its variants.
  const tests = JSON.stringify(
    compiled.theme ? runningTests(compiled.theme, design as Design).map((s) => s.id) : [],
  );
  // Each write is guarded the same way: always for a publish by hand, and only while the claim
  // holds for a scheduled one. The guard's parameters come after each statement's own.
  const guard = (at: number) =>
    schedule
      ? `EXISTS (SELECT 1 FROM site_design_schedules
                  WHERE channel_id = ?${at} AND claim_token = ?${at + 1} AND status = 'scheduled')`
      : '1';
  const guardArgs = schedule ? [channelId, schedule.token] : [];
  const statements = [
    db
      .prepare(
        `INSERT INTO site_designs (channel_id, draft_json, draft_updated_by, draft_updated_at,
           published_json, published_version, published_by, published_at, published_tests)
         SELECT ?1, ?2, ?3, ?4, ?2, 1, ?3, ?4, ?5 WHERE ${guard(6)}
         ON CONFLICT (channel_id) DO UPDATE SET published_json = excluded.published_json,
           published_version = site_designs.published_version + 1,
           published_by = excluded.published_by, published_at = excluded.published_at,
           published_tests = excluded.published_tests`,
      )
      .bind(channelId, json, operatorId, now, tests, ...guardArgs),
    db
      .prepare(
        `INSERT INTO site_design_versions (id, channel_id, design_json, theme, published_by, published_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${guard(7)}`,
      )
      .bind(versionId, channelId, json, design.theme, operatorId, now, ...guardArgs),
    db
      .prepare(
        `DELETE FROM site_design_versions WHERE channel_id = ?1 AND id NOT IN (
           SELECT id FROM site_design_versions WHERE channel_id = ?1
            ORDER BY published_at DESC, id DESC LIMIT ?2)`,
      )
      .bind(channelId, SITE_DESIGN_VERSIONS_KEPT),
    // As bumpCacheStatement (hostnames.ts), under the guard.
    db
      .prepare(
        `INSERT INTO site_settings (channel_id, cache_version, updated_at)
         SELECT ?1, 2, ?2 WHERE ${guard(3)}
         ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
      )
      .bind(channelId, now, ...guardArgs),
    ...(schedule
      ? [
          db
            .prepare(
              `DELETE FROM site_design_schedules
                WHERE channel_id = ?1 AND claim_token = ?2 AND status = 'scheduled'`,
            )
            .bind(channelId, schedule.token),
        ]
      : []),
  ];
  const results = await db.batch(statements);
  if (schedule && !results[results.length - 1]?.meta.changes) return { status: 'lost' };
  await appendAudit(db, {
    workspaceId: input.workspaceId,
    actorId: operatorId,
    action: 'site.design_published',
    targetType: 'channel',
    targetId: channelId,
    metadata: {
      versionId,
      theme: design.theme,
      ownFiles: design.files !== null,
      ...(schedule ? { scheduled: true, scheduledFor: toIso(schedule.publishAt) } : {}),
    },
    ipPrefix: input.ipPrefix ?? null,
  });
  return {
    status: 'published',
    json,
    problems: compiled.problems,
    version: {
      id: versionId,
      publishedAt: toIso(now),
      publishedBy: operatorId,
      theme: design.theme,
    },
  };
}
