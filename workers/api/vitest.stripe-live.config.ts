// The Stripe test-clock lifecycle suite (tests/stripe-lifecycle.live.test.ts) against a real
// Stripe account in test mode. `pnpm test` never runs it; `pnpm --filter @swarm/api
// test:stripe-live` does, and skips every test unless both variables are set:
//
//   STRIPE_TEST_SECRET_KEY   the platform's test-mode secret key (sk_test_…). A live key is refused.
//   STRIPE_TEST_ACCOUNT      a Standard account connected to that platform in test mode, with
//                            charges enabled (acct_…).
//
// The worker runs with PAYMENTS=stripe and that key, so the levels, coupons and webhook code under
// test make their real Stripe calls. See docs/deployment.md, "Stripe lifecycle suite".
import { readFile } from 'node:fs/promises';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { testLinkBindings } from '../../scripts/lib/test-link-keys.mjs';

const key = process.env.STRIPE_TEST_SECRET_KEY;
const account = process.env.STRIPE_TEST_ACCOUNT;
if (key && !key.startsWith('sk_test_')) {
  throw new Error(
    'STRIPE_TEST_SECRET_KEY is not a test-mode secret key (sk_test_…); refusing to run against live mode.',
  );
}
if (account && !/^acct_[A-Za-z0-9]+$/.test(account)) {
  throw new Error('STRIPE_TEST_ACCOUNT must be a connected account id (acct_…).');
}
const enabled = Boolean(key && account);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          AUTH_KEYS: `k1:${'t'.repeat(64)}`,
          UNSUBSCRIBE_KEYS: `u1:${'u'.repeat(64)}`,
          // The vault's test key (tests/vault-fetch.ts); the api itself holds no FIELD_KEYS.
          TEST_FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          ...testLinkBindings([
            'CONFIRM_KEYS',
            'CHECKOUT_VERIFY_KEYS',
            'SITE_LINK_SIGNING_KEYS',
            'SPONSOR_REPORT_SIGNING_KEYS',
          ]),
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          // The suite signs the events it fetches from Stripe with this secret.
          STRIPE_WEBHOOK_SECRETS: `whsec_${'l'.repeat(32)}`,
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
          LIVE_STRIPE_ENABLED: enabled ? '1' : '0',
          ...(enabled
            ? {
                PAYMENTS: 'stripe',
                STRIPE_SECRET_KEY: key as string,
                // Connect OAuth isn't exercised (the account is already connected); the env check
                // only needs a client id of the right shape.
                STRIPE_CONNECT_CLIENT_ID: 'ca_lifecycle_suite_unused',
                LIVE_STRIPE_ACCOUNT: account as string,
              }
            : {}),
        },
        workers: [
          {
            name: 'swarm-vault',
            modules: true,
            script: await readFile('./tests/fixtures/vault-stub.js', 'utf8'),
            compatibilityDate: '2026-10-01',
          },
          {
            name: 'swarm-realtime',
            modules: true,
            script: await readFile('./tests/fixtures/realtime-stub.js', 'utf8'),
            compatibilityDate: '2026-10-01',
            durableObjects: { SEND_MONITOR: 'SendMonitor', API_RATE_LIMITER: 'ApiRateLimiter' },
          },
        ],
      },
    })),
  ],
  test: {
    include: ['tests/**/*.live.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Advancing a test clock takes Stripe from seconds to a few minutes.
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
