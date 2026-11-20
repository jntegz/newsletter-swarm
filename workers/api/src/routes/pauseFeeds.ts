// Incident response: "Pause all outbound feeds" (Settings > Security). One action pauses every
// export destination and webhook endpoint of the workspace, and can also revoke every API key and
// app grant, for when a session, key or admin may have been taken over. Signing out sessions
// alone does not stop these, by design. Needs an owner or admin with a fresh factor of their own,
// is audited per feed, key and grant, and every owner and admin is emailed with the list. Each
// feed is resumed one at a time afterwards (PATCH its status), so nothing comes back unreviewed.
// docs/security.md "Standing feeds".
import { createRoute } from '@hono/zod-openapi';
import { all, batch } from '@swarm/db';
import {
  PauseFeedsSchema,
  PausedFeedsSchema,
  idPattern,
  type ExportDestinationConfig,
  type PausedFeeds,
} from '@swarm/domain';
import { requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { loadFactors, requireFreshFactor } from '../lib/mfa';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { noticeTeam } from '../lib/team-notice';
import { revokeGrantStatements } from '../v2/oauth';

export const pauseFeeds = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));

pauseFeeds.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/security/pause-feeds',
    tags: ['Security'],
    summary: 'Pause all outbound feeds',
    description:
      'Owners and admins, with a second factor of your own proved in the last 10 minutes (403 `secondFactor: step_up_required`, or `factor_required` without one). Pauses every export destination and webhook endpoint of the workspace that is not already paused or turned off, and with `revokeApiKeys` or `revokeApps` also revokes every API key or app grant. Answers with each feed it paused and where it pointed. Audited, and every owner and admin is emailed. Resume each feed on its own page afterwards.',
    request: { params: workspaceParam, body: jsonBody(PauseFeedsSchema) },
    responses: {
      200: ok(PausedFeedsSchema, 'Paused'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    requireFreshFactor(auth, await loadFactors(e, auth.operatorId));
    const now = Date.now();

    const destinations = await all<{ id: string; channel_id: string; config_json: string }>(
      e.DB,
      `UPDATE export_destinations SET status = 'paused', updated_at = ?2
        WHERE workspace_id = ?1 AND status <> 'paused' RETURNING id, channel_id, config_json`,
      workspaceId,
      now,
    );
    const endpoints = await all<{ id: string; channel_id: string | null; url: string }>(
      e.DB,
      `UPDATE webhook_endpoints SET status = 'paused', updated_at = ?2
        WHERE workspace_id = ?1 AND status = 'active' RETURNING id, channel_id, url`,
      workspaceId,
      now,
    );
    const keys = input.revokeApiKeys
      ? await all<{ id: string }>(
          e.DB,
          `UPDATE api_keys SET revoked_at = ?2 WHERE workspace_id = ?1 AND revoked_at IS NULL
           RETURNING id`,
          workspaceId,
          now,
        )
      : [];
    const grants = input.revokeApps
      ? await all<{ id: string; app_id: string }>(
          e.DB,
          'SELECT id, app_id FROM oauth_grants WHERE workspace_id = ?1 AND revoked_at IS NULL',
          workspaceId,
        )
      : [];
    if (grants.length) {
      await batch(
        e.DB,
        grants.flatMap((grant) => revokeGrantStatements(e.DB, grant.id, now)),
      );
    }

    const paused: PausedFeeds['paused'] = [
      ...destinations.map((d) => {
        const config = JSON.parse(d.config_json) as ExportDestinationConfig;
        return {
          kind: 'export_destination' as const,
          id: d.id,
          target: `${config.endpoint ?? 'S3'} ${config.bucket}/${config.prefix}`,
          channelId: d.channel_id,
        };
      }),
      ...endpoints.map((w) => ({
        kind: 'webhook_endpoint' as const,
        id: w.id,
        target: w.url,
        channelId: w.channel_id,
      })),
    ];
    const ip = ipPrefix(clientIp(c));
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'feeds.paused_all',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: {
        exportDestinations: destinations.length,
        webhookEndpoints: endpoints.length,
        apiKeysRevoked: keys.length,
        appsRevoked: grants.length,
      },
      ipPrefix: ip,
    });
    const entries = [
      ...paused.map((feed) => ({
        action: feed.kind === 'export_destination' ? 'export_destination.paused' : 'webhook.paused',
        targetType: feed.kind,
        targetId: feed.id,
        metadata: { reason: 'feeds_paused_all', target: feed.target },
      })),
      ...keys.map((key) => ({
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: key.id,
        metadata: { reason: 'feeds_paused_all' },
      })),
      ...grants.map((grant) => ({
        action: 'oauth_grant.revoked',
        targetType: 'oauth_grant',
        targetId: grant.id,
        metadata: { appId: grant.app_id, reason: 'feeds_paused_all' },
      })),
    ];
    for (const entry of entries) {
      await appendAudit(e.DB, { workspaceId, actorId: auth.operatorId, ...entry, ipPrefix: ip });
    }

    const listed = paused.slice(0, 20).map((feed) => `• ${feed.target}`);
    await noticeTeam(e, c.get('log'), workspaceId, ['owner', 'admin'], {
      category: 'standing_feed_changed',
      subject: 'All outbound feeds were paused',
      heading: 'Outbound feeds paused',
      lines: [
        `${auth.email} paused every outbound feed of this workspace: ${destinations.length} export ${destinations.length === 1 ? 'destination' : 'destinations'} and ${endpoints.length} webhook ${endpoints.length === 1 ? 'endpoint' : 'endpoints'}.${keys.length ? ` ${keys.length} API ${keys.length === 1 ? 'key was' : 'keys were'} revoked.` : ''}${grants.length ? ` ${grants.length} ${grants.length === 1 ? 'app was' : 'apps were'} disconnected.` : ''}`,
        ...(listed.length
          ? [`Paused: ${listed.join(' ')}${paused.length > 20 ? ' and more' : ''}`]
          : []),
        'Nothing is sent until an admin resumes each feed on its own. If you did not expect this, check Settings > Security and the audit log.',
      ],
      path: '/settings/security',
      label: 'Review security',
    });
    return c.json(
      { data: { paused, apiKeysRevoked: keys.length, appsRevoked: grants.length } },
      200,
    );
  },
);
