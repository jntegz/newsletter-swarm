/**
 * Server-side Dispatch renderer: editor document (TipTap JSON) → email HTML and plain text.
 *
 * The output is a *template*. Per-recipient values are left as placeholders and filled in by
 * `personalize` at send time:
 *   {{@link:N}}      the Nth distinct link (rewritten to a tracking URL, or restored for preview)
 *   {{@unsubscribe}} the Member's unsubscribe page
 *   {{@member_center}} the Member's Member Center (profile, pause, digest, unsubscribe)
 *   {{@pixel}}       the open pixel <img>, or nothing when open tracking is off
 *   {{@ask:<optionId>}} a one-tap poll link for one option (`askPoll` block): signed per
 *                    recipient by the send pipeline, '#' in previews and test sends
 *   {{ first_name | fallback }}, {{ last_name }}, {{ email }}  merge tags, typed by the author
 *
 * With the code_embeds flag (`codeEmbeds`), code blocks are highlighted with inline colours
 * (./highlight) and a table of contents block (`tableOfContents`, top level only) lists the
 * top-level headings as plain text; without it the block is refused. With custom_email_css
 * (`customCss`), the Channel's stylesheet is placed by ./css: inline where it can be, otherwise
 * in a `<style>` element in the head.
 *
 * Smart Blocks (`smartBlock`, top level only) are wrapped in `<!--swarm:sb:<i>-->` …
 * `<!--/swarm:sb:<i>-->` in both parts; `personalize` keeps the ones a recipient sees (dropping
 * the markers) and removes the rest with their content. See "Smart Blocks" in @swarm/domain p6-growth.ts.
 *
 * A block's `attrs.showOn` ('email' or 'web'; absent or null means both, see blockShownOn) keeps it
 * out of the other surface: a 'web' block leaves no html, text, link, footnote or heading in the
 * email, and is still checked so a broken block is refused before it reaches the site.
 *
 * A linked snippet (`snippet`, top level only) is replaced by its blocks before this renderer runs
 * (./snippets); one still here is gone, so it renders nothing, with a warning.
 *
 * The document frame (head, page and card tables, preheader, button) is ./shell, shared with
 * system emails, and the colours are ./palette. Between them they carry what email needs beyond
 * the markup: a fixed-width table and padded cells for Outlook on Windows, a dark palette for
 * `prefers-color-scheme` and Outlook.com, tighter gutters on a phone. Blocks that need a border
 * or padding are tables for the same reason, and every image has a pixel `width` that fits the
 * box it sits in.
 *
 * Every attribute that reaches the HTML is escaped here. Unknown node types are refused rather
 * than dropped, so a client can never smuggle markup past the renderer.
 */
import { embedInfo, imageWidthPercent } from './embeds';
import { applyEmailCss, lintEmailCss } from './css';
import { emailCodeDarkCss, highlightEmail, normalizeLanguage } from './highlight';
import { escapeHtml } from './index';
import { darkTheme, emailTheme, type EmailTheme, type ThemeInput } from './palette';
import {
  CARD_GUTTER,
  EMAIL_FONTS,
  directionOf,
  emailButton,
  preheaderHtml,
  shellBody,
  shellHead,
  type TextDirection,
} from './shell';
import { SNIPPET_GONE_WARNING, SNIPPET_NODE } from './snippets';

export interface EmailDesignOptions {
  font?: 'system' | 'serif' | 'mono';
  logoUrl?: string | null;
  pageColor?: string | undefined;
  cardColor?: string | undefined;
  textColor?: string | undefined;
  header?: string;
  /** A line under every email, such as the publication's postal address. */
  footer?: string;
}

/** The card is 600px wide: what mail apps have agreed on. */
const CARD_WIDTH = 600;
/** The width blocks have inside the card, for the `width` attribute Outlook sizes images by. */
const CONTENT_WIDTH = CARD_WIDTH - 2 * CARD_GUTTER - 2;

export interface RenderOptions {
  channelName: string;
  accentColor?: string | null;
  preheader?: string;
  /** Public URL of a media library item, or null when it does not belong to this workspace. */
  mediaUrl: (mediaId: string) => string | null;
  /**
   * The Dispatch's cover image, shown above the body in every variant. `url` is null when the
   * media item is gone: the image is left out with a warning, so it can never stop a send.
   */
  cover?: { url: string | null; alt: string } | null;
  /** Raw HTML blocks are allowed only when the raw_html_mode flag is on. */
  allowHtmlBlocks: boolean;
  /**
   * Who may read the Dispatch in full on the site. Email goes to Members, so for 'public',
   * 'members' and 'hidden' (or when absent) it carries everything and a gate divider renders
   * nothing. For 'paid' the teaser variant stops at the first gate and ends with a button to
   * `webUrl`; the full variant, for Members the Gate admits, carries everything.
   */
  webVisibility?: 'public' | 'members' | 'paid' | 'hidden';
  /** Which email a 'paid' Dispatch renders as; 'teaser' when absent. Ignored otherwise. */
  paidVariant?: EmailVariant;
  /** The Dispatch's web address, for the "Continue reading on the web" button. */
  webUrl?: string | null;
  /**
   * The Ask question an `askPoll` block points at, or null when it isn't one of this Channel's
   * choice questions (the block is then refused). Without it every poll block is refused.
   */
  ask?: (askId: string, questionId: string) => AskPollView | null;
  /** Highlighted code blocks and the table of contents block: the code_embeds flag. */
  codeEmbeds?: boolean;
  /** The Channel's email design, when the email_design flag is on. */
  design?: EmailDesignOptions | null | undefined;
  /** The Channel's email CSS, when the custom_email_css flag is on; linted again here. */
  customCss?: string | null;
  /** The language the Dispatch is written in (BCP 47), for `<html lang>`. 'en' when absent. */
  lang?: string | null;
  /** The reading direction. When absent it follows the script most of the text is written in. */
  dir?: TextDirection;
}

/** The table of contents block: `{ type: 'tableOfContents', attrs: { title? } }`, top level. */
export const TOC_NODE = 'tableOfContents';

/** Which output a block is being rendered for. */
type BlockSurface = 'email' | 'web';

const showOnOf = (node: unknown): unknown =>
  typeof node === 'object' && node !== null
    ? (node as { attrs?: { showOn?: unknown } }).attrs?.showOn
    : undefined;

/**
 * Whether a block belongs on this surface, from its `attrs.showOn`: 'email' or 'web' keeps it to
 * that one, absent or null shows it on both. Any other value is refused, so a typo can never put
 * text meant for one surface on the other.
 */
export function blockShownOn(node: unknown, surface: BlockSurface): boolean {
  const showOn = showOnOf(node);
  if (showOn === undefined || showOn === null) return true;
  if (showOn !== 'email' && showOn !== 'web') {
    throw new RenderError('A block can show on email or web only.');
  }
  return showOn === surface;
}

/** The blocks of a list that belong on this surface. Refusing a bad value is left to rendering. */
export function shownBlocks<T>(nodes: T[], surface: BlockSurface): T[] {
  const other = surface === 'email' ? 'web' : 'email';
  return nodes.filter((node) => showOnOf(node) !== other);
}

