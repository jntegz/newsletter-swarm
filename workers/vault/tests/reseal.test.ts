// The vault's cron: every stored value moved to the row-bound v3 format, the binding read from
// the row itself; values that will not open left in place and counted; a write made in between
// never undone; and, while writes are still legacy, the same rotation re-seal the jobs worker
// runs, on the same progress row.
import { env } from 'cloudflare:workers';
import { FIELD_SEALED_COLUMNS, sealedValueSql, sealedWithOtherKeySql } from '@swarm/domain';
import { encrypt, encryptFor, isSealedV3, sealAppKey, sealedKeyId } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { contextFromEnv, COLUMN_SPECS, openValue, resealToCurrent } from '@swarm/vault/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { addField, addMember, addOperator, rows, seedChannel, sql, storeValue } from './helpers';

const OLD = `f0:${'o'.repeat(64)}`;
const keys = parseKeyring(`${env.FIELD_KEYS},${OLD}`);
const oldKeys = parseKeyring(OLD);

async function cron(vars: Record<string, string>, now = Date.now()) {
  const ctx = await contextFromEnv(
    { ...env, FIELD_KEYS: `${env.FIELD_KEYS},${OLD}`, ...vars },
    'vault',
    {
      now: () => now,
    },
  );
  const runs = [];
  for (let i = 0; i < 50; i++) {
    const result = await resealToCurrent(ctx);
    if (!result) break;
    runs.push(result);
    if (result.finished) break;
  }
  return { ctx, runs };
}

