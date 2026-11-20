/**
 * Web renderer: editor document (TipTap JSON) → semantic, accessible HTML for the Channel website.
 *
 * Same discipline as the email renderer (./render): every value that reaches the HTML is escaped
 * here, URLs go through `safeUrl`, and unknown node types and marks are refused (RenderError)
 * rather than dropped, so a client can never smuggle markup past the renderer.
 *
 * Differences from email:
 * - No per-recipient values. Merge tags render as their fallback (or the Channel name for
 *   `{{channel.name}}`), never a Member's data. Links stay direct: no click tracking on the site.
 * - Styling is by class names that the site stylesheet defines; no inline styles (the site CSP
 *   doesn't allow them). Focal points become generated classes whose rules are returned in `css`.
 * - The gate divider `{ "type": "gate" }` (top level only) splits the document: everything after
 *   the first one is the gated part, returned separately so the site decides who sees it.
 * - Raw HTML blocks (`htmlBlock`): rendered only when `allowHtmlBlocks` is on, and then only inside
 *   an `<iframe sandbox srcdoc>` with an empty sandbox (no scripts, no forms, no same-origin, no
 *   top navigation). The srcdoc document inherits the page's CSP, so it can't load third-party
 *   resources either. When the flag is off the block is omitted (with a warning), not rendered.
 * - A media item that is missing or no longer public is omitted with a warning instead of failing
 *   the page (it was valid when the Dispatch was sent).
 * - Smart Blocks (`smartBlock`, top level only) render their content or nothing, as
 *   `smartBlockVisible` decides; by default by the block's `anonymous` setting ('show' or 'hide'),
 *   which is what the public site uses for every reader: pages are cached and shared, so a
 *   per-reader view would need an uncached render per signed-in reader. Hidden blocks are left
 *   out of the text and excerpt too, so the search index never holds them.
 * - With the code_embeds flag (`codeEmbeds`), code blocks are highlighted with classes (no inline
 *   styles, no script: ./highlight), top-level headings get `id`s, and a table of contents block
 *   (`tableOfContents`) links to them. It lists the headings of its own part: one in the free part
 *   never reveals the headings of the gated part. Without the flag the block is left out.
 * - A linked snippet (`snippet`, top level only) is replaced by its blocks before this renderer runs
 *   (./snippets); one still here is gone, so it renders nothing.
 * - An embed is a link card. With `players`, one from a service with a player also carries the player's
 *   address and a button that stays hidden: the site's script (workers/site/src/render/players.ts)
 *   shows the button, and only a click adds the frame. Nothing here loads anything by itself.
 * - A block with `attrs.showOn` 'email' (see blockShownOn in ./render) is left out of the html, text,
 *   excerpt, reading time, footnotes and table of contents, so the search index never holds it.
 */
import { embedInfo, imageWidthPercent } from './embeds';
import { highlightWeb, normalizeLanguage } from './highlight';
import { escapeHtml } from './index';
import {
  ASK_POLL_NODE,
  RenderError,
  TOC_NODE,
  blockShownOn,
  refuseShowOnPart,
  safeUrl,
  shownBlocks,
  topLevelHeadings,
  type AskPollView,
} from './render';
import { SNIPPET_GONE_WARNING, SNIPPET_NODE } from './snippets';

export interface WebMedia {
  url: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  /** 0..1 from the left / top, when the media item has a focal point. */
  focalX?: number | null;
  focalY?: number | null;
}

export interface WebRenderOptions {
  channelName: string;
  /** A public media library item of this workspace, or null. */
  media: (mediaId: string) => WebMedia | null;
  /** Raw HTML blocks are allowed only when the raw_html_mode flag is on. */
  allowHtmlBlocks: boolean;
  /** Added to heading levels, so editor H1 sits below the page title. Default 1. */
  headingOffset?: number;
  /**
   * Whether Smart Block `index` (document order, 0-based) is shown. Default: the block's
   * `anonymous` setting, so readers who aren't identified get the fallback.
   */
  smartBlockVisible?: (block: { index: number; anonymous: 'hide' | 'show' }) => boolean;
  /**
   * The Ask question an `askPoll` block points at. On the web the options link to the survey
   * page (`/_swarm/ask/<askId>?o=<optionId>`), which asks who is answering. Without it, or for
   * an unknown question, the block is left out with a warning.
   */
  ask?: (askId: string, questionId: string) => AskPollView | null;
  /** Highlighted code, heading anchors and the table of contents block: the code_embeds flag. */
  codeEmbeds?: boolean;
  /** Embeds can load their player after a click. Only for a page that runs the player script. */
  players?: boolean;
}

