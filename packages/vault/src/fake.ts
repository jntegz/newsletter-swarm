/**
 * An in-process stand-in for the vault, for callers' tests: the same operations (core/ops.ts) on
 * the caller's test D1, behind the same per-caller interface the service binding has. Use it with
 * useVaultForTests(caller, createFakeVault(caller, await fakeVaultEnv(env.DB))). Results go
 * through structuredClone, as RPC would copy them, so a caller can't come to rely on sharing.
 */
import { newEd25519Secret, publicKeyring } from '@swarm/tokens';
import type { VaultCaller, VaultFor } from './api';
import { contextFromEnv, opsFor } from './core';
export { forgetProviderTokens } from './core/proxy';

/** A vault env for tests: fresh keys, legacy writes and opening on, v1 links (before the cutover). */
export async function fakeVaultEnv(
  db: D1Database,
  overrides: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> {
  const ed = async () => `t1:${await newEd25519Secret()}`;
  const memberSigning = await ed();
  return {
    ENVIRONMENT: 'test',
    DB: db,
    FIELD_KEYS: `f1:${'f'.repeat(64)}`,
    SIGNUP_KEYS: `s1:${'s'.repeat(64)}`,
    MEMBER_SIGNING_KEYS: memberSigning,
    MEMBER_VERIFY_KEYS: await publicKeyring('MEMBER_SIGNING_KEYS', memberSigning),
    GOODS_SIGNING_KEYS: await ed(),
    MEMBER_KEYS: `m1:${'m'.repeat(64)}`,
    LINK_SIGNING_MODE: 'v1',
    VAULT_WRITE_FORMAT: 'legacy',
    VAULT_LEGACY_OPEN: 'on',
    ...overrides,
  };
}

/** A result as RPC hands it over: copied, except a streamed body, which is passed through. */
function copyResult(result: unknown): unknown {
  const value = (result as { ok?: boolean; value?: { body?: unknown } } | null)?.value;
  if (value && typeof value === 'object' && value.body instanceof ReadableStream) {
    const { body, ...rest } = value;
    return { ok: true, value: { ...structuredClone(rest), body } };
  }
  return structuredClone(result);
}

/** `caller`'s entrypoint, run in process on `env` (fakeVaultEnv). */
export function createFakeVault<C extends VaultCaller>(
  caller: C,
  env: Record<string, unknown>,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): VaultFor[C] {
  const ops = opsFor(caller, () => contextFromEnv(env, caller, options)) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const cloned: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(ops)) {
    cloned[name] = async (...args: unknown[]) => copyResult(await method(...structuredClone(args)));
  }
  return cloned as unknown as VaultFor[C];
}

/**
 * A vault that is down, for callers' fail-closed tests: every method answers `unavailable`, as
 * the client does when the binding times out or throws.
 */
export function createDownVault<C extends VaultCaller>(): VaultFor[C] {
  return new Proxy({} as VaultFor[C], {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return async () => ({ ok: false, reason: 'unavailable' });
    },
  });
}

/**
 * fakeVaultEnv with a caller's own test bindings: the shared test link keys (TEST_LINK_KEYS, so a
 * link the vault mints verifies with the public keys the callers' tests hold), the link mode and
 * MEMBER_KEYS, and the platform Stripe and DeBounce keys the caller's tests run with.
 */
export async function testVaultEnv(
  env: Record<string, unknown> & { DB: D1Database },
  overrides: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> {
  const text = (name: string) =>
    typeof env[name] === 'string' ? (env[name] as string) : undefined;
  const linkKeys = text('TEST_LINK_KEYS');
  const links = (linkKeys ? JSON.parse(linkKeys) : {}) as Record<string, string>;
  const pick = (entries: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries(entries).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
  return fakeVaultEnv(env.DB, {
    ...pick({
      SIGNUP_KEYS: links.SIGNUP_KEYS,
      MEMBER_SIGNING_KEYS: links.MEMBER_SIGNING_KEYS,
      MEMBER_VERIFY_KEYS: links.MEMBER_VERIFY_KEYS,
      GOODS_SIGNING_KEYS: links.GOODS_SIGNING_KEYS,
      LINK_SIGNING_MODE: text('LINK_SIGNING_MODE'),
      LINK_LEGACY_CUTOFF: text('LINK_LEGACY_CUTOFF'),
      MEMBER_KEYS: text('MEMBER_KEYS'),
      // Only values the vault accepts (a caller's dev placeholders are not real keys).
      STRIPE_SECRET_KEY:
        (text('STRIPE_SECRET_KEY')?.length ?? 0) >= 32 ? text('STRIPE_SECRET_KEY') : undefined,
      DEBOUNCE_API_KEY:
        (text('DEBOUNCE_API_KEY')?.length ?? 0) >= 8 ? text('DEBOUNCE_API_KEY') : undefined,
    }),
    ...overrides,
  });
}
