/**
 * The member event bus (Phase 6): an append-only log in `member_events` that every Flow trigger
 * reads. Writers append; the Flows engine (flows.ts, `enrollFromEvents`) drains unprocessed rows
 * in `seq` order and stamps `processed_at`.
 *
 * CONTRACT
 * - Every event names a Member; the Channel is taken from the Member row inside the INSERT, so
 *   an event for a deleted Member is silently dropped (never a foreign-key error) and, when the
 *   caller passes `channelId`, an event whose Member is in another Channel is dropped too.
 * - Writes are cheap, fire-and-forget appends. Where a write already happens in a `db.batch`,
 *   add the *Statement form to the same batch so the event commits with the change it describes.
 * - The conditional helpers (tags, fields) are placed BEFORE the write they describe in the
 *   batch: they compare against the old state, so a no-op change emits nothing.
 * - Payloads are MemberEventPayloads in @swarm/domain (p6-flows.ts). Values of profile fields are
 *   never copied into the log.
 * - Emitters today: subscribe (member_joined, form_submitted, confirmed), confirmRequest
 *   (confirmed), checkout buyers (member_joined), Gift Pass claims (member_joined, confirmed),
 *   operator create and imports (member_joined), tagStatements / bulk untag (tag_added, tag_removed),
 *   fieldValueStatements / Member Center (field_changed), Circle refresh (circle_entered,
 *   circle_exited), recomputeEntitlement (level_purchased, level_canceled), recordClick
 *   (link_clicked, human only), recordOpen (email_opened, Flow emails only), the site's Dispatch
 *   page (gate_hit, signed-in readers), recordAskAnswers in asks.ts (ask_answered),
 *   rosterChangeStatements in rosters.ts (roster_joined, roster_left; Phase 8), countReferrals,
 *   reviewReferral and checkMilestones in champions.ts (referral_succeeded, referral_milestone).
 *   Still to come: unengaged (daily check in flows.ts), api_event (Phase 7).
 */
import { MEMBER_EVENT_TYPES, type MemberEventPayloads, type MemberEventType } from '@swarm/domain';
import { all, run } from './db';
import type { StoredValue } from './fields';

export { MEMBER_EVENT_TYPES };
export type { MemberEventPayloads, MemberEventType };

/** An event to append. `channelId`, when given, must match the Member's Channel. */
export type MemberEventInput = {
  [T in MemberEventType]: {
    type: T;
    memberId: string;
    channelId?: string;
    payload: MemberEventPayloads[T];
  };
}[MemberEventType];

/** A row of the log, as the Flows engine reads it. */
export interface MemberEventRow {
  seq: number;
  channel_id: string;
  member_id: string;
  type: MemberEventType;
  payload_json: string;
  created_at: number;
}

/** Processed events are kept this long (for run debugging), then pruned by the daily job. */
export const MEMBER_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The append, as a statement for an existing `db.batch`. */
export function memberEventStatement(
  db: D1Database,
  event: MemberEventInput,
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
       SELECT m.channel_id, m.id, ?2, ?3, ?4 FROM members m
        WHERE m.id = ?1 AND (?5 IS NULL OR m.channel_id = ?5)`,
    )
    .bind(event.memberId, event.type, JSON.stringify(event.payload), now, event.channelId ?? null);
}

/** Appends one event. */
export async function recordMemberEvent(
  db: D1Database,
  event: MemberEventInput,
  now: number = Date.now(),
): Promise<void> {
  await memberEventStatement(db, event, now).run();
}

/** Appends several events in one batch. */
export async function recordMemberEvents(
  db: D1Database,
  events: readonly MemberEventInput[],
  now: number = Date.now(),
): Promise<void> {
  if (events.length) await db.batch(events.map((event) => memberEventStatement(db, event, now)));
}

// ---- Conditional statements (placed before the write they describe) --------------------------

/** tag_added, only when the Member doesn't have the tag yet. */
export function tagAddedEventStatement(
  db: D1Database,
  memberId: string,
  tagId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
       SELECT m.channel_id, m.id, 'tag_added', json_object('tagId', ?2), ?3 FROM members m
        WHERE m.id = ?1
          AND NOT EXISTS (SELECT 1 FROM member_tags mt WHERE mt.member_id = ?1 AND mt.tag_id = ?2)`,
    )
    .bind(memberId, tagId, now);
}

