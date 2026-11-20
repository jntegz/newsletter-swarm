// What theme HTML may contain, and a small state machine that follows the static HTML of a
// template so each placeholder knows where it sits: in text, in a quoted attribute, or in an
// address. Nothing here builds a DOM; it only reads the template once, when it is saved.

/** Elements a theme may use. No script, style, frames, forms, embeds or document-level tags. */
const ALLOWED_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
  // Inline SVG, for icons and rules drawn in the theme itself.
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
]);

const GLOBAL_ATTRIBUTES = new Set([
  'class',
  'id',
  'lang',
  'dir',
  'title',
  'role',
  'hidden',
  'tabindex',
  'translate',
  'style',
]);

const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target', 'hreflang']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
  time: new Set(['datetime']),
  data: new Set(['value']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  details: new Set(['open', 'name']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
};

const SVG_ATTRIBUTES = new Set([
  'viewbox',
  'xmlns',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'fill-rule',
  'clip-rule',
  'opacity',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'points',
  'transform',
  'focusable',
  'preserveaspectratio',
  'vector-effect',
]);
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
]);

/** Attributes that hold an address; their value is checked as a whole. */
export const URL_ATTRIBUTES = new Set(['href', 'src', 'cite']);

/** Why this attribute can't be on this element, or null when it can. */
function attributeProblem(element: string, attribute: string): string | null {
  const name = attribute.toLowerCase();
  if (name.startsWith('on')) return `“${attribute}” runs code, so it isn’t allowed.`;
  if (name.startsWith('aria-') || name.startsWith('data-')) return null;
  if (GLOBAL_ATTRIBUTES.has(name)) return null;
  if (ELEMENT_ATTRIBUTES[element]?.has(name)) return null;
  if (SVG_ELEMENTS.has(element) && SVG_ATTRIBUTES.has(name)) return null;
  if (name === 'srcset' || name === 'sizes') {
    return 'Use {{ image | image }} for a responsive image; srcset is written for you.';
  }
  return `<${element}> can’t have a “${attribute}” attribute here.`;
}

/** Why this element can't be used, or null when it can. */
function elementProblem(element: string): string | null {
  if (ALLOWED_ELEMENTS.has(element)) return null;
  if (element === 'script') {
    return 'Scripts aren’t allowed in themes. Add code in Website → Custom code, where it waits for consent.';
  }
  if (element === 'style') return 'Put styles in theme.css, not in a <style> element.';
  if (element === 'form' || element === 'input' || element === 'button') {
    return 'Use {% subscribe_form %} for the signup form; other forms aren’t allowed.';
  }
  if (element === 'iframe' || element === 'object' || element === 'embed') {
    return `<${element}> loads another site, so it isn’t allowed in themes.`;
  }
  if (element === 'main') return 'The page already has its <main>; use <div> or <section>.';
  return `<${element}> isn’t allowed in themes.`;
}

/**
 * Why a link or image address can't be used, or null when it can. Links may go anywhere on the
 * web; images and other files must come from this site (the media library) or be inline images,
 * so a theme never makes a reader's browser call another server.
 */
export function urlProblem(attribute: string, value: string): string | null {
  // Browsers ignore these characters inside a scheme, so "java\tscript:" is "javascript:".
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const plain = value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (attribute === 'src') {
    if (plain.startsWith('data:image/') && !plain.startsWith('data:image/svg')) return null;
    if (plain.startsWith('/') && !plain.startsWith('//')) return null;
    return 'Images must come from your media library, so they load from your own site.';
  }
  if (plain === '' || plain.startsWith('#') || plain.startsWith('?')) return null;
  if (plain.startsWith('/') && !plain.startsWith('//')) return null;
  if (/^(https?:|mailto:)/.test(plain)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/.test(plain)) return null; // a relative address such as "about"
  return 'Links can start with https:, http:, mailto:, # or /.';
}

