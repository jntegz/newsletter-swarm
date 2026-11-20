// The site fonts, so the studio can show each font's name in its own face. Grotesk and Archivo are
// the files the site serves itself; Geist comes from the dashboard's own packages. Loaded only when
// the studio opens, and only the faces actually drawn are fetched.
//
// Uploaded fonts are drawn under the family the site uses for them (uploadedFonts.ts).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { FONT_STACKS, isMediaId, type FontId } from '@swarm/site-themes';
import archivo from '../../../../design/2026-11/fonts/archivo-latin-standard-normal.woff2?url';
import grotesk from '../../../../design/2026-11/fonts/schibsted-grotesk-latin-wght-normal.woff2?url';
import { uploadedStack } from './uploadedFonts';

const FACES: [family: string, url: string, weight: string][] = [
  ['Swarm Grotesk', grotesk, '400 900'],
  ['Swarm Archivo', archivo, '100 900'],
];

let added = false;

/** Adds the site's own font faces to the dashboard, once. */
export function addSiteFonts() {
  if (added || typeof FontFace === 'undefined') return;
  added = true;
  for (const [family, url, weight] of FACES) {
    document.fonts.add(new FontFace(family, `url(${url}) format('woff2')`, { weight }));
  }
}

const DASHBOARD_FACES: Partial<Record<FontId, string>> = {
  geist: "'Geist Variable','Geist',system-ui,sans-serif",
  mono: "'Geist Mono Variable','Geist Mono',ui-monospace,monospace",
};

/** The CSS font stack that draws a font's name in its own face here. */
export const fontStack = (id: string) =>
  isMediaId(id)
    ? uploadedStack(id)
    : (DASHBOARD_FACES[id as FontId] ?? FONT_STACKS[id as FontId] ?? 'inherit');
