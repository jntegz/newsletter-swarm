// POST /v1/<formId>/subscribe: JSON from the form frame, or a plain form post (the no-JS snippet).
//
// The plain form post is core, not an option: Channel website pages run no JavaScript, so the
// site's own subscribe form is this post (the registry's nojs_subscribe records that decision and
// is not checked). UTM, referrer and landing-page attribution is stored only with the
// subscribe_attribution_fields flag on; the form id and a Champion's ref are always kept.
//
// Checks, in order: a published form; per-IP and per-form rate limits; the form's origin
// allowlist; the honeypot; Turnstile; the address (valid, not disposable); required fields and
// consent; profile field values; then, on a single opt-in form with signup checks turned on
// (docs/email-verification.md), the address with DeBounce, last so bots never cost a credit. A
// form that asks people to confirm sends nothing to DeBounce here: the address is checked once its
// holder has confirmed it (routes/confirm.ts). A red address is refused with DeBounce's
// suggested spelling when it has one; DeBounce being slow, down or out of credits lets the person
// in unchecked. The answer is about the address only, never whether it is on the list, and the
// address is asked about every time, so its timing doesn't say either. Then the visitor gets the
// form's success message (or redirect,
// carrying a signed Member reference, never the address) and the sign-up itself runs after the
// response, so neither the answer nor its timing says whether the address was already on the list.
//
// Without JavaScript there is no Turnstile token. The no-JS post is answered with a challenge page
// on the capture origin that repeats the submitted values in hidden inputs next to the Turnstile
// widget; the sign-up only happens once that challenge is passed. Turnstile itself needs
// JavaScript, so a browser with JavaScript fully off gets a small question instead (guard.ts), and
// a sign-up that passes that way always confirms by email, whatever the form says. Nothing is ever
// accepted without a passed challenge.
import {
  AttributionInputSchema,
  EMAIL_CHECK_REFUSAL,
  EmailSchema,
  newId,
  type AttributionInput,
  type FieldValue,
} from '@swarm/domain';
import {
  FieldValueError,
  afterJoin,
  channelSiteOrigin,
  checkSignup,
  isDisposableAddress,
  linksFor,
  memberReference,
  normalizeFieldValue,
  readFormStamp,
  sectionCountStatement,
  sectionVariantOf,
  subscribe,
  type SubmittedField,
  VAULT_HELD_KEY,
} from '@swarm/engine';
import { retryWhileBusy } from '@swarm/db';
import { createLogger } from '@swarm/runtime';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  audienceDeps,
  channelFlag,
  clientIp,
  env,
  later,
  refreshCircles,
  type AppContext,
  type AppEnv,
} from '../context';
import { captureVault, signupDebounce } from '../vault';
import { originOf, siteOriginConfig, type CaptureEnv } from '../env';
import { formFieldDefs, loadPublishedForm, type PublishedForm } from '../forms';
import {
  newChallenge,
  originAllowed,
  originFrom,
  rateLimit,
  readChallenge,
  turnstilePass,
} from '../guard';
import { h, page } from '../pages';
import { journeyStart } from './journey';

const log = createLogger({ service: 'capture' });

const JsonSubmissionSchema = z.object({
  email: z.string().max(320),
  firstName: z.string().max(200).nullish(),
  lastName: z.string().max(200).nullish(),
  fields: z
    .record(
      z.string().max(60),
      z.union([
        z.string().max(2000),
        z.array(z.string().max(200)).max(50),
        z.boolean(),
        z.number(),
      ]),
    )
    .optional(),
  consent: z.boolean().optional(),
  formVersion: z.number().int().positive().nullish(),
  formStamp: z.string().max(1024).nullish(),
  website: z.string().max(500).optional(),
  turnstileToken: z.string().max(4096).nullish(),
  parentOrigin: z.string().max(255).nullish(),
  attribution: AttributionInputSchema.nullish(),
  ref: z.string().max(40).nullish(),
});

