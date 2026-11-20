/**
 * Gift Passes and gift articles (Phase 5, flags gift_passes and gift_articles).
 *
 * Gift Pass claim links are `<channel origin>/_swarm/gift/<token>`, where the token is a random
 * secret and only its SHA-256 is stored (gift_passes.claim_token_hash). Whoever marks a pass paid
 * (the webhook processor, on checkout.session.completed for intent 'gift') makes the token with
 * `newGiftClaimToken`, stores the hash, sets claim_by and emails the link to the recipient.
 *
 * Gift article links are `/p/<slug>?gift=<token>`, with the same random-secret-and-hash scheme in
 * gift_article_links.
 */
import { sha256Hex } from '@swarm/db';
import { base64UrlEncode } from '@swarm/tokens';
import { GIFT_CLAIM_DAYS, hashGiftClaimToken } from './payments-mail';

/** How long a paid Gift Pass can wait to be claimed. */
export const GIFT_CLAIM_WINDOW_MS = GIFT_CLAIM_DAYS * 24 * 60 * 60 * 1000;
/** Gift article links per Member per calendar month (UTC). */
export const GIFT_ARTICLE_MAX_PER_PERIOD = 5;
/** How long a gift article link keeps working. */
export const GIFT_ARTICLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How many times one gift article link opens its Dispatch. A link is meant for one person; this
 * stops one posted in public from serving everyone, with room for re-reads and link previews.
 */
export const GIFT_ARTICLE_MAX_READS = 50;

/**
 * Stops gift article links: a Member's own for one Dispatch, or (publisher) every link to a
 * Dispatch. Returns how many were stopped.
 */
export async function revokeGiftArticleLinks(
  db: D1Database,
  input: { channelId: string; dispatchId: string; memberId?: string | null },
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE gift_article_links SET revoked_at = ?1
        WHERE channel_id = ?2 AND dispatch_id = ?3 AND (?4 IS NULL OR member_id = ?4)
          AND revoked_at IS NULL AND expires_at > ?1`,
    )
    .bind(now, input.channelId, input.dispatchId, input.memberId ?? null)
    .run();
  return result.meta.changes ?? 0;
}
/** Gift Pass lengths offered on the plans page. */
export const GIFT_MONTHS = [1, 3, 6, 12] as const;

/** URL-safe tokens of any length we (or the webhook processor) might issue. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** A random URL-safe token and the hash to store. */
export async function newGiftToken(): Promise<{ token: string; hash: string }> {
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
  return { token, hash: await sha256Hex(token) };
}

/** The stored hash for a token from a URL, or null when it can't be one of ours. */
export async function giftTokenHash(token: string | null | undefined): Promise<string | null> {
  if (!token || !TOKEN.test(token)) return null;
  return hashGiftClaimToken(token);
}

/** UTC calendar month, as stored in gift_article_links.period ("2026-10"). */
export function monthPeriod(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** `now` plus whole calendar months (UTC), for a claimed Gift Pass's period end. */
export function addMonths(now: number, months: number): number {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
