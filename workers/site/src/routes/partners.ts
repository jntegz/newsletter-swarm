// Partner Exchange and Sponsor Match on the publication's website (docs/partner-exchange.md,
// docs/sponsor-match.md):
//
//   GET  /partners                  publications this one recommends (flag partner_exchange)
//   GET  /_swarm/partner/:id        counts the click, then leads to the partner
//   GET  /sponsor                   what's on offer, and a form to book it (flag sponsor_match)
//   POST /_swarm/sponsor            takes a request, which waits for the publisher to accept it
//   GET  /_swarm/sponsored/:id      counts the click, then leads to the sponsor
//   GET  /_swarm/sponsor/report/:t  the sponsor's own numbers, behind a signed link
//
// Targets are read from the server, so these can't be used as open redirects, and clicks are plain
// counters with no visitor identifiers.
import {
  EmailSchema,
  PARTNERS_PATH,
  SPONSOR_PATH,
  SponsorRequestSchema,
  idPattern,
  newId,
  partnerClickPath,
} from '@swarm/domain';
import { all, first, run } from '@swarm/db';
import {
  TURNSTILE_SCRIPT,
  channelAdminEmails,
  mailAdapter,
  partnerPicksFor,
  linksFor,
  readSponsorReport,
} from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { isBotRequest } from '../edge/analytics';
import { formatMoney } from '../money/amounts';
import {
  crossSite,
  field,
  refused,
  tooMany,
  turnstilePassed,
  underPaymentLimit,
} from '../money/guard';
import { later } from '../readers/later';
import { h, readerPage } from '../readers/pages';
import { siteFlags } from '../render/data';
import { loadChrome, renderPage, sendPage } from '../render/layout';

export const partners = new Hono<SiteBindings>();

/** A person's real click, not a HEAD, a prefetch or a known bot. */
function isPersonClick(c: SiteContext): boolean {
  const userAgent = c.req.header('user-agent');
  const purpose = c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '';
  return (
    c.req.method === 'GET' &&
    !/prefetch|prerender/i.test(purpose) &&
    !!userAgent &&
    !isBotRequest(userAgent, c.req.raw.cf as Parameters<typeof isBotRequest>[1])
  );
}

