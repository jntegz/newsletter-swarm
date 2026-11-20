import { idPattern } from '@swarm/domain';
import { z } from 'zod';
import type { WebhookMessage } from './webhooks';

/**
 * Messages on the jobs queue (consumed by the jobs worker). Each job row holds its own progress
 * and cursor, so a message only names the job; handlers are safe to run twice. No message carries
 * an address or other Member data, only ids: what lands in a dead-letter queue (`swarm-jobs-dlq`)
 * then holds nothing that erasure and retention can't reach.
 */
export type JobMessage =
  | { type: 'import_analyze'; jobId: string }
  | { type: 'import_run'; jobId: string }
  | { type: 'export'; jobId: string }
  | { type: 'bulk'; jobId: string }
  | { type: 'circle_refresh'; circleId: string; generation: number }
  /**
   * Member data in this Channel changed: re-evaluate its Circles. Only the public queue carries
   * it (PublicMessage); the jobs worker marks the Channel's Circles pending and queues their
   * circle_refresh messages itself, so the message names nothing but the Channel.
   */
  | { type: 'channel_changed'; channelId: string }
  // Flows (Phase 6; handled by flows.ts through the jobs worker):
  /** Drain unprocessed member_events and enrol Members in live Flows (enrollFromEvents). */
  | { type: 'flow_events' }
  /**
   * Execute one node of one run (runStep). Idempotent on (runId, nodeId, attempt): a step row
   * already done or failed for that attempt makes the message a no-op. Queued with
   * delaySeconds (≤ QUEUE_MAX_DELAY_SECONDS) for short delays, or by the minute sweep.
   */
  | { type: 'flow_step'; runId: string; nodeId: string; attempt: number }
  // Email checks (docs/email-verification.md; email-checks.ts):
  /** One planning step of a run: sorts its addresses, then counts the credits. */
  | { type: 'email_check_plan'; runId: string }
  /** Moves a running run along: the part at DeBounce, the next one. */
  | { type: 'email_check_run'; runId: string }
  /**
   * Members just added by hand or through the API (or re-checked), or who just confirmed a
   * signup, checked in the background. Named by Member id,
   * never by address, so a message that dead-letters holds no address and one whose Member was
   * erased meanwhile ends without doing anything. Queue messages are not signed: the ids are
   * checked against stored rows, and "Check again" (which skips the workspace's settings and a
   * result that still counts) is a stored email_check_requests row named by `requestId`, never a
   * flag on the message.
   */
  | {
      type: 'email_check';
      workspaceId: string;
      channelId: string;
      memberIds?: string[];
      requestId?: string;
      /**
       * They just confirmed a signup made through a form that asks people to confirm: the
       * workspace's signup rules apply (checkConfirmed), never the rules for additions by hand.
       */
      confirmed?: true;
    };

export interface JobQueue {
  send(message: JobMessage, options?: { delaySeconds?: number }): Promise<void>;
}

/** Adapts a Cloudflare Queue binding to JobQueue. */
export function jobQueue(queue: Queue<JobMessage>): JobQueue {
  return {
    send: async (message, options) => {
      await queue.send(message, options);
    },
  };
}

/**
 * What the internet-facing workers (capture, events) may queue, on their own queue (`swarm-public`,
 * PUBLIC_QUEUE). They hold no binding to the jobs queue, and the jobs worker refuses anything else
 * that arrives on this one (security review S04-P1-TR-public-worker-queue-narrowing):
 * - `channel_changed`: a signup, confirmation, settings change or bounce changed a Member;
 * - `email_check` for one Member who just confirmed a signup (capture's confirm route), with the
 *   signup rules (`confirmed`) and never a stored "Check again" request.
 */
export type PublicMessage =
  | Extract<JobMessage, { type: 'channel_changed' }>
  | {
      type: 'email_check';
      workspaceId: string;
      channelId: string;
      memberIds: [string];
      confirmed: true;
    };

