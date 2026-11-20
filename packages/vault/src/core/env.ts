/**
 * The vault Worker's environment: its secrets (the only FIELD_KEYS outside a recovery kit), the
 * vars the installer renders, and DB. Parsed once per isolate and failing closed: with a missing
 * or malformed key the vault refuses every call (callers see `unavailable`), never a weaker mode.
 */
import { createLogger, defineEnv, BaseEnvSchema, binding, secret } from '@swarm/runtime';
import {
  linkModeFromEnv,
  parseKeyring,
  parseSigningKeyring,
  parseVerifyKeyring,
  type Keyring,
} from '@swarm/tokens';
import { z } from 'zod';
import type { VaultCaller } from '../api';
import type { VaultContext, VaultKeys } from './context';

const keyringText = z.string().refine((value) => {
  try {
    parseKeyring(value);
    return true;
  } catch {
    return false;
  }
}, 'is not a keyring');

const VaultEnvSchema = BaseEnvSchema.extend({
  DB: binding<D1Database>(),
  FIELD_KEYS: keyringText,
  SIGNUP_KEYS: keyringText,
  MEMBER_SIGNING_KEYS: keyringText,
  MEMBER_VERIFY_KEYS: keyringText,
  GOODS_SIGNING_KEYS: keyringText,
  /** Held only while v1 links are still accepted (and, before the cutover, signed). */
  MEMBER_KEYS: keyringText.optional(),
  LINK_SIGNING_MODE: z.enum(['v1', 'v2']),
  LINK_LEGACY_CUTOFF: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  /** `legacy` until callers no longer hold FIELD_KEYS and the switch is made (docs/deployment.md). */
  VAULT_WRITE_FORMAT: z.enum(['legacy', 'v3']),
  VAULT_LEGACY_OPEN: z.enum(['on', 'off']),
  /** Payments on: the platform key, for Channels without their own (absent: null). */
  STRIPE_SECRET_KEY: secret()
    .optional()
    .transform((value) => value ?? null),
  /** Email checks on (absent: null). */
  DEBOUNCE_API_KEY: z
    .string()
    .min(8)
    .optional()
    .transform((value) => value ?? null),
});

type VaultEnv = z.infer<typeof VaultEnvSchema>;

const parseVaultEnv = defineEnv(VaultEnvSchema);

const keyCache = new WeakMap<object, Promise<VaultKeys>>();

async function importKeys(env: VaultEnv): Promise<VaultKeys> {
  const field: Keyring = parseKeyring(env.FIELD_KEYS);
  return {
    field,
    signup: await parseSigningKeyring('SIGNUP_KEYS', env.SIGNUP_KEYS),
    memberSigning: await parseSigningKeyring('MEMBER_SIGNING_KEYS', env.MEMBER_SIGNING_KEYS),
    memberVerify: await parseVerifyKeyring('MEMBER_SIGNING_KEYS', env.MEMBER_VERIFY_KEYS),
    goodsSigning: await parseSigningKeyring('GOODS_SIGNING_KEYS', env.GOODS_SIGNING_KEYS),
    memberLegacy: env.MEMBER_KEYS ? parseKeyring(env.MEMBER_KEYS) : null,
  };
}

/**
 * A context for one call through `caller`'s entrypoint (or the vault's own cron). Throws on an
 * invalid environment; the entrypoint turns that into `unavailable`.
 */
export async function contextFromEnv(
  rawEnv: unknown,
  caller: VaultCaller | 'vault',
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<VaultContext> {
  const env = parseVaultEnv(rawEnv);
  let keys = keyCache.get(env);
  if (!keys) {
    keys = importKeys(env);
    keyCache.set(env, keys);
    keys.catch(() => keyCache.delete(env));
  }
  return {
    db: env.DB,
    keys: await keys,
    config: {
      writeFormat: env.VAULT_WRITE_FORMAT,
      legacyOpen: env.VAULT_LEGACY_OPEN === 'on',
      links: linkModeFromEnv(env),
      development: env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test',
    },
    secrets: {
      stripeSecretKey: env.STRIPE_SECRET_KEY,
      debounceApiKey: env.DEBOUNCE_API_KEY,
    },
    caller,
    log: createLogger({ service: 'vault', entrypoint: caller }),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? (() => Date.now()),
  };
}
