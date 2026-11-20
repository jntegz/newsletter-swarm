// Email checks (flag email_verification; docs/email-verification.md): DeBounce's status and who may
// use the install's credits (instance admins), a workspace's rules, checks of a list (planned, then
// run in parts), a publication's results and what to do with red addresses, one subscriber's check,
// and the file each part hands DeBounce. The key (DEBOUNCE_API_KEY) never leaves the workers.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run } from '@swarm/db';
import {
  BULK_MAX_MEMBERS,
  CreateEmailCheckRunSchema,
  EMAIL_CHECK_CODES,
  EMAIL_CHECK_RED_BATCH,
  EmailCheckRedActionSchema,
  EmailCheckRedResultSchema,
  EmailCheckRunSchema,
  EmailCheckSettingsSchema,
  EmailCheckStatusSchema,
  EmailCheckSummarySchema,
  ImportEmailCheckSchema,
  ImportJobSchema,
  InstanceEmailChecksSchema,
  MemberEmailCheckSchema,
  UpdateInstanceEmailChecksSchema,
  UpdateInstanceEmailChecksWorkspaceSchema,
  idPattern,
  isEmailCheckCode,
  newId,
  type EmailCheckStatus,
  type InstanceEmailChecks,
} from '@swarm/domain';
import {
  DebounceError,
  EMAIL_CHECK_DAILY_CHECKS,
  EMAIL_CHECK_MONTHLY_LIST_CHECKS,
  EmailCheckBudgetError,
  activeRun,
  channelCheckCounts,
  createRun,
  debounceFor,
  emailCheckAvailability,
  emailCheckBudget,
  emailCheckFile,
  emailCheckListBudget,
  latestRun,
  loadRun,
  readChecks,
  readEmailCheckSettings,
  resumeRun,
  saveEmailCheckSettings,
  startRun,
  stopRun,
  toEmailCheckRun,
  jobQueue,
  type RunDeps,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel, requireWorkspace } from '../lib/access';
import { IMPORT_COLUMNS, requireRow, toImportJob, type ImportJobRow } from '../lib/audience';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { noticeInstanceChange, requireInstanceAdmin } from '../lib/instance-admin';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const emailChecks = createRouter();

// Instance changes are announced to the other instance admins (lib/instance-admin.ts).
emailChecks.use('/api/v1/instance/email-checks/*', noticeInstanceChange);
emailChecks.use('/api/v1/instance/email-checks', noticeInstanceChange);

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const channelParam = idParam('channelId', idPattern('channel'));
const runParams = workspaceParam.extend({
  runId: z
    .string()
    .regex(idPattern('emailCheckRun'))
    .openapi({ param: { name: 'runId', in: 'path' } }),
});

const BALANCE_KEY = 'email-checks:balance';
const BALANCE_TTL_SECONDS = 300;

interface Balance {
  balance: number | null;
  rejected: boolean;
}

/** DeBounce's balance, cached for five minutes: every Apps page would otherwise ask. */
async function balance(c: AppContext, fresh = false): Promise<Balance> {
  const e = env(c);
  const debounce = debounceFor(e);
  if (!debounce) return { balance: null, rejected: false };
  if (!fresh) {
    const cached = await e.CACHE.get<Balance>(BALANCE_KEY, 'json').catch(() => null);
    if (cached) return cached;
  }
  let answer: Balance;
  try {
    answer = { balance: await debounce.balance(), rejected: false };
  } catch (error) {
    if (!(error instanceof DebounceError)) throw error;
    answer = { balance: null, rejected: error.kind === 'key' || error.kind === 'forbidden' };
  }
  await e.CACHE.put(BALANCE_KEY, JSON.stringify(answer), {
    expirationTtl: BALANCE_TTL_SECONDS,
  }).catch(() => undefined);
  return answer;
}

async function status(
  c: AppContext,
  workspaceId: string,
  showBalance: boolean,
): Promise<EmailCheckStatus> {
  const e = env(c);
  const availability = await emailCheckAvailability(e.DB, e, workspaceId);
  return {
    ...availability,
    balance: showBalance && availability.available ? (await balance(c)).balance : null,
    settings: await readEmailCheckSettings(e.DB, workspaceId),
    budget: await budgetOf(e.DB, workspaceId),
  };
}

