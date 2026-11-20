import { describe, expect, it } from 'vitest';
import { oneLine } from './PostHeader';
import { isShortcut, readingTime } from './shortcuts';

describe('readingTime', () => {
  it('rounds to whole minutes at about 230 words a minute, never under one', () => {
    expect(readingTime(0)).toBe('nothing to read yet');
    expect(readingTime(37)).toBe('1 min read');
    expect(readingTime(230)).toBe('1 min read');
    expect(readingTime(1150)).toBe('5 min read');
  });
});

describe('isShortcut', () => {
  // The modifier follows the platform the code detects: ⌘ on a Mac, Ctrl elsewhere.
  const onMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = onMac ? 'metaKey' : 'ctrlKey';
  const other = onMac ? 'ctrlKey' : 'metaKey';
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  it('needs the modifier, and Shift only when asked', () => {
    expect(isShortcut(key('s', { [mod]: true }), 's')).toBe(true);
    expect(isShortcut(key('S', { [mod]: true }), 's')).toBe(true);
    expect(isShortcut(key('s'), 's')).toBe(false);
    expect(isShortcut(key('s', { [other]: true }), 's')).toBe(false);
    expect(isShortcut(key('s', { [mod]: true, shiftKey: true }), 's')).toBe(false);
    expect(isShortcut(key('s', { [mod]: true, shiftKey: true }), 's', { shift: true })).toBe(true);
  });
  it('leaves Alt combinations to the editor', () => {
    expect(isShortcut(key('s', { [mod]: true, altKey: true }), 's')).toBe(false);
  });
});

describe('oneLine', () => {
  it('turns pasted line breaks into single spaces', () => {
    expect(oneLine('Notes on\nthe popup\r\n  economy')).toBe('Notes on the popup economy');
    expect(oneLine('Already one line')).toBe('Already one line');
  });
});
