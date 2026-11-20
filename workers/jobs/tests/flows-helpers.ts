// Test fixtures for the Flows engine: published Flows with frozen Flow emails, in-memory
// queues on a simulated clock, and a driver that runs jobs, the minute sweep and time forward.
import { env } from 'cloudflare:test';
import { extraTriggerTypes, newId, type FlowGraph } from '@swarm/domain';
import {
  RetryLater,
  engineConfig,
  enrollFromEvents,
  handleSendMessage,
  runStep,
  sweepFlows,
  type FlowsEnv,
  type JobMessage,
  type PipelineContext,
  type SendMessage,
} from '@swarm/engine';
import type { MailAdapter as ProviderAdapter, OutgoingMail as ProviderMail } from '@swarm/mail';
import { parseKeyring } from '@swarm/tokens';
import { flowsVault } from '../src/vault';
import { jobsEnv } from './helpers';

type MailAdapter = NonNullable<FlowsEnv['notices']>['mail'];
type OutgoingMail = Parameters<MailAdapter['send']>[0];

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

interface Queued {
  message: JobMessage;
  at: number;
  delaySeconds: number | undefined;
}

/** A jobs queue on a simulated clock: delayed messages become due at now + delaySeconds. */
class ClockQueue {
  readonly items: Queued[] = [];
  /** Every delaySeconds ever requested, for the 12 hour limit. */
  readonly delays: number[] = [];
  constructor(readonly clock: { now: number }) {}
  async send(message: JobMessage, options?: { delaySeconds?: number }) {
    const delaySeconds = options?.delaySeconds;
    if (delaySeconds !== undefined) this.delays.push(delaySeconds);
    this.items.push({ message, at: this.clock.now + (delaySeconds ?? 0) * 1000, delaySeconds });
  }
  async sendBatch(messages: { body: JobMessage; delaySeconds?: number }[]) {
    for (const m of messages) {
      await this.send(m.body, m.delaySeconds === undefined ? {} : { delaySeconds: m.delaySeconds });
    }
  }
}

class SendRecorder {
  readonly messages: SendMessage[] = [];
  async send(message: SendMessage) {
    this.messages.push(message);
  }
  async sendBatch(messages: { body: SendMessage }[]) {
    for (const m of messages) this.messages.push(m.body);
  }
  /** Batch messages for one Member. */
  for(memberId: string) {
    return this.messages.filter(
      (m): m is Extract<SendMessage, { type: 'batch' }> =>
        m.type === 'batch' && m.memberIds.includes(memberId),
    );
  }
}

export class MailRecorder implements MailAdapter {
  readonly sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    return { messageId: `test-${this.sent.length}` };
  }
}

export interface Harness {
  clock: { now: number };
  jobs: ClockQueue;
  sends: SendRecorder;
  mail: MailRecorder;
  env: FlowsEnv;
  /** Runs every due message (and what they queue) until none is due. */
  drain(): Promise<number>;
  /** Moves the clock, running the minute sweep and due messages on the way (coarse steps). */
  advance(ms: number, stepMs?: number): Promise<void>;
}

export function harness(
  start = Date.now(),
  options: { fetch?: typeof fetch; ignoreForeign?: boolean } = {},
): Harness {
  const clock = { now: start };
  const jobs = new ClockQueue(clock);
  const sends = new SendRecorder();
  const mail = new MailRecorder();
  const base = jobsEnv().env;
  const flowsEnv: FlowsEnv = {
    DB: env.DB,
    JOBS_QUEUE: jobs as unknown as Queue<JobMessage>,
    SEND_QUEUE: sends as unknown as Queue<SendMessage>,
    vault: flowsVault(base),
    notices: { mail, from: 'notifications@mail.swarm.localhost' },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const drain = async () => {
    let ran = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const index = jobs.items.findIndex((item) => item.at <= clock.now);
      if (index < 0) break;
      const [item] = jobs.items.splice(index, 1);
      const message = item!.message;
      if (message.type === 'flow_step') await runStep(flowsEnv, message, clock.now);
      else if (message.type === 'flow_events') await enrollFromEvents(flowsEnv, clock.now);
      ran++;
    }
    return ran;
  };
  const advance = async (ms: number, stepMs = HOUR) => {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + stepMs);
      await sweepFlows(flowsEnv, clock.now);
      await drain();
    }
  };
  return { clock, jobs, sends, mail, env: flowsEnv, drain, advance };
}

// ---- The send side: the real pipeline behind a queue the test releases by hand ------------------

