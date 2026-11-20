// Event Webhooks (Phase 7) against real D1: fan-out from member_events and platform_events,
// endpoint matching, the cursor, signed delivery, retries, auto-disable with the notice,
// redrive, the sweep, pruning and the emission sites in the engine and jobs.
import { env } from 'cloudflare:test';
import {
  FlowGraphSchema,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  newId,
  webhookBackoffSeconds,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@swarm/domain';
import {
  WEBHOOK_CURSORS,
  WEBHOOK_FANOUT_MAX_DELIVERIES,
  WEBHOOK_FANOUT_PAGE,
  applyRosterChanges,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_RETENTION_MS,
  WEBHOOK_SWEEP_GRACE_MS,
  deliverWebhook,
  enrollFromEvents,
  fanOutWebhooks,
  leaveBeforeConfirming,
  newWebhookSecret,
  pruneWebhooks,
  recordMemberEvent,
  recordPlatformEvent,
  setOutboundPlatformHosts,
  OUTBOUND_WAIT_MS_PER_MINUTE,
  WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS,
  WEBHOOK_ENDPOINT_MAX_CONCURRENT,
  redriveFailedWebhooks,
  redriveWebhookDelivery,
  sendTestWebhook,
  sweepWebhooks,
  unsubscribeMember,
  webhookErasureStatements,
  webhookEventId,
  type WebhookMessage,
  type WebhooksEnv,
} from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import { verifySwarmSignature } from '../../../docs/examples/verify-webhook';
import { runBulk } from '../src/handlers/bulk';
import { consume } from '../src/index';
import { parseJobsEnv } from '../src/env';
import { useWebhookFetchForTests } from '../src/handlers/webhooks';
import { MailRecorder, harness as flowsHarness, makeTag, publishFlow } from './flows-helpers';
import {
  addMember,
  count,
  jobsEnv,
  one,
  seedChannel,
  seedFeedAdmin,
  testFieldKeys,
} from './helpers';
import { signDelivery } from '../src/vault';

const HOUR = 3_600_000;
const keys = () => testFieldKeys;

class WebhookQueueRecorder {
  readonly messages: { deliveryId: string; delaySeconds: number | undefined }[] = [];
  async send(message: WebhookMessage, options?: { delaySeconds?: number }) {
    this.messages.push({ deliveryId: message.deliveryId, delaySeconds: options?.delaySeconds });
  }
  async sendBatch(messages: { body: WebhookMessage; delaySeconds?: number }[]) {
    for (const m of messages)
      await this.send(m.body, { ...(m.delaySeconds ? { delaySeconds: m.delaySeconds } : {}) });
  }
}

interface Captured {
  url: string;
  headers: Headers;
  body: string;
  redirect: RequestInit['redirect'];
}

/** A receiver that answers from a script (default 200) and records every request. */
function receiver(answer: (n: number) => Response | Promise<Response> = () => new Response('ok')) {
  const requests: Captured[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
      redirect: init?.redirect,
    });
    return answer(requests.length);
  }) as typeof fetch;
  return { requests, fetcher };
}

function harness(fetcher?: typeof fetch) {
  const queue = new WebhookQueueRecorder();
  const mail = new MailRecorder();
  const wenv: WebhooksEnv = {
    DB: env.DB,
    WEBHOOKS_QUEUE: queue,
    signDelivery: signDelivery(jobsEnv().env),
    ENVIRONMENT: 'test',
    ...(fetcher ? { fetch: fetcher } : {}),
    notices: { mail, from: 'notifications@mail.swarm.localhost' },
  };
  return { queue, mail, env: wenv };
}

