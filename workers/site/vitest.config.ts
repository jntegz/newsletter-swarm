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
          PLATFORM_SITE_DOMAIN: 'swarm.test',
          SITE_SCHEME: 'http',
          READER_KEYS: `r1:${'r'.repeat(64)}`,
          ...testLinkBindings([
            'CONFIRM_KEYS',
            'FORM_STAMP_KEYS',
            'ASK_PAGE_VERIFY_KEYS',
            'GOODS_VERIFY_KEYS',
            'CHECKOUT_SIGNING_KEYS',
            'SITE_LINK_VERIFY_KEYS',
            'SPONSOR_REPORT_VERIFY_KEYS',
          ]),
          // Not FIELD_KEYS (the vault holds it): the vault's test key, for seeding stored values.
          TEST_FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
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
            durableObjects: { SEND_PACER: 'SendPacer' },
          },
        ],
      },
    })),
  ],
  test: { setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
