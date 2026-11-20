// The client a caller wraps its VAULT binding in: every failure (no binding, a timeout, a
// transport error, a vault that throws or answers nonsense) is `unavailable`, never a rejection
// and never a value, so the caller fails closed. And the API errors a failed result becomes.
import { describe, expect, it } from 'vitest';
import {
  useVaultForTests,
  VAULT_TIMEOUT_MS,
  vaultClient,
  vaultError,
  vaultValue,
  type CaptureVault,
  type JobsVault,
} from '../src';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('vaultClient', () => {
  it('passes results through', async () => {
    const binding = {
      openJourneyToken: async () => ({ ok: true, value: { journeyId: 'sj_1' } }),
    } as unknown as CaptureVault;
    const client = vaultClient('capture', binding, { log: quiet });
    expect(await client.openJourneyToken({ token: 't' })).toEqual({
      ok: true,
      value: { journeyId: 'sj_1' },
    });
  });

  it('is unavailable without a binding, on a throw, on nonsense and after the timeout', async () => {
    expect(
      await vaultClient('jobs', undefined, { log: quiet }).openDsrAddress({
        kind: 'dsr-request',
        requestId: 'pr_1',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    const throwing = {
      openDsrAddress: async () => {
        throw new Error('Network connection lost');
      },
    } as unknown as JobsVault;
    expect(
      await vaultClient('jobs', throwing, { log: quiet }).openDsrAddress({
        kind: 'dsr-request',
        requestId: 'pr_1',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    const nonsense = { openDsrAddress: async () => 'plain' } as unknown as JobsVault;
    expect(
      await vaultClient('jobs', nonsense, { log: quiet }).openDsrAddress({
        kind: 'dsr-request',
        requestId: 'pr_1',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    const slow = {
      openDsrAddress: () => new Promise(() => undefined),
    } as unknown as JobsVault;
    expect(
      await vaultClient('jobs', slow, { log: quiet, timeoutMs: 20 }).openDsrAddress({
        kind: 'dsr-request',
        requestId: 'pr_1',
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('pings: true only when the vault answers', async () => {
    const up = { ping: async () => ({ ok: true, entrypoint: 'site' }) };
    expect(await vaultClient('site', up as never, { log: quiet }).ping()).toBe(true);
    expect(await vaultClient('site', undefined, { log: quiet }).ping()).toBe(false);
    const down = {
      ping: async () => {
        throw new Error('no such service');
      },
    };
    expect(await vaultClient('site', down as never, { log: quiet }).ping()).toBe(false);
  });

  it('uses the test vault when one is set, for that caller only', async () => {
    const fake = {
      ping: async () => ({ ok: true, entrypoint: 'capture' }),
    } as unknown as CaptureVault;
    useVaultForTests('capture', fake);
    try {
      expect(await vaultClient('capture', undefined, { log: quiet }).ping()).toBe(true);
      expect(await vaultClient('site', undefined, { log: quiet }).ping()).toBe(false);
    } finally {
      useVaultForTests('capture', null);
    }
    expect(await vaultClient('capture', undefined, { log: quiet }).ping()).toBe(false);
  });
});

describe('vaultValue and vaultError', () => {
  it('gives the vault five seconds by default', () => {
    expect(VAULT_TIMEOUT_MS).toBe(5_000);
  });

  it('returns the value, or throws the matching API error (503 when down)', () => {
    expect(vaultValue({ ok: true, value: 3 })).toBe(3);
    expect(() => vaultValue({ ok: false, reason: 'unavailable' })).toThrow(
      /temporarily unavailable/,
    );
    expect(vaultError('unavailable').code).toBe('unavailable');
    expect(vaultError('unreadable').code).toBe('unavailable');
    expect(vaultError('refused').code).toBe('forbidden');
    expect(vaultError('not_found').code).toBe('not_found');
    expect(vaultError('rate_limited').code).toBe('rate_limited');
    expect(vaultError('invalid').code).toBe('invalid_input');
  });
});
