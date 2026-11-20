/**
 * Event Webhooks (Phase 7): fan-out, signing, delivery, retries, auto-disable, redrive and
 * housekeeping. The jobs worker runs the fan-out and the sweep on its minute cron and consumes
 * the `webhooks` Queue; the API creates endpoints, sends test events and redrives.
 *
 * CONTRACT (receivers: docs/webhooks.md; constants: p7-platform.ts and p7-webhooks.ts)
 * - Sources. member_events, read with the cursor `webhooks:member_events` in event_cursors
 *   (never processed_at, which belongs to the Flows engine), and the platform_events outbox with
 *   `webhooks:platform_events`. Each source is drained in seq order, in bounded pages; a page's
 *   deliveries and its cursor move commit together, and a re-read page creates nothing twice
 *   (deliveries are UNIQUE per endpoint and event id). A workspace past its share of a run is
 *   held: its own cursor (`<source cursor>:held:<workspace id>`) catches it up in seq order
 *   while the shared cursor goes on without it, and it rejoins once caught up.
 * - Event ids. `ev_` + the first 32 hex of sha256("<source>:<seq>"): stable however often a
 *   source event is read, and the same for every endpoint. Tag, field and Roster changes of one
 *   Member in one page are one member.updated (the id of the first). A Roster change is also its
 *   own roster.subscribed or roster.unsubscribed, with the id of sha256("<source>:<seq>:roster").
 * - Matching. Active endpoints of the event's workspace that list its type, whose Channel filter
 *   is empty or the event's Channel, and that existed when the event happened.
 * - Payloads. The envelope (WebhookEnvelope) is built once at fan-out and stored; every attempt
 *   and redrive sends exactly those bytes. Member data is the Member as it is at fan-out.
 * - Delivery. A queue message only names the delivery. The consumer claims it in D1 (a lease on
 *   next_attempt_at), so a duplicate message or the sweep never sends twice at once. 2xx is
 *   success; anything else, a redirect, a timeout or a network error is a failure, retried
 *   after webhookBackoffSeconds up to WEBHOOK_MAX_ATTEMPTS counted from attempts_base. A retry
 *   is queued with delaySeconds when that fits the queue's 12-hour limit; the minute sweep
 *   re-queues anything overdue (lost messages, a crashed consumer, longer delays).
 * - Auto-disable. failure_count and first_failure_at count failed attempts since the last
 *   success. A failure WEBHOOK_DISABLE_AFTER_HOURS after the first one disables the endpoint,
 *   cancels its open deliveries and emails the workspace's owners and admins. Test deliveries
 *   never count. Deliveries to a paused or disabled endpoint are canceled when their turn comes.
 * - Redrive puts a finished delivery back to pending with a fresh retry budget; a delivery
 *   that is already pending or retrying is left alone.
 */
import { sha256Hex } from '@swarm/db';
import {
  MEMBER_RESOURCE_EVENTS,
  PRODUCT_NAME,
  QUEUE_MAX_DELAY_SECONDS,
  WEBHOOK_DISABLE_AFTER_HOURS,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_REDRIVE_LIMIT,
  WEBHOOK_RESPONSE_EXCERPT_BYTES,
  WEBHOOK_RETENTION_DAYS,
  WEBHOOK_ROTATION_OVERLAP_HOURS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
  newId,
  webhookBackoffSeconds,
  webhookSignedPayload,
  type Member,
  type MemberEventType,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@swarm/domain';
import { escapeHtml, type MailAdapter } from '@swarm/mail';
import { base64UrlEncode, type Keyring } from '@swarm/tokens';
import {
  FEED_AUTHORITY_SQL,
  FEED_PROBLEM_TEXT,
  feedProblemSql,
  type FeedAuthorityProblem,
} from './feed-authority';
import { MEMBER_COLUMNS, toMember, type MemberRow } from './api-shapes';
import { all, first, run, toIso } from './db';
import { decrypt, encrypt } from './fields';
import { operatorNoticeText } from './flows-notify';
import { hexEncode } from './flows-util';
import { chargeOutboundWait, outboundUrlProblem, outboundWaitDeferral } from './outbound-url';

// ---- Types -----------------------------------------------------------------------------------

/** The only message on the `webhooks` Queue: deliver (one attempt of) this delivery. */
export interface WebhookMessage {
  type: 'webhook_delivery';
  deliveryId: string;
}

export interface WebhookQueue {
  send(message: WebhookMessage, options?: { delaySeconds?: number }): Promise<unknown>;
  sendBatch(messages: { body: WebhookMessage; delaySeconds?: number }[]): Promise<unknown>;
}

export interface WebhooksEnv {
  DB: D1Database;
  WEBHOOKS_QUEUE: WebhookQueue;
  /**
   * The Swarm-Signature of a delivery, from the vault (which alone opens secret_enc and
   * previous_secret_enc): null when the secret can't be opened; throws when the vault can't be
   * reached, and the delivery is retried without using an attempt.
   */
  signDelivery: (
    deliveryId: string,
    timestampSeconds: number,
    body: string,
  ) => Promise<string | null>;
  /** The worker's ENVIRONMENT: 'development' also accepts http:// endpoints. */
  ENVIRONMENT: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** The disabled-endpoint email. Without it the notice is skipped. */
  notices?: { mail: MailAdapter; from: string };
}

export interface WebhookEndpointRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  url: string;
  description: string | null;
  events_json: string;
  secret_enc: string;
  previous_secret_enc: string | null;
  previous_expires_at: number | null;
  status: 'active' | 'paused' | 'disabled';
  disabled_reason: string | null;
  failure_count: number;
  first_failure_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  proposed_via: 'key' | 'oauth' | null;
  proposed_by_id: string | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_id: string;
  event_type: WebhookEventType;
  payload_json: string;
  status: 'pending' | 'succeeded' | 'failed' | 'retrying' | 'canceled';
  attempts: number;
  attempts_base: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  error: string | null;
  member_id: string | null;
  test: number;
  created_at: number;
  updated_at: number;
}

// ---- Secrets, URLs and signatures ------------------------------------------------------------

