// Reading past issues out of another platform's export, in the browser: a zip (posts.csv and an
// HTML file per post), or any CSV with a title, a date and the HTML. Nothing leaves the browser
// until the person has seen what was found.
//
// The formats come from public migration tooling and help pages, not from a real export: see the
// fixtures in archive.test.ts. Check them against a real export before relying on them.

export interface ArchiveItem {
  subject: string;
  preheader: string;
  slug: string;
  publishedAt: string;
  visibility: 'public' | 'members' | 'paid';
  html: string;
}

export interface ArchiveRead {
  items: ArchiveItem[];
  /** Why rows were left out, for the person to see before importing. */
  skipped: string[];
}

/** Rows of a CSV: quoted fields, doubled quotes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

const records = (text: string): Record<string, string>[] => {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!head) return [];
  const names = head.map((name) => name.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i] ?? ''])));
};

/** A web address's last part, in the form a post's address can use. */
export function toSlug(value: string): string {
  const path = value.includes('/')
    ? (value.split('?')[0]?.split('/').filter(Boolean).at(-1) ?? '')
    : value;
  return path
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');
}

/** Exports write times without a zone, like 2023-01-18 21:25:27, and mean UTC. */
const when = (value: string | undefined): string | null => {
  const text = value?.trim() ?? '';
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const at = text ? Date.parse(zoneless ? `${text.replace(' ', 'T')}Z` : text) : Number.NaN;
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

const visibilityOf = (audience: string | undefined): ArchiveItem['visibility'] => {
  const value = audience?.trim().toLowerCase() ?? '';
  if (/paid|premium|founding/.test(value)) return 'paid';
  if (/member|only_free|free_only/.test(value) || value === 'both') return 'members';
  return 'public';
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Some exports keep HTML entities in plain fields such as the subtitle. */
const plainText = (value: string | undefined): string =>
  (value ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith('#')) {
        const hex = code[1]?.toLowerCase() === 'x';
        const point = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      }
      // Own names only: the file's &constructor; is no entity.
      const name = code.toLowerCase();
      return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
    })
    .trim();

/** Keeps the first post at each address: a second one could never be imported anyway. */
function keepFirst(items: ArchiveItem[], skipped: string[]): ArchiveItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.slug)) {
      skipped.push(`${item.subject}: another post in this file has the address ${item.slug}`);
      return false;
    }
    seen.add(item.slug);
    return true;
  });
}

/** Files that can hold posts, by path, as text. Handles the stored and deflated files of exports. */
export async function readZip(data: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(data);
  let end = data.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('This file isn’t a zip.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('This zip is damaged.');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(data, at + 46, nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/') || !/\.(csv|html?)$/i.test(name)) continue;
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const bytes = new Uint8Array(data, start, size);
    if (method === 0) files.set(name, decoder.decode(bytes));
    else if (method === 8) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(name, await new Response(stream).text());
    }
  }
  return files;
}

/**
 * An export zip: posts.csv (post_id, post_date, is_published, email_sent_at, inbox_sent_at, type,
 * audience, title, subtitle, podcast_url), and posts/<post_id>.html for each, possibly inside one
 * top-level folder. Other files in the zip, such as per-post statistics, are ignored.
 * Drafts and threads are in the file too, and neither belongs in the archive.
 */
export function readExportZip(files: Map<string, string>): ArchiveRead {
  const list = [...files.keys()].find((name) => /(^|\/)posts\.csv$/.test(name));
  if (!list)
    throw new Error('No posts.csv in this zip. Use the export from your old platform’s settings.');
  const pages = new Map<string, string>();
  for (const [name, text] of files) {
    if (name.startsWith('__MACOSX/')) continue;
    const base = name.split('/').at(-1) ?? name;
    if (base.endsWith('.html') && !pages.has(base)) pages.set(base, text);
  }
  const items: ArchiveItem[] = [];
  const skipped: string[] = [];
  for (const row of records(files.get(list) ?? '')) {
    const id = row.post_id?.trim() ?? '';
    const addressPart = id.replace(/^\d+\.?/, '');
    const title = plainText(row.title) || addressPart || id || '(no title)';
    const type = row.type?.trim().toLowerCase() ?? '';
    if (row.is_published?.trim().toLowerCase() !== 'true') {
      skipped.push(`${title}: a draft`);
      continue;
    }
    if (type === 'thread') {
      skipped.push(`${title}: a discussion thread, not a post`);
      continue;
    }
    if (type === 'page') {
      skipped.push(`${title}: a page, which you can make again under Pages`);
      continue;
    }
    const html = pages.get(`${id}.html`);
    if (!html?.trim()) {
      skipped.push(`${title}: no content in the export`);
      continue;
    }
    const publishedAt = when(row.post_date) ?? when(row.email_sent_at);
    if (!publishedAt) {
      skipped.push(`${title}: no date`);
      continue;
    }
    const slug = toSlug(addressPart) || toSlug(title);
    if (!slug) {
      skipped.push(`${title}: no address could be made from it`);
      continue;
    }
    const podcast = row.podcast_url?.trim();
    items.push({
      subject: title,
      preheader: plainText(row.subtitle),
      slug,
      publishedAt,
      visibility: visibilityOf(row.audience),
      // The audio file stays where it is, so the post links to it.
      html: /^https:\/\//.test(podcast ?? '')
        ? `<p><a href="${podcast?.replace(/"/g, '%22')}">Listen to this episode</a></p>${html}`
        : html,
    });
  }
  return { items: keepFirst(items, skipped), skipped };
}

const pick = (row: Record<string, string>, names: string[]) =>
  names.map((name) => row[name]).find((value) => value?.trim());

const UNPUBLISHED = /draft|archiv|schedul|unpublish|delet|pending/;

/**
 * A CSV with a title, a date and the HTML, under the column names platforms commonly use. One
 * known export has id, web_title, web_subtitle, status (confirmed when published, and it includes
 * drafts and archived posts), audience or web_audiences, url, content_html and created_at, which
 * has no zone.
 */
export function readArchiveCsv(text: string): ArchiveRead {
  const items: ArchiveItem[] = [];
  const skipped: string[] = [];
  const rows = records(text);
  for (const row of rows) {
    const subject = plainText(pick(row, ['title', 'web_title', 'subject', 'name']));
    const html = pick(row, ['html', 'content_html', 'content', 'body', 'email_html', 'web_html']);
    const publishedAt = when(
      pick(row, [
        'publish_date',
        'published_at',
        'date',
        'publish_at',
        'sent_at',
        'send_at',
        'created_at',
      ]),
    );
    const slug = toSlug(pick(row, ['slug', 'url', 'web_url', 'public_url', 'link']) ?? '');
    const label = subject || '(no title)';
    if (!subject) skipped.push(`${label}: no title`);
    else if (UNPUBLISHED.test(row.status?.toLowerCase() ?? '')) {
      skipped.push(`${label}: not published (${row.status?.trim()})`);
    } else if (!html) skipped.push(`${label}: no HTML column`);
    else if (!publishedAt) skipped.push(`${label}: no date`);
    else if (!slug && !toSlug(subject)) skipped.push(`${label}: no address could be made from it`);
    else {
      items.push({
        subject,
        preheader: plainText(
          pick(row, ['subtitle', 'web_subtitle', 'preview_text', 'preheader', 'description']),
        ),
        slug: slug || toSlug(subject),
        publishedAt,
        visibility: visibilityOf(pick(row, ['audience', 'web_audiences', 'visibility', 'access'])),
        html,
      });
    }
  }
  return { items: keepFirst(items, skipped), skipped };
}
