// The Direct Send API (Phase 7): one email to one Member, outside Broadcasts. POST
// /v2/channels/{channelId}/sends (scope sends:write), paid plans only. Contract:
// docs/direct-send.md. Table: direct_sends (0012, 0014).
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/**
 * transactional: something the Member asked for (a receipt, a sign-in code). No unsubscribe
 * headers; suppression still applies. one_off: a single non-transactional message; it needs an
 * active Member and carries List-Unsubscribe and One-Click (RFC 8058) like every Broadcast.
 */
const DIRECT_SEND_KINDS = ['transactional', 'one_off'] as const;
export type DirectSendKind = (typeof DIRECT_SEND_KINDS)[number];

export const DIRECT_SEND_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'failed',
] as const;
export type DirectSendStatus = (typeof DIRECT_SEND_STATUSES)[number];
/** Per-send variables: `{{ var.name }}` in the subject and body. */
export const DIRECT_SEND_VARIABLE = /\{\{\s*var\.([a-z][a-z0-9_]{0,39})\s*\}\}/g;
const DIRECT_SEND_MAX_VARIABLES = 50;

export const CreateDirectSendSchema = z
  .object({
    kind: z.enum(DIRECT_SEND_KINDS),
    /** The recipient: a Member of this Channel, by id or by address. */
    to: z.union([
      z.object({ memberId: id('member') }).strict(),
      z.object({ email: z.email().max(254) }).strict(),
    ]),
    /** The body: a Template of the Channel or the workspace, or a Dispatch of the Channel. */
    templateId: id('template').optional(),
    dispatchId: id('dispatch').optional(),
    variables: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(2000))
      .refine((v) => Object.keys(v).length <= DIRECT_SEND_MAX_VARIABLES, {
        message: `Up to ${DIRECT_SEND_MAX_VARIABLES} variables.`,
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (!!input.templateId === !!input.dispatchId) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'Give either templateId or dispatchId.',
      });
    }
  })
  .openapi('CreateDirectSend');
export const DirectSendSchema = z
  .object({
    id: id('directSend'),
    channelId: id('channel'),
    /** null once the Member has been deleted. */
    memberId: z.string().nullable(),
    kind: z.enum(DIRECT_SEND_KINDS),
    templateId: z.string().nullable(),
    dispatchId: z.string().nullable(),
    status: z.enum(DIRECT_SEND_STATUSES),
    /** For 'suppressed': 'address_suppressed' or 'member_not_active'; for 'failed': the provider's reason. */
    error: z.string().nullable(),
    createdAt: timestamp,
    sentAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .openapi('DirectSend');
export type DirectSend = z.infer<typeof DirectSendSchema>;

export const DirectSendListQuerySchema = z.object({
  cursor: id('directSend').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(DIRECT_SEND_STATUSES).optional(),
});

/** Counts by status per UTC day, newest first, for the dashboard. */
export const DirectSendStatsSchema = z
  .object({
    days: z.array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        counts: z.record(z.enum(DIRECT_SEND_STATUSES), z.number().int()),
        total: z.number().int(),
      }),
    ),
    /** Sends counted against today's limit, and the limit (0 on plans without Direct Send). */
    today: z.object({ used: z.number().int(), limit: z.number().int() }),
  })
  .openapi('DirectSendStats');
export type DirectSendStats = z.infer<typeof DirectSendStatsSchema>;
