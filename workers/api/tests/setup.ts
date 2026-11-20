import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, vi } from 'vitest';
import { turnstile } from './turnstile';
import { installFakeVault } from './vault-fetch';

// The same migrations that ship to D1, applied the same way wrangler applies them.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The vault's own code in process on this D1 (tests/vault-fetch.ts).
await installFakeVault();

const realFetch = globalThis.fetch;

/** Answers Turnstile's siteverify with the current test verdict; everything else goes out as is. */
const fetchWithTurnstile: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) {
    return Response.json({
      success: turnstile.pass,
      action: turnstile.action,
      hostname: 'example.com',
    });
  }
  return realFetch(input, init);
};

// Turnstile is the only outbound call in these tests; everything else is the real binding. The
// answer is in place from the start, because most suites sign in from beforeAll, which runs
// before any beforeEach and would otherwise ask the real Turnstile (and fail without a network).
vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWithTurnstile);

// Each test starts from a passing verdict and the plain handler, whatever the last one changed.
beforeEach(() => {
  turnstile.pass = true;
  turnstile.action = 'quickpass';
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWithTurnstile);
});
