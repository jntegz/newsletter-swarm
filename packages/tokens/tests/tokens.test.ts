import { describe, expect, it } from 'vitest';
import { parseKeyring, signToken, verifyToken } from '../src/index';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(40);
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

describe('parseKeyring', () => {
  it('uses the first entry as the current key', () => {
    const ring = parseKeyring(`k2:${SECRET_B}, k1:${SECRET_A}`);
    expect(ring.current).toBe('k2');
    expect(Object.keys(ring.keys)).toEqual(['k2', 'k1']);
  });

  it.each([
    ['', 'empty'],
    [`k1${SECRET_A}`, 'missing separator'],
    ['k1:short', 'short secret'],
    [`K1:${SECRET_A}`, 'uppercase kid'],
    [`k1:${SECRET_A},k1:${SECRET_B}`, 'duplicate kid'],
  ])('rejects %j (%s)', (value) => {
    expect(() => parseKeyring(value)).toThrow();
  });
});

describe('signToken / verifyToken', () => {
  const ring = parseKeyring(`k1:${SECRET_A}`);

  it('round-trips claims', async () => {
    const token = await signToken(
      ring,
      'confirm',
      { m: 'mb_1' },
      { expiresInSeconds: 60, now: NOW },
    );
    const result = await verifyToken<{ m: string }>(ring, 'confirm', token, { now: NOW + 1000 });
    expect(result).toMatchObject({ ok: true, kid: 'k1', payload: { m: 'mb_1' } });
  });

  it('rejects a token minted for another purpose', async () => {
    const token = await signToken(ring, 'unsubscribe', { m: 'mb_1' }, { noExpiry: true });
    expect(await verifyToken(ring, 'confirm', token)).toEqual({ ok: false, reason: 'purpose' });
  });

  it('rejects a token whose purpose segment was rewritten', async () => {
    const token = await signToken(ring, 'unsubscribe', { m: 'mb_1' }, { noExpiry: true });
    const forged = token.replace('.unsubscribe.', '.confirm.');
    expect(await verifyToken(ring, 'confirm', forged)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects an expired token', async () => {
    const token = await signToken(ring, 'quickpass', {}, { expiresInSeconds: 600, now: NOW });
    const result = await verifyToken(ring, 'quickpass', token, { now: NOW + 600_000 });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered payload', async () => {
    const token = await signToken(ring, 'track', { d: 'dl_1' }, { expiresInSeconds: 60 });
    const parts = token.split('.');
    parts[3] = Buffer.from(JSON.stringify({ d: 'dl_2', iat: 1 })).toString('base64url');
    expect(await verifyToken(ring, 'track', parts.join('.'))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a token signed with a different secret under the same kid', async () => {
    const other = parseKeyring(`k1:${SECRET_B}`);
    const token = await signToken(other, 'track', {}, { expiresInSeconds: 60 });
    expect(await verifyToken(ring, 'track', token)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects an unknown kid', async () => {
    const other = parseKeyring(`k9:${SECRET_A}`);
    const token = await signToken(other, 'track', {}, { expiresInSeconds: 60 });
    expect(await verifyToken(ring, 'track', token)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('keeps verifying old tokens after rotation while the old key is configured', async () => {
    const token = await signToken(ring, 'member', {}, { expiresInSeconds: 60 });
    const rotated = parseKeyring(`k2:${SECRET_B},k1:${SECRET_A}`);
    expect(await verifyToken(rotated, 'member', token)).toMatchObject({ ok: true, kid: 'k1' });

    const retired = parseKeyring(`k2:${SECRET_B}`);
    expect(await verifyToken(retired, 'member', token)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it.each(['', 'a.b.c', 'v2.track.k1.e30.AA', 'v1.track.k1.!!!.AA'])(
    'rejects malformed %j',
    async (value) => {
      expect(await verifyToken(ring, 'track', value)).toMatchObject({ ok: false });
    },
  );

  it('refuses to mint a token without an explicit lifetime decision', async () => {
    await expect(signToken(ring, 'track', {}, {})).rejects.toThrow(/must expire/);
  });

  it('refuses invalid purposes', async () => {
    await expect(signToken(ring, 'Bad Purpose', {}, { noExpiry: true })).rejects.toThrow();
  });
});

describe('key ids that are not in the keyring', () => {
  // A kid comes from the token, so it must never reach Object.prototype: `constructor` would
  // otherwise resolve to a built-in function whose source text anyone knows.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'refuses a token signed under the inherited name %j',
    async (kid) => {
      const ring = parseKeyring(`k1:${SECRET_A}`);
      const inherited = (ring.keys as Record<string, unknown>)[kid];
      const knownText = String(inherited);
      const payload = btoa(JSON.stringify({ sub: 'anyone', iat: 1 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const input = `v1.member.${kid}.${payload}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(knownText),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)),
      );
      let binary = '';
      for (const byte of mac) binary += String.fromCharCode(byte);
      const forged = `${input}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
      const result = await verifyToken(ring, 'member', forged, { now: NOW });
      expect(result.ok).toBe(false);
    },
  );
});
