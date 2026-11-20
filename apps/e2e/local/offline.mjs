// What keeps an e2e run on this machine. The stack runs with Cloudflare's Turnstile test keys,
// and those still call Cloudflare: the browser loads the widget from challenges.cloudflare.com and
// the api, capture and site workers post every token to its siteverify. Here both are answered
// locally, the way Cloudflare answers the always-passing test keys, and any other request for a
// host off this machine is refused instead of sent.

/** The token Cloudflare's test site keys hand out. */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** Cloudflare's always-passing Turnstile test secret; the other test secrets fail. */
const PASSING_SECRET = /^1x0{30,}AA$/;

/** localhost, *.localhost (the publication websites) and the loopback addresses. */
export function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Cloudflare's answer to a siteverify call with a test secret, without calling Cloudflare. */
export function siteverify(form) {
  const secret = form.get('secret');
  const token = form.get('response');
  const pass = typeof secret === 'string' && PASSING_SECRET.test(secret) && token === DUMMY_TOKEN;
  return Response.json({
    success: pass,
    'error-codes': pass ? [] : ['invalid-input-response'],
    ...(pass
      ? { challenge_ts: new Date().toISOString(), hostname: 'example.com', action: '', cdata: '' }
      : {}),
    metadata: { interactive: false },
  });
}

/**
 * The widget script, standing in for https://challenges.cloudflare.com/turnstile/v0/api.js. Like
 * Cloudflare's with a test site key: the always-passing keys (1x…) solve at once and put the dummy
 * token in a hidden cf-turnstile-response field; other keys report an error. Renders .cf-turnstile
 * elements itself unless loaded with ?render=explicit, and calls ?onload=.
 */
export const WIDGET_SCRIPT = `(function () {
  var TOKEN = ${JSON.stringify(DUMMY_TOKEN)};
  var PASSING_KEY = /^1x0+(AA|BB)$/;
  var src = document.currentScript ? new URL(document.currentScript.src) : null;
  var widgets = {};
  var count = 0;
  function call(fn, arg) {
    if (typeof fn === 'string') fn = window[fn];
    if (typeof fn === 'function') fn(arg);
  }
  function solve(id) {
    var w = widgets[id];
    if (!w) return;
    if (PASSING_KEY.test(w.sitekey || '')) {
      w.input.value = TOKEN;
      call(w.callback, TOKEN);
    } else {
      call(w.error, '110100');
    }
  }
  function find(target) {
    if (target === undefined) return Object.keys(widgets);
    if (typeof target === 'string' && widgets[target]) return [target];
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    return Object.keys(widgets).filter(function (id) { return widgets[id].el === el; });
  }
  function render(target, options) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return undefined;
    var o = options || {};
    var d = el.dataset || {};
    var id = 'cf-chl-widget-' + ++count;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = o['response-field-name'] || d.responseFieldName || 'cf-turnstile-response';
    input.id = id + '_response';
    el.appendChild(input);
    widgets[id] = {
      el: el,
      input: input,
      sitekey: o.sitekey || d.sitekey,
      callback: o.callback || d.callback,
      error: o['error-callback'] || d.errorCallback,
    };
    setTimeout(function () { solve(id); }, 50);
    return id;
  }
  window.turnstile = {
    render: render,
    ready: function (fn) { fn(); },
    execute: function (target) { find(target).forEach(solve); },
    reset: function (target) {
      find(target).forEach(function (id) {
        widgets[id].input.value = '';
        setTimeout(function () { solve(id); }, 50);
      });
    },
    remove: function (target) {
      find(target).forEach(function (id) {
        widgets[id].input.remove();
        delete widgets[id];
      });
    },
    getResponse: function (target) {
      var id = find(target)[0];
      return id ? widgets[id].input.value : undefined;
    },
    isExpired: function () { return false; },
  };
  function auto() {
    document.querySelectorAll('.cf-turnstile').forEach(function (el) {
      if (!find(el).length) render(el);
    });
  }
  if (!src || src.searchParams.get('render') !== 'explicit') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
    else auto();
  }
  var onload = src && src.searchParams.get('onload');
  if (onload) setTimeout(function () { call(onload); }, 0);
})();
`;
