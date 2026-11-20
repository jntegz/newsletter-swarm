// The Member Center: /m/<token> (a "member" token, 30 days) and /m to ask for a fresh link.
//
// GET shows the page; POST performs one action (profile, digest, Rosters, pause, resume,
// unsubscribe, rejoin, tracking, emails off and on) and redirects back with a notice. A paying Member also sees their Membership level and,
// for a Stripe subscription, can cancel at period end or keep it, change level after a proration
// preview, update the payment method in Stripe's Billing Portal, and open their invoices. The
// subscription acted on is always the token's Member's own (memberBilling), never one a form names. Link requests at /m answer the same way whether or not
// the address is on any list, and are rate limited per IP and per address. "Your data" asks for a
// copy of everything held about the address or its deletion (routes/privacy.ts), which is confirmed
// from the inbox.
//
// Two kinds of link open this page. The footer link in every email travels with forwarded mail,
// mail-gateway logs and shared inboxes, so it shows a summary only (a masked address, the plan and
// its renewal, no profile values, no invoices) and allows only low-harm actions: pause, resume,
// Rosters, digest, unsubscribe, emails off and on, rejoin, cancel at period end and keep the
// subscription. Anything
// that shows personal or billing detail or can't be taken back (STEP_UP_ACTIONS) needs a link
// emailed on request and opened within the hour; with a footer link those actions email one
// instead. A billing, profile, unsubscribe or tracking change made from either link is mailed to
// the address with a way back (sendMemberChangeNotice), and a Member can turn off every older
// link (members.member_links_after).
import { EmailSchema, idPattern } from '@swarm/domain';
import {
  championLinks,
  championProgress,
  championSettings,
  channelSiteOrigin,
  ensureChampionCode,
  applyLevelChange,
  BillingError,
  billingPortalUrl,
  findChoice,
  formatMoney,
  listInvoices,
  memberBilling,
  previewLevelChange,
  setCancelAtPeriodEnd,
  StripeError,
  cancelPayPalSubscription,
  PayPalError,
  stripeThroughVault,
  usableProrationDate,
  FieldValueError,
  keepAfterSunsetNotice,
  loadMemberCenter,
  memberCenterRosters,
  pauseMember,
  linksFor,
  readMemberSession,
  requestRejoin,
  resumeMember,
  saveMemberCenterRosters,
  sendMemberCenterLinks,
  setMemberDigest,
  setMemberEmails,
  setMemberTracking,
  unsubscribeMember,
  updateMemberProfile,
  endOlderMemberLinks,
  sendMemberChangeNotice,
  PAUSE_WEEKS,
  type MemberChange,
  type CenterField,
  type CenterRoster,
  type CenterView,
  type InvoiceSummary,
  type LevelChangePreview,
  type LevelChoice,
  type MemberBilling,
  type PauseWeeks,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { Hono } from 'hono';
import {
  audienceDeps,
  channelFlag,
  clientIp,
  env,
  later,
  refreshCirclesOf,
  type AppContext,
  type AppEnv,
} from '../context';
import {
  evidenceLinks,
  memberCenterFields,
  memberCenterSealer,
  memberPayPal,
  memberStripeFetch,
} from '../vault';
import { originOf } from '../env';
import { hashKey, newChallenge, rateLimit, readChallenge, verifyTurnstile } from '../guard';
import { brokenLink, h, maskEmail, page, slowDown } from '../pages';
import { PRIVACY_NOTICES, privacyAction, privacyHtml } from './privacy';

const NOTICES: Record<string, string> = {
  profile: 'Your details are saved.',
  digest: 'Your choice is saved.',
  pause: 'Paused. You will hear from us again when the pause ends.',
  resume: 'Welcome back. Emails start again with the next post.',
  unsubscribe: 'You are unsubscribed.',
  rejoin: 'Check your inbox: confirm the email we sent to rejoin.',
  stay: 'Thanks. You stay subscribed.',
  cancel_membership: 'Your paid subscription will end when the period you paid for ends.',
  cancel_paypal: 'Your paid subscription will end when the period you paid for ends.',
  keep_membership: 'Your paid subscription continues.',
  change_level: 'Your plan is changed.',
  champion_link: 'Your share link is ready.',
  rosters: 'Your Rosters are saved.',
  tracking: 'Your choice is saved.',
  emails_off: 'Emails are off. Your subscription stays as it is.',
  emails_on: 'Emails are on again. You will receive the next post.',
  end_links: 'Older links to this page no longer work.',
  ...PRIVACY_NOTICES,
};

const log = createLogger({ service: 'capture' });

/** Stripe's Billing Portal, where the payment method button lands. */
const PORTAL_ORIGINS = ['https://billing.stripe.com'];

const DIGESTS = [
  ['every', 'Every post'],
  ['weekly', 'A weekly digest'],
  ['monthly', 'A monthly digest'],
] as const;

const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Shown in place of encrypted profile fields when the vault couldn't open them just now. */
const FIELDS_UNAVAILABLE =
  'Some of your details can’t be shown right now. They are kept safe; try again in a few minutes.';

function fieldInput(field: CenterField): string {
  const name = `f.${field.key}`;
  const label = h(field.label);
  const v = field.value;
  switch (field.type) {
    case 'number':
      return `<label>${label}<input type="number" step="any" name="${h(name)}" value="${typeof v === 'number' ? v : ''}"></label>`;
    case 'date':
      return `<label>${label}<input type="date" name="${h(name)}" value="${typeof v === 'string' ? h(v) : ''}"></label>`;
    case 'boolean':
      return `<input type="hidden" name="${h(name)}" value="no"><label class="choice"><input type="checkbox" name="${h(name)}" value="yes"${v === true ? ' checked' : ''}> ${label}</label>`;
    case 'select':
      return `<label>${label}<select name="${h(name)}"><option value="">Not set</option>${field.options
        .map((o) => `<option${o === v ? ' selected' : ''}>${h(o)}</option>`)
        .join('')}</select></label>`;
    case 'multi_select': {
      const chosen = Array.isArray(v) ? v : [];
      return `<fieldset><legend>${label}</legend><input type="hidden" name="${h(name)}" value="">${field.options
        .map(
          (o) =>
            `<label class="choice"><input type="checkbox" name="${h(name)}" value="${h(o)}"${chosen.includes(o) ? ' checked' : ''}> ${h(o)}</label>`,
        )
        .join('')}</fieldset>`;
    }
    default:
      return `<label>${label}<input type="text" name="${h(name)}" value="${typeof v === 'string' ? h(v) : ''}" maxlength="2000"></label>`;
  }
}

interface BillingSection {
  billing: MemberBilling;
  /** Null when Stripe could not be reached. */
  invoices: InvoiceSummary[] | null;
  /** False when payments are off for this deployment: details only, no actions. */
  actions: boolean;
}

const priceOf = (amount: number | null, currency: string | null, interval: string | null) =>
  amount === null || !currency
    ? null
    : `${formatMoney(amount, currency)}${interval === 'month' ? ' a month' : interval === 'year' ? ' a year' : ''}`;

const choiceLabel = (choice: LevelChoice) =>
  `${choice.levelName}, ${priceOf(choice.amount, choice.currency, choice.interval)}`;

function billingHtml(
  section: BillingSection,
  action: (name: string, inner: string) => string,
  full: boolean,
) {
  const { subscription: s, manageable, choices } = section.billing;
  const name = s.levelName ?? 'Paid subscription';
  const price = s.source === 'stripe' ? priceOf(s.amount, s.currency, s.interval) : null;
  const lines: string[] = [];
  if (s.source === 'lifetime') lines.push('Lifetime access. It never ends.');
  else if (s.source === 'comp' || s.source === 'gift') {
    const from = s.source === 'gift' ? 'A gift' : 'Complimentary access';
    lines.push(
      s.currentPeriodEnd
        ? `${from}, until ${dateOf(s.currentPeriodEnd)}.`
        : `${from}, with no end date.`,
    );
  } else if (s.status === 'past_due' || s.status === 'unpaid') {
    lines.push('Your last payment didn’t go through. Update your payment method to keep access.');
  } else if (s.cancelAtPeriodEnd) {
    const end = s.cancelAt ?? s.currentPeriodEnd;
    lines.push(
      end
        ? `Canceled. You keep access until ${dateOf(end)}.`
        : 'Canceled. You keep access until the end of the period you paid for.',
    );
  } else {
    if (s.status === 'trialing' && s.trialEnd) {
      lines.push(`Free trial until ${dateOf(s.trialEnd)}.`);
    }
    if (s.currentPeriodEnd) lines.push(`Renews on ${dateOf(s.currentPeriodEnd)}.`);
  }
  let html = `<h2>Your paid subscription</h2><p><strong>${h(name)}</strong>${price ? ` · ${h(price)}` : ''}</p>
${lines.map((line) => `<p class="muted">${h(line)}</p>`).join('')}`;
  // PayPal: billing stops at once when canceled, so there's nothing to take back afterwards.
  if (s.paypalSubscriptionId && !s.cancelAtPeriodEnd && s.status !== 'canceled') {
    html += `<div class="row">${action(
      'cancel_paypal',
      '<button type="submit" class="ghost">Cancel my PayPal subscription</button>',
    )}</div>`;
  }
  if (!manageable || !section.actions) return html;

  const live = s.status !== 'past_due' && s.status !== 'unpaid';
  const buttons: string[] = [];
  if (live) {
    buttons.push(
      s.cancelAtPeriodEnd
        ? action('keep_membership', '<button type="submit">Keep my subscription</button>')
        : action(
            'cancel_membership',
            '<button type="submit" class="ghost">Cancel at the end of the period</button>',
          ),
    );
  }
  buttons.push(
    action('payment_method', '<button type="submit" class="ghost">Update payment method</button>'),
  );
  html += `<div class="row">${buttons.join('')}</div>`;
  if (live && !s.cancelAtPeriodEnd && choices.length) {
    html += `<h2>Change plan</h2>${action(
      'preview_level',
      `<label>Move to<select name="price">${choices
        .map((c) => `<option value="${h(c.priceId)}">${h(choiceLabel(c))}</option>`)
        .join('')}</select></label>
<button type="submit" class="ghost">See what it costs</button>`,
    )}`;
  }
  html += '<h2>Invoices</h2>';
  if (!full) {
    // Invoices show the billing name, address and card: only on a link that was just emailed.
    html += `<p class="muted">To see your invoices, open a link we email you.</p>${action(
      'invoices',
      '<button type="submit" class="ghost">Email me a link</button>',
    )}`;
  } else if (section.invoices === null) {
    html += '<p class="muted">Invoices can’t be loaded right now. Try again later.</p>';
  } else if (section.invoices.length === 0) {
    html += '<p class="muted">No invoices yet.</p>';
  } else {
    html += `<ul class="plain">${section.invoices
      .map(
        (invoice) =>
          `<li><span>${h(dateOf(invoice.createdAt))} · ${h(formatMoney(invoice.amount, invoice.currency))} · ${h(invoice.status)}</span>${
            invoice.url ? `<a href="${h(invoice.url)}" rel="noopener noreferrer">View</a>` : ''
          }</li>`,
      )
      .join('')}</ul>`;
  }
  return html;
}

/** The Champions part of the page: the share link and progress to the next milestone. */
interface ChampionSection {
  links: { shareUrl: string; shortUrl: string } | null;
  shareText: string | null;
  counted: number;
  pending: number;
  next: { name: string; referralsRequired: number; remaining: number } | null;
}

function championHtml(section: ChampionSection, action: (name: string, inner: string) => string) {
  let html = '<h2>Share and earn rewards</h2>';
  if (!section.links) {
    return `${html}<p>Invite friends to join. When they confirm and read, they count toward your rewards.</p>${action(
      'champion_link',
      '<button type="submit" class="ghost">Get my share link</button>',
    )}`;
  }
  if (section.shareText) html += `<p>${h(section.shareText)}</p>`;
  html += `<label>Your share link<input type="text" readonly value="${h(section.links.shortUrl)}"></label>`;
  const counted = `${section.counted} referral${section.counted === 1 ? '' : 's'} counted`;
  const pending = section.pending ? `, ${section.pending} waiting to confirm and read` : '';
  html += `<p>${h(counted + pending)}.</p>`;
  if (section.next) {
    const percent = Math.min(
      100,
      Math.round((section.counted / section.next.referralsRequired) * 100),
    );
    html += `<p>${h(`${section.next.remaining} more to reach ${section.next.name}.`)}</p>
<progress max="${section.next.referralsRequired}" value="${Math.min(section.counted, section.next.referralsRequired)}" aria-label="Progress to ${h(section.next.name)}">${percent}%</progress>`;
  }
  return html;
}

/** Null unless Champions is on for the Channel and the Member is on the list. */
async function championSection(c: AppContext, view: CenterView): Promise<ChampionSection | null> {
  if (view.member.status !== 'active' && view.member.status !== 'paused') return null;
  const e = env(c);
  const settings = await championSettings(e.DB, view.channel.id);
  if (settings.enabled !== 1) return null;
  const row = await e.DB.prepare('SELECT champion_code FROM members WHERE id = ?1')
    .bind(view.member.id)
    .first<{ champion_code: string | null }>();
  const progress = await championProgress(e.DB, view.channel.id, view.member.id);
  let links: ChampionSection['links'] = null;
  if (row?.champion_code) {
    const site = await channelSiteOrigin(
      e.DB,
      { scheme: e.SITE_SCHEME, platformDomain: e.PLATFORM_SITE_DOMAIN },
      view.channel.id,
    );
    links = championLinks(site.origin, row.champion_code);
  }
  return {
    links,
    shareText: settings.share_text,
    counted: progress.counted,
    pending: progress.pending,
    next: progress.nextMilestone,
  };
}

/**
 * "Don't track my opens and clicks" (docs/privacy-controls.md). The hidden field comes first, so an
 * unticked box still says what was chosen.
 */
function trackingHtml(view: CenterView, action: (name: string, inner: string) => string) {
  const { member, channel } = view;
  const tracks = channel.tracks.opens || channel.tracks.clicks;
  const what = member.trackingOff
    ? 'Your emails have no tracking image, and links go straight to where they point. We deleted the opens and clicks we had recorded for you.'
    : tracks
      ? `When you open an email from ${channel.name} or click a link in it, we can see that it was you. It shows what readers read and can be used to pick a time to send to you.`
      : `${channel.name} does not track opens or clicks right now. Your choice applies if that changes.`;
  return `<h2>Tracking</h2><p>${h(what)}</p>${action(
    'tracking',
    `<input type="hidden" name="tracking" value="on"><label class="choice"><input type="checkbox" name="tracking" value="off"${member.trackingOff ? ' checked' : ''}> Don’t track my opens and clicks</label>
<p class="muted">We still see whether an email was delivered or bounced, and your unsubscribe link keeps working.</p>
<button type="submit" class="ghost">Save</button>`,
  )}`;
}

/** "Turn off older links": every link to this page issued before the one in use stops working. */
/**
 * "Stop emails, keep my membership" (security review S03-P5-G-paid-mail-choice): one click, since
 * it only reduces mail. Unlike unsubscribing, the subscription stays: website access, sign-in and
 * any paid subscription are unchanged, and receipts, sign-in links and billing notices still come.
 */
function emailsHtml(view: CenterView, action: (name: string, inner: string) => string) {
  const { member } = view;
  if (member.emailsOff) {
    return `<h2>Emails</h2><p>You stay subscribed, and any paid subscription continues. We still email you receipts, sign-in links and notices about your subscription.</p>
${action('emails_on', '<button type="submit">Turn emails back on</button>')}`;
  }
  if (member.status !== 'active' && member.status !== 'paused') return '';
  return `<h2>Stop emails, keep my membership</h2><p>No more posts or automation emails, and you stay subscribed: you can still sign in and read on the website, and any paid subscription continues. Receipts, sign-in links and notices about your subscription still come. Turn emails back on here any time.</p>
${action('emails_off', '<button type="submit" class="ghost">Stop emails, keep my membership</button>')}`;
}

function linksHtml(full: boolean, action: (name: string, inner: string) => string) {
  return `<h2>Links to this page</h2><p class="muted">Every email you get has a link to this page. If someone else may have one, for example from an email you forwarded, you can turn off all older links. ${
    full ? 'This link keeps working.' : 'We will email you a fresh link to do it.'
  }</p>${action('end_links', '<button type="submit" class="ghost">Turn off older links</button>')}`;
}

/** Rosters (Phase 8, flag rosters): a checkbox per Roster the Member Center lists. */
function rostersHtml(rosters: CenterRoster[], action: (name: string, inner: string) => string) {
  if (!rosters.length) return '';
  return `<h2>Your Rosters</h2>${action(
    'rosters',
    `<fieldset><legend>Choose what you receive</legend>${rosters
      .map(
        (r) =>
          `<label class="choice"><input type="checkbox" name="roster" value="${h(r.id)}"${r.subscribed ? ' checked' : ''}> ${h(r.name)}</label>${
            r.description ? `<p class="muted">${h(r.description)}</p>` : ''
          }`,
      )
      .join('')}</fieldset><button type="submit" class="ghost">Save</button>`,
  )}`;
}

/**
 * The page. `full` is true only for a link emailed on request in the last hour: then profile
 * values, the whole address and invoices show. Otherwise (a footer link) the page is a summary.
 */
function centerPage(
  view: CenterView,
  notice: string | null,
  error: string | null,
  status = 200,
  billing: BillingSection | null = null,
  champion: ChampionSection | null = null,
  rosters: CenterRoster[] = [],
  digestChoice = false,
  full = false,
) {
  const { member, channel } = view;
  const email = full ? member.email : maskEmail(member.email);
  const head = `<p class="channel">${h(channel.name)}</p><h1>Subscriber settings</h1>
${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ''}${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}`;
  const action = (name: string, inner: string) =>
    `<form method="post"><input type="hidden" name="action" value="${name}">${inner}</form>`;
  // Paying and receiving emails are separate: an unsubscribed Member can still manage a membership.
  const membership = billing ? billingHtml(billing, action, full) : '';
  const options = {
    accent: channel.accent,
    status,
    ...(billing ? { formTargets: PORTAL_ORIGINS } : {}),
  };

  if (member.status === 'bounced' || member.status === 'complained') {
    return page(
      'Subscriber settings',
      `${head}<p>Emails from ${h(channel.name)} can’t be delivered to ${h(email)}, so nothing is sent to it.</p>
${privacyHtml(view, action)}`,
      { accent: channel.accent, status },
    );
  }
  if (member.status === 'unsubscribed') {
    // Removed by the inactive-reader rule: say so, so they know why and that coming back is easy.
    const why = member.sunsetReason
      ? `<p>This happened automatically because we saw no opens or clicks from you for a long time. Your mail app may have hidden them. Join again if you still want these emails.</p>`
      : '';
    return page(
      'Subscriber settings',
      `${head}<p>${h(email)} is unsubscribed from ${h(channel.name)}.</p>${why}
${action('rejoin', '<button type="submit">Join again</button>')}
<p>We will email you a link to confirm.</p>${membership}
${privacyHtml(view, action)}`,
      options,
    );
  }

  const state = member.emailsOff
    ? `Emails are off: ${channel.name} sends no posts or automation emails to ${email}.`
    : member.status === 'paused' && member.pausedUntil
      ? `Paused until ${dateOf(member.pausedUntil)}.`
      : member.status === 'pending'
        ? 'Confirm your email from the message we sent to start receiving emails.'
        : `You receive ${channel.name} at ${email}.`;
  // Names and profile values (decrypted ones too) only on a link that was just emailed. Encrypted
  // values the vault couldn't open just now are left out with a note, not shown (or saved) empty.
  const shownFields = view.fieldsUnavailable
    ? view.fields.filter((f) => !f.encrypted)
    : view.fields;
  const profile = full
    ? `${view.fieldsUnavailable ? `<p class="notice" role="status">${FIELDS_UNAVAILABLE}</p>` : ''}${action(
        'profile',
        `<label>First name<input type="text" name="firstName" value="${h(member.firstName ?? '')}" maxlength="80" autocomplete="given-name"></label>
<label>Last name<input type="text" name="lastName" value="${h(member.lastName ?? '')}" maxlength="80" autocomplete="family-name"></label>
${shownFields.map(fieldInput).join('\n')}
<button type="submit">Save details</button>`,
      )}`
    : `<p class="muted">To see or change your details, open a link we email you.</p>${action(
        'profile',
        '<button type="submit" class="ghost">Email me a link</button>',
      )}`;
  // The digest choice shows only with the digest flag on: nothing sends digests yet.
  const digest = digestChoice
    ? action(
        'digest',
        `<fieldset><legend>How often</legend>${DIGESTS.map(
          ([value, label]) =>
            `<label class="choice"><input type="radio" name="digest" value="${value}"${member.digest === value ? ' checked' : ''}> ${label}</label>`,
        ).join('')}</fieldset><button type="submit" class="ghost">Save</button>`,
      )
    : '';
  const pause =
    member.status === 'paused'
      ? action('resume', '<button type="submit" class="ghost">Resume now</button>')
      : member.status === 'active'
        ? `<div class="row">${PAUSE_WEEKS.map((w) =>
            action(
              'pause',
              `<input type="hidden" name="weeks" value="${w}"><button type="submit" class="ghost">${w} weeks</button>`,
            ),
          ).join('')}</div>`
        : '';
  // Told they will be unsubscribed as an inactive reader: one click keeps them.
  const stay = member.sunsetNoticeAt
    ? `<div class="notice" role="status"><p>We haven’t seen you open or click an email for a long time, so you will be unsubscribed soon. Your mail app may hide that you read them.</p>
${action('stay', '<button type="submit">Keep me subscribed</button>')}</div>`
    : '';
  return page(
    'Subscriber settings',
    `${head}${stay}<p>${h(state)}</p>
${membership}
${champion ? championHtml(champion, action) : ''}
<h2>Your details</h2>${profile}
${digest ? `<h2>How often you hear from us</h2>${digest}` : ''}
${rostersHtml(rosters, action)}
${trackingHtml(view, action)}
${emailsHtml(view, action)}
${pause && !member.emailsOff ? `<h2>Take a break</h2>${pause}` : ''}
${linksHtml(full, action)}
<h2>Unsubscribe</h2>${action(
      'unsubscribe',
      `<label>Why are you leaving? (optional)<textarea name="reason" rows="3" maxlength="500"></textarea></label>
<button type="submit" class="ghost">Unsubscribe</button>`,
    )}${billing?.billing.manageable ? '<p class="muted">Unsubscribing stops emails only; it doesn’t cancel your paid subscription.</p>' : ''}
${privacyHtml(view, action)}`,
    options,
  );
}

/** The confirmation step of a level change, with Stripe's proration preview. */
function previewPage(
  view: CenterView,
  billing: MemberBilling,
  choice: LevelChoice,
  preview: LevelChangePreview,
  token: string,
) {
  const s = billing.subscription;
  const current = priceOf(s.amount, s.currency, s.interval);
  const from = `${s.levelName ?? 'Paid subscription'}${current ? `, ${current}` : ''}`;
  return page(
    'Change plan',
    `<p class="channel">${h(view.channel.name)}</p><h1>Change your plan</h1>
<p>From <strong>${h(from)}</strong> to <strong>${h(choiceLabel(choice))}</strong>.</p>
<p>Your next invoice comes to <strong>${h(formatMoney(preview.amountDue, preview.currency))}</strong>${
      preview.nextPaymentAt ? `, on ${h(dateOf(preview.nextPaymentAt))}` : ''
    }. It includes credit for the time left on your current plan.</p>
<form method="post"><input type="hidden" name="action" value="change_level"><input type="hidden" name="price" value="${h(choice.priceId)}"><input type="hidden" name="proration" value="${preview.prorationDate}">
<div class="row"><button type="submit">Confirm the change</button></div></form>
<p><a href="/m/${h(encodeURIComponent(token))}">Keep my current plan</a></p>`,
    { accent: view.channel.accent },
  );
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Profile field values from the form: `f.<key>`; checkboxes post a hidden blank first. */
function profileFields(body: Record<string, unknown>, view: CenterView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of view.fields) {
    const raw = body[`f.${field.key}`];
    if (raw === undefined) continue;
    const list = (Array.isArray(raw) ? raw : [raw]).filter(
      (v): v is string => typeof v === 'string',
    );
    if (field.type === 'multi_select') out[field.key] = list.filter(Boolean);
    else if (field.type === 'boolean') out[field.key] = list.includes('yes');
    else out[field.key] = list.at(-1) ?? null;
  }
  return out;
}

/** The digest flag for the Member's Channel. */
const digestOn = (c: AppContext, view: CenterView) =>
  channelFlag(
    env(c),
    { workspaceId: view.channel.workspaceId, channelId: view.channel.id },
    'digest',
  );

const LINK_CHALLENGE = 'member-link';

/** Asks for an address, with the same checks as a sign-up form: Turnstile, or a question. */
async function linkRequestPage(c: AppContext, hidden: string, failed = false): Promise<Response> {
  const e = env(c);
  const challenge = await newChallenge(e, LINK_CHALLENGE, null, null);
  const fields = `${hidden}<label>Email<input type="email" name="email" required autocomplete="email"></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>`;
  return page(
    'Subscriber settings',
    `<h1>Subscriber settings</h1>${failed ? '<p class="error">We could not check that you are a person. Try again.</p>' : ''}<p>Enter your email and we will send you a link to manage your subscription.</p>
<noscript><style>#with-script{display:none}</style></noscript>
<form id="with-script" method="post" action="/m">${fields}
<div class="cf-turnstile" data-sitekey="${h(e.TURNSTILE_SITE_KEY)}" data-action="subscribe" data-cdata="${LINK_CHALLENGE}"></div>
<button type="submit">Email me a link</button></form>
<noscript><form method="post" action="/m">${fields}
<input type="hidden" name="_challenge" value="${h(challenge.token)}">
<label>${h(challenge.question)} Answer in digits.<input type="text" name="answer" inputmode="numeric" autocomplete="off" required maxlength="4"></label>
<button type="submit">Email me a link</button></form></noscript>`,
    { status: failed ? 403 : 200, turnstile: true },
  );
}

/** POSTs must come from the page itself; a token is the only other proof, and links leak. */
function sameOrigin(c: AppContext): boolean {
  const origin = c.req.header('origin');
  return !origin || origin === originOf(env(c));
}

export function memberRoutes(app: Hono<AppEnv>): void {
  app.get('/m', (c) => {
    const channel = c.req.query('channel');
    const hidden =
      channel && idPattern('channel').test(channel)
        ? `<input type="hidden" name="channel" value="${channel}">`
        : '';
    return linkRequestPage(c, hidden);
  });

  app.post('/m', async (c) => {
    const e = env(c);
    if (!sameOrigin(c)) return brokenLink();
    const body = await c.req.parseBody();
    const parsed = EmailSchema.safeParse(str(body.email) ?? '');
    const channel = str(body.channel);
    const hidden =
      channel && idPattern('channel').test(channel)
        ? `<input type="hidden" name="channel" value="${channel}">`
        : '';
    const wait = await rateLimit(e, [
      [clientIp(c), 'linkIp'],
      ...(parsed.success
        ? [[await hashKey(parsed.data), 'linkEmail'] as [string, 'linkEmail']]
        : []),
    ]);
    if (wait) return slowDown(wait);
    if (!parsed.success) {
      return page(
        'Subscriber settings',
        '<h1>Subscriber settings</h1><p class="error">Enter a valid email address.</p>',
        {
          status: 400,
        },
      );
    }
    const sent = () =>
      page(
        'Check your inbox',
        '<h1>Check your inbox</h1><p>If that address is on a list, a link to its subscriber settings is on the way. It works for 30 days.</p>',
      );
    // A filled honeypot gets the ordinary answer and nothing else.
    if (str(body.website)?.trim()) return sent();
    const challenge = str(body._challenge);
    const read = challenge ? await readChallenge(e, LINK_CHALLENGE, challenge) : null;
    const answer = str(body.answer);
    const passed =
      (await read?.solved(answer ?? null)) ||
      (await verifyTurnstile(
        e,
        str(body['cf-turnstile-response']),
        c.req.header('cf-connecting-ip'),
        LINK_CHALLENGE,
      ));
    if (!passed) return linkRequestPage(c, hidden, true);
    const channelId = channel && idPattern('channel').test(channel) ? channel : null;
    // The vault mints the links from the address itself (rate-limited there per address).
    later(
      c,
      sendMemberCenterLinks(
        audienceDeps(e, evidenceLinks(e, { kind: 'link-request', channelId, email: parsed.data })),
        parsed.data,
        channelId,
      ),
    );
    return sent();
  });

  // Where Stripe's Billing Portal sends the Member back. It carries no token: a return address
  // is handed to Stripe, and a Member Center link must never leave this service.
  app.get('/m/back', () =>
    page(
      'Payment details',
      `<h1>You are back from the payment page</h1><p>Changes you made there take effect straight away.</p>
<p>To see your subscriber settings again, open the link in your email, or <a href="/m">get a new link</a>.</p>`,
    ),
  );

  app.get('/m/:token', async (c) => {
    const e = env(c);
    const session = await readMemberSession(linksFor(e), c.req.param('token'));
    if (!session) return expiredOrBroken();
    // Encrypted fields come from the vault, for this link's own Member.
    const view = await loadMemberCenter(
      e.DB,
      await memberCenterFields(e, c.req.param('token')),
      session.memberId,
    );
    if (!view || !ownChannel(view, session)) return brokenLink();
    if (linkEnded(view, session)) return expiredOrBroken();
    // Own keys only: `?saved=constructor` must not reach Object.prototype.
    const saved = c.req.query('saved') ?? '';
    const full = steppedUp(session);
    return centerPage(
      view,
      Object.hasOwn(NOTICES, saved) ? (NOTICES[saved] ?? null) : null,
      null,
      200,
      await billingSection(c, view, full),
      await championSection(c, view),
      await rostersSection(c, view),
      await digestOn(c, view),
      full,
    );
  });

  app.post('/m/:token', async (c) => {
    const e = env(c);
    const token = c.req.param('token');
    const session = await readMemberSession(linksFor(e), token);
    if (!session || !sameOrigin(c)) return expiredOrBroken();
    const { memberId } = session;
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const view = await loadMemberCenter(e.DB, await memberCenterFields(e, token), memberId);
    if (!view || !ownChannel(view, session)) return brokenLink();
    if (linkEnded(view, session)) return expiredOrBroken();
    const full = steppedUp(session);
    const body = await c.req.parseBody({ all: true });
    const action = str(body.action);
    if (action && needsFreshLink(action, body, view) && !full) {
      // Never skipped: an address mail can't reach gets nothing here.
      if (!unreachable(view)) return emailFreshLink(c, view, action);
      return centerPage(view, null, 'That change is not available right now.', 409);
    }
    if (action === 'end_links') {
      // Every link issued before this one stops working; this one (just emailed) keeps working.
      await endOlderMemberLinks(e.DB, memberId, session.issuedAt);
      notifyChange(c, view, 'end_links');
      return new Response(null, {
        status: 303,
        headers: {
          location: `/m/${encodeURIComponent(token)}?saved=end_links`,
          'cache-control': 'no-store',
        },
      });
    }
    if (action && BILLING_ACTIONS.has(action)) {
      return billingAction(c, view, action, body, token, full);
    }
    // Privacy Center (Phase 7): download or delete my data.
    const privacy = await privacyAction(
      c,
      view,
      action,
      body,
      token,
      (message, status) => centerPage(view, null, message, status, null, null, [], false, full),
      // Deleting has its own proof: a single-use link emailed to the address. No email reaches a
      // bounced or complained address, and nothing on the page can stand in for one (whoever holds
      // the link sees the page too, and a link can be forged with the member signing key), so an
      // admin always approves it.
      { reachable: !unreachable(view), proven: steppedUp(session) },
    );
    if (privacy) return privacy;
    let done = false;
    switch (action) {
      case 'profile':
        try {
          await updateMemberProfile(e.DB, memberCenterSealer(e, token), memberId, {
            firstName: str(body.firstName) ?? null,
            lastName: str(body.lastName) ?? null,
            fields: profileFields(body, view),
          });
          done = true;
          notifyChange(c, view, 'profile');
        } catch (error) {
          if (!(error instanceof FieldValueError)) throw error;
          const label = view.fields.find((f) => f.key === error.key)?.label ?? error.key;
          return centerPage(
            view,
            null,
            `${label}: ${error.message}`,
            400,
            null,
            null,
            [],
            false,
            full,
          );
        }
        break;
      case 'digest': {
        // Refused with the flag off, so a hand-made POST can't store a choice nothing honours.
        const digest = str(body.digest);
        if (
          (digest === 'every' || digest === 'weekly' || digest === 'monthly') &&
          (await digestOn(c, view))
        ) {
          done = await setMemberDigest(e.DB, memberId, digest);
        }
        break;
      }
      case 'pause': {
        const weeks = Number(str(body.weeks));
        if ((PAUSE_WEEKS as readonly number[]).includes(weeks)) {
          done = await pauseMember(e.DB, memberId, weeks as PauseWeeks);
        }
        break;
      }
      case 'resume':
        done = await resumeMember(e.DB, memberId);
        break;
      case 'unsubscribe':
        done = await unsubscribeMember(e.DB, memberId, str(body.reason) ?? null);
        if (done) notifyChange(c, view, 'unsubscribe');
        break;
      case 'emails_off':
      case 'emails_on':
        done = await setMemberEmails(e.DB, memberId, action === 'emails_on');
        if (done) notifyChange(c, view, action);
        break;
      case 'champion_link':
        // Assigning the code is the only change; GET never assigns one (link scanners).
        done =
          (view.member.status === 'active' || view.member.status === 'paused') &&
          (await championSettings(e.DB, view.channel.id)).enabled === 1 &&
          (await ensureChampionCode(e.DB, view.channel.id, memberId)) !== null;
        break;
      case 'rosters': {
        // Only the Rosters the page lists change; anything else posted is ignored.
        const raw = body.roster;
        const ticked = (Array.isArray(raw) ? raw : [raw]).filter(
          (v): v is string => typeof v === 'string',
        );
        done =
          ROSTER_STATUSES.has(view.member.status) &&
          (await saveMemberCenterRosters(e.DB, view.channel.id, memberId, ticked));
        break;
      }
      case 'tracking': {
        // A choice about this Member only; posted as ["on"] or ["on", "off"].
        const raw = body.tracking;
        const values = (Array.isArray(raw) ? raw : [raw]).filter(
          (v): v is string => typeof v === 'string',
        );
        if (values.length) {
          done = await setMemberTracking(e.DB, memberId, !values.includes('off'));
          if (done && values.includes('off') !== view.member.trackingOff) {
            notifyChange(c, view, values.includes('off') ? 'tracking_off' : 'tracking_on');
          }
        }
        break;
      }
      case 'invoices':
        // From a link just emailed, the page already shows them: back to it, nothing changed.
        return new Response(null, {
          status: 303,
          headers: { location: `/m/${encodeURIComponent(token)}`, 'cache-control': 'no-store' },
        });
      case 'stay':
        done = await keepAfterSunsetNotice(e.DB, memberId);
        break;
      case 'rejoin':
        done = view.member.status === 'unsubscribed';
        if (done) later(c, requestRejoin(audienceDeps(e), memberId));
        break;
    }
    if (!done) {
      return centerPage(
        view,
        null,
        'That change is not available right now.',
        409,
        null,
        null,
        [],
        false,
        full,
      );
    }
    refreshCirclesOf(c, memberId);
    return new Response(null, {
      status: 303,
      headers: {
        location: `/m/${encodeURIComponent(token)}?saved=${action}`,
        'cache-control': 'no-store',
      },
    });
  });
}

/**
 * Actions a footer link can't take. The 30-day link in every email's footer travels with
 * forwarded mail, so anything that charges the card (a level change), opens the payment portal,
 * can't be taken back (a PayPal cancellation, deleting tracking history), changes or shows the
 * profile, shows invoices or turns off links needs a link emailed on request, opened within
 * STEP_UP_MS. Deleting data has its own emailed confirmation (routes/privacy.ts). Pausing,
 * Rosters, the digest, unsubscribing (rejoin undoes it), canceling at period end and keeping the
 * subscription stay one click.
 */
const STEP_UP_ACTIONS = new Set([
  'preview_level',
  'change_level',
  'payment_method',
  'cancel_paypal',
  'profile',
  'invoices',
  'end_links',
]);
const STEP_UP_MS = 60 * 60 * 1000;

/** Whether this POST needs a freshly emailed link. Turning tracking off deletes its history. */
function needsFreshLink(action: string, body: Record<string, unknown>, view: CenterView): boolean {
  if (STEP_UP_ACTIONS.has(action)) return true;
  if (action === 'tracking') {
    const raw = body.tracking;
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (v): v is string => typeof v === 'string',
    );
    return values.includes('off') && !view.member.trackingOff;
  }
  return false;
}

