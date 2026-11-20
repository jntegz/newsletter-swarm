// Goods on the site, with the real webhook processor and the dev Stripe: buying, the library,
// downloads, refunds and disputes, and what each one lets a stranger do.
import { env } from 'cloudflare:test';
import {
  DevStripe,
  GOODS_LIBRARY_TTL_SECONDS,
  LIBRARY_MAILS_PER_WINDOW,
  handleStripeEvent,
  localGoodsLinks,
  signLibraryToken,
  type StripeEvent,
} from '@swarm/engine';
import { signToken } from '@swarm/tokens';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSite, mountSite } from '../src/index';
import {
  BROWSER_UA,
  addMember,
  call,
  mailTo,
  nextIp,
  seedChannel,
  sessionCookie,
  uniqueEmail,
  type SeededChannel,
} from './helpers';
import { turnstile } from './turnstile';
import { cutoff, legacyKeys, testLinks } from './links';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const stripe = new DevStripe();
const site = createSite((s) => mountSite(s, { stripe: () => stripe }));
const PDF = '%PDF-1.4 the paid file';

interface Shop extends SeededChannel {
  goodId: string;
  priceId: string;
  fileId: string;
  account: string;
}

async function seedShop(options: { flag?: boolean; license?: boolean } = {}): Promise<Shop> {
  const ch = await seedChannel();
  const now = Date.now();
  const account = `acct_${hex().slice(0, 16)}`;
  const goodId = `gd_${hex()}`;
  const priceId = `gv_${hex()}`;
  const fileId = `gf_${hex()}`;
  const mediaId = `md_${hex()}`;
  const key = `${ch.channelId}/${hex()}.pdf`;
  await env.MEDIA.put(key, PDF);
  const flag = options.flag ?? true;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled, tax_enabled,
         default_currency, connected_at, updated_at) VALUES (?1, ?2, ?3, 1, 0, 'usd', ?4, ?4)`,
    ).bind(ch.channelId, ch.workspaceId, account, now),
    ...(flag
      ? [
          env.DB.prepare(
            `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'goods', 'channel', ?2, 1, 0)`,
          ).bind(`ff_${hex()}`, ch.channelId),
        ]
      : []),
    env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, 'application/pdf', 20, ?5)`,
    ).bind(mediaId, ch.workspaceId, ch.channelId, key, now),
    env.DB.prepare(
      `INSERT INTO goods (id, channel_id, slug, name, description, status, license_keys, created_at, updated_at)
       VALUES (?1, ?2, 'field-guide', 'Field Guide', 'A <b>useful</b> guide.', 'published', ?3, ?4, ?4)`,
    ).bind(goodId, ch.channelId, options.license ? 1 : 0, now),
    env.DB.prepare(
      `INSERT INTO good_prices (id, good_id, name, amount, currency) VALUES (?1, ?2, 'Standard', 900, 'usd')`,
    ).bind(priceId, goodId),
    env.DB.prepare(
      `INSERT INTO good_files (id, good_id, media_id, name) VALUES (?1, ?2, ?3, 'Guide')`,
    ).bind(fileId, goodId, mediaId),
  ]);
  return { ...ch, goodId, priceId, fileId, account };
}

/** A second, cheaper product with its own file, in the same Channel. */
async function addGood(ch: Shop) {
  const now = Date.now();
  const goodId = `gd_${hex()}`;
  const priceId = `gv_${hex()}`;
  const fileId = `gf_${hex()}`;
  const mediaId = `md_${hex()}`;
  const key = `${ch.channelId}/${hex()}.pdf`;
  await env.MEDIA.put(key, '%PDF-1.4 the cheap file');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, 'application/pdf', 20, ?5)`,
    ).bind(mediaId, ch.workspaceId, ch.channelId, key, now),
    env.DB.prepare(
      `INSERT INTO goods (id, channel_id, slug, name, description, status, license_keys, created_at, updated_at)
       VALUES (?1, ?2, 'sticker', 'Sticker', 'Cheap.', 'published', 0, ?3, ?3)`,
    ).bind(goodId, ch.channelId, now),
    env.DB.prepare(
      `INSERT INTO good_prices (id, good_id, name, amount, currency) VALUES (?1, ?2, 'Standard', 100, 'usd')`,
    ).bind(priceId, goodId),
    env.DB.prepare(
      `INSERT INTO good_files (id, good_id, media_id, name) VALUES (?1, ?2, ?3, 'Sticker sheet')`,
    ).bind(fileId, goodId, mediaId),
  ]);
  return { goodId, priceId, fileId };
}

const post = (ch: SeededChannel, path: string, fields: Record<string, string>, cookie?: string) =>
  call(site, `${ch.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ch.origin,
      'user-agent': BROWSER_UA,
      'cf-connecting-ip': nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });

