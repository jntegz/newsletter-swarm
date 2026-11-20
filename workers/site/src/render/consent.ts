// The cookie popup and an owner's code (flag site_custom_code). Both are in the cached page, the same
// for every reader, and a small nonce'd script decides in the reader's own browser: it reads their
// choice from a first-party cookie, and only then starts the code they agreed to. Without JavaScript
// nothing runs, so nothing is loaded. A page with code gets a wider CSP (edge/headers.ts).
import {
  parseVerificationTag,
  siteCodeHtml,
  type CodeCategory,
  type SiteCodeEntry,
  type SiteConsent,
} from '@swarm/domain';
import type { SiteEnv } from '../env';
import { h } from './html';

// Every platform site is a sibling host of one domain, and another Channel's owner code can set a
// Domain=<that domain> cookie. __Host- cookies cannot be set from another host, so over https the
// choice lives only there. Plain http (local development) cannot hold __Host- cookies, so it keeps
// the unprefixed name, which was also the name everywhere before.
const CONSENT_COOKIE_SECURE = '__Host-swarm_consent';
const CONSENT_COOKIE_LOCAL = 'swarm_consent';

export const consentCookieName = (env: Pick<SiteEnv, 'SITE_SCHEME'>) =>
  env.SITE_SCHEME === 'https' ? CONSENT_COOKIE_SECURE : CONSENT_COOKIE_LOCAL;

export interface SiteCodeSettings {
  consent: SiteConsent | null;
  code: SiteCodeEntry[];
}

