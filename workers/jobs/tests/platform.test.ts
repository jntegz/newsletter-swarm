// Phase 7, Open API workstream: the migration shim's exclusion rules in the import job, and the
// daily housekeeping (old Idempotency-Keys, audit retention per plan, and OAuth metadata
// document clients that are no longer used).
import { env } from 'cloudflare:test';
import { AUDIT_VERIFY_PAGE, appendAudit, pruneAuditEvents, verifyAuditChain } from '@swarm/db';
import { newId, type ImportReport } from '@swarm/domain';
import { MONTH_MS, appendAgentAction, auditRetentionMs } from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeImport, runImport } from '../src/handlers/imports';
import {
  VERIFY_WORKSPACES_PER_RUN,
  maintainPlatform,
  pruneMetadataClients,
  verifyAuditChains,
} from '../src/handlers/platform';
import { count, jobsEnv, one, seedChannel, seedImport } from './helpers';

let seed: { workspaceId: string; channelId: string };

beforeEach(async () => {
  seed = await seedChannel();
});

describe('imports from other platforms', () => {
  const CSV = [
    'email,name,status,email_disabled',
    'keep@example.com,Ada,active,false',
    'left@example.com,Bob,unsubscribed,false',
    'off@example.com,Cy,active,TRUE',
    '',
  ].join('\r\n');
  const columns = ['email', 'name', 'status', 'email_disabled'];
  const map = { email: 'email', name: 'first_name', status: null, email_disabled: null } as const;

  async function seedPlatformImport(status: string) {
    const jobId = await seedImport(seed, CSV, columns, map, { status, consent: true });
    const mapping = {
      columns,
      map,
      source: 'platform_csv',
      exclude: [
        { column: 'status', values: ['unsubscribed', 'inactive'] },
        { column: 'email_disabled', values: ['true'] },
      ],
    };
    await env.DB.prepare('UPDATE import_jobs SET mapping_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(mapping), jobId)
      .run();
    return jobId;
  }

  it('counts people who unsubscribed there as suppressed in the dry run', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedPlatformImport('analyzing');
    await analyzeImport(jobs, jobId);
    const row = await one<{ report_json: string }>(
      'SELECT report_json FROM import_jobs WHERE id = ?1',
      jobId,
    );
    const report = JSON.parse(row!.report_json) as ImportReport;
    expect(report.counts).toMatchObject({ new: 1, suppressed: 2 });
    expect(report.samples.suppressed.map((s) => [s.email, s.reason])).toEqual([
      ['left@example.com', 'Unsubscribed on the previous platform.'],
      ['off@example.com', 'Unsubscribed on the previous platform.'],
    ]);
  });

  it('never imports them', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedPlatformImport('importing');
    await runImport(jobs, jobId);
    const emails = await env.DB.prepare('SELECT email FROM members WHERE channel_id = ?1')
      .bind(seed.channelId)
      .all<{ email: string }>();
    expect(emails.results.map((r) => r.email)).toEqual(['keep@example.com']);
  });
});

