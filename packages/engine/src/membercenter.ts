/**
 * The Member Center: what a Member can see and change about themselves through a signed link
 * (purpose "member", 30 days). Every status change goes through the domain state machine with the
 * actor "member", and is a conditional UPDATE on the status it was read in.
 */
import { canTransition, type DIGESTS, type FieldValue, type MemberStatus } from '@swarm/domain';
import type { EngineConfig } from './config';
import { memberCenterUrl, sendConfirmation, type AudienceDeps } from './confirm';
import { MemberLinkRefused } from './links';
import { composeMessage, memberMail } from './messages';
import { all, first, run } from './db';
import { fieldChangedEventStatement } from './events';
import { memberUnsubscribedStatement } from './platform-events';
import { normalizeFieldValue, plainFromStored, storedValue, type FieldDef } from './fields';
import { sealEncrypted } from './members';
import type { FieldVault } from './vault-ports';
import { resolveSender } from './start';
import { channelSettings, profilingSql } from './tracking-choices';

type Digest = (typeof DIGESTS)[number];

export const PAUSE_WEEKS = [2, 4, 8] as const;
export type PauseWeeks = (typeof PAUSE_WEEKS)[number];

export interface CenterField extends FieldDef {
  id: string;
  label: string;
  value: FieldValue;
}

export interface CenterView {
  member: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: MemberStatus;
    digest: Digest;
    pausedUntil: number | null;
    /** They asked not to have their opens and clicks tracked (tracking-choices.ts). */
    trackingOff: boolean;
    /** "Stop emails, keep my membership": posts and automation emails skip them (setMemberEmails). */
    emailsOff: boolean;
    /** Member Center links issued before this (ms) no longer work; null when none were ended. */
    linksAfter: number | null;
    /** Told they will be unsubscribed as an inactive reader (sunsetInactiveMembers), or null. */
    sunsetNoticeAt: number | null;
    /** They were unsubscribed by the inactive-reader rule: its recorded reason. */
    sunsetReason: string | null;
  };
  channel: {
    id: string;
    workspaceId: string;
    name: string;
    accent: string;
    /** What the publication tracks per person now. */
    tracks: { opens: boolean; clicks: boolean };
  };
  fields: CenterField[];
  /** Encrypted values exist but the vault couldn't open them: they show as unavailable. */
  fieldsUnavailable: boolean;
}

interface FieldRow {
  id: string;
  key: string;
  label: string;
  type: FieldDef['type'];
  options_json: string;
  encrypted: number;
  value_text: string | null;
  value_num: number | null;
  value_enc: string | null;
}

async function fieldRows(db: D1Database, channelId: string, memberId: string) {
  return all<FieldRow>(
    db,
    `SELECT f.id, f.key, f.label, f.type, f.options_json, f.encrypted, v.value_text, v.value_num, v.value_enc
       FROM member_fields f LEFT JOIN member_field_values v ON v.field_id = f.id AND v.member_id = ?2
      WHERE f.channel_id = ?1 AND f.deleted_at IS NULL
      ORDER BY f.position, f.created_at`,
    channelId,
    memberId,
  );
}

const toDef = (row: FieldRow): FieldDef & { id: string; label: string } => ({
  id: row.id,
  key: row.key,
  label: row.label,
  type: row.type,
  options: JSON.parse(row.options_json) as string[],
  encrypted: row.encrypted === 1,
});

/**
 * Everything the Member Center page shows. Encrypted fields are opened by the vault, for the
 * link's own Member (@swarm/vault openMemberCenter): `opened` is what it opened, by field key;
 * null when it couldn't be reached (they show as unavailable); undefined where they aren't shown.
 */
