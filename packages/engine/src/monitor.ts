/**
 * Publishes Broadcast progress to its SendMonitor Durable Object (realtime worker), which pushes
 * it to dashboards over WebSocket. Best effort: the Broadcast row stays the source of truth, and
 * the dashboard falls back to polling when no socket is open.
 */
import type { BroadcastProgress } from '@swarm/domain';
import { first, toIso } from './db';
import { WAIT_COLUMNS, toSendWait, type WaitColumns } from './send-waits';

interface MonitorStub {
  publish(progress: BroadcastProgress): Promise<void>;
}

export async function publishProgress(
  db: D1Database,
  monitors: DurableObjectNamespace | undefined,
  broadcastIds: Iterable<string>,
  log?: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  if (!monitors) return;
  for (const broadcastId of new Set(broadcastIds)) {
    const row = await first<WaitColumns & { completed_at: number | null }>(
      db,
      `SELECT ${WAIT_COLUMNS}, completed_at FROM broadcasts WHERE id = ?1`,
      broadcastId,
    );
    if (!row) continue;
    const stub = monitors.get(monitors.idFromName(broadcastId)) as unknown as MonitorStub;
    try {
      await stub.publish({
        broadcastId,
        status: row.status as BroadcastProgress['status'],
        recipientCount: row.recipient_count,
        sentCount: row.sent_count,
        failedCount: row.failed_count,
        completedAt: row.completed_at === null ? null : toIso(row.completed_at),
        waiting: toSendWait(row),
        at: Date.now(),
      });
    } catch (error) {
      log?.('send monitor publish failed', { broadcastId, error: (error as Error).message });
    }
  }
}
