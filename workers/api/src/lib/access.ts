import { channelAccess, roleAtLeast, workspaceRole, type ChannelAccess } from '@swarm/db';
import type { SeatRole, SecondFactorState } from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { ApiError } from '@swarm/runtime';
import { env, type AppContext, type AuthContext } from './context';

/**
 * A signed-in session that has finished sign-in, second factor included. A session that still
 * owes a second factor gets 401 mfa_required everywhere except the routes that call
 * requireSignedIn (the second-factor steps, sign-out and GET /api/v1/auth/session).
 */
export function requireAuth(c: AppContext): AuthContext {
  const auth = requireSignedIn(c);
  if (auth.secondFactor !== 'ok') {
    throw new ApiError(
      'mfa_required',
      auth.secondFactor === 'enroll'
        ? 'Set up a second factor to continue.'
        : 'Confirm it is you with your second factor to continue.',
    );
  }
  return auth;
}

/** A session with at least a first factor, in one of the given second-factor states. */
export function requireSignedIn(
  c: AppContext,
  allowed: readonly SecondFactorState[] = ['ok', 'verify', 'enroll'],
): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw new ApiError('unauthorized', 'Sign in to continue.');
  if (!allowed.includes(auth.secondFactor)) {
    throw new ApiError('mfa_required', 'Confirm it is you with your second factor to continue.');
  }
  return auth;
}

/** The sso flag, at platform scope: sign-in happens before any workspace is known. */
export async function ssoEnabled(c: AppContext): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('sso', {});
}

/**
 * What a session may reach in a workspace beyond its role, checked on every path that grants
 * workspace authority (requireWorkspace, requireChannel, routePolicy and the routes that read a
 * role directly). `role` is the operator's seat role in that workspace.
 *
 * - A session that came through an identity provider and has not proved a factor of the
 *   operator's own reaches only its connection's workspace: the provider speaks for its own
 *   workspace, not for seats the operator holds elsewhere.
 * - Enforced SSO: a session that did not come through the workspace's connection can't enter it.
 *   Owners are exempt, so a broken identity provider can't lock everyone out of the workspace.
 *   While the sso flag is off nobody can sign in through a connection, so enforcing one would
 *   lock its people out for good; the flag is only read for a session that would otherwise be
 *   refused.
 */
export async function checkSessionReach(
  c: AppContext,
  auth: AuthContext,
  workspaceId: string,
  role: SeatRole,
): Promise<void> {
  if (auth.ssoWorkspaceId !== null && auth.ssoWorkspaceId !== workspaceId) {
    throw new ApiError(
      'forbidden',
      'You signed in with another workspace’s single sign-on. Confirm it is you with your own second factor, or sign in with your email, to open this workspace.',
      [
        { path: 'sso', message: 'sso_other_workspace' },
        { path: 'secondFactor', message: 'step_up_required' },
      ],
    );
  }
  if (auth.ssoBlockedWorkspaceId !== workspaceId || role === 'owner') return;
  if (!(await ssoEnabled(c))) return;
  throw new ApiError('forbidden', 'This workspace requires single sign-on. Sign in with SSO.', [
    { path: 'sso', message: 'sso_required' },
  ]);
}

/** 404 when the operator has no seat (tenancy is never revealed); 403 when the role is too low. */
export async function requireWorkspace(
  c: AppContext,
  workspaceId: string,
  minimum: SeatRole,
): Promise<{ workspaceId: string; role: SeatRole; auth: AuthContext }> {
  const auth = requireAuth(c);
  const role = await workspaceRole(env(c).DB, auth.operatorId, workspaceId);
  if (!role) throw new ApiError('not_found', 'Workspace not found.');
  await checkSessionReach(c, auth, workspaceId, role);
  if (!roleAtLeast(role, minimum)) {
    throw new ApiError('forbidden', `This needs the ${minimum} role or higher.`);
  }
  return { workspaceId, role, auth };
}

export async function requireChannel(
  c: AppContext,
  channelId: string,
  minimum: SeatRole,
  options: { allowDeleted?: boolean } = {},
): Promise<ChannelAccess & { auth: AuthContext }> {
  const auth = requireAuth(c);
  const access = await channelAccess(env(c).DB, auth.operatorId, channelId);
  if (!access || (access.deleted && !options.allowDeleted)) {
    throw new ApiError('not_found', 'Publication not found.');
  }
  if (auth.ssoBlockedWorkspaceId === access.workspaceId || auth.ssoWorkspaceId !== null) {
    const seat = await workspaceRole(env(c).DB, auth.operatorId, access.workspaceId);
    await checkSessionReach(c, auth, access.workspaceId, seat ?? access.role);
  }
  if (!roleAtLeast(access.role, minimum)) {
    throw new ApiError('forbidden', `This needs the ${minimum} role or higher.`);
  }
  return { ...access, auth };
}