function steppedUp(session: { issuedAt: number; emailed: boolean }): boolean {
  return session.emailed && Date.now() - session.issuedAt < STEP_UP_MS;
}

/**
 * Whether a link names the Member's own Channel. A link from before the cutover names none, so the
 * Member's row decides alone; a newer one must match it (security review S04-X-TR).
 */
const ownChannel = (view: CenterView, session: { channelId: string | null }) =>
  session.channelId === null || session.channelId === view.channel.id;

/** A link issued before the Member turned older links off. */
const linkEnded = (view: CenterView, session: { issuedAt: number }) =>
  view.member.linksAfter !== null && session.issuedAt < view.member.linksAfter;

/** Mails the address about a change made through its link, after the response. */
function notifyChange(c: AppContext, view: CenterView, change: MemberChange): void {
  later(
    c,
    (async () => {
      // A bounded number per address: a link holder repeating changes can't flood the inbox.
      if (await rateLimit(env(c), [[await hashKey(view.member.id), 'changeNotice']])) return;
      // A fresh emailed link, minted by the vault from the link this change was made with.
      const token = c.req.param('token') ?? '';
      await sendMemberChangeNotice(
        audienceDeps(env(c), evidenceLinks(env(c), { kind: 'step-up', token })),
        view.member.id,
        change,
      );
    })(),
  );
}

