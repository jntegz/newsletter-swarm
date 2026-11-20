// Theme settings to CSS. The standard tokens set the site's own variables (so post pages and the
// archive match the home page); any other colour, number, range, select or font setting a theme
// declares becomes --t-<id> for its own CSS. Nothing here loads anything from another server:
// built-in fonts come from /_swarm/fonts/ and uploaded ones from the site's own /media/.
import { readableColor } from '@swarm/domain';
import { FONTS, isMediaId, type FontId, type SettingDef } from './settings';

const SYSTEM = "-apple-system,'Segoe UI',system-ui,'Helvetica Neue',sans-serif";
export const FONT_STACKS: Record<FontId, string> = {
  grotesk: `'Swarm Grotesk',${SYSTEM}`,
  archivo: `'Swarm Archivo',${SYSTEM}`,
  serif: "Charter,'Bitstream Charter','Iowan Old Style','Sitka Text',Cambria,Georgia,serif",
  geist: `'Geist',${SYSTEM}`,
  inter: `'Inter',${SYSTEM}`,
  system: SYSTEM,
  mono: "'Geist Mono','JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace",
};

/** Fonts the site serves itself, at /_swarm/fonts/<file>.woff2. */
const FONT_FACES: Partial<Record<FontId, string>> = {
  grotesk:
    "@font-face{font-family:'Swarm Grotesk';src:url('/_swarm/fonts/grotesk.woff2') format('woff2');font-weight:400 900;font-display:swap}",
  archivo:
    "@font-face{font-family:'Swarm Archivo';src:url('/_swarm/fonts/archivo.woff2') format('woff2');font-weight:100 900;font-display:swap}",
};

/** An uploaded font as the caller found it in the media library. */
interface UploadedFont {
  /** Where the site serves the file: a same-site path, /media/<key>.woff2 or .woff. */
  url: string;
  /** The name the owner gave it, for people; never written into the CSS. */
  family?: string | null;
}

/** Finds an uploaded font by its media id; null when it isn't (or is no longer) there. */
export type FontLookup = (id: string) => UploadedFont | null | undefined;

/** The only addresses an uploaded font is loaded from: the site's own media, a font file. */
const UPLOADED_FONT_URL = /^\/media\/[a-z0-9_/-]+\.(woff2|woff)$/;

/** The CSS family an uploaded font is drawn with: its own, so no other face can stand in for it. */
export const uploadedFontFamily = (mediaId: string) => `Swarm Upload ${mediaId.slice(3, 15)}`;

const isFontId = (value: unknown): value is FontId => FONTS.includes(value as FontId);

/**
 * A font setting's stack and the @font-face rules it needs. An uploaded font comes first, with the
 * setting's own default after it, so text still looks right while it loads or if it fails. A media
 * id the lookup can't find, or whose address isn't a font on the site's /media/, gets the default.
 */
function fontFor(
  value: unknown,
  fallback: FontId,
  lookup: FontLookup | undefined,
): { stack: string; faces: string[] } {
  if (isFontId(value)) return { stack: FONT_STACKS[value], faces: [FONT_FACES[value] ?? ''] };
  const plain = { stack: FONT_STACKS[fallback], faces: [FONT_FACES[fallback] ?? ''] };
  if (!isMediaId(value) || !lookup) return plain;
  const found = lookup(value);
  const match = found && typeof found.url === 'string' ? UPLOADED_FONT_URL.exec(found.url) : null;
  if (!match || found!.url.includes('//')) return plain;
  const family = uploadedFontFamily(value);
  const format = match[1] === 'woff2' ? 'woff2' : 'woff';
  return {
    stack: `'${family}',${plain.stack}`,
    faces: [
      `@font-face{font-family:'${family}';src:url('${found!.url}') format('${format}');font-weight:100 900;font-display:swap}`,
      ...plain.faces,
    ],
  };
}