/** A heading's anchor: lower-case words joined by hyphens, never empty. */
function headingSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'section';
}

export interface WebImage {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** CSS object-position, e.g. "50% 30%". */
  objectPosition: string;
}

export interface WebRendered {
  /** Everything before the first gate divider (the whole document when there is none). */
  freeHtml: string;
  /** Everything after the first gate divider; empty when there is none. */
  gatedHtml: string;
  hasGate: boolean;
  /** Plain text of the whole document. */
  text: string;
  /** Plain text of the free part only: safe to index and to show to anyone. */
  freeText: string;
  /** Up to ~200 characters from the free part. */
  excerpt: string;
  /** Reading time of the whole document at 230 words per minute, at least 1. */
  readingMinutes: number;
  /** The first image in the free part. */
  firstImage: WebImage | null;
  /** Rules for the generated focal-point classes; the page puts them in its stylesheet. */
  css: string;
  /** Origins of the players in the free part, for the page's frame-src. Empty without `players`. */
  freePlayers: string[];
  /** The same for the gated part, needed only when the reader is shown that part. */
  gatedPlayers: string[];
  warnings: string[];
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

interface Out {
  html: string;
  text: string;
}

const MAX_DEPTH = 24;
const WORDS_PER_MINUTE = 230;
/** Merge tags in both spellings: `{{ first_name | there }}` and `{{member.first_name | "there"}}`. */
const MERGE_TAG = /\{\{\s*([a-z_][a-z0-9_.]*)\s*(?:\|\s*([^{}]*?))?\s*\}\}/gi;

/** Every media id the document refers to, for a single lookup before rendering. */
export function collectMediaIds(node: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > MAX_DEPTH + 2) return into;
  if (Array.isArray(node)) {
    for (const child of node) collectMediaIds(child, into, depth + 1);
    return into;
  }
  if (typeof node !== 'object' || node === null) return into;
  const { attrs, content } = node as Node;
  if (attrs && typeof attrs.mediaId === 'string' && attrs.mediaId.length <= 64) {
    into.add(attrs.mediaId);
  }
  if (content !== undefined) collectMediaIds(content, into, depth + 1);
  return into;
}

/** Fills merge tags for the web: the fallback, or the Channel name; never a Member's data. */
export function webMergeTags(text: string, channelName: string): string {
  return text.replace(MERGE_TAG, (_whole, field: string, fallback: string | undefined) => {
    if (field.toLowerCase() === 'channel.name') return channelName;
    const value = (fallback ?? '').trim();
    return value.replace(/^(["'])(.*)\1$/, '$2');
  });
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function percent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value * 100)));
}

class WebRenderer {
  readonly warnings = new Set<string>();
  readonly focal = new Map<string, string>();
  firstImage: WebImage | null = null;
  private smartBlocks = 0;
  /** Footnotes waiting to be listed, and how many there have been in the whole document. */
  footnotes: string[] = [];
  footnoteCount = 0;
  private readonly offset: number;
  /** Anchors of the top-level headings (code_embeds only). */
  headingIds = new Map<unknown, string>();
  /** What a table of contents in the part being rendered lists. */
  toc: { level: number; text: string; id: string }[] = [];
  /** Origins of the players in the part being rendered. */
  players = new Set<string>();

  constructor(private readonly options: WebRenderOptions) {
    this.offset = Math.min(3, Math.max(0, options.headingOffset ?? 1));
  }

  merge(text: string): string {
    return webMergeTags(text, this.options.channelName);
  }