/** Why a fresh link is needed, in the words of the "check your inbox" page. */
const FRESH_LINK_REASONS: Record<string, string> = {
  preview_level: 'Changing your plan',
  change_level: 'Changing your plan',
  payment_method: 'Changing your payment method',
  cancel_paypal: 'Canceling your PayPal subscription',
  profile: 'Seeing or changing your details',
  invoices: 'Seeing your invoices',
  end_links: 'Turning off older links',
  tracking: 'Turning tracking off',
};

/** Whether a fresh link can't reach the Member by email. */
const unreachable = (view: CenterView) =>
  view.member.status === 'bounced' || view.member.status === 'complained';

/** Emails the Member a fresh link instead of acting, with the same per-address limit as /m. */
async function emailFreshLink(c: AppContext, view: CenterView, action: string): Promise<Response> {
  const e = env(c);
  const wait = await rateLimit(e, [[await hashKey(view.member.email), 'linkEmail']]);
  if (wait) return slowDown(wait);
  const token = c.req.param('token') ?? '';
  later(
    c,
    sendMemberCenterLinks(
      audienceDeps(e, evidenceLinks(e, { kind: 'step-up', token })),
      view.member.email,
      view.channel.id,
    ),
  );
  const reason = FRESH_LINK_REASONS[action] ?? 'This';
  return page(
    'Check your inbox',
    `<p class="channel">${h(view.channel.name)}</p><h1>Check your inbox</h1>
<p>${h(reason)} needs a fresh link. We just emailed one to ${h(maskEmail(view.member.email))}.</p>
<p>Open it within an hour, then try again from there.</p>`,
    { accent: view.channel.accent },
  );
}

