import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso, verifyInstanceAudit } from '@swarm/db';
import {
  InstanceAuditQuerySchema,
  InstanceAuditSchema,
  InstanceFeatureSchema,
  InstanceInfoSchema,
  InstanceMailSchema,
  InstanceSendingLimitsSchema,
  InstanceSettingsSchema,
  InstanceSiteCodeSchema,
  idPattern,
  newId,
  UpdateInstanceFeatureSchema,
  UpdateInstanceSettingsSchema,
  UpdateInstanceSiteCodeSchema,
  UpdateInstanceSiteCodeWorkspaceSchema,
  UpdateSendingLimitsSchema,
  type InstanceSendingLimits,
  type InstanceSiteCode,
  type WindowUsage,
} from '@swarm/domain';
import {
  isSwitchableFlag,
  listPlatformFeatures,
  setPlatformFeature,
  type PlatformFeature,
} from '@swarm/flags';
import {
  bumpSiteCachesStatement,
  holdWithheldSiteCodeStatement,
  dnsLookup,
  domainIdentities,
  mailServiceStatus,
  readSendingLimitsRow,
  resumeLimitWaits,
  saveSendingLimits,
  sendLimiter,
  sesAccount,
  shareSendingLimits,
  toSendingLimits,
  waitingSendCount,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { createRouter, env, type AppContext } from '../lib/context';
import { signupMode } from '../lib/instance';
import { noticeInstanceChange, requireInstanceAdmin } from '../lib/instance-admin';
import { sendQueue } from '../lib/send';
import { audit } from '../lib/site';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';

export const instance = createRouter();

// Instance settings belong to the instance admins the installer (or a later admin) named, with a
// factor of their own; a change needs a fresh one and is announced (lib/instance-admin.ts).
instance.use('/api/v1/instance/*', noticeInstanceChange);

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance',
    tags: ['Instance'],
    summary: 'Public facts about this Swarm',
    description: 'Whether anyone can sign up, or only people with an invite.',
    responses: { 200: ok(InstanceInfoSchema, 'Instance') },
  }),
  async (c) => c.json({ data: { signup: await signupMode(env(c)) } }, 200),
);

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/settings',
    tags: ['Instance'],
    summary: 'Instance settings',
    description: 'Instance admins only.',
    responses: {
      200: ok(InstanceSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    return c.json({ data: { signup: await signupMode(env(c)) } }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/settings',
    tags: ['Instance'],
    summary: 'Change instance settings',
    description:
      'Instance admins only. There is no workspace to audit an instance change in, so the row keeps who changed it last and when.',
    request: { body: jsonBody(UpdateInstanceSettingsSchema) },
    responses: {
      200: ok(InstanceSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { signup } = c.req.valid('json');
    const e = env(c);
    await run(
      e.DB,
      `INSERT INTO instance_settings (key, value, updated_by, updated_at) VALUES ('signup', ?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                                        updated_at = excluded.updated_at`,
      signup,
      auth.operatorId,
      Date.now(),
    );
    c.get('log').info('instance signup mode changed', { signup });
    return c.json({ data: { signup } }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/mail',
    tags: ['Instance'],
    summary: 'The email service and its DNS records',
    description:
      'Instance admins only. Asks the service for the records it wants and DNS for what is published, so each call does both. It changes nothing. No keys are ever returned.',
    responses: {
      200: ok(InstanceMailSchema, 'Email service'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    const e = env(c);
    const service = e.MAIL_ADAPTER;
    const region =
      service === 'mailgun'
        ? e.MAILGUN_REGION
        : service === 'ses' || service === 'resend'
          ? e.AWS_REGION
          : undefined;
    const data = await mailServiceStatus({
      db: e.DB,
      service,
      region: region ?? null,
      domain: e.MAIL_FROM.split('@')[1] as string,
      identities: domainIdentities(e),
      dns: dnsLookup(e),
      ses: sesAccount(e),
    });
    return c.json({ data }, 200);
  },
);

// ---- Sending limits (migrations/0066_sending_limits.sql) ------------------------------------

const usageJson = (window: WindowUsage) => ({ ...window, resetsAt: toIso(window.resetsAt) });

/** The stored limits, with what the pacer has counted against them and who waits for them. */
async function readSendingLimits(c: AppContext): Promise<InstanceSendingLimits> {
  const e = env(c);
  const now = Date.now();
  const row = await readSendingLimitsRow(e.DB);
  const limits = toSendingLimits(row);
  const limiter = sendLimiter(e);
  const usage = limiter
    ? await limiter.usage(limits).catch((error: unknown) => {
        c.get('log').warn('send pacer unavailable for sending limits', {
          error: (error as Error).message,
        });
        return null;
      })
    : null;
  return {
    limits,
    ceiling: usage?.ceiling ?? null,
    usage: usage
      ? { hour: usageJson(usage.hour), day: usageJson(usage.day), month: usageJson(usage.month) }
      : null,
    service: usage?.service
      ? { window: usage.service.window, until: toIso(usage.service.until) }
      : null,
    waitingSends: await waitingSendCount(e.DB, now),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/sending-limits',
    tags: ['Instance'],
    summary: 'Sending limits for the whole Swarm',
    description:
      'Instance admins only. The limits every email on this Swarm counts against (posts, automations, Direct Send and sign-in mail together), what has been counted this UTC hour, day and month, and how many sends are waiting. `usage` is null when the counter cannot be reached. Reads only.',
    responses: {
      200: ok(InstanceSendingLimitsSchema, 'Sending limits'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    return c.json({ data: await readSendingLimits(c) }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/sending-limits',
    tags: ['Instance'],
    summary: 'Change the sending limits',
    description:
      'Instance admins only. Null means no limit of that kind. The change applies to every email from the next one on: the counter is told at once, and applies the most recently saved limits whatever a worker still has cached (without the counter, a change reaches every worker within 30 seconds). Sends waiting for this Swarm’s own hourly, daily or monthly limit then try again at once, and wait again if the new limit still holds. MAIL_MAX_PER_SECOND, where set on the send worker, still caps perSecond. The row keeps who changed it last and when.',
    request: { body: jsonBody(UpdateSendingLimitsSchema) },
    responses: {
      200: ok(InstanceSendingLimitsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const limits = c.req.valid('json');
    const e = env(c);
    const now = Date.now();
    const saved = await saveSendingLimits(e.DB, limits, auth.operatorId, now);
    // Before anything resumes: a send worker that still has the old limits cached gets the new
    // ones from the pacer, instead of stopping the resumed sends again for the old limit.
    const limiter = sendLimiter(e);
    if (limiter) {
      await shareSendingLimits(limiter, saved).catch((error: unknown) => {
        c.get('log').warn('send pacer unavailable for new sending limits', {
          error: (error as Error).message,
        });
      });
    }
    const resumed = await resumeLimitWaits(e.DB, sendQueue(c), now);
    c.get('log').info('instance sending limits changed', {
      ...limits,
      resumed,
      by: auth.operatorId,
    });
    return c.json({ data: await readSendingLimits(c) }, 200);
  },
);

const featureJson = (feature: PlatformFeature) => ({
  key: feature.key,
  enabled: feature.enabled,
  updatedBy: feature.updatedBy,
  updatedAt: feature.updatedAt === null ? null : toIso(feature.updatedAt),
});

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/features',
    tags: ['Instance'],
    summary: 'Features for the whole Swarm',
    description:
      'Instance admins only. Every feature that can be turned on or off, as stored. Features read this through a cache, so what they do can lag by up to a minute.',
    responses: {
      200: ok(z.array(InstanceFeatureSchema), 'Features'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    const features = await listPlatformFeatures(env(c).DB);
    return c.json({ data: features.map(featureJson) }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/features/{key}',
    tags: ['Instance'],
    summary: 'Turn a feature on or off for the whole Swarm',
    description:
      'Instance admins only. Only features the list returns are accepted. Off is stored, so an update never turns the feature back on, and the row keeps who changed it last and when. Takes effect within a minute, or six minutes on website pages already in the edge cache.',
    request: {
      params: z.object({
        key: z.string().openapi({ param: { name: 'key', in: 'path' }, example: 'split_tests' }),
      }),
      body: jsonBody(UpdateInstanceFeatureSchema),
    },
    responses: {
      200: ok(InstanceFeatureSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { key } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    // Checked here rather than in the schema, so only an admin learns which keys exist.
    if (!isSwitchableFlag(key)) {
      throw new ApiError('invalid_input', 'That is not a feature you can turn on or off.');
    }
    const saved = await setPlatformFeature(env(c).DB, {
      id: newId('featureFlag'),
      key,
      enabled,
      updatedBy: auth.operatorId,
      now: Date.now(),
    });
    c.get('log').info('instance feature changed', { key, enabled, by: auth.operatorId });
    return c.json({ data: featureJson(saved) }, 200);
  },
);

// ---- Code on websites (migrations/0065_site_code_rules.sql) ---------------------------------

const SITE_CODE_LIST_LIMIT = 500;

async function readSiteCode(db: D1Database): Promise<InstanceSiteCode> {
  const [rule, workspaces] = await Promise.all([
    first<{ every_workspace: number }>(
      db,
      'SELECT every_workspace FROM site_code_rules WHERE id = 1',
    ),
    all<{ id: string; name: string; allowed: number; admin_owned: number; held: number }>(
      db,
      `SELECT w.id, w.name,
              EXISTS (SELECT 1 FROM site_code_workspaces a WHERE a.workspace_id = w.id) AS allowed,
              EXISTS (SELECT 1 FROM site_code_held h WHERE h.workspace_id = w.id) AS held,
              EXISTS (SELECT 1 FROM seats s JOIN instance_admins i ON i.operator_id = s.operator_id
                       WHERE s.workspace_id = w.id AND s.role = 'owner') AS admin_owned
         FROM workspaces w ORDER BY w.name COLLATE NOCASE, w.id LIMIT ?1`,
      SITE_CODE_LIST_LIMIT,
    ),
  ]);
  return {
    everyWorkspace: rule?.every_workspace === 1,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      allowed: w.allowed === 1,
      ownedByInstanceAdmin: w.admin_owned === 1,
      held: w.held === 1,
    })),
  };
}

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/audit',
    tags: ['Instance'],
    summary: 'Changes to this Swarm’s settings',
    description:
      'Instance admins only. Changes to install-wide settings, newest first and `limit` a page (100 unless fewer are asked for), who made them and what they asked for (values of fields named like secrets are not recorded), and whether the whole hash chain still verifies from the first event. Pass `nextCursor` as `cursor` for older changes.',
    request: { query: InstanceAuditQuerySchema },
    responses: {
      200: ok(InstanceAuditSchema, 'Audit log'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    const db = env(c).DB;
    const { cursor, limit } = c.req.valid('query');
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before)) throw new ApiError('invalid_input', 'Invalid cursor.');
    const [rows, verification] = await Promise.all([
      all<{
        seq: number;
        action: string;
        email: string | null;
        metadata_json: string;
        ip_prefix: string | null;
        created_at: number;
      }>(
        db,
        `SELECT e.seq, e.action, o.email, e.metadata_json, e.ip_prefix, e.created_at
           FROM instance_audit_events e LEFT JOIN operators o ON o.id = e.actor_operator_id
          WHERE e.seq < ?1 ORDER BY e.seq DESC LIMIT ?2`,
        before,
        limit + 1,
      ),
      verifyInstanceAudit(db),
    ]);
    const shown = rows.slice(0, limit);
    return c.json(
      {
        data: {
          items: shown.map((row) => ({
            seq: row.seq,
            action: row.action,
            actorEmail: row.email,
            metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
            ipPrefix: row.ip_prefix,
            at: toIso(row.created_at),
          })),
          nextCursor: rows.length > limit ? String(shown[shown.length - 1]?.seq) : null,
          verification,
        },
      },
      200,
    );
  },
);

instance.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/site-code',
    tags: ['Instance'],
    summary: 'Where website code may run',
    description:
      'Instance admins only. Code owners add to their website (scripts, not CSS) always runs on a publication’s own custom domain. On this Swarm’s own domain it runs only for the workspaces allowed here (`allowed`), or for all of them when everyWorkspace is on. A workspace an instance admin makes is allowed when it is made. `ownedByInstanceAdmin` is for information only and allows nothing by itself, because any owner can make a teammate an owner.',
    responses: {
      200: ok(InstanceSiteCodeSchema, 'Rules'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    return c.json({ data: await readSiteCode(env(c).DB) }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/site-code',
    tags: ['Instance'],
    summary: 'Let every workspace add code to websites on this Swarm’s domain',
    description:
      'Instance admins only. Off by default. The row keeps who changed it last and when. Every website’s cached pages are refreshed. Turning it on does not release code that is withheld now: those workspaces are `held`, and their code stays off on this Swarm’s domain until each is allowed by itself.',
    request: { body: jsonBody(UpdateInstanceSiteCodeSchema) },
    responses: {
      200: ok(InstanceSiteCodeSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { everyWorkspace } = c.req.valid('json');
    const db = env(c).DB;
    const now = Date.now();
    await db.batch([
      // On: hold the workspaces whose code is withheld now (only when it was off). Off: no holds.
      everyWorkspace
        ? holdWithheldSiteCodeStatement(db, now)
        : db.prepare('DELETE FROM site_code_held'),
      db
        .prepare(
          `INSERT INTO site_code_rules (id, every_workspace, updated_by, updated_at) VALUES (1, ?1, ?2, ?3)
           ON CONFLICT (id) DO UPDATE SET every_workspace = excluded.every_workspace,
                                          updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(everyWorkspace ? 1 : 0, auth.operatorId, now),
      bumpSiteCachesStatement(db, null),
    ]);
    c.get('log').info('instance site code rule changed', {
      everyWorkspace,
      by: auth.operatorId,
    });
    return c.json({ data: await readSiteCode(db) }, 200);
  },
);

instance.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/site-code/workspaces/{workspaceId}',
    tags: ['Instance'],
    summary: 'Allow or stop website code on this Swarm’s domain for one workspace',
    description:
      'Instance admins only, whether or not they have a seat in the workspace. The change is written to that workspace’s audit log, so its owners can see who allowed or stopped it. Its websites’ cached pages are refreshed.',
    request: {
      params: idParam('workspaceId', idPattern('workspace')),
      body: jsonBody(UpdateInstanceSiteCodeWorkspaceSchema),
    },
    responses: {
      200: ok(InstanceSiteCodeSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { workspaceId } = c.req.valid('param');
    const { allowed } = c.req.valid('json');
    const db = env(c).DB;
    if (!(await first(db, 'SELECT 1 FROM workspaces WHERE id = ?1', workspaceId))) {
      throw new ApiError('not_found', 'Workspace not found.');
    }
    await db.batch([
      allowed
        ? db
            .prepare(
              `INSERT INTO site_code_workspaces (workspace_id, allowed_by, created_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (workspace_id) DO NOTHING`,
            )
            .bind(workspaceId, auth.operatorId, Date.now())
        : db.prepare('DELETE FROM site_code_workspaces WHERE workspace_id = ?1').bind(workspaceId),
      // Allowed by itself: no longer held. Stopped while every workspace is allowed: held, so
      // stopping it means something then too.
      allowed
        ? db.prepare('DELETE FROM site_code_held WHERE workspace_id = ?1').bind(workspaceId)
        : db
            .prepare(
              `INSERT INTO site_code_held (workspace_id, held_at)
               SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM site_code_rules WHERE id = 1 AND every_workspace = 1)
               ON CONFLICT (workspace_id) DO NOTHING`,
            )
            .bind(workspaceId, Date.now()),
      bumpSiteCachesStatement(db, workspaceId),
    ]);
    await audit(
      c,
      { workspaceId, auth },
      allowed ? 'instance.site_code_allowed' : 'instance.site_code_stopped',
      'workspace',
      workspaceId,
    );
    return c.json({ data: await readSiteCode(db) }, 200);
  },
);
