// The form iframe: rendered from a published version, mounted by the loader from any allowed site.
//
// Inside the frame:
// - the parent's origin is learned from the `swarm:init` message (event.origin, which the browser
//   sets and a page can't forge) and checked against the form's allowlist; every message back is
//   sent to that origin only;
// - the Turnstile managed widget runs here, so the challenge appears inline when it is needed;
// - text from the server is set with textContent only.
// The CSP's frame-ancestors repeats the allowlist, so a foreign site can't even display the frame.
import { consentHtml, textOn } from '@swarm/domain';
import { scriptJson } from '@swarm/engine';
import type { FormFieldDef, PublishedForm } from './forms';
import { h, safeAccent, TURNSTILE_SCRIPT } from './pages';

const FRAME_SCRIPT = String.raw`(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('swarm-form').textContent);
  var form = document.getElementById('form');
  var status = document.getElementById('status');
  var button = form.querySelector('button[type=submit]');
  // Email checks: DeBounce's suggested spelling, offered as a button that fills the field in.
  var suggest = document.getElementById('suggest');
  var embedded = window.parent !== window;
  var parentOrigin = null;
  var init = null;

  function post(message) {
    if (!embedded || !parentOrigin) return;
    message.form = cfg.id;
    window.parent.postMessage(message, parentOrigin);
  }
  function resize() {
    post({ type: 'swarm:resize', height: document.documentElement.scrollHeight });
  }
  function say(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }
  function reveal() {
    document.body.removeAttribute('data-waiting');
    resize();
  }

  window.addEventListener('message', function (e) {
    if (!embedded || e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.type !== 'swarm:init' || m.form !== cfg.id) return;
    if (cfg.allowed.length && cfg.allowed.indexOf(e.origin) === -1) return;
    parentOrigin = e.origin;
    init = m;
    reveal();
  });
  if (!embedded) {
    if (cfg.allowed.length) {
      form.setAttribute('hidden', '');
      say('This form can only be used on the site it belongs to.', 'error');
    }
    reveal();
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(document.body);

  // Turnstile loads after the frame's load event, not before it. The loader only introduces itself
  // on that event, so a script in the head would hold the whole form back (hidden) for as long as
  // Cloudflare's script takes to arrive.
  window.addEventListener('load', function () {
    var widget = document.createElement('script');
    widget.src = cfg.turnstile;
    widget.async = true;
    document.head.appendChild(widget);
  });

  suggest.addEventListener('click', function () {
    var field = form.querySelector('input[name=email]');
    field.value = suggest.getAttribute('data-email') || field.value;
    suggest.setAttribute('hidden', '');
    say('');
    field.focus();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (embedded && !parentOrigin) return;
    send(0);
  });

  // The managed widget may still be working out its token; wait for it rather than fail.
  function send(attempt) {
    var data = new FormData(form);
    if (!data.get('cf-turnstile-response') && attempt < 20) {
      button.disabled = true;
      say('Checking that you are a person…');
      return setTimeout(function () {
        send(attempt + 1);
      }, 500);
    }
    var body = {
      email: data.get('email') || '',
      firstName: data.get('firstName'),
      lastName: data.get('lastName'),
      consent: data.get('consent') === 'yes',
      formVersion: cfg.version,
      formStamp: cfg.stamp,
      website: data.get('website') || '',
      turnstileToken: data.get('cf-turnstile-response'),
      parentOrigin: parentOrigin,
      attribution: init && init.attribution ? init.attribution : null,
      ref: init && typeof init.ref === 'string' ? init.ref : null,
      fields: {},
    };
    data.forEach(function (value, name) {
      if (name.indexOf('f.') !== 0 || typeof value !== 'string') return;
      var key = name.slice(2);
      if (cfg.multi.indexOf(key) !== -1) (body.fields[key] = body.fields[key] || []).push(value);
      else body.fields[key] = value;
    });
    button.disabled = true;
    say('Sending…');
    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, json: json };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var error = result.json && result.json.error ? result.json.error : null;
          var message = error ? error.message : '';
          say(message || 'That did not work. Try again.', 'error');
          if (error && typeof error.suggestion === 'string' && error.suggestion) {
            suggest.textContent = 'Use ' + error.suggestion;
            suggest.setAttribute('data-email', error.suggestion);
            suggest.removeAttribute('hidden');
          } else {
            suggest.setAttribute('hidden', '');
          }
          button.disabled = false;
          if (window.turnstile) window.turnstile.reset();
          return;
        }
        var redirect = result.json.data.redirect;
        if (redirect && !embedded) return window.location.assign(redirect);
        var journey = result.json.data.journey;
        if (journey && journey.indexOf('/v1/j/') === 0) {
          post({ type: 'swarm:joined', redirect: null });
          // The journey page can't report its height, so make room for it.
          post({ type: 'swarm:resize', height: Math.max(document.documentElement.scrollHeight, 560) });
          return window.location.assign(journey);
        }
        form.setAttribute('hidden', '');
        say(result.json.data.message || '', 'done');
        post({ type: 'swarm:joined', redirect: redirect || null });
      })
      .catch(function () {
        say('That did not work. Check your connection and try again.', 'error');
        button.disabled = false;
      });
  }
})();
`;

