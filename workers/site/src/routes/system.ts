// robots.txt and the /_swarm system routes other than reader sign-in.
//
//   GET  /robots.txt          everything allowed except /_swarm/, AI crawlers the Bot Rules block
//   GET  /_swarm/site.css     the Channel's stylesheet (immutable when ?v= matches)
//   POST /_swarm/subscribe    the fallback subscribe form, handed to the capture worker
//   POST /_swarm/prompt/dismiss  "No thanks" on a Smart Prompt: a first-party cooldown cookie
import { first } from '@swarm/db';
import { SmartPromptPlacementSchema } from '@swarm/domain';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { SiteBindings } from '../context';
import { botPolicy } from '../edge/bots';
import { siteFlags, siteForm } from '../render/data';
import { activeDesign, designFonts } from '../render/design';
import { absolute, cacheHeaders, h } from '../render/html';
import { page } from '../render/layout';
import { captureAction } from '../render/subscribe';
import { promptCookieName, readDismissals, writeDismissals } from '../render/prompts';
import { SITE_FONTS } from '../render/fonts';
import { siteCss, stylesheetVersion } from '../render/theme';
import { safeReturnPath } from '../readers/returnPath';
import { crossSite } from './reader';

export const system = new Hono<SiteBindings>();

system.get('/robots.txt', async (c) => {
  const channel = c.get('channel');
  const policy = await botPolicy(c.get('env'), channel);
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /_swarm/', ''];
  if (policy.blocked.length > 0) {
    // One group for every blocked crawler: a named group replaces the * group for that crawler.
    for (const bot of policy.blocked) lines.push(`User-agent: ${bot.robots}`);
    lines.push('Disallow: /', '');
  }
  lines.push(`Sitemap: ${absolute(channel, '/sitemap.xml')}`, '');
  return c.text(lines.join('\n'), 200, {
    ...cacheHeaders(c, 'public'),
    'content-type': 'text/plain; charset=utf-8',
  });
});

/** Fonts the templates use, served from here so a site makes no third-party requests. */
system.get('/_swarm/fonts/:file', (c) => {
  // Own names only: /_swarm/fonts/constructor must not find Object.prototype's (a 500).
  const name = c.req.param('file').replace(/\.woff2$/, '');
  const data = Object.hasOwn(SITE_FONTS, name) ? SITE_FONTS[name] : undefined;
  if (!data) return c.notFound();
  return c.body(
    Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)),
    200,
    {
      'content-type': 'font/woff2',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  );
});

system.get('/_swarm/site.css', async (c) => {
  const channel = c.get('channel');
  const flags = await siteFlags(c);
  const design = await activeDesign(c, flags);
  const current = c.req.query('v') === stylesheetVersion(channel, design);
  const fonts = design ? await designFonts(c, design) : undefined;
  return c.body(siteCss(channel, flags.site_templates, design, fonts), 200, {
    ...cacheHeaders(c, 'public'),
    'content-type': 'text/css; charset=utf-8',
    // A stale ?v= still gets today's rules, but only for a short while.
    'cache-control': current
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300, s-maxage=300',
  });
});

/**
 * The plain subscribe form (shown when the Channel has no usable published Capture Form when the
 * page was rendered). The capture worker only takes sign-ups through a form, so this looks up the
 * Channel's site form now and answers 307, which makes the browser repeat the same POST there:
 * the capture worker then sees the reader's own address, IP and Origin and applies all of its
 * checks (rate limits, origin allowlist, honeypot, Turnstile challenge page) as for the embed.
 * Without a form there is nowhere to send it, and the reader is told so.
 */
system.post('/_swarm/subscribe', async (c) => {
  const env = c.get('env');
  const form = await siteForm(env, c.get('channel'));
  if (form) {
    c.header('cache-control', 'no-store');
    return c.redirect(captureAction(env, form.id), 307);
  }
  const channel = c.get('channel');
  const response = await page(
    c,
    {
      meta: {
        title: 'Sign-ups are closed',
        description: `${channel.name} is not taking sign-ups on this site right now.`,
        path: '/_swarm/subscribe',
        noindex: true,
      },
      body: `<header class="sw-pagehead"><h1>Sign-ups are closed</h1><p>${h(channel.name)} is not taking sign-ups on this site right now. Try again later.</p></header>`,
      subscribe: false,
    },
    { cache: 'private' },
  );
  return new Response(response.body, { status: 503, headers: response.headers });
});

/**
 * Dismisses a Smart Prompt for its cooldown: the prompt id and the end of the cooldown go in a
 * first-party cookie (HttpOnly, SameSite=Lax), then the reader goes back to the page. Only
 * this site's own forms may post here; an unknown prompt or a zero cooldown sets nothing.
 */
system.post('/_swarm/prompt/dismiss', async (c) => {
  const env = c.get('env');
  const form = await c.req.parseBody();
  const back = safeReturnPath(typeof form.return === 'string' ? form.return : '/');
  c.header('cache-control', 'no-store');
  if (crossSite(c)) return c.redirect(back, 303);
  const id = typeof form.id === 'string' && /^cf_[0-9a-f]{32}$/.test(form.id) ? form.id : null;
  const row = id
    ? await first<{ placement_json: string | null }>(
        env.DB,
        `SELECT placement_json FROM capture_forms
          WHERE id = ?1 AND channel_id = ?2 AND kind = 'prompt' AND deleted_at IS NULL`,
        id,
        c.get('channel').id,
      )
    : null;
  const placement = row?.placement_json
    ? SmartPromptPlacementSchema.safeParse(JSON.parse(row.placement_json))
    : null;
  if (id && placement?.success && placement.data.cooldownDays > 0) {
    const now = Date.now();
    const until = now + placement.data.cooldownDays * 86_400_000;
    setCookie(c, promptCookieName(env), writeDismissals(readDismissals(c, now), id, until), {
      path: '/',
      secure: env.SITE_SCHEME === 'https',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 365 * 86_400,
    });
  }
  return c.redirect(back, 303);
});
