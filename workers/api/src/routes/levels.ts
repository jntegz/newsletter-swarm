// Membership levels and their prices (Phase 5). Every level is a Stripe Product on the Channel's
// connected account and every price a Stripe Price; prices are never edited: a change is a new
// level_prices row and a new Stripe Price, now or scheduled.
import { createRoute } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  CreateLevelPriceSchema,
  CreateMembershipLevelSchema,
  LevelListQuerySchema,
  LevelPriceSchema,
  MAX_LEVELS,
  MembershipLevelListSchema,
  MembershipLevelSchema,
  UpdateMembershipLevelSchema,
  idPattern,
  newId,
  type PriceInterval,
} from '@swarm/domain';
import type { StripeApi } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { env, createRouter, type AppContext } from '../lib/context';
import {
  connectedAccount,
  readLevels,
  requireConnectedAccount,
  requireLevel,
  stripe,
  stripeCall,
  toLevelPrice,
  type ConnectedAccount,
  type LevelRow,
  type PriceRow,
} from '../lib/levels';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag } from '../lib/site';

export const levels = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const levelParams = channelParam.extend(idParam('levelId', idPattern('membershipLevel')).shape);
const priceParams = levelParams.extend(idParam('priceId', idPattern('levelPrice')).shape);

interface NewPrice {
  interval: PriceInterval;
  amount: number;
  customAmount: boolean;
  minAmount?: number | null | undefined;
}

/**
 * Creates the Stripe Price for a level price. A recurring pay-what-you-want price has none: Stripe
 * has no custom amounts on recurring prices, so checkout sends price_data with the reader's amount.
 */
async function createStripePrice(
  api: StripeApi,
  account: ConnectedAccount,
  productId: string,
  levelId: string,
  priceId: string,
  currency: string,
  price: NewPrice,
): Promise<string | null> {
  if (price.customAmount && price.interval !== 'lifetime') return null;
  const params: Record<string, unknown> = {
    product: productId,
    currency,
    metadata: { swarm_level_id: levelId, swarm_price_id: priceId },
  };
  if (price.customAmount) {
    params.custom_unit_amount = {
      enabled: true,
      minimum: price.minAmount,
      preset: price.amount,
    };
  } else {
    params.unit_amount = price.amount;
  }
  if (price.interval !== 'lifetime') params.recurring = { interval: price.interval };
  const created = await stripeCall(() =>
    api.request<{ id: string }>('POST', '/v1/prices', params, {
      account: account.accountId,
      idempotencyKey: priceId,
    }),
  );
  return created.id;
}

async function deactivateStripePrice(
  c: AppContext,
  channelId: string,
  stripePriceId: string | null,
): Promise<void> {
  if (!stripePriceId) return;
  const account = await connectedAccount(env(c).DB, channelId);
  if (!account) return;
  await stripeCall(() =>
    stripe(c).request(
      'POST',
      `/v1/prices/${stripePriceId}`,
      { active: false },
      {
        account: account.accountId,
        idempotencyKey: `${stripePriceId}:deactivate`,
      },
    ),
  );
}

/** A yearly figure to compare prices across intervals: monthly × 12, yearly as is. */
const yearly = (interval: string, amount: number) => (interval === 'month' ? amount * 12 : amount);

/**
 * Founding Level rules: one active Founding Level per Channel; it has a monthly or yearly price
 * (not pay what you want), and its lowest yearly figure (monthly × 12, or yearly) is at least the
 * highest yearly figure of the Channel's active regular levels in the same currency.
 */
