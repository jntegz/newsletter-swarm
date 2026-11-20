/**
 * Sending limits (docs/self-hosting.md "Sending limits", docs/architecture.md "Pacing"): the
 * stored setting, the client of the realtime worker's SendPacer that every email asks, and the
 * MailAdapter that asks it for each email outside the send pipeline.
 *
 * - The pipeline (pipeline.ts) takes bulk turns for its batches itself, from the provider's own
 *   adapter; everything else (sign-in links, confirmations, receipts, notices) goes through
 *   `mailAdapter` (adapters.ts), which wraps the provider in LimitedMail when the worker has the
 *   SEND_PACER binding. Direct Send asks for its turn before it records the send (api worker).
 * - The pacer is told the limits on every turn with when they were saved, and applies the most
 *   recently saved ones it has been given. Saving them in Settings tells it at once
 *   (shareSendingLimits), so a worker still holding the old ones in its LIMITS_CACHE_MS cache
 *   can't undo the change. When it can't be reached, mail still goes: the pipeline paces its
 *   batches at the per-second rate on its own (quotas then can't be counted), and transactional
 *   mail is sent.
 */
import {
  NO_SENDING_LIMITS,
  windowEnd,
  type LimitTurn,
  type LimiterUsage,
  type MailPriority,
  type SendingLimits,
  type TurnRequest,
} from '@swarm/domain';
import {
  MailProviderError,
  type MailAdapter,
  type OutgoingMail,
  type ProviderQuota,
  type SentMail,
} from '@swarm/mail';
import { first } from './db';

/** The SendPacer's methods as the engine calls them (workers/realtime/src/index.ts). */
export interface MailLimiter {
  turn(request: TurnRequest): Promise<LimitTurn>;
  /** Gives back what a turn taken at `takenAt` counted for emails that did not go out. */
  release(count: number, takenAt: number): Promise<void>;
  /** The email service said its quota is used up: bulk mail waits until `until`. */
  block(window: ProviderQuota, until: number): Promise<void>;
  usage(limits: SendingLimits): Promise<LimiterUsage>;
}

/** How long a caller waits for the pacer before it goes on without it. */
const LIMITER_TIMEOUT_MS = 2_000;

/** The install's one pacer. A failure or a slow answer rejects, and the caller goes on without. */
export function limiterOf(
  namespace: DurableObjectNamespace,
  timeoutMs = LIMITER_TIMEOUT_MS,
): MailLimiter {
  const stub = namespace.get(namespace.idFromName('install')) as unknown as {
    turn(request: TurnRequest): Promise<LimitTurn>;
    release(count: number, takenAt: number): Promise<void>;
    block(window: ProviderQuota, until: number): Promise<void>;
    usage(limits: SendingLimits): Promise<LimiterUsage>;
  };
  const timed = <T>(call: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the send pacer did not answer')), timeoutMs);
    });
    return Promise.race([call(), late]).finally(() => clearTimeout(timer));
  };
  return {
    turn: (request) => timed(() => stub.turn(request)),
    release: (count, takenAt) => timed(() => stub.release(count, takenAt)),
    block: (window, until) => timed(() => stub.block(window, until)),
    usage: (limits) => timed(() => stub.usage(limits)),
  };
}

// ---- The stored setting (sending_limits, 0066_sending_limits.sql) --------------------------

export interface SendingLimitsRow {
  per_second: number | null;
  per_hour: number | null;
  per_day: number | null;
  per_month: number | null;
  updated_by: string | null;
  updated_at: number;
}

export const toSendingLimits = (row: SendingLimitsRow | null): SendingLimits =>
  row
    ? {
        perSecond: row.per_second,
        perHour: row.per_hour,
        perDay: row.per_day,
        perMonth: row.per_month,
      }
    : NO_SENDING_LIMITS;

export const readSendingLimitsRow = (db: D1Database) =>
  first<SendingLimitsRow>(
    db,
    'SELECT per_second, per_hour, per_day, per_month, updated_by, updated_at FROM sending_limits WHERE id = 1',
  );

/** The stored limits and when they were saved (0: never), as every turn passes them. */
export interface StoredLimits {
  limits: SendingLimits;
  savedAt: number;
}

/**
 * Each worker reads the setting at most this often. The pacer applies the newest saved limits it
 * knows, so a cached copy can't undo a change; without the pacer, a change applies within this.
 */
export const LIMITS_CACHE_MS = 30_000;
let cached: { stored: StoredLimits; at: number } | null = null;

/** The stored limits, read through a short cache. No row means no limits. */
export async function loadSendingLimits(db: D1Database, now = Date.now()): Promise<StoredLimits> {
  if (cached && now - cached.at < LIMITS_CACHE_MS) return cached.stored;
  const row = await readSendingLimitsRow(db);
  const stored = { limits: toSendingLimits(row), savedAt: row?.updated_at ?? 0 };
  cached = { stored, at: now };
  return stored;
}

/** A turn's `limits` and `limitsSavedAt`, from the stored setting. */
export const turnLimits = (stored: StoredLimits) => ({
  limits: stored.limits,
  limitsSavedAt: stored.savedAt,
});

/**
 * Tells the pacer limits that were just saved, with a turn for nothing (it counts nothing), so
 * every turn after it applies them, whatever the asking worker has cached. Best effort: without
 * the pacer nothing is counted anyway.
 */
export async function shareSendingLimits(limiter: MailLimiter, stored: StoredLimits) {
  await limiter.turn({ count: 0, priority: 'bulk', ...turnLimits(stored) });
}

