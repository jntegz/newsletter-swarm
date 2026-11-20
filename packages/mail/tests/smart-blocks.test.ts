// Smart Blocks: the render matrix (visible / hidden × html / text × nested content), checked on
// the MIME message a recipient actually gets, plus the web renderer and marker safety.
import { describe, expect, it } from 'vitest';
import {
  applySmartBlocks,
  buildMime,
  personalize,
  renderDispatch,
  renderWeb,
  RenderError,
  smartBlocksOf,
  type RenderOptions,
} from '../src/index';

const options: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: true,
};

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const link = (href: string) => [{ type: 'link', attrs: { href } }];
const VIP = { field: 'tag', cmp: 'eq', value: 'VIP' };
const smart = (content: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: 'smartBlock',
  attrs: { condition: VIP, ...attrs },
  content,
});

/** Intro, block 0 (a paragraph with a link), middle, block 1 (a list and a quote), outro. */
const DOCUMENT = doc(
  para(text('Intro')),
  smart([para(text('For VIPs: '), text('the lounge', link('https://vip.example/lounge')))], {
    label: 'VIP note',
  }),
  para(text('Middle')),
  smart(
    [
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(text('One'))] },
          { type: 'listItem', content: [para(text('Two'))] },
        ],
      },
      { type: 'blockquote', content: [para(text('Quoted, {{ first_name | friend }}'))] },
    ],
    { anonymous: 'show' },
  ),
  para(text('Outro')),
);

function decodeParts(raw: string): { text: string; html: string } {
  const parts = raw.split(/--swarm-[0-9a-f]+/);
  const decode = (part: string) => {
    const body = part.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    const binary = atob(body);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  };
  return { text: decode(parts[1]!), html: decode(parts[2]!) };
}

/** The message one recipient gets, as MIME, decoded back into its two parts. */
function mimeFor(visible: readonly number[] | undefined) {
  const template = renderDispatch(DOCUMENT, options);
  const filled = personalize(
    { html: template.html, text: template.text, subject: 'Issue' },
    {
      link: (n) => `https://t.example/c/${n}`,
      unsubscribeUrl: 'https://t.example/u/1',
      pixelUrl: null,
      member: { email: 'ada@example.org', firstName: 'Ada' },
      ...(visible ? { smartBlocks: visible } : {}),
    },
  );
  const raw = buildMime({
    from: { name: 'Field Notes', address: 'hello@news.example' },
    to: 'ada@example.org',
    subject: filled.subject,
    text: filled.text,
    html: filled.html,
    messageId: 'dl_1@news.example',
    date: new Date('2026-10-28T10:00:00Z'),
    headers: {},
  });
  const parts = decodeParts(raw);
  // The body text before the footer, and the html of the content cell.
  return {
    text: parts.text.split('\n\n--\n')[0]!,
    html: /<td class="sw-content[^>]*>([\s\S]*?)<\/td><\/tr>\n<\/table>/.exec(parts.html)![1]!,
    fullHtml: parts.html,
  };
}

