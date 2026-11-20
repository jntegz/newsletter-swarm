// Circle materialisation and scheduled re-evaluation.
//
// A refresh computes membership with the compiled rule and applies it as a diff (remove Members
// who no longer match, add new ones) in ONE db.batch, which D1 runs as a transaction: readers see
// the old membership or the new one, never a half-built Circle. Every statement is guarded on the
// Circle still being at the generation this message was queued for, so a refresh for a rule that
// has since changed (or a deleted Circle) changes nothing.
import { all, first, run } from '@swarm/db';
import { CIRCLE_STUCK_AFTER_MS, CircleRuleError, compileCircle } from '@swarm/engine';
import type { JobsEnv } from '../env';

/** Circles are re-evaluated at least this often, so "within the last N days" stays current. */
const CIRCLE_REFRESH_EVERY_MS = 60 * 60 * 1000;
/** Each lost refresh in a row doubles the wait before the next, up to 32 times (8 hours). */
const STUCK_BACKOFF_MAX_DOUBLINGS = 5;
const DUE_PER_RUN = 50;
/** One workspace fills at most this many of a run's places. */
const DUE_PER_WORKSPACE = 10;

interface CircleRow {
  channel_id: string;
  rule_json: string;
  generation: number;
  deleted_at: number | null;
  evaluated_at: number | null;
}

export async function refreshCircle(
  env: JobsEnv,
  circleId: string,
  generation: number,
  now = Date.now(),
): Promise<void> {
  const db = env.DB;
  const circle = await first<CircleRow>(
    db,
    'SELECT channel_id, rule_json, generation, deleted_at, evaluated_at FROM circles WHERE id = ?1',
    circleId,
  );
  // Deleted, or the rule changed after this message was queued: a newer message will follow.
  if (!circle || circle.deleted_at !== null || circle.generation !== generation) return;

  let compiled;
  try {
    compiled = await compileCircle(db, JSON.parse(circle.rule_json), circle.channel_id, now);
  } catch (error) {
    if (!(error instanceof CircleRuleError)) throw error;
    // A rule that no longer compiles (say, its profile field was deleted) won't on retry either.
    await run(
      db,
      `UPDATE circles SET status = 'failed', error = ?1, evaluated_at = ?2, updated_at = ?2,
              refresh_failures = 0
        WHERE id = ?3 AND generation = ?4`,
      error.message,
      now,
      circleId,
      generation,
    );
    return;
  }

  await run(
    db,
    `UPDATE circles SET status = 'refreshing', updated_at = ?1
      WHERE id = ?2 AND generation = ?3 AND deleted_at IS NULL`,
    now,
    circleId,
    generation,
  );

  // ?1 carries the rule's values (see compileCircle).
  const guard = `EXISTS (SELECT 1 FROM circles c WHERE c.id = ?2 AND c.generation = ?3 AND c.deleted_at IS NULL)`;
  const params = [...compiled.params, circleId, generation, circle.channel_id];
  // Flow triggers (Phase 6): circle_exited / circle_entered for the diff, written in the same
  // transaction just before the rows change. A Circle's first evaluation emits nothing: nobody
  // "entered" a Circle that didn't exist yet. ?5 is now, ?6 is 1 when events are emitted.
  const emit = circle.evaluated_at === null ? 0 : 1;
  await db.batch([
    db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT ?4, cm.member_id, 'circle_exited', json_object('circleId', ?2), ?5 FROM circle_members cm
          WHERE cm.circle_id = ?2 AND ?6 = 1 AND ${guard}
            AND cm.member_id NOT IN (SELECT m.id FROM members m WHERE m.channel_id = ?4 AND (${compiled.where}))`,
      )
      .bind(...params, now, emit),
    db
      .prepare(
        `DELETE FROM circle_members
          WHERE circle_id = ?2 AND ${guard}
            AND member_id NOT IN (SELECT m.id FROM members m WHERE m.channel_id = ?4 AND (${compiled.where}))`,
      )
      .bind(...params),
    db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT ?4, m.id, 'circle_entered', json_object('circleId', ?2), ?5 FROM members m
          WHERE m.channel_id = ?4 AND ?6 = 1 AND ${guard} AND (${compiled.where})
            AND NOT EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = ?2 AND cm.member_id = m.id)`,
      )
      .bind(...params, now, emit),
    db
      .prepare(
        `INSERT OR IGNORE INTO circle_members (circle_id, member_id, generation)
         SELECT ?2, m.id, ?3 FROM members m
          WHERE m.channel_id = ?4 AND ${guard} AND (${compiled.where})`,
      )
      .bind(...params),
    // A change that arrived while this ran set the status back to pending and queued another
    // refresh; leave it pending for that one.
    db
      .prepare(
        `UPDATE circles
            SET member_count = (SELECT count(*) FROM circle_members WHERE circle_id = ?2),
                evaluated_at = ?5, updated_at = ?5, error = NULL, refresh_failures = 0,
                status = CASE status WHEN 'pending' THEN 'pending' ELSE 'ready' END
          WHERE id = ?2 AND generation = ?3 AND deleted_at IS NULL`,
      )
      .bind(...params, now),
  ]);
}

/**
 * Cron: queues Circles that haven't been evaluated recently, and any whose message was lost.
 * A lost refresh (the message failed or never ran) counts in refresh_failures and doubles the wait
 * before the next. Circles are taken by when the cron last looked at them (a lost one by when it
 * was last queued, not by its old evaluated_at), and one workspace fills at most
 * DUE_PER_WORKSPACE places, so Circles that keep failing can't hold every place in every run.
 */
export async function refreshDueCircles(env: JobsEnv, now: number): Promise<number> {
  const due = await all<{ id: string; generation: number }>(
    env.DB,
    `UPDATE circles
        SET refresh_failures = refresh_failures
              + CASE WHEN status IN ('pending', 'refreshing') THEN 1 ELSE 0 END,
            status = 'pending', updated_at = ?1
      WHERE id IN (
        SELECT id FROM (
          SELECT id, due_at,
                 row_number() OVER (PARTITION BY workspace_id ORDER BY due_at, id) AS n
            FROM (SELECT id, workspace_id,
                         CASE WHEN status IN ('pending', 'refreshing') THEN updated_at
                              ELSE ifnull(evaluated_at, 0) END AS due_at
                    FROM circles
                   WHERE deleted_at IS NULL
                     AND ((status IN ('ready', 'failed') AND ifnull(evaluated_at, 0) < ?1 - ?2)
                       OR (status IN ('pending', 'refreshing')
                           AND updated_at < ?1 - ?3 * (1 << min(refresh_failures, ?6))))))
         WHERE n <= ?5 ORDER BY due_at, id LIMIT ?4)
      RETURNING id, generation`,
    now,
    CIRCLE_REFRESH_EVERY_MS,
    CIRCLE_STUCK_AFTER_MS,
    DUE_PER_RUN,
    DUE_PER_WORKSPACE,
    STUCK_BACKOFF_MAX_DOUBLINGS,
  );
  for (const circle of due) {
    await env.JOBS_QUEUE.send({
      type: 'circle_refresh',
      circleId: circle.id,
      generation: circle.generation,
    });
  }
  return due.length;
}