/** A new signing secret: whsec_ + 32 random bytes, base64url. */
export function newWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${WEBHOOK_SECRET_PREFIX}${base64UrlEncode(bytes)}`;
}

export const sealWebhookSecret = (keys: Keyring, secret: string) => encrypt(keys, secret);

/** Why an endpoint URL is refused, or null. Plain http only in development. */
export function webhookEndpointUrlProblem(url: string, environment: string): string | null {
  return outboundUrlProblem(url, { allowHttp: environment === 'development' });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return hexEncode(new Uint8Array(mac));
}

/**
 * The Swarm-Signature value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, one
 * v1= per secret (the current one first; during a rotation the previous one follows). The key is
 * the secret string as shown, whsec_ prefix included.
 */
export async function signWebhook(
  secrets: readonly string[],
  timestampSeconds: number,
  body: string,
): Promise<string> {
  const signed = webhookSignedPayload(timestampSeconds, body);
  const macs = await Promise.all(secrets.map((secret) => hmacHex(secret, signed)));
  return [`t=${timestampSeconds}`, ...macs.map((mac) => `v1=${mac}`)].join(',');
}

/** The secrets that sign now: the current one, plus the previous one inside the overlap. */
export async function signingSecrets(
  keys: Keyring,
  endpoint: Pick<WebhookEndpointRow, 'secret_enc' | 'previous_secret_enc' | 'previous_expires_at'>,
  now: number,
): Promise<string[] | null> {
  const current = await decrypt(keys, endpoint.secret_enc);
  if (!current) return null;
  const secrets = [current];
  if (endpoint.previous_secret_enc && (endpoint.previous_expires_at ?? 0) > now) {
    const previous = await decrypt(keys, endpoint.previous_secret_enc);
    if (previous) secrets.push(previous);
  }
  return secrets;
}

export const WEBHOOK_ROTATION_OVERLAP_MS = WEBHOOK_ROTATION_OVERLAP_HOURS * 60 * 60 * 1000;

/**
 * Stable per source event (see the contract above). `variant` tells apart the second webhook
 * event one source event produces (a Roster change: member.updated and roster.*).
 */
export async function webhookEventId(
  source: 'member_events' | 'platform_events',
  seq: number,
  variant?: string,
): Promise<string> {
  const key = variant ? `${source}:${seq}:${variant}` : `${source}:${seq}`;
  return `ev_${(await sha256Hex(key)).slice(0, 32)}`;
}

// ---- Fan-out ---------------------------------------------------------------------------------

export const WEBHOOK_CURSORS = {
  member_events: 'webhooks:member_events',
  platform_events: 'webhooks:platform_events',
} as const;

/** Source events read per page, and pages per source per cron run in each pass. */
export const WEBHOOK_FANOUT_PAGE = 500;
export const WEBHOOK_FANOUT_PAGES = 10;
/**
 * Delivery rows written per source per cron run. Events alone do not bound the work: one page
 * of a bulk tag times hundreds of endpoints is more inserts than one invocation should run, and
 * a run that dies before its cursor moves repeats forever. The rows go in D1 batches of
 * WRITE_CHUNK, and a batch counts as one query towards the per-invocation limit; the queries
 * themselves are bounded by WEBHOOK_FANOUT_QUERIES.
 */
export const WEBHOOK_FANOUT_MAX_DELIVERIES = 5_000;
/**
 * Delivery rows one workspace may take from the shared pass per source per run. A workspace that
 * reaches it is held back: its later events are left to its own catch-up cursor and the shared
 * cursor goes on with everyone else's, so one workspace's backlog never holds the rest behind it.
 * One source seq never exceeds it (at most two webhook events times the top plan's 200
 * endpoints), so no cursor ever has to stop inside a seq.
 */
export const WEBHOOK_FANOUT_WORKSPACE_DELIVERIES = 1_000;
/** Statements per D1 batch when writing a page's deliveries. */
const WRITE_CHUNK = 50;
/** Members read per query when a page's events need them. */
const MEMBER_CHUNK = 100;
/**
 * D1 queries one fan-out call may run, both sources together (a batch counts as one). The minute
 * cron runs every step in one invocation, and past 1,000 queries every later D1 call in it
 * throws, so the fan-out keeps well under a third of that whatever the backlog, and stops paging
 * when the next page might not fit.
 */
export const WEBHOOK_FANOUT_QUERIES = 300;
/**
 * Most queries a page runs before its writes: a shared page reads the held list, its cursor,
 * the newest seq, the events and their endpoints, a catch-up page the last three; then Members.
 */
const PAGE_MEMBER_READS = Math.ceil(WEBHOOK_FANOUT_PAGE / MEMBER_CHUNK);
const SHARED_PAGE_READS = 5 + PAGE_MEMBER_READS;
const CATCH_UP_PAGE_READS = 3 + PAGE_MEMBER_READS;
/** Statements a page writes after its deliveries: the hold or release, and the cursor. */
const PAGE_TAIL = 2;
/** Batch queries that write `deliveries` rows and a page's tail. */
const writesFor = (deliveries: number) => Math.ceil((deliveries + PAGE_TAIL) / WRITE_CHUNK);
/** Deliveries a page may write in `queries` batch queries. */
const deliveriesFor = (queries: number) => Math.max(0, queries * WRITE_CHUNK - PAGE_TAIL);

/** Member event → webhook event. Anything else on the bus is not announced. */
export const MEMBER_EVENT_WEBHOOKS: Partial<Record<MemberEventType, WebhookEventType>> = {
  member_joined: 'member.created',
  confirmed: 'member.confirmed',
  tag_added: 'member.updated',
  tag_removed: 'member.updated',
  field_changed: 'member.updated',
  roster_joined: 'member.updated',
  roster_left: 'member.updated',
  level_purchased: 'level.purchased',
  level_canceled: 'level.canceled',
  ask_answered: 'ask.response',
  form_submitted: 'capture_form.submitted',
};

/**
 * Member events that also produce a second, more specific webhook event. Roster changes stay
 * member.updated (receivers written before Rosters rely on it) and are roster.* as well.
 */
export const MEMBER_EVENT_EXTRA_WEBHOOKS: Partial<Record<MemberEventType, WebhookEventType>> = {
  roster_joined: 'roster.subscribed',
  roster_left: 'roster.unsubscribed',
};

const MEMBER_DATA_EVENTS = new Set<WebhookEventType>(MEMBER_RESOURCE_EVENTS);
/** Events from member_events whose data wraps the Member with the event's details. */
const MEMBER_WRAPPED_EVENTS = new Set<WebhookEventType>([
  'level.purchased',
  'level.canceled',
  'ask.response',
  'capture_form.submitted',
  'roster.subscribed',
  'roster.unsubscribed',
]);

interface SourceEvent {
  source: 'member_events' | 'platform_events';
  seq: number;
  /** Set on the second webhook event of one source event (webhookEventId). */
  variant?: string;
  workspaceId: string;
  channelId: string | null;
  memberId: string | null;
  type: WebhookEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export async function readEventCursor(db: D1Database, name: string): Promise<number> {
  const row = await first<{ value: number }>(
    db,
    'SELECT value FROM event_cursors WHERE name = ?1',
    name,
  );
  return row?.value ?? 0;
}

function cursorStatement(db: D1Database, name: string, value: number, now: number) {
  // max(): a slower concurrent pass never moves the cursor backwards.
  return db
    .prepare(
      `INSERT INTO event_cursors (name, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET value = max(value, excluded.value), updated_at = excluded.updated_at`,
    )
    .bind(name, value, now);
}

/**
 * Which workspaces a page reads: everyone but the held ones (the shared pass), or one held
 * workspace (its catch-up).
 */
type PageScope = { except: readonly string[] } | { only: string };

const scopeSql = (column: string, scope: PageScope) =>
  'only' in scope ? `${column} = ?4` : `${column} NOT IN (SELECT value FROM json_each(?4))`;
const scopeArg = (scope: PageScope) =>
  'only' in scope ? scope.only : JSON.stringify(scope.except);

interface SourcePage {
  /** Where the cursor may move once the page is written: every event in scope up to it is in it. */
  last: number;
  count: number;
  events: SourceEvent[];
}

/** A short page has read everything in scope up to `through`. */
const pageLast = (
  rows: readonly { seq: number }[],
  limit: number,
  after: number,
  through: number,
) => (rows.length < limit ? Math.max(after, through) : rows[rows.length - 1]!.seq);

/**
 * A deleted Channel's events are not fanned out (and are not sent later on a restore): its
 * subscribers' data stops flowing to receivers once it is deleted. A member.deleted notice still
 * goes, so receivers can drop what they hold.
 */
const LIVE_CHANNEL_EVENT = `(channel_id IS NULL OR type = 'member.deleted' OR NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.id = platform_events.channel_id AND c.deleted_at IS NOT NULL))`;

async function memberEventsPage(
  db: D1Database,
  after: number,
  through: number,
  scope: PageScope,
  limit: number,
): Promise<SourcePage> {
  const rows = await all<{
    seq: number;
    channel_id: string;
    workspace_id: string;
    member_id: string;
    type: MemberEventType;
    payload_json: string;
    created_at: number;
  }>(
    db,
    `SELECT e.seq, e.channel_id, c.workspace_id, e.member_id, e.type, e.payload_json, e.created_at
       FROM member_events e JOIN channels c ON c.id = e.channel_id
      WHERE e.seq > ?1 AND e.seq <= ?2 AND ${scopeSql('c.workspace_id', scope)}
        AND c.deleted_at IS NULL
      ORDER BY e.seq LIMIT ?3`,
    after,
    through,
    limit,
    scopeArg(scope),
  );
  const events: SourceEvent[] = [];
  const updated = new Set<string>();
  for (const row of rows) {
    const type = MEMBER_EVENT_WEBHOOKS[row.type];
    if (!type) continue;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const base = {
      source: 'member_events' as const,
      seq: row.seq,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      memberId: row.member_id,
      payload,
      createdAt: row.created_at,
    };
    // One member.updated per Member per page: receivers read the current state anyway.
    if (type !== 'member.updated' || !updated.has(row.member_id)) {
      if (type === 'member.updated') updated.add(row.member_id);
      events.push({ ...base, type });
    }
    // The specific event is never merged: each Roster change is its own roster.* event.
    const extra = MEMBER_EVENT_EXTRA_WEBHOOKS[row.type];
    if (extra) events.push({ ...base, type: extra, variant: 'roster' });
  }
  return { last: pageLast(rows, limit, after, through), count: rows.length, events };
}

async function platformEventsPage(
  db: D1Database,
  after: number,
  through: number,
  scope: PageScope,
  limit: number,
): Promise<SourcePage> {
  const rows = await all<{
    seq: number;
    workspace_id: string;
    channel_id: string | null;
    member_id: string | null;
    type: WebhookEventType;
    payload_json: string;
    created_at: number;
  }>(
    db,
    `SELECT seq, workspace_id, channel_id, member_id, type, payload_json, created_at
       FROM platform_events WHERE seq > ?1 AND seq <= ?2 AND ${scopeSql('workspace_id', scope)}
        AND ${LIVE_CHANNEL_EVENT}
      ORDER BY seq LIMIT ?3`,
    after,
    through,
    limit,
    scopeArg(scope),
  );
  return {
    last: pageLast(rows, limit, after, through),
    count: rows.length,
    events: rows.map((row) => ({
      source: 'platform_events' as const,
      seq: row.seq,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      memberId: row.member_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    })),
  };
}

const endpointEvents = new WeakMap<WebhookEndpointRow, Set<string>>();
function listens(endpoint: WebhookEndpointRow, event: SourceEvent): boolean {
  let events = endpointEvents.get(endpoint);
  if (!events) {
    events = new Set(JSON.parse(endpoint.events_json) as string[]);
    endpointEvents.set(endpoint, events);
  }
  return (
    events.has(event.type) &&
    (endpoint.channel_id === null || endpoint.channel_id === event.channelId) &&
    endpoint.created_at <= event.createdAt
  );
}

const needsMember = (event: SourceEvent) =>
  MEMBER_DATA_EVENTS.has(event.type) ||
  (event.source === 'member_events' && MEMBER_WRAPPED_EVENTS.has(event.type));

/** The envelope's `data`, or null when the event can't be described any more (Member gone). */
function eventData(event: SourceEvent, member: Member | undefined): Record<string, unknown> | null {
  const p = event.payload;
  if (MEMBER_DATA_EVENTS.has(event.type)) return member ?? null;
  if (event.source === 'member_events' && MEMBER_WRAPPED_EVENTS.has(event.type)) {
    if (!member) return null;
    switch (event.type) {
      case 'level.purchased':
        return { member, levelId: p.levelId ?? null, source: p.source };
      case 'level.canceled':
        return { member, levelId: p.levelId ?? null };
      case 'ask.response':
        return {
          member,
          askId: p.askId,
          questionId: p.questionId,
          optionId: p.optionId ?? null,
        };
      case 'roster.subscribed':
      case 'roster.unsubscribed':
        return { member, rosterId: p.rosterId, source: p.source };
      default:
        return { member, formId: p.formId, created: p.created === true };
    }
  }
  return p;
}

async function loadMembers(db: D1Database, ids: readonly string[]): Promise<Map<string, Member>> {
  const members = new Map<string, Member>();
  for (let i = 0; i < ids.length; i += MEMBER_CHUNK) {
    const rows = await all<MemberRow>(
      db,
      `SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id IN (SELECT value FROM json_each(?1))`,
      JSON.stringify(ids.slice(i, i + MEMBER_CHUNK)),
    );
    for (const row of rows) members.set(row.id, toMember(row));
  }
  return members;
}

export function envelopeFor(
  eventId: string,
  event: Pick<SourceEvent, 'type' | 'createdAt' | 'workspaceId' | 'channelId'>,
  data: Record<string, unknown>,
): WebhookEnvelope {
  return {
    id: eventId,
    type: event.type,
    createdAt: toIso(event.createdAt),
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    data,
  };
}

function insertDelivery(
  db: D1Database,
  input: {
    endpointId: string;
    workspaceId: string;
    eventId: string;
    type: WebhookEventType;
    body: string;
    memberId: string | null;
    test: boolean;
  },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json,
         status, attempts, next_attempt_at, member_id, test, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?8, ?9, ?7, ?7)
       ON CONFLICT (endpoint_id, event_id) DO NOTHING RETURNING id`,
    )
    .bind(
      newId('webhookDelivery', now),
      input.endpointId,
      input.workspaceId,
      input.eventId,
      input.type,
      input.body,
      now,
      input.memberId,
      input.test ? 1 : 0,
    );
}

