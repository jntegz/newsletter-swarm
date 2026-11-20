import { describe, expect, it } from 'vitest';
import {
  SITE_DESIGN_MAX_CHARS,
  SiteDesignSchema,
  SitePreviewRequestSchema,
  SiteThemeFileSchema,
  THEME_LIMITS,
  idPattern,
  newId,
} from '../src/index';

const design = { theme: 'launch', files: null, settings: { accent: '#123456' }, sections: null };

describe('SiteDesignSchema', () => {
  it('takes a design whose values the engine checks later', () => {
    expect(SiteDesignSchema.parse(design)).toEqual(design);
    // Wrong values are the engine's problems, not a refused save.
    const odd = {
      ...design,
      settings: { accent: 'red', nope: [1, 2] },
      sections: [{ id: 'Bad Id', type: 'missing', settings: { x: 1 }, audience: 'visitors' }],
      files: { 'Not/A/Theme.txt': '<script>' },
    };
    expect(SiteDesignSchema.safeParse(odd).success).toBe(true);
  });

  it('refuses wrong shapes', () => {
    expect(SiteDesignSchema.safeParse({ ...design, theme: 'other' }).success).toBe(false);
    expect(SiteDesignSchema.safeParse({ ...design, settings: [] }).success).toBe(false);
    expect(
      SiteDesignSchema.safeParse({
        ...design,
        sections: [{ id: 'a', type: 'hero', settings: {}, audience: 'nobody' }],
      }).success,
    ).toBe(false);
  });

  it('holds the theme limits', () => {
    const many = Object.fromEntries(
      Array.from({ length: THEME_LIMITS.files + 1 }, (_, i) => [`snippets/s${i}.html`, '']),
    );
    expect(SiteDesignSchema.safeParse({ ...design, files: many }).success).toBe(false);
    const big = { 'theme.css': 'x'.repeat(THEME_LIMITS.bytes + 1) };
    expect(SiteDesignSchema.safeParse({ ...design, files: big }).success).toBe(false);
    const sections = Array.from({ length: THEME_LIMITS.sections + 1 }, (_, i) => ({
      id: `s${i}`,
      type: 'text',
      settings: {},
    }));
    expect(SiteDesignSchema.safeParse({ ...design, sections }).success).toBe(false);
    const huge = { ...design, settings: { body: 'x'.repeat(SITE_DESIGN_MAX_CHARS) } };
    expect(SiteDesignSchema.safeParse(huge).success).toBe(false);
  });
});

describe('previews and theme files', () => {
  it('previews as a visitor unless asked', () => {
    expect(SitePreviewRequestSchema.parse({})).toEqual({ as: 'visitor' });
    expect(SitePreviewRequestSchema.safeParse({ as: 'owner' }).success).toBe(false);
  });

  it('reads the export format', () => {
    const file = { format: 'swarm-theme', version: 1, name: 'Mine', files: { 'theme.json': '{}' } };
    expect(SiteThemeFileSchema.parse(file)).toEqual(file);
    expect(SiteThemeFileSchema.safeParse({ ...file, version: 2 }).success).toBe(false);
  });

  it('gives versions their own ids', () => {
    expect(idPattern('siteDesignVersion').test(newId('siteDesignVersion'))).toBe(true);
  });
});