describe('Smart Blocks in email', () => {
  it('wraps each top-level block in numbered markers in both parts', () => {
    const out = renderDispatch(DOCUMENT, options);
    for (const part of [out.html, out.text]) {
      expect(part).toContain('<!--swarm:sb:0-->');
      expect(part).toContain('<!--/swarm:sb:0-->');
      expect(part).toContain('<!--swarm:sb:1-->');
      expect(part).toContain('<!--/swarm:sb:1-->');
    }
    expect(out.smartBlocks).toEqual([
      { index: 0, label: 'VIP note', anonymous: 'hide', condition: VIP },
      { index: 1, label: null, anonymous: 'show', condition: VIP },
    ]);
    expect(smartBlocksOf(DOCUMENT).map((b) => b.index)).toEqual([0, 1]);
    // A block's links are ordinary links in the shared list.
    expect(out.links).toEqual(['https://vip.example/lounge']);
  });

  it('both visible: content kept, markers gone (text and html)', () => {
    const out = mimeFor([0, 1]);
    expect(out.text).toBe(
      [
        'Intro',
        'For VIPs: the lounge (https://t.example/c/0)',
        'Middle',
        '- One\n- Two\n\n> Quoted, Ada',
        'Outro',
      ].join('\n\n'),
    );
    expect(out.fullHtml).not.toContain('swarm:sb');
    expect(out.html).toContain('the lounge</a>');
    expect(out.html).toContain('<li style="margin:0 0 6px">');
    expect(out.html).toContain('Quoted, Ada');
  });

  it('first hidden, second visible', () => {
    const out = mimeFor([1]);
    expect(out.text).toBe(
      ['Intro', 'Middle', '- One\n- Two\n\n> Quoted, Ada', 'Outro'].join('\n\n'),
    );
    expect(out.html).not.toContain('For VIPs');
    expect(out.html).not.toContain('https://t.example/c/0');
    expect(out.html).toContain('Quoted, Ada');
    expect(out.fullHtml).not.toContain('swarm:sb');
  });

  it('first visible, second hidden (nested content goes with it)', () => {
    const out = mimeFor([0]);
    expect(out.text).toBe(
      ['Intro', 'For VIPs: the lounge (https://t.example/c/0)', 'Middle', 'Outro'].join('\n\n'),
    );
    expect(out.html).not.toContain('<li');
    expect(out.html).not.toContain('<blockquote');
    expect(out.html).not.toContain('Quoted');
  });

  it('both hidden', () => {
    const out = mimeFor([]);
    expect(out.text).toBe(['Intro', 'Middle', 'Outro'].join('\n\n'));
    expect(out.html).toBe(
      renderDispatch(
        doc(para(text('Intro')), para(text('Middle')), para(text('Outro'))),
        options,
      ).html.match(/<td class="sw-content[^>]*>([\s\S]*?)<\/td><\/tr>\n<\/table>/)![1],
    );
    expect(out.fullHtml).not.toContain('swarm:sb');
  });

  it('a preview without a visibility list keeps every block', () => {
    expect(mimeFor(undefined).text).toBe(mimeFor([0, 1]).text);
  });

  it('a block at the very start or end leaves no stray blank lines', () => {
    const template = renderDispatch(
      doc(smart([para(text('Top'))]), para(text('Body')), smart([para(text('Bottom'))])),
      options,
    );
    const hidden = applySmartBlocks(template, []);
    expect(hidden.text.startsWith('Body\n\n--\n')).toBe(true);
    const shown = applySmartBlocks(template, [0, 1]);
    expect(shown.text.startsWith('Top\n\nBody\n\nBottom\n\n--\n')).toBe(true);
  });

  it('Member data that looks like a marker is never treated as one', () => {
    const template = renderDispatch(
      doc(para(text('Hi {{ first_name | there }}')), smart([para(text('Secret'))])),
      options,
    );
    const out = personalize(
      { html: template.html, text: template.text, subject: 's' },
      {
        link: () => '#',
        unsubscribeUrl: 'https://t.example/u/1',
        pixelUrl: null,
        member: { email: 'a@b.example', firstName: '<!--/swarm:sb:0-->' },
        smartBlocks: [],
      },
    );
    expect(out.text).not.toContain('Secret');
    expect(out.html).not.toContain('Secret');
    expect(out.text).toContain('Hi <!--/swarm:sb:0-->');
    expect(out.html).toContain('Hi &lt;!--/swarm:sb:0--&gt;');
  });

  it('refuses author text and raw HTML that imitate a marker', () => {
    expect(() =>
      renderDispatch(doc(para(text('x <!--/swarm:sb:0--> y')), smart([para(text('a'))])), options),
    ).toThrow(RenderError);
    expect(() =>
      renderDispatch(
        doc({ type: 'htmlBlock', attrs: { html: '<!--swarm:sb:0-->' } }, para(text('a'))),
        options,
      ),
    ).toThrow(RenderError);
  });

  it('refuses nested Smart Blocks, blocks inside other blocks, and a missing condition', () => {
    expect(() => renderDispatch(doc(smart([smart([para(text('a'))])])), options)).toThrow(
      'top level',
    );
    expect(() =>
      renderDispatch(doc({ type: 'blockquote', content: [smart([para(text('a'))])] }), options),
    ).toThrow('top level');
    expect(() =>
      renderDispatch(doc({ type: 'smartBlock', attrs: {}, content: [para(text('a'))] }), options),
    ).toThrow('condition');
  });

  it('keeps indexes stable in the teaser of a gated paid Dispatch', () => {
    const gated = doc(
      smart([para(text('Before'))]),
      { type: 'gate' },
      smart([para(text('After'))]),
    );
    const paid = { ...options, webVisibility: 'paid' as const, webUrl: 'https://s.example/p' };
    const teaser = renderDispatch(gated, paid);
    const full = renderDispatch(gated, { ...paid, paidVariant: 'full' });
    expect(teaser.smartBlocks?.map((b) => b.index)).toEqual([0]);
    expect(full.smartBlocks?.map((b) => b.index)).toEqual([0, 1]);
    expect(applySmartBlocks(full, [1]).text).toContain('After');
    expect(applySmartBlocks(full, [1]).text).not.toContain('Before');
  });
});

describe('Smart Blocks on the web', () => {
  const web = { channelName: 'Field Notes', media: () => null, allowHtmlBlocks: false };

  it('shows only blocks marked show for anonymous readers, by default', () => {
    const out = renderWeb(DOCUMENT, web);
    expect(out.freeHtml).not.toContain('For VIPs');
    expect(out.text).not.toContain('For VIPs');
    expect(out.freeHtml).toContain('<li>');
    expect(out.freeHtml).not.toContain('swarm:sb');
  });

  it('follows smartBlockVisible when given', () => {
    const out = renderWeb(DOCUMENT, { ...web, smartBlockVisible: ({ index }) => index === 0 });
    expect(out.freeHtml).toContain('For VIPs');
    expect(out.freeHtml).not.toContain('<li>');
  });

  it('refuses nested Smart Blocks', () => {
    expect(() => renderWeb(doc(smart([smart([para(text('a'))])])), web)).toThrow(RenderError);
  });
});
