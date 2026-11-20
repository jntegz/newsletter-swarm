// Goods on the publication's website (flag goods; docs/goods.md):
//
//   GET  /goods                          what's for sale
//   GET  /goods/:slug                    one product and a form that posts to /_swarm/checkout
//   GET  /_swarm/library/:token          what this buyer has bought, with downloads (or one order)
//   GET  /_swarm/library/:token/f/:file  one file, streamed after the order check
//   GET  /_swarm/library                 ask for the library link again
//   POST /_swarm/library                 mails it, with the same answer whether or not they bought:
//                                        the lookup and the send run after the response, and an
//                                        address gets at most 3 library mails a day per publication
//
// Files are never redirected to their media URL: a link a buyer could keep would outlive a refund.
import { EmailSchema, GOODS_PATH, goodPath } from '@swarm/domain';
import { all, first } from '@swarm/db';
import {
  LIBRARY_MAILS_PER_WINDOW,
  LIBRARY_MAIL_WINDOW_MS,
  TURNSTILE_SCRIPT,
  goodsDownload,
  goodsLibrary,
  latestPaidOrder,
  mailAdapter,
  linksFor,
  readGoodsToken,
  sendGoodsLibraryMail,
  takeMailAllowance,
} from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import { evidenceGoodsLinks } from '../vault';
import { formatMoney } from '../money/amounts';
import { SIGNOUT_FORM, buyerLine } from '../money/buyer';
import { memberById, paidAccount } from '../money/data';
import { crossSite, field, refused, tooMany, underPaymentLimit } from '../money/guard';
import { later } from '../readers/later';
import { h, readerPage } from '../readers/pages';
import { siteFlags } from '../render/data';
import { loadChrome, renderPage, sendPage } from '../render/layout';

export const goods = new Hono<SiteBindings>();

const FILE_ID = /^gf_[0-9a-f]{32}$/;

interface GoodRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

interface PriceRow {
  id: string;
  good_id: string;
  name: string;
  amount: number;
  currency: string;
}

