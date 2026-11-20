// The dashboard's Overview: Member growth and the latest Broadcasts with their opens and clicks,
// in two reads instead of one stats request per Broadcast.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  ChannelOverviewSchema,
  OVERVIEW_BROADCASTS,
  idPattern,
  type BroadcastStatus,
  type ChannelOverview,
} from '@swarm/domain';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { errors, idParam, ok } from '../lib/openapi';
import { SEND_TOTALS_SQL, sendRates, type SendTotals } from '../lib/sendRates';

export const overview = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const DAY = 86_400_000;

overview.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/overview',
    tags: ['Broadcasts'],
    summary: 'Member growth and the latest Broadcasts, for the Overview',
    description: `Active Members now, Members who joined and who unsubscribed in the last 30 days, and the latest ${OVERVIEW_BROADCASTS} sent Broadcasts with delivered, human opens and human clicks (machine opens and clicks from privacy proxies and link scanners are left out).`,
    request: { params: channelParam },
    responses: {
      200: ok(ChannelOverviewSchema, 'Overview'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const since = Date.now() - 30 * DAY;

    const members = await first<{ active: number; joined: number; left: number }>(
      db,
      `SELECT coalesce(sum(status = 'active'), 0) AS active,
              coalesce(sum(created_at >= ?2), 0) AS joined,
              coalesce(sum(unsubscribed_at >= ?2), 0) AS left
         FROM members WHERE channel_id = ?1`,
      channelId,
      since,
    );

    const rows = await all<{
      id: string;
      dispatch_id: string;
      subject: string;
      status: BroadcastStatus;
      created_at: number;
      completed_at: number | null;
      recipient_count: number;
    }>(
      db,
      `SELECT id, dispatch_id, subject, status, created_at, completed_at, recipient_count
         FROM broadcasts
        WHERE channel_id = ?1 AND kind = 'broadcast' AND status IN ('sent', 'partially_failed')
        ORDER BY created_at DESC LIMIT ${OVERVIEW_BROADCASTS}`,
      channelId,
    );
    const ids = rows.map((row) => row.id);
    const totals = ids.length
      ? await all<SendTotals & { broadcast_id: string }>(
          db,
          `SELECT broadcast_id, ${SEND_TOTALS_SQL}
             FROM deliveries WHERE broadcast_id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})
            GROUP BY broadcast_id`,
          ...ids,
        )
      : [];
    const byId = new Map(totals.map((t) => [t.broadcast_id, t]));

    const data: ChannelOverview = {
      members: {
        active: members?.active ?? 0,
        joinedLast30Days: members?.joined ?? 0,
        leftLast30Days: members?.left ?? 0,
      },
      broadcasts: rows.map((row) => {
        const { delivered, humanOpens, humanClicks, openRate, clickRate } = sendRates(
          byId.get(row.id),
        );
        return {
          id: row.id,
          dispatchId: row.dispatch_id,
          subject: row.subject,
          status: row.status,
          createdAt: toIso(row.created_at),
          completedAt: row.completed_at === null ? null : toIso(row.completed_at),
          recipientCount: row.recipient_count,
          delivered,
          humanOpens,
          humanClicks,
          openRate,
          clickRate,
        };
      }),
    };
    return c.json({ data }, 200);
  },
);