const pipelineConfig = engineConfig({
  TRACK_ORIGIN: 'https://link.swarm.test',
  PLATFORM_MAIL_DOMAIN: 'mail.swarm.test',
  UNSUBSCRIBE_MAIL_DOMAIN: 'unsubscribe.swarm.test',
  TRACK_KEYS: parseKeyring(`t1:${'t'.repeat(64)}`),
  UNSUBSCRIBE_KEYS: parseKeyring(`u1:${'u'.repeat(64)}`),
  MEDIA_ORIGIN: 'https://media.swarm.test',
});

/** What the mail provider was handed: the real last step of a Flow email. */
class ProviderOutbox implements ProviderAdapter {
  readonly accepted: ProviderMail[] = [];
  /** Runs on every hand-off, before `fail`: an attempted send counts, accepted or not. */
  onSend: ((mail: ProviderMail) => Promise<void>) | null = null;
  fail: ((mail: ProviderMail) => Error | null) | null = null;

  async send(mail: ProviderMail) {
    await this.onSend?.(mail);
    const error = this.fail?.(mail);
    if (error) throw error;
    this.accepted.push(mail);
    return { messageId: `provider-${this.accepted.length}-${mail.tags?.delivery ?? ''}` };
  }
}

interface HeldMessage {
  message: SendMessage;
  at: number;
}

/**
 * The send queue on the simulated clock, consumed by the real handleSendMessage. Messages wait
 * until the test releases them, so anything can happen between the Flow step that queued an email
 * and the consumer that sends it. A RetryLater goes back on the queue as workers/send does.
 */
export class SendPipeline {
  readonly items: HeldMessage[] = [];
  readonly outbox = new ProviderOutbox();
  readonly ctx: PipelineContext;

  constructor(readonly clock: { now: number }) {
    this.ctx = {
      db: env.DB,
      mail: this.outbox,
      config: pipelineConfig,
      now: () => clock.now,
      queue: {
        send: async (message, options) => {
          await this.send(message, options);
        },
        sendBatch: async (messages) => {
          for (const m of messages) await this.send(m.body);
        },
      },
    };
  }

  async send(message: SendMessage, options?: { delaySeconds?: number }) {
    this.items.push({ message, at: this.clock.now + (options?.delaySeconds ?? 0) * 1000 });
  }

  async sendBatch(messages: { body: SendMessage }[]) {
    for (const m of messages) await this.send(m.body);
  }

  /** Indexes of the messages that are due now. */
  due(): number[] {
    return this.items.flatMap((item, i) => (item.at <= this.clock.now ? [i] : []));
  }

  /** Delivers one queued message (`times` 2 is an at-least-once queue delivering it twice). */
  async consume(index: number, times = 1): Promise<void> {
    const [item] = this.items.splice(index, 1);
    if (!item) return;
    for (let i = 0; i < times; i++) {
      try {
        await handleSendMessage(this.ctx, item.message);
      } catch (error) {
        if (!(error instanceof RetryLater)) throw error;
        await this.send(item.message, { delaySeconds: error.delaySeconds });
        return;
      }
    }
  }

  /** Delivers everything due, including what that queues. Returns how many ran. */
  async consumeDue(): Promise<number> {
    let ran = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const [next] = this.due();
      if (next === undefined) return ran;
      await this.consume(next);
      ran++;
    }
    throw new Error('the send queue did not drain');
  }
}

/** Puts the real send pipeline behind a harness's Flows engine. */
export function attachPipeline(h: Harness): SendPipeline {
  const pipeline = new SendPipeline(h.clock);
  h.env.SEND_QUEUE = pipeline as unknown as Queue<SendMessage>;
  return pipeline;
}

/** One frozen link per Flow Broadcast, so a test can record real clicks on it. */
export async function addLinkTarget(broadcastId: string, url = 'https://example.com/read') {
  const id = newId('linkTarget');
  await env.DB.prepare(
    'INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, ?3, 0)',
  )
    .bind(id, broadcastId, url)
    .run();
  return id;
}

export interface PublishedFlow {
  flowId: string;
  /** node id → Flow Broadcast id, for send_email nodes. */
  broadcasts: Record<string, string>;
}

