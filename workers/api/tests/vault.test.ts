// The api holds no FIELD_KEYS (B4): its env refuses the secret once deployed and needs VAULT; no
// source opens or seals a value itself; the vault checks the credential itself, even when a
// route's own check is skipped; and with the vault down, encrypted fields are not shown and a
// save that needs a seal answers 503 (fail closed).
import { env } from 'cloudflare:test';
import type { MemberDetail, MemberListItem } from '@swarm/domain';
import { createDownVault, useVaultForTests, vaultClient } from '@swarm/vault';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseApiEnv } from '../src/env';
import { addField, addMember, data } from './audience-helpers';
import { call, createChannel, signIn, type Session } from './helpers';
import { createKey, v2, v2Data } from './v2-helpers';
import { installFakeVault } from './vault-fetch';

const tokenOf = (s: Session) => s.cookie.slice(s.cookie.indexOf('=') + 1);

let owner: Session;
let channelId: string;
let fieldKey: string;
let memberId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  fieldKey = (await addField(owner, channelId, { type: 'text', encrypted: true })).key;
  memberId = (await addMember(owner, channelId, { fields: { [fieldKey]: 'secret-1' } })).id;
});

afterEach(installFakeVault);

describe('the api and FIELD_KEYS', () => {
  it('refuses FIELD_KEYS and needs VAULT once deployed', () => {
    const problems = (() => {
      try {
        parseApiEnv({
          ...env,
          ENVIRONMENT: 'production',
          FIELD_KEYS: `f1:${'f'.repeat(64)}`,
          VAULT: undefined,
        });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(problems).toMatch(/FIELD_KEYS: is held by the vault Worker alone/);
    expect(problems).toMatch(/VAULT: the VAULT service binding is missing/);
  });

  it('has no source that opens, seals or names FIELD_KEYS', () => {
    const sources = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(
        /\.FIELD_KEYS\b|\b(encrypt|decrypt|encryptFor|decryptFor|toStored|fromStored|sealV3|openV3|macFor|openAppKey|sealAppKey|openCopilotKey|sealCopilotKey|openCredentials|sealCredentials|sealWebhookSecret)\(/,
      );
    }
  });
});

describe('the vault behind member fields', () => {
  it('refuses a teammate of another workspace, even when the route check is skipped', async () => {
    const outsider = await signIn();
    const vault = vaultClient('api', null);
    const asOwner = await vault.openMemberFields(
      { kind: 'operator-session', sessionToken: tokenOf(owner) },
      { channelId, memberIds: [memberId] },
    );
    expect(asOwner).toEqual({ ok: true, value: { [memberId]: { [fieldKey]: 'secret-1' } } });
    expect(
      await vault.openMemberFields(
        { kind: 'operator-session', sessionToken: tokenOf(outsider) },
        { channelId, memberIds: [memberId] },
      ),
    ).toMatchObject({ ok: false });
  });

  it('with the vault down: encrypted fields are not shown, and saving one answers 503', async () => {
    useVaultForTests('api', createDownVault<'api'>());
    const detail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${memberId}`, { cookie: owner.cookie }),
    );
    expect(detail.fields[fieldKey]).toBeNull();
    expect(detail.encryptedUnavailable).toBe(true);
    const saved = await call('PATCH', `/api/v1/members/${memberId}`, {
      cookie: owner.cookie,
      body: { fields: { [fieldKey]: 'secret-2' } },
    });
    expect(saved.status).toBe(503);
    await installFakeVault();
    const after = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${memberId}`, { cookie: owner.cookie }),
    );
    expect(after.fields[fieldKey]).toBe('secret-1');
    expect(after).not.toHaveProperty('encryptedUnavailable');
  });

  it('flags only the Members whose encrypted fields could not be opened, on /api/v1 and /v2', async () => {
    const plain = (await addMember(owner, channelId, {})).id;
    const { secret } = await createKey(owner, { scopes: ['members:read'] });
    const listPath = `/api/v1/channels/${channelId}/members?fields=${fieldKey}`;
    const v2Path = `/v2/channels/${channelId}/members/${memberId}`;
    const listed = async () =>
      (
        await data<{ items: MemberListItem[] }>(
          await call('GET', listPath, { cookie: owner.cookie }),
        )
      ).items;

    const up = await listed();
    expect(up.find((m) => m.id === memberId)).not.toHaveProperty('encryptedUnavailable');
    expect((await v2Data<MemberDetail>(await v2('GET', v2Path, secret))).fields[fieldKey]).toBe(
      'secret-1',
    );

    useVaultForTests('api', createDownVault<'api'>());
    const down = await listed();
    expect(down.find((m) => m.id === memberId)).toMatchObject({
      fields: { [fieldKey]: null },
      encryptedUnavailable: true,
    });
    // Nothing sealed to open: not flagged.
    expect(down.find((m) => m.id === plain)).not.toHaveProperty('encryptedUnavailable');
    const viaV2 = await v2Data<MemberDetail>(await v2('GET', v2Path, secret));
    expect(viaV2.fields[fieldKey]).toBeNull();
    expect(viaV2.encryptedUnavailable).toBe(true);
    const plainV2 = await v2Data<MemberDetail>(
      await v2('GET', `/v2/channels/${channelId}/members/${plain}`, secret),
    );
    expect(plainV2).not.toHaveProperty('encryptedUnavailable');
  });
});