async function priceRows(env: SiteEnv, ids: string[]) {
  return all<PriceRow>(
    env.DB,
    `SELECT id, good_id, name, amount, currency FROM good_prices
      WHERE good_id IN (SELECT value FROM json_each(?1)) AND archived_at IS NULL
      ORDER BY position`,
    JSON.stringify(ids),
  );
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${h(part)}</p>`)
    .join('');

goods.get(GOODS_PATH, async (c) => {
  if (!(await siteFlags(c)).goods) return c.notFound();
  const env = c.get('env');
  const channel = c.get('channel');
  const [chrome, rows] = await Promise.all([
    loadChrome(c),
    all<GoodRow>(
      env.DB,
      `SELECT id, slug, name, description FROM goods
        WHERE channel_id = ?1 AND status = 'published' ORDER BY name`,
      channel.id,
    ),
  ]);
  const prices = await priceRows(
    env,
    rows.map((row) => row.id),
  );
  const cards = rows
    .map((row) => {
      const from = prices.find((p) => p.good_id === row.id);
      return `<li><a href="${h(goodPath(row.slug))}"><strong>${h(row.name)}</strong></a>${from ? ` <span class="sw-muted">${h(formatMoney(from.amount, from.currency))}</span>` : ''}</li>`;
    })
    .join('');
  return sendPage(
    c,
    renderPage(c, chrome, {
      meta: {
        title: 'Shop',
        description: `Products from ${channel.name}.`,
        path: GOODS_PATH,
      },
      body: `<article class="sw-page"><h1>Shop</h1>${cards ? `<ul>${cards}</ul>` : '<p>Nothing for sale right now.</p>'}<p class="sw-muted"><a href="/_swarm/library">Find something you already bought</a></p></article>`,
      subscribe: false,
    }),
    { cache: 'private' },
  );
});

goods.get(`${GOODS_PATH}/:slug`, async (c) => {
  if (!(await siteFlags(c)).goods) return c.notFound();
  const env = c.get('env');
  const channel = c.get('channel');
  const good = await first<GoodRow>(
    env.DB,
    `SELECT id, slug, name, description FROM goods
      WHERE channel_id = ?1 AND slug = ?2 AND status = 'published'`,
    channel.id,
    c.req.param('slug').toLowerCase(),
  );
  if (!good) return c.notFound();
  const [chrome, prices, account] = await Promise.all([
    loadChrome(c),
    priceRows(env, [good.id]),
    paidAccount(env, channel.id),
  ]);
  const open = !!account?.chargesEnabled && prices.length > 0;
  const signedIn = !!c.get('reader').memberId;
  const member = signedIn ? await memberById(env, channel.id, c.get('reader').memberId!) : null;
  const form = open
    ? `<form class="sw-plan-form" method="post" action="/_swarm/checkout">
<input type="hidden" name="good" value="${h(good.id)}">
${
  prices.length === 1
    ? `<input type="hidden" name="price" value="${h(prices[0]!.id)}"><p><strong>${h(formatMoney(prices[0]!.amount, prices[0]!.currency))}</strong></p>`
    : `<fieldset><legend>Choose an option</legend>${prices
        .map(
          (p, i) =>
            `<label><input type="radio" name="price" value="${h(p.id)}"${i === 0 ? ' checked' : ''}> ${h(p.name)}: ${h(formatMoney(p.amount, p.currency))}</label>`,
        )
        .join('')}</fieldset>`
}
${signedIn ? (member ? buyerLine({ memberId: member.id, email: member.email }) : '') : '<label>Your email <input type="email" name="email" autocomplete="email" required maxlength="254"></label><p class="sw-muted">Your files are sent here.</p>'}
<div class="cf-turnstile" data-sitekey="${h(env.TURNSTILE_SITE_KEY)}" data-action="checkout"></div>
<button type="submit">Buy</button>
</form>`
    : '<p>This product isn’t on sale right now.</p>';
  return sendPage(
    c,
    renderPage(c, chrome, {
      meta: {
        title: good.name,
        description: good.description.slice(0, 160) || `${good.name} from ${channel.name}.`,
        path: goodPath(good.slug),
      },
      body: `<article class="sw-page"><h1>${h(good.name)}</h1>${paragraphs(good.description)}${form}${member ? SIGNOUT_FORM : ''}</article>${open ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : ''}`,
      subscribe: false,
    }),
    { cache: 'private' },
  );
});

const libraryUrl = (token: string) => `/_swarm/library/${encodeURIComponent(token)}`;

const askForLink = (note = '') =>
  `${note}<form method="post" action="/_swarm/library">
<label>Your email <input type="email" name="email" autocomplete="email" required maxlength="254"></label>
<button type="submit">Send me the link</button>
</form>`;

goods.get('/_swarm/library', async (c) => {
  if (!(await siteFlags(c)).goods) return c.notFound();
  return readerPage(
    c,
    'Your library',
    `<h1>Your library</h1><p>Enter the address you bought with, and we’ll email you a link to your files.</p>${askForLink()}`,
  );
});

goods.post('/_swarm/library', async (c) => {
  if (crossSite(c)) return refused(c);
  if (!(await siteFlags(c)).goods) return c.notFound();
  if (!(await underPaymentLimit(c, 'library'))) return tooMany(c);
  const env = c.get('env');
  const channel = c.get('channel');
  const form = await c.req.parseBody();
  const email = EmailSchema.safeParse(field(form, 'email', 254));
  if (!email.success) {
    return readerPage(
      c,
      'Check your email',
      `<h1>Check your email</h1><p>Enter a valid email address.</p>${askForLink()}`,
      400,
    );
  }
  // Everything that depends on the address runs after the response, so the answer and its
  // timing are the same whether or not it bought anything. One address gets at most
  // LIBRARY_MAILS_PER_WINDOW library mails from this publication a day, however many ask.
  const now = Date.now();
  later(
    c,
    (async () => {
      // The link names their newest paid order, never the address.
      const orderId = await latestPaidOrder(env.DB, channel.id, email.data);
      if (!orderId) return;
      const allowed = await takeMailAllowance(env.DB, {
        scope: 'goods_library',
        key: `${channel.id}:${email.data.toLowerCase()}`,
        limit: LIBRARY_MAILS_PER_WINDOW,
        windowMs: LIBRARY_MAIL_WINDOW_MS,
        now,
      });
      if (!allowed) return;
      await sendGoodsLibraryMail(
        {
          db: env.DB,
          // The vault mints the link from the address asked for (rate-limited there).
          goodsLinks: evidenceGoodsLinks(env, {
            kind: 'library-request',
            channelId: channel.id,
            email: email.data,
          }),
          now,
          mail: {
            adapter: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
            platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
            site: { scheme: env.SITE_SCHEME, platformDomain: env.PLATFORM_SITE_DOMAIN },
            captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
          },
        },
        { channelId: channel.id, to: email.data, orderId, goodName: null },
      );
    })(),
  );
  // The same answer either way, so this can't be used to learn who bought what.
  return readerPage(
    c,
    'Check your inbox',
    '<h1>Check your inbox</h1><p>If that address has bought something here, a link to your files is on its way.</p>',
  );
});

/** Who a link is for: a whole address (the mailed link), or one order (the thank-you page). */
async function libraryScope(
  c: SiteContext,
): Promise<{ email: string; orderId: string | null } | null> {
  const env = c.get('env');
  return readGoodsToken(env.DB, linksFor(env), c.get('channel').id, c.req.param('token') ?? '');
}

const expired = (c: SiteContext) =>
  readerPage(
    c,
    'This link has expired',
    `<h1>This link has expired</h1><p>Enter the address you bought with, and we’ll send a new one.</p>${askForLink()}`,
    410,
  );

goods.get('/_swarm/library/:token', async (c) => {
  if (!(await siteFlags(c)).goods) return c.notFound();
  const scope = await libraryScope(c);
  if (!scope) return expired(c);
  const items = await goodsLibrary(
    c.get('env').DB,
    c.get('channel').id,
    scope.email,
    scope.orderId,
  );
  const token = c.req.param('token');
  const list = items
    .map((item) => {
      const files = item.files
        .map((f) => `<li><a href="${h(libraryUrl(token))}/f/${h(f.id)}">${h(f.name)}</a></li>`)
        .join('');
      return `<section><h2>${h(item.name)}</h2>${
        files ? `<ul>${files}</ul>` : '<p class="small">No files yet.</p>'
      }${item.licenseKey ? `<p>License key: <code>${h(item.licenseKey)}</code></p>` : ''}</section>`;
    })
    .join('');
  return readerPage(
    c,
    'Your library',
    `<h1>Your library</h1>${list || '<p>There’s nothing here. A refunded order no longer shows.</p>'}<p class="small">Keep this page’s link private: anyone who has it can download these files.</p>`,
  );
});

goods.get('/_swarm/library/:token/f/:file', async (c) => {
  if (!(await siteFlags(c)).goods) return c.notFound();
  const scope = await libraryScope(c);
  if (!scope) return expired(c);
  const fileId = c.req.param('file');
  if (!FILE_ID.test(fileId)) return c.notFound();
  const env = c.get('env');
  const file = await goodsDownload(env.DB, c.get('channel').id, scope.email, fileId, scope.orderId);
  if (!file) return c.notFound();
  const object = await env.MEDIA.get(file.r2Key);
  if (!object) return c.notFound();
  const safe = file.name.replace(/[^\w .-]+/g, '_').slice(0, 120) || 'download';
  const name = /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
  return new Response(object.body, {
    headers: {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
});

interface GoodCheckout {
  email: string | null;
  memberId: string | null;
  orderId: string | null;
}

/** Goods links for a paid order's thank-you page, minted by the vault (none: no link shown). */
const thanksLinks = (env: SiteEnv, channelId: string, orderId: string) => {
  const links = evidenceGoodsLinks(env, { kind: 'order', channelId, orderId });
  return {
    libraryToken: (input: { channelId: string; orderId: string }) =>
      links.libraryToken(input).catch(() => null),
    orderToken: (input: { channelId: string; orderId: string }) =>
      links.orderToken(input).catch(() => null),
  };
};

/**
 * The page after a good's checkout, with a link in case the mail is slow or lost. Anyone holding
 * the checkout reference sees this page, and its address was typed, not proved. So the link covers
 * only this order, unless the reader is signed in as the Member who bought.
 */
export async function goodsThanks(c: SiteContext, row: GoodCheckout): Promise<Response> {
  const env = c.get('env');
  const channelId = c.get('channel').id;
  const readerId = c.get('reader').memberId;
  const member =
    readerId && readerId === row.memberId ? await memberById(env, channelId, readerId) : null;
  const own = !!member && !!row.email && member.email.toLowerCase() === row.email;
  // Both name the order, never the address.
  const token =
    !row.email || !row.orderId
      ? null
      : own
        ? await thanksLinks(env, channelId, row.orderId).libraryToken({
            channelId,
            orderId: row.orderId,
          })
        : await thanksLinks(env, channelId, row.orderId).orderToken({
            channelId,
            orderId: row.orderId,
          });
  return readerPage(
    c,
    'Thank you',
    `<h1>Thank you!</h1><p>We’ve emailed you a link to your files.</p>${token ? `<p><a href="${h(libraryUrl(token))}">${own ? 'Open your library now' : 'Get your files now'}</a></p>` : ''}`,
  );
}
