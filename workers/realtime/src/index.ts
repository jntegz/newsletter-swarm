// Durable Objects: the live send monitor (Phase 2), sliding-window rate limiters (Phase 3), the
// public API's token buckets (Phase 7) and the install's send pacer, which holds the sending
// limits. Editor rooms (Phase 2b) join here.
import type { BroadcastProgress } from '@swarm/domain';
import {
  LIMIT_WINDOWS,
  SEND_ADMISSION_RELEASE,
  SEND_ADMISSION_SHARE,
  SEND_LINE_ACTIVE_MS,
  SEND_WORKSPACE_ACTIVE_MS,
  SEND_WORKSPACE_RETRY_SECONDS,
  WINDOW_LIMIT_KEY,
  bulkAllowance,
  effectivePerSecond,
  windowEnd,
  windowStart,
  type LimitReason,
  type LimitTurn,
  type LimitValues,
  type LimitWindow,
  type LimiterUsage,
  type TurnRequest,
  type WindowUsage,
} from '@swarm/domain/limit-windows';
import { BaseEnvSchema, defineEnv, useRuntime, type RuntimeVariables } from '@swarm/runtime';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

const parseEnv = defineEnv(BaseEnvSchema);

const app = new Hono<{ Variables: RuntimeVariables }>();
useRuntime(app, { service: 'realtime', parseEnv });

const FINISHED = new Set(['sent', 'partially_failed', 'canceled', 'failed']);
/** How long a finished Broadcast's last state is kept for late viewers. */
const KEEP_FINISHED_MS = 86_400_000;
/**
 * (Not exported: every named export of a Worker's entry module is taken as an entrypoint.)
 * A socket's authority was checked once, when the api worker forwarded it (Origin, session and a
 * viewer role on the Broadcast's Channel). It holds that authority this long at most, finished
 * Broadcast or not: then it is closed with SOCKET_RECHECK_CODE and the dashboard reconnects
 * through the api worker, which checks again. A lost seat or revoked session therefore ends
 * delivery within this bound (docs/security.md).
 */
const SOCKET_MAX_AGE_MS = 5 * 60_000;
const SOCKET_RECHECK_CODE = 4001;

interface SocketMeta {
  openedAt: number;
}

const openedAt = (socket: WebSocket): number =>
  (socket.deserializeAttachment() as SocketMeta | null)?.openedAt ?? 0;

/**
 * One per Broadcast (named by its id). It has no auth of its own: only workers with the binding
 * reach it, and the api worker checks the operator's access before forwarding a socket.
 */
export class SendMonitor extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ openedAt: Date.now() } satisfies SocketMeta);
    const latest = await this.ctx.storage.get<BroadcastProgress>('latest');
    if (latest) server.send(JSON.stringify(latest));
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Stores and fans out a progress update. Older updates arriving late are ignored. */
  async publish(progress: BroadcastProgress): Promise<void> {
    const latest = await this.ctx.storage.get<BroadcastProgress>('latest');
    if (latest && latest.at > progress.at) return;
    await this.ctx.storage.put('latest', progress);
    const message = JSON.stringify(progress);
    for (const socket of this.liveSockets(Date.now())) {
      try {
        socket.send(message);
      } catch {
        // A socket that closed mid-send is cleaned up by the runtime.
      }
    }
    // Keep the last state for a day after the Broadcast ends, then forget it.
    if (FINISHED.has(progress.status)) {
      await this.ctx.storage.put('finishedAt', Date.now());
      await this.scheduleAlarm();
    }
  }

  /** Sockets still inside SOCKET_MAX_AGE_MS; older ones are closed for a fresh check. */
  private liveSockets(now: number): WebSocket[] {
    const live: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (now - openedAt(socket) < SOCKET_MAX_AGE_MS) {
        live.push(socket);
        continue;
      }
      try {
        socket.close(SOCKET_RECHECK_CODE, 'Reconnect to check access');
      } catch {
        // Already closing.
      }
    }
    return live;
  }

  /** The next time a socket's bound runs out, or a finished Broadcast's state is forgotten. */
  private async scheduleAlarm(): Promise<void> {
    const finishedAt = await this.ctx.storage.get<number>('finishedAt');
    const times = this.ctx.getWebSockets().map((socket) => openedAt(socket) + SOCKET_MAX_AGE_MS);
    if (finishedAt !== undefined) times.push(finishedAt + KEEP_FINISHED_MS);
    if (!times.length) return;
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const finishedAt = await this.ctx.storage.get<number>('finishedAt');
    if (finishedAt !== undefined && now >= finishedAt + KEEP_FINISHED_MS) {
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Broadcast finished');
      await this.ctx.storage.deleteAll();
      return;
    }
    this.liveSockets(now);
    await this.scheduleAlarm();
  }

  // The dashboard never sends anything; a message is a misbehaving client.
  override webSocketMessage(socket: WebSocket): void {
    socket.close(1008, 'This socket is receive-only');
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    // 1005 (no status), 1006 (dropped, e.g. a closed tab) and 1015 (TLS) are reported to us but
    // can't be sent; close() throws on them, so answer those with a normal closure.
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, 'Closing');
  }
}