/**
 * tag_removed for each tag of the Member that a delete will remove: the tags in `tagIds`
 * (mode 'only'), or every tag not in `tagIds` (mode 'except', for replace).
 */
export function tagRemovedEventStatement(
  db: D1Database,
  memberId: string,
  tagIds: readonly string[],
  mode: 'only' | 'except',
  now: number,
): D1PreparedStatement {
  const test = mode === 'only' ? 'IN' : 'NOT IN';
  return db
    .prepare(
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
       SELECT m.channel_id, m.id, 'tag_removed', json_object('tagId', mt.tag_id), ?3
         FROM member_tags mt JOIN members m ON m.id = mt.member_id
        WHERE mt.member_id = ?1 AND mt.tag_id ${test} (SELECT value FROM json_each(?2))`,
    )
    .bind(memberId, JSON.stringify(tagIds), now);
}

/**
 * field_changed when the stored value will differ (null `stored` = the value is cleared).
 * Ciphertexts are never compared here as values: the vault compares an encrypted value with the
 * stored one on plaintext and, when they are equal, hands back the stored ciphertext itself
 * (@swarm/vault sealMemberFields keepUnchanged), so `value_enc IS ?6` matches only that same
 * stored string. A fresh seal never equals anything stored, so it counts as a change (sign-ups,
 * which the vault never tells whether a value is unchanged).
 */
export function fieldChangedEventStatement(
  db: D1Database,
  memberId: string,
  fieldId: string,
  stored: StoredValue | null,
  now: number,
): D1PreparedStatement {
  if (!stored) {
    return db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT m.channel_id, m.id, 'field_changed', json_object('fieldId', ?2), ?3 FROM members m
          WHERE m.id = ?1
            AND EXISTS (SELECT 1 FROM member_field_values v WHERE v.member_id = ?1 AND v.field_id = ?2)`,
      )
      .bind(memberId, fieldId, now);
  }
  return db
    .prepare(
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
       SELECT m.channel_id, m.id, 'field_changed', json_object('fieldId', ?2), ?3 FROM members m
        WHERE m.id = ?1
          AND NOT EXISTS (SELECT 1 FROM member_field_values v WHERE v.member_id = ?1 AND v.field_id = ?2
                            AND v.value_text IS ?4 AND v.value_num IS ?5 AND v.value_enc IS ?6)`,
    )
    .bind(memberId, fieldId, now, stored.value_text, stored.value_num, stored.value_enc);
}

// ---- Reading and housekeeping (used by the Flows engine) -------------------------------------

/** Unprocessed events in seq order. */
export async function pendingMemberEvents(db: D1Database, limit = 500): Promise<MemberEventRow[]> {
  return all<MemberEventRow>(
    db,
    `SELECT seq, channel_id, member_id, type, payload_json, created_at FROM member_events
      WHERE processed_at IS NULL ORDER BY seq LIMIT ?1`,
    limit,
  );
}

/** Stamps events as processed. */
export async function markMemberEventsProcessed(
  db: D1Database,
  seqs: readonly number[],
  now: number = Date.now(),
): Promise<void> {
  if (!seqs.length) return;
  await run(
    db,
    `UPDATE member_events SET processed_at = ?1
      WHERE seq IN (SELECT value FROM json_each(?2)) AND processed_at IS NULL`,
    now,
    JSON.stringify(seqs),
  );
}

/** Deletes processed events older than the retention. Returns how many went. */
export async function pruneMemberEvents(db: D1Database, now: number = Date.now()): Promise<number> {
  const result = await db
    .prepare('DELETE FROM member_events WHERE processed_at IS NOT NULL AND processed_at < ?1')
    .bind(now - MEMBER_EVENT_RETENTION_MS)
    .run();
  return result.meta.changes ?? 0;
}
