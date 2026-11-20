import { describe, expect, it } from 'vitest';
import { personalize, renderDispatch, RenderError, type RenderOptions } from '../src/index';

const options: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: false,
};
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const COVER = 'https://media.example/media/cover.png';

describe('cover image in email', () => {
  it('is a real image with a width and alt text, above the body', () => {
    const { html, text, warnings } = renderDispatch(doc(para('Body text')), {
      ...options,
      cover: { url: COVER, alt: 'A fox at dawn' },
    });
    const img = /<img src="https:\/\/media\.example\/media\/cover\.png"[^>]*>/.exec(html)?.[0];
    expect(img).toContain('alt="A fox at dawn"');
    expect(img).toContain('width="534"');
    expect(html.indexOf(COVER)).toBeLessThan(html.indexOf('Body text'));
    expect(html).not.toContain('background-image');
    // The same image markup as an image block, so it holds up where those do.
    const block = renderDispatch(
      doc({ type: 'image', attrs: { src: COVER, alt: 'A fox at dawn' } }),
      options,
    );
    expect(block.html).toContain(img!);
    // Ordinary images are in the plain text as [alt]; so is the cover.
    expect(block.text).toContain('[A fox at dawn]');
    expect(text.indexOf('[A fox at dawn]')).toBe(0);
    expect(text).toContain('Body text');
    expect(warnings).toEqual([]);
  });

  it('changes nothing without a cover', () => {
    const plain = renderDispatch(doc(para('Body text')), options);
    expect(renderDispatch(doc(para('Body text')), { ...options, cover: null })).toEqual(plain);
    expect(plain.html.match(/<img/g)).toBeNull();
  });

  it('leaves out a missing image with a warning and never refuses the render', () => {
    const { html, text, warnings } = renderDispatch(doc(para('Body text')), {
      ...options,
      cover: { url: null, alt: 'A fox at dawn' },
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('A fox at dawn');
    expect(text).not.toContain('A fox at dawn');
    expect(warnings).toEqual([
      'The cover image is no longer in the media library and was left out.',
    ]);
  });

  it('warns when there is no alt text and adds nothing to the plain text', () => {
    const { html, text, warnings } = renderDispatch(doc(para('Body text')), {
      ...options,
      cover: { url: COVER, alt: '  ' },
    });
    expect(html).toContain('alt=""');
    expect(text.startsWith('Body text')).toBe(true);
    expect(warnings).toEqual(['The cover image has no alt text.']);
  });

  it('escapes alt text', () => {
    const { html } = renderDispatch(doc(para('Body')), {
      ...options,
      cover: { url: COVER, alt: `"><script>alert('x')</script>&` },
    });
    expect(html).not.toContain('<script');
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;"');
  });

  it('escapes a Member’s name that a merge tag in the alt text brings in', () => {
    const template = renderDispatch(doc(para('Body')), {
      ...options,
      cover: { url: COVER, alt: 'For {{ first_name | you }}' },
    });
    expect(template.mergeTags).toEqual([{ field: 'first_name', fallback: 'you' }]);
    const { html } = personalize(
      { html: template.html, text: template.text, subject: 'S' },
      {
        link: () => '#',
        unsubscribeUrl: 'https://u.example/',
        pixelUrl: null,
        member: { email: 'a@example.org', firstName: '"><b>' },
      },
    );
    expect(html).toContain('alt="For &quot;&gt;&lt;b&gt;"');
  });

  it('refuses alt text that imitates a Smart Block marker', () => {
    expect(() =>
      renderDispatch(doc(para('Body')), {
        ...options,
        cover: { url: COVER, alt: '<!--swarm:sb:0-->' },
      }),
    ).toThrow(RenderError);
  });

  it('counts as content, so a post that is only a cover isn’t empty', () => {
    expect(renderDispatch(doc(), options).warnings).toContain('The post is empty.');
    expect(
      renderDispatch(doc(), { ...options, cover: { url: COVER, alt: 'A fox' } }).warnings,
    ).not.toContain('The post is empty.');
    // Gone, it no longer does.
    expect(
      renderDispatch(doc(), { ...options, cover: { url: null, alt: 'A fox' } }).warnings,
    ).toContain('The post is empty.');
  });

  it('is in both emails of a gated paid post', () => {
    const gated = doc(para('Free part'), { type: 'gate' }, para('Paid part'));
    const paid = {
      ...options,
      cover: { url: COVER, alt: 'A fox' },
      webVisibility: 'paid' as const,
      webUrl: 'https://site.example/p/x',
    };
    const teaser = renderDispatch(gated, paid);
    expect(teaser.html).toContain(COVER);
    expect(teaser.html).not.toContain('Paid part');
    expect(renderDispatch(gated, { ...paid, paidVariant: 'full' }).html).toContain(COVER);
  });
});
