// Audit log expansion (Phase 7): export to CSV and JSONL, retention that keeps the hash chain
// verifiable (the anchor), and refusing to prune a broken chain.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { appendAudit, pruneAuditEvents, sha256Hex, canonicalJson } from '@swarm/db';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { data } from './audience-helpers';
import { ORIGIN, call, seatAs, signIn, type Session } from './helpers';

let owner: Session;

beforeAll(async () => {
  owner = await signIn();
});

const verify = async (s: Session) =>
  data<{ ok: boolean; checked: number; brokenAtSeq: number | null; anchorSeq: number | null }>(
    await call('GET', `/api/v1/workspaces/${s.workspaceId}/audit/verify`, { cookie: s.cookie }),
  );

const exportLog = (s: Session, body: Record<string, unknown>, workspaceId = s.workspaceId) =>
  call('POST', `/api/v1/workspaces/${workspaceId}/audit/export`, { cookie: s.cookie, body });

describe('audit export', () => {
  it('downloads CSV oldest first with the chain, and audits the export', async () => {
    const res = await exportLog(owner, { format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="audit-.*\.csv"/);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe(
      'seq,id,created_at,action,actor_id,actor_email,target_type,target_id,ip_prefix,metadata,prev_hash,hash',
    );
    expect(lines[1]?.startsWith('1,')).toBe(true);
    const log = await data<{ items: { action: string }[] }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, { cookie: owner.cookie }),
    );
    expect(log.items[0]?.action).toBe('audit.exported');
  });

  it('downloads JSONL that verifies outside Swarm', async () => {
    const res = await exportLog(owner, { format: 'jsonl' });
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    let prev = '0'.repeat(64);
    for (const event of events) {
      const body = canonicalJson({
        seq: event.seq,
        workspaceId: owner.workspaceId,
        actorId: (event.actor as { id: string } | null)?.id ?? null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: event.metadata,
        createdAt: Date.parse(event.createdAt as string),
      });
      expect(event.prevHash).toBe(prev);
      expect(event.hash).toBe(await sha256Hex(`${prev}\n${body}`));
      prev = event.hash as string;
    }
  });

  it('filters by time, escapes formulas and needs the admin role', async () => {
    await appendAudit(env.DB, {
      workspaceId: owner.workspaceId,
      actorId: null,
      action: 'test.formula',
      metadata: { note: '=HYPERLINK("x")' },
      targetId: '=cmd',
    });
    const csv = await (await exportLog(owner, { format: 'csv' })).text();
    expect(csv).toContain("'=cmd");
    const future = await exportLog(owner, {
      format: 'jsonl',
      from: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await future.text()).toBe('');
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await exportLog(editor, { format: 'csv' }, owner.workspaceId)).status).toBe(403);
    expect((await exportLog(owner, { format: 'xml' })).status).toBe(400);
  });
});

