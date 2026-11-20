// Gift Passes and gift articles on the site.
//
//   GET  /_swarm/gift/:token     the Gift Pass and a form to claim it (GET never claims)
//   POST /_swarm/gift/:token     claims it
//   POST /_swarm/gift-article    a signed-in, entitled Member shares one gated Dispatch
//   POST /_swarm/gift-article/revoke  stops that Member's links to one Dispatch
//
// Claiming: the token's hash (the first link's, or the claim reminder's) finds a paid, unexpired
// pass; one UPDATE flips it to claimed, so a second claim (or a concurrent one) fails. The claimant types their email. That address gets a
// Member, a member_subscriptions row (source 'gift', active until now + months) and a recomputed
// entitlement. Only the address the claim link was mailed to (the recipient, or the purchaser when
// there is none) is proved by the claim: a new Member there is created active. Any other address
// could be anyone's, so a new Member there is created pending and gets the usual confirmation
// email. Claiming never signs the browser in, whoever's address it is: a claim link can be sent
// to someone else, and a session for the link's Member would make that person read, and buy, as
// the sender. The gift lands on the Member, who signs in with the usual emailed link (proof of
// the mailbox), and a browser already signed in as someone else stays signed in as them.
//
// Gift articles (flag gift_articles): at most GIFT_ARTICLE_MAX_PER_PERIOD links per Member per
// calendar month; a link (/p/<slug>?gift=<token>) works for 30 days, at most
// GIFT_ARTICLE_MAX_READS times, and only while the Member who shared it can read the post, and
// shows that one Dispatch in full, never cached and not indexed, without touching the reader's
// meter (money/access.ts). POST /_swarm/gift-article/revoke stops the Member's own links to a
// post; the publisher can stop every link to a post from the API.
import { EmailSchema, newId } from '@swarm/domain';
import { first, run } from '@swarm/db';
import {
  GIFT_ARTICLE_MAX_PER_PERIOD,
  GIFT_ARTICLE_MAX_READS,
  GIFT_ARTICLE_TTL_MS,
  addMonths,
  giftTokenHash,
  isErasedAddress,
  mailAdapter,
  monthPeriod,
  newGiftToken,
  recomputeEntitlement,
  recordMemberEvent,
  recordMemberEvents,
  revokeGiftArticleLinks,
  linksFor,
  sendConfirmation,
} from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { gateConfig } from '../money/data';
import { gateAdmits } from '../money/gate';
import {
  crossSite,
  field,
  refused,
  scriptedRequest,
  tooMany,
  underPaymentLimit,
} from '../money/guard';
import { later } from '../readers/later';
import { h, readerPage } from '../readers/pages';
import { siteFlags } from '../render/data';
import { dispatchPath } from '../render/html';
import { siteMarkers } from '../vault';

export const gifts = new Hono<SiteBindings>();

interface GiftRow {
  id: string;
  status: 'pending_payment' | 'paid' | 'claimed' | 'expired' | 'refunded';
  months: number;
  message: string | null;
  recipient_email: string | null;
  claim_by: number | null;
  level_id: string | null;
  level_name: string | null;
}

async function giftByToken(c: SiteContext, token: string): Promise<GiftRow | null> {
  const hash = await giftTokenHash(token);
  if (!hash) return null;
  return first<GiftRow>(
    c.get('env').DB,
    `SELECT g.id, g.status, g.months, g.message, g.recipient_email, g.claim_by, g.level_id,
            l.name AS level_name
       FROM gift_passes g LEFT JOIN membership_levels l ON l.id = g.level_id
      WHERE (g.claim_token_hash = ?1 OR g.reminder_token_hash = ?1) AND g.channel_id = ?2`,
    hash,
    c.get('channel').id,
  );
}

