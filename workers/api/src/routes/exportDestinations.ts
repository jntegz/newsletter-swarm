// Incremental exports to the operator's own R2 or S3 bucket (Phase 7). Per Channel, admins and
// owners only, on paid plans (PLAN_LIMITS.exportDestinations per workspace). Credentials are
// sealed by the vault and never returned; "test connection" writes and deletes a small object.
// The jobs worker runs the schedule (@swarm/engine export-sync.ts). Every change is audited.
// A destination is standing access to the Channel's Members: adding or repointing one needs a
// fresh check with a second factor of the operator's own, emails the other owners and admins
// with the bucket, and the destination runs only while that operator keeps the admin role, the
// Channel is not deleted and the plan includes it (docs/security.md "Standing feeds").
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  CreateExportDestinationSchema,
  ExportDestinationPatchSchema,
  ExportDestinationSchema,
  ExportDestinationTestSchema,
  PLAN_LIMITS,
  exportScopeWidens,
  idPattern,
  newId,
  type ExportDestination,
  type ExportDestinationConfig,
  type ExportScope,
  type FeedSuspension,
  type Plan,
} from '@swarm/domain';
import {
  feedProblemSql,
  ExportTargetError,
  testExportTarget,
  webhookUrlProblem,
  type ExportCursor,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext, type AuthContext } from '../lib/context';
import { apiVault, credentialOf } from '../lib/vault';
import { ipPrefix } from '../lib/crypto';
import { loadFactors, requireFreshFactor } from '../lib/mfa';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { noticeTeam } from '../lib/team-notice';

/** A destination's keys, sealed by the vault for its row (admin, checked there too). */
async function sealDestinationKeys(
  c: AppContext,
  workspaceId: string,
  destinationId: string,
  keys: { accessKeyId: string; secretAccessKey: string },
): Promise<string> {
  return vaultValue(
    await apiVault(c).sealCredential(credentialOf(c), {
      ref: { kind: 'export-destination', workspaceId, destinationId },
      plaintext: JSON.stringify(keys),
    }),
  );
}

export const exportDestinations = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const destinationParam = idParam('destinationId', idPattern('exportDestination'));

interface DestinationRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  kind: 's3' | 'r2';
  config_json: string;
  credentials_enc: string;
  schedule: 'hourly' | 'daily';
  cursor_json: string;
  status: 'active' | 'paused' | 'failing';
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  scope_json: string;
  scope_legacy: number;
  suspended_reason: FeedSuspension | null;
}

const COLUMNS = `f.id, f.workspace_id, f.channel_id, f.kind, f.config_json, f.credentials_enc,
  f.schedule, f.cursor_json, f.status, f.last_run_at, f.last_error, f.created_at, f.updated_at,
  f.scope_json, f.scope_legacy, ${feedProblemSql('export_destination', 'f')} AS suspended_reason`;

