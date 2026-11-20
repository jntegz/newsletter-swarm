// The public API's documents: /v2/openapi.json (OpenAPI 3.1, built from the /v2 routers only, a
// separate document from the dashboard's), /v2/reference (an API reference rendered here from
// that document: plain HTML and CSS, no script, nothing from another origin) and
// /.well-known/api-catalog (RFC 9727). All three are public.
import { createRoute, z } from '@hono/zod-openapi';
import { API_SCOPES } from '@swarm/domain';
import { createRouter } from '../lib/context';
import { v2Routers } from './index';
import { BEARER_SCHEME, SCOPE_EXTENSION } from './route';

const V2_VERSION = '2.0.0';
const V2_OPENAPI_PATH = '/v2/openapi.json';
const V2_REFERENCE_PATH = '/v2/reference';
const API_CATALOG_PATH = '/.well-known/api-catalog';

const DESCRIPTION = [
  'The Swarm public API. Authenticate with `Authorization: Bearer sk_live_…` (a scoped API key from Settings → Developers) or an OAuth access token.',
  '',
  'Every operation needs one scope, shown on it; a `:write` scope also grants its `:read`. A Channel the credential cannot reach answers 404.',
  '',
  'Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429 carries `Retry-After`. Writes accept `Idempotency-Key` (24 hours). Lists are paged with an opaque `cursor` and `limit` (up to 100). Errors are `{ error: { code, message, requestId, details? } }`.',
].join('\n');

type OpenApiDocument = ReturnType<ReturnType<typeof createRouter>['getOpenAPI31Document']>;

let cached: OpenApiDocument | undefined;

/** The /v2 document. `servers` is set per request by the route; the committed copy has none. */
export function v2OpenApiDocument(): OpenApiDocument {
  if (cached) return cached;
  const doc = createRouter();
  doc.openAPIRegistry.registerComponent('securitySchemes', BEARER_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    description: `A scoped API key (sk_live_…) or an OAuth access token (oat_…). Scopes: ${API_SCOPES.join(', ')}.`,
  });
  for (const router of v2Routers) doc.route('/', router);
  cached = doc.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Swarm public API', version: V2_VERSION, description: DESCRIPTION },
    security: [{ [BEARER_SCHEME]: [] }],
  });
  return cached;
}

// ---- The reference page ----------------------------------------------------------------------

const escape = (text: unknown) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );

