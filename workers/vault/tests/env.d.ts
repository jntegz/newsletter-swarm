import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      DB: D1Database;
      FIELD_KEYS: string;
      SIGNUP_KEYS: string;
      MEMBER_SIGNING_KEYS: string;
      MEMBER_VERIFY_KEYS: string;
      GOODS_SIGNING_KEYS: string;
      TEST_GOODS_VERIFY_KEYS: string;
      MEMBER_KEYS: string;
      STRIPE_SECRET_KEY: string;
      DEBOUNCE_API_KEY: string;
      CAPTURE_CALLER: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