async function enqueue(queue: WebhookQueue, ids: readonly string[], delaySeconds = 0) {
  for (let i = 0; i < ids.length; i += 100) {
    await queue.sendBatch(
      ids.slice(i, i + 100).map((deliveryId) => ({
        body: { type: 'webhook_delivery', deliveryId } as const,
        ...(delaySeconds ? { delaySeconds } : {}),
      })),
    );
  }
}

type WebhookSource = 'member_events' | 'platform_events';

const readPage = (source: WebhookSource) =>
  source === 'member_events' ? memberEventsPage : platformEventsPage;

/** Names of a source's held workspace cursors: `<source cursor>:held:<workspace id>`. */
const heldPrefix = (source: WebhookSource) => `${WEBHOOK_CURSORS[source]}:held:`;

/**
 * The held workspaces of a source and how far each has been fanned out (every one of its
 * events up to the value has its deliveries), the one caught up with longest ago first.
 */
async function readHeld(db: D1Database, source: WebhookSource): Promise<Map<string, number>> {
  const prefix = heldPrefix(source);
  const rows = await all<{ name: string; value: number }>(
    db,
    `SELECT name, value FROM event_cursors WHERE name >= ?1 AND name < ?2
      ORDER BY updated_at, name`,
    prefix,
    `${prefix.slice(0, -1)};`,
  );
  return new Map(rows.map((row) => [row.name.slice(prefix.length), row.value]));
}

