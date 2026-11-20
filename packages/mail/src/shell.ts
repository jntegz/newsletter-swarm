/**
 * The frame every Swarm email is built in: the document head, the page and card tables, the
 * preheader and the button. Posts (./render) and system emails (./system-mail) both use it, so
 * they behave the same in the places email breaks:
 *
 * - Outlook on Windows draws with Word. It ignores max-width, padding on links and inherited
 *   fonts, so the card sits in a fixed-width table only Outlook sees (the `<!--[if mso]>`
 *   comments), buttons carry their padding on the cell (`mso-padding-alt`), and an Outlook-only
 *   stylesheet names a font it has.
 * - Dark mode: the classes written here (`sw-…`) get dark colours from ./palette, for apps that
 *   honour `prefers-color-scheme` and for Outlook's own recolouring (`[data-ogsc]`).
 * - Phones: at 620px and under, the gutters shrink so the text gets the width.
 */
import { darkCss, type EmailTheme } from './palette';

const SYSTEM_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
export const EMAIL_FONTS = {
  system: SYSTEM_FONT,
  serif: `Georgia,'Times New Roman',Times,serif`,
  mono: `Menlo,Consolas,'Courier New',monospace`,
} as const;
type EmailFont = keyof typeof EMAIL_FONTS;

/** What Outlook on Windows is told to use: it does not walk a font list the way browsers do. */
const MSO_FONTS: Record<EmailFont, string> = {
  system: `'Segoe UI',Arial,sans-serif`,
  serif: `Georgia,'Times New Roman',serif`,
  mono: `Consolas,'Courier New',monospace`,
};

export type TextDirection = 'ltr' | 'rtl';

const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/g;
const LETTERS = /\p{L}/gu;

/** 'rtl' when most of the letters are Hebrew or Arabic script, else 'ltr'. */
export function directionOf(text: string): TextDirection {
  const sample = text.slice(0, 4000);
  const rtl = sample.match(RTL_CHARS)?.length ?? 0;
  if (!rtl) return 'ltr';
  const letters = sample.match(LETTERS)?.length ?? 0;
  return rtl * 2 > letters ? 'rtl' : 'ltr';
}

const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The inbox preview line: hidden in the message, and followed by invisible padding so mail apps
 * don't pull body text in after it. `text` may hold merge tags; it is escaped here.
 */
export function preheaderHtml(text: string): string {
  const value = text.trim();
  if (!value) return '';
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escape(value)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`;
}

/**
 * A button that survives every client: a table cell carries the colour (and, in Outlook, the
 * padding), the link inside carries the padding everywhere else, so the whole pill is tappable
 * and at least 44px tall. Outlook on Windows shows it with square corners.
 * `href` and `label` must already be escaped (or be placeholders).
 */
export function emailButton(input: {
  href: string;
  label: string;
  theme: Pick<EmailTheme, 'button' | 'buttonLabel'>;
  margin?: string;
}): string {
  const { theme } = input;
  return `<div style="margin:${input.margin ?? '8px 0 24px'}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td class="sw-btn" align="center" bgcolor="${theme.button}" style="background:${theme.button};border-radius:999px;mso-padding-alt:13px 24px"><a class="sw-button" href="${input.href}" style="display:inline-block;padding:13px 24px;font-size:15px;line-height:20px;font-weight:600;color:${theme.buttonLabel};text-decoration:none;border-radius:999px">${input.label}</a></td></tr></table></div>`;
}

interface ShellInput {
  /** The document title, as text. */
  title: string;
  /** BCP 47 language of the words; 'en' when absent or malformed. */
  lang?: string | null | undefined;
  dir?: TextDirection | undefined;
  font?: EmailFont | undefined;
  theme: EmailTheme;
  /** The dark theme, or null for an email that keeps its colours in dark mode. */
  dark: EmailTheme | null;
  /** The card's width in px. */
  width: number;
  /** Hidden preview text, from preheaderHtml. */
  preheader?: string;
  /** Table rows (`<tr>…</tr>`) of the card. */
  rows: string;
  /** What sits under the card, on the page: HTML for one cell. Empty for nothing. */
  footer?: string;
  /** Appended after everything visible (the open pixel placeholder). */
  tail?: string;
}

/** Padding of the card's cells, sideways: wide on a desktop, tighter on a phone. */
export const CARD_GUTTER = 32;
const PHONE_GUTTER = 20;

/** The `<body>` of an email. Kept apart from the head so a stylesheet can be placed into it. */
export function shellBody(input: ShellInput): string {
  const { theme, width } = input;
  const dir = input.dir ?? 'ltr';
  const font = EMAIL_FONTS[input.font ?? 'system'];
  const start = dir === 'rtl' ? 'right' : 'left';
  const rtl = dir === 'rtl' ? ' dir="rtl"' : '';
  const footer = input.footer
    ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${rtl} style="max-width:${width}px;margin:0 auto"><tr><td class="sw-footer sw-f" align="${start}" style="padding:20px ${CARD_GUTTER}px 8px;font-family:${font};font-size:12px;line-height:1.6;color:${theme.onPage};text-align:${start}">${input.footer}</td></tr></table>`
    : '';
  return `<body class="sw-body"${rtl} style="margin:0;padding:0;width:100%;background:${theme.page};font-family:${font};color:${theme.ink};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">${input.preheader ?? ''}
<table class="sw-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${theme.page}"${rtl} style="background:${theme.page}"><tr><td class="sw-wrap" align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="${width}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table class="sw-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${theme.card}"${rtl} style="max-width:${width}px;margin:0 auto;background:${theme.card};border:1px solid ${theme.line};border-radius:16px;border-collapse:separate">
${input.rows}
</table>${footer}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>${input.tail ?? ''}</body></html>`;
}

/**
 * The document up to `</head>`. `styles` are extra stylesheets, each in its own `<style>`
 * element after the built-in ones, so they win where they overlap.
 */
export function shellHead(
  input: Pick<ShellInput, 'title' | 'lang' | 'dir' | 'font' | 'theme' | 'dark'> & {
    /** Rules for the phone media query, on top of the gutters. */
    phoneCss?: string;
    styles?: readonly string[];
  },
): string {
  const lang = input.lang && LANG.test(input.lang) ? input.lang : 'en';
  const dir = input.dir ?? 'ltr';
  const mso = MSO_FONTS[input.font ?? 'system'];
  const g = PHONE_GUTTER;
  const base =
    ':root{color-scheme:light dark;supported-color-schemes:light dark}' +
    'body{margin:0;padding:0}' +
    '.sw-footer a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}' +
    `@media (max-width:620px){.sw-wrap{padding:12px 8px!important}.sw-header{padding:22px ${g}px 0!important}.sw-content{padding:16px ${g}px 8px!important}.sw-footer{padding:16px ${g}px 8px!important}${input.phoneCss ?? ''}}`;
  const dark = input.dark ? darkCss(input.theme, input.dark) : null;
  const styles = [base, ...(dark ? [dark.media, dark.outlook] : []), ...(input.styles ?? [])];
  return `<!doctype html><html lang="${lang}" dir="${dir}" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(input.title)}</title><!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>td,th,p,a,li,h1,h2,h3,blockquote{font-family:${mso};mso-line-height-rule:exactly}pre,code{font-family:Consolas,'Courier New',monospace}ul,ol{margin-left:24px!important}</style><![endif]-->${styles
    .filter(Boolean)
    .map((css) => `<style>${css}</style>`)
    .join('')}</head>`;
}