  /** The waiting footnotes as a list, numbered after `before`. */
  takeFootnotes(before: number): string {
    if (!this.footnotes.length) return '';
    const items = this.footnotes
      .map(
        (note, i) =>
          `<li id="fn-${before + i + 1}" value="${before + i + 1}">${escapeHtml(note)}</li>`,
      )
      .join('');
    this.footnotes = [];
    return `<ol class="sw-footnotes">${items}</ol>`;
  }

  blocks(nodes: unknown, depth: number): Out {
    if (depth > MAX_DEPTH) throw new RenderError('The document is nested too deeply.');
    if (nodes === undefined) return { html: '', text: '' };
    if (!Array.isArray(nodes)) throw new RenderError('Node content must be a list.');
    const html: string[] = [];
    const text: string[] = [];
    for (const node of nodes as Node[]) {
      if (!blockShownOn(node, 'web')) {
        // Email only: it still takes its place in document order, and a broken block is refused.
        if (node.type === 'smartBlock') this.smartBlocks++;
        new WebRenderer({ ...this.options, smartBlockVisible: () => true }).block(node, depth + 1);
        continue;
      }
      const out = this.block(node, depth + 1);
      if (out.html) html.push(out.html);
      if (out.text) text.push(out.text);
    }
    return { html: html.join('\n'), text: text.join('\n\n') };
  }