interface Submission {
  email: string;
  firstName: string | null;
  lastName: string | null;
  fields: Record<string, unknown>;
  consent: boolean;
  /** The form version on the page the person saw, which may be a cached older one. */
  formVersion: number | null;
  /** The stamp the server signed into the form it rendered (consents.ts formStamp), if any. */
  formStamp: string | null;
  website: string;
  turnstileToken: string | null;
  attribution: AttributionInput | null;
  ref: string | null;
  /** The site the form was used on, when known. */
  hostOrigin: string | null;
  /** A plain form post: a multi-select with one box ticked arrives as a single string. */
  plain: boolean;
  /**
   * The home page section the site's own form sat in, and the variant drawn (sw_section and
   * sw_variant). Only ever counted as a signup for that section; null when absent or invalid.
   */
  siteSection: { sectionId: string; variant: 'a' | 'b' } | null;
}

class Refusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 415 | 429 | 503,
    readonly code:
      | 'invalid_input'
      | 'forbidden'
      | 'not_found'
      | 'unsupported_media_type'
      | 'rate_limited'
      | 'unavailable',
    message: string,
    readonly details?: { path: string; message: string }[],
    /** Email checks: DeBounce's suggested spelling of the address. */
    readonly suggestion?: string,
  ) {
    super(message);
  }
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

const str = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && typeof value[0] === 'string'
      ? value[0]
      : null;

const positiveInt = (value: string | null): number | null =>
  value && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;

/**
 * What a plain form post can say about where it came from: the page (the Referer, when the host
 * sends the whole URL) and UTMs from the snippet's hidden fields or that URL's query.
 */
function plainAttribution(
  values: Record<string, string | string[]>,
  pageUrl: string | null,
): AttributionInput | null {
  const current: NonNullable<AttributionInput['current']> = {};
  let query: URLSearchParams | null = null;
  if (pageUrl) {
    current.current_url = pageUrl.slice(0, 2048);
    try {
      query = new URL(pageUrl).searchParams;
    } catch {
      query = null;
    }
  }
  for (const key of UTM_KEYS) {
    const value = str(values[key]) || query?.get(key);
    if (value) current[key] = value.slice(0, 200);
  }
  return Object.keys(current).length ? { current } : null;
}

/** Values from a urlencoded or multipart post: repeated names are lists, files are ignored. */
function formValues(body: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value))
      out[name] = value.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/**
 * The success answer. Identical for every address, known or not: a live Signup Journey's first
 * step follows the message (its variant comes from a keyed hash of the address, known or not).
 * `memberId` is the id the sign-up will give a Member it creates; the journey and the join steps
 * write only to that.
 */
async function successFor(
  e: CaptureEnv,
  form: PublishedForm,
  email: string,
  memberId: string,
  joinOrigin: string | null = null,
) {
  const success = form.config.success;
  if (success.type === 'message') {
    const journey = await journeyStart(e, form, email, memberId);
    // In steps: on to the site for the name and plan, for every address, known or not.
    if (joinOrigin) {
      // Minted by the vault (SIGNUP_KEYS), which seals the address and the id in it.
      const token = await captureVault(e).mintJoinToken({
        formId: form.id,
        memberId,
        email,
        ...(journey ? { journeyPath: journey } : {}),
      });
      if (!token.ok) {
        throw new Refusal(503, 'unavailable', 'Signing up is not available right now. Try again.');
      }
      return {
        message: null,
        redirect: `${joinOrigin}/_swarm/join/${token.value}`,
        journey: null,
      };
    }
    return { message: success.message, redirect: null, journey };
  }
  const url = new URL(success.url);
  url.searchParams.set('swarm_member', await memberReference(linksFor(e), form.channelId, email));
  return { message: null, redirect: url.href, journey: null };
}

/** The answer a filled honeypot gets: the form's message or bare redirect, minting nothing. */
function decoyFor(form: PublishedForm) {
  const success = form.config.success;
  return success.type === 'message'
    ? { message: success.message, redirect: null, journey: null }
    : { message: null, redirect: new URL(success.url).href, journey: null };
}

