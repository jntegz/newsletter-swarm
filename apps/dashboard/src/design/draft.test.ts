import type { Design } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import {
  copyThemeFiles,
  filesOf,
  personName,
  resetCode,
  sameDesign,
  stableStringify,
  switchTheme,
  whenSaved,
  withSections,
} from './draft';

const themes = [
  { id: 'launch', name: 'Launch', description: '', files: { 'theme.json': '{}' } },
  { id: 'letter', name: 'Letter', description: '', files: { 'theme.json': '{"name":"L"}' } },
];
const design: Design = {
  theme: 'launch',
  files: null,
  settings: { accent: '#2f5d50' },
  sections: [{ id: 'hero-1', type: 'hero', settings: { heading: 'Hi' } }],
};

describe('a design’s files', () => {
  it('uses the built-in files until the code is its own', () => {
    expect(filesOf(design, themes)).toBe(themes[0]!.files);
    const own = copyThemeFiles(design, themes[0]!.files);
    expect(own.files).toEqual(themes[0]!.files);
    expect(own.files).not.toBe(themes[0]!.files);
    expect(filesOf(own, themes)).toBe(own.files);
    expect(resetCode(own).files).toBeNull();
    expect(filesOf({ ...design, theme: 'gone' }, themes)).toBeNull();
  });

  it('keeps settings and sections when the template changes, and drops its own code', () => {
    const switched = switchTheme({ ...design, files: { 'theme.json': '{}' } }, 'letter');
    expect(switched).toEqual({ ...design, theme: 'letter', files: null });
  });

  it('makes the sections concrete from the defaults the first time', () => {
    const defaults = [{ id: 'hero-1', type: 'hero', settings: {} }];
    const next = withSections({ ...design, sections: null }, defaults, (list) => [
      ...list,
      { id: 'faq-1', type: 'faq', settings: {} },
    ]);
    expect(next.sections?.map((s) => s.id)).toEqual(['hero-1', 'faq-1']);
    expect(defaults).toHaveLength(1);
  });
});

describe('comparing', () => {
  it('compares by content, whatever the key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"e":1,"f":2}]},"b":1}',
    );
    const reordered: Design = {
      sections: design.sections,
      settings: { accent: '#2f5d50' },
      files: null,
      theme: 'launch',
    };
    expect(sameDesign(design, reordered)).toBe(true);
    expect(sameDesign(design, { ...design, settings: {} })).toBe(false);
    expect(sameDesign(design, null)).toBe(false);
  });
});

describe('words', () => {
  it('names a person and a time', () => {
    expect(personName({ name: 'Mara', email: 'm@example.com' })).toBe('Mara');
    expect(personName({ email: 'm@example.com' })).toBe('m@example.com');
    expect(personName('Jonas')).toBe('Jonas');
    expect(personName(null)).toBeNull();
    const now = new Date(2026, 10, 8, 21, 30);
    expect(whenSaved(new Date(2026, 10, 8, 21, 10), now)).toBe('21:10');
    expect(whenSaved(new Date(2026, 10, 5, 9, 5), now)).toBe('5 Nov, 09:05');
  });
});
