// /v2 Channels (channels:read), the workspace audit log (audit:read) and the publication context
// an agent is shown before it works on a Channel (channels:read).
import { z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  ApiChannelSchema,
  AuditEventSchema,
  CHANNEL_CONTEXT_DISPATCHES,
  ChannelContextSchema,
  CursorQuerySchema,
  idPattern,
  page,
  scopeAllows,
  type ApiChannel,
} from '@swarm/domain';
import { webUrlFor } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { publicAuditEvent, readAuditEvents } from '../lib/audit';
import { createRouter, env, type AppContext } from '../lib/context';
import { engine } from '../lib/send';
import { toChannel, type ChannelRow } from '../lib/mappers';
import { errors, idParam, ok } from '../lib/openapi';
import { decodeCursor, encodeCursor, guard, v2Route } from './route';

export const v2Channels = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const CHANNEL_COLUMNS =
  'id, workspace_id, slug, name, description, branding_json, settings_json, status, created_at, updated_at, deleted_at';

const toApiChannel = (row: ChannelRow): ApiChannel => {
  const { role: _role, ...channel } = toChannel(row, 'viewer');
  return channel;
};

const listChannels = v2Route('channels:read', {
  method: 'get',
  path: '/v2/channels',
  operationId: 'listChannels',
  tags: ['Channels'],
  summary: 'Channels this credential can reach',
  description: 'Every live Channel of the workspace, or only those the key is limited to.',
  responses: { 200: ok(z.array(ApiChannelSchema), 'Channels') },
});
v2Channels.openapi(listChannels, async (c) => {
  const principal = await guard(c, listChannels);
  const rows = await all<ChannelRow>(
    env(c).DB,
    `SELECT ${CHANNEL_COLUMNS} FROM channels
      WHERE workspace_id = ?1 AND deleted_at IS NULL
        AND (?2 IS NULL OR id IN (SELECT value FROM json_each(?2)))
      ORDER BY created_at`,
    principal.workspaceId,
    principal.channelIds ? JSON.stringify(principal.channelIds) : null,
  );
  return c.json({ data: rows.map(toApiChannel) }, 200);
});

