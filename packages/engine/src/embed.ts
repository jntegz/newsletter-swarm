/**
 * The Capture Form embed: the loader script a site pastes, its SRI hash, the no-JS form and the
 * site-wide first-touch attribution script.
 *
 * The loader is built from a published version's config only, with a fixed key order, so the
 * bytes for (origin, form, version) never change. The api worker hashes these bytes for the
 * snippet's integrity attribute and the capture worker serves the same bytes, which is what makes
 * SRI hold. Change the loader source and every published snippet must be re-copied, so treat the
 * template below as versioned: edit it only together with a note in the release.
 *
 * Rules the loader follows (legacy embed defects that must not return):
 * - document.currentScript is read once, at the top level, while the script runs;
 * - nothing is ever written with innerHTML or similar: elements are created and text is set with
 *   textContent, styles one property at a time;
 * - messages from the iframe are accepted only from the capture origin and from that iframe's
 *   window, and messages to it are sent to the capture origin only.
 */
import { consentHtml, type CaptureFormConfig } from '@swarm/domain';
import { escapeHtml } from '@swarm/mail';
import type { FieldDef } from './fields';

export interface LoaderConfig {
  id: string;
  v: number;
  origin: string;
  layout: CaptureFormConfig['layout'];
  placement: CaptureFormConfig['placement'];
  trigger: CaptureFormConfig['trigger'];
  frequency: CaptureFormConfig['frequency'];
  title: string;
  closeLabel: string;
}

/** The subset of a config the loader needs, in a fixed key order. */
export function loaderConfig(
  origin: string,
  formId: string,
  version: number,
  config: CaptureFormConfig,
): LoaderConfig {
  const t = config.trigger;
  const trigger: CaptureFormConfig['trigger'] =
    t.type === 'delay'
      ? { type: t.type, seconds: t.seconds }
      : t.type === 'scroll'
        ? { type: t.type, percent: t.percent }
        : t.type === 'element_visible' || t.type === 'click'
          ? { type: t.type, selector: t.selector }
          : t.type === 'event'
            ? { type: t.type, name: t.name }
            : { type: t.type };
  const f = config.frequency;
  return {
    id: formId,
    v: version,
    origin: origin.replace(/\/$/, ''),
    layout: config.layout,
    placement: config.placement,
    trigger,
    frequency: f.type === 'once_per_days' ? { type: f.type, days: f.days } : { type: f.type },
    title: config.copy.heading || 'Sign-up form',
    closeLabel: 'Close',
  };
}