export async function loadMemberCenter(
  db: D1Database,
  opened: Record<string, FieldValue> | null | undefined,
  memberId: string,
): Promise<CenterView | null> {
  const row = await first<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    status: MemberStatus;
    digest: Digest;
    paused_until: number | null;
    tracking_opt_out_at: number | null;
    emails_off_at: number | null;
    member_links_after: number | null;
    sunset_notice_at: number | null;
    unsubscribe_reason: string | null;
    channel_id: string;
    workspace_id: string;
    channel_name: string;
    branding_json: string;
    settings_json: string;
  }>(
    db,
    `SELECT m.id, m.email, m.first_name, m.last_name, m.status, m.digest, m.paused_until,
            m.tracking_opt_out_at, m.emails_off_at, m.member_links_after, m.sunset_notice_at, m.unsubscribe_reason, m.channel_id,
            c.workspace_id, c.name AS channel_name, c.branding_json, c.settings_json
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    memberId,
  );
  if (!row) return null;
  const accent = (JSON.parse(row.branding_json) as { accentColor?: unknown }).accentColor;
  const fields: CenterField[] = [];
  let fieldsUnavailable = false;
  for (const f of await fieldRows(db, row.channel_id, memberId)) {
    const def = toDef(f);
    let value: FieldValue = null;
    if (f.value_enc !== null) {
      value = opened?.[def.key] ?? null;
      if (opened === null) fieldsUnavailable = true;
    } else if (f.value_text !== null || f.value_num !== null) {
      value = plainFromStored(def, f);
    }
    fields.push({ ...def, value });
  }
  return {
    member: {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      status: row.status,
      digest: row.digest,
      pausedUntil: row.paused_until,
      trackingOff: row.tracking_opt_out_at !== null,
      emailsOff: row.emails_off_at !== null,
      linksAfter: row.member_links_after,
      sunsetNoticeAt: row.status === 'active' ? row.sunset_notice_at : null,
      sunsetReason:
        row.status === 'unsubscribed' && row.unsubscribe_reason?.startsWith(SUNSET_REASON_PREFIX)
          ? row.unsubscribe_reason
          : null,
    },
    channel: {
      id: row.channel_id,
      workspaceId: row.workspace_id,
      name: row.channel_name,
      accent: typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1',
      tracks: {
        opens: channelSettings(row.settings_json).trackOpens,
        clicks: channelSettings(row.settings_json).trackClicks,
      },
    },
    fields,
    fieldsUnavailable,
  };
}

/**
 * Updates name and profile fields. Values are validated against each field's type (a
 * FieldValueError names the field that failed) and encrypted fields are sealed by the vault for
 * this Member (`seal`, @swarm/vault sealMemberCenterFields; it throws when it can't, and nothing
 * is written). Keys that aren't fields of the Channel are ignored.
 */
export async function updateMemberProfile(
  db: D1Database,
  seal: FieldVault['seal'],
  memberId: string,
  input: { firstName?: string | null; lastName?: string | null; fields?: Record<string, unknown> },
  now = Date.now(),
): Promise<void> {
  const member = await first<{
    channel_id: string;
    first_name: string | null;
    last_name: string | null;
  }>(db, 'SELECT channel_id, first_name, last_name FROM members WHERE id = ?1', memberId);
  if (!member) return;
  const clean = (value: string | null | undefined, fallback: string | null) =>
    value === undefined ? fallback : value?.trim().slice(0, 80) || null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare('UPDATE members SET first_name = ?1, last_name = ?2, updated_at = ?3 WHERE id = ?4')
      .bind(
        clean(input.firstName, member.first_name),
        clean(input.lastName, member.last_name),
        now,
        memberId,
      ),
  ];
  const defs = new Map(
    (await fieldRows(db, member.channel_id, memberId)).map((row) => [row.key, toDef(row)]),
  );
  const values: { def: FieldDef & { id: string }; value: FieldValue }[] = [];
  for (const [key, raw] of Object.entries(input.fields ?? {})) {
    const def = defs.get(key);
    if (def) values.push({ def, value: normalizeFieldValue(def, raw) });
  }
  const sealed = await sealEncrypted(
    { seal },
    memberId,
    values.map(({ def, value }) => ({ field: def, value })),
  );
  for (const { def, value } of values) {
    const stored = storedValue(def, value, sealed[def.key]);
    statements.push(
      fieldChangedEventStatement(db, memberId, def.id, stored, now),
      stored
        ? db
            .prepare(
              `INSERT INTO member_field_values (member_id, field_id, value_text, value_num, value_enc, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT (member_id, field_id) DO UPDATE SET value_text = ?3, value_num = ?4, value_enc = ?5, updated_at = ?6`,
            )
            .bind(memberId, def.id, stored.value_text, stored.value_num, stored.value_enc, now)
        : db
            .prepare('DELETE FROM member_field_values WHERE member_id = ?1 AND field_id = ?2')
            .bind(memberId, def.id),
    );
  }
  await db.batch(statements);
}

async function statusOf(db: D1Database, memberId: string) {
  return (
    await first<{ status: MemberStatus }>(db, 'SELECT status FROM members WHERE id = ?1', memberId)
  )?.status;
}

/** Pauses (or extends a pause) for 2, 4 or 8 weeks. Returns false when the status doesn't allow it. */
export async function pauseMember(
  db: D1Database,
  memberId: string,
  weeks: PauseWeeks,
  now = Date.now(),
): Promise<boolean> {
  if (!PAUSE_WEEKS.includes(weeks)) return false;
  const status = await statusOf(db, memberId);
  if (!status || (status !== 'paused' && !canTransition(status, 'paused', 'member'))) return false;
  const result = await run(
    db,
    `UPDATE members SET status = 'paused', paused_until = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4`,
    now + weeks * 7 * 86_400_000,
    now,
    memberId,
    status,
  );
  return result.meta.changes > 0;
}

export async function resumeMember(db: D1Database, memberId: string, now = Date.now()) {
  if (!canTransition('paused', 'active', 'member')) return false;
  const result = await run(
    db,
    `UPDATE members SET status = 'active', paused_until = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'paused'`,
    now,
    memberId,
  );
  return result.meta.changes > 0;
}

export async function setMemberDigest(
  db: D1Database,
  memberId: string,
  digest: Digest,
  now = Date.now(),
): Promise<boolean> {
  const result = await run(
    db,
    'UPDATE members SET digest = ?1, updated_at = ?2 WHERE id = ?3',
    digest,
    now,
    memberId,
  );
  return result.meta.changes > 0;
}

/**
 * "Stop emails, keep my membership" (off), or emails back on (on). Only the mail choice changes:
 * the status, the paid subscription, website access and reader sessions stay as they are, and mail
 * that belongs to the service (receipts, sign-in links, billing notices) still goes. Posts and
 * automation emails skip them while it is set (security review S03-P5-G-paid-mail-choice). Active
 * and paused Members choose it; anyone can turn emails back on. False when nothing changed.
 */
export async function setMemberEmails(
  db: D1Database,
  memberId: string,
  on: boolean,
  now = Date.now(),
): Promise<boolean> {
  const result = on
    ? await run(
        db,
        'UPDATE members SET emails_off_at = NULL, updated_at = ?1 WHERE id = ?2 AND emails_off_at IS NOT NULL',
        now,
        memberId,
      )
    : await run(
        db,
        `UPDATE members SET emails_off_at = ?1, updated_at = ?1
          WHERE id = ?2 AND emails_off_at IS NULL AND status IN ('active', 'paused')`,
        now,
        memberId,
      );
  return result.meta.changes > 0;
}

/** Unsubscribes with an optional reason. Pending, active and paused Members may leave. */
export async function unsubscribeMember(
  db: D1Database,
  memberId: string,
  reason: string | null,
  now = Date.now(),
): Promise<boolean> {
  const status = await statusOf(db, memberId);
  if (!status || !canTransition(status, 'unsubscribed', 'member')) return false;
  const [, result] = (await db.batch([
    // member.unsubscribed webhooks (Phase 7), before the update.
    memberUnsubscribedStatement(db, memberId, [status], now),
    db
      .prepare(
        `UPDATE members SET status = 'unsubscribed', unsubscribed_at = ?1, unsubscribe_reason = ?2,
                paused_until = NULL, updated_at = ?1
          WHERE id = ?3 AND status = ?4`,
      )
      .bind(now, reason?.trim().slice(0, 500) || null, memberId, status),
  ])) as [D1Result, D1Result];
  await run(
    db,
    'UPDATE confirm_requests SET expires_at = ?1 WHERE member_id = ?2 AND confirmed_at IS NULL AND expires_at > ?1',
    now,
    memberId,
  );
  return result.meta.changes > 0;
}

/** An unsubscribed Member asks to come back: they get a "welcome back, confirm" email. */
export const requestRejoin = (deps: AudienceDeps, memberId: string) =>
  sendConfirmation(deps, { memberId, kind: 'return' });

/**
 * Emails a fresh Member Center link for each Channel (at most five) this address belongs to,
 * or only `channelId` when given. Callers answer the same way whatever this finds.
 */
export async function sendMemberCenterLinks(
  deps: AudienceDeps,
  email: string,
  channelId: string | null,
): Promise<number> {
  const { db } = deps;
  const rows = await all<{
    id: string;
    email: string;
    channel_id: string;
    channel_name: string;
    slug: string;
    branding_json: string;
  }>(
    db,
    `SELECT m.id, m.email, m.channel_id, c.name AS channel_name, c.slug, c.branding_json
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.email = ?1 AND (?2 IS NULL OR m.channel_id = ?2) AND c.deleted_at IS NULL
        AND m.status IN ('pending', 'active', 'paused', 'unsubscribed')
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))
      ORDER BY m.created_at LIMIT 5`,
    email.trim().toLowerCase(),
    channelId,
  );
  for (const row of rows) {
    // Sent only to the address, so it may also delete data or change a paid level for a while.
    // The minter (the vault, for capture) decides from the request itself which Members get one.
    const url = await memberCenterUrl(
      deps,
      { memberId: row.id, channelId: row.channel_id },
      { emailed: true },
    ).catch((error: unknown) => {
      if (error instanceof MemberLinkRefused) return null;
      throw error;
    });
    if (!url) continue;
    const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
    const sender = await resolveSender(
      db,
      config,
      { id: row.channel_id, slug: row.slug, name: row.channel_name },
      null,
    );
    const address = sender.problems.length
      ? `${row.slug}@${deps.platformMailDomain}`
      : sender.address;
    const accent = (JSON.parse(row.branding_json) as { accentColor?: unknown }).accentColor;
    const body = memberMail({
      channelName: row.channel_name,
      accent: typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1',
      heading: 'Manage your subscription',
      paragraphs: [
        `Use this link to update your details, pause or change how often you hear from ${row.channel_name}.`,
        'The link works for 30 days.',
      ],
      button: { label: 'Manage your subscription', url },
      footnote:
        'If you did not ask for this, you can ignore it. Nobody can use the link without this email.',
    });
    const message = await composeMessage(db, {
      key: 'member_center',
      channelId: row.channel_id,
      channelName: row.channel_name,
      accent: typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1',
      variables: { channel_name: row.channel_name, center_url: url },
      fallback: { subject: `Manage your subscription to ${row.channel_name}`, ...body },
    });
    await deps.mail.send({
      category: 'member_center',
      from: { name: sender.name, address },
      to: row.email,
      replyTo: sender.replyTo ?? address,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: { channel: row.channel_id },
    });
  }
  return rows.length;
}

/**
 * Turns off every Member Center link issued before `issuedBefore` (ms) for one Member: footer
 * links in old emails and links forwarded on stop working, and the link in use keeps working.
 * Never moves the moment backwards.
 */
export async function endOlderMemberLinks(
  db: D1Database,
  memberId: string,
  issuedBefore: number,
  now = Date.now(),
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE members SET member_links_after = ?1, updated_at = ?2
      WHERE id = ?3 AND (member_links_after IS NULL OR member_links_after < ?1)`,
    issuedBefore,
    now,
    memberId,
  );
  return result.meta.changes > 0;
}

