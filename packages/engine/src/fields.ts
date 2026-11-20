/**
 * Profile field values: validation against the field's type, the storage columns each type uses,
 * and AES-256-GCM encryption for fields marked encrypted.
 *
 * Storage (member_field_values):
 *   text, select, date (YYYY-MM-DD)  → value_text
 *   multi_select                     → value_text, a JSON array in the field's option order
 *   number, boolean (0/1)            → value_num
 *   encrypted (any type)             → value_enc only: "<kid>.<iv b64url>.<ciphertext b64url>"
 *                                      of the JSON-encoded normalised value
 *
 * Keys come from FIELD_KEYS in the usual keyring format (`kid:secret,...`); the AES key is derived
 * from the secret with HKDF-SHA256, and the first key encrypts while every key decrypts.
 */
import type { FieldType, FieldValue } from '@swarm/domain';
import { keyFor, type Keyring } from '@swarm/tokens';

export interface FieldDef {
  key: string;
  type: FieldType;
  options: readonly string[];
  encrypted: boolean;
}

export interface StoredValue {
  value_text: string | null;
  value_num: number | null;
  value_enc: string | null;
}

export class FieldValueError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'FieldValueError';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates and normalises a value for `field`. Null (or an empty string or list) means "clear". */
export function normalizeFieldValue(field: FieldDef, value: unknown): FieldValue {
  if (value === null || value === undefined || value === '') return null;
  const fail = (message: string): never => {
    throw new FieldValueError(field.key, message);
  };
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') fail('Enter text.');
      const text = (value as string).trim();
      if (text.length > 2000) fail('Keep it under 2,000 characters.');
      return text || null;
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) fail('Enter a number.');
      return n as number;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && /^(true|yes|1)$/i.test(value.trim())) return true;
      if (typeof value === 'string' && /^(false|no|0)$/i.test(value.trim())) return false;
      return fail('Use yes or no.');
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE.test(value.trim()))
        fail('Use a date like 2026-10-27.');
      const text = (value as string).trim();
      const parsed = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        fail('That date does not exist.');
      }
      return text;
    }
    case 'select': {
      if (typeof value !== 'string') fail('Pick one of the choices.');
      const match = field.options.find(
        (o) => o.toLowerCase() === (value as string).trim().toLowerCase(),
      );
      return match ?? fail(`Pick one of: ${field.options.join(', ')}.`);
    }
    case 'multi_select': {
      const list =
        typeof value === 'string' ? value.split(/[;,]/).map((v) => v.trim()) : (value as unknown);
      if (!Array.isArray(list)) fail('Pick from the choices.');
      const chosen = new Set<string>();
      for (const item of list as unknown[]) {
        if (typeof item !== 'string' || !item.trim()) continue;
        const match = field.options.find((o) => o.toLowerCase() === item.trim().toLowerCase());
        if (!match) fail(`"${item}" is not one of: ${field.options.join(', ')}.`);
        chosen.add(match as string);
      }
      // Stored in option order, so equal sets compare equal.
      const ordered = field.options.filter((o) => chosen.has(o));
      return ordered.length ? ordered : null;
    }
  }
}

/** Storage columns for a normalised value. Encrypted fields need a keyring. */
export async function toStored(
  field: FieldDef,
  value: FieldValue,
  keys?: Keyring,
): Promise<StoredValue | null> {
  if (value === null) return null;
  if (field.encrypted) {
    if (!keys) throw new Error('FIELD_KEYS is required to store encrypted fields');
    return storedValue(field, value, await encrypt(keys, JSON.stringify(value)));
  }
  return storedValue(field, value);
}

/**
 * Storage columns for a normalised value, without a key: an encrypted field's `sealed` is what the
 * vault sealed for this Member and field (null clears it). Callers outside the vault use this.
 */
export function storedValue(
  field: FieldDef,
  value: FieldValue,
  sealed?: string | null,
): StoredValue | null {
  if (value === null) return null;
  if (field.encrypted) {
    if (!sealed) throw new Error('An encrypted field needs the value the vault sealed');
    return { value_text: null, value_num: null, value_enc: sealed };
  }
  switch (field.type) {
    case 'number':
      return { value_text: null, value_num: value as number, value_enc: null };
    case 'boolean':
      return { value_text: null, value_num: value ? 1 : 0, value_enc: null };
    case 'multi_select':
      return { value_text: JSON.stringify(value), value_num: null, value_enc: null };
    default:
      return { value_text: value as string, value_num: null, value_enc: null };
  }
}

