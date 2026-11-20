// The Member side of the Privacy Center (Phase 7): "Download my data" and "Delete my data" in the
// Member Center, the download page the export email links to, and the page the erasure
// confirmation email links to.
//
// Both requests are POSTs from the Member Center page and cover the address across the whole
// workspace. The Member Center link is in every email footer, so whoever holds a forwarded email
// can open it: an export is harmless (its link is mailed to the address), but an erasure is not.
// Deleting therefore takes a confirmation page with a checkbox, and then a single-use link mailed
// to the address (/m/erase/<token>, DSR_CONFIRM_LINK_HOURS); only the POST from that link's page
// queues it. Refused while a paid membership still renews. An address Swarm can't mail can't
// confirm: its erasure waits for an admin, unless it comes from a link emailed on request within
// the hour. The jobs worker runs requests within minutes (@swarm/engine privacy.ts). The export
// link (/m/data/<token>, DSR_EXPORT_LINK_DAYS) only shows a page; its POST sends the file, so link
// scanners never fetch it.
//
// /privacy/<channelId> is the publication's public request page, for anyone, subscriber or not (a
// buyer, a gift purchaser or recipient, a sponsor contact, someone whose subscriber row was
// deleted). It answers the same whatever is held, and only mails the address a single-use link
// (/privacy/confirm/<token>); the POST from that link's page files the request. Rate-limited per
// IP and per address. The Member Center and the website footer link to it.
import {
  DSR_CONFIRM_LINK_HOURS,
  DSR_DUE_HOURS,
  DSR_EXPORT_LINK_DAYS,
  EmailSchema,
  idPattern,
} from '@swarm/domain';
import {
  addressRequestOpen,
  confirmAddressRequest,
  confirmErasure,
  eraseConfirmationOpen,
  exportDownload,
  linksFor,
  loadMemberCenter,
  readAddressRequestToken,
  readEraseConfirmationToken,
  readExportLinkToken,
  requestFromMemberCenter,
  startAddressRequest,
  startEraseConfirmation,
  type CenterView,
} from '@swarm/engine';
import type { Hono } from 'hono';
import { first } from '@swarm/db';
import { audienceDeps, clientIp, env, later, type AppContext, type AppEnv } from '../context';
import { addressPrivacy, erasurePrivacy, memberPrivacy } from '../vault';
import { originOf } from '../env';
import { hashKey, rateLimit } from '../guard';
import { h, maskEmail, page, safeAccent, slowDown } from '../pages';

export const PRIVACY_NOTICES: Record<string, string> = {
  export_data: 'We are gathering your data. A download link will arrive by email within 24 hours.',
  export_review:
    'Your request is waiting for review. A download link will arrive by email once it is approved.',
};

const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The "Your data" part of the Member Center. Bounced addresses can't receive the export link. */
export function privacyHtml(
  view: CenterView,
  action: (name: string, inner: string) => string,
): string {
  const canMail = view.member.status !== 'bounced' && view.member.status !== 'complained';
  return `<h2>Your data</h2>
<p class="muted">Get a copy of everything ${h(view.channel.name)} holds about you, or have it deleted.${
    canMail
      ? ''
      : ` Our emails are not reaching this address, so to get a copy, ask ${h(view.channel.name)} directly.`
  }</p>
<div class="row">${
    canMail
      ? action(
          'export_data',
          '<button type="submit" class="ghost">Email me a copy of my data</button>',
        )
      : ''
  }${action('erase_confirm', '<button type="submit" class="ghost">Delete my data</button>')}</div>
<p class="muted">Bought something, gave or got a gift, or booked a sponsorship with another address? <a href="/privacy/${h(view.channel.id)}">Ask about that address</a>.</p>`;
}

/** How an erasure can go from this page. */
interface EraseRoute {
  /** The address can get the confirmation email. */
  reachable: boolean;
  /** The page was opened from a link emailed on request within the hour (shows the address). */
  proven: boolean;
}

/**
 * The confirmation step: deleting is permanent. An address mail can't reach gets no confirmation
 * email, and the publisher checks the request first, whatever link opened the page.
 */
