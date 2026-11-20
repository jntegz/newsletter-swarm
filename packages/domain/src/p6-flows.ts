// Flows (Phase 6): the versioned graph stored in flows.draft_graph_json and
// flow_versions.graph_json, the member events that trigger it, and the run lifecycle enums.
//
// CONTRACT (shared by the api worker, the jobs worker's Flows engine and the dashboard builder):
// - A graph is `{ schema: 1, nodes, edges }`. Exactly one node has type 'trigger'. It holds every
//   start event: its config is the first one, `alsoStartOn` the others (triggersOf lists them).
// - Node ids are short stable strings chosen by the builder (`/^[a-z0-9_-]{1,40}$/i`); they key
//   flow_run_steps.node_id and per-node stats, so the builder never renames an existing node.
// - Edges go `from` → `to` with a `label`. The labels a node may emit depend on its type
//   (FLOW_NODE_OUTPUTS); each label appears at most once per node. A node with no edge for the
//   outcome it produced ends the run as 'completed'.
// - The graph is a DAG (no cycles, including through enrol_flow of the same Flow, which the
//   API refuses by id), every node is reachable from the trigger, and the trigger has no
//   incoming edges. `validateFlowGraph` checks all of this; `FlowGraphSchema` runs it.
// - Every id a graph references must belong to the Flow's Channel. `collectReferencedIds`
//   lists them so the API (on save and publish) and the engine (before each step) can check
//   them in one query per kind.
import { z } from '@hono/zod-openapi';
import { CircleRuleSchema, type CircleRule } from './audience';
import { idPattern } from './ids';

const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Limits

export const FLOW_GRAPH_SCHEMA_VERSION = 1;
export const FLOW_MAX_NODES = 200;
const FLOW_MAX_EDGES = 400;
/** Attempts per node before the step is marked failed and the run is paused. */
export const FLOW_STEP_MAX_ATTEMPTS = 5;
/** Backoff before attempt n+1 (seconds): 30 s, 2 min, 8 min, 32 min. */
export const flowStepBackoffSeconds = (attempt: number) => 30 * 4 ** Math.max(0, attempt - 1);
/** Cloudflare Queues' largest delaySeconds. Longer waits go through flow_runs.next_at. */
export const QUEUE_MAX_DELAY_SECONDS = 12 * 60 * 60;
/** Longest delay or wait a node may ask for. */
const FLOW_MAX_DELAY_DAYS = 365;
/**
 * Runs of one Flow a Member can start per hour when re-entry is on. A graph has no cycles, but a
 * Flow can still re-fire its own trigger (remove then add the tag it listens to, or two Flows
 * enrolling each other); without this such a loop runs its webhooks and notices forever.
 */
export const FLOW_REENTRY_MAX_PER_HOUR = 10;
/** Start events one Flow can have. Each costs one in-memory match per event of its type. */
export const FLOW_MAX_TRIGGERS = 10;
/**
 * Two start events this close together are the same moment: with re-entry on, a Flow with several
 * start events doesn't start a second run because a sign-up emitted two of them at once.
 */
export const FLOW_SAME_MOMENT_MS = 60_000;

export const FlowNodeIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/i, 'Node ids are 1 to 40 letters, digits, - or _.');

// ---------------------------------------------------------------------------------------------
// Member events: the trigger bus (member_events table, written by @swarm/engine events.ts)

export const MEMBER_EVENT_TYPES = [
  'member_joined',
  'form_submitted',
  'confirmed',
  'circle_entered',
  'circle_exited',
  'tag_added',
  'tag_removed',
  'field_changed',
  'level_purchased',
  'level_canceled',
  'ask_answered',
  'link_clicked',
  /** First human open of a Flow email only (not of audience Broadcasts); wakes wait_for_event. */
  'email_opened',
  'gate_hit',
  'unengaged',
  'api_event',
  /** Rosters (Phase 8): a Member joined or left a Roster (Flow triggers with the rosters flag). */
  'roster_joined',
  'roster_left',
  /** Champions: a referral this Member made was counted (countReferrals, reviewReferral). */
  'referral_succeeded',
  /** Champions: this Member's counted referrals reached a milestone (checkMilestones). */
  'referral_milestone',
] as const;
export type MemberEventType = (typeof MEMBER_EVENT_TYPES)[number];

export type MemberJoinSource = 'form' | 'operator' | 'import' | 'checkout' | 'gift' | 'api';

type ConfirmMethod = 'double_opt_in' | 'single_opt_in' | 'return' | 'checkout' | 'gift';

