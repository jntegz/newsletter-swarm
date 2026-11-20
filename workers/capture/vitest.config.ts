import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { testLinkBindings } from '../../scripts/lib/test-link-keys.mjs';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          CAPTURE_ORIGIN: 'https://forms.swarm.test',
          PLATFORM_SITE_DOMAIN: 'swarm.test',
          SITE_SCHEME: 'http',
          // Not FIELD_KEYS (the vault holds it): the vault's test key, for seeding stored values.
          TEST_FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          ...testLinkBindings([
            'CONFIRM_KEYS',
            'CAPTURE_KEYS',
            'FORM_STAMP_KEYS',
            'MEMBER_VERIFY_KEYS',
            'ASK_VERIFY_KEYS',
            'ASK_PAGE_SIGNING_KEYS',
            'DSR_EXPORT_VERIFY_KEYS',
          ]),
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          // The real Stripe client, through the vault, against a fetch mock (tests/setup.ts).
          PAYMENTS: 'stripe',
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
        workers: [
          {
            name: 'swarm-vault-local',
            modules: true,
            scriptPath: './tests/fixtures/vault-stub.js',
            compatibilityDate: '2026-10-01',
          },
          {
            name: 'swarm-realtime-local',
            modules: true,
            scriptPath: './tests/fixtures/realtime-stub.js',
            compatibilityDate: '2026-10-01',
            durableObjects: { RATE_LIMITER: 'RateLimiter', SEND_PACER: 'SendPacer' },
          },
        ],
      },
    })),
  ],
  test: { setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
