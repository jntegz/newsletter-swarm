import { describe, expect, it } from 'vitest';
import {
  CODE_LANGUAGES,
  HIGHLIGHT_MAX_CHARS,
  highlightEmail,
  highlightWeb,
  normalizeLanguage,
  personalize,
  renderDispatch,
  RenderError,
  renderWeb,
  tokenize,
  type RenderOptions,
  type WebRenderOptions,
} from '../src/index';

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const heading = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const code = (value: string, language?: string) => ({
  type: 'codeBlock',
  attrs: { language: language ?? null },
  content: [text(value)],
});
const toc = (title?: string) => ({ type: 'tableOfContents', attrs: title ? { title } : {} });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

const email: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: false,
  codeEmbeds: true,
};
const web: WebRenderOptions = {
  channelName: 'Field Notes',
  media: () => null,
  allowHtmlBlocks: false,
  codeEmbeds: true,
};

describe('tokenize', () => {
  it('always joins back to the exact input, in every language', () => {
    const samples = [
      'const a = `x ${y}`; // done\n/* block */ let n = 0x1f + 2.5e3;',
      'def f(x):\n    """doc"""\n    return x  # comment\n@dec\nclass A: pass',
      'echo "$HOME" ${#x} a#b # tail\nif [ -f x ]; then fi',
      '<div class="a" data-x=\'1\'>text & <b>bold</b><!-- c --></div>',
      "SELECT * FROM t WHERE a = 'it''s' -- note",
      '{"a": [1, true, null, "s"]}',
      'key: value # c\nlist:\n  - "x"\n  - 3',
      '@@ -1 +1 @@\n-old\n+new\n same',
      'fn main() { let s: &\'a str = "x"; println!("{}", s); }',
      'unterminated "string\nnext line',
      '',
    ];
    for (const language of [...CODE_LANGUAGES.map((l) => l.id), null, 'nope']) {
      for (const sample of samples) {
        const tokens = tokenize(sample, language);
        expect(tokens.map((t) => t.text).join('')).toBe(sample);
      }
    }
  });

  it('classifies keywords, strings, comments, numbers and calls', () => {
    const tokens = tokenize('const x = run("a", 42); // hi', 'ts');
    const kind = (t: string) => tokens.find((token) => token.text === t)?.kind;
    expect(kind('const')).toBe('keyword');
    expect(kind('run')).toBe('function');
    expect(kind('"a"')).toBe('string');
    expect(kind('42')).toBe('number');
    expect(kind('// hi')).toBe('comment');
  });

  it('keeps attributes inside tags only, for markup', () => {
    const tokens = tokenize('<a href="x">a=b</a>', 'html');
    expect(tokens.find((t) => t.text === 'href')?.kind).toBe('attribute');
    expect(tokens.find((t) => t.text === '"x"')?.kind).toBe('string');
    expect(tokens.find((t) => t.text.includes('a=b'))?.kind).toBeNull();
  });

  it('marks diff lines', () => {
    const tokens = tokenize('-old\n+new', 'diff');
    expect(tokens).toEqual([
      { text: '-old', kind: 'deleted' },
      { text: '\n', kind: null },
      { text: '+new', kind: 'inserted' },
    ]);
  });

  it('normalises aliases and leaves unknown languages plain', () => {
    expect(normalizeLanguage('JS')).toBe('javascript');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('brainfuck')).toBeNull();
    // Not Object.prototype's names either: the language comes from the post's content.
    expect(normalizeLanguage('constructor')).toBeNull();
    expect(normalizeLanguage('__proto__')).toBeNull();
    expect(tokenize('let x', 'brainfuck')).toEqual([{ text: 'let x', kind: null }]);
  });

  it('leaves very long code plain', () => {
    const long = 'let a = 1;\n'.repeat(HIGHLIGHT_MAX_CHARS / 10);
    expect(tokenize(long, 'js')).toEqual([{ text: long, kind: null }]);
  });

  it('is fast on pathological input', () => {
    const start = Date.now();
    tokenize('"'.repeat(5000) + '/*'.repeat(3000) + '\\'.repeat(5000), 'javascript');
    tokenize('<'.repeat(10_000) + 'a '.repeat(4000), 'html');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('highlight output', () => {
  it('escapes everything, in email and on the web', () => {
    const html = highlightEmail('if (a < b) "<script>"', 'js');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('style="color:#');
    const site = highlightWeb('"<img onerror=x>"', 'js');
    expect(site).toBe('<span class="sw-tk-str">&quot;&lt;img onerror=x&gt;&quot;</span>');
    expect(site).not.toContain('style=');
  });
});

describe('code blocks and tables of contents in email', () => {
  it('highlights with inline styles and dark-mode rules, without script', () => {
    const out = renderDispatch(doc(code('const a = 1;', 'javascript')), email);
    expect(out.html).toContain('class="sw-tk-kw" style="color:#5636e8"');
    expect(out.html).toMatch(/<style>@media \(prefers-color-scheme:dark\)\{\.sw-code\{/);
    expect(out.html).not.toMatch(/<script/i);
    expect(out.text).toContain('const a = 1;');
  });

  it('renders code plainly without the flag', () => {
    const out = renderDispatch(doc(code('const a = 1;', 'javascript')), {
      ...email,
      codeEmbeds: false,
    });
    expect(out.html).not.toContain('sw-tk-');
    expect(out.html).not.toContain('.sw-code{');
    expect(out.html).toContain('const a = 1;');
  });

  it('lists the top-level headings as plain text', () => {
    const out = renderDispatch(
      doc(toc(), heading(2, 'Intro'), para('x'), heading(3, 'Detail <b>'), para('y')),
      email,
    );
    expect(out.html).toContain('<table class="sw-toc sw-line" role="presentation"');
    expect(out.html).toContain('>Intro</li>');
    expect(out.html).toContain('Detail &lt;b&gt;');
    expect(/<table class="sw-toc[^]*?<\/table>/.exec(out.html)?.[0]).not.toContain('<a ');
    expect(out.text).toContain('Contents\n- Intro\n  - Detail <b>');
  });

  it('refuses the block without the flag, and when nested', () => {
    expect(() =>
      renderDispatch(doc(toc(), heading(2, 'A')), { ...email, codeEmbeds: false }),
    ).toThrow(RenderError);
    expect(() => renderDispatch(doc({ type: 'blockquote', content: [toc()] }), email)).toThrow(
      /between blocks/,
    );
  });

  it('lists only the free part in a paid teaser', () => {
    const out = renderDispatch(
      doc(toc(), heading(2, 'Free'), { type: 'gate' }, heading(2, 'Paid')),
      { ...email, webVisibility: 'paid', webUrl: 'https://x.example/p/a' },
    );
    expect(out.html).toContain('Free');
    expect(out.html).not.toContain('Paid</li>');
  });

  it('survives personalisation unchanged', () => {
    const out = renderDispatch(doc(code('x = 1', 'python')), email);
    const sent = personalize(
      { html: out.html, text: out.text, subject: 's' },
      {
        link: () => '#',
        unsubscribeUrl: 'https://u.example',
        pixelUrl: null,
        member: { email: 'a@b.example' },
      },
    );
    expect(sent.html).toContain('sw-tk-num');
  });
});

describe('code blocks and tables of contents on the web', () => {
  it('highlights with classes only and anchors headings', () => {
    const out = renderWeb(
      doc(
        toc('On this page'),
        heading(2, 'Getting started'),
        code('SELECT 1', 'sql'),
        heading(2, 'Getting started'),
      ),
      web,
    );
    expect(out.freeHtml).toContain('<h3 id="getting-started">');
    expect(out.freeHtml).toContain('<h3 id="getting-started-2">');
    expect(out.freeHtml).toContain(
      '<code class="language-sql"><span class="sw-tk-kw">SELECT</span>',
    );
    expect(out.freeHtml).toContain(
      '<nav class="sw-toc" aria-label="On this page"><p class="sw-toc-title">On this page</p><ol><li class="sw-toc-l2"><a href="#getting-started">Getting started</a></li>',
    );
    expect(out.freeHtml).not.toContain('style=');
    // The list is navigation, not content: it stays out of the excerpt and search text.
    expect(out.text).not.toContain('On this page');
  });

  it('never lists gated headings in the free part', () => {
    const out = renderWeb(
      doc(toc(), heading(2, 'Free'), { type: 'gate' }, toc(), heading(2, 'Paid')),
      web,
    );
    expect(out.freeHtml).not.toContain('Paid');
    expect(out.gatedHtml).toContain('href="#paid"');
    expect(out.gatedHtml).toContain('href="#free"');
  });

  it('leaves the block out and code plain without the flag', () => {
    const out = renderWeb(doc(toc(), heading(2, 'A'), code('let a', 'js')), {
      ...web,
      codeEmbeds: false,
    });
    expect(out.freeHtml).not.toContain('sw-toc');
    expect(out.freeHtml).not.toContain('id=');
    expect(out.freeHtml).not.toContain('sw-tk-');
    expect(out.warnings.join(' ')).toContain('table of contents');
  });
});
