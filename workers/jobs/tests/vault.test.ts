// The jobs worker holds no FIELD_KEYS (B4): its env refuses the secret on a deployed worker and
// needs the VAULT binding; no source file opens or seals a value itself; and with the vault down,
// work that needs it is retried rather than done without it (fail closed).
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { channelFields, fieldValueStatements, prepareFieldValues } from '@swarm/engine';
import { createDownVault, createFakeVault, fakeVaultEnv, useVaultForTests } from '@swarm/vault';
import { afterEach, describe, expect, it } from 'vitest';
import { MINUTE_CRON } from '../src/crons';
import { parseJobsEnv } from '../src/env';
import { runScheduled } from '../src/index';
import { recordVaultHeartbeat } from '../src/vault';
import { runExport } from '../src/handlers/exports';
import {
  addField,
  addMember,
  jobsEnv,
  one,
  seedChannel,
  seedFeedAdmin,
  testFieldVault,
} from './helpers';

const restore = async () =>
  useVaultForTests('jobs', createFakeVault('jobs', await fakeVaultEnv(env.DB)));
afterEach(restore);

describe('jobs and FIELD_KEYS', () => {
  it('refuses FIELD_KEYS and needs VAULT once deployed', () => {
    const deployed = {
      ...env,
      ENVIRONMENT: 'production',
      MAIL_ADAPTER: 'ses',
      AWS_ACCESS_KEY_ID: 'AKIA0000000000000000',
      AWS_SECRET_ACCESS_KEY: 's'.repeat(40),
      SES_CONFIGURATION_SET: 'swarm-transactional',
      WEB_HOSTNAMES: 'off',
      SITE_SCHEME: 'https',
      PAYMENTS: 'off',
      DNS_RESOLVER: 'doh',
    };
    expect(() => parseJobsEnv({ ...deployed, FIELD_KEYS: `f1:${'f'.repeat(64)}` })).toThrow(
      /FIELD_KEYS: is held by the vault Worker alone/,
    );
    expect(() => parseJobsEnv({ ...deployed, FIELD_KEYS: undefined, VAULT: undefined })).toThrow(
      /VAULT: the VAULT service binding is missing/,
    );
  });

  it('has no source that opens, seals or names FIELD_KEYS', () => {
    const sources = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(
        /env\.FIELD_KEYS|\b(encrypt|decrypt|encryptFor|decryptFor|toStored|fromStored|sealV3|openV3|macFor)\(/,
      );
    }
  });
});

describe('with the vault down', () => {
  async function exportReady() {
    const seed = await seedChannel();
    await addField(seed.channelId, 'secret', 'text', { encrypted: true });
    const fields = await channelFields(env.DB, seed.channelId);
    const memberId = await addMember(
      seed.channelId,
      `v-${crypto.randomUUID().slice(0, 6)}@example.com`,
    );
    const values = await prepareFieldValues(
      fields,
      { secret: 'hush' },
      testFieldVault(fields),
      memberId,
    );
    await env.DB.batch(fieldValueStatements(env.DB, memberId, values, Date.now()));
    const jobId = newId('exportJob');
    const admin = await seedFeedAdmin(seed.workspaceId);
    await env.DB.prepare(
      `INSERT INTO export_jobs (id, workspace_id, channel_id, format, filter_json, created_by, created_at)
       VALUES (?1, ?2, ?3, 'csv', '{}', ?4, ?5)`,
    )
      .bind(jobId, seed.workspaceId, seed.channelId, admin, Date.now())
      .run();
    return { seed, jobId, admin };
  }

  it('an export writes nothing and is retried, never written without its fields', async () => {
    const { jobId } = await exportReady();
    useVaultForTests('jobs', createDownVault<'jobs'>());
    await expect(runExport(jobsEnv().env, jobId)).rejects.toThrow(/temporarily unavailable/);
    const job = await one<{ status: string; row_count: number }>(
      'SELECT status, row_count FROM export_jobs WHERE id = ?1',
      jobId,
    );
    expect(job?.row_count).toBe(0);
    expect(job?.status).not.toBe('done');
  });

  it('the vault itself refuses an export whose creator is no longer an admin', async () => {
    const { seed, jobId, admin } = await exportReady();
    const vault = createFakeVault('jobs', await fakeVaultEnv(env.DB));
    const memberIds = [
      (await one<{ id: string }>('SELECT id FROM members WHERE channel_id = ?1', seed.channelId))!
        .id,
    ];
    await env.DB.prepare("UPDATE export_jobs SET status = 'running' WHERE id = ?1")
      .bind(jobId)
      .run();
    const before = await vault.openMemberFields(
      { kind: 'export-job', jobId },
      { channelId: seed.channelId, memberIds },
    );
    expect(before).toMatchObject({ ok: true });
    await env.DB.prepare("UPDATE seats SET role = 'editor' WHERE operator_id = ?1")
      .bind(admin)
      .run();
    expect(
      await vault.openMemberFields(
        { kind: 'export-job', jobId },
        { channelId: seed.channelId, memberIds },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('the vault heartbeat', () => {
  const heartbeat = () =>
    one<{ checked_at: number; ok: number; ok_at: number | null }>(
      "SELECT checked_at, ok, ok_at FROM worker_heartbeats WHERE worker = 'jobs'",
    );

  it('is recorded by the minute cron, and keeps the last success while the vault is down', async () => {
    const up = Date.now();
    await runScheduled(jobsEnv().env, MINUTE_CRON, up);
    expect(await heartbeat()).toEqual({ checked_at: up, ok: 1, ok_at: up });

    useVaultForTests('jobs', createDownVault<'jobs'>());
    const down = up + 60_000;
    await runScheduled(jobsEnv().env, MINUTE_CRON, down);
    expect(await heartbeat()).toEqual({ checked_at: down, ok: 0, ok_at: up });

    await restore();
    expect(await recordVaultHeartbeat(jobsEnv().env, down + 60_000)).toBe(true);
    expect(await heartbeat()).toEqual({ checked_at: down + 60_000, ok: 1, ok_at: down + 60_000 });
  });
});
