// Open Operator plumbing shared by the MCP endpoint (routes/mcp.ts) and the dashboard routes
// (routes/operator.ts): workspace settings and flags, the tool list derived from the /v2
// document, the in-process dispatch, and re-resolving a credential by id when an approval runs.
// Contract: docs/open-operator.md.
import { channelAccess, first, lowerRole, workspaceRole } from '@swarm/db';
import {
  AGENT_SETTINGS_DEFAULTS,
  COPILOT_ROLE_SCOPES,
  MCP_PATH,
  type AgentPrincipalKind,
  type ApiScope,
  type ApprovalMode,
  type CopilotMemberDetail,
  type Plan,
  type SeatRole,
} from '@swarm/domain';
import {
  deriveAgentTools,
  type AgentTool,
  type ApprovalPolicy,
  type ApprovalRow,
  type DecideDeps,
  type OperatorDeps,
} from '@swarm/engine';
import { D1FlagStore, FlagService } from '@swarm/flags';
import type { ApiPrincipal } from '../v2/context';
import { v2OpenApiDocument } from '../v2/docs';
import { internalV2Fetch } from '../v2/internal';
import { LIVE_GRANT_SQL, effectiveScopes } from '../v2/oauth';
import { SCOPE_EXTENSION } from '../v2/route';
import { agentEffectOf, agentTargetChanged, agentTargetOf } from './agentEffects';
import { env, type AppContext } from './context';

interface StoredAgentSettings {
  mcpEnabled: boolean;
  approvalMode: ApprovalMode;
  approvalTtlHours: number;
  separateApprover: boolean;
  exposedHoldMinutes: number;
  copilotMemberDetail: CopilotMemberDetail;
  updatedAt: number | null;
}

export async function readAgentSettings(
  db: D1Database,
  workspaceId: string,
): Promise<StoredAgentSettings> {
  const row = await first<{
    mcp_enabled: number;
    approval_mode: ApprovalMode;
    approval_ttl_hours: number;
    separate_approver: number;
    exposed_hold_minutes: number;
    copilot_member_detail: CopilotMemberDetail;
    updated_at: number;
  }>(
    db,
    `SELECT mcp_enabled, approval_mode, approval_ttl_hours, separate_approver, exposed_hold_minutes,
            copilot_member_detail, updated_at
       FROM agent_settings WHERE workspace_id = ?1`,
    workspaceId,
  );
  return row
    ? {
        mcpEnabled: row.mcp_enabled === 1,
        approvalMode: row.approval_mode,
        approvalTtlHours: row.approval_ttl_hours,
        separateApprover: row.separate_approver === 1,
        exposedHoldMinutes: row.exposed_hold_minutes,
        copilotMemberDetail: row.copilot_member_detail,
        updatedAt: row.updated_at,
      }
    : { ...AGENT_SETTINGS_DEFAULTS, updatedAt: null };
}

export async function operatorFlags(
  c: AppContext,
  workspaceId: string,
): Promise<{ openOperatorMcp: boolean; copilotActions: boolean }> {
  const e = env(c);
  const flags = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).all({ workspaceId });
  return { openOperatorMcp: flags.open_operator_mcp, copilotActions: flags.copilot_actions };
}

/** The MCP endpoint: the api worker serves the dashboard's origin. */
export const mcpUrl = (c: AppContext) => `${env(c).APP_ORIGIN}${MCP_PATH}`;

let tools: AgentTool[] | undefined;

/** The tools, derived once per isolate from the same document /v2/openapi.json serves. */
export function agentTools(): AgentTool[] {
  tools ??= deriveAgentTools(v2OpenApiDocument(), SCOPE_EXTENSION);
  return tools;
}

const dispatchFor =
  (c: AppContext): OperatorDeps<ApiPrincipal>['dispatch'] =>
  (principal, request, options) =>
    internalV2Fetch(c, principal, {
      ...request,
      idempotencyKey: options.idempotencyKey,
      approvedBy: options.approvedBy,
    });

export function operatorDeps(c: AppContext, policy: ApprovalPolicy): OperatorDeps<ApiPrincipal> {
  const db = env(c).DB;
  return {
    db,
    tools: agentTools(),
    policy,
    dispatch: dispatchFor(c),
    effectOf: agentEffectOf(db),
    targetOf: agentTargetOf(db),
  };
}

/** Why calls from this workspace may not run now, or null. */
async function mcpBlockedReason(c: AppContext, workspaceId: string): Promise<string | null> {
  const flags = await operatorFlags(c, workspaceId);
  if (!flags.openOperatorMcp) return 'Open Operator is not available for this workspace.';
  const settings = await readAgentSettings(env(c).DB, workspaceId);
  if (!settings.mcpEnabled) return 'MCP access is turned off in this workspace’s settings.';
  return null;
}

/** Why Copilot actions may not run for this workspace (and Channel) now, or null. */
export async function copilotActionsBlockedReason(
  c: AppContext,
  workspaceId: string,
  channelId: string | null,
): Promise<string | null> {
  const e = env(c);
  const flags = new FlagService(new D1FlagStore(e.DB, e.CACHE));
  const scope = channelId ? { workspaceId, channelId } : { workspaceId };
  if (!(await flags.enabled('copilot', scope))) return 'Copilot is not available.';
  if (!(await flags.enabled('copilot_actions', scope))) {
    return 'Copilot actions are not available.';
  }
  return null;
}

