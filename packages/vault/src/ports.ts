/**
 * The engine's ports (@swarm/engine vault-ports.ts) on a caller's vault client: what api, capture,
 * site and jobs hand engine code where it used to take FIELD_KEYS or a provider key. Every port
 * fails closed: a vault that is down or refuses becomes an error (vaultValue: 503 on a request, a
 * retry on a queue), and a provider fetch becomes the matching HTTP status, never a local key.
 */
import type { PrivacyVault } from '@swarm/engine';
import type {
  AddressMarkerSet,
  CredentialRef,
  VaultFailure,
  VaultRequest,
  VaultResult,
  VaultStreamResponse,
} from './api';
import { vaultValue } from './client';

/** What a vault failure looks like to a provider client reading the fetch answer. */
const FAILURE_STATUS: Record<VaultFailure, number> = {
  refused: 403,
  not_found: 404,
  unreadable: 503,
  rate_limited: 429,
  invalid: 400,
  unavailable: 503,
};

/** Headers that carry a credential: the vault attaches its own, and refuses the caller's. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'stripe-account',
  'cookie',
  'proxy-authorization',
]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const NO_BODY = new Set([101, 204, 205, 304]);

interface Proxy<P> {
  providerFetch(
    principal: P,
    credential: CredentialRef,
    request: VaultRequest,
  ): Promise<VaultResult<{ status: number; headers: [string, string][]; body: string }>>;
  /** The api's entrypoint only (ApiVault.providerStream). */
  providerStream?(
    principal: P,
    credential: CredentialRef,
    request: VaultRequest,
  ): Promise<VaultResult<VaultStreamResponse>>;
}

/**
 * A fetch for provider clients (HttpStripe, PayPalApi, the Copilot provider, DeBounce) that sends
 * each request through the vault's providerFetch with `credential` attached there. The client's own
 * credential headers (a placeholder key) are dropped; the vault decides the key and, for Stripe,
 * the connected account. A refusal or an outage comes back as an error status with a JSON message.
 * With `stream` (Copilot), requests go through providerStream and the answer's body streams back
 * as the provider sends it.
 */
export function vaultFetch<P>(
  vault: Proxy<P>,
  principal: P,
  credential: CredentialRef,
  options: { stream?: boolean } = {},
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    if (!METHODS.has(method)) throw new TypeError(`The vault does not send ${method} requests.`);
    const headers = [...request.headers.entries()].filter(
      ([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()),
    );
    const body = method === 'GET' ? undefined : await request.text();
    const outbound: VaultRequest = {
      method: method as VaultRequest['method'],
      url: request.url,
      headers,
      ...(body ? { body } : {}),
    };
    const call: Promise<
      VaultResult<
        VaultStreamResponse | { status: number; headers: [string, string][]; body: string }
      >
    > =
      options.stream && vault.providerStream
        ? vault.providerStream(principal, credential, outbound)
        : vault.providerFetch(principal, credential, outbound);
    // As fetch does: the caller's own signal (a client's timeout, such as DeBounce's few seconds at
    // sign-up) ends the wait, even though the vault would keep waiting for the provider.
    const result = await abortable(call, init?.signal ?? undefined);
    if (!result.ok) {
      const message =
        result.reason === 'unavailable' || result.reason === 'unreadable'
          ? 'The payment or provider connection is temporarily unavailable.'
          : 'This provider request is not allowed here.';
      return new Response(JSON.stringify({ error: { message, type: 'vault' }, message }), {
        status: FAILURE_STATUS[result.reason],
        headers: { 'content-type': 'application/json' },
      });
    }
    const { status, headers: answered, body: text } = result.value;
    return new Response(NO_BODY.has(status) ? null : text, { status, headers: answered });
  };
}

/** `work`, or the signal's reason as soon as it aborts, as fetch rejects. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

interface Markers {
  addressMarkers(args: {
    workspaceId: string;
    email: string;
  }): Promise<VaultResult<AddressMarkerSet>>;
  addressMarkersBulk?(args: {
    workspaceId: string;
    emails: string[];
  }): Promise<VaultResult<Record<string, AddressMarkerSet>>>;
}

/**
 * Erasure markers through the vault, for engine privacy code (isErasedAddress and the rest).
 * `bulk` only for jobs, whose entrypoint has addressMarkersBulk (a client answers every name).
 */
export function markerPort(vault: Markers, options: { bulk?: boolean } = {}): PrivacyVault {
  const bulk = options.bulk ? vault.addressMarkersBulk?.bind(vault) : undefined;
  return {
    addressMarkers: async (workspaceId, email) =>
      vaultValue(await vault.addressMarkers({ workspaceId, email })),
    ...(bulk
      ? {
          addressMarkersMany: async (workspaceId: string, emails: string[]) =>
            vaultValue(await bulk({ workspaceId, emails })),
        }
      : {}),
  };
}

/** A vault result's value, null for a value that can't be opened, else the error (fail closed). */
export function openedOrNull<T>(result: VaultResult<T>): T | null {
  if (result.ok) return result.value;
  if (
    result.reason === 'unreadable' ||
    result.reason === 'refused' ||
    result.reason === 'not_found'
  ) {
    return null;
  }
  return vaultValue(result);
}