/** A change made through a Member Center link that the Member's address is told about. */
export type MemberChange =
  | 'profile'
  | 'unsubscribe'
  | 'tracking_off'
  | 'tracking_on'
  | 'emails_off'
  | 'emails_on'
  | 'cancel_membership'
  | 'keep_membership'
  | 'cancel_paypal'
  | 'payment_method'
  | 'change_level'
  | 'end_links';

/** What the notice says happened, and what the button lets them do about it. */
const CHANGE_WORDING: Record<MemberChange, { what: string; undo: string }> = {
  profile: {
    what: 'Your name or profile details were changed.',
    undo: 'If this wasn’t you, open your settings to put them back.',
  },
  unsubscribe: {
    what: 'You were unsubscribed and won’t receive more posts.',
    undo: 'If this wasn’t you, open your settings and choose Join again.',
  },
  tracking_off: {
    what: 'Tracking of your opens and clicks was turned off, and the opens and clicks recorded for you were deleted.',
    undo: 'Deleted history can’t be brought back. If this wasn’t you, you can turn tracking on again in your settings.',
  },
  tracking_on: {
    what: 'Tracking of your opens and clicks was turned back on.',
    undo: 'If this wasn’t you, open your settings and turn it off again.',
  },
  emails_off: {
    what: 'Emails were turned off: you won’t receive posts or automation emails. Your subscription, and any paid subscription, stay as they are.',
    undo: 'If this wasn’t you, open your settings and turn emails back on.',
  },
  emails_on: {
    what: 'Emails were turned back on: you will receive posts again.',
    undo: 'If this wasn’t you, open your settings and choose Stop emails.',
  },
  cancel_membership: {
    what: 'Your paid subscription was set to end when the current period ends.',
    undo: 'If this wasn’t you, open your settings and choose Keep my subscription.',
  },
  keep_membership: {
    what: 'Your paid subscription was set to continue after the current period.',
    undo: 'If this wasn’t you, open your settings to cancel it again.',
  },
  cancel_paypal: {
    what: 'Your PayPal subscription was canceled. It ends when the period you paid for ends.',
    undo: 'A PayPal cancellation can’t be undone from here. If this wasn’t you, subscribe again from the publication’s website and reply to this email.',
  },
  payment_method: {
    what: 'Someone opened the page to change the payment method for your paid subscription.',
    undo: 'If this wasn’t you, open your settings to check your payment details, and turn off older links there.',
  },
  change_level: {
    what: 'Your paid subscription was moved to another plan.',
    undo: 'If this wasn’t you, open your settings to change it back.',
  },
  end_links: {
    what: 'Older links to your subscriber settings were turned off.',
    undo: 'Links in older emails no longer open your settings. Use the button below, or ask for a new link, when you need them.',
  },
};

