// Request and response schemas for the Flows API and the Template Library (Phase 6). The graph,
// run and trigger types they use live in p6-flows.ts; recipes in p6-flow-recipes.ts.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { FlowNodeHeldSchema, FlowRunHoldSchema } from './flow-inbox-rules';
import {
  FLOW_MAX_NODES,
  FLOW_REENTRY,
  FlowDraftPendingSchema,
  FlowEnrolDecisionSchema,
  FlowExitReasonSchema,
  FlowGraphDraftSchema,
  FlowNodeIdSchema,
  FlowRunStatusSchema,
  FlowStatusSchema,
  FlowStepStatusSchema,
  FlowTriggerConfigSchema,
  FlowTriggerTypeSchema,
} from './p6-flows';
import { FLOW_RECIPES, TEMPLATE_KINDS } from './p6-growth';
import {
  BroadcastStatsSchema,
  CoverImageInputSchema,
  CoverImageRefSchema,
  DispatchDocumentSchema,
} from './send';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Flows

const FlowRecipeSchema = z.enum(FLOW_RECIPES).openapi('FlowRecipe');
const FlowReentrySchema = z.enum(FLOW_REENTRY).openapi('FlowReentry');

/** A structural problem in a draft graph (validateFlowGraph). Publishing needs none. */
const FlowGraphIssueSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    nodeId: z.string().optional(),
  })
  .openapi('FlowGraphIssue');

const FlowRunCountsSchema = z
  .object({
    running: z.number().int(),
    waiting: z.number().int(),
    paused: z.number().int(),
    completed: z.number().int(),
    exited: z.number().int(),
    failed: z.number().int(),
  })
  .openapi('FlowRunCounts', { description: 'Runs by status, test runs excluded' });
export type FlowRunCounts = z.infer<typeof FlowRunCountsSchema>;

export const FlowSummarySchema = z
  .object({
    id: id('flow'),
    channelId: id('channel'),
    name: z.string(),
    description: z.string().nullable(),
    status: FlowStatusSchema,
    recipe: FlowRecipeSchema.nullable(),
    liveVersion: z.number().int().nullable(),
    /** The live version's first start event. */
    triggerType: FlowTriggerTypeSchema.nullable(),
    /** Every event type that starts the live version; empty until it is published. */
    triggerTypes: z.array(FlowTriggerTypeSchema),
    reentry: FlowReentrySchema,
    runs: FlowRunCountsSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('FlowSummary');
export type FlowSummary = z.infer<typeof FlowSummarySchema>;

const FlowVersionSchema = z
  .object({
    version: z.number().int(),
    triggerType: FlowTriggerTypeSchema,
    triggerTypes: z.array(FlowTriggerTypeSchema),
    publishedBy: id('operator').nullable(),
    publishedAt: timestamp,
    retiredAt: timestamp.nullable(),
  })
  .openapi('FlowVersion');

export const FlowEmailSchema = z
  .object({
    dispatchId: id('dispatch'),
    subject: z.string(),
    preheader: z.string(),
    /** The draft graph's send_email nodes that use it (one, or none while unused). */
    nodeIds: z.array(z.string()),
    updatedAt: timestamp,
  })
  .openapi('FlowEmail');
export const FlowSchema = FlowSummarySchema.extend({
  draftGraph: FlowGraphDraftSchema,
  /** Steps saved before they were set up (not part of `draftGraph`); null when there are none. */
  draftPending: FlowDraftPendingSchema.nullable(),
  /** Structural problems in the draft; empty when it can be published. */
  issues: z.array(FlowGraphIssueSchema),
  versions: z.array(FlowVersionSchema),
  emails: z.array(FlowEmailSchema),
  /** Whether a webhook signing secret exists (the secret itself is shown once, on rotation). */
  webhookSecretSet: z.boolean(),
}).openapi('Flow');
export type Flow = z.infer<typeof FlowSchema>;

/**
 * Either a recipe (a ready graph with its Flow emails written) or a blank Flow with a trigger.
 * The name defaults to the recipe's.
 */
export const CreateFlowSchema = z
  .object({
    recipe: FlowRecipeSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(280).optional(),
    trigger: FlowTriggerConfigSchema.optional(),
    reentry: FlowReentrySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.recipe === !value.trigger) {
      ctx.addIssue({
        code: 'custom',
        path: ['trigger'],
        message: 'Start from a recipe or choose a trigger, not both.',
      });
    }
    if (!value.recipe && !value.name) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Name the automation.' });
    }
  })
  .openapi('CreateFlow');
export type CreateFlow = z.infer<typeof CreateFlowSchema>;

export const UpdateFlowSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(280).nullable().optional(),
    /**
     * The draft graph. Saved with structural issues (returned in `issues`); refused when it
     * refers to anything outside the Flow's Channel.
     */
    draftGraph: FlowGraphDraftSchema.optional(),
    /** Steps not set up yet; null or an empty list clears them. */
    draftPending: FlowDraftPendingSchema.nullable().optional(),
    reentry: FlowReentrySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateFlow');
