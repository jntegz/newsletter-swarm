// Draws a parsed template with data. Output is escaped for where it sits; only HTML that Swarm
// itself builds (the signup form, images) goes in as HTML. Every render is bounded, so a theme
// can't make a page slow: too many steps or too much output stops it with a RenderLimit error.
import { escapeAttribute, escapeText, safeUrl } from './html';
import type { Cond, Expr, Filter, Node, Value } from './parse';

/** HTML Swarm built and vouches for. Theme data never becomes one of these. */
class TrustedHtml {
  constructor(readonly html: string) {}
  toString() {
    return this.html;
  }
}

/** An image as templates see it: draw it with {{ x | image }} or read its url and alt. */
export interface TemplateImage {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** CSS object-position, "50% 30%". */
  focal: string;
}

/** Where a signup form sits: the section drawing it and the variant drawn. */
export interface FormContext {
  sectionId: string;
  variant: 'a' | 'b';
}

export interface RenderHooks {
  /**
   * The publication's signup form, as built by the site. Inside a section it is told which one
   * and which variant, so the host can add hidden fields; in the layout it gets no context.
   */
  subscribeForm: (context?: FormContext) => string;
  /**
   * HTML the host trusts, added at the end of each section's wrapper (the site's lazy beacon for
   * section analytics). Not called for a fixed `{% section %}` that isn't one of the page's own.
   */
  sectionEnd?: (sectionId: string, variant: 'a' | 'b') => string;
  /** A responsive <img> for a template image. */
  image: (image: TemplateImage, sizes: string) => string;
  /** Today, for dates; injectable for tests. */
  now?: () => Date;
}

export interface RenderFiles {
  layout: Node[] | null;
  sections: Record<string, Node[]>;
  snippets: Record<string, Node[]>;
}

export interface SectionToRender {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  /** Extra classes on the section's wrapper (where it shows). */
  classes: string[];
  /** The variant drawn: 'b' when an A/B test is running and this view got B. */
  variant?: 'a' | 'b' | undefined;
}

export class RenderLimit extends Error {}

export const LIMITS = { steps: 200_000, output: 512 * 1024, depth: 4, loop: 100 } as const;

type Scope = Map<string, unknown>;

interface State {
  steps: number;
  size: number;
  depth: number;
  hooks: RenderHooks;
  files: RenderFiles;
  sections: SectionToRender[];
  globals: Record<string, unknown>;
  /** The section being drawn, for the signup form's context. */
  current: FormContext | null;
}

/**
 * Draws a page: the layout with its sections, or the sections alone when the theme has no layout.
 * `globals` are what every file can read (site, reader, posts, theme…).
 */
export function renderPage(
  files: RenderFiles,
  sections: SectionToRender[],
  globals: Record<string, unknown>,
  hooks: RenderHooks,
): string {
  const state: State = {
    steps: 0,
    size: 0,
    depth: 0,
    hooks,
    files,
    sections,
    globals,
    current: null,
  };
  if (files.layout) return walk(files.layout, scopeOf(globals), state);
  return drawSections(state);
}

/** Draws one template on its own (a snippet or a section), for previews and tests. */
export function renderNodes(
  nodes: Node[],
  globals: Record<string, unknown>,
  hooks: RenderHooks,
  files: RenderFiles = { layout: null, sections: {}, snippets: {} },
): string {
  const state: State = {
    steps: 0,
    size: 0,
    depth: 0,
    hooks,
    files,
    sections: [],
    globals,
    current: null,
  };
  return walk(nodes, scopeOf(globals), state);
}

const scopeOf = (values: Record<string, unknown>): Scope => new Map(Object.entries(values));

function drawSections(state: State): string {
  return state.sections.map((s) => drawSection(s, state)).join('');
}

function drawSection(section: SectionToRender, state: State): string {
  const nodes = state.files.sections[section.type];
  if (!nodes) return '';
  const scope = scopeOf(state.globals);
  const index = state.sections.indexOf(section);
  const variant = section.variant ?? 'a';
  scope.set('section', {
    id: section.id,
    type: section.type,
    settings: section.settings,
    index: index + 1,
  });
  const classes = ['t-section', `t-section--${section.type}`, ...section.classes]
    .map((c) => c.replace(/[^\w-]/g, ''))
    .join(' ');
  const outer = state.current;
  state.current = { sectionId: section.id, variant };
  let inner: string;
  try {
    inner = walk(nodes, scope, state);
  } finally {
    state.current = outer;
  }
  // The host's own HTML (the beacon), only for the page's own sections.
  const end =
    index !== -1 && state.hooks.sectionEnd ? state.hooks.sectionEnd(section.id, variant) : '';
  return `<div class="${classes}" id="section-${escapeAttribute(section.id)}">${inner}${end}</div>`;
}

function tick(state: State) {
  if (++state.steps > LIMITS.steps)
    throw new RenderLimit('This page takes too many steps to draw.');
}

