// In-process /v2 requests for Open Operator (docs/open-operator.md): a tool call or an approved
// call runs as a real /v2 request through the app's router, so the route's own scope, Channel and
// validation checks apply. The request carries the already-resolved principal instead of a
// secret: authenticateV2 takes it from here, keyed by the Request object, which only code inside
// this worker can hold. Such requests skip the rate limiter (the /mcp request was counted).
import type { CredentialPrincipal } from '@swarm/vault';
import type { AppContext } from '../lib/context';
import type { ApiPrincipal } from './context';

const principals = new WeakMap<Request, ApiPrincipal>();
/** The outer request's own credential, carried to the vault (lib/vault.ts) unchanged. */
const credentials = new WeakMap<Request, CredentialPrincipal>();
const approvers = new WeakMap<Request, string>();

type Fetcher = (
  request: Request,
  env: AppContext['env'],
  ctx: AppContext['executionCtx'] | undefined,
) => Response | Promise<Response>;
let appFetch: Fetcher | null = null;

/** Called once by createApp with the app's own fetch. */
export function registerInternalFetch(fetcher: Fetcher): void {
  appFetch = fetcher;
}

/** The principal of an in-process request, or null for a request from outside. */
export const internalPrincipal = (request: Request): ApiPrincipal | null =>
  principals.get(request) ?? null;

/** The credential of the request an in-process request was made from (session, key or token). */
export const internalCredential = (request: Request): CredentialPrincipal | null =>
  credentials.get(request) ?? null;

/** For an in-process request that runs an approved agent call: the operator who approved it. */
export const internalApprover = (request: Request): string | null => approvers.get(request) ?? null;

/** Runs `method path` on /v2 as `principal`, from inside a request handled by this worker. */
export async function internalV2Fetch(
  c: AppContext,
  principal: ApiPrincipal,
  input: {
    method: string;
    path: string;
    body: unknown;
    idempotencyKey?: string | undefined;
    approvedBy?: string | undefined;
  },
): Promise<Response> {
  if (!appFetch) throw new Error('internal /v2 dispatch is not registered');
  if (!input.path.startsWith('/v2/')) throw new Error('internal dispatch only reaches /v2');
  const url = new URL(input.path, c.req.url);
  // The prefix check above holds only for the path as given: dot segments ('..', '%2e%2e')
  // would resolve to somewhere else, so the path must already be in its resolved form.
  if (`${url.pathname}${url.search}` !== input.path) {
    throw new Error('internal dispatch path must already be normalised');
  }
  const headers = new Headers({ accept: 'application/json' });
  const ip = c.req.header('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  if (input.idempotencyKey) headers.set('idempotency-key', input.idempotencyKey);
  let body: string | null = null;
  if (input.body !== null && input.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(input.body);
  }
  const request = new Request(url, {
    method: input.method,
    headers,
    body,
  });
  principals.set(request, principal);
  // Copilot and MCP tools reach the vault with their caller's own credential, never a stronger one.
  const credential = c.get('credential');
  if (credential) credentials.set(request, credential);
  if (input.approvedBy) approvers.set(request, input.approvedBy);
  let ctx: AppContext['executionCtx'] | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  return appFetch(request, c.env, ctx);
}
