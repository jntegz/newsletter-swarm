// Open Operator (Phase 8.11): MCP server over /v2 and the agent audit log, flags open_operator_mcp and copilot_actions.
// Tables: migrations/0023_open_operator.sql. Docs: docs/open-operator.md.
import { z } from '@hono/zod-openapi';
import { CursorQuerySchema } from './http';
import { chainPageShape } from './schemas';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });

// ---------------------------------------------------------------------------------------------
// The MCP endpoint

export const MCP_PATH = '/mcp';
/** RFC 9728 metadata for the /mcp resource (path-inserted form) and the origin-wide one. */
export const MCP_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
export const ROOT_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** The current, stateless revision: version and client identity ride on every request. */
export const MCP_MODERN_VERSION = '2026-07-28';
/** Handshake-based revisions answered through `initialize` (newest first). */
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export const MCP_PROTOCOL_VERSIONS = [MCP_MODERN_VERSION, ...MCP_LEGACY_VERSIONS] as const;
/** A request without MCP-Protocol-Version is treated as this revision (Streamable HTTP rules). */
export const MCP_ASSUMED_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = 'swarm-open-operator';
export const MCP_MAX_BODY_BYTES = 1_000_000;

/** JSON-RPC and MCP error codes the endpoint uses. Application codes avoid -32768..-32000. */
export const MCP_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
  unauthorized: -31001,
  forbidden: -31003,
  featureDisabled: -31004,
  rateLimited: -31029,
} as const;

/** The server's own tool, beside the tools derived from /v2. */
export const APPROVAL_STATUS_TOOL = 'get_agent_approval';

/**
 * /v2 operations that destroy, send or change many things at once, by operationId. Every DELETE
 * is destructive too. They carry destructiveHint and are held for approval in `destructive` mode.
 * Feed sources can schedule and send posts on their own, and webhook endpoints receive subscriber
 * data, so creating or repointing either is held as well. Adding a Member starts mail to a person
 * (and Flows that start on joining), and an API event starts the Flows that wait for it, the
 * same effect as enrolInFlow, so both are held too.
 */
export const DESTRUCTIVE_OPERATIONS = [
  'scheduleDispatch',
  'createDirectSend',
  'unsubscribeMember',
  'bulkUpsertMembers',
  'confirmImport',
  'enrolInFlow',
  'rotateWebhookSecret',
  'redriveWebhookDeliveries',
  'createFeedSource',
  'updateFeedSource',
  'createWebhookEndpoint',
  'updateWebhookEndpoint',
  'createMember',
  'sendMemberEvent',
] as const;

/**
 * Write operations that are held like destructive ones when a call reaches the same kind of
 * effect, decided per call from its body and the state it acts on (classifyCall in
 * @swarm/engine): what is held follows the effect, not the method. The note is added to the
 * tool's description, and these tools carry destructiveHint.
 */
export const CONDITIONAL_HOLD_OPERATIONS = {
  updateMember:
    'Held like a destructive call when it changes the Member’s status or replaces their tags, or sets fields while a live Flow of the Channel starts on a field change.',
  updateDispatch:
    'Held like a destructive call when it widens who can read the post on the website (webVisibility towards public).',
  addMemberTags:
    'Held like a destructive call while a live Flow of the Channel starts on a tag being added.',
  setMemberFields:
    'Held like a destructive call while a live Flow of the Channel starts on a field change.',
  subscribeRosterMember:
    'Held like a destructive call while a live Flow of the Channel starts on joining a Roster.',
} as const satisfies Record<string, string>;

/**
 * Operations whose effect reaches outside Swarm: they send email (now or as a consequence), call
 * a webhook endpoint or fetch a URL. They carry openWorldHint, and Copilot asks before running one
 * even on the first turn.
 */
export const OPEN_WORLD_OPERATIONS = [
  'scheduleDispatch',
  'createDirectSend',
  'sendDispatchTest',
  'createMember',
  'enrolInFlow',
  'sendMemberEvent',
  'createWebhookEndpoint',
  'updateWebhookEndpoint',
  'sendWebhookTest',
  'redriveWebhookDelivery',
  'redriveWebhookDeliveries',
  'createFeedSource',
  'updateFeedSource',
  'checkFeedSource',
] as const;

// ---------------------------------------------------------------------------------------------
// Settings

