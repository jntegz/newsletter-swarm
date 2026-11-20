/**
 * Custom email CSS (the custom_email_css flag): a Channel's own stylesheet for its emails.
 *
 * `lintEmailCss` parses the stylesheet with a small parser of its own and returns errors (the
 * stylesheet is refused) and warnings (it is saved, but some mail clients will ignore a part).
 * Nothing the author typed reaches an email as written: `applyEmailCss` works from the parsed
 * rules only, so a stylesheet that lints clean is re-serialised, never pasted.
 *
 * Errors: `@import` and other at-rules that load or declare things, any `url()` (external
 * images, fonts and trackers), `expression()`, `javascript:`, `behavior`/`-moz-binding`,
 * `position: fixed`, `<` (it could close the style element), `{{` (it could act as a merge tag),
 * unbalanced braces and anything over EMAIL_CSS_MAX_BYTES.
 *
 * Placement: a rule whose selectors are all simple (`p`, `.sw-button`, `a.sw-button`) outside
 * `@media` is inlined into the matching elements' `style` attributes, after the renderer's own
 * styles so it wins; that is the only form Gmail and Outlook apply everywhere. Everything else
 * (`@media`, descendant selectors, pseudo-classes) goes into a `<style>` element in the head.
 */

/** The largest stylesheet a Channel can save, in UTF-8 bytes. */
export const EMAIL_CSS_MAX_BYTES = 20_000;
const MAX_RULES = 400;

/**
 * Class names the email renderer puts on its elements, for custom CSS to target. Element
 * selectors (`p`, `h1`, `h2`, `h3`, `ul`, `ol`, `li`, `blockquote`, `a`, `img`, `hr`, `pre`, `code`)
 * work too.
 */
export const EMAIL_CSS_CLASSES = [
  'sw-body',
  'sw-card',
  'sw-header',
  'sw-content',
  'sw-footer',
  'sw-button',
  'sw-code',
  'sw-caption',
  'sw-link-card',
  'sw-attachment',
  'sw-poll',
  'sw-toc',
] as const;

interface CssIssue {
  level: 'error' | 'warning';
  message: string;
  /** 1-based line in the stylesheet. */
  line: number;
}

interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

interface CssRule {
  selectors: string[];
  declarations: CssDeclaration[];
  /** The `@media` condition the rule sits in, or null. */
  media: string | null;
}

interface EmailCssLint {
  ok: boolean;
  errors: CssIssue[];
  warnings: CssIssue[];
  rules: CssRule[];
}

/** Properties that major mail clients drop (Outlook for Windows, Gmail, Yahoo). */
const IGNORED_PROPERTIES: Record<string, string> = {
  'box-shadow': 'Outlook for Windows ignores box-shadow.',
  transform: 'Most mail clients ignore transform.',
  transition: 'Mail clients don’t animate, so transition has no effect.',
  animation: 'Most mail clients ignore animation.',
  filter: 'Most mail clients ignore filter.',
  'backdrop-filter': 'Most mail clients ignore backdrop-filter.',
  'clip-path': 'Most mail clients ignore clip-path.',
  'mix-blend-mode': 'Most mail clients ignore mix-blend-mode.',
  'object-fit': 'Outlook and Gmail ignore object-fit.',
  float: 'Outlook for Windows ignores float on most elements.',
  'z-index': 'Gmail ignores z-index.',
  'background-image': 'Outlook for Windows ignores background-image.',
  gap: 'Outlook for Windows ignores gap.',
  'grid-template-columns': 'Outlook for Windows ignores grid layout.',
  'grid-template-rows': 'Outlook for Windows ignores grid layout.',
  'flex-direction': 'Outlook for Windows ignores flex layout.',
  'justify-content': 'Outlook for Windows ignores flex layout.',
  'align-items': 'Outlook for Windows ignores flex layout.',
};

const BLOCKED_PROPERTIES = new Set(['behavior', '-moz-binding', '-ms-behavior']);

interface Located {
  text: string;
  at: number;
}

