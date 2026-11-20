/**
 * The click map: a frozen email template rewritten so it can be shown on a send's report, with a
 * numbered badge by each link and nothing in it that can fire.
 *
 * The output goes in `<iframe sandbox="" srcDoc>`, where scripts can't run, so the marks are written
 * here. The email may hold the owner's raw HTML, so this never edits the template in place: it reads
 * tags and writes new ones from allow-lists, which makes the output safe by how it is built. A
 * Content-Security-Policy in the document is the second lock.
 *
 * What can't happen in the output:
 *   - {{@pixel}}, {{@link:N}}, {{@unsubscribe}}, {{@member_center}} and {{@ask:…}} don't survive, in
 *     any position. No URL in the output comes from one, so nothing can count as an open or a click.
 *   - A link can't navigate: it has no href at all. A fragment isn't safe, because a srcdoc
 *     document resolves it against the page around it and would load that page in the frame.
 *   - A hidden or 1×1 image, or an image at a tracking path, is removed. Other images load as sent.
 *   - CSS can't fetch anything (url(), @import and the like are removed).
 *
 * Merge tags show their fallback, or nothing without one, as they do for a reader with no value.
 * Every Smart Block shows, with its markers gone.
 */
import { CLICK_MAP_LEVELS, formatClickShare } from './click-map-scale';
import { MERGE_FIELDS, MERGE_TAG } from './render';

/** The human clicks on one link target. `position` is the N of {{@link:N}}. */
interface ClickMapCount {
  position: number;
  people: number;
  clicks: number;
}

interface ClickMapLink extends ClickMapCount {
  /** The number on the badge: order of first appearance in this email. */
  number: number;
  /** How many places in the HTML use this target; they all share one count. */
  occurrences: number;
  /** This link's part of all the clicks in the view, from 0 to 1. */
  share: number;
  /** 0 for no clicks, then 1 to 4 as the link nears the most-clicked link. */
  level: number;
}

interface MarkedClickMap {
  html: string;
  links: ClickMapLink[];
  /** Links in the HTML with no tracked target (raw HTML blocks). */
  uncountedLinks: number;
  hasSmartBlocks: boolean;
}

const CSP =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

// Tags the email can keep. Anything else loses its tag and keeps its text.
const TAGS = new Set(
  `a abbr address article aside b big blockquote body br caption center cite code col colgroup dd
   del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins
   kbd li main mark nav ol p pre q s samp section small span strike strong sub summary sup table
   tbody td tfoot th thead time tr tt u ul`.split(/\s+/),
);
const VOID_TAGS = new Set(['br', 'col', 'hr', 'img']);
// Their content isn't markup, so it goes with them (style is handled on its own).
const RAW_TEXT_TAGS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
const ATTRIBUTES = new Set(
  `align aria-hidden aria-label bgcolor border cellpadding cellspacing class color colspan dir face
   height lang role rowspan size title valign width`.split(/\s+/),
);

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'open'; name: string; attrs: Map<string, string> }
  | { kind: 'close'; name: string }
  | { kind: 'raw'; name: string; value: string };

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Finds tags the way a browser's tokenizer does, so a `>` in a quoted attribute can't end one. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const text = (value: string) => {
    if (value) tokens.push({ kind: 'text', value });
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    i = lt;
    const next = html[i + 1] ?? '';
    if (next === '!' || next === '?' || (next === '/' && !/[a-z]/i.test(html[i + 2] ?? ''))) {
      i = skipComment(html, i);
    } else if (next === '/') {
      const end = endOfTag(html, i + 2);
      if (end === -1) break;
      const name = /^[^\s/>]+/.exec(html.slice(i + 2, end))?.[0]?.toLowerCase() ?? '';
      tokens.push({ kind: 'close', name });
      i = end + 1;
    } else if (/[a-z]/i.test(next)) {
      const tag = readTag(html, i + 1);
      if (!tag) break;
      i = tag.end;
      tokens.push({ kind: 'open', name: tag.name, attrs: tag.attrs });
      if (RAW_TEXT_TAGS.has(tag.name)) {
        const close = tag.name === 'plaintext' ? -1 : findClose(html, tag.name, i);
        tokens.push({
          kind: 'raw',
          name: tag.name,
          value: html.slice(i, close === -1 ? html.length : close),
        });
        if (close === -1) break;
        const end = endOfTag(html, close);
        i = end === -1 ? html.length : end + 1;
      }
    } else {
      text('<');
      i += 1;
    }
  }
  return tokens;
}