/** Why a pass can't be claimed, or null when it can. */
function unclaimable(c: SiteContext, gift: GiftRow | null, now: number): Response | null {
  if (!gift) {
    return readerPage(
      c,
      'Gift not found',
      '<h1>This gift link is not valid</h1><p>Check that you copied the whole link.</p>',
      404,
    );
  }
  if (gift.status === 'claimed') {
    return readerPage(
      c,
      'Already claimed',
      '<h1>This gift subscription was already claimed</h1><p>If that was you, <a href="/_swarm/reader/signin">sign in</a> with the email you used.</p>',
      410,
    );
  }
  if (gift.status === 'pending_payment') {
    return readerPage(
      c,
      'Not ready yet',
      '<h1>This gift subscription is not ready yet</h1><p>The payment is still being confirmed. Try again in a few minutes.</p>',
      409,
    );
  }
  if (gift.status !== 'paid' || (gift.claim_by !== null && gift.claim_by <= now)) {
    return readerPage(
      c,
      'Gift expired',
      '<h1>This gift subscription has expired</h1><p>Ask the person who gave it to you to get in touch with the publication.</p>',
      410,
    );
  }
  return null;
}

const months = (n: number) => `${n} month${n === 1 ? '' : 's'}`;

gifts.get('/_swarm/gift/:token', async (c) => {
  const token = c.req.param('token');
  const gift = await giftByToken(c, token);
  const problem = unclaimable(c, gift, Date.now());
  if (problem || !gift) return problem!;
  return readerPage(
    c,
    'A gift for you',
    `<h1>A gift for you</h1>
<p>Someone gave you ${h(months(gift.months))} of ${h(gift.level_name ?? 'a paid subscription')} with ${h(c.get('channel').name)}.</p>
${gift.message ? `<blockquote><p>${h(gift.message)}</p></blockquote>` : ''}
<form method="post" action="/_swarm/gift/${h(encodeURIComponent(token))}">
<label>Your email<input type="email" name="email" autocomplete="email" required maxlength="254" value="${h(gift.recipient_email ?? '')}"></label>
<button type="submit">Claim the gift</button>
</form>
<p class="small">Your paid subscription starts when you claim it.</p>`,
  );
});

