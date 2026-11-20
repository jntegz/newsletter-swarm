/**
 * The colours of every email Swarm writes (posts and system emails), in light and in dark, and the
 * arithmetic that keeps a publication's own colours readable. The renderer writes the light
 * colours inline and the dark ones in a `prefers-color-scheme` rule; the dark preview
 * (./dark-preview) uses the same dark values, so what it shows is what a mail app that honours the
 * rule shows.
 */

export const LIGHT = {
  page: '#fbfbfd',
  card: '#ffffff',
  /** Headings and titles. */
  ink: '#0f0f12',
  /** Running text. */
  body: '#3a3a44',
  /** Header, footer, captions. */
  muted: '#6b6b76',
  line: '#efedf6',
  /** Callouts, code, anything set slightly apart from the card. */
  soft: '#f6f5fb',
} as const;

export const DARK = {
  page: '#121214',
  card: '#1c1c1f',
  ink: '#f4f4f6',
  body: '#d9d9df',
  muted: '#a3a3ad',
  line: '#34343a',
  soft: '#26262b',
} as const;

const DEFAULT_ACCENT = '#6c4cf1';

export type Rgb = [number, number, number];

const NAMED: Record<string, string> = { black: '#000000', white: '#ffffff' };

/** A colour as numbers, or null for what can't be read (names other than these, variables). */
export function readColor(value: string): Rgb | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important$/, '');
  const hex = NAMED[v] ?? v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) {
    return [short[1], short[2], short[3]].map((d) => parseInt(`${d}${d}`, 16)) as Rgb;
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (long) return [long[1], long[2], long[3]].map((d) => parseInt(d!, 16)) as Rgb;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

export const toHex = (rgb: Rgb) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (the same) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` with a `share` (0 to 1) of `b` mixed in. */
function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return a.map((c, i) => Math.round(c + ((b[i] as number) - c) * share)) as Rgb;
}

/** A background counts as light from here up: dark mode replaces it. */
const LIGHT_BACKGROUND = 0.6;
export const isLight = (rgb: Rgb) => luminance(rgb) >= LIGHT_BACKGROUND;

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * A colour moved towards white or black, keeping its hue, until it has `ratio` contrast on
 * `background`. Returned as it is when it already does.
 */
export function readableOn(color: Rgb, background: Rgb, ratio = 4.5): Rgb {
  if (contrast(color, background) >= ratio) return color;
  const target = luminance(background) < 0.35 ? WHITE : BLACK;
  let moved = color;
  for (let i = 0; i < 20 && contrast(moved, background) < ratio; i++) {
    moved = mix(moved, target, 0.12);
  }
  return moved;
}

/** White or ink, whichever has more contrast on this background (a button's label). */
function labelOn(background: Rgb): string {
  const ink = readColor(LIGHT.ink) as Rgb;
  return contrast(WHITE, background) >= contrast(ink, background) ? '#ffffff' : LIGHT.ink;
}

/** The colours one email is drawn in. */
export interface EmailTheme {
  page: string;
  card: string;
  ink: string;
  body: string;
  muted: string;
  /** Text that sits on the page, outside the card (the footer). */
  onPage: string;
  line: string;
  soft: string;
  /** Links in running text. */
  link: string;
  button: string;
  buttonLabel: string;
}

export interface ThemeInput {
  accent?: string | null | undefined;
  page?: string | undefined;
  card?: string | undefined;
  text?: string | undefined;
}

const hex = (value: string | null | undefined): Rgb | null =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? readColor(value) : null;

/**
 * The light theme: the defaults, or the publication's colours with everything not chosen worked
 * out from them, so a dark card gets light text without anyone asking.
 */
export function emailTheme(input: ThemeInput = {}): EmailTheme {
  const accent = hex(input.accent) ?? (readColor(DEFAULT_ACCENT) as Rgb);
  const page = hex(input.page);
  const card = hex(input.card);
  const text = hex(input.text);
  const cardRgb = card ?? (readColor(LIGHT.card) as Rgb);
  const pageRgb = page ?? (readColor(LIGHT.page) as Rgb);
  const plainCard = !card || toHex(card) === LIGHT.card;

  let ink: string = LIGHT.ink;
  let body: string = LIGHT.body;
  let muted: string = LIGHT.muted;
  if (text) {
    ink = toHex(text);
    body = toHex(mix(text, cardRgb, 0.12));
    muted = toHex(readableOn(mix(text, cardRgb, 0.38), cardRgb, 4.5));
  } else if (!isLight(cardRgb)) {
    // A card that isn't light and no text colour chosen for it: whichever text reads on it.
    const dark = readColor(DARK.ink) as Rgb;
    const lightText = contrast(dark, cardRgb) >= contrast(readColor(LIGHT.ink) as Rgb, cardRgb);
    ink = lightText ? DARK.ink : LIGHT.ink;
    body = lightText ? DARK.body : LIGHT.ink;
    muted = toHex(readableOn(readColor(lightText ? DARK.muted : LIGHT.muted) as Rgb, cardRgb));
  }
  const inkRgb = readColor(ink) as Rgb;
  const onPage =
    !page || toHex(page) === LIGHT.page
      ? LIGHT.muted
      : toHex(readableOn(readColor(isLight(pageRgb) ? LIGHT.muted : DARK.muted) as Rgb, pageRgb));
  return {
    page: toHex(pageRgb),
    card: toHex(cardRgb),
    ink,
    body,
    muted,
    onPage,
    line: plainCard ? LIGHT.line : toHex(mix(cardRgb, inkRgb, 0.14)),
    soft: plainCard ? LIGHT.soft : toHex(mix(cardRgb, inkRgb, 0.06)),
    link: toHex(readableOn(accent, cardRgb, 4.5)),
    button: toHex(accent),
    buttonLabel: labelOn(accent),
  };
}

/**
 * The dark theme for a light one, or null when the email is already dark (a dark card someone
 * chose stays as chosen in every colour scheme).
 */
export function darkTheme(light: EmailTheme, input: ThemeInput = {}): EmailTheme | null {
  const card = readColor(light.card) as Rgb;
  if (!isLight(card)) return null;
  const page = readColor(light.page) as Rgb;
  const accent = hex(input.accent) ?? (readColor(DEFAULT_ACCENT) as Rgb);
  const darkCard = readColor(DARK.card) as Rgb;
  // An accent too close to the dark card (navy, black) would make the button vanish.
  const button = contrast(accent, darkCard) < 1.6 ? readableOn(accent, darkCard, 4.5) : accent;
  return {
    // A dark page around a light card was a choice: it stays.
    page: isLight(page) ? DARK.page : light.page,
    card: DARK.card,
    ink: DARK.ink,
    body: DARK.body,
    muted: DARK.muted,
    onPage: DARK.muted,
    line: DARK.line,
    soft: DARK.soft,
    link: toHex(readableOn(accent, darkCard, 4.5)),
    button: toHex(button),
    buttonLabel: labelOn(button),
  };
}

/**
 * The dark-mode rules for the classes the renderers write (`sw-…`), as two stylesheets: the
 * `prefers-color-scheme` rule (Apple Mail, iOS Mail, Outlook for Mac and the mobile Outlook apps),
 * and the `[data-ogsc]` / `[data-ogsb]` form Outlook.com and the Outlook apps look for when they
 * recolour an email themselves. Two elements, so a client that drops one keeps the other.
 */
export function darkCss(light: EmailTheme, dark: EmailTheme): { media: string; outlook: string } {
  const text: [string, string][] = [
    ['.sw-h', dark.ink],
    ['.sw-t', dark.body],
    ['.sw-m', dark.muted],
    ['.sw-f', dark.onPage],
    ['.sw-a', dark.link],
  ];
  const background: [string, string][] = [
    ['.sw-body,.sw-page', dark.page],
    ['.sw-card', dark.card],
    ['.sw-soft', dark.soft],
  ];
  if (dark.button !== light.button) {
    background.push(['.sw-btn', dark.button]);
    text.push(['.sw-button', dark.buttonLabel]);
  }
  // The bar of a quote or a callout follows the button: an accent lost on the dark card is lifted.
  const bar = dark.button !== light.button ? `.sw-bar{border-color:${dark.button}!important}` : '';
  const borders = `.sw-card,.sw-line{border-color:${dark.line}!important}${bar}`;
  const rule = (prefix: string, [selector, value]: [string, string], property: string) =>
    `${selector
      .split(',')
      .map((s) => `${prefix}${s}`)
      .join(',')}{${property}:${value}!important}`;
  const media = [
    ...background.map((r) => rule('', r, 'background')),
    borders,
    ...text.map((r) => rule('', r, 'color')),
  ].join('');
  const outlook = [
    ...background.map((r) => rule('[data-ogsb] ', r, 'background')),
    ...text.map((r) => rule('[data-ogsc] ', r, 'color')),
    `[data-ogsc] .sw-card,[data-ogsc] .sw-line{border-color:${dark.line}!important}`,
    bar.replace('.sw-bar', '[data-ogsc] .sw-bar'),
  ].join('');
  return { media: `@media (prefers-color-scheme:dark){${media}}`, outlook };
}
