// Creates (or finds) every Cloudflare resource an environment's workers declare, and writes the
// ids into each worker's wrangler.jsonc. The list comes from the configs themselves: D1 databases,
// KV namespaces, R2 buckets and queues (with their dead-letter queues), across all workers.
//
// Usage: node scripts/provision.mjs staging|production [--dry-run] [--location <hint>]
//          [--turnstile-site-key <key>]
// Requires `pnpm --filter @swarm/api exec wrangler login` first (and CLOUDFLARE_ACCOUNT_ID when
// the login can see several accounts). Safe to re-run: a resource that exists is looked up, never
// created twice, and a config that already holds the right id is left alone. --dry-run prints the
// plan (what exists, what would be created, which values would change) and changes nothing.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ENVIRONMENTS,
  collectResources,
  parseJsonc,
  ratelimitClashes,
  rewriteConfig,
  unprovisionedPaths,
} from './lib/wrangler-config.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    location: { type: 'string' },
    'turnstile-site-key': { type: 'string' },
  },
});
const environment = positionals[0];
const dryRun = flags['dry-run'];
if (!ENVIRONMENTS.includes(environment)) {
  console.error(
    'Usage: node scripts/provision.mjs staging|production [--dry-run] [--location <hint>] [--turnstile-site-key <key>]',
  );
  process.exit(1);
}

// The workspace's wrangler, run from the repository root (no config there) with no terminal, so
// it never offers to edit a config itself.
const WRANGLER = join(ROOT, 'workers/api/node_modules/.bin/wrangler');

function wrangler(...args) {
  try {
    return execFileSync(WRANGLER, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    throw Object.assign(new Error(`wrangler ${args.join(' ')} failed:\n${output}`), { output });
  }
}

// One list call per kind and run, dropped after a create.
const lists = new Map();
function listed(kind, args) {
  if (!lists.has(kind)) lists.set(kind, JSON.parse(wrangler(...args)));
  return lists.get(kind);
}

const missing = (error) => /does not exist|code: 10006/i.test(error.output ?? '');
const locationArgs = flags.location ? ['--location', flags.location] : [];

// Each kind: how to find an existing resource (its id, or true when it has no id we need; null
// when it does not exist) and how to create it.
const KINDS = {
  d1: {
    label: 'D1 database',
    find: (name) =>
      listed('d1', ['d1', 'list', '--json']).find((db) => db.name === name)?.uuid ?? null,
    create: (name) => {
      wrangler('d1', 'create', name, ...locationArgs);
      lists.delete('d1');
    },
  },
  kv: {
    label: 'KV namespace',
    find: (title) =>
      listed('kv', ['kv', 'namespace', 'list']).find((ns) => ns.title === title)?.id ?? null,
    create: (title) => {
      wrangler('kv', 'namespace', 'create', title);
      lists.delete('kv');
    },
  },
  r2: {
    label: 'R2 bucket',
    find: (name) => {
      try {
        wrangler('r2', 'bucket', 'info', name, '--json');
        return true;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    create: (name) => wrangler('r2', 'bucket', 'create', name, ...locationArgs),
  },
  queues: {
    label: 'Queue',
    find: (name) => {
      try {
        wrangler('queues', 'info', name);
        return true;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    create: (name) => wrangler('queues', 'create', name),
  },
};

const workers = readdirSync(join(ROOT, 'workers'))
  .map((name) => `workers/${name}/wrangler.jsonc`)
  .filter((file) => existsSync(join(ROOT, file)));
const configs = workers.map((file) => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return { file, text, value: parseJsonc(text).value };
});

const clashes = ratelimitClashes(configs);
if (clashes.length > 0) {
  console.error(`Rate-limit namespace ids shared between environments:\n${clashes.join('\n')}`);
  process.exit(1);
}

const plan = collectResources(configs, environment);
const ids = { d1: {}, kv: {}, vars: {} };
console.log(`${dryRun ? 'Plan for' : 'Provisioning'} ${environment}:`);
for (const [kind, { label, find, create }] of Object.entries(KINDS)) {
  for (const name of plan[kind]) {
    let found;
    try {
      found = find(name);
    } catch (error) {
      // A dry run still prints the plan when wrangler is not signed in.
      if (!dryRun) throw error;
      console.log(`  unknown  ${label} ${name} (lookup failed: ${error.message.split('\n')[0]})`);
      continue;
    }
    if (found) {
      console.log(`  exists   ${label} ${name}`);
    } else if (dryRun) {
      console.log(`  create   ${label} ${name}`);
      continue;
    } else {
      create(name);
      found = find(name);
      if (!found) throw new Error(`${label} ${name} was created but cannot be found`);
      console.log(`  created  ${label} ${name}`);
    }
    if (typeof found === 'string') ids[kind][name] = found;
  }
}

// Turnstile widgets are not managed by wrangler: create one for the environment's hosts in the
// dashboard (its secret goes in with `wrangler secret put TURNSTILE_SECRET_KEY`) and pass the
// public site key here.
const siteKey = flags['turnstile-site-key'];
if (siteKey) ids.vars.TURNSTILE_SITE_KEY = siteKey;
else if (plan.turnstile) console.log('  skipped  TURNSTILE_SITE_KEY (pass --turnstile-site-key)');

let pending = 0;
for (const config of configs) {
  const { text, changes } = rewriteConfig(config.text, environment, ids);
  for (const change of changes) {
    console.log(`  ${dryRun ? 'set' : 'wrote'}    ${config.file} ${change.path} = ${change.to}`);
  }
  if (!dryRun && changes.length > 0) writeFileSync(join(ROOT, config.file), text);
  pending += unprovisionedPaths(text, environment).length;
}

if (dryRun) {
  console.log('Dry run: nothing was created or written.');
} else if (pending > 0) {
  console.log(
    `${pending} value(s) still say "unprovisioned"; see pnpm check:provisioned ${environment}.`,
  );
} else {
  console.log(`Next: pnpm check:provisioned ${environment} && pnpm db:migrate:${environment}`);
}
