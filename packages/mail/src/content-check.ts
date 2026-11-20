/**
 * Advice about a rendered email before it is sent: things spam filters and readers hold against a
 * message that the writer can still change. Every finding is advice, never a reason to stop a
 * send, and the limits are deliberately loose so an ordinary newsletter gets none.
 *
 * Pure: it reads the rendered email and nothing else. The pre-send checklist (engine start.ts)
 * calls it after the renderer.
 */

type ContentAdviceId =
  | 'subject_caps'
  | 'subject_punctuation'
  | 'subject_long'
  | 'subject_thin'
  | 'preview_text'
  | 'spam_phrases'
  | 'link_shortener'
  | 'link_text_mismatch'
  | 'many_links'
  | 'ip_link'
  | 'insecure_link'
  | 'image_heavy'
  | 'huge_image';

export interface ContentAdvice {
  id: ContentAdviceId;
  /** One or two plain sentences: what was found and what to do about it. */
  message: string;
}

/** The limits each check uses, in one place so the docs and the tests can name them. */
export const CONTENT_LIMITS = {
  /** A subject is "all capitals" when it has at least this many letters ... */
  capsMinLetters: 10,
  /** ... and at least this share of them are capitals. */
  capsShare: 0.8,
  /** The same mark (! ? $ and other currency signs) this many times in a row. */
  repeatedMarks: 3,
  /** Or this many exclamation marks anywhere in the subject. */
  exclamationMarks: 4,
  /** Inboxes show roughly the first 60 characters; this is well past that. */
  subjectMaxLength: 90,
  /** Fewer letters and digits than this is not really a subject. */
  subjectMinCharacters: 3,
  /** Different trigger phrases needed before saying anything: one alone is a weak signal. */
  spamPhraseHits: 3,
  /** More different links than this. A long link roundup stays under it. */
  maxLinks: 60,
  /** With at least one image, fewer words than this is "mostly images". */
  imageHeavyMaxWords: 20,
  /** Images narrower than this (a logo, an icon) are not counted as content images. */
  contentImageMinWidth: 100,
  /** One image file larger than this many bytes. */
  hugeImageBytes: 1_000_000,
} as const;

/**
 * Phrases that content filters score. Short and conservative on purpose: each is rare in honest
 * writing and common in junk mail. Matched as whole phrases, ignoring case; a warning needs
 * CONTENT_LIMITS.spamPhraseHits different ones.
 */
export const SPAM_TRIGGER_PHRASES = [
  '100% free',
  'act now',
  'buy now',
  'call now',
  'cash bonus',
  'click here now',
  'dear friend',
  'double your income',
  'earn extra cash',
  'free gift',
  'limited time offer',
  'lose weight fast',
  'lowest price',
  'make money fast',
  'money back guarantee',
  'no credit check',
  'no obligation',
  'no strings attached',
  'once in a lifetime',
  'order now',
  'risk free',
  'this is not spam',
  'what are you waiting for',
  'while supplies last',
  'work from home',
  'you are a winner',
  'you have been selected',
] as const;

/**
 * Public link shorteners. Anyone can make a link on these, spammers do, and so blocklists and
 * filters treat the whole host with suspicion. A publication's own short-link domain is not public
 * and is never on this list.
 */
export const PUBLIC_LINK_SHORTENERS = [
  'bit.ly',
  'bitly.com',
  'buff.ly',
  'cutt.ly',
  'goo.gl',
  'is.gd',
  'lnkd.in',
  'ow.ly',
  'rb.gy',
  'rebrand.ly',
  'shorturl.at',
  't.co',
  't.ly',
  'tiny.cc',
  'tinyurl.com',
  'v.gd',
] as const;

export interface ContentCheckInput {
  subject: string;
  /** The preview text (preheader); empty when there is none. */
  preheader: string;
  /** The rendered HTML document. Link placeholders ({{@link:N}}) index into `links`. */
  html: string;
  /** The rendered plain-text part. */
  text: string;
  /** Every distinct link address in the email. */
  links: readonly string[];
  /**
   * Hosts the publication itself owns, such as its own short-link domain or branded link domain.
   * Links to them are never called a public shortener or a mismatch.
   */
  ownHosts?: readonly string[];
  /** File sizes of the email's images by address, where known. Unknown images are skipped. */
  imageBytes?: ReadonlyMap<string, number>;
}

const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

/**
 * The part of a hostname someone registered: the last two labels, or three under a country's
 * second level (example.co.uk). A heuristic, not the public suffix list; good enough to tell
 * whether two hosts belong together.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [second, top] = labels.slice(-2) as [string, string];
  const take = top.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const isIpHost = (host: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
const isLocalHost = (host: string) => host === 'localhost' || host.endsWith('.localhost');

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

const decodeEntities = (value: string) =>
  value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * The host a piece of link text shows, when the text is itself a web address. Only text that
 * plainly is one counts (a scheme, a leading www., or a .com/.org/.net name), so "Node.js" or
 * "README.md" as link text is never mistaken for an address.
 */
