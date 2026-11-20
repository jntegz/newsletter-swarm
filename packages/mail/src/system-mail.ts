/**
 * System emails: sign-in links, confirmations, receipts, invites, security notices. One heading,
 * a few short paragraphs, at most one button. They use the same frame as posts (./shell), so the
 * first email anyone gets from a Swarm holds up in Outlook, on a phone and in dark mode.
 */
import { darkTheme, emailTheme } from './palette';
import { EMAIL_FONTS, emailButton, preheaderHtml, shellBody, shellHead } from './shell';

/** Plain text (escaped here), or HTML the caller built and escaped itself. */
type SystemParagraph = string | { html: string };

export interface SystemEmailInput {
  /** The document title; the subject line is the usual choice. */
  title: string;
  /** The small line above the heading: the publication's or the product's name. */
  brand: string;
  /** The button's colour; the default accent when absent or not a hex colour. */
  accent?: string | null;
  heading: string;
  paragraphs: readonly SystemParagraph[];
  button?: { label: string; url: string } | null;
  /** Small print under the button. */
  footnote?: SystemParagraph | null;
  /** The inbox preview line. Defaults to the first paragraph. */
  preheader?: string;
  /** A line under the card, on the page. */
  footer?: string | null;
  lang?: string | null;
}

const CARD_WIDTH = 480;

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const inner = (part: SystemParagraph) => (typeof part === 'string' ? escape(part) : part.html);

const plain = (part: SystemParagraph | undefined) =>
  part === undefined
    ? ''
    : typeof part === 'string'
      ? part
      : part.html
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');

/** A paragraph that is one link, written out: for notices that list an address to open. */
export function systemLink(url: string, accent?: string | null): { html: string } {
  const { link } = emailTheme({ accent });
  return {
    html: `<a class="sw-a" href="${escape(url)}" style="color:${link};text-decoration:underline;word-break:break-all">${escape(url)}</a>`,
  };
}

/** The HTML of a system email. The caller writes the plain-text part. */
export function systemEmail(input: SystemEmailInput): string {
  const themeInput = { accent: input.accent };
  const theme = emailTheme(themeInput);
  const family = EMAIL_FONTS.system;
  const paragraphs = input.paragraphs.map(
    (part) =>
      `<p class="sw-t" style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${theme.body}">${inner(part)}</p>`,
  );
  const button = input.button
    ? emailButton({
        href: escape(input.button.url),
        label: escape(input.button.label),
        theme,
        margin: '8px 0 0',
      })
    : '';
  const footnote = input.footnote
    ? `<p class="sw-m" style="margin:24px 0 0;font-size:13px;line-height:1.5;color:${theme.muted}">${inner(input.footnote)}</p>`
    : '';
  const shell = {
    title: input.title,
    lang: input.lang,
    theme,
    dark: darkTheme(theme, themeInput),
    width: CARD_WIDTH,
  } as const;
  const body = shellBody({
    ...shell,
    preheader: preheaderHtml(input.preheader ?? plain(input.paragraphs[0])),
    rows: `<tr><td class="sw-content sw-h" align="left" style="padding:32px;font-family:${family};font-size:15px;line-height:1.55;color:${theme.ink};text-align:left"><p class="sw-m" style="margin:0 0 16px;font-size:13px;line-height:1.5;font-weight:600;letter-spacing:0.02em;color:${theme.muted}">${escape(input.brand)}</p>
<h1 class="sw-h" style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:${theme.ink}">${escape(input.heading)}</h1>
${paragraphs.join('\n')}
${button}${footnote}</td></tr>`,
    footer: input.footer ? escape(input.footer) : '',
  });
  const head = shellHead({
    ...shell,
    phoneCss: '.sw-content{padding:24px 20px!important}',
  });
  return `${head}\n${body}`;
}
