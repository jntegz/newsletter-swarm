/**
 * The Broadcast pipeline, as queue message handlers:
 *
 *   snapshot  copy active, unsuppressed Members in the audience into broadcast_recipients,
 *             1,000 per message
 *   fanout    reserve Reputation Ramp capacity and hand out batches of 50, 500 per message
 *   batch     check the recipient can still be mailed, personalise, build MIME, send, record
 *             deliveries
 *
 * Phase 6: the snapshot also places each recipient for a Split Test or Cohort Sample (a variant,
 * or held back; holdback.ts) and decides which Smart Blocks they see (smartblocks.ts). Fan-out
 * and batches skip held recipients until the decision releases them.
 *
 * Every step is safe to run twice. Recipients are claimed with a conditional UPDATE before
 * they are sent, so a retried or duplicated batch message never mails anyone twice; the only
 * at-least-once window is a worker dying between the provider accepting a message and the
 * delivery row being written, which the reaper resolves after the claim times out.
 */
import {
  SERVICE_STOPPED_RETRY,
  effectivePerSecond,
  windowStart,
  type LimitTurn,
  type SendingLimits,
  type SendWaitReason,
} from '@swarm/domain';
import {
  hasSmartBlockMarkers,
  MailProviderError,
  personalize,
  unsubscribeHeaders,
  type DedicatedSending,
  type MailAdapter,
  type ProviderQuota,
} from '@swarm/mail';
import { toBroadcast, toDispatchSummary } from './api-shapes';
import { askLinks, askOptionIds } from './asks';
import { cancelIfChannelDeleted } from './cancel';
import { AudienceError, compileAudience, parseAudience, type CompiledCircle } from './circles';
import { bounceCode, trackToken, unsubscribeCode } from './codes';
import {
  BATCH_SIZE,
  CLAIM_TIMEOUT_MS,
  FANOUT_CHUNK,
  SNAPSHOT_CHUNK,
  STUCK_AFTER_MS,
  type EngineConfig,
  type SendMessage,
  type SendQueue,
} from './config';
import { all, first, newIdFor, placeholders, run } from './db';
import { sendingConfigurationSet } from './dedicated';
import { bestTimeSlots } from './best-time';
import { cohortHaltNotice, holdBackPlacements } from './holdback';
import { platformEventStatement } from './platform-events';
import { release, reserve, secondsUntilTomorrow } from './ramp';
import {
  activeWait,
  clearFinishedWait,
  endedNotice,
  waitDelaySeconds,
  isPausing,
  resumeDueSends,
  resumeSend,
  startWait,
  waitNotice,
} from './send-waits';
import {
  installIsShared,
  loadSendingLimits,
  quotaResetsAt,
  turnLimits,
  type MailLimiter,
  type StoredLimits,
} from './sending-limits';
import { compileSmartBlocks, smartBlocksForRange } from './smartblocks';
import type { DispatchRow } from './start';
import { broadcastStats } from './stats';
import { channelSettings, optedOutOfTracking } from './tracking-choices';
import { admittedSql } from './variants';

export interface PipelineContext {
  db: D1Database;
  queue: SendQueue;
  /** The provider's own adapter (providerMail): batches take their turns from `limiter` first. */
  mail: MailAdapter;
  /** For the owners' notices; the send worker passes the limited adapter. Absent: `mail`. */
  notices?: MailAdapter;
  config: EngineConfig;
  /** Creates paid Channels' own configuration sets on first send (Phase 7); absent: shared set. */
  dedicated?: DedicatedSending;
  /** MAIL_MAX_PER_SECOND: a ceiling on the per-second limit from Settings. */
  maxPerSecond?: number;
  /**
   * The install's sending limits (the realtime worker's SendPacer). Absent, or failing, a batch
   * keeps to the per-second rate on its own and quotas are not counted.
   */
  limiter?: MailLimiter;
  /** The stored sending limits; read from the database (through a short cache) when absent. */
  limits?: SendingLimits;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** What a queue message's delivery carries besides its body. */
export interface DeliveryInfo {
  /** Cloudflare Queues' attempts for this message: 1 on the first delivery. */
  attempts?: number;
}

export interface BroadcastRow {
  id: string;
  dispatch_id: string;
  channel_id: string;
  workspace_id: string;
  status: 'queued' | 'sending' | 'sent' | 'partially_failed' | 'canceled' | 'failed';
  subject: string;
  preheader: string;
  html: string;
  text: string;
  from_name: string;
  from_address: string;
  reply_to: string | null;
  sending_domain_id: string | null;
  ramp_id: string | null;
  track_opens: number;
  /** 0: plain links, no click tracking per person (0063_tracking_choices.sql). */
  track_clicks: number;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  snapshot_cursor: string | null;
  fanout_cursor: string | null;
  /** The tier being walked during warm-up. Null means no ordering. */
  fanout_tier: 0 | 1 | 2 | null;
  snapshot_done: number;
  fanout_done: number;
  failure_reason: string | null;
  created_by: string | null;
  created_at: number;
  last_progress_at: number;
  resume_at: number | null;
  /** A wait for a sending limit (send-waits.ts, 0066_sending_limits.sql). */
  waiting_for: SendWaitReason | null;
  waiting_since: number | null;
  wait_detail: string | null;
  completed_at: number | null;
  canceled_at: number | null;
  /** The audience with its Circle rules frozen at start (see startBroadcast). */
  audience_json: string;
  /** A gated paid Dispatch's teaser; null when everyone gets html/text (see variants.ts). */
  teaser_html: string | null;
  teaser_text: string | null;
  /** The Gate's levels as counted at start ('[]' = any paid level). */
  gate_level_ids_json: string | null;
  /** 'flow': a Flow email's standing Broadcast (flow_emails), owned by the Flows engine. */
  kind: 'broadcast' | 'flow';
  flow_id: string | null;
  split_test_id: string | null;
  cohort_sample_id: string | null;
  /** 0 not asked for, 1 personal times, 2 asked for but the warm-up limit ruled it out. */
  best_time?: number;
  personal_time_count?: number;
  default_time_count?: number;
}

/** Thrown when a batch should be retried later with the queue's backoff. */
export class RetryLater extends Error {
  constructor(
    message: string,
    readonly delaySeconds: number,
  ) {
    super(message);
    this.name = 'RetryLater';
  }
}

/** Seconds before a batch with retryable failures is tried again, unless the provider says. */
const RETRY_DELAY_SECONDS = 30;
/** Sends in flight per batch when the adapter doesn't say (SES: 10). */
const DEFAULT_CONCURRENCY = 10;
/**
 * How long one message may wait its turns before the rest go back on the queue. A consumer holds
 * up to ten messages and has a wall-clock limit, and waiting costs it duration.
 */
const PACED_BATCH_BUDGET_MS = 60_000;
/**
 * Deliveries of one message the queue retries for throttling. After that, the recipients go back
 * on the queue as a new message with a growing delay, so waiting never reaches the dead-letter
 * queue (max_retries is 8).
 */
const QUEUE_RETRIES = 3;
/** The longest backoff between throttled attempts once they are new messages. */
const MAX_THROTTLE_DELAY_SECONDS = 900;

export type SendErrorClass =
  | { kind: 'halt'; error: string }
  | { kind: 'quota'; error: string; quota: ProviderQuota }
  | { kind: 'failed'; error: string }
  | { kind: 'retry'; error: string; retryAfterSeconds: number | null };

/**
 * What a provider error means for one recipient: quota (the account's daily or monthly quota is
 * used up, wait for it), halt (the account can't send, pause the send until a person resumes
 * it), failed (this message was rejected) or retry (throttling, an outage, or anything that isn't
 * a provider answer, such as a network error).
 */
export function classifySendError(error: unknown): SendErrorClass {
  const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
  if (error instanceof MailProviderError) {
    if (error.quota) {
      return { kind: 'quota', error: `${error.code}: ${message}`, quota: error.quota };
    }
    if (error.halting) return { kind: 'halt', error: `${error.code}: ${message}` };
    if (!error.retryable) return { kind: 'failed', error: `${error.code}: ${message}` };
    return { kind: 'retry', error: message, retryAfterSeconds: error.retryAfterSeconds };
  }
  return { kind: 'retry', error: message, retryAfterSeconds: null };
}

const clock = (ctx: PipelineContext) => (ctx.now ? ctx.now() : Date.now());
/** A Broadcast row paused for a limit (send-waits.ts), in SQL. */
const PAUSED_SQL = `waiting_for IN ('month', 'service_month', 'service_stopped')`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Cloudflare Queues' longest delay. */
const MAX_QUEUE_DELAY_SECONDS = 43_200;

async function loadBroadcast(db: D1Database, id: string): Promise<BroadcastRow | null> {
  return first<BroadcastRow>(db, 'SELECT * FROM broadcasts WHERE id = ?1', id);
}

const live = (b: BroadcastRow | null): b is BroadcastRow =>
  b !== null && (b.status === 'queued' || b.status === 'sending');

/**
 * The Broadcast as a step sees it, canceled first when its Channel has been deleted, so a batch
 * still queued, a ramp's next-day fan-out or a release after a hold-back sends nothing.
 */
async function loadForStep(ctx: PipelineContext, id: string): Promise<BroadcastRow | null> {
  const broadcast = await loadBroadcast(ctx.db, id);
  if (!live(broadcast) || !(await cancelIfChannelDeleted(ctx.db, broadcast, clock(ctx))))
    return broadcast;
  ctx.log?.('broadcast canceled: its Channel was deleted', { broadcastId: id });
  return loadBroadcast(ctx.db, id);
}

export async function handleSendMessage(
  ctx: PipelineContext,
  message: SendMessage,
  delivery: DeliveryInfo = {},
): Promise<void> {
  switch (message.type) {
    case 'snapshot':
      return snapshot(ctx, message.broadcastId);
    case 'fanout':
      return fanout(ctx, message.broadcastId);
    case 'batch':
      return sendBatch(ctx, message, delivery.attempts ?? 1);
    case 'cohort_halted':
      return notifyCohortHalted(ctx, message.broadcastId);
    case 'wait_notice':
      return notifyWaiting(ctx, message.broadcastId, message.ended);
  }
}

/**
 * The audience predicate for a snapshot chunk: the frozen rules, measured from the Broadcast's
 * start so every chunk (and the preflight count) applies the same "last N days" window.
 * Null when the audience can no longer be evaluated (the Broadcast has been failed).
 */
async function snapshotAudience(
  ctx: PipelineContext,
  broadcast: BroadcastRow,
): Promise<CompiledCircle | null> {
  try {
    return await compileAudience(
      ctx.db,
      broadcast.channel_id,
      parseAudience(broadcast.audience_json),
      broadcast.created_at,
    );
  } catch (error) {
    if (!(error instanceof AudienceError)) throw error;
    const now = clock(ctx);
    await run(
      ctx.db,
      `UPDATE broadcasts SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3 AND status IN ('queued', 'sending')`,
      error.message,
      now,
      broadcast.id,
    );
    await settleDispatch(ctx.db, broadcast.dispatch_id, now);
    ctx.log?.('broadcast audience could not be evaluated', {
      broadcastId: broadcast.id,
      error: error.message,
    });
    return null;
  }
}

/**
 * Warm-up order. Mailbox providers judge a new domain by how its first readers respond, and the
 * daily cap only reaches some of them, so it goes to the likeliest to engage.
 *   1  engaged: a fresh score says so, or a person opened or clicked in the last 90 days
 *   2  unknown: everything else, including readers whose opens are hidden from us
 *   0  cold: a fresh score says so
 * 0 is the column's default and goes last, so a row with no opinion on it can't jump the queue.
 */
const TIER_ORDER = [1, 2, 0] as const;
const NEXT_TIER = { 1: 2, 2: 0, 0: null } as const;
const FIRST_TIER = TIER_ORDER[0];
const ENGAGED_WINDOW_MS = 90 * 86_400_000;
/** Scores update daily, so an older one means the feature was switched off. */
const FRESH_SCORE_MS = 7 * 86_400_000;

function tierSql(active: number, fresh: number) {
  return `CASE
    WHEN e.computed_at >= ?${fresh} AND e.band IN ('very_engaged', 'engaged') THEN 1
    WHEN EXISTS (SELECT 1 FROM deliveries d WHERE d.member_id = m.id AND d.sent_at >= ?${active}
                  AND (d.human_opened_at IS NOT NULL OR d.human_clicked_at IS NOT NULL)) THEN 1
    WHEN e.computed_at >= ?${fresh} AND e.band = 'cold' THEN 0
    ELSE 2 END`;
}

/**
 * The recipients the fan-out has already been past, as the reaper needs them. Out of member order,
 * `member_id <= cursor` alone would also take later tiers, which have no ramp reservation yet.
 */
function passedSql(tier: BroadcastRow['fanout_tier']) {
  if (tier === null) return 'member_id <= ?2';
  const earlier = TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier));
  const current = `(send_tier = ${tier} AND member_id <= ?2)`;
  return earlier.length ? `(send_tier IN (${earlier.join(', ')}) OR ${current})` : current;
}

