// The engagement score: how much a Member has been reading lately, from human opens and clicks.
import { z } from '@hono/zod-openapi';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });

export const ENGAGEMENT_BANDS = [
  'very_engaged',
  'engaged',
  'slipping',
  'cold',
  /** Fewer than ENGAGEMENT_MIN_SENT posts reached them in the window. */
  'too_few_posts',
  /** Their mail app or a privacy proxy opens everything, so opens say nothing about them. */
  'opens_hidden',
] as const;
const EngagementBandSchema = z.enum(ENGAGEMENT_BANDS).openapi('EngagementBand');
export type EngagementBand = z.infer<typeof EngagementBandSchema>;

export const MemberEngagementSchema = z
  .object({
    /** 0 to 100, or null when the band is too_few_posts or opens_hidden. */
    score: z.number().int().min(0).max(100).nullable(),
    band: EngagementBandSchema,
    /** Posts that reached them in the last 90 days. */
    sentCount: z.number().int(),
    /** Of those, opened by a person. Machine opens are not counted. */
    openedCount: z.number().int(),
    /** Of those, with a link clicked by a person. Link scanners are not counted. */
    clickedCount: z.number().int(),
    lastEngagedAt: timestamp.nullable(),
    computedAt: timestamp,
  })
  .openapi('MemberEngagement');
export type MemberEngagement = z.infer<typeof MemberEngagementSchema>;

export const EngagementSummarySchema = z
  .object({
    bands: z.object(
      Object.fromEntries(ENGAGEMENT_BANDS.map((band) => [band, z.number().int()])) as Record<
        EngagementBand,
        z.ZodNumber
      >,
    ),
    computedAt: timestamp.nullable(),
  })
  .openapi('EngagementSummary');
export type EngagementSummary = z.infer<typeof EngagementSummarySchema>;