/** A workspace's single checks today and list checks this month, as the API shows them. */
async function budgetOf(db: D1Database, workspaceId: string) {
  const [single, list] = await Promise.all([
    emailCheckBudget(db, workspaceId),
    emailCheckListBudget(db, workspaceId),
  ]);
  return {
    ...single,
    listChecks: list.monthlyChecks,
    listUsedThisMonth: list.usedThisMonth,
    listResetsAt: new Date(list.resetsAt).toISOString(),
  };
}

/** The feature is on and the install has a key that this workspace may use. */
async function requireAvailable(c: AppContext, workspaceId: string, channelId?: string) {
  const e = env(c);
  const availability = await emailCheckAvailability(e.DB, e, workspaceId, channelId);
  if (!availability.enabled) {
    throw new ApiError('feature_disabled', 'Email checks are not turned on for this workspace.');
  }
  if (!availability.keySet) {
    throw new ApiError('unavailable', 'DeBounce isn’t set up on this Swarm yet.');
  }
  if (availability.access === 'not_allowed') {
    throw new ApiError(
      'forbidden',
      'The owner of this Swarm hasn’t let this workspace use DeBounce.',
    );
  }
}

function runDeps(c: AppContext): RunDeps {
  const e = env(c);
  return {
    db: e.DB,
    debounce: debounceFor(e),
    queue: jobQueue(e.JOBS_QUEUE),
    files: e.IMPORTS,
    fileOrigin: e.APP_ORIGIN,
  };
}

const auditCheck = (
  c: AppContext,
  workspaceId: string,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) =>
  appendAudit(env(c).DB, {
    workspaceId,
    actorId,
    action,
    targetType,
    targetId,
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });

// ---- Instance: the key, the balance and who may use it ------------------------------------------

async function readInstance(c: AppContext, fresh = false): Promise<InstanceEmailChecks> {
  const db = env(c).DB;
  const [rule, workspaces, money] = await Promise.all([
    first<{ every_workspace: number }>(
      db,
      'SELECT every_workspace FROM email_check_rules WHERE id = 1',
    ),
    all<{
      id: string;
      name: string;
      allowed: number;
      admin_owned: number;
      custom_daily: number;
      custom_list: number;
    }>(
      db,
      `SELECT w.id, w.name,
              EXISTS (SELECT 1 FROM email_check_workspaces a WHERE a.workspace_id = w.id) AS allowed,
              EXISTS (SELECT 1 FROM email_check_budgets b WHERE b.workspace_id = w.id) AS custom_daily,
              EXISTS (SELECT 1 FROM email_check_list_budgets l WHERE l.workspace_id = w.id) AS custom_list,
              EXISTS (SELECT 1 FROM seats s JOIN instance_admins i ON i.operator_id = s.operator_id
                       WHERE s.workspace_id = w.id AND s.role = 'owner') AS admin_owned
         FROM workspaces w ORDER BY w.name COLLATE NOCASE, w.id LIMIT 500`,
    ),
    balance(c, fresh),
  ]);
  return {
    keySet: !!env(c).DEBOUNCE_API_KEY,
    balance: money.balance,
    keyRejected: money.rejected,
    everyWorkspace: rule?.every_workspace === 1,
    defaults: {
      dailyChecks: EMAIL_CHECK_DAILY_CHECKS,
      listChecks: EMAIL_CHECK_MONTHLY_LIST_CHECKS,
    },
    workspaces: await Promise.all(
      workspaces.map(async (w) => {
        const budget = await budgetOf(db, w.id);
        return {
          id: w.id,
          name: w.name,
          allowed: w.allowed === 1,
          dailyChecks: budget.dailyChecks,
          usedToday: budget.usedToday,
          listChecks: budget.listChecks,
          listUsedThisMonth: budget.listUsedThisMonth,
          customDailyChecks: w.custom_daily === 1,
          customListChecks: w.custom_list === 1,
          ownedByInstanceAdmin: w.admin_owned === 1,
        };
      }),
    ),
  };
}

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/instance/email-checks',
    tags: ['Instance'],
    summary: 'DeBounce on this Swarm',
    description:
      'Instance admins only. Whether DEBOUNCE_API_KEY is set (never the key), the credits left (asked of DeBounce at most every five minutes, `fresh=1` asks now), and which workspaces may spend them: those allowed here (`allowed`; a workspace an instance admin makes is allowed when it is made), or all of them with everyWorkspace. `ownedByInstanceAdmin` is for information only and allows nothing by itself, because any owner can make a teammate an owner.',
    request: { query: z.object({ fresh: z.enum(['0', '1']).optional() }) },
    responses: {
      200: ok(InstanceEmailChecksSchema, 'DeBounce'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    await requireInstanceAdmin(c);
    return c.json({ data: await readInstance(c, c.req.valid('query').fresh === '1') }, 200);
  },
);

