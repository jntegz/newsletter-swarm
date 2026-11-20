import { z } from '@hono/zod-openapi';
import { ErrorEnvelopeSchema, dataEnvelope, type ErrorCode } from '@swarm/domain';

const ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unsupported_media_type: 415,
  rate_limited: 429,
};

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});

export const ok = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema: dataEnvelope(schema) } },
});

export const noContent = { description: 'Done, no content' };

/** Documents the error responses a route can produce. */
export function errors(...codes: ErrorCode[]) {
  return Object.fromEntries(
    codes
      .filter((code) => ERROR_STATUS[code])
      .map((code) => [
        ERROR_STATUS[code] as number,
        { description: code, content: { 'application/json': { schema: ErrorEnvelopeSchema } } },
      ]),
  );
}

export const idParam = <K extends string>(name: K, pattern: RegExp) =>
  z.object({
    [name]: z
      .string()
      .regex(pattern)
      .openapi({ param: { name, in: 'path' } }),
  } as { [P in K]: z.ZodString });
