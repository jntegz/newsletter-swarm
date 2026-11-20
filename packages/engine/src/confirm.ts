/**
 * Confirm opt-in, Gentle Reminders and the signed links Members receive.
 *
 * Tokens (links.ts, each family on its own keyring, purpose-scoped so none can stand in for
 * another). `c` is the Channel, checked against the row the link names:
 *   confirm     {q: confirm request id, c}  7 days   GET shows a page, POST confirms (CONFIRM_KEYS)
 *   member      {m: member id, c, e?: 1}    30 days  the Member Center (e: emailed on request at
 *                                                    /m) (MEMBER_SIGNING_KEYS, Ed25519)
 *   leave       {m: member id, c}           30 days  List-Unsubscribe on confirmation mail
 *                                                    (CONFIRM_KEYS)
 *   member-ref  {c, r}                      1 day    the signed reference a form redirect
 *                                                    carries (CAPTURE_KEYS)
 *
 * A confirm only moves a Member out of the status its request was made for: `pending` for a new
 * sign-up, `unsubscribed` for a returning one. Both are single conditional UPDATEs inside one
 * batch, so a replayed or raced confirm changes nothing.
 */
import { canTransition, type MemberStatus } from '@swarm/domain';
import { unsubscribeHeaders, type MailAdapter, type OutgoingMail } from '@swarm/mail';
import { base64UrlEncode } from '@swarm/tokens';
import type { EngineConfig } from './config';
import { all, first, newIdFor, run } from './db';
import { recordMemberEvent } from './events';
import type { LinkKeys, LinkSigner, LinkVerifier, MemberLinkMinter } from './links';
import { memberUnsubscribedStatement } from './platform-events';
import { composeMessage, memberMail } from './messages';
import { joinFormRosters } from './rosters';
import { resolveSender } from './start';
import { isSuppressedFor } from './suppressions';

const DAY_SECONDS = 86_400;
/** How long a confirm link works, unless the Channel sets its own `confirmDays`. */
export const CONFIRM_LIFETIME_SECONDS = 7 * DAY_SECONDS;
export const MEMBER_LINK_LIFETIME_SECONDS = 30 * DAY_SECONDS;
const LEAVE_LIFETIME_SECONDS = 30 * DAY_SECONDS;
const REFERENCE_LIFETIME_SECONDS = DAY_SECONDS;
/** Gentle Reminder: one, this long after the last send, while the request is still open. */
export const REMINDER_AFTER_MS = 48 * 60 * 60 * 1000;
/** A confirmation is resent at most this often, and at most MAX_SENDS times per request. */
export const RESEND_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_SENDS = 5;
/** New confirm requests per Member per day. */
const MAX_REQUESTS_PER_DAY = 3;

export type ConfirmKind = 'subscribe' | 'return';

/** The status a request of this kind confirms from. */
export const confirmsFrom = (kind: ConfirmKind): MemberStatus =>
  kind === 'subscribe' ? 'pending' : 'unsubscribed';

/** Everything the Member-facing flows need. Built by the api and capture workers. */
export interface AudienceDeps {
  db: D1Database;
  mail: MailAdapter;
  /** Signs the links this worker makes itself: confirm, leave, the privacy confirmations. */
  links: LinkSigner;
  /** Member Center links. Required wherever one is mailed (memberCenterUrl throws without it). */
  memberLinks?: MemberLinkMinter;
  /** Public origin of the capture worker, without a trailing slash. */
  captureOrigin: string;
  platformMailDomain: string;
  now?: () => number;
}

const clock = (deps: { now?: () => number }) => (deps.now ? deps.now() : Date.now());

// ---- Tokens ---------------------------------------------------------------------------------

const ID = { q: /^cq_[0-9a-f]{32}$/, m: /^mb_[0-9a-f]{32}$/ };

export function confirmToken(
  links: LinkSigner,
  request: { requestId: string; channelId: string },
  lifetimeSeconds: number,
  now: number,
) {
  return links.sign(
    'confirm',
    { q: request.requestId, c: request.channelId },
    { expiresInSeconds: lifetimeSeconds, now },
  );
}

export type TokenRead<T> = { ok: true; value: T } | { ok: false; reason: 'invalid' | 'expired' };

