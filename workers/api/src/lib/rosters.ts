// Rosters (Phase 8, flag rosters): the reads and writes behind the dashboard routes
// (routes/rosters.ts) and /v2 (v2/rosters.ts). Callers have checked Channel access (or the API
// scope) first; these check the flag, keep every row inside the Channel and audit. Contract:
// docs/rosters.md.
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  ROSTERS_MAX,
  newId,
  type CreateRoster,
  type Roster,
  type RosterAudience,
  type RosterMember,
  type RosterSource,
  type RosterStatus,
  type UpdateRoster,
} from '@swarm/domain';
import { applyRosterChanges, leftByMember, liveRosterIds } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { actorAudit, type Actor } from './actor';
import { appendAudit } from './audit';
import { env, type AppContext } from './context';
import { flagEnabled } from './site';

export const ROSTERS_OFF = 'Rosters are not turned on for this publication.';

/** Refuses with feature_disabled (404) when the rosters flag is off for the Channel. */
export async function requireRosters(
  c: AppContext,
  scope: { workspaceId: string; channelId: string },
): Promise<void> {
  if (!(await flagEnabled(c, scope, 'rosters')))
    throw new ApiError('feature_disabled', ROSTERS_OFF);
}

interface RosterRow {
  id: string;
  channel_id: string;
  name: string;
  description: string | null;
  member_center: number;
  created_at: number;
  updated_at: number;
  subscribed: number;
  active: number;
}

const ROSTER_SELECT = `SELECT r.id, r.channel_id, r.name, r.description, r.member_center, r.created_at, r.updated_at,
       (SELECT count(*) FROM roster_members rm WHERE rm.roster_id = r.id AND rm.status = 'subscribed') AS subscribed,
       (SELECT count(*) FROM roster_members rm JOIN members m ON m.id = rm.member_id
         WHERE rm.roster_id = r.id AND rm.status = 'subscribed' AND m.status = 'active') AS active
  FROM rosters r`;

const toRoster = (row: RosterRow): Roster => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  description: row.description,
  memberCenter: row.member_center === 1,
  subscribedCount: row.subscribed,
  activeCount: row.active,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export async function listRosters(db: D1Database, channelId: string): Promise<Roster[]> {
  const rows = await all<RosterRow>(
    db,
    `${ROSTER_SELECT} WHERE r.channel_id = ?1 AND r.deleted_at IS NULL ORDER BY r.name COLLATE NOCASE`,
    channelId,
  );
  return rows.map(toRoster);
}

