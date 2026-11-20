import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAMILIES, KEYRING_ALGS, publicKeyring, verifyKeysName } from '@swarm/tokens';
import {
  cutOverLinkKeys,
  initialLinkKeys,
  KEY_REGISTRY,
  KEY_SECRET_NAMES,
  keyringEntry,
  keySecretNames,
  linkKeyWindows,
  MAIL_SECRETS,
  MAIL_WORKERS,
  SECRET_MATRIX,
  secretNames,
  verifierWorkers,
  type KeyHolder,
} from '../src/keys';
import { REPO_ROOT, WORKERS, type Worker } from '../src/paths';

/** Required secrets in .dev.vars.example: uncommented NAME= lines. */
function devVars(worker: string): string[] {
  const file = join(REPO_ROOT, 'workers', worker, '.dev.vars.example');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => !!name);
}

/** NAME=value lines of a worker's .dev.vars.example. */
function devValues(worker: string): Map<string, string> {
  const file = join(REPO_ROOT, 'workers', worker, '.dev.vars.example');
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) out.set(match[1] as string, match[2] as string);
  }
  return out;
}

const off = { customDomains: false, payments: false, google: false };

describe('SECRET_MATRIX', () => {
  for (const worker of WORKERS) {
    it(`${worker} matches its .dev.vars.example`, () => {
      expect([...SECRET_MATRIX[worker]].sort()).toEqual(devVars(worker).sort());
    });
  }

  it('gives a keyring the same example value in every worker, and public keys that match', async () => {
    const seen = new Map<string, string>();
    for (const worker of WORKERS) {
      for (const [name, value] of devValues(worker)) {
        if (!name.endsWith('_KEYS')) continue;
        expect(seen.get(name) ?? value, `${worker} ${name}`).toBe(value);
        seen.set(name, value);
      }
    }
    for (const entry of KEY_REGISTRY.filter((e) => e.alg === 'ed25519')) {
      const signing = seen.get(entry.name) as string;
      expect(signing, entry.name).toMatch(/^dev0:/);
      expect(seen.get(verifyKeysName(entry.name))).toBe(await publicKeyring(entry.name, signing));
    }
  });

  it('gives FIELD_KEYS, SIGNUP_KEYS and the goods signing key to the vault alone', () => {
    for (const name of ['FIELD_KEYS', 'SIGNUP_KEYS', 'GOODS_SIGNING_KEYS']) {
      expect(
        WORKERS.filter((worker) => SECRET_MATRIX[worker].includes(name)),
        name,
      ).toEqual(['vault']);
    }
    // Member Center links: the vault for api and capture; send and jobs sign their own mail.
    expect(WORKERS.filter((w) => SECRET_MATRIX[w].includes('MEMBER_SIGNING_KEYS')).sort()).toEqual([
      'jobs',
      'send',
      'vault',
    ]);
  });

  it('adds the mail credentials of the chosen provider to every worker that sends', () => {
    for (const worker of WORKERS) {
      const ses = secretNames(worker, {
        provider: 'ses',
        features: off,
        resendWebhookSecret: false,
      });
      const resend = secretNames(worker, {
        provider: 'resend',
        features: off,
        resendWebhookSecret: false,
      });
      const sends = MAIL_WORKERS.includes(worker);
      expect(ses).toEqual([...SECRET_MATRIX[worker], ...(sends ? MAIL_SECRETS.ses : [])]);
      expect(resend).toEqual([...SECRET_MATRIX[worker], ...(sends ? MAIL_SECRETS.resend : [])]);
    }
  });

  it('gives events the Resend webhook secret once it exists', () => {
    expect(
      secretNames('events', { provider: 'resend', features: off, resendWebhookSecret: true }),
    ).toEqual(['UNSUBSCRIBE_KEYS', 'BOUNCE_KEYS', 'RESEND_WEBHOOK_SECRET']);
  });

  it('adds feature secrets', () => {
    const all = { customDomains: true, payments: true, google: true };
    const api = secretNames('api', {
      provider: 'resend',
      features: all,
      resendWebhookSecret: false,
    });
    expect(api).toEqual(
      expect.arrayContaining([
        'CF_ZONE_ID',
        'CF_API_TOKEN',
        'STRIPE_SECRET_KEY',
        'STRIPE_CONNECT_CLIENT_ID',
        'STRIPE_WEBHOOK_SECRETS',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
      ]),
    );
    // capture and site make their Stripe calls through the vault, which holds the key.
    for (const worker of ['site', 'capture'] as const) {
      expect(
        secretNames(worker, { provider: 'resend', features: all, resendWebhookSecret: false }),
      ).not.toContain('STRIPE_SECRET_KEY');
    }
    expect(
      secretNames('vault', { provider: 'resend', features: all, resendWebhookSecret: false }),
    ).toContain('STRIPE_SECRET_KEY');
    expect(
      secretNames('track', { provider: 'resend', features: all, resendWebhookSecret: false }),
    ).toEqual(['TRACK_KEYS', 'UNSUBSCRIBE_KEYS']);
  });
});

