// Coupons (Phase 5): a Stripe coupon with one promotion code (the code readers type) on the
// Channel's connected account, optionally limited to some Membership levels.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation } from '@swarm/db';
import {
  CouponSchema,
  CreateCouponSchema,
  UpdateCouponSchema,
  idPattern,
  newId,
} from '@swarm/domain';
import { bumpCacheStatement } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import {
  checkLevelIds,
  connectedAccount,
  requireConnectedAccount,
  stripe,
  stripeCall,
  toCoupon,
  type CouponRow,
} from '../lib/levels';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const coupons = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const couponParams = channelParam.extend(idParam('couponId', idPattern('coupon')).shape);

const CouponListQuerySchema = z.object({ status: z.enum(['active', 'archived']).optional() });

const codeTaken = () =>
  new ApiError('conflict', 'An active coupon already uses that code.', [
    { path: 'code', message: 'An active coupon already uses that code.' },
  ]);

async function requireCoupon(db: D1Database, channelId: string, couponId: string) {
  const row = await first<CouponRow>(
    db,
    'SELECT * FROM coupons WHERE id = ?1 AND channel_id = ?2',
    couponId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Coupon not found.');
  return row;
}

coupons.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/coupons',
    tags: ['Coupons'],
    summary: 'Coupons of a Channel, newest first',
    request: { params: channelParam, query: CouponListQuerySchema },
    responses: {
      200: ok(z.object({ items: z.array(CouponSchema) }), 'Coupons'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { status } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<CouponRow>(
      env(c).DB,
      `SELECT * FROM coupons WHERE channel_id = ?1 AND (?2 IS NULL OR status = ?2)
        ORDER BY created_at DESC LIMIT 500`,
      channelId,
      status ?? null,
    );
    return c.json({ data: { items: rows.map(toCoupon) } }, 200);
  },
);

coupons.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/coupons',
    tags: ['Coupons'],
    summary: 'Create a coupon',
    description:
      'Admin role. Needs a connected Stripe account that can take payments (409 otherwise). Creates a Stripe coupon (percent or amount off; once, repeating or forever; limited to the levels’ Stripe Products when levelIds is set) and a promotion code with the code, redemption limit and expiry, on the connected account. Codes are unique among active coupons, ignoring case.',
    request: { params: channelParam, body: jsonBody(CreateCouponSchema) },
    responses: {
      201: ok(CouponSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const now = Date.now();
    const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
    if (expiresAt !== null && expiresAt <= now + 60_000) {
      const message = 'Pick an expiry in the future.';
      throw new ApiError('invalid_input', message, [{ path: 'expiresAt', message }]);
    }
    const levelRows = await checkLevelIds(db, channelId, input.levelIds, 'levelIds');
    const api = stripe(c);
    const account = await requireConnectedAccount(db, channelId);
    const taken = await first(
      db,
      `SELECT 1 FROM coupons WHERE channel_id = ?1 AND code = ?2 AND status = 'active'`,
      channelId,
      input.code,
    );
    if (taken) throw codeTaken();
    const products = levelRows.map((row) => row.stripe_product_id).filter(Boolean) as string[];
    if (products.length !== levelRows.length) {
      throw new ApiError('conflict', 'One of those paid plans has no Stripe Product.');
    }

    const id = newId('coupon', now);
    const coupon = await stripeCall(() =>
      api.request<{ id: string }>(
        'POST',
        '/v1/coupons',
        {
          name: input.name ?? input.code,
          ...(input.percentOff !== undefined
            ? { percent_off: input.percentOff }
            : { amount_off: input.amountOff, currency: input.currency }),
          duration: input.duration,
          ...(input.durationMonths ? { duration_in_months: input.durationMonths } : {}),
          ...(products.length ? { applies_to: { products } } : {}),
          metadata: { swarm_coupon_id: id, swarm_channel_id: channelId },
        },
        { account: account.accountId, idempotencyKey: id },
      ),
    );
    const promotion = await stripeCall(() =>
      api.request<{ id: string }>(
        'POST',
        '/v1/promotion_codes',
        {
          promotion: { type: 'coupon', coupon: coupon.id },
          code: input.code,
          ...(input.maxRedemptions ? { max_redemptions: input.maxRedemptions } : {}),
          ...(expiresAt ? { expires_at: Math.floor(expiresAt / 1000) } : {}),
          metadata: { swarm_coupon_id: id },
        },
        { account: account.accountId, idempotencyKey: `${id}:promotion_code` },
      ),
    );
    try {
      await db
        .prepare(
          `INSERT INTO coupons (id, channel_id, code, name, percent_off, amount_off, currency, duration,
             duration_months, max_redemptions, expires_at, level_ids_json, status, stripe_coupon_id,
             stripe_promotion_code_id, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active', ?13, ?14, ?15, ?16)`,
        )
        .bind(
          id,
          channelId,
          input.code,
          input.name ?? null,
          input.percentOff ?? null,
          input.amountOff ?? null,
          input.currency ?? null,
          input.duration,
          input.durationMonths ?? null,
          input.maxRedemptions ?? null,
          expiresAt,
          JSON.stringify(input.levelIds),
          coupon.id,
          promotion.id,
          access.auth.operatorId,
          now,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw codeTaken();
      throw error;
    }
    await audit(c, access, 'coupon.created', 'coupon', id, {
      percentOff: input.percentOff ?? null,
      amountOff: input.amountOff ?? null,
      duration: input.duration,
      levelIds: input.levelIds,
    });
    const row = await requireCoupon(db, channelId, id);
    return c.json({ data: toCoupon(row) }, 201);
  },
);

coupons.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/coupons/{couponId}',
    tags: ['Coupons'],
    summary: 'A coupon',
    request: { params: couponParams },
    responses: { 200: ok(CouponSchema, 'Coupon'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId, couponId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: toCoupon(await requireCoupon(env(c).DB, channelId, couponId)) }, 200);
  },
);