async function checkFounding(
  db: D1Database,
  channelId: string,
  levelId: string | null,
  currency: string,
  prices: NewPrice[],
): Promise<void> {
  const other = await first<{ id: string }>(
    db,
    `SELECT id FROM membership_levels WHERE channel_id = ?1 AND founding = 1 AND status = 'active'
       AND (?2 IS NULL OR id <> ?2)`,
    channelId,
    levelId,
  );
  if (other) throw new ApiError('conflict', 'This publication already has a founding plan.');
  const recurring = prices.filter((p) => p.interval !== 'lifetime');
  const invalid = (message: string) =>
    new ApiError('invalid_input', message, [{ path: 'prices', message }]);
  if (!recurring.length) throw invalid('A founding plan needs a monthly or yearly price.');
  if (recurring.some((p) => p.customAmount)) {
    throw invalid('A founding plan has a fixed price, not pay what you want.');
  }
  const regular = await first<{ top: number | null }>(
    db,
    `SELECT max(CASE p.interval WHEN 'month' THEN p.amount * 12 ELSE p.amount END) AS top
       FROM level_prices p JOIN membership_levels l ON l.id = p.level_id
      WHERE l.channel_id = ?1 AND l.status = 'active' AND l.founding = 0 AND p.status = 'active'
        AND p.interval IN ('month', 'year') AND p.currency = ?2 AND (?3 IS NULL OR l.id <> ?3)`,
    channelId,
    currency,
    levelId,
  );
  const floor = regular?.top ?? 0;
  const lowest = Math.min(...recurring.map((p) => yearly(p.interval, p.amount)));
  if (lowest < floor) {
    throw invalid(
      `A founding plan costs at least as much as the highest regular price: ${floor} per year (${currency}).`,
    );
  }
}

async function levelOut(c: AppContext, channelId: string, levelId: string) {
  const [level] = await readLevels(env(c).DB, channelId, { levelId, includeRetired: true });
  if (!level) throw new ApiError('not_found', 'Paid plan not found.');
  return level;
}

/** The currency of a level: its prices', else the account's. */
async function levelCurrency(db: D1Database, levelId: string): Promise<string | null> {
  const row = await first<{ currency: string }>(
    db,
    `SELECT currency FROM level_prices WHERE level_id = ?1 AND status <> 'retired'
      ORDER BY created_at DESC LIMIT 1`,
    levelId,
  );
  return row?.currency ?? null;
}

// ---- Levels ----------------------------------------------------------------------------------

levels.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/levels',
    tags: ['Membership levels'],
    summary: 'Membership levels of a Channel',
    description:
      'The implicit free level, then the paid levels (Founding Level first, then by position) with their active and scheduled prices. Archived levels only with includeArchived=true.',
    request: { params: channelParam, query: LevelListQuerySchema },
    responses: {
      200: ok(MembershipLevelListSchema, 'Levels'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { includeArchived } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const items = await readLevels(db, channelId, { includeArchived: includeArchived === 'true' });
    const members = await first<{ total: number; paid: number }>(
      db,
      `SELECT (SELECT count(*) FROM members WHERE channel_id = ?1 AND status IN ('active', 'paused')) AS total,
              (SELECT count(*) FROM member_entitlements e JOIN members m ON m.id = e.member_id
                WHERE e.channel_id = ?1 AND e.kind = 'paid' AND m.status IN ('active', 'paused')
                  AND (e.expires_at IS NULL OR e.expires_at > ?2)) AS paid`,
      channelId,
      Date.now(),
    );
    const free = Math.max(0, (members?.total ?? 0) - (members?.paid ?? 0));
    return c.json({ data: { free: { name: 'Free', memberCount: free }, items } }, 200);
  },
);

