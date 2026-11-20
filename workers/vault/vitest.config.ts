import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** A fresh Ed25519 key pair as keyrings: base64url PKCS#8 to sign, raw 32 bytes to verify. */
function ed25519(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signing = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  return { signing: `${kid}:${signing}`, verify: `${kid}:${x}` };
}

const member = ed25519('t1');
const goods = ed25519('t1');

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'test',
          // Before the cutover (still years away) unless a test switches to v2; wrangler.jsonc's
          // local block runs v2 from the start, as every other worker does in development.
          LINK_SIGNING_MODE: 'v1',
          LINK_LEGACY_CUTOFF: '9999999999999',
          FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          SIGNUP_KEYS: `s1:${'s'.repeat(64)}`,
          MEMBER_SIGNING_KEYS: member.signing,
          MEMBER_VERIFY_KEYS: member.verify,
          GOODS_SIGNING_KEYS: goods.signing,
          // The public half, for tests that check a goods link as site will.
          TEST_GOODS_VERIFY_KEYS: goods.verify,
          MEMBER_KEYS: `m1:${'m'.repeat(64)}`,
          STRIPE_SECRET_KEY: 'sk_test_platform_0123456789abcdefghijklmnop',
          DEBOUNCE_API_KEY: 'debounce-test-key',
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
        serviceBindings: {
          // A caller Worker with a binding pinned to CaptureVault, as capture's will be.
          CAPTURE_CALLER: 'capture-caller',
        },
        workers: [
          {
            name: 'capture-caller',
            modules: true,
            scriptPath: './tests/fixtures/capture-caller.js',
            compatibilityDate: '2026-10-01',
            serviceBindings: {
              // The plugin names the worker under test vitest-plugin-runner-<test.name>.
              VAULT: { name: 'vitest-plugin-runner-vault', entrypoint: 'CaptureVault' },
            },
          },
        ],
      },
    })),
  ],
  test: { name: 'vault', setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
