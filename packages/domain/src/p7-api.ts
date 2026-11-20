// Phase 7, Open API workstream: scoped API keys (Settings → Developers), CIDR allowlists, the
// rate-limit policy, Idempotency-Key, the /v2 request and response shapes that are not already
// in the dashboard schemas, import sources (the migration shim) and the audit log export.
// Shared constants (plans, scopes, key formats) are in p7-platform.ts.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { FieldKeySchema, FieldValueSchema, TagNameSchema } from './audience';
import { ChannelSchema, EmailSchema } from './schemas';
import { API_EVENT_NAME } from './p6-flows';
import { ApiScopeSchema, PLAN_LIMITS, type Plan } from './p7-platform';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// IP addresses and CIDR ranges (IPv4 and IPv6), for key allowlists

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  let input = text.toLowerCase();
  // A trailing dotted quad (::ffff:192.0.2.1) is two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(input);
  if (dotted) {
    const v4 = parseIpv4(dotted[2]!);
    if (v4 === null) return null;
    input = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** An IPv4 or IPv6 address; an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is read as IPv4. */
export function parseIp(text: string): ParsedIp | null {
  const value = text.trim();
  if (value.includes(':')) {
    const v6 = parseIpv6(value);
    if (v6 === null) return null;
    if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
  }
  const v4 = parseIpv4(value);
  return v4 === null ? null : { version: 4, value: v4 };
}

interface ParsedCidr {
  version: 4 | 6;
  base: bigint;
  bits: number;
}

/** `a.b.c.d/n`, `x:x::/n`, or a bare address (one host). Host bits must be zero. */
export function parseCidr(text: string): ParsedCidr | null {
  const [address = '', prefix, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  // A mapped address written as IPv6 keeps its IPv6 prefix length meaning.
  const width = ip.version === 4 ? 32 : 128;
  let bits = width;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    bits = Number(prefix);
    if (ip.version === 4 && address.includes(':')) bits -= 96;
    if (bits < 0 || bits > width) return null;
  }
  const hostMask = (1n << BigInt(width - bits)) - 1n;
  if ((ip.value & hostMask) !== 0n) return null;
  return { version: ip.version, base: ip.value, bits };
}

function formatIp(version: 4 | 6, value: bigint): string {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
  }
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt(16 * (7 - i))) & 0xffffn).toString(16),
  );
  // Compress the longest run of zero groups (RFC 5952).
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.length && j - i > 1) best = { start: i, length: j - i };
    i = j;
  }
  if (best.start < 0) return groups.join(':');
  const left = groups.slice(0, best.start).join(':');
  const right = groups.slice(best.start + best.length).join(':');
  return `${left}::${right}`;
}

/** The canonical spelling of a valid range (`192.0.2.0/24`, `2001:db8::/32`). */
export function normalizeCidr(text: string): string | null {
  const cidr = parseCidr(text);
  return cidr ? `${formatIp(cidr.version, cidr.base)}/${cidr.bits}` : null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const address = parseIp(ip);
  const range = parseCidr(cidr);
  if (!address || !range || address.version !== range.version) return false;
  const width = range.version === 4 ? 32 : 128;
  return address.value >> BigInt(width - range.bits) === range.base >> BigInt(width - range.bits);
}

export const CidrSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => parseCidr(value) !== null, 'Use an IPv4 or IPv6 address or CIDR range.')
  .transform((value) => normalizeCidr(value) as string)
  .openapi({ example: '203.0.113.0/24' });

// ---------------------------------------------------------------------------------------------
// Scoped API keys

/** Ranges per key. */
const API_KEY_MAX_ALLOWLIST = 20;
/** The longest expiry a key can be given. */
export const API_KEY_MAX_EXPIRY_DAYS = 730;
/** last_used_at is written at most this often per key, not on every request. */
export const API_KEY_LAST_USED_INTERVAL_MS = 60_000;

/** `suspended`: the admin who stands behind it (its creator, or whoever last changed it) no
 *  longer has the admin role here, so it is refused until an admin changes it or revokes it. */
const API_KEY_STATUSES = ['active', 'suspended', 'expired', 'revoked'] as const;
/**
 * Where a key works: `mcp` only on the MCP server, where approval holds apply (for agents);
 * `both` also on /v2 directly, where nothing is held (for integrations, a deliberate choice).
 */
