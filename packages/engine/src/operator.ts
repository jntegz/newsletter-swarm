/**
 * Open Operator (Phase 8): the agent tool registry, the agent audit log and the approval queue.
 * The API worker's MCP endpoint uses them; an in-product agent (Copilot) can reuse them through
 * runAgentTool and decideAgentApproval with its own dispatch.
 *
 * CONTRACT (docs/open-operator.md; constants in p8-operator.ts; tables in 0023_open_operator.sql)
 * - Tools are derived from the /v2 OpenAPI document (deriveAgentTools): one per operation, named
 *   after its operationId in snake_case, with the operation's one scope. Read-only = GET or a
 *   `:read` scope; destructive = DELETE or DESTRUCTIVE_OPERATIONS; everything else is a write.
 * - A call becomes a /v2 request (toolRequest) that the caller's `dispatch` runs through the real
 *   router, so the route's own scope, Channel, validation and plan checks apply. Nothing here
 *   repeats them, except the scope pre-check that decides between "refused" and "held".
 * - Every call that names a tool writes one agent_actions row after it finishes (never updated):
 *   hash-chained per workspace like audit_events. Arguments are stored only as maskArguments().
 * - Held calls (approval mode) store the exact request in agent_approvals. Approving claims the
 *   row with one conditional update, re-resolves the credential, re-checks its scope and Channel,
 *   then runs the stored request once with Idempotency-Key agent-approval-<id>.
 */
import {
  all,
  canonicalJson,
  first,
  isUniqueViolation,
  recordedBroken,
  run,
  sha256Hex,
  type ChainCheckpoint,
  type ChainVerifyOptions,
  type ChainVerifyStep,
} from '@swarm/db';
import {
  AGENT_LOG_MIN_RETENTION_DAYS,
  APPROVAL_STATUS_TOOL,
  CONDITIONAL_HOLD_OPERATIONS,
  DESTRUCTIVE_OPERATIONS,
  OPEN_WORLD_OPERATIONS,
  MAX_PENDING_APPROVALS,
  PLAN_LIMITS,
  newId,
  scopeAllows,
  type AgentOutcome,
  type AgentPrincipalKind,
  type AgentSource,
  type ApiScope,
  type ApprovalMode,
  type Plan,
  type ToolRisk,
} from '@swarm/domain';
import { MONTH_MS } from './retention';

// ---------------------------------------------------------------------------------------------
// The tool registry

export interface AgentPrincipal {
  kind: AgentPrincipalKind;
  /** The api_keys id or the oauth_grants id. */
  id: string;
  workspaceId: string;
  /** null = every Channel in the workspace. */
  channelIds: string[] | null;
  scopes: ApiScope[];
}

type Json = Record<string, unknown>;

export interface AgentToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: AgentToolAnnotations;
  operationId: string;
  method: string;
  /** The path template, e.g. /v2/channels/{channelId}/members. */
  path: string;
  scope: ApiScope;
  risk: ToolRisk;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

/** The fields of an OpenAPI 3.1 document this module reads. */
export interface OpenApiLike {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_SCHEMA_DEPTH = 8;
const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_OPERATIONS);
const OPEN_WORLD = new Set<string>(OPEN_WORLD_OPERATIONS);
const CONDITIONAL: Record<string, string | undefined> = CONDITIONAL_HOLD_OPERATIONS;

/** listMembers → list_members. */
export const toolName = (operationId: string) =>
  operationId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function toolRisk(method: string, scope: string, operationId: string): ToolRisk {
  const verb = method.toLowerCase();
  if (verb === 'delete' || DESTRUCTIVE.has(operationId)) return 'destructive';
  if (verb === 'get' || scope.endsWith(':read')) return 'read';
  return 'write';
}

