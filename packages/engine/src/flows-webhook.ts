/**
 * webhook_call nodes: https only, private hosts and IP literals refused (outbound-url.ts, shared
 * with Event Webhooks), a 10 second timeout, and the Event Webhooks signature:
 *
 *   Swarm-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *   Swarm-Webhook-Id: <run id>:<node id>  (stable across retries, for receiver deduplication)
 *
 * The key is the Flow's webhook secret (flows.webhook_secret_enc), which only the vault opens:
 * it makes the signature (@swarm/vault signFlowWebhook). Any non-2xx answer, a timeout or a
 * network error is a failure, which the engine retries with backoff.
 */
import { hexEncode } from './flows-util';
import { outboundUrlProblem } from './outbound-url';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SIGNATURE_HEADER = 'Swarm-Signature';
export const WEBHOOK_ID_HEADER = 'Swarm-Webhook-Id';

/** Why a URL may not be called, or null when it may. */
export function webhookUrlProblem(raw: string): string | null {
  return outboundUrlProblem(raw);
}

/** The Swarm-Signature value for `body` at `timestamp` (unix seconds). */
export async function webhookSignature(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=${hexEncode(new Uint8Array(mac))}`;
}

export class WebhookError extends Error {
  constructor(
    message: string,
    /** True when retrying can't help (a refused URL). */
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

/**
 * POSTs a signed JSON body. Throws WebhookError on refusal, timeout, network error or non-2xx.
 * The signature comes from `sign` (the vault, which holds the secret) or from `secret` itself.
 */
export async function callWebhook(
  fetcher: typeof fetch,
  input: { url: string; id: string; payload: unknown; now: number } & (
    { secret: string } | { sign: (timestamp: number, body: string) => Promise<string> }
  ),
): Promise<{ status: number }> {
  const problem = webhookUrlProblem(input.url);
  if (problem) throw new WebhookError(`Webhook URL refused: ${problem}.`, true);
  const body = JSON.stringify(input.payload);
  const timestamp = Math.floor(input.now / 1000);
  const signature =
    'sign' in input
      ? await input.sign(timestamp, body)
      : await webhookSignature(input.secret, timestamp, body);
  let response: Response;
  try {
    response = await fetcher(input.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Swarm-Webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_ID_HEADER]: input.id,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    throw new WebhookError(
      name === 'TimeoutError' || name === 'AbortError'
        ? 'The webhook did not answer within 10 seconds.'
        : `The webhook could not be reached: ${(error as Error).message}`,
    );
  }
  // The body is never read beyond what's needed to release the connection.
  await response.body?.cancel().catch(() => undefined);
  if (response.status < 200 || response.status > 299) {
    throw new WebhookError(`The webhook answered ${response.status}.`);
  }
  return { status: response.status };
}
