// Copilot (Phase 8.10): in-product writing assistant, flags copilot and copilot_byok, and Copilot
// actions (flag copilot_actions). Tables: migrations/0022_copilot.sql, 0030_copilot_actions.sql.
// Docs: docs/copilot.md.
// Prompts, provider adapters and quota checks live in @swarm/engine (copilot.ts,
// copilot-provider.ts, copilot-actions.ts); this file holds the contract the API and the
// dashboard share.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { AgentTargetSchema } from './p8-operator';
import type { ApiScope, Plan } from './p7-platform';
import type { SeatRole } from './schemas';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Features, styles and limits

const COPILOT_FEATURES = [
  'subject_lines',
  'preview_text',
  'rewrite',
  'fix_grammar',
  'translate',
  'teaser',
  'social_posts',
] as const;
export type CopilotFeature = (typeof COPILOT_FEATURES)[number];
/** What the request log records: the editor features, plus `actions` (Ask Copilot to do it). */
const COPILOT_LOG_FEATURES = [...COPILOT_FEATURES, 'actions'] as const;
export type CopilotLogFeature = (typeof COPILOT_LOG_FEATURES)[number];

/** Features that work on the operator's selection; the others read the whole Dispatch. */
export const COPILOT_SELECTION_FEATURES: readonly CopilotFeature[] = [
  'rewrite',
  'fix_grammar',
  'translate',
];
/** Features whose result is a list of short options (one per line). */
export const COPILOT_LIST_FEATURES: readonly CopilotFeature[] = ['subject_lines', 'preview_text'];

export const COPILOT_STYLES = [
  'shorter',
  'longer',
  'friendly',
  'formal',
  'confident',
  'plain',
] as const;
export type CopilotStyle = (typeof COPILOT_STYLES)[number];

/** Providers a workspace can bring its own key for. */
const COPILOT_PROVIDERS = ['anthropic'] as const;
/**
 * The platform's adapter (COPILOT_ADAPTER): Workers AI by default, Anthropic as the optional
 * external provider, or the offline fake in development and test.
 */
const COPILOT_ADAPTERS = ['workers-ai', 'anthropic', 'dev'] as const;
export type CopilotAdapter = (typeof COPILOT_ADAPTERS)[number];

/** 'platform' is Swarm's key (with the plan allowance); 'workspace' is the workspace's own. */
const COPILOT_KEY_SOURCES = ['platform', 'workspace'] as const;
export type CopilotKeySource = (typeof COPILOT_KEY_SOURCES)[number];

const COPILOT_REQUEST_STATUSES = ['pending', 'succeeded', 'failed', 'canceled', 'refused'] as const;
export type CopilotRequestStatus = (typeof COPILOT_REQUEST_STATUSES)[number];

/** Error codes inside the event stream (before it starts, errors are the usual JSON envelope). */
export type CopilotStreamError =
  'rate_limited' | 'key_rejected' | 'refused' | 'too_long' | 'unavailable' | 'internal';

/** Characters of text one request may send (about 6,000 tokens). */
const COPILOT_MAX_INPUT_CHARS = 24_000;
/** Options returned for subject lines and preview text. */
export const COPILOT_SUGGESTIONS = 5;
/** A subject or preheader is at most 200 characters (dispatches table). */
export const COPILOT_SUGGESTION_MAX_CHARS = 200;
/** Share Kit: the short post fits the tightest common limit, the long one a long-form network. */
export const COPILOT_SOCIAL_LIMITS = {
  shortChars: 280,
  longChars: 3000,
  threadPosts: 6,
  threadPostChars: 280,
} as const;
/** Where the Dispatch's web link goes in a social post; the server puts the real link there. */
export const COPILOT_LINK_TOKEN = '[LINK]';

interface CopilotPlanLimits {
  /** Requests on the platform key per workspace per calendar month (UTC). */
  requestsPerMonth: number;
  /** Requests on the platform key per operator per minute. */
  requestsPerMinute: number;
}

/** Decision 2026-10-28 (Phase 8 defaults, reversible). Platform key only. */
export const COPILOT_PLAN_LIMITS: Record<Plan, CopilotPlanLimits> = {
  free: { requestsPerMonth: 30, requestsPerMinute: 5 },
  pro: { requestsPerMonth: 500, requestsPerMinute: 10 },
  scale: { requestsPerMonth: 2000, requestsPerMinute: 20 },
  enterprise: { requestsPerMonth: 10_000, requestsPerMinute: 30 },
};
/** With a workspace key there is no monthly allowance; this per-operator limit still applies. */
export const COPILOT_BYOK_PER_MINUTE = 30;

