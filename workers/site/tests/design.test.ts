// The reader-facing design rules that are easy to break without noticing: an accent of any colour
// stays readable, a site with nothing on it still invites signup, and the owner's colours never
// leave text unreadable in the other colour scheme.
import { env } from 'cloudflare:test';
import { contrastRatio, newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { createSite, mountSite } from '../src/index';
import { CSS_REVISION } from '../src/render/theme';
import { call, seedChannel, type SeededChannel } from './helpers';

const site = createSite((s) => mountSite(s));
const get = (ch: SeededChannel, path: string) => call(site, `${ch.origin}${path}`);
const page = async (ch: SeededChannel, path: string) => (await get(ch, path)).text();

const brand = (ch: SeededChannel, branding: Record<string, unknown>) =>
  env.DB.prepare('UPDATE channels SET branding_json = ?2 WHERE id = ?1')
    .bind(ch.channelId, JSON.stringify(branding))
    .run();

const choose = (ch: SeededChannel, theme: Record<string, unknown>) =>
  env.DB.prepare(
    `INSERT INTO site_settings (channel_id, theme_json, updated_at) VALUES (?1, ?2, 0)
     ON CONFLICT (channel_id) DO UPDATE SET theme_json = ?2, cache_version = cache_version + 1`,
  )
    .bind(ch.channelId, JSON.stringify(theme))
    .run();

const templatesOn = (ch: SeededChannel) =>
  env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), ch.channelId)
    .run();

async function stylesheet(ch: SeededChannel): Promise<string> {
  const href = /href="(\/_swarm\/site\.css[^"]*)"/.exec(await page(ch, '/'))![1]!;
  return (await get(ch, href)).text();
}

/** The value of a custom property in the first rule whose selector is exactly `selector`. */
function variable(css: string, selector: string, name: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[}\\n])${escaped}\\{([^}]*)\\}`).exec(css);
  const value = new RegExp(`${name}:([^;]+)`).exec(rule?.[1] ?? '');
  if (!value) throw new Error(`${name} not set in ${selector}`);
  return value[1]!;
}

describe('accent colour', () => {
  it('keeps a light accent readable: dark button text, darker links on light, as chosen on dark', async () => {
    const ch = await seedChannel();
    await brand(ch, { accentColor: '#FFE14D' });
    const css = await stylesheet(ch);
    expect(variable(css, ':root', '--accent')).toBe('#ffe14d');
    expect(variable(css, ':root', '--on-accent')).toBe('#0f0f12');
    const light = variable(css, ':root', '--link');
    expect(light).not.toBe('#ffe14d');
    expect(contrastRatio(light, '#f8f7fc')).toBeGreaterThanOrEqual(4.5);
    expect(variable(css, 'html[data-scheme=dark]', '--link')).toBe('#ffe14d');
    expect(css).toContain('a{color:var(--link)');
  });

  it('lightens a dark accent for links on the dark scheme only', async () => {
    const ch = await seedChannel();
    await brand(ch, { accentColor: '#1b2a4a' });
    const css = await stylesheet(ch);
    expect(variable(css, ':root', '--on-accent')).toBe('#ffffff');
    expect(variable(css, ':root', '--link')).toBe('#1b2a4a');
    const dark = variable(css, 'html[data-scheme=dark]', '--link');
    expect(contrastRatio(dark, '#1d1d24')).toBeGreaterThanOrEqual(4.5);
  });

  it('puts the rules revision in the stylesheet address, so an upgrade is a new file', async () => {
    const ch = await seedChannel();
    const html = await page(ch, '/');
    expect(html).toMatch(new RegExp(`site\\.css\\?v=\\d+\\.[0-9a-f]{6}\\.${CSS_REVISION}"`));
    const old = await get(ch, '/_swarm/site.css?v=1.6c4cf1');
    expect(old.headers.get('cache-control')).not.toContain('immutable');
  });
});

describe('page head', () => {
  it('draws the initial on the accent as the tab icon when there is no logo', async () => {
    const ch = await seedChannel();
    await brand(ch, { accentColor: '#0a7d5a' });
    const html = await page(ch, '/');
    const href = /<link rel="icon" href="([^"]+)">/.exec(html)?.[1] ?? '';
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('fill="#0a7d5a"');
    expect(svg).toMatch(/>[A-Z0-9]<\/text>/);
    expect(html).not.toContain('apple-touch-icon');
  });

  it('tells the browser the page colour for both schemes', async () => {
    const ch = await seedChannel();
    const html = await page(ch, '/');
    expect(html).toContain(
      '<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">',
    );
    expect(html).toContain(
      '<meta name="theme-color" content="#0f0f12" media="(prefers-color-scheme: dark)">',
    );
  });
});