function emit(out: string[], text: string, state: State) {
  state.size += text.length;
  if (state.size > LIMITS.output) throw new RenderLimit('This page is too large.');
  out.push(text);
}

function walk(nodes: Node[], scope: Scope, state: State): string {
  const out: string[] = [];
  for (const node of nodes) {
    tick(state);
    switch (node.t) {
      case 'text':
        emit(out, node.v, state);
        break;
      case 'out': {
        const v = evaluate(node.v, scope, state);
        if (node.c === 't')
          emit(out, v instanceof TrustedHtml ? v.html : escapeText(text(v)), state);
        else if (node.c === 'a')
          emit(out, escapeAttribute(text(v instanceof TrustedHtml ? '' : v)), state);
        else {
          const address = v instanceof TrustedHtml ? '' : text(v);
          emit(out, escapeAttribute(safeUrl(node.c.url, address)), state);
        }
        break;
      }
      case 'if': {
        let chosen: Node[] | null = node.else;
        for (const branch of node.branches) {
          const yes = truthy(condition(branch.cond, scope, state));
          if (node.unless ? !yes : yes) {
            chosen = branch.body;
            break;
          }
        }
        if (chosen) emit(out, walk(chosen, scope, state), state);
        break;
      }
      case 'for': {
        let items = list(evaluate(node.list, scope, state));
        if (node.reversed) items = [...items].reverse();
        const offset = node.offset ? Math.max(0, Math.floor(num(literal(node.offset, scope)))) : 0;
        const limit = node.limit
          ? Math.max(0, Math.floor(num(literal(node.limit, scope))))
          : LIMITS.loop;
        items = items.slice(offset, offset + Math.min(limit, LIMITS.loop));
        if (!items.length) {
          if (node.else) emit(out, walk(node.else, scope, state), state);
          break;
        }
        const inner = new Map(scope);
        items.forEach((item, index) => {
          inner.set(node.name, item);
          inner.set('forloop', {
            index: index + 1,
            index0: index,
            first: index === 0,
            last: index === items.length - 1,
            length: items.length,
          });
          emit(out, walk(node.body, inner, state), state);
        });
        break;
      }
      case 'assign':
        scope.set(node.name, evaluate(node.v, scope, state));
        break;
      case 'sections':
        emit(out, drawSections(state), state);
        break;
      case 'section': {
        const section = state.sections.find((s) => s.type === node.name) ?? {
          id: node.name,
          type: node.name,
          settings: {},
          classes: [],
        };
        emit(out, drawSection(section, state), state);
        break;
      }
      case 'render': {
        const snippet = state.files.snippets[node.name];
        if (!snippet) break;
        if (state.depth >= LIMITS.depth) throw new RenderLimit('Snippets are nested too deeply.');
        // A snippet sees what it's given, plus the page-wide values.
        const inner: Scope = new Map(
          ['site', 'reader', 'theme', 'page'].map((k) => [k, state.globals[k]] as const),
        );
        for (const [key, value] of Object.entries(node.args))
          inner.set(key, evaluate(value, scope, state));
        state.depth++;
        emit(out, walk(snippet, inner, state), state);
        state.depth--;
        break;
      }
      case 'subscribe':
        emit(
          out,
          state.current
            ? state.hooks.subscribeForm({ ...state.current })
            : state.hooks.subscribeForm(),
          state,
        );
        break;
    }
  }
  return out.join('');
}

// ---- Values --------------------------------------------------------------------------------------

function literal(e: Expr, scope: Scope): unknown {
  if (e.k === 'lit') return e.v;
  let v: unknown = scope.get(String(e.p[0]));
  for (const key of e.p.slice(1)) v = property(v, key);
  return v;
}

function property(v: unknown, key: string | number): unknown {
  if (v == null) return null;
  if (Array.isArray(v) || typeof v === 'string') {
    if (key === 'size') return v.length;
    if (key === 'first') return v[0] ?? null;
    if (key === 'last') return v[v.length - 1] ?? null;
    if (typeof key === 'number') return v[key < 0 ? v.length + key : key] ?? null;
    return null;
  }
  if (typeof v === 'object' && !(v instanceof TrustedHtml)) {
    // Own properties only: nothing reaches the prototype.
    return Object.prototype.hasOwnProperty.call(v, key)
      ? (v as Record<string, unknown>)[key]
      : null;
  }
  return null;
}

function evaluate(value: Value, scope: Scope, state: State): unknown {
  let v = literal(value.base, scope);
  for (const filter of value.filters) {
    tick(state);
    v = apply(filter, v, scope, state);
  }
  return v;
}

const text = (v: unknown): string => {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(text).join(', ');
  if (typeof v === 'object') return '';
  return String(v);
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(text(v));
  return Number.isFinite(n) ? n : 0;
};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

