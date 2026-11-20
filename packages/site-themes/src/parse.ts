// The template language: from text to a tree the renderer walks. Parsing never runs anything.
// Each placeholder records where it sits in the HTML (see ./html), so the renderer escapes it the
// right way, and every problem carries a line and column for the editor.
import { HtmlTracker, URL_ATTRIBUTES, urlProblem } from './html';

export interface Problem {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

type Literal = string | number | boolean | null;

export type Expr = { k: 'lit'; v: Literal } | { k: 'path'; p: (string | number)[] };

export interface Filter {
  name: string;
  args: Expr[];
}

export interface Value {
  base: Expr;
  filters: Filter[];
}

type Comparison = '==' | '!=' | '<' | '>' | '<=' | '>=' | 'contains';

export type Cond =
  | { k: 'test'; left: Value; op?: Comparison; right?: Value }
  | { k: 'and' | 'or'; left: Cond; right: Cond };

/** How an output is escaped: as text, as an attribute, or as a whole address checked when drawn. */
type OutputContext = 't' | 'a' | { url: string };

export type Node =
  | { t: 'text'; v: string }
  | { t: 'out'; v: Value; c: OutputContext; line: number }
  | { t: 'if'; branches: { cond: Cond; body: Node[] }[]; else: Node[] | null; unless?: true }
  | {
      t: 'for';
      name: string;
      list: Value;
      limit: Expr | null;
      offset: Expr | null;
      reversed: boolean;
      body: Node[];
      else: Node[] | null;
    }
  | { t: 'assign'; name: string; v: Value }
  | { t: 'sections' }
  | { t: 'section'; name: string; line: number }
  | { t: 'render'; name: string; args: Record<string, Value>; line: number }
  | { t: 'subscribe' };

export interface Parsed {
  nodes: Node[];
  /** The JSON inside {% schema %}…{% endschema %}, if any (section files). */
  schema: { text: string; line: number } | null;
  problems: Problem[];
  /** Static facts the theme checks use. */
  facts: {
    headings: string[];
    subscribe: boolean;
    sections: string[];
    renders: string[];
    sectionsTag: boolean;
  };
}

const FILTERS: Record<string, { min: number; max: number }> = {
  default: { min: 1, max: 1 },
  truncate: { min: 1, max: 2 },
  truncatewords: { min: 1, max: 2 },
  date: { min: 0, max: 1 },
  number: { min: 0, max: 0 },
  plural: { min: 2, max: 2 },
  upcase: { min: 0, max: 0 },
  downcase: { min: 0, max: 0 },
  capitalize: { min: 0, max: 0 },
  strip: { min: 0, max: 0 },
  size: { min: 0, max: 0 },
  first: { min: 0, max: 0 },
  last: { min: 0, max: 0 },
  image: { min: 0, max: 1 },
  url_encode: { min: 0, max: 0 },
  escape: { min: 0, max: 0 },
  paragraphs: { min: 0, max: 0 },
  append: { min: 1, max: 1 },
  prepend: { min: 1, max: 1 },
  replace: { min: 2, max: 2 },
  join: { min: 0, max: 1 },
  minus: { min: 1, max: 1 },
  plus: { min: 1, max: 1 },
};

// ---- Lexing --------------------------------------------------------------------------------------

interface Piece {
  kind: 'text' | 'out' | 'tag';
  body: string;
  /** Offset of the piece in the source. */
  at: number;
}

function pieces(source: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let trimNext = false;
  while (i < source.length) {
    const next = source.slice(i).search(/\{\{|\{%/);
    if (next === -1) {
      out.push({
        kind: 'text',
        body: trimNext ? source.slice(i).trimStart() : source.slice(i),
        at: i,
      });
      break;
    }
    if (next > 0) {
      out.push({
        kind: 'text',
        body: trimNext ? source.slice(i, i + next).trimStart() : source.slice(i, i + next),
        at: i,
      });
    }
    trimNext = false;
    const start = i + next;
    const isOut = source[start + 1] === '{';
    const close = isOut ? '}}' : '%}';
    const end = source.indexOf(close, start + 2);
    if (end === -1) {
      out.push({ kind: isOut ? 'out' : 'tag', body: '\u0000unclosed', at: start });
      break;
    }
    let body = source.slice(start + 2, end);
    if (body.startsWith('-')) {
      body = body.slice(1);
      const last = out[out.length - 1];
      if (last?.kind === 'text') last.body = last.body.trimEnd();
    }
    if (body.endsWith('-')) {
      body = body.slice(0, -1);
      trimNext = true;
    }
    out.push({ kind: isOut ? 'out' : 'tag', body: body.trim(), at: start });
    i = end + 2;
  }
  return out;
}

// ---- Expressions ---------------------------------------------------------------------------------

type Tok = { k: 'id' | 'str' | 'num' | 'op'; v: string };

function tokens(text: string): Tok[] | string {
  const out: Tok[] = [];
  const re =
    /\s*(?:(==|!=|<=|>=|<|>)|([|:,.[\]=])|'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*))/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return `I don’t understand “${text.slice(i).trim().slice(0, 20)}”.`;
    i = re.lastIndex;
    if (m[1]) out.push({ k: 'op', v: m[1] });
    else if (m[2]) out.push({ k: 'op', v: m[2] });
    else if (m[3] !== undefined) out.push({ k: 'str', v: m[3] });
    else if (m[4] !== undefined) out.push({ k: 'str', v: m[4] });
    else if (m[5]) out.push({ k: 'num', v: m[5] });
    else if (m[6]) out.push({ k: 'id', v: m[6] });
  }
  return out;
}

class Reader {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok | undefined {
    return this.toks[this.i++];
  }
  isOp(v: string) {
    const t = this.peek();
    return t?.k === 'op' && t.v === v;
  }
  isId(v: string) {
    const t = this.peek();
    return t?.k === 'id' && t.v === v;
  }
  done() {
    return this.i >= this.toks.length;
  }
}

class SyntaxProblem extends Error {}

function expr(r: Reader): Expr {
  const t = r.next();
  if (!t) throw new SyntaxProblem('Something is missing here.');
  if (t.k === 'str') return { k: 'lit', v: t.v };
  if (t.k === 'num') return { k: 'lit', v: Number(t.v) };
  if (t.k === 'id') {
    if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
    if (t.v === 'nil' || t.v === 'null') return { k: 'lit', v: null };
    if (t.v === 'blank' || t.v === 'empty') return { k: 'lit', v: '' };
    const p: (string | number)[] = [t.v];
    for (;;) {
      if (r.isOp('.')) {
        r.next();
        const n = r.next();
        if (n?.k !== 'id') throw new SyntaxProblem('A name should follow the dot.');
        p.push(n.v);
      } else if (r.isOp('[')) {
        r.next();
        const n = r.next();
        if (n?.k === 'num') p.push(Number(n.v));
        else if (n?.k === 'str') p.push(n.v);
        else throw new SyntaxProblem('Use a number or a quoted name inside [ ].');
        if (!r.isOp(']')) throw new SyntaxProblem('A “]” is missing.');
        r.next();
      } else break;
    }
    return { k: 'path', p };
  }
  throw new SyntaxProblem(`Unexpected “${t.v}”.`);
}

function value(r: Reader): Value {
  const base = expr(r);
  const filters: Filter[] = [];
  while (r.isOp('|')) {
    r.next();
    const name = r.next();
    if (name?.k !== 'id') throw new SyntaxProblem('A filter name should follow “|”.');
    const spec = FILTERS[name.v];
    if (!spec) throw new SyntaxProblem(`There is no “${name.v}” filter.`);
    const args: Expr[] = [];
    if (r.isOp(':')) {
      r.next();
      args.push(expr(r));
      while (r.isOp(',')) {
        r.next();
        args.push(expr(r));
      }
    }
    if (args.length < spec.min || args.length > spec.max) {
      throw new SyntaxProblem(
        spec.min === spec.max
          ? `“${name.v}” takes ${spec.min} value${spec.min === 1 ? '' : 's'}.`
          : `“${name.v}” takes ${spec.min} to ${spec.max} values.`,
      );
    }
    filters.push({ name: name.v, args });
  }
  return { base, filters };
}

const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>=']);

function test(r: Reader): Cond {
  const left = value(r);
  const t = r.peek();
  if (t?.k === 'op' && COMPARISONS.has(t.v)) {
    r.next();
    return { k: 'test', left, op: t.v as Comparison, right: value(r) };
  }
  if (t?.k === 'id' && t.v === 'contains') {
    r.next();
    return { k: 'test', left, op: 'contains', right: value(r) };
  }
  return { k: 'test', left };
}

function cond(r: Reader): Cond {
  let left = test(r);
  while (r.isId('and') || r.isId('or')) {
    const op = r.next()?.v as 'and' | 'or';
    left = { k: op, left, right: test(r) };
  }
  if (!r.done()) throw new SyntaxProblem(`Unexpected “${r.peek()?.v}”.`);
  return left;
}

// ---- The tree ------------------------------------------------------------------------------------

interface Frame {
  tag: 'if' | 'unless' | 'for';
  node: Extract<Node, { t: 'if' } | { t: 'for' }>;
  /** The list being filled (the current branch's body). */
  into: Node[];
  at: number;
  /** HTML state when the block opened; every branch must end where it started. */
  html: string;
}

const RAW_BLOCKS: Record<string, string> = {
  comment: 'endcomment',
  schema: 'endschema',
  raw: 'endraw',
};

/** Parses one template file. Problems are collected; the tree is usable when there are none. */
export function parseTemplate(file: string, source: string): Parsed {
  const problems: Problem[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const where = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
  };
  const problem = (offset: number, message: string, severity: Problem['severity'] = 'error') =>
    problems.push({ file, ...where(offset), message, severity });

  const html = new HtmlTracker();
  const root: Node[] = [];
  const stack: Frame[] = [];
  const facts: Parsed['facts'] = {
    headings: [],
    subscribe: false,
    sections: [],
    renders: [],
    sectionsTag: false,
  };
  let schema: Parsed['schema'] = null;
  const current = () => stack[stack.length - 1]?.into ?? root;
  const push = (node: Node) => current().push(node);

  const list = pieces(source);
  for (let n = 0; n < list.length; n++) {
    const piece = list[n];
    if (!piece) continue;
    if (piece.body === '\u0000unclosed') {
      problem(
        piece.at,
        piece.kind === 'out'
          ? 'This {{ is never closed with }}.'
          : 'This {% is never closed with %}.',
      );
      break;
    }
    if (piece.kind === 'text') {
      if (!piece.body) continue;
      html.feed(piece.body, piece.at);
      push({ t: 'text', v: piece.body });
      continue;
    }
    if (piece.kind === 'out') {
      const place = html.placement();
      if (typeof place === 'string') {
        problem(piece.at, place);
        continue;
      }
      let c: OutputContext = place.kind === 'text' ? 't' : 'a';
      if (place.kind === 'attribute' && URL_ATTRIBUTES.has(place.attribute)) {
        const prefix = html.value;
        if (!prefix && !html.valueHasPlaceholder) c = { url: place.attribute };
        else if (!prefix || !safePrefix(place.attribute, prefix)) {
          problem(
            piece.at,
            'In an address, let the placeholder be the whole address, or start it with https://, / or # before the placeholder.',
          );
          continue;
        }
      }
      html.notePlaceholder();
      try {
        const r = new Reader(asTokens(piece.body));
        const v = value(r);
        if (!r.done()) throw new SyntaxProblem(`Unexpected “${r.peek()?.v}”.`);
        push({ t: 'out', v, c, line: where(piece.at).line });
      } catch (error) {
        problem(piece.at, message(error));
      }
      continue;
    }

    // A tag.
    const [word = ''] = piece.body.split(/\s+/);
    const rest = piece.body.slice(word.length).trim();
    const inAttribute = html.state === 'value-dq' || html.state === 'value-sq';

    if (RAW_BLOCKS[word]) {
      const endWord = RAW_BLOCKS[word];
      let m = n + 1;
      for (; m < list.length; m++) {
        const p = list[m];
        if (p?.kind === 'tag' && p.body === endWord) break;
      }
      const closing = list[m];
      if (!closing) {
        problem(piece.at, `{% ${word} %} is never closed with {% ${endWord} %}.`);
        break;
      }
      // Straight from the source: what's inside is not template code.
      const raw = source.slice(source.indexOf('%}', piece.at) + 2, closing.at);
      if (word === 'schema') {
        if (schema) problem(piece.at, 'A section can have only one {% schema %}.');
        if (stack.length) problem(piece.at, '{% schema %} can’t be inside another block.');
        schema = { text: raw, line: where(piece.at).line };
      } else if (word === 'raw') {
        html.feed(raw, piece.at);
        push({ t: 'text', v: raw });
      }
      n = m;
      continue;
    }

    try {
      if (inAttribute && URL_ATTRIBUTES.has(html.attribute)) {
        throw new SyntaxProblem(
          'Put {% if %} or {% for %} around the whole link, not inside its address.',
        );
      }
      switch (word) {
        case 'if':
        case 'unless': {
          const node: Node = {
            t: 'if',
            branches: [{ cond: cond(new Reader(asTokens(rest))), body: [] }],
            else: null,
            ...(word === 'unless' ? { unless: true as const } : {}),
          };
          push(node);
          stack.push({
            tag: word,
            node,
            into: node.branches[0]!.body,
            at: piece.at,
            html: html.snapshot(),
          });
          break;
        }
        case 'elsif':
        case 'else': {
          const frame = stack[stack.length - 1];
          if (!frame) throw new SyntaxProblem(`{% ${word} %} without an {% if %}.`);
          if (html.snapshot() !== frame.html) {
            throw new SyntaxProblem(
              'This branch leaves an HTML tag or attribute open. Close it before the next branch.',
            );
          }
          if (frame.node.t === 'for') {
            if (word === 'elsif')
              throw new SyntaxProblem('{% elsif %} can’t be used in a {% for %}.');
            if (frame.node.else)
              throw new SyntaxProblem('This {% for %} already has an {% else %}.');
            frame.node.else = [];
            frame.into = frame.node.else;
          } else if (word === 'elsif') {
            if (frame.tag === 'unless')
              throw new SyntaxProblem('{% elsif %} can’t be used in an {% unless %}.');
            if (frame.node.else)
              throw new SyntaxProblem('{% elsif %} can’t come after {% else %}.');
            const branch = { cond: cond(new Reader(asTokens(rest))), body: [] as Node[] };
            frame.node.branches.push(branch);
            frame.into = branch.body;
          } else {
            if (frame.node.else) throw new SyntaxProblem('This block already has an {% else %}.');
            frame.node.else = [];
            frame.into = frame.node.else;
          }
          break;
        }
        case 'endif':
        case 'endunless':
        case 'endfor': {
          const frame = stack.pop();
          const opens = word === 'endif' ? 'if' : word === 'endunless' ? 'unless' : 'for';
          if (!frame || frame.tag !== opens) {
            throw new SyntaxProblem(
              frame
                ? `{% ${word} %} closes {% ${frame.tag} %} from line ${where(frame.at).line}; expected {% end${frame.tag} %}.`
                : `{% ${word} %} without an {% ${opens} %}.`,
            );
          }
          if (html.snapshot() !== frame.html) {
            throw new SyntaxProblem(
              'This block leaves an HTML tag or attribute open. Close it inside the block.',
            );
          }
          break;
        }
        case 'for': {
          const r = new Reader(asTokens(rest));
          const name = r.next();
          if (name?.k !== 'id') throw new SyntaxProblem('Write it as {% for post in posts %}.');
          if (!r.isId('in')) throw new SyntaxProblem('Write it as {% for post in posts %}.');
          r.next();
          const listValue = value(r);
          let limit: Expr | null = null;
          let offset: Expr | null = null;
          let reversed = false;
          while (!r.done()) {
            const t = r.next();
            if (t?.k === 'id' && (t.v === 'limit' || t.v === 'offset')) {
              if (!r.isOp(':')) throw new SyntaxProblem(`Write ${t.v}: 3.`);
              r.next();
              const e = expr(r);
              if (t.v === 'limit') limit = e;
              else offset = e;
            } else if (t?.k === 'id' && t.v === 'reversed') reversed = true;
            else if (t?.k === 'op' && t.v === ',') continue;
            else throw new SyntaxProblem(`Unexpected “${t?.v}” in {% for %}.`);
          }
          const node: Node = {
            t: 'for',
            name: name.v,
            list: listValue,
            limit,
            offset,
            reversed,
            body: [],
            else: null,
          };
          push(node);
          stack.push({ tag: 'for', node, into: node.body, at: piece.at, html: html.snapshot() });
          break;
        }
        case 'assign': {
          const m = /^([A-Za-z_][\w-]*)\s*=\s*([\s\S]+)$/.exec(rest);
          if (!m) throw new SyntaxProblem('Write it as {% assign name = value %}.');
          const r = new Reader(asTokens(m[2] ?? ''));
          const v = value(r);
          if (!r.done()) throw new SyntaxProblem(`Unexpected “${r.peek()?.v}”.`);
          push({ t: 'assign', name: m[1] ?? '', v });
          break;
        }
        case 'sections':
          if (inAttribute || html.state !== 'data')
            throw new SyntaxProblem('{% sections %} must be in the page, not inside a tag.');
          facts.sectionsTag = true;
          push({ t: 'sections' });
          break;
        case 'section': {
          const r = new Reader(asTokens(rest));
          const t = r.next();
          if (t?.k !== 'str' || !r.done())
            throw new SyntaxProblem("Write it as {% section 'hero' %}.");
          facts.sections.push(t.v);
          push({ t: 'section', name: t.v, line: where(piece.at).line });
          break;
        }
        case 'render': {
          const r = new Reader(asTokens(rest));
          const t = r.next();
          if (t?.k !== 'str')
            throw new SyntaxProblem("Write it as {% render 'post-card', post: post %}.");
          const args: Record<string, Value> = {};
          while (r.isOp(',')) {
            r.next();
            const key = r.next();
            if (key?.k !== 'id' || !r.isOp(':'))
              throw new SyntaxProblem('Pass values as name: value.');
            r.next();
            args[key.v] = value(r);
          }
          if (!r.done()) throw new SyntaxProblem(`Unexpected “${r.peek()?.v}”.`);
          facts.renders.push(t.v);
          push({ t: 'render', name: t.v, args, line: where(piece.at).line });
          break;
        }
        case 'subscribe_form':
          if (rest)
            throw new SyntaxProblem(
              '{% subscribe_form %} takes nothing; its words come from the signup form.',
            );
          if (html.state !== 'data')
            throw new SyntaxProblem('{% subscribe_form %} must be in the page, not inside a tag.');
          facts.subscribe = true;
          push({ t: 'subscribe' });
          break;
        default:
          throw new SyntaxProblem(
            word.startsWith('end')
              ? `{% ${word} %} closes nothing.`
              : `There is no {% ${word} %} tag.`,
          );
      }
    } catch (error) {
      problem(piece.at, message(error));
    }
  }

  for (const frame of stack.reverse()) {
    problem(frame.at, `{% ${frame.tag} %} is never closed with {% end${frame.tag} %}.`);
  }
  if (html.state !== 'data' && html.state !== 'comment') {
    problem(source.length, 'The file ends inside an HTML tag.');
  }
  for (const p of html.problems) problem(p.offset, p.message);
  facts.headings = html.headings;
  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return { nodes: root, schema, problems, facts };
}

function asTokens(text: string): Tok[] {
  const t = tokens(text);
  if (typeof t === 'string') throw new SyntaxProblem(t);
  return t;
}

function message(error: unknown): string {
  if (error instanceof SyntaxProblem) return error.message;
  throw error;
}

/** Static text before a placeholder in an address must already pin down where it goes. */
function safePrefix(attribute: string, prefix: string): boolean {
  const plain = prefix.trim().toLowerCase();
  if (urlProblem(attribute, prefix)) return false;
  if (attribute === 'src') return plain.startsWith('/') || plain.startsWith('data:image/');
  return /^(https?:\/\/|mailto:|\/(?!\/)|#|\?)/.test(plain);
}