/**
 * Tells a Member's address about a change made through their Member Center link, with a fresh
 * link (emailed, so it also allows the changes that need one) to look or put it back. Sent for
 * billing, profile, unsubscribe and tracking changes: the footer link travels with forwarded mail,
 * so the address learns of anything done with it. Strictly transactional, never marketing.
 */
export async function sendMemberChangeNotice(
  deps: AudienceDeps,
  memberId: string,
  change: MemberChange,
): Promise<boolean> {
  const { db } = deps;
  const row = await first<{
    id: string;
    email: string;
    status: MemberStatus;
    channel_id: string;
    channel_name: string;
    slug: string;
    branding_json: string;
  }>(
    db,
    `SELECT m.id, m.email, m.status, m.channel_id, c.name AS channel_name, c.slug, c.branding_json
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))`,
    memberId,
  );
  // Mail can't reach a bounced or complained address.
  if (!row || row.status === 'bounced' || row.status === 'complained') return false;
  const url = await memberCenterUrl(
    deps,
    { memberId: row.id, channelId: row.channel_id },
    { emailed: true },
  );
  const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
  const sender = await resolveSender(
    db,
    config,
    { id: row.channel_id, slug: row.slug, name: row.channel_name },
    null,
  );
  const address = sender.problems.length
    ? `${row.slug}@${deps.platformMailDomain}`
    : sender.address;
  const brand = (JSON.parse(row.branding_json) as { accentColor?: unknown }).accentColor;
  const accent = typeof brand === 'string' && /^#[0-9a-f]{6}$/i.test(brand) ? brand : '#6c4cf1';
  const wording = CHANGE_WORDING[change];
  const body = memberMail({
    channelName: row.channel_name,
    accent,
    heading: 'A change to your subscription',
    paragraphs: [
      `${wording.what} This was done with a link to your subscriber settings for ${row.channel_name}.`,
      wording.undo,
    ],
    button: { label: 'Open my settings', url },
    footnote:
      'The button works for 30 days, and for an hour it also allows changes that need a fresh link. If someone else has your links, turn off older links from your settings.',
  });
  await deps.mail.send({
    category: 'member_change',
    from: { name: sender.name, address },
    to: row.email,
    replyTo: sender.replyTo ?? address,
    subject: `A change to your subscription to ${row.channel_name}`,
    html: body.html,
    text: body.text,
    tags: { channel: row.channel_id },
  });
  return true;
}

