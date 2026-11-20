// Signup Journeys (flag signup_journeys): up to three steps after a successful subscribe.
//
//   GET  /v1/j/<token>/<step>  shows step 0, 1 or 2 (counts a view)
//   POST /v1/j/<token>/<step>  completes or skips it (an ask step records its answers), then
//                              goes on to the next step, or the end
//
// The sign-up itself runs after the subscribe response, and that response is the same for every
// address, so the journey can't name an existing Member. Its token (purpose 'journey', SIGNUP_KEYS,
// one day) carries the journey, the variant, the form, the address and the id the sign-up gives a
// Member it creates, both sealed. The vault alone holds those keys: it mints the token
// (mintJourneyToken) and opens it (openJourneyToken). An answer is recorded only for the Member with
// that id, which exists only if this sign-up added the address. A known address keeps its own id
// and a Member added any other way gets another, so a journey can't be used to write into someone
// else's profile by typing their address into a form, however soon after they joined.
//
// The variant is picked from a keyed HMAC of the address, so it is the same every time for the
// same Member and says nothing about whether the address was known. Steps that can't show (a flag
// off, a closed Ask, an archived level, no site configured, recommendations before Phase 8) are
// skipped without counting. Pages work without JavaScript and inside the form frame (frame
// ancestors follow the form's allowlist).
import {
  askOpen,
  bumpJourneyDaily,
  channelSiteOrigin,
  partnerPicksFor,
  linksFor,
  liveJourneyFor,
  loadAsk,
  loadJourney,
  pickJourneyVariant,
  recordAskAnswers,
  type AskAnswer,
  type LoadedAsk,
} from '@swarm/engine';
import { first } from '@swarm/db';
import { partnerClickPath, type SignupJourneyStep } from '@swarm/domain';
import { D1FlagStore, FlagService, type FlagKey } from '@swarm/flags';
import type { Hono } from 'hono';
import { clientIp, env, later, type AppContext, type AppEnv } from '../context';
import { siteOriginConfig, type CaptureEnv } from '../env';
import { frameAncestors } from '../frame';
import { captureVault } from '../vault';
import { loadPublishedForm, type PublishedForm } from '../forms';
import { rateLimit } from '../guard';
import { brokenLink, expiredLink, h, page, slowDown } from '../pages';

const EXPIRED = 'This page has expired. You are signed up all the same.';

/** What a journey token says, opened by the vault. */
interface JourneyClaims {
  journeyId: string;
  variant: string;
  formId: string;
  /** The address of the sign-up. */
  email: string;
  /** The id of the Member this sign-up creates. */
  memberId: string;
}

const flagsFor = (e: CaptureEnv, form: Pick<PublishedForm, 'workspaceId' | 'channelId'>) => {
  const service = new FlagService(new D1FlagStore(e.DB));
  return (key: FlagKey) =>
    service.enabled(key, { workspaceId: form.workspaceId, channelId: form.channelId });
};

/** Keyed with CAPTURE_KEYS since the cutover (MEMBER_KEYS before): variants were drawn anew then. */
async function variantSeed(e: CaptureEnv, channelId: string, email: string): Promise<string> {
  const secret = linksFor(e).secret('CAPTURE_KEYS');
  if (!secret) throw new Error('CAPTURE_KEYS is not set');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`journey-variant:${channelId}:${email.toLowerCase()}`),
  );
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Where the visitor goes after a successful sign-up through `form`, or null when there is no
 * live journey (or the flag is off). Called for every submission that gets the success answer,
 * known address or not, so the answer stays the same for both. `memberId` is the id the sign-up
 * gives the Member if it creates one.
 */