coupons.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/coupons/{couponId}',
    tags: ['Coupons'],
    summary: 'Rename, archive or restore a coupon',
    description:
      'Admin role. The discount can’t change (Stripe coupons are immutable): archive the coupon and create another. Archiving deactivates the promotion code, so the code stops working at checkout, and removes it from the Gate if it was shown there; existing discounts keep running.',
    request: { params: couponParams, body: jsonBody(UpdateCouponSchema) },
    responses: {
      200: ok(CouponSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, couponId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const row = await requireCoupon(db, channelId, couponId);
    const now = Date.now();
    const statusChange = input.status !== undefined && input.status !== row.status;
    if (statusChange && input.status === 'active') {
      if (row.expires_at !== null && row.expires_at <= now) {
        throw new ApiError('conflict', 'This coupon has expired. Create a new one.');
      }
      const taken = await first(
        db,
        `SELECT 1 FROM coupons WHERE channel_id = ?1 AND code = ?2 AND status = 'active' AND id <> ?3`,
        channelId,
        row.code,
        couponId,
      );
      if (taken) throw codeTaken();
    }
    const nameChange = input.name !== undefined && input.name !== row.name;
    const account = nameChange || statusChange ? await connectedAccount(db, channelId) : null;
    if (account) {
      const api = stripe(c);
      if (nameChange && row.stripe_coupon_id) {
        const stripeCouponId = row.stripe_coupon_id;
        await stripeCall(() =>
          api.request(
            'POST',
            `/v1/coupons/${stripeCouponId}`,
            { name: input.name ?? row.code },
            { account: account.accountId },
          ),
        );
      }
      if (statusChange && row.stripe_promotion_code_id) {
        const promotionId = row.stripe_promotion_code_id;
        await stripeCall(() =>
          api.request(
            'POST',
            `/v1/promotion_codes/${promotionId}`,
            { active: input.status === 'active' },
            { account: account.accountId },
          ),
        );
      }
    }
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE coupons SET name = CASE WHEN ?1 = 1 THEN ?2 ELSE name END,
                  status = coalesce(?3, status) WHERE id = ?4`,
        )
        .bind(input.name !== undefined ? 1 : 0, input.name ?? null, input.status ?? null, couponId),
    ];
    if (statusChange && input.status === 'archived') {
      const shown = await first(
        db,
        'SELECT 1 FROM gate_settings WHERE channel_id = ?1 AND gate_coupon_id = ?2',
        channelId,
        couponId,
      );
      if (shown) {
        statements.push(
          db
            .prepare(
              'UPDATE gate_settings SET gate_coupon_id = NULL, updated_at = ?1 WHERE channel_id = ?2',
            )
            .bind(now, channelId),
          bumpCacheStatement(db, channelId, now),
        );
      }
    }
    try {
      await db.batch(statements);
    } catch (error) {
      if (isUniqueViolation(error)) throw codeTaken();
      throw error;
    }
    const action = statusChange
      ? input.status === 'archived'
        ? 'coupon.archived'
        : 'coupon.restored'
      : 'coupon.updated';
    await audit(c, access, action, 'coupon', couponId);
    return c.json({ data: toCoupon(await requireCoupon(db, channelId, couponId)) }, 200);
  },
);