/** Only people who have really been given the chance to read: enough emails, none opened. */
export const SUNSET_MIN_SENT = 5;
/** A reader is told first and removed no sooner than this many days after the notice. */
export const SUNSET_NOTICE_DAYS = 14;
/**
 * A notice older than this no longer counts: a reader who reads again after one and goes quiet
 * later gets a fresh notice. Shorter than the shortest period (90 days).
 */
export const SUNSET_NOTICE_VALID_DAYS = 60;
/** Notices sent per run, across Channels: each is one email, and the cron runs every 5 minutes. */
export const SUNSET_NOTICE_BATCH = 50;
/** Every automatic unsubscribe's reason starts with this, so a publisher can find and review them. */
export const SUNSET_REASON_PREFIX = 'Automatic: inactive-reader rule';
const SUNSET_BATCH = 500;
const DAY_MS = 86_400_000;
/** retention.ts MONTH_MS, an average month. */
const RETENTION_MONTH_MS = 2_629_746_000;

export interface SunsetResult {
  unsubscribed: number;
  noticed: number;
  /** Channels whose period is longer than the history the workspace keeps: nothing is done there. */
  unmeasurable: number;
}

interface SunsetCandidate {
  id: string;
  email: string;
  sunset_notice_at: number | null;
  sent: number;
}