function toDestination(row: DestinationRow): ExportDestination {
  const config = JSON.parse(row.config_json) as ExportDestinationConfig;
  const cursor = JSON.parse(row.cursor_json) as ExportCursor;
  return {
    id: row.id,
    channelId: row.channel_id,
    kind: row.kind,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    schedule: row.schedule,
    status: row.status,
    lastRunAt: row.last_run_at === null ? null : toIso(row.last_run_at),
    lastError: row.last_error,
    exportedThrough: cursor.members ? toIso(cursor.members) : null,
    scope: JSON.parse(row.scope_json) as ExportScope,
    legacyScope: row.scope_legacy === 1,
    suspendedReason: row.suspended_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** An operator-supplied endpoint must be a public https origin (no private or local hosts). */
function checkEndpoint(endpoint: string | null | undefined) {
  if (!endpoint) return;
  if (webhookUrlProblem(endpoint)) {
    throw new ApiError('invalid_input', 'Use a public https endpoint.', [
      { path: 'endpoint', message: 'Use a public https endpoint.' },
    ]);
  }
}

/** The destination and the caller's access to its Channel; 404 for anyone without access. */
async function loadDestination(c: AppContext, destinationId: string) {
  const notFound = new ApiError('not_found', 'Export destination not found.');
  const row = await first<DestinationRow>(
    env(c).DB,
    `SELECT ${COLUMNS} FROM export_destinations f WHERE f.id = ?1`,
    destinationId,
  );
  if (!row) throw notFound;
  try {
    return { row, access: await requireChannel(c, row.channel_id, 'admin') };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
}

/** A new place for Members to go: a fresh check with a factor of the operator's own. */
async function requireFeedStepUp(c: AppContext, auth: AuthContext): Promise<void> {
  requireFreshFactor(auth, await loadFactors(env(c), auth.operatorId));
}

const NOTICE_SUBJECT = {
  added: 'added',
  repointed: 'moved',
  adopted: 'confirmed',
  widened: 'widened',
} as const;
const NOTICE_ACTION = {
  added: 'added an export destination',
  repointed: 'pointed an export destination at a new bucket',
  adopted: 'confirmed an export destination',
  widened: 'changed an export destination to send more',
} as const;

/** What a scope sends, in a sentence's words. */
function scopeWords(scope: ExportScope): string {
  const who =
    scope.members === 'all' ? 'every subscriber, including people who left' : 'subscribed readers';
  const fields =
    scope.fields === 'all'
      ? 'with all their profile fields'
      : scope.fields.length
        ? `with the profile fields ${scope.fields.join(', ')}`
        : 'without profile fields';
  return `${who}, ${fields},`;
}

/** To the owners and admins (but the actor): where the Members now go. */
async function destinationNotice(
  c: AppContext,
  access: { workspaceId: string; channelId: string; auth: AuthContext },
  what: 'added' | 'repointed' | 'adopted' | 'widened',
  config: ExportDestinationConfig,
  scope: ExportScope,
): Promise<void> {
  const target = `${config.endpoint ?? 'S3'} bucket ${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`;
  await noticeTeam(
    env(c),
    c.get('log'),
    access.workspaceId,
    ['owner', 'admin'],
    {
      category: 'standing_feed_changed',
      subject: `Subscriber export ${NOTICE_SUBJECT[what]}: ${config.bucket}`,
      heading: 'Export destination',
      lines: [
        `${access.auth.email} ${NOTICE_ACTION[what]}. It copies ${scopeWords(scope)} of the publication to ${target}.`,
        'If you did not expect this, pause or remove it under Members → Export destinations.',
      ],
      path: `/channels/${access.channelId}/export-destinations`,
      label: 'Review export destinations',
    },
    access.auth.operatorId,
  );
}

/** fetch, wrapped: calling the bare global as a method throws "Illegal invocation" in workerd. */
const fetcher = (input: string, init: RequestInit) => fetch(input, init);

exportDestinations.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/export-destinations',
    tags: ['Members'],
    summary: 'Export destinations of a Channel',
    description: 'Credentials are never returned. Admins and owners only.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(ExportDestinationSchema), 'Destinations'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'admin');
    const rows = await all<DestinationRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM export_destinations f WHERE f.channel_id = ?1 ORDER BY f.created_at`,
      channelId,
    );
    return c.json({ data: rows.map(toDestination) }, 200);
  },
);

exportDestinations.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/export-destinations',
    tags: ['Members'],
    summary: 'Add an export destination',
    description:
      'Paid plans: changed Members and new member events are written to the bucket as JSON Lines, hourly or daily, under the prefix. `scope` says who and which profile fields are sent; by default subscribed Members only, with no profile fields (anyone else gets a reduced line with their id, status and dates). The access key needs permission to put objects (and to delete them for "test connection"). Answers `plan_required` on the free plan and `conflict` when the plan’s limit is reached. Needs a second factor of your own proved in the last 10 minutes (403 `secondFactor: step_up_required`, or `factor_required` without one); the other owners and admins are emailed with the bucket. It runs while you keep the admin role here.',
    request: { params: channelParam, body: jsonBody(CreateExportDestinationSchema) },
    responses: {
      201: ok(ExportDestinationSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    await requireFeedStepUp(c, access.auth);
    checkEndpoint(input.endpoint);
    const plan = await first<{ plan: Plan }>(
      e.DB,
      'SELECT plan FROM workspaces WHERE id = ?1',
      access.workspaceId,
    );
    const limit = PLAN_LIMITS[plan?.plan ?? 'free'].exportDestinations;
    if (limit === 0) {
      throw new ApiError('plan_required', 'Export destinations are part of the paid plans.');
    }
    const now = Date.now();
    const id = newId('exportDestination', now);
    const config: ExportDestinationConfig = {
      endpoint: input.endpoint ?? null,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
    };
    // The limit is checked in the insert itself, so destinations added at once can't pass it together.
    const added = await first<{ id: string }>(
      e.DB,
      `INSERT INTO export_destinations (id, workspace_id, channel_id, kind, config_json, credentials_enc,
         schedule, created_by, created_at, updated_at, confirmed_by, confirmed_at, scope_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?8, ?9, ?11
        WHERE (SELECT count(*) FROM export_destinations WHERE workspace_id = ?2) < ?10
       RETURNING id`,
      id,
      access.workspaceId,
      channelId,
      input.kind,
      JSON.stringify(config),
      await sealDestinationKeys(c, access.workspaceId, id, {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      }),
      input.schedule,
      access.auth.operatorId,
      now,
      limit,
      JSON.stringify(input.scope),
    );
    if (!added) {
      throw new ApiError('conflict', `Your plan allows ${limit} export destinations.`);
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export_destination.created',
      targetType: 'export_destination',
      targetId: id,
      metadata: {
        channelId,
        kind: input.kind,
        endpoint: input.endpoint ?? null,
        bucket: input.bucket,
        prefix: input.prefix,
        schedule: input.schedule,
        scope: input.scope,
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    await destinationNotice(c, access, 'added', config, input.scope);
    const row = await first<DestinationRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM export_destinations f WHERE f.id = ?1`,
      id,
    );
    return c.json({ data: toDestination(row as DestinationRow) }, 201);
  },
);

exportDestinations.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/export-destinations/{destinationId}',
    tags: ['Members'],
    summary: 'Change, pause or resume an export destination',
    description:
      'Replace both keys together, or neither. Setting `active` resumes a paused or failing destination; its next run is due at once. A new endpoint, region, bucket, prefix or keys, or a `scope` that sends more people or fields, is like adding it: a fresh second-factor check, a notice to the other owners and admins, and you stand behind it from then on. Saving any `scope` ends `legacyScope`.',
    request: { params: destinationParam, body: jsonBody(ExportDestinationPatchSchema) },
    responses: {
      200: ok(ExportDestinationSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { destinationId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await loadDestination(c, destinationId);
    const e = env(c);
    checkEndpoint(input.endpoint);
    const current = JSON.parse(row.config_json) as ExportDestinationConfig;
    const config: ExportDestinationConfig = {
      endpoint: input.endpoint === undefined ? current.endpoint : input.endpoint,
      region: input.region ?? current.region,
      bucket: input.bucket ?? current.bucket,
      prefix: input.prefix ?? current.prefix,
    };
    // A new bucket or new keys is a new place for the Members to go: treated as adding it.
    const repointed =
      JSON.stringify(config) !== JSON.stringify(current) ||
      (input.accessKeyId !== undefined && input.secretAccessKey !== undefined);
    // Sending more people or fields than before is like a new place for them to go, too.
    const currentScope = JSON.parse(row.scope_json) as ExportScope;
    const scope = input.scope ?? currentScope;
    const widened = !!input.scope && exportScopeWidens(currentScope, input.scope);
    if (repointed || widened) await requireFeedStepUp(c, access.auth);
    if (row.kind === 'r2' && !config.endpoint) {
      throw new ApiError('invalid_input', 'R2 needs the account’s S3 endpoint.', [
        { path: 'endpoint', message: 'R2 needs the account’s S3 endpoint.' },
      ]);
    }
    // New keys are sealed by the vault for this row; older stored ones are moved onto the
    // current format by the vault's re-seal cron, not here.
    let credentials = row.credentials_enc;
    if (input.accessKeyId && input.secretAccessKey) {
      credentials = await sealDestinationKeys(c, row.workspace_id, destinationId, {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      });
    }
    const resume = input.status === 'active' && row.status !== 'active';
    const now = Date.now();
    await run(
      e.DB,
      `UPDATE export_destinations SET config_json = ?1, credentials_enc = ?2, schedule = ?3,
          status = ?4, last_run_at = CASE WHEN ?5 = 1 THEN NULL ELSE last_run_at END,
          failure_count = CASE WHEN ?5 = 1 THEN 0 ELSE failure_count END, updated_at = ?6,
          confirmed_by = CASE WHEN ?8 = 1 THEN ?9 ELSE confirmed_by END,
          confirmed_at = CASE WHEN ?8 = 1 THEN ?6 ELSE confirmed_at END,
          scope_json = ?10, scope_legacy = CASE WHEN ?11 = 1 THEN 0 ELSE scope_legacy END
        WHERE id = ?7`,
      JSON.stringify(config),
      credentials,
      input.schedule ?? row.schedule,
      input.status ?? row.status,
      resume ? 1 : 0,
      now,
      destinationId,
      repointed || widened ? 1 : 0,
      access.auth.operatorId,
      JSON.stringify(scope),
      input.scope ? 1 : 0,
    );
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export_destination.updated',
      targetType: 'export_destination',
      targetId: destinationId,
      // Which settings changed, and where it now points; key values are never logged.
      metadata: {
        changed: Object.keys(input).filter((k) => k !== 'secretAccessKey'),
        ...(repointed
          ? { endpoint: config.endpoint, bucket: config.bucket, prefix: config.prefix }
          : {}),
        ...(input.scope ? { scope } : {}),
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (repointed) await destinationNotice(c, access, 'repointed', config, scope);
    else if (widened) await destinationNotice(c, access, 'widened', config, scope);
    const updated = await first<DestinationRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM export_destinations f WHERE f.id = ?1`,
      destinationId,
    );
    return c.json({ data: toDestination(updated as DestinationRow) }, 200);
  },
);

exportDestinations.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/export-destinations/{destinationId}/confirm',
    tags: ['Members'],
    summary: 'Confirm or adopt an export destination',
    description:
      'A destination whose admin no longer has the role, or that has no recorded admin, exports nothing (`suspendedReason`) until an admin adopts it; it then runs on their authority. Needs a second factor of your own proved in the last 10 minutes; the other owners and admins are emailed with the bucket.',
    request: { params: destinationParam },
    responses: {
      200: ok(ExportDestinationSchema, 'Confirmed'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { destinationId } = c.req.valid('param');
    const { row, access } = await loadDestination(c, destinationId);
    const e = env(c);
    await requireFeedStepUp(c, access.auth);
    const now = Date.now();
    await run(
      e.DB,
      'UPDATE export_destinations SET confirmed_by = ?1, confirmed_at = ?2, updated_at = ?2 WHERE id = ?3',
      access.auth.operatorId,
      now,
      destinationId,
    );
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export_destination.confirmed',
      targetType: 'export_destination',
      targetId: destinationId,
      metadata: { channelId: row.channel_id, was: row.suspended_reason },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    await destinationNotice(
      c,
      access,
      'adopted',
      JSON.parse(row.config_json) as ExportDestinationConfig,
      JSON.parse(row.scope_json) as ExportScope,
    );
    const updated = await first<DestinationRow>(
      e.DB,
      `SELECT ${COLUMNS} FROM export_destinations f WHERE f.id = ?1`,
      destinationId,
    );
    return c.json({ data: toDestination(updated as DestinationRow) }, 200);
  },
);

exportDestinations.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/export-destinations/{destinationId}',
    tags: ['Members'],
    summary: 'Remove an export destination',
    description: 'Objects already written to the bucket stay there.',
    request: { params: destinationParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { destinationId } = c.req.valid('param');
    const { row, access } = await loadDestination(c, destinationId);
    const e = env(c);
    await run(e.DB, 'DELETE FROM export_destinations WHERE id = ?1', destinationId);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export_destination.deleted',
      targetType: 'export_destination',
      targetId: destinationId,
      metadata: { channelId: row.channel_id },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);

exportDestinations.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/export-destinations/{destinationId}/test',
    tags: ['Members'],
    summary: 'Test the connection',
    description:
      'Writes a small text file under the prefix with the stored keys, then deletes it. Answers 200 with `ok: false` and the storage API’s reason when it fails.',
    request: { params: destinationParam },
    responses: {
      200: ok(ExportDestinationTestSchema, 'Result'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { destinationId } = c.req.valid('param');
    const { row, access } = await loadDestination(c, destinationId);
    const e = env(c);
    const config = JSON.parse(row.config_json) as ExportDestinationConfig;
    // Signed by the vault with the stored keys (admin, checked there too); they never come here.
    const vault = apiVault(c);
    const result = await testExportTarget(
      {
        ...config,
        sign: async (request) => {
          const signed = await vault.signDestinationRequest(credentialOf(c), {
            destinationId,
            request,
          });
          if (!signed.ok && (signed.reason === 'refused' || signed.reason === 'unreadable')) {
            throw new ExportTargetError('The stored keys can’t be opened. Enter them again.');
          }
          return vaultValue(signed);
        },
      },
      fetcher,
    );
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'export_destination.tested',
      targetType: 'export_destination',
      targetId: destinationId,
      metadata: { ok: result.ok, status: result.status },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: result }, 200);
  },
);
