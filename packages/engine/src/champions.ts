/**
 * Champions (Phase 6): referrals with milestones and rewards.
 *
 * - Codes. A Member's champion_code (CHAMPION_CODE in @swarm/domain) is assigned on first use,
 *   unique per Channel; a collision is retried with a fresh code. The share link is
 *   <site origin>/?ref=<code>, the short one <site origin>/r/<code> (the site worker).
 * - Referrals. Recorded at sign-up (subscribe.ts) as 'pending' with the sign-up's /24 or /48
 *   (never the full address). Self-referrals are refused; with block_disposable a disposable
 *   address is recorded as 'rejected' (disposable_domain).
 * - Counting (countReferrals, every minute from the jobs worker), in this order:
 *     1. more than cluster_limit referrals for one Champion from one network prefix within
 *        cluster_window_hours (counting back from each referral) → 'held' (ip_cluster);
 *     2. the referred Member left (unsubscribed, bounced, complained) → 'rejected' (unsubscribed);
 *     3. confirmed and at least one human open within engagement_days of confirming → 'counted';
 *     4. still pending after engagement_days (of confirming, or of the referral when never
 *        confirmed) → 'rejected' (not_engaged).
 *   Operators approve held referrals ('counted') or reject them ('rejected', operator).
 * - Milestones. When a Champion's counted referrals reach an active milestone (and Champions is on
 *   for the Channel), a champion_awards row is inserted; UNIQUE (member_id, milestone_id) makes
 *   that happen once however many runs race. Only the run that inserted it fulfils it:
 *   comp_level → a comp grant for comp_days (grantComp) and the entitlement recomputed;
 *   coupon → the coupon code by email; manual and goods (Phase 8) → left 'pending' for the
 *   operator. The Champion gets an email either way. fulfil_flow_id is kept for a Flow-sent
 *   email later: the built-in email is still sent.
 * - Flow triggers. While Champions is on for the Channel, a referral that becomes 'counted' emits
 *   referral_succeeded to the Champion, and a new award emits referral_milestone. Referrals counted
 *   while it is off emit nothing, then or later. Each commits in one batch with the change it
 *   describes (the event first, while the old state still selects it), so it fires exactly once.
 *   Nothing about the referred Member goes in the payload except the referral's id.
 */
import {
  CHAMPION_CODE,
  CHAMPION_DEFAULTS,
  type ChampionRewardKind,
  type MemberStatus,
} from '@swarm/domain';
import { ipPrefix, isUniqueViolation } from '@swarm/db';
import type { MailAdapter } from '@swarm/mail';
import { isDisposableAddress } from './addresses';
import { grantComp } from './comp';
import type { MemberLinkMinter } from './links';
import { composeMessage, memberMail } from './messages';
import type { EngineConfig } from './config';
import { all, first, newIdFor, run } from './db';
import { resolveSender } from './start';
import { isSuppressedFor } from './suppressions';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MEMBER_ID = /^mb_[0-9a-f]{32}$/;

// ---- Codes ----------------------------------------------------------------------------------

/** The CHAMPION_CODE alphabet: lowercase letters and digits without look-alikes (31 symbols). */
export const CHAMPION_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CHAMPION_CODE_LENGTH = 8;
const CODE_ATTEMPTS = 8;

/** A random code (rejection sampling, so every symbol is equally likely). */
export function newChampionCode(): string {
  const n = CHAMPION_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = '';
  while (code.length < CHAMPION_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < CHAMPION_CODE_LENGTH)
        code += CHAMPION_CODE_ALPHABET[byte % n];
    }
  }
  return code;
}

/**
 * The Member's champion_code, assigned now if they have none. Null when the Member isn't in the
 * Channel. A code another Member of the Channel already has is retried with a new one; a
 * concurrent assignment for the same Member wins and is returned.
 */
