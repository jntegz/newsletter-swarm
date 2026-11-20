import { readFile } from 'node:fs/promises';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';
import { testLinkBindings } from '../../scripts/lib/test-link-keys.mjs';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          AUTH_KEYS: `k1:${'t'.repeat(64)}`,
          UNSUBSCRIBE_KEYS: `u1:${'u'.repeat(64)}`,
          // Not FIELD_KEYS (the vault holds it): the vault's test key, for seeding stored values.
          TEST_FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          ...testLinkBindings([
            'CONFIRM_KEYS',
            'CHECKOUT_VERIFY_KEYS',
            'SITE_LINK_SIGNING_KEYS',
            'SPONSOR_REPORT_SIGNING_KEYS',
          ]),
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          // Two secrets, as during a rotation; the payments tests sign with either.
          STRIPE_WEBHOOK_SECRETS: `whsec_${'a'.repeat(32)},whsec_${'b'.repeat(32)}`,
          // Email checks: the fake DeBounce (packages/engine/src/debounce.ts), never the network.
          DEBOUNCE_API_KEY: 'dev',
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
        workers: [
          {
            name: 'swarm-vault-local',
            modules: true,
            script: await readFile('./tests/fixtures/vault-stub.js', 'utf8'),
            compatibilityDate: '2026-10-01',
          },
          {
            name: 'swarm-realtime-local',
            modules: true,
            // Inlined because a module path may not leave this worker.
            script: await readFile('./tests/fixtures/realtime-stub.js', 'utf8'),
            compatibilityDate: '2026-10-01',
            durableObjects: {
              SEND_MONITOR: 'SendMonitor',
              API_RATE_LIMITER: 'ApiRateLimiter',
              SEND_PACER: 'SendPacer',
            },
          },
        ],
      },
    })),
  ],
  test: {
    setupFiles: ['./tests/setup.ts'],
    // The Stripe test-clock suite talks to Stripe; it runs only through vitest.stripe-live.config.ts.
    exclude: [...configDefaults.exclude, '**/*.live.test.ts'],
  },
});
