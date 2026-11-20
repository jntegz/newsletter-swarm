// A website signup in steps (flag signup_paths), after the address is saved by the capture worker.
//
//   GET  /_swarm/join/<token>        goes to the first step the Channel's signup path asks for
//   GET  /_swarm/join/<token>/name   first and last name; both optional
//   POST /_swarm/join/<token>/name   saves them after the response, then the next step
//   GET  /_swarm/join/<token>/plan   free or a paid level; skipped when nothing can be bought
//   GET  /_swarm/join/<token>/done   the form's thank-you message, or the Channel's Signup Journey
//
// Every address gets the same pages at the same speed, known or not (see packages/engine/src/join.ts).
// These pages hold the token, so they are never cached, carry no referrer and run no owner code.
import { addJoinName, payPalSellable, TURNSTILE_SCRIPT } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { crossSite, field, refused, tooMany, underPaymentLimit } from '../money/guard';
import { SIGNOUT_FORM } from '../money/buyer';
import {
  activeLevels,
  memberById,
  paidAccount,
  paymentsOpen,
  paypalConnected,
} from '../money/data';
import { later } from '../readers/later';
import { h } from '../render/html';
import { siteFlags, siteForm } from '../render/data';
import { loadChrome, renderPage, sendPage } from '../render/layout';
import { levelCard, sellable } from './plans';
import { openJoin } from '../vault';

export const joinRoutes = new Hono<SiteBindings>();

const noReferrer = (c: SiteContext) => c.header('referrer-policy', 'no-referrer');

async function joinPage(c: SiteContext, title: string, body: string): Promise<Response> {
  const chrome = await loadChrome(c);
  const html = renderPage(c, chrome, {
    meta: { title, description: title, path: '/_swarm/join', noindex: true },
    referrer: 'no-referrer',
    bare: true,
    subscribe: false,
    bodyClass: 'sw-landing',
    body: `<div class="sw-article sw-join">${body}</div>`,
  });
  return sendPage(c, html, { cache: 'private' });
}

const expired = (c: SiteContext) =>
  joinPage(
    c,
    'This page has expired',
    `<header class="sw-pagehead"><h1>This page has expired</h1><p>If you already entered your email, you are signed up all the same.</p></header><p><a href="/">Go to ${h(c.get('channel').name)}</a></p>`,
  );

const read = async (c: SiteContext) => {
  const env = c.get('env');
  const flags = await siteFlags(c);
  if (!flags.signup_paths) return null;
  // The vault verifies the token and opens its claims (it alone holds those keys).
  return openJoin(env, c.req.param('token') ?? '', c.get('channel').id);
};

/** What the plan step can offer now; nothing to offer means the step is skipped. */
async function planChoices(c: SiteContext) {
  const env = c.get('env');
  const channel = c.get('channel');
  const [flags, account, levels, paypal] = await Promise.all([
    siteFlags(c),
    paidAccount(env, channel.id),
    activeLevels(env, channel.id),
    paypalConnected(env, channel.id),
  ]);
  const open = account !== null && account.chargesEnabled && paymentsOpen(env, account);
  const pwyw = flags.pay_what_you_want;
  const usable = levels
    .filter((l) => l.visibility === 'public' && (!l.founding || flags.founding_level))
    .filter((l) =>
      l.prices.some(
        (p) =>
          (open && sellable(p, pwyw)) ||
          (paypal && p.interval !== 'lifetime' && payPalSellable(p, l.trialDays)),
      ),
    );
  return { levels: usable, open, paypal, pwyw, founding: flags.founding_level };
}

const stepPath = (token: string, step: 'name' | 'plan' | 'done') => `/_swarm/join/${token}/${step}`;

async function afterName(c: SiteContext, token: string): Promise<string> {
  if (c.get('channel').settings.signupPath !== 'email_name_plan') return stepPath(token, 'done');
  const choices = await planChoices(c);
  return stepPath(token, choices.levels.length ? 'plan' : 'done');
}

joinRoutes.get('/_swarm/join/:token', async (c) => {
  const token = c.req.param('token');
  if (!(await read(c))) return expired(c);
  c.header('cache-control', 'no-store');
  noReferrer(c);
  const path = c.get('channel').settings.signupPath;
  return c.redirect(stepPath(token, path === 'email' ? 'done' : 'name'), 303);
});

