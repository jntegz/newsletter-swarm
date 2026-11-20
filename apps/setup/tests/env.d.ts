import type { SetupRun } from '../src/run';

declare global {
  namespace Cloudflare {
    interface Env {
      SETUP: DurableObjectNamespace<SetupRun>;
      TEST_RELEASE_KEY: string;
      RELEASE_URL: string;
      RELEASE_PUBLIC_KEY: string;
      RELEASE_MIN_VERSION: string;
      SETUP_PASSWORD: string;
    }
  }
}