/** One row in every sealed column, each in its legacy format under the old key. */
async function seedEverything() {
  const { workspaceId, channelId } = await seedChannel();
  const now = Date.now();
  const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  const fieldId = await addField(channelId, 'tax_id');
  const memberId = await addMember(channelId);
  await storeValue(memberId, fieldId, await encrypt(oldKeys, '"DE-1"'));
  const { operatorId } = await addOperator(workspaceId, 'owner');
  await sql(
    'INSERT INTO totp_secrets (operator_id, secret_enc, created_at) VALUES (?1, ?2, ?3)',
    operatorId,
    await encrypt(oldKeys, 'JBSWY3DP'),
    now,
  );
  const flowId = id('fl');
  await sql(
    `INSERT INTO flows (id, workspace_id, channel_id, name, draft_graph_json, webhook_secret_enc, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'F', '{}', ?4, ?5, ?5)`,
    flowId,
    workspaceId,
    channelId,
    await encrypt(oldKeys, 'whsec_flow'),
    now,
  );
  const endpointId = id('wh');
  await sql(
    `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, previous_secret_enc, created_at, updated_at)
     VALUES (?1, ?2, 'https://h.example.test/', '[]', ?3, ?4, ?5, ?5)`,
    endpointId,
    workspaceId,
    await encrypt(oldKeys, 'whsec_now'),
    await encrypt(oldKeys, 'whsec_before'),
    now,
  );
  const ssoId = id('so');
  await sql(
    `INSERT INTO sso_connections (id, workspace_id, protocol, domains_json, config_json, created_at, updated_at)
     VALUES (?1, ?2, 'oidc', '[]', ?3, ?4, ?4)`,
    ssoId,
    workspaceId,
    JSON.stringify({
      issuer: 'https://idp.example.com',
      clientId: 'c',
      clientSecretEnc: await encrypt(oldKeys, 'sso-secret'),
    }),
    now,
  );
  const destinationId = id('xd');
  await sql(
    `INSERT INTO export_destinations (id, workspace_id, channel_id, kind, config_json, credentials_enc, created_at, updated_at)
     VALUES (?1, ?2, ?3, 's3', '{}', ?4, ?5, ?5)`,
    destinationId,
    workspaceId,
    channelId,
    await encrypt(
      oldKeys,
      JSON.stringify({
        w: workspaceId,
        d: destinationId,
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      }),
    ),
    now,
  );
  const requestId = id('pr');
  await sql(
    `INSERT INTO dsr_requests (id, workspace_id, email_hash, kind, source, status, due_at, created_at, updated_at, email_enc)
     VALUES (?1, ?2, 'h', 'export', 'operator', 'pending', ?3, ?3, ?3, ?4)`,
    requestId,
    workspaceId,
    now,
    await encryptFor(oldKeys, 'dsr-address', 'p@example.test'),
  );
  await sql(
    `INSERT INTO address_confirmations (workspace_id, channel_id, kind, email_enc, email_hash, created_at, expires_at)
     VALUES (?1, ?2, 'erase', ?3, ?4, ?5, ?6)`,
    workspaceId,
    channelId,
    await encryptFor(oldKeys, 'dsr-address', 'a@example.test'),
    `k1:${crypto.randomUUID()}`,
    now,
    now + 86_400_000,
  );
  await sql(
    `INSERT INTO copilot_keys (id, workspace_id, provider, key_enc, last4, validated_at, created_at, updated_at)
     VALUES (?1, ?2, 'anthropic', ?3, 'abcd', ?4, ?4, ?4)`,
    id('mk'),
    workspaceId,
    await sealAppKey(oldKeys, workspaceId, 'sk-ant-1'),
    now,
  );
  await sql(
    `INSERT INTO app_connections (id, workspace_id, app, base_url, key_enc, last4, slug_format, created_at, updated_at)
     VALUES (?1, ?2, 'shorthop', 'https://s.example.com', ?3, 'abcd', 'random', ?4, ?4)`,
    id('ac'),
    workspaceId,
    await sealAppKey(oldKeys, workspaceId, 'sh-key'),
    now,
  );
  await sql(
    `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, connected_at, updated_at, own_key_enc, webhook_secret_enc)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
    channelId,
    workspaceId,
    id('acct'),
    now,
    await sealAppKey(oldKeys, workspaceId, 'rk_test_own'),
    await sealAppKey(oldKeys, workspaceId, 'whsec_stripe'),
  );
  await sql(
    `INSERT INTO paypal_accounts (channel_id, workspace_id, mode, client_id, secret_enc, secret_last4, webhook_id, connected_at, updated_at)
     VALUES (?1, ?2, 'sandbox', 'c', ?3, '0123', 'w', ?4, ?4)`,
    channelId,
    workspaceId,
    await sealAppKey(oldKeys, workspaceId, 'pp-secret'),
    now,
  );
  return { workspaceId, channelId, memberId, fieldId };
}

const PLAIN: Record<string, string> = {
  'member_field_values.value_enc': '"DE-1"',
  'totp_secrets.secret_enc': 'JBSWY3DP',
  'flows.webhook_secret_enc': 'whsec_flow',
  'webhook_endpoints.secret_enc': 'whsec_now',
  'webhook_endpoints.previous_secret_enc': 'whsec_before',
  'sso_connections.config_json': 'sso-secret',
  'export_destinations.credentials_enc': JSON.stringify({
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
  }),
  'dsr_requests.email_enc': 'p@example.test',
  'address_confirmations.email_enc': 'a@example.test',
  'copilot_keys.key_enc': 'sk-ant-1',
  'app_connections.key_enc': 'sh-key',
  'stripe_accounts.own_key_enc': 'rk_test_own',
  'stripe_accounts.webhook_secret_enc': 'whsec_stripe',
  'paypal_accounts.secret_enc': 'pp-secret',
};

describe('the vault re-seal cron', () => {
  beforeEach(async () => {
    await sql('DELETE FROM field_key_reseal');
    for (const place of FIELD_SEALED_COLUMNS) await sql(`DELETE FROM ${place.table}`);
  });

  it('knows how to bind every sealed column', () => {
    expect(Object.keys(COLUMN_SPECS).sort()).toEqual(
      FIELD_SEALED_COLUMNS.map((p) => `${p.table}.${p.column}`).sort(),
    );
  });

  it('moves every value to v3 under the current key, bound to its row', async () => {
    await seedEverything();
    const { ctx, runs } = await cron({ VAULT_WRITE_FORMAT: 'v3' });
    expect(runs.at(-1)?.finished).toBe(true);
    expect(runs.reduce((n, r) => n + r.resealed, 0)).toBe(14);
    expect(runs.reduce((n, r) => n + r.unreadable, 0)).toBe(0);
    for (const place of FIELD_SEALED_COLUMNS) {
      const name = `${place.table}.${place.column}`;
      const spec = COLUMN_SPECS[name];
      if (!spec) throw new Error(name);
      const bindingSql = Object.entries(spec.binding)
        .map(([part, expr]) => `${expr} AS b_${part}`)
        .join(', ');
      const [row] = await rows<Record<string, string>>(
        `SELECT ${sealedValueSql(place)} AS sealed, ${bindingSql} FROM ${place.table}`,
      );
      if (!row) throw new Error(`no row in ${name}`);
      expect(isSealedV3(row.sealed as string), name).toBe(true);
      expect(sealedKeyId(row.sealed as string), name).toBe('f1');
      const parts = Object.fromEntries(
        Object.keys(spec.binding).map((part) => [part, row[`b_${part}`] as string]),
      );
      expect(await openValue(ctx, spec.kind, parts, row.sealed as string), name).toBe(PLAIN[name]);
      // The retire count sees nothing on the old key, and every value on the current one.
      const [old] = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${place.table} WHERE ${sealedWithOtherKeySql(place)}`,
        'f1',
      );
      expect(old?.n, name).toBe(0);
      const [current] = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${place.table} WHERE ${sealedWithOtherKeySql(place)}`,
        'f0',
      );
      expect(current?.n, name).toBe(1);
    }
    // Done: the next run has nothing to do.
    expect(await resealToCurrent(ctx)).toBeNull();
  });

  it('counts a value no key opens, and leaves it', async () => {
    const { memberId, fieldId } = await seedEverything();
    const lost = await encrypt(parseKeyring(`zz:${'z'.repeat(64)}`), '"gone"');
    await storeValue(memberId, fieldId, lost);
    const { runs } = await cron({ VAULT_WRITE_FORMAT: 'v3' });
    expect(runs.reduce((n, r) => n + r.unreadable, 0)).toBe(1);
    const [row] = await rows<{ value_enc: string }>(
      'SELECT value_enc FROM member_field_values WHERE member_id = ?1',
      memberId,
    );
    expect(row?.value_enc).toBe(lost);
    const [progress] = await rows<{ unreadable: number; finished_at: number | null }>(
      "SELECT unreadable, finished_at FROM field_key_reseal WHERE kid = 'v3:f1'",
    );
    expect(progress?.unreadable).toBe(1);
    expect(progress?.finished_at).not.toBeNull();
  });

  it('never undoes a write made after the value was read', async () => {
    const { memberId, fieldId } = await seedEverything();
    const ctx = await contextFromEnv(
      { ...env, FIELD_KEYS: `${env.FIELD_KEYS},${OLD}`, VAULT_WRITE_FORMAT: 'v3' },
      'vault',
    );
    const fresh = await encrypt(keys, '"new"');
    // Between the read and the conditional update, a caller saves a new value.
    const original = ctx.db;
    let raced = false;
    ctx.db = new Proxy(original, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            if (!raced && query.startsWith('UPDATE member_field_values')) {
              raced = true;
              return {
                bind: (...params: unknown[]) => ({
                  run: async () => {
                    await storeValue(memberId, fieldId, fresh);
                    return target
                      .prepare(query)
                      .bind(...params)
                      .run();
                  },
                }),
              };
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    await resealToCurrent(ctx);
    expect(raced).toBe(true);
    const [row] = await rows<{ value_enc: string }>(
      'SELECT value_enc FROM member_field_values WHERE member_id = ?1',
      memberId,
    );
    expect(row?.value_enc).toBe(fresh);
  });

  it('while writes are legacy, re-seals onto the current key in place, on the rotation’s progress row', async () => {
    const { memberId } = await seedEverything();
    const { runs } = await cron({ VAULT_WRITE_FORMAT: 'legacy' });
    expect(runs.at(-1)?.finished).toBe(true);
    expect(runs[0]?.target).toBe('f1');
    const [row] = await rows<{ value_enc: string }>(
      'SELECT value_enc FROM member_field_values WHERE member_id = ?1',
      memberId,
    );
    expect(isSealedV3(row?.value_enc as string)).toBe(false);
    expect(sealedKeyId(row?.value_enc as string)).toBe('f1');
    // A ring of one key has nothing to rotate.
    const single = await contextFromEnv({ ...env, VAULT_WRITE_FORMAT: 'legacy' }, 'vault');
    expect(await resealToCurrent(single)).toBeNull();
  });
});