interface RateLimitResult {
  allowed: boolean;
  /** Estimated hits left in the window after this one. */
  remaining: number;
  /** When `allowed` is false: seconds until a hit would be allowed again. */
  retryAfterSeconds: number;
}

interface WindowState {
  /** Start of the current fixed window, in ms. */
  start: number;
  current: number;
  previous: number;
}

/**
 * A sliding-window rate limiter, one object per key (named by the caller, e.g. "sub:ip:<ip>").
 * It keeps counts for the current and previous fixed windows and weighs the previous one by how
 * much of it still overlaps the sliding window: the standard approximation, accurate to within a
 * few percent and constant in memory. Refused hits are not counted, so a client that keeps
 * hammering is let back in once the window slides past its earlier hits.
 */
export class RateLimiter extends DurableObject {
  private state: WindowState | null = null;

  async hit(limit: number, windowMs: number, now: number = Date.now()): Promise<RateLimitResult> {
    if (!(limit > 0) || !(windowMs > 0)) throw new Error('limit and windowMs must be positive');
    let state = this.state ?? (await this.ctx.storage.get<WindowState>('w')) ?? null;
    const start = now - (now % windowMs);
    if (!state || start - state.start >= 2 * windowMs) {
      state = { start, current: 0, previous: 0 };
    } else if (start !== state.start) {
      state = { start, current: 0, previous: state.current };
    }
    const overlap = 1 - (now - start) / windowMs;
    const estimate = state.previous * overlap + state.current;
    if (estimate + 1 > limit) {
      // The earliest moment the weighted previous window has decayed enough for one more hit.
      const needed = state.previous > 0 ? (estimate + 1 - limit) / state.previous : 1;
      const wait = state.current + 1 > limit ? start + windowMs - now : needed * windowMs;
      this.state = state;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.min(wait, start + windowMs - now) / 1000)),
      };
    }
    state.current += 1;
    this.state = state;
    await this.ctx.storage.put('w', state);
    // Forget the key once two windows pass without a hit.
    await this.ctx.storage.setAlarm(start + 2 * windowMs);
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - estimate - 1)),
      retryAfterSeconds: 0,
    };
  }

  override async alarm(): Promise<void> {
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}

interface ApiRateResult {
  allowed: boolean;
  /** The bucket size (RateLimit-Limit). */
  limit: number;
  /** Whole tokens left after this request (RateLimit-Remaining). */
  remaining: number;
  /** Seconds until the bucket is full again (RateLimit-Reset). */
  resetSeconds: number;
  /** When refused: seconds until one token is back (Retry-After). */
  retryAfterSeconds: number;
}

interface BucketState {
  tokens: number;
  /** When `tokens` was last brought up to date, in ms. */
  at: number;
}

/**
 * The /v2 token bucket (Phase 7), one object per API principal (named "v2:<kind>:<id>" by the api
 * worker). It holds `capacity` tokens and refills `perMinute` a minute, continuously; each
 * request takes one. The policy (plan rate, key cap, burst) is decided by the caller on every
 * request, so a plan change applies at once: a smaller bucket is clamped to its new size.
 * Refused requests take nothing.
 */
export class ApiRateLimiter extends DurableObject {
  private state: BucketState | null = null;