/** Inlines `#/components/schemas/…` references so a tool's input schema stands alone. */
function inline(schema: unknown, components: Record<string, unknown>, depth: number): unknown {
  if (Array.isArray(schema)) return schema.map((item) => inline(item, components, depth));
  if (!schema || typeof schema !== 'object') return schema;
  const object = schema as Json;
  if (typeof object.$ref === 'string') {
    const name = /^#\/components\/schemas\/(.+)$/.exec(object.$ref)?.[1];
    const target = name === undefined ? undefined : components[name];
    // A self-referencing schema ends in an open schema rather than recursing forever.
    if (target === undefined || depth >= MAX_SCHEMA_DEPTH) return {};
    const { $ref: _ref, ...rest } = object;
    return { ...(inline(target, components, depth + 1) as Json), ...rest };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(object)) {
    // OpenAPI-only keywords mean nothing to a JSON Schema validator.
    if (key === 'example' || key === 'xml' || key === 'externalDocs') continue;
    out[key] = inline(value, components, depth);
  }
  return out;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

/**
 * One tool per operation of the /v2 document, sorted by name (a deterministic list helps clients
 * and prompt caches). The document is the one /v2/openapi.json serves, so tools follow routes.
 */
export function deriveAgentTools(doc: OpenApiLike, scopeKey = 'x-swarm-scope'): AgentTool[] {
  const components = doc.components?.schemas ?? {};
  const tools: AgentTool[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = (item as Record<string, Json | undefined>)[method];
      if (!op || typeof op.operationId !== 'string' || typeof op[scopeKey] !== 'string') continue;
      const operationId = op.operationId;
      const scope = op[scopeKey] as ApiScope;
      const risk = toolRisk(method, scope, operationId);
      const params = (op.parameters as Parameter[] | undefined) ?? [];
      const properties: Json = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      for (const param of params) {
        if (param.in !== 'path' && param.in !== 'query') continue;
        const schema = inline(param.schema ?? {}, components, 0) as Json;
        properties[param.name] = param.description
          ? { ...schema, description: param.description }
          : schema;
        if (param.in === 'path') pathParams.push(param.name);
        else queryParams.push(param.name);
        if (param.in === 'path' || param.required) required.push(param.name);
      }
      const requestBody = op.requestBody as
        { required?: boolean; content?: Record<string, { schema?: unknown }> } | undefined;
      const bodySchema = requestBody?.content?.['application/json']?.schema;
      if (bodySchema !== undefined) {
        properties.body = {
          ...(inline(bodySchema, components, 0) as Json),
          description: 'The JSON request body.',
        };
        if (requestBody?.required) required.push('body');
      }
      const summary = typeof op.summary === 'string' ? op.summary : operationId;
      const conditional = risk === 'write' ? CONDITIONAL[operationId] : undefined;
      const openWorld = OPEN_WORLD.has(operationId);
      const notes = [
        typeof op.description === 'string' ? op.description : null,
        `Needs the ${scope} scope. Calls ${method.toUpperCase()} ${path} on the Swarm public API.`,
        openWorld
          ? 'Reaches outside Swarm: it sends email (now or as a result), calls a webhook endpoint or fetches a URL.'
          : null,
        risk === 'destructive'
          ? 'Destructive: the workspace may require a person to approve the call first; the result then says it is pending.'
          : conditional
            ? `${conditional} The result then says it is pending a person's approval.`
            : null,
      ].filter(Boolean);
      tools.push({
        name: toolName(operationId),
        title: summary,
        description: `${summary}.\n\n${notes.join('\n\n')}`,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        annotations: {
          title: summary,
          readOnlyHint: risk === 'read',
          // A tool that can be held like a destructive one says so, whatever its method.
          destructiveHint: risk === 'destructive' || conditional !== undefined,
          idempotentHint: method === 'get' || method === 'put' || method === 'delete',
          openWorldHint: openWorld,
        },
        operationId,
        method: method.toUpperCase(),
        path,
        scope,
        risk,
        pathParams,
        queryParams,
        hasBody: bodySchema !== undefined,
      });
    }
  }
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The tools a principal may call (a `:write` scope grants its `:read`). */
export const toolsFor = (tools: readonly AgentTool[], scopes: readonly ApiScope[]) =>
  tools.filter((tool) => scopeAllows(scopes, tool.scope));

/** The server's own approval-status tool (not a /v2 operation). */
export const APPROVAL_STATUS_TOOL_DEFINITION = {
  name: APPROVAL_STATUS_TOOL,
  title: 'Status of a held tool call',
  description:
    'A destructive call may wait for a person to approve it in the Swarm dashboard. Pass the approvalId from the pending result to see whether it was approved, rejected or expired, and the result once it ran.',
  inputSchema: {
    type: 'object',
    properties: { approvalId: { type: 'string', pattern: '^aa_[0-9a-f]{32}$' } },
    required: ['approvalId'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Status of a held tool call',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export interface ToolRequest {
  method: string;
  /** Path and query string, e.g. /v2/channels/ch_…/members?limit=10. */
  path: string;
  /** The JSON body, or null. */
  body: unknown;
}

export type ToolRequestResult = { ok: true; request: ToolRequest } | { ok: false; message: string };

const primitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The /v2 request for a call. Shapes are checked here; values are the route's to validate. */
export function toolRequest(tool: AgentTool, args: Json): ToolRequestResult {
  const known = new Set([
    ...tool.pathParams,
    ...tool.queryParams,
    ...(tool.hasBody ? ['body'] : []),
  ]);
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length) return { ok: false, message: `Unknown argument: ${unknown.join(', ')}.` };
  let path = tool.path;
  for (const name of tool.pathParams) {
    const value = args[name];
    if (!primitive(value) || String(value) === '') {
      return { ok: false, message: `${name} is required.` };
    }
    // encodeURIComponent keeps '.', and a URL resolves '.' and '..' segments away, so such a
    // value would reach a different route than this tool's.
    if (
      String(value)
        .split('/')
        .some((segment) => segment === '.' || segment === '..')
    ) {
      return { ok: false, message: `${name} is not a valid id.` };
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const query = new URLSearchParams();
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (!values.every(primitive)) return { ok: false, message: `${name} must be a plain value.` };
    for (const item of values) query.append(name, String(item));
  }
  const search = query.toString();
  return {
    ok: true,
    request: {
      method: tool.method,
      path: search ? `${path}?${search}` : path,
      body: tool.hasBody ? (args.body ?? null) : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Masking

const SENSITIVE_KEY =
  /^(e-?mail|emails|.*name|phone|address|street|city|postal.*|zip|ip|.*_ip|fields?|note|notes|message|secret|.*secret|password|token|.*token|url|urls|html|text|content|body_?html|subject|preheader)$/i;
/**
 * The argument names whose short values are kept as they are: enumerations, scopes, tags, times
 * and counts the API defines, never values a person or a credential could be identified by. Any
 * other string (a license key, a search term, a new argument nobody listed yet) is reduced to its
 * length until it is added here.
 */
export const SAFE_ARGUMENT_KEYS: readonly string[] = [
  'status',
  'mode',
  'kind',
  'type',
  'scope',
  'scopes',
  'risk',
  'outcome',
  'role',
  'event',
  'events',
  'grouping',
  'contentMode',
  'webVisibility',
  'visibility',
  'format',
  'sort',
  'order',
  'direction',
  'timezone',
  'digest',
  'plan',
  'currency',
  'tag',
  'tags',
  'publishAt',
  'pausedUntil',
  'since',
  'until',
  'before',
  'after',
  'quietStart',
  'quietEnd',
  'time',
  'weekdays',
  'source',
  'feature',
];
const SAFE_KEY = new Set(SAFE_ARGUMENT_KEYS);
const ID = /^[a-z]{2}_[0-9a-f]{32}$/;
const TOKEN_LIKE = /^[A-Za-z0-9_.:-]{1,40}$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_ITEMS = 10;
const MAX_DEPTH = 5;
const MAX_SUMMARY_CHARS = 2048;

function maskValue(value: unknown, depth: number, key: string | null): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (EMAIL_LIKE.test(value)) return '[email]';
    if (ID.test(value)) return value;
    if (key !== null && SAFE_KEY.has(key) && TOKEN_LIKE.test(value)) return value;
    return `[text, ${value.length} chars]`;
  }
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    // Items are judged by the array's own key: tags: ['vip'] keeps its tag names.
    const items = value.slice(0, MAX_ITEMS).map((item) => maskValue(item, depth + 1, key));
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS} more]`] : items;
  }
  if (typeof value === 'object') {
    const out: Json = {};
    for (const [name, item] of Object.entries(value as Json)) {
      // Ids under a sensitive-looking key (memberId, …) are not caught: the key must match whole.
      out[name] =
        SENSITIVE_KEY.test(name) && item !== null && item !== undefined
          ? '[redacted]'
          : maskValue(item, depth + 1, name);
    }
    return out;
  }
  return '[value]';
}

/**
 * The stored summary of tool arguments (or of a response): the shape, ids, numbers and booleans,
 * and short token-like strings only under a listed argument name (SAFE_ARGUMENT_KEYS); personal
 * or secret fields redacted, other text reduced to its length, anything that looks like an email
 * address replaced. At most 2 KB.
 */
export function maskArguments(value: unknown): unknown {
  const masked = maskValue(value, 0, null);
  const text = JSON.stringify(masked) ?? 'null';
  return text.length <= MAX_SUMMARY_CHARS ? masked : { truncated: true, chars: text.length };
}

/**
 * A request path as kept after its call was decided: ids and the route's own words stay, any
 * other segment (a license key, an address) becomes [value], and query values are masked like
 * arguments.
 */
export function maskPath(path: string): string {
  const [route = '', search = ''] = path.split('?', 2);
  const segments = route
    .split('/')
    .map((segment) =>
      segment === '' ||
      ID.test(segment) ||
      (/^[a-z0-9][a-z0-9-]*$/.test(segment) && !/\d{3}/.test(segment))
        ? segment
        : '[value]',
    );
  if (!search) return segments.join('/');
  const query = new URLSearchParams(search);
  const kept = [...query.entries()].map(([name, value]) => {
    const masked = maskValue(value, 0, name);
    return `${encodeURIComponent(name)}=${typeof masked === 'string' && masked === value ? encodeURIComponent(value) : '[value]'}`;
  });
  return `${segments.join('/')}?${kept.join('&')}`;
}

// ---------------------------------------------------------------------------------------------
// The agent audit log

const GENESIS = '0'.repeat(64);
const clamp = (value: string | null | undefined, max: number) =>
  value ? value.slice(0, max) : null;

export interface AgentActionInput {
  id?: string;
  workspaceId: string;
  source: AgentSource;
  principalKind: AgentPrincipalKind;
  principalId: string;
  clientName: string | null;
  clientVersion: string | null;
  tool: string;
  channelId: string | null;
  risk: ToolRisk | null;
  arguments: unknown;
  outcome: AgentOutcome;
  statusCode: number | null;
  errorCode: string | null;
  latencyMs: number;
  approvalId: string | null;
  /** The Copilot request the call was part of, if any. */
  copilotRequestId?: string | null;
  createdAt?: number;
}

interface ActionRow {
  id: string;
  workspace_id: string;
  seq: number;
  source: string;
  principal_kind: string;
  principal_id: string;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  channel_id: string | null;
  risk: string | null;
  arguments_json: string;
  outcome: string;
  status_code: number | null;
  error_code: string | null;
  latency_ms: number;
  approval_id: string | null;
  copilot_request_id: string | null;
  created_at: number;
  prev_hash: string;
  hash: string;
}

const ACTION_COLUMNS = `id, workspace_id, seq, source, principal_kind, principal_id, client_name,
  client_version, tool, channel_id, risk, arguments_json, outcome, status_code, error_code,
  latency_ms, approval_id, created_at, prev_hash, hash, copilot_request_id`;

function actionHash(prevHash: string, row: Omit<ActionRow, 'prev_hash' | 'hash'>): Promise<string> {
  const body = canonicalJson({
    id: row.id,
    seq: row.seq,
    workspaceId: row.workspace_id,
    source: row.source,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    clientName: row.client_name,
    clientVersion: row.client_version,
    tool: row.tool,
    channelId: row.channel_id,
    risk: row.risk,
    arguments: JSON.parse(row.arguments_json) as unknown,
    outcome: row.outcome,
    statusCode: row.status_code,
    errorCode: row.error_code,
    latencyMs: row.latency_ms,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    // Added later: hashed only when set, so rows written before it still verify.
    ...(row.copilot_request_id ? { copilotRequestId: row.copilot_request_id } : {}),
  });
  return sha256Hex(`${prevHash}\n${body}`);
}

/**
 * Appends one row to the workspace's agent log. Concurrent writers race on
 * UNIQUE(workspace_id, seq) and retry, as appendAudit does. The arguments must already be masked.
 */
export async function appendAgentAction(db: D1Database, input: AgentActionInput): Promise<string> {
  const id = input.id ?? newId('agentAction');
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await first<{ seq: number; hash: string }>(
      db,
      'SELECT seq, hash FROM agent_actions WHERE workspace_id = ?1 ORDER BY seq DESC LIMIT 1',
      input.workspaceId,
    );
    const anchor = last
      ? null
      : await first<{ seq: number; hash: string }>(
          db,
          'SELECT seq, hash FROM agent_action_anchors WHERE workspace_id = ?1',
          input.workspaceId,
        );
    const start = last ?? anchor ?? { seq: 0, hash: GENESIS };
    const row = {
      id,
      workspace_id: input.workspaceId,
      seq: start.seq + 1,
      source: input.source,
      principal_kind: input.principalKind,
      principal_id: input.principalId,
      client_name: clamp(input.clientName, 100),
      client_version: clamp(input.clientVersion, 100),
      tool: input.tool.slice(0, 128),
      channel_id: clamp(input.channelId, 64),
      risk: input.risk,
      arguments_json: JSON.stringify(input.arguments ?? null),
      outcome: input.outcome,
      status_code: input.statusCode,
      error_code: clamp(input.errorCode, 64),
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
      approval_id: input.approvalId,
      copilot_request_id: clamp(input.copilotRequestId, 64),
      created_at: input.createdAt ?? Date.now(),
    };
    const hash = await actionHash(start.hash, row);
    try {
      await run(
        db,
        `INSERT INTO agent_actions (${ACTION_COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
        row.id,
        row.workspace_id,
        row.seq,
        row.source,
        row.principal_kind,
        row.principal_id,
        row.client_name,
        row.client_version,
        row.tool,
        row.channel_id,
        row.risk,
        row.arguments_json,
        row.outcome,
        row.status_code,
        row.error_code,
        row.latency_ms,
        row.approval_id,
        row.created_at,
        start.hash,
        hash,
        row.copilot_request_id,
      );
      return id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('could not append agent action after 5 attempts');
}

export interface AgentLogVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  anchorSeq: number | null;
}

/** Re-computes every kept row's hash, from the retention anchor or the genesis hash. */
export async function verifyAgentLog(
  db: D1Database,
  workspaceId: string,
): Promise<AgentLogVerification> {
  const { ok, checked, brokenAtSeq, anchorSeq } = await verifyAgentLogStep(db, workspaceId);
  return { ok, checked, brokenAtSeq, anchorSeq };
}

/** verifyAgentLog in bounded steps, like verifyAuditChainStep in @swarm/db. */
export async function verifyAgentLogStep(
  db: D1Database,
  workspaceId: string,
  options: ChainVerifyOptions = {},
): Promise<ChainVerifyStep> {
  const anchor = await first<{ seq: number; hash: string }>(
    db,
    'SELECT seq, hash FROM agent_action_anchors WHERE workspace_id = ?1',
    workspaceId,
  );
  const start = anchor ?? { seq: 0, hash: GENESIS };
  const anchorSeq = anchor?.seq ?? null;
  const resume = options.from && options.from.seq >= start.seq ? options.from : null;
  const limit = options.limit ?? Infinity;
  const through = options.throughSeq ?? Number.MAX_SAFE_INTEGER;
  let last: ChainCheckpoint = resume ?? { seq: start.seq, hash: start.hash };
  let checked = 0;
  // From the start, read from seq 0 so rows left at or below a moved anchor show as a break.
  let after = resume ? resume.seq : -1;
  // Read in pages so a long log never sits in memory at once.
  for (;;) {
    const page = Math.min(AGENT_LOG_VERIFY_PAGE, limit - checked);
    if (page <= 0) return { ok: true, checked, brokenAtSeq: null, anchorSeq, done: false, last };
    const rows = await all<ActionRow>(
      db,
      `SELECT ${ACTION_COLUMNS} FROM agent_actions WHERE workspace_id = ?1 AND seq > ?2
          AND seq <= ?3 ORDER BY seq LIMIT ?4`,
      workspaceId,
      after,
      through,
      page,
    );
    for (const row of rows) {
      const expected = await actionHash(last.hash, row);
      if (row.seq !== last.seq + 1 || row.prev_hash !== last.hash || row.hash !== expected) {
        return { ok: false, checked, brokenAtSeq: row.seq, anchorSeq, done: true, last };
      }
      last = { seq: row.seq, hash: row.hash };
      checked++;
      after = row.seq;
    }
    if (rows.length < page) break;
  }
  return { ok: true, checked, brokenAtSeq: null, anchorSeq, done: true, last };
}

/** Rows read per page while verifying. */
export const AGENT_LOG_VERIFY_PAGE = 1000;

/** Days a plan keeps its agent log; null = kept. */
export function agentLogRetentionDays(plan: Plan): number | null {
  const days = PLAN_LIMITS[plan].auditRetentionDays;
  return days === null ? null : Math.max(days, AGENT_LOG_MIN_RETENTION_DAYS);
}

const PRUNE_BATCH = 5000;
const DAY_MS = 86_400_000;

/**
 * Daily housekeeping: agent log retention per plan (verify the rows to delete first, never prune
 * a broken chain, move the anchor and delete in one batch, at most 5,000 rows per workspace per
 * run), and the stored bodies of approvals that expired without a decision.
 */
export async function pruneAgentLog(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ pruned: number; refused: string[]; clearedApprovals: number }> {
  // Newly expired approvals (their body still stored): keep the path only masked, as a decided
  // one's is, and clear the body.
  const expiring = await all<{ id: string; path: string }>(
    db,
    `SELECT id, path FROM agent_approvals
      WHERE status = 'pending' AND expires_at <= ?1 AND body_json IS NOT NULL LIMIT 1000`,
    now,
  );
  for (const row of expiring) {
    await run(
      db,
      'UPDATE agent_approvals SET path = ?2, body_json = NULL WHERE id = ?1',
      row.id,
      maskPath(row.path),
    );
  }
  const cleared = await run(
    db,
    `UPDATE agent_approvals SET body_json = NULL
      WHERE status = 'pending' AND expires_at <= ?1 AND body_json IS NOT NULL`,
    now,
  );
  const candidates = await all<{ workspace_id: string; plan: Plan; months: number }>(
    db,
    `SELECT DISTINCT a.workspace_id, w.plan, w.audit_retention_months AS months FROM agent_actions a
       JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.created_at < ?1 LIMIT 200`,
    now - AGENT_LOG_MIN_RETENTION_DAYS * DAY_MS,
  );
  let pruned = 0;
  const refused: string[] = [];
  for (const { workspace_id: workspaceId, plan, months } of candidates) {
    // The plan's period, capped like the audit log by the workspace's own (on every plan), and
    // never under AGENT_LOG_MIN_RETENTION_DAYS.
    const days = agentLogRetentionDays(plan);
    const keepMs = Math.max(
      Math.min(days === null ? Infinity : days * DAY_MS, months * MONTH_MS),
      AGENT_LOG_MIN_RETENTION_DAYS * DAY_MS,
    );
    const before = now - keepMs;
    const anchor = await first<{ seq: number }>(
      db,
      'SELECT seq FROM agent_action_anchors WHERE workspace_id = ?1',
      workspaceId,
    );
    const through = await first<{ seq: number; hash: string; created_at: number }>(
      db,
      `SELECT seq, hash, created_at FROM agent_actions
        WHERE workspace_id = ?1 AND created_at < ?2 AND seq <= ?3
        ORDER BY seq DESC LIMIT 1`,
      workspaceId,
      before,
      (anchor?.seq ?? 0) + PRUNE_BATCH,
    );
    if (!through) continue;
    // Only what this prune deletes, the first kept row (its link and its own hash), and any
    // break the verification cron has recorded: a break further on keeps its evidence, and the
    // check stays bounded. Without that row, an edit inside the range with the hashes recomputed
    // up to the prune point (and the row's prev_hash rewritten to match) would be deleted.
    const check = await verifyAgentLogStep(db, workspaceId, { throughSeq: through.seq + 1 });
    // A first kept row that is not the next seq (a gap) is found by its link.
    const next =
      check.ok && check.last.seq <= through.seq
        ? await first<{ seq: number; prev_hash: string }>(
            db,
            `SELECT seq, prev_hash FROM agent_actions WHERE workspace_id = ?1 AND seq > ?2
            ORDER BY seq LIMIT 1`,
            workspaceId,
            check.last.seq,
          )
        : null;
    const linked = !next || (next.seq === check.last.seq + 1 && next.prev_hash === check.last.hash);
    if (!check.ok || !linked || (await recordedBroken(db, workspaceId, 'agent_actions'))) {
      refused.push(workspaceId);
      continue;
    }
    const [, deleted] = await db.batch([
      db
        .prepare(
          `INSERT INTO agent_action_anchors (workspace_id, seq, hash, pruned_before, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (workspace_id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash,
             pruned_before = excluded.pruned_before, updated_at = excluded.updated_at`,
        )
        .bind(workspaceId, through.seq, through.hash, through.created_at, now),
      db
        .prepare('DELETE FROM agent_actions WHERE workspace_id = ?1 AND seq <= ?2')
        .bind(workspaceId, through.seq),
    ]);
    pruned += deleted?.meta.changes ?? 0;
  }
  return { pruned, refused, clearedApprovals: expiring.length + (cleared.meta.changes ?? 0) };
}

// ---------------------------------------------------------------------------------------------
// Running a tool

export interface ApprovalPolicy {
  mode: ApprovalMode;
  ttlHours: number;
}

export function needsApproval(risk: ToolRisk, policy: ApprovalPolicy): boolean {
  if (policy.mode === 'never' || risk === 'read') return false;
  return policy.mode === 'writes' || risk === 'destructive';
}

export interface DispatchOptions {
  idempotencyKey?: string;
  /** For an approved call: the operator who approved it, a named person taking responsibility. */
  approvedBy?: string;
}

/** What a call would do, for holding it: the tool's risk, raised when its effect is harder. */
export interface CallEffect {
  risk: ToolRisk;
  /** Why a write is held like a destructive call; null when the tool's own risk applies. */
  reason: string | null;
}

export interface OperatorDeps<P extends AgentPrincipal = AgentPrincipal> {
  db: D1Database;
  tools: readonly AgentTool[];
  policy: ApprovalPolicy;
  /** Runs a /v2 request as `principal` through the API's router. */
  dispatch: (principal: P, request: ToolRequest, options: DispatchOptions) => Promise<Response>;
  /**
   * For a write: why this call reaches an effect a held tool has, from the state it acts on (a
   * live Flow that would enrol, a post becoming public), or null. Body-only rules are bodyEffect.
   */
  effectOf?: (principal: P, tool: AgentTool, args: Json) => Promise<string | null>;
  /**
   * For a held call: what it acts on as it is now (a Dispatch's subject, sender, audience and a
   * digest of its send fields), stored on the approval so the approver sees it and approval runs
   * only while it still matches (DecideDeps.targetChanged). Null when there is nothing to bind.
   */
  targetOf?: (principal: P, tool: AgentTool, args: Json) => Promise<Json | null>;
  now?: () => number;
}

export interface AgentCall<P extends AgentPrincipal = AgentPrincipal> {
  principal: P;
  source: AgentSource;
  client: { name: string | null; version: string | null };
  toolName: string;
  arguments: unknown;
  /** The effect as the caller already classified it (classifyCall), so both agree. */
  effect?: CallEffect;
  /** The Copilot request this call is part of, recorded on its log row and approval. */
  copilotRequestId?: string | null;
  /** The client's key for this operation (MCP Idempotency-Key), for writes that run at once. */
  idempotencyKey?: string | null;
}

const isJson = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Why a write reaches an effect a held tool has, from its body alone, or null: update_member
 * can unsubscribe (unsubscribe_member is held) or replace every tag (removing one is held).
 */
export function bodyEffect(operationId: string, body: unknown): string | null {
  if (!isJson(body)) return null;
  if (operationId === 'updateMember') {
    if (body.status !== undefined) return 'It changes the Member’s subscription status.';
    if (body.tags !== undefined) return 'It replaces the Member’s tags.';
  }
  return null;
}

/**
 * The risk a call is held by: a write is raised to destructive when its body (bodyEffect) or the
 * state it acts on (deps.effectOf) reaches what a held tool does. Reads and destructive tools
 * keep their risk. Decided by the server from the call, never from what a model says.
 */
export async function classifyCall<P extends AgentPrincipal>(
  deps: Pick<OperatorDeps<P>, 'effectOf'>,
  principal: P,
  tool: AgentTool,
  args: unknown,
): Promise<CallEffect> {
  if (tool.risk !== 'write' || !isJson(args)) return { risk: tool.risk, reason: null };
  const reason =
    bodyEffect(tool.operationId, args.body) ??
    (deps.effectOf ? await deps.effectOf(principal, tool, args) : null);
  return reason ? { risk: 'destructive', reason } : { risk: 'write', reason: null };
}

export type AgentToolOutcome =
  | { kind: 'unknown_tool'; actionId: string }
  | { kind: 'denied'; actionId: string; scope: ApiScope }
  | {
      kind: 'result';
      actionId: string;
      ok: boolean;
      statusCode: number | null;
      /** The parsed JSON answer (or { error } for a local refusal); null for 204. */
      body: unknown;
    }
  | {
      kind: 'pending_approval';
      actionId: string;
      approvalId: string;
      expiresAt: number;
      /** The request as stored, which is what runs if the call is approved. */
      request: ToolRequest;
      /** The call repeated one that was already waiting: this is that approval. */
      duplicate?: boolean;
    };

interface ParsedResponse {
  status: number;
  body: unknown;
  errorCode: string | null;
}

async function readResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { text: text.slice(0, 2000) };
    }
  }
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return {
    status: response.status,
    body,
    errorCode: typeof error?.code === 'string' ? error.code : null,
  };
}

