// Event Webhooks (Phase 7): the minute fan-out and sweep, the `webhooks` Queue consumer and the
// daily prune. The work itself is in @swarm/engine (webhooks.ts); this wires it to the env.
import {
  deliverWebhook,
  fanOutWebhooks,
  mailAdapter,
  pruneWebhooks,
  sweepWebhooks,
  type WebhookMessage,
  type WebhooksEnv,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';
import { signDelivery } from '../vault';

const log = createLogger({ service: 'jobs' });

let injectedFetch: typeof fetch | undefined;

/** Tests answer webhook requests here. Pass undefined to go back to the real fetch. */
export function useWebhookFetchForTests(fetcher: typeof fetch | undefined): void {
  injectedFetch = fetcher;
}

function webhooksEnv(env: JobsEnv): WebhooksEnv {
  return {
    DB: env.DB,
    WEBHOOKS_QUEUE: env.WEBHOOKS_QUEUE,
    signDelivery: signDelivery(env),
    ENVIRONMENT: env.ENVIRONMENT,
    ...(injectedFetch ? { fetch: injectedFetch } : {}),
    notices: {
      mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      from: `notifications@${env.PLATFORM_MAIL_DOMAIN}`,
    },
  };
}

/** The minute cron: new events into deliveries, then anything overdue back on the queue. */
export async function runWebhooksMinute(env: JobsEnv, now: number): Promise<void> {
  const wenv = webhooksEnv(env);
  const created = await fanOutWebhooks(wenv, now);
  const swept = await sweepWebhooks(wenv, now);
  if (created || swept) log.info('webhooks', { created, swept });
}

/** The daily cron: finished deliveries and outbox rows past the retention. */
export async function pruneWebhookData(env: JobsEnv, now: number): Promise<void> {
  log.info('webhooks pruned', await pruneWebhooks(env.DB, now));
}

/**
 * The `webhooks` Queue consumer. State lives in D1 (retries are scheduled there), so a message
 * is acked once its attempt is recorded; only an error before that retries the message.
 */
export async function consumeWebhooks(
  env: JobsEnv,
  messages: readonly Message<WebhookMessage>[],
): Promise<void> {
  const wenv = webhooksEnv(env);
  await Promise.all(
    messages.map(async (message) => {
      try {
        await deliverWebhook(wenv, message.body.deliveryId, Date.now());
        message.ack();
      } catch (error) {
        log.warn('webhook delivery failed; retrying', {
          deliveryId: message.body.deliveryId,
          error: (error as Error).message,
        });
        message.retry({ delaySeconds: 30 });
      }
    }),
  );
}
