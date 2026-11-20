// Reads the workers' wrangler.jsonc files for provisioning: which Cloudflare resources an
// environment needs, which values still say "unprovisioned" or another template value, and
// rewriting those values in place (comments and formatting are kept, only the quoted value changes).
import { readFileSync } from 'node:fs';

export const PLACEHOLDER = 'unprovisioned';

/**
 * Every template value the committed staging and production blocks hold (`unprovisioned`,
 * `swarm.example`, `swarm.page`, the account id `000000000000`). The installer refuses the same
 * list (packages/installer/src/config/render.ts reads this file too), so a manual deploy gets the
 * same assurance as `pnpm swarm`.
 */
export const TEMPLATE_PATTERNS = JSON.parse(
  readFileSync(new URL('../../packages/installer/src/config/placeholders.json', import.meta.url)),
).patterns.map((source) => new RegExp(source));
export const ENVIRONMENTS = ['staging', 'production'];

/**
 * Parses JSONC (comments, trailing commas). Returns the value and every string value with its
 * JSON path and the offsets of its quoted text, so a value can be replaced without reformatting.
 */
export function parseJsonc(text) {
  const strings = [];
  let i = 0;

  function fail(message) {
    throw new SyntaxError(`${message} at offset ${i}`);
  }

  function skip() {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i);
        i = end === -1 ? text.length : end + 1;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail('unterminated comment');
        i = end + 2;
      } else return;
    }
  }

  function string() {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    return { value: JSON.parse(text.slice(start, i)), start, end: i };
  }

  function value(path) {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const object = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return object;
        }
        if (text[i] !== '"') fail('expected a key');
        const key = string().value;
        skip();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        object[key] = value([...path, key]);
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const array = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return array;
        }
        array.push(value([...path, array.length]));
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('expected "," or "]"');
      }
    }
    if (c === '"') {
      const token = string();
      strings.push({ path, ...token });
      return token.value;
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!literal) fail('unexpected token');
    i += literal[0].length;
    return JSON.parse(literal[0]);
  }

  const result = value([]);
  skip();
  if (i < text.length) fail('trailing content');
  return { value: result, strings };
}

