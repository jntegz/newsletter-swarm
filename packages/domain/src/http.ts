import { z } from '@hono/zod-openapi';

/** Every error code the API can return. Map these to copy in the dashboard, never show raw messages. */
export const ERROR_CODES = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  /** /v2: the key or token lacks the route's scope. */
  insufficient_scope: 403,
  /** The session has a first factor only; finish the second factor first. */
  mfa_required: 401,
  /** The workspace's plan does not include this. */
  plan_required: 403,
  not_found: 404,
  conflict: 409,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  feature_disabled: 404,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      requestId: z.string(),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  })
  .openapi('ErrorEnvelope');

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export const CursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
