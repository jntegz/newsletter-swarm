// Fails when product surfaces use competitor or legacy terms, or when old UI words leak back into
// visible dashboard copy, reader pages or the messages the server writes for the dashboard.
// Scope: UI source, public docs, the generated API contract, reader workers and server messages.
// Rules: docs/vocabulary.md (UI words since Nov 2026: design/2026-11/RENAME.md).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const SCAN = ['apps/dashboard/src', 'docs', 'README.md'];
const SKIP_FILES = new Set(['docs/vocabulary.md']);
const EXTENSIONS = /\.(tsx?|jsx?|md|json|html|css)$/;

// Everywhere in SCAN, any case.
export const BANNED = [
  { pattern: /\bboosts?\b/i, use: 'Signals' },
  { pattern: /\bsmart warming\b/i, use: 'Warm-up' },
  { pattern: /\bbeehiiv\b|\bhiiv\b/i, use: 'no competitor names in product surfaces' },
  { pattern: /\bsubstack\b/i, use: 'no competitor names in product surfaces' },
  { pattern: /\brestacks?\b/i, use: 'Relay' },
  { pattern: /\brecommendation network\b/i, use: 'Partner Exchange' },
  { pattern: /\bad network\b/i, use: 'Sponsor Match' },
  { pattern: /\bsubscriber center\b/i, use: 'Subscriber settings' },
  { pattern: /\bcampaigns?\b/i, use: 'post or send' },
  // "tier" only ever meant a paid plan here; a generic use can carry the allow marker.
  { pattern: /\btiers?\b/i, use: 'Paid plan' },
  // The short-post feed, capitalised. Skips the sample publication "Field Notes", table header
  // cells ("| Notes |") and titles like "Notes on …"; lowercase "notes" stays a generic word.
  { pattern: /(?<!Field |\|\s*)\bNotes\b(?!\s*\|| on\b)/, use: 'Commons' },
];

// Dashboard only: old UI words (capitalised, as they were written in copy) inside JSX text or a
// string literal. Code, the database and the API keep these names; visible copy does not.
// Components and the .ts helpers that build labels (nav, flow summaries); tests are skipped.
const DASHBOARD = 'apps/dashboard/src/';
const DASHBOARD_FILES = /(?<!\.test|\.d)\.tsx?$/;
const OLD_UI_WORDS = [
  { word: /Dispatch(?:es)?/, use: 'Post' },
  { word: /Members?/, use: 'Subscriber' },
  { word: /Circles?/, use: 'Segment' },
  { word: /Flows?/, use: 'Automation' },
  { word: /Capture [Ff]orms?/, use: 'Signup form' },
  { word: /Broadcasts?/, use: 'Send / Send report' },
  { word: /Membership [Ll]evels?/, use: 'Paid plan' },
  { word: /Site Studio/, use: 'Website' },
  { word: /Reputation Ramp/, use: 'Warm-up' },
  { word: /Preheader/, use: 'Preview text' },
  { word: /Gift Pass(?:es)?/, use: 'Gift subscription' },
];
// Not part of an identifier, a type, a JSX tag (`<Member`), a path or a property access.
const OLD_UI = new RegExp(
  `(?<![\\w$.<\\/@-])(?:${OLD_UI_WORDS.map(({ word }) => word.source).join('|')})(?![\\w$(\\[/-]|\\.\\w)`,
  'g',
);
// Lines that are code structure, never copy.
const CODE_LINE = /^(?:import\b|export\s+(?:type|interface)\b|type\s|interface\s|\/\/|\/?\*)/;

/** Whether `index` sits in a string literal or in JSX text, judged from this line alone. */
function inCopy(line, index) {
  let quote = null;
  let braces = 0;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
  }
  if (quote) {
    // Words with spaces are copy. A single word is copy only where a label goes; elsewhere it is
    // more likely a key or an enum value ('Member' in a type union).
    const start = line.lastIndexOf(quote, index - 1);
    const literal = line.slice(start + 1, index) + line.slice(index).split(quote)[0];
    return /\s/.test(literal.trim()) || isLabelValue(line.slice(0, start));
  }
  if (braces > 0) return false;
  const before = line.slice(0, index);
  // After a tag's `>` or an expression's `}` on the same line: JSX text.
  if (/(?:^|[^=])>[^<>{}=]*$/.test(before) || /\}[^<>{}=;]*$/.test(before)) return true;
  // A whole line of prose inside JSX.
  return /^\s*[A-Za-z][^=;(){}<>]*$/.test(line) && /[a-z]\s+[a-z]/i.test(line.trim());
}

