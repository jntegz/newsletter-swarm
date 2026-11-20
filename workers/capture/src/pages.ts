// Server-rendered pages on the capture origin: confirm, leave, Member Center, the no-JS results and
// the Turnstile challenge. Every value is escaped; pages carry a strict CSP and run no script of
// their own (the challenge page loads only Turnstile).
import { readableColor, textOn } from '@swarm/domain';
import { escapeHtml } from '@swarm/mail';

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

const STYLE = `:root{--accent:#6c4cf1;--on-accent:#fff;--link:#6c4cf1;color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#fbfbfd;color:#0f0f12}
main{max-width:480px;margin:10vh auto;padding:32px;background:#fff;border:1px solid #efedf6;border-radius:18px}
.channel{font-size:13px;font-weight:600;color:#6b6b76;margin:0 0 12px}
h1{font-size:22px;line-height:1.25;letter-spacing:-0.02em;margin:0 0 12px;text-wrap:balance}
h2{font-size:16px;margin:28px 0 8px}
p{font-size:15px;line-height:1.55;color:#3a3a44;margin:0 0 16px}
label{display:block;font-size:14px;font-weight:500;margin:0 0 12px}
input[type=text],input[type=email],input[type=number],input[type=date],select,textarea{display:block;width:100%;margin-top:6px;font:inherit;font-weight:400;padding:10px 12px;border:1px solid #e7e5ee;border-radius:10px;background:transparent;color:inherit}
fieldset{border:0;padding:0;margin:0 0 12px}legend{font-size:14px;font-weight:500;margin-bottom:6px}
.choice{display:flex;gap:8px;align-items:center;font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:8px}
button{font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:0;border-radius:999px;padding:12px 22px;min-height:44px;cursor:pointer}
button.ghost{color:#0f0f12;background:#fff;border:1px solid #e7e5ee}
button.danger{background:#b5401f;color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--link);outline-offset:2px}
a:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:2px}
.muted{font-size:14px;color:#6b6b76}
ul.plain{list-style:none;padding:0;margin:0 0 16px}ul.plain li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid #efedf6;font-size:14px}
.notice{padding:10px 14px;border-radius:10px;background:#e9f5ee;color:#1f7a4d;font-size:14px}
.error{padding:10px 14px;border-radius:10px;background:#ffe9e2;color:#b5401f;font-size:14px}
a{color:var(--link)}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.bar{display:block;height:6px;margin-top:6px;border-radius:3px;background:#efedf6}.bar span{display:block;height:6px;border-radius:3px;background:var(--accent)}
ul.results{list-style:none;padding:0;margin:0 0 16px}ul.results li{padding:8px 0;border-top:1px solid #efedf6;font-size:14px}ul.results .count{float:right;color:#6b6b76}
textarea{min-height:96px}
@media (prefers-color-scheme:dark){body{background:#0f0f12;color:#f4f3f8}main{background:#17171c;border-color:#2a2a33}p{color:#c9c8d3}input[type],select,textarea,button.ghost,ul.plain li{border-color:#3a3a46}button.ghost{background:#17171c;color:#f4f3f8}.channel,.muted,ul.results .count{color:#a2a2ad}.notice{background:#16301f;color:#8fd6ab}.error{background:#3a1a12;color:#ffb39e}.bar,ul.plain li,ul.results li{border-color:#2a2a33}.bar{background:#2a2a33}}
@media (max-width:520px){main{margin:16px;padding:24px 20px}}`;

export const safeAccent = (accent: string | null | undefined) =>
  accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';

/**
 * The accent as these pages use it: as chosen for buttons, with button text that reads on it, and
 * as link text moved just far enough to read on the light card and on the dark one.
 */
export function accentVars(value: string | null | undefined): string {
  const accent = safeAccent(value).toLowerCase();
  return `:root{--accent:${accent};--on-accent:${textOn(accent)};--link:${readableColor(accent, '#ffffff', 4.6)}}@media (prefers-color-scheme:dark){:root{--link:${readableColor(accent, '#17171c', 4.6)}}}`;
}

interface PageOptions {
  status?: number;
  accent?: string | null;
  /** Load the Turnstile script (the challenge page). */
  turnstile?: boolean;
  /**
   * Origins a form here may end up at after a redirect (form-action covers redirects): the
   * Member Center's payment method button lands on Stripe's Billing Portal.
   */
  formTargets?: string[];
  /** frame-ancestors sources, for pages shown inside the form frame (Signup Journeys). */
  frameAncestors?: string;
}

export function page(title: string, body: string, options: PageOptions = {}): Response {
  const script = options.turnstile ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>${STYLE}${accentVars(options.accent)}</style>${script}
</head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin',
      'content-security-policy': [
        "default-src 'none'",
        options.turnstile ? 'script-src https://challenges.cloudflare.com' : "script-src 'none'",
        options.turnstile ? 'frame-src https://challenges.cloudflare.com' : null,
        "style-src 'unsafe-inline'",
        ["form-action 'self'", ...(options.formTargets ?? [])].join(' '),
        "base-uri 'none'",
        `frame-ancestors ${options.frameAncestors ?? "'none'"}`,
      ]
        .filter(Boolean)
        .join('; '),
    },
  });
}

export const h = escapeHtml;

/** An address as a footer link shows it: enough to recognise, not enough to learn. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

export const brokenLink = () =>
  page(
    'This link does not work',
    '<h1>This link does not work</h1><p>It may be incomplete. Open the email again and use the link from there.</p>',
    { status: 404 },
  );

export const expiredLink = (what: string) =>
  page('This link has expired', `<h1>This link has expired</h1><p>${h(what)}</p>`, { status: 410 });

export const slowDown = (retryAfter: number) => {
  const res = page(
    'Too many attempts',
    '<h1>Too many attempts</h1><p>Wait a few minutes, then try again.</p>',
    { status: 429 },
  );
  res.headers.set('retry-after', String(retryAfter));
  return res;
};
