/**
 * Funnel Explorer rollups (Phase 6) into funnel_daily: visit → form view → subscribe → confirm →
 * first open → paid, per UTC day and cut (source, utm_source/medium/campaign, form, Champion;
 * '' = none).
 *
 * CONTRACT
 * - Visits: anonymous. The site edge adds one per visitor per day (the visitor's first counted
 *   page view of the day on the Channel), with that view's source and UTM tags (funnelVisitStatement,
 *   in the same waitUntil as the page view). No form or Champion.
 * - Form views: anonymous. Copied from capture_form_daily (the embed counts loads) for today and
 *   yesterday on every pass, as a replace (not an increment), so re-running is harmless. Cut by
 *   form only: the embed load carries no attribution.
 * - Subscribes, confirms, first opens, paid: per-Member facts, attributed to the Member's first
 *   touch (members.source_json top-level keys), members.form_id and the referring Champion
 *   (members.referred_by, unless that referral was rejected), on the UTC day of the fact.
 *   - subscribe = member_joined, except imports and operator-created Members (not funnel
 *     traffic); writes the funnel_members row. Later stages count only Members with that row.
 *   - confirm = the first `confirmed` event; paid = the first `level_purchased` event.
 *   - first open = the Member's first human open of any Broadcast (deliveries.human_opened_at),
 *     scanned by time with a short lag so in-flight writes are not missed.
 * - Every per-Member increment is guarded by funnel_members (inserted, or a 0 → 1 flag flip, in
 *   the same batch), so re-reading events or open windows never double counts. The cursors in
 *   funnel_cursors only save work. member_events.processed_at belongs to the Flows engine and is
 *   never touched here.
 * - Source matches the site's: utm_source (lowercased, [a-z0-9._-], 60 characters), else the
 *   referrer host without "www." ("internal" for the page's own host), else "direct".
 */
import { analyticsDay } from './readers';
import { all, first } from './db';

const MAX_SOURCE = 120;
const UTM_SOURCE_MAX = 60;
/** Opens newer than this are left for the next pass, so a write in flight is not skipped. */
export const FUNNEL_OPEN_LAG_MS = 2 * 60 * 1000;
const OPEN_WINDOW_MS = 60 * 60 * 1000;
const EVENT_BATCH = 200;
const STATEMENT_CHUNK = 400;

/** One cell of funnel_daily's key, apart from Channel and day. */
export interface FunnelKey {
  source: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  formId: string;
  championId: string;
}

export const EMPTY_FUNNEL_KEY: FunnelKey = {
  source: '',
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  formId: '',
  championId: '',
};

/** A UTM value as counted: lowercased, [a-z0-9._-] only, clipped. */
export function normalizeUtm(value: string | null | undefined, max = UTM_SOURCE_MAX): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, max);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The traffic source of a touch (see the file comment). `ownHost` is the landing page's host. */
export function funnelSource(
  utmSource: string | null | undefined,
  referrer: string | null | undefined,
  ownHost: string | null | undefined,
): string {
  const utm = normalizeUtm(utmSource);
  if (utm) return utm;
  const host = hostOf(referrer);
  if (!host) return 'direct';
  if (ownHost && host === ownHost.toLowerCase()) return 'internal';
  return host.replace(/^www\./, '').slice(0, MAX_SOURCE) || 'direct';
}

/** The visit key of a page view: source and UTM tags from the landing URL. */
export function visitFunnelKey(url: URL, referrer: string | undefined): FunnelKey {
  const params = url.searchParams;
  return {
    ...EMPTY_FUNNEL_KEY,
    source: funnelSource(params.get('utm_source'), referrer, url.hostname),
    utmSource: normalizeUtm(params.get('utm_source')),
    utmMedium: normalizeUtm(params.get('utm_medium'), MAX_SOURCE),
    utmCampaign: normalizeUtm(params.get('utm_campaign'), MAX_SOURCE),
  };
}

interface MemberAttributionRow {
  id: string;
  channel_id: string;
  source_json: string;
  form_id: string | null;
  referred_by: string | null;
  referral_status: string | null;
}

/** A Member's first-touch key. */
export function memberFunnelKey(row: {
  source_json: string;
  form_id: string | null;
  referred_by: string | null;
  referral_status?: string | null;
}): FunnelKey {
  let source: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.source_json);
    if (parsed && typeof parsed === 'object') source = parsed as Record<string, unknown>;
  } catch {
    // An unreadable source is "direct".
  }
  const text = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : null);
  return {
    source: funnelSource(text('utm_source'), text('referrer'), hostOf(text('first_url'))),
    utmSource: normalizeUtm(text('utm_source')),
    utmMedium: normalizeUtm(text('utm_medium'), MAX_SOURCE),
    utmCampaign: normalizeUtm(text('utm_campaign'), MAX_SOURCE),
    formId: row.form_id ?? '',
    championId: row.referred_by && row.referral_status !== 'rejected' ? row.referred_by : '',
  };
}