/**
 * A one-word string is copy when it is a label value (`label: 'Members'`, `title="Members"`) or a
 * branch of a ternary or `??` that picks display text (`n === 1 ? 'Member' : 'Members'`).
 */
function isLabelValue(lead) {
  if (/(?:label|title|placeholder|description|hint|empty|legend|alt)\s*[:=]\s*\{?\s*$/.test(lead)) {
    return true;
  }
  return /(?:\?\??|[^\w$\s]\s*:)\s*$/.test(lead);
}

const ALLOW_MARKER = 'vocabulary-allow';

// Reader-facing workers: the website, the signup and subscriber settings pages, and the
// unsubscribe pages, plus the built-in wording of the emails readers get. Everything a reader sees
// there is a string literal, so every literal that reads as prose (it has a space in it) is checked
// for the internal names. Identifiers, routes, SQL and log lines are lowercase or outside literals,
// so they don't match. Packages that mix reader copy with other strings (packages/mail,
// packages/engine) are not scanned this way; their messages for teammates fall under MESSAGE_SCAN.
const READER_SCAN = [
  'workers/site/src',
  'workers/capture/src',
  'workers/track/src',
  'packages/domain/src/p8-messages.ts',
];
const READER_WORDS = [
  { word: /Member Center/, use: 'Subscriber settings, or "Manage your subscription" on a link' },
  { word: /Membership levels?/, use: 'plan' },
  { word: /Memberships?/, use: 'paid subscription' },
  { word: /Members?/, use: 'subscriber' },
  { word: /Dispatch(?:es)?/, use: 'post' },
  { word: /Channels?/, use: 'the publication' },
  { word: /Gift Pass(?:es)?/, use: 'gift subscription' },
  { word: /Founding Levels?/, use: 'founding plan' },
  { word: /Capture Forms?/, use: 'signup form' },
  { word: /Champions?/, use: 'referrer' },
  { word: /Circles?/, use: 'not a word for readers' },
  { word: /Flows?/, use: 'not a word for readers' },
  { word: /Broadcasts?/, use: 'not a word for readers' },
];
const READER = new RegExp(
  `\\b(?:${READER_WORDS.map(({ word }) => word.source).join('|')})\\b`,
  'g',
);

// Messages the server writes for the person using the dashboard: API errors, pre-send checks,
// render warnings and validation messages. The dashboard shows them as they are, so they use the UI
// words. Only literals in a message position are checked (an argument of a `…Error` constructor or
// of the invalid/fail/requireFlag helpers, a `message` value, a render warning), which leaves SQL,
// log lines, prompts and the OpenAPI summaries and descriptions (developer documentation, where
// the internal names are right) alone.
const MESSAGE_SCAN = [
  'workers/api/src',
  'workers/jobs/src',
  'workers/send/src',
  'workers/events/src',
  'packages/engine/src',
  'packages/mail/src',
  'packages/domain/src',
];
const MESSAGE_WORDS = [
  { word: /Member Center/, use: 'subscriber settings' },
  { word: /Membership [Ll]evels?/, use: 'paid plan' },
  { word: /Founding Levels?/, use: 'founding plan' },
  { word: /Members?/, use: 'subscriber' },
  { word: /Dispatch(?:es)?/, use: 'post' },
  { word: /Channels?/, use: 'publication' },
  { word: /Circles?/, use: 'segment' },
  { word: /Flows?/, use: 'automation' },
  { word: /Broadcasts?/, use: 'send' },
  { word: /Capture [Ff]orms?/, use: 'signup form' },
  { word: /Gates?/, use: 'paywall' },
  { word: /Gift Pass(?:es)?/, use: 'gift subscription' },
  { word: /Reputation Ramps?/, use: 'warm-up' },
  { word: /Preheaders?/, use: 'preview text' },
  { word: /Site Studio/, use: 'website' },
  { word: /Split Tests?/, use: 'split test' },
  { word: /Cohort Sampl(?:e|es|ing)/, use: 'cohort sample' },
  { word: /Smart Blocks?/, use: 'Smart block' },
  { word: /Champions?/, use: 'referrals, referrer' },
  { word: /QuickPass/, use: 'sign-in link' },
];
const MESSAGE = new RegExp(
  `\\b(?:${MESSAGE_WORDS.map(({ word }) => word.source).join('|')})\\b`,
  'g',
);
// The code just before a literal that makes it a message. `new Error(` is left out: those are
// internal failures that end up in logs, not in a response.
const MESSAGE_CONTEXT = new RegExp(
  [
    /\bnew \w+Error\(\s*(?:'[a-z_]+',\s*)?$/,
    /\bmessage\s*(?::|=(?!=))[^;{}]*$/,
    /\b(?:invalid|fail|requireFlag)\((?:[^()]|\([^()]*\))*,\s*$/,
    /\bwarnings\.(?:add|push)\(\s*$/,
    /\bproblem = $/,
  ]
    .map((re) => re.source)
    .join('|'),
);
const SCHEMA_DOC = /\.(?:describe|openapi)\(/;

/**
 * The string literals of a TypeScript source, as `{ line, text }`: quoted strings and the text
 * parts of template literals, without comments, regular expressions or `${...}` expressions.
 */
export function stringLiterals(source) {
  return scanLiterals(source).map(({ line, text }) => ({ line, text }));
}

/** As stringLiterals, with `open`: where the literal starts (the same for every part of a template). */
function scanLiterals(source) {
  const out = [];
  const length = source.length;
  const stack = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  const template = (open) => {
    const start = line;
    let text = '';
    while (i < length) {
      const c = source[i];
      if (c === '\\') {
        text += source[i + 1] ?? '';
        i += 2;
      } else if (c === '`') {
        i++;
        break;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        stack.push([depth, open]);
        depth = 0;
        break;
      } else {
        if (c === '\n') line++;
        text += c;
        i++;
      }
    }
    out.push({ line: start, text, open });
  };
  while (i < length) {
    const c = source[i];
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < length && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"') {
      const open = i;
      let text = '';
      i++;
      while (i < length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        text += source[i] ?? '';
        i++;
      }
      i++;
      out.push({ line, text, open });
    } else if (c === '`') {
      i++;
      template(i - 1);
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      i++;
      if (depth === 0 && stack.length) {
        const [outer, open] = stack.pop();
        depth = outer;
        template(open);
      } else depth--;
    } else if (
      c === '/' &&
      /(?:^|[(,=:[!&|?{};\n]|\breturn)\s*$/.test(source.slice(Math.max(0, i - 12), i))
    ) {
      // A regular expression: skip to its closing slash so a quote inside it opens nothing.
      let inClass = false;
      i++;
      while (i < length && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        i++;
      }
      i++;
    } else i++;
  }
  return out;
}

/** Internal names in the prose literals of a reader-facing source, as `{ line, problem }`. */
export function readerProblems(source) {
  const lines = source.split(/\r?\n/);
  const problems = [];
  for (const { line, text } of stringLiterals(source)) {
    if (!/\s/.test(text.trim())) continue;
    if (lines[line - 1]?.includes(ALLOW_MARKER)) continue;
    for (const match of text.matchAll(READER)) {
      const { use } = READER_WORDS.find(({ word }) =>
        new RegExp(`^${word.source}$`).test(match[0]),
      );
      problems.push({ line, problem: `"${match[0]}" → ${use} (readers see this)` });
    }
  }
  return problems;
}

/** Internal names in the messages a server source writes for teammates, as `{ line, problem }`. */
export function messageProblems(source) {
  const lines = source.split(/\r?\n/);
  const problems = [];
  const isMessage = new Map();
  for (const { line, text, open } of scanLiterals(source)) {
    if (!isMessage.has(open)) {
      const lead = source.slice(Math.max(0, open - 120), open).replace(/\s+/g, ' ');
      isMessage.set(open, MESSAGE_CONTEXT.test(lead) && !SCHEMA_DOC.test(lead.slice(-60)));
    }
    if (!isMessage.get(open) || !/\s/.test(text.trim())) continue;
    if (lines[line - 1]?.includes(ALLOW_MARKER)) continue;
    for (const match of text.matchAll(MESSAGE)) {
      const { use } = MESSAGE_WORDS.find(({ word }) =>
        new RegExp(`^${word.source}$`).test(match[0]),
      );
      problems.push({ line, problem: `"${match[0]}" → ${use} (the dashboard shows this message)` });
    }
  }
  return problems;
}

// Line has no uppercase micro labels (DESIGN.md): headings over tables and groups use `.table-head`
// in sentence case. Checked in the dashboard's components and the shared ones it uses, tests
// skipped. A typed code shown in capitals (a currency code in its input) carries the marker on its
// own line or the line before, with the reason.
const UPPERCASE_SCAN = ['apps/dashboard/src', 'packages/ui/src/components'];
const UPPERCASE_FILES = /(?<!\.test)\.tsx$/;
const UPPERCASE = /(?<![\w-])uppercase(?![\w-])|text-?transform\W+uppercase/i;
const UPPERCASE_ALLOW = 'uppercase-allow';

/** Whether a line of a component sets text in capitals, given the line before it. */
export function uppercaseProblem(line, previous = '') {
  if (line.includes(UPPERCASE_ALLOW) || previous.includes(UPPERCASE_ALLOW)) return null;
  if (/^(?:\/\/|\/?\*)/.test(line.trim())) return null;
  return UPPERCASE.test(line)
    ? 'uppercase text → sentence case; `.table-head` for headings (no uppercase micro labels)'
    : null;
}

/** The banned terms on one line, as `"match" → replacement` (empty when the line is fine). */
export function lineProblems(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  return BANNED.flatMap(({ pattern, use }) => {
    const match = line.match(pattern);
    return match ? [`"${match[0]}" → ${use}`] : [];
  });
}

function* walk(path) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return;
  if (stats.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    yield* walk(join(path, entry));
  }
}

function main() {
  const problems = [];
  for (const target of SCAN) {
    for (const file of walk(join(ROOT, target))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (SKIP_FILES.has(rel) || !EXTENSIONS.test(rel)) continue;
      const dashboardCopy = rel.startsWith(DASHBOARD) && DASHBOARD_FILES.test(rel);
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          for (const problem of lineProblems(line))
            problems.push(`${rel}:${index + 1}  ${problem}`);
          if (line.includes(ALLOW_MARKER)) return;
          if (!dashboardCopy || CODE_LINE.test(line.trim())) return;
          for (const match of line.matchAll(OLD_UI)) {
            if (!inCopy(line, match.index)) continue;
            const { use } = OLD_UI_WORDS.find(({ word }) =>
              new RegExp(`^${word.source}$`).test(match[0]),
            );
            problems.push(`${rel}:${index + 1}  "${match[0]}" → ${use} (old UI word)`);
          }
        });
    }
  }

  for (const target of READER_SCAN) {
    for (const file of walk(join(ROOT, target))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (!/(?<!\.test|\.d)\.ts$/.test(rel)) continue;
      for (const { line, problem } of readerProblems(readFileSync(file, 'utf8'))) {
        problems.push(`${rel}:${line}  ${problem}`);
      }
    }
  }

  for (const target of MESSAGE_SCAN) {
    for (const file of walk(join(ROOT, target))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (!/(?<!\.test|\.d)\.ts$/.test(rel) || READER_SCAN.includes(rel)) continue;
      for (const { line, problem } of messageProblems(readFileSync(file, 'utf8'))) {
        problems.push(`${rel}:${line}  ${problem}`);
      }
    }
  }

  for (const target of UPPERCASE_SCAN) {
    for (const file of walk(join(ROOT, target))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (!UPPERCASE_FILES.test(rel)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const problem = uppercaseProblem(line, lines[index - 1]);
        if (problem) problems.push(`${rel}:${index + 1}  ${problem}`);
      });
    }
  }

  if (problems.length > 0) {
    console.error(`Vocabulary check failed (${problems.length}):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('Vocabulary check passed.');
}

// Run as a script; the tests import the rules.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