let sharedCache: { shared: boolean; at: number } | null = null;

/**
 * Whether more than one workspace exists on this install, read through the same short cache as
 * the limits: then the pacer admits each workspace's large sends in parts (TurnRequest.sharedInstall).
 */
export async function installIsShared(db: D1Database, now = Date.now()): Promise<boolean> {
  if (sharedCache && now - sharedCache.at < LIMITS_CACHE_MS) return sharedCache.shared;
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM (SELECT 1 FROM workspaces LIMIT 2)',
  );
  sharedCache = { shared: (row?.n ?? 0) > 1, at: now };
  return sharedCache.shared;
}

/** Forgets the cached setting: after saving it here, and in tests. */
export function forgetSendingLimits(): void {
  cached = null;
  sharedCache = null;
}

/**
 * Saves the setting. updated_at only ever grows (by at least 1 ms a save), since the pacer takes
 * the limits with the latest one as the newest. Returns what was saved, for shareSendingLimits.
 */
export async function saveSendingLimits(
  db: D1Database,
  limits: SendingLimits,
  operatorId: string,
  now = Date.now(),
): Promise<StoredLimits> {
  const saved = await first<{ updated_at: number }>(
    db,
    `INSERT INTO sending_limits (id, per_second, per_hour, per_day, per_month, updated_by, updated_at)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (id) DO UPDATE SET per_second = excluded.per_second, per_hour = excluded.per_hour,
       per_day = excluded.per_day, per_month = excluded.per_month, updated_by = excluded.updated_by,
       updated_at = max(excluded.updated_at, sending_limits.updated_at + 1)
     RETURNING updated_at`,
    limits.perSecond,
    limits.perHour,
    limits.perDay,
    limits.perMonth,
    operatorId,
    now,
  );
  forgetSendingLimits();
  return { limits, savedAt: saved?.updated_at ?? now };
}

// ---- Errors and waits ---------------------------------------------------------------------

/** When a used-up quota of the email service is taken to reset: the next UTC day or month. */
export const quotaResetsAt = (quota: ProviderQuota, now: number): number => windowEnd(quota, now);

const timeOfDay = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
const dayOfMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** "00:00 UTC" within a day, "1 December, 00:00 UTC" further off. */
export function resumeTime(at: number, now: number): string {
  const time = `${timeOfDay.format(at)} UTC`;
  return at - now < 86_400_000 ? time : `${dayOfMonth.format(at)}, ${time}`;
}

const LIMIT_WORDS: Record<NonNullable<LimitTurn['limit']>, string> = {
  second: 'per-second limit',
  hour: 'hourly limit',
  day: 'daily limit',
  month: 'monthly limit',
  service_day: 'daily quota',
  service_month: 'monthly quota',
};

/**
 * Thrown by LimitedMail (and answered as 429 by Direct Send) when a sending limit holds an email
 * back. Retryable, so a caller with its own retries tries again later.
 */
export class SendingLimitError extends MailProviderError {
  constructor(
    readonly limit: NonNullable<LimitTurn['limit']>,
    readonly resetsAt: number | null,
    retryAfter: number,
    now = Date.now(),
  ) {
    const service = limit.startsWith('service_');
    super(
      429,
      'sending_limit',
      `${service ? 'The email service’s' : 'This Swarm’s'} ${LIMIT_WORDS[limit]} is reached${
        resetsAt ? `. Sending can continue at ${resumeTime(resetsAt, now)}` : '. Try again shortly'
      }.`,
      retryAfter,
    );
    this.name = 'SendingLimitError';
  }

  override get retryable(): boolean {
    return true;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A MailAdapter that takes a turn from the pacer before each email. For mail outside the send
 * pipeline: one email to one person, which someone is waiting for or should hear about soon, so
 * it is transactional (it may use the whole of each window and jumps the per-second line).
 */
export class LimitedMail implements MailAdapter {
  readonly maxConcurrency?: number;

  constructor(
    private readonly inner: MailAdapter,
    private readonly limiter: MailLimiter,
    private readonly limits: () => Promise<StoredLimits>,
    private readonly log?: (message: string, fields?: Record<string, unknown>) => void,
    private readonly priority: MailPriority = 'transactional',
  ) {
    if (inner.maxConcurrency !== undefined) this.maxConcurrency = inner.maxConcurrency;
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    const takenAt = Date.now();
    let counted = false;
    try {
      const turn = await this.limiter.turn({
        count: 1,
        priority: this.priority,
        ...turnLimits(await this.limits()),
      });
      if (turn.granted === 0) {
        throw new SendingLimitError(
          turn.limit ?? 'second',
          turn.resetsAt,
          turn.retryAfterSeconds,
          takenAt,
        );
      }
      counted = true;
      if (turn.startInMs > 0) await sleep(turn.startInMs);
    } catch (error) {
      if (error instanceof SendingLimitError) throw error;
      // The pacer is down or slow: one email to one person goes anyway.
      this.log?.('send pacer unavailable; sending without it', {
        category: mail.category,
        error: (error as Error).message,
      });
    }
    try {
      return await this.inner.send(mail);
    } catch (error) {
      if (counted && error instanceof MailProviderError && (error.retryable || error.quota)) {
        // It didn't go out, so it doesn't count. Best effort, like the rest.
        await this.limiter.release(1, takenAt).catch(() => undefined);
      }
      if (error instanceof MailProviderError && error.quota) {
        await this.limiter
          .block(error.quota, quotaResetsAt(error.quota, Date.now()))
          .catch(() => undefined);
      }
      throw error;
    }
  }
}