export type UpdateFlow = z.infer<typeof UpdateFlowSchema>;

export const PublishFlowSchema = z
  .object({
    /**
     * Move open runs of earlier versions onto the new one (each exits with 'migrated' and
     * continues at the node with the same id). Default: runs finish on their own version.
     */
    migrateRuns: z.boolean().default(false),
    /**
     * Email steps of the draft whose email may go again to Members who already got it. Default: a
     * Member who got a step's email in an earlier version doesn't get it from the new one.
     */
    resendNodeIds: z.array(FlowNodeIdSchema).max(FLOW_MAX_NODES).default([]),
  })
  .openapi('PublishFlow');

export const PublishFlowResultSchema = z
  .object({
    flow: FlowSchema,
    version: z.number().int(),
    /** The Flow Broadcast frozen for each send_email node of the new version. */
    emails: z.array(
      z.object({ nodeId: z.string(), dispatchId: id('dispatch'), broadcastId: id('broadcast') }),
    ),
  })
  .openapi('PublishFlowResult');

export const FlowTestRunSchema = z
  .object({ memberId: id('member') })
  .openapi('FlowTestRun', { description: 'A Member of the Flow’s Channel' });

/** Which start event started a run. Null for test runs and for enrolment by a step or the API. */
const FlowRunStartSchema = z
  .object({
    /** Position in the version's start events (triggersOf). */
    index: z.number().int(),
    event: FlowTriggerTypeSchema,
    /** The event's ids and names that a trigger can select on, such as tagId. Never member data. */
    details: z.record(z.string(), z.union([z.string(), z.number()])),
  })
  .openapi('FlowRunStart');
export type FlowRunStart = z.infer<typeof FlowRunStartSchema>;

export const FlowRunSchema = z
  .object({
    id: id('flowRun'),
    flowId: id('flow'),
    version: z.number().int(),
    memberId: id('member'),
    memberEmail: z.string().nullable(),
    status: FlowRunStatusSchema,
    exitReason: FlowExitReasonSchema.nullable(),
    currentNodeId: z.string().nullable(),
    nextAt: timestamp.nullable(),
    /** Set while an inbox rule holds the run's email. */
    hold: FlowRunHoldSchema.nullable(),
    test: z.boolean(),
    startedBy: FlowRunStartSchema.nullable(),
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp.nullable(),
  })
  .openapi('FlowRun');
export type FlowRun = z.infer<typeof FlowRunSchema>;

