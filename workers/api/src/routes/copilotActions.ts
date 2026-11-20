// Copilot actions (Phase 8, flag copilot_actions): "Ask Copilot to do it". Contract:
// docs/copilot.md "Ask Copilot to do it".
//
// - POST /channels/{id}/copilot/actions: any role on the Channel. The model proposes calls to the
//   Open Operator tools; each runs through runAgentTool as the operator acting through Copilot
//   (principal kind `copilot`), with the scopes of the operator's role on this Channel, so it is
//   in the agent log and follows the approval mode. Destructive calls, and changes proposed after
//   the model read workspace content, wait for the operator's confirmation in any mode.
// - POST /channels/{id}/copilot/actions/{approvalId}/confirm|cancel: the operator who asked
//   decides their own held call. A call the approval mode holds needs an admin (they can confirm
//   here too, or in Settings → Developers → Open Operator).
// Same quotas and request log as the editor assistant (feature `actions`).
import { createRoute } from '@hono/zod-openapi';
import { first, roleAtLeast, workspaceRole } from '@swarm/db';
import {
  CopilotActionConfirmSchema,
  CopilotActionDecisionSchema,
  CopilotActionResultSchema,
  CopilotActionRunSchema,
  idPattern,
  type CopilotActionDecision,
  type CopilotStreamError,
} from '@swarm/domain';
import {
  approvalRequestDigest,
  approvalStatus,
  approveAgentApproval,
  finishCopilotRequest,
  needsApproval,
  readApproval,
  rejectAgentApproval,
  runCopilotActions,
  storedRequest,
  type CopilotProviderError,
  type DecideResult,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { providerFor, reserveRequest } from '../lib/copilot';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import {
  approverRefusal,
  copilotActionsBlockedReason,
  copilotPrincipal,
  decideDeps,
  operatorDeps,
  readAgentSettings,
} from '../lib/operator';

export const copilotActions = createRouter();

const tags = ['Copilot'];
const channelParam = idParam('channelId', idPattern('channel'));
const approvalParams = channelParam.extend(idParam('approvalId', idPattern('agentApproval')).shape);

/** The workspace's approval policy as it is now; Copilot actions run only with the flag on. */
async function policyOf(c: AppContext, workspaceId: string) {
  const settings = await readAgentSettings(env(c).DB, workspaceId);
  return { mode: settings.approvalMode, ttlHours: settings.approvalTtlHours };
}

const memberDetailOf = async (c: AppContext, workspaceId: string) =>
  (await readAgentSettings(env(c).DB, workspaceId)).copilotMemberDetail;

function streamCode(error: CopilotProviderError, workspaceKey: boolean): CopilotStreamError {
  if (error.kind === 'auth') return workspaceKey ? 'key_rejected' : 'unavailable';
  if (error.kind === 'rate_limited') return 'rate_limited';
  return 'unavailable';
}

const ERROR_TEXT: Record<CopilotStreamError, string> = {
  rate_limited: 'The model is busy right now. Try again in a minute.',
  key_rejected: 'The provider refused your workspace’s key. Check it in Settings → Copilot.',
  refused: 'Copilot declined this request.',
  too_long: 'The answer was too long.',
  unavailable: 'Copilot is not available right now. Try again in a moment.',
  internal: 'Something went wrong. Try again.',
};

copilotActions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/copilot/actions',
    tags,
    summary: 'Ask Copilot to do something',
    description:
      'Copilot turns the request into calls to the Open Operator tools, with the scopes of your role on this Channel, and runs them through the agent log and the approval mode. Destructive calls, and changes proposed after Copilot read workspace content, are held for your confirmation (`approval.decider` `operator`); calls the approval mode holds wait for an admin (`admin`). Any role; flags `copilot` and `copilot_actions`. Counts against the Copilot allowance like any other request. See docs/copilot.md.',
    request: { params: channelParam, body: jsonBody(CopilotActionRunSchema) },
    responses: {
      200: ok(CopilotActionResultSchema, 'What Copilot did and what waits'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'rate_limited'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const e = env(c);
    const access = await requireChannel(c, channelId, 'viewer');
    const scope = { workspaceId: access.workspaceId, channelId };
    const blocked = await copilotActionsBlockedReason(c, access.workspaceId, channelId);
    if (blocked) throw new ApiError('feature_disabled', blocked);
    if (input.dispatchId) {
      const dispatch = await first(
        e.DB,
        'SELECT 1 FROM dispatches WHERE id = ?1 AND channel_id = ?2',
        input.dispatchId,
        channelId,
      );
      if (!dispatch) throw new ApiError('not_found', 'Post not found.');
    }
    const principal = await copilotPrincipal(
      e.DB,
      access.auth.operatorId,
      access.workspaceId,
      channelId,
    );
    if (!principal) throw new ApiError('not_found', 'Publication not found.');

    const { provider, model, keySource } = await providerFor(c, scope);
    const now = Date.now();
    const { id: requestId, remaining } = await reserveRequest(c, {
      workspaceId: access.workspaceId,
      channelId,
      dispatchId: input.dispatchId ?? null,
      operatorId: access.auth.operatorId,
      // A viewer's or author's run counts against their seat's monthly share.
      ...(principal.role ? { role: principal.role } : {}),
      feature: 'actions',
      keySource,
      provider: provider.name,
      model,
      now,
    });
    const policy = await policyOf(c, access.workspaceId);
    const { policy: _unused, ...deps } = operatorDeps(c, policy);
    const outcome = await runCopilotActions({
      provider,
      model,
      operator: deps,
      policy,
      principal,
      context: { channelId, dispatchId: input.dispatchId ?? null },
      request: input.request,
      requestId,
      memberDetail: await memberDetailOf(c, access.workspaceId),
      signal: c.req.raw.signal,
    });

    const tokens = { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens };
    let text = outcome.text;
    if (outcome.error) {
      const code = streamCode(outcome.error, keySource === 'workspace');
      // Metadata only: never the text, never the key.
      c.get('log').warn('copilot provider error', {
        requestId,
        kind: outcome.error.kind,
        status: outcome.error.status,
        keySource,
      });
      await finishCopilotRequest(e.DB, requestId, {
        status: outcome.error.kind === 'aborted' ? 'canceled' : 'failed',
        errorCode: code,
        ...tokens,
        now: Date.now(),
      });
      if (outcome.steps.length === 0) {
        throw new ApiError(
          code === 'rate_limited' ? 'rate_limited' : 'unavailable',
          ERROR_TEXT[code],
        );
      }
      text = text || ERROR_TEXT[code];
    } else {
      await finishCopilotRequest(e.DB, requestId, {
        status: outcome.stop === 'refused' ? 'refused' : 'succeeded',
        errorCode: outcome.stop === 'refused' ? 'refused' : null,
        ...tokens,
        now: Date.now(),
      });
      if (outcome.stop === 'refused') text = text || ERROR_TEXT.refused;
    }
    return c.json(
      {
        data: {
          requestId,
          text,
          steps: outcome.steps,
          stop: outcome.stop,
          readWorkspaceContent: outcome.readWorkspaceContent,
          remaining,
        },
      },
      200,
    );
  },
);

/**
 * A held call of this operator's own Copilot request on this Channel (or a workspace-wide call
 * made from it), with the operator's workspace role; 404 for anything else.
 */
async function ownApproval(c: AppContext, channelId: string, approvalId: string) {
  const access = await requireChannel(c, channelId, 'viewer');
  const row = await readApproval(env(c).DB, access.workspaceId, approvalId);
  if (
    !row ||
    row.principal_kind !== 'copilot' ||
    row.principal_id !== access.auth.operatorId ||
    (row.channel_id !== null && row.channel_id !== channelId)
  ) {
    throw new ApiError('not_found', 'Approval not found.');
  }
  const seat = await workspaceRole(env(c).DB, access.auth.operatorId, access.workspaceId);
  return { access, row, seat };
}

function decision(result: DecideResult): CopilotActionDecision {
  if (result.kind === 'not_found') throw new ApiError('not_found', 'Approval not found.');
  if (result.kind === 'conflict') {
    throw new ApiError('conflict', `This call is ${result.status} and can no longer be decided.`);
  }
  const row = result.row;
  return {
    approvalId: row.id,
    status:
      row.status === 'executed' ? 'executed' : row.status === 'rejected' ? 'rejected' : 'failed',
    statusCode: row.result_status,
    result: row.result_json === null ? row.reason : (JSON.parse(row.result_json) as unknown),
  };
}

const audit = (
  c: AppContext,
  workspaceId: string,
  operatorId: string,
  action: string,
  approvalId: string,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId,
    actorId: operatorId,
    action,
    targetType: 'agent_approval',
    targetId: approvalId,
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });

