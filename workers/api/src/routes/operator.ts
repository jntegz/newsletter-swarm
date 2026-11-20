// Open Operator (Phase 8) in the dashboard: MCP settings, the agent audit log with its chain
// check, and the approval queue (Settings → Developers → Open Operator). Workspace-level, admin
// and above; changes and decisions are audited. The MCP endpoint is routes/mcp.ts. Contract:
// docs/open-operator.md.
import { createRoute } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  AgentActionSchema,
  AgentActionsQuerySchema,
  AgentApprovalSchema,
  AgentApprovalsQuerySchema,
  AgentLogVerificationSchema,
  AgentSettingsSchema,
  CHAIN_VERIFY_MAX,
  ChainVerifyQuerySchema,
  RejectAgentApprovalSchema,
  UpdateAgentSettingsSchema,
  idPattern,
  page,
  type AgentAction,
  type AgentApproval,
  type AgentSettings,
} from '@swarm/domain';
import {
  approvalStatus,
  approveAgentApproval,
  readApproval,
  rejectAgentApproval,
  resolveAgentApproval,
  verifyAgentLogStep,
  type ApprovalRow,
  type DecideResult,
  teammateEmailSql,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireWorkspace } from '../lib/access';
import { verifyChainPage } from '../lib/chain-verify';
import { agentTargetChanged } from '../lib/agentEffects';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import {
  approverRefusal,
  decideDeps,
  mcpUrl,
  operatorFlags,
  readAgentSettings,
} from '../lib/operator';
import { decodeCursor, encodeCursor } from '../v2/route';

export const operator = createRouter();

const BASE = '/api/v1/workspaces/{workspaceId}';
const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const approvalParams = workspaceParam.extend(
  idParam('approvalId', idPattern('agentApproval')).shape,
);
const tags = ['Open Operator'];

const admin = (c: AppContext, workspaceId: string) => requireWorkspace(c, workspaceId, 'admin');

const audit = (
  c: AppContext,
  workspaceId: string,
  operatorId: string,
  action: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId,
    actorId: operatorId,
    action,
    targetType: targetId ? 'agent_approval' : 'workspace',
    targetId: targetId ?? workspaceId,
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });

/**
 * The key's name and prefix, the OAuth app's name, or the operator's address with "via Copilot",
 * for a credential column pair (a redacted former teammate's placeholder, teammateEmailSql).
 */
const CREDENTIAL_LABEL = (alias: string) => `CASE ${alias}.principal_kind
    WHEN 'key' THEN (SELECT k.name || ' (' || k.prefix || '…)' FROM api_keys k WHERE k.id = ${alias}.principal_id)
    WHEN 'copilot' THEN (SELECT ${teammateEmailSql('o', `${alias}.workspace_id`)} || ' via Copilot'
                           FROM operators o WHERE o.id = ${alias}.principal_id)
    ELSE (SELECT a.name FROM oauth_grants g JOIN oauth_apps a ON a.id = g.app_id WHERE g.id = ${alias}.principal_id)
  END`;