type CountedStage = 'visits' | 'subscribes' | 'confirms' | 'first_opens' | 'paid';

const KEY_COLUMNS =
  'channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id';

/**
 * +1 on one funnel_daily cell. `guard` (SQL using ?9 = the Member id) decides whether the
 * increment happens; it runs inside the INSERT, before the flag write that follows it.
 */
function incrementStatement(
  db: D1Database,
  stage: CountedStage,
  channelId: string,
  day: string,
  key: FunnelKey,
  guard: { sql: string; memberId: string } | null,
): D1PreparedStatement {
  const binds = [
    channelId,
    day,
    key.source,
    key.utmSource,
    key.utmMedium,
    key.utmCampaign,
    key.formId,
    key.championId,
  ];
  return db
    .prepare(
      `INSERT INTO funnel_daily (${KEY_COLUMNS}, ${stage})
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1 WHERE ${guard ? guard.sql : 'true'}
       ON CONFLICT (${KEY_COLUMNS}) DO UPDATE SET ${stage} = ${stage} + 1`,
    )
    .bind(...binds, ...(guard ? [guard.memberId] : []));
}

/** The site edge's visit: one per visitor per day (see the file comment). */
export function funnelVisitStatement(
  db: D1Database,
  input: { channelId: string; url: URL; referrer: string | undefined; now: number },
): D1PreparedStatement {
  return incrementStatement(
    db,
    'visits',
    input.channelId,
    analyticsDay(input.now),
    visitFunnelKey(input.url, input.referrer),
    null,
  );
}

async function readCursor(db: D1Database, name: 'member_events' | 'opens'): Promise<number | null> {
  const row = await first<{ value: number }>(
    db,
    'SELECT value FROM funnel_cursors WHERE name = ?1',
    name,
  );
  return row ? row.value : null;
}

function cursorStatement(
  db: D1Database,
  name: 'member_events' | 'opens',
  value: number,
  now: number,
): D1PreparedStatement {
  // max(): a slower concurrent pass never moves a cursor backwards.
  return db
    .prepare(
      `INSERT INTO funnel_cursors (name, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET value = max(value, excluded.value), updated_at = excluded.updated_at`,
    )
    .bind(name, value, now);
}

