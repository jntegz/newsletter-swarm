// Goods, shared by the dashboard routes (routes/goods.ts) and the public API (v2/goods.ts).
import { all, first, isUniqueViolation, toIso, type ChannelAccess } from '@swarm/db';
import {
  goodPath,
  newId,
  type CreateGood,
  type Good,
  type GoodOrder,
  type GoodStatus,
  type UpdateGood,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { env, type AppContext } from './context';
import { requireFlag, siteOrigin } from './site';

const GOODS_OFF = 'Products are not turned on for this publication.';

export const requireGoods = (
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
) => requireFlag(c, access, 'goods', GOODS_OFF);

interface GoodRow {
  id: string;
  channel_id: string;
  slug: string;
  name: string;
  description: string;
  status: GoodStatus;
  license_keys: number;
  created_at: number;
  updated_at: number;
}

export async function listGoods(c: AppContext, channelId: string, ids?: string[]): Promise<Good[]> {
  const db = env(c).DB;
  const rows = await all<GoodRow>(
    db,
    `SELECT * FROM goods WHERE channel_id = ?1
        AND (?2 IS NULL OR id IN (SELECT value FROM json_each(?2)))
      ORDER BY status = 'archived', name`,
    channelId,
    ids ? JSON.stringify(ids) : null,
  );
  if (!rows.length) return [];
  const goodIds = JSON.stringify(rows.map((row) => row.id));
  const [origin, prices, files] = await Promise.all([
    siteOrigin(c, channelId),
    all<{ id: string; good_id: string; name: string; amount: number; currency: string }>(
      db,
      `SELECT id, good_id, name, amount, currency FROM good_prices
        WHERE good_id IN (SELECT value FROM json_each(?1)) AND archived_at IS NULL ORDER BY position`,
      goodIds,
    ),
    all<{ id: string; good_id: string; media_id: string; name: string }>(
      db,
      `SELECT id, good_id, media_id, name FROM good_files
        WHERE good_id IN (SELECT value FROM json_each(?1)) ORDER BY position`,
      goodIds,
    ),
  ]);
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    slug: row.slug,
    url: new URL(goodPath(row.slug), origin.origin).toString(),
    name: row.name,
    description: row.description,
    status: row.status,
    licenseKeys: row.license_keys === 1,
    prices: prices
      .filter((p) => p.good_id === row.id)
      .map((p) => ({ id: p.id, name: p.name, amount: p.amount, currency: p.currency })),
    files: files
      .filter((f) => f.good_id === row.id)
      .map((f) => ({ id: f.id, mediaId: f.media_id, name: f.name })),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

export async function getGood(c: AppContext, channelId: string, goodId: string): Promise<Good> {
  const [good] = await listGoods(c, channelId, [goodId]);
  if (!good) throw new ApiError('not_found', 'Product not found.');
  return good;
}

/** Only PDFs of this publication can be sold: other files would need a real virus scanner. */
async function checkFiles(c: AppContext, channelId: string, mediaIds: string[]) {
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw new ApiError('invalid_input', 'Each file can be on a product once.');
  }
  if (!mediaIds.length) return;
  const row = await first<{ n: number }>(
    env(c).DB,
    `SELECT count(*) AS n FROM media
      WHERE channel_id = ?1 AND deleted_at IS NULL AND content_type = 'application/pdf'
        AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(mediaIds),
  );
  if ((row?.n ?? 0) !== mediaIds.length) {
    throw new ApiError('invalid_input', 'Products can only include PDFs from this publication.');
  }
}

function priceStatements(
  db: D1Database,
  goodId: string,
  prices: NonNullable<CreateGood['prices']>,
  now: number,
) {
  const kept = prices.flatMap((p) => (p.id ? [p.id] : []));
  return [
    db
      .prepare(
        `UPDATE good_prices SET archived_at = ?1
          WHERE good_id = ?2 AND archived_at IS NULL
            AND id NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(now, goodId, JSON.stringify(kept)),
    ...prices.map((p, position) =>
      p.id
        ? db
            .prepare(
              `UPDATE good_prices SET name = ?1, amount = ?2, currency = ?3, position = ?4
                WHERE id = ?5 AND good_id = ?6`,
            )
            .bind(p.name, p.amount, p.currency, position, p.id, goodId)
        : db
            .prepare(
              `INSERT INTO good_prices (id, good_id, name, amount, currency, position)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .bind(newId('goodPrice', now), goodId, p.name, p.amount, p.currency, position),
    ),
  ];
}

function fileStatements(
  db: D1Database,
  goodId: string,
  files: NonNullable<CreateGood['files']>,
  now: number,
) {
  return [
    db.prepare('DELETE FROM good_files WHERE good_id = ?1').bind(goodId),
    ...files.map((f, position) =>
      db
        .prepare(
          'INSERT INTO good_files (id, good_id, media_id, name, position) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(newId('goodFile', now), goodId, f.mediaId, f.name, position),
    ),
  ];
}

const slugTaken = () =>
  new ApiError('conflict', 'Another product already uses this address. Choose another.');

export async function createGood(
  c: AppContext,
  channelId: string,
  input: CreateGood,
): Promise<Good> {
  const db = env(c).DB;
  const now = Date.now();
  const id = newId('good', now);
  await checkFiles(
    c,
    channelId,
    (input.files ?? []).map((f) => f.mediaId),
  );
  // A new product has no prices to keep, so an id sent here means nothing.
  const prices = (input.prices ?? []).map(({ id: _id, ...price }) => price);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO goods (id, channel_id, slug, name, description, license_keys, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        )
        .bind(
          id,
          channelId,
          input.slug,
          input.name,
          input.description ?? '',
          input.licenseKeys ? 1 : 0,
          now,
        ),
      ...priceStatements(db, id, prices, now),
      ...fileStatements(db, id, input.files ?? [], now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
  return getGood(c, channelId, id);
}

export async function updateGood(
  c: AppContext,
  channelId: string,
  goodId: string,
  input: UpdateGood,
): Promise<Good> {
  const db = env(c).DB;
  const now = Date.now();
  const current = await getGood(c, channelId, goodId);
  if (input.files)
    await checkFiles(
      c,
      channelId,
      input.files.map((f) => f.mediaId),
    );
  if (input.prices) {
    // An id from another product must not move that product's price.
    const known = await all<{ id: string }>(
      db,
      'SELECT id FROM good_prices WHERE good_id = ?1 AND archived_at IS NULL',
      goodId,
    );
    const ids = new Set(known.map((p) => p.id));
    if (input.prices.some((p) => p.id && !ids.has(p.id))) {
      throw new ApiError('invalid_input', 'That price isn’t on this product.');
    }
  }
  const prices = input.prices?.length ?? current.prices.length;
  const files = input.files?.length ?? current.files.length;
  if ((input.status ?? current.status) === 'published' && (!prices || !files)) {
    throw new ApiError(
      'invalid_input',
      'A product needs a price and a file before it can go on sale.',
    );
  }
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE goods SET name = ?1, slug = ?2, description = ?3, license_keys = ?4, status = ?5, updated_at = ?6
            WHERE id = ?7 AND channel_id = ?8`,
        )
        .bind(
          input.name ?? current.name,
          input.slug ?? current.slug,
          input.description ?? current.description,
          (input.licenseKeys ?? current.licenseKeys) ? 1 : 0,
          input.status ?? current.status,
          now,
          goodId,
          channelId,
        ),
      ...(input.prices ? priceStatements(db, goodId, input.prices, now) : []),
      ...(input.files ? fileStatements(db, goodId, input.files, now) : []),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
  return getGood(c, channelId, goodId);
}

interface OrderRow {
  id: string;
  channel_id: string;
  good_id: string;
  good_name: string;
  price_name: string | null;
  member_id: string | null;
  email: string;
  amount: number;
  currency: string;
  status: GoodOrder['status'];
  license_key: string | null;
  created_at: number;
  paid_at: number | null;
  ended_at: number | null;
}

const toOrder = (row: OrderRow): GoodOrder => ({
  id: row.id,
  channelId: row.channel_id,
  goodId: row.good_id,
  goodName: row.good_name,
  priceName: row.price_name,
  memberId: row.member_id,
  email: row.email,
  amount: row.amount,
  currency: row.currency,
  status: row.status,
  licenseKey: row.license_key,
  createdAt: toIso(row.created_at),
  paidAt: row.paid_at === null ? null : toIso(row.paid_at),
  endedAt: row.ended_at === null ? null : toIso(row.ended_at),
});

const ORDER_SELECT = `SELECT o.id, o.channel_id, o.good_id, g.name AS good_name, p.name AS price_name,
         o.member_id, o.email, o.amount, o.currency, o.status, k.license_key, o.created_at,
         o.paid_at, o.ended_at
    FROM good_orders o JOIN goods g ON g.id = o.good_id
    LEFT JOIN good_prices p ON p.id = o.price_id
    LEFT JOIN good_license_keys k ON k.order_id = o.id`;

/** Orders that got as far as paying, newest first. An abandoned checkout isn't an order. */
export async function listOrders(
  c: AppContext,
  channelId: string,
  query: { cursor?: string | null | undefined; limit: number },
): Promise<{ items: GoodOrder[]; nextCursor: string | null }> {
  const rows = await all<OrderRow>(
    env(c).DB,
    `${ORDER_SELECT}
      WHERE o.channel_id = ?1 AND o.status <> 'pending' AND (?2 IS NULL OR o.id < ?2)
      ORDER BY o.id DESC LIMIT ?3`,
    channelId,
    query.cursor ?? null,
    query.limit + 1,
  );
  const items = rows.slice(0, query.limit).map(toOrder);
  return { items, nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
}

export async function getOrder(c: AppContext, channelId: string, orderId: string) {
  const row = await first<OrderRow & { payment_intent_id: string | null }>(
    env(c).DB,
    `SELECT sub.*, o2.payment_intent_id FROM (${ORDER_SELECT}
      WHERE o.id = ?1 AND o.channel_id = ?2) sub JOIN good_orders o2 ON o2.id = sub.id`,
    orderId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Order not found.');
  return { order: toOrder(row), paymentIntentId: row.payment_intent_id };
}
