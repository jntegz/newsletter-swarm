/**
 * Keyrings for v2 links (links.ts), imported once into CryptoKeys. The text is the v1 format,
 * `kid:secret[,kid:secret...]`, first entry current:
 * - HMAC-SHA256: the secret is at least 32 characters, used as is (as in v1).
 * - Ed25519, signing (`<NAME>_SIGNING_KEYS`): base64url of the PKCS#8 private key.
 * - Ed25519, verifying (`<NAME>_VERIFY_KEYS`): base64url of the raw 32-byte public key.
 */
import { KEYRING_ALGS, type KeyringName, type LinkAlg } from './families';
import { base64UrlDecode, base64UrlEncode, parseKeyring } from './keyring';

interface ImportedKeyring {
  /** Which keyring this is: a family refuses every other one, whatever its keys. */
  name: KeyringName;
  alg: LinkAlg;
  keys: Readonly<Record<string, CryptoKey>>;
}

/** Signs with `current`. For HMAC its keys also verify. */
export interface SigningKeyring extends ImportedKeyring {
  current: string;
}

/** Verifies only: for Ed25519 it holds public keys. */
export type VerifyKeyring = ImportedKeyring;

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';
const ED25519 = { name: 'Ed25519' } as const;
const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;

function linkAlg(name: KeyringName): LinkAlg {
  const alg = KEYRING_ALGS[name];
  if (alg === 'aes-256-gcm') throw new Error(`${name} seals values; it does not sign links`);
  return alg;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function bytesOf(
  name: KeyringName,
  kid: string,
  secret: string,
  what: string,
): Uint8Array<ArrayBuffer> {
  try {
    return base64UrlDecode(secret);
  } catch {
    throw new Error(`${name} entry "${kid}" is not ${what}`);
  }
}

async function importEntries(
  name: KeyringName,
  value: string,
  role: 'sign' | 'verify',
): Promise<{ current: string; keys: Record<string, CryptoKey> }> {
  const ring = parseKeyring(value);
  const alg = linkAlg(name);
  const keys = Object.create(null) as Record<string, CryptoKey>;
  for (const [kid, secret] of Object.entries(ring.keys)) {
    if (alg === 'hmac-sha256') {
      const usages: ('sign' | 'verify')[] = role === 'sign' ? ['sign', 'verify'] : ['verify'];
      keys[kid] = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        HMAC,
        false,
        usages,
      );
    } else if (role === 'sign') {
      const der = bytesOf(name, kid, secret, 'an Ed25519 private key');
      if (der.length !== 48 || !hex(der).startsWith(PKCS8_ED25519_PREFIX)) {
        throw new Error(`${name} entry "${kid}" is not an Ed25519 private key`);
      }
      keys[kid] = await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign']);
    } else {
      const raw = bytesOf(name, kid, secret, 'an Ed25519 public key');
      if (raw.length !== 32) throw new Error(`${name} entry "${kid}" is not an Ed25519 public key`);
      keys[kid] = await crypto.subtle.importKey('raw', raw, ED25519, false, ['verify']);
    }
  }
  return { current: ring.current, keys };
}

/**
 * Checks a keyring secret's text without importing it (env parsing is synchronous): `secret` is a
 * keyring name, or `<NAME>_VERIFY_KEYS` for an Ed25519 keyring's public keys. Throws with the
 * problem, never the value. The import at first use (parseSigningKeyring) checks the rest.
 */
export function checkKeyringText(secret: string, value: string): void {
  const verify = secret.endsWith('_VERIFY_KEYS');
  const name = (verify ? secret.replace(/_VERIFY_KEYS$/, '_SIGNING_KEYS') : secret) as KeyringName;
  if (!Object.hasOwn(KEYRING_ALGS, name)) throw new Error(`${secret} is not a keyring`);
  const ring = parseKeyring(value);
  if (KEYRING_ALGS[name] !== 'ed25519') {
    if (verify) throw new Error(`${name} is not an Ed25519 keyring`);
    return;
  }
  const what = verify ? 'an Ed25519 public key' : 'an Ed25519 private key';
  for (const [kid, text] of Object.entries(ring.keys)) {
    const bytes = bytesOf(name, kid, text, what);
    const ok = verify
      ? bytes.length === 32
      : bytes.length === 48 && hex(bytes).startsWith(PKCS8_ED25519_PREFIX);
    if (!ok) throw new Error(`${secret} entry "${kid}" is not ${what}`);
  }
}

/** The keyring a signer holds (its secret `name`). Throws on a malformed value: fail closed. */
export async function parseSigningKeyring(
  name: KeyringName,
  value: string,
): Promise<SigningKeyring> {
  const { current, keys } = await importEntries(name, value, 'sign');
  return { name, alg: linkAlg(name), current, keys };
}

/**
 * The keyring a verifier holds: for Ed25519 the public keys (secret `<NAME>_VERIFY_KEYS`, see
 * verifyKeysName), for HMAC the shared keyring itself.
 */
export async function parseVerifyKeyring(name: KeyringName, value: string): Promise<VerifyKeyring> {
  const { keys } = await importEntries(name, value, 'verify');
  return { name, alg: linkAlg(name), keys };
}

/**
 * The public keyring for an Ed25519 signing keyring, in the same order: what the installer gives
 * the verifiers. The public key comes from the private key's JWK form (`x`).
 */
export async function publicKeyring(name: KeyringName, signingValue: string): Promise<string> {
  if (linkAlg(name) !== 'ed25519') throw new Error(`${name} is not an Ed25519 keyring`);
  const ring = parseKeyring(signingValue);
  const entries: string[] = [];
  for (const [kid, secret] of Object.entries(ring.keys)) {
    const der = bytesOf(name, kid, secret, 'an Ed25519 private key');
    const key = await crypto.subtle.importKey('pkcs8', der, ED25519, true, ['sign']);
    // Typed as a union in workers-types; a JWK export is always the JWK.
    const { x } = (await crypto.subtle.exportKey('jwk', key)) as { x?: unknown };
    if (typeof x !== 'string' || x.length !== 43) {
      throw new Error(`${name} entry "${kid}" has no public key`);
    }
    entries.push(`${kid}:${x}`);
  }
  return entries.join(',');
}

/** A new Ed25519 private key, as a keyring entry's secret (base64url PKCS#8). */
export async function newEd25519Secret(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as {
    privateKey: CryptoKey;
  };
  const der = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  return base64UrlEncode(new Uint8Array(der));
}