function eraseConfirmPage(
  view: CenterView,
  token: string,
  erase: EraseRoute,
  error: string | null = null,
) {
  // A footer link shows the address masked, as the Member Center does.
  const email = erase.proven ? view.member.email : maskEmail(view.member.email);
  const reviewed = !erase.reachable
    ? `<p>${h(view.channel.name)} checks this request before anything is deleted, since emails can’t reach this address to confirm it’s yours.</p>`
    : '';
  return page(
    'Delete your data',
    `<p class="channel">${h(view.channel.name)}</p><h1>Delete your data</h1>
${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}
<p>This deletes ${h(email)} and everything held with it: your details, your history of emails, opens and clicks, your answers and your referrals. It covers ${h(view.channel.name)} and any other newsletter run by the same publisher.</p>
<p>It can’t be undone. You won’t receive anything from them again, and this address can’t be signed up again.</p>${
      erase.reachable
        ? `
<p>To make sure it is really you, we will email ${h(email)} a link to confirm. Nothing is deleted until you use it.</p>`
        : reviewed
    }
<form method="post"><input type="hidden" name="action" value="erase">
<label class="choice"><input type="checkbox" name="confirm" value="yes" required> I understand this can’t be undone</label>
<div class="row"><button type="submit" class="danger">${erase.reachable ? 'Email me the link to confirm' : 'Delete my data'}</button></div></form>
<p><a href="/m/${h(encodeURIComponent(token))}">Keep my data</a></p>`,
    { accent: view.channel.accent, status: error ? 400 : 200 },
  );
}

/**
 * One privacy action from the Member Center POST, or null when `action` isn't one. The caller
 * has already checked the token, the origin and the rate limit, and sets `review` when an
 * erasure must wait for an admin to approve it.
 */
export async function privacyAction(
  c: AppContext,
  view: CenterView,
  action: string | undefined,
  body: Record<string, unknown>,
  token: string,
  unavailable: (message: string, status: number) => Response,
  erase: EraseRoute = { reachable: true, proven: false },
): Promise<Response | null> {
  const e = env(c);
  switch (action) {
    case 'export_data': {
      if (view.member.status === 'bounced' || view.member.status === 'complained') {
        return unavailable('That change is not available right now.', 409);
      }
      const result = await requestFromMemberCenter(
        e.DB,
        memberPrivacy(e, token),
        view.member.id,
        'export',
      );
      if (result.outcome === 'unavailable') {
        return unavailable('That change is not available right now.', 409);
      }
      // A second click while one is on its way says the same thing. One an admin filed and has
      // not approved yet still waits for them.
      const saved = result.status === 'pending' ? 'export_review' : 'export_data';
      return new Response(null, {
        status: 303,
        headers: {
          location: `/m/${encodeURIComponent(token)}?saved=${saved}`,
          'cache-control': 'no-store',
        },
      });
    }
    case 'erase_confirm':
      return eraseConfirmPage(view, token, erase);
    case 'erase': {
      if (body.confirm !== 'yes') {
        return eraseConfirmPage(view, token, erase, 'Tick the box to confirm.');
      }
      // An email to the address confirms; nothing is queued from this page. An address no email
      // reaches is filed instead, always for an admin to review: nothing a link carries proves who
      // holds it (whoever holds the member signing key could forge one emailed a moment ago).
      const outcome = await startEraseConfirmation(
        { ...audienceDeps(e), fieldKeys: memberPrivacy(e, token) },
        view.member.id,
        Date.now(),
      );
      if (outcome === 'paid') return unavailable(PAID_FIRST, 409);
      if (outcome === 'unavailable') {
        return unavailable('That change is not available right now.', 409);
      }
      // No redirect back: the Member Center link stops working once the data is gone.
      if (outcome === 'open') return beingDeleted(view.channel.name, view.channel.accent);
      // Only a running request is "being deleted"; anything else still waits for an admin.
      if (outcome === 'review') return reviewPage(view, erase.reachable);
      return page(
        'Check your inbox',
        `<p class="channel">${h(view.channel.name)}</p><h1>Check your inbox</h1>
<p>We sent an email to ${h(maskEmail(view.member.email))}. Use the link in it to confirm that you want your data deleted.</p>
<p>Nothing is deleted until you do. The link works once, for ${DSR_CONFIRM_LINK_HOURS} hours.</p>
<p><a href="/m/${h(encodeURIComponent(token))}">Back to your settings</a></p>`,
        { accent: view.channel.accent },
      );
    }
    default:
      return null;
  }
}