/** The built-in font a font setting falls back to: its default when that is one, else `base`. */
const fallbackOf = (defs: SettingDef[], id: string, base: FontId): FontId => {
  const declared = defs.find((d) => d.id === id)?.default;
  return isFontId(declared) ? declared : base;
};

const STANDARD_TOKENS = [
  'accent',
  'page',
  'ink',
  'scheme',
  'heading_font',
  'body_font',
  'scale',
  'corners',
  'width',
  'buttons',
] as const;

/** The standard tokens as settings, for themes to include in theme.json (with their own defaults). */
export function standardSettings(
  defaults: Partial<Record<(typeof STANDARD_TOKENS)[number], unknown>> = {},
): SettingDef[] {
  const d = <T>(id: (typeof STANDARD_TOKENS)[number], fallback: T) =>
    (defaults[id] ?? fallback) as T;
  return [
    {
      id: 'accent',
      type: 'color',
      label: 'Accent',
      group: 'Colour',
      default: d('accent', '#2f5d50'),
      info: 'Buttons, links and highlights.',
    },
    {
      id: 'page',
      type: 'color',
      label: 'Background',
      group: 'Colour',
      default: d('page', '#fbfaf7'),
    },
    { id: 'ink', type: 'color', label: 'Text', group: 'Colour', default: d('ink', '#16181d') },
    {
      id: 'scheme',
      type: 'select',
      label: 'Light or dark',
      group: 'Colour',
      default: d('scheme', 'light'),
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'auto', label: 'Follow the reader’s device' },
      ],
    },
    {
      id: 'heading_font',
      type: 'font',
      label: 'Headings',
      group: 'Type',
      default: d('heading_font', 'grotesk'),
    },
    {
      id: 'body_font',
      type: 'font',
      label: 'Text',
      group: 'Type',
      default: d('body_font', 'geist'),
    },
    {
      id: 'scale',
      type: 'select',
      label: 'Text size',
      group: 'Type',
      default: d('scale', 'regular'),
      options: [
        { value: 'compact', label: 'Compact' },
        { value: 'regular', label: 'Regular' },
        { value: 'large', label: 'Large' },
      ],
    },
    {
      id: 'corners',
      type: 'select',
      label: 'Corners',
      group: 'Shape',
      default: d('corners', 'soft'),
      options: [
        { value: 'square', label: 'Square' },
        { value: 'soft', label: 'Soft' },
        { value: 'round', label: 'Round' },
      ],
    },
    {
      id: 'width',
      type: 'select',
      label: 'Page width',
      group: 'Shape',
      default: d('width', 'regular'),
      options: [
        { value: 'narrow', label: 'Narrow' },
        { value: 'regular', label: 'Regular' },
        { value: 'wide', label: 'Wide' },
      ],
    },
    {
      id: 'buttons',
      type: 'select',
      label: 'Buttons',
      group: 'Shape',
      default: d('buttons', 'solid'),
      options: [
        { value: 'solid', label: 'Solid' },
        { value: 'pill', label: 'Pill' },
        { value: 'outline', label: 'Outline' },
      ],
    },
  ];
}

// ---- Colour --------------------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function luminance(hex: string): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Readable text on a colour: near-black or white, whichever has more contrast. */
const onColour = (hex: string) =>
  contrast(hex, '#0f0f12') >= contrast(hex, '#ffffff') ? '#0f0f12' : '#ffffff';

