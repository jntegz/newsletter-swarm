import type { SeatRole } from '@swarm/domain';

/** Integer milliseconds (database) → ISO 8601 string (API). */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Runs a statement again when that is safe, so that a moment of D1 failure doesn't cost someone
 * their one-time sign-in link or a one-click unsubscribe. A SELECT runs again after any transient
 * failure. Anything else, `UPDATE … RETURNING` through `first` or `all` included, may have gone
 * through, so it runs again only when the database was busy, which says nothing was written.
 */
function retrySafely<T>(sql: string, work: () => Promise<T>): Promise<T> {
  return /^\s*SELECT\b/i.test(sql) ? retryRead(work, 4, 50) : retryWhileBusy(work, 4, 50);
}

export async function first<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return retrySafely(sql, () =>
    db
      .prepare(sql)
      .bind(...params)
      .first<T>(),
  );
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await retrySafely(sql, () =>
    db
      .prepare(sql)
      .bind(...params)
      .all<T>(),
  );
  return results;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return retrySafely(sql, () =>
    db
      .prepare(sql)
      .bind(...params)
      .run(),
  );
}

/** Runs statements atomically. Use for any write that touches more than one row or table. */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  // A batch is one transaction: when the database is busy, none of it was written.
  await retryWhileBusy(() => db.batch(statements), 4, 50);
}

/** The database refused the statement because another writer held it: nothing was written. */
const BUSY_D1 = /database is locked|SQLITE_BUSY/i;
/** D1's own transient failures, when a read can safely run again. */
const TRANSIENT_D1 = /D1_ERROR:.*internal error|Network connection lost|object to be reset/i;

async function retryOn<T>(
  pattern: RegExp,
  work: () => Promise<T>,
  attempts: number,
  waitMs: number,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const again = error instanceof Error && pattern.test(error.message);
      if (!again || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
    }
  }
}

/**
 * Runs a read again when D1 fails for a moment. For reads on a public page, where one failure
 * shows a visitor a broken form. Never wrap a write: it may have gone through. Locally this also
 * covers `wrangler dev`'s workers sharing one SQLite file, where a read right after another
 * process commits can fail with "Failed to get session commit token: internal error".
 */
export function retryRead<T>(read: () => Promise<T>, attempts = 6, waitMs = 100): Promise<T> {
  return retryOn(
    new RegExp(`${TRANSIENT_D1.source}|${BUSY_D1.source}`, 'i'),
    read,
    attempts,
    waitMs,
  );
}

/**
 * Runs work again only when the database was busy, the one failure that says nothing was written.
 * The work must cope with being run again after its earlier statements committed.
 */
export function retryWhileBusy<T>(work: () => Promise<T>, attempts = 5, waitMs = 100): Promise<T> {
  return retryOn(BUSY_D1, work, attempts, waitMs);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

const ROLE_RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

export function roleAtLeast(role: SeatRole, minimum: SeatRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** The operator's seat role in a workspace, or null when they have no seat there. */
export async function workspaceRole(
  db: D1Database,
  operatorId: string,
  workspaceId: string,
): Promise<SeatRole | null> {
  const row = await first<{ role: SeatRole }>(
    db,
    'SELECT role FROM seats WHERE workspace_id = ?1 AND operator_id = ?2',
    workspaceId,
    operatorId,
  );
  return row?.role ?? null;
}

export interface ChannelAccess {
  channelId: string;
  workspaceId: string;
  role: SeatRole;
  deleted: boolean;
}

/**
 * The lower of two roles. A per-Channel role only ever restricts a seat: the effective role on a
 * Channel is the lower of the workspace seat role and the Channel role.
 */
export function lowerRole(a: SeatRole, b: SeatRole | null | undefined): SeatRole {
  if (!b) return a;
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/**
 * The single tenancy check for Channels. Resolves the operator's effective role: the seat role,
 * lowered by a per-Channel role when one exists (an override never raises a seat above its
 * workspace role, least privilege). Returns null when the
 * operator has no seat in the Channel's workspace, so callers answer 404 and a
 * Channel in another workspace is indistinguishable from one that does not exist.
 */
export async function channelAccess(
  db: D1Database,
  operatorId: string,
  channelId: string,
): Promise<ChannelAccess | null> {
  const row = await first<{
    workspaceId: string;
    seatRole: SeatRole;
    channelRole: SeatRole | null;
    deletedAt: number | null;
  }>(
    db,
    `SELECT c.workspace_id AS workspaceId, s.role AS seatRole, cr.role AS channelRole,
            c.deleted_at AS deletedAt
       FROM channels c
       JOIN seats s ON s.workspace_id = c.workspace_id AND s.operator_id = ?1
       LEFT JOIN channel_roles cr ON cr.channel_id = c.id AND cr.operator_id = ?1
      WHERE c.id = ?2`,
    operatorId,
    channelId,
  );
  if (!row) return null;
  return {
    channelId,
    workspaceId: row.workspaceId,
    role: lowerRole(row.seatRole, row.channelRole),
    deleted: row.deletedAt !== null,
  };
}

export * from './audit';
export * from './credentials';
export * from './instance-audit';
export * from './crypto';
