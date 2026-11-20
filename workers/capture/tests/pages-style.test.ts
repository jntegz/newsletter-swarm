import { contrastRatio } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { accentVars, page } from '../src/pages';

const value = (css: string, name: string) => new RegExp(`${name}:(#[0-9a-f]{6})`).exec(css)![1]!;

describe('the accent on confirm and subscriber settings pages', () => {
  it('uses the default when the colour is missing or not a colour', () => {
    expect(accentVars(null)).toContain('--accent:#6c4cf1;--on-accent:#ffffff');
    expect(accentVars('red;}body{display:none')).toContain('--accent:#6c4cf1');
  });

  it('keeps a light accent readable: dark button text and darker links on the light card', () => {
    const css = accentVars('#FFE14D');
    expect(value(css, '--accent')).toBe('#ffe14d');
    expect(value(css, '--on-accent')).toBe('#0f0f12');
    expect(contrastRatio(value(css, '--link'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    const dark = css.slice(css.indexOf('@media'));
    expect(value(dark, '--link')).toBe('#ffe14d');
  });

  it('lightens a dark accent for links on the dark card', () => {
    const dark = accentVars('#1b2a4a');
    expect(
      contrastRatio(value(dark.slice(dark.indexOf('@media')), '--link'), '#17171c'),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('puts the variables in every page', async () => {
    const html = await page('Title', '<h1>Hello</h1>', { accent: '#0a7d5a' }).text();
    expect(html).toContain('--accent:#0a7d5a;--on-accent:#ffffff');
    expect(html).toContain('color:var(--on-accent)');
  });
});
