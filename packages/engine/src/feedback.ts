/**
 * What happens after a message is sent: provider events (delivery, bounce, complaint) and
 * unsubscribes. Shared by the events worker (SNS, provider webhooks, Email Routing) and the track
 * worker (One-Click). Other providers' events are mapped onto the SES shape.
 */
import { appendAudit } from '@swarm/db';
import { MEMBER_STATUSES, canTransition, type MemberStatus } from '@swarm/domain';
import { classifyBounce } from './bounce-classifier';
import { recordBounce, recordDelivered } from './bounces';
import { first, newIdFor, run } from './db';
import { complaintUnsubscribedStatement, memberUnsubscribedStatement } from './platform-events';
import { checkRampHealth } from './ramp';
import { rosterChangeStatements, rosterUnsubscribePlan } from './rosters';
import { PROVIDER_REASONS, providerSyncStatement } from './suppressions';

/** SES event publishing ("eventType") and notification ("notificationType") formats. */
export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: {
    messageId?: string;
    tags?: Record<string, string[]>;
    /** The recipients the provider says the message went to (lowercased), when it says. */
    destination?: string[];
  };
  bounce?: {
    bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
    bounceSubType?: string;
    /**
     * `status` is the enhanced status code (5.1.1) SES sends; mapped providers put theirs there
     * too, or the basic SMTP code (550) when that is all they have.
     */
    bouncedRecipients?: { emailAddress?: string; status?: string; diagnosticCode?: string }[];
  };
  complaint?: {
    complainedRecipients?: { emailAddress?: string }[];
    complaintFeedbackType?: string;
  };
  delivery?: { timestamp?: string };
  /** SES accepted the message, then refused to send it (it found a virus, for instance). */
  reject?: { reason?: string };
}

/** A rejected message never reached the recipient, so the address itself is not at fault. */
const rejectError = (event: SesEvent) =>
  `Rejected by the email service${event.reject?.reason ? `: ${event.reject.reason}` : ''}`;

/** Resend webhook event types that map onto SES events; the rest are acknowledged and ignored. */
export const RESEND_APPLIED_TYPES = [
  'email.delivered',
  'email.bounced',
  'email.suppressed',
  'email.complained',
] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * Resend tags as SES's `mail.tags` (name → values). Webhooks send an object
 * ({"delivery": "dl_…"}); sends use an array of {name, value}; both are accepted.
 */
export function resendTags(value: unknown): Record<string, string[]> {
  // No prototype: a tag named "constructor" or "__proto__" is a tag, not a built-in.
  const tags = Object.create(null) as Record<string, string[]>;
  const add = (name: unknown, raw: unknown) => {
    const key = text(name);
    if (!key) return;
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map(String);
    if (values.length) (tags[key] ??= []).push(...values);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const tag = record(item);
      if (tag) add(tag.name, tag.value);
    }
  } else {
    for (const [name, raw] of Object.entries(record(value) ?? {})) add(name, raw);
  }
  return tags;
}

/** The bare address of "a@b" or "Name <a@b>". */
function bareAddress(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw);
  return angle ? angle[1] : raw;
}

function recipients(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(bareAddress).filter((v): v is string => Boolean(v));
}

/**
 * A Resend webhook payload as the SES event applySesEvent understands, or null for the types
 * Swarm doesn't act on (sent, delivery_delayed, opened, clicked, failed, …). Correlation is the
 * same as for SES: the `delivery` / `direct_send` tag first, then the provider message id, which
 * for Resend is data.email_id (what POST /emails returned).
 */