/**
 * The site's origin when this post starts a signup in steps, else null. Only the site's own plain
 * form asks for it, and only a form that answers with a message: a redirect form goes its own way.
 */
async function joinOriginFor(
  e: CaptureEnv,
  form: PublishedForm,
  values: Record<string, string | string[]>,
  hostOrigin: string | null,
): Promise<string | null> {
  if (str(values.join) !== '1' || form.signupPath === 'email') return null;
  if (form.config.success.type !== 'message') return null;
  const site = siteOriginConfig(e);
  if (!site) return null;
  const on = await channelFlag(
    e,
    { workspaceId: form.workspaceId, channelId: form.channelId },
    'signup_paths',
  );
  if (!on) return null;
  const { origin } = await channelSiteOrigin(e.DB, site, form.channelId);
  // The page they are on, when it is this site: it knows its own port on a local install.
  const sameHost = hostOrigin && new URL(hostOrigin).hostname === new URL(origin).hostname;
  return sameHost ? hostOrigin : origin;
}

/**
 * Whether a plain post came from the Channel's own website: its platform address or one of its
 * active web hostnames. Only those carry a home page section worth counting.
 */
async function fromChannelSite(
  e: CaptureEnv,
  channelId: string,
  hostOrigin: string | null,
): Promise<boolean> {
  const site = siteOriginConfig(e);
  if (!site || !hostOrigin) return false;
  const host = new URL(hostOrigin).hostname;
  const { platformOrigin } = await channelSiteOrigin(e.DB, site, channelId);
  if (new URL(platformOrigin).hostname === host) return true;
  const custom = await e.DB.prepare(
    `SELECT 1 AS ok FROM custom_hostnames
      WHERE hostname = ?1 AND channel_id = ?2 AND status = 'active' AND role = 'web'`,
  )
    .bind(host, channelId)
    .first<{ ok: number }>();
  return custom !== null;
}

/** +1 signup for a home page section's variant, when the post came from the Channel's site. */
async function countSectionSignup(
  e: CaptureEnv,
  form: PublishedForm,
  hostOrigin: string | null,
  section: { sectionId: string; variant: 'a' | 'b' },
): Promise<void> {
  if (!(await fromChannelSite(e, form.channelId, hostOrigin))) return;
  await retryWhileBusy(() =>
    sectionCountStatement(e.DB, 'signups', { channelId: form.channelId, ...section }).run(),
  );
}

async function validate(
  e: CaptureEnv,
  form: PublishedForm,
  input: Submission,
  nameComesLater = false,
): Promise<{ email: string; fields: SubmittedField[] }> {
  const parsed = EmailSchema.safeParse(input.email);
  if (!parsed.success) throw new Refusal(400, 'invalid_input', 'Enter a valid email address.');
  const email = parsed.data;
  if (isDisposableAddress(email)) {
    throw new Refusal(400, 'invalid_input', 'Use a permanent email address, not a disposable one.');
  }
  const config = form.config;
  if (config.consent?.required && !input.consent) {
    throw new Refusal(400, 'invalid_input', 'Tick the consent box to join.');
  }
  const defs = await formFieldDefs(e.DB, form);
  const fields: SubmittedField[] = [];
  for (const field of config.fields) {
    if (field.key === 'email') continue;
    if (field.key === 'first_name' || field.key === 'last_name') {
      const value = field.key === 'first_name' ? input.firstName : input.lastName;
      if (!nameComesLater && field.required && !value?.trim()) {
        throw new Refusal(400, 'invalid_input', `Fill in ${field.label}.`);
      }
      continue;
    }
    const def = defs.get(field.key.slice('field:'.length));
    if (!def) continue;
    let value: FieldValue;
    // Own keys only: a blank field keyed "constructor" must not find Object.prototype's.
    const raw = Object.hasOwn(input.fields, def.key) ? input.fields[def.key] : undefined;
    try {
      value = normalizeFieldValue(
        def,
        input.plain && def.type === 'multi_select' && typeof raw === 'string' ? [raw] : raw,
      );
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      throw new Refusal(400, 'invalid_input', `${field.label}: ${error.message}`, [
        { path: `fields.${def.key}`, message: error.message },
      ]);
    }
    if (value === null) {
      if (field.required) throw new Refusal(400, 'invalid_input', `Fill in ${field.label}.`);
      continue;
    }
    fields.push({ def, value });
  }
  return { email, fields };
}

