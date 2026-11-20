import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A fresh signing key per run, so the tests sign a release the way a real one is signed.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SETUP_PASSWORD: 'test-only-setup-password',
          RELEASE_URL: 'https://release.test',
          RELEASE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) as string,
          // Required: without it the page opens no release (see wrangler.jsonc).
          RELEASE_MIN_VERSION: '0.1.0',
          TEST_RELEASE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        },
      },
    })),
  ],
  test: { testTimeout: 60_000 },
});
