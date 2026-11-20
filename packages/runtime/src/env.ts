import { z } from 'zod';

const EnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Fields every worker has. Extend this with the worker's own vars, secrets and bindings. */
export const BaseEnvSchema = z.object({
  ENVIRONMENT: EnvironmentSchema,
});

/** A secret value. 32 characters minimum; there is never a default. */
export const secret = () => z.string().min(32, 'must be at least 32 characters');

/** A Cloudflare binding (D1, KV, R2, Queue…). Validated for presence only. */
export const binding = <T>() =>
  z.custom<T>((value) => typeof value === 'object' && value !== null, 'binding is missing');

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid worker environment: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

/**
 * The committed .dev.vars.example keys say this, and they are long enough to pass as real ones. Its
 * Ed25519 keys can't say it (they are base64url), so their key id is `dev0`, which the installer
 * never makes (it makes k<yyyymmdd>).
 */
const PLACEHOLDER = /development-only|replace-before|before-using-this-file|(?:^|,)\s*dev0:/;

/** Deployed workers must not run on a key anyone can read in the repository. */
function placeholderProblems(schema: z.ZodObject, env: unknown): string[] {
  if (typeof env !== 'object' || env === null) return [];
  const values = env as Record<string, unknown>;
  if (values.ENVIRONMENT !== 'staging' && values.ENVIRONMENT !== 'production') return [];
  return Object.keys(schema.shape)
    .filter((key) => typeof values[key] === 'string' && PLACEHOLDER.test(values[key]))
    .map((key) => `${key}: is the placeholder from .dev.vars.example; generate a real key`);
}

/**
 * Builds a parser that validates a worker's env once per isolate. Missing or invalid values
 * fail closed: the worker refuses requests and logs which keys are wrong, never their values.
 */
export function defineEnv<S extends z.ZodObject>(schema: S) {
  const cache = new WeakMap<object, z.infer<S>>();
  return (env: unknown): z.infer<S> => {
    if (typeof env === 'object' && env !== null) {
      const cached = cache.get(env);
      if (cached) return cached;
    }
    const result = schema.safeParse(env);
    const problems = [
      ...(result.success
        ? []
        : result.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )),
      ...placeholderProblems(schema, env),
    ];
    if (!result.success || problems.length > 0) throw new EnvError(problems);
    if (typeof env === 'object' && env !== null) cache.set(env, result.data);
    return result.data;
  };
}

/**
 * Whether a request reached this worker on a name only a local run has: localhost, a loopback
 * address, or a name under the reserved `.localhost` and `.test` domains (RFC 6761). Cloudflare
 * never routes such a name to a deployed Worker, so development-only routes and fakes check this
 * as well as ENVIRONMENT: a script uploaded with development settings by mistake keeps them shut.
 */
export function localRequest(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}