levels.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/levels',
    tags: ['Membership levels'],
    summary: 'Create a Membership level',
    description:
      'Admin role. Needs a connected Stripe account that can take payments (409 otherwise): the level becomes a Stripe Product on that account and each price a Stripe Price, with the level and price ids as idempotency keys. `founding` needs the founding_level flag; a pay-what-you-want price the pay_what_you_want flag. A Founding Level is the only one in the Channel, has a fixed monthly or yearly price, and its lowest yearly figure (monthly × 12, or yearly) is at least the highest yearly figure of the active regular levels. Currency defaults to the Stripe account’s.',
    request: { params: channelParam, body: jsonBody(CreateMembershipLevelSchema) },
    responses: {
      201: ok(MembershipLevelSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    if (input.founding) {
      await requireFlag(c, access, 'founding_level', 'Founding plans are not available.');
    }
    if (input.prices.some((p) => p.customAmount)) {
      await requireFlag(c, access, 'pay_what_you_want', 'Pay what you want is not available.');
    }
    const db = env(c).DB;
    const api = stripe(c);
    const account = await requireConnectedAccount(db, channelId);
    const currency = input.currency ?? account.defaultCurrency;
    if (!currency) {
      const message = 'Choose a currency.';
      throw new ApiError('invalid_input', message, [{ path: 'currency', message }]);
    }
    const count = await first<{ n: number; top: number | null }>(
      db,
      `SELECT count(*) AS n, max(position) AS top FROM membership_levels
        WHERE channel_id = ?1 AND status = 'active'`,
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_LEVELS) {
      throw new ApiError('conflict', `A publication can have ${MAX_LEVELS} active paid plans.`);
    }
    if (input.founding) await checkFounding(db, channelId, null, currency, input.prices);

    const now = Date.now();
    const levelId = newId('membershipLevel', now);
    const product = await stripeCall(() =>
      api.request<{ id: string }>(
        'POST',
        '/v1/products',
        {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          metadata: { swarm_level_id: levelId, swarm_channel_id: channelId },
        },
        { account: account.accountId, idempotencyKey: levelId },
      ),
    );
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO membership_levels (id, channel_id, name, description, benefits_json, founding,
             visibility, trial_days, status, position, stripe_product_id, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?12, ?12)`,
        )
        .bind(
          levelId,
          channelId,
          input.name,
          input.description ?? null,
          JSON.stringify(input.benefits),
          input.founding ? 1 : 0,
          input.visibility,
          input.trialDays,
          input.position ?? (count?.top ?? -1) + 1,
          product.id,
          access.auth.operatorId,
          now,
        ),
    ];
    for (const price of input.prices) {
      const priceId = newId('levelPrice', now);
      const stripePriceId = await createStripePrice(
        api,
        account,
        product.id,
        levelId,
        priceId,
        currency,
        price,
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, custom_amount,
               min_amount, status, stripe_price_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10)`,
          )
          .bind(
            priceId,
            levelId,
            channelId,
            price.interval,
            currency,
            price.amount,
            price.customAmount ? 1 : 0,
            price.customAmount ? (price.minAmount ?? null) : null,
            stripePriceId,
            now,
          ),
      );
    }
    await db.batch(statements);
    await audit(c, access, 'level.created', 'membership_level', levelId, {
      founding: input.founding,
      prices: input.prices.map((p) => ({ interval: p.interval, amount: p.amount })),
    });
    return c.json({ data: await levelOut(c, channelId, levelId) }, 201);
  },
);

levels.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/levels/{levelId}',
    tags: ['Membership levels'],
    summary: 'A Membership level with its full price history',
    request: { params: levelParams },
    responses: {
      200: ok(MembershipLevelSchema, 'Level'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, levelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await levelOut(c, channelId, levelId) }, 200);
  },
);

