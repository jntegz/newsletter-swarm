/**
 * What a caller's env schema says about the vault: the VAULT service binding, required outside
 * tests (tests use the in-process fake through useVaultForTests), and FIELD_KEYS refused on a
 * deployed worker (staging, production), so one still holding the old secret fails to start
 * instead of quietly keeping it. A local .dev.vars from before the vault may still carry it: it is
 * ignored there (nothing reads it), and `pnpm setup:dev` writes a new one without it.
 */
import { binding } from '@swarm/runtime';
import { z } from 'zod';
import type { VaultCaller, VaultFor } from './api';

/** Fields for a caller's env schema (spread into it). */
export const vaultEnvFields = <C extends VaultCaller>() => ({
  /** The vault (workers/vault), through this worker's own entrypoint. */
  VAULT: binding<VaultFor[C]>().optional(),
  /** Held by the vault Worker alone (docs/security.md "The vault"): refused, never read. */
  FIELD_KEYS: z.unknown().optional(),
});

/** Use inside the schema's superRefine: VAULT is required outside ENVIRONMENT=test. */
export function checkVaultEnv(
  env: { ENVIRONMENT: string; VAULT?: unknown; FIELD_KEYS?: unknown },
  ctx: z.RefinementCtx,
): void {
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (!local && env.FIELD_KEYS !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIELD_KEYS'],
      message: 'is held by the vault Worker alone: delete this secret from this worker',
    });
  }
  if (env.ENVIRONMENT !== 'test' && !env.VAULT) {
    ctx.addIssue({
      code: 'custom',
      path: ['VAULT'],
      message: 'the VAULT service binding is missing (encrypted data is reached only through it)',
    });
  }
}