export async function journeyStart(
  e: CaptureEnv,
  form: PublishedForm,
  email: string,
  memberId: string,
): Promise<string | null> {
  if (form.config.success.type !== 'message') return null;
  if (!(await flagsFor(e, form)('signup_journeys'))) return null;
  const journey = await liveJourneyFor(e.DB, form.channelId, form.id);
  if (!journey) return null;
  const variant = await pickJourneyVariant(journey, await variantSeed(e, form.channelId, email));
  // Minted by the vault (SIGNUP_KEYS); without it the sign-up simply has no journey.
  const minted = await captureVault(e).mintJourneyToken({
    formId: form.id,
    journeyId: journey.id,
    variant: variant.key,
    memberId,
    email: email.toLowerCase(),
  });
  return minted.ok ? `/v1/j/${minted.value}/0` : null;
}

interface Context {
  token: string;
  claims: JourneyClaims;
  form: PublishedForm;
  journeyId: string;
  variant: string;
  steps: SignupJourneyStep[];
  flag: (key: FlagKey) => Promise<boolean>;
}

async function readJourney(e: CaptureEnv, token: string): Promise<Context | Response> {
  if (token.length > 1024) return brokenLink();
  // The vault verifies the token and opens its claims; an expired, forged or unreadable one, or a
  // vault that is down, ends the journey here (the sign-up itself is done).
  const opened = await captureVault(e).openJourneyToken({ token });
  if (!opened.ok) return opened.reason === 'invalid' ? brokenLink() : expiredLink(EXPIRED);
  const claims: JourneyClaims = opened.value;
  const [form, journey] = await Promise.all([
    loadPublishedForm(e.DB, claims.formId),
    loadJourney(e.DB, claims.journeyId),
  ]);
  const variant = journey?.variants.find((v) => v.key === claims.variant);
  // A journey that was paused or archived meanwhile simply ends.
  if (!form || !journey || journey.channelId !== form.channelId || !variant) return done(null);
  const flag = flagsFor(e, form);
  if (!(await flag('signup_journeys'))) return done(form);
  return {
    token,
    claims,
    form,
    journeyId: journey.id,
    variant: variant.key,
    steps: variant.steps,
    flag,
  };
}

function done(form: PublishedForm | null): Response {
  return page(
    'You are all set',
    `${form ? `<p class="channel">${h(form.channelName)}</p>` : ''}<h1>You are all set</h1><p>Thanks for joining. You can close this page.</p>`,
    {
      ...(form
        ? { accent: form.accent, frameAncestors: frameAncestors(form.config.allowedOrigins) }
        : {}),
    },
  );
}

/** What a step needs to render, or null when it can't show now. */
async function prepareStep(
  e: CaptureEnv,
  ctx: Context,
  step: SignupJourneyStep,
): Promise<
  | { kind: 'ask'; ask: LoadedAsk }
  | { kind: 'upsell'; url: string; level: { name: string; description: string | null } | null }
  | { kind: 'recommendations'; picks: { name: string; description: string; url: string }[] }
  | { kind: 'welcome'; headline: string; body: string | null; optOut: string }
  | null
> {
  switch (step.kind) {
    case 'ask': {
      if (!(await ctx.flag('reader_survey_on_subscribe'))) return null;
      const ask = await loadAsk(e.DB, step.askId, ctx.form.channelId);
      return ask && askOpen(ask) ? { kind: 'ask', ask } : null;
    }
    case 'recommendations': {
      if (!(await ctx.flag('partner_exchange'))) return null;
      const site = siteOriginConfig(e);
      if (!site) return null;
      const picks = await partnerPicksFor(e.DB, ctx.form.channelId, 'signup');
      if (!picks.length) return null;
      const { origin } = await channelSiteOrigin(e.DB, site, ctx.form.channelId);
      return {
        kind: 'recommendations',
        picks: picks.map((pick) => ({
          name: pick.name,
          description: pick.description,
          url: new URL(partnerClickPath(pick.id, 'signup'), origin).toString(),
        })),
      };
    }
    case 'upsell': {
      const site = siteOriginConfig(e);
      if (!site) return null;
      const { origin } = await channelSiteOrigin(e.DB, site, ctx.form.channelId);
      let level: { name: string; description: string | null } | null = null;
      if (step.levelId) {
        level = await first<{ name: string; description: string | null }>(
          e.DB,
          `SELECT name, description FROM membership_levels
            WHERE id = ?1 AND channel_id = ?2 AND status = 'active'`,
          step.levelId,
          ctx.form.channelId,
        );
        if (!level) return null;
      }
      const url = `${origin}/subscribe${step.levelId ? `?level=${encodeURIComponent(step.levelId)}` : ''}`;
      return { kind: 'upsell', url, level };
    }
    case 'welcome':
      if (!(await ctx.flag('welcome_page'))) return null;
      return {
        kind: 'welcome',
        headline: step.headline,
        body: step.body ?? null,
        optOut: step.optOutText || 'No thanks',
      };
  }
}

