/**
 * Feed Sync: RSS 2.0, RSS 1.0, Atom 1.0 and JSON Feed 1.x into one item model. XML goes through
 * the bounded reader shared with DMARC (no DOCTYPE, so no DTDs or entity expansion); the format
 * is detected from the body, not the content type. Fields per format: docs/feed-sync.md.
 */
import { FEED_SYNC_LIMITS, type FeedFormat } from '@swarm/domain';
import { parseXml, type XmlElement } from './dmarc';
import { decodeHtmlEntities, safeImage, safeLink, textToHtml } from './feed-html';

/** A feed that can't be fetched or read; the message is shown to the operator. */
export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedError';
  }
}

export interface ParsedFeedItem {
  guid: string | null;
  link: string | null;
  title: string;
  publishedAt: number | null;
  /** The item's HTML (or plain text turned into paragraphs); null when it has none. */
  html: string | null;
  /** A shorter HTML or text summary, when the feed gives one apart from the content. */
  summary: string | null;
  /** The first image enclosure, https only. */
  image: string | null;
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string | null;
  items: ParsedFeedItem[];
}

const child = (el: XmlElement | undefined, name: string) =>
  el?.children.find((c) => c.name === name);
const children = (el: XmlElement | undefined, name: string) =>
  el?.children.filter((c) => c.name === name) ?? [];
const text = (el: XmlElement | undefined, name: string): string | null => {
  const value = child(el, name)?.text.trim();
  return value ? value : null;
};

const cut = (value: string | null, max: number) => (value ? value.slice(0, max) : value);
const oneLine = (value: string | null) => value?.replace(/\s+/g, ' ').trim() || null;

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Drops each tag, from a '<' to the next '>', in one pass. The regex /<[^>]*>/g did the same but
 * took quadratic time on a long run of '<' with no '>': every start scanned to the end.
 */
function stripTags(value: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = value.indexOf('<', i);
    const gt = lt < 0 ? -1 : value.indexOf('>', lt);
    // With no '>' after this '<', none follows any later '<' either: the rest is text.
    if (gt < 0) return out + value.slice(i);
    out += value.slice(i, lt);
    i = gt + 1;
  }
}