function hostShownAs(text: string): string | null {
  const shown = text.trim();
  if (!shown || /\s/.test(shown)) return null;
  const match = /^(https?:\/\/)?(www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#:]\S*)?$/i.exec(shown);
  if (!match) return null;
  const host = match[3]!.toLowerCase();
  const top = host.slice(host.lastIndexOf('.') + 1);
  if (!/^[a-z]{2,}$/.test(top)) return null;
  const obvious = !!match[1] || !!match[2] || ['com', 'org', 'net'].includes(top);
  return obvious ? host : null;
}

function subjectAdvice(subject: string): ContentAdvice[] {
  const advice: ContentAdvice[] = [];
  const trimmed = subject.trim();
  // An empty subject is the checklist's own blocking check; nothing to add here.
  if (!trimmed) return advice;

  // Letters that have a capital form, so scripts without capitals are never "all capitals".
  const letters = [...trimmed].filter((c) => c.toLowerCase() !== c.toUpperCase());
  const capitals = letters.filter((c) => c === c.toUpperCase());
  if (
    letters.length >= CONTENT_LIMITS.capsMinLetters &&
    capitals.length / letters.length >= CONTENT_LIMITS.capsShare
  ) {
    advice.push({
      id: 'subject_caps',
      message:
        'The subject is written in capitals. Spam filters and readers both take that as shouting. Use normal sentence case.',
    });
  }

  const repeated = new RegExp(`([!?$€£])\\1{${CONTENT_LIMITS.repeatedMarks - 1},}`);
  const exclamations = (trimmed.match(/!/g) ?? []).length;
  if (repeated.test(trimmed) || exclamations >= CONTENT_LIMITS.exclamationMarks) {
    advice.push({
      id: 'subject_punctuation',
      message:
        'The subject repeats punctuation such as !!! or $$$. That is a classic spam signal. One mark is enough.',
    });
  }

  if (trimmed.length > CONTENT_LIMITS.subjectMaxLength) {
    advice.push({
      id: 'subject_long',
      message: `The subject is ${trimmed.length} characters long. Most inboxes show about 60, so the end will be cut off. Put the important words first or shorten it.`,
    });
  }

  const meaningful = (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (
    meaningful < CONTENT_LIMITS.subjectMinCharacters ||
    /^(untitled|no subject|\(no subject\)|subject|test)$/i.test(trimmed)
  ) {
    advice.push({
      id: 'subject_thin',
      message:
        'The subject says almost nothing. Readers decide from the subject whether to open, and an empty-looking one is often treated as junk. Say what the email is about.',
    });
  }
  return advice;
}

function phraseAdvice(subject: string, body: string): ContentAdvice[] {
  const haystack = ` ${`${subject}\n${body}`
    .toLowerCase()
    .replace(/[-‐-―]/g, ' ')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')} `;
  const hits = SPAM_TRIGGER_PHRASES.filter((phrase) =>
    haystack.includes(` ${phrase.replace(/-/g, ' ')} `),
  );
  if (hits.length < CONTENT_LIMITS.spamPhraseHits) return [];
  return [
    {
      id: 'spam_phrases',
      message: `The email uses several phrases that spam filters score: ${hits
        .slice(0, 5)
        .map((hit) => `"${hit}"`)
        .join(', ')}. One is harmless, several together are not. Reword a few of them.`,
    },
  ];
}

function linkAdvice(input: ContentCheckInput, own: Set<string>): ContentAdvice[] {
  const advice: ContentAdvice[] = [];
  const isOwn = (host: string) => own.has(host) || own.has(registrableDomain(host));

  const shorteners = new Set<string>();
  const ipLinks = new Set<string>();
  let insecure = 0;
  for (const link of input.links) {
    const host = hostOf(link);
    if (!host) continue;
    if (isLocalHost(host)) continue;
    if (isIpHost(host)) ipLinks.add(host);
    else if (!isOwn(host) && (PUBLIC_LINK_SHORTENERS as readonly string[]).includes(host)) {
      shorteners.add(host);
    }
    if (/^http:\/\//i.test(link)) insecure += 1;
  }

  if (shorteners.size) {
    advice.push({
      id: 'link_shortener',
      message: `${count(shorteners.size, 'A link goes', 'links go')} through a public link shortener (${[...shorteners].join(', ')}). Spammers hide behind these, so many filters distrust them. Link to the real address instead.`,
    });
  }
  if (ipLinks.size) {
    advice.push({
      id: 'ip_link',
      message: `${count(ipLinks.size, 'A link points', 'links point')} at a bare IP address (${[...ipLinks].slice(0, 3).join(', ')}). Filters treat that as a strong sign of spam or phishing. Link to a domain name instead.`,
    });
  }
  if (insecure) {
    advice.push({
      id: 'insecure_link',
      message: `${count(insecure, 'A link uses', 'links use')} http:// instead of https://. Browsers warn about such pages and filters trust them less. Use the https:// address where the site has one.`,
    });
  }

  // Link text that is itself a web address, but for a different site than the link opens.
  const mismatches = new Set<string>();
  for (const match of input.html.matchAll(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const placeholder = /^\{\{@link:(\d+)\}\}$/.exec(match[1]!);
    const href = placeholder ? input.links[Number(placeholder[1])] : decodeEntities(match[1]!);
    const target = href ? hostOf(href) : null;
    if (!target || isOwn(target)) continue;
    const shown = hostShownAs(decodeEntities(match[2]!.replace(/<[^>]*>/g, '')));
    if (!shown) continue;
    const shownHost = shown.replace(/^www\./, '');
    if (registrableDomain(shownHost) !== registrableDomain(target)) {
      mismatches.add(`${shownHost} opens ${target}`);
    }
  }
  if (mismatches.size) {
    advice.push({
      id: 'link_text_mismatch',
      message: `${count(mismatches.size, 'A link shows', 'links show')} one web address but ${mismatches.size === 1 ? 'opens' : 'open'} another (${[...mismatches].slice(0, 2).join('; ')}). That is how phishing emails look, and filters punish it. Use words for the link text, or make the two match.`,
    });
  }

  if (input.links.length > CONTENT_LIMITS.maxLinks) {
    advice.push({
      id: 'many_links',
      message: `The email has ${input.links.length} different links. Very link-heavy emails are more likely to be filtered. Keep the ones readers need.`,
    });
  }
  return advice;
}

/** The body of the plain-text part: without the footer, link addresses and image stand-ins. */
function readableWords(text: string): number {
  const body = text.split(/\n--\n/)[0] ?? '';
  const cleaned = body
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    // An image's alt text stands alone on a line in square brackets; readers never see it as text.
    .replace(/^\s*\[[^\]\n]*\]\s*$/gm, ' ');
  return (cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function imageAdvice(input: ContentCheckInput): ContentAdvice[] {
  const advice: ContentAdvice[] = [];
  const images = [...input.html.matchAll(/<img\b[^>]*>/gi)].map((match) => {
    const tag = match[0];
    const width = Number(/\bwidth="(\d+)"/i.exec(tag)?.[1] ?? Number.NaN);
    const src = decodeEntities(/\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? '');
    return { src, width };
  });
  // A logo or an icon is decoration; an image with no stated width is taken as content.
  const content = images.filter(
    (image) => Number.isNaN(image.width) || image.width >= CONTENT_LIMITS.contentImageMinWidth,
  );
  const words = readableWords(input.text);
  if (content.length && words < CONTENT_LIMITS.imageHeavyMaxWords) {
    advice.push({
      id: 'image_heavy',
      message: `This email is mostly images with very little text (${count(words, '1 word', 'words')}). Filters cannot read images, and many inboxes hide them until the reader agrees, so it can look empty. Add a few sentences of real text.`,
    });
  }

  let largest = 0;
  for (const image of images) {
    largest = Math.max(largest, input.imageBytes?.get(image.src) ?? 0);
  }
  if (largest > CONTENT_LIMITS.hugeImageBytes) {
    advice.push({
      id: 'huge_image',
      message: `An image is ${(largest / 1_000_000).toFixed(1)} MB. Large images load slowly, and on a phone many readers will not wait. Resize or compress it to under 1 MB.`,
    });
  }
  return advice;
}

/**
 * Advice for one rendered email, in a stable order: subject, preview text, wording, links, images.
 * Never throws; an email it cannot make sense of simply gets no advice.
 */
export function checkContent(input: ContentCheckInput): ContentAdvice[] {
  try {
    const own = new Set(
      (input.ownHosts ?? []).map((host) => host.toLowerCase().replace(/^www\./, '')),
    );
    const advice = subjectAdvice(input.subject);
    if (!input.preheader.trim()) {
      advice.push({
        id: 'preview_text',
        message:
          'There is no preview text. Inboxes will show the first line of the email next to the subject instead. A short summary there helps readers decide to open.',
      });
    }
    advice.push(...phraseAdvice(input.subject, input.text.split(/\n--\n/)[0] ?? ''));
    advice.push(...linkAdvice(input, own));
    advice.push(...imageAdvice(input));
    return advice;
  } catch {
    return [];
  }
}
