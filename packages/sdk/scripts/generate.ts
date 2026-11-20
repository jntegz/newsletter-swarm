// Generates src/generated.ts from docs/openapi-v2.json: a TypeScript type for every schema in
// components.schemas, and a method per operation (named by its operationId) on SwarmClient.
// Written for this project instead of a library: openapi-typescript did not support TypeScript 6
// when Phase 1 checked, and the document only uses a small part of JSON Schema.
// Run with `pnpm --filter @swarm/sdk generate` (or `pnpm openapi:v2`, which writes the document
// first). CI fails if the committed output is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

type Schema = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: Schema }> }
  >;
  'x-swarm-scope'?: string;
}

interface Document {
  info: { title: string; version: string };
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, Schema> };
}

const source = fileURLToPath(new URL('../../../docs/openapi-v2.json', import.meta.url));
const target = fileURLToPath(new URL('../src/generated.ts', import.meta.url));
const doc = JSON.parse(readFileSync(source, 'utf8')) as Document;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
const indent = (text: string, by = '  ') => text.replace(/\n/g, `\n${by}`);
const comment = (text: string | undefined, pad = '') =>
  text ? `${pad}/** ${text.replace(/\*\//g, '* /').replace(/\n+/g, ' ')} */\n` : '';

/** A JSON Schema (as zod-to-openapi writes it for OpenAPI 3.1) as a TypeScript type. */
function tsType(schema: Schema | undefined): string {
  if (!schema || Object.keys(schema).length === 0) return 'unknown';
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop() as string;
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map((value) => (value === null ? 'null' : JSON.stringify(value)));
    return values.join(' | ');
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const parts = ((schema.anyOf ?? schema.oneOf) as Schema[]).map(tsType);
    return [...new Set(parts)]
      .map((part) => (part.includes('=>') ? `(${part})` : part))
      .join(' | ');
  }
  if (Array.isArray(schema.allOf)) {
    return (schema.allOf as Schema[]).map((part) => `(${tsType(part)})`).join(' & ');
  }
  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : schema.type
      ? [schema.type as string]
      : schema.properties
        ? ['object']
        : [];
  if (!types.length) return 'unknown';
  return types
    .map((type) => {
      switch (type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array': {
          const item = tsType(schema.items as Schema | undefined);
          return /^[A-Za-z0-9_]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
        }
        case 'object':
          return objectType(schema);
        default:
          return 'unknown';
      }
    })
    .join(' | ');
}

function objectType(schema: Schema): string {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const lines = Object.entries(properties).map(
    ([name, prop]) =>
      `${comment(prop.description as string | undefined)}${key(name)}${required.has(name) ? '' : '?'}: ${tsType(prop)};`,
  );
  const extra = schema.additionalProperties;
  if (extra && typeof extra === 'object') {
    lines.push(`[key: string]: ${tsType(extra as Schema)};`);
  } else if (extra === true || (!lines.length && extra === undefined)) {
    lines.push('[key: string]: unknown;');
  }
  return lines.length ? `{\n  ${indent(lines.join('\n'))}\n}` : 'Record<string, never>';
}

// ---- Schemas ---------------------------------------------------------------------------------

const schemas = Object.entries(doc.components?.schemas ?? {}).sort(([a], [b]) =>
  a.localeCompare(b),
);
const typeDeclarations = schemas.map(
  ([name, schema]) =>
    `${comment(schema.description as string | undefined)}export type ${name} = ${tsType(schema)};`,
);

// ---- Operations ------------------------------------------------------------------------------

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const methodDeclarations: string[] = [];
const operationTable: string[] = [];

/** The `data` of the first 2xx JSON response, or void for 204. */
function resultType(op: OperationObject): string {
  const ok = Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status));
  const types = ok.map(([, response]) => {
    const schema = response.content?.['application/json']?.schema;
    if (!schema) return 'void';
    const data = (schema.properties as Record<string, Schema> | undefined)?.data;
    return data ? tsType(data) : tsType(schema);
  });
  return [...new Set(types)].join(' | ') || 'void';
}

for (const [path, item] of Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b))) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    if (!op.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    const params = op.parameters ?? [];
    const pathParams = params.filter((p) => p.in === 'path');
    const queryParams = params.filter((p) => p.in === 'query');
    const body = op.requestBody?.content?.['application/json']?.schema;
    const fields: string[] = pathParams.map(
      (p) => `${comment(p.description)}${key(p.name)}: ${tsType(p.schema)};`,
    );
    if (queryParams.length) {
      const query = queryParams.map(
        (p) =>
          `${comment(p.description ?? (p.schema?.description as string | undefined))}${key(p.name)}?: ${tsType(p.schema)};`,
      );
      fields.push(`query?: {\n  ${indent(query.join('\n'))}\n};`);
    }
    if (body) fields.push(`body: ${tsType(body)};`);
    const argsType = fields.length ? `{\n  ${indent(fields.join('\n'))}\n}` : null;
    const docLines = [
      op.summary ? `${op.summary}.` : null,
      op['x-swarm-scope'] ? `Scope: ${op['x-swarm-scope']}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const call = [
      `method: '${method.toUpperCase()}'`,
      `path: '${path}'`,
      pathParams.length
        ? `pathParams: { ${pathParams.map((p) => `${key(p.name)}: args.${p.name}`).join(', ')} }`
        : null,
      queryParams.length ? 'query: args.query' : null,
      body ? 'body: args.body' : null,
    ].filter(Boolean);
    const signature = argsType
      ? `args: ${indent(argsType)}, options?: RequestOptions`
      : 'options?: RequestOptions';
    methodDeclarations.push(
      `${comment(docLines)}${op.operationId}(${signature}): Promise<${resultType(op)}> {\n` +
        `  return this.transport.request({ ${call.join(', ')} }, options);\n` +
        `}`,
    );
    operationTable.push(
      `${op.operationId}: { method: '${method.toUpperCase()}', path: '${path}', scope: ${JSON.stringify(op['x-swarm-scope'] ?? null)} },`,
    );
  }
}

const output = `// Generated by packages/sdk/scripts/generate.ts from docs/openapi-v2.json. Do not edit.
// ${doc.info.title} ${doc.info.version}
import { Transport, type ClientOptions, type RequestOptions } from './client';

export const API_VERSION = ${JSON.stringify(doc.info.version)};

${typeDeclarations.join('\n\n')}

/** Every operation: method, path and the scope it needs. */
export const OPERATIONS = {
  ${indent(operationTable.join('\n'))}
} as const;

export type OperationId = keyof typeof OPERATIONS;

/** The Swarm public API. One method per operation, named by its operationId. */
export class SwarmClient {
  readonly transport: Transport;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
  }

  /** The rate-limit headers of the latest response. */
  get rateLimit() {
    return this.transport.rateLimit;
  }

  ${indent(methodDeclarations.join('\n\n'))}
}
`;

const config = await resolveConfig(target);
writeFileSync(target, await format(output, { ...config, parser: 'typescript' }));
console.log(`wrote ${target}: ${schemas.length} types, ${operationTable.length} operations`);
