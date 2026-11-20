// Metered Gates on the site. A reader who isn't entitled may read gate_settings.meter_limit
// distinct metered gated Dispatches per period in full (plus operator grants for a Member).
//
// A signed-in Member's reads are rows in gate_meter_reads keyed by their Member id, so the meter
// follows them across devices; the daily housekeeping deletes rows from earlier periods
// (METER_READS_KEEP_MS in @swarm/engine readers.ts), and deleting or erasing the Member deletes theirs.
//
// An anonymous reader's meter lives with the visitor and nowhere else: a first-party cookie that
// lists the Dispatches read this period, signed so it can't be edited (purpose 'meter',
// READER_KEYS), HttpOnly, SameSite=Lax, lasting one period at most, `__Host-swarm_meter` over https
// and `swarm_meter` locally (like the reader cookie). It holds no identifier and nothing is
// stored on the server, so a visitor can't grow the database and no reading history outlives the
// period. The cookie is set only when a free read is used.
//
// The anonymous meter is a speed bump, not a lock: clearing cookies resets it. Channels that need
// a lock use a hard Gate with no meter (meter_limit 0) or unmetered Gates.
import { meterPeriodKey, type MeterPeriod } from '@swarm/domain';
import { signToken, verifyToken } from '@swarm/tokens';
import { getCookie, setCookie } from 'hono/cookie';
import type { SiteContext } from '../context';

const METER_COOKIE_SECURE = '__Host-swarm_meter';
const METER_COOKIE_LOCAL = 'swarm_meter';
const METER_PURPOSE = 'meter';
/** The cookie never outlives the longest period it can describe. */
const PERIOD_SECONDS: Record<MeterPeriod, number> = {
  week: 7 * 24 * 60 * 60,
  month: 31 * 24 * 60 * 60,
};

const meterCookieName = (c: SiteContext) =>
  c.get('env').SITE_SCHEME === 'https' ? METER_COOKIE_SECURE : METER_COOKIE_LOCAL;

/** A Dispatch as the cookie lists it: the random end of its id, enough within one Channel. */
const shortId = (dispatchId: string) => dispatchId.slice(-12);

interface MeterInput {
  dispatchId: string;
  limit: number;
  period: MeterPeriod;
  now: number;
}

type MeterResult =
  /** Read in full on the meter (or read before this period: re-reading is free). */
  { outcome: 'read'; remaining: number } | { outcome: 'spent' };

/** Counts this read against the reader's meter when there is room, and says what happened. */
export async function useMeter(c: SiteContext, input: MeterInput): Promise<MeterResult> {
  return c.get('reader').memberId ? memberMeter(c, input) : anonymousMeter(c, input);
}

/** The Dispatches this browser read on the meter this period, from its signed cookie. */
async function readAnonymous(c: SiteContext, period: string): Promise<string[]> {
  const value = getCookie(c, meterCookieName(c));
  if (!value || value.length > 2048) return [];
  const read = await verifyToken<{ c?: unknown; p?: unknown; d?: unknown }>(
    c.get('env').READER_KEYS,
    METER_PURPOSE,
    value,
  );
  if (!read.ok) return [];
  const { c: channelId, p, d } = read.payload;
  if (channelId !== c.get('channel').id || p !== period || !Array.isArray(d)) return [];
  return d.filter((id): id is string => typeof id === 'string').slice(0, 100);
}

async function anonymousMeter(c: SiteContext, input: MeterInput): Promise<MeterResult> {
  const period = meterPeriodKey(input.period, input.now);
  const read = await readAnonymous(c, period);
  const id = shortId(input.dispatchId);
  if (read.includes(id))
    return { outcome: 'read', remaining: Math.max(0, input.limit - read.length) };
  if (read.length >= input.limit) return { outcome: 'spent' };
  const next = [...read, id];
  const env = c.get('env');
  const value = await signToken(
    env.READER_KEYS,
    METER_PURPOSE,
    { c: c.get('channel').id, p: period, d: next },
    { expiresInSeconds: PERIOD_SECONDS[input.period], now: input.now },
  );
  setCookie(c, meterCookieName(c), value, {
    path: '/',
    secure: env.SITE_SCHEME === 'https',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: PERIOD_SECONDS[input.period],
  });
  return { outcome: 'read', remaining: Math.max(0, input.limit - next.length) };
}

async function memberMeter(c: SiteContext, input: MeterInput): Promise<MeterResult> {
  const env = c.get('env');
  const channelId = c.get('channel').id;
  const memberId = c.get('reader').memberId as string;
  const period = meterPeriodKey(input.period, input.now);

  const [seen, grants] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(dispatch_id = ?4), 0) AS seen FROM gate_meter_reads
        WHERE channel_id = ?1 AND reader_key = ?2 AND period = ?3`,
    )
      .bind(channelId, memberId, period, input.dispatchId)
      .first<{ n: number; seen: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(extra), 0) AS extra FROM gate_meter_grants
        WHERE channel_id = ?1 AND member_id = ?2 AND period = ?3`,
    )
      .bind(channelId, memberId, period)
      .first<{ extra: number }>(),
  ]);
  const allowance = input.limit + (grants?.extra ?? 0);
  const used = seen?.n ?? 0;
  if (seen?.seen) return { outcome: 'read', remaining: Math.max(0, allowance - used) };

  // One statement: the count and the insert can't interleave with another read.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO gate_meter_reads (channel_id, reader_key, period, dispatch_id, read_at)
     SELECT ?1, ?2, ?3, ?4, ?5
      WHERE (SELECT COUNT(*) FROM gate_meter_reads
              WHERE channel_id = ?1 AND reader_key = ?2 AND period = ?3) < ?6`,
  )
    .bind(channelId, memberId, period, input.dispatchId, input.now, allowance)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    // Either the meter is spent, or a concurrent request of the same reader recorded this read.
    const again = await env.DB.prepare(
      `SELECT 1 AS hit FROM gate_meter_reads
        WHERE channel_id = ?1 AND reader_key = ?2 AND period = ?3 AND dispatch_id = ?4`,
    )
      .bind(channelId, memberId, period, input.dispatchId)
      .first<{ hit: number }>();
    if (!again) return { outcome: 'spent' };
  }
  return { outcome: 'read', remaining: Math.max(0, allowance - used - 1) };
}