const truthy = (v: unknown) =>
  !(v == null || v === false || v === '' || (Array.isArray(v) && v.length === 0));

const numberFormat = new Intl.NumberFormat('en');
const dateFormats: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' },
  long: { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' },
  month: { month: 'long', year: 'numeric', timeZone: 'UTC' },
  year: { year: 'numeric', timeZone: 'UTC' },
};

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isImage(v: unknown): v is TemplateImage {
  return !!v && typeof v === 'object' && typeof (v as TemplateImage).url === 'string';
}

function apply(filter: Filter, v: unknown, scope: Scope, state: State): unknown {
  const arg = (i: number) => literal(filter.args[i] as Expr, scope);
  switch (filter.name) {
    case 'default':
      return truthy(v) ? v : arg(0);
    case 'truncate': {
      const s = text(v);
      const n = Math.max(1, Math.floor(num(arg(0))));
      const end = filter.args[1] ? text(arg(1)) : '…';
      return s.length > n ? `${s.slice(0, Math.max(0, n - end.length)).trimEnd()}${end}` : s;
    }
    case 'truncatewords': {
      const words = text(v).split(/\s+/).filter(Boolean);
      const n = Math.max(1, Math.floor(num(arg(0))));
      const end = filter.args[1] ? text(arg(1)) : '…';
      return words.length > n ? `${words.slice(0, n).join(' ')}${end}` : words.join(' ');
    }
    case 'date': {
      const d = toDate(v);
      if (!d) return '';
      const style = filter.args[0] ? text(arg(0)) : 'short';
      if (style === 'iso') return d.toISOString().slice(0, 10);
      if (style === 'ago') return ago(d, state.hooks.now?.() ?? new Date());
      return new Intl.DateTimeFormat('en-US', dateFormats[style] ?? dateFormats.short).format(d);
    }
    case 'number':
      return numberFormat.format(num(v));
    case 'plural':
      return `${numberFormat.format(num(v))} ${num(v) === 1 ? text(arg(0)) : text(arg(1))}`;
    case 'upcase':
      return text(v).toUpperCase();
    case 'downcase':
      return text(v).toLowerCase();
    case 'capitalize': {
      const s = text(v);
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    case 'strip':
      return text(v).trim();
    case 'size':
      return Array.isArray(v) || typeof v === 'string' ? v.length : 0;
    case 'first':
      return property(v, 'first');
    case 'last':
      return property(v, 'last');
    case 'join':
      return list(v)
        .map(text)
        .join(filter.args[0] ? text(arg(0)) : ', ');
    case 'append':
      return text(v) + text(arg(0));
    case 'prepend':
      return text(arg(0)) + text(v);
    case 'replace':
      return text(v)
        .split(text(arg(0)))
        .join(text(arg(1)));
    case 'plus':
      return num(v) + num(arg(0));
    case 'minus':
      return num(v) - num(arg(0));
    case 'url_encode':
      return encodeURIComponent(text(v));
    case 'escape':
      return v;
    case 'paragraphs': {
      // Text an owner typed, escaped, with blank lines as paragraphs and line breaks kept.
      const blocks = text(v)
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter(Boolean);
      return new TrustedHtml(
        blocks.map((b) => `<p>${escapeText(b).replace(/\n/g, '<br>')}</p>`).join(''),
      );
    }
    case 'image': {
      if (!isImage(v)) return '';
      const sizes = filter.args[0] ? text(arg(0)) : '100vw';
      return new TrustedHtml(state.hooks.image(v, sizes.replace(/[^\w\s(),:.%-]/g, '')));
    }
    default:
      return v;
  }
}

function ago(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function condition(c: Cond, scope: Scope, state: State): boolean {
  if (c.k !== 'test') {
    return c.k === 'and'
      ? condition(c.left, scope, state) && condition(c.right, scope, state)
      : condition(c.left, scope, state) || condition(c.right, scope, state);
  }
  const left = evaluate(c.left, scope, state);
  if (!c.op || !c.right) return truthy(left);
  const right = evaluate(c.right, scope, state);
  switch (c.op) {
    case '==':
      return same(left, right);
    case '!=':
      return !same(left, right);
    case '<':
      return num(left) < num(right);
    case '>':
      return num(left) > num(right);
    case '<=':
      return num(left) <= num(right);
    case '>=':
      return num(left) >= num(right);
    case 'contains':
      return Array.isArray(left)
        ? left.some((item) => same(item, right))
        : text(left).includes(text(right));
  }
}

function same(a: unknown, b: unknown): boolean {
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObject(a) || isObject(b)) return a === b;
  if (a === '' && (b == null || (Array.isArray(b) && !b.length))) return true;
  if (b === '' && (a == null || (Array.isArray(a) && !a.length))) return true;
  if (typeof a === 'number' || typeof b === 'number') return num(a) === num(b);
  return a === b || text(a) === text(b);
}