/** Contrast warnings for the dashboard, in plain words. */
export function contrastWarnings(
  values: Record<string, unknown>,
  /** The theme's settings: colours marked text_on are checked against the text colour too. */
  defs: SettingDef[] = [],
): string[] {
  const out: string[] = [];
  const page = typeof values.page === 'string' ? values.page : null;
  const ink = typeof values.ink === 'string' ? values.ink : null;
  const accent = typeof values.accent === 'string' ? values.accent : null;
  if (page && ink && contrast(page, ink) < 4.5) {
    out.push(
      `Text on the background is hard to read (${contrast(page, ink).toFixed(1)}:1; aim for 4.5:1).`,
    );
  }
  // Links are text in the accent colour, so they need the text ratio.
  if (page && accent && contrast(page, accent) < 4.5) {
    out.push(
      `Links in the accent colour are hard to see on the background (${contrast(page, accent).toFixed(1)}:1; aim for 4.5:1).`,
    );
  }
  for (const def of defs) {
    const surface = values[def.id];
    if (def.type !== 'color' || !def.text_on || !ink || typeof surface !== 'string') continue;
    if (!HEX.test(surface)) continue;
    const ratio = contrast(surface, ink);
    if (ratio < 4.5) {
      out.push(
        `Text on ${def.label.toLowerCase()} is hard to read (${ratio.toFixed(1)}:1; aim for 4.5:1).`,
      );
    }
  }
  return out;
}

// ---- CSS -----------------------------------------------------------------------------------------

const SCALES = { compact: [16, 1.2], regular: [17, 1.25], large: [18, 1.3] } as const;
const CORNERS = { square: [2, 2], soft: [12, 8], round: [24, 999] } as const;
const WIDTHS = { narrow: 760, regular: 1120, wide: 1320 } as const;

const pick = <T extends Record<string, unknown>>(table: T, key: unknown, fallback: keyof T) =>
  table[(typeof key === 'string' && key in table ? key : fallback) as keyof T];

const HEX = /^#[0-9a-fA-F]{6}$/;
const colour = (v: unknown, fallback: string) =>
  typeof v === 'string' && HEX.test(v) ? v : fallback;

