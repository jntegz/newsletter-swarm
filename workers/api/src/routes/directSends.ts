// Direct Send stats for the dashboard (Phase 7): counts by status per UTC day for one Channel.
// Sending itself is /v2 only (v2/sends.ts).
import { createRoute, z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  DIRECT_SEND_STATUSES,
  DirectSendStatsSchema,
  PLAN_LIMITS,
  idPattern,
  type DirectSendStatus,
  type Plan,
} from '@swarm/domain';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { errors, idParam, ok } from '../lib/openapi';
import { dayStart } from '../v2/sends';

export const directSends = createRouter();

const DAY_MS = 86_400_000;

directSends.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/direct-sends/stats',
    tags: ['Direct Send'],
    summary: 'Direct Sends by status per day',
    description:
      'Newest day first, days without sends left out. `today` is the workspace-wide count against the plan’s daily limit.',
    request: {
      params: idParam('channelId', idPattern('channel')),
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
    },
    responses: {
      200: ok(DirectSendStatsSchema, 'Counts'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { days } = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const today = dayStart(Date.now());
    const rows = await all<{ day: number; status: DirectSendStatus; n: number }>(
      db,
      `SELECT created_at - (created_at % ${DAY_MS}) AS day, status, count(*) AS n FROM direct_sends
        WHERE channel_id = ?1 AND created_at >= ?2 GROUP BY day, status ORDER BY day DESC`,
      channelId,
      today - (days - 1) * DAY_MS,
    );
    const byDay = new Map<number, Record<DirectSendStatus, number>>();
    for (const row of rows) {
      let counts = byDay.get(row.day);
      if (!counts) {
        counts = Object.fromEntries(DIRECT_SEND_STATUSES.map((s) => [s, 0])) as Record<
          DirectSendStatus,
          number
        >;
        byDay.set(row.day, counts);
      }
      counts[row.status] = row.n;
    }
    const usage = await first<{ plan: Plan; used: number }>(
      db,
      `SELECT w.plan, (SELECT count(*) FROM direct_sends s WHERE s.workspace_id = w.id AND s.created_at >= ?2) AS used
         FROM workspaces w WHERE w.id = ?1`,
      access.workspaceId,
      today,
    );
    return c.json(
      {
        data: {
          days: [...byDay].map(([day, counts]) => ({
            day: new Date(day).toISOString().slice(0, 10),
            counts,
            total: Object.values(counts).reduce((sum, n) => sum + n, 0),
          })),
          today: { used: usage!.used, limit: PLAN_LIMITS[usage!.plan].directSendsPerDay },
        },
      },
      200,
    );
  },
);
