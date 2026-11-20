import { getSchema } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { describe, expect, it, vi } from 'vitest';
import { dispatchExtensions } from './extensions';
import { linksIn, replaceLinks } from './linkRewrite';

const text = (value: string, href: string) => ({
  type: 'text',
  text: value,
  marks: [{ type: 'link', attrs: { href } }],
});

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [text('Read', 'https://example.org/text')] },
    { type: 'paragraph', content: [text('Mail', 'mailto:hello@example.org')] },
    { type: 'button', attrs: { href: 'https://example.org/button', label: 'Go' } },
    {
      type: 'image',
      attrs: {
        mediaId: 'media_1',
        src: 'https://cdn.example.org/a.png',
        alt: '',
        href: 'https://example.org/image',
      },
    },
    {
      type: 'linkCard',
      attrs: {
        href: 'https://app.example.com/_swarm/sponsored/booking_1',
        title: 'Sponsored: Ad',
      },
    },
  ],
};

const schema = getSchema(dispatchExtensions({ placeholder: '' }));
const start = () => schema.nodeFromJSON(doc);
const WEB = ['https://example.org/text', 'https://example.org/button', 'https://example.org/image'];

describe('linksIn', () => {
  it('finds links in text, buttons and images, and leaves out mail and sponsor links', () => {
    expect(linksIn(start())).toEqual(WEB);
  });
});

describe('replaceLinks', () => {
  it('changes every kind of link in one step, and keeps the rest of each block', () => {
    const state = EditorState.create({ schema, doc: start() });
    const dispatch = vi.fn<(tr: Transaction) => void>();
    replaceLinks(
      { state, view: { dispatch } } as unknown as Editor,
      new Map(WEB.map((url, i) => [url, `https://go.example/${i}`])),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const next = dispatch.mock.calls[0]![0].doc;
    expect(linksIn(next)).toEqual([
      'https://go.example/0',
      'https://go.example/1',
      'https://go.example/2',
    ]);
    expect(JSON.stringify(next.toJSON())).toContain('https://cdn.example.org/a.png');
  });
});