/** The matching events of one source seq (a Roster change is two events of one seq). */
interface SeqGroup {
  seq: number;
  workspaceId: string;
  matches: { event: SourceEvent; targets: WebhookEndpointRow[] }[];
  /** Deliveries the seq writes. */
  size: number;
}

async function seqGroups(db: D1Database, events: readonly SourceEvent[]): Promise<SeqGroup[]> {
  const workspaceIds = [...new Set(events.map((e) => e.workspaceId))];
  const endpoints = workspaceIds.length
    ? await all<WebhookEndpointRow>(
        db,
        `SELECT f.* FROM webhook_endpoints f
          WHERE f.status = 'active' AND f.workspace_id IN (SELECT value FROM json_each(?1))
            AND ${FEED_AUTHORITY_SQL('webhook_endpoint')}`,
        JSON.stringify(workspaceIds),
      )
    : [];
  const groups: SeqGroup[] = [];
  for (const event of events) {
    const targets = endpoints.filter(
      (ep) => ep.workspace_id === event.workspaceId && listens(ep, event),
    );
    if (!targets.length) continue;
    let group = groups.at(-1);
    if (group?.seq !== event.seq) {
      group = { seq: event.seq, workspaceId: event.workspaceId, matches: [], size: 0 };
      groups.push(group);
    }
    group.matches.push({ event, targets });
    group.size += targets.length;
  }
  return groups;
}

/**
 * Writes the deliveries of `groups`, then `last` (the cursor moves) in the final chunk: a crash
 * before it re-reads the page, and the UNIQUE (endpoint, event) index turns the repeated
 * inserts into no-ops.
 */
async function writeDeliveries(
  env: WebhooksEnv,
  groups: readonly SeqGroup[],
  last: readonly D1PreparedStatement[],
  now: number,
): Promise<{ written: number; created: number }> {
  const db = env.DB;
  const matched = groups.flatMap((group) => group.matches);
  const memberIds = [
    ...new Set(
      matched
        .filter(({ event }) => event.memberId && needsMember(event))
        .map(({ event }) => event.memberId as string),
    ),
  ];
  const members = memberIds.length ? await loadMembers(db, memberIds) : new Map<string, Member>();

  const statements: D1PreparedStatement[] = [];
  for (const { event, targets } of matched) {
    const data = eventData(event, event.memberId ? members.get(event.memberId) : undefined);
    if (!data) continue;
    const eventId = await webhookEventId(event.source, event.seq, event.variant);
    const body = JSON.stringify(envelopeFor(eventId, event, data));
    for (const endpoint of targets) {
      statements.push(
        insertDelivery(
          db,
          {
            endpointId: endpoint.id,
            workspaceId: event.workspaceId,
            eventId,
            type: event.type,
            body,
            memberId: event.type === 'member.deleted' ? null : event.memberId,
            test: false,
          },
          now,
        ),
      );
    }
  }
  const written = statements.length;
  statements.push(...last);
  const created: string[] = [];
  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    const results = await db.batch<{ id: string }>(statements.slice(i, i + WRITE_CHUNK));
    for (const result of results) for (const row of result.results ?? []) created.push(row.id);
  }
  // A failed enqueue is not lost: the rows are pending and due, and the sweep picks them up.
  await enqueue(env.WEBHOOKS_QUEUE, created).catch(() => undefined);
  return { written, created: created.length };
}

/**
 * Keeps every held workspace held. A concurrent run's catch-up may have released one after
 * this pass read it and skipped its events: putting it back (at the position read, events up to
 * which are written) means those events are caught up later, never lost.
 */
