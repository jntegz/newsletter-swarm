// Scoped API keys (Settings → Developers) (Phase 7): list, create (the secret is shown once),
// change name, scopes, Channels, allowlist and cap, and revoke. Admin role or higher; every
// change is audited. Presented keys are resolved in v2/keys.ts.
//
// A key is standing access to the workspace, so creating or changing one needs a fresh check
// with a second factor of the operator's own, and the key works only while the admin who stands
// behind it (created_by: its creator, or whoever last changed it) still has the admin role here.
// A key whose admin was demoted shows as suspended until an admin changes it (and so stands
// behind it) or revokes it (docs/security.md "Standing feeds").
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  API_KEY_MAX_EXPIRY_DAYS,
  ApiKeySchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  PLAN_LIMITS,
  UpdateApiKeySchema,
  idPattern,
  newId,
  type ApiKey,
  type ApiKeySurface,
  type ApiScope,
  type Plan,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { teammateEmailSql } from '@swarm/engine';
import { requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { loadFactors, requireFreshFactor } from '../lib/mfa';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { noticeTeam, type TeamNotice } from '../lib/team-notice';
import { NO_STORE } from '../v2/idempotency';
import { mintApiKey } from '../v2/keys';

export const apiKeys = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const keyParams = workspaceParam.extend(idParam('keyId', idPattern('apiKey')).shape);
const DAY_MS = 86_400_000;

interface KeyRow {
  id: string;
  workspace_id: string;
  channel_ids_json: string | null;
  name: string;
  prefix: string;
  scopes_json: string;
  ip_allowlist_json: string | null;
  rate_cap: number | null;
  surface: ApiKeySurface;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip_prefix: string | null;
  created_by: string | null;
  creator_email: string | null;
  created_at: number;
  revoked_at: number | null;
  steward_admin: number;
}

/** 1 while the key's creator (or last editor) still holds an owner or admin seat here. */
const STEWARD_ADMIN_SQL = `(k.created_by IS NULL OR EXISTS (
  SELECT 1 FROM seats ks WHERE ks.workspace_id = k.workspace_id AND ks.operator_id = k.created_by
     AND ks.role IN ('owner', 'admin')))`;

const KEY_COLUMNS = `k.id, k.workspace_id, k.channel_ids_json, k.name, k.prefix, k.scopes_json,
  k.ip_allowlist_json, k.rate_cap, k.surface, k.expires_at, k.last_used_at, k.last_used_ip_prefix, k.created_by,
  ${teammateEmailSql('o', 'k.workspace_id')} AS creator_email, k.created_at, k.revoked_at, ${STEWARD_ADMIN_SQL} AS steward_admin`;

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

function toApiKey(row: KeyRow, now = Date.now()): ApiKey {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes_json) as ApiScope[],
    channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
    ipAllowlist: row.ip_allowlist_json ? (JSON.parse(row.ip_allowlist_json) as string[]) : null,
    rateCap: row.rate_cap,
    surface: row.surface,
    status:
      row.revoked_at !== null
        ? 'revoked'
        : row.expires_at !== null && row.expires_at <= now
          ? 'expired'
          : row.steward_admin
            ? 'active'
            : 'suspended',
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    lastUsedIpPrefix: row.last_used_ip_prefix,
    createdBy:
      row.created_by && row.creator_email ? { id: row.created_by, email: row.creator_email } : null,
    createdAt: toIso(row.created_at),
    revokedAt: iso(row.revoked_at),
  };
}

/** To the other owners and admins: a key was created, or its scopes or publications changed. */
function keyNotice(
  by: string,
  name: string,
  scopes: ApiScope[],
  what: 'created' | 'changed',
): TeamNotice {
  return {
    category: 'standing_feed_changed',
    subject: what === 'created' ? `A new API key: ${name}` : `An API key was changed: ${name}`,
    heading: what === 'created' ? 'New API key' : 'API key changed',
    lines: [
      `${by} ${what === 'created' ? 'created' : 'changed the access of'} the API key “${name}”. It can: ${scopes.join(', ')}.`,
      'If you did not expect this, revoke it under Settings → Developers.',
    ],
    path: '/settings/developers',
    label: 'Review API keys',
  };
}

async function readKey(c: AppContext, workspaceId: string, keyId: string): Promise<KeyRow> {
  const row = await first<KeyRow>(
    env(c).DB,
    `SELECT ${KEY_COLUMNS} FROM api_keys k LEFT JOIN operators o ON o.id = k.created_by
      WHERE k.id = ?1 AND k.workspace_id = ?2`,
    keyId,
    workspaceId,
  );
  if (!row) throw new ApiError('not_found', 'API key not found.');
  return row;
}

