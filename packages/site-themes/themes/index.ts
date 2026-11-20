// The built-in themes, as theme files. A site that never edited code renders these directly,
// so improvements here reach it; "Edit code" copies them into the site's design. The files live in
// themes/<id>/ and reach code through generated.ts (scripts/build-themes.mjs).
import type { ThemeFiles } from '../src/theme';
import { THEME_FILES } from './generated';

export const BUILT_IN_THEME_IDS = [
  'gate',
  'letter',
  'magazine',
  'newspaper',
  'launch',
  'night',
  'zine',
  'brief',
] as const;
type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];

interface BuiltInTheme {
  id: BuiltInThemeId;
  name: string;
  /** One line for the gallery. */
  description: string;
  files: ThemeFiles;
}

const ABOUT: Record<BuiltInThemeId, { name: string; description: string }> = {
  gate: {
    name: 'Gate',
    description:
      'One focused invitation: a large name, the promise and the form on the first screen.',
  },
  letter: {
    name: 'Letter',
    description:
      'Personal and warm: your face, a note in your words, and past issues listed like letters.',
  },
  magazine: {
    name: 'Magazine',
    description:
      'Image-led and bold: a cover, one story up close and an asymmetric grid of the rest.',
  },
  newspaper: {
    name: 'Newspaper',
    description: 'A front page: a masthead between double rules, a lead story and ruled columns.',
  },
  launch: {
    name: 'Launch',
    description:
      'A product-style landing page: the form in a panel, proof, benefits, cards and questions.',
  },
  night: {
    name: 'Night',
    description:
      'Dark and cinematic: oversized type in a soft light, the form in a frosted panel, issues on a reel.',
  },
  zine: {
    name: 'Zine',
    description:
      'Risograph print energy: overprinted spot colours, sticker badges, torn notes and stacked cards.',
  },
  brief: {
    name: 'Brief',
    description:
      'Swiss and exact: a strict grid, numbered issues, key figures set large and a ruled archive.',
  },
};

export const BUILT_IN_THEMES: Partial<Record<BuiltInThemeId, BuiltInTheme>> = Object.fromEntries(
  BUILT_IN_THEME_IDS.filter((id) => THEME_FILES[id]).map((id) => [
    id,
    { id, ...ABOUT[id], files: THEME_FILES[id] as ThemeFiles },
  ]),
);