async function rampStillWarming(db: D1Database, rampId: string | null): Promise<boolean> {
  if (!rampId) return false;
  const ramp = await first<{ status: string }>(
    db,
    'SELECT status FROM reputation_ramps WHERE id = ?1',
    rampId,
  );
  return !!ramp && ramp.status !== 'complete';
}

async function snapshot(ctx: PipelineContext, broadcastId: string): Promise<void> {
  const { db } = ctx;
  const broadcast = await loadForStep(ctx, broadcastId);
  if (!live(broadcast) || broadcast.snapshot_done) return;
  const audience = await snapshotAudience(ctx, broadcast);
  if (!audience) return;
  const now = clock(ctx);
  const cursor = broadcast.snapshot_cursor ?? '';

  const page = await all<{ id: string }>(
    db,
    `SELECT id FROM members WHERE channel_id = ?1 AND status = 'active' AND id > ?2 ORDER BY id LIMIT ?3`,
    broadcast.channel_id,
    cursor,
    SNAPSHOT_CHUNK,
  );
  const last = page.at(-1)?.id;
  // Decided on the first page and kept, so one Broadcast is ordered all the way through or not at all.
  const ordered =
    broadcast.fanout_tier !== null ||
    (cursor === '' && (await rampStillWarming(db, broadcast.ramp_id)));

  if (last) {
    // Copy the page's Members in the audience, minus suppressed addresses, and advance the
    // cursor in one transaction. The cursor guard makes a duplicate message a no-op instead of a
    // double copy, and the primary key makes overlapping Circles count each Member once.
    // ?1 carries the audience's values (see compileAudience).
    // A gated paid Dispatch also decides here, once, who gets the full email and who the teaser.
    const variant =
      broadcast.teaser_html !== null
        ? `CASE WHEN ${admittedSql(7, 8)} THEN 'full' ELSE 'teaser' END`
        : `'full'`;
    // Placements for this page, keyed by Member id: [held, split variant, Smart Blocks, best-time slot].
    const placements = await recipientPlacements(ctx, broadcast, page, cursor, last);
    const at = broadcast.teaser_html !== null ? 9 : 7;
    const tierAt = at + (placements ? 1 : 0);
    const tier = ordered
      ? {
          columns: ', send_tier',
          values: `, ${tierSql(tierAt, tierAt + 1)}`,
          join: ' LEFT JOIN member_engagement e ON e.member_id = m.id',
          params: [now - ENGAGED_WINDOW_MS, now - FRESH_SCORE_MS],
        }
      : { columns: '', values: '', join: '', params: [] };
    const placed = placements
      ? {
          columns: ', held, split_variant_id, smart_blocks_json, send_after',
          values: `, coalesce(json_extract(p.value, '$[0]'), 0), json_extract(p.value, '$[1]'), json_extract(p.value, '$[2]'), json_extract(p.value, '$[3]')`,
          join: ` LEFT JOIN json_each(?${at}) p ON p.key = m.id`,
        }
      : { columns: '', values: '', join: '' };
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, member_id, email, first_name, last_name, variant${placed.columns}${tier.columns})
           SELECT ?2, m.id, m.email, m.first_name, m.last_name, ${variant}${placed.values}${tier.values} FROM members m${placed.join}${tier.join}
            WHERE m.channel_id = ?3 AND m.status = 'active' AND m.emails_off_at IS NULL
              AND m.id > ?4 AND m.id <= ?5
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?6 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))
              AND (${audience.where})`,
        )
        .bind(
          ...audience.params,
          broadcastId,
          broadcast.channel_id,
          cursor,
          last,
          broadcast.workspace_id,
          ...(broadcast.teaser_html !== null ? [now, broadcast.gate_level_ids_json ?? '[]'] : []),
          ...(placements ? [JSON.stringify(placements)] : []),
          ...tier.params,
        ),
      db
        .prepare(
          `UPDATE broadcasts SET snapshot_cursor = ?1, last_progress_at = ?2, fanout_tier = ?5
            WHERE id = ?3 AND ifnull(snapshot_cursor, '') = ?4`,
        )
        .bind(last, now, broadcastId, cursor, ordered ? FIRST_TIER : null),
    ]);
  }

  if (page.length === SNAPSHOT_CHUNK) {
    await ctx.queue.send({ type: 'snapshot', broadcastId });
    return;
  }

  // Snapshot complete: freeze the count and start handing out batches.
  const done = await first<{ recipient_count: number }>(
    db,
    `UPDATE broadcasts
        SET snapshot_done = 1, status = 'sending', last_progress_at = ?1,
            recipient_count = (SELECT count(*) FROM broadcast_recipients WHERE broadcast_id = ?2),
            personal_time_count = CASE WHEN best_time = 0 THEN 0 ELSE
              (SELECT count(*) FROM broadcast_recipients WHERE broadcast_id = ?2 AND send_after IS NOT NULL) END,
            default_time_count = CASE WHEN best_time = 0 THEN 0 ELSE
              (SELECT count(*) FROM broadcast_recipients WHERE broadcast_id = ?2 AND send_after IS NULL) END
      WHERE id = ?2 AND snapshot_done = 0 AND status IN ('queued', 'sending')
      RETURNING recipient_count`,
    now,
    broadcastId,
  );
  if (!done) return;
  ctx.log?.('broadcast snapshot complete', { broadcastId, recipients: done.recipient_count });
  if (done.recipient_count === 0) {
    await run(db, 'UPDATE broadcasts SET fanout_done = 1 WHERE id = ?1', broadcastId);
    await maybeComplete(ctx, broadcastId);
    return;
  }
  await ctx.queue.send({ type: 'fanout', broadcastId });
}

/**
 * Placements for a snapshot page: per Member, [held (0/1), split variant id or null, visible Smart
 * Block indexes or null, best-time slot or null]. Null when the Broadcast has none of these.
 */
async function recipientPlacements(
  ctx: PipelineContext,
  broadcast: BroadcastRow,
  page: { id: string }[],
  cursor: string,
  last: string,
): Promise<Record<string, [0 | 1, string | null, number[] | null, number | null]> | null> {
  const { db } = ctx;
  const ids = page.map((row) => row.id);
  const holdBack = await holdBackPlacements(db, broadcast, ids);
  // Smart Blocks are in the frozen render only when the Dispatch has some (and its flag was on).
  let visible: Map<string, number[]> | null = null;
  if (hasSmartBlockMarkers(broadcast)) {
    const dispatch = await first<{ content_json: string }>(
      db,
      'SELECT content_json FROM dispatches WHERE id = ?1',
      broadcast.dispatch_id,
    );
    // The Dispatch can't change while it is sending; conditions are measured from the start.
    const blocks = await compileSmartBlocks(
      db,
      broadcast.channel_id,
      JSON.parse(dispatch?.content_json ?? '{}'),
      broadcast.created_at,
    );
    visible = await smartBlocksForRange(db, broadcast.channel_id, blocks, ids, cursor, last);
  }
  // Never alongside a hold-back: starting the send refuses that.
  const now = clock(ctx);
  const slots = broadcast.best_time === 1 ? await bestTimeSlots(db, broadcast, ids, now) : null;
  if (!holdBack && !visible && !slots) return null;
  const out: Record<string, [0 | 1, string | null, number[] | null, number | null]> = {};
  for (const id of ids) {
    const place = holdBack?.get(id);
    const slot = slots?.get(id) ?? null;
    out[id] = [
      place?.held ?? (slot !== null && slot > now ? 1 : 0),
      place?.variantId ?? null,
      visible ? (visible.get(id) ?? []) : null,
      slot,
    ];
  }
  return out;
}

/** A fan-out waiting for a limit looks again at least this often, so a resume isn't missed. */
const FANOUT_WAIT_RECHECK_SECONDS = 900;

async function fanout(ctx: PipelineContext, broadcastId: string): Promise<void> {
  const { db } = ctx;
  const broadcast = await loadForStep(ctx, broadcastId);
  if (!live(broadcast) || !broadcast.snapshot_done || broadcast.fanout_done) return;
  const now = clock(ctx);
  // Waiting for a sending limit: hand nothing out. A pause is resumed with a new fan-out
  // (send-waits.ts); a short wait comes back here when it ends.
  const wait = activeWait(broadcast, now);
  if (wait) {
    if (!isPausing(wait)) {
      await ctx.queue.send(
        { type: 'fanout', broadcastId },
        {
          delaySeconds: Math.min(
            FANOUT_WAIT_RECHECK_SECONDS,
            waitDelaySeconds(broadcast.resume_at ?? now, now),
          ),
        },
      );
    }
    return;
  }
  const cursor = broadcast.fanout_cursor ?? '';
  const tier = broadcast.fanout_tier;

  const remaining = await all<{ member_id: string; reserved_on: string | null }>(
    db,
    `SELECT member_id, reserved_on FROM broadcast_recipients
      WHERE broadcast_id = ?1 AND member_id > ?2 AND status = 'pending' AND held = 0
        ${tier === null ? '' : `AND send_tier = ${tier}`}
      ORDER BY member_id LIMIT ?3`,
    broadcastId,
    cursor,
    FANOUT_CHUNK,
  );
  if (remaining.length === 0) {
    const next = tier === null ? null : NEXT_TIER[tier];
    if (next !== null) {
      // This tier is done: walk the next one from the start. It has ids below the cursor. Only
      // the fan-out that moved it goes on, so two running at once become one.
      const moved = await run(
        db,
        `UPDATE broadcasts SET fanout_tier = ?1, fanout_cursor = NULL, last_progress_at = ?2
          WHERE id = ?3 AND fanout_tier = ?4 AND ifnull(fanout_cursor, '') = ?5`,
        next,
        now,
        broadcastId,
        tier,
        cursor,
      );
      if (moved.meta.changes) await ctx.queue.send({ type: 'fanout', broadcastId });
      return;
    }
    await run(
      db,
      'UPDATE broadcasts SET fanout_done = 1, last_progress_at = ?1 WHERE id = ?2',
      now,
      broadcastId,
    );
    await maybeComplete(ctx, broadcastId);
    return;
  }

  // Warm-up capacity, for the recipients that hold none for today (reserved_on). One that still
  // holds today's, waiting in a delayed or duplicated batch or put back by a short wait, is handed
  // out again without it: whichever message gets there first sends it, once.
  const today = utcDay(now);
  let slice = remaining;
  const reserved: string[] = [];
  if (broadcast.ramp_id) {
    const needed = remaining.filter((r) => r.reserved_on !== today).length;
    const reservation = needed ? await reserve(db, broadcast.ramp_id, needed, now) : null;
    // In member order, up to the first recipient the capacity doesn't reach.
    let left = reservation?.granted ?? 0;
    slice = [];
    for (const recipient of remaining) {
      if (recipient.reserved_on !== today) {
        if (left === 0) break;
        left--;
        reserved.push(recipient.member_id);
      }
      slice.push(recipient);
    }
    if (slice.length === 0) {
      // Out of capacity (or paused): wait. The reaper leaves the Broadcast alone until resume_at.
      const delay = reservation?.ramp.status === 'paused' ? 3600 : secondsUntilTomorrow(now);
      await run(
        db,
        'UPDATE broadcasts SET resume_at = ?1, last_progress_at = ?2 WHERE id = ?3',
        now + delay * 1000,
        now,
        broadcastId,
      );
      ctx.log?.('broadcast waiting for the reputation ramp', { broadcastId, delaySeconds: delay });
      await ctx.queue.send({ type: 'fanout', broadcastId }, { delaySeconds: delay });
      return;
    }
  }

  const batches: { body: SendMessage }[] = [];
  for (let i = 0; i < slice.length; i += BATCH_SIZE) {
    batches.push({
      body: {
        type: 'batch',
        broadcastId,
        memberIds: slice.slice(i, i + BATCH_SIZE).map((r) => r.member_id),
      },
    });
  }
  const last = slice.at(-1)!.member_id;
  // Only the last pass can finish the fan-out. Other tiers come back here to move on.
  const lastPass = tier === null || NEXT_TIER[tier] === null;
  const exhausted =
    lastPass && remaining.length < FANOUT_CHUNK && slice.length === remaining.length;
  // The cursor moves first, guarded on where this walk started, and only the fan-out that moved
  // it hands its slice out and marks the capacity it reserved. Two fan-outs at once (a resume
  // beside a delayed one) become one: the other gives its reservation back and stops. A worker
  // dying before the batches are queued leaves them pending behind the cursor, for the reaper.
  // A short wait that has run out ends here too (activeWait above let the fan-out through). A
  // pause a batch started since then stays, with its resume_at.
  const [moved] = await db.batch([
    db
      .prepare(
        `UPDATE broadcasts SET fanout_cursor = ?1, fanout_done = ?2, last_progress_at = ?3,
                resume_at = CASE WHEN ${PAUSED_SQL} THEN resume_at ELSE NULL END,
                waiting_since = CASE WHEN ${PAUSED_SQL} THEN waiting_since ELSE NULL END,
                wait_detail = CASE WHEN ${PAUSED_SQL} THEN wait_detail ELSE NULL END,
                waiting_for = CASE WHEN ${PAUSED_SQL} THEN waiting_for ELSE NULL END
          WHERE id = ?4 AND ifnull(fanout_cursor, '') = ?5 AND fanout_tier IS ?6
          RETURNING id`,
      )
      .bind(last, exhausted ? 1 : 0, now, broadcastId, cursor, tier),
    db
      .prepare(
        `UPDATE broadcast_recipients SET reserved_on = ?1
          WHERE broadcast_id = ?2 AND member_id IN (SELECT value FROM json_each(?3))
            AND status = 'pending'
            AND (SELECT fanout_cursor FROM broadcasts WHERE id = ?2) IS ?4`,
      )
      .bind(today, broadcastId, JSON.stringify(reserved), last),
  ]);
  if (!moved?.results.length) {
    if (broadcast.ramp_id && reserved.length) await release(db, broadcast.ramp_id, reserved.length);
    return;
  }
  // Queues accept up to 100 messages per sendBatch; FANOUT_CHUNK / BATCH_SIZE = 10.
  await ctx.queue.sendBatch(batches);
  if (!exhausted) await ctx.queue.send({ type: 'fanout', broadcastId });
}

interface Claimed {
  member_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  variant: 'full' | 'teaser';
  split_variant_id: string | null;
  smart_blocks_json: string | null;
}

interface VariantRender {
  subject: string | null;
  html: string | null;
  text: string | null;
}

const variantCache = new Map<string, Map<string, VariantRender>>();

/** A Split Test's frozen variants (subject, render), by variant id. Frozen at start: cacheable. */
async function splitVariants(db: D1Database, splitTestId: string) {
  let variants = variantCache.get(splitTestId);
  if (!variants) {
    const rows = await all<VariantRender & { id: string }>(
      db,
      'SELECT id, subject, html, text FROM split_test_variants WHERE split_test_id = ?1',
      splitTestId,
    );
    variants = new Map(rows.map((row) => [row.id, row]));
    if (variantCache.size > 100) variantCache.clear();
    variantCache.set(splitTestId, variants);
  }
  return variants;
}

const linkCache = new Map<string, { id: string; position: number; url: string }[]>();

async function linkTargets(db: D1Database, broadcastId: string) {
  let links = linkCache.get(broadcastId);
  if (!links) {
    links = await all<{ id: string; position: number; url: string }>(
      db,
      'SELECT id, position, url FROM link_targets WHERE broadcast_id = ?1 ORDER BY position',
      broadcastId,
    );
    if (linkCache.size > 100) linkCache.clear();
    linkCache.set(broadcastId, links);
  }
  return links;
}

/**
 * What this batch may track: opens and clicks per person as the Broadcast froze them and the
 * Channel allows now, and the claimed Members who asked not to be tracked.
 */
async function trackingFor(
  db: D1Database,
  broadcast: Pick<BroadcastRow, 'channel_id' | 'track_opens' | 'track_clicks'>,
  memberIds: readonly string[],
): Promise<{ opens: boolean; clicks: boolean; optedOut: Set<string> }> {
  const [channel, optedOut] = await Promise.all([
    first<{ settings_json: string }>(
      db,
      'SELECT settings_json FROM channels WHERE id = ?1',
      broadcast.channel_id,
    ),
    optedOutOfTracking(db, memberIds),
  ]);
  const now = channelSettings(channel?.settings_json ?? '{}');
  return {
    opens: broadcast.track_opens === 1 && now.trackOpens,
    clicks: broadcast.track_clicks !== 0 && now.trackClicks,
    optedOut,
  };
}

function linkBase(config: EngineConfig, linkDomain: string | null): string {
  return linkDomain ? `https://${linkDomain}` : config.trackOrigin;
}