/** A tenant claim: a Channel id, or null for a link from before the cutover, which named none. */
const tenantOf = (c: unknown): string | null | undefined =>
  c === undefined ? null : typeof c === 'string' ? c : undefined;

export async function readConfirmToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<TokenRead<{ requestId: string; channelId: string | null }>> {
  if (token.length > 512) return { ok: false, reason: 'invalid' };
  const result = await links.verify<{ q?: unknown; c?: unknown }>(
    'confirm',
    token,
    now ? { now } : {},
  );
  if (!result.ok) return { ok: false, reason: result.reason === 'expired' ? 'expired' : 'invalid' };
  const { q, c } = result.payload;
  const channelId = tenantOf(c);
  return typeof q === 'string' && ID.q.test(q) && channelId !== undefined
    ? { ok: true, value: { requestId: q, channelId } }
    : { ok: false, reason: 'invalid' };
}

/**
 * A Member Center token. `emailed` marks a link sent only to the address because someone asked
 * for it at /m; footer and page links never carry it, so a forwarded email can't stand in for it.
 */
export function memberToken(
  links: LinkSigner,
  member: { memberId: string; channelId: string },
  now?: number,
  options: { emailed?: true } = {},
) {
  return links.sign(
    'member',
    { m: member.memberId, c: member.channelId, ...(options.emailed ? { e: 1 } : {}) },
    { expiresInSeconds: MEMBER_LINK_LIFETIME_SECONDS, ...(now === undefined ? {} : { now }) },
  );
}

/** Member Center links signed by this worker itself (send, jobs; the api and capture for now). */
export const localMemberLinks = (links: LinkSigner): MemberLinkMinter => ({
  memberToken: (member, options = {}) =>
    memberToken(links, member, options.now, options.emailed ? { emailed: true } : {}),
});

/**
 * A Member Center token's Member and Channel (null for a link from before the cutover: the caller
 * checks it against the Member's row), when it was issued (ms) and whether it was emailed on request.
 */
export async function readMemberSession(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<{
  memberId: string;
  channelId: string | null;
  issuedAt: number;
  emailed: boolean;
} | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ m?: unknown; c?: unknown; e?: unknown }>(
    'member',
    token,
    now ? { now } : {},
  );
  if (!result.ok) return null;
  const { m, c, e, iat } = result.payload;
  const channelId = tenantOf(c);
  if (typeof m !== 'string' || !ID.m.test(m) || channelId === undefined) return null;
  return { memberId: m, channelId, issuedAt: iat * 1000, emailed: e === 1 };
}

export function leaveToken(
  links: LinkSigner,
  member: { memberId: string; channelId: string },
  now?: number,
) {
  return links.sign(
    'leave',
    { m: member.memberId, c: member.channelId },
    { expiresInSeconds: LEAVE_LIFETIME_SECONDS, ...(now === undefined ? {} : { now }) },
  );
}

/** The Member and Channel (null before the cutover) of a leave link, or null. */
export async function readLeaveToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<{ memberId: string; channelId: string | null } | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ m?: unknown; c?: unknown }>(
    'leave',
    token,
    now ? { now } : {},
  );
  if (!result.ok) return null;
  const { m, c } = result.payload;
  const channelId = tenantOf(c);
  return typeof m === 'string' && ID.m.test(m) && channelId !== undefined
    ? { memberId: m, channelId }
    : null;
}

/**
 * The signed reference a form's redirect carries instead of an email. `r` is an HMAC of the
 * Channel and address: stable per Member, meaningless without the key, and computed the same
 * whether or not the address is already on the list, so the redirect reveals nothing. Keyed with
 * CAPTURE_KEYS since the cutover (MEMBER_KEYS before), so `r` changed once then.
 */
export async function memberReference(
  links: LinkKeys,
  channelId: string,
  email: string,
): Promise<string> {
  const secret = links.secret('CAPTURE_KEYS');
  if (!secret) throw new Error("CAPTURE_KEYS is not set, so this worker can't sign a reference");
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`member-ref:${channelId}:${email.toLowerCase()}`),
  );
  const r = base64UrlEncode(new Uint8Array(mac).slice(0, 18));
  return links.sign(
    'member-ref',
    { c: channelId, r },
    { expiresInSeconds: REFERENCE_LIFETIME_SECONDS },
  );
}