/** The payload stored in member_events.payload_json, by event type. */
export interface MemberEventPayloads {
  /** A Member row was created, in any status (pending under double opt-in). */
  member_joined: { source: MemberJoinSource; formId?: string; importId?: string; status: string };
  /** A Capture Form was submitted by a Member, new or existing (not by a suppressed address). */
  form_submitted: { formId: string; created: boolean };
  /** The Member became active with consent: a confirm, a single opt-in sign-up, a purchase. */
  confirmed: { method: ConfirmMethod; formId?: string };
  circle_entered: { circleId: string };
  circle_exited: { circleId: string };
  tag_added: { tagId: string };
  tag_removed: { tagId: string };
  /** Values are never copied into the log (fields can be encrypted). */
  field_changed: { fieldId: string };
  /** The paid entitlement started or moved to this level (null: a paid grant with no level). */
  level_purchased: { levelId: string | null; source: string };
  /** The paid entitlement on this level ended or moved away from it. */
  level_canceled: { levelId: string | null };
  ask_answered: { askId: string; questionId: string; optionId?: string };
  /** A human click (bot and scanner clicks never emit). */
  link_clicked: { url: string; dispatchId: string; broadcastId: string; linkTargetId: string };
  email_opened: { dispatchId: string; broadcastId: string };
  /** A signed-in reader was shown the Gate on a Dispatch page. */
  gate_hit: { dispatchId: string };
  /** No human open or click for `days` days; emitted by the daily unengaged check. */
  unengaged: { days: number };
  /** Phase 7 public API: POST /v2/members/:id/events. */
  api_event: { name: string; properties?: Record<string, string | number | boolean | null> };
  roster_joined: { rosterId: string; source: string };
  roster_left: { rosterId: string; source: string };
  /** Never the referred Member's address: this payload is copied into run context and webhooks. */
  referral_succeeded: { referralId: string };
  referral_milestone: { milestoneId: string; awardId: string };
}

// ---------------------------------------------------------------------------------------------
// Triggers

/** Trigger types are member event types, minus email_opened (only waits listen for it). */
export const FLOW_TRIGGER_TYPES = [
  'member_joined',
  'form_submitted',
  'confirmed',
  'circle_entered',
  'circle_exited',
  'tag_added',
  'tag_removed',
  'field_changed',
  'level_purchased',
  'level_canceled',
  'ask_answered',
  'unengaged',
  'link_clicked',
  'gate_hit',
  'api_event',
  /** Rosters (Phase 8, flag rosters): saving or publishing one needs the flag. */
  'roster_joined',
  'roster_left',
  'referral_succeeded',
  'referral_milestone',
] as const satisfies readonly MemberEventType[];
export const FlowTriggerTypeSchema = z.enum(FLOW_TRIGGER_TYPES).openapi('FlowTriggerType');
export type FlowTriggerType = z.infer<typeof FlowTriggerTypeSchema>;

export const API_EVENT_NAME = /^[a-z][a-z0-9_.]{0,59}$/;

/**
 * Trigger config. Every trigger also takes an optional enrolment `filter` (a Circle rule the
 * Member must match when the event is processed).
 */
