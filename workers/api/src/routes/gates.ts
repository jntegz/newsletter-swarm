// Gates (Phase 5): which Membership levels read past a Dispatch's gate divider, the Channel's
// meter and default Gate design, gift-meter grants, and the gift article links Members shared
// (how often each was read, and stopping them). Every Gate change bumps the site cache.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  CreateMeterGrantSchema,
  GateSchema,
  GateSettingsSchema,
  MeterGrantSchema,
  PutGateSchema,
  UpdateGateSettingsSchema,
  idPattern,
  meterPeriodKey,
  newId,
  type Gate,
  type GateDesign,
  type GateSettings,
  type MeterPeriod,
} from '@swarm/domain';
import { GIFT_ARTICLE_MAX_READS, bumpCacheStatement, revokeGiftArticleLinks } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { checkLevelIds, requireChannelMember } from '../lib/levels';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { requireOwned } from '../lib/send';
import { audit, requireFlag } from '../lib/site';

export const gates = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const dispatchParam = idParam('dispatchId', idPattern('dispatch'));
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);

interface GateRow {
  dispatch_id: string;
  level_ids_json: string;
  metered: number;
  design_json: string;
  updated_at: number;
}

async function readGate(db: D1Database, dispatchId: string): Promise<Gate> {
  const row = await first<GateRow>(db, 'SELECT * FROM gates WHERE dispatch_id = ?1', dispatchId);
  return {
    dispatchId,
    levelIds: row ? (JSON.parse(row.level_ids_json) as string[]) : [],
    metered: row ? row.metered === 1 : true,
    design: row ? (JSON.parse(row.design_json) as GateDesign) : {},
    saved: !!row,
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

interface SettingsRow {
  meter_limit: number;
  meter_period: MeterPeriod;
  meter_mode: 'soft' | 'hard';
  design_json: string;
  gate_coupon_id: string | null;
  updated_at: number;
}

async function readSettings(db: D1Database, channelId: string): Promise<GateSettings> {
  const row = await first<SettingsRow>(
    db,
    'SELECT * FROM gate_settings WHERE channel_id = ?1',
    channelId,
  );
  const period = row?.meter_period ?? 'month';
  return {
    channelId,
    meterLimit: row?.meter_limit ?? 0,
    meterPeriod: period,
    meterMode: row?.meter_mode ?? 'hard',
    design: row ? (JSON.parse(row.design_json) as GateDesign) : {},
    gateCouponId: row?.gate_coupon_id ?? null,
    currentPeriod: meterPeriodKey(period),
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

// ---- Per-Dispatch Gate -----------------------------------------------------------------------

gates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/gate',
    tags: ['Gates'],
    summary: 'The Gate of a Dispatch',
    description:
      'Defaults (any paid level, metered, the Channel’s design) until one is saved. The Gate applies to content after the gate divider.',
    request: { params: dispatchParam },
    responses: { 200: ok(GateSchema, 'Gate'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    return c.json({ data: await readGate(env(c).DB, dispatchId) }, 200);
  },
);

gates.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/dispatches/{dispatchId}/gate',
    tags: ['Gates'],
    summary: 'Save the Gate of a Dispatch',
    description:
      'Editor role. levelIds are Membership levels of the Dispatch’s Channel (empty = any paid level); metered lets the Channel’s meter admit non-members.',
    request: { params: dispatchParam, body: jsonBody(PutGateSchema) },
    responses: {
      200: ok(GateSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const db = env(c).DB;
    await checkLevelIds(db, access.channelId, input.levelIds, 'levelIds');
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO gates (dispatch_id, channel_id, level_ids_json, metered, design_json, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (dispatch_id) DO UPDATE SET level_ids_json = excluded.level_ids_json,
             metered = excluded.metered, design_json = excluded.design_json,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(
          dispatchId,
          access.channelId,
          JSON.stringify(input.levelIds),
          input.metered ? 1 : 0,
          JSON.stringify(input.design),
          access.auth.operatorId,
          now,
        ),
      bumpCacheStatement(db, access.channelId, now),
    ]);
    await audit(c, access, 'gate.updated', 'dispatch', dispatchId, {
      levelIds: input.levelIds,
      metered: input.metered,
    });
    return c.json({ data: await readGate(db, dispatchId) }, 200);
  },
);

// ---- Channel settings ------------------------------------------------------------------------

gates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/gate-settings',
    tags: ['Gates'],
    summary: 'The meter and the default Gate design',
    request: { params: channelParam },
    responses: { 200: ok(GateSettingsSchema, 'Settings'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await readSettings(env(c).DB, channelId) }, 200);
  },
);

gates.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/gate-settings',
    tags: ['Gates'],
    summary: 'Change the meter and the default Gate design',
    description:
      'Editor role. meterLimit is the number of gated Dispatches a reader without access can read per period (0 turns the meter off). gateCouponId shows an active coupon of this Channel inside the Gate and needs the paywall_coupon flag.',
    request: { params: channelParam, body: jsonBody(UpdateGateSettingsSchema) },
    responses: {
      200: ok(GateSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const db = env(c).DB;
    if (input.gateCouponId) {
      await requireFlag(c, access, 'paywall_coupon', 'Coupons in the paywall are not available.');
      const coupon = await first(
        db,
        `SELECT 1 FROM coupons WHERE id = ?1 AND channel_id = ?2 AND status = 'active'`,
        input.gateCouponId,
        channelId,
      );
      if (!coupon) {
        const message = 'Choose an active coupon of this publication.';
        throw new ApiError('invalid_input', message, [{ path: 'gateCouponId', message }]);
      }
    }
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          'INSERT INTO gate_settings (channel_id, updated_at) VALUES (?1, ?2) ON CONFLICT (channel_id) DO NOTHING',
        )
        .bind(channelId, now),
      db
        .prepare(
          `UPDATE gate_settings SET meter_limit = coalesce(?1, meter_limit),
                  meter_period = coalesce(?2, meter_period), meter_mode = coalesce(?3, meter_mode),
                  design_json = coalesce(?4, design_json),
                  gate_coupon_id = CASE WHEN ?5 = 1 THEN ?6 ELSE gate_coupon_id END, updated_at = ?7
            WHERE channel_id = ?8`,
        )
        .bind(
          input.meterLimit ?? null,
          input.meterPeriod ?? null,
          input.meterMode ?? null,
          input.design === undefined ? null : JSON.stringify(input.design),
          input.gateCouponId !== undefined ? 1 : 0,
          input.gateCouponId ?? null,
          now,
          channelId,
        ),
      bumpCacheStatement(db, channelId, now),
    ]);
    await audit(c, access, 'gate_settings.updated', 'channel', channelId, {
      fields: Object.keys(input),
    });
    return c.json({ data: await readSettings(db, channelId) }, 200);
  },
);

