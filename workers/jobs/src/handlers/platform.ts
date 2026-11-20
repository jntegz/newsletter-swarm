// Daily housekeeping for the public API (Phase 7, Open API workstream): Idempotency-Key rows past
// their 24 hours, and audit log retention: the workspace's audit_retention_months, or the plan's
// PLAN_LIMITS.auditRetentionDays when shorter, on every plan (auditRetentionMs). Pruning the
// audit log keeps its hash chain verifiable through an anchor; see pruneAuditEvents in @swarm/db.
// OAuth for MCP (Phase 8): cached Client ID Metadata Documents long past expiry, and the app rows
// of metadata document clients that no longer have a live grant (docs/oauth.md).
import { all, first, pruneAuditEvents, run, verifyAuditChainStep } from '@swarm/db';
import { CLIENT_METADATA_LIMITS, IDEMPOTENCY_TTL_HOURS, PLANS, PLAN_LIMITS } from '@swarm/domain';
import { MONTH_MS, auditRetentionMs, verifyAgentLogStep } from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });
const DAY_MS = 86_400_000;
/** Workspaces pruned per plan per run; the rest follow the next day. */
const WORKSPACES_PER_RUN = 50;

export async function maintainPlatform(env: JobsEnv, now: number): Promise<void> {
  const keys = await run(
    env.DB,
    'DELETE FROM api_idempotency WHERE created_at <= ?1',
    now - IDEMPOTENCY_TTL_HOURS * 3_600_000,
  );
  let audit = 0;
  for (const plan of PLANS) {
    const days = PLAN_LIMITS[plan].auditRetentionDays;
    // The plan's limit, when it has one; the workspace's own setting caps every plan.
    const planMs = days === null ? null : days * DAY_MS;
    const due = await all<{ id: string; months: number }>(
      env.DB,
      `SELECT w.id, w.audit_retention_months AS months FROM workspaces w WHERE w.plan = ?1
          AND EXISTS (SELECT 1 FROM audit_events a WHERE a.workspace_id = w.id
                        AND a.created_at < ?2 - min(coalesce(?3, w.audit_retention_months * ${MONTH_MS}),
                                                    w.audit_retention_months * ${MONTH_MS}))
        LIMIT ?4`,
      plan,
      now,
      planMs,
      WORKSPACES_PER_RUN,
    );
    for (const { id, months } of due) {
      const before = now - auditRetentionMs(plan, months);
      const result = await pruneAuditEvents(env.DB, id, before, now);
      // A chain that doesn't verify is evidence: it is kept and someone has to look at it.
      if (result.refused) log.error('audit chain broken; not pruned', { workspaceId: id });
      audit += result.pruned;
    }
  }
  const oauth = await pruneMetadataClients(env.DB, now);
  log.info('platform housekeeping', {
    idempotencyKeys: keys.meta.changes,
    auditEvents: audit,
    ...oauth,
  });
}

/**
 * Drops cached metadata documents a week past expiry, and metadata document clients' app rows
 * with no live grant: every grant revoked, or nothing left that can be used (no unused code, no
 * unexpired unused refresh token). Deleting the row deletes its grants and tokens with it. A row
 * younger than a day is kept, so a consent in progress is never cut short.
 */
export async function pruneMetadataClients(
  db: D1Database,
  now: number,
): Promise<{ clientDocuments: number; metadataClients: number }> {
  const documents = await run(
    db,
    'DELETE FROM oauth_client_documents WHERE expires_at <= ?1',
    now - CLIENT_METADATA_LIMITS.pruneAfterDays * DAY_MS,
  );
  const clients = await run(
    db,
    `DELETE FROM oauth_apps WHERE metadata_url IS NOT NULL AND created_at <= ?1
       AND NOT EXISTS (
         SELECT 1 FROM oauth_grants g WHERE g.app_id = oauth_apps.id AND g.revoked_at IS NULL
            AND ((g.code_consumed_at IS NULL AND g.code_expires_at > ?2)
                 OR EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh'
                              AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > ?2)))`,
    now - DAY_MS,
    now,
  );
  return { clientDocuments: documents.meta.changes, metadataClients: clients.meta.changes };
}

/** Workspaces whose chain is verified per five-minute run: 288 runs a day cover 14,400. */
export const VERIFY_WORKSPACES_PER_RUN = 50;
/**
 * Events checked per run for each chain, across workspaces. It applies inside a workspace too: a
 * long chain stops at the budget, keeps a checkpoint in audit_verification_passes and goes on in
 * later runs, so no single chain can outlast a run. Each chain has its own budget, so a long
 * audit log pass never leaves the agent log unverified.
 */
