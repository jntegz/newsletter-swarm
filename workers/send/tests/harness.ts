import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  createLinkKeys,
  engineConfig,
  handleSendMessage,
  RetryLater,
  type DispatchRow,
  type EngineConfig,
  type PipelineContext,
  type SendMessage,
} from '@swarm/engine';
import type { MailAdapter, OutgoingMail, SentMail } from '@swarm/mail';
import { parseKeyring } from '@swarm/tokens';

const mode = { signing: 'v2' as const, legacyCutoffMs: Number(env.LINK_LEGACY_CUTOFF) };

/** The send worker's own link keys: it signs Member Center and Ask links, and verifies none. */
const sendLinks = createLinkKeys({
  mode,
  rings: { MEMBER_SIGNING_KEYS: env.MEMBER_SIGNING_KEYS, ASK_SIGNING_KEYS: env.ASK_SIGNING_KEYS },
});

/** Every link key of the test install, to check links as capture does. */
export const verifier = createLinkKeys({
  mode,
  memberKeys: parseKeyring(env.MEMBER_KEYS),
  rings: JSON.parse(env.TEST_LINK_KEYS) as Record<string, string>,
});

export const config: EngineConfig = engineConfig(
  {
    TRACK_ORIGIN: 'https://link.swarm.test',
    PLATFORM_MAIL_DOMAIN: 'mail.swarm.test',
    UNSUBSCRIBE_MAIL_DOMAIN: 'unsubscribe.swarm.test',
    TRACK_KEYS: parseKeyring(env.TRACK_KEYS),
    UNSUBSCRIBE_KEYS: parseKeyring(env.UNSUBSCRIBE_KEYS),
    BOUNCE_KEYS: parseKeyring(env.BOUNCE_KEYS),
    MEDIA_ORIGIN: 'https://media.swarm.test',
    CAPTURE_ORIGIN: 'https://forms.swarm.test',
  },
  sendLinks,
);

/** Records every message; `fail` decides per call whether to throw instead. */
export class CaptureMail implements MailAdapter {
  readonly sent: OutgoingMail[] = [];
  fail: ((mail: OutgoingMail, call: number) => Error | null) | null = null;
  private calls = 0;

  async send(mail: OutgoingMail): Promise<SentMail> {
    const error = this.fail?.(mail, ++this.calls);
    if (error) throw error;
    this.sent.push(mail);
    return { messageId: `ses-${this.sent.length}-${crypto.randomUUID()}` };
  }
}

interface Queued {
  body: SendMessage;
  delaySeconds: number;
  /** Deliveries of this message so far, as Cloudflare Queues counts them. */
  attempts?: number;
}

/** An in-memory queue the test drives by hand, so ordering and failures are deterministic. */
export class MemoryQueue {
  readonly items: Queued[] = [];

  async send(body: SendMessage, options?: { delaySeconds?: number }) {
    this.items.push({ body, delaySeconds: options?.delaySeconds ?? 0 });
  }

  async sendBatch(messages: { body: SendMessage; delaySeconds?: number }[]) {
    for (const m of messages) this.items.push({ body: m.body, delaySeconds: m.delaySeconds ?? 0 });
  }
}

export function context(mail = new CaptureMail(), now?: () => number) {
  const queue = new MemoryQueue();
  const ctx: PipelineContext = { db: env.DB, queue, mail, config, ...(now ? { now } : {}) };
  return { ctx, queue, mail };
}

interface DrainOptions {
  /** Stop when the next message is delayed (it would wait for the ramp). */
  stopAtDelay?: boolean;
  /** Called before each message; return false to drop it (a lost message). */
  filter?: (message: SendMessage, index: number) => boolean;
  /** Deliver every batch message twice (an at-least-once queue). */
  duplicateBatches?: boolean;
  maxSteps?: number;
  /**
   * The consumer's max_retries (wrangler.jsonc: 8). A message retried more often goes to the
   * dead-letter queue: it is dropped and counted.
   */
  maxRetries?: number;
}