export async function ensureChampionCode(
  db: D1Database,
  channelId: string,
  memberId: string,
  generate: () => string = newChampionCode,
): Promise<string | null> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const row = await first<{ champion_code: string | null }>(
      db,
      'SELECT champion_code FROM members WHERE id = ?1 AND channel_id = ?2',
      memberId,
      channelId,
    );
    if (!row) return null;
    if (row.champion_code) return row.champion_code;
    const code = generate();
    if (!CHAMPION_CODE.test(code)) throw new Error('generated champion code is malformed');
    try {
      await run(
        db,
        `UPDATE members SET champion_code = ?1 WHERE id = ?2 AND channel_id = ?3 AND champion_code IS NULL`,
        code,
        memberId,
        channelId,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('could not assign a unique champion code');
}

/** The share links for a code on a site origin (no trailing slash). */
export function championLinks(siteOrigin: string, code: string) {
  const origin = siteOrigin.replace(/\/$/, '');
  return { shareUrl: `${origin}/?ref=${code}`, shortUrl: `${origin}/r/${code}` };
}

/** The Member a code (or, from older embeds, a Member id) names in this Channel. */
export async function resolveReferrer(
  db: D1Database,
  channelId: string,
  ref: string | null | undefined,
): Promise<string | null> {
  if (!ref) return null;
  if (MEMBER_ID.test(ref)) return ref;
  const code = ref.toLowerCase();
  if (!CHAMPION_CODE.test(code)) return null;
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM members WHERE channel_id = ?1 AND champion_code = ?2',
    channelId,
    code,
  );
  return row?.id ?? null;
}

/** A ref value worth keeping (a code or a Member id), lowercased; null otherwise. */
export function cleanRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (MEMBER_ID.test(ref)) return ref;
  const code = ref.trim().toLowerCase();
  return CHAMPION_CODE.test(code) ? code : null;
}

// ---- Settings -------------------------------------------------------------------------------

export interface ChampionSettingsRow {
  channel_id: string;
  enabled: number;
  engagement_days: number;
  cluster_limit: number;
  cluster_window_hours: number;
  block_disposable: number;
  public_leaderboard: number;
  share_text: string | null;
  updated_at: number | null;
}

/** The Channel's settings, or the defaults (Champions off) when none are saved. */
export async function championSettings(
  db: D1Database,
  channelId: string,
): Promise<ChampionSettingsRow> {
  const row = await first<ChampionSettingsRow>(
    db,
    'SELECT * FROM champion_settings WHERE channel_id = ?1',
    channelId,
  );
  return (
    row ?? {
      channel_id: channelId,
      enabled: 0,
      engagement_days: CHAMPION_DEFAULTS.engagementDays,
      cluster_limit: CHAMPION_DEFAULTS.clusterLimit,
      cluster_window_hours: CHAMPION_DEFAULTS.clusterWindowHours,
      block_disposable: CHAMPION_DEFAULTS.blockDisposable ? 1 : 0,
      public_leaderboard: 0,
      share_text: null,
      updated_at: null,
    }
  );
}

// ---- Referrals ------------------------------------------------------------------------------

/** Ignores tags and dots Gmail-style, so `ada+x@` and `ada@` count as the same person. */
function personKey(email: string): string {
  const at = email.lastIndexOf('@');
  const local = (email.slice(0, at).split('+')[0] ?? '').toLowerCase();
  return `${local.replace(/\./g, '')}@${email.slice(at + 1).toLowerCase()}`;
}

export type ReferralResult = 'recorded' | 'rejected' | 'invalid' | 'self' | 'duplicate';

/**
 * Records that `referredId` joined through `referrerId`. The referrer must be a Member of the
 * same Channel who is still on the list; nobody refers themselves (same id or same address);
 * a Member is referred at most once (referrals.referred_id is unique). Only the network prefix
 * of `ip` is stored.
 */
export async function recordReferral(
  db: D1Database,
  input: {
    channelId: string;
    referrerId: string;
    referredId: string;
    referredEmail: string;
    ip?: string | null;
  },
  now = Date.now(),
): Promise<ReferralResult> {
  if (!MEMBER_ID.test(input.referrerId)) return 'invalid';
  if (input.referrerId === input.referredId) return 'self';
  const referrer = await first<{ email: string; status: MemberStatus }>(
    db,
    'SELECT email, status FROM members WHERE id = ?1 AND channel_id = ?2',
    input.referrerId,
    input.channelId,
  );
  if (!referrer || !['active', 'paused'].includes(referrer.status)) return 'invalid';
  if (personKey(referrer.email) === personKey(input.referredEmail)) return 'self';
  const settings = await championSettings(db, input.channelId);
  const disposable = settings.block_disposable === 1 && isDisposableAddress(input.referredEmail);
  const inserted = await first(
    db,
    `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at, status, review_reason, ip_prefix)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (referred_id) DO NOTHING RETURNING id`,
    newIdFor('referral', now),
    input.channelId,
    input.referrerId,
    input.referredId,
    now,
    disposable ? 'rejected' : 'pending',
    disposable ? 'disposable_domain' : null,
    ipPrefix(input.ip),
  );
  if (!inserted) return 'duplicate';
  await run(
    db,
    'UPDATE members SET referred_by = ?1 WHERE id = ?2 AND referred_by IS NULL',
    input.referrerId,
    input.referredId,
  );
  return disposable ? 'rejected' : 'recorded';
}