emailChecks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/email-checks',
    tags: ['Instance'],
    summary: 'Let every workspace use DeBounce',
    description:
      'Instance admins only. Off by default: the credits are the install owner’s, so only the workspaces an instance admin allowed one by one may use them.',
    request: { body: jsonBody(UpdateInstanceEmailChecksSchema) },
    responses: {
      200: ok(InstanceEmailChecksSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { everyWorkspace } = c.req.valid('json');
    await run(
      env(c).DB,
      `INSERT INTO email_check_rules (id, every_workspace, updated_by, updated_at) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT (id) DO UPDATE SET every_workspace = excluded.every_workspace,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      everyWorkspace ? 1 : 0,
      auth.operatorId,
      Date.now(),
    );
    c.get('log').info('instance email check rule changed', { everyWorkspace, by: auth.operatorId });
    return c.json({ data: await readInstance(c) }, 200);
  },
);

emailChecks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/instance/email-checks/workspaces/{workspaceId}',
    tags: ['Instance'],
    summary: 'Allow or stop DeBounce for one workspace',
    description:
      'Instance admins only, whether or not they have a seat in the workspace. Written to that workspace’s audit log. `dailyChecks` sets how many single checks (signups, additions, Check again) the workspace may spend per UTC day; null goes back to the install default (EMAIL_CHECK_DAILY_CHECKS). `listChecks` sets how many addresses its checks of a list (and imports that check addresses) may send to DeBounce per calendar month (UTC); null goes back to EMAIL_CHECK_MONTHLY_LIST_CHECKS. Settings > Instance shows and sets both.',
    request: { params: workspaceParam, body: jsonBody(UpdateInstanceEmailChecksWorkspaceSchema) },
    responses: {
      200: ok(InstanceEmailChecksSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const auth = await requireInstanceAdmin(c, { change: true });
    const { workspaceId } = c.req.valid('param');
    const { allowed, dailyChecks, listChecks } = c.req.valid('json');
    const db = env(c).DB;
    if (!(await first(db, 'SELECT 1 FROM workspaces WHERE id = ?1', workspaceId))) {
      throw new ApiError('not_found', 'Workspace not found.');
    }
    if (dailyChecks === null) {
      await run(db, 'DELETE FROM email_check_budgets WHERE workspace_id = ?1', workspaceId);
    } else if (dailyChecks !== undefined) {
      await run(
        db,
        `INSERT INTO email_check_budgets (workspace_id, daily_checks, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (workspace_id) DO UPDATE SET daily_checks = excluded.daily_checks,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        workspaceId,
        dailyChecks,
        auth.operatorId,
        Date.now(),
      );
    }
    if (listChecks === null) {
      await run(db, 'DELETE FROM email_check_list_budgets WHERE workspace_id = ?1', workspaceId);
    } else if (listChecks !== undefined) {
      await run(
        db,
        `INSERT INTO email_check_list_budgets (workspace_id, monthly_checks, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (workspace_id) DO UPDATE SET monthly_checks = excluded.monthly_checks,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        workspaceId,
        listChecks,
        auth.operatorId,
        Date.now(),
      );
    }
    if (dailyChecks !== undefined || listChecks !== undefined) {
      await auditCheck(
        c,
        workspaceId,
        auth.operatorId,
        'instance.email_checks_budget',
        'workspace',
        workspaceId,
        {
          ...(dailyChecks !== undefined ? { dailyChecks } : {}),
          ...(listChecks !== undefined ? { listChecks } : {}),
        },
      );
    }
    if (allowed) {
      await run(
        db,
        `INSERT INTO email_check_workspaces (workspace_id, allowed_by, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (workspace_id) DO NOTHING`,
        workspaceId,
        auth.operatorId,
        Date.now(),
      );
    } else {
      await run(db, 'DELETE FROM email_check_workspaces WHERE workspace_id = ?1', workspaceId);
    }
    await auditCheck(
      c,
      workspaceId,
      auth.operatorId,
      allowed ? 'instance.email_checks_allowed' : 'instance.email_checks_stopped',
      'workspace',
      workspaceId,
    );
    return c.json({ data: await readInstance(c) }, 200);
  },
);

// ---- A workspace's rules ---------------------------------------------------------------------

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/email-checks',
    tags: ['Email checks'],
    summary: 'Whether addresses can be checked here, and the rules',
    description:
      'Anyone with a seat sees whether checking is available and the rules; only admins see the credits left on the install’s DeBounce account.',
    request: { params: workspaceParam },
    responses: {
      200: ok(EmailCheckStatusSchema, 'Email checks'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'viewer');
    const admin = access.role === 'admin' || access.role === 'owner';
    return c.json({ data: await status(c, workspaceId, admin) }, 200);
  },
);

emailChecks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/email-checks/settings',
    tags: ['Email checks'],
    summary: 'What each colour does, per origin, and how long a result counts',
    description:
      'Signup forms and imports can accept, accept and tag (`email-<colour>`), require confirmation by email, or refuse (an import skips them). Additions by hand or through the API are checked afterwards, so they can only accept or tag.',
    request: { params: workspaceParam, body: jsonBody(EmailCheckSettingsSchema) },
    responses: {
      200: ok(EmailCheckStatusSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const settings = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    if (!(await emailCheckAvailability(env(c).DB, env(c), workspaceId)).enabled) {
      throw new ApiError('feature_disabled', 'Email checks are not turned on for this workspace.');
    }
    await saveEmailCheckSettings(env(c).DB, workspaceId, settings, access.auth.operatorId);
    await auditCheck(
      c,
      workspaceId,
      access.auth.operatorId,
      'email_checks.settings_changed',
      'workspace',
      workspaceId,
    );
    return c.json({ data: await status(c, workspaceId, true) }, 200);
  },
);

// ---- Checking a list ---------------------------------------------------------------------------

async function runFor(c: AppContext, workspaceId: string, runId: string) {
  const row = await loadRun(env(c).DB, runId);
  if (!row || row.workspace_id !== workspaceId) throw new ApiError('not_found', 'Check not found.');
  return row;
}

emailChecks.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/email-checks/runs',
    tags: ['Email checks'],
    summary: 'Plan a check of a list',
    description:
      'Counts the addresses in scope once each (an address in two publications is one), leaves out those with a result that still counts (or every checked one, with onlyNeverChecked), settles what Swarm can tell for free, and asks DeBounce for the balance. Nothing is sent to DeBounce until the plan is started. One check at a time per workspace.',
    request: { params: workspaceParam, body: jsonBody(CreateEmailCheckRunSchema) },
    responses: {
      202: ok(EmailCheckRunSchema, 'Planning'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'unavailable',
      ),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    await requireAvailable(c, workspaceId);
    if (input.channelId) {
      const channel = await first(
        e.DB,
        'SELECT 1 FROM channels WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL',
        input.channelId,
        workspaceId,
      );
      if (!channel) throw new ApiError('not_found', 'Publication not found.');
    }
    if (input.scope === 'segment') {
      const circle = await first(
        e.DB,
        'SELECT 1 FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
        input.circleId,
        input.channelId,
      );
      if (!circle) throw new ApiError('not_found', 'Segment not found.');
    }
    if (await activeRun(e.DB, workspaceId)) {
      throw new ApiError(
        'conflict',
        'A check is already planned or running. Finish or stop it first.',
      );
    }
    const now = Date.now();
    const runId = await createRun(
      e.DB,
      {
        workspaceId,
        scope: input.scope,
        channelId: input.scope === 'workspace' ? null : (input.channelId ?? null),
        circleId: input.scope === 'segment' ? (input.circleId ?? null) : null,
        onlyNeverChecked: input.onlyNeverChecked,
        createdBy: access.auth.operatorId,
      },
      now,
    );
    await e.JOBS_QUEUE.send({ type: 'email_check_plan', runId });
    await auditCheck(
      c,
      workspaceId,
      access.auth.operatorId,
      'email_checks.planned',
      'email_check_run',
      runId,
      {
        scope: input.scope,
      },
    );
    const row = await loadRun(e.DB, runId);
    return c.json({ data: await toEmailCheckRun(e.DB, row!) }, 202);
  },
);

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/email-checks/runs/{runId}',
    tags: ['Email checks'],
    summary: 'A check of a list: its plan and progress',
    request: { params: runParams },
    responses: {
      200: ok(EmailCheckRunSchema, 'Check'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, runId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    return c.json(
      { data: await toEmailCheckRun(env(c).DB, await runFor(c, workspaceId, runId)) },
      200,
    );
  },
);

const runAction = (action: 'start' | 'stop' | 'resume', summary: string, description: string) =>
  emailChecks.openapi(
    createRoute({
      method: 'post',
      path: `/api/v1/workspaces/{workspaceId}/email-checks/runs/{runId}/${action}`,
      tags: ['Email checks'],
      summary,
      description,
      request: { params: runParams },
      responses: {
        200: ok(EmailCheckRunSchema, 'Check'),
        ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'unavailable'),
      },
    }),
    async (c) => {
      const { workspaceId, runId } = c.req.valid('param');
      const access = await requireWorkspace(c, workspaceId, 'admin');
      const row = await runFor(c, workspaceId, runId);
      const e = env(c);
      const now = Date.now();
      if (action === 'start') {
        await requireAvailable(c, workspaceId);
        if (row.status !== 'planned')
          throw new ApiError('conflict', 'This check isn’t waiting to start.');
        try {
          await startRun(runDeps(c), runId, now);
        } catch (error) {
          // Past the workspace's list checks for this month: nothing was sent, and it can still
          // start once there are enough (next month, or a higher number from the owner).
          if (error instanceof EmailCheckBudgetError) throw new ApiError('conflict', error.message);
          throw error;
        }
      } else if (action === 'resume') {
        await requireAvailable(c, workspaceId);
        if (row.status !== 'paused') throw new ApiError('conflict', 'This check isn’t paused.');
        await resumeRun(runDeps(c), runId, now);
      } else {
        await stopRun(e.DB, runId, now, e.IMPORTS);
      }
      await auditCheck(
        c,
        workspaceId,
        access.auth.operatorId,
        `email_checks.${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'resumed'}`,
        'email_check_run',
        runId,
      );
      return c.json({ data: await toEmailCheckRun(e.DB, (await loadRun(e.DB, runId))!) }, 200);
    },
  );

runAction(
  'start',
  'Start a planned check',
  'Swarm’s own results are stored, then the addresses go to DeBounce in parts of 5,000, one part at a time (a small check asks one address at a time). Each address costs one credit. Running out of credits pauses the check. Every address the plan sends to DeBounce counts against the workspace’s list checks for the month (`budget.listChecks` on the workspace’s email checks); a check that needs more than are left answers 409 and doesn’t start, and what a stopped check never sent is given back.',
);
runAction(
  'stop',
  'Stop a check',
  'No further part is sent. DeBounce can’t cancel a part it already has, so that part finishes and its results are still stored. A plan that never started is canceled.',
);
runAction('resume', 'Resume a paused check', 'After credits were added, or the key was fixed.');

// ---- A publication's results ---------------------------------------------------------------------

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/email-checks',
    tags: ['Email checks'],
    summary: 'How the publication’s addresses stand',
    description:
      'Counts of subscribers who may be mailed by colour and by reason, how many were never checked or have an old result, and the workspace’s running or latest check.',
    request: { params: channelParam },
    responses: {
      200: ok(EmailCheckSummarySchema, 'Summary'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const availability = await emailCheckAvailability(e.DB, e, access.workspaceId, channelId);
    const settings = await readEmailCheckSettings(e.DB, access.workspaceId);
    const counts = await channelCheckCounts(e.DB, channelId, settings.validMonths);
    const last =
      (await activeRun(e.DB, access.workspaceId).then((r) => (r?.scope === 'import' ? null : r))) ??
      (await latestRun(e.DB, access.workspaceId));
    return c.json(
      {
        data: {
          ...availability,
          subscribers: counts.subscribers,
          counts: {
            green: counts.green,
            orange: counts.orange,
            red: counts.red,
            unchecked: counts.unchecked,
            stale: counts.stale,
          },
          reasons: counts.reasons
            .filter((r) => isEmailCheckCode(r.code))
            .map((r) => {
              const info = EMAIL_CHECK_CODES[r.code as keyof typeof EMAIL_CHECK_CODES];
              return { code: r.code, state: info.colour, label: info.label, count: r.n };
            })
            .sort((a, b) => b.count - a.count),
          validMonths: settings.validMonths,
          run: last ? await toEmailCheckRun(e.DB, last) : null,
        },
      },
      200,
    );
  },
);

interface RedRow {
  id: string;
  email: string;
  paying: number;
}

emailChecks.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/email-checks/red',
    tags: ['Email checks'],
    summary: 'Stop mailing red subscribers, or delete them',
    description:
      'Without confirm: only counts. suppress adds a suppression for this publication for each red subscriber who may be mailed (removable on the Sending page), up to 1,000 a request; send again for the rest. delete queues bulk deletes. Subscribers with a paid subscription are never changed: they are listed for a person to look at.',
    request: { params: channelParam, body: jsonBody(EmailCheckRedActionSchema) },
    responses: {
      200: ok(EmailCheckRedResultSchema, 'Result'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const now = Date.now();
    const suppress = input.action === 'suppress' ? 1 : 0;
    const rows = await all<RedRow>(
      e.DB,
      `SELECT m.id, m.email,
              EXISTS (SELECT 1 FROM member_entitlements me WHERE me.member_id = m.id AND me.kind = 'paid'
                        AND (me.expires_at IS NULL OR me.expires_at > ?3)) AS paying
         FROM members m JOIN email_checks ec
           ON ec.workspace_id = ?2 AND ec.email = m.email AND ec.state = 'red'
        WHERE m.channel_id = ?1 AND m.status IN ('pending', 'active', 'paused')
          AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?2
                AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = ?1)))
        ORDER BY m.id`,
      channelId,
      access.workspaceId,
      now,
      suppress,
    );
    const paying = rows.filter((r) => r.paying);
    const actionable = rows.filter((r) => !r.paying);
    const result = {
      actionable: actionable.length,
      done: 0,
      remaining: actionable.length,
      paying: paying.length,
      needsAttention: paying.slice(0, 50).map((r) => ({ id: r.id, email: r.email })),
      jobIds: [] as string[],
    };
    if (!input.confirm || !actionable.length) return c.json({ data: result }, 200);

    if (input.action === 'suppress') {
      const batch = actionable.slice(0, EMAIL_CHECK_RED_BATCH);
      const statements = batch.map((r) =>
        e.DB.prepare(
          `INSERT INTO suppressions (id, workspace_id, channel_id, email, reason, detail, created_at)
           VALUES (?1, ?2, ?3, ?4, 'manual', 'Email check: red', ?5) ON CONFLICT DO NOTHING`,
        ).bind(newId('suppression', now), access.workspaceId, channelId, r.email, now),
      );
      for (let i = 0; i < statements.length; i += 100)
        await e.DB.batch(statements.slice(i, i + 100));
      result.done = batch.length;
    } else {
      // Bulk deletes of up to BULK_MAX_MEMBERS each; the jobs worker applies them.
      const batch = actionable.slice(0, BULK_MAX_MEMBERS * 20);
      for (let i = 0; i < batch.length; i += BULK_MAX_MEMBERS) {
        const ids = batch.slice(i, i + BULK_MAX_MEMBERS).map((r) => r.id);
        const id = newId('bulkJob', now);
        await e.DB.prepare(
          `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, params_json, selection_json, total, created_by, created_at)
           VALUES (?1, ?2, ?3, 'delete', '{}', ?4, ?5, ?6, ?7)`,
        )
          .bind(
            id,
            access.workspaceId,
            channelId,
            JSON.stringify({ memberIds: ids }),
            ids.length,
            access.auth.operatorId,
            now,
          )
          .run();
        await e.JOBS_QUEUE.send({ type: 'bulk', jobId: id });
        result.jobIds.push(id);
      }
      result.done = batch.length;
    }
    result.remaining = actionable.length - result.done;
    await auditCheck(
      c,
      access.workspaceId,
      access.auth.operatorId,
      input.action === 'suppress' ? 'email_checks.red_suppressed' : 'email_checks.red_deleted',
      'channel',
      channelId,
      { count: result.done, paying: paying.length },
    );
    return c.json({ data: result }, 200);
  },
);

// ---- One subscriber -------------------------------------------------------------------------------

const memberParam = idParam('memberId', idPattern('member'));
const MemberCheckSchema = z
  .object({ available: z.boolean(), check: MemberEmailCheckSchema.nullable() })
  .openapi('MemberEmailCheckView');

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/members/{memberId}/email-check',
    tags: ['Email checks'],
    summary: 'A subscriber’s email check',
    request: { params: memberParam },
    responses: {
      200: ok(MemberCheckSchema, 'Email check'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const member = await first<{ channel_id: string; email: string }>(
      env(c).DB,
      'SELECT channel_id, email FROM members WHERE id = ?1',
      memberId,
    );
    if (!member) throw new ApiError('not_found', 'Subscriber not found.');
    const access = await requireChannel(c, member.channel_id, 'viewer').catch((error: unknown) => {
      throw error instanceof ApiError && error.code === 'not_found'
        ? new ApiError('not_found', 'Subscriber not found.')
        : error;
    });
    const e = env(c);
    const availability = await emailCheckAvailability(
      e.DB,
      e,
      access.workspaceId,
      member.channel_id,
    );
    const settings = await readEmailCheckSettings(e.DB, access.workspaceId);
    const checks = await readChecks(e.DB, access.workspaceId, [member.email], settings.validMonths);
    return c.json(
      { data: { available: availability.available, check: checks.get(member.email) ?? null } },
      200,
    );
  },
);

emailChecks.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/members/{memberId}/email-check',
    tags: ['Email checks'],
    summary: 'Check a subscriber’s address again',
    description:
      'Queued: the result arrives in a few seconds. Costs one credit unless Swarm’s own checks settle it.',
    request: { params: memberParam },
    responses: {
      202: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'unavailable'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const member = await first<{ channel_id: string }>(
      env(c).DB,
      'SELECT channel_id FROM members WHERE id = ?1',
      memberId,
    );
    if (!member) throw new ApiError('not_found', 'Subscriber not found.');
    const access = await requireChannel(c, member.channel_id, 'editor').catch((error: unknown) => {
      throw error instanceof ApiError && error.code === 'not_found'
        ? new ApiError('not_found', 'Subscriber not found.')
        : error;
    });
    await requireAvailable(c, access.workspaceId, member.channel_id);
    // Forced, so it is a stored request the jobs worker reads (and spends), not a message flag.
    const requestId = newId('emailCheckRequest');
    await run(
      env(c).DB,
      `INSERT INTO email_check_requests (id, workspace_id, channel_id, member_id, requested_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      requestId,
      access.workspaceId,
      member.channel_id,
      memberId,
      access.auth.operatorId,
      Date.now(),
    );
    await env(c).JOBS_QUEUE.send({
      type: 'email_check',
      workspaceId: access.workspaceId,
      channelId: member.channel_id,
      requestId,
    });
    return c.body(null, 202);
  },
);