function holdStatement(
  db: D1Database,
  source: WebhookSource,
  held: ReadonlyMap<string, number>,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO event_cursors (name, value, updated_at)
       SELECT ?1 || json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?3
         FROM json_each(?2) j WHERE 1
       ON CONFLICT (name) DO NOTHING`,
    )
    .bind(heldPrefix(source), JSON.stringify([...held]), now);
}

interface FanOutState {
  held: Map<string, number>;
  /** Deliveries each workspace took from the shared pass in this run. */
  used: Map<string, number>;
  perWorkspace: number;
}

/** Queries run so far in a fan-out call, and how many the current stage may reach. */
interface QueryMeter {
  used: number;
  limit: number;
}

/** Queries a page may still write in, after its reads, or less than 1 when it must not start. */
const writable = (meter: QueryMeter, reads: number) => meter.limit - meter.used - reads;

/**
 * `db`, counting into `meter` every query it runs: each read or write, and each batch as one.
 * Counting the queries themselves (retries included) keeps the bound true as the code changes.
 */
function meteredDb(db: D1Database, meter: QueryMeter): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const counted =
      (method: 'first' | 'all' | 'run' | 'raw') =>
      (...args: unknown[]) => {
        meter.used++;
        return (statement[method] as (...a: unknown[]) => unknown).apply(statement, args);
      };
    const outer = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: counted('first'),
      all: counted('all'),
      run: counted('run'),
      raw: counted('raw'),
    } as unknown as D1PreparedStatement;
    inner.set(outer, statement);
    return outer;
  };
  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => {
      meter.used++;
      return db.batch(statements.map((statement) => inner.get(statement) ?? statement));
    },
    exec: (query: string) => {
      meter.used++;
      return db.exec(query);
    },
  } as unknown as D1Database;
}

/**
 * One page of the shared pass: every workspace but the held ones, from the source's cursor. A
 * workspace that would go past its share in this run is held from its next seq on. At most
 * `budget` deliveries; with `force` it writes at least the first seq, so a run always moves the
 * cursor, unless that passes `cap`, the deliveries the queries left can write. `cut` is true when
 * events were left for the next run.
 */
async function sharedPage(
  env: WebhooksEnv,
  source: WebhookSource,
  state: FanOutState,
  now: number,
  budget: number,
  force: boolean,
  cap: number,
): Promise<{ read: number; written: number; created: number; cut: boolean }> {
  const db = env.DB;
  const name = WEBHOOK_CURSORS[source];
  const after = await readEventCursor(db, name);
  // The newest seq first: a short page has then read every event up to it.
  const newest = await first<{ seq: number | null }>(db, `SELECT max(seq) AS seq FROM ${source}`);
  const through = newest?.seq ?? 0;
  if (through <= after) return { read: 0, written: 0, created: 0, cut: false };
  const page = await readPage(source)(
    db,
    after,
    through,
    { except: [...state.held.keys()] },
    WEBHOOK_FANOUT_PAGE,
  );
  const groups = await seqGroups(db, page.events);

  // Whole seqs only until the budget is spent. The cursor then stops just before the first seq
  // left out, which the next run starts from.
  let cursor = page.last;
  let planned = 0;
  const taken: SeqGroup[] = [];
  for (const group of groups) {
    const workspaceId = group.workspaceId;
    if (state.held.has(workspaceId)) continue;
    const used = state.used.get(workspaceId) ?? 0;
    if (used && used + group.size > state.perWorkspace) {
      state.held.set(workspaceId, group.seq - 1);
      continue;
    }
    // `force` may pass the delivery budget, never `cap`, the queries left.
    const over = planned + group.size > budget && !(force && !taken.length);
    if (over || planned + group.size > cap) {
      cursor = group.seq - 1;
      break;
    }
    taken.push(group);
    planned += group.size;
    state.used.set(workspaceId, used + group.size);
  }
  const last = [cursorStatement(db, name, cursor, now)];
  if (state.held.size) last.unshift(holdStatement(db, source, state.held, now));
  const { written, created } = await writeDeliveries(env, taken, last, now);
  return { read: page.count, written, created, cut: cursor !== page.last };
}

/**
 * Catch-up of the held workspaces, the one caught up with longest ago first, each from its own
 * cursor up to the shared one and in seq order, within `budget` deliveries, WEBHOOK_FANOUT_PAGES
 * pages and the queries `meter` has left.
 * A workspace that reaches the shared cursor is released: the shared pass takes its events
 * again. The release checks the shared cursor in the same batch, so a cursor that moved on
 * meanwhile (past events it skipped) keeps the workspace held.
 */
async function catchUpHeld(
  env: WebhooksEnv,
  source: WebhookSource,
  held: ReadonlyMap<string, number>,
  now: number,
  budget: number,
  meter: QueryMeter,
): Promise<number> {
  const db = env.DB;
  const shared = WEBHOOK_CURSORS[source];
  let created = 0;
  let pages = 0;
  for (const [workspaceId, from] of held) {
    const name = `${heldPrefix(source)}${workspaceId}`;
    let after = from;
    for (;;) {
      const queries = writable(meter, CATCH_UP_PAGE_READS);
      if (pages >= WEBHOOK_FANOUT_PAGES || queries < 1) return created;
      pages++;
      const cap = Math.min(budget, deliveriesFor(queries));
      const through = await readEventCursor(db, shared);
      const page = await readPage(source)(
        db,
        after,
        through,
        { only: workspaceId },
        WEBHOOK_FANOUT_PAGE,
      );
      const groups = await seqGroups(db, page.events);
      let cursor = page.last;
      let planned = 0;
      const taken: SeqGroup[] = [];
      for (const group of groups) {
        if (planned + group.size > cap) {
          cursor = group.seq - 1;
          break;
        }
        taken.push(group);
        planned += group.size;
      }
      const result = await writeDeliveries(
        env,
        taken,
        [
          cursorStatement(db, name, cursor, now),
          db
            .prepare(
              `DELETE FROM event_cursors WHERE name = ?1
                 AND value >= (SELECT value FROM event_cursors WHERE name = ?2)`,
            )
            .bind(name, shared),
        ],
        now,
      );
      created += result.created;
      budget -= result.written;
      // Out of budget: the rest waits for the next run.
      if (cursor !== page.last) return created;
      if (page.count < WEBHOOK_FANOUT_PAGE) break;
      after = cursor;
    }
  }
  return created;
}

export interface WebhookFanOutLimits {
  /** Deliveries per source per run (WEBHOOK_FANOUT_MAX_DELIVERIES). */
  perRun?: number;
  /** Deliveries per workspace per source from the shared pass (WEBHOOK_FANOUT_WORKSPACE_DELIVERIES). */
  perWorkspace?: number;
  /** D1 queries per run, both sources together (WEBHOOK_FANOUT_QUERIES). */
  queries?: number;
}

/**
 * Drains both sources in bounded pages, at most `perRun` deliveries per source and `queries` D1
 * queries in all, so a backlog never uses up the cron invocation's queries. The shared
 * pass reads every workspace that is not held, in seq order; held workspaces catch up from
 * their own cursors in the same run, in turn, with what is left (at least one workspace's share
 * while any is held). Each endpoint belongs to one workspace, and a workspace's events are
 * fanned out in seq order by one pass or the other, so no endpoint's deliveries are lost,
 * doubled or reordered. Returns how many deliveries were created.
 */
export async function fanOutWebhooks(
  env: WebhooksEnv,
  now: number = Date.now(),
  limits: WebhookFanOutLimits = {},
): Promise<number> {
  const perRun = limits.perRun ?? WEBHOOK_FANOUT_MAX_DELIVERIES;
  const perWorkspace = limits.perWorkspace ?? WEBHOOK_FANOUT_WORKSPACE_DELIVERIES;
  const queries = limits.queries ?? WEBHOOK_FANOUT_QUERIES;
  const meter: QueryMeter = { used: 0, limit: 0 };
  const metered: WebhooksEnv = { ...env, DB: meteredDb(env.DB, meter) };
  let created = 0;
  for (const source of ['member_events', 'platform_events'] as const) {
    // The first source takes at most half the queries, so its backlog never starves the other.
    const limit = source === 'member_events' ? Math.floor(queries / 2) : queries;
    if (limit - meter.used < 1) continue;
    meter.limit = limit;
    const state: FanOutState = {
      held: await readHeld(metered.DB, source),
      used: new Map(),
      perWorkspace,
    };
    // While any workspace is held, its catch-up keeps at least one workspace's share, in
    // deliveries and in the queries that write them.
    const reserve = state.held.size ? perWorkspace : 0;
    meter.limit -= state.held.size ? CATCH_UP_PAGE_READS + writesFor(perWorkspace) : 0;
    let budget = perRun - reserve;
    for (let page = 0; page < WEBHOOK_FANOUT_PAGES; page++) {
      // Out of queries: the cursor stays where the last page left it, for the next run.
      const left = writable(meter, SHARED_PAGE_READS);
      if (left < 1) break;
      const cap = deliveriesFor(left);
      // An overlapping run may have held or released workspaces since the last page. A stale
      // list would let this page write a newly held workspace's later events ahead of its
      // catch-up, out of seq order for its endpoints.
      if (page) state.held = await readHeld(metered.DB, source);
      const result = await sharedPage(metered, source, state, now, budget, page === 0, cap);
      created += result.created;
      budget -= result.written;
      // A short page means the source is drained for now; a cut one waits for the next run.
      if (result.cut || result.read < WEBHOOK_FANOUT_PAGE) break;
    }
    meter.limit = limit;
    budget += reserve;
    if (state.held.size && budget > 0) {
      created += await catchUpHeld(metered, source, state.held, now, budget, meter);
    }
  }
  return created;
}

// ---- Delivery --------------------------------------------------------------------------------

/** A claimed attempt holds the row this long (longer than the request timeout). */
export const WEBHOOK_LEASE_MS = 60_000;
/** The sweep re-queues work this overdue (a queued message is normally on time). */
export const WEBHOOK_SWEEP_GRACE_MS = 60_000;
/** Queue delays are approximate: a message this early may still claim. */
const EARLY_MS = 5_000;
/**
 * Deliveries in flight to one endpoint at a time (security review S04-P3-TR-tenant-outbound-lanes),
 * so a burst to one slow endpoint can't fill the webhooks queue's consumers. Owner decision.
 */
export const WEBHOOK_ENDPOINT_MAX_CONCURRENT = 4;
/** A delivery that found its endpoint busy asks again after this long, without using an attempt. */
export const WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS = 5;

/** A place among the endpoint's WEBHOOK_ENDPOINT_MAX_CONCURRENT, or null when all are taken. */
async function takeEndpointLease(
  db: D1Database,
  endpointId: string,
  now: number,
): Promise<string | null> {
  const id = crypto.randomUUID();
  // D1 runs one write at a time, so the count and the insert can't interleave with another's.
  const [, inserted] = await db.batch([
    db
      .prepare('DELETE FROM webhook_endpoint_leases WHERE endpoint_id = ?1 AND expires_at <= ?2')
      .bind(endpointId, now),
    db
      .prepare(
        `INSERT INTO webhook_endpoint_leases (id, endpoint_id, expires_at) SELECT ?1, ?2, ?3
          WHERE (SELECT count(*) FROM webhook_endpoint_leases
                  WHERE endpoint_id = ?2 AND expires_at > ?4) < ?5`,
      )
      .bind(id, endpointId, now + WEBHOOK_LEASE_MS, now, WEBHOOK_ENDPOINT_MAX_CONCURRENT),
  ]);
  return inserted?.meta.changes ? id : null;
}

/** Puts a delivery back for later without using an attempt, and queues it for then. */
async function deferDelivery(env: WebhooksEnv, deliveryId: string, until: number, now: number) {
  await run(
    env.DB,
    `UPDATE webhook_deliveries SET next_attempt_at = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ('pending', 'retrying')`,
    until,
    now,
    deliveryId,
  );
  await env.WEBHOOKS_QUEUE.send(
    { type: 'webhook_delivery', deliveryId },
    { delaySeconds: Math.max(1, Math.ceil((until - now) / 1000)) },
  ).catch(() => undefined);
}

export type DeliveryOutcome =
  'skipped' | 'succeeded' | 'retrying' | 'failed' | 'canceled' | 'disabled' | 'deferred';

interface PostResult {
  status: number | null;
  excerpt: string | null;
  error: string | null;
  latencyMs: number;
}

async function readExcerpt(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < WEBHOOK_RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A body that breaks off mid-way still leaves what arrived.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, WEBHOOK_RESPONSE_EXCERPT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.byteLength) break;
  }
  return bytes.byteLength ? new TextDecoder().decode(bytes) : null;
}

async function post(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<PostResult> {
  const started = Date.now();
  try {
    const response = await fetcher(url, {
      method: 'POST',
      // A redirect is not followed: it answers 3xx, which is a failure.
      redirect: 'manual',
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const excerpt = await readExcerpt(response);
    const ok = response.status >= 200 && response.status <= 299;
    return {
      status: response.status,
      excerpt,
      error: ok ? null : `The endpoint answered ${response.status}.`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const name = (error as Error).name;
    return {
      status: null,
      excerpt: null,
      error:
        name === 'TimeoutError' || name === 'AbortError'
          ? `The endpoint did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds.`
          : `The endpoint could not be reached: ${(error as Error).message}`.slice(0, 500),
      latencyMs: Date.now() - started,
    };
  }
}

/** The headers of a request (Content-Type, User-Agent, the event id and type, the signature). */
export function webhookHeaders(
  delivery: Pick<WebhookDeliveryRow, 'event_id' | 'event_type'>,
  signature: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': WEBHOOK_USER_AGENT,
    [WEBHOOK_EVENT_ID_HEADER]: delivery.event_id,
    [WEBHOOK_EVENT_TYPE_HEADER]: delivery.event_type,
    [WEBHOOK_SIGNATURE_HEADER]: signature,
  };
}

async function finish(
  db: D1Database,
  delivery: WebhookDeliveryRow,
  attempt: number,
  result: PostResult | { status: null; excerpt: null; error: string; latencyMs: null },
  status: WebhookDeliveryRow['status'],
  nextAttemptAt: number | null,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO webhook_attempts (delivery_id, attempt, started_at, response_status, latency_ms, error, response_excerpt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (delivery_id, attempt) DO NOTHING`,
      )
      .bind(
        delivery.id,
        attempt,
        now,
        result.status,
        result.latencyMs,
        result.error,
        result.excerpt,
      ),
    db
      .prepare(
        `UPDATE webhook_deliveries SET status = ?1, attempts = ?2, next_attempt_at = ?3, last_attempt_at = ?4,
                response_status = ?5, response_excerpt = ?6, latency_ms = ?7, error = ?8, updated_at = ?4
          WHERE id = ?9`,
      )
      .bind(
        status,
        attempt,
        nextAttemptAt,
        now,
        result.status,
        result.excerpt,
        result.latencyMs,
        result.error,
        delivery.id,
      ),
  ]);
}