gifts.post('/_swarm/gift/:token', async (c) => {
  if (crossSite(c)) return refused(c);
  if (!(await underPaymentLimit(c, 'gift'))) return tooMany(c);
  const env = c.get('env');
  const channel = c.get('channel');
  const token = c.req.param('token');
  const form = await c.req.parseBody();
  const email = EmailSchema.safeParse(field(form, 'email', 254));
  if (!email.success) {
    return readerPage(
      c,
      'Check your email',
      `<h1>Check your email</h1><p>Enter a valid email address.</p><p><a href="/_swarm/gift/${h(encodeURIComponent(token))}">Back</a></p>`,
      400,
    );
  }
  // An address erased through the Privacy Center never becomes a Member again; the pass stays
  // unclaimed for another address.
  if (await isErasedAddress(env.DB, channel.workspaceId, email.data, siteMarkers(env))) {
    return readerPage(
      c,
      'Check your email',
      `<h1>Check your email</h1><p>This address can’t be used here. Enter another one.</p><p><a href="/_swarm/gift/${h(encodeURIComponent(token))}">Back</a></p>`,
      400,
    );
  }
  const now = Date.now();
  const hash = await giftTokenHash(token);
  // Single use: a second or concurrent claim finds the status already changed.
  const claimed = hash
    ? await first<{
        id: string;
        level_id: string | null;
        months: number;
        recipient_email: string | null;
        purchaser_email: string;
      }>(
        env.DB,
        `UPDATE gift_passes SET status = 'claimed', claimed_at = ?1
          WHERE (claim_token_hash = ?2 OR reminder_token_hash = ?2) AND channel_id = ?3 AND status = 'paid'
            AND (claim_by IS NULL OR claim_by > ?1)
         RETURNING id, level_id, months, recipient_email, purchaser_email`,
        now,
        hash,
        channel.id,
      )
    : null;
  if (!claimed) return unclaimable(c, await giftByToken(c, token), now)!;

  const address = email.data;
  // The claim link (and its reminder) went to this address, so holding it proves the address.
  const recipient = (claimed.recipient_email ?? claimed.purchaser_email).toLowerCase() === address;
  // Claiming is consent only for the proved address; anyone else confirms by email first.
  const created = await first<{ id: string }>(
    env.DB,
    `INSERT INTO members (id, channel_id, email, status, source_json, consent_at, confirmed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)
     ON CONFLICT (channel_id, email) DO NOTHING RETURNING id`,
    newId('member', now),
    channel.id,
    address,
    recipient ? 'active' : 'pending',
    JSON.stringify({ kind: 'gift', gift_pass: claimed.id }),
    recipient ? now : null,
    now,
  );
  let memberId: string;
  if (created) {
    memberId = created.id;
    await recordMemberEvents(
      env.DB,
      recipient
        ? [
            { type: 'member_joined', memberId, payload: { source: 'gift', status: 'active' } },
            { type: 'confirmed', memberId, payload: { method: 'gift' } },
          ]
        : [{ type: 'member_joined', memberId, payload: { source: 'gift', status: 'pending' } }],
      now,
    );
  } else {
    const existing = await first<{ id: string; status: string }>(
      env.DB,
      'SELECT id, status FROM members WHERE channel_id = ?1 AND email = ?2',
      channel.id,
      address,
    );
    if (!existing) return readerPage(c, 'Try again', '<h1>Something went wrong</h1>', 409);
    memberId = existing.id;
    if (recipient && (existing.status === 'pending' || existing.status === 'unsubscribed')) {
      // The link was mailed to this address: claiming it is their own consent.
      await run(
        env.DB,
        `UPDATE members SET status = 'active', consent_at = ?1, confirmed_at = COALESCE(confirmed_at, ?1),
           unsubscribed_at = NULL, updated_at = ?1 WHERE id = ?2`,
        now,
        memberId,
      );
      await recordMemberEvent(
        env.DB,
        { type: 'confirmed', memberId, payload: { method: 'gift' } },
        now,
      );
    }
  }

  // A refund or dispute that lands after the claim above but before this batch ends the pass while
  // it has no member yet, so the grant is only written while the pass is still claimed.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status,
         current_period_end, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'gift', 'active', ?5, ?6, ?6
        WHERE EXISTS (SELECT 1 FROM gift_passes WHERE id = ?7 AND status = 'claimed')`,
    ).bind(
      newId('memberSubscription', now),
      channel.id,
      memberId,
      claimed.level_id,
      addMonths(now, claimed.months),
      now,
      claimed.id,
    ),
    env.DB.prepare('UPDATE gift_passes SET claimed_member_id = ?1 WHERE id = ?2').bind(
      memberId,
      claimed.id,
    ),
  ]);
  await recomputeEntitlement(env.DB, channel.id, memberId, now);

  c.header('cache-control', 'no-store');
  if (created && !recipient) {
    later(
      c,
      sendConfirmation(
        {
          db: env.DB,
          mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
          links: linksFor(env),
          captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
          platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
        },
        { memberId, kind: 'subscribe' },
      ),
    );
    return readerPage(
      c,
      'Check your email',
      `<h1>Check your email</h1><p>${h(months(claimed.months))} of a paid subscription are on ${h(address)}. We sent a link to that address: confirm it, then sign in with it to start reading.</p><p><a href="/_swarm/reader/signin">Sign in</a></p>`,
    );
  }
  return readerPage(
    c,
    'Gift claimed',
    `<h1>Your gift is claimed</h1><p>${h(months(claimed.months))} of paid subscription are on ${h(address)}. Sign in with that address to start reading.</p><p><a href="/_swarm/reader/signin">Sign in</a></p>`,
  );
});

gifts.post('/_swarm/gift-article', async (c) => {
  if (crossSite(c) || scriptedRequest(c)) return refused(c);
  const env = c.get('env');
  const channel = c.get('channel');
  const reader = c.get('reader');
  if (!(await siteFlags(c)).gift_articles) return c.notFound();
  if (!reader.memberId) {
    return readerPage(
      c,
      'Sign in first',
      '<h1>Sign in first</h1><p>Subscribers can share paywalled posts once they are signed in.</p><p><a href="/_swarm/reader/signin">Sign in</a></p>',
      403,
    );
  }
  if (!(await underPaymentLimit(c, 'gift-article'))) return tooMany(c);
  const form = await c.req.parseBody();
  const dispatchId = field(form, 'dispatchId', 40);
  const dispatch = /^dp_[0-9a-f]{32}$/.test(dispatchId)
    ? await first<{ id: string; web_visibility: 'public' | 'members' | 'paid'; slug: string }>(
        env.DB,
        `SELECT d.id, d.web_visibility, s.slug FROM dispatches d
           JOIN dispatch_slugs s ON s.dispatch_id = d.id AND s.channel_id = d.channel_id AND s.is_current = 1
          WHERE d.id = ?1 AND d.channel_id = ?2 AND d.web_published_at IS NOT NULL
            AND d.web_visibility IN ('members', 'paid')`,
        dispatchId,
        channel.id,
      )
    : null;
  if (!dispatch) {
    return readerPage(c, 'Not found', '<h1>This post cannot be shared</h1>', 404);
  }
  const { gate } = await gateConfig(env, channel.id, dispatch.id);
  if (!gateAdmits(dispatch.web_visibility, reader, gate.levelIds)) {
    return readerPage(
      c,
      'Not included',
      '<h1>Your subscription does not include this post</h1><p>You can share posts you can read.</p>',
      403,
    );
  }

  const now = Date.now();
  const period = monthPeriod(now);
  const { token, hash } = await newGiftToken();
  // The cap is checked in the same statement as the insert.
  const inserted = await env.DB.prepare(
    `INSERT INTO gift_article_links (token_hash, channel_id, member_id, dispatch_id, period, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE (SELECT COUNT(*) FROM gift_article_links
              WHERE member_id = ?3 AND channel_id = ?2 AND period = ?5) < ?8`,
  )
    .bind(
      hash,
      channel.id,
      reader.memberId,
      dispatch.id,
      period,
      now,
      now + GIFT_ARTICLE_TTL_MS,
      GIFT_ARTICLE_MAX_PER_PERIOD,
    )
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    return readerPage(
      c,
      'Limit reached',
      `<h1>You have shared ${GIFT_ARTICLE_MAX_PER_PERIOD} Posts this month</h1><p>You can gift more next month.</p>`,
      429,
    );
  }
  const link = new URL(dispatchPath(dispatch.slug), channel.origin);
  link.searchParams.set('gift', token);
  // The page holding the link is cut off from whatever page opened it, so script there can't
  // read the link out of this window.
  c.header('cross-origin-opener-policy', 'same-origin');
  c.header('cache-control', 'no-store');
  return readerPage(
    c,
    'Gift link',
    `<h1>Your gift link</h1><p>Anyone with this link can read this post in full for 30 days, up to ${GIFT_ARTICLE_MAX_READS} times, while your subscription includes it. Send it to one person.</p>
<p><input type="text" readonly value="${h(link.toString())}" aria-label="Gift link"></p>
<p class="small">Links this month: up to ${GIFT_ARTICLE_MAX_PER_PERIOD}.</p>
<form method="post" action="/_swarm/gift-article/revoke"><input type="hidden" name="dispatchId" value="${h(dispatch.id)}"><button type="submit" class="sw-ghost">Stop my gift links to this post</button></form>
<p><a href="${h(dispatchPath(dispatch.slug))}">Back to the post</a></p>`,
  );
});

gifts.post('/_swarm/gift-article/revoke', async (c) => {
  if (crossSite(c) || scriptedRequest(c)) return refused(c);
  const env = c.get('env');
  const channel = c.get('channel');
  const reader = c.get('reader');
  if (!(await siteFlags(c)).gift_articles) return c.notFound();
  if (!reader.memberId) {
    return readerPage(
      c,
      'Sign in first',
      '<h1>Sign in first</h1><p>Sign in to stop the gift links you shared.</p><p><a href="/_swarm/reader/signin">Sign in</a></p>',
      403,
    );
  }
  const form = await c.req.parseBody();
  const dispatchId = field(form, 'dispatchId', 40);
  if (!/^dp_[0-9a-f]{32}$/.test(dispatchId)) {
    return readerPage(c, 'Not found', '<h1>This post cannot be found</h1>', 404);
  }
  const stopped = await revokeGiftArticleLinks(env.DB, {
    channelId: channel.id,
    dispatchId,
    memberId: reader.memberId,
  });
  c.header('cache-control', 'no-store');
  return readerPage(
    c,
    'Gift links stopped',
    `<h1>${stopped ? 'Your gift links to this post no longer work' : 'You have no working gift links to this post'}</h1><p>Anyone who opens one now sees the post as a visitor would.</p>`,
  );
});