/**
 * Unsubscribes readers who haven't opened or clicked for a Channel's `sunsetDays`. Off unless the
 * owner chose a time. Runs from the five-minute cron, in batches, through the same path as someone
 * leaving themselves. A person's status changes only on positive evidence:
 *
 * - The whole period is measured. Engagement is read from the person's own deliveries since the
 *   cutoff, not from the 90-day score, and only where the workspace keeps delivery history for at
 *   least the chosen period (engagement_retention_months, retention.ts); a Channel whose period is
 *   longer than that is skipped (`unmeasurable`), because missing history is unknown, not old.
 *   Nothing sent before the workspace's history limit is read, even while the retention job has
 *   not yet removed the person from it.
 * - They were measurable. At least SUNSET_MIN_SENT emails with an open pixel went to them in the
 *   period, and a reader the score treats as unknowable (`opens_hidden`: machine opens only, which
 *   a privacy proxy produces) or as having too few emails is never treated as inactive, nor is
 *   anyone whose emails in the period were mostly opened by a machine only.
 * - They were told. The first time someone qualifies they get one email saying so, with a link to
 *   their subscriber settings, where one click keeps them (sunset_kept_at, which counts like an
 *   open). Only SUNSET_NOTICE_DAYS after a notice (and while it is under SUNSET_NOTICE_VALID_DAYS
 *   old) are they unsubscribed, with a reason that says it was automatic and on what evidence.
 * - Needs a recent engagement rollup: without one, nobody counts as inactive.
 *
 * Never where opens aren't seen: a publication with open tracking or reader profiling off is
 * skipped (its scores are deleted on the next rollup, and skipping here covers the time until
 * then), and so is anyone who asked not to be tracked, and anyone with a paid entitlement.
 */
