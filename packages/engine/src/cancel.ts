import { first, run } from './db';

/** Shown on the report of a send that stopped because its Channel was deleted. */
export const CHANNEL_DELETED_REASON =
  'The publication was deleted, so the rest of this send was canceled.';

/**
 * Stops a Broadcast. Batches already in the queue see the status and skip their recipients.
 * `reason` is kept on the Broadcast for its report, when the stop wasn't a person's choice.
 */
export async function cancelBroadcast(
  db: D1Database,
  broadcastId: string,
  now = Date.now(),
  reason: string | null = null,
): Promise<boolean> {
  const row = await first<{ dispatch_id: string; ramp_id: string | null; best_time: number }>(
    db,
    `UPDATE broadcasts SET status = 'canceled', canceled_at = ?1, completed_at = ?1,
            failure_reason = coalesce(?3, failure_reason)
      WHERE id = ?2 AND status IN ('queued', 'sending') RETURNING dispatch_id, ramp_id, best_time`,
    now,
    broadcastId,
    reason,
  );
  if (!row) return false;
  await run(
    db,
    `UPDATE dispatches SET status = 'canceled', updated_at = ?1 WHERE id = ?2`,
    now,
    row.dispatch_id,
  );
  // Readers still waiting for their hour have no batch to skip them.
  if (row.best_time) {
    await run(
      db,
      `UPDATE broadcast_recipients SET status = 'skipped'
        WHERE broadcast_id = ?1 AND held = 1 AND send_after IS NOT NULL AND status = 'pending'`,
      broadcastId,
    );
  }
  return true;
}

/**
 * A deleted Channel mails nobody again. Deleting a Channel cancels its sends; this cancels one the
 * delete did not see (it started alongside it) at its next step. A Flow's Broadcast is left to the
 * Flows engine, which exits the runs of a deleted Channel. True when the Broadcast was canceled.
 */
export async function cancelIfChannelDeleted(
  db: D1Database,
  broadcast: { id: string; channel_id: string; kind: string },
  now: number,
): Promise<boolean> {
  if (broadcast.kind !== 'broadcast') return false;
  const deleted = await first(
    db,
    'SELECT 1 FROM channels WHERE id = ?1 AND deleted_at IS NOT NULL',
    broadcast.channel_id,
  );
  return !!deleted && cancelBroadcast(db, broadcast.id, now, CHANNEL_DELETED_REASON);
}
