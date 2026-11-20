// Link families on their own keyrings (docs/security.md "Keys"): each signs and verifies only
// with its own keys, a holder of one worker's keys can't make another's links, v1 links from
// before the cutover keep working for their window and no longer, and bounce codes moved off the
// unsubscribe key.
import {
  base64UrlEncode,
  FAMILIES,
  familyOf,
  parseKeyring,
  parseSigningKeyring,
  signToken,
  type FamilySpec,
} from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import {
  bounceCode,
  LEGACY_BOUNCE_DAYS,
  readAnyBounceCode,
  readBounceCode,
  unsubscribeCode,
} from '../src/codes';
import { createLinkKeys, linksFor, sameTenant } from '../src/links';
import {
  signSitePreview,
  SITE_PREVIEW_PURPOSE,
  SITE_PREVIEW_SECONDS,
  verifySitePreview,
} from '../src/site-preview';
import { testLinkKey } from '../../../scripts/lib/test-link-keys.mjs';
import { everyLink, HOLDS, memberKeys, workerLinks, type Holder } from './link-keys';

const DAY = 86_400_000;
const channelId = `ch_${'c'.repeat(32)}`;
const workspaceId = `ws_${'w'.repeat(32)}`;

/** Claims that satisfy each family's tenant claim. */
const claimsFor = (spec: FamilySpec): Record<string, unknown> =>
  spec.tenantClaim === 'c' ? { c: channelId } : spec.tenantClaim === 'w' ? { w: workspaceId } : {};

/** Who signs and who verifies each moved family (the registry). */
const ROUTES: Record<string, { signers: Holder[]; verifiers: Holder[] }> = {
  confirm: { signers: ['api', 'capture', 'site'], verifiers: ['capture'] },
  leave: { signers: ['api', 'capture', 'site'], verifiers: ['capture'] },
  // The vault mints them for the api and capture.
  member: { signers: ['send', 'jobs', 'vault'], verifiers: ['capture', 'vault'] },
  'member-ref': { signers: ['capture'], verifiers: ['capture'] },
  challenge: { signers: ['capture'], verifiers: ['capture'] },
  'dsr-confirm': { signers: ['capture'], verifiers: ['capture'] },
  'dsr-address-confirm': { signers: ['capture'], verifiers: ['capture'] },
  'form-stamp': { signers: ['capture', 'site'], verifiers: ['capture'] },
  // SIGNUP_KEYS is HMAC and the vault's alone: it signs and opens them for capture and site.
  join: { signers: ['vault'], verifiers: ['vault'] },
  journey: { signers: ['vault'], verifiers: ['vault'] },
  ask: { signers: ['send'], verifiers: ['capture'] },
  'ask-page': { signers: ['capture'], verifiers: ['site'] },
  'dsr-export': { signers: ['jobs'], verifiers: ['capture'] },
  'goods-library': { signers: ['vault'], verifiers: ['site'] },
  'goods-order': { signers: ['vault'], verifiers: ['site'] },
  'checkout-ref': { signers: ['site'], verifiers: ['api'] },
  // Its own keyring, so jobs (which mails sponsors new report links) holds no preview key.
  'sponsor-report': { signers: ['api', 'jobs'], verifiers: ['site'] },
  'site-preview': { signers: ['api'], verifiers: ['site'] },
};

