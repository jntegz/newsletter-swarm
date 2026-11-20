// Copilot (Phase 8): the editor assistant's streaming endpoint, the workspace's own model key and
// the metadata-only request log. Contract: docs/copilot.md.
//
// - POST /dispatches/{id}/copilot: editors and up on the Dispatch's Channel, flag `copilot`.
//   Answers text/event-stream; checks (tenancy, flag, key, limits) answer JSON errors first.
//   Share Kit (social_posts) also gets the Dispatch's web link, computed here, never by the model.
// - /workspaces/{id}/copilot[/key|/requests]: admins and owners; the key routes need
//   `copilot_byok`. The key is checked with the provider, sealed by the vault and never
//   returned or logged; only its last four characters are stored in clear.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  CopilotLogQuerySchema,
  CopilotRequestLogSchema,
  CopilotRunSchema,
  CopilotSettingsSchema,
  COPILOT_PLAN_LIMITS,
  SaveCopilotKeySchema,
  UpdateCopilotKeySchema,
  idPattern,
  newId,
  type CopilotKeySource,
  type CopilotRequestLog,
  type CopilotSettings,
} from '@swarm/domain';
import {
  aiGatewayOf,
  copilotEventStream,
  copilotMonth,
  copilotMonthlyUsage,
  copilotSeatAllowance,
  copilotPrompt,
  createCopilotProvider,
  keyLast4,
  platformCopilotModel,
  platformCopilotProvider,
  webUrlFor,
  teammateEmailSql,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { requireChannel, requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { flagOn, loadKey, planOf, providerFor, reserveRequest } from '../lib/copilot';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { engine } from '../lib/send';
import { apiVault, credentialOf } from '../lib/vault';

export const copilot = createRouter();

const dispatchParam = idParam('dispatchId', idPattern('dispatch'));
const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const PROVIDER = 'anthropic' as const;

/** Admins and owners of a workspace that has Copilot on. */
async function requireCopilotAdmin(c: AppContext, workspaceId: string) {
  const access = await requireWorkspace(c, workspaceId, 'admin');
  if (!(await flagOn(c, 'copilot', { workspaceId }))) {
    throw new ApiError('feature_disabled', 'Copilot is not available.');
  }
  return access;
}

async function settingsOf(c: AppContext, workspaceId: string): Promise<CopilotSettings> {
  const e = env(c);
  const now = Date.now();
  const [key, plan, byokAvailable, actionsAvailable, used, usedOnKey] = await Promise.all([
    loadKey(e.DB, workspaceId),
    planOf(e.DB, workspaceId),
    flagOn(c, 'copilot_byok', { workspaceId }),
    flagOn(c, 'copilot_actions', { workspaceId }),
    copilotMonthlyUsage(e.DB, workspaceId, now),
    copilotMonthlyUsage(e.DB, workspaceId, now, 'workspace'),
  ]);
  const platformKey = platformCopilotProvider(e) !== null;
  const keySource: CopilotKeySource | null =
    byokAvailable && key ? 'workspace' : platformKey ? 'platform' : null;
  const workspaceKey = keySource === 'workspace';
  return {
    provider: workspaceKey && e.COPILOT_ADAPTER !== 'dev' ? PROVIDER : e.COPILOT_ADAPTER,
    model: workspaceKey ? e.COPILOT_MODEL : platformCopilotModel(e),
    byokAvailable,
    platformKey,
    actionsAvailable,
    key: key
      ? {
          provider: key.provider,
          last4: key.last4,
          createdAt: toIso(key.created_at),
          validatedAt: toIso(key.validated_at),
          monthlyUnitCap: key.monthly_unit_cap,
          used: usedOnKey,
        }
      : null,
    keySource,
    usage: {
      month: copilotMonth(now).month,
      used,
      limit: COPILOT_PLAN_LIMITS[plan].requestsPerMonth,
      perMinute: COPILOT_PLAN_LIMITS[plan].requestsPerMinute,
      lowRoleLimit: copilotSeatAllowance('viewer', 'platform', plan) ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The editor assistant

copilot.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/copilot',
    tags: ['Copilot'],
    summary: 'Ask Copilot about a Dispatch',
    description:
      'Streams a suggestion as `text/event-stream`: `delta` events with `{text}` while the model writes, then one `done` (`{requestId, text, suggestions, remaining}`) or `error` (`{code, message}`). Nothing is changed: the dashboard applies a result only when the operator accepts it. Editors and up. Answers `feature_disabled` when Copilot is off for the Channel, `rate_limited` (detail `quota`: `month` or `minute`) at a limit, and `unavailable` when no model key can be used. The text is never stored; see docs/copilot.md.',
    request: { params: dispatchParam, body: jsonBody(CopilotRunSchema) },
    responses: {
      200: {
        description: 'The event stream',
        content: { 'text/event-stream': { schema: z.string() } },
      },
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'rate_limited'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const e = env(c);
    const notFound = new ApiError('not_found', 'Post not found.');
    const dispatch = await first<{ id: string; channel_id: string; subject: string }>(
      e.DB,
      'SELECT id, channel_id, subject FROM dispatches WHERE id = ?1',
      dispatchId,
    );
    if (!dispatch) throw notFound;
    let access;
    try {
      access = await requireChannel(c, dispatch.channel_id, 'editor');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') throw notFound;
      throw error;
    }
    const scope = { workspaceId: access.workspaceId, channelId: access.channelId };
    if (!(await flagOn(c, 'copilot', scope))) {
      throw new ApiError('feature_disabled', 'Copilot is not available for this publication.');
    }

    const { provider, model, keySource } = await providerFor(c, scope);
    const now = Date.now();
    // Share Kit: the link the posts carry (read only; the slug is planned, not reserved).
    const link =
      input.feature === 'social_posts' ? await webUrlFor(e.DB, engine(c), dispatch) : null;

    const { id: requestId, remaining } = await reserveRequest(c, {
      workspaceId: access.workspaceId,
      channelId: access.channelId,
      dispatchId,
      operatorId: access.auth.operatorId,
      feature: input.feature,
      keySource,
      provider: provider.name,
      model,
      now,
    });
    const channel = await first<{ settings_json: string }>(
      e.DB,
      'SELECT settings_json FROM channels WHERE id = ?1',
      access.channelId,
    );
    const { styleGuide } = JSON.parse(channel?.settings_json ?? '{}') as { styleGuide?: unknown };
    const log = c.get('log');
    const body = copilotEventStream({
      db: e.DB,
      provider,
      request: {
        model,
        ...copilotPrompt(input, typeof styleGuide === 'string' ? styleGuide : ''),
      },
      requestId,
      feature: input.feature,
      keySource,
      remaining,
      link,
      // Metadata only: never the text, never the key.
      onProviderError: (error) =>
        log.warn('copilot provider error', {
          requestId,
          kind: error.kind,
          status: error.status,
          keySource,
        }),
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Settings and the workspace key

copilot.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/copilot',
    tags: ['Copilot'],
    summary: 'Copilot settings and usage',
    description:
      'The model, whether the workspace may bring its own key, the saved key’s last four characters (never the key), the key in use and this month’s platform-key usage. Admins and owners.',
    request: { params: workspaceParam },
    responses: {
      200: ok(CopilotSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireCopilotAdmin(c, workspaceId);
    return c.json({ data: await settingsOf(c, workspaceId) }, 200);
  },
);

copilot.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/copilot/key',
    tags: ['Copilot'],
    summary: 'Save the workspace’s own model key',
    description:
      'Checks the key with the provider (no tokens are used), then stores it sealed, replacing any earlier key. A refused key answers `invalid_input` at `apiKey`; a provider that can’t be reached answers `unavailable` and nothing is saved. Admins and owners, flag `copilot_byok` (every plan).',
    request: { params: workspaceParam, body: jsonBody(SaveCopilotKeySchema) },
    responses: {
      200: ok(CopilotSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireCopilotAdmin(c, workspaceId);
    if (!(await flagOn(c, 'copilot_byok', { workspaceId }))) {
      throw new ApiError('feature_disabled', 'Bringing your own key is not available.');
    }
    const e = env(c);
    const check = await createCopilotProvider(e, input.apiKey, {
      gateway: aiGatewayOf(e),
    }).validateKey();
    if (!check.ok && check.reason === 'rejected') {
      throw new ApiError('invalid_input', 'The provider didn’t accept this key.', [
        { path: 'apiKey', message: 'The provider didn’t accept this key.' },
      ]);
    }
    if (!check.ok) {
      throw new ApiError(
        'unavailable',
        'The provider can’t be reached to check the key. Try again.',
      );
    }
    const now = Date.now();
    // Sealed by the vault for this row (an existing key keeps its row id on the upsert).
    const keyId =
      (
        await first<{ id: string }>(
          e.DB,
          'SELECT id FROM copilot_keys WHERE workspace_id = ?1',
          workspaceId,
        )
      )?.id ?? newId('modelKey', now);
    const sealed = vaultValue(
      await apiVault(c).sealCredential(credentialOf(c), {
        ref: { kind: 'copilot', workspaceId, keyId },
        plaintext: input.apiKey,
      }),
    );
    const last4 = keyLast4(input.apiKey);
    await run(
      e.DB,
      `INSERT INTO copilot_keys (id, workspace_id, provider, key_enc, last4, created_by,
         validated_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
       ON CONFLICT (workspace_id) DO UPDATE SET provider = excluded.provider,
         key_enc = excluded.key_enc, last4 = excluded.last4, created_by = excluded.created_by,
         validated_at = excluded.validated_at, created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      keyId,
      workspaceId,
      input.provider,
      sealed,
      last4,
      access.auth.operatorId,
      now,
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'copilot_key.saved',
      targetType: 'workspace',
      targetId: workspaceId,
      // The provider and last four only; the key is never logged.
      metadata: { provider: input.provider, last4 },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await settingsOf(c, workspaceId) }, 200);
  },
);

copilot.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/copilot/key',
    tags: ['Copilot'],
    summary: 'Set a monthly ceiling for the workspace’s own key',
    description:
      'With `monthlyUnitCap`, Copilot requests on the workspace’s own key stop for the month once that many units are used (`rate_limited`, quota `month`); null removes the ceiling. An editor request is one unit, an action run one per started 25,000 tokens. Admins and owners. Audited as copilot_key.updated.',
    request: { params: workspaceParam, body: jsonBody(UpdateCopilotKeySchema) },
    responses: {
      200: ok(CopilotSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { monthlyUnitCap } = c.req.valid('json');
    const access = await requireCopilotAdmin(c, workspaceId);
    const e = env(c);
    const updated = await first<{ id: string }>(
      e.DB,
      'UPDATE copilot_keys SET monthly_unit_cap = ?2, updated_at = ?3 WHERE workspace_id = ?1 RETURNING id',
      workspaceId,
      monthlyUnitCap,
      Date.now(),
    );
    if (!updated) throw new ApiError('not_found', 'This workspace has no key of its own.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'copilot_key.updated',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { monthlyUnitCap },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await settingsOf(c, workspaceId) }, 200);
  },
);

copilot.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/copilot/key',
    tags: ['Copilot'],
    summary: 'Remove the workspace’s own model key',
    description:
      'Copilot goes back to the platform key and the plan’s allowance. Admins and owners.',
    request: { params: workspaceParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const access = await requireCopilotAdmin(c, workspaceId);
    const e = env(c);
    const key = await loadKey(e.DB, workspaceId);
    if (!key) throw new ApiError('not_found', 'There is no saved key.');
    await run(e.DB, 'DELETE FROM copilot_keys WHERE workspace_id = ?1', workspaceId);
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'copilot_key.deleted',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { provider: key.provider, last4: key.last4 },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);

interface LogRow {
  id: string;
  feature: CopilotRequestLog['feature'];
  key_source: CopilotKeySource;
  model: string;
  status: CopilotRequestLog['status'];
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  operator_id: string | null;
  operator_email: string | null;
  channel_id: string | null;
  dispatch_id: string | null;
  created_at: number;
}

copilot.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/copilot/requests',
    tags: ['Copilot'],
    summary: 'Copilot request log',
    description:
      'Newest first: feature, key source, model, status, tokens, latency and who asked. Metadata only; the text sent and received is never stored. Admins and owners.',
    request: { params: workspaceParam, query: CopilotLogQuerySchema },
    responses: {
      200: ok(z.array(CopilotRequestLogSchema), 'Requests'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    await requireCopilotAdmin(c, workspaceId);
    const rows = await all<LogRow>(
      env(c).DB,
      `SELECT r.id, r.feature, r.key_source, r.model, r.status, r.error_code, r.input_tokens,
              r.output_tokens, r.latency_ms, r.operator_id,
              ${teammateEmailSql('o', 'r.workspace_id')} AS operator_email,
              r.channel_id, r.dispatch_id, r.created_at
         FROM copilot_requests r LEFT JOIN operators o ON o.id = r.operator_id
        WHERE r.workspace_id = ?1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?2`,
      workspaceId,
      limit,
    );
    const data: CopilotRequestLog[] = rows.map((row) => ({
      id: row.id,
      feature: row.feature,
      keySource: row.key_source,
      model: row.model,
      status: row.status,
      errorCode: row.error_code,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      operator:
        row.operator_id && row.operator_email
          ? { id: row.operator_id, email: row.operator_email }
          : null,
      channelId: row.channel_id,
      dispatchId: row.dispatch_id,
      createdAt: toIso(row.created_at),
    }));
    return c.json({ data }, 200);
  },
);