describe('KEY_REGISTRY', () => {
  /** The matrix once every interim holder is gone (B4), with the vault's own column. */
  const final = (holder: KeyHolder) =>
    KEY_REGISTRY.filter((e) => !e.legacyHolders).flatMap((entry) => {
      const signs = entry.signers.includes(holder);
      const verifies = entry.verifiers.includes(holder);
      if (entry.alg !== 'ed25519') return signs || verifies ? [entry.name] : [];
      return [...(signs ? [entry.name] : []), ...(verifies ? [verifyKeysName(entry.name)] : [])];
    });

  it('gives each worker the keyrings of the target design once callers use the vault', () => {
    expect(final('vault')).toEqual([
      'SIGNUP_KEYS',
      'FIELD_KEYS',
      'MEMBER_SIGNING_KEYS',
      'MEMBER_VERIFY_KEYS',
      'GOODS_SIGNING_KEYS',
    ]);
    expect(final('api')).toEqual([
      'AUTH_KEYS',
      'UNSUBSCRIBE_KEYS',
      'CONFIRM_KEYS',
      'CHECKOUT_VERIFY_KEYS',
      'SITE_LINK_SIGNING_KEYS',
      'SPONSOR_REPORT_SIGNING_KEYS',
    ]);
    expect(final('capture')).toEqual([
      'CONFIRM_KEYS',
      'CAPTURE_KEYS',
      'FORM_STAMP_KEYS',
      'MEMBER_VERIFY_KEYS',
      'ASK_VERIFY_KEYS',
      'ASK_PAGE_SIGNING_KEYS',
      'DSR_EXPORT_VERIFY_KEYS',
    ]);
    expect(final('site')).toEqual([
      'READER_KEYS',
      'CONFIRM_KEYS',
      'FORM_STAMP_KEYS',
      'ASK_PAGE_VERIFY_KEYS',
      'GOODS_VERIFY_KEYS',
      'CHECKOUT_SIGNING_KEYS',
      'SITE_LINK_VERIFY_KEYS',
      'SPONSOR_REPORT_VERIFY_KEYS',
    ]);
    // Sponsor reports have their own ring: jobs holds no design-preview key.
    expect(final('jobs')).toEqual([
      'MEMBER_SIGNING_KEYS',
      'DSR_EXPORT_SIGNING_KEYS',
      'SPONSOR_REPORT_SIGNING_KEYS',
    ]);
    expect(final('send')).toEqual([
      'TRACK_KEYS',
      'UNSUBSCRIBE_KEYS',
      'BOUNCE_KEYS',
      'MEMBER_SIGNING_KEYS',
      'ASK_SIGNING_KEYS',
    ]);
    expect(final('track')).toEqual(['TRACK_KEYS', 'UNSUBSCRIBE_KEYS']);
    expect(final('events')).toEqual(['UNSUBSCRIBE_KEYS', 'BOUNCE_KEYS']);
    expect(final('realtime')).toEqual([]);
  });

  it('never gives a public worker the private key of a link family another worker signs', () => {
    // The public workers that verify an Ed25519 family hold only its public keys, unless they
    // sign it too (today only as an interim holder, which B4 removes).
    for (const entry of KEY_REGISTRY.filter((e) => e.alg === 'ed25519')) {
      for (const worker of entry.verifiers) {
        if (worker === 'vault') continue;
        expect(final(worker as Worker), `${worker} ${entry.name}`).not.toContain(entry.name);
      }
    }
  });

  it('keeps an old key at least as long as anything it signs lives', () => {
    for (const spec of Object.values(FAMILIES)) {
      const days = keyringEntry(spec.keyring).maxLinkLifetimeDays;
      if (spec.maxLifetimeSeconds === null) continue;
      expect(days, spec.purpose).not.toBeNull();
      expect(spec.maxLifetimeSeconds, spec.purpose).toBeLessThanOrEqual((days as number) * 86_400);
    }
    for (const entry of KEY_REGISTRY) expect(KEYRING_ALGS[entry.name]).toBe(entry.alg);
  });

  it('keeps MEMBER_KEYS on each verifier for the longest window of what it verifies', () => {
    const DAY = 86_400_000;
    // The vault verifies member links itself (B3), so it needs v1 ones for their 30 days too.
    expect(linkKeyWindows(0)).toEqual({
      capture: 90 * DAY,
      site: 90 * DAY,
      api: 30 * DAY,
      vault: 30 * DAY,
    });
    const linkKeys = cutOverLinkKeys(1000);
    expect(linkKeys).toEqual({
      mode: 'v2',
      cutoffAt: 1000,
      legacyUntil: {
        vault: 1000 + 30 * DAY,
        api: 1000 + 30 * DAY,
        capture: 1000 + 90 * DAY,
        site: 1000 + 90 * DAY,
      },
    });
    const holders = (now: number) =>
      WORKERS.filter((w) => keySecretNames(w, linkKeys, now).includes('MEMBER_KEYS'));
    expect(holders(1000)).toEqual(['vault', 'site', 'capture', 'api']);
    expect(holders(1000 + 30 * DAY)).toEqual(['site', 'capture']);
    expect(holders(1000 + 90 * DAY)).toEqual([]);
    // Before the cutover, and on an install that has not moved, it stays where it was.
    for (const linkKeys of [undefined, { mode: 'verify-v2' as const }]) {
      expect(WORKERS.filter((w) => keySecretNames(w, linkKeys, 0).includes('MEMBER_KEYS'))).toEqual(
        ['vault', 'site', 'capture', 'send', 'jobs', 'api'],
      );
    }
  });

  it('manages every keyring and public key name, and nothing else', () => {
    expect([...KEY_SECRET_NAMES]).toContain('MEMBER_VERIFY_KEYS');
    expect([...KEY_SECRET_NAMES]).toContain('MEMBER_KEYS');
    expect([...KEY_SECRET_NAMES]).not.toContain('TURNSTILE_SECRET_KEY');
    expect(verifierWorkers('MEMBER_SIGNING_KEYS')).toEqual(['vault', 'capture']);
    expect(verifierWorkers('CONFIRM_KEYS')).toEqual(['capture']);
  });

  it('starts a new install on v2 only when the code signs it', () => {
    expect(initialLinkKeys(true, true, 5)).toEqual({ mode: 'v2', cutoffAt: 5, legacyUntil: {} });
    expect(initialLinkKeys(true, false, 5)).toEqual({ mode: 'verify-v2' });
    expect(initialLinkKeys(false, true, 5)).toEqual({ mode: 'verify-v2' });
  });
});
