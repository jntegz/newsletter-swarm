// Reader sign-in: a magic link to a Member's email, consumed by POST. (Phase 4, site edge.)
//
//   GET  /_swarm/reader/signin?return=/p/x   the email form
//   POST /_swarm/reader/signin               always answers "check your email" (enumeration-safe)
//   GET  /_swarm/reader/consume?token=…      a "Continue" page; GET never consumes (link scanners)
//   POST /_swarm/reader/consume              consumes the token atomically, starts a session
//   POST /_swarm/reader/signout              ends the session (everywhere=1: every session of
//                                            this Member on this Channel, on every device)
//
// Separate from operator QuickPass and from Member Center links: its own tables, its own keyring
// (READER_KEYS, purposes 'reader-signin' and 'reader-session') and its own cookie.
//
// Rate limits:
// - per client IP: the Workers Rate Limiting binding READER_LIMITER (10 requests a minute per IP,
//   counted per Cloudflare location). The RateLimiter Durable Object lives in the realtime worker
//   and the site worker has no binding to it; a KV counter would be neither atomic nor cheap.
//   Exceeding it answers 429, which says nothing about any address.
// - per address: a D1 count of this Member's sign-in tokens in the last 30 minutes (at most 3).
//   D1 is the source of truth for the tokens anyway, and the count runs after the response with
//   everything else that depends on the address, so going over it changes neither the answer nor
//   its timing.
import { EmailSchema } from '@swarm/domain';
import { first, run, sha256Hex } from '@swarm/db';
import { READER_MEMBER_STATUSES, composeMessage, mailAdapter, readerClassFor } from '@swarm/engine';
import type { OutgoingMail } from '@swarm/mail';
import { signToken, verifyToken } from '@swarm/tokens';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SiteBindings, SiteChannel, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import { later } from '../readers/later';
import { h, readerPage } from '../readers/pages';
import { safeReturnPath } from '../readers/returnPath';
import { createReaderSession, endReaderSession, randomSecret } from '../readers/session';

const READER_TOKEN_TTL_MS = 20 * 60 * 1000;
const PER_ADDRESS_WINDOW_MS = 30 * 60 * 1000;
const PER_ADDRESS_LIMIT = 3;
const SIGNIN_PURPOSE = 'reader-signin';
/**
 * Marks the browser that asked for a link (as __Host-swarm_quickpass does for operators), so only
 * that browser is sent on to the link's return path. The value is derived from the token, so no
 * row stores it. Unprefixed over plain http in local development, like the session cookie.
 */
const LINK_COOKIE_SECURE = '__Host-swarm_reader_link';
const LINK_COOKIE_LOCAL = 'swarm_reader_link';
const browserBinding = (token: string) => sha256Hex(`reader-browser:${token}`);
const linkCookie = (c: SiteContext) =>
  c.get('env').SITE_SCHEME === 'https'
    ? { name: LINK_COOKIE_SECURE, secure: true }
    : { name: LINK_COOKIE_LOCAL, secure: false };

export const reader = new Hono<SiteBindings>();

const clientIp = (c: SiteContext) => c.req.header('cf-connecting-ip') ?? 'unknown';

/**
 * Form posts must come from this site: refuse cross-site posts (CSRF, login forcing). A post must
 * say where it came from: every current browser sends Origin on a form post, Sec-Fetch-Site too.
 * `Origin: null` is also what a sandboxed frame or a data: page sends, so it is taken only with
 * Sec-Fetch-Site: same-origin (a form on a no-referrer page, such as the reader pages).
 */
export function crossSite(c: SiteContext): boolean {
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = c.req.header('origin');
  if (origin === 'null') return fetchSite !== 'same-origin';
  if (origin) return origin !== new URL(c.req.url).origin;
  return !fetchSite;
}

async function underIpLimit(c: SiteContext): Promise<boolean> {
  const limiter = c.get('env').READER_LIMITER;
  if (!limiter) {
    // The binding is declared in every environment; without it, fail closed outside development.
    return c.get('env').ENVIRONMENT === 'development' || c.get('env').ENVIRONMENT === 'test';
  }
  const { success } = await limiter.limit({ key: `reader-signin:${clientIp(c)}` });
  return success;
}

function formField(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : '';
}

function signinForm(returnPath: string, email = '', error?: string): string {
  return `<h1>Sign in to read</h1>
<p>Subscribers get a sign-in link by email. Use the address you get this publication's emails at.</p>
${error ? `<p role="alert" class="small">${h(error)}</p>` : ''}
<form method="post" action="/_swarm/reader/signin">
<input type="hidden" name="return" value="${h(returnPath)}">
<label>Email<input type="email" name="email" value="${h(email)}" autocomplete="email" required maxlength="254"></label>
<button type="submit">Email me a link</button>
</form>`;
}

reader.get('/signin', (c) => {
  const returnPath = safeReturnPath(c.req.query('return'));
  return readerPage(c, 'Sign in', signinForm(returnPath));
});

