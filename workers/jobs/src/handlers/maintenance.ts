// Cron housekeeping for Members: pause expiry, expired exports, stale import files, and imported
// people who never confirmed. (Phase 3, Members workstream.)
import { all, appendAudit, run } from '@swarm/db';
import { IMPORT_PENDING_DAYS } from '@swarm/domain';
import {
  enqueueChannelCircleRefresh,
  jobQueue,
  memberDeletedStatement,
  resumePausedMembers,
} from '@swarm/engine';
import type { JobsEnv } from '../env';

/** Uploaded files of imports that finished, or were abandoned before importing, are deleted. */
const IMPORT_FILE_DAYS = 7;
const ABANDONED_IMPORT_DAYS = 30;
const DAY_MS = 86_400_000;
const BATCH = 50;
/** Pending imported Members deleted per batch, and batches per run. */
const PENDING_BATCH = 500;
const PENDING_BATCHES = 10;

/**
 * Imported people who started pending (the operator did not attest that they agreed) and never
 * confirmed are deleted IMPORT_PENDING_DAYS after they were imported, unless a confirmation email
 * sent to them is still open. Nothing was ever sent to them as a post, so only the Member goes:
 * the same delete as an operator's (member.deleted webhook, rows that cascade), one audit entry
 * per Channel and run. Returns how many were deleted.
 */
export async function expirePendingImports(env: JobsEnv, now: number): Promise<number> {
  let deleted = 0;
  const channels = new Map<string, { workspaceId: string; count: number }>();
  for (let i = 0; i < PENDING_BATCHES; i++) {
    const rows = await all<{ id: string; channel_id: string; workspace_id: string }>(
      env.DB,
      `SELECT m.id, m.channel_id, c.workspace_id FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE m.status = 'pending' AND m.import_id IS NOT NULL AND m.created_at <= ?1
          AND m.confirmed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM confirm_requests q WHERE q.member_id = m.id
                           AND q.confirmed_at IS NULL AND q.expires_at > ?2)
        ORDER BY m.created_at LIMIT ?3`,
      now - IMPORT_PENDING_DAYS * DAY_MS,
      now,
      PENDING_BATCH,
    );
    if (!rows.length) break;
    const ids = JSON.stringify(rows.map((r) => r.id));
    await env.DB.batch([
      memberDeletedStatement(
        env.DB,
        rows.map((r) => r.id),
        now,
      ),
      // Metered reads keyed by these Members' ids (no foreign key).
      env.DB.prepare(
        `DELETE FROM gate_meter_reads WHERE reader_key IN
           (SELECT id FROM members WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending')`,
      ).bind(ids),
      // Still pending in the same statement, so someone who confirmed meanwhile stays.
      env.DB.prepare(
        `DELETE FROM members WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending'`,
      ).bind(ids),
    ]);
    deleted += rows.length;
    for (const row of rows) {
      const entry = channels.get(row.channel_id) ?? { workspaceId: row.workspace_id, count: 0 };
      entry.count++;
      channels.set(row.channel_id, entry);
    }
    if (rows.length < PENDING_BATCH) break;
  }
  for (const [channelId, { workspaceId, count }] of channels) {
    await appendAudit(env.DB, {
      workspaceId,
      actorId: null,
      action: 'members.pending_imports_deleted',
      targetType: 'channel',
      targetId: channelId,
      metadata: { count, days: IMPORT_PENDING_DAYS },
    });
    await enqueueChannelCircleRefresh(env.DB, jobQueue(env.JOBS_QUEUE), channelId, { now });
  }
  return deleted;
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function maintainMembers(env: JobsEnv, now: number): Promise<void> {
  // Pauses that have ended: paused → active is a system transition. Bounded per run.
  for (let i = 0; i < 20; i++) {
    if ((await resumePausedMembers(env.DB, now)) === 0) break;
  }

  // Finished exports past their expiry: delete the parts; the job row stays for the audit trail.
  const expired = await all<{ id: string; r2_key: string }>(
    env.DB,
    `SELECT id, r2_key FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at <= ?1
        AND r2_key IS NOT NULL LIMIT ?2`,
    now,
    BATCH,
  );
  for (const job of expired) {
    await deletePrefix(env.EXPORTS, job.r2_key);
    await run(env.DB, 'UPDATE export_jobs SET r2_key = NULL WHERE id = ?1', job.id);
  }

  // Abandoned imports (never confirmed) are canceled; their files go with finished ones below.
  await run(
    env.DB,
    `UPDATE import_jobs SET status = 'canceled', updated_at = ?1, completed_at = ?1
      WHERE status IN ('uploaded', 'analyzed') AND updated_at <= ?2`,
    now,
    now - ABANDONED_IMPORT_DAYS * DAY_MS,
  );
  const stale = await all<{ id: string; r2_key: string }>(
    env.DB,
    `SELECT id, r2_key FROM import_jobs WHERE status IN ('done', 'failed', 'canceled')
        AND completed_at <= ?1 AND r2_key <> '' LIMIT ?2`,
    now - IMPORT_FILE_DAYS * DAY_MS,
    BATCH,
  );
  for (const job of stale) {
    await env.IMPORTS.delete(job.r2_key);
    await run(env.DB, "UPDATE import_jobs SET r2_key = '' WHERE id = ?1", job.id);
  }

  await expirePendingImports(env, now);
}