const triggerBase = { filter: CircleRuleSchema.optional() };
export const FlowTriggerConfigSchema = z
  .discriminatedUnion('event', [
    z.object({
      event: z.literal('member_joined'),
      /** Only sign-ups through this form; any source when omitted. */
      formId: id('captureForm').optional(),
      /** Imported Members enrol only when true (an import should not flood a welcome Flow). */
      includeImports: z.boolean().default(false),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('form_submitted'),
      formId: id('captureForm').optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('confirmed'),
      formId: id('captureForm').optional(),
      ...triggerBase,
    }),
    z.object({ event: z.literal('circle_entered'), circleId: id('circle'), ...triggerBase }),
    z.object({ event: z.literal('circle_exited'), circleId: id('circle'), ...triggerBase }),
    z.object({ event: z.literal('tag_added'), tagId: id('tag'), ...triggerBase }),
    z.object({ event: z.literal('tag_removed'), tagId: id('tag'), ...triggerBase }),
    z.object({ event: z.literal('field_changed'), fieldId: id('memberField'), ...triggerBase }),
    /** Any paid level when levelId is omitted. */
    z.object({
      event: z.literal('level_purchased'),
      levelId: id('membershipLevel').optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('level_canceled'),
      levelId: id('membershipLevel').optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('ask_answered'),
      askId: id('ask'),
      /** Only this answer; any answer when omitted. */
      optionId: id('askOption').optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('unengaged'),
      days: z.number().int().min(7).max(365),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('link_clicked'),
      /** Any Dispatch when omitted. */
      dispatchId: id('dispatch').optional(),
      /** This link, by its address or its short link; any link when omitted. */
      url: z.url().max(2000).optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('gate_hit'),
      dispatchId: id('dispatch').optional(),
      ...triggerBase,
    }),
    z.object({
      event: z.literal('api_event'),
      name: z.string().regex(API_EVENT_NAME),
      ...triggerBase,
    }),
    /** Any change source (form, Member Center, operator, import, API, unsubscribe link). */
    z.object({ event: z.literal('roster_joined'), rosterId: id('roster'), ...triggerBase }),
    z.object({ event: z.literal('roster_left'), rosterId: id('roster'), ...triggerBase }),
    /** A referral counted: the referred Member confirmed and opened an email, or it was approved. */
    z.object({ event: z.literal('referral_succeeded'), ...triggerBase }),
    /** Any milestone when milestoneId is omitted. */
    z.object({
      event: z.literal('referral_milestone'),
      milestoneId: id('championMilestone').optional(),
      ...triggerBase,
    }),
  ])
  .openapi('FlowTriggerConfig');
export type FlowTriggerConfig = z.infer<typeof FlowTriggerConfigSchema>;

/**
 * The trigger node's config: its first start event, and the others in `alsoStartOn`. Each has its
 * own `filter`. A graph saved before there could be several simply has no `alsoStartOn`, so old
 * drafts and published versions read as they are.
 */
const FlowTriggerNodeConfigSchema = FlowTriggerConfigSchema.and(
  z.object({
    alsoStartOn: z
      .array(FlowTriggerConfigSchema)
      .max(FLOW_MAX_TRIGGERS - 1)
      .optional(),
  }),
);
type FlowTriggerNodeConfig = z.infer<typeof FlowTriggerNodeConfigSchema>;

// ---------------------------------------------------------------------------------------------
// Actions
const FLOW_ACTION_TYPES = [
  'send_email',
  'delay',
  'add_tag',
  'remove_tag',
  'update_field',
  'change_level',
  'enrol_flow',
  'branch',
  'ab_split',
  'wait_for_event',
  'webhook_call',
  'notify_author',
  'exit',
] as const;
const FLOW_NODE_TYPES = ['trigger', ...FLOW_ACTION_TYPES] as const;
export const FlowNodeTypeSchema = z.enum(FLOW_NODE_TYPES).openapi('FlowNodeType');
export type FlowNodeType = z.infer<typeof FlowNodeTypeSchema>;

const FLOW_EDGE_LABELS = ['default', 'true', 'false', 'a', 'b', 'timeout'] as const;
export const FlowEdgeLabelSchema = z.enum(FLOW_EDGE_LABELS).openapi('FlowEdgeLabel');
export type FlowEdgeLabel = z.infer<typeof FlowEdgeLabelSchema>;

/** The outcomes (edge labels) each node type can produce. */
export const FLOW_NODE_OUTPUTS: Record<FlowNodeType, readonly FlowEdgeLabel[]> = {
  trigger: ['default'],
  send_email: ['default'],
  delay: ['default'],
  add_tag: ['default'],
  remove_tag: ['default'],
  update_field: ['default'],
  change_level: ['default'],
  enrol_flow: ['default'],
  branch: ['true', 'false'],
  ab_split: ['a', 'b'],
  /** default: the event happened before the timeout. */
  wait_for_event: ['default', 'timeout'],
  webhook_call: ['default'],
  notify_author: ['default'],
  exit: [],
};
const DelayConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('duration'),
    amount: z.number().int().min(1),
    unit: z.enum(['minutes', 'hours', 'days']),
  }),
  z.object({
    /** Waits until the next listed weekday at `time` (HH:MM, 24 h). */
    mode: z.literal('until'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /**
     * 'member': the Member's `timezone` profile field when it holds a valid IANA zone, else the
     * Channel's settings timezone, else UTC. Otherwise an IANA zone name.
     */
    timezone: z.string().min(1).max(64),
  }),
]);