export function resendToSesEvent(payload: unknown): SesEvent | null {
  const body = record(payload);
  const data = record(body?.data);
  const type = text(body?.type);
  if (!body || !data || !type) return null;
  const messageId = text(data.email_id) ?? text(data.id);
  const mail: NonNullable<SesEvent['mail']> = { tags: resendTags(data.tags) };
  if (messageId) mail.messageId = messageId;
  const to = recipients(data.to);

  switch (type) {
    case 'email.delivered': {
      const timestamp = text(data.created_at) ?? text(body.created_at);
      return { eventType: 'Delivery', mail, delivery: timestamp ? { timestamp } : {} };
    }
    case 'email.bounced': {
      const bounce = record(data.bounce) ?? {};
      const kind = text(bounce.type)?.toLowerCase();
      const bounceType =
        kind === 'permanent'
          ? 'Permanent'
          : kind === 'temporary' || kind === 'transient'
            ? 'Transient'
            : 'Undetermined';
      const subType = text(bounce.subType) ?? text(bounce.sub_type);
      const codes = Array.isArray(bounce.diagnosticCode)
        ? bounce.diagnosticCode.map(text).filter(Boolean)
        : [text(bounce.diagnosticCode)].filter(Boolean);
      const diagnostic = (text(bounce.message) ?? codes.join('; ')) || undefined;
      return {
        eventType: 'Bounce',
        mail,
        bounce: {
          bounceType,
          ...(subType ? { bounceSubType: subType } : {}),
          bouncedRecipients: to.map((emailAddress) => ({
            emailAddress,
            ...(diagnostic ? { diagnosticCode: diagnostic } : {}),
          })),
        },
      };
    }
    case 'email.suppressed': {
      // Resend refused to send to an address on its suppression list: a hard bounce for us.
      const suppressed = record(data.suppressed) ?? {};
      const diagnostic = text(suppressed.message) ?? text(suppressed.type);
      return {
        eventType: 'Bounce',
        mail,
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'Suppressed',
          bouncedRecipients: to.map((emailAddress) => ({
            emailAddress,
            ...(diagnostic ? { diagnosticCode: diagnostic } : {}),
          })),
        },
      };
    }
    case 'email.complained': {
      const feedback = text(record(data.complaint)?.type);
      return {
        eventType: 'Complaint',
        mail,
        complaint: {
          complainedRecipients: to.map((emailAddress) => ({ emailAddress })),
          ...(feedback ? { complaintFeedbackType: feedback } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * A Mailgun webhook event as the SES event applySesEvent understands, or null for the types Swarm
 * doesn't act on (accepted, opened, clicked, unsubscribed, …). Correlation is the same as for
 * Resend: the `delivery` / `direct_send` variable first, then the provider message id. Mailgun's
 * docs name failures both `failed` and `permanent_fail` / `temporary_fail`, so all three are read.
 */
export function mailgunToSesEvent(payload: unknown): SesEvent | null {
  const body = record(payload);
  const type = text(body?.event);
  if (!body || !type) return null;
  const headers = record(record(body.message)?.headers);
  const messageId = text(headers?.['message-id'])?.replace(/^<|>$/g, '');
  const mail: NonNullable<SesEvent['mail']> = { tags: resendTags(record(body['user-variables'])) };
  if (messageId) mail.messageId = messageId;
  const to = recipients(body.recipient);
  mail.destination = to.map((address) => address.toLowerCase());

  switch (type) {
    case 'delivered': {
      const seconds = typeof body.timestamp === 'number' ? body.timestamp : Number.NaN;
      return {
        eventType: 'Delivery',
        mail,
        delivery: Number.isFinite(seconds)
          ? { timestamp: new Date(seconds * 1000).toISOString() }
          : {},
      };
    }
    case 'failed':
    case 'permanent_fail':
    case 'temporary_fail': {
      const severity = text(body.severity)?.toLowerCase();
      const bounceType =
        type === 'permanent_fail' || severity === 'permanent'
          ? 'Permanent'
          : type === 'temporary_fail' || severity === 'temporary'
            ? 'Transient'
            : 'Undetermined';
      const status = record(body['delivery-status']);
      const diagnostic = text(status?.message) ?? text(status?.description);
      const reason = text(body.reason);
      // The enhanced code when Mailgun read one, else the SMTP reply code (not its own 6xx codes).
      const code =
        text(status?.['enhanced-code']) ??
        (typeof status?.code === 'number' && status.code >= 200 && status.code < 600
          ? String(status.code)
          : undefined);
      return {
        eventType: 'Bounce',
        mail,
        bounce: {
          bounceType,
          ...(reason ? { bounceSubType: reason } : {}),
          bouncedRecipients: to.map((emailAddress) => ({
            emailAddress,
            ...(code ? { status: code } : {}),
            ...(diagnostic ? { diagnosticCode: diagnostic } : {}),
          })),
        },
      };
    }
    case 'complained':
      return {
        eventType: 'Complaint',
        mail,
        complaint: { complainedRecipients: to.map((emailAddress) => ({ emailAddress })) },
      };
    default:
      return null;
  }
}

/**
 * A Postmark webhook as the SES event applySesEvent understands, or null for the types Swarm doesn't
 * act on here. Tags come back as Metadata. An address Postmark deactivated, a hard bounce and a bad
 * address are permanent; the rest, like a soft bounce or a block, are temporary.
 */
export function postmarkToSesEvent(payload: unknown): SesEvent | null {
  const body = record(payload);
  const type = text(body?.RecordType);
  if (!body || !type) return null;
  const messageId = text(body.MessageID);
  const mail: NonNullable<SesEvent['mail']> = { tags: resendTags(record(body.Metadata)) };
  if (messageId) mail.messageId = messageId;
  const to = recipients(body.Email ?? body.Recipient);

  if (type === 'Delivery') {
    const timestamp = text(body.DeliveredAt);
    return { eventType: 'Delivery', mail, delivery: timestamp ? { timestamp } : {} };
  }
  if (type === 'SpamComplaint' || (type === 'Bounce' && body.Type === 'SpamComplaint')) {
    return {
      eventType: 'Complaint',
      mail,
      complaint: { complainedRecipients: to.map((emailAddress) => ({ emailAddress })) },
    };
  }
  if (type !== 'Bounce') return null;
  const kind = text(body.Type);
  const permanent = body.Inactive === true || kind === 'HardBounce' || kind === 'BadEmailAddress';
  const diagnostic = text(body.Details) ?? text(body.Description);
  return {
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType: permanent ? 'Permanent' : 'Transient',
      ...(kind ? { bounceSubType: kind } : {}),
      bouncedRecipients: to.map((emailAddress) => ({
        emailAddress,
        ...(diagnostic ? { diagnosticCode: diagnostic } : {}),
      })),
    },
  };
}

/**
 * The delivery a reader unsubscribed from through Postmark's own link, or null. Bounces and
 * complaints also arrive as subscription changes, but their own webhooks already handle them.
 */
export function postmarkUnsubscribedDelivery(payload: unknown): string | null {
  const body = record(payload);
  if (
    body?.RecordType !== 'SubscriptionChange' ||
    body.SuppressSending !== true ||
    body.SuppressionReason !== 'ManualSuppression' ||
    body.Origin !== 'Recipient'
  ) {
    return null;
  }
  const delivery = text(record(body.Metadata)?.delivery);
  return delivery && /^dl_[0-9a-f]{32}$/.test(delivery) ? delivery : null;
}

interface DeliveryContext {
  id: string;
  broadcast_id: string;
  channel_id: string;
  member_id: string | null;
  email: string;
  provider_message_id: string | null;
  status: string;
  sent_at: number;
  workspace_id: string;
  ramp_id: string | null;
}

async function deliveryFor(db: D1Database, event: SesEvent): Promise<DeliveryContext | null> {
  const select = `SELECT d.id, d.broadcast_id, d.channel_id, d.member_id, d.email, d.provider_message_id, d.status, d.sent_at, b.workspace_id, b.ramp_id
       FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id`;
  const tagged = event.mail?.tags?.delivery?.[0];
  if (tagged && /^dl_[0-9a-f]{32}$/.test(tagged)) {
    const row = await first<DeliveryContext>(db, `${select} WHERE d.id = ?1`, tagged);
    if (row) return row;
  }
  const messageId = event.mail?.messageId;
  if (!messageId) return null;
  return first<DeliveryContext>(db, `${select} WHERE d.provider_message_id = ?1`, messageId);
}

export type Corroboration = 'match' | 'mismatch' | 'unknown';

/**
 * Whether an event agrees with what Swarm recorded for the send it names, for providers whose
 * signature doesn't cover the event (Mailgun signs only a timestamp and a token): the address the
 * send went to must be among the event's recipients, and when Swarm recorded the provider's
 * message id the event must carry the same one. 'unknown' when the event names no send Swarm has.
 */
export async function corroborateEvent(db: D1Database, event: SesEvent): Promise<Corroboration> {
  const target = (await deliveryFor(db, event)) ?? (await directSendFor(db, event));
  if (!target) return 'unknown';
  return agrees(event, target) ? 'match' : 'mismatch';
}

function agrees(
  event: SesEvent,
  target: { email: string | null; provider_message_id: string | null },
): boolean {
  const to = event.mail?.destination ?? [];
  const email = target.email?.toLowerCase() ?? '';
  // An erased send keeps no address: nothing it could still change needs one.
  if (email.includes('@') && !to.includes(email)) return false;
  if (target.provider_message_id && event.mail?.messageId !== target.provider_message_id) {
    return false;
  }
  return true;
}

/** Statuses `actor` may move a Member to `to` from, per the domain state machine. */
export const transitionSources = (to: MemberStatus, actor: 'system' | 'member' | 'operator') =>
  MEMBER_STATUSES.filter((from) => canTransition(from, to, actor));

/** A fixed SQL list of statuses (never user input). */
export const statusList = (statuses: readonly MemberStatus[]) =>
  statuses.map((s) => `'${s}'`).join(', ');

const MEMBER_UNSUBSCRIBABLE = transitionSources('unsubscribed', 'member');

/** SES's bounce subtype for an address already on the account-level suppression list. */
const ON_ACCOUNT_SUPPRESSION_LIST = 'OnAccountSuppressionList';

const RESULT_KIND = {
  hard: 'hard_bounce',
  soft: 'soft_bounce',
  blocked: 'blocked',
  ignored: 'ignored',
} as const;

type BouncedRecipient = NonNullable<NonNullable<SesEvent['bounce']>['bouncedRecipients']>[number];

/** What the receiving server said; the provider's bounce type when it passed nothing on. */
const bounceDetail = (
  bounce: NonNullable<SesEvent['bounce']>,
  recipient: BouncedRecipient,
): string | null =>
  recipient.diagnosticCode?.trim() ||
  [bounce.bounceType, bounce.bounceSubType].filter(Boolean).join(' / ') ||
  null;

/**
 * The entry for `email` among an event's recipients, if it names it. An event matched to a
 * delivery acts only on the address that delivery went to: some payloads (Mailgun's event-data)
 * are not covered by the provider's signature, so another address they name is ignored. An entry
 * with no address names nobody else, so it is used when none names `email`.
 */
function ownRecipient<T extends { emailAddress?: string }>(
  recipients: T[] | undefined,
  email: string,
): T | undefined {
  return (
    recipients?.find((r) => r.emailAddress?.toLowerCase() === email.toLowerCase()) ??
    recipients?.find((r) => !r.emailAddress)
  );
}

/**
 * Suppresses `email` workspace-wide and moves the workspace's Members of it to `memberStatus`.
 * Only this workspace changes. Hard bounces are also queued for the SES account-level
 * suppression list (the mailbox does not exist, for any sender), unless SES reported them from it
 * (`fromProvider`: an OnAccountSuppressionList bounce). Complaints are not: a complaint is about
 * this workspace's mail, and the SES list is shared by every workspace (docs/deliverability.md
 * "Suppressions").
 */
export async function suppress(
  db: D1Database,
  workspaceId: string,
  email: string,
  reason: 'hard_bounce' | 'soft_bounce' | 'complaint',
  detail: string | null,
  memberStatus: 'bounced' | 'complained',
  now: number,
  options: { fromProvider?: boolean } = {},
): Promise<void> {
  const providerReason = reason === 'hard_bounce' ? PROVIDER_REASONS.hard_bounce : null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (workspace_id, email) WHERE channel_id IS NULL DO NOTHING`,
      )
      .bind(
        newIdFor('suppression', now),
        workspaceId,
        email,
        reason,
        detail?.slice(0, 500) ?? null,
        now,
      ),
    ...(providerReason && !options.fromProvider
      ? [providerSyncStatement(db, email, { action: 'put', reason: providerReason }, now)]
      : []),
    // A complaint unsubscribes: member.unsubscribed webhooks (Phase 7), before the update.
    ...(memberStatus === 'complained'
      ? [
          complaintUnsubscribedStatement(
            db,
            workspaceId,
            email,
            transitionSources(memberStatus, 'system'),
            now,
          ),
        ]
      : []),
    // The address is suppressed workspace-wide, so every Channel's Member record reflects it.
    // Only system transitions apply, so a complaint overrides a bounce but never the reverse. A
    // bounce remembers the status, so removing the suppression can give it back (bounces.ts).
    db
      .prepare(
        `UPDATE members SET bounced_from = CASE WHEN ?1 = 'bounced' THEN status ELSE bounced_from END,
                status = ?1, updated_at = ?2, paused_until = NULL
          WHERE email = ?3 AND status IN (${statusList(transitionSources(memberStatus, 'system'))})
            AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?4)`,
      )
      .bind(memberStatus, now, email, workspaceId),
  ]);
}

export interface FeedbackResult {
  handled: boolean;
  kind?:
    'delivery' | 'hard_bounce' | 'soft_bounce' | 'blocked' | 'complaint' | 'rejected' | 'ignored';
  /** For a bounce: whether the bounce rules stopped mailing the address, or held it for an admin. */
  stopped?: boolean;
  held?: boolean;
  rampPaused?: string | null;
  /** Set when the event changed a Member, so Circles need a look. */
  memberChangedIn?: string;
}

export async function applySesEvent(
  db: D1Database,
  event: SesEvent,
  now = Date.now(),
  options: { corroborate?: boolean } = {},
): Promise<FeedbackResult> {
  const type = event.eventType ?? event.notificationType;
  const delivery = await deliveryFor(db, event);
  if (!delivery) return applyDirectSendEvent(db, event, type, now, options);
  // An event whose body isn't signed changes nothing unless it agrees with Swarm's record.
  if (options.corroborate && !agrees(event, delivery)) return { handled: false, kind: 'ignored' };

  if (type === 'Delivery') {
    await run(
      db,
      `UPDATE deliveries SET status = 'delivered', delivered_at = coalesce(delivered_at, ?1) WHERE id = ?2 AND status = 'sent'`,
      now,
      delivery.id,
    );
    // A delivered email starts the "in a row" count of soft bounces again.
    await recordDelivered(db, delivery.workspace_id, delivery.email, now);
    return { handled: true, kind: 'delivery' };
  }

  if (type === 'Reject') {
    await run(
      db,
      `UPDATE deliveries SET status = 'failed', error = ?1 WHERE id = ?2 AND status = 'sent'`,
      rejectError(event),
      delivery.id,
    );
    return { handled: true, kind: 'rejected' };
  }

  if (type === 'Bounce') {
    const bounce = event.bounce ?? {};
    const email = delivery.email.toLowerCase();
    // Only the address this delivery went to, never another one the event names (see ownRecipient).
    const recipient: BouncedRecipient = ownRecipient(bounce.bouncedRecipients, email) ?? {
      emailAddress: email,
    };
    const classified = classifyBounce({
      bounceType: bounce.bounceType,
      bounceSubType: bounce.bounceSubType,
      status: recipient.status,
      diagnostic: recipient.diagnosticCode,
    });
    // An erased delivery keeps no address ('erased'), so there is nothing to record against one.
    const outcome =
      classified.kind !== 'ignored' && email.includes('@')
        ? await recordBounce(
            db,
            {
              workspaceId: delivery.workspace_id,
              email,
              sendId: delivery.id,
              sentAt: delivery.sent_at,
              fromProvider: bounce.bounceSubType === ON_ACCOUNT_SUPPRESSION_LIST,
              detail: bounceDetail(bounce, recipient),
            },
            classified,
            now,
          )
        : null;
    const stopped = outcome !== null && outcome.stopped !== null;
    const held = outcome?.held ?? false;
    const kind = classified.kind;
    // Hard bounces and blocks never reached the reader: they count against the domain's
    // reputation (check-up, warm-up) and the send report. Soft bounces leave the delivery as it is.
    const undelivered = classified.kind === 'hard' || classified.kind === 'blocked';
    if (undelivered) {
      await run(
        db,
        `UPDATE deliveries SET status = 'bounced', bounce_type = ?1, bounced_at = ?2 WHERE id = ?3 AND status IN ('sent', 'delivered')`,
        `${classified.kind}:${classified.cause}`,
        now,
        delivery.id,
      );
    }
    const rampPaused = undelivered && delivery.ramp_id ? await rampCheck(db, delivery, now) : null;
    return {
      handled: true,
      kind: RESULT_KIND[kind],
      rampPaused,
      ...(kind === 'ignored' ? {} : { stopped, held }),
      ...(stopped ? { memberChangedIn: delivery.channel_id } : {}),
    };
  }

  if (type === 'Complaint') {
    if (delivery.email.includes('@')) {
      await suppress(
        db,
        delivery.workspace_id,
        delivery.email.toLowerCase(),
        'complaint',
        event.complaint?.complaintFeedbackType ?? null,
        'complained',
        now,
      );
    }
    await run(
      db,
      `UPDATE deliveries SET status = 'complained', complained_at = ?1, unsubscribed_at = coalesce(unsubscribed_at, ?1) WHERE id = ?2`,
      now,
      delivery.id,
    );
    await appendAudit(db, {
      workspaceId: delivery.workspace_id,
      actorId: null,
      action: 'member.complained',
      targetType: 'member',
      targetId: delivery.member_id,
      metadata: { broadcastId: delivery.broadcast_id, deliveryId: delivery.id },
    });
    const rampPaused = delivery.ramp_id ? await rampCheck(db, delivery, now) : null;
    return {
      handled: true,
      kind: 'complaint',
      rampPaused,
      memberChangedIn: delivery.channel_id,
    };
  }

  return { handled: true, kind: 'ignored' };
}

async function rampCheck(
  db: D1Database,
  delivery: DeliveryContext,
  now: number,
): Promise<string | null> {
  const reason = await checkRampHealth(db, delivery.ramp_id as string, now);
  if (reason) {
    await appendAudit(db, {
      workspaceId: delivery.workspace_id,
      actorId: null,
      action: 'ramp.paused',
      targetType: 'reputation_ramp',
      targetId: delivery.ramp_id,
      metadata: { reason, broadcastId: delivery.broadcast_id },
    });
  }
  return reason;
}

/**
 * Direct Send API (Phase 7): events for a direct_sends message (tagged `direct_send`, or matched
 * by provider message id) update its status. Bounces and complaints suppress the address exactly
 * as for a Broadcast; Direct Sends have no Reputation Ramp.
 */
async function directSendFor(db: D1Database, event: SesEvent): Promise<DirectSendContext | null> {
  const select = `SELECT s.id, s.workspace_id, s.member_id, s.provider_message_id, m.email FROM direct_sends s
       LEFT JOIN members m ON m.id = s.member_id`;
  const tagged = event.mail?.tags?.direct_send?.[0];
  const messageId = event.mail?.messageId;
  return (
    (tagged && /^dn_[0-9a-f]{32}$/.test(tagged)
      ? await first<DirectSendContext>(db, `${select} WHERE s.id = ?1`, tagged)
      : null) ??
    (messageId
      ? await first<DirectSendContext>(db, `${select} WHERE s.provider_message_id = ?1`, messageId)
      : null)
  );
}

async function applyDirectSendEvent(
  db: D1Database,
  event: SesEvent,
  type: string | undefined,
  now: number,
  options: { corroborate?: boolean } = {},
): Promise<FeedbackResult> {
  const send = await directSendFor(db, event);
  if (!send) return { handled: false };
  if (options.corroborate && !agrees(event, send)) return { handled: false, kind: 'ignored' };
  const status = (to: string, from: string) =>
    run(
      db,
      `UPDATE direct_sends SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status IN (${from})`,
      to,
      now,
      send.id,
    );
  if (type === 'Delivery') {
    await status('delivered', `'sent'`);
    if (send.email) await recordDelivered(db, send.workspace_id, send.email, now);
    return { handled: true, kind: 'delivery' };
  }
  if (type === 'Reject') {
    await run(
      db,
      `UPDATE direct_sends SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'sent'`,
      rejectError(event),
      now,
      send.id,
    );
    return { handled: true, kind: 'rejected' };
  }
  if (type === 'Bounce') {
    const bounce = event.bounce ?? {};
    // Only the Member's own address, never another one the event names (see ownRecipient).
    const email = send.email?.toLowerCase();
    const recipient: BouncedRecipient =
      (email ? ownRecipient(bounce.bouncedRecipients, email) : undefined) ?? {};
    const classified = classifyBounce({
      bounceType: bounce.bounceType,
      bounceSubType: bounce.bounceSubType,
      status: recipient.status,
      diagnostic: recipient.diagnosticCode,
    });
    if (classified.kind === 'ignored') return { handled: true, kind: 'ignored' };
    // The same rules as for a post; a Direct Send has no delivery row to look between.
    const outcome = email
      ? await recordBounce(
          db,
          {
            workspaceId: send.workspace_id,
            email,
            sendId: send.id,
            sentAt: null,
            fromProvider: bounce.bounceSubType === ON_ACCOUNT_SUPPRESSION_LIST,
            detail: bounceDetail(bounce, recipient),
          },
          classified,
          now,
        )
      : null;
    if (classified.kind === 'hard' || classified.kind === 'blocked') {
      await status('bounced', `'sent', 'delivered'`);
    }
    return {
      handled: true,
      kind: RESULT_KIND[classified.kind],
      stopped: outcome?.stopped != null,
      held: outcome?.held ?? false,
    };
  }
  if (type === 'Complaint') {
    const email = send.email?.toLowerCase();
    if (email) {
      const feedback = event.complaint?.complaintFeedbackType ?? null;
      await suppress(db, send.workspace_id, email, 'complaint', feedback, 'complained', now);
    }
    await status('complained', `'sent', 'delivered', 'bounced'`);
    return { handled: true, kind: 'complaint' };
  }
  return { handled: true, kind: 'ignored' };
}

interface DirectSendContext {
  id: string;
  workspace_id: string;
  member_id: string | null;
  provider_message_id: string | null;
  email: string | null;
}

/**
 * The Member an unsubscribe code points at: a Broadcast delivery (dl_<hex>) or, failing that, a
 * one_off Direct Send with the same hex (dn_<hex>; transactional sends carry no unsubscribe link).
 * A delivery past the workspace's engagement retention finds its Member through the
 * withdrawal-only reference retention.ts kept (unsubscribe_refs) while that lasts. One that names
 * nobody any more (erased, deleted, or past that reference) is no target: the page says the link
 * is too old rather than claiming an unsubscribe.
 */
export async function unsubscribeTarget(db: D1Database, deliveryId: string, now = Date.now()) {
  type Target = {
    member_id: string | null;
    email: string;
    channel_name: string;
    member_status: string | null;
  };
  const delivery = await first<Target>(
    db,
    `SELECT m.id AS member_id, m.email, c.name AS channel_name, m.status AS member_status
       FROM deliveries d JOIN channels c ON c.id = d.channel_id
       LEFT JOIN members m ON m.id = coalesce(d.member_id,
         (SELECT r.member_id FROM unsubscribe_refs r WHERE r.delivery_id = d.id AND r.expires_at > ?2))
      WHERE d.id = ?1`,
    deliveryId,
    now,
  );
  if (delivery) return delivery.member_id === null ? null : delivery;
  return first<Target>(
    db,
    `SELECT s.member_id, m.email, c.name AS channel_name, m.status AS member_status
       FROM direct_sends s JOIN channels c ON c.id = s.channel_id JOIN members m ON m.id = s.member_id
      WHERE s.id = 'dn_' || substr(?1, 4) AND s.kind = 'one_off'`,
    deliveryId,
  );
}

/**
 * Unsubscribes the Member a delivery went to. Idempotent; returns null for an unknown delivery.
 * From a Roster-targeted Broadcast (Phase 8, docs/rosters.md) it leaves the Broadcast's included
 * Rosters instead, and `rosters` names them; `scope: 'all'` leaves the Channel regardless.
 */
export async function unsubscribeDelivery(
  db: D1Database,
  deliveryId: string,
  now = Date.now(),
  options: { scope?: 'auto' | 'all' } = {},
): Promise<{
  channelName: string;
  email: string;
  alreadyUnsubscribed: boolean;
  rosters: string[] | null;
} | null> {
  const row = await unsubscribeTarget(db, deliveryId, now);
  if (!row) return null;
  const plan = options.scope === 'all' ? null : await rosterUnsubscribePlan(db, deliveryId, now);
  if (plan) {
    await db.batch([
      ...plan.rosters.flatMap((roster) =>
        rosterChangeStatements(
          db,
          {
            rosterId: roster.id,
            memberId: plan.memberId,
            status: 'unsubscribed',
            source: 'unsubscribe',
          },
          now,
        ),
      ),
      db
        .prepare(
          'UPDATE deliveries SET unsubscribed_at = coalesce(unsubscribed_at, ?1) WHERE id = ?2',
        )
        .bind(now, deliveryId),
    ]);
    return {
      channelName: row.channel_name,
      email: row.email,
      alreadyUnsubscribed: false,
      rosters: plan.rosters.map((r) => r.name),
    };
  }
  await db.batch([
    // member.unsubscribed webhooks (Phase 7), before the update.
    ...(row.member_id
      ? [memberUnsubscribedStatement(db, row.member_id, MEMBER_UNSUBSCRIBABLE, now)]
      : []),
    db
      .prepare(
        `UPDATE members SET status = 'unsubscribed', unsubscribed_at = ?1, updated_at = ?1, paused_until = NULL
          WHERE id = ?2 AND status IN (${statusList(MEMBER_UNSUBSCRIBABLE)})`,
      )
      .bind(now, row.member_id),
    db
      .prepare(
        'UPDATE deliveries SET unsubscribed_at = coalesce(unsubscribed_at, ?1) WHERE id = ?2',
      )
      .bind(now, deliveryId),
  ]);
  return {
    channelName: row.channel_name,
    email: row.email,
    alreadyUnsubscribed: !MEMBER_UNSUBSCRIBABLE.includes(row.member_status as MemberStatus),
    rosters: null,
  };
}
