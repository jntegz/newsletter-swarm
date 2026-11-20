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
          UNSUBSCRIBE_KEYS: `u1:${'u'.repeat(64)}`,
          BOUNCE_KEYS: `b1:${'b'.repeat(64)}`,
          ...testLinkBindings([], { memberKeys: false }),
          SNS_TOPIC_ARNS: 'arn:aws:sns:eu-west-1:123456789012:swarm-ses-events',
          // base64 of "test-only resend webhook secret!"
          RESEND_WEBHOOK_SECRET: 'whsec_dGVzdC1vbmx5IHJlc2VuZCB3ZWJob29rIHNlY3JldCE=',
          MAILGUN_WEBHOOK_SIGNING_KEY: 'test-only-mailgun-signing-key',
          POSTMARK_WEBHOOK_SECRET: 'test-only-postmark-webhook-secret',
          // base64 of "test-only smtp feedback secret!!"
          SMTP_FEEDBACK_SECRET: 'whsec_dGVzdC1vbmx5IHNtdHAgZmVlZGJhY2sgc2VjcmV0ISE=',
          TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
        },
      },
    })),
  ],
  test: { setupFiles: ['./tests/setup.ts'], testTimeout: 60_000 },
});
