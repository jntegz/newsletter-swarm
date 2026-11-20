/**
 * What the vault records about each operation. Every call writes one log line (op, entrypoint,
 * principal kind, tenant, count, decision, reason, time taken), never a value or a credential.
 * Refusals, rate-limit hits and bulk opens also go to vault_audit (install-wide, 90 days), and a
 * bulk open of a workspace's data (an export run, a data request, a destination run) also goes to
 * that workspace's own audit log, once per job, so the publisher sees it.
 */
import { appendAudit, first, run, sha256Hex } from '@swarm/db';
import type { PrincipalKind } from '../api';
import type { VaultContext } from './context';

type Decision = 'allowed' | 'refused' | 'rate_limited' | 'failed';

interface AuditEntry {
  op: string;
  principalKind: PrincipalKind | 'none';
  /** An id that names the principal (a job, request, Member or credential row), never a secret. */
  principalId?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
  decision: Decision;
  reason?: string | null;
  count?: number;
}

/**
 * How a Member (or any person-shaped subject) is named in vault_audit and vault_mints: a hash, so
 * these records hold no Member id or address and erasure has nothing to remove from them. Given
 * the id, an instance admin can still find its rows.
 */
export const subjectHash = (subject: string) => sha256Hex(`vault-subject\n${subject}`);

/** Days vault_audit and vault_mints rows are kept. */
const VAULT_AUDIT_RETENTION_DAYS = 90;

export async function writeVaultAudit(ctx: VaultContext, entry: AuditEntry): Promise<void> {
  await run(
    ctx.db,
    `INSERT INTO vault_audit (created_at, caller, op, principal_kind, principal_id, workspace_id,
                              channel_id, decision, reason, count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ctx.now(),
    ctx.caller,
    entry.op,
    entry.principalKind,
    entry.principalId?.slice(0, 120) ?? null,
    entry.workspaceId ?? null,
    entry.channelId ?? null,
    entry.decision,
    entry.reason?.slice(0, 120) ?? null,
    entry.count ?? 0,
  );
}

/** Workspace audit actions for the vault's bulk opens. */
type WorkspaceOpenAction = 'vault.export_open' | 'vault.dsr_open' | 'vault.destination_open';

/**
 * A bulk open of `count` values for one job: always in vault_audit; in the workspace's own audit
 * chain the first time this job opens anything, so a long export is one entry there.
 */
export async function recordBulkOpen(
  ctx: VaultContext,
  input: {
    op: string;
    action: WorkspaceOpenAction;
    principalKind: PrincipalKind;
    principalId: string;
    workspaceId: string;
    channelId?: string | null;
    count: number;
    targetType: string;
  },
): Promise<void> {
  const seen = await first(
    ctx.db,
    `SELECT 1 FROM vault_audit WHERE op = ?1 AND principal_kind = ?2 AND principal_id = ?3
        AND decision = 'allowed' LIMIT 1`,
    input.op,
    input.principalKind,
    input.principalId,
  );
  await writeVaultAudit(ctx, {
    op: input.op,
    principalKind: input.principalKind,
    principalId: input.principalId,
    workspaceId: input.workspaceId,
    channelId: input.channelId ?? null,
    decision: 'allowed',
    count: input.count,
  });
  if (seen) return;
  await appendAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actorId: null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.principalId,
    metadata: { caller: ctx.caller, count: input.count },
  });
}

/** Drops vault_audit, vault_mints and vault_rate rows past their retention. */
export async function pruneVaultRecords(ctx: VaultContext): Promise<number> {
  const before = ctx.now() - VAULT_AUDIT_RETENTION_DAYS * 86_400_000;
  const audit = await run(ctx.db, 'DELETE FROM vault_audit WHERE created_at < ?1', before);
  const mints = await run(ctx.db, 'DELETE FROM vault_mints WHERE created_at < ?1', before);
  const rate = await run(
    ctx.db,
    'DELETE FROM vault_rate WHERE window_start < ?1',
    ctx.now() - 2 * 86_400_000,
  );
  return (audit.meta.changes ?? 0) + (mints.meta.changes ?? 0) + (rate.meta.changes ?? 0);
}