levels.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/levels/{levelId}',
    tags: ['Membership levels'],
    summary: 'Change a Membership level',
    description:
      'Admin role. Prices change through POST …/prices. A new name or description updates the Stripe Product. `status: archived` stops new purchases (the Stripe Product is deactivated); members who hold the level keep it. Turning `founding` on applies the Founding Level rules.',
    request: { params: levelParams, body: jsonBody(UpdateMembershipLevelSchema) },
    responses: {
      200: ok(MembershipLevelSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, levelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const row = await requireLevel(db, channelId, levelId);
    const becomesActive = input.status === 'active' && row.status === 'archived';
    if (becomesActive) {
      const count = await first<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM membership_levels WHERE channel_id = ?1 AND status = 'active'`,
        channelId,
      );
      if ((count?.n ?? 0) >= MAX_LEVELS) {
        throw new ApiError('conflict', `A publication can have ${MAX_LEVELS} active paid plans.`);
      }
    }
    const founding = input.founding ?? row.founding === 1;
    const active = (input.status ?? row.status) === 'active';
    if (founding && active && (input.founding === true || becomesActive)) {
      await requireFlag(c, access, 'founding_level', 'Founding plans are not available.');
      const prices = await all<PriceRow>(
        db,
        `SELECT * FROM level_prices WHERE level_id = ?1 AND status = 'active'`,
        levelId,
      );
      await checkFounding(
        db,
        channelId,
        levelId,
        prices[0]?.currency ?? '',
        prices.map((p) => ({
          interval: p.interval,
          amount: p.amount,
          customAmount: p.custom_amount === 1,
        })),
      );
    }

    const productChange: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== row.name) productChange.name = input.name;
    if (input.description !== undefined && input.description !== row.description) {
      productChange.description = input.description ?? '';
    }
    if (input.status !== undefined && input.status !== row.status) {
      productChange.active = input.status === 'active';
    }
    if (Object.keys(productChange).length && row.stripe_product_id) {
      // A disconnected account can't be reached; the level still changes here.
      const account = await connectedAccount(db, channelId);
      if (account) {
        const productId = row.stripe_product_id;
        await stripeCall(() =>
          stripe(c).request('POST', `/v1/products/${productId}`, productChange, {
            account: account.accountId,
          }),
        );
      }
    }
    const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    await db
      .prepare(
        `UPDATE membership_levels SET name = coalesce(?1, name),
                description = CASE WHEN ?2 = 1 THEN ?3 ELSE description END,
                benefits_json = coalesce(?4, benefits_json), founding = coalesce(?5, founding),
                visibility = coalesce(?6, visibility), trial_days = coalesce(?7, trial_days),
                position = coalesce(?8, position), status = coalesce(?9, status), updated_at = ?10
          WHERE id = ?11`,
      )
      .bind(
        input.name ?? null,
        input.description !== undefined ? 1 : 0,
        input.description ?? null,
        json(input.benefits),
        input.founding === undefined ? null : input.founding ? 1 : 0,
        input.visibility ?? null,
        input.trialDays ?? null,
        input.position ?? null,
        input.status ?? null,
        Date.now(),
        levelId,
      )
      .run();
    const action =
      input.status && input.status !== row.status
        ? input.status === 'archived'
          ? 'level.archived'
          : 'level.restored'
        : 'level.updated';
    await audit(c, access, action, 'membership_level', levelId, { fields: Object.keys(input) });
    return c.json({ data: await levelOut(c, channelId, levelId) }, 200);
  },
);

// ---- Prices ----------------------------------------------------------------------------------

const MAX_SCHEDULE_MS = 366 * 86_400_000;

levels.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/levels/{levelId}/prices',
    tags: ['Membership levels'],
    summary: 'Change a price (a new price, never an edit)',
    description:
      'Admin role. Creates a new level price and a new Stripe Price (idempotency key: the new price id). Without effectiveAt it is active now: the previous price for the interval is retired (and deactivated in Stripe) and existing paying Members keep it. With effectiveAt (in the future, within a year) it is scheduled, replacing any earlier scheduled change for the interval; the payments cron makes it active at that time and moves existing paying Members at renewal when existing is "migrate". A recurring pay-what-you-want price has no Stripe Price (checkout sends price_data).',
    request: { params: levelParams, body: jsonBody(CreateLevelPriceSchema) },
    responses: {
      201: ok(LevelPriceSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, levelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const row: LevelRow = await requireLevel(db, channelId, levelId);
    if (row.status !== 'active') {
      throw new ApiError('conflict', 'Restore the paid plan before changing its prices.');
    }
    if (input.customAmount) {
      await requireFlag(c, access, 'pay_what_you_want', 'Pay what you want is not available.');
    }
    const now = Date.now();
    const effectiveAt = input.effectiveAt ? Date.parse(input.effectiveAt) : null;
    if (
      effectiveAt !== null &&
      (effectiveAt <= now + 60_000 || effectiveAt > now + MAX_SCHEDULE_MS)
    ) {
      const message = 'Schedule the change within the next year.';
      throw new ApiError('invalid_input', message, [{ path: 'effectiveAt', message }]);
    }
    const api = stripe(c);
    const account = await requireConnectedAccount(db, channelId);
    const currency = (await levelCurrency(db, levelId)) ?? account.defaultCurrency;
    if (!currency || !row.stripe_product_id) {
      throw new ApiError('conflict', 'This paid plan has no Stripe Product. Create it again.');
    }
    const current = await all<PriceRow>(
      db,
      `SELECT * FROM level_prices WHERE level_id = ?1 AND status <> 'retired'`,
      levelId,
    );
    if (row.founding === 1) {
      const after = current
        .filter((p) => p.status === 'active' && p.interval !== input.interval)
        .map((p) => ({
          interval: p.interval,
          amount: p.amount,
          customAmount: p.custom_amount === 1,
        }))
        .concat([
          { interval: input.interval, amount: input.amount, customAmount: input.customAmount },
        ]);
      await checkFounding(db, channelId, levelId, currency, after);
    }
    const priceId = newId('levelPrice', now);
    const stripePriceId = await createStripePrice(
      api,
      account,
      row.stripe_product_id,
      levelId,
      priceId,
      currency,
      input,
    );
    // The row this one replaces: the active price now, or an earlier scheduled change.
    const replaced = current.find(
      (p) => p.interval === input.interval && p.status === (effectiveAt ? 'scheduled' : 'active'),
    );
    const statements: D1PreparedStatement[] = [];
    if (replaced) {
      statements.push(
        db
          .prepare(`UPDATE level_prices SET status = 'retired', retired_at = ?1 WHERE id = ?2`)
          .bind(now, replaced.id),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, custom_amount,
             min_amount, status, effective_at, existing, stripe_price_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          priceId,
          levelId,
          channelId,
          input.interval,
          currency,
          input.amount,
          input.customAmount ? 1 : 0,
          input.customAmount ? (input.minAmount ?? null) : null,
          effectiveAt ? 'scheduled' : 'active',
          effectiveAt,
          input.existing,
          stripePriceId,
          now,
        ),
      db.prepare('UPDATE membership_levels SET updated_at = ?1 WHERE id = ?2').bind(now, levelId),
    );
    await db.batch(statements);
    if (replaced) await deactivateStripePrice(c, channelId, replaced.stripe_price_id);
    await audit(c, access, 'level.price_changed', 'membership_level', levelId, {
      priceId,
      interval: input.interval,
      amount: input.amount,
      effectiveAt: input.effectiveAt ?? null,
      existing: input.existing,
      replaced: replaced?.id ?? null,
    });
    const created = await first<PriceRow>(db, 'SELECT * FROM level_prices WHERE id = ?1', priceId);
    return c.json({ data: toLevelPrice(created as PriceRow) }, 201);
  },
);

levels.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/levels/{levelId}/prices/{priceId}',
    tags: ['Membership levels'],
    summary: 'Cancel a scheduled price change, or stop offering an interval',
    description:
      'Admin role. A scheduled price is canceled; an active price is retired (existing paying Members keep it) as long as the level keeps another active price.',
    request: { params: priceParams },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, levelId, priceId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    await requireLevel(db, channelId, levelId);
    const price = await first<PriceRow>(
      db,
      'SELECT * FROM level_prices WHERE id = ?1 AND level_id = ?2',
      priceId,
      levelId,
    );
    if (!price) throw new ApiError('not_found', 'Price not found.');
    if (price.status === 'retired') return c.body(null, 204);
    if (price.status === 'active') {
      const others = await first<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM level_prices WHERE level_id = ?1 AND status = 'active' AND id <> ?2`,
        levelId,
        priceId,
      );
      if (!others?.n) {
        throw new ApiError(
          'conflict',
          'A paid plan keeps at least one price. Archive the plan to stop selling it.',
        );
      }
    }
    await db
      .prepare(`UPDATE level_prices SET status = 'retired', retired_at = ?1 WHERE id = ?2`)
      .bind(Date.now(), priceId)
      .run();
    await deactivateStripePrice(c, channelId, price.stripe_price_id);
    await audit(c, access, 'level.price_retired', 'membership_level', levelId, {
      priceId,
      was: price.status,
    });
    return c.body(null, 204);
  },
);