const localError = (code: string, message: string) => ({ error: { code, message } });

/**
 * The Channel a call acts on: the channelId path argument, or for a workspace-level tool (a
 * webhook endpoint, say) the body's channelId, so its log row and approval are scoped to it.
 */
const channelOf = (args: unknown): string | null => {
  const value = (args as Json | null)?.channelId;
  if (typeof value === 'string') return value;
  const body = (args as Json | null)?.body;
  const inBody =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as Json).channelId : null;
  return typeof inBody === 'string' ? inBody : null;
};

/**
 * Runs one tool call for an agent: checks the scope, holds it for approval when the policy says
 * so, or dispatches it to the /v2 route; then records the call in the agent log.
 */
export async function runAgentTool<P extends AgentPrincipal>(
  deps: OperatorDeps<P>,
  call: AgentCall<P>,
): Promise<AgentToolOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const actionId = newId('agentAction', started);
  const { principal } = call;
  const tool = deps.tools.find((candidate) => candidate.name === call.toolName);
  const masked = maskArguments(call.arguments ?? {});
  let risk: ToolRisk | null = tool?.risk ?? null;
  const record = (
    fields: Pick<AgentActionInput, 'outcome' | 'statusCode' | 'errorCode'> & {
      approvalId?: string | null;
    },
  ) =>
    appendAgentAction(deps.db, {
      id: actionId,
      workspaceId: principal.workspaceId,
      source: call.source,
      principalKind: principal.kind,
      principalId: principal.id,
      clientName: call.client.name,
      clientVersion: call.client.version,
      tool: call.toolName,
      channelId: channelOf(call.arguments),
      risk,
      arguments: masked,
      latencyMs: now() - started,
      approvalId: fields.approvalId ?? null,
      outcome: fields.outcome,
      statusCode: fields.statusCode,
      errorCode: fields.errorCode,
      copilotRequestId: call.copilotRequestId ?? null,
      createdAt: now(),
    });

  if (!tool) {
    await record({ outcome: 'error', statusCode: null, errorCode: 'unknown_tool' });
    return { kind: 'unknown_tool', actionId };
  }
  if (!scopeAllows(principal.scopes, tool.scope)) {
    await record({ outcome: 'denied', statusCode: 403, errorCode: 'insufficient_scope' });
    return { kind: 'denied', actionId, scope: tool.scope };
  }
  const args = call.arguments;
  const built =
    args && typeof args === 'object' && !Array.isArray(args)
      ? toolRequest(tool, args as Json)
      : ({ ok: false, message: 'Arguments must be an object.' } as const);
  if (!built.ok) {
    await record({ outcome: 'error', statusCode: 400, errorCode: 'invalid_input' });
    return {
      kind: 'result',
      actionId,
      ok: false,
      statusCode: 400,
      body: localError('invalid_input', built.message),
    };
  }

  const effect = call.effect ?? (await classifyCall(deps, principal, tool, args));
  risk = effect.risk;
  if (needsApproval(effect.risk, deps.policy)) {
    const refusal = await approvalRefusal(deps.db, principal, channelOf(args), started);
    if (refusal) {
      await record({ outcome: 'error', statusCode: refusal.status, errorCode: refusal.code });
      return {
        kind: 'result',
        actionId,
        ok: false,
        statusCode: refusal.status,
        body: localError(refusal.code, refusal.message),
      };
    }
    const bodyJson = built.request.body === null ? null : JSON.stringify(built.request.body);
    // One intent, one decision: a repeat of a call that is still waiting joins it instead of
    // adding a second approval that could run the same effect again.
    const waiting = await first<{ id: string; expires_at: number }>(
      deps.db,
      `SELECT id, expires_at FROM agent_approvals
        WHERE workspace_id = ?1 AND principal_id = ?2 AND status = 'pending' AND expires_at > ?3
          AND tool = ?4 AND method = ?5 AND path = ?6 AND body_json IS ?7
        ORDER BY created_at LIMIT 1`,
      principal.workspaceId,
      principal.id,
      started,
      tool.name,
      built.request.method,
      built.request.path,
      bodyJson,
    );
    if (waiting) {
      await record({
        outcome: 'pending_approval',
        statusCode: 202,
        errorCode: 'duplicate',
        approvalId: waiting.id,
      });
      return {
        kind: 'pending_approval',
        actionId,
        approvalId: waiting.id,
        expiresAt: waiting.expires_at,
        request: storedRequest({
          method: built.request.method,
          path: built.request.path,
          bodyJson,
        }),
        duplicate: true,
      };
    }
    const approvalId = newId('agentApproval', started);
    const expiresAt = started + deps.policy.ttlHours * 3_600_000;
    const target = deps.targetOf ? await deps.targetOf(principal, tool, args as Json) : null;
    await run(
      deps.db,
      `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id,
         client_name, client_version, tool, scope, risk, channel_id, method, path, body_json,
         arguments_json, status, expires_at, created_at, target_json, hold_reason, copilot_request_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'pending', ?16, ?17,
         ?18, ?19, ?20)`,
      approvalId,
      principal.workspaceId,
      actionId,
      principal.kind,
      principal.id,
      clamp(call.client.name, 100),
      clamp(call.client.version, 100),
      tool.name,
      tool.scope,
      effect.risk,
      channelOf(args),
      built.request.method,
      built.request.path,
      bodyJson,
      JSON.stringify(masked),
      expiresAt,
      started,
      target === null ? null : JSON.stringify(target),
      effect.reason,
      clamp(call.copilotRequestId, 64),
    );
    await record({ outcome: 'pending_approval', statusCode: 202, errorCode: null, approvalId });
    return {
      kind: 'pending_approval',
      actionId,
      approvalId,
      expiresAt,
      request: storedRequest({ method: built.request.method, path: built.request.path, bodyJson }),
    };
  }

  // A client's own operation key lets it retry a write after a lost answer without running it
  // twice (the /v2 idempotency store replays the first answer).
  const response = await readResponse(
    await deps.dispatch(
      principal,
      built.request,
      call.idempotencyKey && tool.risk !== 'read'
        ? { idempotencyKey: `agent-call-${call.idempotencyKey}` }
        : {},
    ),
  );
  const ok = response.status >= 200 && response.status < 300;
  await record({
    outcome: ok ? 'ok' : 'error',
    statusCode: response.status,
    errorCode: response.errorCode,
  });
  return { kind: 'result', actionId, ok, statusCode: response.status, body: response.body };
}

