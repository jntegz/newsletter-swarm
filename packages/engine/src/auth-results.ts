/**
 * What Cloudflare Email Routing authenticated about a message it hands to an Email Worker.
 *
 * Email Routing checks SPF, DKIM and DMARC before the Worker runs and prepends an
 * Authentication-Results header (RFC 8601) with authserv-id mx.cloudflare.net. Only that first
 * header is read: any other Authentication-Results header, including a later one that names
 * mx.cloudflare.net, may have been written by the sender.
 *
 * Email Routing echoes the envelope MAIL FROM, which the sender chooses, in the SPF result's
 * comment and in smtp.mailfrom. So the header is read strictly: it must have the shape Email
 * Routing writes (its DKIM results first, then DMARC and SPF once each) with plain values, or
 * nothing in it is trusted.
 */

/** The authserv-id Email Routing puts on the header it adds. */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

export interface AuthenticatedDomains {
  /** The domain of smtp.mailfrom (or, without one, smtp.helo) when SPF passed. */
  spf?: string;
  /** The header.d of every DKIM signature that passed. */
  dkim: string[];
}

const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
/** method[/version]=result: the first word of each result. */
const METHODSPEC = /^([a-z0-9-]+)(?:\/[0-9]+)?=([a-z]+)$/;
/** ptype.property=value: every other word of a result. */
const PROPERTY = /^([a-z]+\.[a-z0-9-]+)=(.*)$/i;
/** What a value may hold: an address, a domain, an IP address or a base64 signature. */
const VALUE = /^[\w.@+=/:-]*$/;

/**
 * Whether the envelope sender (message.from) is free of anything that could change how the
 * header it is echoed into reads: parentheses, quotes, ';', '\', ',', white space or control
 * characters. Nothing is trusted about a message whose sender has any of these.
 */
export function isPlainEnvelopeSender(from: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[()";\\,\s\u0000-\u001f\u007f]/.test(from);
}

/** The domain of an address or a bare domain, lowercased; undefined if it isn't one. */
function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const domain = value
    .slice(value.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return domain.length <= 253 && DOMAIN.test(domain) ? domain : undefined;
}

/**
 * The first header's value split into its ';'-separated parts, each a list of words such as
 * `dkim=pass` or `header.d=google.com`, with comments dropped, quoted strings unquoted and the
 * white space RFC 8601 allows around '=' removed. A Headers object joins repeated headers with
 * ", ", and RFC 8601 has no bare comma, so the first header ends at the first comma. null when
 * the value is malformed (an unclosed comment or quote) or can't be split safely.
 */
function tokenize(value: string): string[][] | null {
  const parts: string[][] = [[]];
  let word = '';
  // After '=', the value still belongs to this word, whatever white space or comment comes first.
  let joining = false;
  let depth = 0;
  let quoted = false;
  // A quoted string in a comment, such as an echoed "local part": a ')' in it doesn't end it.
  let quotedInComment = false;
  const current = () => parts[parts.length - 1]!;
  const end = () => {
    if (word && !joining) {
      current().push(word);
      word = '';
    }
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    // A comma in a comment or quoted string may be where the next header was joined on, after
    // a '(' or '"' the sender slipped into this one; the value can't be read safely then.
    if (ch === ',' && (quoted || depth > 0)) return null;
    if (ch === '\\' && (quoted || depth > 0)) {
      if (value[i + 1] === ',') return null;
      if (quoted) word += value[i + 1] ?? '';
      i++;
    } else if (quoted) {
      if (ch === '"') quoted = false;
      else word += ch;
    } else if (depth > 0) {
      if (ch === '"') quotedInComment = !quotedInComment;
      else if (quotedInComment) continue;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    } else if (ch === '(') {
      end();
      depth = 1;
    } else if (ch === ',') {
      break;
    } else if (ch === ';') {
      joining = false;
      end();
      parts.push([]);
    } else if (/\s/.test(ch)) {
      end();
    } else if (ch === '=') {
      if (!word) word = current().pop() ?? '';
      word += ch;
      joining = true;
    } else {
      if (ch === '"') quoted = true;
      else word += ch;
      joining = false;
    }
  }
  if (quoted || depth > 0) return null;
  joining = false;
  end();
  return parts;
}

/**
 * The domains Email Routing authenticated, from the message's headers. Nothing is authenticated
 * when the first Authentication-Results header is missing, malformed, from anyone else, or not
 * in the shape Email Routing writes.
 */
export function authenticatedDomains(
  headers: Pick<Headers, 'get'> | null | undefined,
): AuthenticatedDomains {
  const value = headers?.get('authentication-results');
  const parts = value ? tokenize(value) : null;
  if (!parts) return { dkim: [] };
  const [authserv, ...results] = parts;
  if (authserv?.[0]?.toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) return { dkim: [] };

  const dkim: string[] = [];
  let spf: string | undefined;
  const seen = new Set<string>();
  for (const words of results) {
    if (words.length === 0) continue;
    // methodspec first: method[/version]=result. Properties follow as ptype.property=value.
    const spec = METHODSPEC.exec(words[0]!.toLowerCase());
    if (!spec) return { dkim: [] };
    const name = spec[1]!;
    const result = spec[2]!;
    const props = new Map<string, string>();
    for (const word of words.slice(1)) {
      const [, key, prop] = PROPERTY.exec(word) ?? [];
      // A stray word, a property given twice or an odd value: something got out of a comment.
      if (!key || prop === undefined || props.has(key.toLowerCase()) || !VALUE.test(prop)) {
        return { dkim: [] };
      }
      props.set(key.toLowerCase(), prop);
    }
    // Email Routing writes its DKIM results before its DMARC and SPF ones, each of those once.
    // Any other order means someone else wrote part of the header.
    if (name === 'dkim' && (seen.has('dmarc') || seen.has('spf'))) return { dkim: [] };
    if ((name === 'dmarc' || name === 'spf') && seen.has(name)) return { dkim: [] };
    seen.add(name);
    if (result !== 'pass') continue;
    if (name === 'dkim') {
      // header.d is a bare domain, and header.i, when given, is it or under it (RFC 6376).
      const d = props.get('header.d')?.toLowerCase().replace(/\.$/, '');
      if (!d || d.length > 253 || !DOMAIN.test(d)) return { dkim: [] };
      const i = props.get('header.i');
      const iDomain = i === undefined ? d : i.includes('@') ? domainOf(i) : undefined;
      if (!iDomain || (iDomain !== d && !iDomain.endsWith(`.${d}`))) return { dkim: [] };
      if (!dkim.includes(d)) dkim.push(d);
    } else if (name === 'spf') {
      // SPF checks MAIL FROM, or HELO when the sender is empty (as for most bounces).
      const mailfrom = props.get('smtp.mailfrom');
      spf = mailfrom ? domainOf(mailfrom) : domainOf(props.get('smtp.helo'));
    }
  }
  return spf ? { spf, dkim } : { dkim };
}
