/**
 * Event Webhooks (Phase 7) for the dashboard (/api/v1, routes/webhooks.ts) and the public API
 * (/v2, v2/webhooks.ts): one implementation behind both. The caller resolves who is acting
 * (a seat with the admin role, or a principal with a webhooks scope); everything here is scoped
 * to that workspace, and to the principal's Channels when it has a Channel list.
 */
import { all, first, run, toIso } from '@swarm/db';
import {
  PLAN_LIMITS,
  WEBHOOK_EVENTS,
  idPattern,
  newId,
  type CreateWebhookEndpoint,
  type FeedSuspension,
  type Plan,
  type UpdateWebhookEndpoint,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
  type WebhookEventType,
} from '@swarm/domain';
import {
  WEBHOOK_ROTATION_OVERLAP_MS,
  feedProblemSql,
  redriveFailedWebhooks,
  redriveWebhookDelivery,
  sendTestWebhook,
  webhookEndpointUrlProblem,
  webhookHeaders,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhookQueue,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { appendAudit } from './audit';
import { env, type AppContext } from './context';
import { noticeTeam } from './team-notice';
import { apiVault, credentialOf } from './vault';

// ---- The queue (replaceable in tests) --------------------------------------------------------

let injectedQueue: WebhookQueue | undefined;

/** Tests capture WEBHOOKS_QUEUE messages here. Pass undefined to go back to the binding. */
export function useWebhooksQueueForTests(queue: WebhookQueue | undefined): void {
  injectedQueue = queue;
}

function webhooksQueue(c: AppContext): WebhookQueue {
  return injectedQueue ?? env(c).WEBHOOKS_QUEUE;
}

// ---- Who is acting ---------------------------------------------------------------------------

export interface WebhookActor {
  workspaceId: string;
  /** The operator (dashboard), or null for an API key or OAuth token. */
  operatorId: string | null;
  /** /v2: the key or grant id, recorded in the audit log and on endpoints it proposes. */
  principalId: string | null;
  /** /v2: what kind of credential principalId is. */
  principalKind: 'key' | 'oauth' | null;
  /** The dashboard: the operator's address, for the notice to the rest of the team. */
  email?: string;
  /** /v2 principals limited to some Channels; null = the whole workspace. */
  channelIds: string[] | null;
  ipPrefix: string | null;
}

async function audit(
  c: AppContext,
  actor: WebhookActor,
  action: string,
  endpointId: string,
  metadata: Record<string, unknown> = {},
) {
  await appendAudit(env(c).DB, {
    workspaceId: actor.workspaceId,
    actorId: actor.operatorId,
    action,
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    metadata: actor.principalId ? { ...metadata, via: actor.principalId } : metadata,
    ipPrefix: actor.ipPrefix,
  });
}

// ---- Mappers ---------------------------------------------------------------------------------

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

type EndpointListRow = WebhookEndpointRow & {
  last_delivery_at: number | null;
  last_delivery_status: WebhookDelivery['status'] | null;
  suspended_reason: FeedSuspension | null;
};

const ENDPOINT_COLUMNS = `e.*, ${feedProblemSql('webhook_endpoint', 'e')} AS suspended_reason,
  (SELECT d.created_at FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY d.id DESC LIMIT 1) AS last_delivery_at,
  (SELECT d.status FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY d.id DESC LIMIT 1) AS last_delivery_status`;

export function toWebhookEndpoint(row: EndpointListRow, now = Date.now()): WebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    url: row.url,
    description: row.description,
    events: JSON.parse(row.events_json) as WebhookEventType[],
    status: row.status,
    disabledReason: row.disabled_reason,
    failureCount: row.failure_count,
    firstFailureAt: iso(row.first_failure_at),
    previousSecretExpiresAt:
      row.previous_secret_enc && (row.previous_expires_at ?? 0) > now
        ? iso(row.previous_expires_at)
        : null,
    lastDeliveryAt: iso(row.last_delivery_at),
    lastDeliveryStatus: row.last_delivery_status,
    suspendedReason: row.suspended_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const toWebhookDelivery = (row: WebhookDeliveryRow): WebhookDelivery => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  status: row.status,
  test: row.test === 1,
  attempts: row.attempts,
  nextAttemptAt: row.status === 'retrying' ? iso(row.next_attempt_at) : null,
  lastAttemptAt: iso(row.last_attempt_at),
  responseStatus: row.response_status,
  latencyMs: row.latency_ms,
  error: row.error,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

// ---- Endpoints -------------------------------------------------------------------------------

const channelScope = (actor: WebhookActor) =>
  actor.channelIds ? JSON.stringify(actor.channelIds) : null;

export async function listEndpoints(
  c: AppContext,
  actor: WebhookActor,
): Promise<WebhookEndpoint[]> {
  const rows = await all<EndpointListRow>(
    env(c).DB,
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e
      WHERE e.workspace_id = ?1
        AND (?2 IS NULL OR e.channel_id IN (SELECT value FROM json_each(?2)))
      ORDER BY e.created_at`,
    actor.workspaceId,
    channelScope(actor),
  );
  const now = Date.now();
  return rows.map((row) => toWebhookEndpoint(row, now));
}

/** The endpoint, if it is in the actor's workspace (and Channels). Otherwise 404. */
export async function requireEndpoint(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
): Promise<EndpointListRow> {
  const row = await first<EndpointListRow>(
    env(c).DB,
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e
      WHERE e.id = ?1 AND e.workspace_id = ?2
        AND (?3 IS NULL OR e.channel_id IN (SELECT value FROM json_each(?3)))`,
    endpointId,
    actor.workspaceId,
    channelScope(actor),
  );
  if (!row) throw new ApiError('not_found', 'Webhook endpoint not found.');
  return row;
}

function checkUrl(c: AppContext, url: string) {
  const problem = webhookEndpointUrlProblem(url, env(c).ENVIRONMENT);
  if (problem) {
    const message = `This URL can’t be used: ${problem}.`;
    throw new ApiError('invalid_input', message, [{ path: 'url', message }]);
  }
}

/** A Channel filter must be a live Channel of the workspace (and of the principal's list). */
async function checkChannel(c: AppContext, actor: WebhookActor, channelId: string | null) {
  if (channelId === null) {
    if (actor.channelIds) {
      throw new ApiError('invalid_input', 'This key is limited to some publications: pick one.', [
        { path: 'channelId', message: 'Pick a publication.' },
      ]);
    }
    return;
  }
  const row = await first<{ workspace_id: string }>(
    env(c).DB,
    'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if (
    !row ||
    row.workspace_id !== actor.workspaceId ||
    (actor.channelIds && !actor.channelIds.includes(channelId))
  ) {
    throw new ApiError('invalid_input', 'Publication not found.', [
      { path: 'channelId', message: 'Pick one of this workspace’s publications.' },
    ]);
  }
}

/** A new signing secret for an endpoint of the workspace, from the vault (admin or webhooks:write). */
async function newEndpointSecret(c: AppContext, workspaceId: string, endpointId: string) {
  return vaultValue(
    await apiVault(c).createWebhookSecret(credentialOf(c), { workspaceId, endpointId }),
  );
}

export async function createEndpoint(
  c: AppContext,
  actor: WebhookActor,
  input: CreateWebhookEndpoint,
): Promise<WebhookEndpointWithSecret> {
  const e = env(c);
  checkUrl(c, input.url);
  const channelId = input.channelId ?? null;
  await checkChannel(c, actor, channelId);
  const workspace = await first<{ plan: Plan }>(
    e.DB,
    'SELECT plan FROM workspaces WHERE id = ?1',
    actor.workspaceId,
  );
  const limit = PLAN_LIMITS[workspace?.plan ?? 'free'].webhookEndpoints;
  const now = Date.now();
  const id = newId('webhookEndpoint', now);
  // Made and sealed by the vault: the plaintext comes back once, for the operator, only.
  const { secretOnce: secret, sealed } = await newEndpointSecret(c, actor.workspaceId, id);
  const events = [...new Set(input.events)].filter((t) => WEBHOOK_EVENTS.includes(t));
  // The limit is checked in the insert itself, so endpoints added at once can't pass it together.
  const added = await first<{ id: string }>(
    e.DB,
    `INSERT INTO webhook_endpoints (id, workspace_id, channel_id, url, description, events_json, secret_enc,
       status, created_by, created_at, updated_at, confirmed_by, confirmed_at, proposed_via, proposed_by_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?9, ?8, CASE WHEN ?8 IS NULL THEN NULL ELSE ?9 END,
            ?11, ?12
      WHERE (SELECT count(*) FROM webhook_endpoints WHERE workspace_id = ?2) < ?10
     RETURNING id`,
    id,
    actor.workspaceId,
    channelId,
    input.url,
    input.description || null,
    JSON.stringify(events),
    sealed,
    // A dashboard admin (after a fresh second-factor check) stands behind it at once; an API key
    // or OAuth grant can only propose it, and it receives nothing until an admin confirms it.
    actor.operatorId,
    now,
    limit,
    actor.operatorId ? null : actor.principalKind,
    actor.operatorId ? null : actor.principalId,
  );
  if (!added) {
    throw new ApiError(
      'conflict',
      `Your plan includes ${limit} webhook endpoints. Delete one or upgrade to add more.`,
    );
  }
  await audit(c, actor, 'webhook.created', id, { url: input.url, events, channelId });
  await feedNotice(c, actor, 'created', input.url);
  return { endpoint: toWebhookEndpoint(await requireEndpoint(c, actor, id)), secret };
}

export async function updateEndpoint(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  input: UpdateWebhookEndpoint,
): Promise<WebhookEndpoint> {
  const current = await requireEndpoint(c, actor, endpointId);
  if (input.url !== undefined) checkUrl(c, input.url);
  if (input.channelId !== undefined) await checkChannel(c, actor, input.channelId);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = ?${params.length}`);
  };
  if (input.url !== undefined) set('url', input.url);
  if (input.description !== undefined) set('description', input.description || null);
  if (input.events !== undefined) set('events_json', JSON.stringify([...new Set(input.events)]));
  if (input.channelId !== undefined) set('channel_id', input.channelId);
  const repointed = repointsEndpoint(current, input);
  if (repointed) {
    // A new target is a new feed: a dashboard admin stands behind it, a key or grant proposes it.
    set('confirmed_by', actor.operatorId);
    set('confirmed_at', actor.operatorId ? Date.now() : null);
    if (!actor.operatorId) {
      set('proposed_via', actor.principalKind);
      set('proposed_by_id', actor.principalId);
    }
  }
  if (input.status !== undefined && input.status !== current.status) {
    set('status', input.status);
    if (input.status === 'active') {
      // Resuming starts over: no failures counted, no reason shown.
      set('disabled_reason', null);
      set('failure_count', 0);
      set('first_failure_at', null);
    }
  }
  set('updated_at', Date.now());
  params.push(endpointId);
  await run(
    env(c).DB,
    `UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = ?${params.length}`,
    ...params,
  );
  await audit(c, actor, 'webhook.updated', endpointId, {
    changed: Object.keys(input),
    ...(input.status && input.status !== current.status
      ? { from: current.status, to: input.status }
      : {}),
    // The new target, so the log shows where a repointed endpoint sends events.
    ...(repointed
      ? { url: input.url ?? current.url, channelId: input.channelId ?? current.channel_id }
      : {}),
  });
  if (repointed) await feedNotice(c, actor, 'repointed', input.url ?? current.url);
  return toWebhookEndpoint(await requireEndpoint(c, actor, endpointId));
}

/** True when a change moves the endpoint to another URL or publication. */
export function repointsEndpoint(
  current: Pick<WebhookEndpointRow, 'url' | 'channel_id'>,
  input: UpdateWebhookEndpoint,
): boolean {
  return (
    (input.url !== undefined && input.url !== current.url) ||
    (input.channelId !== undefined && input.channelId !== current.channel_id)
  );
}

/**
 * An admin adopts the endpoint (after a fresh second-factor check): confirms one an API key or
 * OAuth grant proposed, or takes over one whose admin left. It then runs on their authority.
 */
export async function confirmEndpoint(
  c: AppContext,
  actor: WebhookActor & { operatorId: string },
  endpointId: string,
): Promise<WebhookEndpoint> {
  const current = await requireEndpoint(c, actor, endpointId);
  const now = Date.now();
  await run(
    env(c).DB,
    'UPDATE webhook_endpoints SET confirmed_by = ?1, confirmed_at = ?2, updated_at = ?2 WHERE id = ?3',
    actor.operatorId,
    now,
    endpointId,
  );
  await audit(c, actor, 'webhook.confirmed', endpointId, {
    url: current.url,
    was: current.suspended_reason,
  });
  await feedNotice(c, actor, 'confirmed', current.url);
  return toWebhookEndpoint(await requireEndpoint(c, actor, endpointId));
}

/** To the owners and admins (but the actor): an endpoint was added, repointed, proposed or adopted. */
async function feedNotice(
  c: AppContext,
  actor: WebhookActor,
  what: 'created' | 'repointed' | 'confirmed',
  url: string,
): Promise<void> {
  const who = actor.operatorId ? (actor.email ?? 'An admin') : 'An API key or connected app';
  const verb = {
    created: actor.operatorId ? 'added a webhook endpoint' : 'proposed a webhook endpoint',
    repointed: 'pointed a webhook endpoint somewhere new',
    confirmed: 'confirmed a webhook endpoint',
  }[what];
  const pending = !actor.operatorId
    ? ' It receives nothing until an admin confirms it under Settings → Webhooks.'
    : '';
  await noticeTeam(
    env(c),
    c.get('log'),
    actor.workspaceId,
    ['owner', 'admin'],
    {
      category: 'standing_feed_changed',
      subject: `Webhook endpoint ${what === 'confirmed' ? 'confirmed' : 'changed'}: ${url}`,
      heading: 'Webhook endpoint',
      lines: [
        `${who} ${verb}. It sends events about your subscribers, with their addresses and names, to ${url}.${pending}`,
        'If you did not expect this, pause or delete it.',
      ],
      path: '/settings/developers/webhooks',
      label: 'Review webhooks',
    },
    actor.operatorId,
  );
}

export async function deleteEndpoint(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
): Promise<void> {
  const current = await requireEndpoint(c, actor, endpointId);
  await run(env(c).DB, 'DELETE FROM webhook_endpoints WHERE id = ?1', endpointId);
  await audit(c, actor, 'webhook.deleted', endpointId, { url: current.url });
}

/** A new secret; the previous one keeps signing (a second v1=) for the overlap. */
export async function rotateSecret(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
): Promise<WebhookEndpointWithSecret> {
  const e = env(c);
  await requireEndpoint(c, actor, endpointId);
  const { secretOnce: secret, sealed } = await newEndpointSecret(c, actor.workspaceId, endpointId);
  const now = Date.now();
  await run(
    e.DB,
    `UPDATE webhook_endpoints SET previous_secret_enc = secret_enc, previous_expires_at = ?1,
            secret_enc = ?2, updated_at = ?3
      WHERE id = ?4`,
    now + WEBHOOK_ROTATION_OVERLAP_MS,
    sealed,
    now,
    endpointId,
  );
  await audit(c, actor, 'webhook.secret_rotated', endpointId);
  return { endpoint: toWebhookEndpoint(await requireEndpoint(c, actor, endpointId), now), secret };
}

export async function sendTest(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  type: WebhookEventType | undefined,
): Promise<WebhookDelivery> {
  const endpoint = await requireEndpoint(c, actor, endpointId);
  const eventType =
    type ?? (JSON.parse(endpoint.events_json) as WebhookEventType[])[0] ?? 'member.created';
  const deliveryId = await sendTestWebhook(
    { DB: env(c).DB, WEBHOOKS_QUEUE: webhooksQueue(c) },
    endpoint,
    eventType,
  );
  await audit(c, actor, 'webhook.test_sent', endpointId, { type: eventType });
  return toWebhookDelivery(await loadDelivery(c, endpointId, deliveryId));
}

// ---- Deliveries ------------------------------------------------------------------------------

const deliveryIdPattern = idPattern('webhookDelivery');

export async function listDeliveries(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  query: {
    cursor?: string | undefined;
    limit: number;
    status?: WebhookDelivery['status'] | undefined;
    eventType?: WebhookEventType | undefined;
  },
): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
  await requireEndpoint(c, actor, endpointId);
  // Ids are UUIDv7, so id order is creation order and the last id is the cursor.
  if (query.cursor !== undefined && !deliveryIdPattern.test(query.cursor)) {
    throw new ApiError('invalid_input', 'Invalid cursor.');
  }
  const rows = await all<WebhookDeliveryRow>(
    env(c).DB,
    `SELECT * FROM webhook_deliveries
      WHERE endpoint_id = ?1 AND (?2 IS NULL OR id < ?2)
        AND (?3 IS NULL OR status = ?3) AND (?4 IS NULL OR event_type = ?4)
      ORDER BY id DESC LIMIT ?5`,
    endpointId,
    query.cursor ?? null,
    query.status ?? null,
    query.eventType ?? null,
    query.limit + 1,
  );
  const items = rows.slice(0, query.limit).map(toWebhookDelivery);
  return {
    items,
    nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
  };
}

async function loadDelivery(
  c: AppContext,
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow> {
  const row = await first<WebhookDeliveryRow>(
    env(c).DB,
    'SELECT * FROM webhook_deliveries WHERE id = ?1 AND endpoint_id = ?2',
    deliveryId,
    endpointId,
  );
  if (!row) throw new ApiError('not_found', 'Delivery not found.');
  return row;
}

export async function getDelivery(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDeliveryDetail> {
  await requireEndpoint(c, actor, endpointId);
  const row = await loadDelivery(c, endpointId, deliveryId);
  const attempts = await all<{
    attempt: number;
    started_at: number;
    response_status: number | null;
    latency_ms: number | null;
    error: string | null;
    response_excerpt: string | null;
  }>(
    env(c).DB,
    'SELECT * FROM webhook_attempts WHERE delivery_id = ?1 ORDER BY attempt',
    deliveryId,
  );
  // The headers as sent, with the MAC values left out (they are derived from the secret).
  const timestamp = Math.floor((row.last_attempt_at ?? row.created_at) / 1000);
  return {
    ...toWebhookDelivery(row),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    requestHeaders: webhookHeaders(row, `t=${timestamp},v1=…`),
    responseExcerpt: row.response_excerpt,
    attemptLog: attempts.map((a) => ({
      attempt: a.attempt,
      startedAt: toIso(a.started_at),
      responseStatus: a.response_status,
      latencyMs: a.latency_ms,
      error: a.error,
      responseExcerpt: a.response_excerpt,
    })),
  };
}

/** Deliveries go only to an active endpoint (test events excepted). */
function requireActive(endpoint: EndpointListRow) {
  if (endpoint.status !== 'active') {
    throw new ApiError(
      'conflict',
      endpoint.status === 'paused'
        ? 'This endpoint is paused. Resume it first.'
        : 'This endpoint is turned off. Resume it first.',
    );
  }
}

/**
 * Sends a delivery again with the same event id and body. Idempotent: a delivery that is
 * already pending or retrying is returned as it is.
 */
export async function redriveDelivery(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDelivery> {
  const endpoint = await requireEndpoint(c, actor, endpointId);
  const row = await loadDelivery(c, endpointId, deliveryId);
  if (row.test !== 1) requireActive(endpoint);
  const redriven = await redriveWebhookDelivery(
    { DB: env(c).DB, WEBHOOKS_QUEUE: webhooksQueue(c) },
    deliveryId,
  );
  if (redriven) {
    await audit(c, actor, 'webhook.redriven', endpointId, {
      deliveryId,
      eventId: row.event_id,
    });
  }
  return toWebhookDelivery(await loadDelivery(c, endpointId, deliveryId));
}

export async function redriveFailedSince(
  c: AppContext,
  actor: WebhookActor,
  endpointId: string,
  since: string,
): Promise<{ redriven: number }> {
  const endpoint = await requireEndpoint(c, actor, endpointId);
  requireActive(endpoint);
  const redriven = await redriveFailedWebhooks(
    { DB: env(c).DB, WEBHOOKS_QUEUE: webhooksQueue(c) },
    endpointId,
    Date.parse(since),
  );
  if (redriven) {
    await audit(c, actor, 'webhook.redriven', endpointId, { since, count: redriven });
  }
  return { redriven };
}
