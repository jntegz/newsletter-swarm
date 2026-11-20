/**
 * DMARC aggregate reports arrive as email (RFC 7489 §7.2.1.1): a zip or gzip of the XML report,
 * attached or as the whole body, or occasionally plain XML. This file finds the report in the
 * raw message and decompresses it, with hard bounds so a hostile message (a zip bomb, a deep
 * multipart tree, a huge entry count) costs a bounded amount of work. Everything here throws
 * DmarcInputError on bad input; callers log and drop the message.
 */

export class DmarcInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmarcInputError';
  }
}

export const DMARC_LIMITS = {
  /** The whole raw message (a 5 MB attachment is ~6.8 MB as base64). */
  messageBytes: 10 * 1024 * 1024,
  /** The attachment before decompression. */
  compressedBytes: 5 * 1024 * 1024,
  /** The XML after decompression. */
  uncompressedBytes: 25 * 1024 * 1024,
  zipEntries: 5,
  mimeDepth: 5,
  mimeParts: 50,
};

export type ReportFormat = 'zip' | 'gzip' | 'xml';

export interface ReportAttachment {
  format: ReportFormat;
  filename: string | null;
  bytes: Uint8Array;
}

// ---- MIME ----------------------------------------------------------------------------------

/** Bytes to a string with one char per byte, so headers and 8-bit bodies round-trip exactly. */
function binaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function binaryBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

function splitPart(text: string): Part {
  const match = /\r?\n\r?\n/.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  const body = match ? text.slice(match.index + match[0].length) : '';
  const headers = new Map<string, string>();
  // Unfold continuation lines, then take the first value of each header.
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/** A structured header value: `type/subtype; a=b; c="d"` → value and lowercase params. */
export function parseHeaderValue(value: string): { value: string; params: Map<string, string> } {
  const [first = '', ...rest] = value.split(';');
  const params = new Map<string, string>();
  for (const piece of rest) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    let key = piece.slice(0, eq).trim().toLowerCase();
    let val = piece.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    // RFC 2231: filename*=utf-8''name.zip (continuations such as filename*0 are not joined).
    if (key.endsWith('*')) {
      key = key.slice(0, -1);
      const quote = val.indexOf("''");
      if (quote >= 0) val = val.slice(quote + 2);
      try {
        val = decodeURIComponent(val);
      } catch {
        // Keep the raw value.
      }
    }
    if (!params.has(key)) params.set(key, val);
  }
  return { value: first.trim().toLowerCase(), params };
}

function decodeBody(part: Part): Uint8Array {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  if (encoding === 'base64') {
    const kept = part.body.replace(/[^A-Za-z0-9+/=]/g, '');
    // Padding is stripped by a scan, not /=+$/, which is quadratic on a long '=' run mid-body.
    let end = kept.length;
    while (end > 0 && kept.charCodeAt(end - 1) === 61) end--;
    const clean = kept.slice(0, end);
    const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
    try {
      return binaryBytes(atob(padded));
    } catch {
      throw new DmarcInputError('attachment is not valid base64');
    }
  }
  if (encoding === 'quoted-printable') {
    return binaryBytes(
      part.body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
    );
  }
  return binaryBytes(part.body);
}

function magicFormat(bytes: Uint8Array): ReportFormat | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'zip';
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  // XML, after an optional UTF-8 byte order mark and whitespace.
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const space = (b: number | undefined) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
  while (i < bytes.length && i < 64 && space(bytes[i])) i++;
  return bytes[i] === 0x3c ? 'xml' : null;
}

const REPORT_TYPES: Record<string, ReportFormat> = {
  'application/zip': 'zip',
  'application/x-zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gzip',
  'application/x-gzip': 'gzip',
  'application/x-gunzip': 'gzip',
  'text/xml': 'xml',
  'application/xml': 'xml',
};

function filenameFormat(name: string | null): ReportFormat | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return 'gzip';
  if (lower.endsWith('.xml')) return 'xml';
  return null;
}

interface Leaf {
  type: string;
  filename: string | null;
  part: Part;
}

function collectLeaves(text: string, depth: number, leaves: Leaf[]): void {
  if (depth > DMARC_LIMITS.mimeDepth) throw new DmarcInputError('MIME nesting is too deep');
  const part = splitPart(text);
  const type = parseHeaderValue(part.headers.get('content-type') ?? 'text/plain');
  if (type.value.startsWith('multipart/')) {
    const boundary = type.params.get('boundary');
    if (!boundary) throw new DmarcInputError('multipart message without a boundary');
    const delimiter = `--${boundary}`;
    // One part at a time, so a body of millions of delimiters stops at the limit instead of being
    // split whole first. What comes before the first delimiter is the preamble; a part starting
    // with "--" is the closing delimiter's epilogue.
    let at = part.body.indexOf(delimiter);
    for (let parts = 0; at >= 0; parts++) {
      const start = at + delimiter.length;
      at = part.body.indexOf(delimiter, start);
      const piece = part.body.slice(start, at < 0 ? undefined : at);
      if (piece.startsWith('--')) break;
      // Parts count even when they hold no leaves (an empty multipart, say).
      if (leaves.length >= DMARC_LIMITS.mimeParts || parts >= DMARC_LIMITS.mimeParts) {
        throw new DmarcInputError('too many parts');
      }
      collectLeaves(piece.replace(/^[ \t]*\r?\n/, ''), depth + 1, leaves);
    }
    return;
  }
  const disposition = parseHeaderValue(part.headers.get('content-disposition') ?? '');
  const filename = disposition.params.get('filename') ?? type.params.get('name') ?? null;
  leaves.push({ type: type.value, filename, part });
}

