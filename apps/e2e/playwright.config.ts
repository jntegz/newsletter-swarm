import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { DASHBOARD_PORT, TURNSTILE_PORT, VAULT, WORKERS } from './workers';

const reuse = !process.env.CI;

// A dev registry of this run's own. Playwright kills the workers, so they stay listed in the
// registry with addresses nothing listens on. The next stack doesn't replace those entries: its
// queue messages go to the dead address and wrangler drops them, while send() reports success. A
// Circle then never gets ready and a send never finishes. Test processes inherit the variable, so
// only the first one makes the folder. To reuse workers you started yourself, set it to theirs.
if (!process.env.WRANGLER_REGISTRY_PATH) {
  const registry = mkdtempSync(join(tmpdir(), 'swarm-e2e-registry-'));
  process.env.WRANGLER_REGISTRY_PATH = registry;
  process.once('exit', () => rmSync(registry, { recursive: true, force: true }));
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: 'retain-on-failure',
    // The stand-in Turnstile (local/turnstile.mjs) answers for challenges.cloudflare.com with a
    // throwaway self-signed certificate.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Host pages are fulfilled by page.route on made-up localhost ports; Chromium's Local
        // Network Access checks treat them as public and block their requests to the local
        // workers (the embed script, the form frame). Every origin here is local, so turn it off.
        // The run stays on this machine: challenges.cloudflare.com goes to the stand-in Turnstile
        // and every other host that is not local fails to resolve.
        launchOptions: {
          args: [
            '--disable-features=LocalNetworkAccessChecks',
            `--host-resolver-rules=MAP challenges.cloudflare.com 127.0.0.1:${TURNSTILE_PORT}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: `node local/turnstile.mjs ${TURNSTILE_PORT}`,
      port: TURNSTILE_PORT,
      reuseExistingServer: reuse,
      timeout: 30_000,
    },
    // Each worker as its dev script runs it, but with outbound requests kept local
    // (local/worker.mjs): Turnstile's siteverify answered here, any other outside host refused.
    {
      command: `node local/worker.mjs ${VAULT.name} ${VAULT.port} ${VAULT.inspectorPort}`,
      // Every path answers 404, which Playwright's url check does not take as ready: wait for the port.
      port: VAULT.port,
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
    ...WORKERS.map((worker) => ({
      command: `node local/worker.mjs ${worker.name} ${worker.port} ${worker.inspectorPort}${'testScheduled' in worker ? ' --test-scheduled' : ''}`,
      url: `http://localhost:${worker.port}/healthz`,
      reuseExistingServer: reuse,
      timeout: 120_000,
    })),
    {
      command: 'pnpm --filter @swarm/dashboard dev',
      url: `http://localhost:${DASHBOARD_PORT}`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      cwd: '../..',
    },
  ],
});
