// Renders the built-in themes with realistic sample data inside a copy of the site's page shell,
// for design review and for the dashboard's theme thumbnails. Nothing here ships to a site.
//
//   tsx packages/site-themes/scripts/gallery.ts <out-dir> [--shoot] [--axe <axe.min.js>]
//       [--thumbs <dir>] [--only gate,letter] [--playwright <path to playwright/index.js>]
//
// Writes one HTML page per theme, reader and colour scheme (and an empty publication), with the
// fonts and sample images next to them. --shoot serves the directory and takes screenshots with
// Playwright (and checks the form is in the first screen and nothing scrolls sideways); --axe runs
// axe-core on every page; --thumbs saves a 1200x800 first-screen thumbnail per theme as .webp.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_FONTS } from '../../../workers/site/src/render/fonts';
import { subscribeForm } from '../../../workers/site/src/render/subscribe';
import { SEARCH_LINK, siteCss } from '../../../workers/site/src/render/theme';
import {
  compileTheme,
  renderDesign,
  type CompiledTheme,
  type Design,
  type RenderHooks,
} from '../src/index';
import { BUILT_IN_THEME_IDS } from '../themes/index';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const THEMES_DIR = resolve(HERE, '../themes');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(args[0] && !args[0].startsWith('--') ? args[0] : 'theme-gallery');
const ONLY = option('--only')?.split(',');
const ids = BUILT_IN_THEME_IDS.filter((id) => !ONLY || ONLY.includes(id));

/** A theme's files from disk, as the build step reads them. */
function readTheme(id: string): Record<string, string> {
  const dir = join(THEMES_DIR, id);
  const files: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else if (/\.(html|css|json)$/.test(name)) files[rel] = readFileSync(join(dir, rel), 'utf8');
    }
  };
  walk('');
  return files;
}

// ---- Sample pictures, drawn here so nothing is fetched ----------------------------------------

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