/** A Member Center link for a Member of `channelId`. */
export const memberCenterUrl = async (
  deps: AudienceDeps,
  member: { memberId: string; channelId: string },
  options: { emailed?: true } = {},
) => {
  if (!deps.memberLinks) throw new Error('no Member Center link signer');
  const token = await deps.memberLinks.memberToken(member, {
    now: clock(deps),
    ...(options.emailed ? { emailed: true } : {}),
  });
  return `${deps.captureOrigin}/m/${token}`;
};

// ---- Mail -----------------------------------------------------------------------------------

interface MemberChannelRow {
  member_id: string;
  email: string;
  first_name: string | null;
  status: MemberStatus;
  channel_id: string;
  workspace_id: string;
  channel_name: string;
  slug: string;
  branding_json: string;
  settings_json: string;
}

/** The Channel's confirm link lifetime: its `confirmDays` (1 to 30), else the default. */
function confirmLifetimeSeconds(settingsJson: string): number {
  const days = (JSON.parse(settingsJson) as { confirmDays?: unknown }).confirmDays;
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 30
    ? days * DAY_SECONDS
    : CONFIRM_LIFETIME_SECONDS;
}

async function loadMemberChannel(db: D1Database, memberId: string) {
  return first<MemberChannelRow>(
    db,
    `SELECT m.id AS member_id, m.email, m.first_name, m.status, m.channel_id, c.workspace_id,
            c.name AS channel_name, c.slug, c.branding_json, c.settings_json
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    memberId,
  );
}

const accentOf = (brandingJson: string) => {
  const accent = (JSON.parse(brandingJson) as { accentColor?: unknown }).accentColor;
  return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';
};

/** From the Channel's sender; the shared platform address when its own domain can't send. */
async function senderFor(deps: AudienceDeps, row: MemberChannelRow) {
  // resolveSender reads only the platform mail domain from the engine config.
  const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
  const channel = { id: row.channel_id, slug: row.slug, name: row.channel_name };
  const sender = await resolveSender(deps.db, config, channel, null);
  if (sender.problems.length === 0) return sender;
  return { ...sender, address: `${row.slug}@${deps.platformMailDomain}`, replyTo: null };
}

async function confirmationMail(
  deps: AudienceDeps,
  row: MemberChannelRow,
  input: { requestId: string; kind: ConfirmKind; reminder: boolean; expiresAt: number },
): Promise<OutgoingMail> {
  const now = clock(deps);
  const lifetime = Math.max(60, Math.floor((input.expiresAt - now) / 1000));
  const token = await confirmToken(
    deps.links,
    { requestId: input.requestId, channelId: row.channel_id },
    lifetime,
    now,
  );
  const leave = await leaveToken(
    deps.links,
    { memberId: row.member_id, channelId: row.channel_id },
    now,
  );
  const url = `${deps.captureOrigin}/v1/confirm/${token}`;
  const sender = await senderFor(deps, row);
  const name = row.channel_name;
  const returning = input.kind === 'return';
  const daysLeft = Math.max(1, Math.ceil(lifetime / DAY_SECONDS));
  const subject = returning
    ? `Welcome back to ${name}: confirm to rejoin`
    : input.reminder
      ? `Reminder: confirm your email for ${name}`
      : `Confirm your email for ${name}`;
  const body = memberMail({
    channelName: name,
    accent: accentOf(row.branding_json),
    heading: returning ? 'Welcome back' : 'Confirm your email',
    paragraphs: [
      returning
        ? `Someone asked to rejoin ${name} with this address. Confirm and you will start receiving it again.`
        : `Someone asked to join ${name} with this address. Confirm it was you and you are in.`,
      `The link works for ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}.`,
    ],
    button: { label: returning ? 'Confirm and rejoin' : 'Confirm my email', url },
    footnote: input.reminder
      ? 'This is the only reminder. If you did not ask for this, ignore it and you will not hear from us again.'
      : 'If you did not ask for this, ignore this email. Nothing happens unless you confirm.',
  });
  // Only the Channel's own values: the address here is one a stranger may have typed.
  const message = await composeMessage(deps.db, {
    key: returning ? 'rejoin' : input.reminder ? 'confirm_reminder' : 'confirm',
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    channelName: name,
    accent: accentOf(row.branding_json),
    variables: { channel_name: name, days_left: String(daysLeft), confirm_url: url },
    fallback: { subject, ...body },
  });
  return {
    category: input.reminder ? 'confirm_reminder' : 'confirm',
    from: { name: sender.name, address: sender.address },
    to: row.email,
    replyTo: sender.replyTo ?? sender.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: unsubscribeHeaders(`${deps.captureOrigin}/v1/leave/${leave}`, null),
    tags: { channel: row.channel_id, kind: input.kind },
  };
}

export type SendConfirmationResult = 'sent' | 'rate_limited' | 'skipped';

/**
 * Sends (or resends) a confirmation. Reuses the Member's open request of the same kind, so every
 * link sent for it confirms the same request. Rate limited per request and per Member per day.
 * Skips Members not in the status the kind confirms from, and suppressed addresses.
 */
export async function sendConfirmation(
  deps: AudienceDeps,
  input: { memberId: string; kind: ConfirmKind; formId?: string | null },
): Promise<SendConfirmationResult> {
  const { db } = deps;
  const now = clock(deps);
  const row = await loadMemberChannel(db, input.memberId);
  if (!row || row.status !== confirmsFrom(input.kind)) return 'skipped';
  if (await isSuppressedFor(db, row.workspace_id, row.channel_id, row.email)) return 'skipped';

  const expiresAt = now + confirmLifetimeSeconds(row.settings_json) * 1000;
  const open = await first<{ id: string; sent_count: number; last_sent_at: number }>(
    db,
    `SELECT id, sent_count, last_sent_at FROM confirm_requests
      WHERE member_id = ?1 AND kind = ?2 AND confirmed_at IS NULL AND expires_at > ?3
      ORDER BY created_at DESC LIMIT 1`,
    input.memberId,
    input.kind,
    now,
  );
  let requestId: string;
  if (open) {
    if (open.sent_count >= MAX_SENDS || open.last_sent_at > now - RESEND_INTERVAL_MS) {
      return 'rate_limited';
    }
    // Conditional on the last send, so two racing resends mail once.
    const claimed = await first(
      db,
      `UPDATE confirm_requests SET sent_count = sent_count + 1, last_sent_at = ?1, expires_at = ?2
        WHERE id = ?3 AND last_sent_at = ?4 RETURNING id`,
      now,
      expiresAt,
      open.id,
      open.last_sent_at,
    );
    if (!claimed) return 'rate_limited';
    requestId = open.id;
  } else {
    const today = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM confirm_requests WHERE member_id = ?1 AND created_at > ?2',
      input.memberId,
      now - DAY_SECONDS * 1000,
    );
    if ((today?.n ?? 0) >= MAX_REQUESTS_PER_DAY) return 'rate_limited';
    requestId = newIdFor('confirmRequest', now);
    await run(
      db,
      `INSERT INTO confirm_requests (id, member_id, channel_id, form_id, kind, sent_count, last_sent_at, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?6)`,
      requestId,
      input.memberId,
      row.channel_id,
      input.formId ?? null,
      input.kind,
      now,
      expiresAt,
    );
  }
  await deps.mail.send(
    await confirmationMail(deps, row, { requestId, kind: input.kind, reminder: false, expiresAt }),
  );
  return 'sent';
}

// ---- Confirming -------------------------------------------------------------------------------

export type ConfirmOutcome =
  | {
      outcome: 'confirmed';
      memberId: string;
      channelName: string;
      channelId: string;
      workspaceId: string;
      /** The signup form the request came from, or null (a returning subscriber, a checkout). */
      formId: string | null;
    }
  | { outcome: 'used' | 'expired' | 'not_found'; channelName: string | null };

interface RequestRow {
  id: string;
  member_id: string;
  kind: ConfirmKind;
  form_id: string | null;
  confirmed_at: number | null;
  expires_at: number;
  status: MemberStatus;
  channel_name: string;
  channel_id: string;
  workspace_id: string;
}

async function loadRequest(db: D1Database, requestId: string) {
  return first<RequestRow>(
    db,
    `SELECT q.id, q.member_id, q.kind, q.form_id, q.confirmed_at, q.expires_at, m.status, c.name AS channel_name,
            c.id AS channel_id, c.workspace_id
       FROM confirm_requests q JOIN members m ON m.id = q.member_id JOIN channels c ON c.id = q.channel_id
      WHERE q.id = ?1 AND c.deleted_at IS NULL`,
    requestId,
  );
}

/**
 * What the confirm page shows. Reads only: a GET never changes anything. `channelId` is the link's
 * tenant claim (null for a link from before the cutover): a request of another Channel is not found.
 */
export async function describeConfirmRequest(
  db: D1Database,
  requestId: string,
  now = Date.now(),
  channelId: string | null = null,
): Promise<{ state: 'open' | 'used' | 'expired' | 'not_found'; channelName: string | null }> {
  const row = await loadRequest(db, requestId);
  if (!row || (channelId !== null && row.channel_id !== channelId)) {
    return { state: 'not_found', channelName: null };
  }
  if (row.confirmed_at !== null || row.status !== confirmsFrom(row.kind)) {
    return { state: 'used', channelName: row.channel_name };
  }
  if (row.expires_at <= now) return { state: 'expired', channelName: row.channel_name };
  return { state: 'open', channelName: row.channel_name };
}

/**
 * Confirms a request. The Member moves to active only from the status the request was made for,
 * and only while the request is open; anything else (a replay, an expired link, a Member who has
 * since unsubscribed, bounced or complained) changes nothing.
 */
export async function confirmRequest(
  db: D1Database,
  requestId: string,
  now = Date.now(),
  /** The link's tenant claim, as for describeConfirmRequest. */
  channelId: string | null = null,
): Promise<ConfirmOutcome> {
  const row = await loadRequest(db, requestId);
  if (!row || (channelId !== null && row.channel_id !== channelId)) {
    return { outcome: 'not_found', channelName: null };
  }
  const from = confirmsFrom(row.kind);
  if (!canTransition(from, 'active', 'member')) throw new Error(`cannot confirm from ${from}`);
  if (row.expires_at <= now && row.confirmed_at === null) {
    return { outcome: 'expired', channelName: row.channel_name };
  }

  const [member, request] = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE members SET status = 'active', confirmed_at = ?1, consent_at = coalesce(consent_at, ?1),
                unsubscribed_at = NULL, unsubscribe_reason = NULL, paused_until = NULL, updated_at = ?1
          WHERE id = ?2 AND status = ?3
            AND EXISTS (SELECT 1 FROM confirm_requests q
                         WHERE q.id = ?4 AND q.member_id = ?2 AND q.kind = ?5
                           AND q.confirmed_at IS NULL AND q.expires_at > ?1)
         RETURNING id`,
      )
      .bind(now, row.member_id, from, requestId, row.kind),
    db
      .prepare(
        `UPDATE confirm_requests SET confirmed_at = ?1
          WHERE id = ?2 AND confirmed_at IS NULL
            AND EXISTS (SELECT 1 FROM members m WHERE m.id = ?3 AND m.status = 'active' AND m.confirmed_at = ?1)
         RETURNING id`,
      )
      .bind(now, requestId, row.member_id),
  ]);
  if (!member?.results.length || !request?.results.length) {
    return { outcome: 'used', channelName: row.channel_name };
  }
  // Other open requests for this Member are settled by the confirm too.
  await run(
    db,
    'UPDATE confirm_requests SET expires_at = ?1 WHERE member_id = ?2 AND confirmed_at IS NULL AND expires_at > ?1',
    now,
    row.member_id,
  );
  if (row.form_id) {
    await bumpFormDaily(db, row.form_id, 'confirmed', now);
    // Rosters (Phase 8): the form's Rosters, now that the Member has confirmed.
    await joinFormRosters(db, row.member_id, row.form_id, now);
  }
  await recordMemberEvent(
    db,
    {
      type: 'confirmed',
      memberId: row.member_id,
      payload: {
        method: row.kind === 'return' ? 'return' : 'double_opt_in',
        ...(row.form_id ? { formId: row.form_id } : {}),
      },
    },
    now,
  );
  return {
    outcome: 'confirmed',
    memberId: row.member_id,
    channelName: row.channel_name,
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    formId: row.form_id,
  };
}

