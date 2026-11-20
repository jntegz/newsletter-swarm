// What the renderer does for the places email breaks: Outlook on Windows, dark mode, phones,
// right-to-left text, and a publication's own colours. Real clients can't run here, so these
// pin the well-known patterns the HTML relies on.
import { describe, expect, it } from 'vitest';
import { darkEmail } from '../src/dark-preview';
import { GMAIL_CLIP_BYTES, renderDispatch, systemEmail, systemLink } from '../src/index';
import { contrast, darkTheme, emailTheme, readColor, type Rgb } from '../src/palette';

const text = (value: string, ...marks: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks } : {}),
});
const para = (...content: unknown[]) => ({
  type: 'paragraph',
  content: content.map((c) => (typeof c === 'string' ? text(c) : c)),
});
const heading = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const options = { channelName: 'Field Notes', mediaUrl: () => null, allowHtmlBlocks: false };
const render = (document: unknown, extra: Partial<Parameters<typeof renderDispatch>[1]> = {}) =>
  renderDispatch(document, { ...options, ...extra });
const image = (attrs: Record<string, unknown> = {}) => ({
  type: 'image',
  attrs: { src: 'https://x.example/a.png', alt: 'A', ...attrs },
});
const button = { type: 'button', attrs: { href: 'https://example.com/go', label: 'Read it' } };
const rgb = (hex: string) => readColor(hex) as Rgb;

