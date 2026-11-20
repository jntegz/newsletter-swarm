// Platform (Phase 7) shared contracts: plans and their limits, API scopes, key and token formats,
// the Event Webhook catalogue and signature, data-subject requests, second factors and DMARC.
// Request and response schemas for each surface live next to these in p7-*.ts files owned by the
// workstream that builds it. Tables: migrations/0012_platform.sql.
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------------------------
// Plans

export const PLANS = ['free', 'pro', 'scale', 'enterprise'] as const;

/**
 * Why a standing feed (an export destination or webhook endpoint) receives nothing even though it
 * is active (docs/security.md "Standing feeds"): waiting for an admin to confirm it, the admin
 * who confirmed it no longer an admin, the API key or app that proposed it revoked, its
 * publication deleted, or the plan no longer including it.
 */
const FEED_SUSPENSIONS = [
  'unconfirmed',
  'confirmer_left',
  'credential_revoked',
  'channel_deleted',
  'plan',
] as const;
export const FeedSuspensionSchema = z.enum(FEED_SUSPENSIONS);
export type FeedSuspension = z.infer<typeof FeedSuspensionSchema>;
export type Plan = (typeof PLANS)[number];
export const isPaidPlan = (plan: Plan) => plan !== 'free';

interface PlanLimits {
  /** Active (not revoked, not expired) API keys per workspace. */
  apiKeys: number;
  /** Registered OAuth apps per workspace. */
  oauthApps: number;
  /** Webhook endpoints per workspace. */
  webhookEndpoints: number;
  /** /v2 requests per minute per workspace (a per-key rate_cap can only lower it). */
  requestsPerMinute: number;
  /** Token-bucket burst on top of the steady rate. */
  burst: number;
  /** Direct Send API messages per day; 0 = not available. */
  directSendsPerDay: number;
  /** Audit log retention in days; null = kept forever. */
  auditRetentionDays: number | null;
  /** Export destinations (R2/S3 sync) per workspace. */
  exportDestinations: number;
  sso: boolean;
  dedicatedIps: boolean;
}

/** Decision 2026-10-28 (Phase 7 defaults, reversible). */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    apiKeys: 2,
    oauthApps: 1,
    webhookEndpoints: 2,
    requestsPerMinute: 60,
    burst: 30,
    directSendsPerDay: 0,
    auditRetentionDays: 30,
    exportDestinations: 0,
    sso: false,
    dedicatedIps: false,
  },
  pro: {
    apiKeys: 25,
    oauthApps: 10,
    webhookEndpoints: 10,
    requestsPerMinute: 600,
    burst: 300,
    directSendsPerDay: 10_000,
    auditRetentionDays: 365,
    exportDestinations: 3,
    sso: true,
    dedicatedIps: true,
  },
  scale: {
    apiKeys: 100,
    oauthApps: 25,
    webhookEndpoints: 50,
    requestsPerMinute: 3000,
    burst: 1500,
    directSendsPerDay: 100_000,
    auditRetentionDays: 730,
    exportDestinations: 10,
    sso: true,
    dedicatedIps: true,
  },
  enterprise: {
    apiKeys: 500,
    oauthApps: 100,
    webhookEndpoints: 200,
    requestsPerMinute: 10_000,
    burst: 5000,
    directSendsPerDay: 1_000_000,
    auditRetentionDays: null,
    exportDestinations: 50,
    sso: true,
    dedicatedIps: true,
  },
};

// ---------------------------------------------------------------------------------------------
// API scopes. A key or OAuth grant holds a subset; every /v2 route declares exactly one.

