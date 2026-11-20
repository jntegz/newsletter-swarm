// Consent text on signup forms: plain text plus a small set of tags, so a writer can link to a
// privacy policy. Forms collect email addresses on public pages, so this never passes HTML through:
// only the tags below become tags, links always open in a new window, and everything else shows as
// the text it is. The renderers rely on this alone, whatever is stored.

const FORMATTING = new Set(['b', 'strong', 'i', 'em']);
const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s[^<>]*)?)\s*(\/?)>/gi;
const ATTRIBUTE = /\s+([a-z][a-z-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
const LOOKS_LIKE_TAG = /<\/?[a-z!]/i;

const escapeText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** The address of an `<a>` tag's attributes, cleaned, or null when it can't be used. */
function linkAddress(attributes: string): string | null {
  let href: string | null = null;
  let end = 0;
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match.index !== end) return null;
    end = match.index + match[0].length;
    if (match[1]!.toLowerCase() === 'href') href = match[2] ?? match[3] ?? match[4] ?? null;
  }
  if (attributes.slice(end).trim() || !href) return null;
  try {
    const url = new URL(href.replace(/&amp;/gi, '&'));
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function parse(text: string): { html: string; problem: string | null } {
  let html = '';
  let problem: string | null = null;
  let position = 0;
  const open: string[] = [];
  const plain = (raw: string) => {
    html += escapeText(raw);
    if (LOOKS_LIKE_TAG.test(raw)) problem ??= 'A tag here isn’t finished.';
  };
  const literal = (raw: string, why: string) => {
    html += escapeText(raw);
    problem ??= why;
  };

  for (const match of text.matchAll(TAG)) {
    const [raw, slash, rawName, rawAttributes, directClose] = match;
    const name = rawName!.toLowerCase();
    // `<br />` reaches here with the slash among its attributes.
    const attributes = rawAttributes!.replace(/\s+\/$/, '');
    const selfClose = !!directClose || attributes !== rawAttributes;
    plain(text.slice(position, match.index));
    position = match.index + raw.length;

    if (name === 'br' && !slash && !attributes.trim()) {
      html += '<br>';
    } else if (slash) {
      // Closing tags take no attributes; anything else stays text.
      if (!attributes.trim() && open.at(-1) === name) {
        open.pop();
        html += `</${name}>`;
      } else {
        literal(raw, `</${name}> has no matching opening tag.`);
      }
    } else if (selfClose) {
      literal(raw, `<${name}/> can't be used here.`);
    } else if (FORMATTING.has(name) && !attributes.trim()) {
      open.push(name);
      html += `<${name}>`;
    } else if (name === 'a' && !open.includes('a')) {
      const address = linkAddress(attributes);
      if (address) {
        open.push('a');
        html += `<a href="${escapeText(address)}" target="_blank" rel="noopener noreferrer">`;
      } else {
        literal(raw, 'A link needs an href that starts with https://, http:// or mailto:.');
      }
    } else {
      literal(raw, `Use only <a href="…">, <b>, <strong>, <i>, <em> and <br>, not <${name}>.`);
    }
  }
  plain(text.slice(position));
  if (open.length) problem ??= `<${open.at(-1)}> needs a closing tag.`;
  // Always balanced, so a form's own markup can't end up inside a link.
  while (open.length) html += `</${open.pop()}>`;
  return { html, problem };
}

/** Safe HTML for a consent checkbox's label. One element, because the label lays out as a row. */
export const consentHtml = (text: string): string => `<span>${parse(text).html}</span>`;

/** What is wrong with consent text a writer entered, or null. Plain text is always fine. */
export const consentHtmlProblem = (text: string): string | null => parse(text).problem;