  async take(
    perMinute: number,
    capacity: number,
    now: number = Date.now(),
  ): Promise<ApiRateResult> {
    if (!(perMinute > 0) || !(capacity >= 1))
      throw new Error('perMinute and capacity must be positive');
    const perMs = perMinute / 60_000;
    const saved = this.state ?? (await this.ctx.storage.get<BucketState>('b')) ?? null;
    const elapsed = saved ? Math.max(0, now - saved.at) : 0;
    const tokens = saved ? Math.min(capacity, saved.tokens + elapsed * perMs) : capacity;
    const fullIn = (left: number) => Math.ceil((capacity - left) / perMs / 1000);
    if (tokens < 1) {
      this.state = { tokens, at: now };
      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetSeconds: fullIn(tokens),
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)),
      };
    }
    const left = tokens - 1;
    this.state = { tokens: left, at: now };
    await this.ctx.storage.put('b', this.state);
    // Forget the principal once its bucket would be full again.
    await this.ctx.storage.setAlarm(now + Math.max(1, fullIn(left)) * 1000);
    return {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(left),
      resetSeconds: fullIn(left),
      retryAfterSeconds: 0,
    };
  }

  override async alarm(): Promise<void> {
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}

interface PacerTurn {
  /** Sends this turn may make: all that were asked for, or 0 when the line is too long. */
  granted: number;
  /** How long to wait before making them. */
  startInMs: number;
  /** When nothing was granted: how long before asking again is worthwhile. */
  retryAfterSeconds: number;
}

/**
 * A bulk turn can be up to this far ahead. Past it, the caller goes back to the queue. Kept short
 * because mail someone is waiting for takes its place after the turns already handed out: this is
 * how long a sign-in link can wait behind a big send (plus that send's last turn).
 */
const PACER_MAX_LEAD_MS = 2_000;
/** Mail someone is waiting for may wait this long in the line before it is refused. */
const PACER_URGENT_WAIT_MS = 10_000;
/** Cloudflare Queues' longest delay. */
const PACER_MAX_RETRY_SECONDS = 43_200;

interface WindowCount {
  /** Start of the window the count belongs to, in ms. */
  start: number;
  used: number;
}

interface PacerState {
  hour: WindowCount;
  day: WindowCount;
  month: WindowCount;
  /** The email service said its own quota is used up: bulk mail waits until `until`. */
  service: { window: 'day' | 'month'; until: number } | null;
  /** MAIL_MAX_PER_SECOND as the send worker last reported it. */
  ceiling: number | null;
  /**
   * The most recently saved limits any caller brought (TurnRequest.limitsSavedAt). Absent in
   * state stored before it existed.
   */
  limits?: { values: LimitValues; savedAt: number } | null;
  /**
   * Bulk use per workspace in the current hour, day and month, and when each last asked for a
   * bulk turn (TurnRequest.workspaceId). Absent in state stored before it existed.
   */
  workspaces?: Record<string, WorkspaceUse>;
}

const freshCount = (window: LimitWindow, now: number): WindowCount => ({
  start: windowStart(window, now),
  used: 0,
});

interface WorkspaceUse {
  lastAsked: number;
  hour: WindowCount;
  day: WindowCount;
  month: WindowCount;
}

/** Workspaces remembered at most; the ones that asked longest ago go first. */
const MAX_TRACKED_WORKSPACES = 500;

/**
 * The install's sending limits (docs/architecture.md "Pacing"). The email service is shared, so
 * one object (named "install") holds the line for every email: posts, automation emails, Direct
 * Sends and the mail people wait for. Callers pass the stored limits on every turn, with when they
 * were saved; the object applies the most recently saved ones it has been given (saving them in
 * Settings tells it at once), so a worker's cached copy can't undo a change.
 *
 * - Per second: one line for every email. A turn reserves count / rate seconds of it, so turns
 *   never overlap and the rate holds for all mail together. Bulk turns more than 2 s ahead are
 *   sent back to the queue. Mail someone waits for takes the next place after the turns already
 *   handed out, ahead of every bulk turn not handed out yet, so it waits a few seconds at most.
 * - Per UTC hour, day and month: counts that survive eviction (SQLite storage, written in the
 *   same synchronous step as the decision). Bulk mail may use all but a tenth of each limit.
 * - The email service's own quota: after it said a daily or monthly quota is used up, bulk turns
 *   (and turns of callers that can come back later) are refused until it resets, so one send
 *   finding out stops the others asking.
 *
 * Every method runs with no await, so each one runs alone. The per-second line is kept in memory:
 * when the object is evicted it has been idle long enough that the line is empty anyway.
 */
