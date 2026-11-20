/**
 * Keyring text (`kid:secret[,kid:secret...]`) and the base64url both token formats use.
 */

const KID_PATTERN = /^[a-z0-9]{1,16}$/;
const MIN_SECRET_LENGTH = 32;

export interface Keyring {
  /** Key id used for new tokens. */
  current: string;
  /** Every key that may still verify tokens, by key id. */
  keys: Readonly<Record<string, string>>;
}

/**
 * Parses `kid:secret[,kid:secret...]`. The first entry is the current signing key;
 * later entries only verify, which is how keys are rotated without breaking live links.
 */
export function parseKeyring(value: string): Keyring {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('keyring is empty');

  // No prototype, so no key id can ever resolve to an inherited property.
  const keys: Record<string, string> = Object.create(null) as Record<string, string>;
  let current: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const kid = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (separator < 1 || !KID_PATTERN.test(kid)) {
      throw new Error('keyring entries must look like "<kid>:<secret>" with a short lowercase kid');
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `keyring secret for "${kid}" must be at least ${MIN_SECRET_LENGTH} characters`,
      );
    }
    if (kid in keys) throw new Error(`keyring has duplicate kid "${kid}"`);
    keys[kid] = secret;
    current ??= kid;
  }
  return { current: current as string, keys };
}

/**
 * The secret for a key id that arrived from outside (a token, a sealed value), or undefined. Only
 * the keyring's own entries count: a kid such as "constructor" must not reach Object.prototype,
 * whose functions have source text anyone knows.
 */
export function keyFor(keyring: Keyring, kid: string): string | undefined {
  return ownKey(keyring.keys, kid);
}

/** keyFor for any map of keys by kid, such as the imported keys of a v2 keyring. */
export function ownKey<T>(keys: Readonly<Record<string, T>>, kid: string): T | undefined {
  if (!KID_PATTERN.test(kid) || !Object.hasOwn(keys, kid)) return undefined;
  return keys[kid];
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('not base64url');
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
