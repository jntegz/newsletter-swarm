// The install's own audit log: changes to install-wide settings (instance_audit_events, 0113).
// One hash chain for the whole install, built like the workspace chain in audit.ts: each event's
// hash covers the previous event's hash, so editing or deleting a past event breaks verification
// from there on. Concurrent writers race on the seq primary key and retry.
import { newId } from '@swarm/domain';
import { canonicalJson, sha256Hex } from './crypto';
import { all, first, isUniqueViolation } from './index';

const GENESIS = '0'.repeat(64);

export interface InstanceAuditInput {
  actorId: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ipPrefix?: string | null;
}

export interface InstanceAuditRow {
  seq: number;
  id: string;
  actor_operator_id: string | null;
  action: string;
  metadata_json: string;
  ip_prefix: string | null;
  created_at: number;
  prev_hash: string;
  hash: string;
}

function instanceEventHash(
  prevHash: string,
  row: Pick<
    InstanceAuditRow,
    'seq' | 'actor_operator_id' | 'action' | 'metadata_json' | 'created_at'
  >,
): Promise<string> {
  const body = canonicalJson({
    seq: row.seq,
    actorId: row.actor_operator_id,
    action: row.action,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at,
  });
  return sha256Hex(`${prevHash}\n${body}`);
}

export async function appendInstanceAudit(
  db: D1Database,
  input: InstanceAuditInput,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await first<{ seq: number; hash: string }>(
      db,
      'SELECT seq, hash FROM instance_audit_events ORDER BY seq DESC LIMIT 1',
    );
    const row = {
      seq: (last?.seq ?? 0) + 1,
      actor_operator_id: input.actorId,
      action: input.action,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      created_at: Date.now(),
    };
    const prevHash = last?.hash ?? GENESIS;
    const hash = await instanceEventHash(prevHash, row);
    try {
      await db
        .prepare(
          `INSERT INTO instance_audit_events (seq, id, actor_operator_id, action, metadata_json,
             ip_prefix, created_at, prev_hash, hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          row.seq,
          newId('instanceAuditEvent'),
          row.actor_operator_id,
          row.action,
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
  throw new Error('could not append instance audit event after 5 attempts');
}

/** Checks the whole chain from the start, a page at a time. */
export async function verifyInstanceAudit(
  db: D1Database,
): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }> {
  let prev = GENESIS;
  let expectedSeq = 1;
  let checked = 0;
  for (;;) {
    const rows = await all<InstanceAuditRow>(
      db,
      'SELECT * FROM instance_audit_events WHERE seq >= ?1 ORDER BY seq LIMIT 500',
      expectedSeq,
    );
    for (const row of rows) {
      const broken =
        row.seq !== expectedSeq ||
        row.prev_hash !== prev ||
        row.hash !== (await instanceEventHash(prev, row));
      if (broken) return { ok: false, checked, brokenAtSeq: expectedSeq };
      prev = row.hash;
      expectedSeq++;
      checked++;
    }
    if (rows.length < 500) return { ok: true, checked, brokenAtSeq: null };
  }
}