const getChannel = v2Route('channels:read', {
  method: 'get',
  path: '/v2/channels/{channelId}',
  operationId: 'getChannel',
  tags: ['Channels'],
  summary: 'One Channel',
  request: { params: channelParam },
  responses: { 200: ok(ApiChannelSchema, 'Channel'), ...errors('not_found') },
});
v2Channels.openapi(getChannel, async (c) => {
  await guard(c, getChannel);
  const row = await first<ChannelRow>(
    env(c).DB,
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?1`,
    c.req.valid('param').channelId,
  );
  return c.json({ data: toApiChannel(row as ChannelRow) }, 200);
});

const listAudit = v2Route('audit:read', {
  method: 'get',
  path: '/v2/audit-events',
  operationId: 'listAuditEvents',
  tags: ['Audit'],
  summary: 'The workspace audit log, newest first',
  description:
    'Tamper-evident: each event’s hash covers the one before. Events older than the plan’s retention are pruned (an `audit.pruned` event records each prune). A credential limited to Channels sees only events about those Channels and their resources, and its own changes.',
  request: { query: CursorQuerySchema },
  responses: { 200: ok(page(AuditEventSchema), 'Events'), ...errors('invalid_input') },
});
v2Channels.openapi(listAudit, async (c) => {
  const principal = await guard(c, listAudit);
  const { cursor, limit } = c.req.valid('query');
  const position = decodeCursor(cursor);
  const before = position === undefined ? Number.MAX_SAFE_INTEGER : Number(position);
  if (!Number.isSafeInteger(before))
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  const rows = await readAuditEvents(env(c).DB, principal.workspaceId, {
    beforeSeq: before,
    limit: limit + 1,
    ...(principal.channelIds
      ? { limitedTo: { channelIds: principal.channelIds, principalId: principal.id } }
      : {}),
  });
  const items = rows.slice(0, limit).map(publicAuditEvent);
  const nextCursor = rows.length > limit ? encodeCursor(String(items.at(-1)?.seq)) : null;
  return c.json({ data: { items, nextCursor } }, 200);
});

// ---- Publication context ----------------------------------------------------------------------

const DAY = 86_400_000;

/** A rate in [0, 1] rounded to a basis point, like the Overview and Broadcast stats. */
const rate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;

const getContext = v2Route('channels:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/context',
  operationId: 'getChannelContext',
  tags: ['Channels'],
  summary: 'The publication context an agent works from',
  description: `What a person would know sitting down to write: the publication and its style guide, the audience by numbers (needs \`members:read\`), and the last ${CHANNEL_CONTEXT_DISPATCHES} sent posts with how each went (needs \`dispatches:read\` and \`broadcasts:read\`). A part the credential's scopes don't allow is null. Machine opens and clicks (privacy proxies, link scanners) are left out. Read this before drafting, so tone, length and cadence match the publication.`,
  request: { params: channelParam },
  responses: { 200: ok(ChannelContextSchema, 'Context'), ...errors('not_found') },
});

async function contextAudience(db: D1Database, channelId: string) {
  const now = Date.now();
  const audience = await first<{ active: number; paid: number; joined: number; left: number }>(
    db,
    `SELECT (SELECT count(*) FROM members WHERE channel_id = ?1 AND status = 'active') AS active,
            (SELECT count(*) FROM member_entitlements e JOIN members m ON m.id = e.member_id
              WHERE e.channel_id = ?1 AND e.kind = 'paid' AND m.status IN ('active', 'paused')
                AND (e.expires_at IS NULL OR e.expires_at > ?2)) AS paid,
            (SELECT count(*) FROM members WHERE channel_id = ?1 AND created_at >= ?3) AS joined,
            (SELECT count(*) FROM members WHERE channel_id = ?1 AND unsubscribed_at >= ?3) AS left`,
    channelId,
    now,
    now - 30 * DAY,
  );
  return {
    activeMembers: audience?.active ?? 0,
    paidMembers: audience?.paid ?? 0,
    joinedLast30Days: audience?.joined ?? 0,
    leftLast30Days: audience?.left ?? 0,
  };
}

/** The last sent posts, with the same honest numbers the Overview shows. */
async function contextDispatches(c: AppContext, channelId: string) {
  const db = env(c).DB;
  // Picks the Broadcasts first, as the Overview does: only their Deliveries get counted, not those
  // of every Broadcast the Channel ever sent.
  const rows = await all<{
    id: string;
    subject: string;
    sent_at: number | null;
    web_visibility: 'public' | 'members' | 'paid' | 'hidden';
    web_published_at: number | null;
    slug: string | null;
    recipient_count: number;
    sent: number;
    bounced: number;
    delivered: number;
    human_opened: number;
    human_clicked: number;
  }>(
    db,
    `SELECT d.id, b.subject, d.sent_at, d.web_visibility, d.web_published_at, b.recipient_count,
            (SELECT s.slug FROM dispatch_slugs s WHERE s.dispatch_id = d.id AND s.is_current = 1) AS slug,
            coalesce(sum(r.status <> 'failed'), 0) AS sent,
            coalesce(sum(r.status = 'bounced'), 0) AS bounced,
            coalesce(sum(r.status IN ('delivered', 'complained')), 0) AS delivered,
            coalesce(sum(r.human_opened_at IS NOT NULL), 0) AS human_opened,
            coalesce(sum(r.human_clicked_at IS NOT NULL), 0) AS human_clicked
       FROM (SELECT id, dispatch_id, subject, recipient_count, created_at
               FROM broadcasts
              WHERE channel_id = ?1 AND kind = 'broadcast' AND status IN ('sent', 'partially_failed')
              ORDER BY created_at DESC LIMIT ${CHANNEL_CONTEXT_DISPATCHES}) b
       JOIN dispatches d ON d.id = b.dispatch_id
  LEFT JOIN deliveries r ON r.broadcast_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC`,
    channelId,
  );
  const config = engine(c);
  return Promise.all(
    rows.map(async (row) => {
      // As in the Overview: a sent message that hasn't bounced counts as delivered.
      const delivered = Math.max(row.delivered, row.sent - row.bounced);
      const onSite =
        row.slug !== null && row.web_published_at !== null && row.web_visibility !== 'hidden';
      return {
        id: row.id,
        subject: row.subject,
        sentAt: row.sent_at === null ? null : toIso(row.sent_at),
        recipientCount: row.recipient_count,
        humanOpens: row.human_opened,
        humanClicks: row.human_clicked,
        openRate: rate(row.human_opened, delivered),
        clickRate: rate(row.human_clicked, delivered),
        webUrl:
          onSite && row.slug !== null
            ? await webUrlFor(
                db,
                config,
                { id: row.id, channel_id: channelId, subject: row.subject },
                { slug: row.slug, isNew: false },
              )
            : null,
      };
    }),
  );
}

v2Channels.openapi(getContext, async (c) => {
  const principal = await guard(c, getContext);
  const channelId = c.req.valid('param').channelId;
  const db = env(c).DB;

  const channel = await first<ChannelRow>(
    db,
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?1`,
    channelId,
  );
  if (!channel) throw new ApiError('not_found', 'Publication not found.');

  // channels:read alone doesn't reach Members or Broadcast stats, so it doesn't reach them here.
  const mayReadPosts =
    scopeAllows(principal.scopes, 'dispatches:read') &&
    scopeAllows(principal.scopes, 'broadcasts:read');

  return c.json(
    {
      data: {
        publication: {
          name: channel.name,
          description: channel.description,
          slug: channel.slug,
          createdAt: toIso(channel.created_at),
        },
        styleGuide: toChannel(channel, 'viewer').styleGuide,
        audience: scopeAllows(principal.scopes, 'members:read')
          ? await contextAudience(db, channelId)
          : null,
        recentDispatches: mayReadPosts ? await contextDispatches(c, channelId) : null,
      },
    },
    200,
  );
});
