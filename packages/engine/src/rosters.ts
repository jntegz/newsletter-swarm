/**
 * Rosters (Phase 8, flag rosters): several opt-in lists per Channel. Contract: docs/rosters.md.
 *
 * - Memberships change only through `rosterChangeStatements`, which puts the member event first
 *   (written only when the status really changes) and the write after it, in one batch. The
 *   statements join the Roster and the Member on the Channel, so a Roster of another Channel
 *   (or a deleted one, when joining) changes nothing.
 * - The audience part (`rosterAudienceSql`) is compiled into the same predicate as the Circles
 *   (circles.ts compileAudience), so preflight, the snapshot and the count agree.
 * - The flag is read here with `rostersEnabled`, so the capture, track and events workers apply
 *   it the same way the API does.
 */
import {
  MEMBER_LEFT_SOURCES,
  hasRosters,
  type RosterAudience,
  type RosterMembership,
  type RosterOverlap,
  type RosterSource,
  type RosterStatus,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { all, first, toIso } from './db';

const LEFT = MEMBER_LEFT_SOURCES.map((s) => `'${s}'`).join(', ');

/** Whether the rosters flag is on for a Channel (platform → workspace → Channel overrides). */
export async function rostersEnabled(db: D1Database, channelId: string): Promise<boolean> {
  const channel = await first<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM channels WHERE id = ?1',
    channelId,
  );
  if (!channel) return false;
  return new FlagService(new D1FlagStore(db)).enabled('rosters', {
    workspaceId: channel.workspace_id,
    channelId,
  });
}

/** The ids of `ids` that are live Rosters of the Channel. */
export async function liveRosterIds(
  db: D1Database,
  channelId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM rosters
      WHERE channel_id = ?1 AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(ids),
  );
  return new Set(rows.map((r) => r.id));
}

// ---- Audiences -------------------------------------------------------------------------------

/** Reads a stored audience's Roster part; null when there is none. */
export function parseRosterAudience(value: unknown): RosterAudience | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RosterAudience>;
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  const rosters: RosterAudience = {
    include: ids(raw.include),
    exclude: ids(raw.exclude),
    conflict: raw.conflict === 'include_wins' ? 'include_wins' : 'exclude_wins',
  };
  return hasRosters(rosters) ? rosters : null;
}

/** Subscribed to any of the Rosters `list(ids)` yields, as an expression over `members m`. */
const subscribedTo = (list: string) =>
  `EXISTS (SELECT 1 FROM roster_members rm
            WHERE rm.member_id = m.id AND rm.status = 'subscribed' AND rm.roster_id IN ${list})`;

/**
 * The Roster part of an audience over `members m`, or null when it has none. `list` binds an id
 * list (CircleValues.list), so every value goes through the audience's one JSON parameter.
 * Included: subscribed to one of them. Excluded: subscribed to none of them, except that under
 * include_wins a Member on an included Roster stays in (so excluded Rosters change nothing then).
 */
export function rosterAudienceSql(
  rosters: RosterAudience | null | undefined,
  list: (ids: readonly string[]) => string,
): string | null {
  if (!hasRosters(rosters)) return null;
  const parts: string[] = [];
  if (rosters.include.length) parts.push(subscribedTo(list(rosters.include)));
  const excludeApplies =
    rosters.exclude.length > 0 && !(rosters.include.length && rosters.conflict === 'include_wins');
  if (excludeApplies) parts.push(`NOT ${subscribedTo(list(rosters.exclude))}`);
  return parts.length ? parts.join(' AND ') : '1';
}

