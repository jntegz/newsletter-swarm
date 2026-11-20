import { describe, expect, it } from 'vitest';
import { colorLuminance, contrastRatio, mixColors, readableColor, textOn } from '../src/site';

describe('colour contrast helpers', () => {
  it('measures luminance and contrast as WCAG does', () => {
    expect(colorLuminance('#000000')).toBe(0);
    expect(colorLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  it('mixes two colours', () => {
    expect(mixColors('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixColors('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('picks dark or white text for a background', () => {
    expect(textOn('#ffe14d')).toBe('#0f0f12');
    expect(textOn('#6c4cf1')).toBe('#ffffff');
    expect(textOn('#0f0f12')).toBe('#ffffff');
    expect(textOn('not a colour')).toBe('#ffffff');
  });

  it('leaves a readable colour alone', () => {
    expect(readableColor('#6C4CF1', '#ffffff')).toBe('#6c4cf1');
  });

  it.each([
    ['#ffe14d', '#ffffff'],
    ['#ffffff', '#fbfbfd'],
    ['#6c4cf1', '#17171c'],
    ['#101010', '#0f0f12'],
    ['#ff0000', '#ff0000'],
    ['#808080', '#808080'],
  ])('moves %s until it reads on %s', (color, background) => {
    const fixed = readableColor(color, background);
    expect(fixed).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(fixed, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('returns what it cannot read unchanged', () => {
    expect(readableColor('red', '#ffffff')).toBe('red');
  });
});
