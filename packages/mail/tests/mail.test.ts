import { describe, expect, it } from 'vitest';
import { escapeHtml, formatAddress } from '../src/index';

describe('formatAddress', () => {
  it('quotes ASCII display names and escapes quotes', () => {
    expect(formatAddress({ name: 'Field Notes', address: 'a@b.example' })).toBe(
      '"Field Notes" <a@b.example>',
    );
    expect(formatAddress({ name: 'Say "hi"', address: 'a@b.example' })).toBe(
      '"Say \\"hi\\"" <a@b.example>',
    );
  });

  it('encodes non-ASCII names', () => {
    expect(formatAddress({ name: 'Zpravodaj Žirafa', address: 'a@b.example' })).toMatch(
      /^=\?UTF-8\?B\?.+\?= <a@b\.example>$/,
    );
  });

  it('returns the bare address without a name', () => {
    expect(formatAddress({ address: 'a@b.example' })).toBe('a@b.example');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;',
    );
  });
});
