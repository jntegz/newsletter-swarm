import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TEMPLATE_PATTERNS,
  collectResources,
  deployProblems,
  kvTitle,
  parseJsonc,
  ratelimitClashes,
  rewriteConfig,
  templatePaths,
  unprovisionedPaths,
} from '../lib/wrangler-config.mjs';

const CONFIG = `{
  // Local development.
  "name": "swarm-x",
  "vars": { "ENVIRONMENT": "development", "URL": "https://example.com/a//b" },
  "d1_databases": [{ "binding": "DB", "database_name": "swarm", "database_id": "local" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "local" }],
  "env": {
    "staging": {
      /* block comment */
      "vars": { "ENVIRONMENT": "staging", "TURNSTILE_SITE_KEY": "unprovisioned" },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "swarm-staging",
          "database_id": "unprovisioned", // written by provision.mjs
        },
      ],
      "kv_namespaces": [{ "binding": "CACHE", "id": "unprovisioned" }],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "swarm-staging-media" }],
      "queues": {
        "producers": [{ "binding": "SEND_QUEUE", "queue": "swarm-staging-send" }],
        "consumers": [{ "queue": "swarm-staging-send", "dead_letter_queue": "swarm-staging-send-dlq" }],
      },
      "ratelimits": [{ "name": "L", "namespace_id": "1011", "simple": { "limit": 10, "period": 60 } }],
    },
    "production": {
      "d1_databases": [
        { "binding": "DB", "database_name": "swarm-production", "database_id": "unprovisioned" },
      ],
      "kv_namespaces": [{ "binding": "CACHE", "id": "unprovisioned" }],
      "ratelimits": [{ "name": "L", "namespace_id": "1021", "simple": { "limit": 10, "period": 60 } }],
    },
  },
}
`;

const IDS = {
  d1: { 'swarm-staging': 'd1-uuid' },
  kv: { 'swarm-staging-cache': 'kv-id' },
  vars: { TURNSTILE_SITE_KEY: '0x4AAA' },
};

describe('parseJsonc', () => {
  it('reads comments, trailing commas and slashes inside strings', () => {
    const { value } = parseJsonc(CONFIG);
    assert.equal(value.vars.URL, 'https://example.com/a//b');
    assert.equal(value.env.staging.d1_databases[0].database_id, 'unprovisioned');
    assert.equal(value.env.staging.ratelimits[0].simple.limit, 10);
  });

  it('parses every worker config in the repository', () => {
    const workers = new URL('../../workers/', import.meta.url);
    for (const name of readdirSync(workers)) {
      const text = readFileSync(new URL(`${name}/wrangler.jsonc`, workers), 'utf8');
      assert.equal(typeof parseJsonc(text).value.name, 'string', name);
    }
  });

  it('rejects broken input', () => {
    assert.throws(() => parseJsonc('{ "a": }'), SyntaxError);
    assert.throws(() => parseJsonc('{ "a": "b" } x'), SyntaxError);
  });
});

describe('link signing modes', () => {
  it('are the same in every worker that sets them, in each environment', () => {
    // The vault signs Member Center and goods links that capture and site check: a worker in
    // another mode refuses every link it is handed.
    const workers = new URL('../../workers/', import.meta.url);
    const configs = readdirSync(workers).map((name) => ({
      name,
      value: parseJsonc(readFileSync(new URL(`${name}/wrangler.jsonc`, workers), 'utf8')).value,
    }));
    for (const environment of ['local', 'staging', 'production']) {
      const modes = new Map();
      for (const { name, value } of configs) {
        const vars = environment === 'local' ? value.vars : value.env?.[environment]?.vars;
        if (!vars?.LINK_SIGNING_MODE) continue;
        modes.set(name, `${vars.LINK_SIGNING_MODE} ${vars.LINK_LEGACY_CUTOFF ?? '-'}`);
      }
      assert.ok(modes.has('vault'), environment);
      assert.equal(
        new Set(modes.values()).size,
        1,
        `${environment}: ${JSON.stringify([...modes])}`,
      );
    }
  });
});

describe('collectResources', () => {
  it('lists each resource of an environment once, dead-letter queues included', () => {
    const value = parseJsonc(CONFIG).value;
    const resources = collectResources([{ value }, { value }], 'staging');
    assert.deepEqual(resources, {
      d1: ['swarm-staging'],
      kv: ['swarm-staging-cache'],
      r2: ['swarm-staging-media'],
      queues: ['swarm-staging-send', 'swarm-staging-send-dlq'],
      turnstile: true,
    });
    assert.deepEqual(collectResources([{ value }], 'production').r2, []);
  });

  it('names KV namespaces after the binding', () => {
    assert.equal(kvTitle('production', 'RATE_CACHE'), 'swarm-production-rate-cache');
  });
});