/**
 * The List-Unsubscribe target of confirmation mail: a pending Member leaves (pending →
 * unsubscribed), and every open request stops, so no reminder follows.
 */
export async function leaveBeforeConfirming(
  db: D1Database,
  memberId: string,
  now = Date.now(),
  /** The link's tenant claim (null before the cutover): a Member of another Channel is not found. */
  channelId: string | null = null,
): Promise<{ channelName: string } | null> {
  const row = await loadMemberChannel(db, memberId);
  if (!row || (channelId !== null && row.channel_id !== channelId)) return null;
  if (row.status === 'pending' && canTransition('pending', 'unsubscribed', 'member')) {
    await db.batch([
      // member.unsubscribed webhooks (Phase 7), before the update.
      memberUnsubscribedStatement(db, memberId, ['pending'], now),
      db
        .prepare(
          `UPDATE members SET status = 'unsubscribed', unsubscribed_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'pending'`,
        )
        .bind(now, memberId),
    ]);
  }
  await run(
    db,
    'UPDATE confirm_requests SET expires_at = ?1 WHERE member_id = ?2 AND confirmed_at IS NULL AND expires_at > ?1',
    now,
    memberId,
  );
  return { channelName: row.channel_name };
}

// ---- Gentle Reminders -------------------------------------------------------------------------

