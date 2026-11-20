import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  checkKeyringText,
  FAMILIES,
  familyOf,
  KEYRING_ALGS,
  LEGACY_ACCEPT_MAX_SECONDS,
  linkModeFromEnv,
  newEd25519Secret,
  parseKeyring,
  parseSigningKeyring,
  parseVerifyKeyring,
  publicKeyring,
  signLink,
  signToken,
  verifyKeysName,
  verifyLink,
  type KeyringName,
  type SigningKeyring,
} from '../src/index';

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const DAY_MS = 86_400_000;
const HMAC_SECRET = 'c'.repeat(40);

async function ed25519Ring(name: KeyringName, kids = ['k1']) {
  const text = (
    await Promise.all(kids.map(async (kid) => `${kid}:${await newEd25519Secret()}`))
  ).join(',');
  return {
    text,
    signing: await parseSigningKeyring(name, text),
    verify: await parseVerifyKeyring(name, await publicKeyring(name, text)),
  };
}

/** A v2 token over any body, signed with the ring's current key: what a key holder could make. */
async function craft(purpose: string, ring: SigningKeyring, body: Record<string, unknown>) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const input = `v2.${purpose}.${ring.current}.${payload}`;
  const alg = ring.alg === 'ed25519' ? 'Ed25519' : 'HMAC';
  const key = ring.keys[ring.current] as CryptoKey;
  const sig = await crypto.subtle.sign(alg, key, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

describe('the families', () => {
  it('give every family a signing keyring and a valid purpose', () => {
    for (const spec of Object.values(FAMILIES)) {
      expect(spec.purpose).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(KEYRING_ALGS[spec.keyring]).toBe(spec.alg);
      if (spec.alg === 'ed25519') expect(spec.keyring).toMatch(/_SIGNING_KEYS$/);
      expect(spec.keyring).not.toBe('MEMBER_KEYS');
    }
  });

  it('accept no v1 link for longer than 90 days after the cutover', () => {
    const legacy = Object.values(FAMILIES).filter((spec) => spec.legacy);
    expect(legacy.length).toBeGreaterThan(10);
    for (const spec of legacy) {
      expect(spec.legacy!.acceptForSeconds).toBeLessThanOrEqual(LEGACY_ACCEPT_MAX_SECONDS);
      expect(spec.legacy!.acceptForSeconds).toBeLessThanOrEqual(spec.legacy!.lifetimeSeconds);
      expect(spec.maxLifetimeSeconds).not.toBeNull();
      expect(spec.maxLifetimeSeconds!).toBeLessThanOrEqual(LEGACY_ACCEPT_MAX_SECONDS);
    }
    // Sponsor reports lived a year as v1; from the cutover they live 90 days and v1 ones too.
    expect(FAMILIES['sponsor-report']?.legacy).toEqual({
      lifetimeSeconds: 365 * 86_400,
      acceptForSeconds: 90 * 86_400,
    });
  });

  it('refuse an unknown purpose and name public keys after their keyring', () => {
    expect(() => familyOf('nonsense')).toThrow(/no token family/);
    expect(() => familyOf('constructor')).toThrow(/no token family/);
    expect(verifyKeysName('MEMBER_SIGNING_KEYS')).toBe('MEMBER_VERIFY_KEYS');
    expect(() => verifyKeysName('CONFIRM_KEYS')).toThrow(/not an Ed25519/);
  });
});

describe('keyrings', () => {
  it('parse HMAC and Ed25519 keyrings, first entry current', async () => {
    const hmac = await parseSigningKeyring(
      'CONFIRM_KEYS',
      `k2:${HMAC_SECRET},k1:${'d'.repeat(32)}`,
    );
    expect(hmac).toMatchObject({ name: 'CONFIRM_KEYS', alg: 'hmac-sha256', current: 'k2' });
    expect(Object.keys(hmac.keys)).toEqual(['k2', 'k1']);
    const ed = await ed25519Ring('MEMBER_SIGNING_KEYS', ['k2', 'k1']);
    expect(ed.signing.current).toBe('k2');
    expect(Object.keys(ed.verify.keys)).toEqual(['k2', 'k1']);
    expect((await publicKeyring('MEMBER_SIGNING_KEYS', ed.text)).split(',')).toHaveLength(2);
  });

  it('refuse what is not a key of the right kind, instead of running without one', async () => {
    const ed = await ed25519Ring('MEMBER_SIGNING_KEYS');
    const publicText = await publicKeyring('MEMBER_SIGNING_KEYS', ed.text);
    await expect(parseSigningKeyring('MEMBER_SIGNING_KEYS', publicText)).rejects.toThrow(
      /not an Ed25519 private key/,
    );
    await expect(parseVerifyKeyring('MEMBER_SIGNING_KEYS', ed.text)).rejects.toThrow(
      /not an Ed25519 public key/,
    );
    await expect(parseSigningKeyring('MEMBER_SIGNING_KEYS', `k1:${HMAC_SECRET}`)).rejects.toThrow(
      /not an Ed25519 private key/,
    );
    await expect(parseSigningKeyring('MEMBER_SIGNING_KEYS', '')).rejects.toThrow(/empty/);
    await expect(parseSigningKeyring('FIELD_KEYS', `k1:${HMAC_SECRET}`)).rejects.toThrow(
      /does not sign links/,
    );
    await expect(publicKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`)).rejects.toThrow(
      /not an Ed25519/,
    );
  });
});

describe('checkKeyringText', () => {
  it('checks a keyring without importing it, as an env schema must', async () => {
    const { text } = await ed25519Ring('MEMBER_SIGNING_KEYS');
    const publicText = await publicKeyring('MEMBER_SIGNING_KEYS', text);
    expect(() => checkKeyringText('MEMBER_SIGNING_KEYS', text)).not.toThrow();
    expect(() => checkKeyringText('MEMBER_VERIFY_KEYS', publicText)).not.toThrow();
    expect(() => checkKeyringText('CONFIRM_KEYS', `k1:${HMAC_SECRET}`)).not.toThrow();
    // A public key where the private one belongs, and the other way round.
    expect(() => checkKeyringText('MEMBER_SIGNING_KEYS', publicText)).toThrow(/private key/);
    expect(() => checkKeyringText('MEMBER_VERIFY_KEYS', text)).toThrow(/public key/);
    // An HMAC secret is no Ed25519 key, and no HMAC keyring has public keys.
    expect(() => checkKeyringText('ASK_SIGNING_KEYS', `k1:${HMAC_SECRET}`)).toThrow();
    expect(() => checkKeyringText('CONFIRM_VERIFY_KEYS', publicText)).toThrow();
    expect(() => checkKeyringText('NOT_A_RING', `k1:${HMAC_SECRET}`)).toThrow(/not a keyring/);
    expect(() => checkKeyringText('CONFIRM_KEYS', 'k1:short')).toThrow();
  });
});

describe('v2 links', () => {
  it('round-trip an HMAC family', async () => {
    const ring = await parseSigningKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    const token = await signLink('confirm', ring, { q: 'cq_1', c: 'ch_1' }, { now: NOW });
    expect(token).toMatch(/^v2\.confirm\.k1\./);
    const verify = await parseVerifyKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    const result = await verifyLink<{ q: string }>('confirm', verify, token, { now: NOW + 1000 });
    expect(result).toMatchObject({ ok: true, kid: 'k1', legacy: false, payload: { q: 'cq_1' } });
    if (result.ok) expect(result.payload.exp).toBe(NOW / 1000 + 30 * 86_400);
  });

  it('round-trip an Ed25519 family, verified with the public key only', async () => {
    const { signing, verify } = await ed25519Ring('MEMBER_SIGNING_KEYS');
    const token = await signLink('member', signing, { m: 'mb_1', c: 'ch_1' }, { now: NOW });
    // An 86-character signature, against HMAC's 43.
    expect(token.split('.')[4]).toHaveLength(86);
    expect(await verifyLink('member', verify, token, { now: NOW })).toMatchObject({
      ok: true,
      payload: { m: 'mb_1', c: 'ch_1' },
    });
  });

  it('verify links signed with an older key while it is in the ring', async () => {
    const old = await ed25519Ring('ASK_SIGNING_KEYS', ['k1']);
    const token = await signLink(
      'ask',
      old.signing,
      { m: 'mb_1', o: 'o1', c: 'ch_1' },
      { now: NOW },
    );
    const newer = `k2:${await newEd25519Secret()},${old.text}`;
    const verify = await parseVerifyKeyring(
      'ASK_SIGNING_KEYS',
      await publicKeyring('ASK_SIGNING_KEYS', newer),
    );
    expect((await verifyLink('ask', verify, token, { now: NOW })).ok).toBe(true);
    const without = await parseVerifyKeyring(
      'ASK_SIGNING_KEYS',
      (await publicKeyring('ASK_SIGNING_KEYS', newer)).split(',')[0] as string,
    );
    expect(await verifyLink('ask', without, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('take the algorithm and keyring from the family, never from the token', async () => {
    const confirm = await parseSigningKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    const member = await ed25519Ring('MEMBER_SIGNING_KEYS');
    // Another family's keyring is a bug in the caller, refused before any token is read.
    await expect(
      signLink('member', confirm, { m: 'mb_1', c: 'ch_1' }, { now: NOW }),
    ).rejects.toThrow(/needs MEMBER_SIGNING_KEYS \(ed25519\), not CONFIRM_KEYS/);
    const token = await signLink('confirm', confirm, { q: 'cq_1', c: 'ch_1' }, { now: NOW });
    await expect(verifyLink('member', confirm, token)).rejects.toThrow(/needs MEMBER_SIGNING_KEYS/);
    // An HMAC keyring renamed to pass as the Ed25519 one is still refused by its algorithm.
    const renamed = { ...confirm, name: 'MEMBER_SIGNING_KEYS' as const };
    await expect(verifyLink('member', renamed, token)).rejects.toThrow(/\(hmac-sha256\)/);
    // Ed25519 links verify with the public keys, never a private keyring.
    const memberLink = await signLink('member', member.signing, { m: 'mb_1', c: 'ch_1' });
    await expect(verifyLink('member', member.signing, memberLink)).rejects.toThrow(/public keys/);
    // A token MACed with the public key as an HMAC secret does not verify as Ed25519.
    const publicSecret = (await publicKeyring('MEMBER_SIGNING_KEYS', member.text)).split(':')[1];
    const confused = await parseSigningKeyring('CONFIRM_KEYS', `k1:${publicSecret}`);
    const forged = await craft('member', confused, {
      m: 'mb_1',
      c: 'ch_1',
      iat: NOW / 1000,
      exp: NOW / 1000 + 60,
    });
    expect(await verifyLink('member', member.verify, forged, { now: NOW })).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuse a signature of the wrong length as a bad signature, never by throwing', async () => {
    const { signing, verify } = await ed25519Ring('MEMBER_SIGNING_KEYS');
    const token = await signLink('member', signing, { m: 'mb_1', c: 'ch_1' }, { now: NOW });
    const head = token.slice(0, token.lastIndexOf('.'));
    // An HMAC-length signature on an Ed25519 family (what a holder of an HMAC key would send).
    for (const sig of [base64UrlEncode(new Uint8Array(32)), '', 'AA']) {
      expect(await verifyLink('member', verify, `${head}.${sig}`, { now: NOW })).toEqual({
        ok: false,
        reason: 'signature',
      });
    }
    const hmac = await parseSigningKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    const confirm = await signLink('confirm', hmac, { q: 'cq_1', c: 'ch_1' }, { now: NOW });
    const short = `${confirm.slice(0, confirm.lastIndexOf('.'))}.${base64UrlEncode(new Uint8Array(64))}`;
    expect((await verifyLink('confirm', hmac, short, { now: NOW })).ok).toBe(false);
  });

  it('refuse another purpose, a rewritten purpose and broken tokens', async () => {
    const ring = await parseSigningKeyring('CAPTURE_KEYS', `k1:${HMAC_SECRET}`);
    const verify = await parseVerifyKeyring('CAPTURE_KEYS', `k1:${HMAC_SECRET}`);
    const token = await signLink('challenge', ring, { f: 'f1' }, { now: NOW });
    expect(await verifyLink('dsr-confirm', verify, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'purpose',
    });
    const rewritten = token.replace('.challenge.', '.dsr-confirm.');
    expect(await verifyLink('dsr-confirm', verify, rewritten, { now: NOW })).toEqual({
      ok: false,
      reason: 'signature',
    });
    for (const bad of [
      'v2.challenge.k1.x',
      'v3' + token.slice(2),
      token.replace('.k1.', '.constructor.'),
      token.slice(0, -2) + '!!',
      'v2.challenge.k1.' + 'a'.repeat(3000) + '.b',
    ]) {
      const result = await verifyLink('challenge', verify, bad, { now: NOW });
      expect(result.ok).toBe(false);
    }
  });

  it('expire, and refuse a lifetime longer than the family allows even from a key holder', async () => {
    const ring = await parseSigningKeyring('CAPTURE_KEYS', `k1:${HMAC_SECRET}`);
    const verify = await parseVerifyKeyring('CAPTURE_KEYS', `k1:${HMAC_SECRET}`);
    const token = await signLink('challenge', ring, { f: 'f1' }, { now: NOW });
    expect(await verifyLink('challenge', verify, token, { now: NOW + 15 * 60_000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    await expect(
      signLink('challenge', ring, { f: 'f1' }, { now: NOW, expiresInSeconds: 3600 }),
    ).rejects.toThrow(/at most 900 seconds/);
    const long = await craft('challenge', ring, {
      f: 'f1',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(await verifyLink('challenge', verify, long, { now: NOW })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
    const endless = await craft('challenge', ring, { f: 'f1', iat: NOW / 1000 });
    expect(await verifyLink('challenge', verify, endless, { now: NOW })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('need the tenant claim of a family that has one', async () => {
    const ring = await parseSigningKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    await expect(signLink('confirm', ring, { q: 'cq_1' }, { now: NOW })).rejects.toThrow(
      /name its tenant in "c"/,
    );
    await expect(signLink('confirm', ring, { q: 'cq_1', c: '' })).rejects.toThrow(/tenant/);
    await expect(signLink('confirm', ring, { q: 'cq_1', c: 'ch_1', iat: 1 })).rejects.toThrow(
      /set by signLink/,
    );
    const forged = await craft('confirm', ring, {
      q: 'cq_1',
      iat: NOW / 1000,
      exp: NOW / 1000 + 60,
    });
    const verify = await parseVerifyKeyring('CONFIRM_KEYS', `k1:${HMAC_SECRET}`);
    expect(await verifyLink('confirm', verify, forged, { now: NOW })).toEqual({
      ok: false,
      reason: 'tenant',
    });
  });

  it('sign a family without expiry only when the family has none', async () => {
    const ring = await parseSigningKeyring('READER_KEYS', `k1:${HMAC_SECRET}`);
    const token = await signLink('reader-session', ring, { n: 'x' }, { now: NOW });
    const verify = await parseVerifyKeyring('READER_KEYS', `k1:${HMAC_SECRET}`);
    const result = await verifyLink('reader-session', verify, token, { now: NOW + 3650 * DAY_MS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.exp).toBeUndefined();
  });
});

describe('v1 links from before the cutover', () => {
  const memberKeys = parseKeyring(`k1:${'m'.repeat(40)}`);
  const CUTOFF = NOW;

  async function rings() {
    const ed = await ed25519Ring('MEMBER_SIGNING_KEYS');
    return ed.verify;
  }
  const v1 = (purpose: string, claims: Record<string, unknown>, at: number, seconds: number) =>
    signToken(memberKeys, purpose, claims, { expiresInSeconds: seconds, now: at });

  it('verify only with the legacy keyring passed, for a family that took them', async () => {
    const verify = await rings();
    const token = await v1('member', { m: 'mb_1' }, CUTOFF - DAY_MS, 30 * 86_400);
    expect(await verifyLink('member', verify, token, { now: CUTOFF })).toEqual({
      ok: false,
      reason: 'legacy_closed',
    });
    const legacy = { keyring: memberKeys, cutoffMs: CUTOFF };
    expect(await verifyLink('member', verify, token, { now: CUTOFF, legacy })).toMatchObject({
      ok: true,
      legacy: true,
      payload: { m: 'mb_1' },
    });
    // member-ref was never verified, so no v1 one is taken.
    const capture = await parseVerifyKeyring('CAPTURE_KEYS', `k1:${HMAC_SECRET}`);
    const ref = await v1('member-ref', { c: 'ch_1', r: 'x' }, CUTOFF - 1000, 86_400);
    expect(await verifyLink('member-ref', capture, ref, { now: CUTOFF, legacy })).toEqual({
      ok: false,
      reason: 'legacy_closed',
    });
  });

  it('take v1 links of any age within their lifetime before the cutover is set', async () => {
    const verify = await rings();
    const legacy = { keyring: memberKeys, cutoffMs: null };
    const token = await v1('member', { m: 'mb_1' }, NOW + 5 * DAY_MS, 30 * 86_400);
    expect((await verifyLink('member', verify, token, { now: NOW + 6 * DAY_MS, legacy })).ok).toBe(
      true,
    );
    const long = await v1('member', { m: 'mb_1' }, NOW, 31 * 86_400);
    expect(await verifyLink('member', verify, long, { now: NOW, legacy })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('refuse one issued at or after the cutover', async () => {
    const verify = await rings();
    const legacy = { keyring: memberKeys, cutoffMs: CUTOFF };
    const token = await v1('member', { m: 'mb_1' }, CUTOFF, 30 * 86_400);
    expect(await verifyLink('member', verify, token, { now: CUTOFF + 1000, legacy })).toEqual({
      ok: false,
      reason: 'legacy_closed',
    });
  });

  it('close for every v1 link, even a backdated one, once the window has passed', async () => {
    const verify = await rings();
    const legacy = { keyring: memberKeys, cutoffMs: CUTOFF };
    // A holder of the old key backdates iat to just before the cutover: valid until its exp…
    const backdated = await v1('member', { m: 'mb_1' }, CUTOFF - 1000, 30 * 86_400);
    const end = CUTOFF + 30 * DAY_MS;
    expect((await verifyLink('member', verify, backdated, { now: end - 2000, legacy })).ok).toBe(
      true,
    );
    // …and no longer: exp is capped by the lifetime, and the window closes at cutoff + 30 days.
    expect((await verifyLink('member', verify, backdated, { now: end, legacy })).ok).toBe(false);
    // Asking for a longer life does not get past the cap.
    const longer = await v1('member', { m: 'mb_1' }, CUTOFF - 1000, 60 * 86_400);
    expect(await verifyLink('member', verify, longer, { now: end + DAY_MS, legacy })).toEqual({
      ok: false,
      reason: 'legacy_closed',
    });
    expect(await verifyLink('member', verify, longer, { now: CUTOFF, legacy })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('keep sponsor reports issued for a year working for 90 days from the cutover', async () => {
    const site = await ed25519Ring('SPONSOR_REPORT_SIGNING_KEYS');
    const legacy = { keyring: memberKeys, cutoffMs: CUTOFF };
    const report = await v1('sponsor-report', { b: 'bk_1' }, CUTOFF - 100 * DAY_MS, 365 * 86_400);
    const at = (days: number) =>
      verifyLink('sponsor-report', site.verify, report, { now: CUTOFF + days * DAY_MS, legacy });
    expect((await at(89)).ok).toBe(true);
    expect(await at(90)).toEqual({ ok: false, reason: 'legacy_closed' });
  });

  it('keep sponsor reports signed with the keyring they had before for their 90 days', async () => {
    const own = await ed25519Ring('SPONSOR_REPORT_SIGNING_KEYS');
    const former = await ed25519Ring('SITE_LINK_SIGNING_KEYS');
    // Signed by the api before the family had its own ring (same key id, another key).
    const iat = Math.floor(Date.now() / 1000);
    const before = await craft('sponsor-report', former.signing, {
      c: 'ch_1',
      b: 'bk_1',
      iat,
      exp: iat + 86_400,
    });
    const now = await signLink('sponsor-report', own.signing, { c: 'ch_1', b: 'bk_1' });
    const read = (token: string, withFormer: boolean) =>
      verifyLink('sponsor-report', own.verify, token, withFormer ? { former: former.verify } : {});
    expect((await read(now, false)).ok).toBe(true);
    expect((await read(before, false)).ok).toBe(false);
    expect((await read(before, true)).ok).toBe(true);
    // Only the family's own former ring: a design preview's key is no stand-in for the member one.
    await expect(
      verifyLink('member', (await ed25519Ring('MEMBER_SIGNING_KEYS')).verify, before, {
        former: former.verify,
      }),
    ).rejects.toThrow(/never signed with/);
  });

  it('refuse a v1 link signed with any other key', async () => {
    const verify = await rings();
    const other = parseKeyring(`k1:${'o'.repeat(40)}`);
    const token = await signToken(
      other,
      'member',
      { m: 'mb_1' },
      {
        expiresInSeconds: 86_400,
        now: CUTOFF - 1000,
      },
    );
    const legacy = { keyring: memberKeys, cutoffMs: CUTOFF };
    expect(await verifyLink('member', verify, token, { now: CUTOFF, legacy })).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
});

describe('linkModeFromEnv', () => {
  it('reads the vars the installer renders', () => {
    expect(linkModeFromEnv({ LINK_SIGNING_MODE: 'v1' })).toEqual({
      signing: 'v1',
      legacyCutoffMs: null,
    });
    expect(linkModeFromEnv({ LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: String(NOW) })).toEqual({
      signing: 'v2',
      legacyCutoffMs: NOW,
    });
  });

  it('refuses to guess, failing closed', () => {
    expect(() => linkModeFromEnv({})).toThrow(/must be v1 or v2/);
    expect(() => linkModeFromEnv({ LINK_SIGNING_MODE: 'v2' })).toThrow(/needs LINK_LEGACY_CUTOFF/);
    expect(() => linkModeFromEnv({ LINK_SIGNING_MODE: 'V2' })).toThrow(/must be v1 or v2/);
    expect(() =>
      linkModeFromEnv({ LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: '2027-01-15' }),
    ).toThrow(/milliseconds/);
  });
});