async function makeEndpoint(
  seed: { workspaceId: string },
  options: {
    events?: readonly WebhookEventType[];
    channelId?: string | null;
    status?: 'active' | 'paused' | 'disabled';
    secret?: string;
    url?: string;
    createdAt?: number;
    confirmedBy?: string;
    unconfirmed?: boolean;
    proposedVia?: { kind: 'key' | 'oauth'; id: string };
  } = {},
): Promise<{ id: string; secret: string }> {
  const secret = options.secret ?? newWebhookSecret();
  const id = newId('webhookEndpoint');
  const at = options.createdAt ?? Date.now() - 1000;
  // An admin standing behind it: an endpoint receives events only while one does.
  const admin = options.confirmedBy ?? (await seedFeedAdmin(seed.workspaceId));
  await env.DB.prepare(
    `INSERT INTO webhook_endpoints (id, workspace_id, channel_id, url, events_json, secret_enc, status, created_at, updated_at,
       created_by, confirmed_by, confirmed_at, proposed_via, proposed_by_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      seed.workspaceId,
      options.channelId ?? null,
      options.url ?? 'https://hooks.example.com/in',
      JSON.stringify(options.events ?? WEBHOOK_EVENTS),
      await encrypt(keys(), secret),
      options.status ?? 'active',
      at,
      admin,
      options.unconfirmed ? null : at,
      options.proposedVia?.kind ?? null,
      options.proposedVia?.id ?? null,
    )
    .run();
  return { id, secret };
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  error: string | null;
  member_id: string | null;
}

const deliveriesOf = async (endpointId: string) =>
  (
    await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ?1 ORDER BY id')
      .bind(endpointId)
      .all<DeliveryRow>()
  ).results;

const delivery = (id: string) =>
  one<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = ?1', id) as Promise<DeliveryRow>;

const endpointRow = (id: string) =>
  one<{
    status: string;
    failure_count: number;
    first_failure_at: number | null;
    disabled_reason: string | null;
  }>(
    'SELECT status, failure_count, first_failure_at, disabled_reason FROM webhook_endpoints WHERE id = ?1',
    id,
  );

const email = () => `m-${crypto.randomUUID()}@example.com`;

/** `db`, calling `before` and `after` around each batch with the SQL of its statements. */
function aroundBatches(
  db: D1Database,
  hooks: {
    before?: (sql: string[]) => Promise<void> | void;
    after?: (sql: string[]) => Promise<void> | void;
  },
): D1Database {
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => {
          const statement = target.prepare(query);
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            sqlOf.set(bound, query);
            return bound;
          };
          sqlOf.set(statement, query);
          return statement;
        };
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((statement) => sqlOf.get(statement) ?? '');
          await hooks.before?.(sql);
          const results = await target.batch(statements);
          await hooks.after?.(sql);
          return results;
        };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** `db`, counting the queries run through it: each read or write, and a batch as one. */
function countQueries(db: D1Database): { db: D1Database; counter: { queries: number } } {
  const counter = { queries: 0 };
  const counted = (statement: D1PreparedStatement): D1PreparedStatement => {
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => counted(bind(...values));
    for (const method of ['first', 'all', 'run', 'raw'] as const) {
      const call = (statement[method] as (...args: unknown[]) => unknown).bind(statement);
      Object.assign(statement, {
        [method]: (...args: unknown[]) => {
          counter.queries++;
          return call(...args);
        },
      });
    }
    return statement;
  };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (query: string) => counted(target.prepare(query));
      if (key === 'batch' || key === 'exec')
        return (...args: unknown[]) => {
          counter.queries++;
          return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
        };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { db: proxy, counter };
}

beforeEach(() => useWebhookFetchForTests(undefined));

describe('fan-out', () => {
  it('creates one delivery per matching endpoint and event', async () => {
    const seed = await seedChannel();
    const otherChannel = newId('channel');
    await env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Other', ?4, ?4)",
    )
      .bind(otherChannel, seed.workspaceId, `ch-${crypto.randomUUID().slice(0, 12)}`, Date.now())
      .run();
    const elsewhere = await seedChannel();
    const all = await makeEndpoint(seed);
    const onlyConfirmed = await makeEndpoint(seed, { events: ['member.confirmed'] });
    const thisChannel = await makeEndpoint(seed, { channelId: seed.channelId });
    const otherFilter = await makeEndpoint(seed, { channelId: otherChannel });
    const paused = await makeEndpoint(seed, { status: 'paused' });
    const disabled = await makeEndpoint(seed, { status: 'disabled' });
    const foreign = await makeEndpoint(elsewhere);

    const h = harness();
    await fanOutWebhooks(h.env); // drain what earlier tests left
    const member = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'form', status: 'pending' },
    });
    await recordMemberEvent(env.DB, {
      type: 'confirmed',
      memberId: member,
      payload: { method: 'double_opt_in' },
    });
    // Not announced: no webhook for clicks.
    await recordMemberEvent(env.DB, {
      type: 'gate_hit',
      memberId: member,
      payload: { dispatchId: newId('dispatch') },
    });
    const created = await fanOutWebhooks(h.env);

    expect((await deliveriesOf(all.id)).map((d) => d.event_type).sort()).toEqual([
      'member.confirmed',
      'member.created',
    ]);
    expect((await deliveriesOf(onlyConfirmed.id)).map((d) => d.event_type)).toEqual([
      'member.confirmed',
    ]);
    expect(await deliveriesOf(thisChannel.id)).toHaveLength(2);
    for (const none of [otherFilter, paused, disabled, foreign]) {
      expect(await deliveriesOf(none.id)).toEqual([]);
    }
    expect(created).toBe(5);
    expect(h.queue.messages).toHaveLength(5);

    // The same event has the same id for every endpoint, and the body is the envelope.
    const createdOf = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).filter((d) => d.event_type === 'member.created');
    const [first] = await createdOf(all.id);
    const [same] = await createdOf(thisChannel.id);
    expect(first!.event_id).toBe(same!.event_id);
    const envelope = JSON.parse(first!.payload_json) as WebhookEnvelope;
    expect(envelope).toMatchObject({
      id: first!.event_id,
      type: 'member.created',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      data: { id: member, firstName: 'Ada', status: 'active', tags: [] },
    });
    expect(first!.member_id).toBe(member);
    // The Flows engine's processed_at is untouched.
    expect(
      await count(
        'SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND processed_at IS NOT NULL',
        member,
      ),
    ).toBe(0);
  });

  it('never reprocesses: the cursor moves, and a re-read creates nothing twice', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    await fanOutWebhooks(h.env);
    const member = await addMember(seed.channelId, email());
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'operator', status: 'active' },
    });
    expect(await fanOutWebhooks(h.env)).toBe(1);
    expect(await fanOutWebhooks(h.env)).toBe(0);
    const cursor = await one<{ value: number }>(
      'SELECT value FROM event_cursors WHERE name = ?1',
      WEBHOOK_CURSORS.member_events,
    );
    // A crash before the cursor moved: the page is read again, the UNIQUE index holds.
    await env.DB.prepare('UPDATE event_cursors SET value = ?1 WHERE name = ?2')
      .bind(cursor!.value - 1, WEBHOOK_CURSORS.member_events)
      .run();
    expect(await fanOutWebhooks(h.env)).toBe(0);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
  });

  it('coalesces tag and field changes into one member.updated per Member and page', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed, { events: ['member.updated'] });
    const h = harness();
    await fanOutWebhooks(h.env);
    const a = await addMember(seed.channelId, email());
    const b = await addMember(seed.channelId, email());
    for (const memberId of [a, a, b, a]) {
      await recordMemberEvent(env.DB, {
        type: 'tag_added',
        memberId,
        payload: { tagId: newId('tag') },
      });
    }
    await fanOutWebhooks(h.env);
    expect((await deliveriesOf(endpoint.id)).map((d) => d.member_id).sort()).toEqual([a, b].sort());
  });

  it('bounds the deliveries one run writes, and still writes each one exactly once', async () => {
    const seed = await seedChannel();
    const endpoints: { id: string }[] = [];
    for (let i = 0; i < 10; i++) {
      endpoints.push(await makeEndpoint(seed, { events: ['member.updated', 'roster.subscribed'] }));
    }
    const h = harness();
    await fanOutWebhooks(h.env);
    // Counts the delivery inserts each run sends to D1.
    const insertStatements = new WeakSet<D1PreparedStatement>();
    let inserts = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare')
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes('INSERT INTO webhook_deliveries')) return statement;
            const bind = statement.bind.bind(statement);
            statement.bind = (...values: unknown[]) => {
              const bound = bind(...values);
              insertStatements.add(bound);
              return bound;
            };
            return statement;
          };
        if (key === 'batch')
          return (statements: D1PreparedStatement[]) => {
            inserts += statements.filter((s) => insertStatements.has(s)).length;
            return target.batch(statements);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const bounded = { ...h.env, DB: db };

    // A bulk tag on 20 Members (one event each) and 5 Roster joins (two events each).
    for (let i = 0; i < 20; i++) {
      await recordMemberEvent(env.DB, {
        type: 'tag_added',
        memberId: await addMember(seed.channelId, email()),
        payload: { tagId: newId('tag') },
      });
    }
    for (let i = 0; i < 5; i++) {
      await recordMemberEvent(env.DB, {
        type: 'roster_joined',
        memberId: await addMember(seed.channelId, email()),
        payload: { rosterId: newId('roster'), source: 'api' },
      });
    }
    const expected = endpoints.length * (20 + 5 * 2);

    const limit = 25;
    let total = 0;
    let runs = 0;
    for (; runs < 50; runs++) {
      inserts = 0;
      const created = await fanOutWebhooks(bounded, Date.now(), {
        perRun: limit,
        perWorkspace: limit,
      });
      expect(inserts).toBeLessThanOrEqual(limit);
      total += created;
      if (!created) break;
    }
    expect(runs).toBeGreaterThan(expected / limit);
    expect(total).toBe(expected);
    let rows = 0;
    for (const endpoint of endpoints) {
      const deliveries = await deliveriesOf(endpoint.id);
      expect(new Set(deliveries.map((d) => d.event_id)).size).toBe(deliveries.length);
      rows += deliveries.length;
    }
    expect(rows).toBe(expected);
    expect(new Set(h.queue.messages.map((m) => m.deliveryId)).size).toBe(expected);
  });

  /** `n` dispatch.scheduled events of one workspace in the outbox, written in one batch. */
  async function outboxEvents(workspaceId: string, n: number): Promise<number[]> {
    const at = Date.now();
    const statements = [];
    for (let i = 0; i < n; i++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
           VALUES (?1, NULL, NULL, 'dispatch.scheduled', ?2, ?3) RETURNING seq`,
        ).bind(workspaceId, JSON.stringify({ id: `dp_${i}` }), at),
      );
    }
    const results = await env.DB.batch<{ seq: number }>(statements);
    return results.map((r) => r.results[0]!.seq);
  }

  /** Keeps a test's pending deliveries out of the sweep tests further down. */
  async function forgetDeliveries(...workspaceIds: string[]): Promise<void> {
    await env.DB.prepare(
      'DELETE FROM webhook_deliveries WHERE workspace_id IN (SELECT value FROM json_each(?1))',
    )
      .bind(JSON.stringify(workspaceIds))
      .run();
  }

  async function drainFanOut(wenv: WebhooksEnv): Promise<void> {
    for (let i = 0; i < 100 && (await fanOutWebhooks(wenv)); i++) {
      // Until nothing is left.
    }
  }

  it('lets other workspaces through while one works off a large backlog', async () => {
    const big = await seedChannel();
    const small = await seedChannel();
    const bigEndpoints = [
      await makeEndpoint(big, { events: ['dispatch.scheduled'] }),
      await makeEndpoint(big, { events: ['dispatch.scheduled'] }),
    ];
    const smallEndpoint = await makeEndpoint(small, { events: ['dispatch.scheduled'] });
    const h = harness();
    await drainFanOut(h.env);
    // A backlog of 3,000 deliveries, then one event of another workspace.
    const backlog = await outboxEvents(big.workspaceId, 1500);
    const [later] = await outboxEvents(small.workspaceId, 1);

    const first = await fanOutWebhooks(h.env);
    expect(first).toBeLessThanOrEqual(WEBHOOK_FANOUT_MAX_DELIVERIES);
    expect(await deliveriesOf(smallEndpoint.id)).toHaveLength(1);
    // The big workspace keeps its place and catches up in the same run with what is left.
    expect(await deliveriesOf(bigEndpoints[0]!.id)).toHaveLength(1500);

    // A new event of the big workspace after the catch-up released it.
    const [next] = await outboxEvents(big.workspaceId, 1);
    await drainFanOut(h.env);
    expect(
      await count("SELECT count(*) AS n FROM event_cursors WHERE name LIKE 'webhooks:%:held:%'"),
    ).toBe(0);
    const order = new Map<string, number>();
    for (const seq of [...backlog, later!, next!]) {
      order.set(await webhookEventId('platform_events', seq), seq);
    }
    // Every endpoint got each of its events once, created in seq order.
    for (const endpoint of [...bigEndpoints, smallEndpoint]) {
      const rows = await deliveriesOf(endpoint.id);
      expect(new Set(rows.map((d) => d.event_id)).size).toBe(rows.length);
      const eventOf = new Map(rows.map((d) => [d.id, d.event_id]));
      const seqs = h.queue.messages
        .filter((m) => eventOf.has(m.deliveryId))
        .map((m) => order.get(eventOf.get(m.deliveryId)!)!);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(seqs).toHaveLength(endpoint === smallEndpoint ? 1 : 1501);
    }
    await forgetDeliveries(big.workspaceId, small.workspaceId);
  });

  it('holds a workspace past its share and catches it up in seq order across runs', async () => {
    const big = await seedChannel();
    const small = await seedChannel();
    const bigEndpoint = await makeEndpoint(big, { events: ['dispatch.scheduled'] });
    const smallEndpoint = await makeEndpoint(small, { events: ['dispatch.scheduled'] });
    const h = harness();
    await drainFanOut(h.env);
    const limits = { perRun: 8, perWorkspace: 4 };
    const backlog = await outboxEvents(big.workspaceId, 20);
    await outboxEvents(small.workspaceId, 1);

    // Run 1: the big workspace takes its share, is held, and the other workspace goes through.
    expect(await fanOutWebhooks(h.env, Date.now(), limits)).toBeLessThanOrEqual(limits.perRun);
    expect(await deliveriesOf(smallEndpoint.id)).toHaveLength(1);
    const held = await one<{ value: number }>(
      'SELECT value FROM event_cursors WHERE name = ?1',
      `webhooks:platform_events:held:${big.workspaceId}`,
    );
    expect(held!.value).toBeGreaterThanOrEqual(backlog[3]!);
    expect(held!.value).toBeLessThan(backlog.at(-1)!);
    // A crash before the held cursor moved: the re-read writes nothing twice.
    await env.DB.prepare('UPDATE event_cursors SET value = value - 2 WHERE name = ?1')
      .bind(`webhooks:platform_events:held:${big.workspaceId}`)
      .run();

    // New events of the other workspace keep going through while the backlog is worked off.
    await outboxEvents(small.workspaceId, 1);
    for (let run = 0; run < 10; run++) {
      expect(await fanOutWebhooks(h.env, Date.now(), limits)).toBeLessThanOrEqual(limits.perRun);
    }
    expect(await deliveriesOf(smallEndpoint.id)).toHaveLength(2);
    const rows = await deliveriesOf(bigEndpoint.id);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((d) => d.event_id)).size).toBe(20);
    const ids = new Map(rows.map((d) => [d.id, d.event_id]));
    const sent = h.queue.messages
      .filter((m) => ids.has(m.deliveryId))
      .map((m) => ids.get(m.deliveryId));
    const expected = [];
    for (const seq of backlog) expected.push(await webhookEventId('platform_events', seq));
    expect(sent).toEqual(expected);
    expect(
      await count("SELECT count(*) AS n FROM event_cursors WHERE name LIKE 'webhooks:%:held:%'"),
    ).toBe(0);
    await forgetDeliveries(big.workspaceId, small.workspaceId);
  });

  it('keeps each run within its query budget under a large backlog with held workspaces', async () => {
    const big = [await seedChannel(), await seedChannel()];
    const small = await seedChannel();
    const endpoints: { seed: { workspaceId: string }; id: string }[] = [];
    for (const seed of [big[0]!, big[0]!, big[1]!, big[1]!, small]) {
      endpoints.push({ seed, ...(await makeEndpoint(seed, { events: ['dispatch.scheduled'] })) });
    }
    const h = harness();
    await drainFanOut(h.env);
    const { db, counter } = countQueries(env.DB);
    const metered = { ...h.env, DB: db };
    const seqs = new Map<string, number[]>();
    for (const seed of [...big, small, ...big, small]) {
      const n = seed === small ? 3 : 700;
      seqs.set(seed.workspaceId, [
        ...(seqs.get(seed.workspaceId) ?? []),
        ...(await outboxEvents(seed.workspaceId, n)),
      ]);
    }
    const limits = { perWorkspace: 300, queries: 60 };
    let runs = 0;
    for (; runs < 50; runs++) {
      counter.queries = 0;
      const created = await fanOutWebhooks(metered, Date.now(), limits);
      expect(counter.queries).toBeLessThanOrEqual(limits.queries);
      if (!created) break;
    }
    expect(runs).toBeGreaterThan(1);
    expect(
      await count("SELECT count(*) AS n FROM event_cursors WHERE name LIKE 'webhooks:%:held:%'"),
    ).toBe(0);
    // Every endpoint still got each of its events once, created in seq order.
    for (const endpoint of endpoints) {
      const rows = await deliveriesOf(endpoint.id);
      const eventOf = new Map(rows.map((d) => [d.id, d.event_id]));
      const sent = h.queue.messages
        .filter((m) => eventOf.has(m.deliveryId))
        .map((m) => eventOf.get(m.deliveryId));
      const expected = [];
      for (const seq of seqs.get(endpoint.seed.workspaceId)!) {
        expected.push(await webhookEventId('platform_events', seq));
      }
      expect(sent).toEqual(expected);
    }
    await forgetDeliveries(...[...big, small].map((seed) => seed.workspaceId));
  });

  const heldName = (workspaceId: string) => `webhooks:platform_events:held:${workspaceId}`;
  const setCursor = (name: string, value: number) =>
    env.DB.prepare(
      `INSERT INTO event_cursors (name, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    )
      .bind(name, value, Date.now())
      .run();
  const heldValue = async (workspaceId: string) =>
    (
      await one<{ value: number }>(
        'SELECT value FROM event_cursors WHERE name = ?1',
        heldName(workspaceId),
      )
    )?.value ?? null;
  /** The event ids of an endpoint's deliveries, in the order they were created (queued). */
  async function sentTo(h: ReturnType<typeof harness>, endpointId: string) {
    const eventOf = new Map((await deliveriesOf(endpointId)).map((d) => [d.id, d.event_id]));
    return h.queue.messages
      .filter((m) => eventOf.has(m.deliveryId))
      .map((m) => eventOf.get(m.deliveryId));
  }
  const eventIds = (seqs: readonly number[]) =>
    Promise.all(seqs.map((seq) => webhookEventId('platform_events', seq)));

  it('reads the held workspaces again for each shared page, so overlapping runs keep seq order', async () => {
    const other = await seedChannel();
    const held = await seedChannel();
    const endpoint = await makeEndpoint(held, { events: ['dispatch.scheduled'] });
    const h = harness();
    await drainFanOut(h.env);
    // A full page of events no endpoint listens to, then the held workspace's.
    await outboxEvents(other.workspaceId, WEBHOOK_FANOUT_PAGE);
    const seqs = await outboxEvents(held.workspaceId, 6);
    // Between this run's pages, an overlapping run holds the workspace (its first two events
    // written) and moves the shared cursor past two more.
    let overlapped = false;
    const db = aroundBatches(env.DB, {
      after: async () => {
        if (overlapped) return;
        overlapped = true;
        await setCursor(heldName(held.workspaceId), seqs[1]!);
        await setCursor(WEBHOOK_CURSORS.platform_events, seqs[3]!);
      },
    });
    await fanOutWebhooks({ ...h.env, DB: db });
    expect(overlapped).toBe(true);
    await drainFanOut(h.env);
    expect(await sentTo(h, endpoint.id)).toEqual(await eventIds(seqs.slice(2)));
    expect(await heldValue(held.workspaceId)).toBeNull();
    await forgetDeliveries(held.workspaceId);
  });

  it('keeps a workspace held when the shared cursor moves on during its catch-up', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed, { events: ['dispatch.scheduled'] });
    const h = harness();
    await drainFanOut(h.env);
    // Held before its first event; the shared cursor has gone past all three.
    const seqs = await outboxEvents(seed.workspaceId, 3);
    await setCursor(heldName(seed.workspaceId), seqs[0]! - 1);
    await setCursor(WEBHOOK_CURSORS.platform_events, seqs[2]!);
    // While the catch-up writes up to the shared cursor it read, an overlapping run's shared
    // pass moves that cursor past a new event of the held workspace.
    let later: number | undefined;
    const db = aroundBatches(env.DB, {
      before: async (sql) => {
        if (later || !sql.some((q) => q.includes('AND value >= (SELECT value'))) return;
        [later] = await outboxEvents(seed.workspaceId, 1);
        await setCursor(WEBHOOK_CURSORS.platform_events, later!);
      },
    });
    await fanOutWebhooks({ ...h.env, DB: db });
    expect(later).toBeDefined();
    // Not released: the event the shared pass skipped is still to be caught up.
    expect(await heldValue(seed.workspaceId)).toBe(seqs[2]);
    await drainFanOut(h.env);
    expect(await heldValue(seed.workspaceId)).toBeNull();
    expect(await sentTo(h, endpoint.id)).toEqual(await eventIds([...seqs, later!]));
    await forgetDeliveries(seed.workspaceId);
  });

  it('holds a workspace again when an overlapping run released it while a page skipped it', async () => {
    const held = await seedChannel();
    const other = await seedChannel();
    const heldEndpoint = await makeEndpoint(held, { events: ['dispatch.scheduled'] });
    const otherEndpoint = await makeEndpoint(other, { events: ['dispatch.scheduled'] });
    const h = harness();
    await drainFanOut(h.env);
    // Held and caught up: its cursor is at the shared one.
    const at = (await one<{ value: number }>(
      'SELECT value FROM event_cursors WHERE name = ?1',
      WEBHOOK_CURSORS.platform_events,
    ))!.value;
    await setCursor(heldName(held.workspaceId), at);
    const [mine] = await outboxEvents(held.workspaceId, 1);
    const [theirs] = await outboxEvents(other.workspaceId, 1);
    // The page skips the held workspace's event; an overlapping run's catch-up releases it just
    // before the page is written, and this run dies right after.
    const db = aroundBatches(env.DB, {
      before: async (sql) => {
        if (sql.some((q) => q.includes('json_each(?2) j WHERE 1'))) {
          await env.DB.prepare('DELETE FROM event_cursors WHERE name = ?1')
            .bind(heldName(held.workspaceId))
            .run();
        }
      },
      after: (sql) => {
        if (sql.some((q) => q.includes('json_each(?2) j WHERE 1'))) throw new Error('died');
      },
    });
    await expect(fanOutWebhooks({ ...h.env, DB: db })).rejects.toThrow('died');
    // Held again where this run read it, so the skipped event is caught up, not lost.
    expect(await heldValue(held.workspaceId)).toBe(at);
    await drainFanOut(h.env);
    expect(await heldValue(held.workspaceId)).toBeNull();
    expect(await sentTo(h, heldEndpoint.id)).toEqual(await eventIds([mine!]));
    // Written by the run that died (not queued: the sweep picks it up).
    expect((await deliveriesOf(otherEndpoint.id)).map((d) => d.event_id)).toEqual(
      await eventIds([theirs!]),
    );
    await forgetDeliveries(held.workspaceId, other.workspaceId);
  });

  it('keeps the outbox rows a held workspace has not been fanned out past', async () => {
    const seed = await seedChannel();
    const h = harness();
    await drainFanOut(h.env);
    const old = Date.now() - WEBHOOK_RETENTION_MS - HOUR;
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      await recordPlatformEvent(
        env.DB,
        { type: 'dispatch.sent', workspaceId: seed.workspaceId, payload: { i } },
        old,
      );
      seqs.push((await one<{ seq: number }>('SELECT max(seq) AS seq FROM platform_events'))!.seq);
    }
    await drainFanOut(h.env);
    // The shared cursor is past all three; the held workspace only past the first.
    await setCursor(heldName(seed.workspaceId), seqs[0]!);
    const left = () =>
      env.DB.prepare('SELECT seq FROM platform_events WHERE workspace_id = ?1 ORDER BY seq')
        .bind(seed.workspaceId)
        .all<{ seq: number }>()
        .then((r) => r.results.map((row) => row.seq));
    await pruneWebhooks(env.DB);
    expect(await left()).toEqual(seqs.slice(1));
    // Released (caught up): the rest go too.
    await env.DB.prepare('DELETE FROM event_cursors WHERE name = ?1')
      .bind(heldName(seed.workspaceId))
      .run();
    await pruneWebhooks(env.DB);
    expect(await left()).toEqual([]);
  });

  it('sends roster.subscribed and roster.unsubscribed per change, and member.updated as well', async () => {
    const seed = await seedChannel();
    const rosterOnly = await makeEndpoint(seed, {
      events: ['roster.subscribed', 'roster.unsubscribed'],
    });
    const updatedOnly = await makeEndpoint(seed, { events: ['member.updated'] });
    const h = harness();
    await fanOutWebhooks(h.env);
    const rosterId = newId('roster');
    await env.DB.prepare(
      "INSERT INTO rosters (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Deals', ?3, ?3)",
    )
      .bind(rosterId, seed.channelId, Date.now())
      .run();
    const member = await addMember(seed.channelId, email());
    await applyRosterChanges(env.DB, [
      { rosterId, memberId: member, status: 'subscribed', source: 'api' },
    ]);
    // Joining again changes nothing, so it is not announced.
    await applyRosterChanges(env.DB, [
      { rosterId, memberId: member, status: 'subscribed', source: 'api' },
    ]);
    await applyRosterChanges(env.DB, [
      { rosterId, memberId: member, status: 'unsubscribed', source: 'unsubscribe' },
    ]);
    await fanOutWebhooks(h.env);

    const rosterDeliveries = (await deliveriesOf(rosterOnly.id)).sort((a, b) =>
      a.event_type.localeCompare(b.event_type),
    );
    expect(
      rosterDeliveries.map((d) => {
        const envelope = JSON.parse(d.payload_json) as WebhookEnvelope;
        return [envelope.type, envelope.data.rosterId, envelope.data.source];
      }),
    ).toEqual([
      ['roster.subscribed', rosterId, 'api'],
      ['roster.unsubscribed', rosterId, 'unsubscribe'],
    ]);
    const envelope = JSON.parse(rosterDeliveries[0]!.payload_json) as WebhookEnvelope;
    expect(envelope).toMatchObject({
      channelId: seed.channelId,
      data: { member: { id: member, status: 'active' } },
    });
    expect(rosterDeliveries[0]!.member_id).toBe(member);
    // Both changes in one page are still one member.updated, with an id of its own.
    const updated = await deliveriesOf(updatedOnly.id);
    expect(updated).toHaveLength(1);
    expect(rosterDeliveries.map((d) => d.event_id)).not.toContain(updated[0]!.event_id);
    expect(new Set(rosterDeliveries.map((d) => d.event_id)).size).toBe(2);
  });

  it("sends nothing about a deleted Channel's subscribers except that they were deleted", async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    await fanOutWebhooks(h.env); // drain what earlier tests left
    const member = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'form', status: 'pending' },
    });
    // Fanned out while the Channel was live, attempted after it was deleted.
    await fanOutWebhooks(h.env);
    const [queued] = await deliveriesOf(endpoint.id);
    expect(queued!.event_type).toBe('member.created');

    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), seed.channelId)
      .run();
    await recordMemberEvent(env.DB, {
      type: 'confirmed',
      memberId: member,
      payload: { method: 'double_opt_in' },
    });
    await recordPlatformEvent(env.DB, {
      type: 'member.unsubscribed',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberId: member,
      payload: {},
    });
    await recordPlatformEvent(env.DB, {
      type: 'member.deleted',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberId: member,
      payload: { id: member },
    });
    await fanOutWebhooks(h.env);
    expect((await deliveriesOf(endpoint.id)).map((d) => d.event_type).sort()).toEqual([
      'member.created',
      'member.deleted',
    ]);
    expect(await deliverWebhook(h.env, queued!.id)).toBe('canceled');
    expect((await delivery(queued!.id)).error).toBe('The publication was deleted.');
  });

  it('skips events from before the endpoint existed', async () => {
    const seed = await seedChannel();
    const h = harness();
    await fanOutWebhooks(h.env);
    const member = await addMember(seed.channelId, email());
    await recordMemberEvent(
      env.DB,
      { type: 'confirmed', memberId: member, payload: { method: 'single_opt_in' } },
      Date.now() - 60_000,
    );
    const endpoint = await makeEndpoint(seed, { createdAt: Date.now() - 1000 });
    await fanOutWebhooks(h.env);
    expect(await deliveriesOf(endpoint.id)).toEqual([]);
  });

  it('fans out the platform_events outbox, wrapping and attaching data per type', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    await fanOutWebhooks(h.env);
    const member = await addMember(seed.channelId, email(), { status: 'unsubscribed' });
    await recordPlatformEvent(env.DB, {
      type: 'dispatch.scheduled',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      payload: { id: 'dp_x', subject: 'Hello' },
    });
    await recordPlatformEvent(env.DB, {
      type: 'member.unsubscribed',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberId: member,
      payload: {},
    });
    await recordMemberEvent(env.DB, {
      type: 'level_purchased',
      memberId: member,
      payload: { levelId: 'lv_1', source: 'checkout' },
    });
    await fanOutWebhooks(h.env);
    const byType = Object.fromEntries(
      (await deliveriesOf(endpoint.id)).map((d) => [
        d.event_type,
        (JSON.parse(d.payload_json) as WebhookEnvelope).data,
      ]),
    );
    expect(byType['dispatch.scheduled']).toEqual({ id: 'dp_x', subject: 'Hello' });
    expect(byType['member.unsubscribed']).toMatchObject({ id: member, status: 'unsubscribed' });
    expect(byType['level.purchased']).toMatchObject({
      member: { id: member },
      levelId: 'lv_1',
      source: 'checkout',
    });
  });
});

describe('delivery', () => {
  async function oneDelivery(fetcher: typeof fetch, endpointOptions = {}) {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed, endpointOptions);
    const h = harness(fetcher);
    const id = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    // A real (non-test) delivery: retries and failures count.
    await env.DB.prepare('UPDATE webhook_deliveries SET test = 0 WHERE id = ?1').bind(id).run();
    return { seed, endpoint, h, id };
  }

  it('POSTs the signed envelope with the documented headers and records the response', async () => {
    const r = receiver(() => new Response('x'.repeat(5000), { status: 201 }));
    const { endpoint, h, id } = await oneDelivery(r.fetcher);
    const now = Date.now();
    expect(await deliverWebhook(h.env, id, now)).toBe('succeeded');
    const [request] = r.requests;
    const row = await delivery(id);
    expect(request!.url).toBe('https://hooks.example.com/in');
    expect(request!.redirect).toBe('manual');
    expect(request!.body).toBe(row.payload_json);
    expect(request!.headers.get('content-type')).toBe('application/json');
    expect(request!.headers.get('user-agent')).toBe('Swarm-Webhooks/1');
    expect(request!.headers.get('swarm-event-id')).toBe(row.event_id);
    expect(request!.headers.get('swarm-event-type')).toBe('member.created');
    const signature = request!.headers.get('swarm-signature')!;
    expect(
      await verifySwarmSignature(
        endpoint.secret,
        signature,
        request!.body,
        300,
        Math.floor(now / 1000),
      ),
    ).toBe(true);
    expect(row).toMatchObject({ status: 'succeeded', attempts: 1, response_status: 201 });
    expect(row.response_excerpt).toHaveLength(1024);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(
      await count('SELECT count(*) AS n FROM webhook_attempts WHERE delivery_id = ?1', id),
    ).toBe(1);
    // A second message for the same delivery sends nothing.
    expect(await deliverWebhook(h.env, id, now)).toBe('skipped');
    expect(r.requests).toHaveLength(1);
  });

  it('signs with both secrets while a rotation overlaps', async () => {
    const r = receiver();
    const { endpoint, h, id } = await oneDelivery(r.fetcher);
    const previous = newWebhookSecret();
    await env.DB.prepare(
      'UPDATE webhook_endpoints SET previous_secret_enc = ?1, previous_expires_at = ?2 WHERE id = ?3',
    )
      .bind(await encrypt(keys(), previous), Date.now() + HOUR, endpoint.id)
      .run();
    const now = Date.now();
    await deliverWebhook(h.env, id, now);
    const signature = r.requests[0]!.headers.get('swarm-signature')!;
    expect(signature.match(/v1=/g)).toHaveLength(2);
    for (const secret of [endpoint.secret, previous]) {
      expect(
        await verifySwarmSignature(
          secret,
          signature,
          r.requests[0]!.body,
          300,
          Math.floor(now / 1000),
        ),
      ).toBe(true);
    }
  });

  it('retries on the documented schedule, then fails; redirects count as failures', async () => {
    let status = 302;
    const r = receiver(
      () => new Response(null, { status, headers: { location: 'https://x.example' } }),
    );
    const { h, id, endpoint } = await oneDelivery(r.fetcher);
    let now = Date.now();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const outcome = await deliverWebhook(h.env, id, now);
      const row = await delivery(id);
      expect(row.attempts).toBe(attempt);
      if (attempt === 1) expect(row.response_status).toBe(302);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(outcome).toBe('retrying');
        expect(row.status).toBe('retrying');
        waits.push((row.next_attempt_at! - now) / 1000);
        now = row.next_attempt_at!;
      } else {
        expect(outcome).toBe('failed');
        expect(row).toMatchObject({
          status: 'failed',
          next_attempt_at: null,
          response_status: 500,
        });
      }
      status = 500;
    }
    expect(waits).toEqual(
      Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) => webhookBackoffSeconds(i + 1)),
    );
    // Each retry was queued with its delay (all within the queue's 12 hours).
    expect(h.queue.messages.slice(1).map((m) => m.delaySeconds)).toEqual(waits);
    expect(r.requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect((await endpointRow(endpoint.id))!.failure_count).toBe(WEBHOOK_MAX_ATTEMPTS);
  });

  it('a timeout or network error is a failure with a message', async () => {
    const r = receiver(() => {
      throw new TypeError('connection refused');
    });
    const { h, id } = await oneDelivery(r.fetcher);
    expect(await deliverWebhook(h.env, id)).toBe('retrying');
    expect((await delivery(id)).error).toMatch(/could not be reached: connection refused/);
  });

  it('a success resets the failure count', async () => {
    const r = receiver((n) => new Response(null, { status: n === 1 ? 500 : 200 }));
    const { h, id, endpoint } = await oneDelivery(r.fetcher);
    const now = Date.now();
    await deliverWebhook(h.env, id, now);
    expect(await endpointRow(endpoint.id)).toMatchObject({
      failure_count: 1,
      first_failure_at: now,
    });
    await deliverWebhook(h.env, id, (await delivery(id)).next_attempt_at!);
    expect(await endpointRow(endpoint.id)).toMatchObject({
      failure_count: 0,
      first_failure_at: null,
    });
  });

  it('cancels deliveries to a paused endpoint, but sends test events', async () => {
    const r = receiver();
    const { h, id, endpoint, seed } = await oneDelivery(r.fetcher, { status: 'paused' });
    expect(await deliverWebhook(h.env, id)).toBe('canceled');
    expect((await delivery(id)).status).toBe('canceled');
    const test = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'dispatch.sent',
    );
    expect(await deliverWebhook(h.env, test)).toBe('succeeded');
  });

  it('turns an endpoint off after 72 hours of failures and emails owners and admins', async () => {
    const r = receiver(() => new Response('down', { status: 503 }));
    const { h, id, endpoint, seed } = await oneDelivery(r.fetcher);
    const now = Date.now();
    const operator = newId('operator');
    const viewer = newId('operator');
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
      ).bind(operator, 'owner@example.com', now),
      env.DB.prepare(
        'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
      ).bind(viewer, `viewer-${crypto.randomUUID()}@example.com`, now),
      env.DB.prepare(
        "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', ?4, ?4)",
      ).bind(newId('seat'), seed.workspaceId, operator, now),
      env.DB.prepare(
        "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'viewer', ?4, ?4)",
      ).bind(newId('seat'), seed.workspaceId, viewer, now),
    ]);
    // Another open delivery that the disable cancels.
    const other = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.updated',
    );
    await env.DB.prepare('UPDATE webhook_deliveries SET test = 0 WHERE id = ?1').bind(other).run();

    // Failing, but not for long enough yet.
    await env.DB.prepare(
      'UPDATE webhook_endpoints SET failure_count = 40, first_failure_at = ?1 WHERE id = ?2',
    )
      .bind(now - WEBHOOK_DISABLE_AFTER_MS + HOUR, endpoint.id)
      .run();
    expect(await deliverWebhook(h.env, id, now)).toBe('retrying');
    expect((await endpointRow(endpoint.id))!.status).toBe('active');
    expect(h.mail.sent).toHaveLength(0);

    expect(await deliverWebhook(h.env, id, now + 2 * HOUR)).toBe('disabled');
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'Every delivery failed for 72 hours.',
    });
    expect((await delivery(other)).status).toBe('canceled');
    // The owner and the admin standing behind the endpoint; never the viewer.
    expect(h.mail.sent.map((m) => m.to)).toContain('owner@example.com');
    expect(h.mail.sent).toHaveLength(2);
    expect(h.mail.sent.every((m) => !m.to.startsWith('viewer-'))).toBe(true);
    expect(h.mail.sent.find((m) => m.to === 'owner@example.com')).toMatchObject({
      category: 'webhook_disabled',
      subject: 'A webhook endpoint was turned off',
    });
    expect(h.mail.sent[0]!.text).toContain('https://hooks.example.com/in');
    // Signed with the product's name on its own line, in plain words.
    expect(h.mail.sent[0]!.text.endsWith('\n\nSwarm')).toBe(true);
    expect(h.mail.sent[0]!.text).not.toContain('\u2014');
    // Test events never count towards it.
    await env.DB.prepare(
      "UPDATE webhook_endpoints SET status = 'active', failure_count = 0, first_failure_at = ?1 WHERE id = ?2",
    )
      .bind(now - 100 * HOUR, endpoint.id)
      .run();
    const test = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    await deliverWebhook(h.env, test, now);
    expect((await endpointRow(endpoint.id))!.status).toBe('active');
  });

  it("refuses the install's own hosts at attempt time, as the worker's env names them", async () => {
    const r = receiver();
    const { h, id } = await oneDelivery(r.fetcher, { url: 'https://api.own.swarm.example/in' });
    // The worker points the guard at its own hosts when it reads its env.
    parseJobsEnv({ ...env, OUTBOUND_BLOCKED_HOSTS: 'own.swarm.example' });
    try {
      expect(await deliverWebhook(h.env, id)).toBe('failed');
      expect(r.requests).toHaveLength(0);
      expect((await delivery(id)).error).toMatch(/refused/);
    } finally {
      setOutboundPlatformHosts([]);
    }
  });

  it('charges waiting to the workspace, slow successes included, and holds it past its share', async () => {
    // A slow endpoint that does answer 2xx.
    const slow = receiver(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return new Response('ok');
    });
    const a = await oneDelivery(slow.fetcher);
    const now = Date.now();
    expect(await deliverWebhook(a.h.env, a.id, now)).toBe('succeeded');
    const scope = `outbound_wait:${a.seed.workspaceId}`;
    const spent = await env.DB.prepare('SELECT count FROM usage_windows WHERE scope = ?1')
      .bind(scope)
      .first<{ count: number }>();
    expect(spent!.count).toBeGreaterThanOrEqual(40);
    // Past the share: A's next delivery waits for the next minute, without using an attempt.
    await env.DB.prepare('UPDATE usage_windows SET count = ?2 WHERE scope = ?1')
      .bind(scope, OUTBOUND_WAIT_MS_PER_MINUTE)
      .run();
    const endpoint = await makeEndpoint(a.seed);
    const nextId = await sendTestWebhook(
      a.h.env,
      { id: endpoint.id, workspace_id: a.seed.workspaceId, channel_id: null },
      'member.created',
    );
    await env.DB.prepare('UPDATE webhook_deliveries SET test = 0 WHERE id = ?1').bind(nextId).run();
    const before = slow.requests.length;
    expect(await deliverWebhook(a.h.env, nextId, now)).toBe('deferred');
    expect(slow.requests).toHaveLength(before);
    const row = await delivery(nextId);
    expect(row).toMatchObject({ attempts: 0 });
    expect(Number(row.next_attempt_at)).toBeGreaterThan(now);
    expect(a.h.queue.messages.some((m) => m.deliveryId === nextId)).toBe(true);
    // Another workspace is not held.
    const fast = receiver();
    const b = await oneDelivery(fast.fetcher);
    expect(await deliverWebhook(b.h.env, b.id, now)).toBe('succeeded');
    expect(fast.requests).toHaveLength(1);
  });

  it('keeps at most a few deliveries in flight to one endpoint, deferring the rest without an attempt', async () => {
    let inFlight = 0;
    let most = 0;
    const slow = receiver(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return new Response('ok');
    });
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness(slow.fetcher);
    const ids: string[] = [];
    for (let i = 0; i < WEBHOOK_ENDPOINT_MAX_CONCURRENT + 2; i++) {
      ids.push(
        await sendTestWebhook(
          h.env,
          { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
          'member.created',
        ),
      );
    }
    const now = Date.now();
    const outcomes = await Promise.all(ids.map((id) => deliverWebhook(h.env, id, now)));
    expect(most).toBeLessThanOrEqual(WEBHOOK_ENDPOINT_MAX_CONCURRENT);
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(WEBHOOK_ENDPOINT_MAX_CONCURRENT);
    const deferred = ids.filter((_, i) => outcomes[i] === 'deferred');
    expect(deferred).toHaveLength(2);
    expect(slow.requests).toHaveLength(WEBHOOK_ENDPOINT_MAX_CONCURRENT);
    for (const id of deferred) {
      const row = await delivery(id);
      expect(row).toMatchObject({ attempts: 0, status: 'pending' });
      expect(Number(row.next_attempt_at)).toBe(now + WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS * 1000);
      expect(h.queue.messages).toContainEqual({
        deliveryId: id,
        delaySeconds: WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS,
      });
    }
    // Every place was given back: the deferred ones go when they are due.
    expect(
      await count(
        'SELECT count(*) AS n FROM webhook_endpoint_leases WHERE endpoint_id = ?1',
        endpoint.id,
      ),
    ).toBe(0);
    const later = now + WEBHOOK_ENDPOINT_BUSY_RETRY_SECONDS * 1000;
    for (const id of deferred) expect(await deliverWebhook(h.env, id, later)).toBe('succeeded');
  });

  it('another endpoint is not held by a busy one', async () => {
    const seed = await seedChannel();
    const busy = await makeEndpoint(seed);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: WEBHOOK_ENDPOINT_MAX_CONCURRENT }, () =>
        env.DB.prepare(
          'INSERT INTO webhook_endpoint_leases (id, endpoint_id, expires_at) VALUES (?1, ?2, ?3)',
        ).bind(crypto.randomUUID(), busy.id, now + 60_000),
      ),
    );
    const r = receiver();
    const h = harness(r.fetcher);
    const held = await sendTestWebhook(
      h.env,
      { id: busy.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    expect(await deliverWebhook(h.env, held, now)).toBe('deferred');
    const free = await makeEndpoint(seed);
    const other = await sendTestWebhook(
      h.env,
      { id: free.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    expect(await deliverWebhook(h.env, other, now)).toBe('succeeded');
    // Leases a dead worker left behind end by themselves.
    expect(await deliverWebhook(h.env, held, now + 61_000)).toBe('succeeded');
  });

  it('refuses a URL that is no longer allowed without calling it', async () => {
    const r = receiver();
    const { h, id } = await oneDelivery(r.fetcher, { url: 'https://10.0.0.1/in' });
    expect(await deliverWebhook(h.env, id)).toBe('failed');
    expect(r.requests).toHaveLength(0);
    expect((await delivery(id)).error).toMatch(/refused/);
  });
});

describe('redrive', () => {
  it('re-sends the same event id and body, and is a no-op while pending', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const r = receiver();
    const h = harness(r.fetcher);
    const id = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    await deliverWebhook(h.env, id);
    const before = await delivery(id);
    expect(before.status).toBe('succeeded');

    expect(await redriveWebhookDelivery(h.env, id)).toBe(true);
    expect((await delivery(id)).status).toBe('pending');
    // Already pending: nothing changes, nothing is queued again.
    const queued = h.queue.messages.length;
    expect(await redriveWebhookDelivery(h.env, id)).toBe(false);
    expect(h.queue.messages).toHaveLength(queued);

    await deliverWebhook(h.env, id);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]!.body).toBe(r.requests[0]!.body);
    expect(r.requests[1]!.headers.get('swarm-event-id')).toBe(before.event_id);
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('gives a redriven delivery a fresh retry budget; "failed since" is bounded by time', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness(receiver(() => new Response(null, { status: 500 })).fetcher);
    const make = async () => {
      const id = await sendTestWebhook(
        h.env,
        { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
        'member.created',
      );
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'failed', attempts = 9, next_attempt_at = NULL WHERE id = ?1",
      )
        .bind(id)
        .run();
      return id;
    };
    const old = await make();
    await env.DB.prepare('UPDATE webhook_deliveries SET created_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 10 * HOUR, old)
      .run();
    const recent = await make();
    expect(await redriveFailedWebhooks(h.env, endpoint.id, Date.now() - HOUR)).toBe(1);
    expect((await delivery(old)).status).toBe('failed');
    expect((await delivery(recent)).status).toBe('pending');
    expect(await deliverWebhook(h.env, recent)).toBe('retrying');
    expect((await delivery(recent)).attempts).toBe(10);
  });
});

describe('sweep and housekeeping', () => {
  it('re-queues overdue pending and retrying deliveries only', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    const id = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    const now = Date.now();
    h.queue.messages.length = 0;
    await sweepWebhooks(h.env, now);
    expect(h.queue.messages.map((m) => m.deliveryId)).not.toContain(id);
    await sweepWebhooks(h.env, now + WEBHOOK_SWEEP_GRACE_MS + 1000);
    expect(h.queue.messages.map((m) => m.deliveryId)).toContain(id);
  });

  it('prunes finished deliveries and passed outbox rows after 30 days', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    const finished = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    const open = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    const old = Date.now() - WEBHOOK_RETENTION_MS - HOUR;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'succeeded', updated_at = ?1 WHERE id = ?2",
      ).bind(old, finished),
      env.DB.prepare('UPDATE webhook_deliveries SET updated_at = ?1 WHERE id = ?2').bind(old, open),
    ]);
    await recordPlatformEvent(
      env.DB,
      { type: 'dispatch.sent', workspaceId: seed.workspaceId, payload: {} },
      old,
    );
    await fanOutWebhooks(h.env);
    await recordPlatformEvent(
      env.DB,
      { type: 'dispatch.sent', workspaceId: seed.workspaceId, payload: { unread: true } },
      old,
    );
    await pruneWebhooks(env.DB);
    expect(await one('SELECT id FROM webhook_deliveries WHERE id = ?1', finished)).toBeNull();
    expect(await one('SELECT id FROM webhook_deliveries WHERE id = ?1', open)).not.toBeNull();
    // The row the cursor hasn't passed is kept.
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE workspace_id = ?1 AND json_extract(payload_json, '$.unread') = 1",
        seed.workspaceId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE workspace_id = ?1 AND json_extract(payload_json, '$.unread') IS NULL",
        seed.workspaceId,
      ),
    ).toBe(0);
  });

  it('keeps an erasure until every export destination of its publication has written it', async () => {
    const seed = await seedChannel();
    const h = harness();
    const old = Date.now() - WEBHOOK_RETENTION_MS - 60_000;
    await env.DB.prepare(
      `INSERT INTO export_destinations
         (id, workspace_id, channel_id, kind, config_json, credentials_enc, cursor_json, status,
          created_at, updated_at)
       VALUES ('exp_paused', ?1, ?2, 'r2', '{}', 'sealed', '{}', 'paused', ?3, ?3)`,
    )
      .bind(seed.workspaceId, seed.channelId, old)
      .run();
    await recordPlatformEvent(
      env.DB,
      {
        type: 'member.deleted',
        workspaceId: seed.workspaceId,
        channelId: seed.channelId,
        memberId: 'mem_erased',
        payload: {},
      },
      old,
    );
    await fanOutWebhooks(h.env);
    const erasures = () =>
      count(
        "SELECT count(*) AS n FROM platform_events WHERE channel_id = ?1 AND type = 'member.deleted'",
        seed.channelId,
      );

    // Webhooks are done with it, but the paused destination has not written it yet.
    await pruneWebhooks(env.DB);
    expect(await erasures()).toBe(1);

    // Once the destination's deletions cursor passes it, it goes like any other old event.
    const seq = (await one<{ seq: number }>(
      "SELECT seq FROM platform_events WHERE channel_id = ?1 AND type = 'member.deleted'",
      seed.channelId,
    ))!.seq;
    await env.DB.prepare("UPDATE export_destinations SET cursor_json = ?1 WHERE id = 'exp_paused'")
      .bind(JSON.stringify({ deletions: seq }))
      .run();
    await pruneWebhooks(env.DB);
    expect(await erasures()).toBe(0);
  });

  it('erasure statements remove stored payloads about the Member', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const h = harness();
    await fanOutWebhooks(h.env);
    const member = await addMember(seed.channelId, email());
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'form', status: 'pending' },
    });
    await fanOutWebhooks(h.env);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
    await env.DB.batch(webhookErasureStatements(env.DB, member));
    expect(await deliveriesOf(endpoint.id)).toHaveLength(0);
  });
});

describe('the webhooks queue consumer', () => {
  it('routes webhook_delivery batches to delivery and acks them', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const r = receiver();
    useWebhookFetchForTests(r.fetcher);
    const h = harness();
    const id = await sendTestWebhook(
      h.env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    const acks: string[] = [];
    await consume(
      {
        queue: 'swarm-webhooks',
        messages: [
          {
            id: 'm1',
            timestamp: new Date(),
            attempts: 1,
            body: { type: 'webhook_delivery', deliveryId: id },
            ack: () => acks.push(id),
            retry: () => undefined,
          },
        ],
      } as unknown as MessageBatch<WebhookMessage>,
      env,
    );
    expect(acks).toEqual([id]);
    expect((await delivery(id)).status).toBe('succeeded');
    expect(r.requests).toHaveLength(1);
  });
});

describe('routing batches by queue (S04-P1-V-job-handler-review)', () => {
  const message = (id: string, body: unknown, acks: string[], retries: string[]) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => acks.push(id),
    retry: () => retries.push(id),
  });

  it('never sends a jobs batch down the webhooks path because of its first body', async () => {
    const seed = await seedChannel();
    const endpoint = await makeEndpoint(seed);
    const r = receiver();
    useWebhookFetchForTests(r.fetcher);
    const id = await sendTestWebhook(
      harness().env,
      { id: endpoint.id, workspace_id: seed.workspaceId, channel_id: null },
      'member.created',
    );
    const acks: string[] = [];
    const retries: string[] = [];
    // A forged delivery body at the head of a jobs batch, then an ordinary job.
    await consume(
      {
        queue: 'swarm-jobs',
        messages: [
          message('forged', { type: 'webhook_delivery', deliveryId: id }, acks, retries),
          message('job', { type: 'export', jobId: 'ej_missing' }, acks, retries),
        ],
      } as unknown as MessageBatch<WebhookMessage>,
      env,
    );
    expect(acks.sort()).toEqual(['forged', 'job']);
    expect(retries).toEqual([]);
    // The delivery was not sent from the jobs queue.
    expect(r.requests).toHaveLength(0);

    // On the webhooks queue, a body that is not a delivery is dropped, not run as a job.
    const more: string[] = [];
    await consume(
      {
        queue: 'swarm-staging-webhooks',
        messages: [message('job', { type: 'flow_events' }, more, retries)],
      } as unknown as MessageBatch<WebhookMessage>,
      env,
    );
    expect(more).toEqual(['job']);
    expect(retries).toEqual([]);
  });
});

describe('emission sites', () => {
  const outbox = (memberId: string, type: string) =>
    count(
      'SELECT count(*) AS n FROM platform_events WHERE member_id = ?1 AND type = ?2',
      memberId,
      type,
    );

  it('Member Center and the pending leave link emit member.unsubscribed once', async () => {
    const seed = await seedChannel();
    const active = await addMember(seed.channelId, email());
    expect(await unsubscribeMember(env.DB, active, 'too many')).toBe(true);
    expect(await unsubscribeMember(env.DB, active, null)).toBe(false);
    expect(await outbox(active, 'member.unsubscribed')).toBe(1);
    const pending = await addMember(seed.channelId, email(), { status: 'pending' });
    await leaveBeforeConfirming(env.DB, pending);
    await leaveBeforeConfirming(env.DB, pending);
    expect(await outbox(pending, 'member.unsubscribed')).toBe(1);
  });

  it('bulk unsubscribe and delete emit member.unsubscribed and member.deleted', async () => {
    const seed = await seedChannel();
    const ids = [
      await addMember(seed.channelId, email()),
      await addMember(seed.channelId, email()),
    ];
    const already = await addMember(seed.channelId, email(), { status: 'unsubscribed' });
    const job = async (action: 'unsubscribe' | 'delete') => {
      const id = newId('bulkJob');
      await env.DB.prepare(
        `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, params_json, selection_json, total, created_at)
         VALUES (?1, ?2, ?3, ?4, '{}', ?5, 0, ?6)`,
      )
        .bind(
          id,
          seed.workspaceId,
          seed.channelId,
          action,
          JSON.stringify({ memberIds: [...ids, already] }),
          Date.now(),
        )
        .run();
      return id;
    };
    const { env: jobs } = jobsEnv();
    await runBulk(jobs, await job('unsubscribe'));
    for (const id of ids) expect(await outbox(id, 'member.unsubscribed')).toBe(1);
    expect(await outbox(already, 'member.unsubscribed')).toBe(0);
    await runBulk(jobs, await job('delete'));
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE type = 'member.deleted' AND json_extract(payload_json, '$.channelId') = ?1 AND member_id IS NULL",
        seed.channelId,
      ),
    ).toBe(3);
  });

  it('a completed Flow run emits flow.completed with the run (test runs left out)', async () => {
    const seed = await seedChannel();
    const tagId = await makeTag(seed.channelId);
    const graph = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'tag', type: 'add_tag', config: { tagId } },
      ],
      edges: [{ from: 'trigger', to: 'tag' }],
    });
    const flow = await publishFlow(seed, graph);
    const member = await addMember(seed.channelId, email());
    const h = flowsHarness();
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId: member, payload: { name: 'go' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await h.drain();
    const row = await one<{ workspace_id: string; channel_id: string; payload_json: string }>(
      "SELECT workspace_id, channel_id, payload_json FROM platform_events WHERE type = 'flow.completed' AND member_id = ?1",
      member,
    );
    expect(row).toMatchObject({ workspace_id: seed.workspaceId, channel_id: seed.channelId });
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      flowId: flow.flowId,
      memberId: member,
      status: 'completed',
      test: false,
    });
  });
});

describe('the authority behind an endpoint (S04-X-V-feed-survives-authority-end, S04-X-V-grant-webhook-survives)', () => {
  /** A Member event in `seed`'s Channel, fanned out. */
  async function memberEvent(seed: { channelId: string }, h: ReturnType<typeof harness>) {
    await fanOutWebhooks(h.env); // drain what earlier tests left
    const member = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'form', status: 'active' },
    });
    await fanOutWebhooks(h.env);
  }

  /** A grant of a connected app for the workspace, live until revoked. */
  async function seedGrant(workspaceId: string, operatorId: string): Promise<string> {
    const now = Date.now();
    const appId = newId('oauthApp');
    const grantId = newId('oauthGrant');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_apps (id, workspace_id, name, client_id, redirect_uris_json, scopes_json, created_at, updated_at)
         VALUES (?1, ?2, 'Synthetic app', ?3, '["https://app.example.com/cb"]', '["webhooks:write"]', ?4, ?4)`,
      ).bind(appId, workspaceId, `client-${appId}`, now),
      env.DB.prepare(
        `INSERT INTO oauth_grants (id, app_id, workspace_id, operator_id, scopes_json, created_at)
         VALUES (?1, ?2, ?3, ?4, '["webhooks:write"]', ?5)`,
      ).bind(grantId, appId, workspaceId, operatorId, now),
    ]);
    return grantId;
  }

  it('the control endpoint receives the event', async () => {
    const seed = await seedChannel();
    const control = await makeEndpoint(seed);
    await memberEvent(seed, harness());
    expect((await deliveriesOf(control.id)).length).toBeGreaterThan(0);
  });

  it('nothing reaches an endpoint whose admin was removed or demoted, or whose Channel was deleted', async () => {
    const seed = await seedChannel();
    const removedAdmin = await seedFeedAdmin(seed.workspaceId);
    const demotedAdmin = await seedFeedAdmin(seed.workspaceId);
    const removed = await makeEndpoint(seed, { confirmedBy: removedAdmin });
    const demoted = await makeEndpoint(seed, { confirmedBy: demotedAdmin });
    const ofChannel = await makeEndpoint(seed, { channelId: seed.channelId });
    const control = await makeEndpoint(seed);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM seats WHERE operator_id = ?1').bind(removedAdmin),
      env.DB.prepare("UPDATE seats SET role = 'viewer' WHERE operator_id = ?1").bind(demotedAdmin),
    ]);
    const h = harness();
    await fanOutWebhooks(h.env);
    // Soft-deleting the Channel stops its endpoint, and its events reach no other endpoint
    // either; the Member event still happens.
    const member = await addMember(seed.channelId, email());
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), seed.channelId)
      .run();
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: member,
      payload: { source: 'form', status: 'active' },
    });
    await fanOutWebhooks(h.env);
    expect(await deliveriesOf(control.id)).toEqual([]);
    // Another publication of the workspace, still live: the control endpoint receives it.
    const live = newId('channel');
    await env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Live', ?4, ?4)",
    )
      .bind(live, seed.workspaceId, `ch-${crypto.randomUUID().slice(0, 12)}`, Date.now())
      .run();
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: await addMember(live, email()),
      payload: { source: 'form', status: 'active' },
    });
    await fanOutWebhooks(h.env);
    expect(await deliveriesOf(removed.id)).toEqual([]);
    expect(await deliveriesOf(demoted.id)).toEqual([]);
    expect(await deliveriesOf(ofChannel.id)).toEqual([]);
    expect((await deliveriesOf(control.id)).length).toBeGreaterThan(0);
    // Suspended, not deleted: the endpoints and their settings stay.
    expect((await endpointRow(removed.id))?.status).toBe('active');
  });

  it('an endpoint a grant proposed receives nothing until confirmed, and stops when the grant is revoked', async () => {
    const seed = await seedChannel();
    const admin = await seedFeedAdmin(seed.workspaceId);
    const grantId = await seedGrant(seed.workspaceId, admin);
    const proposed = await makeEndpoint(seed, {
      unconfirmed: true,
      proposedVia: { kind: 'oauth', id: grantId },
    });
    const h = harness();
    await memberEvent(seed, h);
    expect(await deliveriesOf(proposed.id)).toEqual([]);

    // An admin confirms it: it receives the next event.
    await env.DB.prepare(
      'UPDATE webhook_endpoints SET confirmed_by = ?1, confirmed_at = ?2 WHERE id = ?3',
    )
      .bind(admin, Date.now(), proposed.id)
      .run();
    await memberEvent(seed, h);
    const before = (await deliveriesOf(proposed.id)).length;
    expect(before).toBeGreaterThan(0);

    // The grant is revoked: nothing more, and a delivery already queued is canceled.
    const r = receiver();
    const queued = await deliveriesOf(proposed.id);
    await env.DB.prepare('UPDATE oauth_grants SET revoked_at = ?1 WHERE id = ?2')
      .bind(Date.now(), grantId)
      .run();
    await memberEvent(seed, h);
    expect((await deliveriesOf(proposed.id)).length).toBe(before);
    expect(await deliverWebhook(harness(r.fetcher).env, queued[0]!.id, Date.now())).toBe(
      'canceled',
    );
    expect(r.requests).toEqual([]);
  });

  it('an endpoint whose proposing API key was revoked receives nothing', async () => {
    const seed = await seedChannel();
    const keyId = newId('apiKey');
    await env.DB.prepare(
      `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, created_at, revoked_at)
       VALUES (?1, ?2, 'Key', 'pfx', ?1, '[]', ?3, ?3)`,
    )
      .bind(keyId, seed.workspaceId, Date.now())
      .run();
    const proposed = await makeEndpoint(seed, { proposedVia: { kind: 'key', id: keyId } });
    await memberEvent(seed, harness());
    expect(await deliveriesOf(proposed.id)).toEqual([]);
  });
});
