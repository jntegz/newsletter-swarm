import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      DB: D1Database;
      TRACK_KEYS: string;
      UNSUBSCRIBE_KEYS: string;
      BOUNCE_KEYS: string;
      LINK_LEGACY_CUTOFF: string;
      DMARC_MAIL_DOMAIN: string;
      RESEND_WEBHOOK_SECRET: string;
      MAILGUN_WEBHOOK_SIGNING_KEY: string;
      POSTMARK_WEBHOOK_SECRET: string;
      SMTP_FEEDBACK_SECRET: string;
      REPORTS: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
