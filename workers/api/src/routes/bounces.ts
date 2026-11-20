// Bounce rules (docs/deliverability.md "Bounces"): the workspace's policy, its preview, the
// subscribers on a paid plan held for an admin, and one subscriber's bounces. The rules are
// workspace-wide like the suppressions they make, so changing them and deciding a hold need a
// workspace admin seat; reading needs a viewer. The work is in @swarm/engine bounces.ts.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  BounceHoldDecisionSchema,
  BounceHoldSchema,
  BouncePolicySavedSchema,
  BouncePolicySchema,
  BouncePolicySettingsSchema,
  BouncePreviewSchema,
  MemberBouncesSchema,
  UpdateBouncePolicySchema,
  idPattern,
  type BouncePolicy,
  type BouncePolicySettings,
} from '@swarm/domain';
import {
  BounceHoldError,
  applyBouncePolicy,
  decideBounceHold,
  listBounceHolds,
  memberBounces,
  previewBouncePolicy,
  readBouncePolicy,
  saveBouncePolicy,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel, requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { refreshCircles } from '../lib/circles';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { requireOwned } from '../lib/send';

export const bounces = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const channelParam = idParam('channelId', idPattern('channel'));
const memberParam = idParam('memberId', idPattern('member'));
const holdParam = z.object({
  channelId: z.string().regex(idPattern('channel')),
  holdId: z.string().regex(idPattern('bounceState')),
});

const settings = (policy: BouncePolicy, updatedAt: number | null): BouncePolicySettings => ({
  ...policy,
  updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
});

/** A change that stopped subscribers: the Circles of the workspace's publications need a look. */
async function refreshWorkspaceCircles(c: AppContext, workspaceId: string) {
  const channels = await all<{ id: string }>(
    env(c).DB,
    'SELECT id FROM channels WHERE workspace_id = ?1 AND deleted_at IS NULL LIMIT 50',
    workspaceId,
  );
  for (const channel of channels) refreshCircles(c, channel.id);
}

bounces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/bounce-policy',
    tags: ['Deliverability'],
    summary: 'The bounce rules of a workspace',
    description:
      'When a bounce stops mailing an address. Every workspace starts with the recommended rules: the first hard bounce, or 3 emails in a row that bounced softly, and subscribers on a paid plan are held for an admin. `updatedAt` is null until an admin saves.',
    request: { params: workspaceParam },
    responses: {
      200: ok(BouncePolicySettingsSchema, 'Bounce rules'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'viewer');
    const { policy, updatedAt } = await readBouncePolicy(env(c).DB, workspaceId);
    return c.json({ data: settings(policy, updatedAt) }, 200);
  },
);

bounces.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/bounce-policy',
    tags: ['Deliverability'],
    summary: 'Change the bounce rules',
    description: `The new rules apply from the next bounce, using each address's stored counts. With \`applyToPast\`, they are also applied to stored bounce history now: matching addresses are stopped (or held, for a paid plan) at once, up to 500 per call; \`applied.remaining\` says how many wait for the next call. Complaints always stop mailing and are not part of the rules.`,
    request: { params: workspaceParam, body: jsonBody(UpdateBouncePolicySchema) },
    responses: {
      200: ok(BouncePolicySavedSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const { applyToPast, ...policy } = c.req.valid('json');
    const db = env(c).DB;
    const now = Date.now();
    const before = await readBouncePolicy(db, workspaceId);
    await saveBouncePolicy(db, workspaceId, policy, auth.operatorId, now);
    const applied = applyToPast ? await applyBouncePolicy(db, workspaceId, policy, now) : null;
    await appendAudit(db, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'bounce_policy.changed',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { from: before.policy, to: policy, applied },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (applied && applied.stopped > 0) await refreshWorkspaceCircles(c, workspaceId);
    return c.json({ data: { ...settings(policy, now), applied } }, 200);
  },
);

bounces.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/bounce-policy/preview',
    tags: ['Deliverability'],
    summary: 'What these bounce rules would do now',
    description:
      'Counts the addresses still being mailed that these rules would stop now, from stored bounce history (90 days) and counts, and those on a paid plan that would be held instead. Changes nothing.',
    request: { params: workspaceParam, body: jsonBody(BouncePolicySchema) },
    responses: {
      200: ok(BouncePreviewSchema, 'Preview'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const policy = c.req.valid('json');
    return c.json(
      { data: await previewBouncePolicy(env(c).DB, workspaceId, policy, Date.now()) },
      200,
    );
  },
);

bounces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/bounce-holds',
    tags: ['Deliverability'],
    summary: 'Subscribers on a paid plan waiting for a bounce decision',
    description:
      'Addresses of this publication’s subscribers that the bounce rules would stop, held because they have a paid plan and the workspace asks first. They are still being mailed. Oldest first.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(BounceHoldSchema), 'Held subscribers'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await listBounceHolds(env(c).DB, access.workspaceId, channelId) }, 200);
  },
);

bounces.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/bounce-holds/{holdId}',
    tags: ['Deliverability'],
    summary: 'Decide on a held subscriber',
    description:
      '`stop` stops mailing the address as the rule would have (a workspace-wide bounce suppression). `keep` keeps mailing it and starts its bounce counts again; for a hard bounce the address also leaves the Amazon SES account-level suppression list. Needs a workspace admin, because the address is suppressed workspace-wide.',
    request: { params: holdParam, body: jsonBody(BounceHoldDecisionSchema) },
    responses: {
      204: noContent,
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, holdId } = c.req.valid('param');
    const { decision } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    await requireWorkspace(c, access.workspaceId, 'admin');
    const db = env(c).DB;
    // Only a hold of one of this publication's subscribers is found through it.
    const listed = await first(
      db,
      `SELECT 1 FROM bounce_states s WHERE s.id = ?1 AND s.workspace_id = ?2
          AND EXISTS (SELECT 1 FROM members m WHERE m.channel_id = ?3 AND m.email = s.email)`,
      holdId,
      access.workspaceId,
      channelId,
    );
    if (!listed) throw new ApiError('not_found', 'That subscriber is no longer waiting for you.');
    let decided: { email: string; rule: string };
    try {
      decided = await decideBounceHold(db, access.workspaceId, holdId, decision, Date.now());
    } catch (error) {
      if (error instanceof BounceHoldError) throw new ApiError('not_found', error.message);
      throw error;
    }
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'bounce.hold_decided',
      targetType: 'bounce_state',
      targetId: holdId,
      metadata: { channelId, decision, rule: decided.rule },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (decision === 'stop') await refreshWorkspaceCircles(c, access.workspaceId);
    return c.body(null, 204);
  },
);

bounces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/members/{memberId}/bounces',
    tags: ['Members'],
    summary: 'A Member’s bounces',
    description:
      'The address as the bounce rules see it, across the workspace: emails in a row that bounced softly, a hold for an admin, the bounce suppression that stopped it with the server’s words, and the latest bounces of the last 90 days.',
    request: { params: memberParam },
    responses: {
      200: ok(MemberBouncesSchema, 'Bounces'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const access = await requireOwned(c, 'member', memberId, 'viewer');
    const db = env(c).DB;
    const member = await first<{ email: string }>(
      db,
      'SELECT email FROM members WHERE id = ?1',
      memberId,
    );
    if (!member) throw new ApiError('not_found', 'Subscriber not found.');
    return c.json(
      { data: await memberBounces(db, access.workspaceId, member.email, Date.now()) },
      200,
    );
  },
);
