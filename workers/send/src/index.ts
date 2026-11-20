// Broadcast pipeline: queue consumers (snapshot, fan-out, batches) and the minute cron
// (scheduled Dispatches, the stuck-Broadcast reaper and resuming paused sends, sending-domain
// verification, dedicated IP provisioning and warm-up).
import { D1FlagStore, FlagService } from '@swarm/flags';
import {
  linksFor,
  RetryLater,
  StartError,
  dedicatedSending,
  domainIdentities,
  dueDispatches,
  engineConfig,
  handleSendMessage,
  linkHostnames,
  mailAdapter,
  providerMail,
  publishProgress,
  reap,
  refreshDomain,
  DOMAIN_CHECK_WINDOW_MS,
  releaseBestTimeSlots,
  sendLimiter,
  startBroadcast,
  sweepDedicatedIps,
  txtResolver,
  DevHostnames,
  type PipelineContext,
  type SendMessage,
  type SendQueue,
} from '@swarm/engine';
import { appendAudit, all, run } from '@swarm/db';
import { createLogger, useRuntime, type RuntimeVariables } from '@swarm/runtime';
import { Hono } from 'hono';
import { parseSendEnv, type SendEnv } from './env';

export const app = new Hono<{ Variables: RuntimeVariables }>();
useRuntime(app, { service: 'send', parseEnv: parseSendEnv });

const log = createLogger({ service: 'send' });

function queueOf(queue: Queue<SendMessage>): SendQueue {
  return {
    send: async (message, options) => {
      await queue.send(message, options);
    },
    sendBatch: async (messages) => {
      if (messages.length) await queue.sendBatch(messages);
    },
  };
}

export function pipelineContext(env: SendEnv): PipelineContext {
  const config = engineConfig(env, linksFor(env));
  // Null with Resend: every Channel sends through the account's shared reputation.
  const dedicated = dedicatedSending(env);
  const info = (message: string, fields?: Record<string, unknown>) => log.info(message, fields);
  // Batches take their turns from the install's sending limits themselves, so they get the
  // provider's own adapter; the owners' notices take theirs like any other one-off email.
  const limiter = sendLimiter(env);
  return {
    db: env.DB,
    queue: queueOf(env.SEND_QUEUE),
    mail: providerMail(env, config.platformMailDomain),
    notices: mailAdapter(env, config.platformMailDomain, info),
    ...(dedicated ? { dedicated } : {}),
    ...(env.MAIL_MAX_PER_SECOND ? { maxPerSecond: env.MAIL_MAX_PER_SECOND } : {}),
    ...(limiter ? { limiter } : {}),
    config,
    log: info,
  };
}

/** Exponential backoff for unexpected errors: 10 s, 20 s, 40 s … capped at 10 minutes. */
const backoff = (attempts: number) => Math.min(600, 10 * 2 ** Math.max(0, attempts - 1));

async function consume(batch: MessageBatch<SendMessage>, rawEnv: unknown): Promise<void> {
  const env = parseSendEnv(rawEnv);
  const ctx = pipelineContext(env);
  const touched = new Set<string>();
  for (const message of batch.messages) {
    touched.add(message.body.broadcastId);
    try {
      await handleSendMessage(ctx, message.body, { attempts: message.attempts });
      message.ack();
    } catch (error) {
      const delaySeconds =
        error instanceof RetryLater ? error.delaySeconds : backoff(message.attempts);
      log.warn('send message failed; retrying', {
        type: message.body.type,
        broadcastId: message.body.broadcastId,
        attempts: message.attempts,
        error: (error as Error).message,
      });
      message.retry({ delaySeconds });
    }
  }
  await publishProgress(env.DB, env.SEND_MONITOR, touched, ctx.log);
}

/** Tries at starting a scheduled Dispatch before it goes back to draft; about an hour in all. */
const MAX_START_ATTEMPTS = 6;

/** Takes a scheduled Dispatch back to draft and records why, for the team to see. */
async function unschedule(
  env: SendEnv,
  workspaceId: string | undefined,
  dispatchId: string,
  now: number,
  metadata: Record<string, unknown>,
) {
  await run(
    env.DB,
    `UPDATE dispatches SET status = 'draft', publish_at = NULL, best_time = 0, start_attempts = 0,
            start_retry_at = NULL, updated_at = ?1
      WHERE id = ?2 AND status = 'scheduled'`,
    now,
    dispatchId,
  );
  if (workspaceId) {
    await appendAudit(env.DB, {
      workspaceId,
      actorId: null,
      action: 'dispatch.schedule_failed',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata,
    });
  }
}

/**
 * Starts scheduled Dispatches that are due. A Dispatch that fails its checks goes back to draft.
 * Any other failure is logged and the Dispatch is tried again after 2, 4, 8, 16 and 32 minutes,
 * then goes back to draft, so one bad row or a passing outage can't keep the rest of the minute's
 * Dispatches from starting, and rows that fail every time don't hold the head of the due window.
 * Each try is counted, with its wait, before it starts and cleared when the Dispatch starts, so a
 * try that never finishes (the invocation runs out of time) counts as a failure too.
 */
