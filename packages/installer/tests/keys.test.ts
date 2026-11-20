import {
  parseKeyring,
  parseSigningKeyring,
  parseVerifyKeyring,
  publicKeyring,
} from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { ensureKeyrings, KEY_REGISTRY, KEYRING_NAMES, newKeyring } from '../src/keys';
import { emptySecrets } from '../src/state';

describe('keyrings', () => {
  it('look like k<yyyymmdd>:<64 base64url characters> and parse', () => {
    const ring = newKeyring(new Date('2026-11-01T12:00:00Z'));
    expect(ring).toMatch(/^k20261101:[A-Za-z0-9_-]{64}$/);
    const parsed = parseKeyring(ring);
    expect(parsed.current).toBe('k20261101');
    expect(parsed.keys.k20261101).toHaveLength(64);
  });

  it('are random', () => {
    expect(newKeyring()).not.toBe(newKeyring());
  });

  it('are generated once and never replaced on a re-run', async () => {
    const secrets = emptySecrets();
    expect(await ensureKeyrings(secrets)).toEqual([...KEYRING_NAMES]);
    const first = { ...secrets.keys };
    expect(await ensureKeyrings(secrets)).toEqual([]);
    expect(secrets.keys).toEqual(first);
    for (const name of KEYRING_NAMES)
      expect(() => parseKeyring(secrets.keys[name] as string)).not.toThrow();
  });

  it('fills only a missing keyring, as an update of an install from before per-link keys', async () => {
    const secrets = emptySecrets();
    for (const name of ['AUTH_KEYS', 'TRACK_KEYS', 'UNSUBSCRIBE_KEYS', 'FIELD_KEYS', 'MEMBER_KEYS'])
      secrets.keys[name] = newKeyring();
    const kept = { ...secrets.keys };
    const created = await ensureKeyrings(secrets);
    expect(created).toEqual(KEYRING_NAMES.filter((name) => !(name in kept)));
    expect(created).toContain('READER_KEYS');
    expect(created).toContain('MEMBER_SIGNING_KEYS');
    for (const [name, value] of Object.entries(kept)) expect(secrets.keys[name]).toBe(value);
  });

  it('makes no MEMBER_KEYS for an install that starts on v2 links', async () => {
    const secrets = emptySecrets();
    const created = await ensureKeyrings(secrets, { legacy: false });
    expect(created).not.toContain('MEMBER_KEYS');
    expect(secrets.keys.MEMBER_KEYS).toBeUndefined();
  });

  it('makes Ed25519 keyrings whose derived public keys verify what they sign', async () => {
    const secrets = emptySecrets();
    await ensureKeyrings(secrets, { now: new Date('2026-11-01T00:00:00Z') });
    for (const entry of KEY_REGISTRY) {
      const value = secrets.keys[entry.name] as string;
      if (entry.alg !== 'ed25519') {
        expect(value).toMatch(/^k20261101:[A-Za-z0-9_-]{64}$/);
        continue;
      }
      const signing = await parseSigningKeyring(entry.name, value);
      const publicText = await publicKeyring(entry.name, value);
      expect(publicText).toMatch(/^k20261101:[A-Za-z0-9_-]{43}$/);
      const verify = await parseVerifyKeyring(entry.name, publicText);
      const data = new TextEncoder().encode('swarm');
      const signature = await crypto.subtle.sign('Ed25519', signing.keys.k20261101!, data);
      expect(await crypto.subtle.verify('Ed25519', verify.keys.k20261101!, signature, data)).toBe(
        true,
      );
    }
  });
});
