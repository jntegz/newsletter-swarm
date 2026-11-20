/**
 * The platform event outbox (Phase 7): webhook events that are not member events. Member events
 * (`member_events`) are fanned out to webhooks by the jobs worker with its own cursor; anything
 * else that a webhook announces is appended here by the code that makes it happen.
 *
 * CONTRACT
 * - `type` is a WebhookEventType (p7-platform.ts). Today: dispatch.scheduled (API schedule),
 *   dispatch.sent and broadcast.completed (maybeComplete in pipeline.ts), flow.completed (the
 *   Flows engine), member.unsubscribed (unsubscribe page and One-Click, Member Center, the
 *   pending leave link, operator edits, bulk, complaints), member.updated (operator edits of
 *   name, digest or status), member.deleted (operator delete; erasure).
 * - `payload` is the resource the webhook carries as `data`, in its API shape (the same domain
 *   schemas the API returns), captured when the event happens. The exception is
 *   MEMBER_RESOURCE_EVENTS (member.unsubscribed, member.updated): payload `{}`, and the fan-out
 *   attaches the Member as it is when the event is delivered (see the helpers below).
 * - `memberId` is set whenever the event is about one Member, so erasure can remove it.
 * - Like member events, appends are cheap and belong in the same `db.batch` as the change they
 *   describe where one exists (`platformEventStatement`).
 */
import type { WebhookEventType } from '@swarm/domain';

export interface PlatformEventInput {
  type: WebhookEventType;
  workspaceId: string;
  channelId?: string | null;
  memberId?: string | null;
  payload: Record<string, unknown>;
}

export function platformEventStatement(
  db: D1Database,
  event: PlatformEventInput,
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      event.workspaceId,
      event.channelId ?? null,
      event.memberId ?? null,
      event.type,
      JSON.stringify(event.payload),
      now,
    );
}

export async function recordPlatformEvent(
  db: D1Database,
  event: PlatformEventInput,
  now?: number,
): Promise<void> {
  await platformEventStatement(db, event, now).run();
}

// ---- Member events with no member event (data = the Member, attached at fan-out) -------------
//
// member.unsubscribed, and operator edits that change no tag or field (member.updated), have no
// member event, so they go through the outbox with payload `{}`: the webhook fan-out attaches
// the Member as it is then (MEMBER_RESOURCE_EVENTS in @swarm/domain), like the member.* events
// that come from member_events. As with the tag helpers in events.ts, the conditional
// statements go BEFORE the write they describe in the batch, so a no-op emits nothing.

const idList = (ids: string | readonly string[]) =>
  JSON.stringify(typeof ids === 'string' ? [ids] : ids);

/**
 * member.unsubscribed, placed before the UPDATE that unsubscribes: emitted for each Member that
 * is in one of the `from` statuses (so the update will change it).
 */
export function memberUnsubscribedStatement(
  db: D1Database,
  memberIds: string | readonly string[],
  from: readonly string[],
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       SELECT c.workspace_id, m.channel_id, m.id, 'member.unsubscribed', '{}', ?3
         FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.status IN (SELECT value FROM json_each(?2))`,
    )
    .bind(idList(memberIds), JSON.stringify(from), now);
}

/**
 * member.unsubscribed for every Member with `email` in the workspace that a complaint will move
 * (status in `from`), placed before that UPDATE.
 */
export function complaintUnsubscribedStatement(
  db: D1Database,
  workspaceId: string,
  email: string,
  from: readonly string[],
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       SELECT c.workspace_id, m.channel_id, m.id, 'member.unsubscribed', '{}', ?4
         FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE m.email = ?2 AND c.workspace_id = ?1 AND m.status IN (SELECT value FROM json_each(?3))`,
    )
    .bind(workspaceId, email, JSON.stringify(from), now);
}

/** member.updated for an edit that emits no member event (name, digest, status). */
export function memberUpdatedStatement(
  db: D1Database,
  memberId: string,
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       SELECT c.workspace_id, m.channel_id, m.id, 'member.updated', '{}', ?2
         FROM members m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?1`,
    )
    .bind(memberId, now);
}

/**
 * member.deleted, placed before the DELETE. The payload is ids only, and `member_id` stays NULL:
 * the Member is gone and the row holds nothing that erasure must remove.
 */
export function memberDeletedStatement(
  db: D1Database,
  memberIds: string | readonly string[],
  now: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       SELECT c.workspace_id, m.channel_id, NULL, 'member.deleted',
              json_object('id', m.id, 'channelId', m.channel_id), ?2
         FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE m.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(idList(memberIds), now);
}
