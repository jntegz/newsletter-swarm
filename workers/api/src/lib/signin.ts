import { all, batch, first, run } from '@swarm/db';
import { newId, type Me } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { ApiEnv } from '../env';
import { appendAudit } from './audit';
import { INVITE_ONLY_MESSAGE, hasPendingInvite, isInstanceAdmin, signupMode } from './instance';
import { toOperator, toWorkspace, type OperatorRow, type WorkspaceRow } from './mappers';
import { secondFactorStatus } from './mfa';

/** Thrown by findOrCreateOperator for an unknown address on an invite-only instance. */
const inviteOnlyError = () =>
  new ApiError('forbidden', INVITE_ONLY_MESSAGE, [{ path: 'signup', message: 'invite_only' }]);

export const isInviteOnlyError = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.details?.[0]?.message === 'invite_only';

/**
 * Finds the operator for a verified email, or creates them together with their first
 * workspace and an owner seat. Callers must have proven control of the email first.
 *
 * On an invite-only instance (0032_instance.sql) an unknown address is let in only with a
 * pending invite, and then without a workspace of its own: the seat comes from accepting the
 * invite. Anyone else gets inviteOnlyError().
 */
export async function findOrCreateOperator(
  e: ApiEnv,
  email: string,
  ip: string | null,
): Promise<{ operatorId: string; created: boolean }> {
  const existing = await first<{ id: string }>(
    e.DB,
    'SELECT id FROM operators WHERE email = ?1',
    email,
  );
  if (existing) return { operatorId: existing.id, created: false };

  if ((await signupMode(e)) === 'invite_only') {
    if (!(await hasPendingInvite(e, email))) throw inviteOnlyError();
    return createInvitedOperator(e, email);
  }

  // A new operator is never an instance admin yet, so their workspace gets no install-level grant
  // here. If they are made one later (in SQL, docs/deployment.md), the instance_admins trigger in
  // migrations/0069_review_fixes.sql allows the workspaces whose workspace.created entry names them.
  const now = Date.now();
  const operatorId = newId('operator');
  const workspaceId = newId('workspace');
  try {
    await batch(e.DB, [
      e.DB.prepare(
        'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
      ).bind(operatorId, email, now),
      e.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, 'My workspace', ?2, ?2)",
      ).bind(workspaceId, now),
      e.DB.prepare(
        "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', ?4, ?4)",
      ).bind(newId('seat'), workspaceId, operatorId, now),
    ]);
  } catch (error) {
    // A concurrent sign-in for the same email won the race; use theirs.
    const raced = await first<{ id: string }>(
      e.DB,
      'SELECT id FROM operators WHERE email = ?1',
      email,
    );
    if (raced) return { operatorId: raced.id, created: false };
    throw error;
  }
  await appendAudit(e.DB, {
    workspaceId,
    actorId: operatorId,
    action: 'workspace.created',
    targetType: 'workspace',
    targetId: workspaceId,
    ipPrefix: ip,
  });
  return { operatorId, created: true };
}

/** An operator with no seat yet; accepting their invite gives them one. */
async function createInvitedOperator(
  e: ApiEnv,
  email: string,
): Promise<{ operatorId: string; created: boolean }> {
  const operatorId = newId('operator');
  try {
    await run(
      e.DB,
      'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
      operatorId,
      email,
      Date.now(),
    );
  } catch (error) {
    // A concurrent sign-in for the same email won the race; use theirs.
    const raced = await first<{ id: string }>(
      e.DB,
      'SELECT id FROM operators WHERE email = ?1',
      email,
    );
    if (raced) return { operatorId: raced.id, created: false };
    throw error;
  }
  return { operatorId, created: true };
}

export async function loadMe(e: ApiEnv, operatorId: string, sessionId: string): Promise<Me> {
  const operator = await first<OperatorRow>(
    e.DB,
    'SELECT id, email, name, created_at FROM operators WHERE id = ?1',
    operatorId,
  );
  if (!operator) throw new Error('operator vanished');
  const workspaces = await all<WorkspaceRow>(
    e.DB,
    `SELECT w.id, w.name, w.plan, s.role, w.created_at
       FROM seats s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.operator_id = ?1 ORDER BY w.created_at`,
    operatorId,
  );
  const secondFactor = await secondFactorStatus(e, operatorId, sessionId);
  const done = secondFactor.state === 'ok';
  return {
    operator: toOperator(operator),
    // A session that still owes a second factor learns nothing about the workspaces yet.
    workspaces: done ? workspaces.map(toWorkspace) : [],
    sessionId,
    secondFactor,
    instanceAdmin: done && (await isInstanceAdmin(e, operatorId)),
  };
}