export async function sunsetInactiveMembers(
  deps: AudienceDeps,
  now = Date.now(),
): Promise<SunsetResult> {
  const { db } = deps;
  const channels = await all<{
    id: string;
    name: string;
    slug: string;
    branding_json: string;
    workspace_id: string;
    days: number;
    months: number;
  }>(
    db,
    `SELECT c.id, c.name, c.slug, c.branding_json, c.workspace_id,
            json_extract(c.settings_json, '$.sunsetDays') AS days,
            w.engagement_retention_months AS months
       FROM channels c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.deleted_at IS NULL AND c.status = 'active'
        AND json_extract(c.settings_json, '$.sunsetDays') >= 90 AND ${profilingSql('c')}`,
  );
  const result: SunsetResult = { unsubscribed: 0, noticed: 0, unmeasurable: 0 };
  let noticeBudget = SUNSET_NOTICE_BATCH;
  for (const channel of channels) {
    const cutoff = now - channel.days * DAY_MS;
    // Where the workspace's engagement history ends. Older deliveries no longer name the person
    // (or are about to, the retention job works in batches), so the period can't be seen in full
    // and nothing older is read.
    const historyFloor = now - channel.months * RETENTION_MONTH_MS;
    if (historyFloor > cutoff) {
      result.unmeasurable += 1;
      continue;
    }
    const graceCutoff = now - SUNSET_NOTICE_DAYS * DAY_MS;
    const counted = `d.member_id = m.id AND d.sent_at >= ?2 AND d.sent_at < ?6
          AND d.status NOT IN ('failed', 'bounced') AND d.tracked = 1
          AND EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = d.broadcast_id AND b.track_opens = 1)`;
    const rows = await all<SunsetCandidate>(
      db,
      `SELECT id, email, sunset_notice_at, sent FROM (
         SELECT m.id, m.email, m.sunset_notice_at,
                (SELECT count(*) FROM deliveries d WHERE ${counted}) AS sent,
                (SELECT count(*) FROM deliveries d WHERE ${counted}
                    AND d.opened_at IS NOT NULL AND d.human_opened_at IS NULL
                    AND d.human_clicked_at IS NULL) AS machine_only
           FROM members m JOIN member_engagement e ON e.member_id = m.id
          WHERE m.channel_id = ?1 AND m.status = 'active' AND m.created_at < ?2
            AND m.tracking_opt_out_at IS NULL AND m.emails_off_at IS NULL
            AND coalesce(m.sunset_kept_at, 0) < ?2
            AND (m.sunset_notice_at IS NULL OR m.sunset_notice_at < ?7)
            AND e.computed_at > ?4 AND e.band NOT IN ('opens_hidden', 'too_few_posts')
            AND coalesce(e.last_engaged_at, 0) < ?2
            AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.member_id = m.id AND d.sent_at >= ?8
                             AND (d.human_opened_at >= ?2 OR d.human_clicked_at >= ?2))
            AND NOT EXISTS (SELECT 1 FROM member_entitlements me
                             WHERE me.member_id = m.id AND me.kind = 'paid'
                               AND (me.expires_at IS NULL OR me.expires_at > ?5)))
        WHERE sent >= ?3 AND machine_only * 2 < sent
        LIMIT ${SUNSET_BATCH}`,
      channel.id,
      cutoff,
      SUNSET_MIN_SENT,
      now - 7 * DAY_MS,
      now,
      now - DAY_MS,
      graceCutoff,
      historyFloor,
    );
    const validFrom = now - SUNSET_NOTICE_VALID_DAYS * DAY_MS;
    for (const row of rows) {
      const noticed = row.sunset_notice_at;
      if (noticed !== null && noticed >= validFrom && noticed < graceCutoff) {
        const reason =
          `${SUNSET_REASON_PREFIX} (${channel.days} days): ${row.sent} emails with an open pixel ` +
          `since ${dayOf(cutoff)} and no opens or clicks; told on ${dayOf(noticed)}.`;
        if (await unsubscribeMember(db, row.id, reason, now)) result.unsubscribed += 1;
        continue;
      }
      if (noticeBudget <= 0) continue;
      noticeBudget -= 1;
      await sendSunsetNotice(deps, channel, row, now);
      await run(
        db,
        "UPDATE members SET sunset_notice_at = ?1 WHERE id = ?2 AND status = 'active'",
        now,
        row.id,
      );
      result.noticed += 1;
    }
  }
  return result;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function sendSunsetNotice(
  deps: AudienceDeps,
  channel: { id: string; name: string; slug: string; branding_json: string; days: number },
  member: { id: string; email: string },
  now: number,
) {
  const url = await memberCenterUrl(
    { ...deps, now: () => now },
    { memberId: member.id, channelId: channel.id },
    { emailed: true },
  );
  const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
  const sender = await resolveSender(
    deps.db,
    config,
    { id: channel.id, slug: channel.slug, name: channel.name },
    null,
  );
  const address = sender.problems.length
    ? `${channel.slug}@${deps.platformMailDomain}`
    : sender.address;
  const rawAccent = (JSON.parse(channel.branding_json) as { accentColor?: unknown }).accentColor;
  const accent =
    typeof rawAccent === 'string' && /^#[0-9a-f]{6}$/i.test(rawAccent) ? rawAccent : '#6c4cf1';
  const months = Math.round(channel.days / 30);
  const body = memberMail({
    channelName: channel.name,
    accent,
    heading: 'Do you still want these emails?',
    paragraphs: [
      `We haven’t seen you open or click an email from ${channel.name} in about ${months} months, so we will stop sending them in ${SUNSET_NOTICE_DAYS} days.`,
      'If you still read them, one click keeps you subscribed. Your mail app may hide that you open them, so we can’t always tell.',
      'If you are unsubscribed, you can join again at any time from the same page.',
    ],
    button: { label: 'Keep me subscribed', url },
    footnote: 'If you’d rather stop, you don’t need to do anything.',
  });
  await deps.mail.send({
    category: 'member_center',
    from: { name: sender.name, address },
    to: member.email,
    replyTo: sender.replyTo ?? address,
    subject: `Do you still want emails from ${channel.name}?`,
    html: body.html,
    text: body.text,
    tags: { channel: channel.id },
  });
}

/**
 * The reader chose to stay after a notice: it counts like an open, so the inactive period starts
 * again now. Only while they are active and were told.
 */
export async function keepAfterSunsetNotice(
  db: D1Database,
  memberId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE members SET sunset_kept_at = ?1, sunset_notice_at = NULL, updated_at = ?1
      WHERE id = ?2 AND status = 'active' AND sunset_notice_at IS NOT NULL`,
    now,
    memberId,
  );
  return result.meta.changes > 0;
}
