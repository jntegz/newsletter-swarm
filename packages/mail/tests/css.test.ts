import { describe, expect, it } from 'vitest';
import {
  applyEmailCss,
  EMAIL_CSS_MAX_BYTES,
  lintEmailCss,
  renderDispatch,
  type RenderOptions,
} from '../src/index';

const options: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: false,
};
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (value: string) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
const button = { type: 'button', attrs: { href: 'https://x.example', label: 'Go' } };

const errorsOf = (css: string) => lintEmailCss(css).errors.map((e) => e.message);
const warningsOf = (css: string) => lintEmailCss(css).warnings.map((e) => e.message);

describe('lintEmailCss', () => {
  it('accepts ordinary email CSS', () => {
    const lint = lintEmailCss(
      `/* brand */\np { color: #333; font-family: 'Helvetica Neue', Arial }\n.sw-button { background: #111 !important }\n@media (max-width: 600px) { h1 { font-size: 24px } }`,
    );
    expect(lint.errors).toEqual([]);
    expect(lint.ok).toBe(true);
    expect(lint.rules).toHaveLength(3);
    expect(lint.rules[1]).toEqual({
      selectors: ['.sw-button'],
      declarations: [{ property: 'background', value: '#111', important: true }],
      media: null,
    });
    expect(lint.rules[2]?.media).toBe('(max-width: 600px)');
  });

  it.each([
    ['@import url(https://evil.example/a.css);', /@import/],
    ['@import "a.css";', /@import/],
    ['p { background: url(https://t.example/pixel.gif) }', /url\(\)/],
    ['p { background: URL( "//t.example/x" ) }', /url\(\)/],
    ['p { width: expression(alert(1)) }', /script/],
    ['p { background: javascript:alert(1) }', /script/],
    ['p { behavior: url(x.htc) }', /behavior/],
    ['div { position: fixed; top: 0 }', /position: fixed/],
    ['p { color: red } </style><script>', /“<”/],
    ['p { color: {{ first_name }} }', /“\{\{”/],
    ['p { color: red', /closing brace/],
    ['p { color: red } }', /closing brace without/],
    ['/* open', /comment is not closed/],
    ['@font-face { font-family: x }', /@font-face/],
    ['p { color }', /not a property and value/],
    ['p { content: "\\3c" }', /Escapes/],
  ])('refuses %s', (css, message) => {
    const lint = lintEmailCss(css);
    expect(lint.ok).toBe(false);
    expect(lint.rules).toEqual([]);
    expect(lint.errors.map((e) => e.message).join(' ')).toMatch(message);
  });

  it('has no warning for properties named like Object.prototype members', () => {
    expect(warningsOf('p { constructor: 1px; toString: 2px }')).toEqual([]);
  });

  it('refuses a stylesheet over the size cap', () => {
    expect(errorsOf(`p{color:red}\n`.repeat(EMAIL_CSS_MAX_BYTES / 10))[0]).toMatch(/at most/);
  });

  it('reports the line of a problem', () => {
    expect(lintEmailCss('p { color: red }\n\ndiv { position: fixed }').errors[0]?.line).toBe(3);
  });

  it('warns about what major clients ignore, and still accepts it', () => {
    const css = `a:hover { color: red }\ndiv { display: flex; box-shadow: 0 0 1px #000; position: relative }\np { color: var(--x) }\n@keyframes spin { from { opacity: 0 } }`;
    const lint = lintEmailCss(css);
    expect(lint.ok).toBe(true);
    const warnings = warningsOf(css).join(' ');
    expect(warnings).toMatch(/:hover/);
    expect(warnings).toMatch(/flex/);
    expect(warnings).toMatch(/box-shadow/);
    expect(warnings).toMatch(/position/);
    expect(warnings).toMatch(/var\(\)/);
    expect(warnings).toMatch(/@keyframes/);
    // The ignored at-rule is dropped rather than passed on.
    expect(lint.rules.map((r) => r.selectors[0])).toEqual(['a:hover', 'div', 'p']);
  });
});

describe('applyEmailCss', () => {
  it('inlines simple rules after the existing styles, by specificity', () => {
    const { rules } = lintEmailCss(
      'a.sw-button { color: blue } a { color: red } .sw-button { padding: 0 }',
    );
    const out = applyEmailCss(
      '<head><title>t</title></head><body><a class="sw-button" style="color:#fff">x</a><a href="#">y</a></body>',
      rules,
    );
    expect(out.html).toContain(
      '<a class="sw-button" style="color:#fff;color:red;padding:0;color:blue">x</a>',
    );
    expect(out.html).toContain('<a href="#" style="color:red">y</a>');
    expect(out.html).toContain('<title>t</title>');
    expect(out.stylesheet).toBe('');
  });

  it('keeps @media and complex selectors for the style element', () => {
    const { rules } = lintEmailCss(
      '.sw-content p { margin: 0 } a:hover { color: red } @media (max-width: 600px) { p { font-size: 18px } h1 { font-size: 22px } }',
    );
    const out = applyEmailCss('<body><p>x</p></body>', rules);
    expect(out.html).toBe('<body><p>x</p></body>');
    expect(out.stylesheet).toBe(
      '.sw-content p{margin:0}a:hover{color:red}@media (max-width: 600px){p{font-size:18px}h1{font-size:22px}}',
    );
  });

  it('escapes quotes so a value never leaves the style attribute', () => {
    const { rules } = lintEmailCss(`p { font-family: "A" }`);
    const out = applyEmailCss('<body><p>x</p></body>', rules);
    expect(out.html).toBe('<body><p style="font-family:&quot;A&quot;">x</p></body>');
  });
});

describe('custom CSS in a rendered email', () => {
  it('inlines into the email and puts the rest in the head', () => {
    const out = renderDispatch(doc(para('Hello'), button), {
      ...options,
      customCss:
        'p { color: #222 } .sw-button { background: #000 } @media (max-width:600px) { p { font-size: 18px } }',
    });
    expect(out.html).toMatch(/<p class="sw-t" style="[^"]*;color:#222">Hello<\/p>/);
    expect(out.html).toMatch(
      /<a class="sw-button" href="\{\{@link:0\}\}" style="[^"]*;background:#000">/,
    );
    expect(out.html).toContain('<style>@media (max-width:600px){p{font-size:18px}}</style></head>');
  });

  it('leaves out a stylesheet with errors, with a warning', () => {
    const out = renderDispatch(doc(para('Hello')), {
      ...options,
      customCss: 'p { background: url(https://t.example/x.gif) }',
    });
    expect(out.html).not.toContain('t.example');
    expect(out.warnings).toContain('The publication’s email CSS has errors, so it was left out.');
  });

  it('changes nothing without custom CSS', () => {
    const plain = renderDispatch(doc(para('Hello')), options);
    // Only the built-in stylesheets: phone, dark mode, Outlook.com's dark mode, and Outlook's own.
    expect(plain.html.match(/<style>/g)).toHaveLength(4);
    expect(renderDispatch(doc(para('Hello')), { ...options, customCss: '  ' }).html).toBe(
      plain.html,
    );
  });
});
