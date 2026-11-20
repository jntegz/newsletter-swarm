// A block kept to email or to the website: nothing of it reaches the other surface, in html, text,
// excerpts, footnotes, tables of contents or links, and everything else keeps working around it.
import { describe, expect, it } from 'vitest';
import {
  RenderError,
  applySmartBlocks,
  renderDispatch,
  renderWeb,
  shownBlocks,
  smartBlocksOf,
  usesBlockVisibility,
  type RenderOptions,
  type WebRenderOptions,
} from '../src/index';

const email: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: true,
  codeEmbeds: true,
};
const web: WebRenderOptions = {
  channelName: 'Field Notes',
  media: () => null,
  allowHtmlBlocks: true,
  codeEmbeds: true,
};

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (value: string, showOn?: unknown) => ({
  type: 'paragraph',
  ...(showOn === undefined ? {} : { attrs: { showOn } }),
  content: [text(value)],
});
const heading = (value: string, showOn?: unknown) => ({
  type: 'heading',
  attrs: { level: 2, ...(showOn === undefined ? {} : { showOn }) },
  content: [text(value)],
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const CONDITION = { field: 'tag', cmp: 'eq', value: 'VIP' };
const smart = (value: string, attrs: Record<string, unknown> = {}) => ({
  type: 'smartBlock',
  attrs: { condition: CONDITION, anonymous: 'show', ...attrs },
  content: [para(value)],
});
const footnoted = (before: string, note: string, showOn?: unknown) => ({
  type: 'paragraph',
  ...(showOn === undefined ? {} : { attrs: { showOn } }),
  content: [text(before), { type: 'footnote', attrs: { text: note } }],
});

describe('blocks kept to one surface', () => {
  const mixed = doc(
    para('For both'),
    para('Just the inbox', 'email'),
    para('Just the site', 'web'),
  );

  it('leaves website-only blocks out of the email, html and text', () => {
    const out = renderDispatch(mixed, email);
    expect(out.html).toContain('For both');
    expect(out.html).toContain('Just the inbox');
    expect(out.html).not.toContain('Just the site');
    expect(out.text).not.toContain('Just the site');
  });

  it('leaves email-only blocks out of the website, text, excerpt and reading time', () => {
    const out = renderWeb(doc(para('Just the inbox', 'email'), para('For both')), web);
    expect(out.freeHtml).toContain('For both');
    expect(out.freeHtml).not.toContain('Just the inbox');
    expect(out.text).toBe('For both');
    expect(out.freeText).toBe('For both');
    expect(out.excerpt).toBe('For both');
  });

  it('does not change a document that uses no setting, null included', () => {
    const plain = doc(para('One'), heading('Two'));
    const nulled = doc(para('One', null), heading('Two', null));
    expect(renderDispatch(nulled, email).html).toBe(renderDispatch(plain, email).html);
    expect(renderDispatch(nulled, email).text).toBe(renderDispatch(plain, email).text);
    expect(renderWeb(nulled, web).freeHtml).toBe(renderWeb(plain, web).freeHtml);
  });

  it('refuses an unknown value on both surfaces, wherever the block is', () => {
    for (const value of ['both', 'EMAIL', 1, true, {}]) {
      const bad = doc(para('Hello', value));
      expect(() => renderDispatch(bad, email)).toThrow(RenderError);
      expect(() => renderWeb(bad, web)).toThrow(RenderError);
    }
    const nested = doc({ type: 'blockquote', content: [para('Hello', 'sometimes')] });
    expect(() => renderWeb(nested, web)).toThrow(RenderError);
  });

  it('honours a setting on a nested block, so its text never leaks', () => {
    const nested = doc({ type: 'blockquote', content: [para('Quote'), para('Secret', 'email')] });
    expect(renderWeb(nested, web).text).not.toContain('Secret');
    expect(renderDispatch(nested, email).text).toContain('Secret');
  });

  it('refuses a setting on a list item or a column', () => {
    const list = doc({
      type: 'bulletList',
      content: [{ type: 'listItem', attrs: { showOn: 'email' }, content: [para('Item')] }],
    });
    const columns = doc({
      type: 'columns',
      content: [
        { type: 'column', attrs: { showOn: 'web' }, content: [para('Left')] },
        { type: 'column', content: [para('Right')] },
      ],
    });
    for (const bad of [list, columns]) {
      expect(() => renderDispatch(bad, email)).toThrow(RenderError);
      expect(() => renderWeb(bad, web)).toThrow(RenderError);
    }
  });

  it('still refuses a broken block the surface does not show', () => {
    const button = { type: 'button', attrs: { href: 'nope', label: '', showOn: 'web' } };
    expect(() => renderDispatch(doc(button), email)).toThrow(RenderError);
    const onlyEmail = { type: 'button', attrs: { href: 'nope', label: '', showOn: 'email' } };
    expect(() => renderWeb(doc(onlyEmail), web)).toThrow(RenderError);
  });

  it('keeps a hidden block out of the links, merge tags and warnings of the email', () => {
    const out = renderDispatch(
      doc(para('Kept'), {
        type: 'paragraph',
        attrs: { showOn: 'web' },
        content: [
          text('{{ first_name }}', [{ type: 'link', attrs: { href: 'https://site.example/' } }]),
        ],
      }),
      email,
    );
    expect(out.links).toEqual([]);
    expect(out.mergeTags).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('numbers footnotes only from the blocks shown', () => {
    const notes = doc(
      footnoted('Inbox', 'Inbox note', 'email'),
      footnoted('Site', 'Site note', 'web'),
      footnoted('Both', 'Both note'),
    );
    const mail = renderDispatch(notes, email);
    expect(mail.text).toContain('Inbox[1]');
    expect(mail.text).toContain('Both[2]');
    expect(mail.text).not.toContain('Site note');
    const site = renderWeb(notes, web);
    expect(site.text).toContain('Site[1]');
    expect(site.text).toContain('Both[2]');
    expect(site.freeHtml).not.toContain('Inbox note');
    expect(site.freeHtml).toContain('id="fn-2"');
  });

  it('lists only the headings shown in a table of contents', () => {
    const toc = doc(
      { type: 'tableOfContents' },
      heading('Everywhere'),
      heading('Inbox heading', 'email'),
      heading('Site heading', 'web'),
    );
    const mail = renderDispatch(toc, email);
    expect(mail.html).toContain('Inbox heading');
    expect(mail.html).not.toContain('Site heading');
    const site = renderWeb(toc, web);
    expect(site.freeHtml).toContain('Site heading');
    expect(site.freeHtml).not.toContain('Inbox heading');
    expect(site.freeHtml).toContain('href="#everywhere"');
  });

  it('can keep the table of contents itself to one surface', () => {
    const toc = doc({ type: 'tableOfContents', attrs: { showOn: 'web' } }, heading('Heading'));
    expect(renderDispatch(toc, email).html).not.toContain('sw-toc');
    expect(renderWeb(toc, web).freeHtml).toContain('sw-toc');
  });

  it('keeps paywall gating: the email teaser and the web parts both stop at the gate', () => {
    const paid = doc(
      para('Free both'),
      para('Free site', 'web'),
      { type: 'gate' },
      para('Paid both'),
      para('Paid inbox', 'email'),
      para('Paid site', 'web'),
    );
    const options = {
      ...email,
      webVisibility: 'paid' as const,
      webUrl: 'https://site.example/post',
    };
    const teaser = renderDispatch(paid, options);
    expect(teaser.text).toContain('Free both');
    expect(teaser.text).not.toContain('Free site');
    expect(teaser.text).not.toContain('Paid');
    expect(teaser.text.includes('Continue reading')).toBe(true);
    const full = renderDispatch(paid, { ...options, paidVariant: 'full' });
    expect(full.text).toContain('Paid inbox');
    expect(full.text).not.toContain('Paid site');

    const site = renderWeb(paid, web);
    expect(site.hasGate).toBe(true);
    expect(site.freeText).toBe('Free both\n\nFree site');
    expect(site.gatedHtml).toContain('Paid site');
    expect(site.gatedHtml).not.toContain('Paid inbox');
    expect(site.text).not.toContain('Paid inbox');
  });

  it('never lets a website-only paid block into the free email by moving past the gate', () => {
    const paid = doc(para('Open'), { type: 'gate', attrs: { showOn: 'web' } }, para('Closed'));
    const teaser = renderDispatch(paid, {
      ...email,
      webVisibility: 'paid',
      webUrl: 'https://site.example/post',
    });
    expect(teaser.text).not.toContain('Closed');
    expect(renderWeb(paid, web).freeText).toBe('Open');
  });

  describe('Smart Blocks', () => {
    const blocks = doc(
      smart('Site only smart', {
        showOn: 'web',
        condition: { field: 'tag', cmp: 'eq', value: 'A' },
      }),
      smart('First in the email'),
      smart('Second in the email', { showOn: 'email' }),
    );

    it('give the email markers the indexes smartBlocksOf reports', () => {
      const out = renderDispatch(blocks, email);
      expect(smartBlocksOf(blocks).map((b) => b.index)).toEqual([0, 1]);
      expect(smartBlocksOf(blocks).map((b) => b.condition)).toEqual([CONDITION, CONDITION]);
      expect(out.smartBlocks?.map((b) => b.index)).toEqual([0, 1]);
      expect(out.html).not.toContain('Site only smart');
      const onlySecond = applySmartBlocks(out, [1]);
      expect(onlySecond.html).toContain('Second in the email');
      expect(onlySecond.html).not.toContain('First in the email');
    });

    it('can count every block when checking the document', () => {
      expect(smartBlocksOf(blocks, { allSurfaces: true })).toHaveLength(3);
    });

    it('keep document order on the website, and leave out email-only ones', () => {
      const seen: number[] = [];
      const site = renderWeb(blocks, {
        ...web,
        smartBlockVisible: ({ index }) => {
          seen.push(index);
          return true;
        },
      });
      expect(seen).toEqual([0, 1]);
      expect(site.text).toContain('Site only smart');
      expect(site.text).not.toContain('Second in the email');
    });
  });

  it('finds a setting at any depth, and treats null as none', () => {
    expect(usesBlockVisibility(doc(para('One')))).toBe(false);
    expect(usesBlockVisibility(doc(para('One', null)))).toBe(false);
    expect(usesBlockVisibility(doc(para('One', 'web')))).toBe(true);
    expect(usesBlockVisibility(doc({ type: 'blockquote', content: [para('x', 'email')] }))).toBe(
      true,
    );
    expect(usesBlockVisibility(doc(para('One', 'both')))).toBe(true);
  });

  it('filters a list without judging odd values, which rendering refuses', () => {
    const list = [para('a', 'email'), para('b', 'web'), para('c'), para('d', 'both')];
    expect(shownBlocks(list, 'web').map((n) => n.content[0]?.text)).toEqual(['b', 'c', 'd']);
  });
});
