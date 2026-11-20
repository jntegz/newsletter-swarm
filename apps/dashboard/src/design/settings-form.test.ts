import type { SettingDef } from '@swarm/site-themes';
import { standardSettings } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import {
  controlKind,
  fieldProblem,
  fontName,
  groupSettings,
  isVisible,
  itemTitle,
  listMax,
  newListItem,
  normaliseHex,
  optionLabel,
  optionsOf,
  withValue,
} from './settings-form';

const def = (over: Partial<SettingDef> & Pick<SettingDef, 'id' | 'type'>): SettingDef => ({
  label: over.id,
  ...over,
});

describe('groupSettings', () => {
  it('keeps the declared order and groups by first appearance', () => {
    const groups = groupSettings([
      def({ id: 'a', type: 'text', group: 'Colour' }),
      def({ id: 'b', type: 'text' }),
      def({ id: 'c', type: 'text', group: 'Type' }),
      def({ id: 'd', type: 'text', group: 'Colour' }),
    ]);
    expect(groups.map((g) => [g.title, g.defs.map((d) => d.id)])).toEqual([
      ['Colour', ['a', 'd']],
      [null, ['b']],
      ['Type', ['c']],
    ]);
  });

  it('groups the standard tokens as Colour, Type and Shape', () => {
    expect(groupSettings(standardSettings()).map((g) => g.title)).toEqual([
      'Colour',
      'Type',
      'Shape',
    ]);
  });
});

describe('isVisible', () => {
  const defs = [def({ id: 'layout', type: 'select' }), def({ id: 'show', type: 'checkbox' })];
  it('shows a setting while the other setting has the value', () => {
    expect(isVisible({ visible_if: 'layout:split' }, { layout: 'split' }, defs)).toBe(true);
    expect(isVisible({ visible_if: 'layout:split' }, { layout: 'centred' }, defs)).toBe(false);
  });
  it('takes several values, a negation and checkboxes', () => {
    expect(isVisible({ visible_if: 'layout:split, cover' }, { layout: 'cover' }, defs)).toBe(true);
    expect(isVisible({ visible_if: 'layout:!split' }, { layout: 'cover' }, defs)).toBe(true);
    expect(isVisible({ visible_if: 'show:true' }, { show: true }, defs)).toBe(true);
    expect(isVisible({ visible_if: 'show:true' }, { show: false }, defs)).toBe(false);
  });
  it('never hides a setting for good over a typo', () => {
    expect(isVisible({ visible_if: 'layut:split' }, {}, defs)).toBe(true);
    expect(isVisible({ visible_if: 'nonsense' }, {}, defs)).toBe(true);
    expect(isVisible({}, {}, defs)).toBe(true);
  });
});

describe('controls', () => {
  it('draws short choices as segments and long sets as a select', () => {
    expect(controlKind(def({ id: 's', type: 'select', options: ['a', 'b'] }))).toBe('segmented');
    expect(controlKind(def({ id: 's', type: 'select', options: ['a', 'b', 'c', 'd', 'e'] }))).toBe(
      'select',
    );
    expect(controlKind(def({ id: 's', type: 'select', options: ['only'] }))).toBe('select');
    expect(
      controlKind(def({ id: 's', type: 'select', options: ['x'.repeat(40), 'y'.repeat(40)] })),
    ).toBe('select');
    expect(controlKind(def({ id: 'c', type: 'checkbox' }))).toBe('switch');
    expect(controlKind(def({ id: 'l', type: 'list' }))).toBe('list');
  });

  it('labels plain option values', () => {
    expect(optionLabel('two_up')).toBe('Two up');
    expect(optionsOf({ options: ['centred', { value: 'split', label: 'Side by side' }] })).toEqual([
      { value: 'centred', label: 'Centred' },
      { value: 'split', label: 'Side by side' },
    ]);
    expect(fontName('grotesk')).toBe('Grotesk');
  });
});

describe('values', () => {
  it('sets and removes a value without touching the old object', () => {
    const before = { a: 1, b: 2 };
    expect(withValue(before, 'a', 3)).toEqual({ a: 3, b: 2 });
    expect(withValue(before, 'b', undefined)).toEqual({ a: 1 });
    expect(before).toEqual({ a: 1, b: 2 });
  });

  it('starts a list item with defaults and empty text', () => {
    expect(
      newListItem([
        def({ id: 'quote', type: 'textarea' }),
        def({ id: 'stars', type: 'number', default: 5 }),
        def({ id: 'photo', type: 'image' }),
        def({ id: 'on', type: 'checkbox' }),
      ]),
    ).toEqual({ quote: '', stars: 5, on: false });
  });

  it('names a list item by its first text', () => {
    const fields = [def({ id: 'photo', type: 'image' }), def({ id: 'quote', type: 'textarea' })];
    expect(itemTitle({ quote: '  So   good  ' }, fields, 0)).toBe('So good');
    expect(itemTitle({}, fields, 2)).toBe('Item 3');
    expect(itemTitle({ quote: 'x'.repeat(60) }, fields, 0)).toHaveLength(48);
  });

  it('caps lists at the engine’s 20', () => {
    expect(listMax({ max: 6 })).toBe(6);
    expect(listMax({ max: 50 })).toBe(20);
    expect(listMax({})).toBe(20);
  });

  it('explains a bad address as a sentence', () => {
    const url = def({ id: 'link', type: 'url' });
    expect(fieldProblem(url, 'https://example.com')).toBeUndefined();
    expect(fieldProblem(url, '/about')).toBeUndefined();
    expect(fieldProblem(url, 'javascript:alert(1)')).toMatch(/^[A-Z]/);
  });

  it('reads typed colours', () => {
    expect(normaliseHex('#2F5D50')).toBe('#2f5d50');
    expect(normaliseHex('2f5d50')).toBe('#2f5d50');
    expect(normaliseHex('#abc')).toBe('#aabbcc');
    expect(normaliseHex('#2f5d5')).toBeNull();
    expect(normaliseHex('green')).toBeNull();
  });
});
