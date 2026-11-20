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
          // Not FIELD_KEYS (the env refuses it): the vault's test key, for seeding stored values.
          TEST_FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          ...testLinkBindings([
            'MEMBER_SIGNING_KEYS',
            'DSR_EXPORT_SIGNING_KEYS',
            'SPONSOR_REPORT_SIGNING_KEYS',
          ]),
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
          // tests/flows-fuzz.test.ts: how long to run and which seed to start from.
          ...(process.env.FLOW_FUZZ_ITERATIONS
            ? { FLOW_FUZZ_ITERATIONS: process.env.FLOW_FUZZ_ITERATIONS }
            : {}),
          ...(process.env.FLOW_FUZZ_SEED ? { FLOW_FUZZ_SEED: process.env.FLOW_FUZZ_SEED } : {}),
          ...(process.env.FLOW_REHEARSE_ITERATIONS
            ? { FLOW_REHEARSE_ITERATIONS: process.env.FLOW_REHEARSE_ITERATIONS }
            : {}),
          ...(process.env.FLOW_REHEARSE_SEED
            ? { FLOW_REHEARSE_SEED: process.env.FLOW_REHEARSE_SEED }
            : {}),
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
