import { newId } from '@swarm/domain';
import { canonicalJson, sha256Hex } from './crypto';
import { all, first, isUniqueViolation } from './index';

export interface AuditInput {
  workspaceId: string;
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipPrefix?: string | null;
}

const GENESIS = '0'.repeat(64);

interface AuditRow {
  seq: number;
  workspace_id: string;
  actor_operator_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string;
  created_at: number;
  prev_hash: string;
  hash: string;
}

function eventHash(prevHash: string, row: Omit<AuditRow, 'prev_hash' | 'hash'>): Promise<string> {
  const body = canonicalJson({
    seq: row.seq,
    workspaceId: row.workspace_id,
    actorId: row.actor_operator_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at,
  });
  return sha256Hex(`${prevHash}\n${body}`);
}

/**
 * Appends a tamper-evident event: each row's hash covers the previous row's hash, so
 * editing or deleting any past row breaks verification from that point on. Concurrent
 * writers race on UNIQUE(workspace_id, seq) and retry.
 */
export async function appendAudit(db: D1Database, input: AuditInput): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await first<{ seq: number; hash: string }>(
      db,
      'SELECT seq, hash FROM audit_events WHERE workspace_id = ?1 ORDER BY seq DESC LIMIT 1',
      input.workspaceId,
    );
    const row = {
      seq: (last?.seq ?? 0) + 1,
      workspace_id: input.workspaceId,
      actor_operator_id: input.actorId,
      action: input.action,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      created_at: Date.now(),
    };
    const prevHash = last?.hash ?? GENESIS;
    const hash = await eventHash(prevHash, row);
    try {
      await db
        .prepare(
          `INSERT INTO audit_events (id, workspace_id, seq, actor_operator_id, action, target_type,
             target_id, metadata_json, ip_prefix, created_at, prev_hash, hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .bind(
          newId('auditEvent'),
          row.workspace_id,
          row.seq,
          row.actor_operator_id,
          row.action,
          row.target_type,
          row.target_id,
          row.metadata_json,
          input.ipPrefix ?? null,
          row.created_at,
          prevHash,
          hash,
        )
        .run();
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('could not append audit event after 5 attempts');
}

/** Where verification starts: the retention anchor (audit_anchors), or the genesis hash. */
async function chainStart(
  db: D1Database,
  workspaceId: string,
): Promise<{ seq: number; hash: string; anchored: boolean }> {
  const anchor = await first<{ seq: number; hash: string }>(
    db,
    'SELECT seq, hash FROM audit_anchors WHERE workspace_id = ?1',
    workspaceId,
  );
  return anchor ? { ...anchor, anchored: true } : { seq: 0, hash: GENESIS, anchored: false };
}

/** A verified event a later call can resume from. */
export interface ChainCheckpoint {
  seq: number;
  hash: string;
}

export interface ChainVerifyOptions {
  /**
   * Resume after this verified event instead of the chain start. Ignored once retention has
   * pruned past it: the chain then starts at the anchor.
   */
  from?: ChainCheckpoint | null;
  /** Check at most this many events; `done` is false when more are left. */
  limit?: number;
  /** Stop after this seq (a prune checks only what it deletes). */
  throughSeq?: number;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  /** The last pruned seq when retention has pruned the start of the chain, else null. */
  anchorSeq: number | null;
}

export interface ChainVerifyStep extends AuditVerification {
  /** False when `limit` stopped the check early; `last` is where to resume. */
  done: boolean;
  /** The last event verified (or the start), to resume from. */
  last: ChainCheckpoint;
}

/**
 * Re-computes every kept event's hash. After retention has pruned the oldest events the chain
 * starts at the anchor: the first kept event must have the anchor's seq + 1 and chain from its
 * hash (see pruneAuditEvents).
 */
export async function verifyAuditChain(
  db: D1Database,
  workspaceId: string,
): Promise<AuditVerification> {
  const { ok, checked, brokenAtSeq, anchorSeq } = await verifyAuditChainStep(db, workspaceId);
  return { ok, checked, brokenAtSeq, anchorSeq };
}

/**
 * verifyAuditChain in bounded steps: `options` resume from a checkpoint and cap the events
 * checked, so a long chain is verified over several calls.
 */
export async function verifyAuditChainStep(
  db: D1Database,
  workspaceId: string,
  options: ChainVerifyOptions = {},
): Promise<ChainVerifyStep> {
  const anchor = await chainStart(db, workspaceId);
  const anchorSeq = anchor.anchored ? anchor.seq : null;
  const resume = options.from && options.from.seq >= anchor.seq ? options.from : null;
  const limit = options.limit ?? Infinity;
  const through = options.throughSeq ?? Number.MAX_SAFE_INTEGER;
  let last: ChainCheckpoint = resume ?? { seq: anchor.seq, hash: anchor.hash };
  let checked = 0;
  // From the start, read from seq 0 so rows left at or below a moved anchor show as a break.
  let after = resume ? resume.seq : -1;
  // Read in pages so a long chain never sits in memory at once.
  for (;;) {
    const page = Math.min(AUDIT_VERIFY_PAGE, limit - checked);
    if (page <= 0) return { ok: true, checked, brokenAtSeq: null, anchorSeq, done: false, last };
    const rows = await all<AuditRow>(
      db,
      `SELECT seq, workspace_id, actor_operator_id, action, target_type, target_id, metadata_json,
              created_at, prev_hash, hash
         FROM audit_events WHERE workspace_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq LIMIT ?4`,
      workspaceId,
      after,
      through,
      page,
    );
    for (const row of rows) {
      const expected = await eventHash(last.hash, row);
      if (row.seq !== last.seq + 1 || row.prev_hash !== last.hash || row.hash !== expected) {
        return { ok: false, checked, brokenAtSeq: row.seq, anchorSeq, done: true, last };
      }
      last = { seq: row.seq, hash: row.hash };
      checked++;
      after = row.seq;
    }
    if (rows.length < page) break;
  }
  return { ok: true, checked, brokenAtSeq: null, anchorSeq, done: true, last };
}

/** True when the verification cron last found this workspace's chain broken. */
export async function recordedBroken(
  db: D1Database,
  workspaceId: string,
  chain: 'audit_events' | 'agent_actions',
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    'SELECT ok FROM audit_verifications WHERE workspace_id = ?1 AND chain = ?2',
    workspaceId,
    chain,
  );
  return row?.ok === 0;
}

/**
 * True when the first event after `last` (the last one a prune deletes) follows it in seq and
 * names its hash. An edit inside the prune range with the hashes recomputed up to the prune point
 * breaks the chain only at this link, so a prune that skipped it would delete the evidence. Used
 * when the prune's check stopped short of the next seq.
 */
async function linksToNext(
  db: D1Database,
  workspaceId: string,
  last: ChainCheckpoint,
): Promise<boolean> {
  const next = await first<{ seq: number; prev_hash: string }>(
    db,
    `SELECT seq, prev_hash FROM audit_events WHERE workspace_id = ?1 AND seq > ?2
      ORDER BY seq LIMIT 1`,
    workspaceId,
    last.seq,
  );
  return !next || (next.seq === last.seq + 1 && next.prev_hash === last.hash);
}

/** Events read per page while verifying. */
export const AUDIT_VERIFY_PAGE = 1000;

/** Events deleted per prune, so one run stays bounded; the next run continues. */
export const AUDIT_PRUNE_BATCH = 5000;

export interface AuditPruneResult {
  pruned: number;
  /** The new anchor (last pruned seq), or null when nothing was pruned. */
  throughSeq: number | null;
  /** Set when the chain did not verify: nothing is deleted. */
  refused?: 'broken_chain';
}

/**
 * Retention: deletes a workspace's events older than `before` (ms) while keeping the chain
 * verifiable.
 *
 * 1. The events to delete are verified first, from the anchor to the prune point (at most one
 *    batch, so the work stays bounded however long the chain is), together with the link from
 *    the last of them to the first kept event. A break there, or a break the
 *    verification cron has recorded anywhere in the chain, refuses the prune: deleting would
 *    destroy the evidence, so the caller logs it. A break past the prune point is kept and
 *    still verifies as broken from the new anchor.
 * 2. The prune is appended to the chain as an `audit.pruned` event naming the last pruned seq and
 *    its hash. It is newer than anything pruned, so it is always kept, and its own hash covers
 *    the anchor values.
 * 3. One batch moves the anchor to the last pruned event and deletes the events up to it.
 *    Verification then starts from the anchor. An anchor moved by hand no longer matches the
 *    first kept event, and the audit.pruned events record every anchor the chain has had.
 */
export async function pruneAuditEvents(
  db: D1Database,
  workspaceId: string,
  before: number,
  now: number = Date.now(),
): Promise<AuditPruneResult> {
  const last = await first<{ seq: number }>(
    db,
    `SELECT seq FROM audit_events WHERE workspace_id = ?1 AND created_at < ?2
      ORDER BY seq DESC LIMIT 1`,
    workspaceId,
    before,
  );
  if (!last) return { pruned: 0, throughSeq: null };
  const start = await chainStart(db, workspaceId);
  const throughSeq = Math.min(last.seq, start.seq + AUDIT_PRUNE_BATCH);
  // Through the first kept event too, its own hash recomputed: one with its prev_hash rewritten
  // to match a re-hashed range links on seq and prev_hash alone. When it isn't the next seq (a
  // gap), linksToNext refuses.
  const check = await verifyAuditChainStep(db, workspaceId, { throughSeq: throughSeq + 1 });
  if (
    !check.ok ||
    (check.last.seq <= throughSeq && !(await linksToNext(db, workspaceId, check.last))) ||
    (await recordedBroken(db, workspaceId, 'audit_events'))
  ) {
    return { pruned: 0, throughSeq: null, refused: 'broken_chain' };
  }
  const through = await first<{ seq: number; hash: string; created_at: number }>(
    db,
    'SELECT seq, hash, created_at FROM audit_events WHERE workspace_id = ?1 AND seq = ?2',
    workspaceId,
    throughSeq,
  );
  if (!through) return { pruned: 0, throughSeq: null };
  await appendAudit(db, {
    workspaceId,
    actorId: null,
    action: 'audit.pruned',
    metadata: {
      throughSeq: through.seq,
      anchorHash: through.hash,
      prunedBefore: new Date(through.created_at).toISOString(),
    },
  });
  const [, deleted] = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_anchors (workspace_id, seq, hash, pruned_before, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (workspace_id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash,
           pruned_before = excluded.pruned_before, updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, through.seq, through.hash, through.created_at, now),
    db
      .prepare('DELETE FROM audit_events WHERE workspace_id = ?1 AND seq <= ?2')
      .bind(workspaceId, through.seq),
  ]);
  return { pruned: deleted?.meta.changes ?? 0, throughSeq: through.seq };
}
