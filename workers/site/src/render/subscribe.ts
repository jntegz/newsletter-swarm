// Native Capture Forms: the Channel's site form rendered inline in the page (no iframe, no
// script). It posts to the capture worker exactly like the embed's no-JS form does: the same
// action (/v1/<formId>/subscribe), the same field names (email, firstName, lastName, consent=yes)
// and the same `website` honeypot, so the capture worker's checks, Turnstile challenge page and
// success answer all apply unchanged. The honeypot is hidden by a stylesheet class, not an inline
// style (the site CSP forbids inline styles). Both forms carry `data-swarm-subscribe`, so the edge
// can add a Champion's referral code as a hidden `ref` input (edge/referral.ts).
//
// Without a usable published form the page shows a plain email form that posts to
// /_swarm/subscribe, which hands the post to the capture worker (routes/system.ts).
import { consentHtml } from '@swarm/domain';
import type { FormContext } from '@swarm/site-themes';
import type { SiteChannel } from '../context';
import type { SiteEnv } from '../env';
import type { SiteForm } from './data';
import { h } from './html';

const FIELD_NAMES: Record<string, { name: string; type: string; autocomplete: string }> = {
  email: { name: 'email', type: 'email', autocomplete: 'email' },
  first_name: { name: 'firstName', type: 'text', autocomplete: 'given-name' },
  last_name: { name: 'lastName', type: 'text', autocomplete: 'family-name' },
};

const HONEYPOT =
  '<div class="sw-hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" value="" tabindex="-1" autocomplete="off"></label></div>';

export const captureAction = (env: SiteEnv, formId: string) =>
  `${env.CAPTURE_ORIGIN.replace(/\/$/, '')}/v1/${encodeURIComponent(formId)}/subscribe`;

/**
 * Inside a section of the published design's home page: the section and the variant drawn, so the
 * capture worker counts the signup for it (docs/site-themes.md, section analytics).
 */
const sectionFields = (context: FormContext | undefined) =>
  context
    ? `<input type="hidden" name="sw_section" value="${h(context.sectionId)}">
<input type="hidden" name="sw_variant" value="${context.variant === 'b' ? 'b' : 'a'}">
`
    : '';

/** The form element alone: the Channel's Capture Form, or the plain fallback. */
export function subscribeForm(env: SiteEnv, form: SiteForm | null, context?: FormContext): string {
  if (!form) {
    return `<form method="post" action="/_swarm/subscribe" data-swarm-subscribe>
<label>Email <input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></label>
${sectionFields(context)}${HONEYPOT}
<button type="submit">Subscribe</button>
</form>`;
  }
  const { config } = form;
  const inputs: string[] = [];
  for (const field of config.fields) {
    const known = FIELD_NAMES[field.key];
    // Profile fields are only asked for in the embed frame; the site form leaves optional ones out.
    if (!known) continue;
    // In steps, the form asks for the address alone and the name comes next.
    if (form.join && field.key !== 'email') continue;
    inputs.push(
      `<label>${h(field.label)} <input type="${known.type}" name="${known.name}" autocomplete="${known.autocomplete}"${field.required ? ' required' : ''}${known.type === 'email' ? ' maxlength="254"' : ' maxlength="200"'}${field.placeholder ? ` placeholder="${h(field.placeholder)}"` : ''}></label>`,
    );
  }
  if (config.consent) {
    inputs.push(
      `<label class="sw-consent"><input type="checkbox" name="consent" value="yes"${config.consent.required ? ' required' : ''}> ${consentHtml(config.consent.text)}</label>`,
    );
  }
  // The page may be a cached copy, so the post says which version's wording the reader saw, with
  // the server's stamp proving it.
  return `<form method="post" action="${h(captureAction(env, form.id))}" data-swarm-subscribe>
${inputs.join('\n')}
<input type="hidden" name="formVersion" value="${form.version}">
${form.stamp ? `<input type="hidden" name="formStamp" value="${h(form.stamp)}">` : ''}
${form.join ? '<input type="hidden" name="join" value="1">' : ''}
${sectionFields(context)}${HONEYPOT}
<button type="submit">${h(config.copy.button)}</button>
</form>`;
}

/** The subscribe section shown at the end of most pages (id "subscribe", the header links to it). */
export function subscribeBlock(env: SiteEnv, channel: SiteChannel, form: SiteForm | null): string {
  const heading = form?.config.copy.heading || `Get ${channel.name} by email`;
  const body =
    form?.config.copy.body ||
    channel.description ||
    'New issues in your inbox. Unsubscribe at any time.';
  return `<section class="sw-subscribe" id="subscribe" aria-labelledby="sw-subscribe-title">
<h2 id="sw-subscribe-title">${h(heading)}</h2>
<p>${h(body)}</p>
${subscribeForm(env, form)}
</section>`;
}