describe('each link family', () => {
  it('covers every family that moved off MEMBER_KEYS', () => {
    const moved = Object.values(FAMILIES)
      .filter((spec) => !['AUTH_KEYS', 'READER_KEYS', 'TRACK_KEYS'].includes(spec.keyring))
      .map((spec) => spec.purpose)
      .sort();
    expect(Object.keys(ROUTES).sort()).toEqual(moved);
  });

  for (const [purpose, { signers, verifiers }] of Object.entries(ROUTES)) {
    it(`${purpose}: signed by ${signers.join(', ')}, verified by ${verifiers.join(', ')} only`, async () => {
      const spec = familyOf(purpose);
      for (const signer of signers) {
        const token = await workerLinks(signer).sign(purpose, { x: 1, ...claimsFor(spec) });
        expect(token.startsWith(`v2.${purpose}.t1.`), `${signer} ${purpose}`).toBe(true);
        for (const verifier of verifiers) {
          const read = await workerLinks(verifier).verify(purpose, token);
          expect(read, `${signer} → ${verifier} ${purpose}`).toMatchObject({ ok: true });
        }
      }
      // Every other worker can't sign it: it holds no key for it, so it refuses outright.
      for (const holder of Object.keys(HOLDS) as Holder[]) {
        if (signers.includes(holder)) continue;
        await expect(
          workerLinks(holder).sign(purpose, claimsFor(spec)),
          `${holder} signs ${purpose}`,
        ).rejects.toThrow(/is not set/);
      }
    });
  }

  it('refuses a token of another family, even signed with that family’s own key', async () => {
    const all = everyLink();
    const member = await all.sign('member', { m: 'mb_1', c: channelId });
    for (const purpose of ['ask', 'leave', 'confirm', 'dsr-export', 'goods-library']) {
      expect((await all.verify(purpose, member)).ok, purpose).toBe(false);
    }
    // Relabelled as an ask link: the purpose is signed, so the signature no longer matches.
    const relabelled = member.replace('v2.member.', 'v2.ask.');
    expect(await all.verify('ask', relabelled)).toMatchObject({ ok: false });
  });

  it('refuses a v2 link without its tenant claim, and compares the claim with the row', async () => {
    const all = everyLink();
    await expect(all.sign('member', { m: 'mb_1' })).rejects.toThrow(/tenant/);
    expect(sameTenant(channelId, channelId)).toBe(true);
    expect(sameTenant(`ch_${'d'.repeat(32)}`, channelId)).toBe(false);
    // A link from before the cutover carries none; only the row decides then.
    expect(sameTenant(undefined, channelId)).toBe(true);
  });
});

describe('a holder of one worker’s keys (S04-X-V-keyring-forge-chain)', () => {
  it('can’t make goods, sponsor report, data download or one-tap links with capture’s keys', async () => {
    const capture = workerLinks('capture');
    const site = workerLinks('site');
    const all = everyLink();
    for (const purpose of ['goods-library', 'goods-order', 'sponsor-report', 'dsr-export', 'ask']) {
      const spec = familyOf(purpose);
      await expect(capture.sign(purpose, claimsFor(spec))).rejects.toThrow(/is not set/);
    }
    // Nor by signing one with a key it does hold: the family decides the key, never the token.
    const secret = parseKeyring(
      // capture's HMAC keyring, as a forger who dumped its env would have it.
      `t1:${capture.secret('CAPTURE_KEYS')}`,
    );
    const forged = await signToken(
      secret,
      'goods-library',
      { c: channelId, a: 'go_1' },
      {
        expiresInSeconds: 60,
      },
    );
    expect((await site.verify('goods-library', forged)).ok).toBe(false);
    const asV2 = (await all.sign('goods-library', { c: channelId, a: 'go_1' })).replace(
      /\.[^.]+$/,
      `.${forged.split('.')[4]}`,
    );
    expect((await site.verify('goods-library', asV2)).ok).toBe(false);
  });

  it('can’t make a Member Center link with site’s or the api’s public keys', async () => {
    await expect(workerLinks('site').sign('member', { m: 'mb_1', c: channelId })).rejects.toThrow();
    await expect(workerLinks('api').sign('checkout-ref', { r: 'x' })).rejects.toThrow(
      /CHECKOUT_SIGNING_KEYS/,
    );
  });
});

