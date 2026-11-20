/**
 * A publication's own restricted Stripe key, next to Connect. Every money call already names its
 * account (`options.account`), so the routing lives here: an account with a sealed key runs on that
 * key with no Stripe-Account header, and any other account goes through the platform. Callers don't
 * change. docs/deployment.md.
 *
 * Only the vault opens a sealed key: an own-key account's calls go out through the vault's
 * provider proxy (`ownKeyFetch`, @swarm/vault vaultFetch), which attaches the key itself.
 */
import { first } from './db';
import type { ProviderFetch } from './vault-ports';
import {
  DevStripe,
  HttpStripe,
  StripeError,
  stripeApi,
  type PaymentsEnv,
  type StripeApi,
  type StripeParams,
  type StripeRequestOptions,
} from './stripe';

export interface OwnKeyEnv extends PaymentsEnv {
  DB: D1Database;
  /**
   * The vault's Stripe proxy for a Channel's account. Without it, accounts with their own key
   * can't be reached here and their calls fail (503), never falling back to the platform.
   */
  ownKeyFetch?: ((channelId: string) => ProviderFetch) | undefined;
}

/** What the client sends as its key when the vault attaches the real one. */
export const VAULT_HELD_KEY = 'vault-held';

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const UNAVAILABLE = 'Payments are not available here.';

/** Only restricted keys: a leaked one can do far less, and its owner can revoke it in Stripe. */
export const RESTRICTED_KEY = /^rk_(live|test)_[A-Za-z0-9]{10,}$/;

/** What Swarm reads and changes, checked before a key is saved. Stripe names what's missing. */
export const OWN_KEY_READ_CHECKS = [
  '/v1/account',
  '/v1/products',
  '/v1/prices',
  '/v1/customers',
  '/v1/subscriptions',
  '/v1/checkout/sessions',
] as const;

class RoutingStripe implements StripeApi {
  private readonly clients = new Map<string, StripeApi | null>();

  constructor(
    private readonly env: OwnKeyEnv,
    private readonly platform: StripeApi | null,
  ) {}

  private async ownClient(account: string): Promise<StripeApi | null> {
    if (this.clients.has(account)) return this.clients.get(account) ?? null;
    const row = await first<{ channel_id: string }>(
      this.env.DB,
      `SELECT channel_id FROM stripe_accounts
        WHERE stripe_account_id = ?1 AND status = 'connected' AND own_key_enc IS NOT NULL`,
      account,
    );
    let client: StripeApi | null = null;
    if (row) {
      // Never fall back to the platform: this account's calls would run somewhere else.
      if (!this.env.ownKeyFetch) {
        throw new StripeError('The saved Stripe key can’t be read.', 503, null, null);
      }
      client = new HttpStripe(VAULT_HELD_KEY, this.env.ownKeyFetch(row.channel_id));
    }
    this.clients.set(account, client);
    return client;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params?: StripeParams,
    options: StripeRequestOptions = {},
  ): Promise<T> {
    const own = options.account ? await this.ownClient(options.account) : null;
    if (own) {
      const { account, ...rest } = options;
      // A key reads its own account at /v1/account.
      const ownPath = path === `/v1/accounts/${account}` ? '/v1/account' : path;
      return own.request<T>(method, ownPath, params, rest);
    }
    if (!this.platform) throw new StripeError(UNAVAILABLE, 503, null, null);
    return this.platform.request<T>(method, path, params, options);
  }

  private connect(): StripeApi {
    if (!this.platform) throw new StripeError(UNAVAILABLE, 503, null, null);
    return this.platform;
  }

  connectUrl(clientId: string, state: string, redirectUri: string): string {
    return this.connect().connectUrl(clientId, state, redirectUri);
  }

  connectExchange(code: string) {
    return this.connect().connectExchange(code);
  }

  connectRevoke(clientId: string, accountId: string) {
    return this.connect().connectRevoke(clientId, accountId);
  }
}

/**
 * The client for money calls. With PAYMENTS=off it still answers for accounts with their own key;
 * null only when this worker can't hold keys at all. Check the account before relying on it.
 */
export function stripeFor(env: OwnKeyEnv, fetcher: typeof fetch = defaultFetch): StripeApi | null {
  const platform = stripeApi(env, fetcher);
  if (platform instanceof DevStripe) return platform;
  return new RoutingStripe(env, platform);
}

/** Scheduled work runs over every account: with payments off, only if some have their own key. */
export async function stripeForAllAccounts(env: OwnKeyEnv): Promise<StripeApi | null> {
  if (env.PAYMENTS !== 'off') return stripeFor(env);
  const any = await first(
    env.DB,
    `SELECT 1 AS ok FROM stripe_accounts WHERE status = 'connected' AND own_key_enc IS NOT NULL LIMIT 1`,
  );
  return any ? stripeFor(env) : null;
}

/** A client on one key that hasn't been saved yet, to check it. The dev fake stands in locally. */
export const stripeForKey = (
  env: PaymentsEnv,
  key: string,
  fetcher: typeof fetch = defaultFetch,
): StripeApi => (env.PAYMENTS === 'dev' ? new DevStripe() : new HttpStripe(key, fetcher));

/**
 * The client of a worker with no Stripe key of its own (capture, site): every call goes through
 * the vault's proxy (`fetcher`, for one Channel), which picks the Channel's own key or the
 * platform key with its connected account. The caller's account option is dropped on the way.
 */
export function stripeThroughVault(env: PaymentsEnv, fetcher: ProviderFetch): StripeApi | null {
  if (env.PAYMENTS === 'off') return null;
  if (env.PAYMENTS === 'dev') return new DevStripe();
  return new HttpStripe(VAULT_HELD_KEY, fetcher);
}