/**
 * Usage counts what a request consumes: an editor request is one unit; an action run (up to six
 * model turns) is one unit per started COPILOT_TOKENS_PER_UNIT tokens, at least one.
 */
export const COPILOT_TOKENS_PER_UNIT = 25_000;
/**
 * The share of the platform key's monthly allowance one viewer or author may use, so one
 * low-privilege seat can't use up what editors need. Editors and above share the pool freely.
 * Owner-adjustable default.
 */
export const COPILOT_LOW_ROLE_SHARE = 0.25;
/** With a workspace key: units a month one viewer or author may use (owner-adjustable default). */
export const COPILOT_BYOK_LOW_ROLE_MONTHLY_UNITS = 100;

export const UpdateCopilotKeySchema = z
  .object({
    /** A monthly ceiling, in units, for requests on the workspace key; null removes it. */
    monthlyUnitCap: z.number().int().min(1).max(1_000_000).nullable(),
  })
  .openapi('UpdateCopilotKey');

// ---------------------------------------------------------------------------------------------
// Requests

const CopilotFeatureSchema = z.enum(COPILOT_FEATURES).openapi('CopilotFeature');
const CopilotStyleSchema = z.enum(COPILOT_STYLES).openapi('CopilotStyle');
const CopilotKeySourceSchema = z.enum(COPILOT_KEY_SOURCES).openapi('CopilotKeySource');
const CopilotRequestStatusSchema = z.enum(COPILOT_REQUEST_STATUSES).openapi('CopilotRequestStatus');

/** A language name as an operator types it: "German", "Português (Brasil)". */
const CopilotLanguageSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[\p{L}][\p{L} ()-]*$/u, 'Use the name of a language.');

export const CopilotRunSchema = z
  .object({
    feature: CopilotFeatureSchema,
    /** The selection, or the Dispatch as plain text (blank lines between blocks). */
    text: z.string().trim().min(1, 'There is no text to work on.').max(COPILOT_MAX_INPUT_CHARS),
    /** The current subject, as context for subject lines, preview text and teasers. */
    subject: z.string().max(200).optional(),
    /** rewrite only. */
    style: CopilotStyleSchema.optional(),
    /** translate only. */
    language: CopilotLanguageSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.feature === 'rewrite' && !value.style) {
      ctx.addIssue({ code: 'custom', path: ['style'], message: 'Pick a style.' });
    }
    if (value.feature === 'translate' && !value.language) {
      ctx.addIssue({ code: 'custom', path: ['language'], message: 'Name a language.' });
    }
  })
  .openapi('CopilotRun');
export type CopilotRun = z.infer<typeof CopilotRunSchema>;

/** Share Kit social posts for a Dispatch: plain text, with the Dispatch's web link. */
export interface CopilotSocialPosts {
  short: string;
  long: string;
  /** One string per post of the thread. */
  thread: string[];
  /** The web link put into the posts, or null when the Channel has no website. */
  link: string | null;
}