describe('audit retention', () => {
  it('prunes old events and the chain still verifies from the anchor', async () => {
    const s = await signIn();
    for (let i = 0; i < 5; i++) {
      await appendAudit(env.DB, { workspaceId: s.workspaceId, actorId: null, action: `test.${i}` });
    }
    const before = await verify(s);
    expect(before).toMatchObject({ ok: true, anchorSeq: null });
    // Age the first four events past retention.
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = created_at - ?1 WHERE workspace_id = ?2 AND seq <= 4',
    )
      .bind(400 * 86_400_000, s.workspaceId)
      .run();
    // Re-hash nothing: moving created_at breaks those rows, so put the chain right again first.
    await rehash(s.workspaceId);
    expect((await verify(s)).ok).toBe(true);

    const result = await pruneAuditEvents(env.DB, s.workspaceId, Date.now() - 365 * 86_400_000);
    expect(result).toEqual({ pruned: 4, throughSeq: 4 });
    const after = await verify(s);
    expect(after).toMatchObject({ ok: true, anchorSeq: 4, brokenAtSeq: null });
    const kept = await env.DB.prepare(
      'SELECT seq, action, metadata_json FROM audit_events WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(s.workspaceId)
      .all<{ seq: number; action: string; metadata_json: string }>();
    expect(kept.results[0]?.seq).toBe(5);
    const prune = kept.results.find((r) => r.action === 'audit.pruned');
    expect(JSON.parse(prune?.metadata_json ?? '{}')).toMatchObject({ throughSeq: 4 });
    // Nothing more to prune.
    expect(await pruneAuditEvents(env.DB, s.workspaceId, Date.now() - 365 * 86_400_000)).toEqual({
      pruned: 0,
      throughSeq: null,
    });
  });

  it('detects a moved anchor or an edited kept event', async () => {
    const s = await signIn();
    for (let i = 0; i < 3; i++) {
      await appendAudit(env.DB, { workspaceId: s.workspaceId, actorId: null, action: `test.${i}` });
    }
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = 1 WHERE workspace_id = ?1 AND seq <= 2',
    )
      .bind(s.workspaceId)
      .run();
    await rehash(s.workspaceId);
    await pruneAuditEvents(env.DB, s.workspaceId, 1000);
    expect((await verify(s)).ok).toBe(true);
    await env.DB.prepare('UPDATE audit_anchors SET seq = seq + 1 WHERE workspace_id = ?1')
      .bind(s.workspaceId)
      .run();
    expect((await verify(s)).ok).toBe(false);
  });

  it('refuses to prune a chain that does not verify', async () => {
    const s = await signIn();
    await appendAudit(env.DB, { workspaceId: s.workspaceId, actorId: null, action: 'test.a' });
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'tampered', created_at = 1 WHERE workspace_id = ?1 AND seq = 1",
    )
      .bind(s.workspaceId)
      .run();
    const result = await pruneAuditEvents(env.DB, s.workspaceId, 1000);
    expect(result).toEqual({ pruned: 0, throughSeq: null, refused: 'broken_chain' });
    const count = await env.DB.prepare(
      'SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1',
    )
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect(count?.n).toBeGreaterThan(0);
  });

  it('refuses a prune whose edited range was re-hashed up to the prune point', async () => {
    const s = await signIn();
    for (let i = 0; i < 4; i++) {
      await appendAudit(env.DB, { workspaceId: s.workspaceId, actorId: null, action: `test.${i}` });
    }
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = 1 WHERE workspace_id = ?1 AND seq <= 3',
    )
      .bind(s.workspaceId)
      .run();
    await rehash(s.workspaceId);
    // Edit an event inside the prune range and recompute the hashes through the prune point only:
    // the one break left is the link from seq 3 to the first kept event.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'tampered' WHERE workspace_id = ?1 AND seq = 2",
    )
      .bind(s.workspaceId)
      .run();
    await rehash(s.workspaceId, 3);
    const result = await pruneAuditEvents(env.DB, s.workspaceId, 1000);
    expect(result).toEqual({ pruned: 0, throughSeq: null, refused: 'broken_chain' });
    const kept = await env.DB.prepare(
      'SELECT seq, action FROM audit_events WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(s.workspaceId)
      .all<{ seq: number; action: string }>();
    expect(kept.results.map((r) => r.action)).not.toContain('audit.pruned');
    expect(kept.results[0]?.seq).toBe(1);
    expect(await verify(s)).toMatchObject({ ok: false, brokenAtSeq: 4 });
  });

  it('refuses a prune whose re-hashed range was linked to the first kept event', async () => {
    const s = await signIn();
    for (let i = 0; i < 4; i++) {
      await appendAudit(env.DB, { workspaceId: s.workspaceId, actorId: null, action: `test.${i}` });
    }
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = 1 WHERE workspace_id = ?1 AND seq <= 3',
    )
      .bind(s.workspaceId)
      .run();
    await rehash(s.workspaceId);
    // As above, and the first kept event's prev_hash rewritten to the new hash of seq 3, so only
    // that event's own hash shows the edit.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'tampered' WHERE workspace_id = ?1 AND seq = 2",
    )
      .bind(s.workspaceId)
      .run();
    await rehash(s.workspaceId, 3);
    await env.DB.prepare(
      `UPDATE audit_events SET prev_hash = (SELECT hash FROM audit_events WHERE workspace_id = ?1 AND seq = 3)
        WHERE workspace_id = ?1 AND seq = 4`,
    )
      .bind(s.workspaceId)
      .run();
    const result = await pruneAuditEvents(env.DB, s.workspaceId, 1000);
    expect(result).toEqual({ pruned: 0, throughSeq: null, refused: 'broken_chain' });
    const kept = await env.DB.prepare(
      'SELECT seq, action FROM audit_events WHERE workspace_id = ?1 ORDER BY seq',
    )
      .bind(s.workspaceId)
      .all<{ seq: number; action: string }>();
    expect(kept.results.map((r) => r.action)).toContain('tampered');
    expect(await verify(s)).toMatchObject({ ok: false, brokenAtSeq: 4 });
  });
});

