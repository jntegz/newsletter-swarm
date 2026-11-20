import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          TRACK_KEYS: `t1:${'t'.repeat(64)}`,
          UNSUBSCRIBE_KEYS: `u1:${'u'.repeat(64)}`,
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
      },
    })),
  ],
  test: { setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