/** Buys a product as an anonymous visitor typing `email`, or as the reader behind `cookie`. */
async function buy(
  ch: Shop,
  email: string,
  product: { goodId: string; priceId: string } = ch,
  cookie?: string,
  /** The signed-in Member the product page named (money/buyer.ts). */
  buyer?: string,
) {
  turnstile.pass = true;
  turnstile.action = 'checkout';
  const res = await post(
    ch,
    '/_swarm/checkout',
    {
      good: product.goodId,
      price: product.priceId,
      ...(cookie ? {} : { email }),
      ...(buyer ? { buyer } : {}),
      'cf-turnstile-response': 'ok',
    },
    cookie,
  );
  expect(res.status).toBe(303);
  const dev = new URL(res.headers.get('location')!);
  const done = await post(ch, dev.pathname, {});
  expect(done.status).toBe(303);
  return done.headers.get('location')!;
}

const keys = () => testLinks();
const library = async (ch: Shop, email: string) =>
  `${ch.origin}/_swarm/library/${await signLibraryToken(keys(), ch.channelId, (await order(ch, email))!.id)}`;
/**
 * A library link as mailed before links stopped carrying the address (claim `e`): a v1 link,
 * signed with MEMBER_KEYS before the cutover.
 */
const legacyLibrary = async (ch: Shop, email: string, now = cutoff() - 60_000) =>
  `${ch.origin}/_swarm/library/${await signToken(
    legacyKeys(),
    'goods-library',
    { c: ch.channelId, e: email.toLowerCase() },
    { expiresInSeconds: GOODS_LIBRARY_TTL_SECONDS, now },
  )}`;
const order = (ch: Shop, email: string) =>
  env.DB.prepare(
    'SELECT id, status, member_id, payment_intent_id FROM good_orders WHERE channel_id = ?1 AND email = ?2',
  )
    .bind(ch.channelId, email)
    .first<{ id: string; status: string; member_id: string | null; payment_intent_id: string }>();

const event = (ch: Shop, type: string, object: Record<string, unknown>): StripeEvent => ({
  id: `evt_${hex().slice(0, 20)}`,
  type,
  account: ch.account,
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: { object },
});
const webhook = (e: StripeEvent) =>
  handleStripeEvent(
    {
      db: env.DB,
      stripe,
      links: testLinks(),
      goodsLinks: localGoodsLinks(testLinks()),
      fieldKeys: undefined,
      now: Date.now(),
    },
    e,
  );

beforeAll(() => {
  turnstile.pass = true;
});

