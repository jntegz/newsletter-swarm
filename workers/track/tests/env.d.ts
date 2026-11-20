import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      DB: D1Database;
      TRACK_KEYS: string;
      UNSUBSCRIBE_KEYS: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