/** The address, or "" when it isn't a safe one (used for addresses filled in when rendering). */
export const safeUrl = (attribute: string, value: string) =>
  urlProblem(attribute, value) ? '' : value;

export const escapeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeAttribute = (value: string) =>
  escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- Following the HTML -------------------------------------------------------------------------

type HtmlState =
  | 'data'
  | 'tag-name'
  | 'end-tag'
  | 'in-tag'
  | 'attr-name'
  | 'after-attr-name'
  | 'before-value'
  | 'value-dq'
  | 'value-sq'
  | 'value-uq'
  | 'comment';

/** Where a placeholder sits, as the renderer needs to know it. */
type Placement = { kind: 'text' } | { kind: 'attribute'; element: string; attribute: string };

interface HtmlProblem {
  offset: number;
  message: string;
}

/**
 * Reads static HTML in pieces (the text between placeholders) and keeps the state between them.
 * Problems are collected rather than thrown, so one save reports all of them.
 */
export class HtmlTracker {
  state: HtmlState = 'data';
  element = '';
  attribute = '';
  /** The static text of the current attribute value, for the address check. */
  value = '';
  /** Whether a placeholder appeared in the current attribute value. */
  valueHasPlaceholder = false;
  private buffer = '';
  readonly problems: HtmlProblem[] = [];
  readonly headings: string[] = [];

  /** Where a placeholder at this point would sit, or a reason it can't sit here. */
  placement(): Placement | string {
    switch (this.state) {
      case 'data':
        return { kind: 'text' };
      case 'value-dq':
      case 'value-sq':
        if (this.attribute === 'style') {
          return 'Placeholders can’t go in a style attribute. Use a class, or a theme setting in theme.css.';
        }
        return { kind: 'attribute', element: this.element, attribute: this.attribute };
      case 'value-uq':
      case 'before-value':
        return 'Put quotes around an attribute that holds a placeholder: attr="{{ … }}".';
      case 'comment':
        return 'Placeholders can’t go inside an HTML comment.';
      default:
        return 'A placeholder can’t go here, inside a tag. Put it in the text or in a quoted attribute value.';
    }
  }

  /** Notes that a placeholder was written in the current attribute value. */
  notePlaceholder() {
    if (this.state === 'value-dq' || this.state === 'value-sq') this.valueHasPlaceholder = true;
  }

