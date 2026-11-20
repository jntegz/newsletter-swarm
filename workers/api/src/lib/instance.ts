import { first } from '@swarm/db';
import type { SignupMode } from '@swarm/domain';
import type { ApiEnv } from '../env';

/**
 * Who can sign up on this instance. With no setting saved, local development and tests are open.
 * A deployed instance fails closed instead: the first person to sign in may (they become its
 * owner), and everyone after them needs an invite until an instance admin chooses otherwise. The
 * installer saves invite-only before anything is deployed; this covers an install made by hand.
 */
export async function signupMode(e: ApiEnv): Promise<SignupMode> {
  const row = await first<{ value: string }>(
    e.DB,
    "SELECT value FROM instance_settings WHERE key = 'signup'",
  );
  if (row) return row.value === 'invite_only' ? 'invite_only' : 'open';
  if (e.ENVIRONMENT === 'development' || e.ENVIRONMENT === 'test') return 'open';
  return (await first(e.DB, 'SELECT 1 FROM operators LIMIT 1')) ? 'invite_only' : 'open';
}

/** Whether the operator may change instance settings. */
export async function isInstanceAdmin(e: ApiEnv, operatorId: string): Promise<boolean> {
  return !!(await first(e.DB, 'SELECT 1 FROM instance_admins WHERE operator_id = ?1', operatorId));
}

/** Whether an address has an invite it can still accept. */
export async function hasPendingInvite(e: ApiEnv, email: string): Promise<boolean> {
  return !!(await first(
    e.DB,
    `SELECT 1 FROM invites
      WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
      LIMIT 1`,
    email,
    Date.now(),
  ));
}

export const INVITE_ONLY_MESSAGE = 'This Swarm is invite-only. Ask the owner for an invite.';
