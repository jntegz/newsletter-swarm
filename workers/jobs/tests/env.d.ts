import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { JobMessage } from '@swarm/engine';

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
      CACHE: KVNamespace;
      JOBS_QUEUE: Queue<JobMessage>;
      MEDIA: R2Bucket;
      IMPORTS: R2Bucket;
      EXPORTS: R2Bucket;
      DEV_MAILBOX: R2Bucket;
      TEST_FIELD_KEYS: string;
      MEMBER_KEYS: string;
      LINK_LEGACY_CUTOFF: string;
      TEST_LINK_KEYS: string;
      TEST_MIGRATIONS: D1Migration[];
      FLOW_FUZZ_ITERATIONS?: string;
      FLOW_FUZZ_SEED?: string;
      FLOW_REHEARSE_ITERATIONS?: string;
      FLOW_REHEARSE_SEED?: string;
    }
  }
}
