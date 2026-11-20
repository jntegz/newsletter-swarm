/**
 * Feed Sync: item HTML into editor blocks (the TipTap JSON the renderer in @swarm/mail accepts).
 * Never a raw HTML block: a small tolerant tokenizer builds a tree, and a walk keeps only the
 * nodes and marks the editor has. Scripts, embeds and forms are dropped with their contents;
 * unknown tags keep their text. Links keep http, https and mailto; images keep https sources.
 * Rules: docs/feed-sync.md "Making Dispatches".
 */
import { FEED_SYNC_LIMITS } from '@swarm/domain';

export interface DocMark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';
  attrs?: { href: string };
}

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}

// ---- Tokenizer and tree ----------------------------------------------------------------------

interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlElement | string)[];
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Their text is not markup: skipped to the end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);
/** Each raw-text element's end tag, found from a position without copying the document. */
const RAW_TEXT_END = new Map([...RAW_TEXT].map((tag) => [tag, new RegExp(`</${tag}`, 'gi')]));
/** Dropped with everything inside. */
const DROPPED = new Set([
  ...RAW_TEXT,
  'head',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'video',
  'audio',
  'canvas',
  'form',
  'button',
  'select',
  'input',
  'picture',
  'map',
]);
/** An open one of these is closed by a new one of the same kind (`<p>a<p>b`, `<li>a<li>b`). */
const SELF_CLOSING_SIBLINGS = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'option']);
const BLOCK_CLOSES_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const MAX_TREE_DEPTH = 64;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  shy: '­',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  iexcl: '¡',
  iquest: '¿',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  yacute: 'ý',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  agrave: 'à',
  egrave: 'è',
  ograve: 'ò',
  auml: 'ä',
  euml: 'ë',
  iuml: 'ï',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  ccedil: 'ç',
  ntilde: 'ñ',
  oslash: 'ø',
  aring: 'å',
};

/** Decodes HTML character references; unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
    (whole, ref: string) => {
      if (ref[0] === '#') {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? Number.parseInt(ref.slice(2), 16)
            : Number.parseInt(ref.slice(1), 10);
        // NUL, surrogates and out-of-range code points become the replacement character.
        if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return '�';
        return String.fromCodePoint(code);
      }
      // Own names only: a feed's &constructor; must not find Object.prototype's.
      return Object.hasOwn(NAMED, ref) ? NAMED[ref]! : whole;
    },
  );
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** A forgiving HTML tree: unmatched end tags are ignored, unclosed elements close at the end. */
function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const closeTo = (tag: string): boolean => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k]!.tag === tag) {
        stack.length = k;
        return true;
      }
    }
    return false;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const text = html.slice(i, lt < 0 ? html.length : lt);
      top().children.push(decodeHtmlEntities(text));
      if (lt < 0) break;
      i = lt;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html[i + 1] === '/';
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(i + (closing ? 2 : 1), i + 40));
    if (!nameMatch) {
      // A lone '<' is text.
      top().children.push('<');
      i += 1;
      continue;
    }
    // Walk to the closing '>', minding quotes.
    let j = i + 1;
    let quote = '';
    while (j < html.length) {
      const ch = html[j]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const tag = nameMatch[0].toLowerCase();
    if (closing) {
      closeTo(tag);
      i = j + 1;
      continue;
    }
    const inner = html.slice(i + 1 + nameMatch[0].length, j);
    i = j + 1;
    const rawEnd = RAW_TEXT_END.get(tag);
    if (rawEnd) {
      // Lowercasing the whole document here, once per raw-text tag, cost O(tags * length).
      rawEnd.lastIndex = i;
      const end = rawEnd.exec(html)?.index ?? -1;
      i = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
      continue;
    }
    if (SELF_CLOSING_SIBLINGS.has(tag) && top().tag === tag) stack.pop();
    else if (BLOCK_CLOSES_P.has(tag) && top().tag === 'p') stack.pop();
    const element: HtmlElement = { tag, attrs: parseAttributes(inner), children: [] };
    top().children.push(element);
    if (!VOID.has(tag) && !inner.trimEnd().endsWith('/') && stack.length < MAX_TREE_DEPTH) {
      stack.push(element);
    }
  }
  return root;
}

// ---- URLs ------------------------------------------------------------------------------------