export function decideDeps(c: AppContext, workspaceId: string): DecideDeps<ApiPrincipal> {
  return {
    db: env(c).DB,
    resolvePrincipal: (kind, id, row) =>
      kind === 'copilot'
        ? copilotPrincipal(env(c).DB, id, row.workspace_id, row.channel_id)
        : principalForCredential(env(c).DB, kind, id),
    blockedReason: (row) =>
      row.principal_kind === 'copilot'
        ? copilotActionsBlockedReason(c, workspaceId, row.channel_id)
        : mcpBlockedReason(c, workspaceId),
    targetChanged: agentTargetChanged(env(c).DB),
    dispatch: dispatchFor(c),
  };
}

/**
 * The principal for an operator acting through Copilot, as they are now: limited to one Channel,
 * with the scopes of the lower of their workspace role and their role on that Channel (so never
 * wider than either). Without a Channel (a workspace-wide call being approved) the seat role is
 * used and no Channel is reachable. Null when the operator has no seat, or no access to the
 * Channel, any more.
 */
export async function copilotPrincipal(
  db: D1Database,
  operatorId: string,
  workspaceId: string,
  channelId: string | null,
): Promise<ApiPrincipal | null> {
  const [seat, plan] = await Promise.all([
    workspaceRole(db, operatorId, workspaceId),
    first<{ plan: Plan }>(db, 'SELECT plan FROM workspaces WHERE id = ?1', workspaceId),
  ]);
  if (!seat || !plan) return null;
  let role: SeatRole = seat;
  if (channelId) {
    const access = await channelAccess(db, operatorId, channelId);
    if (!access || access.deleted || access.workspaceId !== workspaceId) return null;
    role = lowerRole(seat, access.role);
  }
  return {
    kind: 'copilot',
    id: operatorId,
    workspaceId,
    channelIds: channelId ? [channelId] : [],
    scopes: [...COPILOT_ROLE_SCOPES[role]],
    plan: plan.plan,
    rateCap: null,
    role,
  };
}

/**
 * A credential as it is now, by id, for running an approved call: the key unrevoked and
 * unexpired, or the grant and its app unrevoked, the consenting operator still admin or owner,
 * and at least one live token. Null otherwise. The key's IP allowlist is not checked here: the
 * call it guarded was made earlier, and the approval comes from the dashboard.
 */
async function principalForCredential(
  db: D1Database,
  kind: AgentPrincipalKind,
  id: string,
  now: number = Date.now(),
): Promise<ApiPrincipal | null> {
  if (kind === 'copilot') return null;
  if (kind === 'key') {
    const row = await first<{
      workspace_id: string;
      channel_ids_json: string | null;
      scopes_json: string;
      rate_cap: number | null;
      plan: Plan;
    }>(
      db,
      `SELECT k.workspace_id, k.channel_ids_json, k.scopes_json, k.rate_cap, w.plan
         FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
        WHERE k.id = ?1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?2)`,
      id,
      now,
    );
    if (!row) return null;
    return {
      kind: 'key',
      id,
      workspaceId: row.workspace_id,
      channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
      scopes: JSON.parse(row.scopes_json) as ApiScope[],
      plan: row.plan,
      rateCap: row.rate_cap,
    };
  }
  const row = await first<{
    workspace_id: string;
    channel_ids_json: string | null;
    grant_scopes: string;
    app_scopes: string;
    plan: Plan;
  }>(
    db,
    `SELECT g.workspace_id, g.channel_ids_json, g.scopes_json AS grant_scopes,
            a.scopes_json AS app_scopes, w.plan
       FROM oauth_grants g
       JOIN oauth_apps a ON a.id = g.app_id
       JOIN workspaces w ON w.id = g.workspace_id
      WHERE g.id = ?1 AND g.resource = 'mcp' AND ${LIVE_GRANT_SQL}
        AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL
                      AND t.expires_at > ?2)`,
    id,
    now,
  );
  if (!row) return null;
  return {
    kind: 'oauth',
    id,
    workspaceId: row.workspace_id,
    channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
    scopes: effectiveScopes(row.grant_scopes, row.app_scopes),
    plan: row.plan,
    rateCap: null,
  };
}

/**
 * The operators who caused a held call: the teammate who asked Copilot, the API key's creator,
 * or the admin who consented to the OAuth grant (and who registered its app, when that is the
 * same workspace). Unknown (a deleted creator) is an empty list.
 */
async function requestersOf(db: D1Database, row: ApprovalRow): Promise<string[]> {
  if (row.principal_kind === 'copilot') return [row.principal_id];
  if (row.principal_kind === 'key') {
    const key = await first<{ created_by: string | null }>(
      db,
      'SELECT created_by FROM api_keys WHERE id = ?1',
      row.principal_id,
    );
    return key?.created_by ? [key.created_by] : [];
  }
  const grant = await first<{ operator_id: string | null; app_creator: string | null }>(
    db,
    `SELECT g.operator_id, CASE WHEN a.workspace_id = g.workspace_id THEN a.created_by END AS app_creator
       FROM oauth_grants g JOIN oauth_apps a ON a.id = g.app_id WHERE g.id = ?1`,
    row.principal_id,
  );
  return [grant?.operator_id, grant?.app_creator].filter((id): id is string => !!id);
}

/**
 * With separate approvers on (agent_settings.separate_approver), why `operatorId` may not decide
 * this held call (they caused it), or null. Off by default: a workspace with a single admin
 * leaves it off, or adds a second admin.
 */
export async function approverRefusal(
  c: AppContext,
  row: ApprovalRow,
  operatorId: string,
): Promise<string | null> {
  const db = env(c).DB;
  const settings = await readAgentSettings(db, row.workspace_id);
  if (!settings.separateApprover) return null;
  if (!(await requestersOf(db, row)).includes(operatorId)) return null;
  return 'This workspace needs a second person: you caused this call (you asked Copilot, created the key or consented to the app), so another admin must approve it.';
}