// ---- Imports ---------------------------------------------------------------------------------------

emailChecks.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/imports/{importId}/email-check',
    tags: ['Imports'],
    summary: 'Check addresses during an import',
    description:
      'Before the import is confirmed. Its new addresses then go to DeBounce first (Swarm’s free checks first, and those with a result that still counts skipped), and follow the workspace’s import rules for their colour.',
    request: {
      params: idParam('importId', idPattern('importJob')),
      body: jsonBody(ImportEmailCheckSchema),
    },
    responses: {
      200: ok(ImportJobSchema, 'Import'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'unavailable',
      ),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { checkAddresses } = c.req.valid('json');
    const { row, access } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'editor',
    );
    if (checkAddresses) await requireAvailable(c, access.workspaceId, row.channel_id);
    const changed = await first(
      env(c).DB,
      `UPDATE import_jobs SET check_addresses = ?1, updated_at = ?2
        WHERE id = ?3 AND status IN ('uploaded', 'analyzing', 'analyzed') RETURNING id`,
      checkAddresses ? 1 : 0,
      Date.now(),
      importId,
    );
    if (!changed) throw new ApiError('conflict', 'This import has already started.');
    const fresh = await first<ImportJobRow>(
      env(c).DB,
      `SELECT channel_id, ${IMPORT_COLUMNS} FROM import_jobs WHERE id = ?1`,
      importId,
    );
    return c.json({ data: toImportJob(fresh!) }, 200);
  },
);

