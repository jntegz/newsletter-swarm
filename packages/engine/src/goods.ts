/**
 * Goods (flag goods): digital products bought one at a time on the publisher's own Stripe account.
 *
 * - The order is written before Checkout, and only the signed checkout webhook marks it paid.
 * - Buying doesn't sign anyone up: an existing Member is linked, nobody is created.
 * - A buyer's library is one signed link per address and Channel. Nothing secret is stored for it,
 *   so it can be mailed again, and it is checked against the orders on every request. The link
 *   names one of the address's orders, never the address, which is looked up when it is used. A refund or
 *   dispute ends access even if the link is still valid. That link goes only to the mailbox or a
 *   signed-in Member; the thank-you page gets an order link, good for that one order.
 * - Paid files are served only through that check, never by sending the buyer to the media URL.
 */
import { sha256Hex } from '@swarm/db';
import { newId, type GoodOrderStatus } from '@swarm/domain';
import { all, first } from './db';
import type { GoodsLinkMinter, LinkSigner, LinkVerifier } from './links';
import { platformEventStatement } from './platform-events';

const LIBRARY_PURPOSE = 'goods-library';
export const GOODS_LIBRARY_TTL_SECONDS = 90 * 24 * 60 * 60;
const ORDER_PURPOSE = 'goods-order';
const ORDER_ID = /^go_[0-9a-f]{32}$/;

/**
 * A library link: everything bought from the Channel with the address of one of its orders. The
 * token names that order, never the address, so the link and a log line holding it don't say who
 * bought (security review S04-C-TR-bearer-and-log-exposure); the address is looked up on use.
 */
export async function signLibraryToken(
  links: LinkSigner,
  channelId: string,
  orderId: string,
  now: number = Date.now(),
): Promise<string> {
  return links.sign(
    LIBRARY_PURPOSE,
    { c: channelId, a: orderId },
    { expiresInSeconds: GOODS_LIBRARY_TTL_SECONDS, now },
  );
}

/**
 * A link to one order only, for the thank-you page: whoever reaches that page may have typed
 * someone else's address, so it must not open everything the address has bought. It names the
 * order, never the address.
 */
export async function signOrderToken(
  links: LinkSigner,
  channelId: string,
  orderId: string,
  now: number = Date.now(),
): Promise<string> {
  return links.sign(
    ORDER_PURPOSE,
    { c: channelId, o: orderId },
    { expiresInSeconds: GOODS_LIBRARY_TTL_SECONDS, now },
  );
}

/** Goods links signed by this worker itself (site and the api, until the vault signs them). */
export const localGoodsLinks = (links: LinkSigner): GoodsLinkMinter => ({
  libraryToken: ({ channelId, orderId, now }) => signLibraryToken(links, channelId, orderId, now),
  orderToken: ({ channelId, orderId, now }) => signOrderToken(links, channelId, orderId, now),
});

/** The address an order was bought with, from the server's own record. */
async function orderEmail(db: D1Database, channelId: string, orderId: unknown) {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return null;
  const row = await first<{ email: string }>(
    db,
    'SELECT email FROM good_orders WHERE id = ?1 AND channel_id = ?2',
    orderId,
    channelId,
  );
  return row?.email ?? null;
}

/**
 * Who a library or order link is for: a whole address (the mailed library link), or one order
 * (the thank-you page). Null when it isn't valid for this Channel. Links mailed before tokens
 * stopped carrying the address (claim `e`) keep working until they expire.
 */
export async function readGoodsToken(
  db: D1Database,
  links: LinkVerifier,
  channelId: string,
  token: string,
  now: number = Date.now(),
): Promise<{ email: string; orderId: string | null } | null> {
  if (token.length > 1024) return null;
  const library = await links.verify<{ c?: unknown; e?: unknown; a?: unknown }>(
    LIBRARY_PURPOSE,
    token,
    { now },
  );
  if (library.ok) {
    const { c, e, a } = library.payload;
    if (c !== channelId) return null;
    const email =
      a !== undefined ? await orderEmail(db, channelId, a) : typeof e === 'string' ? e : null;
    return email ? { email, orderId: null } : null;
  }
  const order = await links.verify<{ c?: unknown; e?: unknown; o?: unknown }>(
    ORDER_PURPOSE,
    token,
    { now },
  );
  if (!order.ok) return null;
  const { c, e, o } = order.payload;
  if (c !== channelId || typeof o !== 'string') return null;
  const email = typeof e === 'string' ? e : await orderEmail(db, channelId, o);
  return email ? { email, orderId: o } : null;
}