/** Why a call can't be queued now (it would be refused anyway), or null. */
async function approvalRefusal(
  db: D1Database,
  principal: AgentPrincipal,
  channelId: string | null,
  now: number,
): Promise<{ status: number; code: string; message: string } | null> {
  if (channelId !== null) {
    const allowed = !principal.channelIds || principal.channelIds.includes(channelId);
    const row = allowed
      ? await first(
          db,
          'SELECT 1 FROM channels WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL',
          channelId,
          principal.workspaceId,
        )
      : null;
    if (!row) return { status: 404, code: 'not_found', message: 'Publication not found.' };
  }
  const pending = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM agent_approvals
      WHERE principal_id = ?1 AND status = 'pending' AND expires_at > ?2`,
    principal.id,
    now,
  );
  if ((pending?.n ?? 0) >= MAX_PENDING_APPROVALS) {
    return {
      status: 409,
      code: 'conflict',
      message: `This credential already has ${MAX_PENDING_APPROVALS} calls waiting for approval.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Approvals

export interface ApprovalRow {
  id: string;
  workspace_id: string;
  action_id: string;
  principal_kind: AgentPrincipalKind;
  principal_id: string;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  scope: ApiScope;
  risk: ToolRisk;
  channel_id: string | null;
  method: string;
  path: string;
  body_json: string | null;
  arguments_json: string;
  status: 'pending' | 'approved' | 'executed' | 'failed' | 'rejected' | 'canceled';
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  result_status: number | null;
  result_json: string | null;
  executed_action_id: string | null;
  created_at: number;
  /** What the call acts on as it was when held (OperatorDeps.targetOf), as JSON. */
  target_json: string | null;
  hold_reason: string | null;
  copilot_request_id: string | null;
}

/** A held call's request as it is stored (and as approving it would run it). */
export const storedRequest = (row: {
  method: string;
  path: string;
  bodyJson: string | null;
}): ToolRequest => ({
  method: row.method,
  path: row.path,
  body: row.bodyJson === null ? null : (JSON.parse(row.bodyJson) as unknown),
});

/**
 * The digest of a held call's request. Copilot shows the request to the operator with this
 * digest, and the confirmation must carry it back, so a click only ever runs what was shown.
 */
export const approvalRequestDigest = (request: ToolRequest): Promise<string> =>
  sha256Hex(canonicalJson({ method: request.method, path: request.path, body: request.body }));

/** The status shown: a pending row past its expiry reads as expired. */
export const approvalStatus = (row: Pick<ApprovalRow, 'status' | 'expires_at'>, now: number) =>
  row.status === 'pending' && row.expires_at <= now ? ('expired' as const) : row.status;

export async function readApproval(
  db: D1Database,
  workspaceId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  return first<ApprovalRow>(
    db,
    'SELECT * FROM agent_approvals WHERE id = ?1 AND workspace_id = ?2',
    approvalId,
    workspaceId,
  );
}

export interface DecideDeps<P extends AgentPrincipal> {
  db: D1Database;
  /**
   * The credential as it is now, or null when it is revoked, expired or no longer live. Gets the
   * claimed row too, so a Copilot principal can be re-resolved for the call's Channel.
   */
  resolvePrincipal: (kind: AgentPrincipalKind, id: string, row: ApprovalRow) => Promise<P | null>;
  /** Flags and settings as they are now, for this row: null when it may run, else the reason. */
  blockedReason: (row: ApprovalRow) => Promise<string | null>;
  /**
   * Whether what the call acts on changed since it was held (row.target_json): null when it still
   * matches or nothing was bound, else what changed. A changed target runs nothing: the approval
   * was for what the approver saw, and an edit made since needs a decision of its own.
   */
  targetChanged?: (row: ApprovalRow) => Promise<string | null>;
  dispatch: OperatorDeps<P>['dispatch'];
  now?: () => number;
}

export type DecideResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; status: ReturnType<typeof approvalStatus> }
  | { kind: 'decided'; row: ApprovalRow };

