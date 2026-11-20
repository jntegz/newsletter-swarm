// Inbox rules: per-Channel limits on automated email (Flow emails), kept in
// channels.settings_json under `inboxRules`. Off until a person turns one on, for existing and new
// Channels alike. The decision itself is decideInboxRules in @swarm/engine (flows-inbox-rules.ts).
import { z } from '@hono/zod-openapi';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24 hour time like 08:00.');

/** How long a held email may wait, in days, before its run exits instead of sending it late. */
export const INBOX_RULES_DEFAULT_MAX_HOLD_DAYS = 14;
export const INBOX_RULES_MAX_HOLD_DAYS = 90;
export const INBOX_RULES_MAX_PER_DAY = 50;
export const INBOX_RULES_MAX_PER_WEEK = 200;
export const INBOX_RULES_MAX_HOURS_AROUND = 72;

export const InboxRulesSchema = z
  .object({
    /** Automated emails per Member in any 24 hours; no limit when null. */
    perDay: z.number().int().min(1).max(INBOX_RULES_MAX_PER_DAY).nullable().default(null),
    /** Automated emails per Member in any 7 days; no limit when null. */
    perWeek: z.number().int().min(1).max(INBOX_RULES_MAX_PER_WEEK).nullable().default(null),
    /** No automated email between these times (HH:MM, may cross midnight); off when null. */
    quietHours: z
      .object({ start: clockTime, end: clockTime })
      .refine((q) => q.start !== q.end, 'Quiet hours need a start and an end that differ.')
      .nullable()
      .default(null),
    /**
     * Holds automated email on a day the Member gets a post, and for `hoursAround` hours on either
     * side of that post (0: the day only). Off when null.
     */
    newsletterDay: z
      .object({ hoursAround: z.number().int().min(0).max(INBOX_RULES_MAX_HOURS_AROUND) })
      .nullable()
      .default(null),
    /** A held email whose wait would pass this many days exits with reason hold_expired. */
    maxHoldDays: z
      .number()
      .int()
      .min(1)
      .max(INBOX_RULES_MAX_HOLD_DAYS)
      .default(INBOX_RULES_DEFAULT_MAX_HOLD_DAYS),
  })
  .openapi('InboxRules');
export type InboxRules = z.infer<typeof InboxRulesSchema>;

/** Every rule off. What a Channel has until a person sets one. */
export const NO_INBOX_RULES: InboxRules = {
  perDay: null,
  perWeek: null,
  quietHours: null,
  newsletterDay: null,
  maxHoldDays: INBOX_RULES_DEFAULT_MAX_HOLD_DAYS,
};

export const inboxRulesActive = (rules: InboxRules): boolean =>
  rules.perDay !== null ||
  rules.perWeek !== null ||
  rules.quietHours !== null ||
  rules.newsletterDay !== null;

/** The rules in a Channel's settings; a missing or unreadable value means every rule is off. */
export function inboxRulesFromSettings(settings: unknown): InboxRules {
  const value = (settings as { inboxRules?: unknown } | null | undefined)?.inboxRules;
  const parsed = InboxRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : NO_INBOX_RULES;
}

export const INBOX_HOLD_REASONS = [
  'quiet_hours',
  'daily_limit',
  'weekly_limit',
  'newsletter_day',
  'near_post',
  /** No rule stops it now, but an earlier held email of this Member has not gone yet. */
  'in_line',
] as const;
const InboxHoldReasonSchema = z.enum(INBOX_HOLD_REASONS).openapi('InboxHoldReason');
export type InboxHoldReason = z.infer<typeof InboxHoldReasonSchema>;

const FLOW_HOLD_OUTCOMES = ['sent', 'skipped', 'expired', 'left'] as const;

/** A send step held back by an inbox rule. `releasedAt` is null while it still waits. */
export const FlowRunHoldSchema = z
  .object({
    nodeId: z.string(),
    reason: InboxHoldReasonSchema,
    until: timestamp,
    /** The zone the rule was read in: the Member's when known, else the Channel's. */
    zone: z.string(),
    heldAt: timestamp,
    releasedAt: timestamp.nullable(),
    outcome: z.enum(FLOW_HOLD_OUTCOMES).nullable(),
  })
  .openapi('FlowRunHold');
export type FlowRunHold = z.infer<typeof FlowRunHoldSchema>;

export const FlowNodeHeldSchema = z
  .object({
    /** Runs waiting at this step now. */
    now: z.number().int(),
    /** Runs this step ever held, the ones waiting now included. */
    total: z.number().int(),
    /** Held runs that waited too long and exited without the email. */
    expired: z.number().int(),
  })
  .openapi('FlowNodeHeld');

export const InboxRuleSettingsSchema = z
  .object({
    rules: InboxRulesSchema,
    /** The Channel's IANA time zone, for Members whose own is not known; UTC when null. */
    timezone: z.string().nullable(),
    /** Emails of this Channel held right now. */
    heldNow: z.number().int(),
  })
  .openapi('InboxRuleSettings');
export type InboxRuleSettings = z.infer<typeof InboxRuleSettingsSchema>;

export const UpdateInboxRuleSettingsSchema = z
  .object({
    rules: InboxRulesSchema,
    timezone: z.string().min(1).max(64).nullable(),
  })
  .openapi('UpdateInboxRuleSettings');
export type UpdateInboxRuleSettings = z.infer<typeof UpdateInboxRuleSettingsSchema>;

interface GraphLike {
  nodes: readonly { id: string; type: string; config: unknown }[];
  edges: readonly { from: string; to: string }[];
}

/**
 * Whether a send step with no `sendRegardless` of its own is exempt: the first email after someone
 * confirms or joins (a welcome), with no other email step before it on any path. Every start event
 * of the Flow must be one of those two: the answer belongs to the step, so a run is held the same
 * way whichever start event began it. Every other email obeys the rules unless the writer marks it.
 */
export function defaultSendRegardless(graph: GraphLike, nodeId: string): boolean {
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const config = trigger?.config as
    { event?: unknown; alsoStartOn?: readonly { event?: unknown }[] } | undefined;
  const events = [config?.event, ...(config?.alsoStartOn ?? []).map((t) => t.event)];
  if (!events.every((event) => event === 'confirmed' || event === 'member_joined')) return false;
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]));
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const at = queue.shift();
    for (const edge of graph.edges) {
      if (edge.to !== at || seen.has(edge.from)) continue;
      if (types.get(edge.from) === 'send_email') return false;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }
  return true;
}

/** Whether a send step ignores the inbox rules: its own mark, else the default above. */
export function isSendRegardless(
  graph: GraphLike,
  node: { id: string; config: { sendRegardless?: boolean | undefined } },
): boolean {
  return node.config.sendRegardless ?? defaultSendRegardless(graph, node.id);
}