async function plan(c: AppContext, workspaceId: string): Promise<Plan> {
  const row = await first<{ plan: Plan }>(
    env(c).DB,
    'SELECT plan FROM workspaces WHERE id = ?1',
    workspaceId,
  );
  return row?.plan ?? 'free';
}

/** Every Channel must be a live Channel of this workspace. */
async function checkChannels(c: AppContext, workspaceId: string, ids: string[]): Promise<void> {
  const found = await all<{ id: string }>(
    env(c).DB,
    `SELECT id FROM channels WHERE workspace_id = ?1 AND deleted_at IS NULL
        AND id IN (SELECT value FROM json_each(?2))`,
    workspaceId,
    JSON.stringify(ids),
  );
  const known = new Set(found.map((row) => row.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    throw new ApiError(
      'invalid_input',
      'Pick publications of this workspace.',
      missing.map(() => ({ path: 'channelIds', message: 'Not a publication of this workspace.' })),
    );
  }
}

function checkRateCap(rateCap: number | null | undefined, workspacePlan: Plan): void {
  const limit = PLAN_LIMITS[workspacePlan].requestsPerMinute;
  if (rateCap != null && rateCap > limit) {
    throw new ApiError('invalid_input', `The cap can be at most ${limit} a minute on this plan.`, [
      { path: 'rateCap', message: `At most ${limit} a minute on this plan.` },
    ]);
  }
}

apiKeys.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/api-keys',
    tags: ['API keys'],
    summary: 'API keys of a workspace, newest first',
    description:
      'Active, expired and revoked keys. The secret is never shown again; the prefix identifies a key.',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(ApiKeySchema), 'API keys'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const rows = await all<KeyRow>(
      env(c).DB,
      `SELECT ${KEY_COLUMNS} FROM api_keys k LEFT JOIN operators o ON o.id = k.created_by
        WHERE k.workspace_id = ?1 ORDER BY k.created_at DESC LIMIT 500`,
      workspaceId,
    );
    const now = Date.now();
    return c.json({ data: rows.map((row) => toApiKey(row, now)) }, 200);
  },
);