const ART: Record<string, string> = {
  hills: svg(
    1600,
    1000,
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d9b8"/><stop offset="1" stop-color="#f3efe4"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#s)"/><circle cx="1130" cy="330" r="120" fill="#e9824e"/><path d="M0 620 C300 520 520 560 760 610 S1250 520 1600 580 V1000 H0Z" fill="#9db58c"/><path d="M0 720 C260 650 600 700 900 740 S1400 660 1600 700 V1000 H0Z" fill="#5f8a64"/><path d="M0 830 C400 780 700 820 1000 860 S1450 800 1600 820 V1000 H0Z" fill="#2f5a45"/>`,
  ),
  swifts: svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#c9dbe6"/><circle cx="420" cy="300" r="90" fill="#fdf3dc"/><g fill="none" stroke="#24323d" stroke-width="7" stroke-linecap="round"><path d="M700 300q30-24 60 0q30-24 60 0"/><path d="M900 220q22-18 44 0q22-18 44 0"/><path d="M1040 360q26-20 52 0q26-20 52 0"/><path d="M820 430q18-14 36 0q18-14 36 0"/><path d="M1200 260q20-16 40 0q20-16 40 0"/></g><path d="M0 780 C300 720 700 760 1000 790 S1400 740 1600 760 V1000 H0Z" fill="#7e9a8a"/><path d="M0 860 C500 820 900 870 1600 840 V1000 H0Z" fill="#4c6b5c"/>`,
  ),
  pond: svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#dfe8d8"/><ellipse cx="800" cy="600" rx="640" ry="260" fill="#6f9fa8"/><g fill="none" stroke="#e8f1ef" stroke-width="5" opacity=".8"><ellipse cx="640" cy="580" rx="90" ry="28"/><ellipse cx="640" cy="580" rx="160" ry="52"/><ellipse cx="1030" cy="650" rx="70" ry="22"/><ellipse cx="1030" cy="650" rx="130" ry="42"/></g><g stroke="#3e5f3a" stroke-width="10" stroke-linecap="round"><path d="M220 700 L250 380"/><path d="M270 720 L320 330"/><path d="M1380 690 L1350 400"/><path d="M1330 700 L1300 360"/></g><ellipse cx="1180" cy="560" rx="46" ry="16" fill="#5e8a4f"/>`,
  ),
  leaves: svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#efe3cf"/><g fill="#b5562f"><path d="M300 300c120-140 300-90 330 30c-130 120-300 110-330-30z"/><path d="M900 640c140-150 330-70 340 60c-150 110-320 80-340-60z"/></g><g fill="#7b8f3e"><path d="M620 520c90-170 280-170 340-60c-110 150-290 160-340 60z"/><path d="M1180 260c110-120 260-80 290 20c-110 100-260 100-290-20z"/></g><g fill="#d39a3a"><path d="M180 760c90-110 230-80 260 20c-100 90-230 90-260-20z"/></g><g fill="none" stroke="#5b4630" stroke-width="5"><path d="M300 300c90 20 220 30 330 30"/><path d="M900 640c110 20 240 40 340 60"/><path d="M620 520c100 0 230-20 340-60"/></g>`,
  ),
  moss: svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#2f3b2c"/><g fill="#6f8f3f"><circle cx="300" cy="700" r="220"/><circle cx="620" cy="760" r="260"/><circle cx="980" cy="720" r="240"/><circle cx="1320" cy="780" r="260"/></g><g fill="#9cba57"><circle cx="420" cy="640" r="110"/><circle cx="800" cy="660" r="140"/><circle cx="1150" cy="640" r="120"/></g><g fill="#d7e39a"><circle cx="470" cy="600" r="18"/><circle cx="830" cy="590" r="22"/><circle cx="1180" cy="600" r="16"/><circle cx="700" cy="640" r="12"/></g>`,
  ),
  frost: svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#e6eef4"/><g fill="none" stroke="#7d9cb6" stroke-width="6" stroke-linecap="round"><path d="M500 260v480M290 500h420M352 352l296 296M352 648l296-296"/><path d="M1120 340v300M970 490h300M1014 384l212 212M1014 596l212-212"/></g><path d="M0 860 C400 820 1100 880 1600 840 V1000 H0Z" fill="#b9cbd9"/>`,
  ),
  portrait: svg(
    600,
    600,
    `<rect width="600" height="600" fill="#e8c9a6"/><circle cx="300" cy="250" r="118" fill="#8a5a3c"/><path d="M120 600c20-130 90-200 180-200s160 70 180 200z" fill="#3d5a4a"/><path d="M190 230c10-90 70-140 150-130c70 10 110 70 100 150c-30-50-80-70-130-60c-50 10-90 30-120 40z" fill="#2c2420"/>`,
  ),
  reader1: svg(
    200,
    200,
    `<rect width="200" height="200" fill="#c8d7e8"/><circle cx="100" cy="82" r="40" fill="#5b4636"/><path d="M30 200c8-50 36-76 70-76s62 26 70 76z" fill="#8a3b2e"/>`,
  ),
  logo: svg(
    200,
    200,
    `<rect width="200" height="200" rx="100" fill="#2f5a45"/><path d="M60 140c0-60 40-90 90-90c0 60-40 90-90 90z" fill="#f3efe4"/><path d="M62 138c22-22 44-44 70-66" stroke="#2f5a45" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  ),
};

/** Some pictures come from the media library, some inline: the hook draws both. */
const DATA_URI = new Set(['frost', 'moss']);
const imageUrl = (name: string) =>
  DATA_URI.has(name)
    ? `data:image/svg+xml;base64,${Buffer.from(ART[name] ?? '').toString('base64')}`
    : `/media/${name}.svg`;

const picture = (name: string, alt: string, width = 1600, height = 1000) => ({
  url: imageUrl(name),
  alt,
  width,
  height,
  focal: '50% 50%',
});

// ---- Sample publication ------------------------------------------------------------------------

const day = (n: number) => new Date(Date.UTC(2026, 10, 8) - n * 7 * 86_400_000).toISOString();
const POSTS = [
  {
    title: 'The week the swifts came back',
    excerpt:
      'They arrive all at once, as if someone opened a door in the sky. A few notes on the first evening they were back over the street, and what they had flown through to get here.',
    image: picture('swifts', 'Swifts drawn as small dark arcs over green hills'),
    minutes: 6,
  },
  {
    title: 'What the hedgerow knows',
    excerpt:
      'A hundred metres of hawthorn and bramble at the end of the lane holds more life than the field beside it. I walked it slowly, four times, at four times of day.',
    image: picture('leaves', 'Autumn leaves in rust, olive and ochre'),
    minutes: 8,
    pinned: true,
  },
  {
    title: 'Notes from a very small pond',
    excerpt:
      'Two square metres of water, dug in March. By June it had newts, by August dragonflies. What arrived, in what order, and what I got wrong.',
    image: picture('pond', 'A small pond with reeds and rings on the water'),
    minutes: 7,
  },
  {
    title: 'Learning the names of mosses',
    excerpt:
      'There are more than a thousand kinds in these islands and I can now name eleven. A beginner’s list, with a hand lens and a lot of kneeling.',
    image: picture('moss', 'Rounded cushions of moss in greens and yellows'),
    minutes: 5,
    paid: true,
  },
  {
    title: 'Walking the same mile for a year',
    excerpt:
      'Every morning, the same route to the river and back. What changes when nothing changes, and the small calendar the walk turned into.',
    image: picture('hills', 'Layered green hills under a low orange sun'),
    minutes: 9,
  },
  {
    title: 'Why the oak keeps its leaves',
    excerpt:
      'Young oaks and beeches hold on to their dead leaves through the winter. There are a few good theories, and one I like more than the evidence allows.',
    image: null,
    minutes: 4,
  },
  {
    title: 'First frost, and other small events',
    excerpt:
      'The morning the grass turned white and crisp. A short list of things that only happen on the first cold day, and how to notice them.',
    image: picture('frost', 'Frost crystals drawn over a pale blue sky'),
    minutes: 5,
  },
  {
    title: 'A field guide to puddles',
    excerpt:
      'Puddles are small weather stations. How long they last, what drinks from them, and why the one by the bus stop never quite dries.',
    image: null,
    minutes: 4,
  },
].map((p, i) => ({
  title: p.title,
  url: `/p/${p.title
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-|-$/g, '')}`,
  excerpt: p.excerpt,
  date: day(i),
  reading_minutes: p.minutes,
  image: p.image,
  is_paid: !!p.paid,
  is_pinned: !!p.pinned,
  author: 'Mara Lind',
}));

const SITE = {
  name: 'Field Notes',
  description:
    'A weekly letter about the nature on your doorstep: birds, weeds, weather and the small events most of us walk past.',
  url: 'https://fieldnotes.example',
  logo: picture('logo', 'Field Notes', 200, 200),
  subscriber_count: 12_431,
  issue_count: 48,
  nav: [
    { label: 'Archive', url: '/archive', current: false },
    { label: 'About', url: '/about', current: false },
  ],
  archive_url: '/archive',
  about_url: '/about',
  plans_url: '/subscribe',
  has_paid_plans: true,
};

const EMPTY_SITE = {
  ...SITE,
  name: 'Tide Tables',
  description: 'Notes on the coast, once a month.',
  logo: null,
  subscriber_count: null,
  issue_count: 0,
  plans_url: null,
  has_paid_plans: false,
};

/** Media ids the sample design's image settings point at. */
const MEDIA: Record<string, unknown> = {
  [`md_${'1'.repeat(32)}`]: picture('portrait', 'Mara Lind, smiling', 600, 600),
  [`md_${'2'.repeat(32)}`]: picture('reader1', 'Jonas Weber', 200, 200),
  [`md_${'3'.repeat(32)}`]: picture('hills', 'Layered green hills under a low orange sun'),
};
const PORTRAIT = `md_${'1'.repeat(32)}`;
const READER = `md_${'2'.repeat(32)}`;
const COVER = `md_${'3'.repeat(32)}`;

/** The words an owner would have written, the same for every theme. */
const COPY: Record<string, Record<string, unknown>> = {
  hero: {
    promise: 'A short letter every Sunday morning. Free.',
    privacy_note: 'No ads, no tracking. Unsubscribe at any time.',
    show_logo: false,
  },
  benefits: {
    items: [
      {
        title: 'One letter a week',
        text: 'Sunday morning, about a ten minute read. Never more often than that.',
      },
      {
        title: 'Things to look for',
        text: 'Each issue ends with three small things to notice that week, wherever you live.',
      },
      {
        title: 'The whole archive',
        text: 'Forty-eight issues so far, all free to read on this site.',
      },
    ],
  },
  testimonials: {
    items: [
      {
        quote: 'The only newsletter I read on paper. I print it on Sunday and take it on my walk.',
        name: 'Jonas Weber',
        role: 'Reader since 2024',
        photo: READER,
      },
      {
        quote: 'It made me look up again. I know the birds on my street by name now.',
        name: 'Priya Natarajan',
        role: 'Teacher',
      },
      {
        quote: 'Calm, precise and never in a hurry. Exactly what Sunday needs.',
        name: 'Ellen Ford',
        role: 'Gardener',
      },
    ],
  },
  author: {
    name: 'Mara Lind',
    bio: 'I am a field ecologist turned writer. For ten years I counted birds for a living; now I write about the ones that live on my street, and about everything else that grows, crawls and flies where most of us never look.\n\nI live by a river with a dog who disapproves of herons.',
    photo: PORTRAIT,
  },
  faq: {
    items: [
      {
        question: 'How often will I hear from you?',
        answer: 'Once a week, on Sunday morning. Sometimes a short extra note in spring.',
      },
      {
        question: 'Is it free?',
        answer:
          'Yes. Paid subscribers support the work and get a monthly field sheet, but every letter is free.',
      },
      {
        question: 'Can I unsubscribe?',
        answer: 'Yes. Every email has an unsubscribe link, and one click is enough.',
      },
    ],
  },
  numbers: {
    items: [
      { value: '48', label: 'Issues so far' },
      { value: '12,431', label: 'Readers' },
      { value: '61%', label: 'Open each letter' },
    ],
  },
};

/** The sample design: each theme's default sections, filled in with the owner's words. */
function sampleDesign(id: string, defaults: { id: string; type: string; settings: object }[]) {
  const sections = defaults.map((s) => {
    const copy = { ...(COPY[s.type] ?? {}) };
    if (s.type === 'hero') {
      copy.image = id === 'magazine' ? COVER : id === 'newspaper' ? null : PORTRAIT;
      if (id === 'letter') {
        copy.heading = 'Hello, I’m Mara.';
        copy.pitch =
          'Every Sunday I write you a letter about what I noticed outside that week: the birds on the roof, the weeds in the pavement, the weather coming in.\n\nIt takes ten minutes to read. I hope it makes your walk a little slower.';
      }
    }
    if (s.type === 'author' && id === 'gate') copy.heading = '';
    return { ...s, settings: { ...s.settings, ...copy } };
  });
  return {
    theme: id,
    files: null,
    settings:
      id === 'letter'
        ? { sign_off: 'Warmly, Mara' }
        : id === 'newspaper'
          ? { edition: 'Weekly edition' }
          : {},
    sections,
  } satisfies Design;
}

const ALT: Record<string, { settings: Record<string, unknown>; hero: string; latest?: string }> = {
  gate: { settings: { backdrop: 'accent', accent: '#0f6b5c' }, hero: 'left', latest: 'cards' },
  letter: { settings: { accent: '#2d5d7b', page: '#f3f1ec' }, hero: 'centred', latest: 'cards' },
  magazine: { settings: { rules: 'accent', accent: '#1d4ed8' }, hero: 'stacked', latest: 'list' },
  newspaper: { settings: { accent: '#7a1a1a', corners: 'soft' }, hero: 'left', latest: 'compact' },
  launch: { settings: { panel: 'ink', accent: '#b93d0b' }, hero: 'centred', latest: 'list' },
  night: {
    settings: { light: 'side', grain: 'heavy', glow: '#4fd1ff', accent: '#be185d' },
    hero: 'centred',
    latest: 'compact',
  },
  zine: {
    settings: { tilt: 'straight', second_ink: '#00a88f', third_ink: '#ff7a1a', accent: '#5b2bd1' },
    hero: 'stacked',
    latest: 'cards',
  },
  brief: { settings: { grid: 'plain', accent: '#1d4ed8' }, hero: 'stacked', latest: 'cards' },
};

/** The sample design with every other choice made, to check they all hold up. */
function alternative(design: Design, scheme: string): Design {
  const alt = ALT[design.theme] ?? { settings: {}, hero: '' };
  return {
    ...design,
    settings: { ...design.settings, ...alt.settings, buttons: 'outline', scheme },
    sections: (design.sections ?? []).map((s) =>
      s.type === 'hero'
        ? { ...s, settings: { ...s.settings, layout: alt.hero, show_logo: true } }
        : s.type === 'latest' && alt.latest
          ? { ...s, settings: { ...s.settings, style: alt.latest, show_images: true } }
          : s,
    ),
  };
}

// ---- The page shell (a copy of workers/site/src/render/layout.ts) ------------------------------

const h = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The home page as the site sends it: the site stylesheet with the design's rules in it
 * (siteCss with the design), data-scheme="t-…", the header without a Subscribe button (the page
 * has its own forms) and with the phones' search link, and the sections in the page-width wrapper.
 */
function shell(opts: {
  title: string;
  scheme: 'light' | 'dark' | 'auto';
  accent: string;
  theme: CompiledTheme;
  design: Design;
  body: string;
  site: typeof SITE;
}): string {
  const channel = {
    branding: { accentColor: opts.accent },
    settings: { customCss: '' },
  } as never;
  const active = {
    theme: opts.theme,
    design: opts.design,
    key: 'gallery',
    source: 'published',
    scheme: opts.scheme,
    font: 'geist',
  } as never;
  const logo = opts.site.logo
    ? `<img src="${h(opts.site.logo.url)}" alt="" width="36" height="36">`
    : '';
  return `<!doctype html>
