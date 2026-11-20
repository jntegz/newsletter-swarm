import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, vi } from 'vitest';
import { stripe } from './stripe';
import { turnstile } from './turnstile';
import { installFakeVault } from './vault-fetch';

// The same migrations that ship to D1, applied the same way wrangler applies them.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The vault's own code in process on this D1 (tests/vault-fetch.ts).
await installFakeVault();

const realFetch = globalThis.fetch;

// Turnstile and Stripe are the only outbound calls; everything else is the real binding.
beforeEach(() => {
  turnstile.pass = true;
  turnstile.hostname = 'forms.swarm.test';
  turnstile.cdata = undefined;
  turnstile.calls = 0;
  stripe.calls = [];
  stripe.answer = () => Response.json({});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.stripe.com/')) {
      const parsed = new URL(url);
      const call = {
        method: init?.method ?? 'GET',
        path: parsed.pathname,
        params: new URLSearchParams(
          typeof init?.body === 'string' ? init.body : parsed.search.slice(1),
        ),
        account: new Headers(init?.headers).get('stripe-account'),
      };
      stripe.calls.push(call);
      return stripe.answer(call);
    }
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) {
      turnstile.calls++;
      return Response.json({
        success: turnstile.pass,
        action: 'subscribe',
        hostname: turnstile.hostname,
        ...(turnstile.cdata === undefined ? {} : { cdata: turnstile.cdata }),
      });
    }
    return realFetch(input, init);
  });
});