const setting = (column: string, fallback: number) =>
  `COALESCE((SELECT s.${column} FROM champion_settings s WHERE s.channel_id = referrals.channel_id), ${fallback})`;
const ENGAGEMENT_MS = `(${setting('engagement_days', CHAMPION_DEFAULTS.engagementDays)} * ${DAY_MS})`;
const CONFIRMED_AT = `(SELECT CASE WHEN m.status IN ('active', 'paused') THEN COALESCE(m.confirmed_at, m.consent_at) END
     FROM members m WHERE m.id = referrals.referred_id)`;

export interface CountResult {
  held: number;
  counted: number;
  rejected: number;
  awards: number;
}

/** One counting pass over every pending referral (see the file comment for the rules). */
export async function countReferrals(deps: ChampionDeps, now = Date.now()): Promise<CountResult> {
  const { db } = deps;
  const held = await db
    .prepare(
      `UPDATE referrals SET status = 'held', review_reason = 'ip_cluster'
        WHERE status = 'pending' AND ip_prefix IS NOT NULL
          AND (SELECT COUNT(*) FROM referrals o
                WHERE o.referrer_id = referrals.referrer_id AND o.ip_prefix = referrals.ip_prefix
                  AND o.created_at > referrals.created_at - ${setting('cluster_window_hours', CHAMPION_DEFAULTS.clusterWindowHours)} * ${HOUR_MS}
                  AND (o.created_at < referrals.created_at
                       OR (o.created_at = referrals.created_at AND o.id <= referrals.id)))
              > ${setting('cluster_limit', CHAMPION_DEFAULTS.clusterLimit)}`,
    )
    .run();
  const left = await db
    .prepare(
      `UPDATE referrals SET status = 'rejected', review_reason = 'unsubscribed'
        WHERE status = 'pending'
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = referrals.referred_id
                         AND m.status IN ('unsubscribed', 'bounced', 'complained'))`,
    )
    .run();
  const countable = `status = 'pending' AND ${CONFIRMED_AT} IS NOT NULL
        AND EXISTS (SELECT 1 FROM deliveries d
                     WHERE d.member_id = referrals.referred_id AND d.human_opened_at IS NOT NULL
                       AND d.human_opened_at >= referrals.created_at
                       AND d.human_opened_at <= ${CONFIRMED_AT} + ${ENGAGEMENT_MS})`;
  const [, countedResult] = await db.batch<{ channel_id: string; referrer_id: string }>([
    db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT channel_id, referrer_id, 'referral_succeeded', json_object('referralId', id), ?1
           FROM referrals WHERE ${countable} AND ${setting('enabled', 0)} = 1`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE referrals SET status = 'counted', counted_at = ?1 WHERE ${countable}
          RETURNING channel_id, referrer_id`,
      )
      .bind(now),
  ]);
  const counted = countedResult?.results ?? [];
  const stale = await db
    .prepare(
      `UPDATE referrals SET status = 'rejected', review_reason = 'not_engaged'
        WHERE status = 'pending'
          AND COALESCE(${CONFIRMED_AT}, referrals.created_at) + ${ENGAGEMENT_MS} < ?1`,
    )
    .bind(now)
    .run();
  const champions = new Map<string, string>();
  for (const row of counted) champions.set(row.referrer_id, row.channel_id);
  let awards = 0;
  // The referrals are already counted: one Champion's failure must not skip the others' checks.
  // A missed check is made again when that Champion's next referral counts.
  for (const [memberId, channelId] of champions) {
    try {
      awards += (await checkMilestones(deps, channelId, memberId, now)).length;
    } catch (error) {
      deps.log?.('champion milestone check failed', {
        channelId,
        memberId,
        error: (error as Error).message,
      });
    }
  }
  return {
    held: held.meta.changes ?? 0,
    counted: counted.length,
    rejected: (left.meta.changes ?? 0) + (stale.meta.changes ?? 0),
    awards,
  };
}