/** Repeats the submitted values next to a Turnstile widget. */
async function challengePage(
  e: CaptureEnv,
  form: PublishedForm,
  values: Record<string, string | string[]>,
  hostOrigin: string | null,
  pageUrl: string | null,
  failed: boolean,
  joinOrigin: string | null,
  /** Email checks: the page that offers DeBounce's suggested spelling instead. */
  suggestion?: { email: string; back: string | null },
): Promise<Response> {
  const hidden: string[] = [];
  if (suggestion) values = { ...values, email: suggestion.email };
  for (const [name, value] of Object.entries(values)) {
    if (name === 'cf-turnstile-response' || name === '_challenge' || name === 'answer') continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      hidden.push(`<input type="hidden" name="${h(name)}" value="${h(v)}">`);
    }
  }
  const challenge = await newChallenge(e, form.id, hostOrigin, pageUrl);
  hidden.push(`<input type="hidden" name="_challenge" value="${h(challenge.token)}">`);
  const action = `/v1/${h(form.id)}/subscribe`;
  const intro = suggestion
    ? `<h1>Check your email address</h1><p class="error">${h(EMAIL_CHECK_REFUSAL)}</p>
<p>Did you mean <strong>${h(suggestion.email)}</strong>?</p>${suggestion.back ? `<p><a href="${h(suggestion.back)}">No, go back and fix it</a></p>` : ''}`
    : `<h1>One more step</h1>
${failed ? '<p class="error">We could not check that you are a person. Try the check again.</p>' : '<p>Confirm you are a person to finish joining.</p>'}`;
  const button = suggestion ? `Yes, use ${h(suggestion.email)}` : 'Continue';
  return page(
    `Join ${form.channelName}`,
    `<p class="channel">${h(form.channelName)}</p>${intro}
<noscript><style>#with-script{display:none}</style></noscript>
<form id="with-script" method="post" action="${action}">${hidden.join('')}
<div class="cf-turnstile" data-sitekey="${h(e.TURNSTILE_SITE_KEY)}" data-action="subscribe" data-cdata="${h(form.id)}"></div>
<p><button type="submit">${button}</button></p></form>
<noscript><form method="post" action="${action}">${hidden.join('')}
<label>${h(challenge.question)} Answer in digits.<input type="text" name="answer" inputmode="numeric" autocomplete="off" required maxlength="4"></label>
<p><button type="submit">Join</button></p></form><p class="muted">We will email you a link to confirm your address.</p></noscript>`,
    {
      status: suggestion ? 400 : failed ? 403 : 200,
      accent: form.accent,
      turnstile: true,
      // Browsers apply form-action to the redirect after the post too.
      ...(joinOrigin ? { formTargets: [joinOrigin] } : {}),
    },
  );
}