/** The first step at or after `from` that can show, or null at the end. */
async function nextStep(e: CaptureEnv, ctx: Context, from: number) {
  for (let index = from; index < ctx.steps.length; index++) {
    const prepared = await prepareStep(e, ctx, ctx.steps[index]!);
    if (prepared) return { index, prepared };
  }
  return null;
}

const stepUrl = (ctx: Context, index: number) => `/v1/j/${ctx.token}/${index}`;

function questionHtml(ask: LoadedAsk): string {
  return ask.questions
    .map((q) => {
      const name = `q.${q.id}`;
      const req = q.required ? ' required' : '';
      const description = q.description ? `<p class="muted">${h(q.description)}</p>` : '';
      if (q.kind === 'text') {
        return `<label>${h(q.prompt)}${description}<textarea name="${name}" maxlength="2000"${req}></textarea></label>`;
      }
      return `<fieldset><legend>${h(q.prompt)}</legend>${description}${q.options
        .map(
          (o) =>
            `<label class="choice"><input type="radio" name="${name}" value="${o.id}"${req}> ${h(o.label)}</label>`,
        )
        .join('')}</fieldset>`;
    })
    .join('');
}

function stepPage(
  ctx: Context,
  index: number,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareStep>>>,
  first: boolean,
): Response {
  const form = ctx.form;
  const action = stepUrl(ctx, index);
  const thanks =
    first && form.config.success.type === 'message'
      ? `<p class="notice">${h(form.config.success.message)}</p>`
      : '';
  const skip = (label: string) =>
    `<form method="post" action="${h(action)}"><input type="hidden" name="action" value="skip"><button type="submit" class="ghost">${h(label)}</button></form>`;
  let body: string;
  const formTargets: string[] = [];
  switch (prepared.kind) {
    case 'ask':
      body = `<h1>${h(prepared.ask.title)}</h1>${prepared.ask.description ? `<p>${h(prepared.ask.description)}</p>` : ''}
<form method="post" action="${h(action)}"><input type="hidden" name="action" value="done">${questionHtml(prepared.ask)}<p><button type="submit">Continue</button></p></form>${skip('Skip')}`;
      break;
    case 'upsell': {
      formTargets.push(new URL(prepared.url).origin);
      const level = prepared.level;
      body = `<h1>${h(level ? `Become a ${level.name} subscriber` : 'Become a paid subscriber')}</h1>
<p>${h(level?.description ?? `Support ${form.channelName} and get everything it publishes.`)}</p>
<form method="post" action="${h(action)}" target="_top"><input type="hidden" name="action" value="done"><p><button type="submit">See plans</button></p></form>${skip('Not now')}`;
      break;
    }
    case 'recommendations':
      body = `<h1>You might also like</h1><ul>${prepared.picks
        .map(
          (pick) =>
            `<li><a href="${h(pick.url)}" target="_blank" rel="noopener nofollow">${h(pick.name)}</a>${pick.description ? `<br>${h(pick.description)}` : ''}</li>`,
        )
        .join('')}</ul>
<form method="post" action="${h(action)}"><input type="hidden" name="action" value="done"><p><button type="submit">Continue</button></p></form>`;
      break;
    case 'welcome':
      body = `<h1>${h(prepared.headline)}</h1>${prepared.body ? `<p>${h(prepared.body)}</p>` : ''}
<form method="post" action="${h(action)}"><input type="hidden" name="action" value="done"><p><button type="submit">Continue</button></p></form>${skip(prepared.optOut)}`;
      break;
  }
  return page(form.channelName, `<p class="channel">${h(form.channelName)}</p>${thanks}${body}`, {
    accent: form.accent,
    frameAncestors: frameAncestors(form.config.allowedOrigins),
    formTargets,
  });
}

