// Fails when any worker's wrangler.jsonc still holds a template value for an environment
// ("unprovisioned", a swarm.example or swarm.page hostname, the account id 000000000000), or when
// staging and production share a rate-limit namespace id. Run before deploying. The template list
// is the installer's own, so a manual deploy is refused what `pnpm swarm` would refuse.
// Usage: node scripts/check-provisioned.mjs staging|production
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENVIRONMENTS, deployProblems, parseJsonc } from './lib/wrangler-config.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const environment = process.argv[2];
if (!ENVIRONMENTS.includes(environment)) {
  console.error('Usage: node scripts/check-provisioned.mjs staging|production');
  process.exit(1);
}

const configs = readdirSync(join(ROOT, 'workers'))
  .map((name) => `workers/${name}/wrangler.jsonc`)
  .filter((file) => existsSync(join(ROOT, file)))
  .map((file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    return { file, text, value: parseJsonc(text).value };
  });

const problems = deployProblems(configs, environment);
if (problems.length > 0) {
  console.error(
    `${environment} is not ready to deploy (${problems.length}):\n${problems.join('\n')}\n` +
      `Run node scripts/provision.mjs ${environment} for the resource ids, and replace every ` +
      'template hostname, site domain and account id with your own (see docs/deployment.md).',
  );
  process.exit(1);
}
console.log(`${environment}: every worker config is provisioned.`);
