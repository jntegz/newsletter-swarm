/**
 * The dark view of the email preview: an approximation of the forced dark colours many mail apps
 * apply, worked out from the inline styles of the rendered email. Real apps differ from each other
 * and from this. It runs on the HTML a writer is about to send and never changes what is sent.
 *
 * The rules:
 * - Light backgrounds turn dark. Dark and strong backgrounds, like a button's, stay as they are.
 * - Text in the email's own design colours, and links, are made readable, as apps do for ordinary
 *   text.
 * - Other dark text with no background of its own stays as written, because some apps leave it
 *   alone and it then disappears. That is the problem a writer needs to see, so it is also listed
 *   in `problems`. Raw HTML and custom CSS are where it comes from.
 * - Images are untouched, so a logo with a transparent background shows what it would really do.
 */
import { DARK, LIGHT, isLight, luminance, readColor, readableOn, toHex, type Rgb } from './palette';

interface DarkEmail {
  html: string;
  /** The opening words of each piece of text that stays dark on a dark background. */
  problems: string[];
}

const PAGE = DARK.page;
const SURFACE = DARK.card;
const LINE = DARK.line;
const TEXT = DARK.body;

/**
 * The colours the email renderer writes itself, and what its own dark-mode rules turn them into
 * (./palette), so this view and a mail app that honours those rules agree.
 */
const DESIGN_TEXT = new Map<string, string>([
  [LIGHT.ink, DARK.ink],
  [LIGHT.body, DARK.body],
  [LIGHT.muted, DARK.muted],
]);
/** Layout cells of the email: a colour set here is the design's, whatever it is. */
const DESIGN_CLASS = /\bsw-(?:content|header|footer|card)\b/;
/** The renderer's text classes, and the dark colour its stylesheet gives each. */
const TEXT_CLASS: [RegExp, string][] = [
  [/\bsw-h\b/, DARK.ink],
  [/\bsw-t\b/, DARK.body],
  [/\bsw-[mf]\b/, DARK.muted],
];
const SOFT_CLASS = /\bsw-soft\b/;

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Below this, text can't be read on the dark surface. */
const DARK_TEXT = 0.1;

/** A coloured text lifted until it reads on the dark surface, keeping its hue. */
function lift(rgb: Rgb): string {
  if (luminance(rgb) >= 0.3) return toHex(rgb);
  const spread = Math.max(...rgb) - Math.min(...rgb);
  if (spread < 24) return TEXT;
  return toHex(readableOn(rgb, readColor(SURFACE) as Rgb, 4.5));
}

interface Frame {
  tag: string;
  /** Inside the card: its background is the surface, outside it the page. */
  card: boolean;
  /** Inside the post's body, where raw HTML goes. */
  content: boolean;
  /** Inside a link, whose colour apps treat as a link's. */
  link: boolean;
  /** A background set inside the body gives the text in it something to sit on. */
  backed: boolean;
}

function darkenBackground(value: string, card: boolean, soft = false): string {
  const rgb = readColor(value);
  if (!rgb || !isLight(rgb)) return value;
  return soft ? DARK.soft : card ? SURFACE : PAGE;
}