const FlowActionConfigSchemas = {
  /**
   * A Dispatch of kind 'flow' in the same Channel. `audience` re-checks paid access before the
   * send: 'paid' exits with not_entitled when the Member has no current entitlement; 'free'
   * exits with already_paid when they do (for upsells). Each node's dispatchId is unique.
   */
  send_email: z.object({
    dispatchId: id('dispatch'),
    audience: z.enum(['any', 'paid', 'free']).default('any'),
    /**
     * Inbox rules never hold this email (it still counts toward the limit). When omitted, the
     * first email after someone confirms or joins is exempt (defaultSendRegardless).
     */
    sendRegardless: z.boolean().optional(),
  }),
  delay: DelayConfigSchema,
  add_tag: z.object({ tagId: id('tag') }),
  remove_tag: z.object({ tagId: id('tag') }),
  /** `value` is validated against the field's type at save and at run time (normalizeFieldValue). */
  update_field: z.object({ fieldId: id('memberField'), value: z.unknown() }),
  /** grant: a comp grant (comp_grants + member_subscriptions) for `days` (no end when null). */
  change_level: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('grant'),
      levelId: id('membershipLevel'),
      days: z.number().int().min(1).max(3650).nullable(),
    }),
    /** Revokes comp grants this Flow made (never a Stripe subscription). */
    z.object({ action: z.literal('revoke'), levelId: id('membershipLevel') }),
  ]),
  /** Another live Flow of the same Channel, never this one. Enrols as of now; no wait. */
  enrol_flow: z.object({ flowId: id('flow') }),
  /** A Circle-style condition evaluated live against the Member (not a saved Circle). */
  branch: z.object({ condition: CircleRuleSchema }),
  /**
   * Share of runs that take edge 'a'; the choice is deterministic per run id. With
   * `autoPromote`, the daily promoteWelcomeSplits job compares the send_email nodes directly
   * behind 'a' and 'b' on the live version once both have `minPerVariant` delivered messages and
   * the version has been live `afterHours`, and publishes a new version where the split is
   * replaced by a direct edge to the winner (the losing branch is dropped).
   */
  ab_split: z.object({
    percentA: z.number().int().min(1).max(99),
    autoPromote: z
      .object({
        metric: z.enum(['opens', 'clicks']),
        minPerVariant: z.number().int().min(1).max(100_000).default(100),
        afterHours: z.number().int().min(1).max(720).default(24),
      })
      .optional(),
  }),
  wait_for_event: z.object({
    event: z.enum(['open', 'click']),
    /** The send_email node whose email is watched; the most recent one sent when omitted. */
    sendNodeId: FlowNodeIdSchema.optional(),
    /** For 'click': only this link, by its address or its short link; any link when omitted. */
    url: z.url().max(2000).optional(),
    timeoutHours: z
      .number()
      .int()
      .min(1)
      .max(FLOW_MAX_DELAY_DAYS * 24),
  }),
  /**
   * POST JSON `{ flowId, runId, nodeId, member: { id, email, firstName, lastName, fields? } }`
   * signed with HMAC-SHA256 (header `Swarm-Signature: t=<unix>,v1=<hex>`, over `<t>.<body>`)
   * using the Flow's webhook secret. https only; private and link-local hosts are refused.
   */
  webhook_call: z.object({
    url: z
      .url()
      .max(2000)
      .refine((u) => u.startsWith('https://'), 'Webhook URLs must use https.'),
    includeFields: z.boolean().default(false),
  }),
  /** Emails the Channel's owners and admins (or the listed operators) a plain notice. */
  notify_author: z.object({
    message: z.string().trim().min(1).max(500),
    operatorIds: z.array(id('operator')).max(20).optional(),
  }),
  exit: z.object({}),
} as const;

const position = z.object({ x: z.number(), y: z.number() }).optional();
const node = <T extends FlowNodeType, C extends z.ZodType>(type: T, config: C) =>
  z.object({
    id: FlowNodeIdSchema,
    type: z.literal(type),
    config,
    /** Builder layout only; the engine ignores it. */
    position,
    /** Optional label shown on the canvas. */
    name: z.string().trim().max(80).optional(),
  });

export const FlowNodeSchema = z
  .discriminatedUnion('type', [
    node('trigger', FlowTriggerNodeConfigSchema),
    node('send_email', FlowActionConfigSchemas.send_email),
    node('delay', FlowActionConfigSchemas.delay),
    node('add_tag', FlowActionConfigSchemas.add_tag),
    node('remove_tag', FlowActionConfigSchemas.remove_tag),
    node('update_field', FlowActionConfigSchemas.update_field),
    node('change_level', FlowActionConfigSchemas.change_level),
    node('enrol_flow', FlowActionConfigSchemas.enrol_flow),
    node('branch', FlowActionConfigSchemas.branch),
    node('ab_split', FlowActionConfigSchemas.ab_split),
    node('wait_for_event', FlowActionConfigSchemas.wait_for_event),
    node('webhook_call', FlowActionConfigSchemas.webhook_call),
    node('notify_author', FlowActionConfigSchemas.notify_author),
    node('exit', FlowActionConfigSchemas.exit),
  ])
  .openapi('FlowNode');