/** Member statuses that see and change their Rosters (unsubscribed Members rejoin first). */
const ROSTER_STATUSES = new Set(['pending', 'active', 'paused']);

async function rostersSection(c: AppContext, view: CenterView): Promise<CenterRoster[]> {
  if (!ROSTER_STATUSES.has(view.member.status)) return [];
  return memberCenterRosters(env(c).DB, view.channel.id, view.member.id);
}

const BILLING_ACTIONS = new Set([
  'cancel_membership',
  'cancel_paypal',
  'keep_membership',
  'preview_level',
  'change_level',
  'payment_method',
]);

/**
 * Stripe for this link's Member, through the vault: it attaches the key and allows only that
 * Member's own subscription, customer, invoices and portal.
 */
const memberStripe = (c: AppContext, view: CenterView) =>
  stripeThroughVault(
    env(c),
    memberStripeFetch(env(c), c.req.param('token') ?? '', view.channel.id),
  );

/** The membership part of the page, or null for a free Member. Invoices only with `full`. */
async function billingSection(
  c: AppContext,
  view: CenterView,
  full: boolean,
): Promise<BillingSection | null> {
  const e = env(c);
  const billing = await memberBilling(e.DB, view.channel.id, view.member.id);
  if (!billing) return null;
  const stripe = memberStripe(c, view);
  let invoices: InvoiceSummary[] | null = [];
  if (billing.manageable && stripe && full) {
    try {
      invoices = await listInvoices(stripe, billing);
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      log.warn('member center invoices unavailable', {
        subscriptionId: billing.subscription.id,
        error: error.message,
      });
      invoices = null;
    }
  }
  return { billing, invoices, actions: stripe !== null };
}

