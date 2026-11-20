// Event Webhooks (Phase 7): request and response schemas for endpoints, the delivery log and
// redrive, plus the `data` shape of each event. Shared constants (the catalogue, signature,
// retries, auto-disable) are in p7-platform.ts. Tables: 0012_platform.sql and 0015_webhooks.sql.
// Guide for receivers: docs/webhooks.md.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { MemberSchema } from './audience';
import { BroadcastSchema, BroadcastStatsSchema, DispatchSummarySchema } from './send';
import { FlowRunSchema } from './p6-flows-api';
import { RosterSourceSchema } from './p8-rosters';
import { GoodOrderEventSchema } from './p8-goods';
import {
  FeedSuspensionSchema,
  WEBHOOK_EVENTS,
  WebhookEventTypeSchema,
  type WebhookEventType,
} from './p7-platform';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

export const WEBHOOK_EVENT_TYPE_HEADER = 'Swarm-Event-Type';
export const WEBHOOK_USER_AGENT = 'Swarm-Webhooks/1';
/** `whsec_` + 43 base64url characters (32 random bytes). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Finished deliveries and outbox rows are kept this long. */
export const WEBHOOK_RETENTION_DAYS = 30;
/** "Redrive all failed since…" re-sends at most this many deliveries per call. */
export const WEBHOOK_REDRIVE_LIMIT = 1000;

/** How the dashboard groups the event checklist. Every event is in exactly one group. */
export const WEBHOOK_EVENT_GROUPS: readonly {
  label: string;
  events: readonly WebhookEventType[];
}[] = [
  {
    label: 'Subscribers',
    events: [
      'member.created',
      'member.confirmed',
      'member.updated',
      'member.unsubscribed',
      'member.deleted',
    ],
  },
  { label: 'Paid plans', events: ['level.purchased', 'level.canceled'] },
  { label: 'Posts', events: ['dispatch.scheduled', 'dispatch.sent', 'broadcast.completed'] },
  { label: 'Growth', events: ['ask.response', 'capture_form.submitted', 'flow.completed'] },
  { label: 'Rosters', events: ['roster.subscribed', 'roster.unsubscribed'] },
  { label: 'Products', events: ['good.purchased', 'good.refunded'] },
];

// ---------------------------------------------------------------------------------------------
// Endpoints

const WEBHOOK_ENDPOINT_STATUSES = ['active', 'paused', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];
const WebhookEndpointStatusSchema = z
  .enum(WEBHOOK_ENDPOINT_STATUSES)
  .openapi('WebhookEndpointStatus');

export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'retrying',
  'canceled',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
const WebhookDeliveryStatusSchema = z
  .enum(WEBHOOK_DELIVERY_STATUSES)
  .openapi('WebhookDeliveryStatus');

const WebhookEventsSchema = z
  .array(WebhookEventTypeSchema)
  .min(1, 'Pick at least one event.')
  .max(WEBHOOK_EVENTS.length)
  .transform((events) => [...new Set(events)]);

const WebhookUrlSchema = z.string().trim().min(1).max(2048);

