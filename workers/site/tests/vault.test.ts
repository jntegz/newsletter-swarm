// The site holds no FIELD_KEYS, no goods or signup signing key and no Stripe key (B4): its env
// refuses FIELD_KEYS once deployed and needs VAULT, no source opens or signs with those keys, and
// through the vault it can reach only the Stripe calls a public site makes.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { vaultClient } from '@swarm/vault';
import { describe, expect, it } from 'vitest';
import { parseSiteEnv } from '../src/env';

describe('the site and the vault', () => {
  it('refuses FIELD_KEYS and needs VAULT once deployed', () => {
    let problems = '';
    try {
      parseSiteEnv({
        ...env,
        ENVIRONMENT: 'production',
        FIELD_KEYS: `f1:${'f'.repeat(64)}`,
        VAULT: undefined,
      });
    } catch (error) {
      problems = (error as Error).message;
    }
    expect(problems).toMatch(/FIELD_KEYS: is held by the vault Worker alone/);
    expect(problems).toMatch(/VAULT: the VAULT service binding is missing/);
  });

  it('has no source that opens, seals or signs with the vault’s keys', () => {
    const sources = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(
        /\.(FIELD_KEYS|SIGNUP_KEYS|GOODS_SIGNING_KEYS|STRIPE_SECRET_KEY)\b|\b(encrypt|decrypt|encryptFor|decryptFor|toStored|fromStored|sealV3|openV3|macFor|localGoodsLinks|readJoinToken)\(/,
      );
    }
  });

  it('reaches only Checkout through the vault for anyone on the site', async () => {
    const now = Date.now();
    const workspaceId = newId('workspace');
    const channelId = newId('channel');
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, 'W', ?2, ?2)",
      ).bind(workspaceId, now),
      env.DB.prepare(
        `INSERT INTO channels (id, workspace_id, name, slug, created_at, updated_at)
         VALUES (?1, ?2, 'C', ?3, ?4, ?4)`,
      ).bind(channelId, workspaceId, `c-${crypto.randomUUID().slice(0, 8)}`, now),
    ]);
    const vault = vaultClient('site', null);
    for (const [method, url] of [
      ['POST', 'https://api.stripe.com/v1/refunds'],
      ['GET', 'https://api.stripe.com/v1/customers'],
      ['POST', 'https://api.stripe.com/v1/billing_portal/sessions'],
    ] as const) {
      expect(
        await vault.providerFetch(
          { kind: 'public-channel', channelId },
          { kind: 'stripe', channelId },
          { method, url },
        ),
        `${method} ${url}`,
      ).toEqual({ ok: false, reason: 'refused' });
    }
  });
});