/**
 * One billing action for the token's Member. The subscription comes from memberBilling; the form
 * only ever chooses an action and, for a level change, one of that Member's own price choices.
 */
async function billingAction(
  c: AppContext,
  view: CenterView,
  action: string,
  body: Record<string, unknown>,
  token: string,
  full: boolean,
): Promise<Response> {
  const e = env(c);
  const now = Date.now();
  const stripe = memberStripe(c, view);
  const billing = await memberBilling(e.DB, view.channel.id, view.member.id, now);
  const unavailable = async (message: string, status: number) =>
    centerPage(
      view,
      null,
      message,
      status,
      await billingSection(c, view, full),
      null,
      [],
      false,
      full,
    );
  if (action === 'cancel_paypal') {
    if (!billing?.subscription.paypalSubscriptionId) {
      return unavailable('That change is not available right now.', 409);
    }
    try {
      await cancelPayPalSubscription(e.DB, memberPayPal(e, token), {
        channelId: view.channel.id,
        subscriptionId: billing.subscription.id,
        now,
      });
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      log.warn('member center paypal cancel failed', { error: error.message });
      return unavailable(
        'That change could not be made right now. Try again in a few minutes.',
        502,
      );
    }
    notifyChange(c, view, 'cancel_paypal');
    return new Response(null, {
      status: 303,
      headers: {
        location: `/m/${encodeURIComponent(token)}?saved=cancel_paypal`,
        'cache-control': 'no-store',
      },
    });
  }
  if (!billing?.manageable || !stripe) {
    return unavailable('That change is not available right now.', 409);
  }
  const ctx = { db: e.DB, stripe, now };
  const fields = { action, memberId: view.member.id, subscriptionId: billing.subscription.id };
  try {
    switch (action) {
      case 'cancel_membership':
      case 'keep_membership':
        await setCancelAtPeriodEnd(ctx, billing, action === 'cancel_membership');
        break;
      case 'payment_method': {
        // The return address goes to Stripe, so it carries no Member Center token.
        const url = await billingPortalUrl(stripe, billing, `${originOf(e)}/m/back`);
        log.info('member center billing', fields);
        notifyChange(c, view, 'payment_method');
        return new Response(null, {
          status: 303,
          headers: { location: url, 'cache-control': 'no-store' },
        });
      }
      case 'preview_level': {
        const choice = findChoice(billing, str(body.price));
        if (!choice) return unavailable('Pick one of the plans on offer.', 400);
        const preview = await previewLevelChange(ctx, billing, choice);
        return previewPage(view, billing, choice, preview, token);
      }
      case 'change_level': {
        const choice = findChoice(billing, str(body.price));
        if (!choice) return unavailable('Pick one of the plans on offer.', 400);
        await applyLevelChange(ctx, billing, choice, usableProrationDate(str(body.proration), now));
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof StripeError) && !(error instanceof BillingError)) throw error;
    log.warn('member center billing failed', { ...fields, error: error.message });
    return unavailable(
      error instanceof BillingError
        ? error.message
        : 'That change could not be made right now. Try again in a few minutes.',
      error instanceof BillingError ? 409 : 502,
    );
  }
  log.info('member center billing', fields);
  notifyChange(c, view, action as MemberChange);
  return new Response(null, {
    status: 303,
    headers: {
      location: `/m/${encodeURIComponent(token)}?saved=${action}`,
      'cache-control': 'no-store',
    },
  });
}

const expiredOrBroken = () =>
  page(
    'This link does not work',
    '<h1>This link does not work</h1><p>Subscriber settings links work for 30 days. <a href="/m">Get a new link</a>.</p>',
    { status: 404 },
  );