const stepParam = (c: AppContext): number | null => {
  const raw = c.req.param('step');
  return raw === '0' || raw === '1' || raw === '2' ? Number(raw) : null;
};

/** The Member this sign-up created, for recording answers; null otherwise. */
async function journeyMember(e: CaptureEnv, ctx: Context): Promise<string | null> {
  // The vault opens only tokens that carry the id (an older one can't say which row is its own).
  const { email, memberId } = ctx.claims;
  const row = await first<{ id: string }>(
    e.DB,
    'SELECT id FROM members WHERE id = ?1 AND channel_id = ?2 AND email = ?3',
    memberId,
    ctx.form.channelId,
    email,
  );
  return row?.id ?? null;
}

export function journeyRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/j/:token/:step', async (c) => {
    const e = env(c);
    c.set('headerOverrides', { 'x-frame-options': null });
    const step = stepParam(c);
    if (step === null) return brokenLink();
    const ctx = await readJourney(e, c.req.param('token'));
    if (ctx instanceof Response) return ctx;
    const next = await nextStep(e, ctx, step);
    if (!next) return done(ctx.form);
    if (next.index !== step) return c.redirect(stepUrl(ctx, next.index), 303);
    later(
      c,
      bumpJourneyDaily(e.DB, {
        journeyId: ctx.journeyId,
        variant: ctx.variant,
        step,
        counter: 'views',
      }),
    );
    // The first step that shows carries the form's thank-you message.
    const earlier = await nextStep(e, ctx, 0);
    return stepPage(ctx, step, next.prepared, earlier?.index === step);
  });

  app.post('/v1/j/:token/:step', async (c) => {
    const e = env(c);
    c.set('headerOverrides', { 'x-frame-options': null });
    const step = stepParam(c);
    if (step === null) return brokenLink();
    const ctx = await readJourney(e, c.req.param('token'));
    if (ctx instanceof Response) return ctx;
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const current = ctx.steps[step];
    const prepared = current ? await prepareStep(e, ctx, current) : null;
    const body = await c.req.parseBody();
    const skipped = body.action === 'skip';
    if (prepared) {
      if (prepared.kind === 'ask' && !skipped) {
        const answers: AskAnswer[] = prepared.ask.questions.map((q) => {
          const value = body[`q.${q.id}`];
          const text = typeof value === 'string' ? value.slice(0, 4000) : null;
          return q.kind === 'choice'
            ? { questionId: q.id, optionId: text }
            : { questionId: q.id, text };
        });
        const memberId = await journeyMember(e, ctx);
        if (memberId) {
          await recordAskAnswers(e.DB, {
            ask: prepared.ask,
            memberId,
            surface: 'journey',
            answers: answers.filter((a) => a.optionId || a.text),
          });
        }
      }
      await bumpJourneyDaily(e.DB, {
        journeyId: ctx.journeyId,
        variant: ctx.variant,
        step,
        counter: skipped ? 'skips' : 'completions',
      });
      if (prepared.kind === 'upsell' && !skipped) {
        return new Response(null, {
          status: 303,
          headers: { location: prepared.url, 'cache-control': 'no-store' },
        });
      }
    }
    const next = await nextStep(e, ctx, step + 1);
    return next ? c.redirect(stepUrl(ctx, next.index), 303) : done(ctx.form);
  });
}