// ---- Gift-meter grants -----------------------------------------------------------------------

gates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/members/{memberId}/meter-grants',
    tags: ['Gates'],
    summary: 'Give a Member extra free reads this period',
    description:
      'Editor role. Adds `extra` gated reads on the meter for the current period (gate_settings.meter_period). Needs the meter to be on (409 otherwise).',
    request: { params: memberParams, body: jsonBody(CreateMeterGrantSchema) },
    responses: {
      201: ok(MeterGrantSchema, 'Granted'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, memberId } = c.req.valid('param');
    const { extra } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const db = env(c).DB;
    await requireChannelMember(db, channelId, memberId);
    const settings = await readSettings(db, channelId);
    if (settings.meterLimit === 0) {
      throw new ApiError('conflict', 'Turn on the meter before giving extra reads.');
    }
    const now = Date.now();
    const id = newId('meterGrant', now);
    const period = meterPeriodKey(settings.meterPeriod, now);
    await db
      .prepare(
        `INSERT INTO gate_meter_grants (id, channel_id, member_id, period, extra, granted_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(id, channelId, memberId, period, extra, access.auth.operatorId, now)
      .run();
    await audit(c, access, 'member.meter_granted', 'member', memberId, { extra, period });
    return c.json({ data: { id, channelId, memberId, period, extra, createdAt: toIso(now) } }, 201);
  },
);

// ---- Gift article links ----------------------------------------------------------------------

const GiftLinkSchema = z
  .object({
    memberId: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    reads: z.number().int(),
    maxReads: z.number().int(),
    revokedAt: z.string().nullable(),
  })
  .openapi('GiftArticleLink');

gates.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/gift-links',
    tags: ['Gates'],
    summary: 'The gift article links Members shared for a Dispatch',
    description:
      'Editor role. Newest first, at most 200. A link opens the Dispatch at most maxReads times, and stops when it is revoked, expires, or its Member can no longer read the Dispatch; reads shows how widely it was used.',
    request: { params: dispatchParam },
    responses: {
      200: ok(z.object({ items: z.array(GiftLinkSchema) }), 'Gift links'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const rows = await all<{
      member_id: string;
      created_at: number;
      expires_at: number;
      reads: number;
      revoked_at: number | null;
    }>(
      env(c).DB,
      `SELECT member_id, created_at, expires_at, reads, revoked_at FROM gift_article_links
        WHERE channel_id = ?1 AND dispatch_id = ?2 ORDER BY created_at DESC LIMIT 200`,
      access.channelId,
      dispatchId,
    );
    return c.json(
      {
        data: {
          items: rows.map((r) => ({
            memberId: r.member_id,
            createdAt: toIso(r.created_at),
            expiresAt: toIso(r.expires_at),
            reads: r.reads,
            maxReads: GIFT_ARTICLE_MAX_READS,
            revokedAt: r.revoked_at === null ? null : toIso(r.revoked_at),
          })),
        },
      },
      200,
    );
  },
);

gates.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/gift-links/revoke',
    tags: ['Gates'],
    summary: 'Stop every gift article link to a Dispatch',
    description:
      'Editor role. Links already shared stop working at once; Members can share new ones within their monthly allowance.',
    request: { params: dispatchParam },
    responses: {
      200: ok(z.object({ stopped: z.number().int() }), 'Stopped'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const stopped = await revokeGiftArticleLinks(env(c).DB, {
      channelId: access.channelId,
      dispatchId,
    });
    await audit(c, access, 'gift_links.revoked', 'dispatch', dispatchId, { stopped });
    return c.json({ data: { stopped } }, 200);
  },
);