export const WebhookEndpointSchema = z
  .object({
    id: id('webhookEndpoint'),
    workspaceId: id('workspace'),
    /** null = events from every Channel in the workspace. */
    channelId: id('channel').nullable(),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(WebhookEventTypeSchema),
    status: WebhookEndpointStatusSchema,
    disabledReason: z.string().nullable(),
    /** Failed attempts in a row; a success resets it. */
    failureCount: z.number().int(),
    firstFailureAt: timestamp.nullable(),
    /** While a rotation overlaps, the previous secret also signs until this time. */
    previousSecretExpiresAt: timestamp.nullable(),
    lastDeliveryAt: timestamp.nullable(),
    lastDeliveryStatus: WebhookDeliveryStatusSchema.nullable(),
    /** Why it receives nothing while active; null when someone with current authority stands
     *  behind it. An admin confirms it (POST …/confirm) to adopt it. */
    suspendedReason: FeedSuspensionSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('WebhookEndpoint');
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/** Returned on create and on rotation only: the secret is never shown again. */
export const WebhookEndpointWithSecretSchema = z
  .object({ endpoint: WebhookEndpointSchema, secret: z.string() })
  .openapi('WebhookEndpointWithSecret');
export type WebhookEndpointWithSecret = z.infer<typeof WebhookEndpointWithSecretSchema>;

export const CreateWebhookEndpointSchema = z
  .object({
    url: WebhookUrlSchema,
    description: z.string().trim().max(200).nullable().optional(),
    events: WebhookEventsSchema,
    channelId: id('channel').nullable().optional(),
  })
  .openapi('CreateWebhookEndpoint');
export type CreateWebhookEndpoint = z.input<typeof CreateWebhookEndpointSchema>;

export const UpdateWebhookEndpointSchema = z
  .object({
    url: WebhookUrlSchema.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    events: WebhookEventsSchema.optional(),
    channelId: id('channel').nullable().optional(),
    /** Pause or resume. Resuming a disabled endpoint clears its failures. */
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateWebhookEndpoint');
export type UpdateWebhookEndpoint = z.input<typeof UpdateWebhookEndpointSchema>;

export const SendTestWebhookSchema = z
  .object({ type: WebhookEventTypeSchema.optional() })
  .openapi('SendTestWebhook');
// ---------------------------------------------------------------------------------------------
// Deliveries

export const WebhookDeliverySchema = z
  .object({
    id: id('webhookDelivery'),
    endpointId: id('webhookEndpoint'),
    eventId: id('webhookEvent'),
    eventType: WebhookEventTypeSchema,
    status: WebhookDeliveryStatusSchema,
    /** A test event sent from the dashboard or API. */
    test: z.boolean(),
    attempts: z.number().int(),
    nextAttemptAt: timestamp.nullable(),
    lastAttemptAt: timestamp.nullable(),
    responseStatus: z.number().int().nullable(),
    latencyMs: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('WebhookDelivery');
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

const WebhookAttemptSchema = z
  .object({
    attempt: z.number().int(),
    startedAt: timestamp,
    responseStatus: z.number().int().nullable(),
    latencyMs: z.number().int().nullable(),
    error: z.string().nullable(),
    responseExcerpt: z.string().nullable(),
  })
  .openapi('WebhookAttempt');
export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  /** The exact body that is signed and sent (the envelope). */
  payload: z.record(z.string(), z.unknown()),
  /** The request headers; the signature's MAC values are not shown. */
  requestHeaders: z.record(z.string(), z.string()),
  responseExcerpt: z.string().nullable(),
  attemptLog: z.array(WebhookAttemptSchema),
}).openapi('WebhookDeliveryDetail');
export type WebhookDeliveryDetail = z.infer<typeof WebhookDeliveryDetailSchema>;

export const WebhookDeliveriesQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: WebhookDeliveryStatusSchema.optional(),
  eventType: WebhookEventTypeSchema.optional(),
});

export const RedriveWebhookDeliveriesSchema = z
  .object({
    /** Failed and canceled deliveries created at or after this time are sent again. */
    since: z.iso.datetime(),
  })
  .openapi('RedriveWebhookDeliveries');

export const RedriveResultSchema = z
  .object({ redriven: z.number().int() })
  .openapi('WebhookRedriveResult');

// ---------------------------------------------------------------------------------------------
// Event data: the `data` of the envelope, per event type (docs/webhooks.md has examples).

/** The body of every request (WebhookEnvelope in p7-platform.ts). */
export const WebhookEnvelopeSchema = z
  .object({
    id: id('webhookEvent'),
    type: WebhookEventTypeSchema,
    createdAt: timestamp,
    workspaceId: id('workspace'),
    channelId: id('channel').nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi('WebhookEnvelope');

const MemberDeletedDataSchema = z
  .object({ id: id('member'), channelId: id('channel') })
  .openapi('WebhookMemberDeleted');

const LevelEventDataSchema = z
  .object({
    member: MemberSchema,
    levelId: id('membershipLevel').nullable(),
    /** level.purchased only: what granted it (checkout, comp, gift, …). */
    source: z.string().optional(),
  })
  .openapi('WebhookLevelEvent');

const AskResponseDataSchema = z
  .object({
    member: MemberSchema,
    askId: id('ask'),
    questionId: id('askQuestion'),
    optionId: id('askOption').nullable(),
  })
  .openapi('WebhookAskResponse');

const CaptureFormSubmittedDataSchema = z
  .object({
    member: MemberSchema,
    formId: id('captureForm'),
    /** True when the submission created the Member. */
    created: z.boolean(),
  })
  .openapi('WebhookCaptureFormSubmitted');

/** roster.subscribed and roster.unsubscribed: the Member, the Roster and who made the change. */
const RosterEventDataSchema = z
  .object({
    member: MemberSchema,
    rosterId: id('roster'),
    /** operator, form, member, import, api or unsubscribe (docs/rosters.md). */
    source: RosterSourceSchema,
  })
  .openapi('WebhookRosterEvent');

const BroadcastCompletedDataSchema = z
  .object({ broadcast: BroadcastSchema, stats: BroadcastStatsSchema })
  .openapi('WebhookBroadcastCompleted');

/** The `data` schema of each event type. */
export const WEBHOOK_EVENT_DATA = {
  'member.created': MemberSchema,
  'member.confirmed': MemberSchema,
  'member.updated': MemberSchema,
  'member.unsubscribed': MemberSchema,
  'member.deleted': MemberDeletedDataSchema,
  'level.purchased': LevelEventDataSchema,
  'level.canceled': LevelEventDataSchema,
  'dispatch.scheduled': DispatchSummarySchema,
  'dispatch.sent': DispatchSummarySchema,
  'broadcast.completed': BroadcastCompletedDataSchema,
  'ask.response': AskResponseDataSchema,
  'flow.completed': FlowRunSchema,
  'capture_form.submitted': CaptureFormSubmittedDataSchema,
  'roster.subscribed': RosterEventDataSchema,
  'roster.unsubscribed': RosterEventDataSchema,
  'good.purchased': GoodOrderEventSchema,
  'good.refunded': GoodOrderEventSchema,
} satisfies Record<WebhookEventType, z.ZodType>;

/** Events whose `data` is the Member as it is when the event is fanned out. */
export const MEMBER_RESOURCE_EVENTS = [
  'member.created',
  'member.confirmed',
  'member.updated',
  'member.unsubscribed',
] as const satisfies readonly WebhookEventType[];