/** JSON that is also safe inside any script context. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

const LOADER_BODY = String.raw`
  var KEY = 'swarm:cf:' + C.id;
  var overlay = C.placement !== 'inline';
  var registry = (window.__swarmForms = window.__swarmForms || {});
  if (overlay && registry[C.id]) return;
  registry[C.id] = true;

  // Frequency and "joined" marks: localStorage, else sessionStorage (a session-only rule), else
  // this page view only.
  var memory = {};
  function probe(name) {
    try {
      var s = window[name];
      s.setItem('__swarm__', '1');
      s.removeItem('__swarm__');
      return s;
    } catch (e) {
      return null;
    }
  }
  var store = probe('localStorage') || probe('sessionStorage');
  function get(key) {
    try {
      if (store) return store.getItem(key);
    } catch (e) {}
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }
  function set(key, value) {
    try {
      if (store) return store.setItem(key, value);
    } catch (e) {}
    memory[key] = value;
  }
  function allowed() {
    if (overlay && get(KEY + ':joined')) return false;
    if (C.frequency.type === 'once_per_days') {
      var last = Number(get(KEY + ':seen'));
      if (last && Date.now() - last < C.frequency.days * 86400000) return false;
    }
    return true;
  }

  // Attribution: the first touch recorded by attr.js, and this page.
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FIRST = UTM.concat(['referrer', 'first_url']);
  function params() {
    try {
      return new URLSearchParams(window.location.search);
    } catch (e) {
      return null;
    }
  }
  function firstTouch() {
    var raw = null;
    try {
      raw = window.localStorage.getItem('swarm:ft');
    } catch (e) {}
    if (!raw) {
      var m = /(?:^|;\s*)swarm_ft=([^;]*)/.exec(document.cookie || '');
      try {
        raw = m ? decodeURIComponent(m[1]) : null;
      } catch (e) {}
    }
    try {
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function attribution() {
    var p = params();
    var ft = firstTouch();
    var first = {};
    var current = { current_url: String(window.location.href).slice(0, 2048) };
    for (var i = 0; i < FIRST.length; i++) {
      if (typeof ft[FIRST[i]] === 'string') first[FIRST[i]] = ft[FIRST[i]].slice(0, 2048);
    }
    for (var j = 0; j < UTM.length; j++) {
      var value = p && p.get(UTM[j]);
      if (value) current[UTM[j]] = value.slice(0, 200);
    }
    if (document.referrer) current.referrer = String(document.referrer).slice(0, 2048);
    return { first: first, current: current };
  }
  function referral() {
    var p = params();
    var ref = (p && p.get('ref')) || firstTouch().ref;
    return typeof ref === 'string' && /^(mb_[0-9a-f]{32}|[a-hjkmnp-z2-9]{8})$/.test(ref) ? ref : null;
  }

  function css(node, styles) {
    for (var k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) node.style.setProperty(k, styles[k]);
    }
    return node;
  }
  function find(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }
  function within(node, selector) {
    try {
      return !!(node && node.nodeType === 1 && node.closest(selector));
    } catch (e) {
      return false;
    }
  }
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  var shown = false;
  var wrap = null;
  var frame = null;
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function close() {
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    document.removeEventListener('keydown', onKey);
    wrap = null;
    frame = null;
  }
  function makeFrame(height) {
    var f = document.createElement('iframe');
    f.src = C.origin + '/v1/' + C.id + '/frame?v=' + C.v;
    f.title = C.title;
    f.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    f.setAttribute('referrerpolicy', 'strict-origin');
    css(f, { border: '0', width: '100%', height: height + 'px', display: 'block' });
    f.addEventListener('load', function () {
      if (!f.contentWindow) return;
      f.contentWindow.postMessage(
        { type: 'swarm:init', form: C.id, attribution: attribution(), ref: referral() },
        C.origin,
      );
    });
    return f;
  }
  function show() {
    if (shown || !allowed()) return;
    shown = true;
    set(KEY + ':seen', String(Date.now()));
    var slim = C.layout === 'slim';
    frame = makeFrame(slim ? 96 : 320);
    wrap = document.createElement('div');
    wrap.setAttribute('data-swarm-capture', C.id);
    if (!overlay) {
      css(wrap, { width: '100%', 'max-width': slim ? '720px' : '480px', margin: '0 auto' });
      wrap.appendChild(frame);
      var host = find('[data-swarm-form="' + C.id + '"]');
      if (host) host.appendChild(wrap);
      else if (script && script.parentNode) script.parentNode.insertBefore(wrap, script.nextSibling);
      else shown = false;
      return;
    }
    var box = css(document.createElement('div'), {
      position: 'relative',
      overflow: 'hidden',
      'border-radius': '16px',
      'box-shadow': '0 12px 40px rgba(15, 15, 18, 0.18)',
    });
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', C.closeLabel);
    css(x, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      width: '32px',
      height: '32px',
      border: '0',
      'border-radius': '999px',
      background: 'rgba(15, 15, 18, 0.08)',
      color: '#0f0f12',
      font: '20px/1 system-ui, sans-serif',
      cursor: 'pointer',
    });
    x.addEventListener('click', close);
    box.appendChild(frame);
    box.appendChild(x);
    wrap.appendChild(box);
    css(wrap, { position: 'fixed', 'z-index': '2147483000' });
    if (C.placement === 'popup') {
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', C.title);
      css(wrap, {
        inset: '0',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        padding: '16px',
        background: 'rgba(15, 15, 18, 0.45)',
      });
      css(box, { width: '100%', 'max-width': slim ? '560px' : '440px' });
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) close();
      });
    } else if (C.placement === 'slide_in_left' || C.placement === 'slide_in_right') {
      wrap.setAttribute('role', 'complementary');
      wrap.setAttribute('aria-label', C.title);
      css(wrap, { bottom: '16px', width: 'min(380px, calc(100vw - 32px))' });
      wrap.style.setProperty(C.placement === 'slide_in_left' ? 'left' : 'right', '16px');
    } else {
      wrap.setAttribute('role', 'complementary');
      wrap.setAttribute('aria-label', C.title);
      css(wrap, { left: '0', right: '0' });
      css(box, { 'border-radius': '0' });
      wrap.style.setProperty(C.placement === 'sticky_top' ? 'top' : 'bottom', '0');
    }
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey);
    if (C.placement === 'popup') x.focus();
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== C.origin || !frame || e.source !== frame.contentWindow) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.form !== C.id || typeof m.type !== 'string') return;
    if (m.type === 'swarm:resize' && typeof m.height === 'number' && isFinite(m.height)) {
      frame.style.setProperty('height', Math.max(48, Math.min(1200, Math.ceil(m.height))) + 'px');
    } else if (m.type === 'swarm:close') {
      close();
    } else if (m.type === 'swarm:joined') {
      set(KEY + ':joined', '1');
      if (typeof m.redirect === 'string') {
        try {
          var url = new URL(m.redirect);
          if (url.protocol === 'https:') window.location.assign(url.href);
        } catch (err) {}
      }
    }
  });

  function once(fn) {
    var done = false;
    return function () {
      if (done) return;
      done = true;
      fn();
    };
  }
  function whenScrolled(test, go) {
    function check() {
      if (!test()) return;
      window.removeEventListener('scroll', check);
      go();
    }
    window.addEventListener('scroll', check, { passive: true });
    return check;
  }
  function depth() {
    var d = document.documentElement;
    var max = d.scrollHeight - window.innerHeight;
    return max <= 0 ? 1 : window.pageYOffset / max;
  }

  var t = C.trigger;
  var go = once(show);
  ready(function () {
    if (t.type === 'immediate') go();
    else if (t.type === 'delay') setTimeout(go, t.seconds * 1000);
    else if (t.type === 'scroll') {
      whenScrolled(function () {
        return depth() * 100 >= t.percent;
      }, go)();
    } else if (t.type === 'element_visible') {
      var target = find(t.selector);
      if (!target) return;
      if (!('IntersectionObserver' in window)) return go();
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            io.disconnect();
            return go();
          }
        }
      });
      io.observe(target);
    } else if (t.type === 'click') {
      document.addEventListener(
        'click',
        function handler(e) {
          if (!within(e.target, t.selector)) return;
          document.removeEventListener('click', handler, true);
          go();
        },
        true,
      );
    } else if (t.type === 'event') {
      window.addEventListener(t.name, go);
      document.addEventListener(t.name, go);
    } else if (t.type === 'exit_intent') {
      document.addEventListener('mouseout', function handler(e) {
        if (e.relatedTarget || e.clientY > 0) return;
        document.removeEventListener('mouseout', handler);
        go();
      });
    } else if (t.type === 'scroll_velocity') {
      // A fast scroll back up after reading a third of the page usually means leaving.
      var lastY = window.pageYOffset;
      var lastT = Date.now();
      var deepest = 0;
      whenScrolled(function () {
        var y = window.pageYOffset;
        var now = Date.now();
        deepest = Math.max(deepest, depth());
        var velocity = (y - lastY) / Math.max(1, now - lastT);
        lastY = y;
        lastT = now;
        return deepest >= 0.3 && velocity <= -1.5;
      }, go);
    }
  });
`;

/** The exact bytes served at /v1/<formId>.js?v=<version>. */
export function buildEmbedScript(config: LoaderConfig): string {
  return `/*! Swarm capture form ${config.id} v${config.v} */
(function () {
  'use strict';
  // Read once, at the top level, while this script runs: afterwards the browser reports null.
  var script = document.currentScript;
  var C = ${scriptJson(config)};
${LOADER_BODY}})();
`;
}

