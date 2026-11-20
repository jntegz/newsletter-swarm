// v2 links in workerd, the runtime that signs and verifies them, and that the Setup Worker makes
// their keys in: an Ed25519 key is generated, its public half derived (JWK export), and a link
// signed with one verifies with the other. The rules themselves are in packages/tokens/tests.
import {
  newEd25519Secret,
  parseKeyring,
  parseSigningKeyring,
  parseVerifyKeyring,
  publicKeyring,
  signLink,
  signToken,
  verifyLink,
} from '@swarm/tokens';
import { describe, expect, it } from 'vitest';

const NOW = Date.UTC(2027, 0, 15);

describe('link keys in workerd', () => {
  it('make an Ed25519 keyring whose public keys verify a link it signs', async () => {
    const text = `k20270115:${await newEd25519Secret()}`;
    const signing = await parseSigningKeyring('MEMBER_SIGNING_KEYS', text);
    const verify = await parseVerifyKeyring(
      'MEMBER_SIGNING_KEYS',
      await publicKeyring('MEMBER_SIGNING_KEYS', text),
    );
    const token = await signLink('member', signing, { m: 'mb_1', c: 'ch_1' }, { now: NOW });
    expect(await verifyLink('member', verify, token, { now: NOW })).toMatchObject({
      ok: true,
      payload: { m: 'mb_1', c: 'ch_1' },
    });
    const tampered = token.replace(/\.([^.]+)\.([^.]+)$/, (_, payload: string, sig: string) => {
      return `.${payload}.${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    });
    expect((await verifyLink('member', verify, tampered, { now: NOW })).ok).toBe(false);
  });

  it('verify HMAC links and v1 links from before the cutover', async () => {
    const ring = `k1:${'c'.repeat(40)}`;
    const token = await signLink(
      'confirm',
      await parseSigningKeyring('CONFIRM_KEYS', ring),
      { q: 'cq_1', c: 'ch_1' },
      { now: NOW },
    );
    const verify = await parseVerifyKeyring('CONFIRM_KEYS', ring);
    expect((await verifyLink('confirm', verify, token, { now: NOW })).ok).toBe(true);
    const memberKeys = parseKeyring(`k1:${'m'.repeat(40)}`);
    const old = await signToken(
      memberKeys,
      'confirm',
      { q: 'cq_1' },
      {
        expiresInSeconds: 86_400,
        now: NOW - 1000,
      },
    );
    const legacy = { keyring: memberKeys, cutoffMs: NOW };
    expect(await verifyLink('confirm', verify, old, { now: NOW, legacy })).toMatchObject({
      ok: true,
      legacy: true,
    });
  });
});