describe('rewriteConfig', () => {
  it('writes ids into the one environment and keeps everything else byte for byte', () => {
    const { text, changes } = rewriteConfig(CONFIG, 'staging', IDS);
    assert.deepEqual(
      changes.map((c) => c.path),
      [
        'env.staging.vars.TURNSTILE_SITE_KEY',
        'env.staging.d1_databases.0.database_id',
        'env.staging.kv_namespaces.0.id',
      ],
    );
    const expected = CONFIG.replace(
      '"TURNSTILE_SITE_KEY": "unprovisioned"',
      '"TURNSTILE_SITE_KEY": "0x4AAA"',
    )
      .replace('"database_id": "unprovisioned", // written', '"database_id": "d1-uuid", // written')
      .replace(
        '"id": "unprovisioned" }],\n      "r2_buckets"',
        '"id": "kv-id" }],\n      "r2_buckets"',
      );
    assert.equal(text, expected);
    // Production and the local block are untouched.
    assert.deepEqual(unprovisionedPaths(text, 'production'), [
      'env.production.d1_databases.0.database_id',
      'env.production.kv_namespaces.0.id',
    ]);
    assert.equal(parseJsonc(text).value.d1_databases[0].database_id, 'local');
  });

  it('is idempotent: a second run changes nothing', () => {
    const once = rewriteConfig(CONFIG, 'staging', IDS).text;
    const twice = rewriteConfig(once, 'staging', IDS);
    assert.equal(twice.text, once);
    assert.deepEqual(twice.changes, []);
  });

  it('replaces a stale id with the one Cloudflare reports', () => {
    const once = rewriteConfig(CONFIG, 'staging', IDS).text;
    const { changes } = rewriteConfig(once, 'staging', { d1: { 'swarm-staging': 'new-uuid' } });
    assert.deepEqual(changes, [
      { path: 'env.staging.d1_databases.0.database_id', from: 'd1-uuid', to: 'new-uuid' },
    ]);
  });

  it('leaves values it has no id for, so the check still reports them', () => {
    const { text } = rewriteConfig(CONFIG, 'staging', { d1: IDS.d1 });
    assert.deepEqual(unprovisionedPaths(text, 'staging'), [
      'env.staging.vars.TURNSTILE_SITE_KEY',
      'env.staging.kv_namespaces.0.id',
    ]);
  });

  it('does nothing for an environment the config does not have', () => {
    assert.deepEqual(rewriteConfig(CONFIG, 'preview', IDS), { text: CONFIG, changes: [] });
  });
});

describe('ratelimitClashes', () => {
  it('reports an id used by two environments, not one shared within an environment', () => {
    const value = parseJsonc(CONFIG).value;
    assert.deepEqual(
      ratelimitClashes([
        { file: 'a', value },
        { file: 'b', value },
      ]),
      [],
    );
    const shared = parseJsonc(CONFIG.replace('"1021"', '"1011"')).value;
    assert.deepEqual(ratelimitClashes([{ file: 'a', value: shared }]), [
      'namespace_id 1011: a (staging) and a (production)',
    ]);
  });

  it('finds no clash in the repository', () => {
    const workers = new URL('../../workers/', import.meta.url);
    const configs = readdirSync(workers).map((name) => ({
      file: name,
      value: parseJsonc(readFileSync(new URL(`${name}/wrangler.jsonc`, workers), 'utf8')).value,
    }));
    assert.deepEqual(ratelimitClashes(configs), []);
  });
});

describe('the manual pre-deploy check', () => {
  const workers = new URL('../../workers/', import.meta.url);
  const committed = () =>
    readdirSync(workers).map((name) => {
      const text = readFileSync(new URL(`${name}/wrangler.jsonc`, workers), 'utf8');
      return { file: `workers/${name}/wrangler.jsonc`, text, value: parseJsonc(text).value };
    });
  /** What provisioning writes: every id and the Turnstile key, and nothing else. */
  const provisioned = (text) => text.replaceAll('"unprovisioned"', '"0123456789abcdef"');

  it('refuses a provisioned production that still has template hostnames and the zero account', () => {
    const configs = committed().map((c) => ({ ...c, text: provisioned(c.text) }));
    const problems = deployProblems(configs, 'production');
    const text = problems.join('\n');
    assert.match(
      text,
      /workers\/api\/wrangler\.jsonc: env\.production\.vars\.APP_ORIGIN \(swarm\.example\)/,
    );
    assert.match(text, /PLATFORM_SITE_DOMAIN \(swarm\.example\)/);
    assert.match(text, /SITE_FALLBACK_ORIGIN \(swarm\.example\)/);
    assert.match(text, /\(000000000000\)/);
    assert.doesNotMatch(text, /unprovisioned/);
  });

  it('passes once every template value is replaced', () => {
    const configs = committed().map((c) => {
      const text = provisioned(c.text)
        .replaceAll('swarm.example', 'newsletter.example.org')
        .replaceAll('000000000000', '123456789012');
      return { ...c, text, value: parseJsonc(text).value };
    });
    assert.deepEqual(deployProblems(configs, 'production'), []);
    assert.deepEqual(deployProblems(configs, 'staging'), []);
  });

  it('still reports what provisioning has not written', () => {
    assert.deepEqual(
      templatePaths(CONFIG, 'staging').map((p) => p.path),
      unprovisionedPaths(CONFIG, 'staging'),
    );
  });

  it('ignores the local block, which never deploys to a real host', () => {
    assert.deepEqual(templatePaths('{ "vars": { "A": "https://swarm.page" } }', 'production'), []);
  });

  it('uses the same list as the installer, and the old swarm.page domain stays refused', () => {
    const installer = JSON.parse(
      readFileSync(
        new URL('../../packages/installer/src/config/placeholders.json', import.meta.url),
        'utf8',
      ),
    ).patterns;
    assert.deepEqual(
      TEMPLATE_PATTERNS.map((p) => p.source),
      installer.map((source) => new RegExp(source).source),
    );
    const old = '{ "env": { "production": { "vars": { "D": "sites.swarm.page" } } } }';
    assert.deepEqual(templatePaths(old, 'production'), [
      { path: 'env.production.vars.D', found: 'swarm.page' },
    ]);
  });

  it('keeps committed templates on reserved names that cannot send anyone to a real site', () => {
    for (const { file, value } of committed()) {
      for (const environment of ['staging', 'production']) {
        const text = JSON.stringify(value.env?.[environment] ?? {});
        assert.doesNotMatch(text, /swarm\.page/, `${file} ${environment}`);
      }
    }
  });
});