const API_KEY_SURFACES = ['both', 'mcp'] as const;
export type ApiKeySurface = (typeof API_KEY_SURFACES)[number];
const ApiKeySurfaceSchema = z.enum(API_KEY_SURFACES).openapi('ApiKeySurface');
export const ApiKeySchema = z
  .object({
    id: id('apiKey'),
    workspaceId: id('workspace'),
    name: z.string(),
    /** The 8 characters after sk_live_, to recognise a key; the secret is never shown again. */
    prefix: z.string(),
    scopes: z.array(ApiScopeSchema),
    /** null = every Channel of the workspace. */
    channelIds: z.array(id('channel')).nullable(),
    /** null = any address. */
    ipAllowlist: z.array(z.string()).nullable(),
    /** Requests per minute; null = the plan's limit. */
    rateCap: z.number().int().nullable(),
    surface: ApiKeySurfaceSchema,
    status: z.enum(API_KEY_STATUSES),
    expiresAt: timestamp.nullable(),
    lastUsedAt: timestamp.nullable(),
    /** The caller's network (IPv4 /24, IPv6 /48), never the full address. */
    lastUsedIpPrefix: z.string().nullable(),
    createdBy: z.object({ id: z.string(), email: z.string() }).nullable(),
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .openapi('ApiKey');
export type ApiKey = z.infer<typeof ApiKeySchema>;

const scopeList = z
  .array(ApiScopeSchema)
  .min(1, 'Pick at least one scope.')
  .max(50)
  .transform((scopes) => [...new Set(scopes)]);
const channelList = z
  .array(id('channel'))
  .min(1, 'Pick at least one publication, or allow every publication.')
  .max(100)
  .transform((ids) => [...new Set(ids)]);
const allowlist = z
  .array(CidrSchema)
  .min(1, 'Add at least one address, or allow any address.')
  .max(API_KEY_MAX_ALLOWLIST, `Up to ${API_KEY_MAX_ALLOWLIST} ranges.`)
  .transform((ranges) => [...new Set(ranges)]);

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1, 'Name the key.').max(80),
    scopes: scopeList,
    channelIds: channelList.nullable().optional(),
    ipAllowlist: allowlist.nullable().optional(),
    rateCap: z.number().int().min(1).nullable().optional(),
    expiresAt: timestamp.nullable().optional(),
    /** Defaults to `both` for API clients; the dashboard asks which. */
    surface: ApiKeySurfaceSchema.optional(),
  })
  .openapi('CreateApiKey');
export type CreateApiKey = z.input<typeof CreateApiKeySchema>;

