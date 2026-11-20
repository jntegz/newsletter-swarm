// The in-process vault for the api's tests (the api holds no FIELD_KEYS): the vault's own code on
// this D1, with the test field and link keys. Its provider requests (Stripe own keys, PayPal,
// Shorthop, the Copilot key, export buckets, the identity provider) go to the global fetch, which
// the setup answers for Turnstile, unless a test points them at a fake (useVaultProviderFetch).
import { env } from 'cloudflare:test';
import { createFakeVault, testVaultEnv, useVaultForTests } from '@swarm/vault';

const passThrough: typeof fetch = (input, init) => globalThis.fetch(input, init);
let providers: typeof fetch = passThrough;

/** Answers the vault's provider requests with `fetcher` (null: back to the global fetch). */
export function useVaultProviderFetch(fetcher: typeof fetch | null): void {
  providers = fetcher ?? passThrough;
}

/** Puts the fake vault in place (again, after a test swapped in another). */
export async function installFakeVault(): Promise<void> {
  useVaultForTests(
    'api',
    createFakeVault('api', await testVaultEnv(env as never), {
      fetch: (input, init) => providers(input, init),
    }),
  );
}