/** True when any block of a document, at any depth, is kept to email or to the web. */
export function usesBlockVisibility(node: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH + 2 || typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some((child) => usesBlockVisibility(child, depth + 1));
  const showOn = showOnOf(node);
  if (showOn !== undefined && showOn !== null) return true;
  return usesBlockVisibility((node as { content?: unknown }).content, depth + 1);
}

/** List items and columns are parts of a block, so they can't be kept to one surface themselves. */
export function refuseShowOnPart(node: unknown): void {
  const showOn = showOnOf(node);
  if (showOn !== undefined && showOn !== null) {
    throw new RenderError('Only a whole block can show on email or web only.');
  }
}

/** The plain text of a heading node (its text children), for tables of contents. */
function headingText(node: unknown): string {
  const content = (node as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((child) => {
      const n = child as { type?: unknown; text?: unknown } | null;
      return n?.type === 'text' && typeof n.text === 'string' ? n.text : ' ';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Top-level headings of a list of blocks, in order (Smart Blocks and quotes are not looked in). */
export function topLevelHeadings(nodes: unknown): { level: number; text: string; node: unknown }[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node) => (node as { type?: unknown } | null)?.type === 'heading')
    .map((node) => ({
      level: Math.min(3, Math.max(1, Number((node as Node).attrs?.level) || 2)),
      text: headingText(node),
      node,
    }))
    .filter((h) => h.text);
}

/** What an `askPoll` block shows: the Ask's title, the question and its options. */
export interface AskPollView {
  title: string;
  description: string | null;
  prompt: string;
  status: 'draft' | 'open' | 'closed';
  options: { id: string; label: string }[];
}

/** The editor block for a one-tap poll: `{ type: 'askPoll', attrs: { askId, questionId } }`. */
export const ASK_POLL_NODE = 'askPoll';
const ASK_OPTION_ID = /^ao_[0-9a-f]{32}$/;
/** The per-recipient poll link placeholder (see personalize). */
const askPlaceholder = (optionId: string) => `{{@ask:${optionId}}}`;
const ASK_PLACEHOLDER = /\{\{@ask:(ao_[0-9a-f]{32})\}\}/g;

/** The gate divider: a top-level block with no attributes; what follows it is the gated part. */
const GATE_NODE = 'gate';

/** A Smart Block: a top-level block whose content is shown or hidden per recipient. */
const SMART_BLOCK = 'smartBlock';

/** The markers around Smart Block `index` (document order, 0-based). */
function smartBlockMarker(index: number): [open: string, close: string] {
  return [`<!--swarm:sb:${index}-->`, `<!--/swarm:sb:${index}-->`];
}

const ANY_MARKER = /<!--\/?swarm:sb:\d+-->/g;

/** A Smart Block as the renderer saw it; the condition is checked by the engine, not here. */
interface RenderedSmartBlock {
  index: number;
  label: string | null;
  anonymous: 'hide' | 'show';
  condition: unknown;
}

/**
 * The top-level Smart Blocks of a document, in order. Nothing else is inspected. A website-only
 * block is not in the email, so by default it takes no index: these indexes are the markers the
 * email renderer writes. `allSurfaces` counts every block, for checks on the document itself.
 */
export function smartBlocksOf(
  content: unknown,
  { allSurfaces = false }: { allSurfaces?: boolean } = {},
): RenderedSmartBlock[] {
  const doc = content as { content?: unknown } | null;
  const blocks = Array.isArray(doc?.content) ? doc.content : Array.isArray(content) ? content : [];
  const out: RenderedSmartBlock[] = [];
  for (const node of blocks as Node[]) {
    if (node?.type !== SMART_BLOCK) continue;
    const attrs = node.attrs ?? {};
    if (!allSurfaces && attrs.showOn === 'web') continue;
    out.push({
      index: out.length,
      label: typeof attrs.label === 'string' ? attrs.label : null,
      anonymous: attrs.anonymous === 'show' ? 'show' : 'hide',
      condition: attrs.condition,
    });
  }
  return out;
}

/** True when a template carries Smart Block markers. */
export function hasSmartBlockMarkers(template: { html: string; text: string }): boolean {
  return template.html.includes('<!--swarm:sb:') || template.text.includes('<!--swarm:sb:');
}

/**
 * Keeps the Smart Blocks in `visible` (without their markers) and removes the others with their
 * content. `visible` undefined keeps every block (previews that aren't "as a Member").
 */
export function applySmartBlocks<T extends { html: string; text: string }>(
  template: T,
  visible: readonly number[] | undefined,
): T {
  if (!hasSmartBlockMarkers(template)) return template;
  const keep = visible === undefined ? null : new Set(visible);
  const shown = (index: string) => keep === null || keep.has(Number(index));
  const html = template.html.replace(
    /<!--swarm:sb:(\d+)-->([\s\S]*?)<!--\/swarm:sb:\1-->/g,
    (_, index: string, inner: string) => (shown(index) ? inner : ''),
  );
  // In text, blocks are separated by a blank line: a removed block takes one separator with it.
  const text = template.text.replace(
    /(\n\n)?<!--swarm:sb:(\d+)-->\n([\s\S]*?)\n<!--\/swarm:sb:\2-->(\n\n)?/g,
    (_, before: string | undefined, index: string, inner: string, after: string | undefined) =>
      shown(index)
        ? `${before ?? ''}${inner}${after ?? ''}`
        : before !== undefined && after !== undefined
          ? '\n\n'
          : '',
  );
  return { ...template, html, text };
}

/** The two emails of a gated paid Dispatch: everything, or up to the gate. */
export type EmailVariant = 'full' | 'teaser';

/** True when the document has a gate divider between its top-level blocks. */
export function hasGateDivider(content: unknown): boolean {
  const doc = content as { content?: unknown } | null;
  const blocks = Array.isArray(doc?.content) ? doc.content : Array.isArray(content) ? content : [];
  return blocks.some((node) => (node as { type?: unknown } | null)?.type === GATE_NODE);
}

/**
 * Gives the full and teaser templates of one Broadcast one shared link list, so a single set of
 * link targets serves both: the full template's links come first (its placeholders are
 * unchanged) and the teaser's placeholders are renumbered into the shared list.
 */
export function shareLinks(
  full: RenderedTemplate,
  teaser: RenderedTemplate,
): { full: RenderedTemplate; teaser: RenderedTemplate } {
  const links = [...full.links];
  const map = teaser.links.map((url) => {
    const index = links.indexOf(url);
    return index === -1 ? links.push(url) - 1 : index;
  });
  const renumber = (input: string) =>
    input.replace(/\{\{@link:(\d+)\}\}/g, (_, n: string) => `{{@link:${map[Number(n)] ?? n}}}`);
  return {
    full: { ...full, links },
    teaser: { ...teaser, html: renumber(teaser.html), text: renumber(teaser.text), links },
  };
}

/** The top-level blocks before the first gate divider (all of them when there is none). */
function beforeGate(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const index = content.findIndex(
    (node) => (node as { type?: unknown } | null)?.type === GATE_NODE,
  );
  return index === -1 ? content : content.slice(0, index);
}

/** The warning for a post with nothing to read. The pre-send checklist turns it into a failed check. */
export const EMPTY_WARNING = 'The post is empty.';

export interface RenderedTemplate {
  /** Full email document with placeholders. */
  html: string;
  /** Plain-text part with placeholders. */
  text: string;
  /** Distinct link URLs in order of first appearance; {{@link:N}} indexes into this. */
  links: string[];
  /** Merge tags used, for the pre-send checklist. */
  mergeTags: { field: string; fallback: string | null }[];
  warnings: string[];
  /** Smart Blocks in the rendered part, in order (their markers are in html and text). */
  smartBlocks?: RenderedSmartBlock[];
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

interface Node {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  text?: unknown;
  marks?: unknown;
}

interface Mark {
  type?: unknown;
  attrs?: Record<string, unknown>;
}

export const MERGE_FIELDS = ['first_name', 'last_name', 'email'] as const;
export const MERGE_TAG = /\{\{\s*(field\.[a-z][a-z0-9_]*|[a-z_]+)\s*(?:\|\s*([^{}]*?))?\s*\}\}/g;

/** Gmail clips messages over ~102 KB. */
export const GMAIL_CLIP_BYTES = 102 * 1024;
const MAX_DEPTH = 24;

const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace`;

const themeInput = (options: RenderOptions): ThemeInput => ({
  accent: options.accentColor,
  page: options.design?.pageColor,
  card: options.design?.cardColor,
  text: options.design?.textColor,
});

/** The text of a document's first blocks, enough to tell which way it reads. */
function sampleText(node: unknown, budget = { left: 4000 }, depth = 0): string {
  if (budget.left <= 0 || depth > MAX_DEPTH + 2 || typeof node !== 'object' || node === null) {
    return '';
  }
  if (Array.isArray(node)) return node.map((n) => sampleText(n, budget, depth + 1)).join(' ');
  const { text, content } = node as Node;
  if (typeof text === 'string') {
    budget.left -= text.length;
    return text;
  }
  return sampleText(content, budget, depth + 1);
}

/** A table with nothing but layout to say: no borders, no spacing, skipped by screen readers. */
const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

/** The last block's bottom margin, removed where a box's own padding already ends it. */
const trimLastMargin = (html: string) =>
  html.replace(/margin:0 0 16px;(?![\s\S]*margin:0 0 16px;)/, 'margin:0;');

/** Accepts http(s) and mailto URLs only. Returns the normalised URL or null. */
export function safeUrl(value: unknown, options: { mailto?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  if (options.mailto && /^mailto:[^\s<>"]+$/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * A real image with alt text and a `width` attribute in px: Outlook on Windows sizes by the
 * attribute alone, every other app by the style, which lets the image shrink with the screen.
 * `available` is the width of whatever the image sits in.
 */
const emailImage = (src: string, alt: string, available: number, percent: number | null = null) => {
  const width = Math.max(1, Math.round((available * (percent ?? 100)) / 100));
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" style="display:block;width:${percent ?? 100}%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:8px">`;
};

class Renderer {
  readonly links: string[] = [];
  readonly warnings = new Set<string>();
  readonly mergeTags = new Map<string, { field: string; fallback: string | null }>();
  readonly smartBlocks: RenderedSmartBlock[] = [];
  /** Top-level headings of the part being rendered, for the table of contents block. */
  headings: { level: number; text: string }[] = [];
  /** Set when a code block was highlighted, so the email carries the dark-mode rules. */
  highlighted = false;
  /** Set when columns were used, so the email carries the rule that stacks them on a phone. */
  stacksColumns = false;
  readonly footnotes: string[] = [];
  /** The publication's accent as chosen: rules, bars and the button. */
  private readonly accent: string;
  /** The width in px of whatever is being rendered into (the card's content, a column, a quote). */
  private available = CONTENT_WIDTH;

  constructor(
    private readonly options: RenderOptions,
    readonly theme: EmailTheme = emailTheme(themeInput(options)),
    /** The side lines start on: 'right' for Hebrew and Arabic script. */
    readonly start: 'left' | 'right' = 'left',
    /** The dark-mode theme, or null when the card is dark already. */
    private readonly dark: EmailTheme | null = darkTheme(theme, themeInput(options)),
  ) {
    this.accent = theme.button;
  }

  /** Renders something that sits `inset` px inside the current width. */
  private inside<T>(inset: number, render: () => T): T {
    const before = this.available;
    this.available = Math.max(80, before - inset);
    try {
      return render();
    } finally {
      this.available = before;
    }
  }

  /** `padding` for a box indented by `px` on the side lines start on. */
  private indent(px: number): string {
    return this.start === 'left' ? `0 0 0 ${px}px` : `0 ${px}px 0 0`;
  }

  /** Returns the placeholder for a URL; mailto links are kept as they are. */
  link(url: string): string {
    if (url.toLowerCase().startsWith('mailto:')) return escapeHtml(url);
    let index = this.links.indexOf(url);
    if (index === -1) index = this.links.push(url) - 1;
    return `{{@link:${index}}}`;
  }

  noteMergeTags(text: string): void {
    for (const match of text.matchAll(MERGE_TAG)) {
      const field = match[1] as string;
      const fallback = match[2]?.trim() || null;
      if (!(MERGE_FIELDS as readonly string[]).includes(field) && !field.startsWith('field.')) {
        this.warnings.add(`Unknown merge tag "${field}" will be sent as written.`);
        continue;
      }
      this.mergeTags.set(`${field}|${fallback ?? ''}`, { field, fallback });
    }
  }

  /**
   * `boxed`: the blocks fill a box of their own (a column, a callout, a quote), so the first
   * one starts at its edge. A Smart Block's content is part of the flow around it instead.
   */
  blocks(nodes: unknown, depth: number, boxed = depth > 0): { html: string; text: string } {
    if (depth > MAX_DEPTH) throw new RenderError('The document is nested too deeply.');
    if (nodes === undefined) return { html: '', text: '' };
    if (!Array.isArray(nodes)) throw new RenderError('Node content must be a list.');
    const html: string[] = [];
    const text: string[] = [];
    let previous: string | null = null;
    for (const node of nodes as Node[]) {
      if (!blockShownOn(node, 'email')) {
        // Website only: nothing of it reaches the email, but a broken block is still refused.
        new Renderer(this.options, this.theme, this.start, this.dark).block(node, depth + 1);
        if (node.type === SNIPPET_NODE) this.warnings.add(SNIPPET_GONE_WARNING);
        continue;
      }
      const out = this.block(node, depth + 1);
      if (out.html) {
        // Margins don't collapse against a table cell's edge or a divider the way they do
        // between paragraphs, so a heading that opens a box or follows a rule gives its own up.
        const first = html.length === 0;
        const top =
          previous === 'horizontalRule' || (first && boxed) ? 0 : first && depth === 0 ? 8 : 24;
        html.push(
          node.type === 'heading' && top !== 24
            ? out.html.replace('margin:24px 0 12px', `margin:${top}px 0 12px`)
            : out.html,
        );
        previous = typeof node.type === 'string' ? node.type : null;
      }
      if (out.text) text.push(out.text);
    }
    return { html: html.join(''), text: text.join('\n\n') };
  }

  block(node: Node, depth: number): { html: string; text: string } {
    if (typeof node !== 'object' || node === null) throw new RenderError('Invalid node.');
    const attrs = node.attrs ?? {};
    switch (node.type) {
      case 'paragraph': {
        const inner = this.inline(node.content);
        if (!inner.html.trim()) return { html: '<p style="margin:0 0 16px">&nbsp;</p>', text: '' };
        return {
          html: `<p class="sw-t" style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${this.theme.body}">${inner.html}</p>`,
          text: inner.text,
        };
      }
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(attrs.level) || 2));
        const size = { 1: 28, 2: 22, 3: 18 }[level];
        const inner = this.inline(node.content);
        return {
          html: `<h${level} class="sw-h" style="margin:24px 0 12px;font-size:${size}px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${this.theme.ink}">${inner.html}</h${level}>`,
          text: inner.text,
        };
      }
      case 'bulletList':
      case 'orderedList': {
        const tag = node.type === 'bulletList' ? 'ul' : 'ol';
        const items = this.inside(24, () =>
          this.listItems(node.content, depth, node.type === 'orderedList'),
        );
        return {
          html: `<${tag} class="sw-t" style="margin:0 0 16px;padding:${this.indent(24)};font-size:16px;line-height:1.6;color:${this.theme.body}">${items.html}</${tag}>`,
          text: items.text,
        };
      }
      case 'blockquote': {
        const inner = this.inside(19, () => this.blocks(node.content, depth));
        // The bar is a table cell's border: Outlook draws neither padding nor a border on a quote.
        return {
          html: `<blockquote style="margin:0 0 16px"><table ${TABLE}><tr><td class="sw-t sw-bar" style="padding:2px ${this.start === 'left' ? `0 2px 16px` : `16px 2px 0`};border-${this.start}:3px solid ${this.accent};color:${this.theme.body}">${trimLastMargin(inner.html)}</td></tr></table></blockquote>`,
          text: inner.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        };
      }
      case 'codeBlock': {
        const inner = this.plain(node.content);
        const language = this.options.codeEmbeds ? normalizeLanguage(attrs.language) : null;
        // A card that is dark by design takes the dark token colours inline, and needs no rules.
        const darkCard = this.dark === null;
        if (language && !darkCard) this.highlighted = true;
        const code = language
          ? highlightEmail(inner, language, darkCard ? 'dark' : 'light')
          : escapeHtml(inner);
        return {
          html: `<div style="margin:0 0 16px"><table ${TABLE} style="border-collapse:separate;table-layout:fixed"><tr><td class="sw-soft sw-h sw-code" dir="ltr" align="left" bgcolor="${this.theme.soft}" style="padding:12px 14px;background:${this.theme.soft};border-radius:8px;color:${this.theme.ink};text-align:left"><pre style="margin:0;font-family:${MONO};font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;word-break:break-word">${code}</pre></td></tr></table></div>`,
          text: inner,
        };
      }
      case TOC_NODE:
        if (!this.options.codeEmbeds) {
          throw new RenderError('Tables of contents are not enabled for this publication.');
        }
        if (depth !== 1) throw new RenderError('A table of contents can only sit between blocks.');
        return this.tableOfContents(attrs);
      case 'horizontalRule':
        return { html: this.rule(), text: '---' };
      case 'image':
        return this.image(attrs);
      case 'button':
        return this.button(attrs);
      case 'linkCard':
        return this.linkCard(attrs);
      case 'htmlBlock': {
        if (!this.options.allowHtmlBlocks) {
          throw new RenderError('Raw HTML blocks are not enabled for this publication.');
        }
        const raw = typeof attrs.html === 'string' ? attrs.html : '';
        if (raw.length > 50_000)
          throw new RenderError('A raw HTML block is over 50,000 characters.');
        this.lintHtml(raw);
        return { html: raw, text: stripTags(raw) };
      }
      case 'attachment':
        return this.attachment(attrs);
      case 'callout': {
        const inner = this.inside(39, () => this.blocks(node.content, depth));
        return {
          html: `<div style="margin:0 0 20px"><table class="sw-callout" ${TABLE} style="border-collapse:separate"><tr><td class="sw-soft sw-bar" bgcolor="${this.theme.soft}" style="padding:16px 18px;background:${this.theme.soft};border-${this.start}:3px solid ${this.accent};border-radius:6px">${trimLastMargin(inner.html)}</td></tr></table></div>`,
          text: inner.text,
        };
      }
      case 'columns':
        return this.columns(node, depth);
      case 'embed':
        return this.embed(attrs);
      case ASK_POLL_NODE:
        if (depth !== 1) throw new RenderError('A poll can only sit between blocks.');
        return this.askPoll(attrs);
      case GATE_NODE:
        // Only meaningful between top-level blocks; renderDispatch cuts paid content there.
        if (depth !== 1) throw new RenderError('A paywall break can only sit between blocks.');
        return { html: '', text: '' };
      case SMART_BLOCK:
        return this.smartBlock(node, depth);
      case SNIPPET_NODE:
        if (depth !== 1) throw new RenderError('A snippet can only sit between blocks.');
        this.warnings.add(SNIPPET_GONE_WARNING);
        return { html: '', text: '' };
      default:
        throw new RenderError(`Unsupported block "${String(node.type)}".`);
    }
  }

  /** Two columns side by side, stacking on a phone (the rule goes in the email's head). */
  columns(node: Node, depth: number): { html: string; text: string } {
    const columns = Array.isArray(node.content) ? (node.content as Node[]) : [];
    if (columns.length !== 2 || columns.some((c) => c?.type !== 'column')) {
      throw new RenderError('A column layout needs exactly two columns.');
    }
    if (depth !== 1) throw new RenderError('Columns can only sit at the top level.');
    columns.forEach(refuseShowOnPart);
    this.stacksColumns = true;
    // Each column has half the width, less the 12px that keeps the two apart.
    const [first, second] = this.inside(this.available / 2 + 12, () =>
      columns.map((column) => this.blocks(column.content, depth + 1)),
    );
    const end = this.start === 'left' ? 'right' : 'left';
    const cell = (html: string, side: 'first' | 'second') =>
      `<td class="sw-col" width="50%" valign="top" align="${this.start}" style="width:50%;vertical-align:top;padding-${side === 'first' ? end : this.start}:12px">${html}</td>`;
    return {
      html: `<table class="sw-cols" ${TABLE} style="margin:0 0 4px"><tr>${cell(first!.html, 'first')}${cell(second!.html, 'second')}</tr></table>`,
      text: [first!.text, second!.text].filter(Boolean).join('\n\n'),
    };
  }

  /** A video or post from another service: its thumbnail if it has one, and a link. */
  embed(attrs: Record<string, unknown>): { html: string; text: string } {
    const url = safeUrl(attrs.url);
    const info = url ? embedInfo(url) : null;
    if (!url || !info) throw new RenderError('That link can’t be embedded.');
    const card = this.linkCard({ href: url, title: info.action, description: info.provider });
    if (!info.youtubeId) return card;
    const thumb = `https://img.youtube.com/vi/${info.youtubeId}/hqdefault.jpg`;
    return {
      html: `<div style="margin:0 0 8px"><a href="${this.link(url)}" style="color:${this.theme.link};text-decoration:none">${emailImage(thumb, info.action, this.available)}</a></div>${card.html}`,
      text: card.text,
    };
  }

  /** A footnote's marker, kept to be listed at the end. */
  footnote(attrs: Record<string, unknown>): { html: string; text: string } {
    const note = typeof attrs.text === 'string' ? attrs.text.trim() : '';
    if (!note) throw new RenderError('A footnote needs text.');
    this.noteMergeTags(note);
    this.footnotes.push(note);
    const n = this.footnotes.length;
    return { html: `<sup>[${n}]</sup>`, text: `[${n}]` };
  }

  /** The footnotes, numbered as they appeared. */
  footnoteList(): { html: string; text: string } {
    if (!this.footnotes.length) return { html: '', text: '' };
    return {
      html: `<div style="margin:24px 0 8px"><table class="sw-footnotes" ${TABLE}><tr><td class="sw-line sw-m" style="padding:12px 0 0;border-top:1px solid ${this.theme.line};font-size:13px;line-height:1.5;color:${this.theme.muted}">${this.footnotes.map((note, i) => `<p style="margin:0 0 6px">[${i + 1}] ${escapeHtml(note)}</p>`).join('')}</td></tr></table></div>`,
      text: this.footnotes.map((note, i) => `[${i + 1}] ${note}`).join('\n'),
    };
  }

  /** A plain list of the top-level headings: email has no reliable in-message anchors. */
  tableOfContents(attrs: Record<string, unknown>): { html: string; text: string } {
    if (!this.headings.length) {
      this.warnings.add('A table of contents has no headings to list.');
      return { html: '', text: '' };
    }
    const title =
      typeof attrs.title === 'string' && attrs.title.trim()
        ? attrs.title.trim().slice(0, 80)
        : 'Contents';
    const items = this.headings
      .map(
        (h) =>
          `<li style="margin:0 0 4px${h.level === 3 ? `;margin-${this.start}:16px` : ''}">${escapeHtml(h.text)}</li>`,
      )
      .join('');
    return {
      html: `<div style="margin:0 0 20px"><table class="sw-toc sw-line" ${TABLE} style="border:1px solid ${this.theme.line};border-radius:12px;border-collapse:separate"><tr><td style="padding:14px 16px"><p class="sw-m" style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.02em;color:${this.theme.muted}">${escapeHtml(title)}</p><ul class="sw-t" style="margin:0;padding:${this.indent(20)};font-size:15px;line-height:1.5;color:${this.theme.body}">${items}</ul></td></tr></table></div>`,
      text: [title, ...this.headings.map((h) => `${h.level === 3 ? '  ' : ''}- ${h.text}`)].join(
        '\n',
      ),
    };
  }

  /** A Smart Block: its content between markers. Top level only, never nested. */
  smartBlock(node: Node, depth: number): { html: string; text: string } {
    if (depth !== 1) throw new RenderError('A Smart block can only sit at the top level.');
    const attrs = node.attrs ?? {};
    if (typeof attrs.condition !== 'object' || attrs.condition === null) {
      throw new RenderError('A Smart block needs a condition.');
    }
    const index = this.smartBlocks.length;
    this.smartBlocks.push({
      index,
      label: typeof attrs.label === 'string' ? attrs.label : null,
      anonymous: attrs.anonymous === 'show' ? 'show' : 'hide',
      condition: attrs.condition,
    });
    const inner = this.blocks(node.content, depth, false);
    const [open, close] = smartBlockMarker(index);
    return {
      html: `${open}${inner.html}${close}`,
      text: `${open}\n${inner.text}\n${close}`,
    };
  }

  listItems(nodes: unknown, depth: number, ordered: boolean): { html: string; text: string } {
    if (!Array.isArray(nodes)) return { html: '', text: '' };
    const html: string[] = [];
    const text: string[] = [];
    (nodes as Node[]).forEach((item, index) => {
      if (item?.type !== 'listItem') throw new RenderError('Lists may only contain list items.');
      refuseShowOnPart(item);
      const inner = this.blocks(item.content, depth + 1);
      // Paragraph margins inside list items would double the spacing.
      html.push(
        `<li style="margin:0 0 6px">${inner.html.replace(/margin:0 0 16px;/g, 'margin:0;')}</li>`,
      );
      const marker = ordered ? `${index + 1}.` : '-';
      text.push(`${marker} ${inner.text.replace(/\n/g, '\n   ')}`);
    });
    return { html: html.join(''), text: text.join('\n') };
  }

  inline(nodes: unknown): { html: string; text: string } {
    if (nodes === undefined) return { html: '', text: '' };
    if (!Array.isArray(nodes)) throw new RenderError('Node content must be a list.');
    let html = '';
    let text = '';
    for (const node of nodes as Node[]) {
      if (node?.type === 'hardBreak') {
        html += '<br>';
        text += '\n';
        continue;
      }
      if (node?.type === 'footnote') {
        const mark = this.footnote(node.attrs ?? {});
        html += mark.html;
        text += mark.text;
        continue;
      }
      if (node?.type !== 'text' || typeof node.text !== 'string') {
        throw new RenderError(`Unsupported inline node "${String(node?.type)}".`);
      }
      this.noteMergeTags(node.text);
      let piece = escapeHtml(node.text);
      let textPiece = node.text;
      const marks = Array.isArray(node.marks) ? (node.marks as Mark[]) : [];
      for (const mark of marks) {
        switch (mark?.type) {
          case 'bold':
            piece = `<strong>${piece}</strong>`;
            break;
          case 'italic':
            piece = `<em>${piece}</em>`;
            break;
          case 'underline':
            piece = `<u>${piece}</u>`;
            break;
          case 'strike':
            piece = `<s>${piece}</s>`;
            break;
          case 'code':
            piece = `<code class="sw-soft" style="font-family:${MONO};font-size:0.9em;background:${this.theme.soft};padding:1px 4px;border-radius:4px">${piece}</code>`;
            break;
          case 'link': {
            const href = safeUrl(mark.attrs?.href, { mailto: true });
            if (!href) {
              this.warnings.add(
                `A link to "${String(mark.attrs?.href ?? '')}" is not a valid web address and was removed.`,
              );
              break;
            }
            const placeholder = this.link(href);
            piece = `<a class="sw-a" href="${placeholder}" style="color:${this.theme.link};text-decoration:underline">${piece}</a>`;
            if (!href.startsWith('mailto:')) textPiece = `${textPiece} (${placeholder})`;
            break;
          }
          default:
            throw new RenderError(`Unsupported text style "${String(mark?.type)}".`);
        }
      }
      html += piece;
      text += textPiece;
    }
    return { html, text };
  }

  plain(nodes: unknown): string {
    if (!Array.isArray(nodes)) return '';
    return (nodes as Node[])
      .map((node) => (typeof node?.text === 'string' ? node.text : ''))
      .join('');
  }

  image(attrs: Record<string, unknown>): { html: string; text: string } {
    let src: string | null = null;
    if (typeof attrs.mediaId === 'string') {
      src = this.options.mediaUrl(attrs.mediaId);
      if (!src) throw new RenderError('An image is not in this workspace’s media library.');
    } else {
      src = safeUrl(attrs.src);
      if (!src?.startsWith('https://'))
        throw new RenderError('Images must come from the media library or an https address.');
    }
    const alt = typeof attrs.alt === 'string' ? attrs.alt.trim() : '';
    if (!alt) this.warnings.add('An image has no alt text.');
    let img = emailImage(src, alt, this.available, imageWidthPercent(attrs.widthPercent));
    const href = safeUrl(attrs.href);
    if (href) img = `<a href="${this.link(href)}" style="text-decoration:none">${img}</a>`;
    const caption = typeof attrs.caption === 'string' ? attrs.caption.trim() : '';
    const captionHtml = caption
      ? `<p class="sw-caption sw-m" style="margin:8px 0 0;font-size:13px;line-height:1.5;color:${this.theme.muted}">${escapeHtml(caption)}</p>`
      : '';
    return {
      html: `<div style="margin:0 0 20px">${img}${captionHtml}</div>`,
      text: alt ? `[${alt}]` : '',
    };
  }

  /** Unlike an image block, a cover image that is gone is left out instead of refused. */
  coverImage(cover: { url: string | null; alt: string }): { html: string; text: string } {
    if (!cover.url) {
      this.warnings.add('The cover image is no longer in the media library and was left out.');
      return { html: '', text: '' };
    }
    const alt = cover.alt.trim();
    if (alt) this.noteMergeTags(alt);
    else this.warnings.add('The cover image has no alt text.');
    return {
      html: `<div style="margin:0 0 20px">${emailImage(cover.url, alt, this.available)}</div>`,
      text: alt ? `[${alt}]` : '',
    };
  }

  button(attrs: Record<string, unknown>): { html: string; text: string } {
    const href = safeUrl(attrs.href);
    const label = typeof attrs.label === 'string' ? attrs.label.trim().slice(0, 80) : '';
    if (!href || !label) throw new RenderError('A button needs a label and a web address.');
    const placeholder = this.link(href);
    this.noteMergeTags(label);
    return {
      html: emailButton({ href: placeholder, label: escapeHtml(label), theme: this.theme }),
      text: `${label}: ${placeholder}`,
    };
  }

  linkCard(attrs: Record<string, unknown>): { html: string; text: string } {
    const href = safeUrl(attrs.href);
    if (!href) throw new RenderError('A link card needs a web address.');
    const title =
      typeof attrs.title === 'string' && attrs.title.trim()
        ? attrs.title.trim()
        : new URL(href).hostname;
    const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';
    const placeholder = this.link(href);
    return {
      html: this.card(
        'sw-link-card',
        placeholder,
        '14px 16px',
        `<span class="sw-h" style="display:block;font-size:15px;line-height:1.4;font-weight:600;color:${this.theme.ink}">${escapeHtml(title)}</span>${description ? `<span class="sw-m" style="display:block;padding-top:4px;font-size:14px;line-height:1.5;color:${this.theme.muted}">${escapeHtml(description)}</span>` : ''}<span class="sw-a" style="display:block;padding-top:6px;font-size:12px;line-height:1.4;color:${this.theme.link}">${escapeHtml(new URL(href).hostname)}</span>`,
      ),
      text: `${title}${description ? ` - ${description}` : ''}\n${placeholder}`,
    };
  }

  /**
   * A one-tap poll: one button per option, each a per-recipient signed link (a placeholder here).
   * Answering happens on the confirm page the link opens, never on the GET itself.
   */
  askPoll(attrs: Record<string, unknown>): { html: string; text: string } {
    const askId = typeof attrs.askId === 'string' ? attrs.askId : '';
    const questionId = typeof attrs.questionId === 'string' ? attrs.questionId : '';
    const poll = askId && questionId ? (this.options.ask?.(askId, questionId) ?? null) : null;
    if (!poll)
      throw new RenderError('A poll points at a question that is not in this publication.');
    const options = poll.options.filter((o) => ASK_OPTION_ID.test(o.id));
    if (options.length < 2) throw new RenderError('A poll needs at least two options.');
    if (poll.status !== 'open') {
      this.warnings.add(
        `The poll “${poll.title}” is ${poll.status === 'draft' ? 'still a draft' : 'closed'}, so answers will be refused until it is open.`,
      );
    }
    const buttons = options
      .map(
        (o) =>
          `<tr><td class="sw-line" style="border:1px solid ${this.theme.line};border-radius:10px;mso-padding-alt:12px 16px"><a class="sw-h" href="${askPlaceholder(o.id)}" style="display:block;padding:12px 16px;font-size:15px;line-height:20px;font-weight:600;color:${this.theme.ink};text-decoration:none">${escapeHtml(o.label)}</a></td></tr><tr><td height="8" style="height:8px;font-size:0;line-height:0">&nbsp;</td></tr>`,
      )
      .join('');
    const description = poll.description
      ? `<p class="sw-m" style="margin:0 0 10px;font-size:14px;line-height:1.5;color:${this.theme.muted}">${escapeHtml(poll.description)}</p>`
      : '';
    return {
      html: `<div style="margin:0 0 20px"><table class="sw-poll sw-line" ${TABLE} style="border:1px solid ${this.theme.line};border-radius:12px;border-collapse:separate"><tr><td style="padding:16px 16px 8px"><p class="sw-m" style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.02em;color:${this.theme.muted}">${escapeHtml(poll.title)}</p>${description}<p class="sw-h" style="margin:0 0 12px;font-size:16px;font-weight:600;line-height:1.4;color:${this.theme.ink}">${escapeHtml(poll.prompt)}</p><table ${TABLE} style="border-collapse:separate">${buttons}</table></td></tr></table></div>`,
      text: [poll.prompt, ...options.map((o) => `- ${o.label}: ${askPlaceholder(o.id)}`)].join(
        '\n',
      ),
    };
  }

  /** The end of the free part of a paid Dispatch in email. */
  continueReading(webUrl: string | null): { html: string; text: string } {
    const note = 'The rest of this post is for paid subscribers.';
    const href = webUrl ? safeUrl(webUrl) : null;
    if (!href) {
      this.warnings.add(
        'This paid post has no web address yet, so the email has no link to the rest.',
      );
      return {
        html: `<p class="sw-m" style="margin:8px 0 16px;font-size:15px;line-height:1.6;color:${this.theme.muted}">${note}</p>`,
        text: note,
      };
    }
    const button = this.button({ href, label: 'Continue reading on the web' });
    return {
      html: `${this.rule()}<p class="sw-m" style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${this.theme.muted}">${note}</p>${button.html}`,
      text: `---
${note}
${button.text}`,
    };
  }

  /**
   * A file from the media library, sent as a download link rather than a MIME attachment. The
   * stored URL carries a random 128-bit id, so it can't be guessed, and deleting the file revokes it.
   */
  attachment(attrs: Record<string, unknown>): { html: string; text: string } {
    const src = typeof attrs.mediaId === 'string' ? this.options.mediaUrl(attrs.mediaId) : null;
    if (!src) throw new RenderError('An attachment is not in this workspace’s media library.');
    const name =
      typeof attrs.name === 'string' && attrs.name.trim()
        ? attrs.name.trim().slice(0, 120)
        : 'Attachment';
    const placeholder = this.link(src);
    const kind = /\.([a-z0-9]{2,5})$/i.exec(src)?.[1]?.toUpperCase() ?? 'File';
    return {
      html: this.card(
        'sw-attachment',
        placeholder,
        '12px 16px',
        `<span class="sw-h" style="display:block;font-size:15px;line-height:1.4;font-weight:600;color:${this.theme.ink}">${escapeHtml(name)}</span><span class="sw-a" style="display:block;padding-top:4px;font-size:12px;line-height:1.4;color:${this.theme.link}">Download ${escapeHtml(kind)}</span>`,
      ),
      text: `${name}: ${placeholder}`,
    };
  }

  /** A divider. A table, because Outlook gives an `<hr>` its own height, colour and margins. */
  rule(): string {
    return `<table class="sw-hr" ${TABLE}><tr><td height="12" style="height:12px;font-size:0;line-height:0">&nbsp;</td></tr><tr><td class="sw-line" height="24" style="height:24px;border-top:1px solid ${this.theme.line};font-size:0;line-height:0">&nbsp;</td></tr></table>`;
  }

  /**
   * A bordered box that is one link (link cards, attachments). The border and padding sit on a
   * table cell, where every app draws them; the link fills the cell.
   */
  card(className: string, href: string, padding: string, inner: string): string {
    return `<div style="margin:0 0 20px"><table class="${className} sw-line" ${TABLE} style="border:1px solid ${this.theme.line};border-radius:12px;border-collapse:separate"><tr><td align="${this.start}" style="padding:${padding}"><a href="${href}" style="display:block;text-decoration:none">${inner}</a></td></tr></table></div>`;
  }

  /** Lint for raw HTML: links that aren't web addresses, images without alt text, dark-mode traps. */
  lintHtml(raw: string): void {
    for (const match of raw.matchAll(/\shref\s*=\s*["']([^"']*)["']/gi)) {
      const href = match[1] ?? '';
      if (!safeUrl(href, { mailto: true }) && !href.startsWith('{{')) {
        this.warnings.add(`Raw HTML links to "${href.slice(0, 80)}", which is not a web address.`);
      }
    }
    for (const match of raw.matchAll(/<img\b[^>]*>/gi)) {
      if (!/\salt\s*=\s*["'][^"']+["']/i.test(match[0])) {
        this.warnings.add('An image in raw HTML has no alt text.');
      }
    }
    if (
      /(^|[;"'\s])color\s*:\s*(#000(000)?\b|black\b)/i.test(raw) &&
      !/background(-color)?\s*:/i.test(raw)
    ) {
      this.warnings.add(
        'Raw HTML sets black text without a background, so it can disappear in dark mode.',
      );
    }
  }
}

/** A guess at the language of right-to-left text, by its script: better than calling it English. */
function rtlLanguage(text: string): string {
  return /[\u0590-\u05ff]/.test(text) ? 'he' : 'ar';
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Renders a Dispatch document into a full email template. Throws RenderError on invalid input. */
export function renderDispatch(document: unknown, options: RenderOptions): RenderedTemplate {
  const doc = document as Node;
  if (typeof doc !== 'object' || doc === null || doc.type !== 'doc') {
    throw new RenderError('The document must be an editor document.');
  }
  const input = themeInput(options);
  const theme = emailTheme(input);
  const dir = options.dir ?? directionOf(sampleText(doc.content));
  const start = dir === 'rtl' ? 'right' : 'left';
  const dark = darkTheme(theme, input);
  const renderer = new Renderer(options, theme, start, dark);
  const gated =
    options.webVisibility === 'paid' &&
    options.paidVariant !== 'full' &&
    Array.isArray(doc.content) &&
    doc.content.some((node) => (node as Node | null)?.type === GATE_NODE);
  const nodes = gated ? beforeGate(doc.content) : doc.content;
  renderer.headings = topLevelHeadings(Array.isArray(nodes) ? shownBlocks(nodes, 'email') : nodes);
  const body = renderer.blocks(nodes, 0);
  if (gated) {
    // Validate the gated part too, so a broken document is refused before it reaches the site.
    const check = new Renderer(options, theme, start, dark);
    check.headings = topLevelHeadings(shownBlocks(doc.content as unknown[], 'email'));
    check.blocks(doc.content, 0);
    const more = renderer.continueReading(options.webUrl ?? null);
    body.html += more.html;
    body.text = body.text
      ? `${body.text}

${more.text}`
      : more.text;
  }
  const notes = renderer.footnoteList();
  if (notes.html) {
    body.html += notes.html;
    body.text = [body.text, notes.text].filter(Boolean).join('\n\n');
  }
  if (options.cover) {
    const cover = renderer.coverImage(options.cover);
    body.html = `${cover.html}${body.html}`;
    body.text = [cover.text, body.text].filter(Boolean).join('\n\n');
  }
  // Only the renderer writes Smart Block markers: text that imitates one (in the text part, or a
  // raw HTML block) could let content escape or swallow a block, so it is refused.
  const markers = renderer.smartBlocks.length * 2;
  if (
    (body.html.match(ANY_MARKER) ?? []).length !== markers ||
    (body.text.match(ANY_MARKER) ?? []).length !== markers
  ) {
    throw new RenderError('Text that looks like a Smart block marker can’t be used.');
  }
  const preheader = (options.preheader ?? '').trim();
  if (preheader) renderer.noteMergeTags(preheader);
  const channel = escapeHtml(options.channelName);

  // Lines of only structure (a divider's "---", an empty quote's ">") aren't anything to read.
  const readable = body.text.replace(/^[\s>*-]+$/gm, '').trim();
  if (!readable && !/<img|<a /.test(body.html)) renderer.warnings.add(EMPTY_WARNING);

  const design = options.design ?? null;
  const font = design?.font && design.font in EMAIL_FONTS ? design.font : 'system';
  const family = EMAIL_FONTS[font];
  const logoSrc = design?.logoUrl ? safeUrl(design.logoUrl) : null;
  const logo =
    logoSrc?.startsWith('https://') || logoSrc?.startsWith('http://localhost')
      ? `<div style="margin:0 0 10px"><img src="${escapeHtml(logoSrc)}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border:0;border-radius:10px;object-fit:cover"></div>`
      : '';
  const headerLine = design?.header?.trim()
    ? `<br><span style="font-weight:400">${escapeHtml(design.header.trim())}</span>`
    : '';
  const address = design?.footer?.trim() ?? '';
  const footerLink = (href: string, label: string) =>
    `<a href="${href}" class="sw-f" style="color:${theme.onPage};text-decoration:underline">${label}</a>`;
  const footer = `You are receiving this because you joined ${channel}.<br>${footerLink('{{@member_center}}', 'Manage your subscription')} &middot; ${footerLink('{{@unsubscribe}}', 'Unsubscribe')}${address ? `<br><span style="display:block;padding-top:8px">${escapeHtml(address)}</span>` : ''}`;
  const g = CARD_GUTTER;
  const cell = `align="${start}"`;
  const shell = {
    title: options.channelName,
    lang: options.lang ?? (dir === 'rtl' ? rtlLanguage(body.text) : null),
    dir,
    font,
    theme,
    dark,
    width: CARD_WIDTH,
  } as const;
  const layout = shellBody({
    ...shell,
    preheader: preheaderHtml(preheader),
    rows: `<tr><td class="sw-header sw-m" ${cell} style="padding:28px ${g}px 0;font-family:${family};font-size:13px;line-height:1.5;font-weight:600;letter-spacing:0.02em;color:${theme.muted};text-align:${start}">${logo}${channel}${headerLine}</td></tr>
<tr><td class="sw-content sw-h" ${cell} style="padding:20px ${g}px 12px;font-family:${family};font-size:16px;line-height:1.6;color:${theme.ink};text-align:${start}">${body.html}</td></tr>`,
    footer,
    tail: '{{@pixel}}',
  });

  // The Channel's CSS is linted again: it was linted when saved, but the rules may have changed.
  let styled = layout;
  const styles: string[] = [];
  if (renderer.highlighted) styles.push(emailCodeDarkCss());
  if (options.customCss?.trim()) {
    const lint = lintEmailCss(options.customCss);
    if (lint.ok) {
      const placed = applyEmailCss(layout, lint.rules);
      styled = placed.html;
      if (placed.stylesheet) styles.push(placed.stylesheet);
    } else {
      renderer.warnings.add('The publication’s email CSS has errors, so it was left out.');
    }
  }
  const head = shellHead({
    ...shell,
    // Headings come down a size on a phone, and columns stack.
    phoneCss: `h1.sw-h{font-size:25px!important}h2.sw-h{font-size:21px!important}${
      renderer.stacksColumns
        ? '.sw-col{display:block!important;width:100%!important;padding:0!important}.sw-col img{max-width:100%!important}'
        : ''
    }`,
    styles,
  });
  const html = `${head}
${styled}`;

  const text = `${body.text.trim()}\n\n--\nYou are receiving this because you joined ${options.channelName}.\nManage your subscription: {{@member_center}}\nUnsubscribe: {{@unsubscribe}}\n${address ? `\n${address}\n` : ''}`;

  if (new TextEncoder().encode(html).length > GMAIL_CLIP_BYTES) {
    renderer.warnings.add('The email is over 102 KB, so Gmail will clip it.');
  }
  for (const tag of renderer.mergeTags.values()) {
    if (!tag.fallback && tag.field !== 'email') {
      renderer.warnings.add(
        `The merge tag "${tag.field}" has no fallback, so some subscribers will see a blank.`,
      );
    }
  }

  return {
    html,
    text,
    links: renderer.links,
    mergeTags: [...renderer.mergeTags.values()],
    warnings: [...renderer.warnings],
    smartBlocks: renderer.smartBlocks,
  };
}

interface Personalization {
  /** Final URL for link N (a tracking URL in a send, the original URL in a preview). */
  link: (index: number) => string;
  unsubscribeUrl: string;
  /** Signed Member Center link; previews and test sends fall back to the unsubscribe URL. */
  memberCenterUrl?: string;
  /** Open pixel URL, or null for no pixel. */
  pixelUrl: string | null;
  /**
   * The one-tap poll link for an option (`{{@ask:<optionId>}}`), signed for this recipient. The
   * send pipeline signs one per option found in the template (askOptionIds in @swarm/engine);
   * absent or null, the link is '#' (previews, test sends).
   */
  ask?: (optionId: string) => string | null;
  member: {
    /** Profile fields by key, for {{ field.key | fallback }}. Encrypted fields are never here. */
    fields?: Record<string, string>;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  /**
   * The Smart Blocks this recipient sees (indexes). Undefined keeps every block, for previews;
   * a send always passes the snapshot's list (empty when none apply).
   */
  smartBlocks?: readonly number[];
}

function mergeValue(field: string, member: Personalization['member']): string | null {
  if (field.startsWith('field.')) {
    // Own keys only: {{ field.constructor }} must not find Object.prototype's, which threw.
    const key = field.slice(6);
    return member.fields && Object.hasOwn(member.fields, key)
      ? member.fields[key]?.trim() || null
      : null;
  }
  switch (field) {
    case 'first_name':
      return member.firstName?.trim() || null;
    case 'last_name':
      return member.lastName?.trim() || null;
    case 'email':
      return member.email;
    default:
      return null;
  }
}

/**
 * Fills a template for one recipient. In HTML the Member's values are escaped; fallbacks were
 * escaped when the template was rendered, so they are inserted as they are.
 */
export function personalize(
  template: { html: string; text: string; subject: string },
  values: Personalization,
): { html: string; text: string; subject: string } {
  const merge = (input: string, escape: boolean) =>
    input.replace(MERGE_TAG, (whole, field: string, fallback: string | undefined) => {
      if (!(MERGE_FIELDS as readonly string[]).includes(field) && !field.startsWith('field.')) {
        return whole;
      }
      const value = mergeValue(field, values.member);
      if (value === null) return (fallback ?? '').trim();
      return escape ? escapeHtml(value) : value;
    });
  const system = (input: string, escape: boolean) =>
    input
      .replace(/\{\{@link:(\d+)\}\}/g, (_, n: string) => {
        const url = values.link(Number(n));
        return escape ? escapeHtml(url) : url;
      })
      .replace(ASK_PLACEHOLDER, (_, optionId: string) => {
        const url = values.ask?.(optionId) ?? '#';
        return escape ? escapeHtml(url) : url;
      })
      .replace(
        /\{\{@unsubscribe\}\}/g,
        escape ? escapeHtml(values.unsubscribeUrl) : values.unsubscribeUrl,
      )
      .replace(/\{\{@member_center\}\}/g, () => {
        const url = values.memberCenterUrl ?? values.unsubscribeUrl;
        return escape ? escapeHtml(url) : url;
      })
      .replace(
        /\{\{@pixel\}\}/g,
        escape && values.pixelUrl
          ? `<img src="${escapeHtml(values.pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
          : '',
      );

  // Smart Blocks first, on the author's template, so nothing a Member typed can act as a marker.
  const shown = applySmartBlocks(template, values.smartBlocks);
  // System placeholders next, then merge tags in a single pass: a Member's name that looks
  // like a placeholder or a merge tag is inserted literally and never expanded.
  return {
    html: merge(system(shown.html, true), true),
    text: merge(system(shown.text, false), false),
    subject: merge(template.subject, false).replace(/[\r\n]+/g, ' '),
  };
}