function skipComment(html: string, start: number): number {
  if (html.startsWith('<!--', start)) {
    // `<!-->` and `<!--->` close at once.
    if (html.startsWith('>', start + 4)) return start + 5;
    if (html.startsWith('->', start + 4)) return start + 6;
    const closes = [html.indexOf('-->', start + 4), html.indexOf('--!>', start + 4)].filter(
      (at) => at !== -1,
    );
    if (!closes.length) return html.length;
    const at = Math.min(...closes);
    return at + (html.startsWith('--!>', at) ? 4 : 3);
  }
  const end = html.indexOf('>', start);
  return end === -1 ? html.length : end + 1;
}

function endOfTag(html: string, start: number): number {
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      // A quote only opens a value right after `=`; elsewhere it is part of a name.
      if (html[i - 1] === '=') quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function findClose(html: string, name: string, start: number): number {
  const needle = `</${name}`;
  const lower = html.toLowerCase();
  let at = lower.indexOf(needle, start);
  while (at !== -1) {
    const after = html[at + needle.length];
    if (after === undefined || after === '>' || after === '/' || isSpace(after)) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return -1;
}

function readTag(
  html: string,
  start: number,
): { name: string; attrs: Map<string, string>; end: number } | null {
  let i = start;
  while (i < html.length && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  const name = html.slice(start, i).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < html.length && (isSpace(html[i]) || html[i] === '/')) i++;
    if (i >= html.length) return null;
    if (html[i] === '>') return { name, attrs, end: i + 1 };
    const nameStart = i;
    i++; // A leading `=` is part of the name.
    while (
      i < html.length &&
      !isSpace(html[i]) &&
      html[i] !== '/' &&
      html[i] !== '>' &&
      html[i] !== '='
    ) {
      i++;
    }
    const attr = html.slice(nameStart, i).toLowerCase();
    while (i < html.length && isSpace(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && isSpace(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end === -1) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const from = i;
        while (i < html.length && !isSpace(html[i]) && html[i] !== '>') i++;
        value = html.slice(from, i);
      }
    }
    // As in a browser, the first of a repeated attribute wins.
    if (!attrs.has(attr)) attrs.set(attr, value);
  }
}

const SYSTEM_PLACEHOLDER = /\{\{@[^{}]*\}\}/g;
const LINK_PLACEHOLDER = /\{\{@link:(\d+)\}\}/;

const escapeAttr = (value: string) =>
  value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== '#') {
      // Own names only: &constructor; is an entity this can't read, not Object.prototype's.
      const name = body.toLowerCase();
      return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
    }
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const FETCHING_CSS =
  /(url|image|image-set|src|element|paint|expression)\s*\(|@import|behavior|binding/i;

/** Keeps the declarations that can't fetch anything. Null when nothing safe is left. */
function safeStyle(raw: string): string | null {
  const decoded = decodeEntities(raw);
  // A CSS escape, or an entity this can't read, could spell out anything.
  if (/[\\&<>]/.test(decoded)) return null;
  const kept = decoded
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && !FETCHING_CSS.test(declaration));
  return kept.length ? kept.join(';') : null;
}

function safeStylesheet(css: string): string {
  if (/[\\<]|@font-face|@namespace|@charset/i.test(css) || FETCHING_CSS.test(css)) return '';
  return css;
}

const pixelSize = (value: string | undefined) => {
  if (value === undefined) return false;
  const number = parseFloat(value);
  return !Number.isNaN(number) && number <= 2;
};

/** The URL to keep for an image, or null when it is a pixel or can't be loaded safely. */
function safeImage(attrs: Map<string, string>): string | null {
  const raw = attrs.get('src');
  if (raw === undefined || raw.includes('{{')) return null;
  const src = decodeEntities(raw).trim();
  if (/^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=\s]*$/i.test(src)) {
    return hiddenImage(attrs) ? null : src;
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The paths of the open pixel and of a click, on any link domain.
  if (/^\/(o|c)\/[^/]+\/?$/.test(url.pathname)) return null;
  return hiddenImage(attrs) ? null : url.href;
}

