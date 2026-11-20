import { describe, expect, it } from 'vitest';
import {
  MAX_SNIPPET_BLOCKS,
  RenderError,
  SNIPPET_GONE_WARNING,
  expandSnippets,
  mayUseSnippets,
  renderDispatch,
  renderWeb,
  snippetBlocks,
  snippetContentProblem,
  snippetIdsOf,
} from '../src/index';

const para = (text: string, showOn?: unknown) => ({
  type: 'paragraph',
  ...(showOn === undefined ? {} : { attrs: { showOn } }),
  content: [{ type: 'text', text }],
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const link = (snippetId: string, showOn?: unknown) => ({
  type: 'snippet',
  attrs: { snippetId, ...(showOn === undefined ? {} : { showOn }) },
});

const emailOptions = { channelName: 'Field', mediaUrl: () => null, allowHtmlBlocks: false };
const webOptions = { channelName: 'Field', media: () => null, allowHtmlBlocks: false };
const email = (document: unknown) => renderDispatch(document, emailOptions);
const web = (document: unknown) => renderWeb(document, webOptions);

describe('expandSnippets', () => {
  it('returns a document with no snippet blocks untouched, so it renders the same', () => {
    const plain = doc(para('One'), { type: 'horizontalRule' }, para('Two'));
    const lookup = () => {
      throw new Error('never read');
    };
    expect(expandSnippets(plain, lookup)).toBe(plain);
    expect(email(expandSnippets(plain, lookup)).html).toBe(email(plain).html);
    expect(mayUseSnippets(JSON.stringify(plain))).toBe(false);
  });

  it('puts the blocks in place, in order, for email and website', () => {
    const saved = doc(para('Saved one'), para('Saved two'));
    const expanded = expandSnippets(doc(para('Before'), link('sn_a'), para('After')), () => saved);
    expect(mayUseSnippets(JSON.stringify(doc(link('sn_a'))))).toBe(true);
    const { html, text } = email(expanded);
    expect(html.indexOf('Before')).toBeLessThan(html.indexOf('Saved one'));
    expect(html.indexOf('Saved two')).toBeLessThan(html.indexOf('After'));
    expect(text).toContain('Saved two');
    expect(web(expanded).freeHtml).toContain('<p>Saved one</p>');
  });

  it('renders the same as the blocks written in the post', () => {
    const inPost = doc(para('Before'), para('Saved'), para('After'));
    const linked = doc(para('Before'), link('sn_a'), para('After'));
    const expanded = expandSnippets(linked, () => doc(para('Saved')));
    expect(email(expanded).html).toBe(email(inPost).html);
    expect(web(expanded).freeHtml).toBe(web(inPost).freeHtml);
  });

  it('keeps blocks inside a snippet to their surface', () => {
    const saved = doc(para('Both'), para('Inbox', 'email'), para('Site', 'web'));
    const expanded = expandSnippets(doc(link('sn_a')), () => saved);
    expect(email(expanded).html).toContain('Inbox');
    expect(email(expanded).html).not.toContain('Site');
    expect(email(expanded).text).not.toContain('Site');
    expect(web(expanded).text).toContain('Site');
    expect(web(expanded).text).not.toContain('Inbox');
  });

  it('keeps the whole snippet to the surface of its block', () => {
    const saved = doc(para('Both'), para('Inbox', 'email'), para('Site', 'web'));
    const inbox = expandSnippets(doc(link('sn_a', 'email')), () => saved);
    expect(email(inbox).text).toContain('Both');
    expect(email(inbox).text).toContain('Inbox');
    expect(web(inbox).text).toBe('');
    // A block kept to the other surface shows nowhere.
    expect(JSON.stringify(inbox)).not.toContain('Site');

    const site = expandSnippets(doc(link('sn_a', 'web')), () => saved);
    expect(web(site).text).toContain('Both');
    expect(web(site).text).toContain('Site');
    expect(email(site).html).not.toContain('Both');
    expect(JSON.stringify(site)).not.toContain('Inbox');
  });

  it('still refuses a showOn value that is neither surface', () => {
    const expanded = expandSnippets(doc(link('sn_a', 'sms')), () => doc(para('Both')));
    expect(() => email(expanded)).toThrow(RenderError);
    expect(() => web(expanded)).toThrow(RenderError);
    const inner = expandSnippets(doc(link('sn_a', 'email')), () => doc(para('Both', 'sms')));
    expect(() => email(inner)).toThrow(RenderError);
    expect(() => email(doc(link('sn_a', 'sms')))).toThrow(RenderError);
  });

  it('leaves out what a snippet saved earlier could use to change the post', () => {
    const saved = doc(
      para('Kept'),
      { type: 'gate' },
      { type: 'smartBlock', attrs: { condition: {} }, content: [para('Hidden')] },
      link('sn_other'),
    );
    const lookup = (id: string) => (id === 'sn_a' ? saved : doc(para('Nested')));
    const expanded = expandSnippets(doc(link('sn_a'), para('After')), lookup);
    const types = (expanded.content as { type: string }[]).map((node) => node.type);
    expect(types).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(expanded)).not.toContain('Nested');
    expect(web(expanded).hasGate).toBe(false);
  });

  it('stops at the limit, so one post can’t grow without bound', () => {
    const many = doc(...Array.from({ length: MAX_SNIPPET_BLOCKS + 5 }, () => link('sn_a')));
    const expanded = expandSnippets(many, () => doc(para('Saved')));
    const nodes = expanded.content as { type: string }[];
    expect(nodes.filter((n) => n.type === 'paragraph')).toHaveLength(MAX_SNIPPET_BLOCKS);
    expect(nodes.filter((n) => n.type === 'snippet')).toHaveLength(5);
    expect(snippetIdsOf(many)).toEqual(['sn_a']);
  });
});

describe('a snippet that is gone', () => {
  const gone = doc(para('Before'), link('sn_gone'), para('After'));

  it('renders nothing, with a warning in the email and on the website', () => {
    const expanded = expandSnippets(gone, () => null);
    const out = email(expanded);
    expect(out.warnings).toContain(SNIPPET_GONE_WARNING);
    expect(out.html).toBe(email(doc(para('Before'), para('After'))).html);
    expect(web(expanded).freeHtml).toBe('<p>Before</p>\n<p>After</p>');
    expect(web(expanded).warnings).toContain(SNIPPET_GONE_WARNING);
  });

  it('warns about one kept to the website too, since the pre-send check reads the email', () => {
    expect(email(doc(para('Text'), link('sn_gone', 'web'))).warnings).toContain(
      SNIPPET_GONE_WARNING,
    );
  });

  it('is removed for a reader’s page', () => {
    const expanded = expandSnippets(gone, () => null, { dropMissing: true });
    expect(expanded.content).toEqual([para('Before'), para('After')]);
  });
});

describe('where a snippet block can sit', () => {
  it('is refused inside another block, because its content may need the top level', () => {
    const nested = doc({ type: 'blockquote', content: [link('sn_a')] });
    expect(() => email(nested)).toThrow(/between blocks/);
    expect(() => web(nested)).toThrow(/between blocks/);
    // And it isn't read: only top-level blocks name snippets.
    expect(snippetIdsOf(nested)).toEqual([]);
  });
});

describe('snippetContentProblem', () => {
  it('refuses snippets, paywall breaks and Smart Blocks at any depth', () => {
    expect(snippetContentProblem(doc(para('Fine')))).toBeNull();
    expect(snippetContentProblem(doc(link('sn_a')))).toMatch(/another snippet/);
    expect(snippetContentProblem(doc({ type: 'gate' }))).toMatch(/paywall/);
    expect(
      snippetContentProblem(doc({ type: 'blockquote', content: [para('x'), link('sn_a')] })),
    ).toMatch(/another snippet/);
    expect(snippetContentProblem(doc({ type: 'smartBlock', content: [] }))).toMatch(/Smart block/);
    // A node called after an object's own properties is not a problem.
    expect(snippetContentProblem(doc({ type: 'toString' }))).toBeNull();
  });
});

describe('snippetBlocks, for a detached copy', () => {
  it('carries the block’s setting onto the copy', () => {
    const saved = doc(para('Both'), para('Site', 'web'));
    expect(snippetBlocks(saved, 'email')).toEqual([para('Both', 'email')]);
    expect(snippetBlocks(saved)).toEqual(saved.content);
    expect(snippetBlocks(saved, null)).toEqual(saved.content);
  });
});