/**
 * Sends one reminder for each open sign-up request whose last send was REMINDER_AFTER_MS ago, if
 * the Member is still pending. Someone who unsubscribed gets no second mail about rejoining. The
 * reminder is claimed with a conditional UPDATE first, so a request is reminded at most once
 * even when two cron runs overlap. Returns the number sent.
 */
export async function sendGentleReminders(deps: AudienceDeps, limit = 50): Promise<number> {
  const { db } = deps;
  const now = clock(deps);
  const due = await all<{ id: string }>(
    db,
    `SELECT q.id FROM confirm_requests q JOIN members m ON m.id = q.member_id
      WHERE q.confirmed_at IS NULL AND q.reminded_at IS NULL AND q.last_sent_at <= ?1 AND q.expires_at > ?2
        AND q.kind = 'subscribe' AND m.status = 'pending'
      ORDER BY q.last_sent_at LIMIT ?3`,
    now - REMINDER_AFTER_MS,
    now + 60_000,
    limit,
  );
  let sent = 0;
  for (const { id } of due) {
    const claimed = await first<{ member_id: string; kind: ConfirmKind; expires_at: number }>(
      db,
      'UPDATE confirm_requests SET reminded_at = ?1 WHERE id = ?2 AND reminded_at IS NULL RETURNING member_id, kind, expires_at',
      now,
      id,
    );
    if (!claimed) continue;
    const row = await loadMemberChannel(db, claimed.member_id);
    if (!row || row.status !== confirmsFrom(claimed.kind)) continue;
    if (await isSuppressedFor(db, row.workspace_id, row.channel_id, row.email)) continue;
    await deps.mail.send(
      await confirmationMail(deps, row, {
        requestId: id,
        kind: claimed.kind,
        reminder: true,
        expiresAt: claimed.expires_at,
      }),
    );
    sent++;
  }
  return sent;
}

// ---- Capture Form daily counts ----------------------------------------------------------------

const DAILY_COLUMNS = new Set(['views', 'submissions', 'confirmed']);

/** Adds one to a form's count for today (UTC). */
export async function bumpFormDaily(
  db: D1Database,
  formId: string,
  column: 'views' | 'submissions' | 'confirmed',
  now = Date.now(),
): Promise<void> {
  if (!DAILY_COLUMNS.has(column)) throw new Error(`unknown column ${column}`);
  const day = new Date(now).toISOString().slice(0, 10);
  await run(
    db,
    `INSERT INTO capture_form_daily (form_id, day, ${column}) VALUES (?1, ?2, 1)
     ON CONFLICT (form_id, day) DO UPDATE SET ${column} = ${column} + 1`,
    formId,
    day,
  );
}
