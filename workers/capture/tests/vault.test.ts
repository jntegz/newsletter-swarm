// Capture holds no FIELD_KEYS, no member or signup signing key, no Stripe and no DeBounce key
// (B4): its env refuses FIELD_KEYS once deployed and needs VAULT, and no source opens, seals or
// signs with them itself.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseCaptureEnv } from '../src/env';

describe('capture and the vault', () => {
  it('refuses FIELD_KEYS and needs VAULT once deployed', () => {
    let problems = '';
    try {
      parseCaptureEnv({
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
        /\.(FIELD_KEYS|SIGNUP_KEYS|MEMBER_SIGNING_KEYS|STRIPE_SECRET_KEY|DEBOUNCE_API_KEY)\b|\b(encrypt|decrypt|encryptFor|decryptFor|toStored|fromStored|sealV3|openV3|macFor|signJoinToken|localMemberLinks)\(/,
      );
    }
  });
});
