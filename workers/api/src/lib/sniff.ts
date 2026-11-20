/**
 * Identifies an upload from its bytes, never from the client's declared type or name.
 * Only formats that cannot carry script are accepted: no SVG, no HTML. Fonts are WOFF2 and WOFF,
 * whose header names the whole file's length; a file that disagrees with its header is refused.
 */
interface Sniffed {
  contentType: string;
  extension: string;
  width: number | null;
  height: number | null;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, i) => bytes[offset + i] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

export function sniff(bytes: Uint8Array): Sniffed | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      contentType: 'image/png',
      extension: 'png',
      width: bytes.length >= 24 ? view.getUint32(16) : null,
      height: bytes.length >= 24 ? view.getUint32(20) : null,
    };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extension: 'jpg', ...jpegSize(bytes) };
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      contentType: 'image/gif',
      extension: 'gif',
      width: bytes.length >= 10 ? view.getUint16(6, true) : null,
      height: bytes.length >= 10 ? view.getUint16(8, true) : null,
    };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp', ...webpSize(bytes) };
  }
  if (ascii(bytes, 4, 12) === 'ftypavif' || ascii(bytes, 4, 12) === 'ftypavis') {
    return { contentType: 'image/avif', extension: 'avif', width: null, height: null };
  }
  if (ascii(bytes, 0, 5) === '%PDF-') {
    return { contentType: 'application/pdf', extension: 'pdf', width: null, height: null };
  }
  const font = ascii(bytes, 0, 4);
  if ((font === 'wOF2' || font === 'wOFF') && woffLength(bytes) === bytes.length) {
    return font === 'wOF2'
      ? { contentType: 'font/woff2', extension: 'woff2', width: null, height: null }
      : { contentType: 'font/woff', extension: 'woff', width: null, height: null };
  }
  return null;
}

/** The kinds of upload, by sniffed type: fonts have their own size limit and their own list. */
export const isFont = (contentType: string) =>
  contentType === 'font/woff2' || contentType === 'font/woff';

/** A WOFF or WOFF2 header's `length`: the whole file's size, big-endian at byte 8. */
function woffLength(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
}

function jpegSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return { width: null, height: null };
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return { width, height };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function webpSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  const chunk = ascii(bytes, 12, 16);
  const at = (i: number) => bytes[i] ?? 0;
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
      height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const b = [at(21), at(22), at(23), at(24)];
    return {
      width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!),
      height: 1 + (((b[3]! & 0x0f) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)),
    };
  }
  return { width: null, height: null };
}