describe('platform housekeeping', () => {
  it('prunes Idempotency-Keys older than 24 hours', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
         VALUES ('key:ky_1', 'old', 'POST', '/v2/x', 'h', 201, '{}', ?1),
                ('key:ky_1', 'new', 'POST', '/v2/x', 'h', 201, '{}', ?2)`,
      ).bind(now - 25 * 3_600_000, now - 3_600_000),
    ]);
    await maintainPlatform(jobsEnv().env, now);
    const keys = await env.DB.prepare(
      "SELECT key FROM api_idempotency WHERE principal = 'key:ky_1'",
    ).all<{ key: string }>();
    expect(keys.results.map((r) => r.key)).toEqual(['new']);
  });

  it('applies audit retention by plan and keeps the chain verifiable', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await appendAudit(env.DB, { workspaceId: seed.workspaceId, actorId: null, action: `t.${i}` });
    }
    // The free plan keeps 30 days. Rewrite the first two as 40 days old, re-chained.
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = ?1 WHERE workspace_id = ?2 AND seq <= 2',
    )
      .bind(now - 40 * 86_400_000, seed.workspaceId)
      .run();
    await rechain(seed.workspaceId);
    await maintainPlatform(jobsEnv().env, now);
    expect(
      await count(
        'SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND seq <= 2',
        seed.workspaceId,
      ),
    ).toBe(0);
    expect(await verifyAuditChain(env.DB, seed.workspaceId)).toMatchObject({
      ok: true,
      anchorSeq: 2,
    });

    // The top plan has no limit of its own: the workspace's setting (24 months by default) is.
    const other = await seedChannel();
    await env.DB.prepare("UPDATE workspaces SET plan = 'enterprise' WHERE id = ?1")
      .bind(other.workspaceId)
      .run();
    for (let i = 0; i < 3; i++) {
      await appendAudit(env.DB, {
        workspaceId: other.workspaceId,
        actorId: null,
        action: `e.${i}`,
      });
    }
    // The first is 25 months old, the second 23.
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE audit_events SET created_at = ?1 WHERE workspace_id = ?2 AND seq = 1',
      ).bind(now - 25 * MONTH_MS, other.workspaceId),
      env.DB.prepare(
        'UPDATE audit_events SET created_at = ?1 WHERE workspace_id = ?2 AND seq = 2',
      ).bind(now - 23 * MONTH_MS, other.workspaceId),
    ]);
    await rechain(other.workspaceId);
    await maintainPlatform(jobsEnv().env, now);
    const kept = async () =>
      (
        await env.DB.prepare('SELECT action FROM audit_events WHERE workspace_id = ?1 ORDER BY seq')
          .bind(other.workspaceId)
          .all<{ action: string }>()
      ).results.map((row) => row.action);
    // A checkpoint entry names what went, and the rest still verifies from the anchor.
    expect(await kept()).toEqual(['e.1', 'e.2', 'audit.pruned']);
    expect(await verifyAuditChain(env.DB, other.workspaceId)).toMatchObject({
      ok: true,
      anchorSeq: 1,
    });

    // A shorter setting prunes sooner; the plan's own shorter limit still wins over a longer one.
    await env.DB.prepare('UPDATE workspaces SET audit_retention_months = 12 WHERE id = ?1')
      .bind(other.workspaceId)
      .run();
    await maintainPlatform(jobsEnv().env, now);
    expect(await kept()).toEqual(['e.2', 'audit.pruned', 'audit.pruned']);
    expect((await verifyAuditChain(env.DB, other.workspaceId)).ok).toBe(true);
    expect(auditRetentionMs('free', 60)).toBe(30 * 86_400_000);
    expect(auditRetentionMs('enterprise', 60)).toBe(60 * MONTH_MS);
  });
});

describe('audit chain verification', () => {
  const DAY = 86_400_000;
  const record = (workspaceId: string) =>
    one<{ ok: number; checked: number; broken_at_seq: number | null; broken_since: number | null }>(
      "SELECT ok, checked, broken_at_seq, broken_since FROM audit_verifications WHERE workspace_id = ?1 AND chain = 'audit_events'",
      workspaceId,
    );

  it('verifies every chain once a day and records a break until it is repaired', async () => {
    for (let i = 0; i < 3; i++) {
      await appendAudit(env.DB, { workspaceId: seed.workspaceId, actorId: null, action: `t.${i}` });
    }
    const now = Date.now();
    await verifyAuditChains(jobsEnv().env, now);
    expect(await record(seed.workspaceId)).toMatchObject({ ok: 1, checked: 3, broken_since: null });

    // Verified today: the next run leaves it alone.
    const again = await verifyAuditChains(jobsEnv().env, now + 60_000);
    expect(again.broken).not.toContainEqual({
      chain: 'audit_events',
      workspaceId: seed.workspaceId,
    });

    // Someone edits a past event.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 2",
    )
      .bind(seed.workspaceId)
      .run();
    const tomorrow = now + DAY;
    expect((await verifyAuditChains(jobsEnv().env, tomorrow)).broken).toContainEqual({
      chain: 'audit_events',
      workspaceId: seed.workspaceId,
    });
    expect(await record(seed.workspaceId)).toMatchObject({
      ok: 0,
      checked: 1,
      broken_at_seq: 2,
      broken_since: tomorrow,
    });
    // Still broken the day after: first seen stays.
    await verifyAuditChains(jobsEnv().env, tomorrow + DAY);
    expect(await record(seed.workspaceId)).toMatchObject({ ok: 0, broken_since: tomorrow });
  });

  it('verifies the agent log too', async () => {
    for (let i = 0; i < 2; i++) {
      await appendAgentAction(env.DB, {
        workspaceId: seed.workspaceId,
        source: 'mcp',
        principalKind: 'key',
        principalId: 'ky_1',
        clientName: null,
        clientVersion: null,
        tool: 'list_channels',
        channelId: null,
        risk: 'read',
        arguments: {},
        outcome: 'ok',
        statusCode: 200,
        errorCode: null,
        latencyMs: 5,
        approvalId: null,
      });
    }
    const now = Date.now();
    await verifyAuditChains(jobsEnv().env, now);
    const agentRecord = () =>
      one<{ ok: number; checked: number }>(
        "SELECT ok, checked FROM audit_verifications WHERE workspace_id = ?1 AND chain = 'agent_actions'",
        seed.workspaceId,
      );
    expect(await agentRecord()).toMatchObject({ ok: 1, checked: 2 });
    await env.DB.prepare(
      "UPDATE agent_actions SET tool = 'delete_member' WHERE workspace_id = ?1 AND seq = 1",
    )
      .bind(seed.workspaceId)
      .run();
    const run = await verifyAuditChains(jobsEnv().env, now + DAY);
    expect(run.broken).toContainEqual({ chain: 'agent_actions', workspaceId: seed.workspaceId });
    expect(await agentRecord()).toMatchObject({ ok: 0, checked: 0 });
  });

  it('stays bounded per run and verifies long chains page by page', async () => {
    const statements = [];
    for (let seq = 1; seq <= AUDIT_VERIFY_PAGE + 5; seq++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO audit_events (id, workspace_id, seq, actor_operator_id, action, target_type,
             target_id, metadata_json, ip_prefix, created_at, prev_hash, hash)
           VALUES (?1, ?2, ?3, NULL, 't', NULL, NULL, '{}', NULL, ?4, '', '')`,
        ).bind(`ae_${crypto.randomUUID().replace(/-/g, '')}`, seed.workspaceId, seq, 1000 + seq),
      );
    }
    await env.DB.batch(statements);
    await rechain(seed.workspaceId);
    expect(await verifyAuditChain(env.DB, seed.workspaceId)).toMatchObject({
      ok: true,
      checked: AUDIT_VERIFY_PAGE + 5,
    });
    const run = await verifyAuditChains(jobsEnv().env, Date.now() + 2 * DAY);
    expect(run.verified).toBeLessThanOrEqual(VERIFY_WORKSPACES_PER_RUN);
  });

  /** A chain of `n` events, written directly and hashed in one go. */
  async function chainOf(workspaceId: string, n: number): Promise<void> {
    const statements = [];
    for (let seq = 1; seq <= n; seq++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO audit_events (id, workspace_id, seq, actor_operator_id, action, target_type,
             target_id, metadata_json, ip_prefix, created_at, prev_hash, hash)
           VALUES (?1, ?2, ?3, NULL, 't', NULL, NULL, '{}', NULL, ?4, '', '')`,
        ).bind(`ae_${crypto.randomUUID().replace(/-/g, '')}`, workspaceId, seq, 1000 + seq),
      );
    }
    await env.DB.batch(statements);
    await rechain(workspaceId);
  }

  /** Verifies whatever earlier tests left due, so only this test's chains are due after it. */
  async function drain(now: number): Promise<void> {
    while ((await verifyAuditChains(jobsEnv().env, now)).verified) {
      // Next batch of workspaces.
    }
  }

  const pass = (workspaceId: string) =>
    one<{ through_seq: number; checked: number }>(
      "SELECT through_seq, checked FROM audit_verification_passes WHERE workspace_id = ?1 AND chain = 'audit_events'",
      workspaceId,
    );

  it('verifies a long chain over several runs and still finds a break past the checkpoint', async () => {
    const now = Date.now() + 10 * DAY;
    await drain(now);
    await chainOf(seed.workspaceId, 25);
    const budget = { eventsPerChain: 10 };

    await verifyAuditChains(jobsEnv().env, now + 1, budget);
    // Not finished: no result yet, and the next run starts after the checkpoint.
    expect(await record(seed.workspaceId)).toBeNull();
    expect(await pass(seed.workspaceId)).toMatchObject({ through_seq: 10, checked: 10 });

    // Someone edits an event the pass has not reached yet.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 18",
    )
      .bind(seed.workspaceId)
      .run();
    const second = await verifyAuditChains(jobsEnv().env, now + 2, budget);
    expect(second.broken).toContainEqual({ chain: 'audit_events', workspaceId: seed.workspaceId });
    expect(await record(seed.workspaceId)).toMatchObject({
      ok: 0,
      checked: 17,
      broken_at_seq: 18,
      broken_since: now + 2,
    });
    expect(await pass(seed.workspaceId)).toBeNull();

    // Repaired: the next day's pass starts from the beginning again and finishes in three runs.
    await rechain(seed.workspaceId);
    // Only this workspace is due the next day.
    await env.DB.prepare('UPDATE audit_verifications SET verified_at = ?1 WHERE workspace_id != ?2')
      .bind(now + DAY, seed.workspaceId)
      .run();
    for (let i = 0; i < 3; i++) await verifyAuditChains(jobsEnv().env, now + DAY + 2 + i, budget);
    expect(await record(seed.workspaceId)).toMatchObject({
      ok: 1,
      checked: 25,
      broken_since: null,
    });
  });

  it('verifies other workspaces while a long chain is still in progress', async () => {
    const now = Date.now() + 20 * DAY;
    await drain(now);
    await chainOf(seed.workspaceId, 25);
    const other = await seedChannel();
    await chainOf(other.workspaceId, 3);
    const budget = { eventsPerChain: 10 };

    // The long chain is first (lower id) and takes the whole budget.
    await verifyAuditChains(jobsEnv().env, now + 1, budget);
    expect(await record(other.workspaceId)).toBeNull();
    expect(await pass(seed.workspaceId)).toMatchObject({ through_seq: 10 });
    // It goes behind the workspaces no run has looked at since: the short one is next.
    await verifyAuditChains(jobsEnv().env, now + 2, budget);
    expect(await record(other.workspaceId)).toMatchObject({ ok: 1, checked: 3 });
    expect(await pass(seed.workspaceId)).toMatchObject({ through_seq: 17 });
    await verifyAuditChains(jobsEnv().env, now + 3, budget);
    expect(await record(seed.workspaceId)).toMatchObject({ ok: 1, checked: 25 });
  });

  it('gives the agent log its own budget, so a long audit pass does not starve it', async () => {
    const now = Date.now() + 30 * DAY;
    await drain(now);
    await chainOf(seed.workspaceId, 25);
    const other = await seedChannel();
    for (let i = 0; i < 2; i++) {
      await appendAgentAction(env.DB, {
        workspaceId: other.workspaceId,
        source: 'mcp',
        principalKind: 'key',
        principalId: 'ky_1',
        clientName: null,
        clientVersion: null,
        tool: 'list_channels',
        channelId: null,
        risk: 'read',
        arguments: {},
        outcome: 'ok',
        statusCode: 200,
        errorCode: null,
        latencyMs: 5,
        approvalId: null,
      });
    }
    // The audit pass uses its whole budget; the agent log is still verified in the same run.
    await verifyAuditChains(jobsEnv().env, now + 1, { eventsPerChain: 10 });
    expect(await pass(seed.workspaceId)).toMatchObject({ through_seq: 10 });
    expect(
      await one<{ ok: number; checked: number }>(
        "SELECT ok, checked FROM audit_verifications WHERE workspace_id = ?1 AND chain = 'agent_actions'",
        other.workspaceId,
      ),
    ).toMatchObject({ ok: 1, checked: 2 });
  });

  it('checks a prune only up to the prune point, and never prunes a chain recorded as broken', async () => {
    const now = Date.now();
    await chainOf(seed.workspaceId, 30);
    // Events 1 to 20 are past the free plan's 30 days; 21 to 30 are recent.
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = ?1 + seq WHERE workspace_id = ?2 AND seq > 20',
    )
      .bind(now, seed.workspaceId)
      .run();
    await rechain(seed.workspaceId);
    // A break among the kept events: pruning before it destroys no evidence of it.
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 25",
    )
      .bind(seed.workspaceId)
      .run();
    const before = now - 30 * DAY;
    expect(await pruneAuditEvents(env.DB, seed.workspaceId, before, now)).toEqual({
      pruned: 20,
      throughSeq: 20,
    });
    expect(await verifyAuditChain(env.DB, seed.workspaceId)).toMatchObject({
      ok: false,
      brokenAtSeq: 25,
      anchorSeq: 20,
    });

    // Once the verification cron has recorded the break, nothing more is pruned.
    const other = await seedChannel();
    await chainOf(other.workspaceId, 10);
    await env.DB.prepare(
      'UPDATE audit_events SET created_at = ?1 + seq WHERE workspace_id = ?2 AND seq > 5',
    )
      .bind(now, other.workspaceId)
      .run();
    await rechain(other.workspaceId);
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'edited' WHERE workspace_id = ?1 AND seq = 8",
    )
      .bind(other.workspaceId)
      .run();
    await env.DB.prepare(
      `INSERT INTO audit_verifications (workspace_id, chain, verified_at, ok, checked, broken_at_seq, broken_since)
       VALUES (?1, 'audit_events', ?2, 0, 7, 8, ?2)`,
    )
      .bind(other.workspaceId, now)
      .run();
    expect(await pruneAuditEvents(env.DB, other.workspaceId, before, now)).toEqual({
      pruned: 0,
      throughSeq: null,
      refused: 'broken_chain',
    });
  });
});

describe('OAuth metadata document clients', () => {
  const DAY = 86_400_000;

  /** A metadata client's app row with one grant, its refresh token set up by `token`. */
  async function seedClient(
    url: string,
    createdAt: number,
    grant: { revoked?: boolean; token?: 'live' | 'expired' | 'used' | null },
  ): Promise<string> {
    const appId = newId('oauthApp');
    const grantId = newId('oauthGrant');
    const statements = [
      env.DB.prepare(
        `INSERT INTO oauth_apps (id, workspace_id, name, client_id, redirect_uris_json, scopes_json,
           created_at, updated_at, metadata_url)
         VALUES (?1, ?2, 'Agent', ?3, '[]', '[]', ?4, ?4, ?5)`,
      ).bind(appId, seed.workspaceId, `swm_${crypto.randomUUID()}`, createdAt, url),
      env.DB.prepare(
        `INSERT INTO oauth_grants (id, app_id, workspace_id, scopes_json, code_consumed_at, created_at, revoked_at, resource)
         VALUES (?1, ?2, ?3, '[]', ?4, ?4, ?5, 'mcp')`,
      ).bind(grantId, appId, seed.workspaceId, createdAt, grant.revoked ? createdAt : null),
    ];
    if (grant.token) {
      const now = Date.now();
      statements.push(
        env.DB.prepare(
          `INSERT INTO oauth_tokens (id, grant_id, family_id, kind, token_hash, expires_at, used_at, created_at)
           VALUES (?1, ?2, ?2, 'refresh', ?3, ?4, ?5, ?6)`,
        ).bind(
          newId('oauthToken'),
          grantId,
          crypto.randomUUID(),
          grant.token === 'expired' ? now - DAY : now + DAY,
          grant.token === 'used' ? now - 1000 : null,
          createdAt,
        ),
      );
    }
    await env.DB.batch(statements);
    return appId;
  }

  it('drops clients without a live grant and old cached documents, and keeps the rest', async () => {
    const now = Date.now();
    const old = now - 3 * DAY;
    const live = await seedClient('https://a.example/client.json', old, { token: 'live' });
    const revoked = await seedClient('https://b.example/client.json', old, {
      revoked: true,
      token: 'live',
    });
    const expired = await seedClient('https://c.example/client.json', old, { token: 'expired' });
    const used = await seedClient('https://d.example/client.json', old, { token: 'used' });
    // Younger than a day: a consent may still be finishing.
    const fresh = await seedClient('https://e.example/client.json', now - 1000, { token: null });
    await env.DB.prepare(
      `INSERT INTO oauth_client_documents (url, status, error, fetched_at, expires_at)
       VALUES ('https://old.example/c.json', 'error', 'x', ?1, ?1),
              ('https://new.example/c.json', 'error', 'x', ?2, ?2)`,
    )
      .bind(now - 8 * DAY, now - DAY)
      .run();

    const result = await pruneMetadataClients(env.DB, now);
    expect(result.metadataClients).toBeGreaterThanOrEqual(3);
    const left = await env.DB.prepare('SELECT id FROM oauth_apps WHERE id IN (?1, ?2, ?3, ?4, ?5)')
      .bind(live, revoked, expired, used, fresh)
      .all<{ id: string }>();
    expect(left.results.map((r) => r.id).sort()).toEqual([live, fresh].sort());
    // Their grants and tokens went with them.
    expect(
      await count(
        'SELECT count(*) AS n FROM oauth_grants WHERE app_id IN (?1, ?2, ?3)',
        revoked,
        expired,
        used,
      ),
    ).toBe(0);
    const docs = await env.DB.prepare(
      "SELECT url FROM oauth_client_documents WHERE url LIKE 'https://%.example/c.json'",
    ).all<{ url: string }>();
    expect(docs.results.map((r) => r.url)).toEqual(['https://new.example/c.json']);
  });

  it('never touches registered apps', async () => {
    const now = Date.now();
    const appId = newId('oauthApp');
    await env.DB.prepare(
      `INSERT INTO oauth_apps (id, workspace_id, name, client_id, redirect_uris_json, scopes_json, created_at, updated_at)
       VALUES (?1, ?2, 'Registered', ?3, '[]', '[]', 1, 1)`,
    )
      .bind(appId, seed.workspaceId, `swc_${crypto.randomUUID()}`)
      .run();
    await maintainPlatform(jobsEnv().env, now);
    expect(await count('SELECT count(*) AS n FROM oauth_apps WHERE id = ?1', appId)).toBe(1);
  });
});

/** Recomputes hashes after a test moved timestamps (as if the events had been written then). */
async function rechain(workspaceId: string): Promise<void> {
  const { canonicalJson, sha256Hex } = await import('@swarm/db');
  const rows = await env.DB.prepare(
    `SELECT id, seq, workspace_id, actor_operator_id, action, target_type, target_id, metadata_json, created_at
       FROM audit_events WHERE workspace_id = ?1 ORDER BY seq`,
  )
    .bind(workspaceId)
    .all<Record<string, unknown>>();
  let prev = '0'.repeat(64);
  for (const row of rows.results) {
    const hash = await sha256Hex(
      `${prev}\n${canonicalJson({
        seq: row.seq,
        workspaceId: row.workspace_id,
        actorId: row.actor_operator_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: JSON.parse(row.metadata_json as string) as unknown,
        createdAt: row.created_at,
      })}`,
    );
    await env.DB.prepare('UPDATE audit_events SET prev_hash = ?1, hash = ?2 WHERE id = ?3')
      .bind(prev, hash, row.id)
      .run();
    prev = hash;
  }
}