const FRAME_STYLE = `*{box-sizing:border-box}html,body{margin:0;background:transparent}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12}
body[data-waiting] main{visibility:hidden}
main{padding:24px;background:#fff;border:1px solid #efedf6;border-radius:16px}
h1{font-size:20px;letter-spacing:-0.02em;margin:0 0 8px}
p{font-size:14px;line-height:1.5;color:#3a3a44;margin:0 0 14px}
label,legend{display:block;font-size:13px;font-weight:500;margin:0 0 10px}
input[type=text],input[type=email],input[type=number],input[type=date],select{display:block;width:100%;margin-top:4px;font:inherit;font-size:15px;padding:10px 12px;border:1px solid #e7e5ee;border-radius:10px;background:transparent;color:inherit}
fieldset{border:0;padding:0;margin:0 0 10px}
.choice{display:flex;gap:8px;align-items:flex-start;font-weight:400}
.choice a{color:inherit;text-decoration:underline}
button{font:inherit;font-weight:600;font-size:15px;color:var(--on-accent,#fff);background:var(--accent);border:0;border-radius:999px;padding:11px 20px;min-height:44px;cursor:pointer;width:100%}
button:disabled{opacity:.6;cursor:default}
button.suggest{width:auto;min-height:36px;margin-top:8px;padding:6px 14px;font-size:14px;color:inherit;background:transparent;border:1px solid currentColor}
button[hidden]{display:none}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
#status{font-size:14px;margin:10px 0 0}#status.error{color:#b5401f}#status.done{color:#1f7a4d;font-weight:600}
.dark #status.error{color:#ffb39e}.dark #status.done{color:#8fd6ab}
@media (prefers-color-scheme:dark){.auto #status.error{color:#ffb39e}.auto #status.done{color:#8fd6ab}}
.slim main{padding:14px}.slim form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}.slim form>*{margin:0}.slim label{flex:1 1 200px}.slim button{width:auto}
.slim .cf-turnstile{flex-basis:100%}
p.joining{font-size:12px;margin:10px 0 0;flex-basis:100%}
@media (prefers-color-scheme:dark){.auto main{background:#17171c;border-color:#2a2a33;color:#f4f3f8}.auto p{color:#c9c8d3}.auto input,.auto select{border-color:#2a2a33}}
.dark main{background:#17171c;border-color:#2a2a33;color:#f4f3f8}.dark p{color:#c9c8d3}.dark input,.dark select{border-color:#2a2a33}`;