/** Rejects a pending approval. The stored body is cleared. */
export async function rejectAgentApproval(
  db: D1Database,
  input: { workspaceId: string; approvalId: string; operatorId: string; reason: string | null },
  now: number = Date.now(),
): Promise<DecideResult> {
  const row = await first<ApprovalRow>(
    db,
    `UPDATE agent_approvals SET status = 'rejected', decided_by = ?3, decided_at = ?4, reason = ?5,
       body_json = NULL
     WHERE id = ?1 AND workspace_id = ?2 AND status = 'pending' AND expires_at > ?4
     RETURNING *`,
    input.approvalId,
    input.workspaceId,
    input.operatorId,
    now,
    input.reason,
  );
  if (!row) return missingOrConflict(db, input, now);
  // Decided: the path is kept for the record, without values it doesn't need.
  const path = maskPath(row.path);
  await run(db, 'UPDATE agent_approvals SET path = ?2 WHERE id = ?1', row.id, path);
  return { kind: 'decided', row: { ...row, path } };
}

async function missingOrConflict(
  db: D1Database,
  input: { workspaceId: string; approvalId: string },
  now: number,
): Promise<DecideResult> {
  const row = await readApproval(db, input.workspaceId, input.approvalId);
  return row ? { kind: 'conflict', status: approvalStatus(row, now) } : { kind: 'not_found' };
}