class Parser {
  readonly errors: CssIssue[] = [];
  readonly warnings: CssIssue[] = [];
  readonly rules: CssRule[] = [];
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly css: string,
  ) {}

  line(at: number): number {
    let n = 1;
    for (let i = 0; i < at && i < this.source.length; i++) if (this.source[i] === '\n') n++;
    return n;
  }

  error(message: string, at: number): void {
    this.errors.push({ level: 'error', message, line: this.line(at) });
  }

  warn(message: string, at: number): void {
    if (this.warnings.some((w) => w.message === message)) return;
    this.warnings.push({ level: 'warning', message, line: this.line(at) });
  }

  skipSpace(): void {
    while (this.pos < this.css.length && /\s/.test(this.css[this.pos] as string)) this.pos++;
  }

  /** Reads up to (not including) one of `stops` at nesting depth 0, skipping strings. */
  readUntil(stops: string): Located {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.css.length) {
      const ch = this.css[this.pos] as string;
      if (ch === '"' || ch === "'") {
        const end = this.css.indexOf(ch, this.pos + 1);
        const newline = this.css.indexOf('\n', this.pos + 1);
        if (end === -1 || (newline !== -1 && newline < end)) {
          this.error('A quoted value is not closed.', this.pos);
          this.pos = newline === -1 ? this.css.length : newline;
          continue;
        }
        this.pos = end + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && stops.includes(ch)) break;
      this.pos++;
    }
    return { text: this.css.slice(start, this.pos), at: start };
  }

  parse(media: string | null, nested: boolean): void {
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.css.length) {
        if (nested) this.error('A block is missing its closing brace.', this.pos);
        return;
      }
      const ch = this.css[this.pos];
      if (ch === '}') {
        if (nested) {
          this.pos++;
          return;
        }
        this.error('There is a closing brace without an opening one.', this.pos);
        this.pos++;
        continue;
      }
      if (ch === '@') this.atRule(media);
      else this.rule(media);
    }
  }

  atRule(media: string | null): void {
    const start = this.pos;
    const name = /^@([a-zA-Z-]+)/.exec(this.css.slice(this.pos))?.[1]?.toLowerCase() ?? '';
    this.pos += name.length + 1;
    const prelude = this.readUntil('{;');
    const hasBlock = this.css[this.pos] === '{';
    this.pos++;
    if (name === 'media') {
      if (!hasBlock) return this.error('@media needs a block.', start);
      const condition = prelude.text.trim().replace(/\s+/g, ' ');
      if (media) this.error('@media can’t be nested inside @media.', start);
      else if (!/^[\w\s():,.-]+$/.test(condition))
        this.error('This @media condition can’t be used.', start);
      this.parse(condition, true);
      return;
    }
    if (['import', 'charset', 'namespace', 'font-face', 'property', 'layer'].includes(name)) {
      this.error(
        name === 'import'
          ? '@import isn’t allowed: an email can’t load another stylesheet.'
          : `@${name} isn’t allowed in email CSS.`,
        start,
      );
    } else {
      this.warn(`Most mail clients ignore @${name || 'rules'}, so it was left out.`, start);
    }
    if (hasBlock) this.skipBlock();
  }

  skipBlock(): void {
    let depth = 1;
    while (this.pos < this.css.length && depth > 0) {
      const ch = this.css[this.pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      this.pos++;
    }
    if (depth > 0) this.error('A block is missing its closing brace.', this.pos);
  }

  rule(media: string | null): void {
    const selectorText = this.readUntil('{}');
    if (this.css[this.pos] !== '{') {
      this.error('A selector is missing its block.', selectorText.at);
      return;
    }
    this.pos++;
    const selectors = selectorText.text
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const at = selectorText.at;
    if (!selectors.length) this.error('A rule has no selector.', at);
    for (const selector of selectors) {
      if (!/^[\w\s.#:>+~*[\]="'()|^$-]+$/.test(selector)) {
        this.error(`The selector “${selector.slice(0, 40)}” can’t be used.`, at);
      }
      if (/:(hover|focus|active|visited|focus-within|checked)\b/.test(selector)) {
        this.warn('Many mail clients ignore :hover and other interactive states.', at);
      }
      if (/::?(before|after)\b/.test(selector)) {
        this.warn('Most mail clients ignore ::before and ::after.', at);
      }
    }
    const declarations: CssDeclaration[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.css.length) {
        this.error('A rule is missing its closing brace.', at);
        break;
      }
      if (this.css[this.pos] === '}') {
        this.pos++;
        break;
      }
      if (this.css[this.pos] === ';') {
        this.pos++;
        continue;
      }
      if (this.css[this.pos] === '{') {
        this.error('Nested rules aren’t supported in email CSS.', this.pos);
        this.pos++;
        this.skipBlock();
        continue;
      }
      const declaration = this.readUntil(';{}');
      const parsed = this.declaration(declaration.text, declaration.at);
      if (parsed) declarations.push(parsed);
    }
    if (selectors.length && declarations.length) {
      if (this.rules.length >= MAX_RULES) {
        this.error(`Email CSS can have at most ${MAX_RULES} rules.`, at);
        return;
      }
      this.rules.push({ selectors, declarations, media });
    }
  }

  declaration(text: string, at: number): CssDeclaration | null {
    const colon = text.indexOf(':');
    if (colon === -1) {
      this.error(`“${text.trim().slice(0, 40)}” is not a property and value.`, at);
      return null;
    }
    const property = text.slice(0, colon).trim().toLowerCase();
    let value = text
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, ' ');
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, '').trim();
    if (!/^-?[a-z][a-z0-9-]*$/.test(property)) {
      this.error(`“${property.slice(0, 40)}” is not a CSS property.`, at);
      return null;
    }
    if (!value) {
      this.error(`${property} has no value.`, at);
      return null;
    }
    const lower = value.toLowerCase();
    if (BLOCKED_PROPERTIES.has(property)) {
      this.error(`${property} isn’t allowed: it can run code in some mail clients.`, at);
      return null;
    }
    if (/\burl\s*\(/.test(lower) || /\bimage-set\s*\(/.test(lower)) {
      this.error(
        `${property} loads a file with url(), which isn’t allowed: images belong in the post, not the stylesheet.`,
        at,
      );
      return null;
    }
    if (/\bexpression\s*\(/.test(lower) || /(java|vb)script\s*:/.test(lower)) {
      this.error(`${property} contains a script, which isn’t allowed.`, at);
      return null;
    }
    if (property === 'position') {
      if (lower === 'fixed') {
        this.error('position: fixed isn’t allowed in email.', at);
        return null;
      }
      this.warn('Gmail and Outlook ignore position, so layouts that rely on it break.', at);
    }
    if (property === 'display' && /\b(inline-)?(flex|grid)\b/.test(lower)) {
      this.warn('Outlook for Windows ignores flex and grid layout.', at);
    }
    if (property.startsWith('--') || /\bvar\s*\(/.test(lower)) {
      this.warn(
        'Gmail ignores CSS variables (var()), so declarations that use them are dropped.',
        at,
      );
    }
    // Own keys only: a property named "constructor" is not one of these.
    const ignored = Object.hasOwn(IGNORED_PROPERTIES, property)
      ? IGNORED_PROPERTIES[property]
      : undefined;
    if (ignored) this.warn(ignored, at);
    return { property, value, important };
  }
}

/** Lints a stylesheet for email. `ok` is false when there is at least one error. */
export function lintEmailCss(source: string): EmailCssLint {
  const fail = (message: string, line = 1): EmailCssLint => ({
    ok: false,
    errors: [{ level: 'error', message, line }],
    warnings: [],
    rules: [],
  });
  if (new TextEncoder().encode(source).length > EMAIL_CSS_MAX_BYTES) {
    return fail(`Email CSS can be at most ${EMAIL_CSS_MAX_BYTES / 1000} KB.`);
  }
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const angle = source.indexOf('<');
  if (angle !== -1) return fail('Email CSS can’t contain “<”.', lineOf(angle));
  const braces = source.indexOf('{{');
  if (braces !== -1) return fail('Email CSS can’t contain “{{”.', lineOf(braces));
  if (source.includes('\\')) {
    return fail('Escapes (\\) aren’t supported in email CSS.', lineOf(source.indexOf('\\')));
  }
  // Comments become spaces of the same length, so positions (and line numbers) stay put.
  let unclosed = -1;
  const css = source.replace(/\/\*[\s\S]*?(\*\/|$)/g, (comment, end: string, index: number) => {
    if (!end) unclosed = index;
    return comment.replace(/[^\n]/g, ' ');
  });
  const parser = new Parser(source, css);
  if (unclosed !== -1) parser.error('A comment is not closed.', unclosed);
  parser.parse(null, false);
  return {
    ok: parser.errors.length === 0,
    errors: parser.errors,
    warnings: parser.warnings,
    rules: parser.errors.length === 0 ? parser.rules : [],
  };
}

// ---- Placement ---------------------------------------------------------------------------

const SIMPLE_SELECTOR = /^([a-z][a-z0-9]*)?((?:\.[A-Za-z_][\w-]*)*)$/;

interface Simple {
  tag: string | null;
  classes: string[];
  specificity: number;
}

function simple(selector: string): Simple | null {
  const match = SIMPLE_SELECTOR.exec(selector);
  if (!match || (!match[1] && !match[2])) return null;
  const classes = (match[2] ?? '').split('.').filter(Boolean);
  return { tag: match[1] ?? null, classes, specificity: classes.length * 10 + (match[1] ? 1 : 0) };
}

const serialize = (d: CssDeclaration) =>
  `${d.property}:${d.value}${d.important ? ' !important' : ''}`;

function attrEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Places linted rules into an email: simple rules inline on matching elements in the body, the
 * rest returned as stylesheet text for a `<style>` element in the head.
 */
export function applyEmailCss(
  html: string,
  rules: readonly CssRule[],
): { html: string; stylesheet: string } {
  const inline: { selector: Simple; declarations: CssDeclaration[]; order: number }[] = [];
  const rest: string[] = [];
  const media = new Map<string, string[]>();
  rules.forEach((rule, order) => {
    const simples = rule.media === null ? rule.selectors.map(simple) : [];
    if (simples.length && simples.every((s) => s !== null)) {
      for (const selector of simples as Simple[]) {
        inline.push({ selector, declarations: rule.declarations, order });
      }
      return;
    }
    const text = `${rule.selectors.join(',')}{${rule.declarations.map(serialize).join(';')}}`;
    if (rule.media === null) rest.push(text);
    else media.set(rule.media, [...(media.get(rule.media) ?? []), text]);
  });
  for (const [condition, inner] of media) rest.push(`@media ${condition}{${inner.join('')}}`);

  let out = html;
  if (inline.length) {
    const bodyAt = Math.max(0, html.search(/<body\b/i));
    const head = html.slice(0, bodyAt);
    const body = html
      .slice(bodyAt)
      .replace(
        /<([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*?)?(\/?)>/g,
        (whole, tagName: string, attrs: string | undefined, slash: string) => {
          const tag = tagName.toLowerCase();
          const attributes = attrs ?? '';
          const classes = (/\sclass="([^"]*)"/.exec(attributes)?.[1] ?? '').split(/\s+/);
          const matching = inline
            .filter(
              ({ selector }) =>
                (selector.tag === null || selector.tag === tag) &&
                selector.classes.every((c) => classes.includes(c)),
            )
            .sort((a, b) => a.selector.specificity - b.selector.specificity || a.order - b.order);
          if (!matching.length) return whole;
          const added = attrEscape(
            matching.flatMap((m) => m.declarations.map(serialize)).join(';'),
          );
          const style = /\sstyle="([^"]*)"/.exec(attributes);
          const next = style
            ? attributes.replace(
                style[0],
                ` style="${style[1]?.replace(/;\s*$/, '') ?? ''}${style[1] ? ';' : ''}${added}"`,
              )
            : `${attributes} style="${added}"`;
          return `<${tagName}${next}${slash}>`;
        },
      );
    out = head + body;
  }
  return { html: out, stylesheet: rest.join('') };
}