/** An operator decision on a held referral; false when it isn't held (or not in the Channel). */
export async function reviewReferral(
  deps: ChampionDeps,
  input: { channelId: string; referralId: string; operatorId: string; approve: boolean },
  now = Date.now(),
): Promise<{ referrerId: string; awards: string[] } | null> {
  const review = deps.db
    .prepare(
      input.approve
        ? `UPDATE referrals SET status = 'counted', counted_at = ?1, reviewed_by = ?2, reviewed_at = ?1
            WHERE id = ?3 AND channel_id = ?4 AND status = 'held' RETURNING referrer_id`
        : `UPDATE referrals SET status = 'rejected', review_reason = 'operator', reviewed_by = ?2,
                  reviewed_at = ?1
            WHERE id = ?3 AND channel_id = ?4 AND status = 'held' RETURNING referrer_id`,
    )
    .bind(now, input.operatorId, input.referralId, input.channelId);
  const results = await deps.db.batch<{ referrer_id: string }>(
    input.approve
      ? [
          deps.db
            .prepare(
              `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
               SELECT channel_id, referrer_id, 'referral_succeeded', json_object('referralId', id), ?1
                 FROM referrals WHERE id = ?2 AND channel_id = ?3 AND status = 'held'
                  AND ${setting('enabled', 0)} = 1`,
            )
            .bind(now, input.referralId, input.channelId),
          review,
        ]
      : [review],
  );
  const row = results.at(-1)?.results[0];
  if (!row) return null;
  const awards = input.approve
    ? await checkMilestones(deps, input.channelId, row.referrer_id, now)
    : [];
  return { referrerId: row.referrer_id, awards };
}

// ---- Progress -------------------------------------------------------------------------------

export interface ChampionProgress {
  counted: number;
  pending: number;
  held: number;
  rejected: number;
  awards: number;
  nextMilestone: { id: string; name: string; referralsRequired: number; remaining: number } | null;
}