/** `event: done` in the stream. */
export interface CopilotDoneEvent {
  requestId: string;
  /** The whole result. */
  text: string;
  /** Subject lines and preview text: the options, else empty. */
  suggestions: string[];
  /** social_posts: the parsed posts, else null. */
  social: CopilotSocialPosts | null;
  /** This month's platform allowance left, or null with a workspace key. */
  remaining: number | null;
}
/** `event: error` in the stream. */
export interface CopilotErrorEvent {
  code: CopilotStreamError;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Settings, the workspace key and the request log

const CopilotKeySchema = z
  .object({
    provider: z.enum(COPILOT_PROVIDERS),
    /** The last four characters; the key itself is never returned. */
    last4: z.string().length(4),
    createdAt: timestamp,
    validatedAt: timestamp,
    /** The workspace's monthly ceiling for requests on this key, in units; null = none. */
    monthlyUnitCap: z.number().int().nullable(),
    /** Units used on this key this month. */
    used: z.number().int(),
  })
  .openapi('CopilotKey');
export const CopilotSettingsSchema = z
  .object({
    /** The provider requests use now: the workspace key's, else the platform adapter. */
    provider: z.enum(COPILOT_ADAPTERS),
    model: z.string(),
    /** Flag copilot_byok is on for the workspace. */
    byokAvailable: z.boolean(),
    /**
     * Whether the platform's adapter can serve requests (Workers AI with its binding, Anthropic
     * with a platform key, or the dev fake). Without it only a workspace key works.
     */
    platformKey: z.boolean(),
    /** Flag copilot_actions is on for the workspace (Ask Copilot to do it). */
    actionsAvailable: z.boolean(),
    key: CopilotKeySchema.nullable(),
    /** The key Copilot uses now. Null when neither key is available. */
    keySource: CopilotKeySourceSchema.nullable(),
    usage: z.object({
      /** YYYY-MM, UTC. */
      month: z.string().regex(/^\d{4}-\d{2}$/),
      /**
       * Units on the platform key this month: one per editor request, one per started
       * COPILOT_TOKENS_PER_UNIT tokens of an action run.
       */
      used: z.number().int(),
      limit: z.number().int(),
      perMinute: z.number().int(),
      /** The most units one viewer or author may use this month. */
      lowRoleLimit: z.number().int(),
    }),
  })
  .openapi('CopilotSettings');
export type CopilotSettings = z.infer<typeof CopilotSettingsSchema>;

export const SaveCopilotKeySchema = z
  .object({
    provider: z.enum(COPILOT_PROVIDERS),
    /** Write-only. Checked with the provider, stored sealed with FIELD_KEYS, never returned. */
    apiKey: z
      .string()
      .trim()
      .min(20, 'This doesn’t look like an API key.')
      .max(300)
      .regex(/^[\x21-\x7e]+$/, 'This doesn’t look like an API key.'),
  })
  .openapi('SaveCopilotKey');
export type SaveCopilotKey = z.infer<typeof SaveCopilotKeySchema>;

/** One row of the request log: metadata only, never the text sent or received. */
export const CopilotRequestLogSchema = z
  .object({
    id: id('copilotRequest'),
    feature: z.enum(COPILOT_LOG_FEATURES).openapi('CopilotLogFeature'),
    keySource: CopilotKeySourceSchema,
    model: z.string(),
    status: CopilotRequestStatusSchema,
    errorCode: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    latencyMs: z.number().int().nullable(),
    operator: z.object({ id: id('operator'), email: z.string() }).nullable(),
    channelId: id('channel').nullable(),
    dispatchId: id('dispatch').nullable(),
    createdAt: timestamp,
  })
  .openapi('CopilotRequestLog');
export type CopilotRequestLog = z.infer<typeof CopilotRequestLogSchema>;

export const CopilotLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------------------------
// Copilot actions (flag copilot_actions): "Ask Copilot to do it"

/**
 * The /v2 scopes Copilot may use for an operator, by role: never more than the role allows in
 * the dashboard. Scopes are coarser than roles, so a scope is granted only when every operation
 * it covers is open to the role. Authors write Dispatches but can't schedule them, and
 * dispatches:write includes scheduling, so authors (like viewers) get read scopes only.
 * Workspace-wide resources (webhooks, the audit log) and Direct Sends need admin.
 */
const READ_SCOPES: readonly ApiScope[] = [
  'channels:read',
  'members:read',
  'dispatches:read',
  'broadcasts:read',
  'circles:read',
  'fields:read',
  'levels:read',
  'forms:read',
  'flows:read',
  'rosters:read',
];
const EDITOR_SCOPES: readonly ApiScope[] = [
  ...READ_SCOPES,
  'members:write',
  'dispatches:write',
  'circles:write',
  'fields:write',
  'flows:write',
  'imports:write',
  'rosters:write',
];
const ADMIN_SCOPES: readonly ApiScope[] = [
  ...EDITOR_SCOPES,
  'webhooks:read',
  'webhooks:write',
  'sends:write',
  'audit:read',
];
export const COPILOT_ROLE_SCOPES: Record<SeatRole, readonly ApiScope[]> = {
  viewer: READ_SCOPES,
  author: READ_SCOPES,
  editor: EDITOR_SCOPES,
  admin: ADMIN_SCOPES,
  owner: ADMIN_SCOPES,
};

/** Caps on one "Ask Copilot to do it" request (decision 2026-10-28, reversible). */
export const COPILOT_ACTION_LIMITS = {
  /** Model turns per request. */
  maxSteps: 6,
  /** Tool calls run per model turn; more are answered as skipped. */
  maxToolCallsPerStep: 4,
  /**
   * Input plus output tokens across all turns; no further turn starts once it is used. The tool
   * list alone is about 3,000 (viewer) to 12,000 (admin) tokens a turn.
   */
  maxTotalTokens: 150_000,
  /** max_tokens of one turn. */
  maxOutputTokens: 4000,
  /** Characters of a tool's answer given back to the model. */
  maxResultChars: 8000,
  /** Characters of the operator's request. */
  maxRequestChars: 2000,
} as const;

export const CopilotActionRunSchema = z
  .object({
    /** What the operator asks Copilot to do. The only instruction the model follows. */
    request: z
      .string()
      .trim()
      .min(1, 'Say what Copilot should do.')
      .max(COPILOT_ACTION_LIMITS.maxRequestChars),
    /** The Dispatch open in the editor, given to the model as an id (never its content). */
    dispatchId: id('dispatch').optional(),
  })
  .openapi('CopilotActionRun');
export type CopilotActionRun = z.infer<typeof CopilotActionRunSchema>;

/**
 * Who has to decide a held call: `operator` (Copilot's own confirmation, for destructive calls
 * and for changes proposed after the model read workspace content, when the approval mode
 * wouldn't hold them) or `admin` (the workspace's approval mode holds it).
 */
const COPILOT_ACTION_DECIDERS = ['operator', 'admin'] as const;
export type CopilotActionDecider = (typeof COPILOT_ACTION_DECIDERS)[number];

const CopilotActionStepSchema = z
  .object({
    tool: z.string(),
    risk: z.enum(['read', 'write', 'destructive']).nullable(),
    /** The agent log row of this call. */
    actionId: z.string(),
    outcome: z.enum(['ok', 'error', 'denied', 'unknown_tool', 'pending_approval']),
    statusCode: z.number().int().nullable(),
    /** Masked summary of the arguments, as in the agent log. */
    arguments: z.unknown(),
    approval: z
      .object({
        id: z.string().regex(idPattern('agentApproval')),
        expiresAt: timestamp,
        decider: z.enum(COPILOT_ACTION_DECIDERS),
        /** Why it waits, in a sentence for the operator. */
        reason: z.string(),
        /**
         * The exact /v2 request that runs if the operator confirms, as the admin approval view
         * shows a pending call: shown to the operator before they confirm.
         */
        request: z.object({ method: z.string(), path: z.string(), body: z.unknown().nullable() }),
        /** SHA-256 of that request; the confirmation must carry it back. */
        requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
        /**
         * What the call acts on, looked up by the server when it was held (a post's subject,
         * sender and audience; a Member's id and status; a feed source), never text from the
         * model. Null when the call names no single target.
         */
        target: AgentTargetSchema.nullable(),
        /** Proposed after the model had read workspace content that others may have written. */
        afterReading: z.boolean(),
      })
      .nullable(),
  })
  .openapi('CopilotActionStep');
export type CopilotActionStep = z.infer<typeof CopilotActionStepSchema>;

const COPILOT_ACTION_STOPS = ['done', 'max_steps', 'max_tokens', 'refused', 'error'] as const;
export type CopilotActionStop = (typeof COPILOT_ACTION_STOPS)[number];

export const CopilotActionResultSchema = z
  .object({
    requestId: id('copilotRequest'),
    /** The model's closing message to the operator (plain text). */
    text: z.string(),
    steps: z.array(CopilotActionStepSchema),
    stop: z.enum(COPILOT_ACTION_STOPS),
    /** Copilot read workspace content (tool results others may have written) in this run. */
    readWorkspaceContent: z.boolean(),
    /** This month's platform allowance left, or null with a workspace key. */
    remaining: z.number().int().nullable(),
  })
  .openapi('CopilotActionResult');
export type CopilotActionResult = z.infer<typeof CopilotActionResultSchema>;

/** Confirming a held call: the digest of the request the operator was shown. */
export const CopilotActionConfirmSchema = z
  .object({
    requestDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'Confirm the call from the request Copilot showed you.'),
  })
  .openapi('CopilotActionConfirm');

export const CopilotActionDecisionSchema = z
  .object({
    approvalId: z.string().regex(idPattern('agentApproval')),
    status: z.enum(['executed', 'failed', 'rejected']),
    statusCode: z.number().int().nullable(),
    /** Masked summary of the answer, or the reason it did not run. */
    result: z.unknown(),
  })
  .openapi('CopilotActionDecision');
export type CopilotActionDecision = z.infer<typeof CopilotActionDecisionSchema>;

/**
 * What Copilot's model is not sent from a Member result by default (agent_settings
 * copilot_member_detail 'masked'): the address, names, field values (some sealed at rest),
 * consent records and the leaving reason. Ids, status, tags, counts and dates stay, so the model
 * can still count, tag and find Members by id.
 */
export const COPILOT_WITHHELD_MEMBER_KEYS = [
  'email',
  'firstName',
  'lastName',
  'fields',
  'consents',
  'unsubscribeReason',
  'phone',
  'ip',
] as const;
