import { describe, expect, it } from 'vitest';
import { diffLines, documentLines } from './diff';

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });

describe('documentLines', () => {
  it('flattens blocks into readable lines', () => {
    const lines = documentLines({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Hello')] },
        para('First'),
        { type: 'paragraph' },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [para('one')] }],
        },
        { type: 'image', attrs: { alt: 'A chart' } },
        { type: 'attachment', attrs: { name: 'Report' } },
      ],
    });
    expect(lines).toEqual(['## Hello', 'First', '• one', '[Image: A chart]', '[File: Report]']);
  });
});

describe('diffLines', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['x'])).toEqual([{ kind: 'added', text: 'x' }]);
    expect(diffLines(['x'], [])).toEqual([{ kind: 'removed', text: 'x' }]);
  });
});