/**
 * Approves a pending approval and runs its stored request exactly once. The claim is one
 * conditional update; authorisation is checked again now (flags and settings, the credential,
 * its scope and Channel); the request runs with Idempotency-Key agent-approval-<id>. The run is
 * recorded in the agent log (source `approval`) and the row ends executed or failed.
 */
export async function approveAgentApproval<P extends AgentPrincipal>(
  deps: DecideDeps<P>,
  input: { workspaceId: string; approvalId: string; operatorId: string },
): Promise<DecideResult> {
  const now = deps.now ?? Date.now;
  const claimedAt = now();
  const claimed = await first<ApprovalRow>(
    deps.db,
    `UPDATE agent_approvals SET status = 'approved', decided_by = ?3, decided_at = ?4
     WHERE id = ?1 AND workspace_id = ?2 AND status = 'pending' AND expires_at > ?4
     RETURNING *`,
    input.approvalId,
    input.workspaceId,
    input.operatorId,
    claimedAt,
  );
  if (!claimed) return missingOrConflict(deps.db, input, claimedAt);
  // Without `resolving` a run always ends decided.
  const result = await runClaimed(deps, claimed, input.operatorId, claimedAt);
  return { kind: 'decided', row: result.row };
}

/** An approved row is left without a result this long before it counts as interrupted. */
export const APPROVAL_STUCK_MS = 10 * 60 * 1000;
/** The /v2 idempotency store keeps an answer this long, so an interrupted run can be checked. */
const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