<html lang="en" class="sw-font-geist" data-scheme="t-${opts.scheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${opts.scheme === 'auto' ? 'light dark' : opts.scheme}">
<title>${h(opts.title)}</title>
<style>${siteCss(channel, true, active)}</style>
</head>
<body>
<a class="sw-skip" href="#main">Skip to content</a>
<header class="sw-header"><div class="sw-wrap">
<a class="sw-brand" href="/">${logo}<span>${h(opts.site.name)}</span></a>
<nav class="sw-nav" aria-label="Site">${opts.site.nav.map((l) => `<a href="${h(l.url)}">${h(l.label)}</a>`).join('')}</nav>
<form class="sw-search" method="get" action="/search" role="search"><label class="sw-sr" for="sw-q">Search</label><input id="sw-q" type="search" name="q" placeholder="Search" maxlength="200"></form>${SEARCH_LINK}
</div></header>
<main id="main" class="sw-main sw-main-design"><div class="sw-wrap">
${opts.body}
</div></main>
<footer class="sw-footer"><div class="sw-wrap">
<nav aria-label="Footer"><a href="/archive">Archive</a><a href="/about">About</a><a href="/search">Search</a><a href="/feed">RSS</a><a href="/sitemap">Sitemap</a><a href="/_swarm/reader/signin?return=%2F">Sign in</a></nav>
<p>© 2026 ${h(opts.site.name)}</p>
</div></footer>
</body>
</html>`;
}

const FORM = {
  id: 'fm_sample',
  version: 3,
  join: false,
  config: {
    fields: [{ key: 'email', label: 'Email', required: true, placeholder: 'you@example.com' }],
    consent: null,
    copy: { button: 'Subscribe', heading: '', body: '' },
  },
};
const FULL_FORM = {
  ...FORM,
  config: {
    ...FORM.config,
    fields: [
      { key: 'first_name', label: 'First name', required: false, placeholder: '' },
      ...FORM.config.fields,
    ],
    consent: { required: true, text: 'I agree to receive this newsletter by email.' },
  },
};

function hooks(full: boolean): RenderHooks {
  return {
    subscribeForm: () =>
      subscribeForm(
        { CAPTURE_ORIGIN: 'https://capture.example' } as never,
        (full ? FULL_FORM : FORM) as never,
      ),
    image: (img, sizes) => {
      const size = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : '';
      return `<img src="${h(img.url)}" alt="${h(img.alt)}"${size} sizes="${h(sizes)}" loading="lazy" decoding="async">`;
    },
    now: () => new Date(Date.UTC(2026, 10, 9)),
  };
}

// ---- Pages --------------------------------------------------------------------------------------

interface PageSpec {
  file: string;
  theme: string;
  reader: 'visitor' | 'subscriber';
  scheme: 'light' | 'dark' | 'auto';
  empty?: boolean;
  full?: boolean;
  /** The other choices: each theme's own setting, another layout, outline buttons, a new accent. */
  alt?: boolean;
}

mkdirSync(join(OUT, 'media'), { recursive: true });
mkdirSync(join(OUT, '_swarm/fonts'), { recursive: true });
for (const [name, body] of Object.entries(ART))
  writeFileSync(join(OUT, 'media', `${name}.svg`), body);
for (const [name, b64] of Object.entries(SITE_FONTS))
  writeFileSync(join(OUT, '_swarm/fonts', `${name}.woff2`), Buffer.from(b64, 'base64'));

const pages: PageSpec[] = [];
/** Each theme's default colour scheme: its thumbnail shows it as it comes. */
const defaultScheme: Record<string, string> = {};
let failed = false;
for (const id of ids) {
  const { theme, problems } = compileTheme(readTheme(id));
  for (const p of problems)
    console.log(`${id}: ${p.severity} ${p.file}:${p.line}:${p.column} ${p.message}`);
  if (!theme) {
    failed = true;
    continue;
  }
  const design = sampleDesign(id, theme.defaults);
  defaultScheme[id] = String(theme.settings.find((s) => s.id === 'scheme')?.default ?? 'light');
  const variants: PageSpec[] = [
    { file: `${id}-visitor-light.html`, theme: id, reader: 'visitor', scheme: 'light' },
    { file: `${id}-visitor-dark.html`, theme: id, reader: 'visitor', scheme: 'dark' },
    { file: `${id}-subscriber-light.html`, theme: id, reader: 'subscriber', scheme: 'light' },
    { file: `${id}-subscriber-dark.html`, theme: id, reader: 'subscriber', scheme: 'dark' },
    { file: `${id}-visitor-auto.html`, theme: id, reader: 'visitor', scheme: 'auto', full: true },
    { file: `${id}-empty-light.html`, theme: id, reader: 'visitor', scheme: 'light', empty: true },
    { file: `${id}-alt-light.html`, theme: id, reader: 'visitor', scheme: 'light', alt: true },
    { file: `${id}-alt-dark.html`, theme: id, reader: 'visitor', scheme: 'dark', alt: true },
  ];
  for (const v of variants) {
    const site = v.empty ? EMPTY_SITE : SITE;
    const posts = v.empty ? [] : POSTS;
    const subscriber = v.reader === 'subscriber';
    const d: Design = v.empty
      ? { theme: id, files: null, settings: { scheme: v.scheme }, sections: null }
      : v.alt
        ? alternative(design, v.scheme)
        : { ...design, settings: { ...design.settings, scheme: v.scheme } };
    const { html } = renderDesign(
      theme,
      d,
      {
        globals: {
          site,
          posts,
          pinned: posts.filter((p) => p.is_pinned),
          featured: posts.find((p) => p.is_pinned) ?? posts[0] ?? null,
          page: { path: '/' },
        },
        reader: { is_subscriber: subscriber, is_paid: false },
        image: (mediaId) => MEDIA[mediaId] ?? null,
      },
      hooks(!!v.full),
    );
    const accent = String(theme.settings.find((s) => s.id === 'accent')?.default ?? '#6c4cf1');
    writeFileSync(
      join(OUT, v.file),
      shell({
        title: `${theme.name}: ${v.file}`,
        scheme: v.scheme,
        accent,
        theme,
        design: d,
        body: html,
        site,
      }),
    );
    pages.push(v);
  }
}
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Theme gallery</title><ul>${pages.map((p) => `<li><a href="${p.file}">${p.file}</a></li>`).join('')}</ul>`,
);
console.log(`Wrote ${pages.length} pages to ${OUT}`);
if (failed) process.exitCode = 1;