async function cancel(db: D1Database, deliveryId: string, reason: string, now: number) {
  await run(
    db,
    `UPDATE webhook_deliveries SET status = 'canceled', next_attempt_at = NULL, error = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ('pending', 'retrying')`,
    reason,
    now,
    deliveryId,
  );
}

/** Makes one attempt at a delivery, if it is due and nobody else holds it. */
export async function deliverWebhook(
  env: WebhooksEnv,
  deliveryId: string,
  now: number = Date.now(),
): Promise<DeliveryOutcome> {
  const db = env.DB;
  const delivery = await first<WebhookDeliveryRow>(
    db,
    `UPDATE webhook_deliveries SET next_attempt_at = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?4)
      RETURNING *`,
    now + WEBHOOK_LEASE_MS,
    now,
    deliveryId,
    now + EARLY_MS,
  );
  if (!delivery) return 'skipped';
  const endpoint = await first<WebhookEndpointRow>(
    db,
    'SELECT * FROM webhook_endpoints WHERE id = ?1',
    delivery.endpoint_id,
  );
  if (!endpoint) return 'skipped'; // deleted: its deliveries went with it
  const test = delivery.test === 1;
  if (!test && endpoint.status !== 'active') {
    await cancel(db, delivery.id, `The endpoint is ${endpoint.status}.`, now);
    return 'canceled';
  }
  if (!test) {
    // The authority behind the endpoint can end after an event was fanned out to it.
    const authority = await first<{ problem: FeedAuthorityProblem | null }>(
      db,
      `SELECT ${feedProblemSql('webhook_endpoint')} AS problem FROM webhook_endpoints f WHERE f.id = ?1`,
      endpoint.id,
    );
    if (authority?.problem) {
      await cancel(
        db,
        delivery.id,
        `The endpoint is suspended: ${FEED_PROBLEM_TEXT[authority.problem]}`,
        now,
      );
      return 'canceled';
    }
  }
  if (!test && delivery.event_type !== 'member.deleted') {
    // Fanned out before its Channel was deleted: a deleted Channel's data no longer goes out.
    const gone = await first(
      db,
      `SELECT 1 FROM channels WHERE id = json_extract(?1, '$.channelId') AND deleted_at IS NOT NULL`,
      delivery.payload_json,
    );
    if (gone) {
      await cancel(db, delivery.id, 'The publication was deleted.', now);
      return 'canceled';
    }
  }
  const attempt = delivery.attempts + 1;

  const problem = webhookEndpointUrlProblem(endpoint.url, env.ENVIRONMENT);
  const signature = problem
    ? null
    : await env.signDelivery(delivery.id, Math.floor(now / 1000), delivery.payload_json);
  if (problem || !signature) {
    // Retrying cannot help: the URL is refused or the secret can't be opened.
    const error = problem
      ? `The endpoint URL is refused: ${problem}.`
      : 'The signing secret could not be opened. Rotate the secret.';
    await finish(
      db,
      delivery,
      attempt,
      { status: null, excerpt: null, error, latencyMs: null },
      'failed',
      null,
      now,
    );
    if (!test) return (await recordFailure(env, endpoint, now)) ? 'disabled' : 'failed';
    return 'failed';
  }

  // The workspace has spent its share of waiting on its endpoints this minute: try again in the
  // next one, without using an attempt, so its slow endpoints don't hold other tenants' deliveries.
  const deferUntil = await outboundWaitDeferral(db, endpoint.workspace_id, now);
  if (deferUntil !== null) {
    await deferDelivery(env, delivery.id, deferUntil, now);
    return 'deferred';
  }
  // The endpoint already has its most deliveries in flight: a few seconds later, still without
  // using an attempt. Test sends and redrives take a place like any other delivery.
  const lease = await takeEndpointLease(db, endpoint.id, now);
  if (!lease) {
    await deferDelivery(env, delivery.id, now + WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS * 1000, now);
    return 'deferred';
  }

  let result: PostResult;
  try {
    result = await post(
      env.fetch ? env.fetch : (input, init) => fetch(input, init),
      endpoint.url,
      webhookHeaders(delivery, signature),
      delivery.payload_json,
    );
  } finally {
    await run(db, 'DELETE FROM webhook_endpoint_leases WHERE id = ?1', lease).catch(
      () => undefined,
    );
  }
  // Waiting is charged to the workspace whatever the answer, a slow success included.
  await chargeOutboundWait(db, endpoint.workspace_id, result.latencyMs ?? 0, now);

  if (!result.error) {
    await finish(db, delivery, attempt, result, 'succeeded', null, now);
    if (!test && (endpoint.failure_count > 0 || endpoint.first_failure_at !== null)) {
      await run(
        db,
        'UPDATE webhook_endpoints SET failure_count = 0, first_failure_at = NULL WHERE id = ?1',
        endpoint.id,
      );
    }
    return 'succeeded';
  }

  const used = attempt - delivery.attempts_base;
  if (used < WEBHOOK_MAX_ATTEMPTS) {
    const delay = webhookBackoffSeconds(used);
    await finish(db, delivery, attempt, result, 'retrying', now + delay * 1000, now);
    // Longer than the queue allows: the minute sweep sends it when it is due.
    if (delay <= QUEUE_MAX_DELAY_SECONDS) {
      await env.WEBHOOKS_QUEUE.send(
        { type: 'webhook_delivery', deliveryId: delivery.id },
        { delaySeconds: delay },
      ).catch(() => undefined);
    }
  } else {
    await finish(db, delivery, attempt, result, 'failed', null, now);
  }
  if (!test && (await recordFailure(env, endpoint, now))) return 'disabled';
  return used < WEBHOOK_MAX_ATTEMPTS ? 'retrying' : 'failed';
}

