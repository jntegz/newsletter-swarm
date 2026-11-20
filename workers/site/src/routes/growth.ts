// Growth pages (Phase 6):
//
//   GET /r/:code         a Champion's short referral link: remembers the code in a first-party
//                        cookie and redirects to the home page with ?ref=<code> (edge/referral.ts
//                        puts it into the subscribe forms). Never cached.
//   GET /champions       the public "top Champions" (flag referral_awards, Champions on and the
//                        public leaderboard switched on): first names and initials, never emails.
//   GET /series/:slug    a Series in order (flag post_series).
import { championSettings, topChampions } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings } from '../context';
import { list, previewCss, previews, empty } from '../render/components';
import { seriesBySlug, seriesDispatches, siteFlags } from '../render/data';
import { h } from '../render/html';
import { page } from '../render/layout';
import { cleanCode, mayRememberReferral, setReferralCookie } from '../edge/referral';
import { notFoundPage } from './pages';

export const growth = new Hono<SiteBindings>();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const pagehead = (title: string, text?: string | null) =>
  `<header class="sw-pagehead"><h1>${h(title)}</h1>${text ? `<p>${h(text)}</p>` : ''}</header>`;

growth.get('/r/:code', async (c) => {
  const code = cleanCode(c.req.param('code'));
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  if (!code) return c.redirect('/', 302);
  if (await mayRememberReferral(c)) setReferralCookie(c, code);
  return c.redirect(`/?ref=${code}`, 302);
});

growth.get('/champions', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const [flags, settings] = await Promise.all([siteFlags(c), championSettings(env.DB, channel.id)]);
  if (!flags.referral_awards || settings.enabled !== 1 || settings.public_leaderboard !== 1) {
    return notFoundPage(c);
  }
  const top = await topChampions(env.DB, channel.id, 10);
  const items = top
    .map(
      (t) =>
        `<li>${h(t.name)} <span>${t.counted} referral${t.counted === 1 ? '' : 's'}</span></li>`,
    )
    .join('');
  return page(c, {
    meta: {
      title: 'Top referrers',
      description: `The subscribers who brought the most readers to ${channel.name}.`,
      path: '/champions',
    },
    body: `${pagehead('Top referrers', settings.share_text ?? `Subscribers who shared ${channel.name} with the most new readers.`)}
${items ? `<ol class="sw-champions">${items}</ol>` : empty('No referrers yet. Share your link from your subscriber settings to be the first.')}`,
  });
});

growth.get('/series/:slug', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  if (!(await siteFlags(c)).post_series) return notFoundPage(c);
  const slug = c.req.param('slug');
  if (!SLUG.test(slug) || slug.length > 80) return notFoundPage(c);
  const series = await seriesBySlug(env, channel.id, slug);
  if (!series) return notFoundPage(c);
  const items = await seriesDispatches(env, channel.id, series.id);
  const views = await previews(c, items);
  const count = `${items.length} part${items.length === 1 ? '' : 's'}`;
  return page(
    c,
    {
      meta: {
        title: series.name,
        description: series.description ?? `${series.name}, a Series from ${channel.name}.`,
        path: `/series/${series.slug}`,
      },
      body: `${pagehead(series.name, series.description ?? count)}${
        series.description ? `<p class="sw-muted">${h(count)}</p>` : ''
      }${list(views) || empty('No parts of this Series are published yet.')}`,
      css: previewCss(views),
    },
    { tags: [series.id] },
  );
});
