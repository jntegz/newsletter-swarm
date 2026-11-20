// The contract B4 builds the callers against: each caller's entrypoint name (what its wrangler
// binding names), and the principal kinds each one takes, held to their shapes at compile time.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  VAULT_ENTRYPOINTS,
  type CaptureVault,
  type CronPrincipal,
  type JobsPrincipal,
  type JobsVault,
  type PersonPrincipal,
  type Principal,
  type PublicPrincipal,
  type SiteVault,
  type VaultCaller,
} from '../src';

describe('the vault contract', () => {
  it('names one entrypoint per caller', () => {
    expect(VAULT_ENTRYPOINTS).toEqual({
      api: 'ApiVault',
      capture: 'CaptureVault',
      site: 'SiteVault',
      jobs: 'JobsVault',
    } satisfies Record<VaultCaller, string>);
  });

  it('takes only person and public principals on the public entrypoints, stored ones on jobs', () => {
    expectTypeOf<Parameters<CaptureVault['providerFetch']>[0]>().toEqualTypeOf<
      PersonPrincipal | PublicPrincipal
    >();
    expectTypeOf<Parameters<SiteVault['providerFetch']>[0]>().toEqualTypeOf<
      PersonPrincipal | PublicPrincipal
    >();
    expectTypeOf<Parameters<JobsVault['providerFetch']>[0]>().toEqualTypeOf<JobsPrincipal>();
    expectTypeOf<CronPrincipal>().toMatchTypeOf<Principal>();
    const cron: CronPrincipal = { kind: 'cron', task: 'paypal-reconcile' };
    expect(cron.kind).toBe('cron');
  });
});
