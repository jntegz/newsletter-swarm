/** A quota the provider can report as used up: the account's daily or monthly sending. */
export type ProviderQuota = 'day' | 'month';

/**
 * Provider errors the send pipeline classifies without knowing the provider:
 * - quota: the account's daily or monthly quota is used up, so sending waits for it to reset;
 * - halting: the whole account can't send (suspended, credentials or domain rejected), so the
 *   send stops until a person resumes it;
 * - retryable: throttling or a provider outage, so the batch is retried later;
 * - none of these: this one message was rejected (a bad address, say) and is recorded as failed.
 */
export class MailProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds the provider asked us to wait (Retry-After), when it said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'MailProviderError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  get halting(): boolean {
    return false;
  }

  /** The quota the provider says is used up; null for any other error. */
  get quota(): ProviderQuota | null {
    return null;
  }
}

/** Retry-After as seconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The mail service already has a domain of this name, and Swarm didn't create it for the domain
 * being added. Swarm never takes such a domain over: it may be another environment's or the
 * operator's own. Whoever runs the instance removes it at the service first.
 */
export class IdentityExistsError extends Error {
  constructor(readonly domain: string) {
    super(`The mail service already has ${domain}.`);
    this.name = 'IdentityExistsError';
  }
}
