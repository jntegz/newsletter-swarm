/**
 * Suppressions: addresses that must not be mailed. Contract: docs/deliverability.md
 * "Suppressions".
 *
 * - Scope: workspace-wide (channel_id NULL: hard bounces, complaints, erasures, manual) or one
 *   Channel (manual only). Every send-time check is "a workspace-wide row, or a row for this
 *   Channel", in SQL `(s.channel_id IS NULL OR s.channel_id = m.channel_id)`. Unsubscribes are not suppressions: they are the Member's
 *   status in that Channel, so they never stop the workspace's other Channels.
 * - The SES account-level suppression list is kept in step through `provider_suppression_sync`
 *   (0026): our hard bounces and complaints are put there, and an operator removing one queues a
 *   removal. provider-suppressions.ts applies the queue and pulls SES-side additions back.
 */
import type { BounceCause, BounceStopRule } from '@swarm/domain';
import { bounceResetStatements, membersRestoredStatement } from './bounces';
import { first, newIdFor } from './db';

/** True when `email` is suppressed for the Channel: workspace-wide or for this Channel. */
export async function isSuppressedFor(
  db: D1Database,
  workspaceId: string,
  channelId: string,
  email: string,
): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM suppressions WHERE workspace_id = ?1 AND email = ?2
        AND (channel_id IS NULL OR channel_id = ?3) LIMIT 1`,
    workspaceId,
    email,
    channelId,
  ));
}

/** Our reasons the SES account-level list carries; soft bounces and manual rows stay ours. */
export const PROVIDER_REASONS = { hard_bounce: 'BOUNCE', complaint: 'COMPLAINT' } as const;

/**
 * Queues a change to the SES account-level suppression list. One row per address, shared by
 * every workspace: the latest intent replaces an older one and resets its retries, except that a
 * removal never replaces a queued put while any workspace still suppresses the address for a
 * bounce or complaint (one workspace's removal must not drop another's put). Run it after the
 * caller's own suppression row is deleted, in the same batch.
 */
export function providerSyncStatement(
  db: D1Database,
  email: string,
  change: { action: 'put'; reason: 'BOUNCE' | 'COMPLAINT' } | { action: 'delete' },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO provider_suppression_sync (email, action, reason, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET action = excluded.action, reason = excluded.reason,
              status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at,
              last_error = NULL, updated_at = excluded.updated_at
        WHERE excluded.action = 'put' OR provider_suppression_sync.action = 'delete'
           OR NOT EXISTS (SELECT 1 FROM suppressions WHERE email = excluded.email
                           AND channel_id IS NULL AND reason IN ('hard_bounce', 'complaint'))`,
    )
    .bind(email.toLowerCase(), change.action, change.action === 'put' ? change.reason : null, now);
}

export interface SuppressionRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  email: string;
  email_hash: string | null;
  reason: 'hard_bounce' | 'soft_bounce' | 'complaint' | 'manual';
  detail: string | null;
  /** Set when the bounce rules stopped mailing the address (0067). */
  bounce_rule: BounceStopRule | null;
  bounce_cause: BounceCause | null;
  bounce_counted: number | null;
  bounce_days: number | null;
  created_at: number;
}

export class SuppressionError extends Error {
  constructor(
    readonly code: 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'SuppressionError';
  }
}

/**
 * An operator's suppression: workspace-wide (`channelId` null) or for one Channel. Adding an
 * address that is already suppressed in that scope returns the existing row. Member statuses
 * don't change: the send-time checks skip the address.
 */
export async function addManualSuppression(
  db: D1Database,
  input: {
    workspaceId: string;
    channelId: string | null;
    email: string;
    detail?: string | null;
    now?: number;
  },
): Promise<{ row: SuppressionRow; created: boolean }> {
  const now = input.now ?? Date.now();
  const email = input.email.trim().toLowerCase();
  const scope = input.channelId
    ? 'channel_id = ?3'
    : // ?3 is still bound (as NULL) so both shapes take the same parameters.
      'channel_id IS NULL AND ?3 IS NULL';
  const existing = await first<SuppressionRow>(
    db,
    `SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2 AND ${scope}`,
    input.workspaceId,
    email,
    input.channelId,
  );
  if (existing) return { row: existing, created: false };
  const id = newIdFor('suppression', now);
  await db
    .prepare(
      `INSERT INTO suppressions (id, workspace_id, channel_id, email, reason, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6) ON CONFLICT DO NOTHING`,
    )
    .bind(id, input.workspaceId, input.channelId, email, input.detail?.slice(0, 500) ?? null, now)
    .run();
  const row = await first<SuppressionRow>(
    db,
    `SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2 AND ${scope}`,
    input.workspaceId,
    email,
    input.channelId,
  );
  if (!row) throw new Error('suppression was not created');
  return { row, created: row.id === id };
}

/**
 * An operator removes a suppression. Complaints stay (the Member asked not to be mailed) and so
 * do erasures (the address is only a hash). Removing a hard bounce also queues its removal from
 * the SES account-level list, whatever other workspaces hold: their own suppressions keep
 * stopping their sends, and skipping it would tell this workspace that another one holds the
 * address. Removing a bounce (the admin fixed the address) gives the workspace's Members of it
 * back the status they had before the bounce, and the bounce counts start again from zero
 * (bounces.ts). Returns how many Members came back.
 */
export async function removeSuppression(
  db: D1Database,
  row: SuppressionRow,
  now = Date.now(),
): Promise<{ restored: number }> {
  if (row.email_hash) {
    throw new SuppressionError('conflict', 'This address was erased, so it stays suppressed.');
  }
  if (row.reason === 'complaint') {
    throw new SuppressionError(
      'conflict',
      'This address marked a post as spam, so it stays suppressed.',
    );
  }
  const bounce =
    row.channel_id === null && (row.reason === 'hard_bounce' || row.reason === 'soft_bounce');
  const results = await db.batch([
    db.prepare('DELETE FROM suppressions WHERE id = ?1').bind(row.id),
    // Bounces start counting again from zero.
    ...bounceResetStatements(db, row.workspace_id, row.email),
    ...(row.reason === 'hard_bounce'
      ? [providerSyncStatement(db, row.email, { action: 'delete' }, now)]
      : []),
    ...(bounce ? [membersRestoredStatement(db, row.workspace_id, row.email, now)] : []),
  ]);
  return { restored: bounce ? (results.at(-1)?.meta.changes ?? 0) : 0 };
}