copilotActions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/copilot/actions/{approvalId}/confirm',
    tags,
    summary: 'Confirm a call Copilot proposed',
    description:
      'Runs a call your own Copilot request held, once, after checking again that your role still allows it. `requestDigest` is the one the held step carried with its request: a different one is `conflict` and nothing runs, so you only ever confirm the request you were shown. A call the workspace’s approval mode holds needs the admin role on the workspace (`forbidden` otherwise). Flags `copilot` and `copilot_actions`. Audited as copilot_action.confirmed.',
    request: { params: approvalParams, body: jsonBody(CopilotActionConfirmSchema) },
    responses: {
      200: ok(CopilotActionDecisionSchema, 'The call ran (or failed)'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, approvalId } = c.req.valid('param');
    const { requestDigest } = c.req.valid('json');
    const { access, row, seat } = await ownApproval(c, channelId, approvalId);
    const { workspaceId } = access;
    // The click is the only control on a call Copilot proposed after reading workspace content:
    // run it only if it is the request the operator was shown. A decided or expired call falls
    // through to the claim, which answers conflict.
    if (
      approvalStatus(row, Date.now()) === 'pending' &&
      (await approvalRequestDigest(
        storedRequest({ method: row.method, path: row.path, bodyJson: row.body_json }),
      )) !== requestDigest
    ) {
      throw new ApiError(
        'conflict',
        'This call is not the one you were shown. Ask Copilot again to see it.',
      );
    }
    const blocked = await copilotActionsBlockedReason(c, workspaceId, row.channel_id);
    if (blocked) throw new ApiError('feature_disabled', blocked);
    const separation = await approverRefusal(c, row, access.auth.operatorId);
    if (separation) {
      throw new ApiError(
        'forbidden',
        `${separation} They can approve it in Settings → Developers → Open Operator.`,
      );
    }
    if (
      needsApproval(row.risk, await policyOf(c, workspaceId)) &&
      !(seat && roleAtLeast(seat, 'admin'))
    ) {
      throw new ApiError(
        'forbidden',
        'This workspace’s approval mode holds this call for an admin. Ask an admin to approve it in Settings → Developers → Open Operator.',
      );
    }
    const result = decision(
      await approveAgentApproval(decideDeps(c, workspaceId), {
        workspaceId,
        approvalId,
        operatorId: access.auth.operatorId,
      }),
    );
    await audit(c, workspaceId, access.auth.operatorId, 'copilot_action.confirmed', approvalId, {
      tool: row.tool,
      outcome: result.status,
      statusCode: result.statusCode,
    });
    return c.json({ data: result }, 200);
  },
);

copilotActions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/copilot/actions/{approvalId}/cancel',
    tags,
    summary: 'Cancel a call Copilot proposed',
    description:
      'The call never runs. Only for calls your own Copilot request held; works without the flags so a held call can always be dropped. Audited as copilot_action.canceled.',
    request: { params: approvalParams },
    responses: {
      200: ok(CopilotActionDecisionSchema, 'The call was canceled'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, approvalId } = c.req.valid('param');
    const { access, row } = await ownApproval(c, channelId, approvalId);
    const { workspaceId } = access;
    const result = decision(
      await rejectAgentApproval(env(c).DB, {
        workspaceId,
        approvalId,
        operatorId: access.auth.operatorId,
        reason: 'Canceled in Copilot by the teammate who asked.',
      }),
    );
    await audit(c, workspaceId, access.auth.operatorId, 'copilot_action.canceled', approvalId, {
      tool: row.tool,
    });
    return c.json({ data: result }, 200);
  },
);