describe('on-demand verification', () => {
  interface Page {
    ok: boolean;
    checked: number;
    brokenAtSeq: number | null;
    complete: boolean;
    nextCursor: string | null;
    fromSeq: number;
  }

  /** One verify request through a DB that counts the audit_events rows it hands back. */
  async function verifyPage(s: Session, query: string): Promise<{ page: Page; rowsRead: number }> {
    let rowsRead = 0;
    const counted = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (typeof value !== 'function') return value;
          if (key === 'bind') {
            return (...args: unknown[]) => counted(target.bind(...args));
          }
          if (key === 'all') {
            return async () => {
              const result = await target.all();
              rowsRead += result.results.length;
              return result;
            };
          }
          if (key === 'first') {
            return async () => {
              const row = await target.first();
              if (row) rowsRead++;
              return row;
            };
          }
          return value.bind(target);
        },
      });
    const db = new Proxy(env.DB, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string) =>
          /FROM audit_events\b/.test(sql) ? counted(target.prepare(sql)) : target.prepare(sql);
      },
    });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://localhost/api/v1/workspaces/${s.workspaceId}/audit/verify${query}`, {
        headers: { origin: ORIGIN, cookie: s.cookie },
      }),
      { ...env, DB: db },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    return { page: await data<Page>(res), rowsRead };
  }

  /** Adds `n` events after the workspace's last one and re-hashes the chain. */
  async function addEvents(workspaceId: string, n: number): Promise<number> {
    const last = await env.DB.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_events WHERE workspace_id = ?1',
    )
      .bind(workspaceId)
      .first<{ seq: number }>();
    const start = last?.seq ?? 0;
    await env.DB.batch(
      Array.from({ length: n }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO audit_events (id, workspace_id, seq, actor_operator_id, action, target_type,
             target_id, metadata_json, ip_prefix, created_at, prev_hash, hash)
           VALUES (?1, ?2, ?3, NULL, 'test.bulk', NULL, NULL, '{}', NULL, ?4, '', '')`,
        ).bind(`ae_${crypto.randomUUID().replace(/-/g, '')}`, workspaceId, start + i + 1, 1000 + i),
      ),
    );
    await rehash(workspaceId);
    return start + n;
  }

  it('checks a chain longer than the bound over several requests, each reading a bounded page', async () => {
    const s = await signIn();
    const total = await addEvents(s.workspaceId, 25);

    const first = await verifyPage(s, '?limit=10');
    expect(first.page).toMatchObject({ ok: true, checked: 10, complete: false });
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.rowsRead).toBeLessThanOrEqual(10);

    let page = first.page;
    let requests = 1;
    while (!page.complete) {
      const next = await verifyPage(s, `?limit=10&cursor=${page.nextCursor ?? ''}`);
      // The page, plus the cursor event read again and checked again.
      expect(next.rowsRead).toBeLessThanOrEqual(12);
      page = next.page;
      requests++;
    }
    expect(page).toMatchObject({ ok: true, checked: total, brokenAtSeq: null, nextCursor: null });
    expect(requests).toBe(Math.ceil(total / 10));

    // An edit past the first page is found when the client pages on to it.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = ?2",
    )
      .bind(s.workspaceId, total - 2)
      .run();
    page = (await verifyPage(s, '?limit=10')).page;
    expect(page).toMatchObject({ ok: true, complete: false });
    while (!page.complete) {
      page = (await verifyPage(s, `?limit=10&cursor=${page.nextCursor ?? ''}`)).page;
    }
    expect(page).toMatchObject({ ok: false, brokenAtSeq: total - 2, nextCursor: null });
  });

  it('starts again when the cursor event changed, and caps the page size', async () => {
    const s = await signIn();
    await addEvents(s.workspaceId, 12);
    const first = (await verifyPage(s, '?limit=5')).page;
    expect(first).toMatchObject({ checked: 5, complete: false });
    // Edit the event the cursor points at (seq 5): resuming after it would miss the edit.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 5",
    )
      .bind(s.workspaceId)
      .run();
    const resumed = (await verifyPage(s, `?limit=5&cursor=${first.nextCursor ?? ''}`)).page;
    expect(resumed).toMatchObject({ ok: false, brokenAtSeq: 5, complete: true });

    const path = `/api/v1/workspaces/${s.workspaceId}/audit/verify`;
    expect((await call('GET', `${path}?limit=10001`, { cookie: s.cookie })).status).toBe(400);
    expect((await call('GET', `${path}?cursor=bm9wZQ`, { cookie: s.cookie })).status).toBe(400);
  });

  it('refuses a cursor it did not issue, so a tampered range cannot be skipped', async () => {
    const s = await signIn();
    const total = await addEvents(s.workspaceId, 12);
    const path = `/api/v1/workspaces/${s.workspaceId}/audit/verify`;

    // A resumed page says where it started, so it shows it is not the whole chain.
    const first = (await verifyPage(s, '?limit=5')).page;
    expect(first).toMatchObject({ fromSeq: 1, checked: 5, complete: false });
    const resumed = (await verifyPage(s, `?limit=5&cursor=${first.nextCursor ?? ''}`)).page;
    expect(resumed).toMatchObject({ fromSeq: 5, checked: 10, complete: false });
    // A cursor works only for the workspace it was issued for.
    const other = await signIn();
    await addEvents(other.workspaceId, 12);
    const elsewhere = `/api/v1/workspaces/${other.workspaceId}/audit/verify`;
    expect(
      (await call('GET', `${elsewhere}?cursor=${first.nextCursor ?? ''}`, { cookie: other.cookie }))
        .status,
    ).toBe(400);

    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 3",
    )
      .bind(s.workspaceId)
      .run();
    // Hashes are public (the audit list shows them), so anyone can name the last event's.
    const last = await env.DB.prepare(
      'SELECT hash FROM audit_events WHERE workspace_id = ?1 AND seq = ?2',
    )
      .bind(s.workspaceId, total)
      .first<{ hash: string }>();
    const forged = btoa(`${total}.${last!.hash}.1000000`).replace(/=+$/, '');
    const res = await call('GET', `${path}?cursor=${forged}`, { cookie: s.cookie });
    expect(res.status).toBe(400);
    expect((await verifyPage(s, '')).page).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
});

/**
 * Recomputes the chain after a test moved timestamps (as if the events had been written then),
 * through `throughSeq` when given.
 */
async function rehash(workspaceId: string, throughSeq = Number.MAX_SAFE_INTEGER): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, seq, workspace_id, actor_operator_id, action, target_type, target_id, metadata_json, created_at
       FROM audit_events WHERE workspace_id = ?1 AND seq <= ?2 ORDER BY seq`,
  )
    .bind(workspaceId, throughSeq)
    .all<Record<string, unknown>>();
  let prev = '0'.repeat(64);
  for (const row of rows.results) {
    const body = canonicalJson({
      seq: row.seq,
      workspaceId: row.workspace_id,
      actorId: row.actor_operator_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: JSON.parse(row.metadata_json as string) as unknown,
      createdAt: row.created_at,
    });
    const hash = await sha256Hex(`${prev}\n${body}`);
    await env.DB.prepare('UPDATE audit_events SET prev_hash = ?1, hash = ?2 WHERE id = ?3')
      .bind(prev, hash, row.id)
      .run();
    prev = hash;
  }
}