export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type FlowNodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;

export const FlowEdgeSchema = z
  .object({
    from: FlowNodeIdSchema,
    to: FlowNodeIdSchema,
    label: FlowEdgeLabelSchema.default('default'),
  })
  .openapi('FlowEdge');
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

const FlowGraphShape = z.object({
  schema: z.literal(FLOW_GRAPH_SCHEMA_VERSION),
  nodes: z.array(FlowNodeSchema).min(1).max(FLOW_MAX_NODES),
  edges: z.array(FlowEdgeSchema).max(FLOW_MAX_EDGES),
});
export type FlowGraph = z.infer<typeof FlowGraphShape>;
/**
 * The graph's shape without the structural checks: drafts are saved with issues (returned by
 * the API as `issues`, from validateFlowGraph); publishing requires FlowGraphSchema.
 */
export const FlowGraphDraftSchema = FlowGraphShape.openapi('FlowGraphDraft');

/**
 * Builder steps that are not set up yet, saved beside the draft so leaving the page keeps them.
 * Their config is not validated (it is what the inspector has so far); `edges` are the ones that
 * touch at least one pending step. The engine never reads this, and publishing refuses while any
 * pending step remains.
 */
export const FlowDraftPendingSchema = z
  .object({
    nodes: z
      .array(
        z.object({
          id: FlowNodeIdSchema,
          type: FlowNodeTypeSchema,
          config: z.record(z.string(), z.unknown()),
          position,
          name: z.string().trim().max(80).optional(),
        }),
      )
      .max(FLOW_MAX_NODES),
    edges: z.array(FlowEdgeSchema).max(FLOW_MAX_EDGES),
  })
  .refine((value) => JSON.stringify(value).length <= 64 * 1024, 'Pending steps are too large.')
  .openapi('FlowDraftPending');
export type FlowDraftPending = z.infer<typeof FlowDraftPendingSchema>;

// ---------------------------------------------------------------------------------------------
// Validation

export interface FlowGraphIssue {
  /** A stable code the builder can map to copy. */
  code:
    | 'trigger_count'
    | 'duplicate_trigger'
    | 'duplicate_node'
    | 'unknown_node'
    | 'self_loop'
    | 'edge_into_trigger'
    | 'bad_label'
    | 'duplicate_label'
    | 'cycle'
    | 'unreachable'
    | 'duplicate_email'
    | 'bad_wait_source'
    | 'delay_too_long';
  message: string;
  /** The node (or edge source) the issue is shown on. */
  nodeId?: string;
}

function delayMs(config: z.infer<typeof DelayConfigSchema>): number | null {
  if (config.mode !== 'duration') return null;
  const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[config.unit];
  return config.amount * unit;
}

