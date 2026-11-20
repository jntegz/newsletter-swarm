import type { MediaAsset } from '@swarm/domain';
import { designCss, compileTheme, standardSettings, uploadedFontFamily } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import { fontFileProblem, fontNameFromFile } from '../pages/FontUpload';
import { fontStack } from './fonts';
import { fontLookupOf, uploadedFamily, uploadedFontName } from './uploadedFonts';

const ID = `md_${'ab12'.repeat(8)}`;
const font = (fields: Partial<MediaAsset> = {}): MediaAsset => ({
  id: ID,
  channelId: `ch_${'2'.repeat(32)}`,
  contentType: 'font/woff2',
  kind: 'font',
  bytes: 4000,
  width: null,
  height: null,
  altText: 'Brand Sans',
  focalPoint: null,
  url: `https://media.example/media/ws/ws_${'1'.repeat(32)}/ch/ch_${'2'.repeat(32)}/${ID}.woff2`,
  createdAt: new Date(0).toISOString(),
  ...fields,
});

describe('uploaded fonts in the dashboard', () => {
  it('draws a font under the family the site uses for it', () => {
    expect(uploadedFamily(ID)).toBe(uploadedFontFamily(ID));
    expect(fontStack(ID)).toBe(`'${uploadedFontFamily(ID)}',system-ui,sans-serif`);
    expect(fontStack('grotesk')).toContain('Swarm Grotesk');
  });

  it('finds fonts at their /media/ path for the studio’s own CSS, and nothing else', () => {
    const lookup = fontLookupOf([font(), font({ id: `md_${'cd'.repeat(16)}`, kind: 'image' })]);
    expect(lookup(ID)).toEqual({ url: new URL(font().url).pathname, family: 'Brand Sans' });
    expect(lookup(`md_${'cd'.repeat(16)}`)).toBeNull();
    expect(lookup(`md_${'ef'.repeat(16)}`)).toBeNull();
    expect(fontLookupOf(undefined)(ID)).toBeNull();

    const { theme } = compileTheme({
      'theme.json': JSON.stringify({ name: 'T', settings: standardSettings(), sections: [] }),
    });
    const css = designCss(theme!, { settings: { heading_font: ID } }, undefined, lookup);
    expect(css).toContain(`src:url('${new URL(font().url).pathname}') format('woff2')`);
    expect(css).not.toContain('media.example');
  });

  it('names fonts and checks files before they are sent', () => {
    expect(uploadedFontName(font({ altText: '  ' }))).toBe('Untitled font');
    expect(fontNameFromFile('Brand-Sans_Bold.woff2')).toBe('Brand Sans Bold');
    expect(fontFileProblem({ name: 'a.woff2', size: 100 })).toBeNull();
    expect(fontFileProblem({ name: 'a.WOFF', size: 100 })).toBeNull();
    expect(fontFileProblem({ name: 'a.woff2', size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(fontFileProblem({ name: 'a.ttf', size: 100 })).toMatch(/WOFF2 or WOFF file/);
    expect(fontFileProblem({ name: 'a.png', size: 100 })).toMatch(/WOFF2 or WOFF font file/);
  });
});
