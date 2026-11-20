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
          TRACK_KEYS: `t1:${'t'.repeat(64)}`,
          UNSUBSCRIBE_KEYS: `u1:${'u'.repeat(64)}`,
          BOUNCE_KEYS: `b1:${'b'.repeat(64)}`,
          ...testLinkBindings(['MEMBER_SIGNING_KEYS', 'ASK_SIGNING_KEYS']),
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
        workers: [
          {
            name: 'swarm-realtime-local',
            modules: true,
            scriptPath: './tests/fixtures/realtime-stub.js',
            compatibilityDate: '2026-10-01',
            durableObjects: { SEND_MONITOR: 'SendMonitor', SEND_PACER: 'SendPacer' },
          },
        ],
      },
    })),
  ],
  test: { setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
