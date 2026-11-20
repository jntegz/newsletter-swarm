// Export HTML holds blocks our editor schema would drop or flatten: paywall marks, captions,
// buttons, footnotes, embeds and whole email layouts. This turns the common ones into the markup
// dispatchExtensions() parses, in the browser, before the post becomes a document. The class names
// come from public migration tooling, not from a real export, so check them against one.
import { embedInfo } from '@swarm/mail/embeds';

interface PreparedHtml {
  html: string;
  /** What couldn't come across, in plain words. */
  lost: string[];
}

const attrsOf = (el: Element): Record<string, unknown> => {
  try {
    return JSON.parse(el.getAttribute('data-attrs') ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const secure = (url: string | null | undefined): string | null => {
  const value = url?.trim().replace(/^http:\/\//i, 'https://') ?? '';
  return /^https:\/\//i.test(value) ? value : null;
};

/** The largest picture a srcset offers, or the plain src. */
function imageSource(img: Element): string | null {
  const widest = (img.getAttribute('srcset') ?? '')
    .split(/,\s+/)
    .map((part) => part.trim().split(/\s+/))
    .map(([url, size]) => ({ url, width: parseInt(size ?? '', 10) || 0 }))
    .sort((a, b) => b.width - a.width)[0]?.url;
  return secure(img.getAttribute('src') ?? widest);
}

function imageElement(
  doc: Document,
  attrs: { src: string; alt?: string; caption?: string; href?: string | null },
): Element {
  const img = doc.createElement('img');
  img.setAttribute('src', attrs.src);
  if (attrs.alt) img.setAttribute('alt', attrs.alt);
  // The image node reads its caption from this attribute.
  if (attrs.caption) img.setAttribute('caption', attrs.caption);
  if (attrs.href) img.setAttribute('data-href', attrs.href);
  return img;
}

function embedElement(doc: Document, url: string): Element {
  const div = doc.createElement('div');
  div.setAttribute('data-embed', '');
  div.setAttribute('data-url', url);
  return div;
}

function linkParagraph(doc: Document, url: string, label: string): Element {
  const p = doc.createElement('p');
  const a = doc.createElement('a');
  a.setAttribute('href', url);
  a.textContent = label;
  p.append(a);
  return p;
}

function linkCardElement(doc: Document, url: string, title: string, description: string): Element {
  const div = doc.createElement('div');
  div.setAttribute('data-link-card', '');
  div.setAttribute('data-href', url);
  div.setAttribute('title', title);
  div.setAttribute('description', description);
  return div;
}

/** The address an embedded video frame stands for, in a form the embed card accepts. */
function embedUrl(src: string): string | null {
  const youtube = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,20})/.exec(src)?.[1];
  if (youtube) return `https://www.youtube.com/watch?v=${youtube}`;
  const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(src)?.[1];
  if (vimeo) return `https://vimeo.com/${vimeo}`;
  const spotify = /open\.spotify\.com\/embed(?:-podcast)?\/(.+?)(?:\?|$)/.exec(src)?.[1];
  if (spotify) return `https://open.spotify.com/${spotify}`;
  return secure(src);
}

/** Replaces each match, dropping it when the builder has nothing to put there. */
function swap(root: Element, selector: string, build: (el: Element) => Element | Element[] | null) {
  for (const el of root.querySelectorAll(selector)) {
    if (!el.isConnected) continue;
    const made = build(el);
    if (Array.isArray(made)) el.replaceWith(...made);
    else if (made) el.replaceWith(made);
    else el.remove();
  }
}

/** An email template's variables mean nothing on a website. */
const stripVariables = (html: string) => html.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, '');

/**
 * What the schema keeps, after the mapping: paragraphs, headings, lists, quotes, code, rules, links,
 * images, plus the buttons, cards, embeds, footnotes and paywall breaks made here. Tables and
 * anything else unknown are reduced to the text inside them.
 */
export function prepareExportHtml(source: string): PreparedHtml {
  const lost = new Set<string>();
  const isEmail = source.includes('content-blocks');
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${isEmail ? stripVariables(source) : source}`,
    'text/html',
  );
  // A whole email: only its content blocks are the post.
  const blocks = doc.querySelector('#content-blocks');
  const root = blocks?.parentElement ?? doc.body;

  root
    .querySelectorAll(
      'script, style, head, title, meta, link, noscript, form, [style*="display:none"], [style*="display: none"]',
    )
    .forEach((el) => el.remove());
  // An email layout's footer, referral and recommendation parts.
  root
    .querySelectorAll('table.mob-block, table.rec__content, td.b, td.f')
    .forEach((el) => el.remove());

  // Signup and sharing belong to the old site. This site has its own signup.
  root
    .querySelectorAll('.subscription-widget-wrap, .subscription-widget-wrap-editor, .comment')
    .forEach((el) => el.remove());

  if (root.querySelector('.poll-embed, td.e')) lost.add('a poll');
  if (root.querySelector('.native-video-embed')) lost.add('a video hosted on the old platform');
  if (root.querySelector('.latex-rendered')) lost.add('a formula, which is now plain text');
  root.querySelectorAll('.poll-embed, .native-video-embed, td.e').forEach((el) => el.remove());

  swap(root, '.paywall-jump', () => {
    const gate = doc.createElement('div');
    gate.setAttribute('data-gate', '');
    return gate;
  });

  // Footnotes: the note's text goes on its marker, which is how the footnote node stores it.
  const notes = new Map<string, string>();
  root.querySelectorAll('.footnote').forEach((note) => {
    const id = note.getAttribute('id') ?? note.querySelector('a[id]')?.getAttribute('id');
    const body = note.querySelector('.footnote-content')?.textContent?.trim();
    if (id && body) notes.set(id, body);
    note.remove();
  });
  swap(root, 'a.footnote-anchor', (anchor) => {
    const noteText = notes.get((anchor.getAttribute('href') ?? '').replace(/^.*#/, ''));
    if (!noteText) return null;
    const sup = doc.createElement('sup');
    sup.setAttribute('data-footnote', '');
    sup.setAttribute('data-text', noteText);
    return sup;
  });

  swap(root, '.image-gallery-embed', (el) => {
    const gallery = attrsOf(el).gallery as { images?: { src?: string }[]; caption?: string } | null;
    const images = (gallery?.images ?? []).flatMap((image) => {
      const src = secure(image.src);
      return src ? [imageElement(doc, { src })] : [];
    });
    return images;
  });

  swap(root, '.captioned-image-container', (el) => {
    const img = el.querySelector('img');
    const src = img && imageSource(img);
    if (!src) return null;
    const link = el.querySelector('a.image-link')?.getAttribute('href');
    // A link to the same picture adds nothing.
    const href = secure(link);
    return imageElement(doc, {
      src,
      alt: img.getAttribute('alt') ?? '',
      caption: el.querySelector('figcaption')?.textContent?.trim() ?? '',
      href: href && !/\.(png|jpe?g|gif|webp)(\?|$)/i.test(href) && href !== src ? href : null,
    });
  });

  swap(root, 'figure', (el) => {
    const img = el.querySelector('img');
    const src = img && imageSource(img);
    if (!src) return Array.from(el.children);
    return imageElement(doc, {
      src,
      alt: img.getAttribute('alt') ?? '',
      caption: el.querySelector('figcaption')?.textContent?.trim() ?? '',
    });
  });

  // The renderers only accept https images.
  for (const img of root.querySelectorAll('img')) {
    const src = imageSource(img);
    if (!src) {
      lost.add('an image that wasn’t on an https address');
      img.remove();
      continue;
    }
    img.setAttribute('src', src);
    img.removeAttribute('srcset');
  }

  // Buttons. Share, gift, comment and subscribe buttons only make sense on the old site.
  swap(root, 'p.button-wrapper', (wrapper) => {
    const a = wrapper.querySelector('a');
    const href = secure(a?.getAttribute('href'));
    const label = a?.textContent?.trim() ?? '';
    if (!href || !label) return null;
    if (/action=share|gift=true|\/subscribe(\/|\?|$)|\/comments(\/|\?|$)/.test(href)) return null;
    const button = doc.createElement('div');
    button.setAttribute('data-email-button', '');
    button.setAttribute('data-href', href);
    button.textContent = label;
    return button;
  });

  // Links to other posts become link cards.
  swap(root, '.embedded-post-wrap, .digest-post-embed', (el) => {
    const attrs = attrsOf(el);
    const url = secure(text(attrs.url) || text(attrs.canonical_url));
    if (!url) return null;
    return linkCardElement(
      doc,
      url,
      text(attrs.title) || url,
      text(attrs.truncated_body_text) || text(attrs.caption),
    );
  });

  swap(root, 'div.tweet', (el) => {
    const url = secure(el.querySelector('a')?.getAttribute('href')?.split('?')[0]);
    return url && embedInfo(url) ? embedElement(doc, url) : null;
  });

  swap(root, 'div.instagram', (el) => {
    const url = secure(el.querySelector('a')?.getAttribute('href'));
    return url ? linkParagraph(doc, url, 'See this on Instagram') : null;
  });

  swap(root, '.file-embed-wrapper', (el) => {
    const url = secure(el.querySelector('a')?.getAttribute('href'));
    const title = el.querySelector('.file-embed-details-h1')?.textContent?.trim() || 'Download';
    lost.add('a file, which stays on the old platform');
    return url ? linkParagraph(doc, url, title) : null;
  });

  // Video and audio players.
  swap(root, 'iframe', (frame) => {
    const url = embedUrl(frame.getAttribute('src') ?? '');
    if (url && embedInfo(url)) return embedElement(doc, url);
    if (url) return linkParagraph(doc, url, 'See this on the original page');
    lost.add('an embedded player');
    return null;
  });

  // Blocks that are only allowed at the top of the document, or that parse badly inside a wrapper,
  // are lifted out of the wrappers around them.
  for (const el of root.querySelectorAll(
    '[data-gate], [data-embed], [data-email-button], [data-link-card]',
  )) {
    let at: Element = el;
    while (at.parentElement && at.parentElement !== root && at.parentElement.tagName === 'DIV') {
      at = at.parentElement;
    }
    if (at !== el) at.replaceWith(el);
  }

  // Empty paragraphs, which exports use as spacing.
  root.querySelectorAll('p').forEach((p) => {
    if (!p.textContent?.trim() && !p.querySelector('img, sup')) p.remove();
  });

  return { html: root.innerHTML, lost: [...lost] };
}