export type ResolveResult =
  | DecideResult
  | { kind: 'too_soon' }
  | { kind: 'too_old' }
  /** The first run still holds its idempotency claim: it may be running or may have died. */
  | { kind: 'still_unknown'; row: ApprovalRow };

/**
 * Finds out what happened to an approved call whose run was interrupted (status approved, no
 * result, claimed at least APPROVAL_STUCK_MS ago) and finishes the row. It sends the stored
 * request again under the same Idempotency-Key (agent-approval-<id>), so the /v2 store answers
 * for the first attempt: a stored answer is replayed (the effect happened once, and is recorded
 * with `replayed`), a claim still held answers `still_unknown` and runs nothing, and only a
 * request that never reached the route (or failed with a server error, which the store does not
 * keep) runs now. Authorisation and the target are checked again, as on approval. Not possible
 * once the store has forgotten the key (24 hours): the row stays Outcome unknown for a person to
 * check by hand.
 */
export async function resolveAgentApproval<P extends AgentPrincipal>(
  deps: DecideDeps<P>,
  input: { workspaceId: string; approvalId: string; operatorId: string },
): Promise<ResolveResult> {
  const now = deps.now ?? Date.now;
  const at = now();
  const row = await readApproval(deps.db, input.workspaceId, input.approvalId);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'approved' || row.result_status !== null || row.result_json !== null) {
    return { kind: 'conflict', status: approvalStatus(row, at) };
  }
  if ((row.decided_at ?? 0) > at - APPROVAL_STUCK_MS) return { kind: 'too_soon' };
  if ((row.decided_at ?? 0) <= at - IDEMPOTENCY_WINDOW_MS) return { kind: 'too_old' };
  // Re-claimed by moving decided_at, so two people resolving at once run it at most once. The
  // first decider stays recorded; the one who resolved is in the audit log.
  const claimed = await first<ApprovalRow>(
    deps.db,
    `UPDATE agent_approvals SET decided_at = ?3
      WHERE id = ?1 AND workspace_id = ?2 AND status = 'approved' AND result_status IS NULL
        AND result_json IS NULL AND decided_at = ?4
     RETURNING *`,
    row.id,
    row.workspace_id,
    at,
    row.decided_at,
  );
  if (!claimed) return { kind: 'conflict', status: 'approved' };
  return runClaimed(deps, claimed, input.operatorId, at, { resolving: true });
}