export class SendPacer extends DurableObject {
  /** The end of every turn handed out so far, bulk and transactional. */
  private nextFree = 0;
  private lineEnd = 0;
  private state: PacerState | null = null;
  /**
   * Each workspace's own place in the per-second line while others are in it too: the earliest
   * its next bulk turn may start, and when it last asked (SEND_LINE_ACTIVE_MS). In memory, like
   * the line itself.
   */
  private lanes = new Map<string, { next: number; asked: number }>();

  /** This workspace's lane, and how many workspaces are in the line now (itself included). */
  private lane(workspaceId: string, now: number) {
    for (const [id, entry] of this.lanes) {
      if (entry.asked <= now - SEND_LINE_ACTIVE_MS) this.lanes.delete(id);
    }
    const entry = this.lanes.get(workspaceId) ?? { next: 0, asked: now };
    entry.asked = now;
    this.lanes.set(workspaceId, entry);
    return { entry, inLine: this.lanes.size };
  }

  /** The stored counts, with any window that has ended started again from zero. */
  private load(now: number): PacerState {
    const state = this.state ??
      this.ctx.storage.kv.get<PacerState>('limits') ?? {
        hour: freshCount('hour', now),
        day: freshCount('day', now),
        month: freshCount('month', now),
        service: null,
        ceiling: null,
      };
    for (const window of LIMIT_WINDOWS) {
      if (state[window].start !== windowStart(window, now)) state[window] = freshCount(window, now);
    }
    if (state.service && state.service.until <= now) state.service = null;
    this.state = state;
    return state;
  }

  private save(state: PacerState): void {
    this.ctx.storage.kv.put('limits', state);
  }

  /** A workspace's bulk use this hour, day and month, marked as asking now. */
  private workspaceUse(state: PacerState, workspaceId: string, now: number): WorkspaceUse {
    const all = (state.workspaces ??= {});
    const use = (all[workspaceId] ??= {
      lastAsked: now,
      hour: freshCount('hour', now),
      day: freshCount('day', now),
      month: freshCount('month', now),
    });
    use.lastAsked = now;
    for (const window of LIMIT_WINDOWS) {
      if (use[window].start !== windowStart(window, now)) use[window] = freshCount(window, now);
    }
    const ids = Object.keys(all);
    if (ids.length > MAX_TRACKED_WORKSPACES) {
      ids.sort((a, b) => all[a]!.lastAsked - all[b]!.lastAsked);
      for (const id of ids.slice(0, ids.length - MAX_TRACKED_WORKSPACES)) delete all[id];
    }
    return use;
  }