/** The newest paid order an address holds from a Channel: what a fresh library link names. */
export async function latestPaidOrder(
  db: D1Database,
  channelId: string,
  email: string,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM good_orders WHERE channel_id = ?1 AND email = ?2 AND status = 'paid'
      ORDER BY paid_at DESC LIMIT 1`,
    channelId,
    email.toLowerCase(),
  );
  return row?.id ?? null;
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A license key: 20 characters from a 32-letter alphabet (100 bits), in groups of five. */
export function newLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const text = [...bytes].map((byte) => KEY_ALPHABET[byte & 31]).join('');
  return text.match(/.{5}/g)!.join('-');
}

export interface LibraryItem {
  orderId: string;
  goodId: string;
  name: string;
  description: string;
  licenseKey: string | null;
  paidAt: number;
  files: { id: string; name: string }[];
}

/** What an address has bought from a Channel and can still use, or just one order of it. */
export async function goodsLibrary(
  db: D1Database,
  channelId: string,
  email: string,
  orderId: string | null = null,
): Promise<LibraryItem[]> {
  const orders = await all<{
    id: string;
    good_id: string;
    name: string;
    description: string;
    license_key: string | null;
    paid_at: number;
  }>(
    db,
    `SELECT o.id, o.good_id, g.name, g.description, k.license_key, o.paid_at
       FROM good_orders o JOIN goods g ON g.id = o.good_id
       LEFT JOIN good_license_keys k ON k.order_id = o.id AND k.revoked_at IS NULL
      WHERE o.channel_id = ?1 AND o.email = ?2 AND o.status = 'paid' AND (?3 IS NULL OR o.id = ?3)
      ORDER BY o.paid_at DESC`,
    channelId,
    email,
    orderId,
  );
  if (!orders.length) return [];
  const files = await all<{ id: string; good_id: string; name: string }>(
    db,
    `SELECT f.id, f.good_id, f.name FROM good_files f
      WHERE f.good_id IN (SELECT value FROM json_each(?1)) ORDER BY f.position`,
    JSON.stringify([...new Set(orders.map((o) => o.good_id))]),
  );
  return orders.map((order) => ({
    orderId: order.id,
    goodId: order.good_id,
    name: order.name,
    description: order.description,
    licenseKey: order.license_key,
    paidAt: order.paid_at,
    files: files.filter((f) => f.good_id === order.good_id).map(({ id, name }) => ({ id, name })),
  }));
}

/**
 * The stored file behind a download, only if this address holds a paid order for its good (that
 * order, when `orderId` is given).
 */
export async function goodsDownload(
  db: D1Database,
  channelId: string,
  email: string,
  fileId: string,
  orderId: string | null = null,
): Promise<{ name: string; r2Key: string; contentType: string } | null> {
  const row = await first<{ name: string; r2_key: string; content_type: string }>(
    db,
    `SELECT f.name, m.r2_key, m.content_type
       FROM good_files f JOIN media m ON m.id = f.media_id AND m.deleted_at IS NULL
      WHERE f.id = ?1 AND EXISTS (
        SELECT 1 FROM good_orders o
         WHERE o.good_id = f.good_id AND o.channel_id = ?2 AND o.email = ?3 AND o.status = 'paid'
           AND (?4 IS NULL OR o.id = ?4))`,
    fileId,
    channelId,
    email,
    orderId,
  );
  return row ? { name: row.name, r2Key: row.r2_key, contentType: row.content_type } : null;
}

export interface GoodOrderEvent {
  id: string;
  channelId: string;
  goodId: string;
  memberId: string | null;
  email: string;
  amount: number;
  currency: string;
  status: GoodOrderStatus;
}

/**
 * Marks an order paid exactly once, with its license key and the webhook announcement. Returns
 * null when it was already handled.
 */
export async function markGoodOrderPaid(
  db: D1Database,
  input: {
    orderId: string;
    channelId: string;
    workspaceId: string;
    memberId: string | null;
    sessionId: string | null;
    paymentIntentId: string | null;
    now: number;
  },
): Promise<GoodOrderEvent | null> {
  const { orderId, channelId, now } = input;
  const updated = await first<{
    id: string;
    good_id: string;
    email: string;
    amount: number;
    currency: string;
    member_id: string | null;
  }>(
    db,
    `UPDATE good_orders SET status = 'paid', paid_at = ?1, stripe_session_id = ?2,
            payment_intent_id = ?3, member_id = coalesce(member_id, ?4)
      WHERE id = ?5 AND channel_id = ?6 AND status = 'pending'
      RETURNING id, good_id, email, amount, currency, member_id`,
    now,
    input.sessionId,
    input.paymentIntentId,
    input.memberId,
    orderId,
    channelId,
  );
  if (!updated) return null;
  const good = await first<{ license_keys: number }>(
    db,
    'SELECT license_keys FROM goods WHERE id = ?1',
    updated.good_id,
  );
  const event: GoodOrderEvent = {
    id: updated.id,
    channelId,
    goodId: updated.good_id,
    memberId: updated.member_id,
    email: updated.email,
    amount: updated.amount,
    currency: updated.currency,
    status: 'paid',
  };
  const statements = [
    platformEventStatement(
      db,
      {
        type: 'good.purchased',
        workspaceId: input.workspaceId,
        channelId,
        memberId: updated.member_id,
        payload: { ...event },
      },
      now,
    ),
  ];
  if (good?.license_keys === 1) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO good_license_keys (id, channel_id, order_id, good_id, license_key, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          newId('goodLicense', now),
          channelId,
          updated.id,
          updated.good_id,
          newLicenseKey(),
          now,
        ),
    );
  }
  await db.batch(statements);
  return event;
}

/** A full refund or a dispute: access ends and the license key stops working. Once only. */
export async function endGoodOrder(
  db: D1Database,
  input: {
    channelId: string;
    workspaceId: string;
    paymentIntentId?: string | null;
    orderId?: string | null;
    status: 'refunded' | 'disputed';
    now: number;
  },
): Promise<boolean> {
  const { channelId, status, now } = input;
  if (!input.paymentIntentId && !input.orderId) return false;
  const ended = await first<{
    id: string;
    good_id: string;
    member_id: string | null;
    email: string;
    amount: number;
    currency: string;
  }>(
    db,
    `UPDATE good_orders SET status = ?1, ended_at = ?2
      WHERE channel_id = ?3 AND status = 'paid'
        AND ((?4 IS NOT NULL AND payment_intent_id = ?4) OR (?5 IS NOT NULL AND id = ?5))
      RETURNING id, good_id, member_id, email, amount, currency`,
    status,
    now,
    channelId,
    input.paymentIntentId ?? null,
    input.orderId ?? null,
  );
  if (!ended) return false;
  await db.batch([
    db
      .prepare('UPDATE good_license_keys SET revoked_at = ?1 WHERE order_id = ?2')
      .bind(now, ended.id),
    platformEventStatement(
      db,
      {
        type: 'good.refunded',
        workspaceId: input.workspaceId,
        channelId,
        memberId: ended.member_id,
        payload: {
          id: ended.id,
          channelId,
          goodId: ended.good_id,
          memberId: ended.member_id,
          email: ended.email,
          amount: ended.amount,
          currency: ended.currency,
          status,
        },
      },
      now,
    ),
  ]);
  return true;
}

/** Whether a license key is good right now, for a publisher's own app. */
export async function checkLicense(
  db: D1Database,
  channelId: string,
  key: string,
): Promise<{ valid: boolean; goodId: string | null; orderId: string | null }> {
  const row = await first<{ good_id: string; order_id: string; revoked_at: number | null }>(
    db,
    `SELECT good_id, order_id, revoked_at FROM good_license_keys
      WHERE channel_id = ?1 AND license_key = ?2`,
    channelId,
    key.trim().toUpperCase(),
  );
  if (!row) return { valid: false, goodId: null, orderId: null };
  return { valid: row.revoked_at === null, goodId: row.good_id, orderId: row.order_id };
}

/** Library mails one address can get from one publication per LIBRARY_MAIL_WINDOW_MS. */
export const LIBRARY_MAILS_PER_WINDOW = 3;
export const LIBRARY_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Takes one from an address's allowance of a kind of mail (mail_allowances) and says whether there
 * was one. The count and the window restart are one statement, so concurrent requests can't both
 * take the last one.
 */
export async function takeMailAllowance(
  db: D1Database,
  input: { scope: string; key: string; limit: number; windowMs: number; now: number },
): Promise<boolean> {
  const row = await first<{ used: number }>(
    db,
    `INSERT INTO mail_allowances (scope, key_hash, window_start, used) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (scope, key_hash) DO UPDATE SET
       used = CASE WHEN window_start <= ?4 THEN 1 ELSE used + 1 END,
       window_start = CASE WHEN window_start <= ?4 THEN ?3 ELSE window_start END
     RETURNING used`,
    input.scope,
    await sha256Hex(`${input.scope}:${input.key}`),
    input.now,
    input.now - input.windowMs,
  );
  return (row?.used ?? Infinity) <= input.limit;
}
