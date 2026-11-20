// Channel websites (Phase 4): shared types for the site worker, the Site Studio API and the dashboard.
import { z } from '@hono/zod-openapi';

/** Who may read a Dispatch in full on the site. 'hidden' keeps it off the site entirely. */
const WEB_VISIBILITIES = ['public', 'members', 'paid', 'hidden'] as const;
export const WebVisibilitySchema = z.enum(WEB_VISIBILITIES).openapi('WebVisibility');
export type WebVisibility = z.infer<typeof WebVisibilitySchema>;

/**
 * What the current reader is entitled to. Resolved per request by the site worker from the reader
 * session; it is part of the edge cache key, so pages never leak between classes.
 */
export type ReaderClass = 'anonymous' | 'member' | 'paid';

/** Whether a reader of `reader` class may read a Dispatch with `visibility` past its gate. */
export function canReadFull(visibility: WebVisibility, reader: ReaderClass): boolean {
  switch (visibility) {
    case 'public':
      return true;
    case 'members':
      return reader !== 'anonymous';
    case 'paid':
      return reader === 'paid';
    case 'hidden':
      return false;
  }
}

/** Lowercase letters, digits and single hyphens, as in URLs. */
export const SiteSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and hyphens.')
  .max(120);

/** Turns a title into a slug candidate (callers make it unique). */
export function slugify(title: string, max = 80): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'dispatch';
}

/**
 * Site paths the platform owns. Pages, sections and Dispatch slugs can never take these, so a
 * Channel's content can't shadow a system route.
 */
export const RESERVED_SITE_PATHS = [
  '_swarm',
  'p',
  's',
  'archive',
  'about',
  'search',
  'feed',
  'feed.json',
  'sitemap',
  'sitemap.xml',
  'robots.txt',
  'media',
  'healthz',
  'offline',
  '.well-known',
  // The plans page (Phase 5).
  'subscribe',
  // Champions (Phase 6): the referral link /r/<code> and the public top Champions page.
  'r',
  'champions',
  // Series pages /series/<slug> (Phase 6, flag post_series).
  'series',
  // Link Hub /links (Phase 8, flag link_hub).
  'links',
  // Author pages /authors/<slug> (flag author_pages).
  'authors',
] as const;

export const SiteLayoutSchema = z.enum(['magazine', 'newspaper']).openapi('SiteLayout');
export type SiteLayout = z.infer<typeof SiteLayoutSchema>;

export const AiBotsPolicySchema = z
  .enum(['unset', 'allow', 'block', 'custom'])
  .openapi('AiBotsPolicy');
export type AiBotsPolicy = z.infer<typeof AiBotsPolicySchema>;

/**
 * AI crawlers the Bot Rules know by name. `ua` is matched case-insensitively against the
 * User-Agent; `robots` is the token written to robots.txt. Verified-bot categories from
 * Cloudflare (cf.verifiedBotCategory) are checked as well where available.
 */
export const KNOWN_AI_BOTS = [
  { key: 'gptbot', name: 'GPTBot (OpenAI)', ua: 'GPTBot', robots: 'GPTBot' },
  {
    key: 'chatgpt-user',
    name: 'ChatGPT-User (OpenAI)',
    ua: 'ChatGPT-User',
    robots: 'ChatGPT-User',
  },
  {
    key: 'oai-searchbot',
    name: 'OAI-SearchBot (OpenAI)',
    ua: 'OAI-SearchBot',
    robots: 'OAI-SearchBot',
  },
  { key: 'claudebot', name: 'ClaudeBot (Anthropic)', ua: 'ClaudeBot', robots: 'ClaudeBot' },
  { key: 'claude-user', name: 'Claude-User (Anthropic)', ua: 'Claude-User', robots: 'Claude-User' },
  { key: 'ccbot', name: 'CCBot (Common Crawl)', ua: 'CCBot', robots: 'CCBot' },
  {
    key: 'google-extended',
    name: 'Google-Extended',
    ua: 'Google-Extended',
    robots: 'Google-Extended',
  },
  {
    key: 'applebot-extended',
    name: 'Applebot-Extended',
    ua: 'Applebot-Extended',
    robots: 'Applebot-Extended',
  },
  { key: 'perplexitybot', name: 'PerplexityBot', ua: 'PerplexityBot', robots: 'PerplexityBot' },
  { key: 'bytespider', name: 'Bytespider (ByteDance)', ua: 'Bytespider', robots: 'Bytespider' },
  {
    key: 'meta-externalagent',
    name: 'Meta-ExternalAgent',
    ua: 'meta-externalagent',
    robots: 'meta-externalagent',
  },
  { key: 'amazonbot', name: 'Amazonbot', ua: 'Amazonbot', robots: 'Amazonbot' },
  { key: 'cohere-ai', name: 'cohere-ai', ua: 'cohere-ai', robots: 'cohere-ai' },
] as const;
export type AiBotKey = (typeof KNOWN_AI_BOTS)[number]['key'];

// ---------------------------------------------------------------------------------------------
// Colour contrast, for the publication's accent colour on reader-facing pages (website, signup
// forms, subscriber settings). The owner picks any colour; these keep what is drawn with it readable.

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
export function colorLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [colorLuminance(a), colorLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `from` moved `amount` (0 to 1) of the way to `to`, as #rrggbb. */
export function mixColors(from: string, to: string, amount: number): string {
  const a = rgbOf(from);
  const b = rgbOf(to);
  return `#${a
    .map((value, i) =>
      Math.round(value + (b[i]! - value) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Text drawn on `background`: near-black or white, whichever contrasts more. */
export function textOn(background: string): '#0f0f12' | '#ffffff' {
  if (!HEX_COLOR.test(background)) return '#ffffff';
  return contrastRatio('#0f0f12', background) >= contrastRatio('#ffffff', background)
    ? '#0f0f12'
    : '#ffffff';
}

/**
 * `color` as it can be used for text on `background`: unchanged when it already reaches `target`
 * (4.5:1, WCAG AA for body text), else moved towards black or white in small steps until it does.
 * A colour that isn't #rrggbb comes back unchanged.
 */
export function readableColor(color: string, background: string, target = 4.5): string {
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(background)) return color;
  if (contrastRatio(color, background) >= target) return color.toLowerCase();
  const towards = colorLuminance(background) > 0.18 ? '#000000' : '#ffffff';
  for (let step = 1; step <= 20; step++) {
    const candidate = mixColors(color, towards, step / 20);
    if (contrastRatio(candidate, background) >= target) return candidate;
  }
  return towards;
}
