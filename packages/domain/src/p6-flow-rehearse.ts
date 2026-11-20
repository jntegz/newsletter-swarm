// Rehearse and Add people for Flows: request and response schemas. A rehearsal answers "what would
// happen to this Member?" without changing anything; Add people starts real runs for a selection,
// after showing who gets in and who doesn't.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { BulkSelectionSchema } from './p3-members';
import {
  FLOW_ENROL_DECISIONS,
  FlowEdgeLabelSchema,
  FlowEnrolDecisionSchema,
  FlowExitReasonSchema,
  FlowNodeTypeSchema,
} from './p6-flows';
import { INBOX_HOLD_REASONS } from './flow-inbox-rules';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Who may enter

/**
 * What the enrolment rules say about one Member and one Flow, when someone adds them by hand. 'enter'
 * lets them in. The next three can't be mailed. The rest are the words Why already uses for a start
 * event that didn't start a run (FlowEnrolDecision).
 */
const FLOW_ENROL_VERDICTS = [
  'enter',
  'unsubscribed',
  'suppressed',
  'not_active',
  ...FLOW_ENROL_DECISIONS,
] as const;
const FlowEnrolVerdictSchema = z.enum(FLOW_ENROL_VERDICTS).openapi('FlowEnrolVerdict');
export type FlowEnrolVerdict = z.infer<typeof FlowEnrolVerdictSchema>;

// ---------------------------------------------------------------------------------------------
// Rehearse

/** Most Members rehearsed at once from a Circle. */
export const FLOW_REHEARSAL_MAX_SAMPLE = 10;

const FlowRehearsalAnswerSchema = z.enum(['yes', 'no', 'a', 'b']);
export type FlowRehearsalAnswer = z.infer<typeof FlowRehearsalAnswerSchema>;

export const FlowRehearseSchema = z
  .object({
    /** The draft being edited, or the live version. */
    source: z.enum(['draft', 'live']),
    /** Rehearse one Member of the Channel. */
    memberId: id('member').optional(),
    /** Or a random sample of a Circle. */
    circleId: id('circle').optional(),
    /** Which start event to imagine, by its place in the list. The first one when left out. */
    startEvent: z.number().int().min(0).optional(),
    /** What a rehearsal can't know, by node: 'yes' / 'no' for a wait, 'a' / 'b' for a split. */
    answers: z.record(z.string(), FlowRehearsalAnswerSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.memberId === !value.circleId) {
      ctx.addIssue({
        code: 'custom',
        path: ['memberId'],
        message: 'Choose a subscriber or a segment.',
      });
    }
  })
  .openapi('FlowRehearse');
export type FlowRehearse = z.infer<typeof FlowRehearseSchema>;

/** One condition of a branch, and whether it holds for this Member. */
const FlowRehearsalConditionSchema = z
  .object({
    field: z.string(),
    cmp: z.string(),
    value: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number()])),
        z.null(),
      ])
      .optional(),
    holds: z.boolean(),
  })
  .openapi('FlowRehearsalCondition');
export type FlowRehearsalCondition = z.infer<typeof FlowRehearsalConditionSchema>;

/**
 * What held an email back: the inbox rules, a paused publication, or the warm-up. Paused ones come
 * back when someone resumes them, which a rehearsal can't date, so it assumes they do.
 */
const FLOW_REHEARSAL_HOLDS = [
  ...INBOX_HOLD_REASONS,
  'channel_paused',
  'ramp_full',
  'ramp_paused',
] as const;
const FlowRehearsalHoldSchema = z
  .object({
    reason: z.enum(FLOW_REHEARSAL_HOLDS),
    /** When the email would look again; null when only someone resuming it can say. */
    until: timestamp.nullable(),
    /** The wait would pass the longest hold, so the email is never sent. */
    expired: z.boolean(),
    /** The time zone the rule read the clock in, when it is an inbox rule. */
    zone: z.string().nullable(),
  })
  .openapi('FlowRehearsalHold');
export type FlowRehearsalHold = z.infer<typeof FlowRehearsalHoldSchema>;

const FlowRehearsalDetailSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('start') }),
    z.object({
      kind: z.literal('email'),
      /**
       * would_send: it goes out. already_sent: they had it from this version. already_received: they
       * had it from another version. not_sent: the run stops here (see the run's end).
       */
      state: z.enum(['would_send', 'already_sent', 'already_received', 'not_sent']),
      /** As this Member would see it, merge tags filled in. Empty when it can't be told. */
      subject: z.string(),
      previewText: z.string(),
      /** Every wait before it could go, in order. */
      holds: z.array(FlowRehearsalHoldSchema),
    }),
    z.object({
      kind: z.literal('delay'),
      /** When the wait ends; null when the moment has already come. */
      until: timestamp.nullable(),
    }),
    z.object({
      kind: z.literal('wait'),
      event: z.enum(['open', 'click']),
      url: z.string().nullable(),
      /** When the wait gives up. */
      until: timestamp,
      /**
       * assumed: the writer's answer decided it. already: they did it before this run. no_email:
       * no email reached them on this path, so it can only time out.
       */
      basis: z.enum(['assumed', 'already', 'no_email']),
      answer: z.enum(['yes', 'no']),
    }),
    z.object({
      kind: z.literal('branch'),
      matched: z.boolean(),
      /** The conditions that decided it; empty when there are too many to look at one by one. */
      because: z.array(FlowRehearsalConditionSchema),
    }),
    z.object({
      kind: z.literal('split'),
      arm: z.enum(['a', 'b']),
      percentA: z.number().int(),
      /** True when the writer picked the arm; otherwise it was drawn the way a run draws it. */
      picked: z.boolean(),
    }),
    z.object({ kind: z.literal('tag'), action: z.enum(['add', 'remove']), tagId: z.string() }),
    z.object({ kind: z.literal('field'), fieldId: z.string() }),
    z.object({
      kind: z.literal('level'),
      action: z.enum(['grant', 'revoke']),
      levelId: z.string(),
      unavailable: z.boolean(),
    }),
    z.object({
      kind: z.literal('enrol'),
      flowId: z.string(),
      /** would_start, or why not: unavailable, not_live or one of the enrolment verdicts. */
      result: z.string(),
    }),
    z.object({ kind: z.literal('webhook'), url: z.string() }),
    z.object({ kind: z.literal('notify'), message: z.string() }),
    z.object({ kind: z.literal('exit') }),
  ])
  .openapi('FlowRehearsalDetail');
export type FlowRehearsalDetail = z.infer<typeof FlowRehearsalDetailSchema>;

const FlowRehearsalStepSchema = z
  .object({
    nodeId: z.string(),
    type: FlowNodeTypeSchema,
    /** As a real run's step would finish. */
    status: z.enum(['done', 'skipped', 'failed']),
    /** The edge it leaves by; null when the run ends here. */
    outcome: FlowEdgeLabelSchema.nullable(),
    /** When it would finish, if the rehearsal started now and every wait took its full time. */
    at: timestamp,
    detail: FlowRehearsalDetailSchema,
  })
  .openapi('FlowRehearsalStep');
export type FlowRehearsalStep = z.infer<typeof FlowRehearsalStepSchema>;

const FlowRehearsalSchema = z
  .object({
    member: z.object({
      id: id('member'),
      email: z.string(),
      status: z.string(),
    }),
    /** Whether the imagined start event would let them in today. The steps show what follows anyway. */
    entry: z.object({
      allowed: z.boolean(),
      /** The start event that would start the run; several can match one event. */
      startEvent: z.number().int().nullable(),
      /** Why not, in the words Why uses; null when allowed, or when there is nothing to tell. */
      reason: FlowEnrolDecisionSchema.nullable(),
    }),
    steps: z.array(FlowRehearsalStepSchema),
    end: z.object({
      /** completed: ran off the end. exited: stopped early. paused: a step can't go on. */
      status: z.enum(['completed', 'exited', 'paused']),
      reason: FlowExitReasonSchema.nullable(),
      /** The step's own words when it can't go on (a value that doesn't fit, no webhook secret). */
      problem: z.string().nullable(),
    }),
  })
  .openapi('FlowRehearsal');
export type FlowRehearsal = z.infer<typeof FlowRehearsalSchema>;

export const FlowRehearsalResultSchema = z
  .object({
    source: z.enum(['draft', 'live']),
    version: z.number().int().nullable(),
    /** The Flow's status now: anything but live means nobody really enters today. */
    flowStatus: z.enum(['draft', 'live', 'paused', 'archived']),
    /** Draft steps not set up yet: a rehearsal can't include them. */
    pendingSteps: z.number().int(),
    /** Set when rehearsing a sample: how many Members the Circle holds. */
    circleSize: z.number().int().nullable(),
    people: z.array(FlowRehearsalSchema),
  })
  .openapi('FlowRehearsalResult');
export type FlowRehearsalResult = z.infer<typeof FlowRehearsalResultSchema>;

// ---------------------------------------------------------------------------------------------
// Add people

export const FlowEnrolPreviewRequestSchema = z
  .object({ selection: BulkSelectionSchema })
  .openapi('FlowEnrolPreviewRequest');

export const FlowEnrolPreviewSchema = z
  .object({
    version: z.number().int(),
    /** Members in the selection. */
    total: z.number().int(),
    /** How many would start a run. */
    entering: z.number().int(),
    /** Everyone else, by why they are left out. Only reasons with at least one Member. */
    skipped: z.array(
      z.object({ reason: FlowEnrolVerdictSchema.exclude(['enter']), count: z.number().int() }),
    ),
  })
  .openapi('FlowEnrolPreview');
export type FlowEnrolPreview = z.infer<typeof FlowEnrolPreviewSchema>;

export const FlowEnrolStartSchema = z
  .object({
    selection: BulkSelectionSchema,
    /** The `entering` number the operator confirmed. A different number now answers 409. */
    confirmCount: z.number().int().min(1),
  })
  .openapi('FlowEnrolStart');
export type FlowEnrolStart = z.infer<typeof FlowEnrolStartSchema>;