export async function championProgress(
  db: D1Database,
  channelId: string,
  memberId: string,
): Promise<ChampionProgress> {
  const counts = await all<{ status: string; n: number }>(
    db,
    `SELECT status, COUNT(*) AS n FROM referrals WHERE channel_id = ?1 AND referrer_id = ?2
      GROUP BY status`,
    channelId,
    memberId,
  );
  const n = (status: string) => counts.find((r) => r.status === status)?.n ?? 0;
  const counted = n('counted');
  const [next, awards] = await Promise.all([
    first<{ id: string; name: string; referrals_required: number }>(
      db,
      `SELECT id, name, referrals_required FROM champion_milestones
        WHERE channel_id = ?1 AND status = 'active' AND referrals_required > ?2
        ORDER BY referrals_required LIMIT 1`,
      channelId,
      counted,
    ),
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM champion_awards WHERE channel_id = ?1 AND member_id = ?2
          AND status <> 'revoked'`,
      channelId,
      memberId,
    ),
  ]);
  return {
    counted,
    pending: n('pending'),
    held: n('held'),
    rejected: n('rejected'),
    awards: awards?.n ?? 0,
    nextMilestone: next
      ? {
          id: next.id,
          name: next.name,
          referralsRequired: next.referrals_required,
          remaining: next.referrals_required - counted,
        }
      : null,
  };
}

/**
 * The public "top Champions": display names only (first name and last initial, or initials),
 * never addresses. Members without a name show as "A referrer".
 */
export async function topChampions(
  db: D1Database,
  channelId: string,
  limit = 10,
): Promise<{ name: string; counted: number }[]> {
  const rows = await all<{ first_name: string | null; last_name: string | null; n: number }>(
    db,
    `SELECT m.first_name, m.last_name, COUNT(*) AS n
       FROM referrals r JOIN members m ON m.id = r.referrer_id
      WHERE r.channel_id = ?1 AND r.status = 'counted' AND m.status IN ('active', 'paused')
      GROUP BY r.referrer_id ORDER BY n DESC, MIN(r.counted_at) ASC LIMIT ?2`,
    channelId,
    limit,
  );
  return rows.map((row) => ({ name: displayName(row.first_name, row.last_name), counted: row.n }));
}

export function displayName(firstName: string | null, lastName: string | null): string {
  const f = firstName?.trim() ?? '';
  const l = lastName?.trim() ?? '';
  // A name field holding an address shows nothing of it.
  if (f.includes('@') || l.includes('@')) return 'A referrer';
  if (f) return l ? `${f} ${l[0]!.toUpperCase()}.` : f;
  if (l) return `${l[0]!.toUpperCase()}.`;
  return 'A referrer';
}

// ---- Milestones and awards ------------------------------------------------------------------

export interface ChampionMail {
  adapter: MailAdapter;
  platformMailDomain: string;
  memberLinks: MemberLinkMinter;
  /** Public origin of the capture worker (Member Center), without a trailing slash. */
  captureOrigin: string;
}

export interface ChampionDeps {
  db: D1Database;
  /** Without it no email is sent; coupon awards then fail (the email is the reward). */
  mail?: ChampionMail | null;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Inserts an award for every active milestone the Champion has reached and fulfils the ones this
 * call inserted. Returns their ids. Nothing happens while Champions is off for the Channel or the
 * Champion is no longer on the list.
 */
export async function checkMilestones(
  deps: ChampionDeps,
  channelId: string,
  memberId: string,
  now = Date.now(),
): Promise<string[]> {
  const { db } = deps;
  const settings = await championSettings(db, channelId);
  if (settings.enabled !== 1) return [];
  const member = await first<{ status: MemberStatus; counted: number }>(
    db,
    `SELECT m.status, (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = m.id AND r.status = 'counted') AS counted
       FROM members m WHERE m.id = ?1 AND m.channel_id = ?2`,
    memberId,
    channelId,
  );
  if (!member || !['active', 'paused'].includes(member.status)) return [];
  const reached = await all<{ id: string; reward_id: string | null }>(
    db,
    `SELECT id, reward_id FROM champion_milestones
      WHERE channel_id = ?1 AND status = 'active' AND referrals_required <= ?2
      ORDER BY referrals_required`,
    channelId,
    member.counted,
  );
  const inserted: string[] = [];
  for (const milestone of reached) {
    const awardId = newIdFor('championAward', now);
    const [, award] = await db.batch<{ id: string }>([
      db
        .prepare(
          `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
           SELECT ?1, ?2, 'referral_milestone', json_object('milestoneId', ?3, 'awardId', ?4), ?5
            WHERE NOT EXISTS (SELECT 1 FROM champion_awards WHERE member_id = ?2 AND milestone_id = ?3)`,
        )
        .bind(channelId, memberId, milestone.id, awardId, now),
      db
        .prepare(
          `INSERT INTO champion_awards (id, channel_id, member_id, milestone_id, reward_id, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)
           ON CONFLICT (member_id, milestone_id) DO NOTHING RETURNING id`,
        )
        .bind(awardId, channelId, memberId, milestone.id, milestone.reward_id, now),
    ]);
    const row = award?.results[0];
    if (row) inserted.push(row.id);
  }
  for (const awardId of inserted) await fulfilAward(deps, awardId, now);
  return inserted;
}

interface AwardRow {
  id: string;
  channel_id: string;
  member_id: string;
  status: string;
  milestone_name: string | null;
  reward_id: string | null;
  kind: ChampionRewardKind | null;
  reward_name: string | null;
  reward_description: string | null;
  level_id: string | null;
  comp_days: number | null;
  coupon_id: string | null;
}

export type FulfilOutcome = 'fulfilled' | 'pending' | 'failed' | 'skipped';

/**
 * Fulfils a 'pending' award (see the file comment). Manual and goods rewards stay pending for the
 * operator (markAwardFulfilled). A comp level that no longer exists, or a coupon that can't be
 * emailed, marks the award 'failed' with a detail.
 */
export async function fulfilAward(
  deps: ChampionDeps,
  awardId: string,
  now = Date.now(),
): Promise<FulfilOutcome> {
  const { db } = deps;
  const award = await first<AwardRow>(
    db,
    `SELECT a.id, a.channel_id, a.member_id, a.status, ms.name AS milestone_name, a.reward_id,
            w.kind, w.name AS reward_name, w.description AS reward_description, w.level_id,
            w.comp_days, w.coupon_id
       FROM champion_awards a
       LEFT JOIN champion_milestones ms ON ms.id = a.milestone_id
       LEFT JOIN champion_rewards w ON w.id = a.reward_id
      WHERE a.id = ?1`,
    awardId,
  );
  if (!award || award.status !== 'pending') return 'skipped';
  const finish = (status: 'fulfilled' | 'failed', detail: string | null, compGrantId?: string) =>
    run(
      db,
      `UPDATE champion_awards SET status = ?1, detail = ?2, comp_grant_id = COALESCE(?3, comp_grant_id),
              fulfilled_at = CASE WHEN ?1 = 'fulfilled' THEN ?4 END
        WHERE id = ?5 AND status = 'pending'`,
      status,
      detail,
      compGrantId ?? null,
      now,
      award.id,
    );
  const milestone = award.milestone_name ?? 'a milestone';

  if (!award.kind) {
    await finish('fulfilled', null);
    await sendAwardMail(deps, award, [`You reached ${milestone}. Thank you for sharing.`], now);
    return 'fulfilled';
  }

  switch (award.kind) {
    case 'comp_level': {
      const level = award.level_id
        ? await first<{ id: string; name: string; status: string }>(
            db,
            'SELECT id, name, status FROM membership_levels WHERE id = ?1 AND channel_id = ?2',
            award.level_id,
            award.channel_id,
          )
        : null;
      if (!level || level.status !== 'active' || !award.comp_days) {
        await finish('failed', 'The plan of this reward is no longer available.');
        return 'failed';
      }
      const expiresAt = now + award.comp_days * DAY_MS;
      const { grantId } = await grantComp(
        db,
        {
          channelId: award.channel_id,
          memberId: award.member_id,
          levelId: level.id,
          expiresAt,
          note: `Referrals: ${milestone}`.slice(0, 280),
          grantedBy: null,
        },
        now,
      );
      await finish('fulfilled', null, grantId);
      await sendAwardMail(
        deps,
        award,
        [
          `You reached ${milestone}. Thank you for sharing.`,
          `Your reward: ${level.name} for ${award.comp_days} day${award.comp_days === 1 ? '' : 's'}, until ${formatDate(expiresAt)}. It is active now.`,
        ],
        now,
      );
      return 'fulfilled';
    }
    case 'coupon': {
      const coupon = award.coupon_id
        ? await first<{ code: string; status: string; expires_at: number | null }>(
            db,
            'SELECT code, status, expires_at FROM coupons WHERE id = ?1 AND channel_id = ?2',
            award.coupon_id,
            award.channel_id,
          )
        : null;
      if (
        !coupon ||
        coupon.status !== 'active' ||
        (coupon.expires_at && coupon.expires_at <= now)
      ) {
        await finish('failed', 'The coupon of this reward is no longer available.');
        return 'failed';
      }
      const sent = await sendAwardMail(
        deps,
        award,
        [
          `You reached ${milestone}. Thank you for sharing.`,
          `Your reward: the coupon code ${coupon.code}. Use it when you choose a plan.`,
        ],
        now,
      );
      if (!sent) {
        await finish('failed', 'The coupon email could not be sent.');
        return 'failed';
      }
      await finish('fulfilled', null);
      return 'fulfilled';
    }
    case 'manual':
    case 'goods': {
      await sendAwardMail(
        deps,
        award,
        [
          `You reached ${milestone}. Thank you for sharing.`,
          `Your reward: ${award.reward_name ?? 'a thank-you'}. We will be in touch about it soon.`,
        ],
        now,
      );
      return 'pending';
    }
  }
}

/**
 * The operator completes an award: a pending manual or goods reward is marked fulfilled; a failed
 * or pending comp or coupon reward is tried again. Returns the outcome, or null when the award
 * isn't in the Channel.
 */
export async function completeAward(
  deps: ChampionDeps,
  input: { channelId: string; awardId: string; detail?: string | null },
  now = Date.now(),
): Promise<FulfilOutcome | null> {
  const { db } = deps;
  const award = await first<{ status: string; kind: ChampionRewardKind | null }>(
    db,
    `SELECT a.status, w.kind FROM champion_awards a LEFT JOIN champion_rewards w ON w.id = a.reward_id
      WHERE a.id = ?1 AND a.channel_id = ?2`,
    input.awardId,
    input.channelId,
  );
  if (!award) return null;
  if (award.status === 'fulfilled' || award.status === 'revoked') return 'skipped';
  if (award.kind === 'comp_level' || award.kind === 'coupon') {
    // Claim a failed award back to pending first, so two retries can't both grant.
    if (award.status === 'failed') {
      const claimed = await first(
        db,
        `UPDATE champion_awards SET status = 'pending', detail = NULL
          WHERE id = ?1 AND status = 'failed' RETURNING id`,
        input.awardId,
      );
      if (!claimed) return 'skipped';
    }
    return fulfilAward(deps, input.awardId, now);
  }
  const done = await first(
    db,
    `UPDATE champion_awards SET status = 'fulfilled', detail = ?1, fulfilled_at = ?2
      WHERE id = ?3 AND status IN ('pending', 'failed') RETURNING id`,
    input.detail ?? null,
    now,
    input.awardId,
  );
  return done ? 'fulfilled' : 'skipped';
}

const formatDate = (at: number) =>
  new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

const accentOf = (brandingJson: string) => {
  try {
    const accent = (JSON.parse(brandingJson) as { accentColor?: unknown }).accentColor;
    return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';
  } catch {
    return '#6c4cf1';
  }
};

/** The award email to the Champion. False when it couldn't be sent (no mail, suppressed, error). */
async function sendAwardMail(
  deps: ChampionDeps,
  award: AwardRow,
  paragraphs: string[],
  now: number,
): Promise<boolean> {
  const mail = deps.mail;
  if (!mail) return false;
  const { db } = deps;
  const row = await first<{
    email: string;
    first_name: string | null;
    status: MemberStatus;
    slug: string;
    name: string;
    branding_json: string;
    workspace_id: string;
  }>(
    db,
    `SELECT m.email, m.first_name, m.status, c.slug, c.name, c.branding_json, c.workspace_id
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    award.member_id,
  );
  if (!row || ['bounced', 'complained'].includes(row.status)) return false;
  if (await isSuppressedFor(db, row.workspace_id, award.channel_id, row.email)) return false;
  try {
    const config = { platformMailDomain: mail.platformMailDomain } as EngineConfig;
    let sender = await resolveSender(
      db,
      config,
      { id: award.channel_id, slug: row.slug, name: row.name },
      null,
    );
    if (sender.problems.length > 0) {
      sender = { ...sender, address: `${row.slug}@${mail.platformMailDomain}`, replyTo: null };
    }
    const token = await mail.memberLinks.memberToken(
      { memberId: award.member_id, channelId: award.channel_id },
      { now },
    );
    const body = memberMail({
      channelName: row.name,
      accent: accentOf(row.branding_json),
      heading: 'You earned a referral reward',
      paragraphs,
      button: { label: 'Open your subscriber settings', url: `${mail.captureOrigin}/m/${token}` },
      footnote: 'You are receiving this because people joined through your share link.',
    });
    const message = await composeMessage(db, {
      key: 'champion_award',
      channelId: award.channel_id,
      workspaceId: row.workspace_id,
      channelName: row.name,
      accent: accentOf(row.branding_json),
      variables: {
        channel_name: row.name,
        first_name: row.first_name ?? '',
        award: paragraphs.join(' '),
        center_url: `${mail.captureOrigin}/m/${token}`,
      },
      fallback: { subject: `You reached a referral milestone on ${row.name}`, ...body },
    });
    await mail.adapter.send({
      category: 'champion_award',
      from: { name: sender.name, address: sender.address },
      to: row.email,
      replyTo: sender.replyTo ?? sender.address,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: { channel: award.channel_id, kind: 'champion_award' },
    });
    return true;
  } catch (error) {
    deps.log?.('champion award email failed', {
      awardId: award.id,
      error: (error as Error).message,
    });
    return false;
  }
}