/** A start event's settings in a stable order, without the other start events. */
function triggerKey(config: FlowTriggerConfig): string {
  const entries = Object.entries(config).filter(([key]) => key !== 'alsoStartOn');
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function triggerConfigs(config: FlowTriggerNodeConfig): FlowTriggerConfig[] {
  const { alsoStartOn, ...first } = config;
  return [first as FlowTriggerConfig, ...(alsoStartOn ?? [])];
}

/** Structural checks on a parsed graph. An empty list means the graph can be published. */
export function validateFlowGraph(graph: FlowGraph): FlowGraphIssue[] {
  const issues: FlowGraphIssue[] = [];
  const byId = new Map<string, FlowNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) {
      issues.push({
        code: 'duplicate_node',
        message: `Two nodes share the id ${n.id}.`,
        nodeId: n.id,
      });
    }
    byId.set(n.id, n);
  }
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    issues.push({
      code: 'trigger_count',
      message: 'An automation starts with exactly one trigger.',
    });
  }

  for (const trigger of triggers) {
    const seen = new Set<string>();
    for (const config of triggerConfigs(trigger.config)) {
      const key = triggerKey(config);
      if (seen.has(key)) {
        issues.push({
          code: 'duplicate_trigger',
          message: 'Two start events are the same.',
          nodeId: trigger.id,
        });
        break;
      }
      seen.add(key);
    }
  }

  const out = new Map<string, string[]>();
  const seenLabels = new Set<string>();
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      issues.push({
        code: 'unknown_node',
        message: 'An edge points at a node that does not exist.',
        ...(from ? { nodeId: e.from } : {}),
      });
      continue;
    }
    if (e.from === e.to) {
      issues.push({ code: 'self_loop', message: 'A step cannot lead to itself.', nodeId: e.from });
      continue;
    }
    if (to.type === 'trigger') {
      issues.push({
        code: 'edge_into_trigger',
        message: 'Nothing can lead into the trigger.',
        nodeId: e.to,
      });
    }
    if (!FLOW_NODE_OUTPUTS[from.type].includes(e.label)) {
      issues.push({
        code: 'bad_label',
        message: `A ${from.type} step has no "${e.label}" outcome.`,
        nodeId: e.from,
      });
    }
    const key = `${e.from}\u0000${e.label}`;
    if (seenLabels.has(key)) {
      issues.push({
        code: 'duplicate_label',
        message: `The "${e.label}" outcome is connected twice.`,
        nodeId: e.from,
      });
    }
    seenLabels.add(key);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }

  // Cycles: iterative three-colour DFS over every node.
  const colour = new Map<string, 0 | 1 | 2>();
  for (const start of byId.keys()) {
    if (colour.get(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    colour.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const children = out.get(top.id) ?? [];
      if (top.next < children.length) {
        const child = children[top.next++]!;
        const c = colour.get(child) ?? 0;
        if (c === 1) {
          issues.push({ code: 'cycle', message: 'Steps cannot loop back.', nodeId: child });
          return issues;
        }
        if (c === 0) {
          colour.set(child, 1);
          stack.push({ id: child, next: 0 });
        }
      } else {
        colour.set(top.id, 2);
        stack.pop();
      }
    }
  }

  // Reachability from the trigger.
  const trigger = triggers[0];
  if (trigger) {
    const reached = new Set([trigger.id]);
    const queue = [trigger.id];
    while (queue.length) {
      for (const next of out.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    for (const n of graph.nodes) {
      if (!reached.has(n.id)) {
        issues.push({
          code: 'unreachable',
          message: 'This step can never be reached.',
          nodeId: n.id,
        });
      }
    }
  }

  const emails = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type === 'send_email') {
      if (emails.has(n.config.dispatchId)) {
        issues.push({
          code: 'duplicate_email',
          message: 'Each email step needs its own email.',
          nodeId: n.id,
        });
      }
      emails.add(n.config.dispatchId);
    }
    if (n.type === 'wait_for_event' && n.config.sendNodeId) {
      if (byId.get(n.config.sendNodeId)?.type !== 'send_email') {
        issues.push({
          code: 'bad_wait_source',
          message: 'Wait for an email step in this automation.',
          nodeId: n.id,
        });
      }
    }
    if (n.type === 'delay') {
      const ms = delayMs(n.config);
      if (ms !== null && ms > FLOW_MAX_DELAY_DAYS * 86_400_000) {
        issues.push({
          code: 'delay_too_long',
          message: `Delays are at most ${FLOW_MAX_DELAY_DAYS} days.`,
          nodeId: n.id,
        });
      }
    }
  }
  return issues;
}

/** The graph schema with structural validation; use it for every graph the API accepts. */
export const FlowGraphSchema = FlowGraphShape.superRefine((graph, ctx) => {
  for (const issue of validateFlowGraph(graph)) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      params: { flowIssue: issue.code, ...(issue.nodeId ? { nodeId: issue.nodeId } : {}) },
    });
  }
}).openapi('FlowGraph', { type: 'object', description: 'A versioned Flow graph' });

/** A new Flow's draft: a lone trigger waiting for configuration is not valid, so start here. */
export function emptyFlowGraph(trigger: FlowTriggerConfig): FlowGraph {
  return {
    schema: FLOW_GRAPH_SCHEMA_VERSION,
    nodes: [{ id: 'trigger', type: 'trigger', config: trigger }],
    edges: [],
  };
}

export function triggerOf(graph: FlowGraph): FlowNodeOf<'trigger'> | undefined {
  return graph.nodes.find((n): n is FlowNodeOf<'trigger'> => n.type === 'trigger');
}

/**
 * Every start event of a graph, in order: the position is the trigger index in run contexts and
 * stats. Empty when the graph has no trigger node.
 */
