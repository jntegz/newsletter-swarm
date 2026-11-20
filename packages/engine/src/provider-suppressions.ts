/**
 * Keeps the SES account-level suppression list in step with Swarm's hard bounces. Contract:
 * docs/deliverability.md "Suppressions". Runs from the jobs worker's minute cron.
 *
 * The SES list belongs to the AWS account, so on a shared install every workspace sends through
 * it. What goes on it is therefore only what is true of the address for everyone: a hard bounce
 * (the mailbox does not exist). A complaint is about one workspace's mail and stays in that
 * workspace. Nothing is read back from the list into workspaces: an address on it is learned
 * when a workspace sends to it, because SES refuses the send and reports a permanent bounce
 * with subtype OnAccountSuppressionList, which feedback.ts suppresses in the sending workspace
 * only. So one workspace's bounce or complaint never changes another workspace's Members, and a
 * workspace can't tell from the list what another workspace holds.
 *
 * `syncProviderSuppressions`: due provider_suppression_sync rows (queued by feedback.ts for hard
 * bounces, and by suppressions.ts when an operator removes a hard bounce) are applied with
 * Put/DeleteSuppressedDestination. Both are idempotent, so a row applied twice is harmless. Each
 * row is leased before the call, so overlapping runs don't race. Provider errors are retried with
 * backoff up to MAX_ATTEMPTS; rejections (and the last retry) leave the row 'failed' with the
 * error. A removal is applied whatever other workspaces hold: each workspace's own suppression
 * keeps stopping its own sends. Complaint rows queued before complaints stopped going to SES are
 * dropped without a call.
 *
 * With no provider list (Resend) the sync only discards what is queued, so no row waits or fails
 * and no address goes to AWS.
 */
import { SesError, type SuppressionList } from '@swarm/mail';
import { all, first, run } from './db';

const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
/** Rows per run (SES allows about one suppression call a second by default). */
const SYNC_BATCH = 25;
/** Rows discarded per run when there is no provider list. */
const DISCARD_BATCH = 1000;

/** 30 s, 1 min, 2 min … capped at 1 hour. */
export const providerSyncBackoffMs = (attempts: number) =>
  Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));

const retryable = (error: unknown) => !(error instanceof SesError) || error.retryable;

interface SyncRow {
  email: string;
  action: 'put' | 'delete';
  reason: 'BOUNCE' | 'COMPLAINT' | null;
  attempts: number;
  updated_at: number;
}

export async function syncProviderSuppressions(
  db: D1Database,
  provider: SuppressionList | null,
  now = Date.now(),
): Promise<{ applied: number; skipped: number; retrying: number; failed: number }> {
  const result = { applied: 0, skipped: 0, retrying: 0, failed: 0 };
  if (!provider) {
    // Every status: this also clears rows left 'failed' by earlier attempts to reach SES.
    const { meta } = await db
      .prepare(
        `DELETE FROM provider_suppression_sync WHERE email IN
           (SELECT email FROM provider_suppression_sync LIMIT ${DISCARD_BATCH})`,
      )
      .run();
    return { ...result, skipped: meta.changes };
  }
  const due = await all<{ email: string }>(
    db,
    `SELECT email FROM provider_suppression_sync
      WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ${SYNC_BATCH}`,
    now,
  );
  for (const { email } of due) {
    // Lease: push next_attempt_at out, so another run skips the row while this one works on it.
    const row = await first<SyncRow>(
      db,
      `UPDATE provider_suppression_sync SET next_attempt_at = ?1
        WHERE email = ?2 AND status = 'pending' AND next_attempt_at <= ?3
        RETURNING email, action, reason, attempts, updated_at`,
      now + LEASE_MS,
      email,
      now,
    );
    if (!row) continue;
    // Done only if nothing newer was queued for the address meanwhile (updated_at changes).
    const done = () =>
      run(
        db,
        'DELETE FROM provider_suppression_sync WHERE email = ?1 AND updated_at = ?2',
        row.email,
        row.updated_at,
      );
    // A complaint is the complaining workspace's matter, not the whole account's.
    if (row.action === 'put' && row.reason !== 'BOUNCE') {
      await done();
      result.skipped++;
      continue;
    }
    try {
      if (row.action === 'put') {
        await provider.putSuppressed(row.email, 'BOUNCE');
      } else {
        await provider.deleteSuppressed(row.email);
      }
      await done();
      result.applied++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const again = retryable(error) && attempts < MAX_ATTEMPTS;
      await run(
        db,
        `UPDATE provider_suppression_sync SET attempts = ?1, status = ?2, next_attempt_at = ?3,
                last_error = ?4
          WHERE email = ?5 AND updated_at = ?6`,
        attempts,
        again ? 'pending' : 'failed',
        now + providerSyncBackoffMs(attempts),
        ((error as Error).message ?? String(error)).slice(0, 500),
        row.email,
        row.updated_at,
      );
      if (again) result.retrying++;
      else result.failed++;
    }
  }
  return result;
}