reader.post('/signin', async (c) => {
  if (crossSite(c))
    return readerPage(c, 'Sign in', '<h1>This form must be sent from this site</h1>', 403);
  if (!(await underIpLimit(c))) {
    c.header('retry-after', '60');
    return readerPage(
      c,
      'Too many attempts',
      '<h1>Too many attempts</h1><p>Wait a minute, then try again.</p>',
      429,
    );
  }
  const form = await c.req.parseBody();
  const returnPath = safeReturnPath(formField(form, 'return'));
  const parsed = EmailSchema.safeParse(formField(form, 'email'));
  if (!parsed.success) {
    return readerPage(
      c,
      'Sign in',
      signinForm(
        returnPath,
        formField(form, 'email').slice(0, 254),
        'Enter a valid email address.',
      ),
      400,
    );
  }

  // Every answer sets the cookie, so it says nothing about the address. When no link is sent,
  // the token behind it is never stored and the cookie matches nothing.
  const now = Date.now();
  const token = await signToken(
    c.get('env').READER_KEYS,
    SIGNIN_PURPOSE,
    { n: randomSecret() },
    { expiresInSeconds: READER_TOKEN_TTL_MS / 1000, now },
  );
  const cookie = linkCookie(c);
  setCookie(c, cookie.name, await browserBinding(token), {
    path: '/',
    secure: cookie.secure,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: READER_TOKEN_TTL_MS / 1000,
  });

  // Everything that depends on whether the address is a Member happens after the response.
  later(c, sendSignInLink(c.get('env'), c.get('channel'), parsed.data, returnPath, token, now));

  return readerPage(
    c,
    'Check your email',
    `<h1>Check your email</h1>
<p>If ${h(parsed.data)} gets emails from ${h(c.get('channel').name)}, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
<p class="small">Not a subscriber yet? Subscribe on the <a href="/">home page</a> first.</p>`,
  );
});

/** Emails a single-use sign-in link to a Member of this Channel. Silent for anyone else. */
async function sendSignInLink(
  env: SiteEnv,
  channel: SiteChannel,
  email: string,
  returnPath: string,
  token: string,
  now: number,
): Promise<void> {
  const placeholders = READER_MEMBER_STATUSES.map((_, i) => `?${i + 3}`).join(', ');
  const member = await first<{ id: string; email: string }>(
    env.DB,
    `SELECT id, email FROM members WHERE channel_id = ?1 AND email = ?2 AND status IN (${placeholders})`,
    channel.id,
    email,
    ...READER_MEMBER_STATUSES,
  );
  if (!member) return;

  const recent = await first<{ n: number }>(
    env.DB,
    'SELECT COUNT(*) AS n FROM reader_tokens WHERE member_id = ?1 AND created_at > ?2',
    member.id,
    now - PER_ADDRESS_WINDOW_MS,
  );
  if ((recent?.n ?? 0) >= PER_ADDRESS_LIMIT) return;

  await run(
    env.DB,
    `INSERT INTO reader_tokens (token_hash, channel_id, member_id, return_path, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    await sha256Hex(token),
    channel.id,
    member.id,
    returnPath,
    now,
    now + READER_TOKEN_TTL_MS,
  );

  const link = new URL('/_swarm/reader/consume', channel.origin);
  link.searchParams.set('token', token);
  await mailAdapter(env, env.PLATFORM_MAIL_DOMAIN).send(
    await signInMail(env, channel, member.email, link.toString()),
  );
}

async function signInMail(
  env: SiteEnv,
  channel: SiteChannel,
  to: string,
  link: string,
): Promise<OutgoingMail> {
  const accent =
    channel.branding.accentColor && /^#[0-9a-f]{6}$/i.test(channel.branding.accentColor)
      ? channel.branding.accentColor
      : '#6c4cf1';
  const subject = `Sign in to read ${channel.name}`;
  const address = `${channel.slug}@${env.PLATFORM_MAIL_DOMAIN}`;
  const message = await composeMessage(env.DB, {
    key: 'reader_signin',
    channelId: channel.id,
    workspaceId: channel.workspaceId,
    channelName: channel.name,
    accent,
    variables: { channel_name: channel.name, signin_url: link },
    fallback: {
      subject,
      text: `${channel.name}\n\nSign in to read on ${channel.origin}:\n\n${link}\n\nThe link works once and expires in 20 minutes. If you did not ask for it, you can ignore this email.\n`,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${h(subject)}</title></head>
<body style="margin:0;background:#fbfbfd;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #efedf6;border-radius:18px" cellpadding="0" cellspacing="0">
<tr><td style="padding:32px"><p style="font-size:13px;font-weight:600;color:#6b6b76;margin:0 0 16px">${h(channel.name)}</p>
<h1 style="font-size:22px;letter-spacing:-0.02em;margin:0 0 12px">Sign in to read</h1>
<p style="font-size:15px;line-height:1.55;color:#3a3a44;margin:0 0 20px">Use this link to sign in on the ${h(channel.name)} website. It works once and expires in 20 minutes.</p>
<a href="${h(link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Sign in</a>
<p style="font-size:13px;line-height:1.5;color:#6b6b76;margin:24px 0 0">If you did not ask for this email, you can ignore it. Nobody can sign in without the link.</p></td></tr></table>
</td></tr></table></body></html>`,
    },
  });
  return {
    category: 'reader_signin',
    from: { name: channel.name, address },
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    tags: { channel: channel.id },
  };
}