/** Mixes two colours in sRGB: `amount` of a, the rest b. Used for dark values. */
function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) =>
    Math.round((x * amount + y * (1 - amount)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

function palette(page: string, ink: string, accent: string): string {
  const alt = mix(ink, page, 0.04);
  return [
    `--accent:${accent}`,
    `--on-accent:${onColour(accent)}`,
    // Links are the accent, moved only as far as it takes to read as text on the page and on cards.
    `--link:${readableColor(readableColor(accent, alt, 4.6), page, 4.6)}`,
    `--page:${page}`,
    `--surface:${page}`,
    `--surface-alt:${alt}`,
    `--ink:${ink}`,
    `--text:${mix(ink, page, 0.9)}`,
    `--text-sub:${readableColor(readableColor(mix(ink, page, 0.66), alt, 4.6), page, 4.6)}`,
    `--line:${mix(ink, page, 0.12)}`,
    `--line-strong:${mix(ink, page, 0.22)}`,
    `--mark:${mix(accent, page, 0.16)}`,
    `--t-accent-soft:${mix(accent, page, 0.1)}`,
  ].join(';');
}

/**
 * The page and text colours of each scheme. A dark version turns the page and the text around,
 * unless they already are dark: then the light version is derived instead.
 */
function schemes(page: string, ink: string) {
  const pageIsDark = luminance(page) < 0.2;
  return {
    light: pageIsDark ? { page: ink, ink: page } : { page, ink },
    dark: pageIsDark
      ? { page, ink }
      : { page: mix(ink, '#000000', 0.82), ink: mix(page, '#ffffff', 0.94) },
  };
}

/** The page colour a design has in its light and dark schemes. */
export function schemePages(values: Record<string, unknown>): { light: string; dark: string } {
  const { light, dark } = schemes(colour(values.page, '#fbfaf7'), colour(values.ink, '#16181d'));
  return { light: light.page, dark: dark.page };
}

/**
 * The CSS for a set of theme settings: variables on <html>, the dark values, the fonts the site
 * serves, and the few rules that make the shape tokens reach the site's own components. The
 * variables sit on html:root, so they win over the site's own (on :root and html[data-scheme]).
 * `font` finds the uploaded fonts that font settings name by media id; without it, or for one it
 * can't find, the setting's default is used.
 */
export function tokensCss(
  defs: SettingDef[],
  values: Record<string, unknown>,
  font?: FontLookup,
): string {
  const accent = colour(values.accent, '#2f5d50');
  const page = colour(values.page, '#fbfaf7');
  const ink = colour(values.ink, '#16181d');
  const { light, dark } = schemes(page, ink);
  // Links are drawn in the accent, so on the dark page (and its raised surface) it is lightened
  // until it reads as text.
  const darkAlt = mix(dark.ink, dark.page, 0.04);
  let darkAccent = accent;
  for (const amount of [0.85, 0.7, 0.55, 0.4, 0.25]) {
    if (Math.min(contrast(dark.page, darkAccent), contrast(darkAlt, darkAccent)) >= 4.5) break;
    darkAccent = mix(accent, '#ffffff', amount);
  }

  const heading = fontFor(values.heading_font, fallbackOf(defs, 'heading_font', 'grotesk'), font);
  const body = fontFor(values.body_font, fallbackOf(defs, 'body_font', 'geist'), font);
  const faces = [...heading.faces, ...body.faces];
  const [base, ratio] = pick(SCALES, values.scale, 'regular');
  const [card, control] = pick(CORNERS, values.corners, 'soft');
  const button = values.buttons === 'pill' ? 999 : control;
  const steps = [-1, 0, 1, 2, 3, 4, 5, 6].map((n) => {
    const px = base * ratio ** n;
    // Large steps shrink on phones; small ones stay put.
    const value =
      n >= 3
        ? `clamp(${(px * 0.72).toFixed(1)}px,${(px / 12).toFixed(2)}vw + ${(px * 0.5).toFixed(1)}px,${px.toFixed(1)}px)`
        : `${px.toFixed(2)}px`;
    return `--step-${n < 0 ? 'm1' : n}:${value}`;
  });

  const custom: string[] = [];
  for (const def of defs) {
    if ((STANDARD_TOKENS as readonly string[]).includes(def.id)) continue;
    const v = values[def.id];
    if (def.type === 'color' && typeof v === 'string' && HEX.test(v))
      custom.push(`--t-${def.id}:${v}`);
    else if ((def.type === 'range' || def.type === 'number') && typeof v === 'number')
      custom.push(`--t-${def.id}:${v}${def.unit ?? ''}`);
    else if (def.type === 'font' && (isFontId(v) || isMediaId(v))) {
      const own = fontFor(v, fallbackOf(defs, def.id, 'system'), font);
      custom.push(`--t-${def.id}:${own.stack}`);
      faces.push(...own.faces);
    } else if (def.type === 'select' && typeof v === 'string' && /^[\w-]+$/.test(v))
      custom.push(`--t-${def.id}:${v}`);
  }

  const root = [
    palette(light.page, light.ink, accent),
    `--font:${body.stack}`,
    `--font-heading:${heading.stack}`,
    `--r-card:${card}px`,
    `--r-control:${control}px`,
    `--r-button:${button}px`,
    `--wrap:${pick(WIDTHS, values.width, 'regular')}px`,
    ...steps,
    ...custom,
  ].join(';');
  const darkVars = palette(dark.page, dark.ink, darkAccent);
  const scheme = values.scheme === 'dark' || values.scheme === 'auto' ? values.scheme : 'light';
  const schemeCss =
    scheme === 'dark'
      ? `html:root{${darkVars};color-scheme:dark}`
      : scheme === 'auto'
        ? `@media (prefers-color-scheme:dark){html:root{${darkVars};color-scheme:dark}}`
        : 'html:root{color-scheme:light}';
  const outline =
    values.buttons === 'outline'
      ? '.sw-button:not(.sw-ghost),button{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}'
      : '';
  return `${[...new Set(faces)].join('')}html:root{${root}}${schemeCss}
body{font-family:var(--font);font-size:var(--step-0)}
h1,h2,h3,h4{font-family:var(--font-heading)}
.sw-wrap{max-width:var(--wrap)}
.sw-narrow{max-width:min(764px,var(--wrap))}
.sw-button,button{border-radius:var(--r-button)}${outline}
`;
}