/** An http(s) or mailto link, resolved against `base`; null for anything else. */
export function safeLink(raw: string | undefined, base: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  if (/^mailto:[^\s<>"]+$/i.test(value)) return value;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** An https image address, resolved against `base`; null for anything else. */
export function safeImage(raw: string | undefined, base: string | null): string | null {
  const url = safeLink(raw, base);
  return url?.startsWith('https://') ? url : null;
}

// ---- The walk --------------------------------------------------------------------------------

const MARK_TAGS: Record<string, DocMark['type']> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  cite: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
  kbd: 'code',
  samp: 'code',
  tt: 'code',
};
const CONTAINERS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'center',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'li',
  'body',
  'html',
]);
/** Blockquotes and lists nest at most this deep; deeper ones are flattened into their parent. */
const MAX_NESTING = 6;

class Converter {
  private out: DocNode[] = [];
  private inline: DocNode[] = [];
  private nesting = 0;
  /** Inside a heading, images wait here and follow the heading as blocks. */
  private headingImages: DocNode[] | null = null;
  blocks = 0;

  constructor(
    private readonly base: string | null,
    private readonly maxBlocks: number,
  ) {}

  get full(): boolean {
    return this.blocks >= this.maxBlocks;
  }

  convert(root: HtmlElement): DocNode[] {
    this.walk(root.children, []);
    this.flush();
    return this.out;
  }

  private push(node: DocNode): void {
    if (this.full) return;
    this.blocks++;
    this.out.push(node);
  }

  /** Ends the running paragraph, if it has any text. */
  private flush(): void {
    const content = trimInline(this.inline);
    this.inline = [];
    if (content.length) this.push({ type: 'paragraph', content });
  }

  /** Runs `fill` with a fresh block list and returns what it produced. */
  private nested(fill: () => void): DocNode[] {
    const saved = { out: this.out, inline: this.inline };
    this.out = [];
    this.inline = [];
    this.nesting++;
    try {
      fill();
      this.flush();
      return this.out;
    } finally {
      this.nesting--;
      this.out = saved.out;
      this.inline = saved.inline;
    }
  }

  private walk(children: (HtmlElement | string)[], marks: DocMark[]): void {
    for (const child of children) {
      if (this.full) return;
      if (typeof child === 'string') {
        const text = child.replace(/[\s­]+/g, (ws) => (ws === '­' ? '' : ' '));
        if (text) this.inline.push(textNode(text, marks));
        continue;
      }
      this.element(child, marks);
    }
  }

  private element(el: HtmlElement, marks: DocMark[]): void {
    const { tag } = el;
    if (DROPPED.has(tag)) return;
    // Own tags only: <constructor> is not a mark.
    const markType = Object.hasOwn(MARK_TAGS, tag) ? MARK_TAGS[tag] : undefined;
    if (markType) {
      this.walk(el.children, withMark(marks, { type: markType }));
      return;
    }
    switch (tag) {
      case 'a': {
        const href = safeLink(el.attrs.href, this.base);
        this.walk(el.children, href ? withMark(marks, { type: 'link', attrs: { href } }) : marks);
        return;
      }
      case 'br':
        this.inline.push({ type: 'hardBreak' });
        return;
      case 'img': {
        const src = safeImage(el.attrs.src, this.base);
        // Tracking pixels and spacers.
        if (!src || el.attrs.width === '1' || el.attrs.height === '1') return;
        const link = marks.find((m) => m.type === 'link')?.attrs?.href;
        const image: DocNode = {
          type: 'image',
          attrs: {
            src,
            alt: (el.attrs.alt ?? '').trim().slice(0, 300),
            ...(link ? { href: link } : {}),
          },
        };
        if (this.headingImages) {
          this.headingImages.push(image);
          return;
        }
        this.flush();
        this.push(image);
        return;
      }
      case 'hr':
        this.flush();
        this.push({ type: 'horizontalRule' });
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        this.flush();
        const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
        const images: DocNode[] = [];
        this.headingImages = images;
        try {
          this.walk(el.children, marks);
        } finally {
          this.headingImages = null;
        }
        const content = trimInline(this.inline);
        this.inline = [];
        if (content.length) this.push({ type: 'heading', attrs: { level }, content });
        for (const image of images) this.push(image);
        return;
      }
      case 'pre': {
        this.flush();
        // trimEnd strips what \s matches; /\s+$/ is quadratic on a long run of space mid-block.
        const text = textContent(el).replace(/^\n/, '').trimEnd();
        if (text) this.push({ type: 'codeBlock', content: [{ type: 'text', text }] });
        return;
      }
      case 'blockquote': {
        this.flush();
        if (this.nesting >= MAX_NESTING) {
          this.walk(el.children, marks);
          this.flush();
          return;
        }
        const content = this.nested(() => this.walk(el.children, marks));
        if (content.length) this.push({ type: 'blockquote', content });
        return;
      }
      case 'ul':
      case 'ol': {
        this.flush();
        if (this.nesting >= MAX_NESTING) {
          this.walk(el.children, marks);
          this.flush();
          return;
        }
        const items: DocNode[] = [];
        for (const child of el.children) {
          if (this.full) break;
          // Text or tags straight inside a list become an item of their own.
          const parts = typeof child !== 'string' && child.tag === 'li' ? child.children : [child];
          const content = this.nested(() => this.walk(parts, marks));
          if (content.length) items.push({ type: 'listItem', content });
        }
        if (items.length) {
          this.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
        }
        return;
      }
      default:
        if (CONTAINERS.has(tag)) {
          this.flush();
          this.walk(el.children, marks);
          this.flush();
          return;
        }
        // span, font, small, sup, abbr, time, mark… keep their children.
        this.walk(el.children, marks);
    }
  }
}