/** Titles are plain text, but feeds often put entities or tags in them. */
function plainTitle(value: string | null): string {
  if (!value) return '';
  return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function finish(item: ParsedFeedItem): ParsedFeedItem | null {
  if (!item.guid && !item.link && !item.title) return null;
  return {
    ...item,
    guid: cut(item.guid, 2048),
    link: cut(item.link, 2048),
  };
}

/** The first image among enclosures and Media RSS elements. */
function imageOf(item: XmlElement, base: string | null): string | null {
  for (const el of item.children) {
    const url = el.attrs.url;
    if (!url) continue;
    const type = el.attrs.type ?? '';
    const isImage =
      (el.name === 'enclosure' && type.startsWith('image/')) ||
      el.name === 'thumbnail' ||
      (el.name === 'content' && (el.attrs.medium === 'image' || type.startsWith('image/')));
    if (isImage) {
      const src = safeImage(url, base);
      if (src) return src;
    }
    // media:group wraps media:content.
    if (el.name === 'group') {
      const nested = imageOf(el, base);
      if (nested) return nested;
    }
  }
  return null;
}

function rssItem(item: XmlElement, feedUrl: string): ParsedFeedItem | null {
  const link = safeLink(text(item, 'link') ?? undefined, feedUrl);
  const guidEl = child(item, 'guid');
  const guid = oneLine(guidEl?.text ?? null) ?? oneLine(item.attrs.about ?? null);
  // A permalink GUID is the link when there is no <link>.
  const permalink =
    !link && guid && guidEl?.attrs.isPermaLink !== 'false' ? safeLink(guid, feedUrl) : null;
  const encoded = text(item, 'encoded');
  const description = text(item, 'description');
  return finish({
    guid,
    link: link ?? permalink,
    title: plainTitle(text(item, 'title')),
    publishedAt: parseDate(text(item, 'pubDate') ?? text(item, 'date')),
    html: encoded ?? description,
    summary: encoded ? description : null,
    image: imageOf(item, link ?? feedUrl),
  });
}

/** Atom text constructs: html, xhtml (read from the source) or text. */
function atomText(el: XmlElement | undefined, source: string): string | null {
  if (!el) return null;
  const type = (el.attrs.type ?? 'text').toLowerCase();
  if (type === 'xhtml') {
    const raw = source.slice(el.inner[0], el.inner[1]).trim();
    return raw || null;
  }
  const value = el.text.trim();
  if (!value) return null;
  return type === 'html' || type === 'text/html' ? value : textToHtml(value);
}

function atomLink(el: XmlElement, base: string): string | null {
  const links = children(el, 'link');
  const alternate =
    links.find((l) => (l.attrs.rel ?? 'alternate') === 'alternate' && l.attrs.href) ??
    links.find((l) => l.attrs.href && !l.attrs.rel);
  return safeLink(alternate?.attrs.href, base);
}

function atomEntry(entry: XmlElement, feedUrl: string, source: string): ParsedFeedItem | null {
  const link = atomLink(entry, feedUrl);
  // Atom puts media in <content src="…"> or <link rel="enclosure" type="image/…">.
  const enclosure = children(entry, 'link').find(
    (l) => l.attrs.rel === 'enclosure' && (l.attrs.type ?? '').startsWith('image/'),
  );
  const content = child(entry, 'content');
  const html = content?.attrs.src ? null : atomText(content, source);
  const summary = atomText(child(entry, 'summary'), source);
  return finish({
    guid: oneLine(text(entry, 'id')),
    link,
    title: plainTitle(atomText(child(entry, 'title'), source)),
    publishedAt: parseDate(text(entry, 'published') ?? text(entry, 'updated')),
    html: html ?? summary,
    summary: html ? summary : null,
    image: safeImage(enclosure?.attrs.href, link ?? feedUrl) ?? imageOf(entry, link ?? feedUrl),
  });
}

function parseXmlFeed(body: string, feedUrl: string): ParsedFeed {
  let root: XmlElement;
  try {
    root = parseXml(body, 'feed XML');
  } catch (error) {
    throw new FeedError(`The feed is not valid XML (${(error as Error).message}).`);
  }
  const limit = FEED_SYNC_LIMITS.itemsPerFetch;
  if (root.name === 'rss') {
    const channel = child(root, 'channel');
    if (!channel) throw new FeedError('The RSS feed has no channel element.');
    return {
      format: 'rss',
      title: plainTitle(text(channel, 'title')) || null,
      items: children(channel, 'item')
        .slice(0, limit)
        .map((item) => rssItem(item, feedUrl))
        .filter((item): item is ParsedFeedItem => item !== null),
    };
  }
  if (root.name === 'RDF') {
    return {
      format: 'rss',
      title: plainTitle(text(child(root, 'channel'), 'title')) || null,
      items: children(root, 'item')
        .slice(0, limit)
        .map((item) => rssItem(item, feedUrl))
        .filter((item): item is ParsedFeedItem => item !== null),
    };
  }
  if (root.name === 'feed') {
    return {
      format: 'atom',
      title: plainTitle(atomText(child(root, 'title'), body)) || null,
      items: children(root, 'entry')
        .slice(0, limit)
        .map((entry) => atomEntry(entry, feedUrl, body))
        .filter((item): item is ParsedFeedItem => item !== null),
    };
  }
  throw new FeedError(`This is not an RSS or Atom feed (the document is <${root.name}>).`);
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function parseJsonFeed(body: string, feedUrl: string): ParsedFeed {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new FeedError('The feed is not valid JSON.');
  }
  const feed = doc as { version?: unknown; title?: unknown; items?: unknown };
  if (
    !feed ||
    typeof feed !== 'object' ||
    !str(feed.version)?.startsWith('https://jsonfeed.org/version/1')
  ) {
    throw new FeedError('This JSON is not a JSON Feed (version 1).');
  }
  const items = Array.isArray(feed.items)
    ? feed.items.slice(0, FEED_SYNC_LIMITS.itemsPerFetch)
    : [];
  return {
    format: 'json',
    title: plainTitle(str(feed.title)) || null,
    items: items
      .map((raw): ParsedFeedItem | null => {
        if (!raw || typeof raw !== 'object') return null;
        const item = raw as Record<string, unknown>;
        const link = safeLink(str(item.url) ?? str(item.external_url) ?? undefined, feedUrl);
        const contentText = str(item.content_text);
        const html = str(item.content_html) ?? (contentText ? textToHtml(contentText) : null);
        const summary = str(item.summary);
        const id = typeof item.id === 'number' ? String(item.id) : oneLine(str(item.id));
        return finish({
          guid: id,
          link,
          title: plainTitle(str(item.title)),
          publishedAt: parseDate(str(item.date_published) ?? str(item.date_modified)),
          html: html ?? (summary ? textToHtml(summary) : null),
          summary: html && summary ? textToHtml(summary) : null,
          image: safeImage(str(item.image) ?? str(item.banner_image) ?? undefined, link ?? feedUrl),
        });
      })
      .filter((item): item is ParsedFeedItem => item !== null),
  };
}

/** Parses a fetched feed body; throws FeedError when it is none of the formats. */
export function parseFeed(body: string, feedUrl: string): ParsedFeed {
  // trimStart also drops a byte order mark.
  const start = body.trimStart();
  if (start.startsWith('{')) return parseJsonFeed(start, feedUrl);
  if (start.startsWith('<')) return parseXmlFeed(start, feedUrl);
  throw new FeedError('This is not a feed: expected RSS, Atom or JSON Feed.');
}
