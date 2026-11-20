// The recovery kit at rest: the install's state and keys, encrypted under a passphrase the person
// chooses, so the file alone (in a downloads folder, a backup, a synced drive) yields no key.
// PBKDF2-SHA256 and AES-256-GCM through WebCrypto, so the Setup Worker, the setup page's script
// and the installer all read and write the same file. Losing the passphrase loses the kit, and
// with it FIELD_KEYS: the setup page says so when it is chosen.
import { InstallError } from './ui';

const KIT_FORMAT = 'swarm-recovery-kit';
const KIT_VERSION = 2;
/** The most PBKDF2 iterations Cloudflare Workers allow. */
const KIT_ITERATIONS = 100_000;
export const MIN_KIT_PASSPHRASE = 12;
/** Binds the ciphertext to this format, so it can't be passed off as another. */
const ADDITIONAL_DATA = `${KIT_FORMAT}:${KIT_VERSION}`;

export interface SealedKit {
  format: typeof KIT_FORMAT;
  version: typeof KIT_VERSION;
  what: string;
  createdAt: string;
  domain: string | null;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  /** base64 of the encrypted JSON `{ state, secrets }`. */
  sealed: string;
}

interface KitContents {
  state: unknown;
  secrets: unknown;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

interface Envelope {
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  sealed: string;
}

async function kitKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A key derived from a passphrase once, with its salt, to seal a file again without re-deriving. */
interface SealingKey {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
}

async function sealWith(sealing: SealingKey, additionalData: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(additionalData) },
    sealing.key,
    utf8(JSON.stringify(value)),
  );
  return {
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: sealing.iterations,
      salt: toBase64(sealing.salt),
    },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    sealed: toBase64(new Uint8Array(sealed)),
  } satisfies Envelope;
}

/** Opens an envelope, or returns null for a wrong passphrase or a changed file. */
async function openWith(
  envelope: Envelope,
  passphrase: string,
  additionalData: string,
): Promise<{ value: unknown; sealing: SealingKey } | null> {
  try {
    const salt = fromBase64(envelope.kdf.salt);
    const iterations = envelope.kdf.iterations;
    const key = await kitKey(passphrase, salt, iterations);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(envelope.cipher.iv) as Uint8Array<ArrayBuffer>,
        additionalData: utf8(additionalData),
      },
      key,
      fromBase64(envelope.sealed) as Uint8Array<ArrayBuffer>,
    );
    return {
      value: JSON.parse(new TextDecoder().decode(plain)) as unknown,
      sealing: { key, salt, iterations },
    };
  } catch {
    return null;
  }
}

const usableIterations = (envelope: Partial<Envelope>) =>
  typeof envelope.kdf?.iterations === 'number' && envelope.kdf.iterations >= 10_000;

/** Whether a parsed file is a sealed kit, rather than an old plain one. */
export function isSealedKit(kit: unknown): kit is SealedKit {
  return (
    typeof kit === 'object' &&
    kit !== null &&
    (kit as { format?: unknown }).format === KIT_FORMAT &&
    typeof (kit as { sealed?: unknown }).sealed === 'string'
  );
}

export async function sealKit(
  contents: KitContents,
  passphrase: string,
  meta: { what: string; createdAt: string; domain: string | null },
): Promise<SealedKit> {
  if (passphrase.length < MIN_KIT_PASSPHRASE) {
    throw new InstallError(
      `Choose a passphrase of at least ${MIN_KIT_PASSPHRASE} characters for the recovery kit.`,
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await kitKey(passphrase, salt, KIT_ITERATIONS);
  const envelope = await sealWith({ key, salt, iterations: KIT_ITERATIONS }, ADDITIONAL_DATA, {
    state: contents.state,
    secrets: contents.secrets,
  });
  return { format: KIT_FORMAT, version: KIT_VERSION, ...meta, ...envelope };
}

/** The state and secrets in a sealed kit. A wrong passphrase or a changed file opens nothing. */
export async function openKit(kit: SealedKit, passphrase: string): Promise<KitContents> {
  if (kit.version !== KIT_VERSION || !usableIterations(kit)) {
    throw new InstallError('This recovery kit is in a format this installer does not know.');
  }
  const opened = await openWith(kit, passphrase, ADDITIONAL_DATA);
  if (!opened) {
    throw new InstallError(
      'That passphrase does not open this recovery kit, or the file has been changed.',
      'Use the passphrase you chose when you saved the kit.',
    );
  }
  return opened.value as KitContents;
}

// ---- .swarm/<env>.secrets.json ------------------------------------------------------------------
// The installer's own copy of the keys, sealed the same way under the operator's passphrase. Only
// this computer ever opens it, so it can afford more PBKDF2 iterations than a Worker allows.

const SECRETS_FORMAT = 'swarm-secrets';
const SECRETS_VERSION = 1;
const SECRETS_ITERATIONS = 600_000;
/** Binds the ciphertext to the format and the environment, so files can't be swapped around. */
const secretsData = (env: string) => `${SECRETS_FORMAT}:${SECRETS_VERSION}:${env}`;

interface SealedSecretsFile extends Envelope {
  format: typeof SECRETS_FORMAT;
  version: typeof SECRETS_VERSION;
  what: string;
  env: string;
}

/** Whether a parsed secrets file is sealed, rather than the plain JSON older installers wrote. */
export function isSealedSecretsFile(file: unknown): file is SealedSecretsFile {
  return (
    typeof file === 'object' &&
    file !== null &&
    (file as { format?: unknown }).format === SECRETS_FORMAT &&
    typeof (file as { sealed?: unknown }).sealed === 'string'
  );
}

/** Derives the key for a new secrets file from a freshly chosen passphrase. */
export async function newSecretsKey(passphrase: string): Promise<SealingKey> {
  if (passphrase.length < MIN_KIT_PASSPHRASE) {
    throw new InstallError(
      `The passphrase for the secrets file must be at least ${MIN_KIT_PASSPHRASE} characters.`,
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    key: await kitKey(passphrase, salt, SECRETS_ITERATIONS),
    salt,
    iterations: SECRETS_ITERATIONS,
  };
}

export async function sealSecretsFile(
  sealing: SealingKey,
  env: string,
  secrets: unknown,
): Promise<SealedSecretsFile> {
  return {
    format: SECRETS_FORMAT,
    version: SECRETS_VERSION,
    what: 'The Swarm installer keys for this environment, encrypted under your passphrase (docs/self-hosting.md).',
    env,
    ...(await sealWith(sealing, secretsData(env), secrets)),
  };
}

/** The secrets in a sealed file, and the key that opened it, to write it back sealed. */
export async function openSecretsFile(
  file: SealedSecretsFile,
  passphrase: string,
  env: string,
  location: string,
): Promise<{ secrets: unknown; sealing: SealingKey }> {
  if (file.version !== SECRETS_VERSION || !usableIterations(file)) {
    throw new InstallError(`${location} is in a format this installer does not know.`);
  }
  const opened = await openWith(file, passphrase, secretsData(env));
  if (!opened) {
    throw new InstallError(
      `That passphrase does not open ${location}, or the file has been changed.`,
      'Use the passphrase you chose for it (or set SWARM_SECRETS_PASSPHRASE), and run the same command again.',
    );
  }
  return { secrets: opened.value, sealing: opened.sealing };
}

export type { SealingKey };
