import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@swarm/domain';
import type { Context, Env as HonoEnv, Hono, Schema } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { EnvError, type Environment } from './env';
import { createLogger, type Logger } from './log';

export interface RuntimeVariables {
  requestId: string;
  log: Logger;
}

interface WorkerOptions<E> {
  /** Service name for logs and /healthz, e.g. "api". */
  service: string;
  /** The parser returned by defineEnv. Called on every request; cached per isolate. */
  parseEnv: (env: unknown) => E & { ENVIRONMENT: Environment };
  /** Serve /.well-known/security.txt (public-facing workers). */
  securityTxt?: boolean;
}

const SECURITY_TXT = [
  'Contact: https://github.com/jntegz/newsletter-swarm/security/advisories/new',
  'Expires: 2027-10-27T00:00:00.000Z',
  'Preferred-Languages: en',
  'Policy: https://github.com/jntegz/newsletter-swarm/blob/main/docs/disclosure.md',
  '',
].join('\n');

/** How long /healthz waits for the vault's ping. */
const VAULT_PING_MS = 3_000;

/** True or false for a worker with a VAULT binding (its ping answered); null without one. */
async function vaultReachable(env: unknown): Promise<boolean | null> {
  const binding = (env as { VAULT?: { ping?: () => Promise<unknown> } } | undefined)?.VAULT;
  if (!binding || typeof binding.ping !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = (await Promise.race([
      // Called on the binding itself: an RPC stub's method doesn't work detached from it.
      binding.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), VAULT_PING_MS);
      }),
    ])) as { ok?: unknown } | undefined;
    return answer?.ok === true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  details?: { path: string; message: string }[],
): Response {
  const body: ErrorEnvelope = {
    error: { code, message, requestId: (c.get('requestId') as string | undefined) ?? 'unknown' },
  };
  if (details) body.error.details = details;
  return c.json(body, ERROR_CODES[code] as ContentfulStatusCode);
}

/**
 * Installs the baseline every worker shares: request ids, structured logs, env validation
 * (fail closed), security headers, JSON error envelope, /healthz and optionally security.txt.
 * Call before mounting routes.
 */
export function useRuntime<
  E,
  H extends HonoEnv & { Variables: RuntimeVariables },
  S extends Schema,
  B extends string,
>(target: Hono<H, S, B>, options: WorkerOptions<E>): void {
  // Works for plain Hono and OpenAPIHono apps alike; the middleware only touches RuntimeVariables.
  const app = target as unknown as Hono<{ Variables: RuntimeVariables }>;

  app.use('*', async (c, next) => {
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('log', createLogger({ service: options.service, requestId }));
    c.header('x-request-id', requestId);
    await next();
  });

  app.use('*', async (c, next) => {
    options.parseEnv(c.env);
    await next();
  });

  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'DENY',
      crossOriginResourcePolicy: 'same-origin',
    }),
  );

  app.get('/healthz', async (c) => {
    const env = options.parseEnv(c.env);
    // A worker bound to the vault (workers/vault) is healthy only while the vault answers through
    // that binding: without it, encrypted data can be neither shown nor saved (fail closed).
    const vault = await vaultReachable(c.env);
    if (vault === false) {
      return errorResponse(c, 'unavailable', 'The vault does not answer through this worker.');
    }
    return c.json({
      data: {
        ok: true,
        service: options.service,
        environment: env.ENVIRONMENT,
        time: new Date().toISOString(),
        ...(vault ? { vault: 'ok' as const } : {}),
      },
    });
  });

  if (options.securityTxt) {
    app.get('/.well-known/security.txt', (c) =>
      c.text(SECURITY_TXT, 200, { 'cache-control': 'public, max-age=86400' }),
    );
  }

  app.notFound((c) => errorResponse(c, 'not_found', 'Not found.'));

  app.onError((err, c) => {
    const log = (c.get('log') as Logger | undefined) ?? createLogger({ service: options.service });
    if (err instanceof ApiError) return errorResponse(c, err.code, err.message, err.details);
    if (err instanceof ZodError) {
      return errorResponse(
        c,
        'invalid_input',
        'Some fields are not valid.',
        err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    if (err instanceof EnvError) {
      log.error('worker environment is invalid', { problems: err.problems });
      return errorResponse(c, 'unavailable', 'This service is not configured.');
    }
    if (err instanceof HTTPException && err.status < 500) {
      const code = (Object.entries(ERROR_CODES).find(([, status]) => status === err.status)?.[0] ??
        'invalid_input') as ErrorCode;
      return errorResponse(c, code, err.message || 'Request rejected.');
    }
    log.error('unhandled error', { error: err.message, stack: err.stack });
    return errorResponse(c, 'internal', 'Something went wrong on our side.');
  });
}