/** Runs a claimed approval once and records its outcome (approve and resolve share it). */
async function runClaimed<P extends AgentPrincipal>(
  deps: DecideDeps<P>,
  claimed: ApprovalRow,
  operatorId: string,
  claimedAt: number,
  options: { resolving?: boolean } = {},
): Promise<Extract<ResolveResult, { kind: 'decided' | 'still_unknown' }>> {
  const now = deps.now ?? Date.now;
  // The person who approved it takes responsibility for it, also when someone else resolves it.
  const approvedBy = claimed.decided_by ?? operatorId;

  const blocked = await deps.blockedReason(claimed);
  const principal = blocked
    ? null
    : await deps.resolvePrincipal(claimed.principal_kind, claimed.principal_id, claimed);
  const changed =
    blocked || !principal || !deps.targetChanged ? null : await deps.targetChanged(claimed);
  const refusal = blocked
    ? { code: 'feature_disabled', message: blocked }
    : changed
      ? { code: 'conflict', message: changed }
      : !principal || principal.workspaceId !== claimed.workspace_id
        ? {
            code: 'unauthorized',
            message:
              claimed.principal_kind === 'copilot'
                ? 'The teammate who asked Copilot can no longer do this.'
                : 'The API key or OAuth grant is no longer valid.',
          }
        : !scopeAllows(principal.scopes, claimed.scope)
          ? {
              code: 'insufficient_scope',
              message: `The credential no longer has ${claimed.scope}.`,
            }
          : claimed.channel_id !== null &&
              principal.channelIds !== null &&
              !principal.channelIds.includes(claimed.channel_id)
            ? { code: 'not_found', message: 'The credential can no longer reach this publication.' }
            : null;

  let statusCode: number | null = null;
  let errorCode: string | null = null;
  let summary: unknown;
  if (refusal || !principal) {
    errorCode = refusal?.code ?? 'unauthorized';
    summary = { error: refusal ?? { code: 'unauthorized' } };
  } else {
    const raw = await deps.dispatch(
      principal,
      storedRequest({ method: claimed.method, path: claimed.path, bodyJson: claimed.body_json }),
      { idempotencyKey: `agent-approval-${claimed.id}`, approvedBy },
    );
    const replayed = raw.headers.get('idempotent-replayed') === 'true';
    const response = await readResponse(raw);
    const message = (response.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (
      options.resolving &&
      response.status === 409 &&
      typeof message === 'string' &&
      /Idempotency-Key is still running|already ran/.test(message)
    ) {
      // The first attempt's claim is still there: it ran or is running, and nothing tells us its
      // answer. Nothing runs now; the row stays Outcome unknown for a person to check.
      const row = await first<ApprovalRow>(
        deps.db,
        `UPDATE agent_approvals SET reason = ?2 WHERE id = ?1 RETURNING *`,
        claimed.id,
        'Checked: the first run started and left no answer. It may have taken effect; check the target before asking again.',
      );
      return { kind: 'still_unknown', row: row ?? claimed };
    }
    statusCode = response.status;
    errorCode = response.errorCode;
    summary = replayed
      ? { replayed: true, answer: maskArguments(response.body) }
      : maskArguments(response.body);
  }
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const actionId = await appendAgentAction(deps.db, {
    workspaceId: claimed.workspace_id,
    source: 'approval',
    principalKind: claimed.principal_kind,
    principalId: claimed.principal_id,
    clientName: claimed.client_name,
    clientVersion: claimed.client_version,
    tool: claimed.tool,
    channelId: claimed.channel_id,
    risk: claimed.risk,
    arguments: JSON.parse(claimed.arguments_json) as unknown,
    outcome: ok ? 'ok' : refusal ? 'denied' : 'error',
    statusCode,
    errorCode,
    latencyMs: now() - claimedAt,
    approvalId: claimed.id,
    copilotRequestId: claimed.copilot_request_id,
    createdAt: now(),
  });
  const row = await first<ApprovalRow>(
    deps.db,
    `UPDATE agent_approvals SET status = ?2, result_status = ?3, result_json = ?4,
       executed_action_id = ?5, reason = ?6, body_json = NULL, path = ?7
     WHERE id = ?1 RETURNING *`,
    claimed.id,
    ok ? 'executed' : 'failed',
    statusCode,
    JSON.stringify(summary ?? null),
    actionId,
    refusal?.message ??
      (statusCode !== null && statusCode >= 500
        ? 'The API answered with a server error: part of the effect may have happened. Check the target before asking again.'
        : null),
    maskPath(claimed.path),
  );
  return { kind: 'decided', row: row ?? claimed };
}

/** For get_agent_approval: an approval created by this credential, as the agent sees it. */
export async function approvalForPrincipal(
  db: D1Database,
  principal: AgentPrincipal,
  approvalId: string,
  now: number = Date.now(),
): Promise<Json | null> {
  const row = await first<ApprovalRow>(
    db,
    'SELECT * FROM agent_approvals WHERE id = ?1 AND workspace_id = ?2 AND principal_id = ?3',
    approvalId,
    principal.workspaceId,
    principal.id,
  );
  if (!row) return null;
  return {
    approvalId: row.id,
    tool: row.tool,
    status: approvalStatus(row, now),
    expiresAt: new Date(row.expires_at).toISOString(),
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    reason: row.reason,
    result:
      row.result_json === null
        ? null
        : { statusCode: row.result_status, summary: JSON.parse(row.result_json) as unknown },
  };
}