describe('a site with nothing on it yet', () => {
  it('shows its name, says the first issue is coming and offers the signup form', async () => {
    const ch = await seedChannel();
    const html = await page(ch, '/');
    expect(html).toMatch(/<header class="sw-home-head"><h1>[^<]+<\/h1>/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('<div class="sw-empty"><h2>The first issue is on its way</h2>');
    expect(html).toContain('<a class="sw-button" href="#subscribe">Subscribe</a>');
    expect(html).toContain('id="subscribe"');
    const archive = await page(ch, '/archive');
    expect(archive).toContain('<div class="sw-empty"><h2>Nothing published yet</h2>');
  });

  it.each(['gate', 'letter', 'magazine', 'newspaper', 'launch'] as const)(
    'looks deliberate in %s, with one h1 and a way to sign up',
    async (template) => {
      const ch = await seedChannel();
      await templatesOn(ch);
      await choose(ch, { template });
      const html = await page(ch, '/');
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain('data-swarm-subscribe');
      if (template === 'magazine') expect(html).toContain('The first issue is on its way.');
      if (template === 'newspaper') expect(html).toContain('The first edition is being set.');
      if (template === 'gate') {
        expect(html).toContain('The first issue is on its way.');
        expect(html).not.toContain('Read past issues first');
      }
    },
  );
});

describe('reading pages', () => {
  it('sets the archive, search and not-found pages in one narrow column', async () => {
    const ch = await seedChannel();
    for (const path of ['/archive', '/search', '/about', '/no-such-page']) {
      expect(await page(ch, path), path).toContain('<div class="sw-wrap sw-narrow">');
    }
    expect(await page(ch, '/')).toContain('<div class="sw-wrap">');
  });

  it('keeps the search form on the search page in the Letter template', async () => {
    const ch = await seedChannel();
    await templatesOn(ch);
    await choose(ch, { template: 'letter' });
    // The theme hides the header's search on its own home page only.
    expect(await stylesheet(ch)).toContain('body:has(.t-letter) .sw-search');
    const search = await page(ch, '/search');
    expect(search).toContain('class="sw-search"');
    expect(search).not.toContain('t-letter');
  });
});

describe('the owner’s colours', () => {
  /** The variables of the design's rule for its dark scheme. */
  const darkRule = (css: string) =>
    /html:root\{([^}]*color-scheme:dark[^}]*)\}/.exec(css)?.[1] ?? '';
  const inRule = (rule: string, name: string) =>
    new RegExp(`${name}:([^;]+)`).exec(rule)?.[1] ?? '';

  it('fixes the scheme to suit a page colour, and works lines and links out from it', async () => {
    const ch = await seedChannel();
    await templatesOn(ch);
    await choose(ch, { template: 'magazine', pageColor: '#FFF8EC', colorScheme: 'dark' });
    const html = await page(ch, '/');
    expect(html).toContain('data-scheme="t-light"');
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<meta name="theme-color" content="#fff8ec">');
    const css = await stylesheet(ch);
    const rule = 'html:root';
    expect(variable(css, rule, '--page')).toBe('#fff8ec');
    expect(contrastRatio(variable(css, rule, '--ink'), '#fff8ec')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(variable(css, rule, '--text-sub'), '#fff8ec')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(variable(css, rule, '--link'), '#fff8ec')).toBeGreaterThanOrEqual(4.5);
  });

  it('uses light text on a dark page colour, whatever the reader’s device prefers', async () => {
    const ch = await seedChannel();
    await templatesOn(ch);
    await choose(ch, { template: 'letter', pageColor: '#101820', inkColor: '#101820' });
    expect(await page(ch, '/')).toContain('data-scheme="t-dark"');
    // The text colour can't be read on this page, so a light one is used.
    expect(inRule(darkRule(await stylesheet(ch)), '--ink')).toBe('#f4f3f8');
  });

  it('leaves a dark text colour out of the dark scheme', async () => {
    const ch = await seedChannel();
    await templatesOn(ch);
    await choose(ch, { template: 'newspaper', inkColor: '#1A2B3C', colorScheme: 'auto' });
    expect(await page(ch, '/')).toContain('data-scheme="t-auto"');
    const css = await stylesheet(ch);
    expect(variable(css, 'html:root', '--ink')).toBe('#1a2b3c');
    const dark = darkRule(css);
    expect(inRule(dark, '--ink')).not.toBe('#1a2b3c');
    expect(contrastRatio(inRule(dark, '--ink'), inRule(dark, '--page'))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('ignores a colour that is not a colour', async () => {
    const ch = await seedChannel();
    await templatesOn(ch);
    await choose(ch, { template: 'letter', pageColor: 'red;}body{display:none' });
    const css = await stylesheet(ch);
    expect(css).not.toContain('red;');
    expect(await page(ch, '/')).toContain('data-scheme="t-');
  });
});