  feed(text: string, base: number) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] ?? '';
      const at = base + i;
      switch (this.state) {
        case 'data':
          if (ch === '<') {
            if (text.startsWith('<!--', i)) {
              this.state = 'comment';
              i += 3;
            } else if (text[i + 1] === '/') {
              this.state = 'end-tag';
              this.buffer = '';
              i += 1;
            } else if (/[a-zA-Z]/.test(text[i + 1] ?? '')) {
              this.state = 'tag-name';
              this.buffer = '';
            } else if (text[i + 1] === '!' || text[i + 1] === '?') {
              this.problems.push({
                offset: at,
                message: 'Doctype and processing instructions aren’t allowed in themes.',
              });
            }
          }
          break;
        case 'comment':
          if (text.startsWith('-->', i)) {
            this.state = 'data';
            i += 2;
          }
          break;
        case 'end-tag':
          if (ch === '>') {
            const name = this.buffer.trim().toLowerCase();
            const problem = elementProblem(name);
            if (problem) this.problems.push({ offset: at, message: problem });
            this.state = 'data';
          } else this.buffer += ch;
          break;
        case 'tag-name':
          if (/[\s/>]/.test(ch)) {
            this.element = this.buffer.toLowerCase();
            const problem = elementProblem(this.element);
            // At the "<" that opens the tag.
            if (problem)
              this.problems.push({ offset: at - this.buffer.length - 1, message: problem });
            if (/^h[1-6]$/.test(this.element)) this.headings.push(this.element);
            this.state = 'in-tag';
            if (ch === '>') this.state = 'data';
          } else this.buffer += ch;
          break;
        case 'in-tag':
          if (ch === '>') this.state = 'data';
          else if (ch === '/' || /\s/.test(ch)) break;
          else if (ch === '"' || ch === "'" || ch === '=' || ch === '<') {
            this.problems.push({
              offset: at,
              message: `Unexpected “${ch}” inside <${this.element}>.`,
            });
          } else {
            this.state = 'attr-name';
            this.buffer = ch;
          }
          break;
        case 'attr-name':
          if (ch === '=' || ch === '>' || ch === '/' || /\s/.test(ch)) {
            this.startAttribute(at);
            if (ch === '=') this.state = 'before-value';
            else if (ch === '>') this.state = 'data';
            else this.state = 'after-attr-name';
          } else this.buffer += ch;
          break;
        case 'after-attr-name':
          if (ch === '=') this.state = 'before-value';
          else if (ch === '>') this.state = 'data';
          else if (!/\s/.test(ch) && ch !== '/') {
            this.state = 'attr-name';
            this.buffer = ch;
          }
          break;
        case 'before-value':
          if (ch === '"') this.state = 'value-dq';
          else if (ch === "'") this.state = 'value-sq';
          else if (ch === '>') this.state = 'data';
          else if (!/\s/.test(ch)) {
            this.state = 'value-uq';
            this.value = ch;
          }
          break;
        case 'value-dq':
        case 'value-sq':
          if (
            (this.state === 'value-dq' && ch === '"') ||
            (this.state === 'value-sq' && ch === "'")
          ) {
            this.endValue(at);
            this.state = 'in-tag';
          } else this.value += ch;
          break;
        case 'value-uq':
          if (/\s/.test(ch) || ch === '>') {
            this.endValue(at);
            this.state = ch === '>' ? 'data' : 'in-tag';
          } else this.value += ch;
          break;
      }
    }
  }

  private startAttribute(at: number) {
    this.attribute = this.buffer.toLowerCase();
    this.value = '';
    this.valueHasPlaceholder = false;
    const problem = attributeProblem(this.element, this.attribute);
    if (problem) this.problems.push({ offset: at - this.buffer.length, message: problem });
  }

  private endValue(at: number) {
    if (URL_ATTRIBUTES.has(this.attribute)) {
      if (/&(?!amp;)[#a-z]/i.test(this.value)) {
        this.problems.push({
          offset: at,
          message: 'Write addresses without character references such as &#…;.',
        });
      } else if (!this.valueHasPlaceholder) {
        const problem = urlProblem(this.attribute, this.value.replace(/&amp;/g, '&'));
        if (problem) this.problems.push({ offset: at, message: problem });
      }
    }
    if (this.attribute === 'style' && this.value) {
      const problem = inlineStyleProblem(this.value);
      if (problem) this.problems.push({ offset: at, message: problem });
    }
    this.value = '';
    this.valueHasPlaceholder = false;
  }

  /**
   * A snapshot, to check that a branch leaves the HTML where it found it. Between tags the last
   * element and attribute seen don't matter: a block may hold whole elements.
   */
  snapshot(): string {
    if (this.state === 'data' || this.state === 'comment') return this.state;
    return `${this.state}|${this.element}|${this.attribute}`;
  }
}

/** The same rules as theme.css, for a style="…" attribute. */
export function inlineStyleProblem(css: string): string | null {
  const plain = css.toLowerCase();
  if (css.includes('\\')) return 'Styles can’t contain backslash escapes.';
  if (/url\(\s*(?!['"]?data:image\/(?!svg))/.test(plain)) {
    return 'url() can only hold an inline image. Files from other sites aren’t allowed.';
  }
  if (/expression\(|javascript:|behaviou?r\s*:|-moz-binding|@import/.test(plain)) {
    return 'That style can run code or load files, so it isn’t allowed.';
  }
  return null;
}
