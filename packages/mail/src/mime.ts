/**
 * Raw MIME for outbound mail: multipart/alternative (text + HTML), base64 bodies, CRLF line
 * endings, RFC 2047 encoded headers. Raw MIME is what lets List-Unsubscribe and Feedback-ID
 * reach the inbox intact (the legacy code used SES "Simple" content, which dropped them).
 */
import type { Address } from './index';

interface MimeMessage {
  from: Address;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  /** Without angle brackets, e.g. "dl_0192…@news.example.com". */
  messageId: string;
  date?: Date;
  /** Extra headers such as List-Unsubscribe. Values must not contain line breaks. */
  headers?: Record<string, string>;
}

const CRLF = '\r\n';

export class HeaderInjectionError extends Error {
  constructor(name: string) {
    super(`header "${name}" contains a line break`);
    this.name = 'HeaderInjectionError';
  }
}

function assertHeaderValue(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new HeaderInjectionError(name);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/**
 * RFC 2047 "B" encoding, split into encoded words of at most 75 characters without breaking a
 * UTF-8 sequence, folded onto continuation lines.
 */
export function encodeHeaderWords(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk: number[] = [];
  // 45 bytes of payload → 60 base64 characters + 12 of "=?UTF-8?B??=" = 72, under the 75 limit.
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${toBase64(new Uint8Array(chunk))}?=`);
    chunk = [];
  };
  for (const char of value) {
    const bytes = new TextEncoder().encode(char);
    if (chunk.length + bytes.length > 45) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(`${CRLF} `);
}

/** "Display Name" <address>, with RFC 2047 for non-ASCII names. */
function formatMailbox({ name, address }: Address): string {
  assertHeaderValue('address', address);
  if (!/^[^\s<>@",]+@[^\s<>@",]+$/.test(address)) throw new Error(`invalid address "${address}"`);
  if (!name) return address;
  assertHeaderValue('display name', name);
  if (isAscii(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${encodeHeaderWords(name)} <${address}>`;
}

function base64Body(content: string): string {
  const encoded = toBase64(new TextEncoder().encode(content));
  return encoded.replace(/.{1,76}/g, (line) => line + CRLF);
}

function boundary(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `swarm-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Builds the full RFC 5322 message. */
export function buildMime(message: MimeMessage): string {
  const date = message.date ?? new Date();
  assertHeaderValue('Subject', message.subject);
  assertHeaderValue('Message-ID', message.messageId);
  if (message.replyTo) assertHeaderValue('Reply-To', message.replyTo);

  const lines: string[] = [
    `From: ${formatMailbox(message.from)}`,
    `To: ${formatMailbox({ address: message.to })}`,
  ];
  if (message.replyTo) lines.push(`Reply-To: ${formatMailbox({ address: message.replyTo })}`);
  lines.push(
    `Subject: ${encodeHeaderWords(message.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${message.messageId}>`,
    'MIME-Version: 1.0',
  );
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`invalid header name "${name}"`);
    assertHeaderValue(name, value);
    lines.push(`${name}: ${value}`);
  }

  const mark = boundary();
  lines.push(`Content-Type: multipart/alternative; boundary="${mark}"`, '');
  const body = [
    `--${mark}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.text),
    `--${mark}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.html),
    `--${mark}--`,
    '',
  ];
  return lines.join(CRLF) + CRLF + body.join(CRLF);
}

/**
 * RFC 8058 One-Click unsubscribe headers. Both an https URL (POSTed by the mailbox provider)
 * and a mailto fallback are listed; the Post header value is fixed by the RFC.
 */
export function unsubscribeHeaders(
  httpsUrl: string,
  mailto: string | null,
): Record<string, string> {
  if (!httpsUrl.startsWith('https://') && !httpsUrl.startsWith('http://localhost')) {
    throw new Error('List-Unsubscribe needs an https URL');
  }
  const targets = [`<${httpsUrl}>`];
  if (mailto) targets.push(`<mailto:${mailto}>`);
  return {
    'List-Unsubscribe': targets.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