export async function startDue(env: SendEnv, now = Date.now()): Promise<string[]> {
  const ctx = pipelineContext(env);
  const flags = new FlagService(new D1FlagStore(env.DB, env.CACHE));
  const started: string[] = [];
  for (const dispatch of await dueDispatches(env.DB, now)) {
    const channel = await env.DB.prepare('SELECT workspace_id FROM channels WHERE id = ?1')
      .bind(dispatch.channel_id)
      .first<{ workspace_id: string }>();
    const scope = { workspaceId: channel?.workspace_id, channelId: dispatch.channel_id };
    const attempts = (dispatch.start_attempts ?? 0) + 1;
    try {
      if (attempts > MAX_START_ATTEMPTS) {
        // The last try never finished, or its failure was not recorded: no tries are left.
        await unschedule(env, channel?.workspace_id, dispatch.id, now, {
          reason: `Swarm could not start this Dispatch after ${attempts - 1} tries.`,
          attempts: attempts - 1,
          checks: [],
        });
        continue;
      }
      // Only the invocation that counts this try goes on, so two never start the same row at once.
      const leased = await env.DB.prepare(
        `UPDATE dispatches SET start_attempts = ?1, start_retry_at = ?2
          WHERE id = ?3 AND status = 'scheduled' AND start_attempts = ?4`,
      )
        .bind(attempts, now + 60_000 * 2 ** attempts, dispatch.id, attempts - 1)
        .run();
      if (!leased.meta.changes) continue;
    } catch (error) {
      log.error('could not record a scheduled start', {
        dispatchId: dispatch.id,
        error: (error as Error).message,
      });
      continue;
    }
    try {
      const { broadcastId } = await startBroadcast(env.DB, ctx.queue, ctx.config, {
        dispatch,
        operatorId: dispatch.updated_by,
        allowHtmlBlocks: await flags.enabled('raw_html_mode', scope),
        features: {
          splitTests: await flags.enabled('split_tests', scope),
          cohortSampling: await flags.enabled('cohort_sampling', scope),
          smartBlocks: await flags.enabled('smart_blocks', scope),
          bestTime: await flags.enabled('best_time_send', scope),
        },
        bestTime: dispatch.best_time === 1,
        now,
      });
      started.push(broadcastId);
    } catch (error) {
      if (!(error instanceof StartError)) {
        log.error('scheduled dispatch failed to start', {
          dispatchId: dispatch.id,
          attempts,
          error: (error as Error).message,
        });
        // The count and the wait were recorded before the try.
        try {
          if (attempts >= MAX_START_ATTEMPTS) {
            // The error may name internals, so the team gets a plain reason; the log has the rest.
            await unschedule(env, channel?.workspace_id, dispatch.id, now, {
              reason: `Swarm could not start this Dispatch after ${attempts} tries.`,
              attempts,
              checks: [],
            });
          }
        } catch (bookkeeping) {
          log.error('could not record a failed start', {
            dispatchId: dispatch.id,
            error: (bookkeeping as Error).message,
          });
        }
        continue;
      }
      await unschedule(env, channel?.workspace_id, dispatch.id, now, {
        reason: error.message,
        checks: error.checks.map((c) => c.message),
      });
      log.warn('scheduled dispatch could not start', {
        dispatchId: dispatch.id,
        reason: error.message,
      });
    }
  }
  return started;
}

/** Re-checks unverified domains, at most every 5 minutes each, for a week after adding or moving. */
async function verifyDomains(env: SendEnv, now = Date.now()): Promise<number> {
  const hostnames = linkHostnames(env);
  const rows = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM sending_domains WHERE status <> 'verified' AND max(created_at, coalesce(provider_changed_at, 0)) > ?1 AND (kind = 'email' OR ?3 = 1)
       AND (last_checked_at IS NULL OR last_checked_at < ?2) ORDER BY last_checked_at LIMIT 10`,
    now - DOMAIN_CHECK_WINDOW_MS,
    now - 5 * 60_000,
    hostnames ? 1 : 0,
  );
  const deps = {
    identities: domainIdentities(env),
    service: env.MAIL_ADAPTER,
    // Link domains are only selected above when a hostname provider exists.
    hostnames: hostnames ?? new DevHostnames(),
    resolver: txtResolver(env),
  };
  for (const row of rows) {
    try {
      await refreshDomain(env.DB, deps, row.id, now);
    } catch (error) {
      log.warn('domain check failed', { domainId: row.id, error: (error as Error).message });
    }
  }
  return rows.length;
}

/** Runs one step of the minute cron; a failure is logged, and the steps after it still run. */
async function step<T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    log.error('cron step failed', { step: name, error: (error as Error).message });
    return fallback;
  }
}

export default {
  fetch: app.fetch,
  queue: consume,
  async scheduled(_controller: ScheduledController, rawEnv: unknown, ctx: ExecutionContext) {
    const env = parseSendEnv(rawEnv);
    ctx.waitUntil(
      (async () => {
        await step('startDue', () => startDue(env), []);
        const resumed = await step('reap', () => reap(pipelineContext(env)), []);
        // Readers whose best time has come. Nothing to do unless a send asked for it.
        const released = await step(
          'releaseBestTimeSlots',
          () => releaseBestTimeSlots(pipelineContext(env)),
          [],
        );
        await step(
          'publishProgress',
          () => publishProgress(env.DB, env.SEND_MONITOR, [...resumed, ...released]),
          undefined,
        );
        await step('verifyDomains', () => verifyDomains(env), 0);
        const dedicated = dedicatedSending(env);
        if (dedicated) {
          await step(
            'sweepDedicatedIps',
            () =>
              sweepDedicatedIps(env.DB, dedicated, Date.now(), (message, fields) =>
                log.warn(message, fields),
              ),
            undefined,
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<unknown, SendMessage>;
