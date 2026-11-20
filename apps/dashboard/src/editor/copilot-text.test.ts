import { describe, expect, it } from 'vitest';
import { textNodes } from './copilot-text';

describe('textNodes', () => {
  it('keeps one paragraph inline and splits on blank lines', () => {
    expect(textNodes('  One line\nwrapped  ')).toEqual([
      { type: 'text', text: 'One line wrapped' },
    ]);
    expect(textNodes('First\n\n\nSecond\n\n')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
    ]);
  });

  it('treats markup as text', () => {
    expect(textNodes('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });

  it('returns nothing for blank text', () => {
    expect(textNodes(' \n\n ')).toEqual([]);
  });
});
