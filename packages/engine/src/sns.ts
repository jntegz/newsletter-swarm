/**
 * Amazon SNS message verification (SignatureVersion 2, RSA SHA-256).
 *
 * - The signing certificate must come from https://sns.<region>.amazonaws.com/…pem.
 * - The public key is read from the certificate with a minimal DER walk (Web Crypto imports
 *   SPKI, not X.509), then the canonical string is verified.
 * - Messages older than an hour are refused, which limits replay of captured notifications;
 *   within that window each MessageId is applied once (SNS_MESSAGE_ID_LIFETIME_MS).
 */

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

export type SnsFailure =
  'malformed' | 'version' | 'cert_url' | 'cert' | 'signature' | 'stale' | 'topic';

const MAX_AGE_MS = 60 * 60 * 1000;
/** How long a MessageId is remembered: an hour either side of its Timestamp, plus a margin. */
export const SNS_MESSAGE_ID_LIFETIME_MS = 2 * MAX_AGE_MS + 10 * 60 * 1000;

export function isSnsHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname) &&
      parsed.port === ''
    );
  } catch {
    return false;
  }
}

export function parseSnsMessage(body: string): SnsMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const strings = [
    'Type',
    'MessageId',
    'TopicArn',
    'Message',
    'Timestamp',
    'SignatureVersion',
    'Signature',
    'SigningCertURL',
  ];
  if (!strings.every((key) => typeof m[key] === 'string')) return null;
  if (
    !['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(
      m.Type as string,
    )
  )
    return null;
  return m as unknown as SnsMessage;
}

/** The exact string SNS signs, per message type. */
export function stringToSign(m: SnsMessage): string {
  const fields: (keyof SnsMessage)[] =
    m.Type === 'Notification'
      ? [
          'Message',
          'MessageId',
          ...(m.Subject !== undefined ? (['Subject'] as const) : []),
          'Timestamp',
          'TopicArn',
          'Type',
        ]
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return fields.map((key) => `${key}\n${m[key] ?? ''}\n`).join('');
}

// ---- DER -------------------------------------------------------------------------------------

interface Tlv {
  tag: number;
  start: number; // first byte of the TLV
  contentStart: number;
  end: number; // one past the last byte
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  if (tag === undefined || length === undefined) throw new Error('truncated DER');
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | (bytes[offset + 2 + i] ?? 0);
    header += count;
  }
  const end = offset + header + length;
  if (end > bytes.length) throw new Error('truncated DER');
  return { tag, start: offset, contentStart: offset + header, end };
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readTlv(bytes, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

/** Returns the SubjectPublicKeyInfo of an X.509 certificate (PEM). */
export function spkiFromPem(pem: string): Uint8Array {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!match?.[1]) throw new Error('not a PEM certificate');
  const der = Uint8Array.from(atob(match[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const certificate = readTlv(der, 0);
  const [tbs] = children(der, certificate);
  if (!tbs || tbs.tag !== 0x30) throw new Error('malformed certificate');
  const fields = children(der, tbs);
  // tbsCertificate: [0] version (optional), serial, signature, issuer, validity, subject, spki, …
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const spki = fields[offset + 5];
  if (!spki || spki.tag !== 0x30) throw new Error('malformed certificate');
  return der.slice(spki.start, spki.end);
}

// ---- Verification ----------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

export type CertFetcher = (url: string) => Promise<string>;

const defaultFetcher: CertFetcher = async (url) => {
  const res = await fetch(url, { cf: { cacheTtl: 86_400, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error(`certificate fetch failed with ${res.status}`);
  return res.text();
};

async function signingKey(url: string, fetcher: CertFetcher): Promise<CryptoKey> {
  let key = keyCache.get(url);
  if (!key) {
    key = fetcher(url).then((pem) =>
      crypto.subtle.importKey(
        'spki',
        spkiFromPem(pem) as BufferSource,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
    keyCache.set(url, key);
    key.catch(() => keyCache.delete(url));
  }
  return key;
}

export async function verifySnsMessage(
  m: SnsMessage,
  options: { allowedTopics: string[]; now?: number; fetchCert?: CertFetcher },
): Promise<{ ok: true } | { ok: false; reason: SnsFailure }> {
  if (m.SignatureVersion !== '2') return { ok: false, reason: 'version' };
  if (!isSnsHost(m.SigningCertURL) || !new URL(m.SigningCertURL).pathname.endsWith('.pem')) {
    return { ok: false, reason: 'cert_url' };
  }
  if (!options.allowedTopics.includes(m.TopicArn)) return { ok: false, reason: 'topic' };
  const sent = Date.parse(m.Timestamp);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(sent) || Math.abs(now - sent) > MAX_AGE_MS)
    return { ok: false, reason: 'stale' };

  let key: CryptoKey;
  try {
    key = await signingKey(m.SigningCertURL, options.fetchCert ?? defaultFetcher);
  } catch {
    return { ok: false, reason: 'cert' };
  }
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    new TextEncoder().encode(stringToSign(m)),
  );
  return valid ? { ok: true } : { ok: false, reason: 'signature' };
}