export function subscribeRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/:formId/subscribe', async (c) => {
    const e = env(c);
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    const json = type.startsWith('application/json');
    const plain =
      type.startsWith('application/x-www-form-urlencoded') ||
      type.startsWith('multipart/form-data');

    const refuse = (error: Refusal, form?: PublishedForm | null) => {
      if (json || !plain) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              requestId: c.get('requestId'),
              ...(error.details ? { details: error.details } : {}),
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
          },
          error.status,
        );
      }
      const back = originFrom(c.req.header('referer'));
      return page(
        'Check the form',
        `<h1>That did not work</h1><p>${h(error.message)}</p>${back && back !== originOf(e) ? `<p><a href="${h(c.req.header('referer') ?? '')}">Go back</a></p>` : ''}`,
        { status: error.status, accent: form?.accent ?? null },
      );
    };

    if (!json && !plain) {
      return refuse(
        new Refusal(415, 'unsupported_media_type', 'Send the form as JSON or a form post.'),
      );
    }
    const form = await loadPublishedForm(e.DB, c.req.param('formId'));
    if (!form) return refuse(new Refusal(404, 'not_found', 'This form is not available.'));

    try {
      const wait = await rateLimit(e, [
        [clientIp(c), 'subscribeIp'],
        [form.id, 'subscribeForm'],
      ]);
      if (wait) {
        c.header('retry-after', String(wait));
        throw new Refusal(
          429,
          'rate_limited',
          'Too many attempts. Wait a few minutes, then try again.',
        );
      }

      let input: Submission;
      let values: Record<string, string | string[]> = {};
      let pageUrl: string | null = null;
      let answered = false;
      let solved = false;
      if (json) {
        // Only the form frame posts JSON, and it is same-origin with this endpoint.
        if (c.req.header('origin') !== originOf(e)) {
          throw new Refusal(403, 'forbidden', 'This form can only be sent from its own page.');
        }
        const body = JsonSubmissionSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) throw new Refusal(400, 'invalid_input', 'Some fields are not valid.');
        const b = body.data;
        input = {
          email: b.email,
          firstName: b.firstName ?? null,
          lastName: b.lastName ?? null,
          fields: b.fields ?? {},
          consent: b.consent === true,
          formVersion: b.formVersion ?? null,
          formStamp: b.formStamp ?? null,
          website: b.website ?? '',
          turnstileToken: b.turnstileToken ?? null,
          attribution: b.attribution ?? null,
          ref: b.ref ?? null,
          hostOrigin: originFrom(b.parentOrigin),
          plain: false,
          siteSection: null,
        };
      } else {
        values = formValues(await c.req.parseBody({ all: true }));
        const challenge = str(values._challenge);
        let hostOrigin: string | null;
        if (challenge) {
          // The re-post from our own challenge page: the host was checked when it was issued.
          const read = await readChallenge(e, form.id, challenge);
          if (!read)
            throw new Refusal(403, 'forbidden', 'This page has expired. Send the form again.');
          hostOrigin = read.hostOrigin;
          pageUrl = read.pageUrl;
          const answer = str(values.answer);
          answered = answer !== null;
          solved = await read.solved(answer);
        } else {
          hostOrigin = originFrom(c.req.header('origin')) ?? originFrom(c.req.header('referer'));
          const referer = c.req.header('referer');
          if (referer && originFrom(referer) === hostOrigin) pageUrl = referer;
        }
        // No prototype: a posted "f.__proto__" is a field name like any other.
        const fields = Object.create(null) as Record<string, unknown>;
        for (const [name, value] of Object.entries(values)) {
          if (name.startsWith('f.')) fields[name.slice(2)] = value;
        }
        input = {
          email: str(values.email) ?? '',
          firstName: str(values.firstName),
          lastName: str(values.lastName),
          fields,
          consent: str(values.consent) === 'yes',
          formVersion: positiveInt(str(values.formVersion)),
          formStamp: str(values.formStamp),
          website: str(values.website) ?? '',
          turnstileToken: str(values['cf-turnstile-response']),
          attribution: plainAttribution(values, pageUrl),
          // The site's inline form carries a Champion's code (?ref= or the /r/<code> cookie).
          ref: str(values.ref)?.slice(0, 40) ?? null,
          hostOrigin,
          plain: true,
          // Carried through the challenge page like every other submitted value.
          siteSection: sectionVariantOf(str(values.sw_section), str(values.sw_variant)),
        };
      }

      if (!originAllowed(form.config.allowedOrigins, input.hostOrigin)) {
        throw new Refusal(403, 'forbidden', 'This form can’t be used on this site.');
      }

      const joinOrigin = json ? null : await joinOriginFor(e, form, values, input.hostOrigin);

      // A filled honeypot gets an ordinary-looking answer and nothing else: no journey, join
      // token or Member reference, since nothing has checked the address or the sender.
      if (input.website.trim()) {
        log.info('honeypot tripped', { formId: form.id });
        return respond(c, decoyFor(form), json);
      }

      // The pass must be for this form: one solved on another form's page doesn't count.
      const pass = solved
        ? null
        : await turnstilePass(e, input.turnstileToken, c.req.header('cf-connecting-ip'), form.id);
      if (!solved && !pass) {
        if (!json) {
          const failed = answered || !!input.turnstileToken;
          return challengePage(e, form, values, input.hostOrigin, pageUrl, failed, joinOrigin);
        }
        throw new Refusal(403, 'forbidden', 'We could not check that you are a person. Try again.');
      }

      const { email, fields } = await validate(e, form, input, joinOrigin !== null);
      // What the server checked itself, apart from what the submission says about where it was:
      // the host Turnstile reported for a pass bound to this form, else the forms address (where
      // Swarm's own question was answered, and where every widget renders). hostOrigin is a claim.
      const verifiedHost =
        pass?.hostname && pass.cdata === form.id ? pass.hostname : new URL(originOf(e)).host;
      // The wording of the version the person saw. An unknown version falls back to the latest.
      // A valid form stamp proves which version Swarm rendered (a cached site page may be older).
      // Without one, an older version is only what the submission says (a pinned embed, or a
      // hand-made request), so the record marks it as claimed. Either way that version's own
      // consent rule applies: naming an older form can't skip a box it had.
      let stamp = await readFormStamp(linksFor(e), input.formStamp, form.id);
      const version = stamp?.version ?? input.formVersion;
      const named =
        version && version !== form.version
          ? await loadPublishedForm(e.DB, form.id, version)
          : null;
      // A stamped version that can't be loaded any more isn't what is recorded.
      if (stamp && stamp.version !== form.version && !named) stamp = null;
      const shown = named ?? form;
      if (shown.config.consent?.required && !input.consent) {
        throw new Refusal(400, 'invalid_input', 'Tick the consent box to join.');
      }
      // The no-JS question is a weaker check than Turnstile: the address has to confirm.
      const mustConfirm = form.doubleOptIn || solved;
      // Email checks: never in the way of a signup when anything goes wrong. A signup that has to
      // confirm is checked once it has (the capture confirm route queues it), so an address
      // nobody confirmed never reaches DeBounce. Only single opt-in asks at the form.
      const check = mustConfirm
        ? null
        : await checkSignup(
            {
              db: e.DB,
              // The key is the vault's; it answers "not allowed" when there is none.
              env: { ENVIRONMENT: e.ENVIRONMENT, DEBOUNCE_API_KEY: VAULT_HELD_KEY },
              debounce: signupDebounce(e, form.channelId),
            },
            { workspaceId: form.workspaceId, channelId: form.channelId, email },
          ).catch((error: Error) => {
            log.warn('email check failed; the signup goes ahead unchecked', {
              error: error.message,
            });
            return null;
          });
      // A refusal from DeBounce the publisher hasn't chosen to show gets the answer any signup
      // gets, and the address is not added: the form never tells a visitor what DeBounce thinks
      // of an address they typed, which may be someone else's.
      if (check?.action === 'refuse' && !check.reveal) {
        log.info('signup refused by the email check, answered as usual', { formId: form.id });
        return respond(c, await successFor(e, form, email, newId('member'), joinOrigin), json);
      }
      if (check?.action === 'refuse') {
        const suggestion = check.result.didYouMean ?? undefined;
        if (!json && suggestion) {
          const back = c.req.header('referer');
          return challengePage(e, form, values, input.hostOrigin, pageUrl, false, joinOrigin, {
            email: suggestion,
            back: back && originFrom(back) !== originOf(e) ? back : null,
          });
        }
        throw new Refusal(
          400,
          'invalid_input',
          suggestion ? `${EMAIL_CHECK_REFUSAL} Did you mean ${suggestion}?` : EMAIL_CHECK_REFUSAL,
          [{ path: 'email', message: EMAIL_CHECK_REFUSAL }],
          suggestion,
        );
      }
      // First-touch and current-touch attribution is stored only with its flag on.
      const attribution =
        input.attribution &&
        (await channelFlag(
          e,
          { workspaceId: form.workspaceId, channelId: form.channelId },
          'subscribe_attribution_fields',
        ))
          ? input.attribution
          : null;
      // Chosen now so the journey and join tokens can name the row this sign-up adds. An address
      // already on the list keeps its own id, so those tokens find no Member and write nothing.
      const memberId = newId('member');
      // Encrypted answers are sealed by the vault for the Member this sign-up creates, before the
      // visitor gets an answer: with the vault down the sign-up fails (503) rather than storing
      // them any other way, or losing them after a success.
      const encrypted = Object.fromEntries(
        fields.filter((f) => f.def.encrypted && f.value !== null).map((f) => [f.def.key, f.value]),
      );
      let sealed: Record<string, string> = {};
      if (Object.keys(encrypted).length) {
        const result = await captureVault(e).sealSignupFields({
          formId: form.id,
          memberId,
          values: encrypted,
        });
        if (!result.ok) {
          throw new Refusal(
            503,
            'unavailable',
            'Signing up is not available right now. Try again.',
          );
        }
        sealed = result.value;
      }
      const answer = await successFor(e, form, email, memberId, joinOrigin);
      // The visitor has their answer by now, so a busy database must not lose the sign-up. Running
      // it again is safe: it finds the address it may already have added.
      later(
        c,
        retryWhileBusy(() =>
          subscribe(
            { ...audienceDeps(e), sealSignup: async () => sealed },
            {
              channelId: form.channelId,
              workspaceId: form.workspaceId,
              formId: form.id,
              email,
              memberId,
              firstName: input.firstName,
              lastName: input.lastName,
              fields,
              // So does an address whose email check colour asks for confirmation.
              doubleOptIn: mustConfirm || check?.action === 'confirm',
              ...(attribution ? { attribution } : {}),
              ref: input.ref,
              ip: c.req.header('cf-connecting-ip') ?? null,
              consent: {
                source: 'form',
                formId: form.id,
                formVersion: shown.version,
                wording: shown.config.consent?.text ?? null,
                ticked: shown.config.consent ? input.consent : null,
                versionClaimed: named !== null && stamp === null,
                stampedAt: stamp?.issuedAt ?? null,
                verifiedHost,
                claimedOrigin: input.hostOrigin,
              },
            },
          ),
        ).then(async (result) => {
          log.info('capture form submission', { formId: form.id, outcome: result.outcome });
          // The check's result is kept only for someone on the list; a tag only for a new Member.
          if (check && result.memberId) {
            const created =
              result.outcome === 'created_active' || result.outcome === 'created_pending';
            await afterJoin(e.DB, {
              workspaceId: form.workspaceId,
              channelId: form.channelId,
              memberId: created ? result.memberId : null,
              check,
            }).catch((error: Error) =>
              log.warn('email check result not saved', { error: error.message }),
            );
          }
        }),
      );
      // Section analytics: a signup through the site's own form in a home page section, counted
      // like the form's submissions (for every address, known or not).
      if (input.siteSection) {
        later(c, countSectionSignup(e, form, input.hostOrigin, input.siteSection));
      }
      refreshCircles(c, form.channelId);
      return respond(c, answer, json);
    } catch (error) {
      if (error instanceof Refusal) return refuse(error, form);
      throw error;
    }
  });
}

function respond(
  c: AppContext,
  answer: { message: string | null; redirect: string | null; journey: string | null },
  json: boolean,
): Response {
  if (json) return c.json({ data: { ok: true, ...answer } }, 200);
  if (answer.journey) {
    return new Response(null, {
      status: 303,
      headers: { location: answer.journey, 'cache-control': 'no-store' },
    });
  }
  if (answer.redirect) {
    return new Response(null, {
      status: 303,
      headers: { location: answer.redirect, 'cache-control': 'no-store' },
    });
  }
  return page('Thank you', `<h1>Thank you</h1><p>${h(answer.message ?? '')}</p>`);
}