const expired = (c: SiteContext) =>
  readerPage(
    c,
    'This link has expired',
    `<h1>This link has expired</h1>
<p>Sign-in links work once and expire after 20 minutes.</p>
<p><a href="/_swarm/reader/signin">Get a new link</a></p>`,
    410,
  );

reader.get('/consume', async (c) => {
  const token = c.req.query('token') ?? '';
  if (token.length > 1024) return expired(c);
  const env = c.get('env');
  const verified = await verifyToken(env.READER_KEYS, SIGNIN_PURPOSE, token);
  if (!verified.ok) return expired(c);
  // Name the account first: anyone can forward a link to their own address. Reading changes
  // nothing, so a link scanner still spends nothing.
  const target = await first<{ id: string; email: string }>(
    env.DB,
    `SELECT m.id, m.email FROM reader_tokens t JOIN members m ON m.id = t.member_id
      WHERE t.token_hash = ?1 AND t.channel_id = ?2 AND t.consumed_at IS NULL AND t.expires_at > ?3`,
    await sha256Hex(token),
    c.get('channel').id,
    Date.now(),
  );
  if (!target) return expired(c);
  // Continuing replaces the reader signed in here, so say so before they do.
  const current = c.get('reader').memberId;
  const signedInAs =
    current !== null && current !== target.id
      ? await first<{ email: string }>(env.DB, 'SELECT email FROM members WHERE id = ?1', current)
      : null;
  const switching = signedInAs
    ? `\n<p>You are signed in as <b>${h(signedInAs.email)}</b>. Continuing signs you in as <b>${h(target.email)}</b> instead.</p>`
    : '';
  return readerPage(
    c,
    'Sign in',
    `<h1>Continue to ${h(c.get('channel').name)}</h1>
<p>Sign in as <b>${h(target.email)}</b> on this device to read subscriber-only posts.</p>${switching}
<p>If you did not ask for this link, close this page.</p>
<form method="post" action="/_swarm/reader/consume">
<input type="hidden" name="token" value="${h(token)}">
<button type="submit">Continue</button>
</form>`,
  );
});

reader.post('/consume', async (c) => {
  if (crossSite(c))
    return readerPage(c, 'Sign in', '<h1>This form must be sent from this site</h1>', 403);
  const form = await c.req.parseBody();
  const token = formField(form, 'token');
  if (!token || token.length > 1024) return expired(c);
  const env = c.get('env');
  const verified = await verifyToken(env.READER_KEYS, SIGNIN_PURPOSE, token);
  if (!verified.ok) return expired(c);

  const now = Date.now();
  // Single use: a replay or a concurrent second POST finds consumed_at already set.
  const consumed = await first<{ member_id: string; return_path: string }>(
    env.DB,
    `UPDATE reader_tokens SET consumed_at = ?1
      WHERE token_hash = ?2 AND channel_id = ?3 AND consumed_at IS NULL AND expires_at > ?1
     RETURNING member_id, return_path`,
    now,
    await sha256Hex(token),
    c.get('channel').id,
  );
  if (!consumed) return expired(c);
  if (
    (await readerClassFor(env.DB, c.get('channel').id, consumed.member_id, now)) === 'anonymous'
  ) {
    return expired(c);
  }

  // Whoever asked for the link chose its return path, and anyone can send a link to their own
  // address to someone else. Follow it only when this browser asked for the link or is already
  // signed in as that Member; a sign-in that changes who this browser reads as goes home.
  const cookie = linkCookie(c);
  const sameBrowser = getCookie(c, cookie.name) === (await browserBinding(token));
  // The edge middleware resolved this browser's reader session before the route.
  const current = c.get('reader').memberId;
  const keepsPath = current === null ? sameBrowser : current === consumed.member_id;
  if (sameBrowser) deleteCookie(c, cookie.name, { path: '/', secure: cookie.secure });

  await createReaderSession(c, consumed.member_id);
  c.header('cache-control', 'no-store');
  return c.redirect(keepsPath ? safeReturnPath(consumed.return_path) : '/', 303);
});

reader.post('/signout', async (c) => {
  if (crossSite(c))
    return readerPage(c, 'Sign out', '<h1>This form must be sent from this site</h1>', 403);
  const form = await c.req.parseBody();
  await endReaderSession(c, { everywhere: formField(form, 'everywhere') === '1' });
  c.header('cache-control', 'no-store');
  return c.redirect(safeReturnPath(formField(form, 'return')), 303);
});