const APPROVAL_MODES = ['never', 'destructive', 'writes'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
const ApprovalModeSchema = z.enum(APPROVAL_MODES).openapi('AgentApprovalMode');

export const APPROVAL_TTL_HOURS = { min: 1, max: 72, default: 24 } as const;
/** Pending approvals one credential may have at once. */
export const MAX_PENDING_APPROVALS = 50;
/** The agent log is kept at least this long on every plan. */
export const AGENT_LOG_MIN_RETENTION_DAYS = 90;

/** Minutes a credential's writes are held after it read text from outside the workspace. */
const EXPOSED_HOLD_MINUTES = { min: 0, max: 1440 } as const;

const COPILOT_MEMBER_DETAILS = ['masked', 'full'] as const;
export type CopilotMemberDetail = (typeof COPILOT_MEMBER_DETAILS)[number];

export const AGENT_SETTINGS_DEFAULTS = {
  mcpEnabled: true,
  approvalMode: 'destructive' as ApprovalMode,
  approvalTtlHours: APPROVAL_TTL_HOURS.default,
  /** Off by default so a workspace with one admin can still approve its agents' calls. */
  separateApprover: false,
  /** Off by default (0); see docs/open-operator.md "Text from outside the workspace". */
  exposedHoldMinutes: 0,
  copilotMemberDetail: 'masked' as CopilotMemberDetail,
};

/**
 * /v2 read operations whose answers carry text written by people outside the workspace: Member
 * names, field values and leaving reasons (typed into public forms and the Member Center), and
 * titles and links taken from feeds. The MCP server labels these results, and the workspace can
 * hold a credential's writes for a while after it read one (exposedHoldMinutes).
 */
export const THIRD_PARTY_TEXT_OPERATIONS = {
  getMember: ['firstName', 'lastName', 'fields', 'unsubscribeReason', 'source', 'consent'],
  lookupMember: ['firstName', 'lastName', 'fields', 'unsubscribeReason', 'source', 'consent'],
  listMembers: ['firstName', 'lastName'],
  listRosterMembers: ['firstName', 'lastName'],
  listFeedItems: ['title', 'link'],
  listFeedSources: ['title'],
  getFeedSource: ['title'],
  checkFeedSource: ['source.title'],
} as const satisfies Record<string, readonly string[]>;

export const AgentSettingsSchema = z
  .object({
    mcpEnabled: z.boolean(),
    approvalMode: ApprovalModeSchema,
    approvalTtlHours: z.number().int(),
    /** The person who caused a held call can't approve it; another admin must. */
    separateApprover: z.boolean(),
    /** Hold a credential's writes this many minutes after it read text from outside (0 = off). */
    exposedHoldMinutes: z.number().int(),
    /** What Copilot's model sees of Members: masked (default) or full. */
    copilotMemberDetail: z.enum(COPILOT_MEMBER_DETAILS),
    /** Flags in effect for the workspace, so the page can explain what is off. */
    flags: z.object({ openOperatorMcp: z.boolean(), copilotActions: z.boolean() }),
    mcpUrl: z.string(),
    pendingApprovals: z.number().int(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('AgentSettings');
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const UpdateAgentSettingsSchema = z
  .object({
    mcpEnabled: z.boolean().optional(),
    approvalMode: ApprovalModeSchema.optional(),
    approvalTtlHours: z
      .number()
      .int()
      .min(APPROVAL_TTL_HOURS.min)
      .max(APPROVAL_TTL_HOURS.max)
      .optional(),
    separateApprover: z.boolean().optional(),
    exposedHoldMinutes: z
      .number()
      .int()
      .min(EXPOSED_HOLD_MINUTES.min)
      .max(EXPOSED_HOLD_MINUTES.max)
      .optional(),
    copilotMemberDetail: z.enum(COPILOT_MEMBER_DETAILS).optional(),
  })
  .openapi('UpdateAgentSettings');
export type UpdateAgentSettings = z.infer<typeof UpdateAgentSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// The agent audit log

/** `copilot`: an operator acting through Copilot actions (the id is the operator's). */
const AGENT_PRINCIPAL_KINDS = ['key', 'oauth', 'copilot'] as const;
export type AgentPrincipalKind = (typeof AGENT_PRINCIPAL_KINDS)[number];
const AGENT_SOURCES = ['mcp', 'approval', 'copilot'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];
const TOOL_RISKS = ['read', 'write', 'destructive'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];
const AGENT_OUTCOMES = ['ok', 'error', 'denied', 'pending_approval'] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

const CredentialSchema = z
  .object({
    kind: z.enum(AGENT_PRINCIPAL_KINDS),
    id: z.string(),
    /**
     * The key's name and prefix, the OAuth app's name, or the operator's address for Copilot;
     * null when it was deleted.
     */
    label: z.string().nullable(),
  })
  .openapi('AgentCredential');

export const AgentActionSchema = z
  .object({
    id: z.string().regex(idPattern('agentAction')),
    seq: z.number().int(),
    source: z.enum(AGENT_SOURCES),
    credential: CredentialSchema,
    client: z.object({ name: z.string().nullable(), version: z.string().nullable() }),
    tool: z.string(),
    channelId: z.string().nullable(),
    risk: z.enum(TOOL_RISKS).nullable(),
    arguments: z.unknown().openapi({ description: 'Masked summary of the arguments' }),
    outcome: z.enum(AGENT_OUTCOMES),
    statusCode: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    latencyMs: z.number().int(),
    approvalId: z.string().nullable(),
    /** The Copilot request (copilot_requests id) this call was part of. */
    copilotRequestId: z.string().nullable(),
    createdAt: timestamp,
  })
  .openapi('AgentAction');
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentActionsQuerySchema = CursorQuerySchema.extend({
  outcome: z.enum(AGENT_OUTCOMES).optional(),
  tool: z.string().max(128).optional(),
  principalId: z.string().max(64).optional(),
});

export const AgentLogVerificationSchema = z
  .object({
    ok: z.boolean(),
    checked: z.number().int(),
    brokenAtSeq: z.number().int().nullable(),
    anchorSeq: z.number().int().nullable(),
    ...chainPageShape,
  })
  .openapi('AgentLogVerification');

// ---------------------------------------------------------------------------------------------
// Approvals

/**
 * What a held call acts on, as the server looked it up when the call was held: for a Dispatch its
 * subject, preheader, status, web visibility, sender, audience definition and a digest of its send
 * fields; for a Member only its id and status; for a feed source its URL, mode and status.
 */
export const AgentTargetSchema = z
  .object({ type: z.string(), id: z.string() })
  .catchall(z.unknown())
  .openapi('AgentTarget');
export type AgentTarget = z.infer<typeof AgentTargetSchema>;

/** Stored statuses; `expired` is computed from a pending row past expires_at. */
const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'executed',
  'failed',
  'rejected',
  'canceled',
  'expired',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AgentApprovalSchema = z
  .object({
    id: z.string().regex(idPattern('agentApproval')),
    status: z.enum(APPROVAL_STATUSES),
    tool: z.string(),
    risk: z.enum(TOOL_RISKS),
    channelId: z.string().nullable(),
    credential: CredentialSchema,
    /** Self-reported by the client (MCP clientInfo or User-Agent): a claim, never verified. */
    client: z.object({ name: z.string().nullable(), version: z.string().nullable() }),
    arguments: z.unknown().openapi({ description: 'Masked summary of the arguments' }),
    /** The exact request that runs on approval; null once decided, expired or erased. */
    request: z
      .object({ method: z.string(), path: z.string(), body: z.unknown().nullable() })
      .nullable(),
    actionId: z.string(),
    /** What the call acts on, as the server looked it up when it was held. */
    target: AgentTargetSchema.nullable(),
    /**
     * Only on a single approval while pending: what changed in the target since it was held
     * (approving then runs nothing), or null.
     */
    targetChanged: z.string().nullable(),
    /** Why a write was held like a destructive call (its body or the target's state). */
    holdReason: z.string().nullable(),
    /** The Copilot request that proposed it, for a call Copilot held. */
    copilotRequestId: z.string().nullable(),
    expiresAt: timestamp,
    decidedBy: z.object({ id: z.string(), email: z.string() }).nullable(),
    decidedAt: timestamp.nullable(),
    reason: z.string().nullable(),
    result: z.object({ statusCode: z.number().int().nullable(), summary: z.unknown() }).nullable(),
    createdAt: timestamp,
  })
  .openapi('AgentApproval');
export type AgentApproval = z.infer<typeof AgentApprovalSchema>;

export const AgentApprovalsQuerySchema = CursorQuerySchema.extend({
  status: z.enum([...APPROVAL_STATUSES, 'all']).default('pending'),
});

export const RejectAgentApprovalSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .openapi('RejectAgentApproval');

// ---------------------------------------------------------------------------------------------
// Publication context (the agent context pack)

/** How many recent sent posts an agent is shown. */
export const CHANNEL_CONTEXT_DISPATCHES = 10;

const ChannelContextDispatchSchema = z
  .object({
    id: z.string().regex(idPattern('dispatch')),
    subject: z.string(),
    sentAt: timestamp.nullable(),
    recipientCount: z.number().int(),
    humanOpens: z
      .number()
      .int()
      .openapi({ description: 'Opens privacy proxies and scanners did not count' }),
    humanClicks: z.number().int(),
    openRate: z.number().min(0).max(1),
    clickRate: z.number().min(0).max(1),
    webUrl: z
      .string()
      .nullable()
      .openapi({ description: 'The page on the website, when it has one' }),
  })
  .openapi('ChannelContextDispatch');
export const ChannelContextSchema = z
  .object({
    publication: z.object({
      name: z.string(),
      description: z.string().nullable(),
      slug: z.string(),
      createdAt: timestamp,
    }),
    /** The operator's style guide, verbatim; empty until they write one. */
    styleGuide: z.string(),
    audience: z
      .object({
        activeMembers: z.number().int(),
        paidMembers: z.number().int(),
        joinedLast30Days: z.number().int(),
        leftLast30Days: z.number().int(),
      })
      .nullable()
      .openapi({ description: 'Null unless the credential holds members:read' }),
    recentDispatches: z
      .array(ChannelContextDispatchSchema)
      .nullable()
      .openapi({
        description: `The last ${CHANNEL_CONTEXT_DISPATCHES} sent posts, newest first, with how each went. Null unless the credential holds dispatches:read and broadcasts:read`,
      }),
  })
  .openapi('ChannelContext');
export type ChannelContext = z.infer<typeof ChannelContextSchema>;