/** Inserts a live Flow with version 1 of `graph`, freezing a Broadcast per send node. */
export async function publishFlow(
  seed: { workspaceId: string; channelId: string },
  graph: FlowGraph,
  options: {
    reentry?: 'never' | 'after_exit';
    status?: 'live' | 'paused' | 'archived' | 'draft';
    webhookSecretEnc?: string | null;
    name?: string;
    flowId?: string;
  } = {},
): Promise<PublishedFlow> {
  const now = Date.now();
  const flowId = options.flowId ?? newId('flow', now);
  const trigger = graph.nodes.find((n) => n.type === 'trigger')!;
  const extras = extraTriggerTypes(graph);
  await env.DB.prepare(
    `INSERT INTO flows (id, workspace_id, channel_id, name, status, draft_graph_json, live_version,
       trigger_type, reentry, webhook_secret_enc, created_at, updated_at, extra_trigger_types)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?10, ?11)`,
  )
    .bind(
      flowId,
      seed.workspaceId,
      seed.channelId,
      options.name ?? 'Welcome',
      options.status ?? 'live',
      JSON.stringify(graph),
      trigger.config.event,
      options.reentry ?? 'never',
      options.webhookSecretEnc ?? null,
      now,
      extras ? JSON.stringify(extras) : null,
    )
    .run();
  const broadcasts = await publishVersion(seed, flowId, 1, graph);
  return { flowId, broadcasts };
}

/** Adds version `version` of a Flow (and its Flow emails); does not change live_version. */
export async function publishVersion(
  seed: { workspaceId: string; channelId: string },
  flowId: string,
  version: number,
  graph: FlowGraph,
): Promise<Record<string, string>> {
  const now = Date.now();
  const trigger = graph.nodes.find((n) => n.type === 'trigger')!;
  await env.DB.prepare(
    `INSERT INTO flow_versions (flow_id, version, graph_json, trigger_type, published_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(flowId, version, JSON.stringify(graph), trigger.config.event, now)
    .run();
  const broadcasts: Record<string, string> = {};
  for (const node of graph.nodes) {
    if (node.type !== 'send_email') continue;
    const dispatchId = node.config.dispatchId;
    await env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, kind, flow_id, created_at, updated_at)
       VALUES (?1, ?2, 'Hello', '{"type":"doc","content":[]}', 'draft', 'flow', ?3, ?4, ?4)
       ON CONFLICT (id) DO NOTHING`,
    )
      .bind(dispatchId, seed.channelId, flowId, now)
      .run();
    const broadcastId = newId('broadcast', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html,
           text, from_name, from_address, track_opens, snapshot_done, fanout_done, created_at,
           last_progress_at, kind, flow_id)
         VALUES (?1, ?2, ?3, ?4, 'sending', 'Hello', '', '<p>Hi</p>', 'Hi', 'Notes', 'notes@mail.swarm.localhost',
           1, 1, 1, ?5, ?5, 'flow', ?6)`,
      ).bind(broadcastId, dispatchId, seed.channelId, seed.workspaceId, now, flowId),
      env.DB.prepare(
        `INSERT INTO flow_emails (flow_id, version, node_id, dispatch_id, broadcast_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(flowId, version, node.id, dispatchId, broadcastId, now),
    ]);
    broadcasts[node.id] = broadcastId;
  }
  return broadcasts;
}

export const dispatchId = () => newId('dispatch');

export async function makeTag(channelId: string, name = `t-${crypto.randomUUID().slice(0, 8)}`) {
  const id = newId('tag');
  await env.DB.prepare(
    'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(id, channelId, name, Date.now())
    .run();
  return id;
}

export async function makeAdmin(workspaceId: string, email: string) {
  const now = Date.now();
  const operatorId = newId('operator', now);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(operatorId, email, now),
    env.DB.prepare(
      `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'admin', ?4, ?4)`,
    ).bind(newId('seat', now), workspaceId, operatorId, now),
  ]);
  return operatorId;
}

interface RunRow {
  id: string;
  flow_id: string;
  version: number;
  status: string;
  exit_reason: string | null;
  current_node_id: string | null;
  next_at: number | null;
  ended_at: number | null;
  context_json: string;
}

export const runsOf = async (flowId: string, memberId?: string) =>
  (
    await env.DB.prepare(
      `SELECT * FROM flow_runs WHERE flow_id = ?1 AND (?2 IS NULL OR member_id = ?2) ORDER BY started_at, id`,
    )
      .bind(flowId, memberId ?? null)
      .all<RunRow>()
  ).results;

export const stepsOf = async (runId: string) =>
  (
    await env.DB.prepare(
      'SELECT node_id, attempt, status, outcome, error, result_json, started_at FROM flow_run_steps WHERE run_id = ?1 ORDER BY rowid',
    )
      .bind(runId)
      .all<{
        node_id: string;
        attempt: number;
        status: string;
        outcome: string | null;
        error: string | null;
        result_json: string | null;
        started_at: number;
      }>()
  ).results;

export const recipientsOf = async (memberId: string) =>
  (
    await env.DB.prepare(
      'SELECT broadcast_id FROM broadcast_recipients WHERE member_id = ?1 ORDER BY broadcast_id',
    )
      .bind(memberId)
      .all<{ broadcast_id: string }>()
  ).results.map((r) => r.broadcast_id);
