// Circles: saved rule trees over a Channel's Members, materialised by the jobs worker (Phase 3).
import { z } from '@hono/zod-openapi';
import { CircleRuleSchema, MemberSchema } from './audience';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

const CIRCLE_STATUSES = ['pending', 'refreshing', 'ready', 'failed'] as const;
const CircleStatusSchema = z.enum(CIRCLE_STATUSES).openapi('CircleStatus');
export type CircleStatus = z.infer<typeof CircleStatusSchema>;

export const CircleSchema = z
  .object({
    id: id('circle'),
    channelId: id('channel'),
    name: z.string(),
    description: z.string().nullable(),
    rule: CircleRuleSchema,
    /** Members in the Circle at the last evaluation, any status. */
    memberCount: z.number().int(),
    /** pending until the jobs worker has evaluated the current rule. */
    status: CircleStatusSchema,
    evaluatedAt: timestamp.nullable(),
    /** Why the last evaluation failed, when status is failed. */
    error: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('Circle');
export type Circle = z.infer<typeof CircleSchema>;

/** A Circle in the Channel's list, with how many of its Members are active right now. */
export const CircleListItemSchema = CircleSchema.extend({
  /** Of memberCount, the Members active now: who a send to the Circle would reach. */
  activeCount: z.number().int(),
}).openapi('CircleListItem');
export type CircleListItem = z.infer<typeof CircleListItemSchema>;

const CircleNameSchema = z.string().trim().min(1, 'Name the segment.').max(80);
const CircleDescriptionSchema = z.string().trim().max(280).nullable();

export const CreateCircleSchema = z
  .object({
    name: CircleNameSchema,
    description: CircleDescriptionSchema.optional(),
    rule: CircleRuleSchema,
  })
  .openapi('CreateCircle');
export type CreateCircle = z.infer<typeof CreateCircleSchema>;

export const UpdateCircleSchema = z
  .object({
    name: CircleNameSchema.optional(),
    description: CircleDescriptionSchema.optional(),
    /** Changing the rule re-evaluates the Circle. */
    rule: CircleRuleSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateCircle');
export type UpdateCircle = z.infer<typeof UpdateCircleSchema>;

export const CirclePreviewRequestSchema = z
  .object({ rule: CircleRuleSchema })
  .openapi('CirclePreviewRequest');
export const CIRCLE_SAMPLE_SIZE = 25;

/** A live evaluation of a rule, saved or not. */
export const CirclePreviewSchema = z
  .object({
    /** Members matching the rule, any status. */
    count: z.number().int(),
    /** Of those, the active ones: who a send to this Circle would reach before suppressions. */
    activeCount: z.number().int(),
    /** Up to 25 matching Members, newest first. */
    sample: z.array(MemberSchema),
  })
  .openapi('CirclePreview');
export type CirclePreview = z.infer<typeof CirclePreviewSchema>;