export function triggersOf(graph: FlowGraph): FlowTriggerConfig[] {
  const trigger = triggerOf(graph);
  return trigger ? triggerConfigs(trigger.config) : [];
}

/**
 * The event types beyond the first start event's, deduplicated: what flows.extra_trigger_types and
 * flow_versions.extra_trigger_types hold. Null when there are none.
 */
export function extraTriggerTypes(graph: FlowGraph): FlowTriggerType[] | null {
  const [first, ...rest] = triggersOf(graph).map((t) => t.event);
  const extra = [...new Set(rest)].filter((event) => event !== first);
  return extra.length ? extra : null;
}

/** The node an outcome leads to, or undefined when the run ends there. */
export function nextNodeId(
  graph: FlowGraph,
  from: string,
  label: FlowEdgeLabel,
): string | undefined {
  return graph.edges.find((e) => e.from === from && e.label === label)?.to;
}

// ---------------------------------------------------------------------------------------------
// Referenced ids (the same-Channel check)

export interface FlowReferencedIds {
  circles: string[];
  tags: string[];
  levels: string[];
  dispatches: string[];
  forms: string[];
  flows: string[];
  fields: string[];
  asks: string[];
  askOptions: string[];
  operators: string[];
  rosters: string[];
  milestones: string[];
  /** Profile field keys used in Circle conditions (`field:<key>`), resolved per Channel. */
  fieldKeys: string[];
}

function ruleRefs(
  rule: CircleRule,
  into: Record<'circles' | 'levels' | 'forms' | 'fieldKeys', Set<string>>,
) {
  if ('op' in rule) {
    for (const child of rule.children) ruleRefs(child, into);
    return;
  }
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (rule.field.startsWith('field:')) into.fieldKeys.add(rule.field.slice('field:'.length));
  else if (rule.field === 'form_id') strings.forEach((v) => into.forms.add(v));
  // Reserved Phase 6 leaves (see p6-growth.ts, SMART_BLOCK_LEAF_FIELDS).
  else if (rule.field === 'circle') strings.forEach((v) => into.circles.add(v));
  else if (rule.field === 'level') strings.forEach((v) => into.levels.add(v));
}

/**
 * Every id the graph refers to, by kind, deduplicated. Tags in Circle conditions are names
 * (resolved per Channel by the compiler), so only node-level tag ids are listed.
 */
export function collectReferencedIds(graph: FlowGraph): FlowReferencedIds {
  const s = {
    circles: new Set<string>(),
    tags: new Set<string>(),
    levels: new Set<string>(),
    dispatches: new Set<string>(),
    forms: new Set<string>(),
    flows: new Set<string>(),
    fields: new Set<string>(),
    asks: new Set<string>(),
    askOptions: new Set<string>(),
    operators: new Set<string>(),
    rosters: new Set<string>(),
    milestones: new Set<string>(),
    fieldKeys: new Set<string>(),
  };
  for (const n of graph.nodes) {
    switch (n.type) {
      case 'trigger': {
        for (const c of triggerConfigs(n.config)) {
          if (c.filter) ruleRefs(c.filter, s);
          if ('formId' in c && c.formId) s.forms.add(c.formId);
          if ('circleId' in c) s.circles.add(c.circleId);
          if ('tagId' in c) s.tags.add(c.tagId);
          if ('fieldId' in c) s.fields.add(c.fieldId);
          if ('levelId' in c && c.levelId) s.levels.add(c.levelId);
          if ('askId' in c) s.asks.add(c.askId);
          if ('optionId' in c && c.optionId) s.askOptions.add(c.optionId);
          if ('dispatchId' in c && c.dispatchId) s.dispatches.add(c.dispatchId);
          if ('rosterId' in c) s.rosters.add(c.rosterId);
          if ('milestoneId' in c && c.milestoneId) s.milestones.add(c.milestoneId);
        }
        break;
      }
      case 'send_email':
        s.dispatches.add(n.config.dispatchId);
        break;
      case 'add_tag':
      case 'remove_tag':
        s.tags.add(n.config.tagId);
        break;
      case 'update_field':
        s.fields.add(n.config.fieldId);
        break;
      case 'change_level':
        s.levels.add(n.config.levelId);
        break;
      case 'enrol_flow':
        s.flows.add(n.config.flowId);
        break;
      case 'branch':
        ruleRefs(n.config.condition, s);
        break;
      case 'notify_author':
        n.config.operatorIds?.forEach((o) => s.operators.add(o));
        break;
      default:
        break;
    }
  }
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, [...v].sort()]),
  ) as unknown as FlowReferencedIds;
}