function hiddenImage(attrs: Map<string, string>): boolean {
  if (pixelSize(attrs.get('width')) || pixelSize(attrs.get('height'))) return true;
  const style = decodeEntities(attrs.get('style') ?? '').toLowerCase();
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(;|$)/.test(style)) {
    return true;
  }
  return [
    ...style.matchAll(/(?:^|[;\s])(?:max-)?(?:width|height)\s*:\s*([\d.]+)(?:px)?\s*(?:;|$)/g),
  ].some((match) => pixelSize(match[1]));
}

function plainAttributes(attrs: Map<string, string>): string {
  let out = '';
  for (const [name, value] of attrs) {
    if (name === 'style') continue;
    if (!ATTRIBUTES.has(name)) continue;
    const clean = value.replace(SYSTEM_PLACEHOLDER, '');
    out += ` ${name}="${escapeAttr(clean)}"`;
  }
  const style = attrs.has('style') ? safeStyle(attrs.get('style')!) : null;
  if (style) out += ` style="${escapeAttr(style)}"`;
  return out;
}

const previewMergeTags = (html: string) =>
  html.replace(MERGE_TAG, (whole, field: string, fallback: string | undefined) =>
    (MERGE_FIELDS as readonly string[]).includes(field) || field.startsWith('field.')
      ? (fallback ?? '').trim()
      : whole,
  );

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const BADGE_BASE =
  "display:inline-block!important;visibility:visible!important;opacity:1!important;position:static!important;margin:4px 0 4px 6px!important;padding:1px 7px!important;border-radius:999px!important;font:600 12px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif!important;letter-spacing:0!important;text-transform:none!important;text-decoration:none!important;white-space:nowrap!important;vertical-align:middle!important;";

function badge(link: ClickMapLink): string {
  const level = CLICK_MAP_LEVELS[link.level] ?? CLICK_MAP_LEVELS[0];
  const shared = link.occurrences > 1 ? ' · shared count' : '';
  const people = `${link.people} ${plural(link.people, 'person', 'people')}`;
  return `<span data-map-link="${link.number}" style="${BADGE_BASE}background:${level.background}!important;color:${level.ink}!important;border:1px solid ${level.outline}!important">#${link.number} · ${people} · ${formatClickShare(link.share)}${shared}</span>`;
}

const UNCOUNTED_BADGE = `<span data-map-uncounted style="${BADGE_BASE}background:#ffffff!important;color:#4b5568!important;border:1px dashed #8a94a6!important">Not counted</span>`;

const outlineFor = (level: { outline: string; width: number; style: string }) =>
  `outline:${level.width}px ${level.style} ${level.outline}!important;outline-offset:2px!important`;

const LINK_LOOK = 'color:#1a4fa0;text-decoration:underline;cursor:default';

type LinkRole = { kind: 'tracked'; position: number } | { kind: 'uncounted' } | { kind: 'quiet' };

function linkRole(href: string, known: Set<number>): LinkRole {
  const match = LINK_PLACEHOLDER.exec(href);
  if (match) {
    const position = Number(match[1]);
    // A number with no target goes nowhere useful in the real email and has nothing to count.
    return known.has(position) ? { kind: 'tracked', position } : { kind: 'uncounted' };
  }
  // Footer links and poll buttons: real parts of the email, with no count on this map.
  if (href.includes('{{@')) return { kind: 'quiet' };
  return /^\s*https?:/i.test(decodeEntities(href)) ? { kind: 'uncounted' } : { kind: 'quiet' };
}

/**
 * Writes the map for one email. `counts` lists its link targets; `listEvery` keeps targets the HTML
 * doesn't use in the list, where otherwise only those with clicks are kept (the plain-text part has
 * them too, and a shared link list holds other versions' links).
 */