/** `code` spans and paragraphs, the only Markdown the descriptions use. */
const prose = (text: unknown) =>
  escape(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`)
    .join('');

type Json = Record<string, unknown>;

function typeOf(schema: Json | undefined): string {
  if (!schema) return 'any';
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop() as string;
    return `<a href="#schema-${escape(name)}">${escape(name)}</a>`;
  }
  if (Array.isArray(schema.enum))
    return schema.enum.map((v) => `<code>${escape(JSON.stringify(v))}</code>`).join(' | ');
  if ('const' in schema) return `<code>${escape(JSON.stringify(schema.const))}</code>`;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      return (schema[key] as Json[]).map(typeOf).join(key === 'allOf' ? ' &amp; ' : ' | ');
    }
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  return types
    .map((type) => {
      if (type === 'array') return `${typeOf(schema.items as Json)}[]`;
      if (type === 'object' && !schema.properties && schema.additionalProperties) {
        return `map of ${typeOf(schema.additionalProperties as Json)}`;
      }
      return escape(type ?? 'any');
    })
    .join(' | ');
}

function propertiesTable(schema: Json | undefined): string {
  const properties = schema?.properties as Record<string, Json> | undefined;
  if (!properties) return schema ? `<p class="type">${typeOf(schema)}</p>` : '';
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  const rows = Object.entries(properties)
    .map(
      ([name, prop]) =>
        `<tr><td><code>${escape(name)}</code>${required.has(name) ? '' : ' <span class="muted">optional</span>'}</td><td>${typeOf(prop)}</td><td>${escape(prop.description ?? '')}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bodySchema(content: unknown): Json | undefined {
  const media = content as Record<string, { schema?: Json }> | undefined;
  return media?.['application/json']?.schema;
}

function renderReference(doc: OpenApiDocument, origin: string): string {
  const operations: { tag: string; method: string; path: string; op: Json }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, Json>)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      operations.push({ tag: ((op.tags as string[]) ?? ['Other'])[0] as string, method, path, op });
    }
  }
  const tags = [...new Set(operations.map((o) => o.tag))];
  const nav = tags
    .map((tag) => `<li><a href="#tag-${escape(tag)}">${escape(tag)}</a></li>`)
    .join('');
  const sections = tags
    .map((tag) => {
      const ops = operations
        .filter((o) => o.tag === tag)
        .map(({ method, path, op }) => {
          const params = (op.parameters as Json[] | undefined) ?? [];
          const paramRows = params
            .map(
              (p) =>
                `<tr><td><code>${escape(p.name)}</code>${p.required ? '' : ' <span class="muted">optional</span>'}</td><td>${escape(p.in)}</td><td>${typeOf(p.schema as Json)}</td><td>${escape((p.schema as Json | undefined)?.description ?? p.description ?? '')}</td></tr>`,
            )
            .join('');
          const body = bodySchema((op.requestBody as Json | undefined)?.content);
          const responses = Object.entries((op.responses as Record<string, Json>) ?? {})
            .map(([status, response]) => {
              const schema = bodySchema(response.content);
              const data = (schema?.properties as Record<string, Json> | undefined)?.data;
              return `<tr><td><code>${escape(status)}</code></td><td>${escape(response.description)}</td><td>${data ? typeOf(data) : schema ? typeOf(schema) : ''}</td></tr>`;
            })
            .join('');
          const id = escape(op.operationId ?? `${method}-${path}`);
          return `<section class="op" id="op-${id}">
  <h3><span class="method ${escape(method)}">${escape(method.toUpperCase())}</span> <code>${escape(path)}</code></h3>
  <p class="summary">${escape(op.summary)}</p>
  <p class="scope">Scope <code>${escape(op[SCOPE_EXTENSION])}</code>${op.operationId ? ` · SDK <code>${escape(op.operationId)}</code>` : ''}</p>
  ${op.description ? prose(op.description) : ''}
  ${paramRows ? `<h4>Parameters</h4><table><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Notes</th></tr></thead><tbody>${paramRows}</tbody></table>` : ''}
  ${body ? `<h4>Body</h4>${body.$ref ? `<p class="type">${typeOf(body)}</p>` : propertiesTable(body)}` : ''}
  <h4>Responses</h4><table><thead><tr><th>Status</th><th>Meaning</th><th>data</th></tr></thead><tbody>${responses}</tbody></table>
</section>`;
        })
        .join('\n');
      return `<h2 id="tag-${escape(tag)}">${escape(tag)}</h2>\n${ops}`;
    })
    .join('\n');
  const schemas = Object.entries((doc.components?.schemas as Record<string, Json>) ?? {})
    .map(
      ([name, schema]) =>
        `<section class="schema" id="schema-${escape(name)}"><h3>${escape(name)}</h3>${schema.description ? prose(schema.description) : ''}${propertiesTable(schema)}</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm API reference</title>
<style>
/* DESIGN.md Indigo tokens */
:root { --ink: #0f0f12; --muted: #6b6b76; --line: #ececf2; --bg: #fbfbfd; --accent: #5636e8; --code: #efeafe; }
@media (prefers-color-scheme: dark) { :root { --ink: #ecebf5; --muted: #a9a7bd; --line: #2f2d42; --bg: #14131d; --accent: #a6a1ff; --code: #22202f; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
.wrap { display: grid; grid-template-columns: 220px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
nav { position: sticky; top: 0; align-self: start; height: 100vh; overflow: auto; padding: 24px 16px; border-right: 1px solid var(--line); }
nav ul { list-style: none; margin: 0; padding: 0; } nav li { margin: 4px 0; }
main { padding: 24px 32px 64px; min-width: 0; }
a { color: var(--accent); } h1 { font-size: 26px; margin: 0 0 8px; } h2 { margin: 40px 0 8px; font-size: 20px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 16px; margin: 0 0 4px; } h4 { margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
code { font: 13px/1.4 ui-monospace, "SFMono-Regular", Consolas, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.op, .schema { border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; }
.method { display: inline-block; min-width: 58px; font: 600 12px/1.8 ui-monospace, Consolas, monospace; text-align: center; border-radius: 4px; color: #fff; background: #4a4a5e; }
.method.get { background: #1f7a4d; } .method.post { background: #5636e8; } .method.patch { background: #8a5a00; } .method.delete { background: #b5401f; }
.summary { margin: 4px 0; font-weight: 500; } .scope, .muted { color: var(--muted); font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; } th, td { text-align: left; padding: 6px 8px; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
@media (max-width: 760px) { .wrap { grid-template-columns: 1fr; } nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 16px; } }
</style>
</head>
<body>
<div class="wrap">
<nav aria-label="Sections"><p><strong>Swarm API</strong> <span class="muted">${escape(doc.info.version)}</span></p><ul>${nav}<li><a href="#schemas">Schemas</a></li></ul><p><a href="${escape(V2_OPENAPI_PATH)}">openapi.json</a></p></nav>
<main>
<h1>Swarm API reference</h1>
${prose(doc.info.description)}
<p>Base URL <code>${escape(origin)}</code> · <a href="${escape(V2_OPENAPI_PATH)}">OpenAPI document</a></p>
${sections}
<h2 id="schemas">Schemas</h2>
${schemas}
</main>
</div>
</body>
</html>`;
}