/** Site-wide first-touch attribution, served at /v1/attr.js. First-party storage only. */
export const ATTRIBUTION_SCRIPT = String.raw`/*! Swarm first-touch attribution */
(function () {
  'use strict';
  var KEY = 'swarm:ft';
  try {
    if (window.localStorage.getItem(KEY)) return;
  } catch (e) {}
  if (/(?:^|;\s*)swarm_ft=/.test(document.cookie || '')) return;
  var p;
  try {
    p = new URLSearchParams(window.location.search);
  } catch (e) {
    return;
  }
  var touch = { first_url: String(window.location.href).slice(0, 2048) };
  try {
    if (document.referrer && new URL(document.referrer).host !== window.location.host) {
      touch.referrer = String(document.referrer).slice(0, 2048);
    }
  } catch (e) {}
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  for (var i = 0; i < UTM.length; i++) {
    var value = p.get(UTM[i]);
    if (value) touch[UTM[i]] = value.slice(0, 200);
  }
  var ref = p.get('ref');
  if (ref && /^(mb_[0-9a-f]{32}|[a-hjkmnp-z2-9]{8})$/.test(ref)) touch.ref = ref;
  var json = JSON.stringify(touch);
  try {
    window.localStorage.setItem(KEY, json);
    return;
  } catch (e) {}
  try {
    document.cookie =
      'swarm_ft=' + encodeURIComponent(json) + '; path=/; max-age=31536000; SameSite=Lax' +
      (window.location.protocol === 'https:' ? '; Secure' : '');
  } catch (e) {}
})();
`;