/**
 * The report file in a raw message. Attachments typed or named as zip, gzip or XML win over body
 * text; an untyped part (application/octet-stream) is recognised by its first bytes.
 */
export function extractReportAttachment(raw: Uint8Array): ReportAttachment {
  if (raw.length > DMARC_LIMITS.messageBytes) throw new DmarcInputError('message is too large');
  const leaves: Leaf[] = [];
  collectLeaves(binaryString(raw), 0, leaves);

  const ranked = leaves
    .map((leaf) => ({
      leaf,
      // Own types only: a part typed "constructor" must not find Object.prototype's.
      declared:
        (Object.hasOwn(REPORT_TYPES, leaf.type) ? REPORT_TYPES[leaf.type] : undefined) ??
        filenameFormat(leaf.filename),
    }))
    // Declared report parts first, then anything that might be one; plain text bodies last.
    .sort((a, b) => Number(!a.declared) - Number(!b.declared));

  for (const { leaf, declared } of ranked) {
    if (!declared && leaf.type.startsWith('text/') && leaf.type !== 'text/xml') {
      // A text/plain body is only a report when it is XML (some reporters send it inline).
      const bytes = decodeBody(leaf.part);
      if (magicFormat(bytes) === 'xml') return { format: 'xml', filename: null, bytes };
      continue;
    }
    const bytes = decodeBody(leaf.part);
    if (bytes.length === 0) continue;
    if (bytes.length > DMARC_LIMITS.compressedBytes) {
      throw new DmarcInputError('attachment is too large');
    }
    // The bytes decide when the label is wrong (a zip sent as application/gzip, say).
    const format = magicFormat(bytes) ?? declared;
    if (format) return { format, filename: leaf.filename, bytes };
  }
  throw new DmarcInputError('no report attachment found');
}

// ---- Decompression -------------------------------------------------------------------------

async function inflate(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
  limit: number,
): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new DmarcInputError('report is too large once decompressed');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DmarcInputError) throw error;
    throw new DmarcInputError(`could not decompress the report (${format})`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Central directory entries (PKWARE APPNOTE §4.3.12–16). ZIP64 and encryption are refused. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  // The end-of-central-directory record is in the last 22 + 65535 bytes (comment length).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DmarcInputError('zip has no central directory');
  const count = u16(bytes, eocd + 10);
  const size = u32(bytes, eocd + 12);
  const start = u32(bytes, eocd + 16);
  if (count === 0xffff || start === 0xffffffff) throw new DmarcInputError('ZIP64 is not supported');
  if (count === 0) throw new DmarcInputError('zip is empty');
  if (count > DMARC_LIMITS.zipEntries) throw new DmarcInputError('zip has too many entries');
  if (start + size > eocd) throw new DmarcInputError('zip central directory is out of range');

  const entries: ZipEntry[] = [];
  let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || u32(bytes, at) !== 0x02014b50) {
      throw new DmarcInputError('zip central directory is corrupt');
    }
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const entry: ZipEntry = {
      flags: u16(bytes, at + 8),
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      uncompressedSize: u32(bytes, at + 24),
      localOffset: u32(bytes, at + 42),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    };
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) {
      throw new DmarcInputError('ZIP64 is not supported');
    }
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function unzip(bytes: Uint8Array): Promise<Uint8Array> {
  const entries = zipEntries(bytes).filter((entry) => !entry.name.endsWith('/'));
  const entry = entries.find((e) => e.name.toLowerCase().endsWith('.xml')) ?? entries[0];
  if (!entry) throw new DmarcInputError('zip has no files');
  if (entry.flags & 0x1) throw new DmarcInputError('zip entry is encrypted');
  if (entry.uncompressedSize > DMARC_LIMITS.uncompressedBytes) {
    throw new DmarcInputError('report is too large once decompressed');
  }
  const local = entry.localOffset;
  if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) {
    throw new DmarcInputError('zip local header is corrupt');
  }
  const dataStart = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new DmarcInputError('zip entry is out of range');
  const data = bytes.subarray(dataStart, dataEnd);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflate(data, 'deflate-raw', DMARC_LIMITS.uncompressedBytes);
  throw new DmarcInputError(`zip compression method ${entry.method} is not supported`);
}

/** The XML text of a report attachment. */
export async function decompressReport(attachment: ReportAttachment): Promise<string> {
  const { bytes, format } = attachment;
  if (bytes.length > DMARC_LIMITS.compressedBytes) {
    throw new DmarcInputError('attachment is too large');
  }
  let xml: Uint8Array;
  if (format === 'zip') xml = await unzip(bytes);
  else if (format === 'gzip') {
    xml = await inflate(bytes, 'gzip', DMARC_LIMITS.uncompressedBytes);
  } else xml = bytes;
  if (xml.length > DMARC_LIMITS.uncompressedBytes) {
    throw new DmarcInputError('report is too large once decompressed');
  }
  // A gzip or zip around another gzip happens; one more level, never more.
  if (format !== 'xml' && magicFormat(xml) === 'gzip') {
    xml = await inflate(xml, 'gzip', DMARC_LIMITS.uncompressedBytes);
  }
  // TextDecoder drops a UTF-8 byte order mark itself (ignoreBOM is false by default).
  return new TextDecoder('utf-8').decode(xml);
}