/** Counts for an audience's Roster part among active, unsuppressed Members (the conflict UI). */
export async function rosterOverlap(
  db: D1Database,
  channelId: string,
  workspaceId: string,
  rosters: RosterAudience,
): Promise<RosterOverlap> {
  const inList = (n: number) => subscribedTo(`(SELECT value FROM json_each(?${n}))`);
  const row = await first<{ included: number; excluded: number; conflicts: number }>(
    db,
    `SELECT coalesce(sum(i), 0) AS included, coalesce(sum(x), 0) AS excluded,
            coalesce(sum(i AND x), 0) AS conflicts
       FROM (SELECT ${inList(3)} AS i, ${inList(4)} AS x FROM members m
              WHERE m.channel_id = ?1 AND m.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?2 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id)))`,
    channelId,
    workspaceId,
    JSON.stringify(rosters.include),
    JSON.stringify(rosters.exclude),
  );
  const included = row?.included ?? 0;
  const excluded = row?.excluded ?? 0;
  const conflicts = row?.conflicts ?? 0;
  let recipients: number;
  if (rosters.include.length) {
    recipients = rosters.conflict === 'include_wins' ? included : included - conflicts;
  } else {
    const all = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM members m WHERE m.channel_id = ?1 AND m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?2 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))`,
      channelId,
      workspaceId,
    );
    recipients = (all?.n ?? 0) - excluded;
  }
  return { included, excluded, conflicts, recipients };
}

// ---- Membership changes ----------------------------------------------------------------------

/**
 * How a subscribe treats an existing row:
 * - 'set': subscribes whatever the row says (the Member asked: Member Center, form confirm);
 * - 'respect': leaves a row alone when the Member left themselves (operators, the API);
 * - 'new_only': only adds a missing row (imports: never re-adds anyone who left).
 */
export type RosterJoinMode = 'set' | 'respect' | 'new_only';

export interface RosterChange {
  rosterId: string;
  memberId: string;
  status: RosterStatus;
  source: RosterSource;
  mode?: RosterJoinMode;
}

/** The event (only when the status changes), then the write, for one membership change. */
export function rosterChangeStatements(
  db: D1Database,
  change: RosterChange,
  now: number = Date.now(),
): D1PreparedStatement[] {
  const { rosterId, memberId, source } = change;
  if (change.status === 'unsubscribed') {
    return [
      db
        .prepare(
          `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
           SELECT m.channel_id, m.id, 'roster_left', json_object('rosterId', ?1, 'source', ?3), ?4
             FROM members m
            WHERE m.id = ?2 AND EXISTS (SELECT 1 FROM roster_members rm
                                         WHERE rm.roster_id = ?1 AND rm.member_id = ?2 AND rm.status = 'subscribed')`,
        )
        .bind(rosterId, memberId, source, now),
      db
        .prepare(
          `UPDATE roster_members SET status = 'unsubscribed', source = ?3, unsubscribed_at = ?4, updated_at = ?4
            WHERE roster_id = ?1 AND member_id = ?2 AND status = 'subscribed'`,
        )
        .bind(rosterId, memberId, source, now),
    ];
  }
  const mode = change.mode ?? 'set';
  // Rows that block the change: already subscribed, any row (new_only), or left by the Member.
  const blocking =
    mode === 'new_only'
      ? '1'
      : mode === 'respect'
        ? `(rm.status = 'subscribed' OR rm.source IN (${LEFT}))`
        : `rm.status = 'subscribed'`;
  const onConflict =
    mode === 'new_only'
      ? 'DO NOTHING'
      : `DO UPDATE SET status = 'subscribed', source = excluded.source,
            subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL, updated_at = excluded.updated_at
          WHERE roster_members.status <> 'subscribed'${
            mode === 'respect' ? ` AND roster_members.source NOT IN (${LEFT})` : ''
          }`;
  return [
    db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT m.channel_id, m.id, 'roster_joined', json_object('rosterId', r.id, 'source', ?3), ?4
           FROM members m JOIN rosters r ON r.channel_id = m.channel_id
          WHERE m.id = ?2 AND r.id = ?1 AND r.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM roster_members rm
                             WHERE rm.roster_id = ?1 AND rm.member_id = ?2 AND ${blocking})`,
      )
      .bind(rosterId, memberId, source, now),
    db
      .prepare(
        `INSERT INTO roster_members (roster_id, member_id, status, source, subscribed_at, created_at, updated_at)
         SELECT r.id, m.id, 'subscribed', ?3, ?4, ?4, ?4
           FROM rosters r JOIN members m ON m.channel_id = r.channel_id
          WHERE r.id = ?1 AND m.id = ?2 AND r.deleted_at IS NULL
         ON CONFLICT (roster_id, member_id) ${onConflict}`,
      )
      .bind(rosterId, memberId, source, now),
  ];
}

/** Applies several changes in one batch. */
export async function applyRosterChanges(
  db: D1Database,
  changes: readonly RosterChange[],
  now: number = Date.now(),
): Promise<void> {
  const statements = changes.flatMap((change) => rosterChangeStatements(db, change, now));
  if (statements.length) await db.batch(statements);
}

interface MembershipRow {
  roster_id: string;
  roster_name: string;
  status: RosterStatus;
  source: RosterSource;
  subscribed_at: number | null;
  unsubscribed_at: number | null;
  updated_at: number;
}

const toMembership = (row: MembershipRow): RosterMembership => ({
  rosterId: row.roster_id,
  rosterName: row.roster_name,
  status: row.status,
  source: row.source,
  subscribedAt: row.subscribed_at === null ? null : toIso(row.subscribed_at),
  unsubscribedAt: row.unsubscribed_at === null ? null : toIso(row.unsubscribed_at),
  updatedAt: toIso(row.updated_at),
});

/** A Member's rows on the live Rosters of their Channel, by Roster name. */
export async function memberRosters(db: D1Database, memberId: string): Promise<RosterMembership[]> {
  const rows = await all<MembershipRow>(
    db,
    `SELECT rm.roster_id, r.name AS roster_name, rm.status, rm.source, rm.subscribed_at,
            rm.unsubscribed_at, rm.updated_at
       FROM roster_members rm JOIN rosters r ON r.id = rm.roster_id
      WHERE rm.member_id = ?1 AND r.deleted_at IS NULL
      ORDER BY r.name COLLATE NOCASE`,
    memberId,
  );
  return rows.map(toMembership);
}