/** Subresource Integrity value (sha384) for exact bytes. */
export async function integrityOf(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(source));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha384-${btoa(binary)}`;
}

export interface EmbedSnippet {
  version: number;
  scriptUrl: string;
  integrity: string;
  script: string;
  noscript: string;
  attribution: string;
}

/** A profile field's definition, as far as the no-JS form needs it. */
export type SnippetFieldDef = Pick<FieldDef, 'key' | 'type' | 'options'>;

/**
 * One field of the no-JS form, with the names the subscribe endpoint reads: email, firstName,
 * lastName and `f.<key>` for profile fields (repeated for multi-select), the same as the form
 * frame posts. A profile field without a definition (deleted since publishing) is left out.
 */
function noscriptInput(
  field: CaptureFormConfig['fields'][number],
  defs: ReadonlyMap<string, SnippetFieldDef>,
): string {
  const req = field.required ? ' required' : '';
  const ph = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const label = escapeHtml(field.label);
  if (field.key === 'email' || field.key === 'first_name' || field.key === 'last_name') {
    const name =
      field.key === 'email' ? 'email' : field.key === 'first_name' ? 'firstName' : 'lastName';
    const type = field.key === 'email' ? 'email' : 'text';
    const autocomplete =
      field.key === 'email' ? 'email' : field.key === 'first_name' ? 'given-name' : 'family-name';
    return `  <label>${label} <input type="${type}" name="${name}" autocomplete="${autocomplete}"${req}${ph}></label>`;
  }
  const def = defs.get(field.key.slice('field:'.length));
  if (!def) return '';
  const name = escapeHtml(`f.${def.key}`);
  const choices = (type: 'radio' | 'checkbox', required: string) =>
    `  <fieldset><legend>${label}</legend>${def.options
      .map(
        (o) =>
          `<label><input type="${type}" name="${name}" value="${escapeHtml(o)}"${required}> ${escapeHtml(o)}</label>`,
      )
      .join('')}</fieldset>`;
  switch (def.type) {
    case 'number':
      return `  <label>${label} <input type="number" name="${name}" step="any"${req}${ph}></label>`;
    case 'date':
      return `  <label>${label} <input type="date" name="${name}"${req}></label>`;
    case 'boolean':
      return `  <label><input type="checkbox" name="${name}" value="yes"${req}> ${label}</label>`;
    case 'select':
      if (field.display === 'radio') return choices('radio', req);
      return `  <label>${label} <select name="${name}"${req}><option value="">Choose…</option>${def.options
        .map((o) => `<option>${escapeHtml(o)}</option>`)
        .join('')}</select></label>`;
    case 'multi_select':
      // A browser can't require "at least one" checkbox; the server checks it.
      return choices('checkbox', '');
    default:
      return `  <label>${label} <input type="text" name="${name}" maxlength="2000"${req}${ph}></label>`;
  }
}

/**
 * Everything the dashboard shows under "Embed": the script tag, the no-JS form, attr.js. `defs`
 * are the Channel's profile fields by key; the no-JS form renders the ones the config uses.
 */
export async function embedSnippet(
  origin: string,
  formId: string,
  version: number,
  config: CaptureFormConfig,
  defs: ReadonlyMap<string, SnippetFieldDef> = new Map(),
): Promise<EmbedSnippet> {
  const loader = loaderConfig(origin, formId, version, config);
  const scriptUrl = `${loader.origin}/v1/${formId}.js?v=${version}`;
  const integrity = await integrityOf(buildEmbedScript(loader));
  const attrIntegrity = await integrityOf(ATTRIBUTION_SCRIPT);

  const inputs = config.fields.map((field) => noscriptInput(field, defs)).filter(Boolean);
  if (config.consent) {
    inputs.push(
      `  <label><input type="checkbox" name="consent" value="yes"${config.consent.required ? ' required' : ''}> ${consentHtml(config.consent.text)}</label>`,
    );
  }
  const noscript = [
    `<form action="${loader.origin}/v1/${formId}/subscribe" method="post">`,
    ...inputs,
    '  <input type="text" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-10000px">',
    // The consent record keeps the wording of the version this snippet was copied from.
    `  <input type="hidden" name="formVersion" value="${version}">`,
    // Attribution without JavaScript: fill these in per page, or leave them empty.
    ...['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'].map(
      (name) => `  <input type="hidden" name="${name}" value="">`,
    ),
    `  <button type="submit">${escapeHtml(config.copy.button)}</button>`,
    '</form>',
  ].join('\n');

  return {
    version,
    scriptUrl,
    integrity,
    script: `<script async src="${scriptUrl}" integrity="${integrity}" crossorigin="anonymous"></script>`,
    noscript,
    attribution: `<script async src="${loader.origin}/v1/attr.js" integrity="${attrIntegrity}" crossorigin="anonymous"></script>`,
  };
}
