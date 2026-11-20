/**
 * What every vault operation runs with: the database, the keys only the vault holds, how it
 * signs and seals (vars the installer renders), and who is asking (the entrypoint the call came
 * through). The worker builds one per request from its env (env.ts); the fake builds one from a
 * test env, so both run the same operations.
 */
import type { Logger } from '@swarm/runtime';
import type { Keyring, LinkMode, SigningKeyring, VerifyKeyring } from '@swarm/tokens';
import type { VaultCaller, VaultFailure, VaultResult } from '../api';

export interface VaultKeys {
  /** FIELD_KEYS: seals and opens every stored secret and encrypted field. */
  field: Keyring;
  /** SIGNUP_KEYS (HMAC): join and journey tokens, signed and verified only here. */
  signup: SigningKeyring;
  /** MEMBER_SIGNING_KEYS (Ed25519): Member Center links for api and capture. */
  memberSigning: SigningKeyring;
  /** MEMBER_VERIFY_KEYS: to check the member links callers present. */
  memberVerify: VerifyKeyring;
  /** GOODS_SIGNING_KEYS (Ed25519): goods links for site and api. */
  goodsSigning: SigningKeyring;
  /** MEMBER_KEYS while links from before the cutover still verify (and signing is still v1). */
  memberLegacy: Keyring | null;
}

interface VaultConfig {
  /** VAULT_WRITE_FORMAT: `legacy` writes what callers holding FIELD_KEYS still read; `v3` binds rows. */
  writeFormat: 'legacy' | 'v3';
  /** VAULT_LEGACY_OPEN: whether values in the older, unbound formats still open. */
  legacyOpen: boolean;
  /** LINK_SIGNING_MODE and LINK_LEGACY_CUTOFF (@swarm/tokens linkModeFromEnv). */
  links: LinkMode;
  /** Plain http (and any host) for outbound calls: development and tests only. */
  development: boolean;
}

interface VaultSecrets {
  /** The platform STRIPE_SECRET_KEY (payments on), for Channels without their own key. */
  stripeSecretKey: string | null;
  /** DEBOUNCE_API_KEY (email checks on). */
  debounceApiKey: string | null;
}

export interface VaultContext {
  db: D1Database;
  keys: VaultKeys;
  config: VaultConfig;
  secrets: VaultSecrets;
  /** The entrypoint the call came through; `vault` for its own cron. */
  caller: VaultCaller | 'vault';
  log: Logger;
  /** Outbound requests (the provider proxy, SSO); tests pass a stub. */
  fetch: typeof fetch;
  now(): number;
}

export const ok = <T>(value: T): VaultResult<T> => ({ ok: true, value });
export const fail = <T = never>(reason: VaultFailure): VaultResult<T> => ({ ok: false, reason });

/** Thrown inside an operation to end it with a failure; run() turns it into the result. */
export class VaultRefusal extends Error {
  constructor(
    readonly reason: VaultFailure,
    readonly detail?: string,
  ) {
    super(detail ?? reason);
    this.name = 'VaultRefusal';
  }
}

export const refuse = (detail?: string): never => {
  throw new VaultRefusal('refused', detail);
};
export const notFound = (detail?: string): never => {
  throw new VaultRefusal('not_found', detail);
};
export const invalid = (detail?: string): never => {
  throw new VaultRefusal('invalid', detail);
};

/**
 * A record built without a prototype (so a key like "constructor" is never inherited), as a
 * plain object for an RPC answer: workerd's serializer refuses an object whose prototype is not
 * Object.prototype. Object.fromEntries defines every key as the object's own data, "__proto__"
 * included, so nothing is set on a prototype.
 */
export const plainRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record));