export const WEBHOOK_DISABLE_AFTER_MS = WEBHOOK_DISABLE_AFTER_HOURS * 60 * 60 * 1000;

/** Counts a failed attempt; disables the endpoint after the window. True when it did. */
async function recordFailure(
  env: WebhooksEnv,
  endpoint: WebhookEndpointRow,
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const counted = await first<{ first_failure_at: number; status: string }>(
    db,
    `UPDATE webhook_endpoints SET failure_count = failure_count + 1,
            first_failure_at = coalesce(first_failure_at, ?1)
      WHERE id = ?2 RETURNING first_failure_at, status`,
    now,
    endpoint.id,
  );
  if (!counted || counted.status !== 'active') return false;
  if (now - counted.first_failure_at < WEBHOOK_DISABLE_AFTER_MS) return false;
  const reason = `Every delivery failed for ${WEBHOOK_DISABLE_AFTER_HOURS} hours.`;
  const disabled = await first<{ id: string }>(
    db,
    `UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = ?1, updated_at = ?2
      WHERE id = ?3 AND status = 'active' RETURNING id`,
    reason,
    now,
    endpoint.id,
  );
  if (!disabled) return false;
  await run(
    db,
    `UPDATE webhook_deliveries SET status = 'canceled', next_attempt_at = NULL,
            error = 'The endpoint was turned off.', updated_at = ?1
      WHERE endpoint_id = ?2 AND status IN ('pending', 'retrying') AND test = 0`,
    now,
    endpoint.id,
  );
  await notifyDisabled(env, endpoint).catch(() => undefined);
  return true;
}

/** Owners and admins of the workspace, once each. */
export async function workspaceAdminEmails(db: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM seats s JOIN operators o ON o.id = s.operator_id
      WHERE s.workspace_id = ?1 AND s.role IN ('owner', 'admin') ORDER BY o.email LIMIT 50`,
    workspaceId,
  );
  return rows.map((r) => r.email);
}

async function notifyDisabled(env: WebhooksEnv, endpoint: WebhookEndpointRow): Promise<number> {
  if (!env.notices) return 0;
  const to = await workspaceAdminEmails(env.DB, endpoint.workspace_id);
  const subject = 'A webhook endpoint was turned off';
  const lines = [
    `Every delivery to ${endpoint.url} failed for ${WEBHOOK_DISABLE_AFTER_HOURS} hours, so it was turned off and nothing more is sent to it.`,
    'Fix the endpoint, then resume it in Settings → Developers → Webhooks. Deliveries that failed can be sent again from its delivery log.',
  ];
  const text = operatorNoticeText(lines);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:32px 16px;background:#fbfbfd;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12">
${lines.map((line) => `<p style="font-size:15px;line-height:1.55;margin:0 0 16px">${escapeHtml(line)}</p>`).join('\n')}
<p style="font-size:12px;color:#6b6b76">${PRODUCT_NAME}</p></body></html>`;
  for (const address of to) {
    await env.notices.mail.send({
      category: 'webhook_disabled',
      from: { name: PRODUCT_NAME, address: env.notices.from },
      to: address,
      subject,
      text,
      html,
      tags: { endpoint: endpoint.id },
    });
  }
  return to.length;
}

