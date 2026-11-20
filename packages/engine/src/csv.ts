/**
 * CSV for imports and exports (RFC 4180, leniently).
 *
 * Parsing works on bytes, not text, so an import can resume from a byte offset: the structural
 * characters (quote, comma, semicolon, tab, CR, LF) are ASCII and never occur inside a UTF-8
 * multi-byte sequence, so record boundaries found in bytes are exact. Fields are decoded as UTF-8.
 *
 * Handles quoted fields, escaped quotes (""), separators and newlines inside quotes, CRLF, LF and
 * bare CR line endings, a UTF-8 byte order mark, and comma, semicolon or tab separators.
 */

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

export type CsvSeparator = ',' | ';' | '\t';

export interface CsvChunk {
  rows: string[][];
  /** Bytes consumed: the offset just past the last complete record. */
  consumed: number;
}

const decoder = new TextDecoder();

/** True when the bytes start with a UTF-8 byte order mark. */
export const hasBom = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

/**
 * Parses complete records from `bytes`. Unless `final` is set, a trailing record without a line
 * ending is left unconsumed, so the caller can read more and resume from `consumed`.
 * Blank lines are skipped. A quote left open at the end of a final chunk closes there.
 * The caller skips a byte order mark at the start of the file (see `hasBom`).
 */
export function parseCsvChunk(
  bytes: Uint8Array,
  options: { final: boolean; separator?: CsvSeparator; limit?: number },
): CsvChunk {
  const limit = options.limit ?? Infinity;
  const sep = (options.separator ?? ',').charCodeAt(0);
  const rows: string[][] = [];
  let consumed = 0;
  let i = 0;
  let row: string[] = [];
  let field: number[] | null = null; // bytes of a quoted field being unescaped
  let start = 0; // start of an unquoted field
  let quoted = false;
  let inQuotes = false;

  const pushField = (end: number) => {
    const text = quoted
      ? decoder.decode(Uint8Array.from(field ?? []))
      : decoder.decode(bytes.subarray(start, end));
    row.push(text);
    field = null;
    quoted = false;
  };
  const endRecord = (next: number) => {
    // A line holding nothing at all is blank, not a record with one empty field.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    consumed = next;
    start = next;
  };

  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (inQuotes) {
      if (b === QUOTE) {
        if (bytes[i + 1] === QUOTE) {
          (field as number[]).push(QUOTE);
          i += 2;
          continue;
        }
        if (i + 1 >= bytes.length && !options.final) break; // "" may straddle the chunk
        inQuotes = false;
        i++;
        continue;
      }
      (field as number[]).push(b);
      i++;
      continue;
    }
    if (b === QUOTE && i === start && !quoted) {
      quoted = true;
      inQuotes = true;
      field = [];
      i++;
      continue;
    }
    if (b === sep) {
      pushField(i);
      i++;
      start = i;
      continue;
    }
    if (b === LF || b === CR) {
      if (b === CR && i + 1 >= bytes.length && !options.final) break; // CRLF may straddle
      pushField(i);
      const next = b === CR && bytes[i + 1] === LF ? i + 2 : i + 1;
      endRecord(next);
      i = next;
      if (rows.length >= limit) return { rows, consumed };
      continue;
    }
    // Text after a closing quote ("ab"c) is kept, as spreadsheets do.
    if (quoted) (field as number[]).push(b);
    i++;
  }

  if (options.final) {
    if (start < bytes.length || row.length > 0 || quoted) {
      pushField(bytes.length);
      endRecord(bytes.length);
    }
    consumed = bytes.length;
  }
  return { rows, consumed };
}

/** Parses a whole document. Strips a byte order mark and detects the separator. */
export function parseCsv(input: string | Uint8Array): string[][] {
  let bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (hasBom(bytes)) bytes = bytes.subarray(3);
  return parseCsvChunk(bytes, { final: true, separator: detectSeparator(bytes) }).rows;
}

/** The most frequent of comma, semicolon and tab outside quotes on the first line. */
export function detectSeparator(bytes: Uint8Array): CsvSeparator {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < bytes.length && i < 65_536; i++) {
    const b = bytes[i];
    if (b === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes && (b === LF || b === CR)) break;
    else if (!inQuotes && b === 0x2c) counts[',']++;
    else if (!inQuotes && b === 0x3b) counts[';']++;
    else if (!inQuotes && b === 0x09) counts['\t']++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

// ---- Import headers ---------------------------------------------------------------------------

/** How much of a file is read to find the header row and the separator. */
export const HEADER_PEEK_BYTES = 64 * 1024;

const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CsvLayout {
  separator: CsvSeparator;
  /** Byte offset of the first data row (after the BOM and any header row). */
  dataOffset: number;
  /** Column names; "Column 1"… when the file has no header row. */
  columns: string[];
  headerless: boolean;
}

/**
 * Reads the layout from the start of a file: separator, header row and where data begins.
 * A first row holding an email address is data, not a header. Blank or repeated header names
 * become "Column N" and "Name (2)", so every column has a unique name. Returns null when no
 * complete first row fits in `head` (pass `final` when `head` is the whole file).
 */
export function csvLayout(head: Uint8Array, final: boolean): CsvLayout | null {
  const bom = hasBom(head) ? 3 : 0;
  const body = head.subarray(bom);
  const separator = detectSeparator(body);
  const { rows, consumed: firstEnd } = parseCsvChunk(body, { final, separator, limit: 1 });
  const first = rows[0];
  if (!first) return null;
  const headerless = first.some((cell) => LOOKS_LIKE_EMAIL.test(cell.trim()));
  const seen = new Map<string, number>();
  const columns = first.map((cell, i) => {
    const base = headerless ? '' : cell.trim().slice(0, 200);
    let name = base || `Column ${i + 1}`;
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), count);
    if (count > 1) name = `${name} (${count})`;
    return name;
  });
  return { separator, dataOffset: bom + (headerless ? 0 : firstEnd), columns, headerless };
}

// ---- Writing ----------------------------------------------------------------------------------

/**
 * One CSV cell. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR) get a
 * leading apostrophe, so an export can't carry a formula injection into someone's spreadsheet.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells: (string | number | boolean | null | undefined)[]) =>
  `${cells.map(csvCell).join(',')}\r\n`;