const PAID_FIRST =
  'Cancel your paid subscription first (it can end with the period you paid for). Then you can delete your data.';

/** An erasure an admin has to approve first. */
const reviewPage = (view: CenterView, reachable: boolean) =>
  page(
    'Your request is waiting for review',
    `<p class="channel">${h(view.channel.name)}</p><h1>Your request is waiting for review</h1>
<p>${reachable ? '' : `Our emails are not reaching ${h(maskEmail(view.member.email))}, so we can’t send you a link to confirm. `}${h(view.channel.name)} will check the request before anything is deleted, within ${DSR_DUE_HOURS.erase / 24} days.</p>`,
    { accent: view.channel.accent },
  );

/** No link back: the Member Center link stops working once the data is gone. */
const beingDeleted = (channelName: string, accent: string) =>
  page(
    'Your data is being deleted',
    `<p class="channel">${h(channelName)}</p><h1>Your data is being deleted</h1>
<p>Everything held about this address is deleted within the next few minutes. You won’t hear from ${h(channelName)} again.</p>
<p class="muted">Links in emails from ${h(channelName)} stop working once it is done.</p>`,
    { accent },
  );

const confirmExpired = () =>
  page(
    'This link does not work',
    `<h1>This link does not work</h1><p>Confirmation links work once, for ${DSR_CONFIRM_LINK_HOURS} hours. To delete your data, ask again from your subscriber settings.</p>`,
    { status: 404 },
  );

const expired = () =>
  page(
    'This link does not work',
    `<h1>This link does not work</h1><p>Download links work for ${DSR_EXPORT_LINK_DAYS} days. Ask for a new copy from your subscriber settings.</p>`,
    { status: 404 },
  );

/** POSTs must come from the page itself. */
const sameOrigin = (c: AppContext) => {
  const origin = c.req.header('origin');
  return !origin || origin === originOf(env(c));
};

