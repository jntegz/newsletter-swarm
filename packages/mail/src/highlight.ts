/**
 * Syntax highlighting for code blocks (the code_embeds flag): a small tokenizer with no
 * dependencies, no WASM and no regular expression that can backtrack badly, so it runs the same
 * in a Worker and in the dashboard editor.
 *
 * It is deliberately approximate: one pass of sticky patterns per language (comments, strings,
 * numbers, words, operators), with words classified as keywords, literals, types or function
 * calls. It never changes the text: the tokens always join back to the input exactly.
 *
 * Three outputs share it:
 * - email: `<span>`s with inline colours (mail clients drop most stylesheets) plus a class the
 *   email's dark-mode rules override (`emailCodeDarkCss`);
 * - the website: `<span>`s with classes only (the site CSP allows no inline styles), coloured by
 *   `codeTokenCss` in the site stylesheet;
 * - the editor: the same classes as decorations.
 */

type TokenKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'literal'
  | 'property'
  | 'tag'
  | 'attribute'
  | 'meta'
  | 'inserted'
  | 'deleted'
  | 'operator';

interface CodeToken {
  text: string;
  /** null for plain text (identifiers, punctuation, whitespace). */
  kind: TokenKind | null;
}

/** The languages the picker offers, in display order. `null` is plain text. */
export const CODE_LANGUAGES = [
  { id: 'bash', label: 'Bash' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'css', label: 'CSS' },
  { id: 'diff', label: 'Diff' },
  { id: 'go', label: 'Go' },
  { id: 'html', label: 'HTML' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'swift', label: 'Swift' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'xml', label: 'XML' },
  { id: 'yaml', label: 'YAML' },
] as const;

type CodeLanguage = (typeof CODE_LANGUAGES)[number]['id'];

const ALIASES: Record<string, CodeLanguage> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  h: 'c',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  patch: 'diff',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  kt: 'kotlin',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  svg: 'xml',
  yml: 'yaml',
};

const KNOWN = new Set<string>(CODE_LANGUAGES.map((l) => l.id));

/** The canonical language id for an editor value or alias, or null for plain text. */
export function normalizeLanguage(value: unknown): CodeLanguage | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (KNOWN.has(key)) return key as CodeLanguage;
  // Own aliases only: a block's language "constructor" must not find Object.prototype's.
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? null) : null;
}

/** Longer code is shown plain: highlighting it would bloat an email past Gmail's clip limit. */
export const HIGHLIGHT_MAX_CHARS = 20_000;

// ---- Grammars ----------------------------------------------------------------------------

type Classify = (word: string, rest: string) => TokenKind | null;