describe('product pages', () => {
  it('are hidden while the flag is off', async () => {
    const ch = await seedShop({ flag: false });
    for (const path of ['/goods', '/goods/field-guide', '/_swarm/library']) {
      expect((await call(site, `${ch.origin}${path}`)).status).toBe(404);
    }
    const res = await post(ch, '/_swarm/checkout', {
      good: ch.goodId,
      price: ch.priceId,
      email: uniqueEmail('off'),
      'cf-turnstile-response': 'ok',
    });
    expect(res.status).toBe(404);
  });

  it('show a published product, escape its words and allow the checkout', async () => {
    const ch = await seedShop();
    const res = await call(site, `${ch.origin}/goods/field-guide`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Field Guide');
    expect(html).toContain('A &lt;b&gt;useful&lt;/b&gt; guide.');
    expect(html).toContain('$9');
    expect(res.headers.get('content-security-policy')).toContain('checkout.stripe.com');
  });

  it('do not show a draft, or sell one', async () => {
    const ch = await seedShop();
    await env.DB.prepare(`UPDATE goods SET status = 'draft' WHERE id = ?1`).bind(ch.goodId).run();
    expect((await call(site, `${ch.origin}/goods/field-guide`)).status).toBe(404);
    const res = await post(ch, '/_swarm/checkout', {
      good: ch.goodId,
      price: ch.priceId,
      email: uniqueEmail('draft'),
      'cf-turnstile-response': 'ok',
    });
    expect(res.status).toBe(404);
  });

  it('refuse a price from another product, and a checkout without an address', async () => {
    const ch = await seedShop();
    const other = await seedShop();
    const wrong = await post(ch, '/_swarm/checkout', {
      good: ch.goodId,
      price: other.priceId,
      email: uniqueEmail('wrong'),
      'cf-turnstile-response': 'ok',
    });
    expect(wrong.status).toBe(404);
    const anonymous = await post(ch, '/_swarm/checkout', {
      good: ch.goodId,
      price: ch.priceId,
      'cf-turnstile-response': 'ok',
    });
    expect(anonymous.status).toBe(400);
  });
});

describe('buying', () => {
  it('delivers the file, and does not sign the buyer up', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('buyer');
    const thanks = await buy(ch, email);
    const row = await order(ch, email);
    expect(row).toMatchObject({ status: 'paid', member_id: null });
    const member = await env.DB.prepare(
      'SELECT 1 FROM members WHERE channel_id = ?1 AND email = ?2',
    )
      .bind(ch.channelId, email)
      .first();
    expect(member).toBeNull();

    const page = await (await call(site, thanks)).text();
    const link = /href="(\/_swarm\/library\/[^"]+)"/.exec(page)?.[1];
    expect(link).toBeTruthy();
    const shelf = await (await call(site, `${ch.origin}${link}`)).text();
    expect(shelf).toContain('Field Guide');
    const file = await call(site, `${ch.origin}${link}/f/${ch.fileId}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(PDF);
    expect(file.headers.get('content-disposition')).toContain('attachment; filename="Guide.pdf"');
    expect(file.headers.get('cache-control')).toBe('no-store');
  });

  it('shows only this checkout on the thank-you page, not what the typed address bought before', async () => {
    const ch = await seedShop({ license: true });
    const victim = uniqueEmail('victim');
    await buy(ch, victim);
    const key = await env.DB.prepare(
      'SELECT license_key FROM good_license_keys WHERE order_id = ?1',
    )
      .bind((await order(ch, victim))!.id)
      .first<{ license_key: string }>();
    expect(key?.license_key).toBeTruthy();

    // A stranger buys the cheap product anonymously, typing the victim's address.
    const cheap = await addGood(ch);
    const thanks = await buy(ch, victim, cheap);
    const page = await (await call(site, thanks)).text();
    const links = [...page.matchAll(/href="(\/_swarm\/library\/[^"]+)"/g)].map((m) => m[1]!);
    expect(links).toHaveLength(1);
    const shelf = await (await call(site, `${ch.origin}${links[0]}`)).text();
    expect(shelf).toContain('Sticker');
    expect(shelf).not.toContain('Field Guide');
    expect(shelf).not.toContain(key!.license_key);
    expect((await call(site, `${ch.origin}${links[0]}/f/${ch.fileId}`)).status).toBe(404);
    // What they just paid for still downloads.
    expect((await call(site, `${ch.origin}${links[0]}/f/${cheap.fileId}`)).status).toBe(200);
  });

  it('gives the signed-in Member who bought their whole library on the thank-you page', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('member');
    const memberId = await addMember(ch.channelId, email);
    const cookie = await sessionCookie(ch.channelId, memberId);
    await buy(ch, email, ch, cookie, memberId);
    const cheap = await addGood(ch);
    const thanks = await buy(ch, email, cheap, cookie, memberId);
    const page = await (await call(site, thanks, { headers: { cookie } })).text();
    const link = /href="(\/_swarm\/library\/[^"]+)"/.exec(page)?.[1];
    expect(link).toBeTruthy();
    const shelf = await (await call(site, `${ch.origin}${link}`)).text();
    expect(shelf).toContain('Sticker');
    expect(shelf).toContain('Field Guide');
    // The same page seen without that session shows only this checkout.
    const anonymous = await (await call(site, thanks)).text();
    const scoped = /href="(\/_swarm\/library\/[^"]+)"/.exec(anonymous)?.[1];
    expect(scoped).toBeTruthy();
    expect(await (await call(site, `${ch.origin}${scoped}`)).text()).not.toContain('Field Guide');
  });

  it('counts one order and one payment when Stripe sends the event twice', async () => {
    const ch = await seedShop({ license: true });
    const email = uniqueEmail('twice');
    await buy(ch, email);
    const row = await order(ch, email);
    const keysBefore = await env.DB.prepare(
      'SELECT count(*) AS n FROM good_license_keys WHERE order_id = ?1',
    )
      .bind(row!.id)
      .first<{ n: number }>();
    expect(keysBefore?.n).toBe(1);
    const events = await env.DB.prepare(
      `SELECT count(*) AS n FROM platform_events WHERE channel_id = ?1 AND type = 'good.purchased'`,
    )
      .bind(ch.channelId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('gives each order a working license key', async () => {
    const ch = await seedShop({ license: true });
    const email = uniqueEmail('license');
    await buy(ch, email);
    const html = await (await call(site, await library(ch, email))).text();
    expect(html).toMatch(/<code>[A-Z2-9]{5}(-[A-Z2-9]{5}){3}<\/code>/);
  });
});

describe('who can download', () => {
  it('refuses someone who has not bought it, and a link for another publication', async () => {
    const ch = await seedShop();
    await buy(ch, uniqueEmail('owner'));
    const stranger = await legacyLibrary(ch, uniqueEmail('stranger'));
    expect((await call(site, `${stranger}/f/${ch.fileId}`)).status).toBe(404);

    const other = await seedShop();
    const email = uniqueEmail('elsewhere');
    await buy(other, email);
    const foreign = await signLibraryToken(
      keys(),
      other.channelId,
      (await order(other, email))!.id,
    );
    const res = await call(site, `${ch.origin}/_swarm/library/${foreign}/f/${ch.fileId}`);
    expect(res.status).toBe(410);
    // Holding a good from one publication doesn't reach another publication's file.
    const mine = await library(other, email);
    expect((await call(site, `${mine}/f/${ch.fileId}`)).status).toBe(404);
  });

  it('refuses a forged or tampered link', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('forged');
    await buy(ch, email);
    expect((await call(site, `${ch.origin}/_swarm/library/nonsense`)).status).toBe(410);
    const good = await library(ch, email);
    const res = await call(site, `${good.slice(0, -2)}xx/f/${ch.fileId}`);
    expect(res.status).toBe(410);
  });

  it('expires the link', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('late');
    await buy(ch, email);
    const old = await signLibraryToken(
      keys(),
      ch.channelId,
      (await order(ch, email))!.id,
      Date.now() - 91 * 86_400_000,
    );
    expect((await call(site, `${ch.origin}/_swarm/library/${old}`)).status).toBe(410);
  });

  it('never reveals the media address', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('address');
    await buy(ch, email);
    const html = await (await call(site, await library(ch, email))).text();
    expect(html).not.toContain('/media/');
    expect(html).not.toContain(ch.channelId);
  });
});

describe('links carry no address (S04-C-TR-bearer-and-log-exposure)', () => {
  /** What a token's claims say, decoded from its payload (never the signature's bytes). */
  const readable = (token: string) => {
    const payload = token.split('.')[3]!;
    return Object.values(
      JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>,
    )
      .map(String)
      .join(' ');
  };
  const tokenOf = (link: string) => decodeURIComponent(link.split('/_swarm/library/')[1]!);

  it('keeps the address out of the thank-you page link, the mailed link and the file links', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('opaque');
    const thanks = await buy(ch, email);
    const page = await (await call(site, thanks)).text();
    const onPage = /href="(\/_swarm\/library\/[^"]+)"/.exec(page)![1]!;
    const [mail] = (await mailTo(email)).filter((m) => m.text.includes('/_swarm/library/'));
    const mailed = /(\/_swarm\/library\/[A-Za-z0-9._%-]+)/.exec(mail!.text)![1]!;
    const local = email.split('@')[0]!;
    for (const link of [onPage, mailed]) {
      expect(link).not.toContain(local);
      expect(readable(tokenOf(link))).not.toContain(local);
      expect(readable(tokenOf(link))).not.toContain('@');
      const shelf = await (await call(site, `${ch.origin}${link}`)).text();
      expect(shelf).toContain('Field Guide');
      expect(shelf).not.toContain(local);
      expect((await call(site, `${ch.origin}${link}/f/${ch.fileId}`)).status).toBe(200);
    }
  });

  it('still opens a library link mailed before, until it expires', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('legacy');
    await buy(ch, email);
    const link = await legacyLibrary(ch, email);
    expect(await (await call(site, link)).text()).toContain('Field Guide');
    expect((await call(site, `${link}/f/${ch.fileId}`)).status).toBe(200);
    const old = await legacyLibrary(ch, email, Date.now() - 91 * 86_400_000);
    expect((await call(site, old)).status).toBe(410);
  });

  it('refuses a link naming an order of another publication', async () => {
    const ch = await seedShop();
    const other = await seedShop();
    const email = uniqueEmail('cross');
    await buy(other, email);
    const forged = await signLibraryToken(keys(), ch.channelId, (await order(other, email))!.id);
    expect((await call(site, `${ch.origin}/_swarm/library/${forged}`)).status).toBe(410);
  });
});

describe('ending an order', () => {
  it.each([
    ['refund', 'charge.refunded', 'refunded'],
    ['dispute', 'charge.dispute.created', 'disputed'],
  ])('a %s ends access and the license key', async (_name, type, status) => {
    const ch = await seedShop({ license: true });
    const email = uniqueEmail(status);
    await buy(ch, email);
    const row = await order(ch, email);
    const link = await library(ch, email);
    expect((await call(site, `${link}/f/${ch.fileId}`)).status).toBe(200);

    const object =
      type === 'charge.refunded'
        ? {
            id: `ch_${hex()}`,
            object: 'charge',
            amount: 900,
            amount_refunded: 900,
            refunded: true,
            currency: 'usd',
            payment_intent: row!.payment_intent_id,
          }
        : {
            id: `dp_${hex()}`,
            object: 'dispute',
            payment_intent: row!.payment_intent_id,
          };
    await webhook(event(ch, type, object));

    expect((await order(ch, email))?.status).toBe(status);
    expect((await call(site, `${link}/f/${ch.fileId}`)).status).toBe(404);
    expect(await (await call(site, link)).text()).not.toContain('Field Guide');
    const key = await env.DB.prepare('SELECT revoked_at FROM good_license_keys WHERE order_id = ?1')
      .bind(row!.id)
      .first<{ revoked_at: number | null }>();
    expect(key?.revoked_at).not.toBeNull();
  });

  it('leaves access alone after a partial refund', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('partial');
    await buy(ch, email);
    const row = await order(ch, email);
    await webhook(
      event(ch, 'charge.refunded', {
        id: `ch_${hex()}`,
        object: 'charge',
        amount: 900,
        amount_refunded: 100,
        refunded: false,
        currency: 'usd',
        payment_intent: row!.payment_intent_id,
      }),
    );
    expect((await order(ch, email))?.status).toBe('paid');
  });
});

describe('asking for the link again', () => {
  it('answers the same whether or not the address bought anything', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('again');
    await buy(ch, email);
    const known = await post(ch, '/_swarm/library', { email });
    const unknown = await post(ch, '/_swarm/library', { email: uniqueEmail('nobody') });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const strip = (html: string) => html.replace(/<title>.*<\/title>/, '');
    expect(strip(await known.text())).toBe(strip(await unknown.text()));
  });

  it('mails one buyer a bounded number of library links, however many ask', async () => {
    const ch = await seedShop();
    const email = uniqueEmail('flood');
    await buy(ch, email);
    const library = async () =>
      (await mailTo(email)).filter((m) => m.category === 'goods_library').length;
    const before = await library();
    for (let i = 0; i < LIBRARY_MAILS_PER_WINDOW + 4; i++) {
      expect((await post(ch, '/_swarm/library', { email })).status).toBe(200);
    }
    expect((await library()) - before).toBe(LIBRARY_MAILS_PER_WINDOW);
  });
});
