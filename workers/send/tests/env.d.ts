import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { SendMessage } from '@swarm/engine';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      DB: D1Database;
      CACHE: KVNamespace;
      DEV_MAILBOX: R2Bucket;
      SEND_QUEUE: Queue<SendMessage>;
      SEND_MONITOR: DurableObjectNamespace;
      SEND_PACER: DurableObjectNamespace;
      TRACK_KEYS: string;
      UNSUBSCRIBE_KEYS: string;
      MEMBER_KEYS: string;
      BOUNCE_KEYS: string;
      MEMBER_SIGNING_KEYS: string;
      ASK_SIGNING_KEYS: string;
      LINK_LEGACY_CUTOFF: string;
      TEST_LINK_KEYS: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