const VERIFY_EVENTS_PER_CHAIN = 50_000;
const VERIFY_EVERY_MS = DAY_MS;

/** Every hash-chained log, with the table that tells which workspaces have one. */
const CHAINS = [
  { chain: 'audit_events', table: 'audit_events', verify: verifyAuditChainStep },
  // Open Operator (Phase 8): the agent log.
  { chain: 'agent_actions', table: 'agent_actions', verify: verifyAgentLogStep },
] as const;

/**
 * Verifies the hash chains (the audit log and the agent log) in bounded batches on the
 * five-minute cron: every workspace that has a chain, once a day, the one no run has looked at
 * for longest first. A pass over a long chain spans several runs; meanwhile it waits behind
 * workspaces not looked at since, so it never holds up the rest. A finished pass's result is
 * kept in audit_verifications; a break is logged as an error on every pass that finds it, and
 * broken_since keeps when it was first seen.
 */
export async function verifyAuditChains(
  env: JobsEnv,
  now: number,
  options: { eventsPerChain?: number } = {},
): Promise<{ verified: number; broken: { chain: string; workspaceId: string }[] }> {
  const budget = options.eventsPerChain ?? VERIFY_EVENTS_PER_CHAIN;
  const broken: { chain: string; workspaceId: string }[] = [];
  let total = 0;
  let verified = 0;
  for (const { chain, table, verify } of CHAINS) {
    let events = 0;
    const due = await all<{ id: string }>(
      env.DB,
      `SELECT w.id FROM workspaces w
         LEFT JOIN audit_verifications v ON v.workspace_id = w.id AND v.chain = ?1
         LEFT JOIN audit_verification_passes p ON p.workspace_id = w.id AND p.chain = ?1
        WHERE (v.verified_at IS NULL OR v.verified_at <= ?2)
          AND EXISTS (SELECT 1 FROM ${table} a WHERE a.workspace_id = w.id)
        ORDER BY COALESCE(p.updated_at, v.verified_at) IS NOT NULL,
                 COALESCE(p.updated_at, v.verified_at), w.id
        LIMIT ?3`,
      chain,
      now - VERIFY_EVERY_MS,
      VERIFY_WORKSPACES_PER_RUN,
    );
    for (const { id } of due) {
      if (events >= budget) break;
      const pass = await first<{
        through_seq: number;
        through_hash: string;
        checked: number;
        started_at: number;
      }>(
        env.DB,
        `SELECT through_seq, through_hash, checked, started_at FROM audit_verification_passes
          WHERE workspace_id = ?1 AND chain = ?2`,
        id,
        chain,
      );
      const result = await verify(env.DB, id, {
        from: pass ? { seq: pass.through_seq, hash: pass.through_hash } : null,
        limit: budget - events,
      });
      events += result.checked;
      const checked = (pass?.checked ?? 0) + result.checked;
      if (!result.done) {
        await run(
          env.DB,
          `INSERT INTO audit_verification_passes
             (workspace_id, chain, through_seq, through_hash, checked, started_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (workspace_id, chain) DO UPDATE SET
             through_seq = excluded.through_seq, through_hash = excluded.through_hash,
             checked = excluded.checked, updated_at = excluded.updated_at`,
          id,
          chain,
          result.last.seq,
          result.last.hash,
          checked,
          pass?.started_at ?? now,
          now,
        );
        continue;
      }
      verified++;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO audit_verifications
             (workspace_id, chain, verified_at, ok, checked, broken_at_seq, broken_since)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?4 = 1 THEN NULL ELSE ?3 END)
           ON CONFLICT (workspace_id, chain) DO UPDATE SET
             verified_at = excluded.verified_at, ok = excluded.ok, checked = excluded.checked,
             broken_at_seq = excluded.broken_at_seq,
             broken_since = CASE WHEN excluded.ok = 1 THEN NULL
                                 ELSE COALESCE(audit_verifications.broken_since, excluded.verified_at) END`,
        ).bind(id, chain, now, result.ok ? 1 : 0, checked, result.brokenAtSeq),
        // The next pass starts from the beginning of the chain again.
        env.DB.prepare(
          'DELETE FROM audit_verification_passes WHERE workspace_id = ?1 AND chain = ?2',
        ).bind(id, chain),
      ]);
      if (!result.ok) {
        broken.push({ chain, workspaceId: id });
        log.error('audit chain broken', {
          workspaceId: id,
          chain,
          brokenAtSeq: result.brokenAtSeq,
        });
      }
    }
    total += events;
  }
  if (verified) {
    log.info('audit chains verified', {
      workspaces: verified,
      events: total,
      broken: broken.length,
    });
  }
  return { verified, broken };
}