/** Queues a re-evaluation of the Channel's Circles from a public worker. */
export async function queueChannelChanged(
  queue: { send(message: PublicMessage): Promise<unknown> },
  channelId: string,
): Promise<void> {
  await queue.send({ type: 'channel_changed', channelId });
}

/**
 * The queues the jobs worker consumes. A batch is read by the queue it came from, never by its
 * bodies: `swarm-jobs`, `swarm-staging-jobs` and `swarm-production-jobs` are all the jobs queue
 * (wrangler.jsonc; the installer's names end the same way).
 */
export type QueueRole = 'jobs' | 'webhooks' | 'public';

export function queueRole(queueName: string): QueueRole | null {
  const match = /(?:^|-)(jobs|webhooks|public)$/.exec(queueName);
  return (match?.[1] as QueueRole | undefined) ?? null;
}

// Queue messages are not signed, so every body is parsed before it runs. On the jobs and webhooks
// queues (api and jobs produce there) fields nobody reads are dropped. On the public queue the
// shapes are exact and its ids must look like ids.
const ref = z.string().min(1).max(100);
const jobId = (type: string) => z.object({ type: z.literal(type), jobId: ref });
const runId = (type: string) => z.object({ type: z.literal(type), runId: ref });
const JOB_SCHEMAS = {
  import_analyze: jobId('import_analyze'),
  import_run: jobId('import_run'),
  export: jobId('export'),
  bulk: jobId('bulk'),
  circle_refresh: z.object({
    type: z.literal('circle_refresh'),
    circleId: ref,
    generation: z.number().int().nonnegative(),
  }),
  flow_events: z.object({ type: z.literal('flow_events') }),
  flow_step: z.object({
    type: z.literal('flow_step'),
    runId: ref,
    nodeId: ref,
    attempt: z.number().int().positive(),
  }),
  email_check_plan: runId('email_check_plan'),
  email_check_run: runId('email_check_run'),
  email_check: z.object({
    type: z.literal('email_check'),
    workspaceId: ref,
    channelId: ref,
    memberIds: z.array(ref).max(1000).optional(),
    requestId: ref.optional(),
    confirmed: z.literal(true).optional(),
  }),
} satisfies Partial<Record<JobMessage['type'], z.ZodType>>;

const PUBLIC_SCHEMAS = {
  channel_changed: z.strictObject({
    type: z.literal('channel_changed'),
    channelId: z.string().regex(idPattern('channel')),
  }),
  email_check: z.strictObject({
    type: z.literal('email_check'),
    workspaceId: z.string().regex(idPattern('workspace')),
    channelId: z.string().regex(idPattern('channel')),
    memberIds: z.tuple([z.string().regex(idPattern('member'))]),
    confirmed: z.literal(true),
  }),
} satisfies Record<PublicMessage['type'], z.ZodType>;

const QUEUE_SCHEMAS: Record<QueueRole, Record<string, z.ZodType>> = {
  jobs: JOB_SCHEMAS,
  webhooks: {
    webhook_delivery: z.object({ type: z.literal('webhook_delivery'), deliveryId: ref }),
  },
  public: PUBLIC_SCHEMAS,
};

export type QueueRead =
  | { ok: true; message: JobMessage | WebhookMessage }
  | { ok: false; type: string | null; reason: 'not_allowed' | 'malformed' };

/**
 * Reads one body from a queue: refused when its type is not one this queue carries, or when it
 * does not have that type's shape. A refused message is never run (the caller acks and logs it).
 */
export function readQueueMessage(role: QueueRole, body: unknown): QueueRead {
  const raw = body && typeof body === 'object' ? (body as { type?: unknown }).type : undefined;
  const type = typeof raw === 'string' ? raw.slice(0, 40) : null;
  const schema =
    type !== null && Object.hasOwn(QUEUE_SCHEMAS[role], type)
      ? QUEUE_SCHEMAS[role][type]
      : undefined;
  if (!schema) return { ok: false, type, reason: 'not_allowed' };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, type, reason: 'malformed' };
  return { ok: true, message: parsed.data as JobMessage | WebhookMessage };
}
