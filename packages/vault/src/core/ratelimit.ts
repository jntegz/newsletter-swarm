/**
 * The vault's own limits, kept in D1 (it binds no Durable Object): fixed windows in vault_rate,
 * taken in one upsert so concurrent calls can't both pass the last slot, and mint counts read from
 * vault_mints. A refused call is recorded in vault_audit by the caller of these.
 */
import { first, sha256Hex } from '@swarm/db';
import type { VaultContext } from './context';

interface Limit {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every limit, by scope. Numbers follow capture's own (guard.ts LIMITS) where one exists. */
const LIMITS = {
  /** /m "email me my links": per address (capture's linkEmail is 3 an hour). */
  'mint:link-request:address': { limit: 3, windowMs: HOUR },
  /** /m across a Channel, whoever asks. */
  'mint:link-request:channel': { limit: 200, windowMs: HOUR },
  /**
   * A fresh, emailed link for a Member who already holds one: what capture sends a Member in an
   * hour, 3 fresh links (linkEmail) and 6 change notices (changeNotice), each with one.
   */
  'mint:step-up:member': { limit: 9, windowMs: HOUR },
  /** The link shown after confirming, per confirm request. */
  'mint:confirmed:request': { limit: 5, windowMs: DAY },
  /** Links the api mints (sends, payment mails), per Channel. */
  'mint:api:channel': { limit: 20_000, windowMs: HOUR },
  /** The goods library by address (engine LIBRARY_MAILS_PER_WINDOW is 3 a day). */
  'mint:goods-library:address': { limit: 3, windowMs: DAY },
  'mint:goods-library:channel': { limit: 500, windowMs: HOUR },
  /** The thank-you page of one paid order. */
  'mint:goods-order:order': { limit: 20, windowMs: DAY },
  /** Erasure-marker lookups, per caller and workspace. */
  markers: { limit: 2_000, windowMs: MINUTE },
  /** Bulk erasure-marker lookups (imports, bulk deletes), per address, per caller and workspace. */
  'markers:bulk': { limit: 100_000, windowMs: MINUTE },
  /** Anonymous proxy calls (checkout, signup checks), per Channel. */
  'proxy:public': { limit: 120, windowMs: MINUTE },
  /** Member Center proxy calls (billing), per Member. */
  'proxy:member': { limit: 30, windowMs: 10 * MINUTE },
  /** Member Center field opens and saves, per Member. */
  'member-center': { limit: 120, windowMs: 10 * MINUTE },
} as const satisfies Record<string, Limit>;

export type LimitScope = keyof typeof LIMITS;

/**
 * Takes one unit of `scope` for `subject`. False when the window is used up: the call must be
 * refused with `rate_limited`.
 */
export async function take(
  ctx: VaultContext,
  scope: LimitScope,
  subject: string,
  units = 1,
): Promise<boolean> {
  const { limit, windowMs } = LIMITS[scope];
  const now = ctx.now();
  const start = now - (now % windowMs);
  const hash = await sha256Hex(`${scope}\n${subject}`);
  const row = await first<{ used: number }>(
    ctx.db,
    `INSERT INTO vault_rate (scope, subject_hash, window_start, used) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (scope, subject_hash) DO UPDATE SET
       used = CASE WHEN vault_rate.window_start = excluded.window_start
                   THEN vault_rate.used + excluded.used ELSE excluded.used END,
       window_start = excluded.window_start
     RETURNING used`,
    scope,
    hash,
    start,
    units,
  );
  return (row?.used ?? Number.POSITIVE_INFINITY) <= limit;
}