/** The partner list for the homepage and /partners. Empty when there's nothing to show. */
export async function partnerPicksHtml(c: SiteContext, limit?: number): Promise<string> {
  const picks = await partnerPicksFor(c.get('env').DB, c.get('channel').id, 'site', limit);
  if (!picks.length) return '';
  return `<ul class="sw-partners">${picks
    .map(
      (pick) =>
        `<li><a href="${h(partnerClickPath(pick.id, 'site'))}" rel="nofollow"><strong>${h(pick.name)}</strong></a>${pick.description ? `<br><span class="sw-muted">${h(pick.description)}</span>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

partners.get(PARTNERS_PATH, async (c) => {
  if (!(await siteFlags(c)).partner_exchange) return c.notFound();
  const channel = c.get('channel');
  const [chrome, list] = await Promise.all([loadChrome(c), partnerPicksHtml(c, 24)]);
  return sendPage(
    c,
    renderPage(c, chrome, {
      meta: {
        title: 'Publications we recommend',
        description: `Publications ${channel.name} recommends.`,
        path: PARTNERS_PATH,
      },
      body: `<article class="sw-page"><h1>Publications we recommend</h1>${list || '<p>Nothing here yet.</p>'}</article>`,
    }),
  );
});

partners.get('/_swarm/partner/:id', async (c) => {
  if (!(await siteFlags(c)).partner_exchange) return c.notFound();
  const id = c.req.param('id');
  if (!idPattern('partnerPick').test(id)) return c.notFound();
  const channel = c.get('channel');
  const env = c.get('env');
  const pick = await first<{ url: string }>(
    env.DB,
    'SELECT url FROM partner_picks WHERE id = ?1 AND channel_id = ?2',
    id,
    channel.id,
  );
  if (!pick) return c.notFound();
  const from = c.req.query('from') === 'signup' ? 'signup' : 'site';
  if (isPersonClick(c)) {
    const column = from === 'signup' ? 'signup_clicks' : 'site_clicks';
    later(
      c,
      run(env.DB, `UPDATE partner_picks SET ${column} = ${column} + 1 WHERE id = ?1`, id).then(
        () => undefined,
      ),
    );
  }
  // So the partner can see what came from here, without any tracking of the person.
  const target = new URL(pick.url);
  if (!target.searchParams.has('utm_source')) {
    target.searchParams.set('utm_source', channel.slug);
    target.searchParams.set('utm_medium', 'partner_exchange');
  }
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  c.header('referrer-policy', 'no-referrer');
  return c.redirect(target.href, 302);
});

// ---- Sponsors -------------------------------------------------------------------------------

async function sponsorPage(c: SiteContext) {
  return first<{ accepting: number; headline: string; pitch: string }>(
    c.get('env').DB,
    'SELECT accepting, headline, pitch FROM sponsor_settings WHERE channel_id = ?1 AND accepting = 1',
    c.get('channel').id,
  );
}

partners.get(SPONSOR_PATH, async (c) => {
  if (!(await siteFlags(c)).sponsor_match) return c.notFound();
  const settings = await sponsorPage(c);
  if (!settings) return c.notFound();
  const env = c.get('env');
  const channel = c.get('channel');
  const [chrome, slots] = await Promise.all([
    loadChrome(c),
    all<{ id: string; name: string; description: string; amount: number; currency: string }>(
      env.DB,
      `SELECT id, name, description, amount, currency FROM sponsor_slots
        WHERE channel_id = ?1 AND archived_at IS NULL ORDER BY position`,
      channel.id,
    ),
  ]);
  const options = slots
    .map(
      (slot, i) =>
        `<label><input type="radio" name="slotId" value="${h(slot.id)}"${i === 0 ? ' checked' : ''}> <strong>${h(slot.name)}</strong>${slot.amount ? `: ${h(formatMoney(slot.amount, slot.currency))}` : ''}${slot.description ? `<br><span class="sw-muted">${h(slot.description)}</span>` : ''}</label>`,
    )
    .join('');
  return sendPage(
    c,
    renderPage(c, chrome, {
      meta: {
        title: settings.headline || 'Sponsor us',
        description: `Sponsor ${channel.name}.`,
        path: SPONSOR_PATH,
      },
      subscribe: false,
      body: `<article class="sw-page"><h1>${h(settings.headline || `Sponsor ${channel.name}`)}</h1>
${settings.pitch ? `<p>${h(settings.pitch)}</p>` : ''}
<form class="sw-plan-form" method="post" action="/_swarm/sponsor">
<fieldset><legend>Placement</legend>${options}</fieldset>
<label>Date you'd like it to run <input type="date" name="runOn" required></label>
<label>Your company <input type="text" name="sponsorName" maxlength="120" required></label>
<label>Your email <input type="email" name="sponsorEmail" maxlength="254" autocomplete="email" required></label>
<label>Ad headline <input type="text" name="adTitle" maxlength="120" required></label>
<label>Ad text <textarea name="adBody" maxlength="280"></textarea></label>
<label>Where it should lead <input type="url" name="adUrl" maxlength="2048" placeholder="https://" required></label>
<div class="cf-turnstile" data-sitekey="${h(env.TURNSTILE_SITE_KEY)}" data-action="sponsor"></div>
<p class="sw-muted">Nothing is charged here. ${h(channel.name)} reviews your request and arranges payment with you directly.</p>
<button type="submit">Send request</button>
</form></article><script src="${TURNSTILE_SCRIPT}" async defer></script>`,
    }),
    { cache: 'private' },
  );
});

partners.post('/_swarm/sponsor', async (c) => {
  if (crossSite(c)) return refused(c);
  if (!(await siteFlags(c)).sponsor_match || !(await sponsorPage(c))) return c.notFound();
  if (!(await underPaymentLimit(c, 'sponsor'))) return tooMany(c);
  const form = await c.req.parseBody();
  if (!(await turnstilePassed(c, form, 'sponsor'))) {
    return readerPage(
      c,
      'Please try again',
      '<h1>Please try again</h1><p>We could not confirm you are a person. Go back, wait for the check to finish, and send the form again.</p>',
      403,
    );
  }
  const env = c.get('env');
  const channel = c.get('channel');
  const back = `<p><a href="${SPONSOR_PATH}">Back</a></p>`;
  const parsed = SponsorRequestSchema.safeParse({
    slotId: field(form, 'slotId', 40),
    runOn: field(form, 'runOn', 10),
    sponsorName: field(form, 'sponsorName', 120),
    sponsorEmail: field(form, 'sponsorEmail', 254),
    adTitle: field(form, 'adTitle', 120),
    adBody: field(form, 'adBody', 280),
    adUrl: field(form, 'adUrl', 2048),
  });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Check the form.';
    return readerPage(
      c,
      'Check the form',
      `<h1>Check the form</h1><p>${h(message)}</p>${back}`,
      400,
    );
  }
  const input = parsed.data;
  const now = Date.now();
  if (input.runOn <= new Date(now).toISOString().slice(0, 10)) {
    return readerPage(
      c,
      'Choose a later date',
      `<h1>Choose a later date</h1><p>Pick a day after today.</p>${back}`,
      400,
    );
  }
  const slot = await first<{ name: string }>(
    env.DB,
    'SELECT name FROM sponsor_slots WHERE id = ?1 AND channel_id = ?2 AND archived_at IS NULL',
    input.slotId,
    channel.id,
  );
  if (!slot) return c.notFound();
  const taken = await first(
    env.DB,
    `SELECT 1 FROM sponsor_bookings WHERE slot_id = ?1 AND run_on = ?2 AND status = 'accepted'`,
    input.slotId,
    input.runOn,
  );
  if (taken) {
    return readerPage(
      c,
      'That date is taken',
      `<h1>That date is taken</h1><p>Another sponsor has this placement on ${h(input.runOn)}. Try a different day.</p>${back}`,
      409,
    );
  }
  await run(
    env.DB,
    `INSERT INTO sponsor_bookings (id, channel_id, slot_id, run_on, sponsor_name, sponsor_email, ad_title, ad_body, ad_url, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    newId('sponsorBooking', now),
    channel.id,
    input.slotId,
    input.runOn,
    input.sponsorName,
    EmailSchema.parse(input.sponsorEmail),
    input.adTitle,
    input.adBody,
    input.adUrl,
    now,
  );
  later(c, notifyAdmins(c, slot.name, input.sponsorName, input.runOn));
  return readerPage(
    c,
    'Request sent',
    `<h1>Request sent</h1><p>${h(channel.name)} will get back to you at ${h(input.sponsorEmail)}. Nothing has been charged.</p>`,
  );
});

