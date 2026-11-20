import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { TOC_NODE, documentHeadings, highlightDecorations } from './codeEmbeds';
import { dispatchExtensions } from './extensions';

const schema = getSchema(dispatchExtensions());
const text = (value: string) => ({ type: 'text', text: value });
const docOf = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

describe('code embeds in the editor', () => {
  it('knows the table of contents block, between top-level blocks only', () => {
    expect(schema.nodes[TOC_NODE]?.spec.group).toBe('topBlock');
    expect(() => docOf({ type: TOC_NODE }, { type: 'paragraph' })).not.toThrow();
  });

  it('decorates the tokens of a code block at their exact positions', () => {
    const doc = docOf(
      { type: 'paragraph', content: [text('Intro')] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [text('const a = 1;')] },
    );
    const decorations = highlightDecorations(doc);
    const spans = decorations.map((d) => ({
      text: doc.textBetween(d.from, d.to),
      class: (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
    }));
    expect(spans).toContainEqual({ text: 'const', class: 'sw-tk-kw' });
    expect(spans).toContainEqual({ text: '1', class: 'sw-tk-num' });
  });

  it('leaves plain-text code blocks undecorated', () => {
    const doc = docOf({ type: 'codeBlock', attrs: { language: null }, content: [text('const a')] });
    expect(highlightDecorations(doc)).toEqual([]);
  });

  it('lists the top-level headings the table of contents shows', () => {
    const doc = docOf(
      { type: TOC_NODE },
      { type: 'heading', attrs: { level: 2 }, content: [text('One')] },
      {
        type: 'blockquote',
        content: [{ type: 'heading', attrs: { level: 2 }, content: [text('Quoted')] }],
      },
      { type: 'heading', attrs: { level: 3 }, content: [text('Two')] },
    );
    expect(documentHeadings(doc)).toEqual([
      { level: 2, text: 'One' },
      { level: 3, text: 'Two' },
    ]);
  });
});