async function settingsView(c: AppContext, workspaceId: string): Promise<AgentSettings> {
  const db = env(c).DB;
  const [settings, flags, pending] = await Promise.all([
    readAgentSettings(db, workspaceId),
    operatorFlags(c, workspaceId),
    first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM agent_approvals
        WHERE workspace_id = ?1 AND status = 'pending' AND expires_at > ?2`,
      workspaceId,
      Date.now(),
    ),
  ]);
  return {
    mcpEnabled: settings.mcpEnabled,
    approvalMode: settings.approvalMode,
    approvalTtlHours: settings.approvalTtlHours,
    separateApprover: settings.separateApprover,
    exposedHoldMinutes: settings.exposedHoldMinutes,
    copilotMemberDetail: settings.copilotMemberDetail,
    flags,
    mcpUrl: mcpUrl(c),
    pendingApprovals: pending?.n ?? 0,
    updatedAt: settings.updatedAt === null ? null : toIso(settings.updatedAt),
  };
}

operator.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/agent-settings`,
    tags,
    summary: 'Open Operator settings',
    description:
      'MCP access, the approval mode and window, both flags, the MCP URL and the pending count.',
    request: { params: workspaceParam },
    responses: {
      200: ok(AgentSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await admin(c, workspaceId);
    return c.json({ data: await settingsView(c, workspaceId) }, 200);
  },
);

operator.openapi(
  createRoute({
    method: 'put',
    path: `${BASE}/agent-settings`,
    tags,
    summary: 'Change Open Operator settings',
    description: 'Needs the open_operator_mcp flag. Audited as agent_settings.updated.',
    request: { params: workspaceParam, body: jsonBody(UpdateAgentSettingsSchema) },
    responses: {
      200: ok(AgentSettingsSchema, 'Settings'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth } = await admin(c, workspaceId);
    const input = c.req.valid('json');
    const flags = await operatorFlags(c, workspaceId);
    if (!flags.openOperatorMcp) {
      throw new ApiError('feature_disabled', 'Open Operator is not available for this workspace.');
    }
    const db = env(c).DB;
    const current = await readAgentSettings(db, workspaceId);
    const next = {
      mcpEnabled: input.mcpEnabled ?? current.mcpEnabled,
      approvalMode: input.approvalMode ?? current.approvalMode,
      approvalTtlHours: input.approvalTtlHours ?? current.approvalTtlHours,
      separateApprover: input.separateApprover ?? current.separateApprover,
      exposedHoldMinutes: input.exposedHoldMinutes ?? current.exposedHoldMinutes,
      copilotMemberDetail: input.copilotMemberDetail ?? current.copilotMemberDetail,
    };
    const now = Date.now();
    await run(
      db,
      `INSERT INTO agent_settings (workspace_id, mcp_enabled, approval_mode, approval_ttl_hours,
         separate_approver, exposed_hold_minutes, copilot_member_detail, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (workspace_id) DO UPDATE SET mcp_enabled = excluded.mcp_enabled,
         approval_mode = excluded.approval_mode, approval_ttl_hours = excluded.approval_ttl_hours,
         separate_approver = excluded.separate_approver,
         exposed_hold_minutes = excluded.exposed_hold_minutes,
         copilot_member_detail = excluded.copilot_member_detail,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      workspaceId,
      next.mcpEnabled ? 1 : 0,
      next.approvalMode,
      next.approvalTtlHours,
      next.separateApprover ? 1 : 0,
      next.exposedHoldMinutes,
      next.copilotMemberDetail,
      auth.operatorId,
      now,
    );
    const { updatedAt: _updatedAt, ...before } = current;
    await audit(c, workspaceId, auth.operatorId, 'agent_settings.updated', null, {
      before,
      after: next,
    });
    return c.json({ data: await settingsView(c, workspaceId) }, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// The agent audit log

interface ActionRow {
  id: string;
  seq: number;
  source: AgentAction['source'];
  principal_kind: AgentAction['credential']['kind'];
  principal_id: string;
  credential_label: string | null;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  channel_id: string | null;
  risk: AgentAction['risk'];
  arguments_json: string;
  outcome: AgentAction['outcome'];
  status_code: number | null;
  error_code: string | null;
  latency_ms: number;
  approval_id: string | null;
  copilot_request_id: string | null;
  created_at: number;
}

const toAction = (row: ActionRow): AgentAction => ({
  id: row.id,
  seq: row.seq,
  source: row.source,
  credential: { kind: row.principal_kind, id: row.principal_id, label: row.credential_label },
  client: { name: row.client_name, version: row.client_version },
  tool: row.tool,
  channelId: row.channel_id,
  risk: row.risk,
  arguments: JSON.parse(row.arguments_json) as unknown,
  outcome: row.outcome,
  statusCode: row.status_code,
  errorCode: row.error_code,
  latencyMs: row.latency_ms,
  approvalId: row.approval_id,
  copilotRequestId: row.copilot_request_id,
  createdAt: toIso(row.created_at),
});

operator.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/agent-actions`,
    tags,
    summary: 'The agent audit log, newest first',
    description: 'Every MCP tool call and every approved call that ran. On every plan.',
    request: { params: workspaceParam, query: AgentActionsQuerySchema },
    responses: {
      200: ok(page(AgentActionSchema), 'Agent actions'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await admin(c, workspaceId);
    const { cursor, limit, outcome, tool, principalId } = c.req.valid('query');
    const position = decodeCursor(cursor);
    const before = position === undefined ? Number.MAX_SAFE_INTEGER : Number(position);
    if (!Number.isSafeInteger(before)) {
      throw new ApiError('invalid_input', 'That page cursor is not valid.');
    }
    const rows = await all<ActionRow>(
      env(c).DB,
      `SELECT x.id, x.seq, x.source, x.principal_kind, x.principal_id, ${CREDENTIAL_LABEL('x')} AS credential_label,
              x.client_name, x.client_version, x.tool, x.channel_id, x.risk, x.arguments_json, x.outcome,
              x.status_code, x.error_code, x.latency_ms, x.approval_id, x.copilot_request_id, x.created_at
         FROM agent_actions x
        WHERE x.workspace_id = ?1 AND x.seq < ?2 AND (?3 IS NULL OR x.outcome = ?3)
          AND (?4 IS NULL OR x.tool = ?4) AND (?5 IS NULL OR x.principal_id = ?5)
        ORDER BY x.seq DESC LIMIT ?6`,
      workspaceId,
      before,
      outcome ?? null,
      tool ?? null,
      principalId ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toAction);
    const nextCursor = rows.length > limit ? encodeCursor(String(items.at(-1)?.seq)) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

operator.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/agent-actions/verify`,
    tags,
    summary: 'Verify the agent log’s hash chain',
    description: `Checks up to \`limit\` rows per request (at most ${CHAIN_VERIFY_MAX.toLocaleString('en-US')}), oldest first. While \`complete\` is false, \`ok\` covers only the rows checked so far: pass \`nextCursor\` as \`cursor\` to go on.`,
    request: { params: workspaceParam, query: ChainVerifyQuerySchema },
    responses: {
      200: ok(AgentLogVerificationSchema, 'Verification'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await admin(c, workspaceId);
    const result = await verifyChainPage(
      env(c).DB,
      env(c).AUTH_KEYS,
      workspaceId,
      'agent_actions',
      verifyAgentLogStep,
      c.req.valid('query'),
    );
    return c.json({ data: result }, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// Approvals

type ApprovalView = ApprovalRow & {
  credential_label: string | null;
  decider_email: string | null;
};

const APPROVAL_SELECT = `SELECT p.*, ${CREDENTIAL_LABEL('p')} AS credential_label,
    ${teammateEmailSql('o', 'p.workspace_id')} AS decider_email
  FROM agent_approvals p LEFT JOIN operators o ON o.id = p.decided_by`;

function toApproval(
  row: ApprovalView,
  now = Date.now(),
  targetChanged: string | null = null,
): AgentApproval {
  return {
    id: row.id,
    status: approvalStatus(row, now),
    tool: row.tool,
    risk: row.risk,
    channelId: row.channel_id,
    credential: { kind: row.principal_kind, id: row.principal_id, label: row.credential_label },
    client: { name: row.client_name, version: row.client_version },
    arguments: JSON.parse(row.arguments_json) as unknown,
    request:
      row.status === 'pending' && row.expires_at > now
        ? {
            method: row.method,
            path: row.path,
            body: row.body_json === null ? null : (JSON.parse(row.body_json) as unknown),
          }
        : null,
    actionId: row.action_id,
    target:
      row.target_json === null ? null : (JSON.parse(row.target_json) as AgentApproval['target']),
    targetChanged,
    holdReason: row.hold_reason,
    copilotRequestId: row.copilot_request_id,
    expiresAt: toIso(row.expires_at),
    decidedBy:
      row.decided_by && row.decider_email ? { id: row.decided_by, email: row.decider_email } : null,
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    reason: row.reason,
    result:
      row.result_json === null
        ? null
        : { statusCode: row.result_status, summary: JSON.parse(row.result_json) as unknown },
    createdAt: toIso(row.created_at),
  };
}

async function approvalView(c: AppContext, workspaceId: string, approvalId: string) {
  const row = await first<ApprovalView>(
    env(c).DB,
    `${APPROVAL_SELECT} WHERE p.id = ?1 AND p.workspace_id = ?2`,
    approvalId,
    workspaceId,
  );
  if (!row) throw new ApiError('not_found', 'Approval not found.');
  const now = Date.now();
  const changed =
    approvalStatus(row, now) === 'pending' ? await agentTargetChanged(env(c).DB)(row) : null;
  return toApproval(row, now, changed);
}

operator.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/agent-approvals`,
    tags,
    summary: 'Agent calls held for approval, newest first',
    request: { params: workspaceParam, query: AgentApprovalsQuerySchema },
    responses: {
      200: ok(page(AgentApprovalSchema), 'Approvals'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await admin(c, workspaceId);
    const { cursor, limit, status } = c.req.valid('query');
    const position = decodeCursor(cursor);
    const now = Date.now();
    const rows = await all<ApprovalView>(
      env(c).DB,
      `${APPROVAL_SELECT}
        WHERE p.workspace_id = ?1 AND (?2 IS NULL OR p.id < ?2)
          -- pending and expired are both stored as pending; the expiry tells them apart.
          AND (?4 = 'all'
               OR (?4 = 'pending' AND p.status = 'pending' AND p.expires_at > ?3)
               OR (?4 = 'expired' AND p.status = 'pending' AND p.expires_at <= ?3)
               OR (?4 NOT IN ('all', 'pending', 'expired') AND p.status = ?4))
        ORDER BY p.id DESC LIMIT ?5`,
      workspaceId,
      position ?? null,
      now,
      status,
      limit + 1,
    );
    const items = rows.slice(0, limit).map((row) => toApproval(row, now));
    const nextCursor = rows.length > limit ? encodeCursor(items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

operator.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/agent-approvals/{approvalId}`,
    tags,
    summary: 'One held call, with the exact request while it is pending',
    request: { params: approvalParams },
    responses: {
      200: ok(AgentApprovalSchema, 'Approval'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, approvalId } = c.req.valid('param');
    await admin(c, workspaceId);
    return c.json({ data: await approvalView(c, workspaceId, approvalId) }, 200);
  },
);

function decided(result: DecideResult): void {
  if (result.kind === 'not_found') throw new ApiError('not_found', 'Approval not found.');
  if (result.kind === 'conflict') {
    throw new ApiError(
      'conflict',
      `This approval is ${result.status} and can no longer be decided.`,
    );
  }
}

operator.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/agent-approvals/{approvalId}/approve`,
    tags,
    summary: 'Approve a held call and run it',
    description:
      'Runs the stored request once, after checking again that the credential is live and holds the scope and Channel. Needs open_operator_mcp or copilot_actions. Audited as agent_approval.approved.',
    request: { params: approvalParams },
    responses: {
      200: ok(AgentApprovalSchema, 'The approval, executed or failed'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, approvalId } = c.req.valid('param');
    const { auth } = await admin(c, workspaceId);
    const flags = await operatorFlags(c, workspaceId);
    if (!flags.openOperatorMcp && !flags.copilotActions) {
      throw new ApiError('feature_disabled', 'Approvals are not available for this workspace.');
    }
    const pending = await readApproval(env(c).DB, workspaceId, approvalId);
    if (!pending) throw new ApiError('not_found', 'Approval not found.');
    const separation = await approverRefusal(c, pending, auth.operatorId);
    if (separation) throw new ApiError('forbidden', separation);
    const result = await approveAgentApproval(decideDeps(c, workspaceId), {
      workspaceId,
      approvalId,
      operatorId: auth.operatorId,
    });
    decided(result);
    const row = (result as Extract<DecideResult, { kind: 'decided' }>).row;
    await audit(c, workspaceId, auth.operatorId, 'agent_approval.approved', approvalId, {
      tool: row.tool,
      via: { kind: row.principal_kind, id: row.principal_id },
      outcome: row.status,
      statusCode: row.result_status,
    });
    return c.json({ data: await approvalView(c, workspaceId, approvalId) }, 200);
  },
);

operator.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/agent-approvals/{approvalId}/resolve`,
    tags,
    summary: 'Find out what happened to an approved call whose outcome is unknown',
    description:
      'For an approval left `approved` with no result for at least 10 minutes (its run was interrupted). Sends the stored request again under the same Idempotency-Key, so the API answers for the first attempt: a stored answer is replayed and recorded (`result.summary.replayed`), a first attempt that started and left no answer runs nothing and stays approved with a note to check the target, and a request that never reached the API runs now. Authorisation and the target are checked again. Not possible after 24 hours, when the answer is no longer kept. Audited as agent_approval.resolved.',
    request: { params: approvalParams },
    responses: {
      200: ok(AgentApprovalSchema, 'The approval, executed, failed, or still unknown'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, approvalId } = c.req.valid('param');
    const { auth } = await admin(c, workspaceId);
    const flags = await operatorFlags(c, workspaceId);
    if (!flags.openOperatorMcp && !flags.copilotActions) {
      throw new ApiError('feature_disabled', 'Approvals are not available for this workspace.');
    }
    const result = await resolveAgentApproval(decideDeps(c, workspaceId), {
      workspaceId,
      approvalId,
      operatorId: auth.operatorId,
    });
    if (result.kind === 'too_soon') {
      throw new ApiError(
        'conflict',
        'This call was approved a moment ago and may still be running. Try again in a few minutes.',
      );
    }
    if (result.kind === 'too_old') {
      throw new ApiError(
        'conflict',
        'This call is too old to check automatically. Check its target by hand before asking for it again.',
      );
    }
    if (result.kind !== 'still_unknown') decided(result);
    const row = (result as { row: ApprovalRow }).row;
    await audit(c, workspaceId, auth.operatorId, 'agent_approval.resolved', approvalId, {
      tool: row.tool,
      via: { kind: row.principal_kind, id: row.principal_id },
      outcome: result.kind === 'still_unknown' ? 'unknown' : row.status,
      statusCode: row.result_status,
    });
    return c.json({ data: await approvalView(c, workspaceId, approvalId) }, 200);
  },
);

operator.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/agent-approvals/{approvalId}/reject`,
    tags,
    summary: 'Reject a held call',
    description: 'The call never runs. Audited as agent_approval.rejected.',
    request: { params: approvalParams, body: jsonBody(RejectAgentApprovalSchema) },
    responses: {
      200: ok(AgentApprovalSchema, 'The rejected approval'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, approvalId } = c.req.valid('param');
    const { auth } = await admin(c, workspaceId);
    const reason = c.req.valid('json').reason || null;
    const result = await rejectAgentApproval(env(c).DB, {
      workspaceId,
      approvalId,
      operatorId: auth.operatorId,
      reason,
    });
    decided(result);
    const row = (result as Extract<DecideResult, { kind: 'decided' }>).row;
    await audit(c, workspaceId, auth.operatorId, 'agent_approval.rejected', approvalId, {
      tool: row.tool,
      via: { kind: row.principal_kind, id: row.principal_id },
    });
    return c.json({ data: await approvalView(c, workspaceId, approvalId) }, 200);
  },
);