apiKeys.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/api-keys',
    tags: ['API keys'],
    summary: 'Create an API key',
    description: `The response holds the full secret (sk_live_…) once; only its SHA-256 is stored. A key may be limited to Channels, to IP ranges (IPv4 and IPv6 CIDR) and to a request rate below the plan's, and may expire (within ${API_KEY_MAX_EXPIRY_DAYS} days). The plan limits how many active keys a workspace has. Needs a second factor of your own proved in the last 10 minutes (403 \`secondFactor: step_up_required\`, or \`factor_required\` without one). The other owners and admins are emailed. The key works while you keep the admin role here.`,
    request: { params: workspaceParam, body: jsonBody(CreateApiKeySchema) },
    responses: {
      201: ok(CreatedApiKeySchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    requireFreshFactor(auth, await loadFactors(e, auth.operatorId));
    const now = Date.now();
    const workspacePlan = await plan(c, workspaceId);
    checkRateCap(input.rateCap, workspacePlan);
    if (input.channelIds) await checkChannels(c, workspaceId, input.channelIds);
    const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
    if (
      expiresAt !== null &&
      (expiresAt <= now || expiresAt > now + API_KEY_MAX_EXPIRY_DAYS * DAY_MS)
    ) {
      throw new ApiError(
        'invalid_input',
        `Pick an expiry within the next ${API_KEY_MAX_EXPIRY_DAYS} days.`,
        [{ path: 'expiresAt', message: 'Pick a date in the future, within two years.' }],
      );
    }
    const limit = PLAN_LIMITS[workspacePlan].apiKeys;
    const minted = await mintApiKey();
    const id = newId('apiKey', now);
    // The count and the insert are one statement, so two creates racing can't pass the limit.
    const inserted = await first<{ id: string }>(
      e.DB,
      `INSERT INTO api_keys (id, workspace_id, channel_ids_json, name, prefix, secret_hash, scopes_json,
         ip_allowlist_json, rate_cap, expires_at, created_by, created_at, surface)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14
        WHERE (SELECT count(*) FROM api_keys WHERE workspace_id = ?2 AND revoked_at IS NULL
                 AND (expires_at IS NULL OR expires_at > ?12)) < ?13
       RETURNING id`,
      id,
      workspaceId,
      input.channelIds ? JSON.stringify(input.channelIds) : null,
      input.name,
      minted.prefix,
      minted.hash,
      JSON.stringify(input.scopes),
      input.ipAllowlist ? JSON.stringify(input.ipAllowlist) : null,
      input.rateCap ?? null,
      expiresAt,
      auth.operatorId,
      now,
      limit,
      input.surface ?? 'both',
    );
    if (!inserted) {
      throw new ApiError(
        'conflict',
        `This plan allows ${limit} active API keys. Revoke one to create another.`,
      );
    }
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: id,
      metadata: {
        name: input.name,
        prefix: minted.prefix,
        scopes: input.scopes,
        channelIds: input.channelIds ?? null,
        ipAllowlist: input.ipAllowlist ?? null,
        surface: input.surface ?? 'both',
        rateCap: input.rateCap ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const key = toApiKey(await readKey(c, workspaceId, id), now);
    await noticeTeam(
      e,
      c.get('log'),
      workspaceId,
      ['owner', 'admin'],
      keyNotice(auth.email, input.name, input.scopes, 'created'),
      auth.operatorId,
    );
    return c.json({ data: { key, secret: minted.secret } }, 201, NO_STORE);
  },
);

apiKeys.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/api-keys/{keyId}',
    tags: ['API keys'],
    summary: 'Change an API key',
    description:
      'Name, scopes, Channels, IP allowlist and rate cap. A change applies to the next request made with the key. Revoked keys can’t be changed. Needs a second factor proved in the last 10 minutes (403 `secondFactor: step_up_required`). Whoever changes a key stands behind it from then on, which also brings back a suspended one.',
    request: { params: keyParams, body: jsonBody(UpdateApiKeySchema) },
    responses: {
      200: ok(ApiKeySchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, keyId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    requireFreshFactor(auth, await loadFactors(env(c), auth.operatorId));
    const current = await readKey(c, workspaceId, keyId);
    if (current.revoked_at !== null) {
      throw new ApiError('conflict', 'This key is revoked. Create a new one instead.');
    }
    checkRateCap(input.rateCap, await plan(c, workspaceId));
    if (input.channelIds) await checkChannels(c, workspaceId, input.channelIds);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    if (input.name !== undefined) set('name', input.name);
    if (input.scopes !== undefined) set('scopes_json', JSON.stringify(input.scopes));
    if (input.channelIds !== undefined) {
      set('channel_ids_json', input.channelIds ? JSON.stringify(input.channelIds) : null);
    }
    if (input.ipAllowlist !== undefined) {
      set('ip_allowlist_json', input.ipAllowlist ? JSON.stringify(input.ipAllowlist) : null);
    }
    if (input.rateCap !== undefined) set('rate_cap', input.rateCap);
    // Whoever changes a key stands behind it from now on (and so adopts a suspended one).
    set('created_by', auth.operatorId);
    if (input.surface !== undefined) set('surface', input.surface);
    params.push(keyId);
    const e = env(c);
    const updated = await first<{ id: string }>(
      e.DB,
      `UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?${params.length} AND revoked_at IS NULL RETURNING id`,
      ...params,
    );
    if (!updated) throw new ApiError('conflict', 'This key is revoked. Create a new one instead.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'api_key.updated',
      targetType: 'api_key',
      targetId: keyId,
      metadata: { prefix: current.prefix, ...input, stewardFrom: current.created_by },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (input.scopes !== undefined || input.channelIds !== undefined) {
      await noticeTeam(
        e,
        c.get('log'),
        workspaceId,
        ['owner', 'admin'],
        keyNotice(
          auth.email,
          input.name ?? current.name,
          input.scopes ?? (JSON.parse(current.scopes_json) as ApiScope[]),
          'changed',
        ),
        auth.operatorId,
      );
    }
    return c.json({ data: toApiKey(await readKey(c, workspaceId, keyId)) }, 200);
  },
);

apiKeys.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/api-keys/{keyId}',
    tags: ['API keys'],
    summary: 'Revoke an API key',
    description:
      'The key stops working at once (401). It stays listed as revoked for the audit trail. Revoking twice does nothing.',
    request: { params: keyParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, keyId } = c.req.valid('param');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const current = await readKey(c, workspaceId, keyId);
    const e = env(c);
    const revoked = await first<{ id: string }>(
      e.DB,
      'UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL RETURNING id',
      Date.now(),
      keyId,
    );
    if (revoked) {
      await appendAudit(e.DB, {
        workspaceId,
        actorId: auth.operatorId,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: keyId,
        metadata: { prefix: current.prefix, name: current.name },
        ipPrefix: ipPrefix(clientIp(c)),
      });
    }
    return c.body(null, 204);
  },
);
