// The WordPress plugin story (docs/wordpress.md), on real WordPress in WebAssembly against the local
// stack. Separate from the main suite because it downloads WordPress. WP_VERSION and PHP_VERSION
// choose what it runs on: `WP_VERSION=6.5 PHP_VERSION=7.4 pnpm test:wordpress` is the oldest we support.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const WP_PORT = 9411;

const { WP_VERSION, PHP_VERSION } = process.env;
const plugin = resolve(import.meta.dirname, '../../integrations/wordpress/swarm-newsletter');
const helpers = resolve(import.meta.dirname, 'wordpress/helpers-mu-plugin.php');
const blueprint = join(tmpdir(), 'swarm-wordpress-blueprint.json');
writeFileSync(
  blueprint,
  JSON.stringify({
    // Here and not as command-line flags: with a blueprint, Playground ignores those.
    preferredVersions: {
      wp: WP_VERSION ? WP_VERSION : 'latest',
      php: PHP_VERSION ? PHP_VERSION : 'latest',
    },
    steps: [
      { step: 'activatePlugin', pluginPath: 'swarm-newsletter/swarm-newsletter.php' },
      { step: 'setSiteOptions', options: { permalink_structure: '/%postname%/' } },
    ],
  }),
);

const playground = [
  'npx -y @wp-playground/cli@3.1.62 server',
  `--port=${WP_PORT}`,
  `--mount="${plugin}:/wordpress/wp-content/plugins/swarm-newsletter"`,
  `--mount="${helpers}:/wordpress/wp-content/mu-plugins/swarm-test-helpers.php"`,
  `--blueprint="${blueprint}"`,
].join(' ');

export default defineConfig({
  ...base,
  testDir: './wordpress',
  fullyParallel: false,
  workers: 1,
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer : []),
    {
      command: playground,
      url: `http://127.0.0.1:${WP_PORT}/`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
