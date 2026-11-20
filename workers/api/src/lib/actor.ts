// Who is making a change, for writes shared by the dashboard (/api/v1, a teammate's session) and
// the public API (/v2, a key or OAuth token). Shared write helpers take an Actor instead of a
// session, so both surfaces run the same code and audit the same way.
import type { SeatRole } from '@swarm/domain';
import type { AuditInput } from './audit';
import { clientIp, type AppContext, type AuthContext } from './context';
import { ipPrefix } from './crypto';
import type { ApiPrincipal } from '../v2/context';

export interface Actor {
  workspaceId: string;
  /** The teammate, or null when an API key or OAuth app acts (then `via` says which). */
  operatorId: string | null;
  /** Their address, for defaults like "send the test to me"; null for API callers. */
  email: string | null;
  /**
   * The role checks run against. API callers are limited by scopes instead, checked before the
   * route runs, so they act with the editor role on the Channels they may reach.
   */
  role: SeatRole;
  via: { kind: ApiPrincipal['kind']; id: string } | null;
  ipPrefix: string | null;
}

export function sessionActor(
  c: AppContext,
  access: { workspaceId: string; role: SeatRole; auth: AuthContext },
): Actor {
  return {
    workspaceId: access.workspaceId,
    operatorId: access.auth.operatorId,
    email: access.auth.email,
    role: access.role,
    via: null,
    ipPrefix: ipPrefix(clientIp(c)),
  };
}

/**
 * A /v2 caller. Copilot actions (kind `copilot`) act as the operator who asked, with their own
 * role, and still record `via` so the audit entry shows it went through Copilot.
 */
export function apiActor(c: AppContext, principal: ApiPrincipal): Actor {
  const copilot = principal.kind === 'copilot';
  return {
    workspaceId: principal.workspaceId,
    operatorId: copilot ? principal.id : null,
    email: null,
    role: copilot ? (principal.role ?? 'viewer') : 'editor',
    via: { kind: principal.kind, id: principal.id },
    ipPrefix: ipPrefix(clientIp(c)),
  };
}

/** An audit entry by this actor; API calls record the key or token in `metadata.via`. */
export function actorAudit(
  actor: Actor,
  entry: Omit<AuditInput, 'workspaceId' | 'actorId' | 'ipPrefix'>,
): AuditInput {
  const metadata = actor.via ? { ...entry.metadata, via: actor.via } : entry.metadata;
  return {
    ...entry,
    ...(metadata ? { metadata } : {}),
    workspaceId: actor.workspaceId,
    actorId: actor.operatorId,
    ipPrefix: actor.ipPrefix,
  };
}
