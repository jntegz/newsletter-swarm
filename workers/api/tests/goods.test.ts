// Goods through the dashboard API: the flag, publishing rules, ownership, refunds and media.
import { env } from 'cloudflare:test';
import type { Good, GoodOrder } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, signIn, type Session } from './helpers';
import { connectAccount, data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let channelId: string;
const hex = () => crypto.randomUUID().replace(/-/g, '');
const goods = (channel = channelId) => `/api/v1/channels/${channel}/goods`;

async function pdf(channel: string, type = 'application/pdf') {
  const id = `md_${hex()}`;
  await env.DB.prepare(
    `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 10, 0)`,
  )
    .bind(id, owner.workspaceId, channel, `${channel}/${hex()}`, type)
    .run();
  return id;
}

const price = { name: 'Standard', amount: 900, currency: 'usd' };
const create = async (body: Record<string, unknown>, channel = channelId) =>
  call('POST', goods(channel), { cookie: owner.cookie, body });

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('goods', () => {
  it('is behind its flag', async () => {
    const res = await call('GET', goods(), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    await enableFlag('goods', owner.workspaceId, channelId);
    expect((await call('GET', goods(), { cookie: owner.cookie })).status).toBe(200);
  });

  it('starts as a draft, and goes on sale only with a price and a file', async () => {
    const good = await data<Good>(await create({ name: 'Guide', slug: 'guide' }), 201);
    expect(good.status).toBe('draft');
    expect(good.url).toContain('/goods/guide');
    const url = `${goods()}/${good.id}`;
    const early = await call('PATCH', url, { cookie: owner.cookie, body: { status: 'published' } });
    expect(early.status).toBe(400);
    const mediaId = await pdf(channelId);
    const ready = await data<Good>(
      await call('PATCH', url, {
        cookie: owner.cookie,
        body: { prices: [price], files: [{ mediaId, name: 'The guide' }], status: 'published' },
      }),
    );
    expect(ready.status).toBe('published');
    expect(ready.prices[0]).toMatchObject({ amount: 900 });
    const emptied = await call('PATCH', url, { cookie: owner.cookie, body: { prices: [] } });
    expect(emptied.status).toBe(400);
  });

  it('keeps a price’s id when it is edited, and archives one left out', async () => {
    const good = await data<Good>(
      await create({ name: 'Prices', slug: 'prices', prices: [price, { ...price, name: 'Pro' }] }),
      201,
    );
    const [first] = good.prices;
    const next = await data<Good>(
      await call('PATCH', `${goods()}/${good.id}`, {
        cookie: owner.cookie,
        body: { prices: [{ id: first!.id, name: 'Basic', amount: 500, currency: 'usd' }] },
      }),
    );
    expect(next.prices).toEqual([{ id: first!.id, name: 'Basic', amount: 500, currency: 'usd' }]);
    const left = await env.DB.prepare(
      'SELECT count(*) AS n FROM good_prices WHERE good_id = ?1 AND archived_at IS NOT NULL',
    )
      .bind(good.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it('refuses a slug twice, an image, and files or prices from elsewhere', async () => {
    expect((await create({ name: 'Dup', slug: 'dup' })).status).toBe(201);
    expect((await create({ name: 'Dup 2', slug: 'dup' })).status).toBe(409);
    const image = await pdf(channelId, 'image/png');
    expect(
      (await create({ name: 'Img', slug: 'img', files: [{ mediaId: image, name: 'x' }] })).status,
    ).toBe(400);
    const other = await createChannel(owner);
    await enableFlag('goods', owner.workspaceId, other.id);
    const foreign = await pdf(other.id);
    expect(
      (await create({ name: 'F', slug: 'foreign', files: [{ mediaId: foreign, name: 'x' }] }))
        .status,
    ).toBe(400);
    const theirs = await data<Good>(
      await create({ name: 'Theirs', slug: 'theirs', prices: [price] }, other.id),
      201,
    );
    const mine = await data<Good>(await create({ name: 'Mine', slug: 'mine' }), 201);
    const stolen = await call('PATCH', `${goods()}/${mine.id}`, {
      cookie: owner.cookie,
      body: { prices: [{ ...price, id: theirs.prices[0]!.id }] },
    });
    expect(stolen.status).toBe(400);
    expect((await call('GET', `${goods()}/${theirs.id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
  });

  it('won’t delete a file a product sells', async () => {
    const mediaId = await pdf(channelId);
    await create({ name: 'Keeps', slug: 'keeps', files: [{ mediaId, name: 'x' }] });
    const res = await call('DELETE', `/api/v1/media/${mediaId}`, { cookie: owner.cookie });
    expect(res.status).toBe(409);
  });

  it('refunds a paid order once, and leaves abandoned checkouts out of the list', async () => {
    await connectAccount(owner, channelId);
    const good = await data<Good>(await create({ name: 'Sold', slug: 'sold' }), 201);
    const add = (id: string, status: string, intent: string | null) =>
      env.DB.prepare(
        `INSERT INTO good_orders (id, channel_id, good_id, email, amount, currency, status, payment_intent_id, created_at)
         VALUES (?1, ?2, ?3, 'buyer@example.com', 900, 'usd', ?4, ?5, 0)`,
      )
        .bind(id, channelId, good.id, status, intent)
        .run();
    const paid = `go_${hex()}`;
    await add(paid, 'paid', 'pi_test');
    await add(`go_${hex()}`, 'pending', null);
    const list = await data<{ items: GoodOrder[] }>(
      await call('GET', `/api/v1/channels/${channelId}/good-orders`, { cookie: owner.cookie }),
    );
    expect(list.items.map((o) => o.id)).toEqual([paid]);
    const refund = `/api/v1/channels/${channelId}/good-orders/${paid}/refund`;
    const done = await data<GoodOrder>(await call('POST', refund, { cookie: owner.cookie }));
    expect(done.status).toBe('refunded');
    expect((await call('POST', refund, { cookie: owner.cookie })).status).toBe(409);
  });
});