const FlowRunStepSchema = z
  .object({
    nodeId: z.string(),
    attempt: z.number().int(),
    status: FlowStepStatusSchema,
    outcome: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .openapi('FlowRunStep');

export const FlowRunDetailSchema = FlowRunSchema.extend({
  steps: z.array(FlowRunStepSchema),
  /** Every step inbox rules held in this run, released or not. */
  holds: z.array(FlowRunHoldSchema),
}).openapi('FlowRunDetail');

export const FlowRunListQuerySchema = z.object({
  status: FlowRunStatusSchema.optional(),
  version: z.coerce.number().int().min(1).optional(),
  /** The last run id of the previous page. */
  cursor: z.string().regex(idPattern('flowRun')).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const FlowRunPageSchema = z
  .object({ items: z.array(FlowRunSchema), nextCursor: z.string().nullable() })
  .openapi('FlowRunPage');

export const FlowStatsQuerySchema = z.object({
  /** Defaults to the live version (or the newest one). */
  version: z.coerce.number().int().min(1).optional(),
});

const FlowNodeStatsSchema = z
  .object({
    nodeId: z.string(),
    type: z.string(),
    /** Runs that reached the node. */
    entered: z.number().int(),
    /** Runs whose step at the node finished (done or skipped). */
    completed: z.number().int(),
    /** Runs that ended (status exited) at the node. */
    exited: z.number().int(),
    /** Runs whose step at the node failed. */
    failed: z.number().int(),
    /** For send_email nodes: what inbox rules held. Zeros for every other node. */
    held: FlowNodeHeldSchema,
    /** For send_email nodes: the Flow Broadcast's metrics. */
    email: BroadcastStatsSchema.extend({ broadcastId: id('broadcast') }).nullable(),
  })
  .openapi('FlowNodeStats');

const FlowEdgeStatsSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    label: z.string(),
    /** Runs that took this edge out of `from`. */
    runs: z.number().int(),
    /** Share of the runs that entered `from` that did not take this edge (0–1). */
    dropOff: z.number(),
  })
  .openapi('FlowEdgeStats');

const FlowTriggerStatsSchema = z
  .object({
    /** Position in the version's start events. */
    index: z.number().int(),
    config: FlowTriggerConfigSchema,
    /** Runs this start event started. */
    runs: z.number().int(),
  })
  .openapi('FlowTriggerStats');

export const FlowStatsSchema = z
  .object({
    version: z.number().int().nullable(),
    /** One entry per start event of the version. */
    triggers: z.array(FlowTriggerStatsSchema),
    nodes: z.array(FlowNodeStatsSchema),
    edges: z.array(FlowEdgeStatsSchema),
  })
  .openapi('FlowStats', { description: 'Per-node and per-edge numbers; test runs excluded' });
export type FlowStats = z.infer<typeof FlowStatsSchema>;

/**
 * One live Flow as seen from one Member: their latest run, if any, and the latest start event that
 * didn't let them in, if any came after it. Both null: no start event has been recorded for them.
 */
export const MemberFlowHistorySchema = z
  .object({
    flowId: id('flow'),
    flowName: z.string(),
    run: z
      .object({
        id: id('flowRun'),
        version: z.number().int(),
        status: FlowRunStatusSchema,
        exitReason: FlowExitReasonSchema.nullable(),
        startedBy: FlowRunStartSchema.nullable(),
        /** Emails of this run that reached the Member (sent and not bounced). */
        emailsReceived: z.number().int(),
        /** Emails they could have had on the path they took, counting what was still ahead. */
        emailsPossible: z.number().int(),
        startedAt: timestamp,
        endedAt: timestamp.nullable(),
      })
      .nullable(),
    decision: z
      .object({
        reason: FlowEnrolDecisionSchema,
        version: z.number().int(),
        event: FlowTriggerTypeSchema,
        decidedAt: timestamp,
      })
      .nullable(),
  })
  .openapi('MemberFlowHistory');
export type MemberFlowHistory = z.infer<typeof MemberFlowHistorySchema>;

export const FlowWebhookSecretSchema = z
  .object({
    secret: z.string().openapi({
      description: 'Shown once. Signs webhook_call requests (Swarm-Signature header).',
    }),
  })
  .openapi('FlowWebhookSecret');

export const FlowRecipeInfoSchema = z
  .object({
    key: FlowRecipeSchema,
    name: z.string(),
    description: z.string(),
    triggerType: FlowTriggerTypeSchema,
    emailCount: z.number().int(),
  })
  .openapi('FlowRecipeInfo');

export const CreateFlowEmailSchema = z
  .object({
    subject: z.string().trim().max(200).optional(),
    preheader: z.string().trim().max(200).optional(),
    content: DispatchDocumentSchema.optional(),
  })
  .openapi('CreateFlowEmail');

// ---------------------------------------------------------------------------------------------
// Template Library

const TemplateKindSchema = z.enum(TEMPLATE_KINDS).openapi('TemplateKind');

export const TemplateSummarySchema = z
  .object({
    id: id('template'),
    workspaceId: id('workspace'),
    /** Null: shared with every Channel of the workspace. */
    channelId: id('channel').nullable(),
    name: z.string(),
    description: z.string().nullable(),
    kind: TemplateKindSchema,
    subject: z.string(),
    preheader: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('TemplateSummary');
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

export const TemplateSchema = TemplateSummarySchema.extend({
  content: DispatchDocumentSchema,
  coverImage: CoverImageRefSchema.nullable(),
}).openapi('Template');
export type Template = z.infer<typeof TemplateSchema>;

export const TemplateListQuerySchema = z.object({
  /** Also list this Channel's own templates (workspace-wide ones are always listed). */
  channelId: z.string().regex(idPattern('channel')).optional(),
});

export const CreateTemplateSchema = z
  .object({
    /** Omit or null for a workspace-wide template. */
    channelId: id('channel').nullable().optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).optional(),
    /** 'design' needs the design_templates flag. */
    kind: TemplateKindSchema.default('dispatch'),
    subject: z.string().trim().max(200).default(''),
    preheader: z.string().trim().max(200).default(''),
    content: DispatchDocumentSchema,
    coverImage: CoverImageInputSchema.nullable().optional(),
  })
  .openapi('CreateTemplate');

export const UpdateTemplateSchema = z
  .object({
    /** Null shares it with every Channel of the workspace; a Channel id keeps it to that one. */
    channelId: id('channel').nullable().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(280).nullable().optional(),
    subject: z.string().trim().max(200).optional(),
    preheader: z.string().trim().max(200).optional(),
    content: DispatchDocumentSchema.optional(),
    coverImage: CoverImageInputSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateTemplate');

const IMPORT_HTML_MAX = 50_000;

export const ImportTemplateSchema = z
  .object({
    channelId: id('channel').nullable().optional(),
    name: z.string().trim().min(1).max(80).default('Imported template'),
    /** The email HTML; the body is kept as one raw HTML block (sending needs raw_html_mode). */
    html: z.string().min(1).max(IMPORT_HTML_MAX),
  })
  .openapi('ImportTemplate');

export const UseTemplateSchema = z
  .object({ channelId: id('channel') })
  .openapi('UseTemplate', { description: 'The Channel the new draft Dispatch is created in' });

export const SaveAsTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).optional(),
    /** Share with every Channel of the workspace (editor role on the workspace). */
    shared: z.boolean().default(false),
  })
  .openapi('SaveAsTemplate');