// ---- Routes ----------------------------------------------------------------------------------

/** Public, mounted on the app beside the /v2 routers (not part of the /v2 document). */
export const v2Docs = createRouter();

v2Docs.openapi(
  createRoute({
    method: 'get',
    path: V2_OPENAPI_PATH,
    tags: ['Public API'],
    summary: 'The public API’s OpenAPI 3.1 document',
    description: 'Public. Built from the /v2 routes only.',
    responses: {
      200: {
        description: 'OpenAPI document',
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
  }),
  (c) => {
    const origin = new URL(c.req.url).origin;
    c.header('cache-control', 'public, max-age=300');
    c.header('access-control-allow-origin', '*');
    const document = { ...v2OpenApiDocument(), servers: [{ url: origin }] };
    // The document is JSON already; its TypeScript type just isn't Hono's JSONValue.
    return c.json(document as unknown as Record<string, never>, 200);
  },
);

v2Docs.openapi(
  createRoute({
    method: 'get',
    path: V2_REFERENCE_PATH,
    tags: ['Public API'],
    summary: 'The public API reference (HTML)',
    description: 'Public. Rendered from the OpenAPI document; no script.',
    responses: {
      200: { description: 'HTML page', content: { 'text/html': { schema: z.string() } } },
    },
  }),
  (c) => {
    c.header('cache-control', 'public, max-age=300');
    c.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    return c.html(renderReference(v2OpenApiDocument(), new URL(c.req.url).origin), 200);
  },
);

v2Docs.openapi(
  createRoute({
    method: 'get',
    path: API_CATALOG_PATH,
    tags: ['Public API'],
    summary: 'API catalog (RFC 9727)',
    description: 'A linkset naming the public API, its OpenAPI document and its reference.',
    responses: {
      200: {
        description: 'Linkset',
        content: { 'application/linkset+json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
  }),
  (c) => {
    const origin = new URL(c.req.url).origin;
    const linkset = {
      linkset: [
        {
          anchor: `${origin}/v2`,
          'service-desc': [
            {
              href: `${origin}${V2_OPENAPI_PATH}`,
              type: 'application/vnd.oai.openapi+json;version=3.1',
            },
          ],
          'service-doc': [{ href: `${origin}${V2_REFERENCE_PATH}`, type: 'text/html' }],
        },
      ],
    };
    return c.json(linkset, 200, {
      'content-type': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      link: `<${origin}${API_CATALOG_PATH}>; rel="api-catalog"`,
      'cache-control': 'public, max-age=3600',
    });
  },
);
