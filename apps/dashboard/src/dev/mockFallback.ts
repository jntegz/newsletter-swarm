// Development only, with ?mock=1: an answer for any request the canned data in mockApi.ts doesn't
// cover, built from the API's own description (docs/openapi.json). It has the right shape and is
// empty, so a page shows its empty state instead of an error. Saves echo what was sent.
/* eslint-disable @typescript-eslint/no-explicit-any */

interface Operation {
  pattern: RegExp;
  /** Fixed path segments: the most specific path wins. */
  fixed: number;
  operation: any;
}

let document: any;
let operations: Map<string, Operation[]> | undefined;

async function load() {
  if (operations) return operations;
  document = (await import('../../../../docs/openapi.json')).default;
  operations = new Map();
  for (const [path, item] of Object.entries<any>(document.paths)) {
    const segments = path.split('/');
    const pattern = new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    const fixed = segments.filter((segment) => !segment.startsWith('{')).length;
    for (const [method, operation] of Object.entries(item)) {
      const list = operations.get(method.toUpperCase()) ?? [];
      list.push({ pattern, fixed, operation });
      operations.set(method.toUpperCase(), list);
    }
  }
  return operations;
}

const resolve = (schema: any) =>
  schema?.$ref ? document.components.schemas[schema.$ref.split('/').pop()] : schema;

/**
 * An id of the kind a pattern like ^cf_[0-9a-f]{32}$ asks for: the one in the address when there is
 * one, so a detail page's next request names the same thing. An empty id would make it /forms//stats.
 */
function idFor(pattern: string, ids: readonly string[]): string | null {
  const prefix = /^\^([a-z0-9]+)_/.exec(pattern)?.[1];
  if (!prefix) return null;
  return ids.find((id) => id.startsWith(`${prefix}_`)) ?? `${prefix}_${'0'.repeat(31)}1`;
}

/** Described only as "an object", so the description can't say what a valid empty one looks like. */
const SHAPES: Record<string, unknown> = { CircleRule: { op: 'and', children: [] } };

function sample(raw: any, ids: readonly string[], depth = 0): unknown {
  const named = raw?.$ref ? SHAPES[raw.$ref.split('/').pop()] : undefined;
  if (named) return named;
  const schema = resolve(raw);
  if (!schema || depth > 10) return null;
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    // Optional parts stay empty: null when the description allows it.
    const nullable = options.some((option: any) => resolve(option)?.type === 'null');
    if (nullable) return null;
    return sample(options[0], ids, depth + 1);
  }
  if (schema.allOf) {
    return Object.assign({}, ...schema.allOf.map((part: any) => sample(part, ids, depth + 1)));
  }
  if (schema.nullable) return null;
  if (schema.enum) return schema.enum[0];
  if ('const' in schema) return schema.const;
  if (schema.default !== undefined) return schema.default;
  switch (Array.isArray(schema.type) ? schema.type[0] : schema.type) {
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'string':
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.pattern) {
        const id = idFor(schema.pattern, ids);
        if (id) return id;
      }
      return schema.format === 'uri' ? 'https://example.com' : '';
    case 'object':
    default: {
      const out: Record<string, unknown> = {};
      const required: string[] = schema.required ?? [];
      for (const [name, property] of Object.entries<any>(schema.properties ?? {})) {
        // A field with a default is always there in a real answer, whatever the description says.
        const part = resolve(property);
        const present = required.includes(name) || part?.default !== undefined;
        if (present || part?.type === 'array') out[name] = sample(property, ids, depth + 1);
      }
      return out;
    }
  }
}

/** The answer for a request the canned data has none for, or null when the API has no such route. */
export async function fallbackAnswer(
  method: string,
  path: string,
  body: unknown,
): Promise<[number, unknown] | null> {
  const candidates = (await load()).get(method) ?? [];
  const match = candidates
    .filter((candidate) => candidate.pattern.test(path))
    .sort((a, b) => b.fixed - a.fixed)[0];
  if (!match) return null;
  const responses = Object.entries<any>(match.operation.responses);
  const success = responses.find(([status]) => status.startsWith('2'));
  if (!success) return null;
  const status = Number(success[0]);
  const schema = success[1].content?.['application/json']?.schema;
  // A Response can't have a body with 204, and the client reads an empty 200 the same way.
  if (!schema) return [200, null];
  const shaped = resolve(schema);
  const ids = path.split('/').filter((segment) => /^[a-z0-9]+_[0-9a-z]+$/.test(segment));
  const data = sample(shaped.properties?.data ?? shaped, ids);
  const merged =
    data && typeof data === 'object' && !Array.isArray(data) && body && typeof body === 'object'
      ? { ...data, ...body }
      : data;
  return [status, merged];
}
