import { CHAMPION_CODE } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { championLinks, cleanRef, displayName, newChampionCode } from '../src/index';

describe('champion codes', () => {
  it('are 8 symbols of the look-alike-free alphabet', () => {
    const codes = new Set(Array.from({ length: 500 }, () => newChampionCode()));
    for (const code of codes) expect(code).toMatch(CHAMPION_CODE);
    expect(codes.size).toBeGreaterThan(495);
  });

  it('are cleaned before use: lowercased, Member ids kept, anything else dropped', () => {
    expect(cleanRef(' ABCD2345 ')).toBe('abcd2345');
    expect(cleanRef(`mb_${'a'.repeat(32)}`)).toBe(`mb_${'a'.repeat(32)}`);
    for (const bad of [null, '', 'abcd234', 'abcd23450', 'abcd1234', 'abcdo234', '<script>']) {
      expect(cleanRef(bad)).toBeNull();
    }
  });

  it('make a share link and a short link on the site', () => {
    expect(championLinks('https://notes.swarm.page/', 'abcd2345')).toEqual({
      shareUrl: 'https://notes.swarm.page/?ref=abcd2345',
      shortUrl: 'https://notes.swarm.page/r/abcd2345',
    });
  });
});

describe('public Champion names', () => {
  it('show a first name and an initial, never an address', () => {
    expect(displayName('Grace', 'hopper')).toBe('Grace H.');
    expect(displayName('Grace', null)).toBe('Grace');
    expect(displayName(null, 'Hopper')).toBe('H.');
    expect(displayName('  ', null)).toBe('A referrer');
    expect(displayName('grace@example.org', null)).toBe('A referrer');
  });
});