  /** One turn for `count` emails. See LimitTurn in @swarm/domain/limit-windows. */
  turn(request: TurnRequest): LimitTurn {
    const now = request.now ?? Date.now();
    const { count, priority } = request;
    if (!(count >= 0) || !Number.isInteger(count)) throw new Error('count must be a whole number');
    const state = this.load(now);
    let changed = false;
    if (request.ceiling !== undefined && request.ceiling !== state.ceiling) {
      state.ceiling = request.ceiling;
      changed = true;
    }
    // The newest saved limits win: a turn bringing older ones (a worker's cache from before a
    // change) gets the newer ones instead. Without a date (take()), its own limits apply.
    let limits = request.limits;
    if (request.limitsSavedAt !== undefined) {
      const known = state.limits ?? null;
      if (!known || request.limitsSavedAt >= known.savedAt) {
        if (!known || request.limitsSavedAt > known.savedAt) changed = true;
        state.limits = { values: request.limits, savedAt: request.limitsSavedAt };
      } else {
        limits = known.values;
      }
    }
    const refuse = (limit: LimitReason, resetsAt: number | null, retryAfterSeconds: number) => {
      if (changed) this.save(state);
      return { granted: 0, startInMs: 0, retryAfterSeconds, limit, resetsAt };
    };
    const secondsUntil = (at: number) => Math.max(1, Math.ceil((at - now) / 1000));

    if ((priority === 'bulk' || request.canWait) && state.service) {
      const { window, until } = state.service;
      return refuse(`service_${window}`, until, secondsUntil(until));
    }

    // The windows: grant what is left in the tightest, and say which one holds back the rest
    // (the one that resets last, since the rest can't go before it does).
    let granted = count;
    // A turn for 0 asks whether one more email could go.
    const wanted = Math.max(1, count);
    let held: { window: LimitWindow; resetsAt: number } | null = null;
    for (const window of LIMIT_WINDOWS) {
      const limit = limits[WINDOW_LIMIT_KEY[window]];
      if (limit === null) continue;
      const allowed = priority === 'bulk' ? bulkAllowance(limit) : limit;
      const left = Math.max(0, allowed - state[window].used);
      granted = Math.min(granted, left);
      const resetsAt = windowEnd(window, now);
      if (left < wanted && (!held || resetsAt > held.resetsAt)) held = { window, resetsAt };
    }
    if (granted === 0 && held) {
      return refuse(held.window, held.resetsAt, secondsUntil(held.resetsAt));
    }

    // A workspace's share: while others send bulk mail too, an equal part of each window.
    const use =
      priority === 'bulk' && request.workspaceId
        ? this.workspaceUse(state, request.workspaceId, now)
        : null;
    const heldForShare = (retryAfterSeconds: number) => {
      // Not a window reset: the others may finish first, so it asks again soon.
      this.save(state);
      return {
        granted: 0,
        startInMs: 0,
        retryAfterSeconds,
        limit: 'second' as const,
        resetsAt: null,
        share: true,
      };
    };
    if (use && count > 0) {
      const sending = Object.values(state.workspaces ?? {}).filter(
        (w) => w.lastAsked > now - SEND_WORKSPACE_ACTIVE_MS,
      ).length;
      // Admission in parts on an install with several workspaces: at most a share of what is
      // left for this workspace of the hour and the day, until the window's last part releases
      // the rest (security review S04-P3-TR-send-workspace-share).
      if (request.sharedInstall) {
        let admitted = granted;
        let releaseAt = Infinity;
        for (const window of ['hour', 'day'] as const) {
          const limit = limits[WINDOW_LIMIT_KEY[window]];
          if (limit === null) continue;
          const start = windowStart(window, now);
          const end = windowEnd(window, now);
          const release = end - Math.floor((end - start) * SEND_ADMISSION_RELEASE);
          if (now >= release) continue;
          const others = Math.max(0, state[window].used - use[window].used);
          const cap = Math.floor(SEND_ADMISSION_SHARE * Math.max(0, bulkAllowance(limit) - others));
          const left = Math.max(0, cap - use[window].used);
          if (left < admitted) releaseAt = Math.min(releaseAt, release);
          admitted = Math.min(admitted, left);
        }
        if (admitted === 0) {
          return heldForShare(
            Math.min(
              PACER_MAX_RETRY_SECONDS,
              Math.max(SEND_WORKSPACE_RETRY_SECONDS, secondsUntil(releaseAt)),
            ),
          );
        }
        granted = admitted;
      }
      if (sending > 1) {
        let shareLeft = granted;
        for (const window of LIMIT_WINDOWS) {
          const limit = limits[WINDOW_LIMIT_KEY[window]];
          if (limit === null) continue;
          const share = Math.max(1, Math.floor(bulkAllowance(limit) / sending));
          shareLeft = Math.min(shareLeft, Math.max(0, share - use[window].used));
        }
        if (shareLeft === 0) return heldForShare(SEND_WORKSPACE_RETRY_SECONDS);
        granted = Math.min(granted, shareLeft);
      }
    }

    let startInMs = 0;
    const rate = effectivePerSecond(limits, state.ceiling);
    if (rate && granted > 0) {
      const span = (granted / rate) * 1000;
      // After every turn already handed out: their callers are waiting to send at their times, so
      // starting sooner would put more than the rate through in those seconds.
      const start = Math.max(this.nextFree, now);
      if (priority === 'transactional') {
        if (start - now > PACER_URGENT_WAIT_MS) {
          return refuse('second', null, secondsUntil(start));
        }
        // Bulk turns not handed out yet come after it.
        this.nextFree = start + span;
        startInMs = start - now;
      } else {
        // While other workspaces are in the line too, each gets an equal part of the rate: its
        // turns start no sooner than its own lane allows. Alone, the lane is the line.
        const lane = request.workspaceId ? this.lane(request.workspaceId, now) : null;
        const own = lane && lane.inLine > 1 ? lane.entry.next : 0;
        const at = Math.max(start, own);
        if (at - now > PACER_MAX_LEAD_MS) {
          if (own > start) {
            // Its lane, not the line, is full: back soon, without lengthening everyone's wait.
            if (changed) this.save(state);
            return {
              granted: 0,
              startInMs: 0,
              retryAfterSeconds: Math.min(PACER_MAX_RETRY_SECONDS, Math.ceil((own - now) / 1000)),
              limit: 'second',
              resetsAt: null,
              share: true,
            };
          }
          // Everyone sent away is told a later time than the last, so they don't all come back
          // at once and get sent away again.
          this.lineEnd = Math.max(this.lineEnd, start) + span;
          return refuse(
            'second',
            null,
            Math.min(PACER_MAX_RETRY_SECONDS, Math.ceil((this.lineEnd - now) / 1000)),
          );
        }
        this.nextFree = Math.max(this.nextFree, at + span);
        if (lane) lane.entry.next = at + span * lane.inLine;
        startInMs = at - now;
      }
    }

    if (granted > 0) {
      for (const window of LIMIT_WINDOWS) state[window].used += granted;
      if (use) for (const window of LIMIT_WINDOWS) use[window].used += granted;
      changed = true;
    }
    if (changed || use) this.save(state);
    return {
      granted,
      startInMs,
      retryAfterSeconds: granted < count && held ? secondsUntil(held.resetsAt) : 0,
      limit: granted < count && held ? held.window : null,
      resetsAt: granted < count && held ? held.resetsAt : null,
    };
  }

