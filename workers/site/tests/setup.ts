import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, vi } from 'vitest';
import { createFakeVault, testVaultEnv, useVaultForTests } from '@swarm/vault';
import { turnstile } from './turnstile';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The vault's own code in process on this D1 (the site holds no FIELD_KEYS, goods or signup key),
// with the test field and link keys and a platform Stripe key; its provider calls go to the
// global fetch, which the tests answer.
useVaultForTests(
  'site',
  createFakeVault(
    'site',
    await testVaultEnv(env as never, { STRIPE_SECRET_KEY: `sk_test_${'s'.repeat(32)}` }),
  ),
);

const realFetch = globalThis.fetch;

// Turnstile siteverify is mocked; every other fetch goes through.
beforeEach(() => {
  turnstile.pass = true;
  turnstile.action = 'checkout';
  turnstile.calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) {
      turnstile.calls++;
      return Response.json({ success: turnstile.pass, action: turnstile.action, hostname: 'x' });
    }
    return realFetch(input, init);
  });
});