/** A note to the publication's owners and admins. A failure here doesn't lose the request. */
async function notifyAdmins(c: SiteContext, slot: string, sponsor: string, runOn: string) {
  const env = c.get('env');
  const channel = c.get('channel');
  const to = await channelAdminEmails(env.DB, channel.id);
  const adapter = mailAdapter(env, env.PLATFORM_MAIL_DOMAIN);
  const text = `${sponsor} would like to sponsor ${channel.name}: ${slot}, on ${runOn}. Review it in the dashboard under Sponsors.`;
  await Promise.all(
    to.map((address) =>
      adapter
        .send({
          category: 'sponsor_request',
          from: { name: channel.name, address: `notifications@${env.PLATFORM_MAIL_DOMAIN}` },
          to: address,
          subject: `Sponsor request for ${channel.name}`,
          html: `<p>${h(text)}</p>`,
          text,
          tags: { channel: channel.id, kind: 'sponsor_request' },
        })
        .catch(() => undefined),
    ),
  );
}

partners.get('/_swarm/sponsored/:id', async (c) => {
  if (!(await siteFlags(c)).sponsor_match) return c.notFound();
  const id = c.req.param('id');
  if (!idPattern('sponsorBooking').test(id)) return c.notFound();
  const env = c.get('env');
  const booking = await first<{ ad_url: string }>(
    env.DB,
    `SELECT ad_url FROM sponsor_bookings WHERE id = ?1 AND channel_id = ?2 AND status = 'accepted'`,
    id,
    c.get('channel').id,
  );
  if (!booking) return c.redirect('/', 302);
  if (isPersonClick(c)) {
    later(
      c,
      run(env.DB, 'UPDATE sponsor_bookings SET clicks = clicks + 1 WHERE id = ?1', id).then(
        () => undefined,
      ),
    );
  }
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  c.header('referrer-policy', 'no-referrer');
  return c.redirect(new URL(booking.ad_url).href, 302);
});

partners.get('/_swarm/sponsor/report/:token', async (c) => {
  if (!(await siteFlags(c)).sponsor_match) return c.notFound();
  const env = c.get('env');
  const id = await readSponsorReport(linksFor(env), c.req.param('token'), c.get('channel').id);
  const row = id
    ? await first<{
        ad_title: string;
        run_on: string;
        clicks: number;
        status: string;
        name: string;
      }>(
        env.DB,
        `SELECT b.ad_title, b.run_on, b.clicks, b.status, s.name
           FROM sponsor_bookings b JOIN sponsor_slots s ON s.id = b.slot_id
          WHERE b.id = ?1 AND b.channel_id = ?2`,
        id,
        c.get('channel').id,
      )
    : null;
  if (!row) return c.notFound();
  return readerPage(
    c,
    'Your sponsorship',
    `<h1>${h(row.ad_title)}</h1><p>${h(row.name)}, ${h(row.run_on)}</p><p><strong>${row.clicks}</strong> ${row.clicks === 1 ? 'click' : 'clicks'} by people so far. Link scanners and bots aren’t counted.</p>`,
  );
});
