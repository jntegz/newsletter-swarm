import { OpenAPIHono } from '@hono/zod-openapi';
import type { MfaMethod, SecondFactorState } from '@swarm/domain';
import type { RuntimeVariables } from '@swarm/runtime';
import type { Context } from 'hono';
import type { CredentialPrincipal } from '@swarm/vault';
import { parseApiEnv, type ApiEnv } from '../env';
import type { ApiPrincipal } from '../v2/context';

export interface AuthContext {
  operatorId: string;
  email: string;
  sessionId: string;
  tokenHash: string;
  /** Phase 7: 'ok', or the second-factor step this session still owes (lib/session.ts). */
  secondFactor: SecondFactorState;
  mfaMethod: MfaMethod | null;
  mfaVerifiedAt: number | null;
  /** A workspace this session may not enter: its enforced SSO captures the operator's domain. */
  ssoBlockedWorkspaceId: string | null;
  /**
   * Set while a session that came through SSO has not proved a factor of the operator's own: the
   * only workspace it may enter, its connection's (docs/security.md "SSO").
   */
  ssoWorkspaceId: string | null;
}

export interface AppEnv {
  Bindings: Record<string, unknown>;
  Variables: RuntimeVariables & {
    auth: AuthContext | null;
    /** /v2 only: the key or OAuth token behind the request. */
    principal: ApiPrincipal | null;
    /**
     * The raw credential behind the request (session cookie, API key or OAuth token), for the
     * vault, which resolves it itself (lib/vault.ts). Unset on a request without one.
     */
    credential: CredentialPrincipal | null;
  };
}

export type AppContext = Context<AppEnv>;

export function env(c: AppContext): ApiEnv {
  return parseApiEnv(c.env);
}

export function clientIp(c: AppContext): string | undefined {
  return c.req.header('cf-connecting-ip') ?? undefined;
}

/** Every router shares one validation hook, so invalid input always uses the error envelope. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
}
