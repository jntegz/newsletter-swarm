import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      APP_ORIGIN: string;
      MEDIA_ORIGIN: string;
      DB: D1Database;
      CACHE: KVNamespace;
      MEDIA: R2Bucket;
      SEND_QUEUE: Queue;
      /** The scriptable stub in tests/fixtures/realtime-stub.js. */
      SEND_PACER: DurableObjectNamespace;
      TEST_SEND_LIMITER: RateLimit;
      DEV_MAILBOX: R2Bucket;
      QUICKPASS_LIMITER: RateLimit;
      AUTH_KEYS: string;
      TURNSTILE_SECRET_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