/** Whether the Member left this Roster themselves, so only they can rejoin it. */
export async function leftByMember(
  db: D1Database,
  rosterId: string,
  memberId: string,
): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 FROM roster_members WHERE roster_id = ?1 AND member_id = ?2
        AND status = 'unsubscribed' AND source IN (${LEFT})`,
    rosterId,
    memberId,
  );
  return row !== null;
}

// ---- Capture Forms ---------------------------------------------------------------------------

/**
 * Joins a form's Rosters (source 'form') when the flag is on: the published config's rosterIds
 * that are live Rosters of the Member's Channel. Called for a new single opt-in Member and when
 * a confirm request made from the form is confirmed. Returns how many Rosters were named.
 */
export async function joinFormRosters(
  db: D1Database,
  memberId: string,
  formId: string,
  now: number = Date.now(),
): Promise<number> {
  const form = await first<{ channel_id: string; roster_ids: string | null }>(
    db,
    `SELECT f.channel_id, json_extract(f.published_config_json, '$.rosterIds') AS roster_ids
       FROM capture_forms f JOIN members m ON m.channel_id = f.channel_id
      WHERE f.id = ?1 AND m.id = ?2`,
    formId,
    memberId,
  );
  if (!form?.roster_ids) return 0;
  const ids = (JSON.parse(form.roster_ids) as unknown[]).filter(
    (id): id is string => typeof id === 'string',
  );
  if (!ids.length || !(await rostersEnabled(db, form.channel_id))) return 0;
  await applyRosterChanges(
    db,
    ids.map((rosterId) => ({ rosterId, memberId, status: 'subscribed', source: 'form' })),
    now,
  );
  return ids.length;
}

// ---- Member Center ---------------------------------------------------------------------------

export interface CenterRoster {
  id: string;
  name: string;
  description: string | null;
  subscribed: boolean;
}

/** The Rosters the Member Center lists (flag on, memberCenter on), with the Member's status. */
export async function memberCenterRosters(
  db: D1Database,
  channelId: string,
  memberId: string,
): Promise<CenterRoster[]> {
  if (!(await rostersEnabled(db, channelId))) return [];
  const rows = await all<{
    id: string;
    name: string;
    description: string | null;
    subscribed: number;
  }>(
    db,
    `SELECT r.id, r.name, r.description,
            EXISTS (SELECT 1 FROM roster_members rm
                     WHERE rm.roster_id = r.id AND rm.member_id = ?2 AND rm.status = 'subscribed') AS subscribed
       FROM rosters r
      WHERE r.channel_id = ?1 AND r.deleted_at IS NULL AND r.member_center = 1
      ORDER BY r.name COLLATE NOCASE`,
    channelId,
    memberId,
  );
  return rows.map((r) => ({ ...r, subscribed: r.subscribed === 1 }));
}

/**
 * The Member Center's Rosters form: joins the ticked Rosters and leaves the unticked ones the
 * page listed. Only Rosters the page can list are touched; anything else posted is ignored.
 */
export async function saveMemberCenterRosters(
  db: D1Database,
  channelId: string,
  memberId: string,
  ticked: readonly string[],
  now: number = Date.now(),
): Promise<boolean> {
  const listed = await memberCenterRosters(db, channelId, memberId);
  if (!listed.length) return false;
  const chosen = new Set(ticked);
  await applyRosterChanges(
    db,
    listed
      .filter((r) => chosen.has(r.id) !== r.subscribed)
      .map((r) => ({
        rosterId: r.id,
        memberId,
        status: chosen.has(r.id) ? 'subscribed' : 'unsubscribed',
        source: 'member',
      })),
    now,
  );
  return true;
}

// ---- Unsubscribe links -----------------------------------------------------------------------

export interface RosterUnsubscribe {
  memberId: string;
  /** The Broadcast's included Rosters (live or not), with names for the page. */
  rosters: { id: string; name: string }[];
}

/**
 * What an unsubscribe link of a Roster-targeted Broadcast leaves: the included Rosters of the
 * frozen audience. Null when the Broadcast includes no Roster, the delivery has no Member, or
 * the flag is off now (then the link unsubscribes from the Channel, as without Rosters).
 */
export async function rosterUnsubscribePlan(
  db: D1Database,
  deliveryId: string,
  now = Date.now(),
): Promise<RosterUnsubscribe | null> {
  const row = await first<{
    member_id: string | null;
    channel_id: string;
    included: string | null;
  }>(
    db,
    // Past engagement retention the Member comes from the withdrawal-only reference (retention.ts).
    `SELECT coalesce(d.member_id,
              (SELECT r.member_id FROM unsubscribe_refs r WHERE r.delivery_id = d.id AND r.expires_at > ?2))
              AS member_id,
            d.channel_id, json_extract(b.audience_json, '$.rosters.include') AS included
       FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id
      WHERE d.id = ?1`,
    deliveryId,
    now,
  );
  if (!row?.member_id || !row.included) return null;
  const ids = (JSON.parse(row.included) as unknown[]).filter(
    (id): id is string => typeof id === 'string',
  );
  if (!ids.length || !(await rostersEnabled(db, row.channel_id))) return null;
  const rosters = await all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM rosters WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))
      ORDER BY name COLLATE NOCASE`,
    row.channel_id,
    JSON.stringify(ids),
  );
  return rosters.length ? { memberId: row.member_id, rosters } : null;
}