async function channelLinkDomain(db: D1Database, channelId: string): Promise<string | null> {
  const row = await first<{ domain: string }>(
    db,
    `SELECT domain FROM sending_domains WHERE channel_id = ?1 AND kind = 'link' AND status = 'verified'
      ORDER BY verified_at LIMIT 1`,
    channelId,
  );
  return row?.domain ?? null;
}

/** Plain profile field values by Member, by key. */
async function memberFieldValues(db: D1Database, memberIds: string[]) {
  const rows = await all<{
    member_id: string;
    key: string;
    value_text: string | null;
    value_num: number | null;
  }>(
    db,
    `SELECT v.member_id, f.key, v.value_text, v.value_num
       FROM member_field_values v JOIN member_fields f ON f.id = v.field_id
      WHERE f.encrypted = 0 AND f.deleted_at IS NULL
        AND v.member_id IN (SELECT value FROM json_each(?1))`,
    JSON.stringify(memberIds),
  );
  const values = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const value = row.value_text ?? (row.value_num === null ? null : String(row.value_num));
    if (value === null) continue;
    values.set(row.member_id, { ...values.get(row.member_id), [row.key]: value });
  }
  return values;
}

/**
 * Pending recipients of a paused Broadcast give their warm-up capacity back (reserved_on), so other
 * sends on the domain can use it today; the resume's walk reserves again on the day they really
 * go. Each recipient gives back once, however many messages hold it, and only today's capacity:
 * an earlier day's ended with its day. A Flow email's Broadcast keeps its reservations, since its
 * resume puts its recipients back on the queue without reserving.
 */