export const UpdateApiKeySchema = z
  .object({
    name: z.string().trim().min(1, 'Name the key.').max(80).optional(),
    scopes: scopeList.optional(),
    channelIds: channelList.nullable().optional(),
    ipAllowlist: allowlist.nullable().optional(),
    rateCap: z.number().int().min(1).nullable().optional(),
    surface: ApiKeySurfaceSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateApiKey');
export const CreatedApiKeySchema = z
  .object({
    key: ApiKeySchema,
    /** The full secret (sk_live_…). Shown once: only its hash is stored. */
    secret: z.string(),
  })
  .openapi('CreatedApiKey');
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

// ---------------------------------------------------------------------------------------------
// Rate limits and idempotency

interface ApiRatePolicy {
  /** Steady requests per minute. */
  perMinute: number;
  /** Extra requests the bucket holds above the steady rate. */
  burst: number;
  /** Bucket size: perMinute + burst. Reported as RateLimit-Limit. */
  capacity: number;
}

/**
 * The token bucket for a principal: refills at min(plan rate, key cap) per minute and holds that
 * plus a burst. A key cap scales the burst by the same ratio, so a low cap is not undone by the
 * plan's full burst.
 */
export function apiRatePolicy(plan: Plan, rateCap: number | null): ApiRatePolicy {
  const limits = PLAN_LIMITS[plan];
  const perMinute = Math.max(1, Math.min(limits.requestsPerMinute, rateCap ?? Infinity));
  const burst = Math.round((limits.burst * perMinute) / limits.requestsPerMinute);
  return { perMinute, burst, capacity: perMinute + burst };
}

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_TTL_HOURS = 24;
/** 1 to 255 visible ASCII characters (a UUID is typical). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

// ---------------------------------------------------------------------------------------------
// Import sources: the migration shim (decision D2, import only)

/**
 * Where an import file comes from. `csv` is any CSV (mapped by header names). The two others
 * read exports of other newsletter platforms: their column names map onto Swarm fields, and
 * people who had unsubscribed or whose email was turned off there are not imported (counted as
 * suppressed in the dry run). JSON is turned into a CSV on upload.
 */
export const IMPORT_SOURCES = ['csv', 'platform_csv', 'platform_json'] as const;
export const ImportSourceSchema = z.enum(IMPORT_SOURCES).openapi('ImportSource');
export type ImportSource = z.infer<typeof ImportSourceSchema>;

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  csv: 'CSV file',
  platform_csv: 'Another newsletter platform (CSV)',
  platform_json: 'Another newsletter platform (JSON)',
};

/** JSON exports are parsed in one piece, so they are smaller than CSV uploads. */
export const IMPORT_JSON_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Audit log export

const AUDIT_EXPORT_FORMATS = ['csv', 'jsonl'] as const;
export const AuditExportSchema = z
  .object({
    format: z.enum(AUDIT_EXPORT_FORMATS).default('csv'),
    from: timestamp.optional().openapi({ description: 'Events at or after this time' }),
    to: timestamp.optional().openapi({ description: 'Events before this time' }),
  })
  .openapi('AuditExport');
/** Rows per export file; narrow the range for more. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

// ---------------------------------------------------------------------------------------------
// /v2 shapes. Resources reuse the dashboard schemas (MemberSchema, DispatchSummarySchema, …) so
// webhooks and the API send the same shapes; these are the few the dashboard has no use for.

/** A Channel as an API client sees it: no seat role (keys and apps have scopes instead). */
export const ApiChannelSchema = ChannelSchema.omit({ role: true }).openapi('ApiChannel');
export type ApiChannel = z.infer<typeof ApiChannelSchema>;

export const ApiMemberLookupQuerySchema = z.object({
  email: EmailSchema.openapi({ param: { name: 'email', in: 'query' } }),
});

/** POST /v2/channels/{channelId}/members: create, or with `upsert` update an existing one. */
export const ApiUpsertMemberSchema = z
  .object({
    email: EmailSchema,
    firstName: z.string().trim().max(80).nullable().optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    /** The person asked to receive this Channel: they start active, otherwise pending. */
    consent: z.boolean().optional(),
    /** Tags to add (created when missing). On update they are added to the Member's tags. */
    tags: z.array(TagNameSchema).max(50).optional(),
    fields: z.record(FieldKeySchema, FieldValueSchema).optional(),
    /** Update the Member when the address is already one instead of answering 409. */
    upsert: z.boolean().default(false),
  })
  .openapi('ApiUpsertMember');

export const ApiTagsSchema = z
  .object({ tags: z.array(TagNameSchema).min(1).max(50) })
  .openapi('ApiTags');

export const ApiFieldValuesSchema = z
  .object({ fields: z.record(FieldKeySchema, FieldValueSchema) })
  .refine((value) => Object.keys(value.fields).length > 0, 'Set at least one field.')
  .openapi('ApiFieldValues');

/** One Member of a bulk upsert. */
const ApiBulkMemberSchema = z.object({
  email: z.string().max(254),
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  fields: z.record(FieldKeySchema, z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const API_BULK_MAX_MEMBERS = 10_000;

/**
 * POST /v2/channels/{channelId}/members/bulk: becomes an import job (dry run first, then
 * confirm). `members` in Swarm's shape, or `records` exported from another platform.
 */
export const ApiBulkUpsertSchema = z
  .object({
    source: z.enum(['swarm', 'platform_csv', 'platform_json']).default('swarm'),
    members: z.array(ApiBulkMemberSchema).min(1).max(API_BULK_MAX_MEMBERS).optional(),
    /** platform_json: the export's subscription objects, as they are. */
    records: z.array(z.record(z.string(), z.unknown())).min(1).max(API_BULK_MAX_MEMBERS).optional(),
    /** platform_csv: the export file's text. */
    csv: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024)
      .optional(),
    consentAttested: z.boolean(),
    updateExisting: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const need = { swarm: 'members', platform_json: 'records', platform_csv: 'csv' } as const;
    const key = need[value.source];
    if (value[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: `Send ${key} with this source.` });
    }
  })
  .openapi('ApiBulkUpsert');
export const ApiCircleCountSchema = z
  .object({
    circleId: id('circle'),
    /** Members matching the rule now, evaluated live. */
    count: z.number().int(),
    activeCount: z.number().int(),
  })
  .openapi('ApiCircleCount');

export const ApiTestSendSchema = z
  .object({
    /** Teammate addresses of this workspace. */
    to: z.array(EmailSchema).min(1).max(5),
    memberId: id('member').optional(),
    variant: z.enum(['full', 'teaser']).optional(),
  })
  .openapi('ApiTestSend');

export const ApiPreviewRequestSchema = z
  .object({
    /** Personalise as this Member would see it; merge tags show their fallbacks otherwise. */
    memberId: id('member').optional(),
    variant: z.enum(['full', 'teaser']).optional(),
  })
  .openapi('ApiPreviewRequest');

export const ApiPreviewSchema = z
  .object({
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    warnings: z.array(z.string()),
  })
  .openapi('ApiPreview');

export const ApiEnrolSchema = z.object({ memberId: id('member') }).openapi('ApiEnrol');

export const ApiMemberEventSchema = z
  .object({
    /** Matched by Flows whose trigger is an API event with this name. */
    name: z.string().regex(API_EVENT_NAME, 'Lowercase letters, digits, . and _, 1 to 60.'),
    properties: z
      .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
      .refine((value) => Object.keys(value).length <= 20, 'Up to 20 properties.')
      .optional(),
  })
  .openapi('ApiMemberEvent');

export const ApiAcceptedSchema = z.object({ accepted: z.literal(true) }).openapi('ApiAccepted');