export function markClickMap(
  template: string,
  counts: readonly ClickMapCount[],
  { listEvery = false }: { listEvery?: boolean } = {},
): MarkedClickMap {
  const hasSmartBlocks = template.includes('<!--swarm:sb:');
  // First, so whatever a fallback holds passes through the same allow-lists as everything else.
  const tokens = tokenize(previewMergeTags(template));
  const byPosition = new Map(counts.map((count) => [count.position, count]));
  const known = new Set(byPosition.keys());

  // A first pass, because the first badge of a repeated link has to say it is shared.
  const order: number[] = [];
  const occurrences = new Map<number, number>();
  for (const token of tokens) {
    if (token.kind !== 'open' || token.name !== 'a') continue;
    const href = token.attrs.get('href');
    if (href === undefined) continue;
    const role = linkRole(href, known);
    if (role.kind !== 'tracked') continue;
    if (!occurrences.has(role.position)) order.push(role.position);
    occurrences.set(role.position, (occurrences.get(role.position) ?? 0) + 1);
  }

  const total = counts.reduce((sum, count) => sum + count.clicks, 0);
  const most = counts.reduce((max, count) => Math.max(max, count.clicks), 0);
  const describe = (count: ClickMapCount, number: number): ClickMapLink => ({
    position: count.position,
    people: count.people,
    clicks: count.clicks,
    number,
    occurrences: occurrences.get(count.position) ?? 0,
    share: total > 0 ? count.clicks / total : 0,
    level: count.clicks > 0 && most > 0 ? Math.max(1, Math.ceil((count.clicks / most) * 4)) : 0,
  });
  const links = order.map((position, index) =>
    describe(byPosition.get(position) as ClickMapCount, index + 1),
  );
  for (const count of [...counts].sort((a, b) => a.position - b.position)) {
    if (occurrences.has(count.position) || (!listEvery && count.clicks === 0)) continue;
    links.push(describe(count, links.length + 1));
  }
  const linkAt = new Map(links.map((link) => [link.position, link]));

  let out = `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Click map</title>`;
  let uncountedLinks = 0;
  // The badge waiting for the open link to close. Links don't nest, so there is one at most.
  let pending: string | null = null;
  const closeLink = () => {
    if (pending === null) return;
    out += `</a>${pending}`;
    pending = null;
  };

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += token.value.replace(SYSTEM_PLACEHOLDER, '').replace(/</g, '&lt;');
        break;
      case 'raw':
        if (token.name === 'style') {
          const css = safeStylesheet(token.value);
          if (css) out += `<style>${css}</style>`;
        }
        break;
      case 'close':
        if (token.name === 'a') closeLink();
        else if (TAGS.has(token.name) && !VOID_TAGS.has(token.name)) out += `</${token.name}>`;
        break;
      case 'open': {
        if (token.name === 'a') {
          closeLink();
          const href = token.attrs.get('href');
          const role: LinkRole = href === undefined ? { kind: 'quiet' } : linkRole(href, known);
          const tracked = role.kind === 'tracked' ? linkAt.get(role.position) : undefined;
          if (role.kind === 'uncounted') uncountedLinks += 1;
          const level = tracked ? CLICK_MAP_LEVELS[tracked.level] : undefined;
          const outline = level
            ? outlineFor(level)
            : role.kind === 'uncounted'
              ? outlineFor(CLICK_MAP_LEVELS[0])
              : '';
          const attrs = new Map(token.attrs);
          const style = attrs.has('style') ? safeStyle(attrs.get('style')!) : null;
          attrs.delete('style');
          attrs.delete('role');
          attrs.delete('aria-disabled');
          // Looks like a link and is announced as one, with nowhere to go. Its own style wins.
          const merged = [LINK_LOOK, style, outline].filter(Boolean).join(';');
          out += `<a role="link" aria-disabled="true"${plainAttributes(attrs)} style="${escapeAttr(merged)}">`;
          pending = tracked ? badge(tracked) : role.kind === 'uncounted' ? UNCOUNTED_BADGE : '';
        } else if (token.name === 'img') {
          const src = safeImage(token.attrs);
          if (src === null) break;
          const alt = (token.attrs.get('alt') ?? '').replace(SYSTEM_PLACEHOLDER, '');
          out += `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${plainAttributes(token.attrs)}>`;
        } else if (TAGS.has(token.name)) {
          out += `<${token.name}${plainAttributes(token.attrs)}>`;
        }
        break;
      }
    }
  }
  closeLink();
  return { html: out, links, uncountedLinks, hasSmartBlocks };
}