function withMark(marks: DocMark[], mark: DocMark): DocMark[] {
  return [...marks.filter((m) => m.type !== mark.type), mark];
}

function textNode(text: string, marks: DocMark[]): DocNode {
  return marks.length
    ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) }
    : { type: 'text', text };
}

const sameMarks = (a: DocNode, b: DocNode) =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/**
 * Collapses spaces across text nodes, drops leading and trailing space and breaks, merges
 * neighbours with the same marks and removes empty text (ProseMirror refuses it).
 */
function trimInline(nodes: DocNode[]): DocNode[] {
  const merged: DocNode[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text') {
      let text = node.text ?? '';
      const afterSpace = !last || last.type === 'hardBreak' || last.text?.endsWith(' ');
      if (afterSpace) text = text.replace(/^ +/, '');
      if (!text) continue;
      if (last?.type === 'text' && sameMarks(last, node)) last.text = (last.text ?? '') + text;
      else merged.push({ ...node, text });
    } else {
      if (last?.type === 'text') last.text = (last.text ?? '').replace(/ +$/, '');
      merged.push(node);
    }
  }
  while (merged.length) {
    const last = merged[merged.length - 1]!;
    if (last.type === 'text') last.text = (last.text ?? '').replace(/ +$/, '');
    if (last.type === 'hardBreak' || (last.type === 'text' && !last.text)) merged.pop();
    else break;
  }
  while (merged[0]?.type === 'hardBreak') merged.shift();
  return merged.filter((n) => n.type !== 'text' || n.text);
}

function textContent(el: HtmlElement | string): string {
  if (typeof el === 'string') return el;
  if (DROPPED.has(el.tag)) return '';
  if (el.tag === 'br') return '\n';
  return el.children.map(textContent).join('');
}

/** Item HTML as editor blocks, at most FEED_SYNC_LIMITS.blocksPerItem of them. */
export function htmlToBlocks(
  html: string,
  base: string | null,
  maxBlocks: number = FEED_SYNC_LIMITS.blocksPerItem,
): DocNode[] {
  return new Converter(base, maxBlocks).convert(parseHtml(html));
}

const SPACED = new Set([...CONTAINERS, ...BLOCK_CLOSES_P, 'br', 'li']);

function spacedText(el: HtmlElement | string): string {
  if (typeof el === 'string') return el;
  if (DROPPED.has(el.tag)) return '';
  const inner = el.children.map(spacedText).join('');
  return SPACED.has(el.tag) ? ` ${inner} ` : inner;
}

/** The readable text of item HTML, spaces collapsed. */
export function htmlToText(html: string): string {
  return spacedText(parseHtml(html)).replace(/\s+/g, ' ').trim();
}

/** Plain text (JSON Feed content_text, Atom type="text") as HTML paragraphs. */
export function textToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Cuts text at a word boundary to at most `max` characters, with an ellipsis when cut. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether any image node is among `blocks`, at any depth. */
export function hasImage(blocks: DocNode[]): boolean {
  return blocks.some((b) => b.type === 'image' || (b.content ? hasImage(b.content) : false));
}