  /**
   * Gives back what a turn counted for emails that did not go out (a retry, a used-up quota).
   * `takenAt` is when the turn was taken: a window that has ended since keeps its count.
   */
  release(count: number, takenAt: number, now: number = Date.now()): void {
    if (!(count > 0)) return;
    const state = this.load(now);
    for (const window of LIMIT_WINDOWS) {
      if (state[window].start === windowStart(window, takenAt)) {
        state[window].used = Math.max(0, state[window].used - count);
      }
    }
    this.save(state);
  }

  /** The email service said its daily or monthly quota is used up: bulk waits until `until`. */
  block(window: 'day' | 'month', until: number, now: number = Date.now()): void {
    if (!(until > now)) return;
    const state = this.load(now);
    if (!state.service || state.service.until < until) state.service = { window, until };
    this.save(state);
  }

  /** The counts so far against `limits`, for Settings > Instance. Reads only. */
  usage(limits: LimitValues, now: number = Date.now()): LimiterUsage {
    const state = this.load(now);
    const window = (key: LimitWindow): WindowUsage => {
      const limit = limits[WINDOW_LIMIT_KEY[key]];
      return {
        used: state[key].used,
        limit,
        forSends: limit === null ? null : bulkAllowance(limit),
        resetsAt: windowEnd(key, now),
      };
    };
    return {
      hour: window('hour'),
      day: window('day'),
      month: window('month'),
      service: state.service,
      ceiling: state.ceiling,
    };
  }

  /**
   * The first pacer's method, kept for a send worker deployed before sending limits: a bulk turn
   * at `perSecond`, with no other limit.
   */
  take(count: number, perSecond: number, now: number = Date.now()): PacerTurn {
    if (!(count > 0) || !(perSecond > 0)) throw new Error('count and perSecond must be positive');
    const turn = this.turn({
      count,
      priority: 'bulk',
      limits: { perSecond, perHour: null, perDay: null, perMonth: null },
      now,
    });
    return {
      granted: turn.granted,
      startInMs: turn.startInMs,
      retryAfterSeconds: turn.retryAfterSeconds,
    };
  }
}

export default app;