/** Changes when the wording or the code changes, so readers are asked again. */
function consentVersion(settings: SiteCodeSettings): string {
  const text = JSON.stringify([
    settings.consent?.text,
    settings.code.map((e) => [e.category, e.value]),
  ]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Whether a stored choice covers a category, for what the server itself sets (the referral
 * cookie). As in the browser, a choice made on other wording or code counts as no choice.
 */
export function consentAllows(
  cookie: string | undefined,
  category: Exclude<CodeCategory, 'necessary'>,
  settings: SiteCodeSettings,
): boolean {
  const [version, flags = ''] = cookie?.split('.') ?? [];
  if (version !== consentVersion(settings)) return false;
  return flags[category === 'analytics' ? 0 : 1] === '1';
}

/** Verification tags go straight in the page: they load nothing, and crawlers must see them. */
export function verificationTags(code: SiteCodeEntry[]): string {
  return code
    .filter((entry) => entry.preset === 'verification')
    .map((entry) => parseVerificationTag(entry.value))
    .filter((tag) => tag !== null)
    .map((tag) => `<meta name="${h(tag.name)}" content="${h(tag.content)}">`)
    .join('\n');
}

// cfg.k is the cookie name. A choice stored before the __Host- name is carried over once, and only
// if it was this host's own: document.cookie cannot tell a host-only cookie from a Domain= one, so
// the loader deletes the host-only old cookie and keeps the value that went away with it.
const LOADER = `(function(){var d=document,n=d.currentScript.nonce,cfg=JSON.parse(d.getElementById('sw-consent-data').textContent),b=d.getElementById('sw-consent'),open=d.getElementById('sw-consent-open'),K=cfg.k,OLD='${CONSENT_COOKIE_LOCAL}';
function vals(k){return d.cookie.split('; ').filter(function(s){return s.indexOf(k+'=')===0}).map(function(s){return s.slice(k.length+1)})}
function set(k,v,age){d.cookie=k+'='+v+'; Path=/; Max-Age='+age+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'')}
if(K!==OLD&&!vals(K).length){var was=vals(OLD);if(was.length){set(OLD,'',0);var left=vals(OLD),mine=was.filter(function(x){var i=left.indexOf(x);if(i<0)return true;left.splice(i,1);return false});if(mine.length===1)set(K,mine[0],15552000)}}
function read(){var m=vals(K)[0];if(m==null)return null;var p=m.split('.');if(p[0]!==cfg.v||!p[1])return null;return{analytics:p[1].charAt(0)==='1',marketing:p[1].charAt(1)==='1'}}
function write(a,k){set(K,cfg.v+'.'+(a?1:0)+(k?1:0),15552000)}
var ran={};function run(c){cfg.code.forEach(function(e,i){if(ran[i]||(e.c!=='necessary'&&!c[e.c]))return;ran[i]=1;var t=d.createElement('template');t.innerHTML=e.h;[].slice.call(t.content.childNodes).forEach(function(o){if(o.nodeName==='SCRIPT'){var s=d.createElement('script');[].forEach.call(o.attributes,function(a){s.setAttribute(a.name,a.value)});s.nonce=n;s.async=o.async;s.text=o.text;d.head.appendChild(s)}else d.body.appendChild(d.importNode(o,true))})})}
var chosen=read();run(chosen||{});if(!b)return;
function show(){var c=read()||{};[].forEach.call(b.querySelectorAll('[data-sw-cat]'),function(i){i.checked=!!c[i.getAttribute('data-sw-cat')]});b.hidden=false;var f=b.querySelector('button');if(f)f.focus()}
function done(a,k){var had=read();write(a,k);b.hidden=true;if(had&&((had.analytics&&!a)||(had.marketing&&!k))){location.reload();return}run({analytics:a,marketing:k})}
function pick(c){var i=b.querySelector('[data-sw-cat="'+c+'"]');return!!(i&&i.checked)}
b.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-sw-choice]');if(!t)return;var w=t.getAttribute('data-sw-choice');if(w==='all')done(true,true);else if(w==='none')done(false,false);else done(pick('analytics'),pick('marketing'))});
if(open){open.hidden=false;open.addEventListener('click',function(e){e.preventDefault();show()})}
if(!chosen)show()})();`;

const CATEGORY_LABEL: Record<Exclude<CodeCategory, 'necessary'>, string> = {
  analytics: 'Analytics: how people use this site',
  marketing: 'Marketing: ads and where you came from',
};

/** Whether a page has anything to run for a reader, which is what widens its CSP. */
export const hasRunnableCode = (settings: SiteCodeSettings) =>
  settings.code.some((entry) => entry.preset !== 'verification');

/** The popup, the code and the loader, for the end of <body>. */
export function consentMarkup(
  settings: SiteCodeSettings,
  nonce: string,
  env: Pick<SiteEnv, 'SITE_SCHEME'>,
): string {
  const banner = settings.consent?.enabled ? settings.consent : null;
  const runnable = settings.code.filter((entry) => entry.preset !== 'verification');
  if (!banner && !runnable.length) return '';
  const data = {
    v: consentVersion(settings),
    k: consentCookieName(env),
    // Without a popup nobody can agree, so only what the owner marked necessary can run.
    code: runnable
      .filter((entry) => banner || entry.category === 'necessary')
      .map((entry) => ({ c: entry.category, h: siteCodeHtml(entry) })),
  };
  const used = (['analytics', 'marketing'] as const).filter(
    (category) => category === 'marketing' || runnable.some((e) => e.category === category),
  );
  const popup = banner
    ? `<div id="sw-consent" class="sw-consent-box sw-consent-${banner.position}" role="dialog" aria-label="Cookie choices" hidden>
<p>${h(banner.text)}${banner.policyUrl ? ` <a href="${h(banner.policyUrl)}">Cookie policy</a>` : ''}</p>
<fieldset><legend>Choose what to allow</legend>${used
        .map(
          (category) =>
            `<label><input type="checkbox" data-sw-cat="${category}"> ${h(CATEGORY_LABEL[category])}</label>`,
        )
        .join('')}</fieldset>
<div class="sw-consent-actions"><button type="button" data-sw-choice="all">${h(banner.acceptLabel)}</button><button type="button" data-sw-choice="none">${h(banner.rejectLabel)}</button><button type="button" data-sw-choice="some">Save my choices</button></div>
</div>`
    : '';
  // Escaped as JSON-LD is: nothing in the owner's code can close this element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `${popup}
<script type="application/json" id="sw-consent-data" nonce="${h(nonce)}">${json}</script>
<script nonce="${h(nonce)}">${LOADER}</script>`;
}

/** The popup's own colours, for the page's nonce'd style element. */
export function consentCss(consent: SiteConsent | null): string {
  if (!consent?.enabled) return '';
  const rules = [
    consent.background ? `background:${consent.background}` : '',
    consent.textColor ? `color:${consent.textColor}` : '',
  ].filter(Boolean);
  return rules.length ? `.sw-consent-box{${rules.join(';')}}` : '';
}

export const CONSENT_CSS = `.sw-consent-box{position:fixed;z-index:30;left:16px;right:16px;bottom:16px;max-width:680px;margin:0 auto;padding:20px;background:var(--surface);color:var(--text);border:1px solid var(--line-strong);border-radius:14px;box-shadow:0 12px 40px rgba(15,15,18,.2);font-size:15px}
.sw-consent-box[hidden]{display:none}
.sw-consent-box p{margin:0 0 10px}
.sw-consent-box a{color:inherit}
.sw-consent-box fieldset{border:0;margin:0 0 14px;padding:0;display:grid;gap:6px}
.sw-consent-box legend{font-weight:600;padding:0;margin-bottom:4px}
.sw-consent-box label{display:flex;gap:8px;align-items:flex-start;font-size:14px}
.sw-consent-actions{display:flex;flex-wrap:wrap;gap:10px}
.sw-consent-actions button{flex:1 1 140px;min-height:44px;font:inherit;font-weight:600;border-radius:var(--r-control);border:1px solid var(--ink);background:var(--ink);color:var(--page);cursor:pointer}
.sw-consent-actions button:last-child{background:transparent;color:inherit;border-color:currentColor}
.sw-consent-bottom_left{margin:0;right:auto;max-width:420px}
.sw-consent-center{top:50%;bottom:auto;transform:translateY(-50%)}
.sw-consent-link{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}
`;