/** KV namespaces have no name in the config; the binding names them: CACHE → swarm-staging-cache. */
export function kvTitle(environment, binding) {
  return `swarm-${environment}-${binding.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Everything one environment of one worker needs from Cloudflare. Durable Objects are created by
 * deploying the realtime worker and rate-limit namespaces are ids chosen in the config, so neither
 * is created here; rate limits are returned so their ids can be checked.
 */
export function resourcesOf(config, environment) {
  const block = config.env?.[environment];
  if (!block) return null;
  const queues = new Set();
  for (const producer of block.queues?.producers ?? []) queues.add(producer.queue);
  for (const consumer of block.queues?.consumers ?? []) {
    queues.add(consumer.queue);
    if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
  }
  return {
    d1: (block.d1_databases ?? []).map((db) => db.database_name),
    kv: (block.kv_namespaces ?? []).map((ns) => kvTitle(environment, ns.binding)),
    r2: (block.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    queues: [...queues],
    ratelimits: (block.ratelimits ?? []).map((limit) => ({
      name: limit.name,
      namespaceId: String(limit.namespace_id),
    })),
    turnstile: block.vars?.TURNSTILE_SITE_KEY !== undefined,
  };
}

/** The resources of every worker for one environment, each name once. */
export function collectResources(configs, environment) {
  const all = { d1: new Set(), kv: new Set(), r2: new Set(), queues: new Set(), turnstile: false };
  for (const { value } of configs) {
    const resources = resourcesOf(value, environment);
    if (!resources) continue;
    for (const kind of ['d1', 'kv', 'r2', 'queues']) {
      for (const name of resources[kind]) all[kind].add(name);
    }
    all.turnstile ||= resources.turnstile;
  }
  return {
    d1: [...all.d1].sort(),
    kv: [...all.kv].sort(),
    r2: [...all.r2].sort(),
    queues: [...all.queues].sort(),
    turnstile: all.turnstile,
  };
}

/**
 * Rate-limit namespace ids are account-wide: an id used by staging must not appear in production,
 * or staging traffic would count against production's limits. Workers of one environment may share
 * an id on purpose. Local development is simulated, so its ids are not checked. Returns the clashes.
 */
export function ratelimitClashes(configs) {
  const owners = new Map();
  const clashes = [];
  for (const { file, value } of configs) {
    for (const [environment, block] of Object.entries(value.env ?? {})) {
      for (const limit of block.ratelimits ?? []) {
        const id = String(limit.namespace_id);
        const owner = owners.get(id);
        if (owner && owner.environment !== environment) {
          clashes.push(
            `namespace_id ${id}: ${owner.file} (${owner.environment}) and ${file} (${environment})`,
          );
        } else if (!owner) owners.set(id, { file, environment });
      }
    }
  }
  return clashes;
}

function isUnder(path, environment) {
  return path[0] === 'env' && path[1] === environment;
}

/** Paths (like `env.staging.d1_databases.0.database_id`) that still hold the placeholder. */
export function unprovisionedPaths(text, environment) {
  return parseJsonc(text)
    .strings.filter((s) => isUnder(s.path, environment) && s.value === PLACEHOLDER)
    .map((s) => s.path.join('.'));
}

/**
 * Paths under one environment whose value still holds a template value, with what was found:
 * `{ path: 'env.production.vars.APP_ORIGIN', found: 'swarm.example' }`. Values provisioning writes
 * (`unprovisioned`) are reported here as well as by unprovisionedPaths.
 */
export function templatePaths(text, environment) {
  const found = [];
  for (const s of parseJsonc(text).strings) {
    if (!isUnder(s.path, environment)) continue;
    for (const pattern of TEMPLATE_PATTERNS) {
      const match = pattern.exec(s.value)?.[0]?.replace(/^[^a-z0-9]/, '');
      if (match) {
        found.push({ path: s.path.join('.'), found: match });
        break;
      }
    }
  }
  return found;
}

/**
 * What stops an environment from being deployed by hand: every template value left in any worker
 * config, and rate-limit ids shared across environments. `configs` is `[{ file, text, value }]`.
 */
export function deployProblems(configs, environment) {
  return [
    ...configs.flatMap(({ file, text }) =>
      templatePaths(text, environment).map(({ path, found }) => `${file}: ${path} (${found})`),
    ),
    ...ratelimitClashes(configs),
  ];
}

/**
 * Writes resolved ids into one environment of a config. `ids` is `{ d1: {name: uuid}, kv:
 * {title: id}, vars: {NAME: value} }`; anything missing from it is left as it is. Returns the new
 * text and the changes made (none when the config is already up to date).
 */
export function rewriteConfig(text, environment, ids) {
  const { value, strings } = parseJsonc(text);
  const block = value.env?.[environment];
  const edits = [];
  if (!block) return { text, changes: [] };
  for (const s of strings) {
    if (!isUnder(s.path, environment)) continue;
    const rest = s.path.slice(2);
    let next;
    if (rest[0] === 'd1_databases' && rest[2] === 'database_id') {
      next = ids.d1?.[block.d1_databases[rest[1]].database_name];
    } else if (rest[0] === 'kv_namespaces' && rest[2] === 'id') {
      next = ids.kv?.[kvTitle(environment, block.kv_namespaces[rest[1]].binding)];
    } else if (rest[0] === 'vars' && rest.length === 2) {
      next = ids.vars?.[rest[1]];
    }
    if (next !== undefined && next !== s.value) {
      edits.push({ ...s, next });
    }
  }
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + JSON.stringify(edit.next) + out.slice(edit.end);
  }
  return {
    text: out,
    changes: edits.map((e) => ({ path: e.path.join('.'), from: e.value, to: e.next })),
  };
}