/** Runs queued messages until the queue is empty. Retries go to the back of the queue. */
export async function drain(
  ctx: PipelineContext,
  queue: MemoryQueue,
  options: DrainOptions = {},
): Promise<{ steps: number; retries: number; delayed: Queued[]; deadLettered: SendMessage[] }> {
  let steps = 0;
  let retries = 0;
  const delayed: Queued[] = [];
  const deadLettered: SendMessage[] = [];
  while (queue.items.length) {
    if (++steps > (options.maxSteps ?? 10_000)) throw new Error('queue did not drain');
    const item = queue.items.shift()!;
    if (item.delaySeconds > 0 && options.stopAtDelay) {
      delayed.push(item);
      continue;
    }
    if (options.filter && !options.filter(item.body, steps)) continue;
    const runs = options.duplicateBatches && item.body.type === 'batch' ? 2 : 1;
    const attempts = item.attempts ?? 1;
    for (let i = 0; i < runs; i++) {
      try {
        await handleSendMessage(ctx, item.body, { attempts });
      } catch (error) {
        if (!(error instanceof RetryLater)) throw error;
        retries++;
        if (attempts > (options.maxRetries ?? Number.POSITIVE_INFINITY)) {
          deadLettered.push(item.body);
        } else {
          queue.items.push({ body: item.body, delaySeconds: 0, attempts: attempts + 1 });
        }
      }
    }
  }
  return { steps, retries, delayed, deadLettered };
}

export async function seedChannel(options: { members?: number; trackOpens?: boolean } = {}) {
  const now = Date.now();
  const workspaceId = newId('workspace');
  const channelId = newId('channel');
  const slug = `ch-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(workspaceId, 'Test workspace', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, settings_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?5, ?5)`,
    ).bind(
      channelId,
      workspaceId,
      slug,
      JSON.stringify({ trackOpens: options.trackOpens ?? true }),
      now,
    ),
  ]);
  if (options.members) await addMembers(channelId, options.members);
  return { workspaceId, channelId, slug };
}

/** Members m1…mN with addresses m<i>@example.org, generated in SQL to stay under bind limits. */
export async function addMembers(channelId: string, count: number, prefix = 'm') {
  const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
     INSERT INTO members (id, channel_id, email, first_name, status, created_at, updated_at)
     SELECT 'mb_' || ?3 || printf('%024d', i), ?2, ?4 || i || '-' || ?3 || '@example.org',
            CASE WHEN i % 2 = 0 THEN 'Ada' ELSE NULL END, 'active', ?5, ?5 FROM n`,
  )
    .bind(count, channelId, tag, prefix, Date.now())
    .run();
  return tag;
}

export async function seedDispatch(channelId: string, overrides: Partial<DispatchRow> = {}) {
  const now = Date.now();
  const id = newId('dispatch');
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi {{ first_name | there }},' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Read ' },
          {
            type: 'text',
            text: 'the essay',
            marks: [{ type: 'link', attrs: { href: 'https://essay.example/1' } }],
          },
        ],
      },
    ],
  };
  await env.DB.prepare(
    `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, sender_identity_id, publish_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(
      id,
      channelId,
      overrides.subject ?? 'Issue 1',
      overrides.content_json ?? JSON.stringify(content),
      overrides.status ?? 'draft',
      overrides.sender_identity_id ?? null,
      overrides.publish_at ?? null,
      now,
    )
    .run();
  return (await env.DB.prepare('SELECT * FROM dispatches WHERE id = ?1')
    .bind(id)
    .first<DispatchRow>())!;
}

export async function broadcastRow(id: string) {
  return env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?1').bind(id).first<{
    status: string;
    recipient_count: number;
    sent_count: number;
    failed_count: number;
    failure_reason: string | null;
    ramp_id: string;
  }>();
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Lifts the platform ramp cap so volume tests aren't throttled. */
export async function completeRamp(channelId: string) {
  await env.DB.prepare(
    `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap, growth, max_cap,
       bounce_threshold, complaint_threshold, created_at, updated_at)
     VALUES (?1, ?2, NULL, 'complete', ?3, 5000, 100, 1.3, 5000, 0.02, 0.0008, ?4, ?4)`,
  )
    .bind(newId('reputationRamp'), channelId, new Date().toISOString().slice(0, 10), Date.now())
    .run();
}