function fieldHtml(
  field: PublishedForm['config']['fields'][number],
  defs: Map<string, FormFieldDef>,
): string {
  const req = field.required ? ' required' : '';
  const ph = field.placeholder ? ` placeholder="${h(field.placeholder)}"` : '';
  const label = h(field.label);
  if (field.key === 'email') {
    return `<label>${label}<input type="email" name="email" autocomplete="email"${ph} required maxlength="254"></label>`;
  }
  if (field.key === 'first_name' || field.key === 'last_name') {
    const name = field.key === 'first_name' ? 'firstName' : 'lastName';
    const auto = field.key === 'first_name' ? 'given-name' : 'family-name';
    return `<label>${label}<input type="text" name="${name}" autocomplete="${auto}"${ph}${req} maxlength="80"></label>`;
  }
  const def = defs.get(field.key.slice('field:'.length));
  if (!def) return '';
  const name = `f.${def.key}`;
  switch (def.type) {
    case 'number':
      return `<label>${label}<input type="number" name="${h(name)}" step="any"${ph}${req}></label>`;
    case 'date':
      return `<label>${label}<input type="date" name="${h(name)}"${req}></label>`;
    case 'boolean':
      return `<label class="choice"><input type="checkbox" name="${h(name)}" value="yes"${req}> ${label}</label>`;
    case 'select':
      if (field.display === 'radio') {
        return `<fieldset><legend>${label}</legend>${def.options
          .map(
            (o) =>
              `<label class="choice"><input type="radio" name="${h(name)}" value="${h(o)}"${req}> ${h(o)}</label>`,
          )
          .join('')}</fieldset>`;
      }
      return `<label>${label}<select name="${h(name)}"${req}><option value="">Choose…</option>${def.options
        .map((o) => `<option>${h(o)}</option>`)
        .join('')}</select></label>`;
    case 'multi_select':
      return `<fieldset><legend>${label}</legend>${def.options
        .map(
          (o) =>
            `<label class="choice"><input type="checkbox" name="${h(name)}" value="${h(o)}"> ${h(o)}</label>`,
        )
        .join('')}</fieldset>`;
    default:
      return `<label>${label}<input type="text" name="${h(name)}"${ph}${req} maxlength="2000"></label>`;
  }
}

/** The frame-ancestors source list for an allowlist (any site when it is empty). */
export function frameAncestors(allowed: readonly string[]): string {
  return allowed.length ? allowed.join(' ') : '*';
}

export function framePage(input: {
  form: PublishedForm;
  defs: Map<string, FormFieldDef>;
  siteKey: string;
  nonce: string;
  /** consents.ts formStamp for this form and version. */
  stamp: string;
}): Response {
  const { form, defs } = input;
  const { config } = form;
  const multi = [...defs.values()].filter((d) => d.type === 'multi_select').map((d) => d.key);
  const clientConfig = {
    id: form.id,
    version: form.version,
    stamp: input.stamp,
    allowed: config.allowedOrigins,
    multi,
    turnstile: TURNSTILE_SCRIPT,
  };
  const theme = config.theme.mode;
  const fields = config.fields.map((f) => fieldHtml(f, defs)).join('\n');
  const consent = config.consent
    ? `<label class="choice"><input type="checkbox" name="consent" value="yes"${config.consent.required ? ' required' : ''}> ${consentHtml(config.consent.text)}</label>`
    : '';
  const intro =
    config.layout === 'slim'
      ? ''
      : `${config.copy.heading ? `<h1>${h(config.copy.heading)}</h1>` : ''}${config.copy.body ? `<p>${h(config.copy.body)}</p>` : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${h(config.copy.heading || form.channelName)}</title>
<style>${FRAME_STYLE}:root{--accent:${safeAccent(form.accent)};--on-accent:${textOn(safeAccent(form.accent))}}</style>
</head><body class="${config.layout} ${theme}" data-waiting>
<main>${intro}
<form id="form" action="/v1/${form.id}/subscribe" method="post">
${fields}
${consent}
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="cf-turnstile" data-sitekey="${h(input.siteKey)}" data-action="subscribe" data-cdata="${h(form.id)}" data-appearance="interaction-only" data-theme="${theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'auto'}"></div>
<button type="submit">${h(config.copy.button)}</button>
<p class="joining">You are joining <strong>${h(form.channelName)}</strong>.</p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<button type="button" id="suggest" class="suggest" hidden></button>
</main>
<script type="application/json" id="swarm-form">${scriptJson(clientConfig)}</script>
<script nonce="${input.nonce}">${FRAME_SCRIPT}</script>
</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Not cached: every load counts as a view, and a republish shows at once.
      'cache-control': 'private, no-cache',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'nonce-${input.nonce}' https://challenges.cloudflare.com`,
        'frame-src https://challenges.cloudflare.com',
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "form-action 'self'",
        "base-uri 'none'",
        `frame-ancestors ${frameAncestors(config.allowedOrigins)}`,
      ].join('; '),
    },
  });
}
