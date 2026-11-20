import { describe, expect, it } from 'vitest';
import { filterSlash, slashQuery } from './slash';

describe('slashQuery', () => {
  it('starts on a line beginning with a slash, with the cursor at its end', () => {
    expect(slashQuery('/', true)).toBe('');
    expect(slashQuery('/ima', true)).toBe('ima');
    expect(slashQuery('/ima', false)).toBeNull();
  });

  it('leaves ordinary text and addresses alone', () => {
    expect(slashQuery('and/or', true)).toBeNull();
    expect(slashQuery('/usr/local', true)).toBeNull();
    expect(slashQuery('', true)).toBeNull();
    expect(slashQuery(`/${'x'.repeat(30)}`, true)).toBeNull();
  });
});

describe('filterSlash', () => {
  const items = [
    { label: 'Heading' },
    { label: 'Image' },
    { label: 'Link card' },
    { label: 'Raw HTML', disabled: true },
  ];

  it('lists what can be used, and puts names starting with the search first', () => {
    expect(filterSlash(items, '').map((i) => i.label)).toEqual(['Heading', 'Image', 'Link card']);
    expect(filterSlash(items, 'im').map((i) => i.label)).toEqual(['Image']);
    expect(filterSlash([{ label: 'Card' }, { label: 'Link card' }], 'card')).toHaveLength(2);
    expect(filterSlash(items, 'raw')).toEqual([]);
  });
});
