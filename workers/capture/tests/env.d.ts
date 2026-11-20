import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  /** Vite's import.meta.glob (tests/vault.test.ts reads the sources with it). */
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, unknown>;
  }
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      DB: D1Database;
      DEV_MAILBOX: R2Bucket;
      EXPORTS: R2Bucket;
      RATE_LIMITER: DurableObjectNamespace;
      MEMBER_KEYS: string;
      LINK_LEGACY_CUTOFF: string;
      TEST_LINK_KEYS: string;
      TEST_FIELD_KEYS: string;
      CAPTURE_ORIGIN: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
