// The in-process vault for capture's tests (capture holds no FIELD_KEYS, member or signup signing
// key, Stripe or DeBounce key): the vault's own code on this D1, with the test field and link
// keys, a platform Stripe key and a DeBounce key. Its Stripe calls go to the global fetch (which
// the setup answers), DeBounce to the engine's test fake (useDebounceFetchForTests).
import { env } from 'cloudflare:test';
import { debounceTestFetch, type PrivacyVault } from '@swarm/engine';
import {
  createFakeVault,
  markerPort,
  openedOrNull,
  testVaultEnv,
  useVaultForTests,
  vaultValue,
} from '@swarm/vault';

/** The platform Stripe key the vault holds in these tests. */
const VAULT_STRIPE_KEY = `sk_test_${'c'.repeat(32)}`;

const providers: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api.debounce.io/')) return debounceTestFetch()(input, init);
  return globalThis.fetch(input, init);
};

/** Puts the fake vault in place; `debounce: false` for an install without a DeBounce key. */
export async function installFakeVault(options: { debounce?: boolean } = {}): Promise<void> {
  useVaultForTests(
    'capture',
    createFakeVault(
      'capture',
      await testVaultEnv(env as never, {
        STRIPE_SECRET_KEY: VAULT_STRIPE_KEY,
        ...(options.debounce === false ? {} : { DEBOUNCE_API_KEY: 'test-debounce-key' }),
      }),
      { fetch: providers },
    ),
  );
}

/**
 * What the jobs worker hands the engine to run data requests (its JobsVault: markers, the
 * request's address and its export), for tests that run a request here as jobs would.
 */
export async function jobsPrivacyVault(): Promise<PrivacyVault> {
  const vault = createFakeVault('jobs', await testVaultEnv(env as never));
  return {
    ...markerPort(vault, { bulk: true }),
    openRequestAddress: async (requestId) =>
      openedOrNull(await vault.openDsrAddress({ kind: 'dsr-request', requestId })),
    buildRequestExport: async (requestId) =>
      vaultValue(await vault.buildDsrExport({ kind: 'dsr-request', requestId })) as Record<
        string,
        unknown
      >,
  };
}