interface Rule {
  re: RegExp;
  kind: TokenKind | null | Classify;
}

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const DQ = /"(?:[^"\\\n]|\\.)*"?/y;
const SQ = /'(?:[^'\\\n]|\\.)*'?/y;
const BACKTICK = /`(?:[^`\\]|\\[\s\S])*`?/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const SLASH_COMMENT = /\/\/[^\n]*/y;
const HASH_COMMENT = /#[^\n]*/y;
const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+)[a-zA-Z]*/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const OPERATOR = /[+\-*/%=&|^!<>?:~]+/y;
const SPACE = /\s+/y;

interface WordSets {
  keywords: Set<string>;
  literals?: Set<string>;
  types?: Set<string>;
  /** Words starting with a capital are types (Java, C#, Rust, Swift…). */
  capitalTypes?: boolean;
  caseInsensitive?: boolean;
}

function classifier(sets: WordSets): Classify {
  return (word, rest) => {
    const key = sets.caseInsensitive ? word.toLowerCase() : word;
    if (sets.keywords.has(key)) return 'keyword';
    if (sets.literals?.has(key)) return 'literal';
    if (sets.types?.has(key)) return 'type';
    if (/^\s*\(/.test(rest)) return 'function';
    if (sets.capitalTypes && /^[A-Z][a-z0-9]/.test(word)) return 'type';
    return null;
  };
}

function grammar(options: WordSets & { comments: RegExp[]; strings: RegExp[]; extra?: Rule[] }) {
  return [
    { re: SPACE, kind: null },
    ...options.comments.map((re) => ({ re, kind: 'comment' as const })),
    ...(options.extra ?? []),
    ...options.strings.map((re) => ({ re, kind: 'string' as const })),
    { re: NUMBER, kind: 'number' as const },
    { re: WORD, kind: classifier(options) },
    { re: OPERATOR, kind: 'operator' as const },
  ] satisfies Rule[];
}

const C_LITERALS = words('true false null NULL nullptr');
const JS_KEYWORDS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
);
const JS_LITERALS = words('true false null undefined NaN Infinity');
const JS_TYPES = words('any boolean never number object string symbol unknown bigint');
const DECORATOR: Rule = { re: /@[A-Za-z_][\w.]*/y, kind: 'meta' };

const javascript = grammar({
  keywords: JS_KEYWORDS,
  literals: JS_LITERALS,
  types: JS_TYPES,
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [DQ, SQ, BACKTICK],
  extra: [DECORATOR],
});

const python = grammar({
  keywords: words(
    'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield',
  ),
  literals: words('True False None'),
  types: words('int float str bool list dict set tuple bytes object'),
  comments: [HASH_COMMENT],
  strings: [
    /[rRbBfFuU]{0,2}"""[\s\S]*?(?:"""|$)/y,
    /[rRbBfFuU]{0,2}'''[\s\S]*?(?:'''|$)/y,
    /[rRbBfFuU]{1,2}"(?:[^"\\\n]|\\.)*"?/y,
    /[rRbBfFuU]{1,2}'(?:[^'\\\n]|\\.)*'?/y,
    DQ,
    SQ,
  ],
  extra: [DECORATOR],
});

const bash = grammar({
  keywords: words(
    'if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit break continue select time',
  ),
  literals: words('true false'),
  // `#` starts a comment only where a word could start, so `a#b` and `${#x}` are not comments.
  comments: [/(?<![\w$#{}])#[^\n]*/y],
  strings: [DQ, /'[^']*'?/y],
  extra: [{ re: /\$\{[^}\n]*\}?|\$[\w@#?$!*-]/y, kind: 'property' }],
});

const c = grammar({
  keywords: words(
    'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while',
  ),
  literals: C_LITERALS,
  types: words(
    'bool char double float int long short signed unsigned void size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t',
  ),
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [DQ, SQ],
  extra: [{ re: /#[ \t]*[a-z]+/y, kind: 'meta' }],
});

const cpp = grammar({
  keywords: words(
    'alignas alignof auto break case catch class const constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept operator private protected public reinterpret_cast return sizeof static static_assert static_cast struct switch template this throw try typedef typeid typename union using virtual volatile while co_await co_return co_yield concept requires',
  ),
  literals: C_LITERALS,
  types: words(
    'bool char char16_t char32_t double float int long short signed unsigned void wchar_t size_t string vector',
  ),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [DQ, SQ],
  extra: [{ re: /#[ \t]*[a-z]+/y, kind: 'meta' }],
});

const csharp = grammar({
  keywords: words(
    'abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using var virtual void volatile while yield get set init',
  ),
  literals: words('true false null'),
  types: words(
    'bool byte char decimal double dynamic float int long object sbyte short string uint ulong ushort',
  ),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [/[@$]{1,2}"(?:[^"\\]|\\.|"")*"?/y, DQ, SQ],
  extra: [{ re: /#[ \t]*[a-z]+/y, kind: 'meta' }],
});

const go = grammar({
  keywords: words(
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  ),
  literals: words('true false nil iota'),
  types: words(
    'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any',
  ),
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [DQ, SQ, /`[^`]*`?/y],
});

const java = grammar({
  keywords: words(
    'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record return sealed permits static strictfp super switch synchronized this throw throws transient try var void volatile while yield',
  ),
  literals: words('true false null'),
  types: words('boolean byte char double float int long short'),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [/"""[\s\S]*?(?:"""|$)/y, DQ, SQ],
  extra: [DECORATOR],
});

const kotlin = grammar({
  keywords: words(
    'as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor companion data enum final finally get import init inline internal lateinit open operator out override private protected public sealed set suspend vararg',
  ),
  literals: words('true false null'),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [/"""[\s\S]*?(?:"""|$)/y, DQ, SQ],
  extra: [DECORATOR],
});

const php = grammar({
  keywords: words(
    'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
  ),
  literals: words('true false null TRUE FALSE NULL'),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT, /(?<![\w$])#[^\n]*/y],
  strings: [DQ, SQ],
  extra: [
    { re: /<\?(?:php|=)?|\?>/y, kind: 'meta' },
    { re: /\$[A-Za-z_]\w*/y, kind: 'property' },
  ],
});

const ruby = grammar({
  keywords: words(
    'alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer private protected public',
  ),
  literals: words('true false nil'),
  capitalTypes: true,
  comments: [HASH_COMMENT],
  strings: [DQ, SQ],
  extra: [
    { re: /:[A-Za-z_]\w*[?!]?/y, kind: 'literal' },
    { re: /@{1,2}[A-Za-z_]\w*/y, kind: 'property' },
  ],
});

const rust = grammar({
  keywords: words(
    'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  ),
  literals: words('true false None Some Ok Err'),
  types: words(
    'bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box',
  ),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  // A lone quote is a lifetime ('a), not a character literal.
  strings: [DQ, /'(?:[^'\\\n]|\\.[^'\n]*)'/y],
  extra: [
    { re: /#!?\[[^\]\n]*\]?/y, kind: 'meta' },
    { re: /[A-Za-z_]\w*!/y, kind: 'function' },
  ],
});

const swift = grammar({
  keywords: words(
    'as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var where while async await some any',
  ),
  literals: words('true false nil'),
  capitalTypes: true,
  comments: [SLASH_COMMENT, BLOCK_COMMENT],
  strings: [/"""[\s\S]*?(?:"""|$)/y, DQ],
  extra: [DECORATOR],
});

const sql = grammar({
  keywords: words(
    'add all alter and as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction trigger union unique update using values view when where with',
  ),
  literals: words('true false null'),
  types: words(
    'int integer bigint smallint text varchar char boolean real float double numeric decimal date time timestamp blob json',
  ),
  caseInsensitive: true,
  comments: [/--[^\n]*/y, BLOCK_COMMENT],
  strings: [/'(?:[^']|'')*'?/y, /"[^"\n]*"?/y],
});

const css: Rule[] = [
  { re: SPACE, kind: null },
  { re: BLOCK_COMMENT, kind: 'comment' },
  { re: DQ, kind: 'string' },
  { re: SQ, kind: 'string' },
  { re: /@[\w-]+/y, kind: 'keyword' },
  { re: /#[\da-fA-F]{3,8}(?![\w-])/y, kind: 'number' },
  { re: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, kind: 'number' },
  { re: /[.#][A-Za-z_-][\w-]*/y, kind: 'type' },
  { re: /--?[A-Za-z_][\w-]*(?=\s*:)|[A-Za-z_][\w-]*(?=\s*:[^:])/y, kind: 'property' },
  { re: /!important/y, kind: 'keyword' },
  { re: /[A-Za-z_-][\w-]*(?=\()/y, kind: 'function' },
  { re: /[A-Za-z_-][\w-]*/y, kind: null },
];

const json: Rule[] = [
  { re: SPACE, kind: null },
  { re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, kind: 'property' },
  { re: DQ, kind: 'string' },
  { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, kind: 'number' },
  { re: /true|false|null/y, kind: 'literal' },
];

const yaml: Rule[] = [
  { re: SPACE, kind: null },
  { re: /(?<![^\s])#[^\n]*/y, kind: 'comment' },
  { re: /(?<=^|\n)[ \t]*-?[ \t]*[\w.$/-][\w .$/-]*(?=:(?:\s|$))/y, kind: 'property' },
  { re: DQ, kind: 'string' },
  { re: /'(?:[^']|'')*'?/y, kind: 'string' },
  { re: /(?:true|false|null|yes|no|on|off|~)(?![\w-])/y, kind: 'literal' },
  { re: /-?\d+(?:\.\d+)?(?![\w-])/y, kind: 'number' },
  { re: /[&*][\w-]+|!![\w]+|---|\.\.\./y, kind: 'meta' },
  { re: /[A-Za-z_][\w-]*/y, kind: null },
];

const GRAMMARS: Partial<Record<CodeLanguage, Rule[]>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  kotlin,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript: javascript,
  yaml,
};

// ---- Tokenizers --------------------------------------------------------------------------

function push(out: CodeToken[], text: string, kind: TokenKind | null): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

function runRules(code: string, rules: readonly Rule[]): CodeToken[] {
  const out: CodeToken[] = [];
  let pos = 0;
  outer: while (pos < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = pos;
      const match = rule.re.exec(code);
      if (!match || match[0].length === 0) continue;
      const text = match[0];
      const kind =
        typeof rule.kind === 'function'
          ? rule.kind(text, code.slice(pos + text.length, pos + text.length + 4))
          : rule.kind;
      push(out, text, kind);
      pos += text.length;
      continue outer;
    }
    push(out, code[pos] as string, null);
    pos += 1;
  }
  return out;
}

/** HTML and XML: a small state machine, since attributes only mean something inside a tag. */
function markup(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  let pos = 0;
  const at = (re: RegExp) => {
    re.lastIndex = pos;
    return re.exec(code)?.[0] ?? null;
  };
  while (pos < code.length) {
    const comment = at(/<!--[\s\S]*?(?:-->|$)/y);
    const meta = comment ? null : at(/<![^>]*>?|<\?[\s\S]*?(?:\?>|$)/y);
    if (comment || meta) {
      push(out, (comment ?? meta) as string, comment ? 'comment' : 'meta');
      pos += ((comment ?? meta) as string).length;
      continue;
    }
    const open = at(/<\/?[A-Za-z][\w:.-]*/y);
    if (!open) {
      const text = at(/[^<]+/y) ?? (code[pos] as string);
      push(out, text, null);
      pos += text.length;
      continue;
    }
    push(out, open, 'tag');
    pos += open.length;
    // Inside the tag until `>`.
    while (pos < code.length) {
      const close = at(/\/?>/y);
      if (close) {
        push(out, close, 'tag');
        pos += close.length;
        break;
      }
      const piece =
        at(/\s+/y) ??
        at(/"[^"]*"?|'[^']*'?/y) ??
        at(/[^\s"'=<>/]+/y) ??
        at(/[=/]/y) ??
        (code[pos] === '<' ? null : (code[pos] as string));
      if (piece === null) break;
      const kind = /^["']/.test(piece) ? 'string' : /^[^\s=/]/.test(piece) ? 'attribute' : null;
      push(out, piece, kind);
      pos += piece.length;
    }
  }
  return out;
}

function diff(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  for (const line of code.split(/(?<=\n)/)) {
    const kind: TokenKind | null = /^(?:\+\+\+|---|diff |index |@@)/.test(line)
      ? 'meta'
      : line.startsWith('+')
        ? 'inserted'
        : line.startsWith('-')
          ? 'deleted'
          : null;
    // The newline is plain, so a coloured line never bleeds into the next.
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    push(out, body, kind);
    if (body !== line) push(out, '\n', null);
  }
  return out;
}

/**
 * Splits code into tokens for a language (canonical id or alias). Unknown languages, plain
 * text and code over HIGHLIGHT_MAX_CHARS come back as one plain token.
 */
export function tokenize(code: string, language: unknown): CodeToken[] {
  if (!code) return [];
  const lang = normalizeLanguage(language);
  if (!lang || code.length > HIGHLIGHT_MAX_CHARS) return [{ text: code, kind: null }];
  if (lang === 'html' || lang === 'xml') return markup(code);
  if (lang === 'diff') return diff(code);
  const rules = GRAMMARS[lang];
  return rules ? runRules(code, rules) : [{ text: code, kind: null }];
}

// ---- Output ------------------------------------------------------------------------------

/** The class a token kind carries in email, on the website and in the editor. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: 'sw-tk-kw',
  string: 'sw-tk-str',
  comment: 'sw-tk-com',
  number: 'sw-tk-num',
  function: 'sw-tk-fn',
  type: 'sw-tk-type',
  literal: 'sw-tk-lit',
  property: 'sw-tk-prop',
  tag: 'sw-tk-tag',
  attribute: 'sw-tk-attr',
  meta: 'sw-tk-meta',
  inserted: 'sw-tk-ins',
  deleted: 'sw-tk-del',
  operator: 'sw-tk-op',
};

/**
 * Token colours. Light colours are at least 4.5:1 on the code background `#f6f5fb`; dark ones on
 * `#1b1a24`. Comments are also italic, and diff lines are also prefixed, so colour is never the
 * only signal.
 */
const CODE_THEME = {
  light: {
    background: '#f6f5fb',
    text: '#0f0f12',
    tokens: {
      keyword: '#5636e8',
      string: '#1a6b43',
      comment: '#64646e',
      number: '#a23a1c',
      function: '#1d5a9e',
      type: '#7a4400',
      literal: '#a23a1c',
      property: '#1d5a9e',
      tag: '#5636e8',
      attribute: '#7a4400',
      meta: '#64646e',
      inserted: '#1a6b43',
      deleted: '#a23a1c',
      operator: '#3a3a44',
    },
  },
  dark: {
    background: '#1b1a24',
    text: '#e8e6f0',
    tokens: {
      keyword: '#b9a8ff',
      string: '#7ee0b8',
      comment: '#a2a2ad',
      number: '#ffb38a',
      function: '#7cc7ff',
      type: '#ffcf6b',
      literal: '#ffb38a',
      property: '#7cc7ff',
      tag: '#b9a8ff',
      attribute: '#ffcf6b',
      meta: '#a2a2ad',
      inserted: '#7ee0b8',
      deleted: '#ff9e9e',
      operator: '#cfcbe0',
    },
  },
} as const satisfies Record<
  'light' | 'dark',
  { background: string; text: string; tokens: Record<TokenKind, string> }
>;

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Highlighted, escaped HTML for an email: inline colours plus the class dark mode overrides.
 * `scheme` 'dark' is for an email whose card is dark by design, in every colour scheme.
 */
export function highlightEmail(
  code: string,
  language: unknown,
  scheme: 'light' | 'dark' = 'light',
): string {
  return tokenize(code, language)
    .map(({ text, kind }) => {
      if (!kind) return escape(text);
      const italic = kind === 'comment' ? ';font-style:italic' : '';
      return `<span class="${TOKEN_CLASS[kind]}" style="color:${CODE_THEME[scheme].tokens[kind]}${italic}">${escape(text)}</span>`;
    })
    .join('');
}

/** Highlighted, escaped HTML for the website: classes only (no inline styles under the CSP). */
export function highlightWeb(code: string, language: unknown): string {
  return tokenize(code, language)
    .map(({ text, kind }) =>
      kind ? `<span class="${TOKEN_CLASS[kind]}">${escape(text)}</span>` : escape(text),
    )
    .join('');
}

/** Token colour rules for a scheme, every selector prefixed with `prefix` (e.g. `.sw-prose `). */
export function codeTokenCss(scheme: 'light' | 'dark', prefix = '', important = false): string {
  const bang = important ? '!important' : '';
  return (Object.keys(TOKEN_CLASS) as TokenKind[])
    .map(
      (kind) => `${prefix}.${TOKEN_CLASS[kind]}{color:${CODE_THEME[scheme].tokens[kind]}${bang}}`,
    )
    .join('');
}

/** The email's dark-mode rules for highlighted code, for its `<style>` element. */
export function emailCodeDarkCss(): string {
  const { background, text } = CODE_THEME.dark;
  return `@media (prefers-color-scheme:dark){.sw-code{background:${background}!important;color:${text}!important}${codeTokenCss('dark', '', true)}}`;
}