// ---- Screenshots, checks and thumbnails ----------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

if (flag('--shoot') || option('--axe') || option('--thumbs')) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    try {
      const body = readFileSync(join(OUT, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const pw = (
    await import(option('--playwright') ?? '/opt/node-tools/node_modules/playwright/index.js')
  ).default;
  const browser = await pw.chromium.launch();
  const shots = join(OUT, 'shots');
  mkdirSync(shots, { recursive: true });
  const axePath = option('--axe');
  const axeSource = axePath ? readFileSync(axePath, 'utf8') : null;
  const report: string[] = [];

  for (const spec of pages) {
    const dark = spec.scheme === 'dark' || (spec.scheme === 'auto' && true);
    const stem = spec.file.replace(/\.html$/, '');
    for (const [w, hgt] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width: w, height: hgt },
        colorScheme: dark ? 'dark' : 'light',
      });
      await page.goto(`${base}/${spec.file}`, { waitUntil: 'networkidle' });
      if (flag('--shoot')) {
        await page.screenshot({ path: join(shots, `${stem}-${w}.png`), fullPage: true });
        if (w === 390) await page.screenshot({ path: join(shots, `${stem}-${w}-first.png`) });
      }
      // The form is in the first screen for visitors, and nothing scrolls sideways.
      const facts = await page.evaluate(() => {
        const form = document.querySelector('main form[data-swarm-subscribe]');
        const email = form?.querySelector('input[type=email]')?.getBoundingClientRect();
        const button = form?.querySelector('button')?.getBoundingClientRect();
        return {
          emailBottom: email ? email.bottom : null,
          buttonBottom: button ? button.bottom : null,
          h1: document.querySelectorAll('h1').length,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      if (spec.reader === 'visitor') {
        if (facts.emailBottom === null || facts.emailBottom > hgt)
          report.push(
            `${spec.file} @${w}: the email field ends at ${facts.emailBottom}, below the first screen`,
          );
        else if (facts.buttonBottom === null || facts.buttonBottom > hgt)
          report.push(
            `${spec.file} @${w}: (note) the button ends at ${facts.buttonBottom}, below the first screen`,
          );
      }
      if (facts.h1 !== 1) report.push(`${spec.file} @${w}: ${facts.h1} h1 elements`);
      if (facts.overflow > 0)
        report.push(`${spec.file} @${w}: scrolls sideways by ${facts.overflow}px`);
      if (axeSource && w === 1440) {
        await page.addScriptTag({ content: axeSource });
        const result = await page.evaluate(async () => {
          const axe = (
            window as unknown as {
              axe: {
                run: (o: unknown) => Promise<{
                  violations: {
                    id: string;
                    impact: string;
                    nodes: { target: string[]; failureSummary: string }[];
                  }[];
                }>;
              };
            }
          ).axe;
          const r = await axe.run({
            runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
          });
          return r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes
              .slice(0, 4)
              .map((n) => `${n.target.join(' ')}: ${n.failureSummary.split('\n')[1] ?? ''}`),
          }));
        });
        for (const v of result)
          report.push(`${spec.file} axe ${v.impact} ${v.id}\n    ${v.nodes.join('\n    ')}`);
      }
      await page.close();
    }
    // Narrowest and widest screens: nothing should scroll sideways.
    for (const w of [320, 1600]) {
      const page = await browser.newPage({ viewport: { width: w, height: 800 } });
      await page.goto(`${base}/${spec.file}`, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) report.push(`${spec.file} @${w}: scrolls sideways by ${overflow}px`);
      await page.close();
    }
  }

  const thumbs = option('--thumbs');
  if (thumbs) {
    mkdirSync(thumbs, { recursive: true });
    for (const id of ids) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const scheme = defaultScheme[id] === 'dark' ? 'dark' : 'light';
      await page.goto(`${base}/${id}-visitor-${scheme}.html`, { waitUntil: 'networkidle' });
      const png = (await page.screenshot({ type: 'png' })).toString('base64');
      // Scaled and encoded as WebP by the browser itself, so no image library is needed.
      const webp = await page.evaluate(async (src: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 800;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, 1200, 800);
        return canvas.toDataURL('image/webp', 0.86).split(',')[1] ?? '';
      }, png);
      writeFileSync(join(thumbs, `${id}.webp`), Buffer.from(webp, 'base64'));
      await page.close();
    }
  }

  await browser.close();
  server.close();
  console.log(report.length ? report.join('\n') : 'No problems found.');
}