async function attributionOf(
  db: D1Database,
  memberIds: readonly string[],
): Promise<Map<string, MemberAttributionRow>> {
  if (!memberIds.length) return new Map();
  const rows = await all<MemberAttributionRow>(
    db,
    `SELECT m.id, m.channel_id, m.source_json, m.form_id, m.referred_by,
            (SELECT r.status FROM referrals r WHERE r.referred_id = m.id) AS referral_status
       FROM members m WHERE m.id IN (SELECT value FROM json_each(?1))`,
    JSON.stringify([...new Set(memberIds)]),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function runChunked(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += STATEMENT_CHUNK) {
    await db.batch(statements.slice(i, i + STATEMENT_CHUNK));
  }
}

const NOT_TRACKED = 'NOT EXISTS (SELECT 1 FROM funnel_members WHERE member_id = ?9)';
const flagGuard = (flag: 'confirmed' | 'first_opened' | 'paid') =>
  `EXISTS (SELECT 1 FROM funnel_members WHERE member_id = ?9 AND ${flag} = 0)`;

function flagStatement(
  db: D1Database,
  flag: 'confirmed' | 'first_opened' | 'paid',
  memberId: string,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE funnel_members SET ${flag} = 1 WHERE member_id = ?1 AND ${flag} = 0`)
    .bind(memberId);
}

interface EventRow {
  seq: number;
  member_id: string;
  type: string;
  payload_json: string;
  created_at: number;
}

const NOT_FUNNEL_JOINS = new Set(['import', 'operator']);

/** Subscribes, confirms and paid from member_events after the cursor. Returns events read. */
export async function rollupFunnelEvents(
  db: D1Database,
  now: number = Date.now(),
  maxBatches = 10,
): Promise<number> {
  let read = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const cursor = (await readCursor(db, 'member_events')) ?? 0;
    const head = await first<{ seq: number | null }>(
      db,
      'SELECT max(seq) AS seq FROM member_events',
    );
    const last = head?.seq ?? 0;
    if (last <= cursor) return read;
    const events = await all<EventRow>(
      db,
      `SELECT seq, member_id, type, payload_json, created_at FROM member_events
        WHERE seq > ?1 AND seq <= ?2 AND type IN ('member_joined', 'confirmed', 'level_purchased')
        ORDER BY seq LIMIT ?3`,
      cursor,
      last,
      EVENT_BATCH,
    );
    const next = events.length === EVENT_BATCH ? events.at(-1)!.seq : last;
    const members = await attributionOf(
      db,
      events.map((e) => e.member_id),
    );
    const statements: D1PreparedStatement[] = [];
    for (const event of events) {
      const member = members.get(event.member_id);
      if (!member) continue;
      const day = analyticsDay(event.created_at);
      const key = memberFunnelKey(member);
      if (event.type === 'member_joined') {
        let payload: { source?: string } = {};
        try {
          payload = JSON.parse(event.payload_json) as { source?: string };
        } catch {
          // Treated as a sign-up.
        }
        if (payload.source && NOT_FUNNEL_JOINS.has(payload.source)) continue;
        statements.push(
          incrementStatement(db, 'subscribes', member.channel_id, day, key, {
            sql: NOT_TRACKED,
            memberId: member.id,
          }),
          db
            .prepare(
              `INSERT INTO funnel_members (member_id, channel_id, joined_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (member_id) DO NOTHING`,
            )
            .bind(member.id, member.channel_id, event.created_at),
        );
      } else {
        const [stage, flag] =
          event.type === 'confirmed'
            ? (['confirms', 'confirmed'] as const)
            : (['paid', 'paid'] as const);
        statements.push(
          incrementStatement(db, stage, member.channel_id, day, key, {
            sql: flagGuard(flag),
            memberId: member.id,
          }),
          flagStatement(db, flag, member.id),
        );
      }
    }
    await runChunked(db, [...statements, cursorStatement(db, 'member_events', next, now)]);
    read += events.length;
    if (events.length < EVENT_BATCH) return read;
  }
  return read;
}

/** First human opens of followed Members, by time window. Returns Members counted (attempted). */
export async function rollupFunnelOpens(db: D1Database, now: number = Date.now()): Promise<number> {
  const upto = now - FUNNEL_OPEN_LAG_MS;
  let cursor = await readCursor(db, 'opens');
  if (cursor === null) {
    // First run: start from the earliest followed Member (nothing earlier can be a first open).
    const earliest = await first<{ at: number | null }>(
      db,
      'SELECT min(joined_at) AS at FROM funnel_members',
    );
    cursor = Math.min(earliest?.at ?? upto, upto);
  }
  let counted = 0;
  for (let i = 0; i < 24 && cursor < upto; i += 1) {
    const end = Math.min(cursor + OPEN_WINDOW_MS, upto);
    // CROSS JOIN keeps the order: per Channel, the (channel_id, human_opened_at) index range.
    const opens = await all<{ member_id: string; at: number }>(
      db,
      `SELECT d.member_id, min(d.human_opened_at) AS at
         FROM channels c CROSS JOIN deliveries d CROSS JOIN funnel_members fm
        WHERE d.channel_id = c.id AND d.human_opened_at > ?1 AND d.human_opened_at <= ?2
          AND fm.member_id = d.member_id AND fm.first_opened = 0
        GROUP BY d.member_id`,
      cursor,
      end,
    );
    const members = await attributionOf(
      db,
      opens.map((o) => o.member_id),
    );
    const statements: D1PreparedStatement[] = [];
    for (const open of opens) {
      const member = members.get(open.member_id);
      if (!member) continue;
      statements.push(
        incrementStatement(
          db,
          'first_opens',
          member.channel_id,
          analyticsDay(open.at),
          memberFunnelKey(member),
          { sql: flagGuard('first_opened'), memberId: member.id },
        ),
        flagStatement(db, 'first_opened', member.id),
      );
    }
    await runChunked(db, [...statements, cursorStatement(db, 'opens', end, now)]);
    counted += opens.length;
    cursor = end;
  }
  return counted;
}

/** Form views for today and yesterday, replaced from capture_form_daily. */
export async function rollupFunnelFormViews(
  db: D1Database,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO funnel_daily (channel_id, day, form_id, form_views)
       SELECT f.channel_id, d.day, d.form_id, d.views
         FROM capture_form_daily d JOIN capture_forms f ON f.id = d.form_id
        WHERE d.day IN (?1, ?2) AND d.views > 0
       ON CONFLICT (${KEY_COLUMNS}) DO UPDATE SET form_views = excluded.form_views`,
    )
    .bind(analyticsDay(now), analyticsDay(now - 86_400_000))
    .run();
}

/** Every pass, for the jobs worker's minute cron. */
export async function runFunnelRollup(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ events: number; opens: number }> {
  const events = await rollupFunnelEvents(db, now);
  const opens = await rollupFunnelOpens(db, now);
  await rollupFunnelFormViews(db, now);
  return { events, opens };
}
