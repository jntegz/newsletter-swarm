/**
 * What a caller wraps its VAULT binding in. Every method gets a timeout, and a transport error, a
 * timeout, a missing binding or a vault that throws all come back as `{ ok: false, reason:
 * 'unavailable' }`: the caller fails closed (encrypted fields not shown, a save answers 503),
 * never a weaker path. Tests swap the binding for the in-process fake with useVaultForTests.
 */
import { ApiError, createLogger, type Logger } from '@swarm/runtime';
import type { VaultCaller, VaultFailure, VaultFor, VaultResult } from './api';

/** The longest a vault call may take before the caller treats the vault as down. */
export const VAULT_TIMEOUT_MS = 5_000;
/**
 * providerStream answers once the provider's headers are in, which for a reply that is not
 * streamed (a Copilot tool turn) is when it is complete: as long as the vault waits for one.
 */
const STREAM_TIMEOUT_MS = 125_000;
/**
 * providerFetch waits for the whole provider answer, which the vault allows 30 s (proxy.ts), so
 * the caller waits a little longer: otherwise a slow Stripe or PayPal call it still completes
 * would be reported here as the vault being down, and the caller might send it again.
 */
const PROVIDER_FETCH_TIMEOUT_MS = 35_000;

const overrides = new Map<VaultCaller, unknown>();

/** Tests: route `caller`'s vault calls to `vault` (fake.ts), or back to the binding with null. */
export function useVaultForTests<C extends VaultCaller>(
  caller: C,
  vault: VaultFor[C] | null,
): void {
  if (vault) overrides.set(caller, vault);
  else overrides.delete(caller);
}

const unavailable = { ok: false, reason: 'unavailable' } as const;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`vault call timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `caller`'s vault, over its binding (or the test override). Methods resolve to a VaultResult
 * and never reject; `ping` resolves to whether the vault answered.
 */
export function vaultClient<C extends VaultCaller>(
  caller: C,
  binding: VaultFor[C] | undefined | null,
  options: { timeoutMs?: number; log?: Logger } = {},
): Omit<VaultFor[C], 'ping'> & { ping(): Promise<boolean> } {
  const timeoutMs = options.timeoutMs ?? VAULT_TIMEOUT_MS;
  const log = options.log ?? createLogger({ service: caller, component: 'vault-client' });
  const target = () => (overrides.get(caller) as VaultFor[C] | undefined) ?? binding ?? null;
  return new Proxy({} as Omit<VaultFor[C], 'ping'> & { ping(): Promise<boolean> }, {
    get(_object, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return async (...args: unknown[]) => {
        const vault = target() as Record<string, (...a: unknown[]) => Promise<unknown>> | null;
        const method = vault?.[property];
        // Called on the binding itself: an RPC stub's method doesn't work detached from it.
        const invoke = () =>
          (vault as Record<string, (...a: unknown[]) => Promise<unknown>>)[property]!(...args);
        if (property === 'ping') {
          if (typeof method !== 'function') return false;
          try {
            const answer = (await withTimeout(invoke(), timeoutMs)) as { ok?: unknown } | undefined;
            return answer?.ok === true;
          } catch {
            return false;
          }
        }
        if (typeof method !== 'function') {
          log.error('vault binding missing', { op: property });
          return unavailable;
        }
        try {
          const limit =
            property === 'providerStream'
              ? STREAM_TIMEOUT_MS
              : property === 'providerFetch'
                ? Math.max(timeoutMs, PROVIDER_FETCH_TIMEOUT_MS)
                : timeoutMs;
          const result = (await withTimeout(invoke(), limit)) as VaultResult<unknown> | undefined;
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            log.error('vault answered without a result', { op: property });
            return unavailable;
          }
          return result;
        } catch (error) {
          log.error('vault unavailable', { op: property, error: (error as Error).message });
          return unavailable;
        }
      };
    },
  });
}

/** The API error a failed vault result becomes on a request path (503 when it is down). */
export function vaultError(reason: VaultFailure): ApiError {
  switch (reason) {
    case 'refused':
      return new ApiError('forbidden', 'You do not have access to this.');
    case 'not_found':
      return new ApiError('not_found', 'Not found.');
    case 'rate_limited':
      return new ApiError('rate_limited', 'Too many requests. Try again in a little while.');
    case 'invalid':
      return new ApiError('invalid_input', 'Some fields are not valid.');
    case 'unreadable':
    case 'unavailable':
      return new ApiError(
        'unavailable',
        'Encrypted data is temporarily unavailable. Nothing was saved; try again shortly.',
      );
  }
}

/** The value of a vault result, or the matching API error (for routes that must not go on). */
export function vaultValue<T>(result: VaultResult<T>): T {
  if (result.ok) return result.value;
  throw vaultError(result.reason);
}
