/**
 * A throwaway RSA key and self-signed X.509 certificate for the SNS signature tests, made fresh on
 * every run so no private key is ever committed. Built with WebCrypto because the tests run inside
 * workerd, which has no way to shell out to openssl.
 */

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const header =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff];
  const out = new Uint8Array(header.length + length);
  out.set(header);
  let offset = header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SEQUENCE = 0x30;
const SET = 0x31;
const ascii = (text: string) => new TextEncoder().encode(text);

// sha256WithRSAEncryption, with its NULL parameters.
const SIGNATURE_ALGORITHM = der(
  SEQUENCE,
  Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00),
);
// CN=test-only, as issuer and subject.
const NAME = der(
  SEQUENCE,
  der(
    SET,
    der(SEQUENCE, Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x03), der(0x0c, ascii('test-only'))),
  ),
);
const VALIDITY = der(
  SEQUENCE,
  der(0x17, ascii('260101000000Z')),
  der(0x17, ascii('360101000000Z')),
);

const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const { publicKey, privateKey } = pair as CryptoKeyPair;

const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
const tbs = der(
  SEQUENCE,
  der(0xa0, der(0x02, Uint8Array.of(2))), // version 3
  der(0x02, Uint8Array.of(1)), // serial number
  SIGNATURE_ALGORITHM,
  NAME,
  VALIDITY,
  NAME,
  spki,
);
const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, tbs));
const certificate = der(
  SEQUENCE,
  tbs,
  SIGNATURE_ALGORITHM,
  der(0x03, Uint8Array.of(0), signature), // BIT STRING with no unused bits
);

/** Signs like SNS does, with the key that `cert` certifies. */
export const signingKey: CryptoKey = privateKey;

/** What SNS would serve from SigningCertURL. */
export const cert = `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...certificate))}\n-----END CERTIFICATE-----\n`;