/** Reads an unencrypted stored value back; an encrypted one is opened by the vault (null here). */
export function plainFromStored(field: FieldDef, row: StoredValue): FieldValue {
  if (row.value_enc !== null) return null;
  switch (field.type) {
    case 'number':
      return row.value_num;
    case 'boolean':
      return row.value_num === null ? null : row.value_num !== 0;
    case 'multi_select':
      return row.value_text === null ? null : (JSON.parse(row.value_text) as string[]);
    default:
      return row.value_text;
  }
}

/** Reads a stored value back. Encrypted values that no key can open come back null. */
export async function fromStored(
  field: FieldDef,
  row: StoredValue,
  keys?: Keyring,
): Promise<FieldValue> {
  if (row.value_enc !== null) {
    if (!keys) return null;
    const plain = await decrypt(keys, row.value_enc);
    return plain === null ? null : (JSON.parse(plain) as FieldValue);
  }
  return plainFromStored(field, row);
}

// ---- AES-256-GCM -------------------------------------------------------------------------------

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string, info = 'swarm:member-fields:v1'): Promise<CryptoKey> {
  const cacheKey = `${info}\u0000${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0),
          info: encoder.encode(info),
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(cacheKey, key);
  }
  return key;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function encrypt(keys: Keyring, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keys.keys[keys.current] as string);
  // The key id is bound as additional data, so a value can't be replayed under another key id.
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(keys.current) },
    key,
    encoder.encode(plaintext),
  );
  return `${keys.current}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

export async function decrypt(keys: Keyring, sealed: string): Promise<string | null> {
  const [kid, iv, body] = sealed.split('.');
  const secret = kid ? keyFor(keys, kid) : undefined;
  if (!secret || !iv || !body) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(iv), additionalData: encoder.encode(kid) },
      await aesKey(secret),
      fromB64url(body),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Sealing for one purpose with its own derived key (HKDF info `swarm:<purpose>:v1`), so a key
 * derived for one kind of value (say, a data request's address) opens no other kind (profile
 * fields, service secrets). Values look like `<purpose>~<key id>.<iv>.<ciphertext>`, with the
 * purpose and key id bound as additional data. `decryptFor` still opens a value sealed with
 * `encrypt` before the purpose existed. Same FIELD_KEYS root: holding the root opens everything.
 */
export async function encryptFor(
  keys: Keyring,
  purpose: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keys.keys[keys.current] as string, `swarm:${purpose}:v1`);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${purpose}:${keys.current}`) },
    key,
    encoder.encode(plaintext),
  );
  return `${purpose}~${keys.current}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

export async function decryptFor(
  keys: Keyring,
  purpose: string,
  sealed: string,
): Promise<string | null> {
  const prefix = `${purpose}~`;
  if (!sealed.startsWith(prefix)) return sealed.includes('~') ? null : decrypt(keys, sealed);
  const [kid, iv, body] = sealed.slice(prefix.length).split('.');
  const secret = kid ? keyFor(keys, kid) : undefined;
  if (!secret || !iv || !body) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(iv), additionalData: encoder.encode(`${purpose}:${kid}`) },
      await aesKey(secret, `swarm:${purpose}:v1`),
      fromB64url(body),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** The key id a sealed value names (not secret), or null. */
export function sealedKeyId(sealed: string): string | null {
  if (isSealedV3(sealed)) return sealed.split('.')[2] || null;
  const kid = sealed.slice(sealed.indexOf('~') + 1).split('.')[0];
  return kid || null;
}

// ---- Row-bound sealing (v3) --------------------------------------------------------------------

/**
 * Sealed format v3, written only by the vault (workers/vault): `fv3.<purpose>.<kid>.<iv>.<ct>`.
 * The key is derived for the purpose alone (HKDF info `swarm:sealed:<purpose>:v3`), and the
 * additional data is `fv3|<purpose>|<kid>|<binding>`, where the binding names the row the value
 * belongs to (sealedBinding). A value copied into another row, another Member's or another
 * tenant's, no longer opens: the vault computes the binding from the row it read, never from the
 * caller. The older formats (`<kid>.…`, `<purpose>~<kid>.…`) carry no binding; the vault opens
 * them while VAULT_LEGACY_OPEN is on and its cron seals them again as v3.
 */
const V3 = 'fv3';
const PURPOSE = /^[a-z][a-z0-9-]{0,39}$/;

export function isSealedV3(sealed: string): boolean {
  return sealed.startsWith(`${V3}.`);
}

/** The purpose a v3 value was sealed for, or null for any other value. */
export function sealedPurposeV3(sealed: string): string | null {
  return isSealedV3(sealed) ? (sealed.split('.')[1] ?? null) : null;
}

const v3Aad = (purpose: string, kid: string, binding: string) =>
  encoder.encode(`${V3}|${purpose}|${kid}|${binding}`);

function assertPurpose(purpose: string, binding: string): void {
  if (!PURPOSE.test(purpose)) throw new Error(`invalid sealing purpose "${purpose}"`);
  if (!binding) throw new Error('a v3 value needs the binding of its row');
}

/** Seals `plaintext` for `purpose`, bound to the row `binding` names, with the current key. */
export async function sealV3(
  keys: Keyring,
  purpose: string,
  binding: string,
  plaintext: string,
): Promise<string> {
  assertPurpose(purpose, binding);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keys.keys[keys.current] as string, `swarm:sealed:${purpose}:v3`);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: v3Aad(purpose, keys.current, binding) },
    key,
    encoder.encode(plaintext),
  );
  return `${V3}.${purpose}.${keys.current}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/**
 * Opens a v3 value sealed for `purpose` and the row `binding` names. Null for anything else: a
 * value of another purpose or row, another format, or a key id the keyring lacks.
 */
export async function openV3(
  keys: Keyring,
  purpose: string,
  binding: string,
  sealed: string,
): Promise<string | null> {
  assertPurpose(purpose, binding);
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== V3 || parts[1] !== purpose) return null;
  const [, , kid, iv, body] = parts as [string, string, string, string, string];
  const secret = keyFor(keys, kid);
  if (!secret || !iv || !body) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(iv), additionalData: v3Aad(purpose, kid, binding) },
      await aesKey(secret, `swarm:sealed:${purpose}:v3`),
      fromB64url(body),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** The parts of a row that a v3 value is bound to, in a fixed order. */
export interface SealedBindingParts {
  w?: string;
  c?: string;
  m?: string;
  f?: string;
  r?: string;
  e?: string;
  fl?: string;
  o?: string;
  sso?: string;
  copilot?: string;
  app?: string;
  kind?: string;
  d?: string;
  ac?: string;
}

const BINDING_ORDER: readonly (keyof SealedBindingParts)[] = [
  'w',
  'c',
  'm',
  'f',
  'r',
  'e',
  'fl',
  'o',
  'sso',
  'copilot',
  'app',
  'kind',
  'd',
  'ac',
];

/**
 * The binding string of a row: `w:<workspace>|c:<channel>|m:<member>|f:<field>` for a profile
 * field, and so on (packages/vault core/columns.ts lists each sealed column's parts). Parts are
 * ids, never values; a part containing `|` is refused rather than escaped.
 */
export function sealedBinding(parts: SealedBindingParts): string {
  const out: string[] = [];
  for (const name of BINDING_ORDER) {
    const value = parts[name];
    if (value === undefined) continue;
    if (!value || value.includes('|')) throw new Error(`invalid binding part ${name}`);
    out.push(`${name}:${value}`);
  }
  if (!out.length) throw new Error('empty binding');
  return out.join('|');
}

/**
 * A sealed value sealed again with the keyring's current key, keeping its form (with or without a
 * purpose), for re-encrypting stored values after FIELD_KEYS is rotated. `current` when it already
 * uses that key; `unreadable` when no key in the ring opens it.
 */
export async function resealWithCurrentKey(
  keys: Keyring,
  sealed: string,
): Promise<{ sealed: string } | 'current' | 'unreadable'> {
  // v3 values carry their row's binding, which only the vault can rebuild: its cron moves them.
  if (isSealedV3(sealed) || sealedKeyId(sealed) === keys.current) return 'current';
  const tilde = sealed.indexOf('~');
  if (tilde === -1) {
    const plain = await decrypt(keys, sealed);
    return plain === null ? 'unreadable' : { sealed: await encrypt(keys, plain) };
  }
  const purpose = sealed.slice(0, tilde);
  const plain = await decryptFor(keys, purpose, sealed);
  return plain === null ? 'unreadable' : { sealed: await encryptFor(keys, purpose, plain) };
}

const macKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC-SHA256 (hex) of `message` under a key derived for one purpose from one FIELD_KEYS entry
 * (HKDF info `swarm:<purpose>:v1`, as encryptFor), so it shares no key with sealed values. Null
 * when the keyring has no key `kid`. For values that must match again later without being
 * reversible, such as erasure markers.
 */
export async function macFor(
  keys: Keyring,
  purpose: string,
  kid: string,
  message: string,
): Promise<string | null> {
  const secret = keyFor(keys, kid);
  if (!secret) return null;
  const info = `swarm:${purpose}:v1`;
  const cacheKey = `${info}\u0000${secret}`;
  let key = macKeyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      );
    })();
    macKeyCache.set(cacheKey, key);
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(message)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
