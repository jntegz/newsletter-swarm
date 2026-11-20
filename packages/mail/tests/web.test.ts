import { describe, expect, it } from 'vitest';
import {
  collectMediaIds,
  RenderError,
  renderWeb,
  webMergeTags,
  type WebRenderOptions,
} from '../src/index';

const options: WebRenderOptions = {
  channelName: 'Field Notes',
  media: (id) =>
    id === 'md_ok'
      ? {
          url: 'https://media.example/media/md_ok.png',
          alt: 'Library alt',
          width: 1200,
          height: 800,
          focalX: 0.25,
          focalY: 0.8,
        }
      : id === 'md_pdf'
        ? { url: 'https://media.example/media/md_pdf.pdf' }
        : null,
  allowHtmlBlocks: false,
};

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const gate = { type: 'gate' };

describe('renderWeb', () => {
  it('renders semantic HTML for every block type', () => {
    const out = renderWeb(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('Intro')] },
        para(
          text('Hello '),
          text('bold', [{ type: 'bold' }]),
          text(' and '),
          text('em', [{ type: 'italic' }]),
        ),
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }] },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [para(text('three'))] }],
        },
        { type: 'blockquote', content: [para(text('quoted'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a < b')] },
        { type: 'horizontalRule' },
        { type: 'image', attrs: { mediaId: 'md_ok', caption: 'A caption' } },
        { type: 'button', attrs: { href: 'https://example.com/go', label: 'Go' } },
        {
          type: 'linkCard',
          attrs: { href: 'https://example.com/read', title: 'Read', description: 'More' },
        },
        { type: 'attachment', attrs: { mediaId: 'md_pdf', name: 'Report' } },
      ),
      options,
    );
    expect(out.freeHtml).toContain('<h2>Intro</h2>');
    expect(out.freeHtml).toContain('<p>Hello <strong>bold</strong> and <em>em</em></p>');
    expect(out.freeHtml).toContain('<ul><li><p>one</p></li></ul>');
    expect(out.freeHtml).toContain('<ol start="3">');
    expect(out.freeHtml).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(out.freeHtml).toContain('<pre><code class="language-ts">a &lt; b</code></pre>');
    expect(out.freeHtml).toContain('<hr>');
    expect(out.freeHtml).toContain(
      '<figure class="sw-figure"><img class="sw-fp-25-80" src="https://media.example/media/md_ok.png" alt="Library alt" width="1200" height="800" loading="lazy" decoding="async"><figcaption>A caption</figcaption></figure>',
    );
    expect(out.css).toBe('.sw-fp-25-80{object-position:25% 80%}');
    expect(out.freeHtml).toContain('<a class="sw-button" href="https://example.com/go">Go</a>');
    expect(out.freeHtml).toContain('class="sw-link-card" href="https://example.com/read"');
    expect(out.freeHtml).toContain('href="https://media.example/media/md_pdf.pdf"');
    expect(out.freeHtml).toContain('Download PDF');
    expect(out.firstImage).toMatchObject({ alt: 'Library alt', objectPosition: '25% 80%' });
    expect(out.hasGate).toBe(false);
    expect(out.gatedHtml).toBe('');
    expect(out.freeHtml).not.toMatch(/style=/);
  });

  it('splits at the first gate divider', () => {
    const out = renderWeb(
      doc(
        para(text('Free words here.')),
        gate,
        para(text('Secret words.')),
        gate,
        para(text('More.')),
      ),
      options,
    );
    expect(out.hasGate).toBe(true);
    expect(out.freeHtml).toBe('<p>Free words here.</p>');
    expect(out.gatedHtml).toBe('<p>Secret words.</p>\n<p>More.</p>');
    expect(out.freeText).toBe('Free words here.');
    expect(out.excerpt).toBe('Free words here.');
    expect(out.text).toContain('Secret words.');
  });

  it('takes the first image from the free part only', () => {
    const out = renderWeb(
      doc(para(text('x')), gate, { type: 'image', attrs: { mediaId: 'md_ok' } }),
      options,
    );
    expect(out.firstImage).toBeNull();
  });

  it('refuses gates below the top level', () => {
    expect(() => renderWeb(doc({ type: 'blockquote', content: [gate] }), options)).toThrow(
      RenderError,
    );
  });

  it('escapes text and attributes', () => {
    const out = renderWeb(
      doc(para(text('<script>alert(1)</script>')), {
        type: 'image',
        attrs: { src: 'https://img.example/a.png?x="><script>', alt: '"><b>' },
      }),
      options,
    );
    expect(out.freeHtml).not.toContain('<script>');
    expect(out.freeHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.freeHtml).not.toContain('"><b>');
  });

  it('drops unsafe links and keeps safe ones direct', () => {
    const out = renderWeb(
      doc(
        para(text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])),
        para(text('good', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }])),
        para(text('mail', [{ type: 'link', attrs: { href: 'mailto:hi@example.com' } }])),
      ),
      options,
    );
    expect(out.freeHtml).not.toContain('javascript:');
    expect(out.freeHtml).toContain('<p>bad</p>');
    expect(out.freeHtml).toContain('<a href="https://example.com/a?b=1&amp;c=2">good</a>');
    expect(out.freeHtml).toContain('<a href="mailto:hi@example.com">mail</a>');
    expect(out.freeHtml).not.toContain('{{@link');
  });

  it('refuses unknown nodes and marks', () => {
    expect(() => renderWeb(doc({ type: 'script' }), options)).toThrow(RenderError);
    expect(() => renderWeb(doc(para(text('x', [{ type: 'onclick' }]))), options)).toThrow(
      RenderError,
    );
    expect(() => renderWeb(doc(para({ type: 'mention' })), options)).toThrow(RenderError);
    expect(() => renderWeb({ type: 'nope' }, options)).toThrow(RenderError);
    expect(() =>
      renderWeb(doc({ type: 'image', attrs: { src: 'http://insecure.example/a.png' } }), options),
    ).toThrow(RenderError);
  });

  it('renders merge tags as their fallback, never personal data', () => {
    expect(webMergeTags('Hi {{ first_name | friend }}!', 'Notes')).toBe('Hi friend!');
    expect(webMergeTags('Hi {{member.first_name | "there"}}!', 'Notes')).toBe('Hi there!');
    expect(webMergeTags('Hi {{ email }}.', 'Notes')).toBe('Hi .');
    expect(webMergeTags('From {{channel.name}}', 'Notes')).toBe('From Notes');
    const out = renderWeb(doc(para(text('Hello {{ first_name | <reader> }}'))), options);
    expect(out.freeHtml).toBe('<p>Hello &lt;reader&gt;</p>');
  });

  it('omits raw HTML unless allowed, and sandboxes it when it is', () => {
    const block = {
      type: 'htmlBlock',
      attrs: { html: '<p onclick="x()">Hi "there"</p><script>bad()</script>' },
    };
    const off = renderWeb(doc(block), options);
    expect(off.freeHtml).toBe('');
    expect(off.warnings.join(' ')).toContain('raw HTML');
    const on = renderWeb(doc(block), { ...options, allowHtmlBlocks: true });
    expect(on.freeHtml).toMatch(
      /^<iframe class="sw-embed" sandbox="" srcdoc="[^"<>]*" title="Embedded content"/,
    );
    expect(on.freeHtml).not.toContain('<script>');
    expect(on.freeHtml).toContain('&lt;script&gt;');
  });

  it('leaves out missing media instead of failing', () => {
    const out = renderWeb(
      doc({ type: 'image', attrs: { mediaId: 'md_gone' } }, para(text('x'))),
      options,
    );
    expect(out.freeHtml).toBe('<p>x</p>');
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('computes excerpt and reading time', () => {
    const words = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');
    const out = renderWeb(doc(para(text(words))), options);
    expect(out.readingMinutes).toBe(4);
    expect(out.excerpt.length).toBeLessThanOrEqual(201);
    expect(out.excerpt.endsWith('…')).toBe(true);
    expect(renderWeb(doc(), options).readingMinutes).toBe(1);
  });

  it('collects media ids', () => {
    const ids = collectMediaIds(
      doc(
        { type: 'image', attrs: { mediaId: 'a' } },
        { type: 'blockquote', content: [{ type: 'attachment', attrs: { mediaId: 'b' } }] },
      ),
    );
    expect([...ids]).toEqual(['a', 'b']);
  });
});