/** A live Roster of the Channel; 404 otherwise (another Channel's Roster is never revealed). */
export async function requireRoster(
  db: D1Database,
  channelId: string,
  rosterId: string,
): Promise<Roster> {
  const row = await first<RosterRow>(
    db,
    `${ROSTER_SELECT} WHERE r.id = ?1 AND r.channel_id = ?2 AND r.deleted_at IS NULL`,
    rosterId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Roster not found.');
  return toRoster(row);
}

const nameTaken = (error: unknown): never => {
  if (isUniqueViolation(error)) {
    throw new ApiError('conflict', 'Another Roster in this publication has this name.', [
      { path: 'name', message: 'Another Roster in this publication has this name.' },
    ]);
  }
  throw error;
};

export async function createRoster(
  db: D1Database,
  actor: Actor,
  channelId: string,
  input: CreateRoster,
): Promise<Roster> {
  const count = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM rosters WHERE channel_id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if ((count?.n ?? 0) >= ROSTERS_MAX) {
    throw new ApiError(
      'conflict',
      `A publication can have ${ROSTERS_MAX} Rosters. Delete one first.`,
    );
  }
  const id = newId('roster');
  const now = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO rosters (id, channel_id, name, description, member_center, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(
        id,
        channelId,
        input.name,
        input.description ?? null,
        input.memberCenter === false ? 0 : 1,
        now,
      )
      .run();
  } catch (error) {
    nameTaken(error);
  }
  await appendAudit(
    db,
    actorAudit(actor, {
      action: 'roster.created',
      targetType: 'roster',
      targetId: id,
      metadata: { channelId, name: input.name },
    }),
  );
  return requireRoster(db, channelId, id);
}

export async function updateRoster(
  db: D1Database,
  actor: Actor,
  channelId: string,
  rosterId: string,
  input: UpdateRoster,
): Promise<Roster> {
  const current = await requireRoster(db, channelId, rosterId);
  try {
    await db
      .prepare(
        `UPDATE rosters SET name = ?1, description = ?2, member_center = ?3, updated_at = ?4
          WHERE id = ?5 AND deleted_at IS NULL`,
      )
      .bind(
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description,
        (input.memberCenter ?? current.memberCenter) ? 1 : 0,
        Date.now(),
        rosterId,
      )
      .run();
  } catch (error) {
    nameTaken(error);
  }
  await appendAudit(
    db,
    actorAudit(actor, {
      action: 'roster.changed',
      targetType: 'roster',
      targetId: rosterId,
      metadata: { channelId, fields: Object.keys(input) },
    }),
  );
  return requireRoster(db, channelId, rosterId);
}

/** Hides the Roster; memberships stay, so a Broadcast already sending to it can finish. */
export async function deleteRoster(
  db: D1Database,
  actor: Actor,
  channelId: string,
  rosterId: string,
): Promise<void> {
  const roster = await requireRoster(db, channelId, rosterId);
  const now = Date.now();
  await db
    .prepare('UPDATE rosters SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2')
    .bind(now, rosterId)
    .run();
  await appendAudit(
    db,
    actorAudit(actor, {
      action: 'roster.deleted',
      targetType: 'roster',
      targetId: rosterId,
      metadata: { channelId, name: roster.name },
    }),
  );
}

// ---- Memberships -----------------------------------------------------------------------------

/** A page of a Roster's memberships, most recently changed first. Cursor: `<updated_at>:<member>`. */
export async function rosterMembers(
  db: D1Database,
  rosterId: string,
  options: { status?: RosterStatus | undefined; after?: string | undefined; limit: number },
): Promise<{ items: RosterMember[]; next: string | null }> {
  let afterAt: number | null = null;
  let afterId: string | null = null;
  if (options.after !== undefined) {
    const match = /^(\d{1,15}):(mb_[0-9a-f]{32})$/.exec(options.after);
    if (!match) throw new ApiError('invalid_input', 'That page cursor is not valid.');
    afterAt = Number(match[1]);
    afterId = match[2] as string;
  }
  const rows = await all<{
    member_id: string;
    email: string;
    member_status: string;
    status: RosterStatus;
    source: RosterSource;
    subscribed_at: number | null;
    unsubscribed_at: number | null;
    updated_at: number;
  }>(
    db,
    `SELECT rm.member_id, m.email, m.status AS member_status, rm.status, rm.source, rm.subscribed_at,
            rm.unsubscribed_at, rm.updated_at
       FROM roster_members rm JOIN members m ON m.id = rm.member_id
      WHERE rm.roster_id = ?1 AND (?2 IS NULL OR rm.status = ?2)
        AND (?3 IS NULL OR rm.updated_at < ?3 OR (rm.updated_at = ?3 AND rm.member_id < ?4))
      ORDER BY rm.updated_at DESC, rm.member_id DESC LIMIT ?5`,
    rosterId,
    options.status ?? null,
    afterAt,
    afterId,
    options.limit + 1,
  );
  const items = rows.slice(0, options.limit).map((r) => ({
    memberId: r.member_id,
    email: r.email,
    memberStatus: r.member_status,
    status: r.status,
    source: r.source,
    subscribedAt: r.subscribed_at === null ? null : toIso(r.subscribed_at),
    unsubscribedAt: r.unsubscribed_at === null ? null : toIso(r.unsubscribed_at),
    updatedAt: toIso(r.updated_at),
  }));
  const last = rows.length > options.limit ? rows[options.limit - 1] : undefined;
  return { items, next: last ? `${last.updated_at}:${last.member_id}` : null };
}

/**
 * An operator or API caller subscribes or unsubscribes one Member. Subscribing a Member who left
 * the Roster themselves is refused (409): only they can rejoin.
 */
export async function setMembership(
  db: D1Database,
  actor: Actor,
  channelId: string,
  rosterId: string,
  memberId: string,
  status: RosterStatus,
): Promise<void> {
  await requireRoster(db, channelId, rosterId);
  if (status === 'subscribed' && (await leftByMember(db, rosterId, memberId))) {
    throw new ApiError(
      'conflict',
      'This subscriber left the Roster themselves. Only they can join it again, from their subscriber settings.',
    );
  }
  const source: RosterSource = actor.via ? 'api' : 'operator';
  await applyRosterChanges(db, [{ rosterId, memberId, status, source, mode: 'respect' }]);
  await appendAudit(
    db,
    actorAudit(actor, {
      action: status === 'subscribed' ? 'roster.member_added' : 'roster.member_removed',
      targetType: 'member',
      targetId: memberId,
      metadata: { channelId, rosterId },
    }),
  );
}

// ---- Audiences -------------------------------------------------------------------------------

/**
 * Checks the Roster part of an audience before it is saved: the flag is on and every Roster is
 * a live Roster of the Channel. Returns the part to store, or null when it names no Roster.
 */
export async function checkRosterAudience(
  c: AppContext,
  scope: { workspaceId: string; channelId: string },
  rosters: RosterAudience | undefined,
): Promise<RosterAudience | null> {
  if (!rosters || (!rosters.include.length && !rosters.exclude.length)) return null;
  await requireRosters(c, scope);
  const wanted = [...rosters.include, ...rosters.exclude];
  const live = await liveRosterIds(env(c).DB, scope.channelId, wanted);
  if (wanted.some((id) => !live.has(id))) {
    throw new ApiError('invalid_input', 'Choose Rosters from this publication.', [
      { path: 'audience.rosters', message: 'Choose Rosters from this publication.' },
    ]);
  }
  return { include: rosters.include, exclude: rosters.exclude, conflict: rosters.conflict };
}

/** A Capture Form config's Rosters: flag on and live in the Channel. */
export async function checkFormRosters(
  c: AppContext,
  scope: { workspaceId: string; channelId: string },
  rosterIds: readonly string[] | undefined,
): Promise<void> {
  if (!rosterIds?.length) return;
  await requireRosters(c, scope);
  const live = await liveRosterIds(env(c).DB, scope.channelId, rosterIds);
  if (rosterIds.some((id) => !live.has(id))) {
    throw new ApiError('invalid_input', 'Choose Rosters from this publication.', [
      { path: 'config.rosterIds', message: 'Choose Rosters from this publication.' },
    ]);
  }
}