/** One element's inline colours rewritten, the frame it opens, and whether its text is lost. */
function styleElement(
  tag: string,
  attrs: string,
  parent: Frame | undefined,
): { attrs: string; frame: Frame; unreadable: boolean } {
  const classes = /\sclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
  const design = DESIGN_CLASS.test(classes);
  const card = (parent?.card ?? false) || /\bsw-card\b/.test(classes);
  const content = parent?.content ?? false;
  const frame: Frame = {
    tag,
    card,
    content: content || /\bsw-content\b/.test(classes),
    link: (parent?.link ?? false) || tag === 'a',
    backed: parent?.backed ?? false,
  };
  let unreadable = false;
  let out = attrs;
  const bgAttr = /\sbgcolor\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
  if (bgAttr) {
    if (content) frame.backed = true;
    const dark = darkenBackground(bgAttr, card, SOFT_CLASS.test(classes));
    out = out.replace(/(\sbgcolor\s*=\s*["']?)[^"'\s>]+/i, (_, start: string) => `${start}${dark}`);
  }
  const match = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  if (!match) return { attrs: out, frame, unreadable };

  const declarations = (match[2] ?? match[3] ?? '').split(';').map((part) => {
    const colon = part.indexOf(':');
    return colon === -1
      ? { prop: '', value: part }
      : { prop: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1) };
  });
  const isBackground = (prop: string) => prop === 'background' || prop === 'background-color';
  if (content && declarations.some((d) => isBackground(d.prop) && d.value.trim())) {
    frame.backed = true;
  }
  const rewritten = declarations.map(({ prop, value }) => {
    if (!prop) return value;
    if (isBackground(prop)) {
      return `${prop}:${darkenBackground(value, card, SOFT_CLASS.test(classes))}`;
    }
    if (prop.startsWith('border')) {
      const border = value.replace(/#[0-9a-f]{3,6}\b/gi, (hex) => {
        const rgb = readColor(hex);
        return rgb && isLight(rgb) ? LINE : hex;
      });
      return `${prop}:${border}`;
    }
    if (prop !== 'color') return `${prop}:${value}`;
    const rgb = readColor(value);
    if (!rgb) return `${prop}:${value}`;
    // A button's label was chosen to read on the button, which keeps its colour.
    if (/\bsw-button\b/.test(classes)) return `${prop}:${value}`;
    const classed = TEXT_CLASS.find(([pattern]) => pattern.test(classes))?.[1];
    if (classed && luminance(rgb) < 0.3) return `${prop}:${classed}`;
    const known = DESIGN_TEXT.get(toHex(rgb));
    if (known) return `${prop}:${known}`;
    const own = design || tag === 'body' || frame.link;
    if (!own && !frame.backed && luminance(rgb) < DARK_TEXT) {
      unreadable = true;
      return `${prop}:${value}`;
    }
    return `${prop}:${lift(rgb)}`;
  });
  const style = rewritten.join(';').replace(/"/g, '&quot;');
  out = out.replace(match[0], () => `${match[1]}"${style}"`);
  return { attrs: out, frame, unreadable };
}

/** A comment (copied as it is: Outlook's conditional markup lives in them), or a tag. */
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
/** The email's own dark-mode rules, which this view turns on whatever the screen is set to. */
const DARK_MEDIA = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
const SNIPPET = 48;

/** The email's HTML with forced dark colours, and the text that stays hard to read. */
export function darkEmail(html: string): DarkEmail {
  const problems: string[] = [];
  const stack: Frame[] = [];
  let out = '';
  let last = 0;
  /** Elements whose text is being collected, as the depth of the stack they opened at. */
  let watching: { depth: number; text: string } | null = null;
  const finishWatch = () => {
    if (!watching) return;
    const text = watching.text
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      problems.push(text.length > SNIPPET ? `${text.slice(0, SNIPPET).trimEnd()}…` : text);
    }
    watching = null;
  };

  for (let match = TAG.exec(html); match; match = TAG.exec(html)) {
    const between = html.slice(last, match.index);
    out += between;
    if (watching) watching.text += between;
    last = match.index + match[0].length;
    if (match[2] === undefined) {
      out += match[0];
      continue;
    }
    const closing = match[1] === '/';
    const tag = (match[2] ?? '').toLowerCase();
    const attrs = match[3] ?? '';

    if (closing) {
      out += match[0];
      const at = stack.map((frame) => frame.tag).lastIndexOf(tag);
      if (at !== -1) {
        stack.length = at;
        if (watching && stack.length <= watching.depth) finishWatch();
      }
      continue;
    }
    if (tag === 'style' || tag === 'title' || tag === 'script') {
      const end = html.toLowerCase().indexOf(`</${tag}>`, last);
      const stop = end === -1 ? html.length : end;
      const inner = html.slice(last, stop);
      out += match[0] + (tag === 'style' ? inner.replace(DARK_MEDIA, '@media all') : inner);
      last = stop;
      TAG.lastIndex = stop;
      continue;
    }
    if (tag === 'meta' && /name\s*=\s*["']?(?:color-scheme|supported-color-schemes)/i.test(attrs)) {
      // Tells the frame to draw its own parts dark too.
      out += match[0].replace(/content\s*=\s*["'][^"']*["']/i, 'content="dark"');
      continue;
    }
    const styled = styleElement(tag, attrs, stack[stack.length - 1]);
    out += `<${match[2]}${styled.attrs}>`;
    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;
    stack.push(styled.frame);
    if (styled.unreadable && !watching) watching = { depth: stack.length - 1, text: '' };
  }
  out += html.slice(last);
  if (watching) finishWatch();
  return { html: out, problems };
}
