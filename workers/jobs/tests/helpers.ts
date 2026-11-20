import { env } from 'cloudflare:test';
import {
  newId,
  type FieldType,
  type FieldValue,
  type ImportTarget,
  type MemberStatus,
} from '@swarm/domain';
import { type ChannelField, type FieldVault, type JobMessage } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { fromStored, toStored } from '@swarm/vault/testing';
import { parseJobsEnv, type JobsEnv } from '../src/env';

/** The vault's test field key (tests/setup.ts fakeVaultEnv): seeds and reads stored values. */
export const testFieldKeys = parseKeyring(env.TEST_FIELD_KEYS);

/**
 * Field values sealed and opened with the test key directly, as the vault's legacy format does,
 * for tests that seed or read values outside a job's authority.
 */
export function testFieldVault(fields: Map<string, ChannelField>): FieldVault {
  const byKey = (key: string) => fields.get(key) as ChannelField;
  return {
    seal: async (_memberId, values) => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        out[key] = (await toStored(byKey(key), value, testFieldKeys))?.value_enc as string;
      }
      return out;
    },
    open: async (memberIds) => {
      const out: Record<string, Record<string, FieldValue>> = {};
      const rows = await env.DB.prepare(
        `SELECT v.member_id, f.key, v.value_enc FROM member_field_values v
           JOIN member_fields f ON f.id = v.field_id
          WHERE v.value_enc IS NOT NULL AND v.member_id IN (SELECT value FROM json_each(?1))`,
      )
        .bind(JSON.stringify(memberIds))
        .all<{ member_id: string; key: string; value_enc: string }>();
      for (const row of rows.results) {
        const field = fields.get(row.key);
        if (!field) continue;
        (out[row.member_id] ??= {})[row.key] = await fromStored(
          field,
          { value_text: null, value_num: null, value_enc: row.value_enc },
          testFieldKeys,
        );
      }
      return out;
    },
  };
}

/** A queue the test drains by hand, so continuation messages are visible and deterministic. */
class MemoryJobs {
  readonly items: JobMessage[] = [];
  async send(message: JobMessage) {
    this.items.push(message);
  }
}

export function jobsEnv(queue = new MemoryJobs()): { env: JobsEnv; queue: MemoryJobs } {
  return {
    env: { ...parseJobsEnv(env), JOBS_QUEUE: queue as unknown as Queue<JobMessage> },
    queue,
  };
}

export async function seedChannel(): Promise<{ workspaceId: string; channelId: string }> {
  const now = Date.now();
  const workspaceId = newId('workspace', now);
  const channelId = newId('channel', now);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, 'Field Notes', ?2, ?2)",
    ).bind(workspaceId, now),
    env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)",
    ).bind(channelId, workspaceId, `ch-${crypto.randomUUID().slice(0, 12)}`, now),
  ]);
  return { workspaceId, channelId };
}

export async function addMember(
  channelId: string,
  email: string,
  options: { status?: MemberStatus; firstName?: string; pausedUntil?: number } = {},
): Promise<string> {
  const now = Date.now();
  const id = newId('member', now);
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, first_name, status, paused_until, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      channelId,
      email,
      options.firstName ?? null,
      options.status ?? 'active',
      options.pausedUntil ?? null,
      now,
    )
    .run();
  return id;
}

export async function addField(
  channelId: string,
  key: string,
  type: FieldType,
  options: { choices?: string[]; encrypted?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  const id = newId('memberField', now);
  await env.DB.prepare(
    `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, encrypted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      channelId,
      key,
      type,
      JSON.stringify(options.choices ?? []),
      options.encrypted ? 1 : 0,
      now,
    )
    .run();
  return id;
}

export async function seedImport(
  seed: { workspaceId: string; channelId: string },
  csv: string,
  columns: string[],
  map: Record<string, ImportTarget>,
  options: { consent?: boolean; update?: boolean; status?: string } = {},
): Promise<string> {
  const now = Date.now();
  const id = newId('importJob', now);
  const key = `ws/${seed.workspaceId}/ch/${seed.channelId}/${id}.csv`;
  const bytes = new TextEncoder().encode(csv);
  await env.IMPORTS.put(key, bytes);
  await env.DB.prepare(
    `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, mapping_json,
       consent_attested, update_existing, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'list.csv', ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  )
    .bind(
      id,
      seed.workspaceId,
      seed.channelId,
      options.status ?? 'analyzing',
      key,
      bytes.byteLength,
      JSON.stringify({ columns, map }),
      options.consent ? 1 : 0,
      options.update ? 1 : 0,
      now,
    )
    .run();
  return id;
}

export const one = <T>(sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .first<T>();

export const count = async (sql: string, ...params: unknown[]) =>
  (await one<{ n: number }>(sql, ...params))?.n ?? 0;

/**
 * An admin of the workspace who stands behind its standing feeds (export destinations, webhook
 * endpoints): feeds run only while the operator who confirmed them keeps the admin role
 * (packages/engine/src/feed-authority.ts). Returns their operator id.
 */
export async function seedFeedAdmin(workspaceId: string, role = 'admin'): Promise<string> {
  const now = Date.now();
  const operatorId = newId('operator', now);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(operatorId, `feed-admin-${crypto.randomUUID().slice(0, 8)}@example.com`, now),
    env.DB.prepare(
      'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
    ).bind(newId('seat', now), workspaceId, operatorId, role, now),
  ]);
  return operatorId;
}