// ---------------------------------------------------------------------------------------------
// Flows and runs

const FLOW_STATUSES = ['draft', 'live', 'paused', 'archived'] as const;
export const FlowStatusSchema = z.enum(FLOW_STATUSES).openapi('FlowStatus');
export type FlowStatus = z.infer<typeof FlowStatusSchema>;

export const FLOW_REENTRY = ['never', 'after_exit'] as const;
export type FlowReentry = (typeof FLOW_REENTRY)[number];

/**
 * running: a step is queued or executing; waiting: parked on a delay or wait (next_at set);
 * paused: a step failed FLOW_STEP_MAX_ATTEMPTS times or the Flow was paused (exit_reason holds
 * why: step_failed or flow_paused); completed: ran off the end of the graph; exited: stopped
 * early (exit_reason); failed: abandoned by an operator after a pause, or unrecoverable.
 */
export const FLOW_RUN_STATUSES = [
  'running',
  'waiting',
  'paused',
  'completed',
  'exited',
  'failed',
] as const;
export const FlowRunStatusSchema = z.enum(FLOW_RUN_STATUSES).openapi('FlowRunStatus');
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;
const FLOW_EXIT_REASONS = [
  /** Reached an exit node. */
  'exit_node',
  /** recheckBeforeSend: status is no longer active (unsubscribed, bounced, complained, paused, pending). */
  'member_inactive',
  /** recheckBeforeSend: the address is in suppressions. */
  'suppressed',
  /** recheckBeforeSend: a send_email node with audience 'paid' and no current entitlement. */
  'not_entitled',
  /** recheckBeforeSend: a send_email node with audience 'free' and a current entitlement. */
  'already_paid',
  /** A referenced id no longer belongs to the Channel (deleted or tampered with). */
  'invalid_reference',
  /** The Flow was archived, or the operator stopped the run. */
  'flow_archived',
  'operator',
  /** Moved to a newer version by the operator; a new run continues. */
  'migrated',
  /** Inbox rules held the email past the Channel's maxHoldDays, so it was not sent. */
  'hold_expired',
  /** Paused-run reasons (status paused). */
  'step_failed',
  'flow_paused',
] as const;
export const FlowExitReasonSchema = z.enum(FLOW_EXIT_REASONS).openapi('FlowExitReason');
export type FlowExitReason = z.infer<typeof FlowExitReasonSchema>;

const FLOW_STEP_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export const FlowStepStatusSchema = z.enum(FLOW_STEP_STATUSES).openapi('FlowStepStatus');
/**
 * Why a start event did not start a run (flow_enrol_decisions.reason). A start event that did start
 * one is a flow_runs row, so it is not recorded twice.
 */
export const FLOW_ENROL_DECISIONS = [
  /** The start event's filter is "in this Circle", and the Member wasn't. */
  'not_in_segment',
  /** Any other filter that the Member didn't match. */
  'filter_miss',
  /** They have an open run of this Flow. */
  'already_in',
  /** Re-entry 'never': they already ran the version that is live now. */
  'already_ran_version',
  /** Re-entry 'never': they ran an earlier version. */
  'already_ran_earlier',
  /** Re-entry on, and FLOW_REENTRY_MAX_PER_HOUR runs started in the last hour. */
  'rate_limited',
] as const;
export const FlowEnrolDecisionSchema = z.enum(FLOW_ENROL_DECISIONS).openapi('FlowEnrolDecision');
export type FlowEnrolDecision = z.infer<typeof FlowEnrolDecisionSchema>;

/** flow_runs.wait_json while a wait_for_event node is parked. */
export interface FlowRunWait {
  node: string;
  event: 'open' | 'click';
  broadcastId: string;
  url?: string;
  /** ms; the timeout edge is taken after this. */
  until: number;
}

/** flow_runs.context_json. */
export interface FlowRunContext {
  /**
   * The enrolling event's payload, for webhook bodies and later conditions. `index` is the start
   * event that let them in (triggersOf); runs from before there could be several have none, and
   * count as the first.
   */
  trigger?: { type: MemberEventType; payload: unknown; seq: number | null; index?: number };
  /** Flow emails sent in this run: node id → broadcast id. */
  sent?: Record<string, string>;
  /** The send_email node most recently sent (default source for wait_for_event). */
  lastSendNodeId?: string;
}