describe('v1 links from before the cutover', () => {
  const cutoff = Date.now() - DAY;
  const v1 = (purpose: string, claims: Record<string, unknown>, issued: number, days: number) =>
    signToken(memberKeys, purpose, claims, { expiresInSeconds: days * 86_400, now: issued });

  it('verify for their family’s window when issued before it', async () => {
    const capture = workerLinks('capture', { mode: { legacyCutoffMs: cutoff } });
    const old = await v1('member', { m: 'mb_1' }, cutoff - 5 * DAY, 30);
    expect(await capture.verify('member', old)).toMatchObject({ ok: true, legacy: true });
    // Issued after the cutover: nothing signs v1 any more, so it is a forgery.
    const late = await v1('member', { m: 'mb_1' }, cutoff + 1000, 30);
    expect(await capture.verify('member', late)).toEqual({ ok: false, reason: 'legacy_closed' });
  });

  it('stop at cutover + their lifetime, backdated or not', async () => {
    const longAgo = Date.now() - 31 * DAY;
    const capture = workerLinks('capture', { mode: { legacyCutoffMs: longAgo } });
    const old = await v1('member', { m: 'mb_1' }, longAgo - 1000, 30);
    expect(await capture.verify('member', old, { now: longAgo + 29 * DAY })).toMatchObject({
      ok: true,
    });
    expect((await capture.verify('member', old, { now: longAgo + 30 * DAY })).ok).toBe(false);
  });

  it('stop for sponsor reports 90 days after the cutover, though they were issued for a year', async () => {
    const site = workerLinks('site', { mode: { legacyCutoffMs: cutoff } });
    const report = await v1('sponsor-report', { b: 'sb_1' }, cutoff - 100 * DAY, 365);
    expect((await site.verify('sponsor-report', report)).ok).toBe(true);
    const after = { now: cutoff + 90 * DAY };
    expect(await site.verify('sponsor-report', report, after)).toEqual({
      ok: false,
      reason: 'legacy_closed',
    });
  });

  it('are refused once MEMBER_KEYS is gone', async () => {
    const capture = workerLinks('capture', { memberKeys: false });
    const old = await v1('member', { m: 'mb_1' }, cutoff - DAY, 30);
    expect(await capture.verify('member', old)).toEqual({ ok: false, reason: 'legacy_closed' });
  });

  it('are still what signers make before the cutover, and need MEMBER_KEYS for it', async () => {
    const v1Mode = { mode: { signing: 'v1' as const, legacyCutoffMs: null } };
    const send = workerLinks('send', v1Mode);
    const token = await send.sign('member', { m: 'mb_1', c: channelId });
    expect(token.startsWith('v1.member.m1.')).toBe(true);
    // Every verifier takes it then, with no window yet.
    expect((await workerLinks('capture', v1Mode).verify('member', token)).ok).toBe(true);
    // The sponsor report of that time still lives a year.
    const report = await workerLinks('api', v1Mode).sign('sponsor-report', {
      b: 'sb_1',
      c: channelId,
    });
    const body = JSON.parse(atob(report.split('.')[3]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(body.exp - body.iat).toBe(365 * 86_400);
    await expect(
      workerLinks('send', { ...v1Mode, memberKeys: false }).sign('member', {
        m: 'mb_1',
        c: channelId,
      }),
    ).rejects.toThrow(/MEMBER_KEYS/);
  });
});

describe('the raw HMAC secrets', () => {
  it('come from CAPTURE_KEYS after the cutover and MEMBER_KEYS before, by the token’s key', () => {
    const v2 = workerLinks('capture');
    const v1 = workerLinks('capture', { mode: { signing: 'v1', legacyCutoffMs: null } });
    expect(v2.secret('CAPTURE_KEYS')).not.toBe(memberKeys.keys.m1);
    expect(v1.secret('CAPTURE_KEYS')).toBe(memberKeys.keys.m1);
    expect(v2.secret('CAPTURE_KEYS', { kid: 'm1', legacy: true })).toBe(memberKeys.keys.m1);
    expect(v2.secret('CAPTURE_KEYS', { kid: 'constructor', legacy: true })).toBeUndefined();
    expect(workerLinks('site').secret('CAPTURE_KEYS')).toBeUndefined();
  });
});

describe('linksFor', () => {
  it('reads a worker’s env once, and refuses to guess its mode', () => {
    const env = { LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: '1000' };
    expect(linksFor(env)).toBe(linksFor(env));
    expect(linksFor(env).mode).toEqual({ signing: 'v2', legacyCutoffMs: 1000 });
    expect(() => linksFor({})).toThrow(/LINK_SIGNING_MODE/);
  });

  it('fails closed on a keyring it does not hold, for signing and for verifying', async () => {
    const none = createLinkKeys({ mode: { signing: 'v2', legacyCutoffMs: 0 }, rings: {} });
    await expect(none.sign('confirm', { q: 'cq_1', c: channelId })).rejects.toThrow(/CONFIRM_KEYS/);
    await expect(none.verify('member', 'v2.member.t1.e30.x')).rejects.toThrow(/MEMBER_VERIFY_KEYS/);
    // The families on their own v1 keyrings never go through here.
    await expect(none.sign('track', { d: 'dl_1' })).rejects.toThrow(/own v1 keyring/);
  });
});

describe('site previews', () => {
  const api = workerLinks('api');
  const site = workerLinks('site');
  const NOW = Date.now();

  it('round-trip the Channel and the audience for 30 minutes', async () => {
    const { token, expiresAt } = await signSitePreview(
      api,
      { channelId: 'ch_1', as: 'paid' },
      { now: NOW },
    );
    expect(expiresAt).toBe((Math.floor(NOW / 1000) + SITE_PREVIEW_SECONDS) * 1000);
    expect(token.split('.')[1]).toBe(SITE_PREVIEW_PURPOSE);
    expect(await verifySitePreview(site, token, { now: NOW + 60_000 })).toEqual({
      channelId: 'ch_1',
      as: 'paid',
    });
    expect(await verifySitePreview(site, token, { now: expiresAt })).toBeNull();
    // The site holds only the public key.
    await expect(signSitePreview(site, { channelId: 'ch_1', as: 'paid' })).rejects.toThrow();
  });

  it('refuse tokens of another purpose and odd claims', async () => {
    const all = everyLink();
    const other = await all.sign('sponsor-report', { b: 'sb_1', c: 'ch_1' });
    expect(await verifySitePreview(site, other)).toBeNull();
    const odd = await all.sign(
      SITE_PREVIEW_PURPOSE,
      { c: 'ch_1', as: 'owner' },
      { expiresInSeconds: 60 },
    );
    expect(await verifySitePreview(site, odd)).toBeNull();
    expect(await verifySitePreview(site, 'garbage')).toBeNull();
  });
});

describe('bounce codes', () => {
  const bounceKeys = parseKeyring(`b1:${'b'.repeat(40)}`);
  const unsubscribeKeys = parseKeyring(`u1:${'u'.repeat(40)}`);
  const delivery = `dl_${'a'.repeat(32)}`;
  const cutoff = Date.now() - DAY;
  const v2 = { signing: 'v2' as const, legacyCutoffMs: cutoff };

  it('are read under BOUNCE_KEYS, and never from an unsubscribe code', async () => {
    const keys = { bounceKeys, unsubscribeKeys, mode: v2 };
    expect(await readAnyBounceCode(keys, await bounceCode(bounceKeys, delivery))).toBe(delivery);
    // The unsubscribe code is in every forwarded copy, under either key.
    const unsubscribe = await unsubscribeCode(unsubscribeKeys, delivery);
    expect(await readAnyBounceCode(keys, unsubscribe)).toBeNull();
    expect(await readAnyBounceCode(keys, await unsubscribeCode(bounceKeys, delivery))).toBeNull();
  });

  it('under UNSUBSCRIBE_KEYS count before the cutover and for 14 days after it', async () => {
    const legacy = await bounceCode(unsubscribeKeys, delivery);
    expect(await readBounceCode(bounceKeys, legacy)).toBeNull();
    const before = {
      bounceKeys,
      unsubscribeKeys,
      mode: { signing: 'v1' as const, legacyCutoffMs: null },
    };
    expect(await readAnyBounceCode(before, legacy)).toBe(delivery);
    const after = { bounceKeys, unsubscribeKeys, mode: v2 };
    expect(await readAnyBounceCode(after, legacy)).toBe(delivery);
    expect(await readAnyBounceCode(after, legacy, cutoff + LEGACY_BOUNCE_DAYS * DAY - 1)).toBe(
      delivery,
    );
    expect(await readAnyBounceCode(after, legacy, cutoff + LEGACY_BOUNCE_DAYS * DAY)).toBeNull();
  });
});

describe('sponsor reports on their own keyring', () => {
  it('still open at the site when signed with the keyring they had before', async () => {
    // A report link the api signed with SITE_LINK_SIGNING_KEYS before sponsor reports got their
    // own ring, crafted with that key (no worker signs them that way any more).
    const ring = await parseSigningKeyring(
      'SITE_LINK_SIGNING_KEYS',
      testLinkKey('SITE_LINK_SIGNING_KEYS'),
    );
    const iat = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ c: channelId, b: 'bk_1', iat, exp: iat + 86_400 })),
    );
    const input = `v2.sponsor-report.${ring.current}.${payload}`;
    const sig = await crypto.subtle.sign(
      'Ed25519',
      ring.keys[ring.current] as CryptoKey,
      new TextEncoder().encode(input),
    );
    const before = `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
    expect((await workerLinks('site').verify('sponsor-report', before)).ok).toBe(true);
    // Without the former ring's public keys it does not.
    const withoutFormer = workerLinks(['SPONSOR_REPORT_VERIFY_KEYS']);
    expect((await withoutFormer.verify('sponsor-report', before)).ok).toBe(false);
    // And jobs, which signs reports, can no longer sign a design preview.
    await expect(workerLinks('jobs').sign(SITE_PREVIEW_PURPOSE, { c: channelId })).rejects.toThrow(
      /is not set/,
    );
    const now = await workerLinks('jobs').sign('sponsor-report', { c: channelId, b: 'bk_1' });
    expect((await workerLinks('site').verify('sponsor-report', now)).ok).toBe(true);
  });
});