async function giveBack(
  db: D1Database,
  broadcast: Pick<BroadcastRow, 'id' | 'ramp_id' | 'kind'>,
  memberIds: string[],
  now: number,
): Promise<void> {
  if (!broadcast.ramp_id || broadcast.kind !== 'broadcast' || !memberIds.length) return;
  const mine = `broadcast_id = ?1 AND member_id IN (SELECT value FROM json_each(?2))
        AND status = 'pending' AND reserved_on IS NOT NULL`;
  const ids = JSON.stringify(memberIds);
  // Counted and cleared in one transaction, so a second message holding them finds nothing.
  const [held] = await db.batch([
    db
      .prepare(`SELECT count(*) AS n FROM broadcast_recipients WHERE ${mine} AND reserved_on = ?3`)
      .bind(broadcast.id, ids, utcDay(now)),
    db
      .prepare(`UPDATE broadcast_recipients SET reserved_on = NULL WHERE ${mine}`)
      .bind(broadcast.id, ids),
  ]);
  const count = (held?.results[0] as { n: number } | undefined)?.n ?? 0;
  if (count) await release(db, broadcast.ramp_id, count);
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Gives back to the pacer what it counted for these recipients, whose emails did not go out. Each
 * turn counted in the windows of when it was taken, so they go back grouped by the hour of it.
 */
async function giveBackTurns(pacer: MailLimiter, countedAt: number[]): Promise<void> {
  const byHour = new Map<number, { count: number; at: number }>();
  for (const at of countedAt) {
    const hour = windowStart('hour', at);
    const group = byHour.get(hour);
    byHour.set(hour, { count: (group?.count ?? 0) + 1, at: Math.min(group?.at ?? at, at) });
  }
  for (const { count, at } of byHour.values()) {
    await pacer.release(count, at).catch(() => undefined);
  }
}

async function sendBatch(
  ctx: PipelineContext,
  message: Extract<SendMessage, { type: 'batch' }>,
  attempts: number,
): Promise<void> {
  const { broadcastId, memberIds } = message;
  const { db, config } = ctx;
  const broadcast = await loadForStep(ctx, broadcastId);
  if (!broadcast) return;
  const now = clock(ctx);

  if (!live(broadcast)) {
    // Canceled or failed: whatever this batch held will never be sent.
    if (memberIds.length) {
      await run(
        db,
        `UPDATE broadcast_recipients SET status = 'skipped'
          WHERE broadcast_id = ?1 AND status = 'pending' AND member_id IN (${placeholders(memberIds.length, 2)})`,
        broadcastId,
        ...memberIds,
      );
    }
    return;
  }

  // Waiting for a sending limit: nobody is claimed, so nobody is lost. A short wait sends this
  // message again when it ends (a new message: it doesn't count against max_retries); a pause
  // leaves its recipients pending for the resume to walk again. A try of an email service that
  // stopped accepting mail (send-waits.ts) goes through.
  const wait = activeWait(broadcast, now);
  const probing = message.probe === true && wait === 'service_stopped';
  if (wait && !probing) {
    if (isPausing(wait)) await giveBack(db, broadcast, memberIds, now);
    else {
      await ctx.queue.send(message, {
        delaySeconds: waitDelaySeconds(broadcast.resume_at ?? now, now),
      });
    }
    return;
  }

  // The last check before the provider. A recipient row says someone could be mailed when it was
  // written; by now they may have unsubscribed, bounced, complained, paused, turned emails off or
  // been suppressed
  // (a slow queue, a throttled provider's retry, a Split Test's held recipients), and the Channel
  // may have been deleted (a Flow's batch). One transaction: whoever can no longer be mailed is
  // skipped, and only the rest are claimed.
  const count = memberIds.length;
  const claimable = `broadcast_id = ?1 AND member_id IN (${placeholders(count, 3)}) AND held = 0
        AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?2))`;
  const channel = `?${count + 3}`;
  const workspace = `?${count + 4}`;
  const claiming = [broadcastId, now - CLAIM_TIMEOUT_MS, ...memberIds];
  const [stopped, claim] = await db.batch<Claimed>([
    db
      .prepare(
        `UPDATE broadcast_recipients SET status = 'skipped'
          WHERE ${claimable}
            AND (EXISTS (SELECT 1 FROM channels ch WHERE ch.id = ${channel} AND ch.deleted_at IS NOT NULL)
                 OR NOT EXISTS (SELECT 1 FROM members m WHERE m.id = broadcast_recipients.member_id
                                AND m.channel_id = ${channel} AND m.status = 'active'
                                AND m.emails_off_at IS NULL)
                 OR EXISTS (SELECT 1 FROM suppressions s
                             WHERE s.workspace_id = ${workspace}
                               AND (s.channel_id IS NULL OR s.channel_id = ${channel})
                               AND s.email IN (broadcast_recipients.email,
                                 (SELECT m.email FROM members m WHERE m.id = broadcast_recipients.member_id))))
          RETURNING reserved_on`,
      )
      .bind(...claiming, broadcast.channel_id, broadcast.workspace_id),
    db
      .prepare(
        `UPDATE broadcast_recipients SET status = 'sending', claimed_at = ?${count + 3}, attempts = attempts + 1
          WHERE ${claimable}
          RETURNING member_id, email, first_name, last_name, variant, split_variant_id, smart_blocks_json`,
      )
      .bind(...claiming, now),
  ]);
  const skippedRows = (stopped?.results ?? []) as unknown as { reserved_on: string | null }[];
  const skipped = skippedRows.length;
  if (skipped > 0) {
    // They were counted and their Reputation Ramp capacity reserved; neither is used now. Only
    // today's capacity goes back: an earlier day's ended with its day.
    await run(
      db,
      'UPDATE broadcasts SET recipient_count = max(0, recipient_count - ?1), last_progress_at = ?2 WHERE id = ?3',
      skipped,
      now,
      broadcastId,
    );
    const today = utcDay(now);
    const held = skippedRows.filter((row) => row.reserved_on === today).length;
    if (broadcast.ramp_id && held) await release(db, broadcast.ramp_id, held);
    ctx.log?.('recipients left before their batch was sent', { broadcastId, skipped });
  }
  const claimed = claim?.results ?? [];
  if (claimed.length === 0) {
    // This may have been the last open recipient, and no send below will finish the Broadcast.
    if (skipped > 0) await maybeComplete(ctx, broadcastId);
    return;
  }

  const links = await linkTargets(db, broadcastId);
  // Tracking (docs/privacy-controls.md): what the send froze, narrowed by what the publication
  // allows now (a Flow email's Broadcast lives on), and off for anyone who asked not to be tracked.
  const tracking = await trackingFor(
    db,
    broadcast,
    claimed.map((recipient) => recipient.member_id),
  );
  const variants = broadcast.split_test_id
    ? await splitVariants(db, broadcast.split_test_id)
    : null;
  const base = linkBase(config, await channelLinkDomain(db, broadcast.channel_id));
  // A paid Channel sends through its own configuration set (created on its first send).
  const configurationSet = await sendingConfigurationSet(
    db,
    ctx.dedicated,
    broadcast.channel_id,
    now,
    (message, fields) => ctx.log?.(message, fields),
  );
  const fromDomain = broadcast.from_address.split('@')[1] as string;
  // One-tap poll options in the frozen templates; each recipient gets links signed for them.
  const pollOptions = askOptionIds(
    broadcast.html,
    broadcast.text,
    broadcast.teaser_html ?? '',
    broadcast.teaser_text ?? '',
  );

  type Outcome =
    | { kind: 'sent'; recipient: Claimed; deliveryId: string; providerId: string; tracked: boolean }
    | { kind: 'failed'; recipient: Claimed; deliveryId: string; error: string; tracked: boolean }
    | { kind: 'retry'; recipient: Claimed; error: string; retryAfterSeconds: number | null }
    | { kind: 'quota'; recipient: Claimed; error: string; quota: ProviderQuota }
    | { kind: 'halt'; recipient: Claimed; error: string };

  // Profile fields, only when this email asks for one. Encrypted fields never go into mail.
  const asksForFields = [broadcast.html, broadcast.subject, broadcast.teaser_html]
    .concat([...(variants?.values() ?? [])].flatMap((v) => [v.html, v.subject]))
    .some((part) => part?.includes('field.'));
  const fieldValues = asksForFields
    ? await memberFieldValues(
        db,
        claimed.map((recipient) => recipient.member_id),
      )
    : null;

  // Only the send worker signs these; failing here (before any send) beats a broken link.
  const { trackKeys, bounceKeys } = config;
  if (!trackKeys || !bounceKeys)
    throw new Error('the send pipeline needs TRACK_KEYS and BOUNCE_KEYS');
  const sendOne = async (recipient: Claimed): Promise<Outcome> => {
    const deliveryId = newIdFor('delivery', now);
    const tracked = !tracking.optedOut.has(recipient.member_id);
    // Without click tracking a link is the address itself: nothing passes through Swarm.
    const tokens =
      tracked && tracking.clicks
        ? await Promise.all(
            links.map((link) => trackToken(trackKeys, { d: deliveryId, l: link.id })),
          )
        : null;
    const code = await unsubscribeCode(config.unsubscribeKeys, deliveryId);
    const unsubscribeUrl = `${base}/u/${code}`;
    const pixelUrl =
      tracked && tracking.opens
        ? `${base}/o/${await trackToken(trackKeys, { d: deliveryId })}`
        : null;
    const member = { memberId: recipient.member_id, channelId: broadcast.channel_id };
    // Every footer links the recipient's own Member Center (a 30-day "member" token).
    const memberCenterUrl =
      config.memberLinks && config.captureOrigin
        ? `${config.captureOrigin}/m/${await config.memberLinks.memberToken(member, { now })}`
        : unsubscribeUrl;
    const polls =
      pollOptions.length && config.askSigner && config.captureOrigin
        ? await askLinks(config.askSigner, config.captureOrigin, member, pollOptions, now)
        : null;
    // The variant was fixed in the snapshot, so a retry sends the same email. Full or teaser
    // (Phase 5) and the Split Test variant are independent: a test on a gated Dispatch changes
    // only the subject.
    const teaser = recipient.variant === 'teaser' && broadcast.teaser_html !== null;
    const split = recipient.split_variant_id
      ? variants?.get(recipient.split_variant_id)
      : undefined;
    const template = {
      html: teaser ? broadcast.teaser_html! : (split?.html ?? broadcast.html),
      text: teaser ? (broadcast.teaser_text ?? broadcast.text) : (split?.text ?? broadcast.text),
      subject: split?.subject ?? broadcast.subject,
    };
    // Smart Blocks seen, as decided in the snapshot; an email with blocks but no decision shows
    // none of them rather than all.
    const smartBlocks = recipient.smart_blocks_json
      ? (JSON.parse(recipient.smart_blocks_json) as number[])
      : hasSmartBlockMarkers(template)
        ? []
        : undefined;
    const fields = fieldValues?.get(recipient.member_id);
    const filled = personalize(template, {
      ...(smartBlocks ? { smartBlocks } : {}),
      link: (n) =>
        tokens ? (tokens[n] ? `${base}/c/${tokens[n]}` : base) : (links[n]?.url ?? base),
      unsubscribeUrl,
      memberCenterUrl,
      pixelUrl,
      member: {
        email: recipient.email,
        firstName: recipient.first_name,
        lastName: recipient.last_name,
        ...(fields ? { fields } : {}),
      },
      ask: (optionId) => polls?.get(optionId) ?? null,
    });
    try {
      const sent = await ctx.mail.send({
        category: 'broadcast',
        from: { name: broadcast.from_name, address: broadcast.from_address },
        to: recipient.email,
        replyTo: broadcast.reply_to ?? broadcast.from_address,
        subject: filled.subject,
        html: filled.html,
        text: filled.text,
        messageId: `${deliveryId}@${fromDomain}`,
        // Its own code: the unsubscribe code is in the body, and a bounce suppresses workspace-wide.
        returnPath: `bounce+${await bounceCode(bounceKeys, deliveryId)}@${config.unsubscribeMailDomain}`,
        headers: {
          ...unsubscribeHeaders(unsubscribeUrl, `unsub+${code}@${config.unsubscribeMailDomain}`),
          'Feedback-ID': `${broadcast.id}:${broadcast.channel_id}:broadcast:swarm`,
          'X-Swarm-Delivery': deliveryId,
        },
        tags: { broadcast: broadcast.id, channel: broadcast.channel_id, delivery: deliveryId },
        ...(configurationSet ? { configurationSet } : {}),
      });
      return { kind: 'sent', recipient, deliveryId, providerId: sent.messageId, tracked };
    } catch (error) {
      const classified = classifySendError(error);
      if (classified.kind === 'failed') return { ...classified, recipient, deliveryId, tracked };
      return { ...classified, recipient };
    }
  };

  // A few in flight at a time (the adapter's maxConcurrency: SES 10, Resend 8) keeps a batch
  // inside the provider's per-second rate. With a per-second limit, each chunk takes its turn
  // from the install's pacer; without one, a single turn counts the whole batch.
  const stored: StoredLimits | null = ctx.limits ? null : await loadSendingLimits(db);
  const limits = ctx.limits ?? stored!.limits;
  const rate = effectivePerSecond(limits, ctx.maxPerSecond);
  const concurrency = Math.max(
    1,
    Math.min(ctx.mail.maxConcurrency ?? DEFAULT_CONCURRENCY, rate ?? Number.MAX_SAFE_INTEGER),
  );
  const step = rate ? concurrency : claimed.length;
  const outcomes: Outcome[] = [];
  // Recipients a turn didn't grant, and why: back to the queue or waiting. Nothing is wrong with them.
  let held: { recipients: Claimed[]; turn: LimitTurn } | null = null;
  // Recipients not tried because the provider stopped or ran out of quota earlier in the batch.
  let untried: Claimed[] = [];
  // The pacer, kept to give back what it counted and to tell it about a used-up quota even after
  // a later turn failed; `pacing` is whether this batch still takes turns from it.
  const pacer = ctx.limiter ?? null;
  let pacing = pacer !== null;
  // When the pacer counted each recipient's email, for those granted a turn.
  const countedAt = new Map<string, number>();
  const batchStarted = Date.now();
  // Several workspaces on this install: large sends are admitted in parts (SEND_ADMISSION_SHARE).
  const sharedInstall = pacer ? await installIsShared(db).catch(() => false) : false;
  const stopping = () => outcomes.some((o) => o.kind === 'halt' || o.kind === 'quota');
  for (let i = 0; i < claimed.length; i += step) {
    const slice = claimed.slice(i, i + step);
    if (stopping()) {
      untried = claimed.slice(i);
      break;
    }
    let allowed = slice.length;
    if (pacer && pacing) {
      try {
        const takenAt = Date.now();
        const turn: LimitTurn =
          takenAt - batchStarted > PACED_BATCH_BUDGET_MS
            ? { granted: 0, startInMs: 0, retryAfterSeconds: 1, limit: 'second', resetsAt: null }
            : await pacer.turn({
                count: slice.length,
                priority: 'bulk',
                // Shared fairly with other workspaces sending at the same time.
                workspaceId: broadcast.workspace_id,
                sharedInstall,
                ...(stored ? turnLimits(stored) : { limits }),
                ceiling: ctx.maxPerSecond ?? null,
              });
        for (const recipient of slice.slice(0, turn.granted)) {
          countedAt.set(recipient.member_id, takenAt);
        }
        allowed = turn.granted;
        if (turn.granted < slice.length) {
          held = { recipients: claimed.slice(i + turn.granted), turn };
        }
        if (turn.startInMs > 0) await sleep(turn.startInMs);
      } catch (error) {
        // Sending never stops for the pacer: this batch keeps to the rate on its own instead.
        pacing = false;
        ctx.log?.('send pacer unavailable; pacing per batch', {
          broadcastId,
          error: (error as Error).message,
        });
      }
    }
    const going = slice.slice(0, allowed);
    const started = Date.now();
    for (let j = 0; j < going.length; j += concurrency) {
      if (stopping()) {
        // Granted and counted, but not sent: given back below.
        untried = going.slice(j);
        break;
      }
      outcomes.push(...(await Promise.all(going.slice(j, j + concurrency).map(sendOne))));
    }
    if (held || untried.length) break;
    // Keeps to the rate when the pacer isn't there to; throttling answers still come back here.
    if (!pacing && rate && i + step < claimed.length) {
      const wait = (slice.length / rate) * 1000 - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }
  if (held && untried.length) held = { ...held, recipients: [...untried, ...held.recipients] };

  const statements: D1PreparedStatement[] = [];
  let sent = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    const memberId = outcome.recipient.member_id;
    if (outcome.kind === 'sent' || outcome.kind === 'failed') {
      const ok = outcome.kind === 'sent';
      if (ok) sent++;
      else failed++;
      statements.push(
        db
          .prepare(
            `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, error, sent_at, tracked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (broadcast_id, member_id) DO NOTHING`,
          )
          .bind(
            outcome.deliveryId,
            broadcastId,
            broadcast.channel_id,
            memberId,
            outcome.recipient.email,
            ok ? outcome.providerId : null,
            ok ? 'sent' : 'failed',
            ok ? null : outcome.error,
            now,
            outcome.tracked ? 1 : 0,
          ),
        db
          .prepare(
            `UPDATE broadcast_recipients SET status = ?1 WHERE broadcast_id = ?2 AND member_id = ?3`,
          )
          .bind(ok ? 'sent' : 'failed', broadcastId, memberId),
      );
    } else if (outcome.kind === 'retry') {
      // Not sent: back to pending so the retried message (or the reaper) can claim it again.
      statements.push(
        db
          .prepare(
            `UPDATE broadcast_recipients SET status = 'pending', claimed_at = NULL WHERE broadcast_id = ?1 AND member_id = ?2`,
          )
          .bind(broadcastId, memberId),
      );
    }
  }
  // The account, not the recipient, held these back: the claim is undone as if it never happened.
  const notTried = [
    ...outcomes.filter((o) => o.kind === 'quota' || o.kind === 'halt').map((o) => o.recipient),
    ...(held?.recipients ?? untried),
  ];
  if (notTried.length) {
    statements.push(
      db
        .prepare(
          `UPDATE broadcast_recipients SET status = 'pending', claimed_at = NULL, attempts = max(0, attempts - 1)
            WHERE broadcast_id = ?1 AND member_id IN (SELECT value FROM json_each(?2))`,
        )
        .bind(broadcastId, JSON.stringify(notTried.map((r) => r.member_id))),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE broadcasts SET sent_count = sent_count + ?1, failed_count = failed_count + ?2, last_progress_at = ?3 WHERE id = ?4`,
      )
      .bind(sent, failed, now, broadcastId),
  );
  await db.batch(statements);
  if (sent > 0 && broadcast.waiting_for) await clearFinishedWait(db, broadcastId, now);
  // Its share came round again: no longer waiting for capacity.
  if (sent > 0 && !held?.turn.share) {
    await run(
      db,
      'UPDATE broadcasts SET share_wait_since = NULL, share_wait_until = NULL WHERE id = ?1 AND share_wait_since IS NOT NULL',
      broadcastId,
    );
  }

  // What the pacer counted for emails that didn't go out is given back: those it granted that the
  // provider didn't take, and those granted but never tried.
  if (pacer) {
    const unsent = [
      ...outcomes
        .filter((o) => o.kind === 'retry' || o.kind === 'quota' || o.kind === 'halt')
        .map((o) => o.recipient),
      ...untried,
    ];
    const counted = unsent.flatMap((r) => countedAt.get(r.member_id) ?? []);
    if (counted.length) await giveBackTurns(pacer, counted);
  }

  const retries = outcomes.filter((o) => o.kind === 'retry');
  const waiting = [...retries.map((o) => o.recipient), ...notTried];
  const halt = outcomes.find((o) => o.kind === 'halt');
  const quota = outcomes.find((o) => o.kind === 'quota');

  // A try of a stopped email service got an answer other than "no": the whole send goes on, and
  // anything the service said now (a quota, slow down) is handled below like any other batch.
  if (probing && !halt && outcomes.length) {
    await resumeSend(db, ctx.queue, broadcastId, now);
    ctx.log?.('the email service accepts mail again; send resumed', { broadcastId });
  }

  // The email service stopped accepting mail (a suspended account, refused credentials, an
  // unverified domain): pause, and try again by itself with one email, less often as time goes
  // on (send-waits.ts). Everyone unsent stays pending.
  if (halt) {
    // A stop already recorded keeps its start and its next try (set before this one was sent).
    await pauseFor(
      ctx,
      broadcast,
      waiting,
      { reason: 'service_stopped', until: now + SERVICE_STOPPED_RETRY.firstMs, detail: halt.error },
      now,
    );
    // Still stopped after a try: the send report shows what the service said this time.
    if (probing) {
      await run(
        db,
        `UPDATE broadcasts SET wait_detail = ?1 WHERE id = ?2 AND waiting_for = 'service_stopped'`,
        halt.error,
        broadcastId,
      );
    }
    ctx.log?.('broadcast paused: the mail provider stopped accepting mail', {
      broadcastId,
      error: halt.error,
      retry: probing,
    });
    return;
  }
  // The email service's own quota, or this Swarm's limit for the window, is used up.
  const service = quota
    ? {
        reason: `service_${quota.quota}` as const,
        until: quotaResetsAt(quota.quota, now),
        detail: quota.error,
      }
    : null;
  if (quota && pacer) {
    await pacer.block(quota.quota, service!.until).catch(() => undefined);
  }
  const window =
    held && held.turn.limit && held.turn.limit !== 'second' && held.turn.resetsAt
      ? { reason: held.turn.limit, until: held.turn.resetsAt, detail: null }
      : null;
  const longest = [service, window]
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .sort((a, b) => b.until - a.until)[0];
  if (longest) {
    ctx.log?.('broadcast waiting for a sending limit', {
      broadcastId,
      reason: longest.reason,
      until: longest.until,
    });
    if (isPausing(longest.reason)) {
      await pauseFor(ctx, broadcast, waiting, longest, now);
      return;
    }
    await startWait(db, broadcastId, longest, now);
    if (waiting.length) {
      await ctx.queue.send(
        { type: 'batch', broadcastId, memberIds: waiting.map((r) => r.member_id) },
        { delaySeconds: waitDelaySeconds(longest.until, now) },
      );
    }
    return;
  }

  if (retries.length) {
    // Honour the provider's Retry-After when it asks for longer than the default.
    const asked = Math.max(0, ...retries.map((o) => o.retryAfterSeconds ?? 0));
    // The first few times, the queue's own retry; a message already passed on for throttling
    // goes straight to the next one.
    if (attempts < QUEUE_RETRIES && !message.throttled) {
      throw new RetryLater(
        `${retries.length} messages need a retry: ${retries[0]!.error}`,
        Math.min(600, Math.max(RETRY_DELAY_SECONDS, Math.ceil(asked))),
      );
    }
    // Throttled for a while: a new message with a growing delay, never the dead-letter queue.
    const throttled = (message.throttled ?? 0) + attempts;
    const delaySeconds = Math.min(
      43_200,
      Math.max(
        Math.min(
          MAX_THROTTLE_DELAY_SECONDS,
          RETRY_DELAY_SECONDS * 2 ** (throttled - QUEUE_RETRIES),
        ),
        Math.ceil(asked),
        held?.turn.retryAfterSeconds ?? 0,
      ),
    );
    await run(
      db,
      'UPDATE broadcasts SET resume_at = max(ifnull(resume_at, 0), ?1) WHERE id = ?2',
      now + delaySeconds * 1000,
      broadcastId,
    );
    await ctx.queue.send(
      { type: 'batch', broadcastId, memberIds: waiting.map((r) => r.member_id), throttled },
      { delaySeconds },
    );
    ctx.log?.('throttled batch back on the queue', { broadcastId, throttled, delaySeconds });
    return;
  }
  if (held) {
    // Over the per-second limit: back to the queue on a new message, because a queue retry would
    // count against max_retries and a long line would send people to the dead-letter queue. The
    // reaper leaves the Broadcast alone until it's due.
    const delaySeconds = Math.max(
      1,
      Math.min(MAX_QUEUE_DELAY_SECONDS, held.turn.retryAfterSeconds),
    );
    // Held for its workspace's share of the install (others sending, or admitted in parts): the
    // send report says it is waiting for capacity, and when it asks again.
    await run(
      db,
      held.turn.share
        ? `UPDATE broadcasts SET resume_at = max(ifnull(resume_at, 0), ?1),
                  share_wait_since = coalesce(share_wait_since, ?3), share_wait_until = ?1
            WHERE id = ?2`
        : 'UPDATE broadcasts SET resume_at = max(ifnull(resume_at, 0), ?1) WHERE id = ?2',
      now + delaySeconds * 1000,
      broadcastId,
      ...(held.turn.share ? [now] : []),
    );
    await ctx.queue.send(
      { type: 'batch', broadcastId, memberIds: held.recipients.map((r) => r.member_id) },
      { delaySeconds },
    );
    return;
  }
  await maybeComplete(ctx, broadcastId);
}

/**
 * Pauses a send for a monthly limit or quota, or for an email service that stopped accepting
 * mail. Recipients this batch put back give their warm-up capacity back (the resume reserves
 * again), and the owners hear about it once.
 */
async function pauseFor(
  ctx: PipelineContext,
  broadcast: BroadcastRow,
  putBack: Claimed[],
  wait: { reason: SendWaitReason; until: number | null; detail: string | null },
  now: number,
): Promise<void> {
  const started = await startWait(ctx.db, broadcast.id, wait, now);
  await giveBack(
    ctx.db,
    broadcast,
    putBack.map((r) => r.member_id),
    now,
  );
  if (started) await ctx.queue.send({ type: 'wait_notice', broadcastId: broadcast.id });
}

/** Marks the Broadcast finished once the snapshot and fan-out are done and nothing is in flight. */
export async function maybeComplete(ctx: PipelineContext, broadcastId: string): Promise<void> {
  const { db } = ctx;
  const broadcast = await loadForStep(ctx, broadcastId);
  // A Flow Broadcast stays open while its Flow version can send; the Flows engine closes it.
  if (!live(broadcast) || broadcast.kind === 'flow') return;
  if (!broadcast.snapshot_done || !broadcast.fanout_done) return;
  const open = await first(
    db,
    `SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ?1 AND status IN ('pending', 'sending') LIMIT 1`,
    broadcastId,
  );
  if (open) return;
  const now = clock(ctx);
  const done = await first<{ status: string }>(
    db,
    `UPDATE broadcasts
        SET status = CASE WHEN failed_count = 0 THEN 'sent' WHEN sent_count = 0 THEN 'failed' ELSE 'partially_failed' END,
            completed_at = ?1, last_progress_at = ?1
      WHERE id = ?2 AND status = 'sending'
      RETURNING status`,
    now,
    broadcastId,
  );
  if (!done) return;
  const dispatch = await settleDispatch(db, broadcast.dispatch_id, now);
  // Event Webhooks (Phase 7): only the call that completed the Broadcast gets here.
  const completed = await loadBroadcast(db, broadcastId);
  await db.batch([
    ...(dispatch?.status === 'sent'
      ? [
          platformEventStatement(
            db,
            {
              type: 'dispatch.sent',
              workspaceId: broadcast.workspace_id,
              channelId: broadcast.channel_id,
              payload: toDispatchSummary({ ...dispatch, latest_broadcast_id: broadcastId }),
            },
            now,
          ),
        ]
      : []),
    platformEventStatement(
      db,
      {
        type: 'broadcast.completed',
        workspaceId: broadcast.workspace_id,
        channelId: broadcast.channel_id,
        payload: {
          broadcast: toBroadcast(completed as BroadcastRow),
          stats: await broadcastStats(db, broadcastId),
        },
      },
      now,
    ),
  ]);
  ctx.log?.('broadcast complete', { broadcastId, status: done.status });
}

/** A Dispatch whose send reached nobody goes back to draft, so it can be fixed and sent again. */
async function settleDispatch(
  db: D1Database,
  dispatchId: string,
  now: number,
): Promise<DispatchRow | null> {
  return first<DispatchRow>(
    db,
    `UPDATE dispatches
        SET status = CASE WHEN (SELECT sent_count FROM broadcasts WHERE dispatch_id = ?2 ORDER BY created_at DESC LIMIT 1) > 0
                          THEN 'sent' ELSE 'draft' END,
            sent_at = coalesce(sent_at, ?1), updated_at = ?1
      WHERE id = ?2 AND status = 'sending' RETURNING *`,
    now,
    dispatchId,
  );
}

/**
 * Minute cron: tries again each send the email service stopped (service_stopped, send-waits.ts)
 * whose next try has come. One pending recipient goes, as a try (a `probe` batch); when the
 * service answers, the whole send goes on. The next try is set first, as long after as the send
 * has been stopped so far (SERVICE_STOPPED_RETRY: from 5 minutes, doubling, at most 6 hours
 * apart), so a second cron run or a lost message only waits for it. Past giveUpMs from the stop,
 * the send ends instead (endStoppedSend). A stop recorded before these tries (resume_at NULL) is
 * due at once. Returns the ids it touched.
 */
export async function retryStoppedSends(ctx: PipelineContext, now: number): Promise<string[]> {
  const { db } = ctx;
  const due = await all<{
    id: string;
    kind: BroadcastRow['kind'];
    ramp_id: string | null;
    waiting_since: number | null;
    resume_at: number | null;
  }>(
    db,
    `SELECT id, kind, ramp_id, waiting_since, resume_at FROM broadcasts
      WHERE waiting_for = 'service_stopped' AND status IN ('queued', 'sending')
        AND (resume_at IS NULL OR resume_at <= ?1)
      ORDER BY resume_at LIMIT 20`,
    now,
  );
  const touched: string[] = [];
  const today = utcDay(now);
  for (const row of due) {
    const since = row.waiting_since ?? now;
    if (now - since >= SERVICE_STOPPED_RETRY.giveUpMs) {
      if (await endStoppedSend(ctx, row.id, now)) touched.push(row.id);
      continue;
    }
    const wait = Math.min(
      SERVICE_STOPPED_RETRY.maxMs,
      Math.max(SERVICE_STOPPED_RETRY.firstMs, now - since),
    );
    const next = Math.min(since + SERVICE_STOPPED_RETRY.giveUpMs, now + wait);
    const claimed = await first<{ id: string }>(
      db,
      `UPDATE broadcasts SET resume_at = ?1, waiting_since = ?2, last_progress_at = ?3
        WHERE id = ?4 AND waiting_for = 'service_stopped' AND resume_at IS ?5 RETURNING id`,
      next,
      since,
      now,
      row.id,
      row.resume_at,
    );
    if (!claimed) continue;
    touched.push(row.id);
    // Engaged readers first, as warm-up sends them.
    const probe = await first<{ member_id: string; reserved_on: string | null }>(
      db,
      `SELECT member_id, reserved_on FROM broadcast_recipients
        WHERE broadcast_id = ?1 AND status = 'pending' AND held = 0
        ORDER BY CASE send_tier WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 2 END, member_id LIMIT 1`,
      row.id,
    );
    if (!probe) {
      // Nobody to try with: the send goes on without the wait (a post's send completes; an
      // automation email's next subscriber tries the service).
      await resumeSend(db, ctx.queue, row.id, now);
      continue;
    }
    if (row.ramp_id && row.kind === 'broadcast' && probe.reserved_on !== today) {
      // The try counts against warm-up like any email; with no room today it waits for the next.
      const { granted } = await reserve(db, row.ramp_id, 1, now);
      if (!granted) continue;
      await run(
        db,
        'UPDATE broadcast_recipients SET reserved_on = ?1 WHERE broadcast_id = ?2 AND member_id = ?3',
        today,
        row.id,
        probe.member_id,
      );
    }
    await ctx.queue.send({
      type: 'batch',
      broadcastId: row.id,
      memberIds: [probe.member_id],
      probe: true,
    });
  }
  if (touched.length) ctx.log?.('stopped sends tried again', { broadcasts: touched.length });
  return touched;
}

/**
 * Ends a send the email service refused mail for SERVICE_STOPPED_RETRY.giveUpMs, in one
 * transaction. Everyone still waiting is recorded as failed (not sent), and the warm-up capacity
 * they held for today goes back. A post's send is then failed, or partially failed if some went,
 * and its Dispatch settles (back to draft when nobody got it). An automation email's standing send
 * stays open, without the wait, for the next subscribers who reach it: what waits on it never
 * grows past one stop's worth. The owners hear about it. Returns whether it ended the send.
 */
async function endStoppedSend(
  ctx: PipelineContext,
  broadcastId: string,
  now: number,
): Promise<boolean> {
  const { db } = ctx;
  const broadcast = await loadBroadcast(db, broadcastId);
  if (!live(broadcast) || broadcast.waiting_for !== 'service_stopped') return false;
  const open = `broadcast_id = ?1 AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?2))
    AND (SELECT waiting_for FROM broadcasts WHERE id = ?1) = 'service_stopped'`;
  const stale = now - CLAIM_TIMEOUT_MS;
  const days = SERVICE_STOPPED_RETRY.giveUpMs / 86_400_000;
  const reason = `The email service stopped accepting mail and still refused it after ${days} days${
    broadcast.wait_detail ? ` (${broadcast.wait_detail})` : ''
  }.`;
  const [held, failed, ended] = await db.batch([
    db
      .prepare(`SELECT count(*) AS n FROM broadcast_recipients WHERE ${open} AND reserved_on = ?3`)
      .bind(broadcastId, stale, utcDay(now)),
    db
      .prepare(
        `UPDATE broadcast_recipients SET status = 'failed', reserved_on = NULL WHERE ${open}`,
      )
      .bind(broadcastId, stale),
    db
      .prepare(
        `UPDATE broadcasts
            SET failed_count = (SELECT count(*) FROM broadcast_recipients
                                 WHERE broadcast_id = ?1 AND status = 'failed'),
                waiting_for = NULL, waiting_since = NULL, wait_detail = NULL, resume_at = NULL,
                last_progress_at = ?2,
                status = CASE WHEN kind = 'flow' THEN status
                              WHEN sent_count = 0 THEN 'failed' ELSE 'partially_failed' END,
                failure_reason = CASE WHEN kind = 'flow' THEN failure_reason ELSE ?3 END,
                completed_at = CASE WHEN kind = 'flow' THEN completed_at ELSE ?2 END,
                fanout_done = CASE WHEN kind = 'flow' THEN fanout_done ELSE 1 END
          WHERE id = ?1 AND waiting_for = 'service_stopped' AND status IN ('queued', 'sending')
          RETURNING id`,
      )
      .bind(broadcastId, now, reason.slice(0, 500)),
  ]);
  if (!ended?.results.length) return false;
  const notSent = failed?.meta.changes ?? 0;
  const reserved = (held?.results[0] as { n: number } | undefined)?.n ?? 0;
  if (broadcast.ramp_id && reserved) await release(db, broadcast.ramp_id, reserved);
  if (broadcast.kind === 'broadcast') await settleDispatch(db, broadcast.dispatch_id, now);
  await ctx.queue.send({ type: 'wait_notice', broadcastId, ended: { notSent } });
  ctx.log?.('send ended: the email service refused mail too long', { broadcastId, notSent });
  return true;
}

/**
 * Resumes Broadcasts that made no progress for STUCK_AFTER_MS (a lost message, a crashed
 * consumer), paused sends whose resume_at has come, and tries stopped email services again
 * (send-waits.ts). Runs from cron. Returns the ids it touched. Flow Broadcasts are left to the
 * Flows sweep (their recipients arrive one run at a time, so "no progress" is normal), apart from
 * resuming a pause. A paused send is not stuck: it has nothing in flight on purpose.
 */
export async function reap(ctx: PipelineContext): Promise<string[]> {
  const { db } = ctx;
  const now = clock(ctx);
  const resumed = [
    ...(await resumeDueSends(db, ctx.queue, now)),
    ...(await retryStoppedSends(ctx, now)),
  ];
  if (resumed.length) ctx.log?.('paused sends resumed', { broadcasts: resumed.length });
  const stuck = await all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts
      WHERE status IN ('queued', 'sending') AND kind = 'broadcast'
        AND last_progress_at < ?1 AND (resume_at IS NULL OR resume_at < ?1)
        AND (waiting_for IS NULL OR NOT ${PAUSED_SQL})
      ORDER BY last_progress_at LIMIT 20`,
    now - STUCK_AFTER_MS,
  );
  for (const broadcast of stuck) {
    await run(db, 'UPDATE broadcasts SET last_progress_at = ?1 WHERE id = ?2', now, broadcast.id);
    if (!broadcast.snapshot_done) {
      await ctx.queue.send({ type: 'snapshot', broadcastId: broadcast.id });
      continue;
    }
    // Abandoned claims go back to pending, then every pending recipient up to the fan-out
    // cursor is handed out again. Recipients after the cursor belong to the fan-out walk.
    await run(
      db,
      `UPDATE broadcast_recipients SET status = 'pending', claimed_at = NULL
        WHERE broadcast_id = ?1 AND status = 'sending' AND claimed_at < ?2`,
      broadcast.id,
      now - CLAIM_TIMEOUT_MS,
    );
    const orphaned = await all<{ member_id: string }>(
      db,
      `SELECT member_id FROM broadcast_recipients
        WHERE broadcast_id = ?1 AND status = 'pending' AND held = 0 AND ${passedSql(broadcast.fanout_tier)}
        ORDER BY member_id LIMIT 1000`,
      broadcast.id,
      broadcast.fanout_cursor ?? '',
    );
    const batches: { body: SendMessage }[] = [];
    for (let i = 0; i < orphaned.length; i += BATCH_SIZE) {
      batches.push({
        body: {
          type: 'batch',
          broadcastId: broadcast.id,
          memberIds: orphaned.slice(i, i + BATCH_SIZE).map((r) => r.member_id),
        },
      });
    }
    for (let i = 0; i < batches.length; i += 100)
      await ctx.queue.sendBatch(batches.slice(i, i + 100));
    if (!broadcast.fanout_done) await ctx.queue.send({ type: 'fanout', broadcastId: broadcast.id });
    else if (orphaned.length === 0) await maybeComplete(ctx, broadcast.id);
    ctx.log?.('reaper resumed broadcast', { broadcastId: broadcast.id, requeued: orphaned.length });
  }
  return [...resumed, ...stuck.map((b) => b.id)];
}