  block(node: Node, depth: number): Out {
    if (typeof node !== 'object' || node === null) throw new RenderError('Invalid node.');
    const attrs = node.attrs ?? {};
    switch (node.type) {
      case 'paragraph': {
        const inner = this.inline(node.content);
        if (!inner.html.trim()) return { html: '', text: '' };
        return { html: `<p>${inner.html}</p>`, text: inner.text };
      }
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(attrs.level) || 2)) + this.offset;
        const tag = `h${Math.min(6, level)}`;
        const inner = this.inline(node.content);
        if (!inner.html.trim()) return { html: '', text: '' };
        const id = this.headingIds.get(node);
        const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
        return { html: `<${tag}${idAttr}>${inner.html}</${tag}>`, text: inner.text };
      }
      case 'bulletList':
      case 'orderedList': {
        const tag = node.type === 'bulletList' ? 'ul' : 'ol';
        const start = node.type === 'orderedList' ? clampInt(attrs.start, 1, 100_000) : null;
        const items = this.listItems(node.content, depth, node.type === 'orderedList');
        const startAttr = start && start !== 1 ? ` start="${start}"` : '';
        return { html: `<${tag}${startAttr}>${items.html}</${tag}>`, text: items.text };
      }
      case 'blockquote': {
        const inner = this.blocks(node.content, depth);
        return {
          html: `<blockquote>${inner.html}</blockquote>`,
          text: inner.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        };
      }
      case 'codeBlock': {
        const inner = this.plain(node.content);
        const known = this.options.codeEmbeds ? normalizeLanguage(attrs.language) : null;
        const language = known
          ? ` class="language-${known}"`
          : typeof attrs.language === 'string' && /^[a-z0-9+#-]{1,20}$/i.test(attrs.language)
            ? ` class="language-${escapeHtml(attrs.language.toLowerCase())}"`
            : '';
        const code = known ? highlightWeb(inner, known) : escapeHtml(inner);
        return { html: `<pre><code${language}>${code}</code></pre>`, text: inner };
      }
      case TOC_NODE:
        return this.tableOfContents(attrs);
      case 'horizontalRule':
        return { html: '<hr>', text: '' };
      case 'image':
        return this.image(attrs);
      case 'button':
        return this.button(attrs);
      case 'linkCard':
        return this.linkCard(attrs);
      case 'attachment':
        return this.attachment(attrs);
      case 'callout': {
        const inner = this.blocks(node.content, depth);
        return { html: `<aside class="sw-callout">${inner.html}</aside>`, text: inner.text };
      }
      case 'columns': {
        const columns = Array.isArray(node.content) ? (node.content as Node[]) : [];
        if (columns.length !== 2 || columns.some((c) => c?.type !== 'column')) {
          throw new RenderError('A column layout needs exactly two columns.');
        }
        columns.forEach(refuseShowOnPart);
        const inner = columns.map((column) => this.blocks(column.content, depth + 1));
        return {
          html: `<div class="sw-columns">${inner.map((out) => `<div>${out.html}</div>`).join('')}</div>`,
          text: inner
            .map((out) => out.text)
            .filter(Boolean)
            .join('\n\n'),
        };
      }
      case 'embed': {
        const url = safeUrl(attrs.url);
        const info = url ? embedInfo(url) : null;
        if (!url || !info) throw new RenderError('That link can’t be embedded.');
        // A link, so the page loads nothing from that service until someone chooses to go there.
        const card = this.linkCard({ href: url, title: info.action, description: info.provider });
        if (!this.options.players || !info.player) return card;
        this.players.add(info.player.origin);
        return {
          html: `<div class="sw-player sw-player-${info.player.shape}" data-sw-src="${escapeHtml(info.player.src)}" data-sw-title="${info.provider} player">${card.html}<div class="sw-player-load" hidden><p>This player loads from ${info.provider}, which may set its own cookies.</p><button type="button">Load the ${info.provider} player</button></div></div>`,
          text: card.text,
        };
      }
      case 'htmlBlock':
        return this.htmlBlock(attrs);
      case ASK_POLL_NODE:
        return this.askPoll(attrs);
      case 'gate':
        throw new RenderError('A paywall break can only sit at the top level of a post.');
      case 'smartBlock': {
        if (depth !== 1) throw new RenderError('A Smart block can only sit at the top level.');
        const index = this.smartBlocks++;
        const anonymous = attrs.anonymous === 'show' ? 'show' : 'hide';
        const visible = this.options.smartBlockVisible
          ? this.options.smartBlockVisible({ index, anonymous })
          : anonymous === 'show';
        if (visible) return this.blocks(node.content, depth);
        // Still checked, so a broken block is refused whoever is reading.
        new WebRenderer(this.options).blocks(node.content, depth);
        return { html: '', text: '' };
      }
      case SNIPPET_NODE:
        if (depth !== 1) throw new RenderError('A snippet can only sit between blocks.');
        this.warnings.add(SNIPPET_GONE_WARNING);
        return { html: '', text: '' };
      default:
        throw new RenderError(`Unsupported block "${String(node.type)}".`);
    }
  }

  listItems(nodes: unknown, depth: number, ordered: boolean): Out {
    if (!Array.isArray(nodes)) return { html: '', text: '' };
    const html: string[] = [];
    const text: string[] = [];
    (nodes as Node[]).forEach((item, index) => {
      if (item?.type !== 'listItem') throw new RenderError('Lists may only contain list items.');
      refuseShowOnPart(item);
      const inner = this.blocks(item.content, depth + 1);
      html.push(`<li>${inner.html}</li>`);
      const marker = ordered ? `${index + 1}.` : '-';
      text.push(`${marker} ${inner.text.replace(/\n/g, '\n   ')}`);
    });
    return { html: html.join(''), text: text.join('\n') };
  }

  inline(nodes: unknown): Out {
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
        const note = typeof node.attrs?.text === 'string' ? this.merge(node.attrs.text.trim()) : '';
        if (!note) throw new RenderError('A footnote needs text.');
        this.footnotes.push(note);
        const n = ++this.footnoteCount;
        html += `<sup id="fnref-${n}"><a href="#fn-${n}" aria-label="Footnote ${n}">[${n}]</a></sup>`;
        text += `[${n}]`;
        continue;
      }
      if (node?.type !== 'text' || typeof node.text !== 'string') {
        throw new RenderError(`Unsupported inline node "${String(node?.type)}".`);
      }
      const value = this.merge(node.text);
      let piece = escapeHtml(value);
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
            piece = `<code>${piece}</code>`;
            break;
          case 'link': {
            const href = safeUrl(mark.attrs?.href, { mailto: true });
            if (!href) {
              this.warnings.add('A link that is not a valid web address was removed.');
              break;
            }
            piece = `<a href="${escapeHtml(href)}">${piece}</a>`;
            break;
          }
          default:
            throw new RenderError(`Unsupported text style "${String(mark?.type)}".`);
        }
      }
      html += piece;
      text += value;
    }
    return { html, text };
  }

  plain(nodes: unknown): string {
    if (!Array.isArray(nodes)) return '';
    return (nodes as Node[])
      .map((node) => (typeof node?.text === 'string' ? node.text : ''))
      .join('');
  }

  focalClass(x: number, y: number): string {
    const name = `sw-fp-${x}-${y}`;
    this.focal.set(name, `.${name}{object-position:${x}% ${y}%}`);
    return name;
  }

  image(attrs: Record<string, unknown>): Out {
    let image: WebImage | null = null;
    if (typeof attrs.mediaId === 'string') {
      const media = this.options.media(attrs.mediaId);
      if (!media) {
        this.warnings.add('An image is no longer in the media library and was left out.');
        return { html: '', text: '' };
      }
      const x = percent(media.focalX);
      const y = percent(media.focalY);
      image = {
        url: media.url,
        alt:
          typeof attrs.alt === 'string' && attrs.alt.trim()
            ? attrs.alt.trim()
            : (media.alt ?? '').trim(),
        width: clampInt(media.width, 1, 20_000),
        height: clampInt(media.height, 1, 20_000),
        objectPosition: `${x}% ${y}%`,
      };
    } else {
      const src = safeUrl(attrs.src);
      if (!src?.startsWith('https://')) {
        throw new RenderError('Images must come from the media library or an https address.');
      }
      image = {
        url: src,
        alt: typeof attrs.alt === 'string' ? attrs.alt.trim() : '',
        width: null,
        height: null,
        objectPosition: '50% 50%',
      };
    }
    if (!image.alt) this.warnings.add('An image has no alt text.');
    this.firstImage ??= image;
    const [x, y] = image.objectPosition.split(' ').map((p) => Number.parseInt(p, 10));
    const size =
      image.width && image.height ? ` width="${image.width}" height="${image.height}"` : '';
    let img = `<img class="${this.focalClass(x ?? 50, y ?? 50)}" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}"${size} loading="lazy" decoding="async">`;
    const href = safeUrl(attrs.href);
    if (href) img = `<a href="${escapeHtml(href)}">${img}</a>`;
    const caption = typeof attrs.caption === 'string' ? this.merge(attrs.caption.trim()) : '';
    const captionHtml = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
    const width = imageWidthPercent(attrs.widthPercent);
    return {
      html: `<figure class="sw-figure${width ? ` sw-w-${width}` : ''}">${img}${captionHtml}</figure>`,
      text: caption || '',
    };
  }

  button(attrs: Record<string, unknown>): Out {
    const href = safeUrl(attrs.href);
    const label =
      typeof attrs.label === 'string' ? this.merge(attrs.label.trim()).slice(0, 80) : '';
    if (!href || !label) throw new RenderError('A button needs a label and a web address.');
    return {
      html: `<p class="sw-button-row"><a class="sw-button" href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`,
      text: label,
    };
  }

  linkCard(attrs: Record<string, unknown>): Out {
    const href = safeUrl(attrs.href);
    if (!href) throw new RenderError('A link card needs a web address.');
    const host = new URL(href).hostname;
    const title =
      typeof attrs.title === 'string' && attrs.title.trim() ? this.merge(attrs.title.trim()) : host;
    const description =
      typeof attrs.description === 'string' ? this.merge(attrs.description.trim()) : '';
    return {
      html: `<a class="sw-link-card" href="${escapeHtml(href)}"><span class="sw-link-card-title">${escapeHtml(title)}</span>${description ? `<span class="sw-link-card-text">${escapeHtml(description)}</span>` : ''}<span class="sw-link-card-host">${escapeHtml(host)}</span></a>`,
      text: `${title}${description ? ` - ${description}` : ''}`,
    };
  }

  attachment(attrs: Record<string, unknown>): Out {
    const media = typeof attrs.mediaId === 'string' ? this.options.media(attrs.mediaId) : null;
    if (!media) {
      this.warnings.add('An attachment is no longer in the media library and was left out.');
      return { html: '', text: '' };
    }
    const name =
      typeof attrs.name === 'string' && attrs.name.trim()
        ? attrs.name.trim().slice(0, 120)
        : 'Attachment';
    const kind = /\.([a-z0-9]{2,5})$/i.exec(media.url)?.[1]?.toUpperCase() ?? 'file';
    return {
      html: `<a class="sw-attachment" href="${escapeHtml(media.url)}"><span class="sw-attachment-name">${escapeHtml(name)}</span><span class="sw-attachment-kind">Download ${escapeHtml(kind)}</span></a>`,
      text: name,
    };
  }

  askPoll(attrs: Record<string, unknown>): Out {
    const askId = typeof attrs.askId === 'string' ? attrs.askId : '';
    const questionId = typeof attrs.questionId === 'string' ? attrs.questionId : '';
    const poll = askId && questionId ? (this.options.ask?.(askId, questionId) ?? null) : null;
    if (!poll || !/^ak_[0-9a-f]{32}$/.test(askId)) {
      this.warnings.add('A poll is no longer available and was left out.');
      return { html: '', text: '' };
    }
    const options = poll.options
      .filter((o) => /^ao_[0-9a-f]{32}$/.test(o.id))
      .map(
        (o) =>
          `<li><a class="sw-button sw-ghost" href="/_swarm/ask/${askId}?o=${o.id}" rel="nofollow">${escapeHtml(o.label)}</a></li>`,
      )
      .join('');
    return {
      html: `<aside class="sw-poll" aria-label="${escapeHtml(poll.title)}"><p class="sw-poll-title">${escapeHtml(poll.title)}</p>${poll.description ? `<p class="sw-poll-text">${escapeHtml(poll.description)}</p>` : ''}<p class="sw-poll-prompt">${escapeHtml(poll.prompt)}</p><ul class="sw-poll-options">${options}</ul></aside>`,
      text: poll.prompt,
    };
  }

  /** A list of links to the headings of this part; not in the text, so excerpts skip it. */
  tableOfContents(attrs: Record<string, unknown>): Out {
    if (!this.options.codeEmbeds) {
      this.warnings.add('A table of contents was left out because code embeds are not enabled.');
      return { html: '', text: '' };
    }
    if (!this.toc.length) return { html: '', text: '' };
    const title =
      typeof attrs.title === 'string' && attrs.title.trim()
        ? this.merge(attrs.title.trim()).slice(0, 80)
        : 'Contents';
    const items = this.toc
      .map(
        (h) =>
          `<li class="sw-toc-l${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
      )
      .join('');
    return {
      html: `<nav class="sw-toc" aria-label="${escapeHtml(title)}"><p class="sw-toc-title">${escapeHtml(title)}</p><ol>${items}</ol></nav>`,
      text: '',
    };
  }

  htmlBlock(attrs: Record<string, unknown>): Out {
    if (!this.options.allowHtmlBlocks) {
      this.warnings.add('A raw HTML block was left out because raw HTML is not enabled.');
      return { html: '', text: '' };
    }
    const raw = typeof attrs.html === 'string' ? attrs.html : '';
    if (!raw.trim()) return { html: '', text: '' };
    if (raw.length > 50_000) throw new RenderError('A raw HTML block is over 50,000 characters.');
    const height = clampInt(attrs.height, 80, 2000) ?? 360;
    // srcdoc is an attribute: escaping it is what keeps the markup inside the sandbox.
    const doc = `<!doctype html><meta charset="utf-8"><body>${raw}</body>`;
    return {
      html: `<iframe class="sw-embed" sandbox="" srcdoc="${escapeHtml(doc)}" title="Embedded content" height="${height}" loading="lazy" referrerpolicy="no-referrer"></iframe>`,
      text: '',
    };
  }
}

function cutExcerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** How the website splits a document for a reader who may not read all of it. */
interface WebShare {
  /** The document to render, with an implicit paywall break where the post needs one. */
  document: unknown;
  /** True when that break was added here: the post has no paywall break the website shows. */
  implicitGate: boolean;
}

const PREVIEW_BLOCKS = 3;

/**
 * The document as the website shows it. A post that isn't 'public' and has no paywall break the
 * website shows (an email-only one is dropped) would otherwise be free in full, so it gets an
 * implicit break: the free part is its first website blocks, at most 3 and at most half of them.
 * The site page and the site search index both decide the free part here, so search never holds
 * more of a post than its page shows.
 */
export function webShare(document: unknown, visibility: string): WebShare {
  const doc = document as { content?: unknown } | null;
  if (visibility === 'public' || !Array.isArray(doc?.content)) {
    return { document, implicitGate: false };
  }
  // Count only what the website shows: an email-only block in the free share would open more of
  // the post to anyone than the share allows.
  const nodes = shownBlocks(doc.content as Node[], 'web').filter(
    // A snippet that is gone shows nothing, so it can't take a place in the free share either.
    (node) => node?.type !== SNIPPET_NODE,
  );
  if (nodes.some((node) => node?.type === 'gate')) return { document, implicitGate: false };
  const free = Math.min(PREVIEW_BLOCKS, Math.floor(nodes.length / 2));
  return {
    document: {
      ...doc,
      content: [...nodes.slice(0, free), { type: 'gate' }, ...nodes.slice(free)],
    },
    implicitGate: true,
  };
}

/**
 * Renders a document for the website. Throws RenderError on invalid input. `gate` dividers split
 * the output at the top level; any after the first are ignored (they would gate nothing new).
 */
export function renderWeb(document: unknown, options: WebRenderOptions): WebRendered {
  const doc = document as Node;
  if (typeof doc !== 'object' || doc === null || doc.type !== 'doc') {
    throw new RenderError('The document must be an editor document.');
  }
  if (doc.content !== undefined && !Array.isArray(doc.content)) {
    throw new RenderError('Node content must be a list.');
  }
  const nodes = (doc.content ?? []) as Node[];
  const gateAt = nodes.findIndex((node) => node?.type === 'gate');
  const freeNodes = gateAt === -1 ? nodes : nodes.slice(0, gateAt);
  const gatedNodes = gateAt === -1 ? [] : nodes.slice(gateAt + 1).filter((n) => n?.type !== 'gate');

  const renderer = new WebRenderer(options);
  let freeToc: WebRenderer['toc'] = [];
  let allToc: WebRenderer['toc'] = [];
  if (options.codeEmbeds) {
    // Anchors are unique across the whole page, so a link to one never changes when the reader
    // can see more.
    const used = new Set<string>();
    const entries = (list: Node[]) =>
      topLevelHeadings(shownBlocks(list, 'web')).map((h) => {
        const base = headingSlug(webMergeTags(h.text, options.channelName));
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        renderer.headingIds.set(h.node, id);
        return { level: h.level, text: webMergeTags(h.text, options.channelName), id };
      });
    freeToc = entries(freeNodes);
    allToc = [...freeToc, ...entries(gatedNodes)];
  }
  renderer.toc = freeToc;
  const free = renderer.blocks(freeNodes, 0);
  free.html += renderer.takeFootnotes(0);
  const freeNoteCount = renderer.footnoteCount;
  const freePlayers = [...renderer.players];
  renderer.players.clear();
  const firstImage = renderer.firstImage;
  renderer.toc = allToc;
  const gated = renderer.blocks(gatedNodes, 0);
  gated.html += renderer.takeFootnotes(freeNoteCount);
  // Listed with the part they belong to, so someone who can't read the rest doesn't see its notes.
  const text = [free.text, gated.text].filter(Boolean).join('\n\n');

  return {
    freeHtml: free.html,
    gatedHtml: gated.html,
    hasGate: gateAt !== -1,
    text,
    freeText: free.text,
    excerpt: cutExcerpt(free.text),
    readingMinutes: Math.max(1, Math.ceil(wordCount(text) / WORDS_PER_MINUTE)),
    firstImage,
    css: [...renderer.focal.values()].join(''),
    freePlayers,
    gatedPlayers: [...renderer.players],
    warnings: [...renderer.warnings],
  };
}