/** The publication a request page is for: its name and accent, while it isn't deleted. */
async function requestChannel(c: AppContext, channelId: string) {
  if (!idPattern('channel').test(channelId)) return null;
  const row = await first<{ id: string; name: string; branding_json: string }>(
    env(c).DB,
    'SELECT id, name, branding_json FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if (!row) return null;
  const accent = (JSON.parse(row.branding_json) as { accentColor?: unknown }).accentColor;
  return {
    id: row.id,
    name: row.name,
    accent: safeAccent(typeof accent === 'string' ? accent : null),
  };
}

const requestMissing = () =>
  page(
    'This page does not exist',
    '<h1>This page does not exist</h1><p>The publication may have been taken down.</p>',
    { status: 404 },
  );

function requestFormPage(
  channel: { id: string; name: string; accent: string },
  error: string | null = null,
) {
  return page(
    'Your data',
    `<p class="channel">${h(channel.name)}</p><h1>Ask about your data</h1>
${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}
<p>Anyone can ask ${h(channel.name)} for a copy of the data it holds about their email address, or to delete it, whether or not they are a subscriber: for example after buying something, giving or getting a gift, or booking a sponsorship.</p>
<p>We will email the address a link to confirm that it is yours. Nothing happens until you use it.</p>
<form method="post">
<label>Email address <input type="email" name="email" autocomplete="email" required maxlength="254"></label>
<fieldset><legend>What would you like?</legend>
<label class="choice"><input type="radio" name="kind" value="export" required checked> A copy of my data</label>
<label class="choice"><input type="radio" name="kind" value="erase"> My data to be deleted</label>
</fieldset>
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="row"><button type="submit">Email me a link to confirm</button></div></form>
<p class="muted">Subscribers can also do this from the subscriber settings link in any email.</p>`,
    { accent: channel.accent, status: error ? 400 : 200 },
  );
}

/** The same answer whatever is held, sent or not. */
const requestSent = (channel: { name: string; accent: string }, email: string) =>
  page(
    'Check your inbox',
    `<p class="channel">${h(channel.name)}</p><h1>Check your inbox</h1>
<p>If ${h(maskEmail(email))} can receive our emails, a link to confirm your request is on its way. Nothing happens until you use it. The link works once, for ${DSR_CONFIRM_LINK_HOURS} hours.</p>
<p class="muted">No email? Check your spam folder, or contact ${h(channel.name)} directly.</p>`,
    { accent: channel.accent },
  );

const requestLinkExpired = () =>
  page(
    'This link does not work',
    `<h1>This link does not work</h1><p>Confirmation links work once, for ${DSR_CONFIRM_LINK_HOURS} hours. Ask again from the publication’s request page.</p>`,
    { status: 404 },
  );

export function privacyRoutes(app: Hono<AppEnv>): void {
  // The public request page: an address and what to do with its data.
  app.get('/privacy/:channelId', async (c) => {
    const channel = await requestChannel(c, c.req.param('channelId'));
    return channel ? requestFormPage(channel) : requestMissing();
  });

  app.post('/privacy/:channelId', async (c) => {
    const e = env(c);
    const channel = await requestChannel(c, c.req.param('channelId'));
    if (!channel || !sameOrigin(c)) return requestMissing();
    const body = await c.req.parseBody();
    const parsed = EmailSchema.safeParse(typeof body.email === 'string' ? body.email : '');
    const kind = body.kind === 'erase' ? 'erase' : body.kind === 'export' ? 'export' : null;
    const wait = await rateLimit(e, [
      [clientIp(c), 'rightsIp'],
      ...(parsed.success
        ? [[await hashKey(parsed.data.toLowerCase()), 'rightsEmail'] as [string, 'rightsEmail']]
        : []),
    ]);
    if (wait) return slowDown(wait);
    if (!parsed.success) return requestFormPage(channel, 'Enter a valid email address.');
    if (!kind) return requestFormPage(channel, 'Choose what you would like.');
    // A filled honeypot gets the ordinary answer and nothing else.
    if (typeof body.website === 'string' && body.website.trim()) {
      return requestSent(channel, parsed.data);
    }
    // After the answer, so how long it takes says nothing about what is held.
    later(
      c,
      startAddressRequest(
        { ...audienceDeps(e), fieldKeys: addressPrivacy(e) },
        { channelId: channel.id, email: parsed.data, kind },
      ),
    );
    return requestSent(channel, parsed.data);
  });

  // The link mailed by the request page: a page with a button; nothing changes on GET.
  app.get('/privacy/confirm/:token', async (c) => {
    const e = env(c);
    const link = await readAddressRequestToken(linksFor(e), c.req.param('token'));
    const open = link ? await addressRequestOpen(e.DB, link) : null;
    const channel = open ? await requestChannel(c, open.channelId) : null;
    if (!open || !channel) return requestLinkExpired();
    const erase = open.kind === 'erase';
    return page(
      erase ? 'Delete your data' : 'Get a copy of your data',
      `<p class="channel">${h(channel.name)}</p><h1>${erase ? 'Delete your data' : 'Get a copy of your data'}</h1>
<p>${
        erase
          ? `This deletes everything ${h(channel.name)} and any other newsletter run by the same publisher hold about this address. It can’t be undone, and the address can’t be signed up again.`
          : `We will email this address a link to download a copy of everything ${h(channel.name)} and any other newsletter run by the same publisher hold about it.`
      }</p>
<form method="post"><div class="row"><button type="submit"${erase ? ' class="danger"' : ''}>${erase ? 'Delete my data' : 'Send me a copy'}</button></div></form>
<p class="muted">Changed your mind? Close this page and nothing happens.</p>`,
      { accent: channel.accent },
    );
  });

  app.post('/privacy/confirm/:token', async (c) => {
    const e = env(c);
    const link = await readAddressRequestToken(linksFor(e), c.req.param('token'));
    if (!link || !sameOrigin(c)) return requestLinkExpired();
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const open = await addressRequestOpen(e.DB, link);
    const channel = open ? await requestChannel(c, open.channelId) : null;
    if (!open || !channel) return requestLinkExpired();
    const outcome = await confirmAddressRequest(e.DB, addressPrivacy(e), link);
    if (outcome === 'expired') return requestLinkExpired();
    if (outcome === 'paid') {
      return page(
        'Cancel your paid subscription first',
        `<p class="channel">${h(channel.name)}</p><h1>Cancel your paid subscription first</h1>
<p>${h(PAID_FIRST)}</p>`,
        { accent: channel.accent, status: 409 },
      );
    }
    const erase = open.kind === 'erase';
    return page(
      'Your request was received',
      `<p class="channel">${h(channel.name)}</p><h1>Your request was received</h1>
<p>${
        outcome === 'review'
          ? `A request like this is already waiting for ${h(channel.name)} to review it.`
          : erase
            ? `Everything held about this address is deleted within the next few minutes, if there is any. You won’t hear from ${h(channel.name)} again.`
            : `A link to download your data will arrive by email within ${DSR_DUE_HOURS.export} hours.`
      }</p>`,
      { accent: channel.accent },
    );
  });

  // The erasure confirmation link: a page with a button; nothing changes on GET.
  app.get('/m/erase/:token', async (c) => {
    const e = env(c);
    const link = await readEraseConfirmationToken(linksFor(e), c.req.param('token'));
    if (!link || !(await eraseConfirmationOpen(e.DB, link))) return confirmExpired();
    const view = await loadMemberCenter(e.DB, undefined, link.memberId);
    if (!view) return confirmExpired();
    return page(
      'Delete your data',
      `<p class="channel">${h(view.channel.name)}</p><h1>Delete your data</h1>
<p>This deletes ${h(view.member.email)} and everything held with it, for ${h(view.channel.name)} and any other newsletter run by the same publisher.</p>
<p>It can’t be undone. You won’t receive anything from them again, and this address can’t be signed up again.</p>
<form method="post"><div class="row"><button type="submit" class="danger">Delete my data</button></div></form>
<p class="muted">Changed your mind? Close this page and nothing happens.</p>`,
      { accent: view.channel.accent },
    );
  });

  app.post('/m/erase/:token', async (c) => {
    const e = env(c);
    const link = await readEraseConfirmationToken(linksFor(e), c.req.param('token'));
    if (!link || !sameOrigin(c)) return confirmExpired();
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const view = await loadMemberCenter(e.DB, undefined, link.memberId);
    if (!view) return confirmExpired();
    const outcome = await confirmErasure(e.DB, erasurePrivacy(e, link), link);
    if (outcome === 'expired') return confirmExpired();
    if (outcome === 'paid') {
      return page(
        'Cancel your paid subscription first',
        `<p class="channel">${h(view.channel.name)}</p><h1>Cancel your paid subscription first</h1>
<p>${h(PAID_FIRST)}</p>`,
        { accent: view.channel.accent, status: 409 },
      );
    }
    if (outcome === 'review') return reviewPage(view, true);
    return beingDeleted(view.channel.name, view.channel.accent);
  });

  app.get('/m/data/:token', async (c) => {
    const e = env(c);
    const link = await readExportLinkToken(linksFor(e), c.req.param('token'));
    const download = link
      ? await exportDownload(e.DB, link.requestId, Date.now(), link.workspaceId)
      : null;
    if (!download) return expired();
    return page(
      'Your data',
      `${download.channelName ? `<p class="channel">${h(download.channelName)}</p>` : ''}<h1>Your data is ready</h1>
<p>One JSON file with everything held about you, as of ${h(dateOf(download.createdAt))}.</p>
<form method="post"><button type="submit">Download my data</button></form>
<p class="muted">The link works until ${h(dateOf(download.expiresAt))}.</p>`,
      { accent: download.accent },
    );
  });

  app.post('/m/data/:token', async (c) => {
    const e = env(c);
    const link = await readExportLinkToken(linksFor(e), c.req.param('token'));
    if (!link || !sameOrigin(c)) return expired();
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const download = await exportDownload(e.DB, link.requestId, Date.now(), link.workspaceId);
    const object = download ? await e.EXPORTS.get(download.key) : null;
    if (!download || !object) return expired();
    const day = new Date(download.createdAt).toISOString().slice(0, 10);
    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="my-data-${day}.json"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
