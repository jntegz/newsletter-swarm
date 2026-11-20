// Uploaded fonts (docs/site-themes.md, "Uploaded fonts"): a font setting may hold a media id, and
// the design's CSS loads that font from the site's own /media/ address, with the setting's default
// after it.
import { describe, expect, it } from 'vitest';
import {
  compileTheme,
  designCss,
  fontMediaIds,
  resolveSettings,
  standardSettings,
  tokensCss,
  uploadedFontFamily,
  valueProblem,
  type FontLookup,
  type SettingDef,
} from '../src';

const ID = `md_${'ab12'.repeat(8)}`;
const OTHER = `md_${'cd34'.repeat(8)}`;
const URL_OF = (id: string, ext = 'woff2') =>
  `/media/ws/ws_${'1'.repeat(32)}/ch/ch_${'2'.repeat(32)}/${id}.${ext}`;

const lookup =
  (fonts: Record<string, string>): FontLookup =>
  (id) =>
    fonts[id] ? { url: fonts[id]!, family: 'Owner’s name' } : null;

const defs = standardSettings({ heading_font: 'archivo', body_font: 'serif' });
const css = (saved: Record<string, unknown>, font?: FontLookup, settings: SettingDef[] = defs) =>
  tokensCss(settings, resolveSettings(settings, saved), font);

describe('uploaded fonts', () => {
  it('accepts a built-in font or a media id, and nothing else', () => {
    const def: SettingDef = { id: 'f', type: 'font', label: 'Font' };
    expect(valueProblem(def, 'grotesk')).toBeNull();
    expect(valueProblem(def, ID)).toBeNull();
    for (const bad of ['comic', 'md_123', `md_${'A'.repeat(32)}`, 12, `${ID}x`]) {
      expect(valueProblem(def, bad), String(bad)).toMatch(/media library/);
    }
    // A saved media id survives resolving, so the CSS can look it up.
    expect(resolveSettings(defs, { heading_font: ID }).heading_font).toBe(ID);
  });

  it('lists the uploaded fonts a design uses, once each', () => {
    const values = resolveSettings(defs, { heading_font: ID, body_font: ID });
    expect(fontMediaIds(defs, values)).toEqual([ID]);
    expect(fontMediaIds(defs, resolveSettings(defs, {}))).toEqual([]);
  });

  it('adds one @font-face per uploaded font, first in the stack, the default after it', () => {
    const out = css(
      { heading_font: ID, body_font: OTHER },
      lookup({ [ID]: URL_OF(ID), [OTHER]: URL_OF(OTHER, 'woff') }),
    );
    const family = uploadedFontFamily(ID);
    expect(family).toBe('Swarm Upload ab12ab12ab12');
    expect(out).toContain(
      `@font-face{font-family:'${family}';src:url('${URL_OF(ID)}') format('woff2');font-weight:100 900;font-display:swap}`,
    );
    expect(out).toContain(`src:url('${URL_OF(OTHER, 'woff')}') format('woff')`);
    expect(out.match(/@font-face\{font-family:'Swarm Upload/g)).toHaveLength(2);
    // The theme's defaults (Archivo for headings, the serif for text) follow as fallbacks, and
    // Archivo's own face comes with it so the fallback looks right too.
    expect(out).toContain(`--font-heading:'${family}','Swarm Archivo',`);
    expect(out).toContain(`--font:'${uploadedFontFamily(OTHER)}',Charter,`);
    expect(out).toContain("@font-face{font-family:'Swarm Archivo'");
    // The owner's name for the font never reaches the CSS.
    expect(out).not.toContain('Owner');
  });

  it('writes one face when both settings use the same font', () => {
    const out = css({ heading_font: ID, body_font: ID }, lookup({ [ID]: URL_OF(ID) }));
    expect(out.match(/@font-face\{font-family:'Swarm Upload/g)).toHaveLength(1);
  });

  it('falls back to the setting’s default for a font that isn’t found', () => {
    const missing = css({ heading_font: ID }, lookup({}));
    expect(missing).not.toContain('Swarm Upload');
    expect(missing).toContain("--font-heading:'Swarm Archivo',");
    // Without a lookup at all (older callers) it is the same.
    expect(css({ heading_font: ID })).toBe(missing);
  });

  it('never emits an address that isn’t a font on the site’s own /media/', () => {
    for (const url of [
      'https://fonts.example.com/media/x.woff2',
      '//evil.example/media/x.woff2',
      '/_swarm/fonts/grotesk.woff2',
      '/media/x.ttf',
      '/media/x.svg',
      "/media/x');}body{color:red}/*.woff2",
      '/media/../api/x.woff2',
      '/media/X.woff2',
      'data:font/woff2;base64,AAAA',
      '/media/x.woff2?v=1',
      ' /media/x.woff2',
    ]) {
      const out = css({ heading_font: ID }, lookup({ [ID]: url }));
      expect(out, url).not.toContain('Swarm Upload');
      expect(out, url).not.toContain(url);
      expect(out, url).toContain("--font-heading:'Swarm Archivo',");
    }
  });

  it('works for a theme’s own font settings too, with their default after', () => {
    const own: SettingDef[] = [
      ...defs,
      { id: 'quote_font', type: 'font', label: 'Quotes', default: 'mono' },
    ];
    const out = css({ quote_font: ID }, lookup({ [ID]: URL_OF(ID) }), own);
    expect(out).toContain(`--t-quote_font:'${uploadedFontFamily(ID)}','Geist Mono',`);
    expect(out).toContain(`src:url('${URL_OF(ID)}')`);
  });

  it('reaches the design’s CSS, and existing callers still work', () => {
    const { theme } = compileTheme({
      'theme.json': JSON.stringify({ name: 'T', settings: defs, sections: [] }),
      'theme.css': '.t{color:var(--ink)}',
    });
    expect(theme).not.toBeNull();
    const design = { settings: { heading_font: ID } };
    const withFont = designCss(theme!, design, undefined, lookup({ [ID]: URL_OF(ID) }));
    expect(withFont).toContain(`src:url('${URL_OF(ID)}')`);
    expect(withFont).toContain('.t{color:var(--ink)}');
    const without = designCss(theme!, design);
    expect(without).not.toContain('Swarm Upload');
    expect(without).toContain("--font-heading:'Swarm Archivo',");
  });
});