/** An import's own check, for whoever can see the import (it is not on the Subscribers page). */
async function importRun(c: AppContext, importId: string, minimum: 'viewer' | 'editor') {
  const { row, access } = await requireRow<ImportJobRow>(
    c,
    'import_jobs',
    IMPORT_COLUMNS,
    importId,
    minimum,
  );
  const run = row.email_check_run_id ? await loadRun(env(c).DB, row.email_check_run_id) : null;
  return { row, access, run: run && run.workspace_id === access.workspaceId ? run : null };
}

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/imports/{importId}/email-check',
    tags: ['Imports'],
    summary: 'The email check of an import',
    description: 'Null until the import starts its check.',
    request: { params: idParam('importId', idPattern('importJob')) },
    responses: {
      200: ok(EmailCheckRunSchema.nullable(), 'Check'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { run } = await importRun(c, importId, 'viewer');
    return c.json({ data: run ? await toEmailCheckRun(env(c).DB, run) : null }, 200);
  },
);

emailChecks.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/imports/{importId}/email-check/{action}',
    tags: ['Imports'],
    summary: 'Resume an import’s paused check, or import without checking the rest',
    description:
      '`resume` carries on after credits were added. `stop` sends no further part: the import then goes ahead, and addresses DeBounce did not check are imported unchecked.',
    request: {
      params: idParam('importId', idPattern('importJob')).extend({
        action: z.enum(['resume', 'stop']).openapi({ param: { name: 'action', in: 'path' } }),
      }),
    },
    responses: {
      200: ok(EmailCheckRunSchema, 'Check'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'unavailable'),
    },
  }),
  async (c) => {
    const { importId, action } = c.req.valid('param');
    const { row, access, run } = await importRun(c, importId, 'editor');
    if (!run) throw new ApiError('not_found', 'This import has no email check.');
    const now = Date.now();
    if (action === 'resume') {
      await requireAvailable(c, access.workspaceId, row.channel_id);
      if (run.status !== 'paused') throw new ApiError('conflict', 'This check isn’t paused.');
      await resumeRun(runDeps(c), run.id, now);
    } else {
      await stopRun(env(c).DB, run.id, now, env(c).IMPORTS);
      // A check stopped with no part at DeBounce is over: the import carries on now.
      const after = await loadRun(env(c).DB, run.id);
      if (after?.status === 'stopped' || after?.status === 'canceled') {
        await env(c).JOBS_QUEUE.send({ type: 'import_run', jobId: importId });
      }
    }
    await auditCheck(
      c,
      access.workspaceId,
      access.auth.operatorId,
      action === 'stop' ? 'email_checks.stopped' : 'email_checks.resumed',
      'email_check_run',
      run.id,
      { importId },
    );
    return c.json(
      { data: await toEmailCheckRun(env(c).DB, (await loadRun(env(c).DB, run.id))!) },
      200,
    );
  },
);

// ---- The file DeBounce fetches ------------------------------------------------------------------------

emailChecks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/public/email-check-lists/{file}',
    tags: ['Email checks'],
    summary: 'One part of a check, for DeBounce to fetch (public)',
    description:
      'Addresses only, one per line. The address carries a random token made for this part alone; only its hash is stored. It answers 404 once DeBounce has finished the part, and after 24 hours.',
    request: {
      params: z.object({
        file: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}\.csv$/)
          .openapi({ param: { name: 'file', in: 'path' } }),
      }),
    },
    responses: {
      200: { description: 'The list', content: { 'text/csv': { schema: z.string() } } },
      ...errors('not_found'),
    },
  }),
  async (c) => {
    const { file } = c.req.valid('param');
    const e = env(c);
    const body = await emailCheckFile(e.DB, e.IMPORTS, file.slice(0, -'.csv'.length));
    if (body === null) throw new ApiError('not_found', 'Not found.');
    return c.body(body, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
    });
  },
);