describe('Outlook on Windows', () => {
  const { html } = render(doc(para('Hello'), button));

  it('gives the card a fixed-width table only Outlook sees, opened and closed once', () => {
    expect(html).toContain(
      '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    );
    expect(html).toContain('<!--[if mso]></td></tr></table><![endif]-->');
    expect(html.match(/<!--\[if mso\]>/g)).toHaveLength(3);
    expect(html.match(/<!\[endif\]-->/g)).toHaveLength(3);
  });

  it('sets the resolution and a font Outlook has, in a stylesheet for it alone', () => {
    expect(html).toContain('<o:PixelsPerInch>96</o:PixelsPerInch>');
    expect(html).toMatch(
      /<!--\[if mso\]>.*font-family:'Segoe UI',Arial,sans-serif.*<!\[endif\]-->/,
    );
    expect(html).toContain('mso-line-height-rule:exactly');
    expect(render(doc(para('x')), { design: { font: 'serif' } }).html).toContain(
      "blockquote{font-family:Georgia,'Times New Roman',serif",
    );
  });

  it('puts the font on every layout cell, since Outlook does not inherit it into tables', () => {
    for (const cell of ['sw-header', 'sw-content', 'sw-footer']) {
      expect(html).toMatch(new RegExp(`<td class="${cell}[^>]*font-family:-apple-system`));
    }
  });

  it('draws the button on a table cell that carries the colour and Outlook’s padding', () => {
    expect(html).toContain(
      '<td class="sw-btn" align="center" bgcolor="#6c4cf1" style="background:#6c4cf1;border-radius:999px;mso-padding-alt:13px 24px">',
    );
    // 13 + 20 + 13: a 46px target everywhere else.
    expect(html).toMatch(
      /<a class="sw-button" href="\{\{@link:0\}\}" style="display:inline-block;padding:13px 24px;font-size:15px;line-height:20px;/,
    );
  });

  it('sizes images by a width attribute that fits what they sit in', () => {
    const width = (html: string) => [...html.matchAll(/<img[^>]* width="(\d+)"/g)].map((m) => m[1]);
    expect(width(render(doc(image())).html)).toEqual(['534']);
    expect(width(render(doc({ type: 'blockquote', content: [image()] })).html)).toEqual(['515']);
    expect(width(render(doc({ type: 'callout', content: [image()] })).html)).toEqual(['495']);
    const columns = {
      type: 'columns',
      content: [
        { type: 'column', content: [image()] },
        { type: 'column', content: [image({ widthPercent: 50 })] },
      ],
    };
    expect(width(render(doc(columns)).html)).toEqual(['255', '128']);
  });

  it('keeps borders and padding on table cells, never on links, quotes or rules', () => {
    const out = render(
      doc(
        { type: 'blockquote', content: [para('Quoted')] },
        { type: 'horizontalRule' },
        { type: 'linkCard', attrs: { href: 'https://example.com/a', title: 'A card' } },
      ),
    ).html;
    expect(out).not.toContain('<hr');
    expect(out).toMatch(
      /<blockquote style="margin:0 0 16px"><table role="presentation"[^>]*><tr><td class="sw-t sw-bar" style="padding:2px 0 2px 16px;border-left:3px solid #6c4cf1/,
    );
    expect(out).toMatch(
      /<table class="sw-link-card sw-line" role="presentation"[^>]*style="border:1px solid #efedf6;[^"]*"><tr><td align="left" style="padding:14px 16px"><a href="\{\{@link:0\}\}" style="display:block;text-decoration:none">/,
    );
    expect(out).toContain('class="sw-hr" role="presentation"');
  });

  it('marks every table it writes as layout', () => {
    const out = render(
      doc(
        para('x'),
        button,
        { type: 'callout', content: [para('c')] },
        { type: 'codeBlock', content: [text('a')] },
        { type: 'horizontalRule' },
      ),
    ).html.replace(/<!--\[if mso\]>.*?<!\[endif\]-->/g, '');
    const tables = out.match(/<table\b[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThan(6);
    for (const table of tables) expect(table).toContain('role="presentation"');
  });
});

describe('dark mode', () => {
  const { html } = render(
    doc(
      heading(1, 'Title'),
      para('Body ', text('link', { type: 'link', attrs: { href: 'https://example.com' } })),
      button,
    ),
  );

  it('declares both colour schemes and ships a dark palette for the classes it writes', () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    const dark = /<style>@media \(prefers-color-scheme:dark\)\{(.*?)\}<\/style>/.exec(html)?.[1];
    expect(dark).toContain('.sw-body,.sw-page{background:#121214!important}');
    expect(dark).toContain('.sw-card{background:#1c1c1f!important}');
    expect(dark).toContain('.sw-h{color:#f4f4f6!important}');
    expect(dark).toContain('.sw-t{color:#d9d9df!important}');
    expect(html).toContain('<h1 class="sw-h"');
    expect(html).toContain('<p class="sw-t"');
    expect(html).toContain('<a class="sw-a" href');
  });

  it('repeats it for Outlook.com, in a stylesheet of its own', () => {
    expect(html).toMatch(
      /<style>\[data-ogsb\] \.sw-body,\[data-ogsb\] \.sw-page\{background:#121214!important\}/,
    );
    expect(html).toContain('[data-ogsc] .sw-h{color:#f4f4f6!important}');
  });

  it('lifts a link colour that would be lost on the dark card, and leaves the button', () => {
    const navy = render(
      doc(para(text('x', { type: 'link', attrs: { href: 'https://example.com' } })), button),
      {
        accentColor: '#14203a',
      },
    ).html;
    const link = /\.sw-a\{color:(#[0-9a-f]{6})!important\}/.exec(navy)?.[1] as string;
    expect(contrast(rgb(link), rgb('#1c1c1f'))).toBeGreaterThanOrEqual(4.5);
    // Navy on a near-black card: the button is lifted too, with a label that reads on it.
    expect(navy).toMatch(/\.sw-btn\{background:#[0-9a-f]{6}!important\}/);
    expect(navy).toMatch(/\.sw-bar\{border-color:#[0-9a-f]{6}!important\}/);
    expect(html).not.toContain('.sw-btn{');
  });

  it('leaves an email that is dark by design alone', () => {
    const out = render(doc(heading(1, 'Title'), para('Body')), {
      design: { pageColor: '#0b0b0d', cardColor: '#17171a' },
    }).html;
    expect(out).not.toContain('prefers-color-scheme');
    expect(out).not.toContain('data-ogsc');
    // Nobody chose a text colour, so it gets one that reads on the dark card.
    expect(out).toMatch(/<h1 class="sw-h" style="[^"]*color:#f4f4f6"/);
    expect(out).toMatch(/<p class="sw-t" style="[^"]*color:#d9d9df"/);
  });

  it('the dark preview shows the same colours the rules give', () => {
    const preview = darkEmail(html);
    expect(preview.problems).toEqual([]);
    expect(preview.html).toContain('@media all{.sw-body');
    expect(preview.html).toMatch(/<h1 class="sw-h" style="[^"]*color:#f4f4f6"/);
    expect(preview.html).toMatch(/<p class="sw-t" style="[^"]*color:#d9d9df"/);
    expect(preview.html).toContain('bgcolor="#1c1c1f"');
    // Outlook's conditional markup passes through untouched.
    expect(preview.html).toContain('<!--[if mso]><table role="presentation" width="600"');
  });
});

describe('a publication’s own colours', () => {
  it('uses the chosen text colour for headings and, softened, for running text', () => {
    const out = render(doc(heading(2, 'T'), para('B')), {
      design: { cardColor: '#fffaf1', textColor: '#2b2118' },
    }).html;
    expect(out).toMatch(/<h2 class="sw-h" style="[^"]*color:#2b2118"/);
    const body = /<p class="sw-t" style="[^"]*color:(#[0-9a-f]{6})"/.exec(out)?.[1] as string;
    expect(body).not.toBe('#3a3a44');
    expect(contrast(rgb(body), rgb('#fffaf1'))).toBeGreaterThan(7);
  });

  it('picks a button label that reads on the accent, and a link that reads on the card', () => {
    const yellow = emailTheme({ accent: '#ffc83d' });
    expect(yellow.button).toBe('#ffc83d');
    expect(yellow.buttonLabel).toBe('#0f0f12');
    expect(contrast(rgb(yellow.link), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    const purple = emailTheme({});
    expect(purple).toMatchObject({ link: '#6c4cf1', button: '#6c4cf1', buttonLabel: '#ffffff' });
    expect(darkTheme(purple)?.button).toBe('#6c4cf1');
  });

  it('ignores anything that is not a hex colour', () => {
    expect(emailTheme({ accent: 'red;x', card: 'url(x)', page: '#fff' })).toEqual(emailTheme());
  });
});

describe('phones', () => {
  it('tightens the gutters, sizes headings down and stacks columns at 620px', () => {
    const columns = {
      type: 'columns',
      content: [
        { type: 'column', content: [para('L')] },
        { type: 'column', content: [para('R')] },
      ],
    };
    const { html } = render(doc(columns));
    const phone = /@media \(max-width:620px\)\{(.*?)\}<\/style>/.exec(html)?.[1];
    expect(phone).toContain('.sw-wrap{padding:12px 8px!important}');
    expect(phone).toContain('.sw-content{padding:16px 20px 8px!important');
    expect(phone).toContain('h1.sw-h{font-size:25px!important}');
    expect(phone).toContain(
      '.sw-col{display:block!important;width:100%!important;padding:0!important}',
    );
    expect(phone).toContain('.sw-col img{max-width:100%!important}');
  });

  it('lets images shrink with the screen', () => {
    expect(render(doc(image())).html).toContain(
      'style="display:block;width:100%;max-width:534px;height:auto;',
    );
  });
});

describe('language and direction', () => {
  it('is English, left to right, unless told or shown otherwise', () => {
    expect(render(doc(para('Hello'))).html).toContain('<html lang="en" dir="ltr"');
    expect(render(doc(para('Bonjour')), { lang: 'fr' }).html).toContain(
      '<html lang="fr" dir="ltr"',
    );
    expect(render(doc(para('Hello')), { lang: '"><script>' }).html).toContain('<html lang="en"');
  });

  it('turns a Hebrew or Arabic issue right to left, bars and indents included', () => {
    const out = render(
      doc(
        para('مرحبا بكم في النشرة البريدية'),
        { type: 'blockquote', content: [para('اقتباس')] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [para('عنصر')] }] },
      ),
    ).html;
    expect(out).toContain('<html lang="ar" dir="rtl"');
    expect(out).toContain('<body class="sw-body" dir="rtl"');
    expect(out).toMatch(/<td class="sw-content sw-h" align="right"[^>]*text-align:right/);
    expect(out).toContain('border-right:3px solid');
    expect(out).toContain('padding:0 24px 0 0');
    expect(render(doc(para('שלום לכולם'))).html).toContain('<html lang="he" dir="rtl"');
    expect(render(doc(para('Hello مرحبا, mostly English text here'))).html).toContain('dir="ltr"');
    expect(render(doc(para('مرحبا')), { dir: 'ltr' }).html).toContain('dir="ltr"');
  });
});

describe('the frame', () => {
  it('looks finished with nothing configured: header, card, footer with both links', () => {
    const { html, text } = render(doc(para('Hello')));
    expect(html).toMatch(/<td class="sw-header sw-m"[^>]*>Field Notes<\/td>/);
    expect(html).toMatch(
      /<td class="sw-footer sw-f"[^>]*>You are receiving this because you joined Field Notes\.<br><a href="\{\{@member_center\}\}"[^>]*>Manage your subscription<\/a> &middot; <a href="\{\{@unsubscribe\}\}"[^>]*>Unsubscribe<\/a><\/td>/,
    );
    expect(text).toMatch(/Unsubscribe: \{\{@unsubscribe\}\}\n$/);
  });

  it('prints the footer line (the postal address) under the links, in both parts', () => {
    const { html, text } = render(doc(para('Hello')), {
      design: { footer: 'Field Notes Ltd, 12 Mill Lane <Hebden Bridge>' },
    });
    expect(html).toContain(
      'Unsubscribe</a><br><span style="display:block;padding-top:8px">Field Notes Ltd, 12 Mill Lane &lt;Hebden Bridge&gt;</span></td>',
    );
    expect(text).toMatch(
      /Unsubscribe: \{\{@unsubscribe\}\}\n\nField Notes Ltd, 12 Mill Lane <Hebden Bridge>\n$/,
    );
  });

  it('hides the preview text from every client, Outlook included', () => {
    const { html } = render(doc(para('Hello')), { preheader: 'Inside <this> issue' });
    expect(html).toMatch(
      /<div style="display:none;[^"]*mso-hide:all">Inside &lt;this&gt; issue(&#847;&zwnj;&nbsp;){40}<\/div>/,
    );
  });

  it('a heading that opens the email or follows a rule gives up its top margin', () => {
    const { html } = render(
      doc(
        heading(1, 'First'),
        para('x'),
        { type: 'horizontalRule' },
        heading(2, 'After'),
        para('y'),
        heading(2, 'Later'),
      ),
    );
    expect(html).toMatch(/<h1 class="sw-h" style="margin:8px 0 12px/);
    expect(html).toMatch(/<h2 class="sw-h" style="margin:0px 0 12px[^>]*>After/);
    expect(html).toMatch(/<h2 class="sw-h" style="margin:24px 0 12px[^>]*>Later/);
  });

  it('stays far under Gmail’s clipping size for a long issue, and still warns past it', () => {
    const long = doc(...Array.from({ length: 120 }, (_, i) => para(`Paragraph ${i} `.repeat(12))));
    const out = render(long);
    expect(new TextEncoder().encode(out.html).length).toBeLessThan(GMAIL_CLIP_BYTES / 2);
    expect(out.warnings).toEqual([]);
    const huge = doc(...Array.from({ length: 700 }, (_, i) => para(`Paragraph ${i} `.repeat(12))));
    expect(render(huge).warnings).toContain('The email is over 102 KB, so Gmail will clip it.');
  });
});

describe('system emails', () => {
  const html = systemEmail({
    title: 'Your sign-in link',
    brand: 'Field <Notes>',
    accent: '#ffc83d',
    heading: 'Sign in',
    paragraphs: ['Use this link & nothing else.', { html: '<b>Chrome</b> signed in.' }],
    button: { label: 'Sign in', url: 'https://example.com/a?b=1&c=2' },
    footnote: 'If you did not ask, ignore this.',
  });

  it('use the same frame: Outlook table, dark palette, phone gutters', () => {
    expect(html).toContain('<!--[if mso]><table role="presentation" width="480"');
    expect(html).toContain('max-width:480px');
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('.sw-content{padding:24px 20px!important}');
    expect(html).toContain('<html lang="en" dir="ltr"');
  });

  it('escape what they are given, and keep trusted HTML', () => {
    expect(html).toContain('Field &lt;Notes&gt;');
    expect(html).toContain('Use this link &amp; nothing else.</p>');
    expect(html).toContain('<b>Chrome</b> signed in.</p>');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html.match(/href=/g)).toHaveLength(1);
  });

  it('use the first paragraph as the inbox preview, and a readable button label', () => {
    expect(html).toMatch(/mso-hide:all">Use this link &amp; nothing else\.&#847;/);
    expect(html).toMatch(/<a class="sw-button"[^>]*color:#0f0f12;/);
    expect(html).toContain('bgcolor="#ffc83d"');
  });

  it('write a bare address as a link', () => {
    expect(systemLink('https://example.com/x?a=1&b=2').html).toBe(
      '<a class="sw-a" href="https://example.com/x?a=1&amp;b=2" style="color:#6c4cf1;text-decoration:underline;word-break:break-all">https://example.com/x?a=1&amp;b=2</a>',
    );
  });
});