export const API_SCOPES = [
  'channels:read',
  'members:read',
  'members:write',
  'dispatches:read',
  'dispatches:write',
  'broadcasts:read',
  'circles:read',
  'circles:write',
  'fields:read',
  'fields:write',
  'levels:read',
  'forms:read',
  'flows:read',
  'flows:write',
  'webhooks:read',
  'webhooks:write',
  'sends:read',
  'sends:write',
  'imports:read',
  'imports:write',
  'audit:read',
  'rosters:read',
  'rosters:write',
  'goods:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const ApiScopeSchema = z.enum(API_SCOPES).openapi('ApiScope');

/** `members:write` implies `members:read`, and so on for every resource. */
export function scopeAllows(granted: readonly ApiScope[], needed: ApiScope): boolean {
  if (granted.includes(needed)) return true;
  if (needed.endsWith(':read')) {
    const write = needed.replace(/:read$/, ':write') as ApiScope;
    return (API_SCOPES as readonly string[]).includes(write) && granted.includes(write);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Key and token formats. Only sha256 hex of the full string is stored.

export const API_KEY_PREFIX = 'sk_live_';
/** sk_live_ + 40 base62 characters; the first 8 after the prefix are shown as `prefix`. */
export const API_KEY_PATTERN = /^sk_live_[0-9A-Za-z]{40}$/;
export const OAUTH_ACCESS_PREFIX = 'oat_';
export const OAUTH_REFRESH_PREFIX = 'ort_';
export const OAUTH_CLIENT_ID_PREFIX = 'swc_';
export const OAUTH_ACCESS_TTL_SECONDS = 3600;
export const OAUTH_REFRESH_TTL_DAYS = 30;
export const OAUTH_CODE_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------------------------
// Event Webhooks

export const WEBHOOK_EVENTS = [
  'member.created',
  'member.confirmed',
  'member.updated',
  'member.unsubscribed',
  'member.deleted',
  'good.purchased',
  'good.refunded',
  'level.purchased',
  'level.canceled',
  'dispatch.scheduled',
  'dispatch.sent',
  'broadcast.completed',
  'ask.response',
  'flow.completed',
  'capture_form.submitted',
  /** Rosters (Phase 8): a Member joined or left a Roster. member.updated is sent as well. */
  'roster.subscribed',
  'roster.unsubscribed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENTS).openapi('WebhookEventType');

/**
 * What a receiver gets as the body. `data` is the resource in its /v2 shape (a Member, a
 * Dispatch, …); `id` is stable across retries and redrives (also sent as Swarm-Event-Id).
 */
export interface WebhookEnvelope {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  workspaceId: string;
  channelId: string | null;
  data: Record<string, unknown>;
}

export const WEBHOOK_SIGNATURE_HEADER = 'Swarm-Signature';
export const WEBHOOK_EVENT_ID_HEADER = 'Swarm-Event-Id';
/** After rotation the previous secret also signs (a second v1=) for this long. */
export const WEBHOOK_ROTATION_OVERLAP_HOURS = 24;
export const WEBHOOK_MAX_ATTEMPTS = 9; // the first try plus 8 retries
/** Seconds before retry n (1-based): 30 s, 2 min, 8 min, 32 min, ~2 h, ~8.5 h, then 12 h caps. */
export function webhookBackoffSeconds(retry: number): number {
  return Math.min(30 * 4 ** (retry - 1), 43_200);
}
/** An endpoint failing every delivery for this long is disabled and its admins are emailed. */
export const WEBHOOK_DISABLE_AFTER_HOURS = 72;
export const WEBHOOK_RESPONSE_EXCERPT_BYTES = 1024;
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac of the previous secret>]`. */
export function webhookSignedPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

// ---------------------------------------------------------------------------------------------
// Privacy Center

export const DSR_KINDS = ['export', 'erase'] as const;
export type DsrKind = (typeof DSR_KINDS)[number];
export const DSR_STATUSES = ['pending', 'processing', 'completed', 'rejected', 'failed'] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];
/** SLA timers on the operator queue. */
export const DSR_DUE_HOURS: Record<DsrKind, number> = { export: 24, erase: 30 * 24 };
export const DSR_EXPORT_LINK_DAYS = 7;
export const ERASED_EMAIL_DOMAIN = 'invalid';

// ---------------------------------------------------------------------------------------------
// Account security

export type MfaMethod = 'passkey' | 'totp' | 'recovery' | 'sso';
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes one step either side of now are accepted. */
export const TOTP_WINDOW = 1;
export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;
export const REQUIRE_2FA_OPTIONS = ['admins', 'all'] as const;

// ---------------------------------------------------------------------------------------------
// Deliverability Center

/** The local part of the DMARC rua address: dmarc+<sendingDomainId>@<DMARC_MAIL_DOMAIN>. */
export const DMARC_RUA_LOCAL_PREFIX = 'dmarc+';
/** Gmail's bulk-sender complaint ceiling (0.3%); 0.1% is where they ask senders to stay below. */
export const GMAIL_COMPLAINT_THRESHOLD = 0.003;
export const GMAIL_COMPLAINT_TARGET = 0.001;
export const MAILBOX_PROVIDERS = ['gmail', 'outlook', 'yahoo', 'apple', 'other'] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];