/**
 * Emails a paused send's owners, admins and creator (send-waits.ts), or, with `ended`, tells them
 * the send ended because the email service refused mail for too long. Best effort: when the email
 * service refuses all mail this fails too, and the send report and Home say it instead.
 */
async function notifyWaiting(
  ctx: PipelineContext,
  broadcastId: string,
  ended?: { notSent: number },
): Promise<void> {
  const notice = ended
    ? await endedNotice(ctx.db, broadcastId, ended.notSent)
    : await waitNotice(ctx.db, broadcastId, clock(ctx));
  if (!notice) return;
  const mail = ctx.notices ?? ctx.mail;
  let notified = 0;
  for (const to of notice.to) {
    try {
      await mail.send({
        category: 'operator',
        from: { name: 'Swarm', address: `notifications@${ctx.config.platformMailDomain}` },
        to,
        subject: notice.subject,
        html: notice.html,
        text: notice.text,
        tags: { broadcast: broadcastId },
      });
      notified++;
    } catch (error) {
      ctx.log?.('paused send notice not sent', {
        broadcastId,
        error: (error as Error).message,
      });
    }
  }
  ctx.log?.('send paused; operators notified', { broadcastId, notified });
}

/** Emails the operators that a Cohort Sample halted a Broadcast (holdback.ts). */
async function notifyCohortHalted(ctx: PipelineContext, broadcastId: string): Promise<void> {
  const notice = await cohortHaltNotice(ctx.db, broadcastId);
  if (!notice) return;
  for (const to of notice.to) {
    await (ctx.notices ?? ctx.mail).send({
      category: 'operator',
      from: { name: 'Swarm', address: `notifications@${ctx.config.platformMailDomain}` },
      to,
      subject: notice.subject,
      html: notice.html,
      text: notice.text,
      tags: { broadcast: broadcastId },
    });
  }
  ctx.log?.('cohort sample halted; operators notified', {
    broadcastId,
    notified: notice.to.length,
  });
}