joinRoutes.get('/_swarm/join/:token/name', async (c) => {
  const token = c.req.param('token');
  const claims = await read(c);
  if (!claims) return expired(c);
  const form = await siteForm(c.get('env'), c.get('channel'), claims.formId);
  const label = (key: string, fallback: string) =>
    form?.config.fields.find((f) => f.key === key)?.label || fallback;
  return joinPage(
    c,
    'What should we call you?',
    `<header class="sw-pagehead"><h1>What should we call you?</h1><p>You are on the list. Add your name so emails can greet you properly.</p></header>
<section class="sw-subscribe" aria-label="Your name">
<form method="post" action="${h(stepPath(token, 'name'))}">
<label>${h(label('first_name', 'First name'))} <input type="text" name="firstName" autocomplete="given-name" maxlength="80"></label>
<label>${h(label('last_name', 'Last name'))} <input type="text" name="lastName" autocomplete="family-name" maxlength="80"></label>
<button type="submit">Continue</button>
</form>
</section>
<p><a href="${h(await afterName(c, token))}">Skip this step</a></p>`,
  );
});

joinRoutes.post('/_swarm/join/:token/name', async (c) => {
  const token = c.req.param('token');
  if (crossSite(c)) return refused(c);
  if (!(await underPaymentLimit(c, 'join'))) return tooMany(c);
  const claims = await read(c);
  if (!claims) return expired(c);
  const form = await c.req.parseBody();
  // After the response: the answer and its timing are the same whether the address was known.
  later(
    c,
    addJoinName(c.get('env').DB, {
      channelId: c.get('channel').id,
      email: claims.email,
      memberId: claims.memberId,
      firstName: field(form, 'firstName', 200),
      lastName: field(form, 'lastName', 200),
    }),
  );
  c.header('cache-control', 'no-store');
  noReferrer(c);
  return c.redirect(await afterName(c, token), 303);
});

joinRoutes.get('/_swarm/join/:token/plan', async (c) => {
  const token = c.req.param('token');
  const claims = await read(c);
  if (!claims) return expired(c);
  const choices = await planChoices(c);
  const done = stepPath(token, 'done');
  c.header('cache-control', 'no-store');
  if (!choices.levels.length) return c.redirect(done, 303);
  const interval = c.req.query('interval') === 'year' ? 'year' : 'month';
  const reader = c.get('reader');
  const member =
    reader.class !== 'anonymous' && reader.memberId
      ? await memberById(c.get('env'), c.get('channel').id, reader.memberId)
      : null;
  const ctx = {
    c,
    signedIn: reader.class !== 'anonymous',
    coupon: '',
    pwyw: choices.pwyw,
    joinToken: token,
    buyer: member ? { memberId: member.id, email: member.email } : null,
  };
  const cards = choices.levels.map((level) =>
    levelCard(ctx, level, {
      interval,
      open: choices.open,
      paypal: choices.paypal,
      pledging: false,
      founding: choices.founding,
    }),
  );
  const hasYear = choices.levels.some((l) =>
    l.prices.some((p) => p.interval === 'year' && sellable(p, choices.pwyw)),
  );
  const here = stepPath(token, 'plan');
  const tabs = hasYear
    ? `<nav class="sw-tabs" aria-label="Billing"><a href="${h(here)}"${interval === 'month' ? ' aria-current="page"' : ''}>Monthly</a><a href="${h(`${here}?interval=year`)}"${interval === 'year' ? ' aria-current="page"' : ''}>Yearly</a></nav>`
    : '';
  return joinPage(
    c,
    'Choose your plan',
    `<header class="sw-pagehead"><h1>Choose your plan</h1><p>You are on the free list already. Support ${h(c.get('channel').name)} to read everything.</p></header>
${tabs}
<ul class="sw-plans"><li class="sw-plan"><h2>Free</h2><ul class="sw-plan-benefits"><li>Public posts by email</li></ul><p><a class="sw-button" href="${h(done)}">Continue with free</a></p></li>
${cards.join('\n')}</ul>
${member ? SIGNOUT_FORM : ''}
<script nonce="${h(c.get('nonce'))}" src="${TURNSTILE_SCRIPT}" async defer></script>`,
  );
});

joinRoutes.get('/_swarm/join/:token/done', async (c) => {
  const claims = await read(c);
  if (!claims) return expired(c);
  const env = c.get('env');
  // A live Signup Journey carries the form's thank-you message itself.
  if (claims.journey) {
    c.header('cache-control', 'no-store');
    noReferrer(c);
    return c.redirect(`${env.CAPTURE_ORIGIN.replace(/\/$/, '')}${claims.journey}`, 303);
  }
  const form = await siteForm(env, c.get('channel'), claims.formId);
  const message =
    form?.config.success.type === 'message' ? form.config.success.message : 'You are all set.';
  return joinPage(
    c,
    'You are all set',
    `<header class="sw-pagehead"><h1>You are all set</h1><p>${h(message)}</p></header><p><a href="/archive">Read past issues</a></p>`,
  );
});