/** Re-queues pending and retrying deliveries that are overdue. Returns how many. */
export async function sweepWebhooks(env: WebhooksEnv, now: number = Date.now()): Promise<number> {
  const due = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM webhook_deliveries
      WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?1
      ORDER BY next_attempt_at LIMIT 500`,
    now - WEBHOOK_SWEEP_GRACE_MS,
  );
  await enqueue(
    env.WEBHOOKS_QUEUE,
    due.map((r) => r.id),
  );
  return due.length;
}

// ---- Redrive and test events (API) -----------------------------------------------------------

type QueueEnv = Pick<WebhooksEnv, 'DB' | 'WEBHOOKS_QUEUE'>;

/**
 * Sends a finished delivery again: same event id and body, a fresh retry budget. A delivery
 * that is pending or retrying is left as it is. True when this call redrove it.
 */
export async function redriveWebhookDelivery(
  env: QueueEnv,
  deliveryId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await first<{ id: string }>(
    env.DB,
    `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?1, attempts_base = attempts,
            error = NULL, updated_at = ?1
      WHERE id = ?2 AND status IN ('succeeded', 'failed', 'canceled') RETURNING id`,
    now,
    deliveryId,
  );
  if (!row) return false;
  await enqueue(env.WEBHOOKS_QUEUE, [row.id]);
  return true;
}

/** Redrives an endpoint's failed and canceled deliveries created since `since` (bounded). */
export async function redriveFailedWebhooks(
  env: QueueEnv,
  endpointId: string,
  since: number,
  now: number = Date.now(),
): Promise<number> {
  const rows = await all<{ id: string }>(
    env.DB,
    `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?1, attempts_base = attempts,
            error = NULL, updated_at = ?1
      WHERE id IN (SELECT id FROM webhook_deliveries
                    WHERE endpoint_id = ?2 AND status IN ('failed', 'canceled') AND created_at >= ?3
                    ORDER BY created_at LIMIT ?4)
      RETURNING id`,
    now,
    endpointId,
    since,
    WEBHOOK_REDRIVE_LIMIT,
  );
  await enqueue(
    env.WEBHOOKS_QUEUE,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/** A test event of `type` with sample data, to one endpoint whatever its status. */
export async function sendTestWebhook(
  env: QueueEnv,
  endpoint: Pick<WebhookEndpointRow, 'id' | 'workspace_id' | 'channel_id'>,
  type: WebhookEventType,
  now: number = Date.now(),
): Promise<string> {
  const eventId = newId('webhookEvent', now);
  const channelId = endpoint.channel_id ?? newId('channel', now);
  const body = JSON.stringify(
    envelopeFor(
      eventId,
      { type, createdAt: now, workspaceId: endpoint.workspace_id, channelId },
      sampleData(type, channelId, now),
    ),
  );
  const row = await first<{ id: string }>(
    env.DB,
    `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json,
       status, attempts, next_attempt_at, test, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, 1, ?7, ?7) RETURNING id`,
    newId('webhookDelivery', now),
    endpoint.id,
    endpoint.workspace_id,
    eventId,
    type,
    body,
    now,
  );
  await enqueue(env.WEBHOOKS_QUEUE, [row!.id]);
  return row!.id;
}

/** Sample `data` for a test event: valid shapes, made-up values. */
export function sampleData(
  type: WebhookEventType,
  channelId: string,
  now: number,
): Record<string, unknown> {
  const at = toIso(now);
  const member: Member = {
    id: newId('member', now),
    channelId,
    email: 'member@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'active',
    digest: 'every',
    tags: ['test'],
    createdAt: at,
    confirmedAt: at,
    pausedUntil: null,
    unsubscribedAt: null,
    emailsOffAt: null,
  };
  const dispatch = {
    id: newId('dispatch', now),
    channelId,
    subject: 'A test post',
    preheader: '',
    status: type === 'dispatch.scheduled' ? 'scheduled' : 'sent',
    senderIdentityId: null,
    publishAt: type === 'dispatch.scheduled' ? toIso(now + 86_400_000) : null,
    sentAt: type === 'dispatch.scheduled' ? null : at,
    createdAt: at,
    updatedAt: at,
    latestBroadcastId: null,
    webVisibility: 'public',
    webPublishedAt: null,
    kind: 'broadcast',
    flowId: null,
    createdVia: null,
    archivedAt: null,
    plannedDate: null,
    importedAt: null,
    bestTime: false,
  };
  switch (type) {
    case 'member.created':
    case 'member.confirmed':
    case 'member.updated':
      return member;
    case 'member.unsubscribed':
      return { ...member, status: 'unsubscribed', unsubscribedAt: at };
    case 'member.deleted':
      return { id: member.id, channelId };
    case 'level.purchased':
      return { member, levelId: newId('membershipLevel', now), source: 'checkout' };
    case 'level.canceled':
      return { member, levelId: newId('membershipLevel', now) };
    case 'dispatch.scheduled':
    case 'dispatch.sent':
      return dispatch;
    case 'broadcast.completed':
      return {
        broadcast: {
          id: newId('broadcast', now),
          dispatchId: dispatch.id,
          channelId,
          status: 'sent',
          subject: dispatch.subject,
          from: { name: 'Field Notes', address: 'field-notes@example.com' },
          recipientCount: 1,
          sentCount: 1,
          failedCount: 0,
          failureReason: null,
          createdAt: at,
          completedAt: at,
          canceledAt: null,
          bestTime: null,
        },
        stats: {
          sent: 1,
          delivered: 1,
          bounced: 0,
          complained: 0,
          failed: 0,
          unsubscribed: 0,
          uniqueOpens: 0,
          humanOpens: 0,
          machineOpens: 0,
          uniqueClicks: 0,
          humanClicks: 0,
          bounceRate: 0,
          complaintRate: 0,
          openRate: 0,
          clickToOpenRate: 0,
          tracking: { opens: true, clicks: true, untracked: 0 },
          cost: { amountMicros: 100, currency: 'USD' },
          links: [],
        },
      };
    case 'ask.response':
      return {
        member,
        askId: newId('ask', now),
        questionId: newId('askQuestion', now),
        optionId: newId('askOption', now),
      };
    case 'flow.completed':
      return {
        id: newId('flowRun', now),
        flowId: newId('flow', now),
        version: 1,
        memberId: member.id,
        memberEmail: member.email,
        status: 'completed',
        exitReason: null,
        currentNodeId: null,
        nextAt: null,
        hold: null,
        test: true,
        startedBy: null,
        startedAt: at,
        updatedAt: at,
        endedAt: at,
      };
    case 'capture_form.submitted':
      return { member, formId: newId('captureForm', now), created: true };
    case 'roster.subscribed':
      return { member, rosterId: newId('roster', now), source: 'form' };
    case 'roster.unsubscribed':
      return {
        member,
        rosterId: newId('roster', now),
        source: 'unsubscribe',
      };
    case 'good.purchased':
    case 'good.refunded':
      return {
        id: newId('goodOrder', now),
        channelId,
        goodId: newId('good', now),
        memberId: member.id,
        email: member.email,
        amount: 900,
        currency: 'usd',
        status: type === 'good.purchased' ? 'paid' : 'refunded',
      };
  }
}

// ---- Housekeeping ----------------------------------------------------------------------------

export const WEBHOOK_RETENTION_MS = WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Deletes finished deliveries (with their attempts) and outbox rows older than the retention.
 * Outbox rows the webhooks cursor hasn't passed yet are kept, and so is every erasure
 * (`member.deleted`) an export destination of its Channel hasn't written yet: a destination that
 * is paused or failing for longer than the retention still learns of it when it runs again.
 */
export async function pruneWebhooks(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ deliveries: number; platformEvents: number }> {
  const cutoff = now - WEBHOOK_RETENTION_MS;
  const deliveries = await run(
    db,
    `DELETE FROM webhook_deliveries WHERE id IN (
       SELECT id FROM webhook_deliveries
        WHERE status IN ('succeeded', 'failed', 'canceled') AND updated_at < ?1 LIMIT 10000)`,
    cutoff,
  );
  // Only rows every workspace has been fanned out past, held ones included.
  const cursor = Math.min(
    await readEventCursor(db, WEBHOOK_CURSORS.platform_events),
    ...(await readHeld(db, 'platform_events')).values(),
  );
  const events = await run(
    db,
    `DELETE FROM platform_events WHERE seq IN (
       SELECT seq FROM platform_events e
        WHERE e.created_at < ?1 AND e.seq <= ?2
          AND NOT (e.type = 'member.deleted' AND EXISTS (
            SELECT 1 FROM export_destinations d
             WHERE d.channel_id = e.channel_id
               AND COALESCE(json_extract(d.cursor_json, '$.deletions'), 0) < e.seq))
        ORDER BY e.seq LIMIT 10000)`,
    cutoff,
    cursor,
  );
  return {
    deliveries: deliveries.meta.changes ?? 0,
    platformEvents: events.meta.changes ?? 0,
  };
}

/** For erasure (Privacy Center): stored webhook payloads that are about the Member. */
export function webhookErasureStatements(db: D1Database, memberId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM webhook_deliveries WHERE member_id = ?1').bind(memberId),
    db.prepare('DELETE FROM platform_events WHERE member_id = ?1').bind(memberId),
  ];
}
