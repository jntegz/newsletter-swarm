// Scheduled publishing of website designs (docs/site-themes.md, "Draft, preview, publish"). On the
// five-minute cron, due schedules are claimed with one conditional UPDATE … RETURNING that sets
// this run's claim token and a lease, so two runs never take the same schedule. Each claimed
// snapshot is checked again and published through publishSiteDesign, exactly as Publish in the
// API does; every write of that batch is guarded on the claim still holding and the batch ends by
// deleting the schedule, so a schedule cancelled or replaced meanwhile, or taken over by another
// run once the lease ran out, publishes nothing. A snapshot that fails its check is marked
// 'failed' with the problems, and the live design is left as it is.
import { all, appendAudit, first, run } from '@swarm/db';
import type { SiteDesign, ThemeProblem } from '@swarm/domain';
import { publishSiteDesign } from '@swarm/engine/site-design';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });

/** A claim lasts this long; a run that died holding one is retried after it, two crons later. */
const SITE_SCHEDULE_LEASE_MS = 10 * 60_000;
const DUE_PER_RUN = 25;

interface Claimed {
  channel_id: string;
  design_json: string;
  publish_at: number;
  scheduled_by: string | null;
}

/** Claims up to `limit` due schedules for this run. */
export function claimDueSchedules(
  db: D1Database,
  token: string,
  now: number,
  limit = DUE_PER_RUN,
): Promise<Claimed[]> {
  const due = `status = 'scheduled' AND publish_at <= ?1 AND ifnull(claimed_until, 0) <= ?1`;
  return all<Claimed>(
    db,
    `UPDATE site_design_schedules SET claim_token = ?2, claimed_until = ?3
      WHERE channel_id IN (SELECT channel_id FROM site_design_schedules WHERE ${due}
                            ORDER BY publish_at LIMIT ?4)
        AND ${due}
      RETURNING channel_id, design_json, publish_at, scheduled_by`,
    now,
    token,
    now + SITE_SCHEDULE_LEASE_MS,
    limit,
  );
}

/** Marks a claimed schedule failed with its problems, while the claim still holds. */
async function markFailed(
  db: D1Database,
  row: Claimed,
  token: string,
  workspaceId: string,
  problems: ThemeProblem[],
  now: number,
): Promise<void> {
  const failed = await first<{ channel_id: string }>(
    db,
    `UPDATE site_design_schedules SET status = 'failed', problems_json = ?3, failed_at = ?4,
            claim_token = NULL, claimed_until = NULL
      WHERE channel_id = ?1 AND claim_token = ?2 AND status = 'scheduled'
      RETURNING channel_id`,
    row.channel_id,
    token,
    JSON.stringify(problems),
    now,
  );
  if (!failed) return;
  await appendAudit(db, {
    workspaceId,
    actorId: null,
    action: 'site.design_schedule_failed',
    targetType: 'channel',
    targetId: row.channel_id,
    metadata: {
      at: new Date(row.publish_at).toISOString(),
      scheduledBy: row.scheduled_by,
      problems: problems.filter((p) => p.severity === 'error').map((p) => p.message),
    },
  });
}

/** Publishes the designs whose time has come. Returns what happened to each claimed schedule. */
export async function publishDueSiteDesigns(
  env: JobsEnv,
  now: number,
): Promise<{ published: number; failed: number; lost: number }> {
  const db = env.DB;
  const token = crypto.randomUUID();
  const claimed = await claimDueSchedules(db, token, now);
  const flags = new FlagService(new D1FlagStore(db, env.CACHE));
  const counts = { published: 0, failed: 0, lost: 0 };
  for (const row of claimed) {
    try {
      const channel = await first<{ workspace_id: string; deleted_at: number | null }>(
        db,
        'SELECT workspace_id, deleted_at FROM channels WHERE id = ?1',
        row.channel_id,
      );
      if (!channel || channel.deleted_at !== null) {
        await run(
          db,
          'DELETE FROM site_design_schedules WHERE channel_id = ?1 AND claim_token = ?2',
          row.channel_id,
          token,
        );
        counts.lost++;
        continue;
      }
      const scope = { workspaceId: channel.workspace_id, channelId: row.channel_id };
      if (!(await flags.enabled('site_templates', scope))) {
        await markFailed(
          db,
          row,
          token,
          channel.workspace_id,
          [
            {
              file: 'design',
              line: 1,
              column: 1,
              message: 'Website themes aren’t on for this publication, so it wasn’t published.',
              severity: 'error',
            },
          ],
          now,
        );
        counts.failed++;
        continue;
      }
      const result = await publishSiteDesign(db, {
        channelId: row.channel_id,
        workspaceId: channel.workspace_id,
        design: JSON.parse(row.design_json) as SiteDesign,
        json: row.design_json,
        operatorId: row.scheduled_by,
        now,
        schedule: { token, publishAt: row.publish_at },
      });
      if (result.status === 'refused') {
        await markFailed(db, row, token, channel.workspace_id, result.problems, now);
        counts.failed++;
      } else if (result.status === 'lost') {
        counts.lost++;
      } else {
        counts.published++;
      }
    } catch (error) {
      // The claim runs out and a later cron tries again.
      log.warn('scheduled design publish failed', {
        channelId: row.channel_id,
        error: (error as Error).message,
      });
    }
  }
  return counts;
}
