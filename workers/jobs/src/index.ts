// Background jobs: imports, exports, bulk actions and Circle evaluation (Phase 3); Flows
// (Phase 6); Privacy Center requests, export destinations and Event Webhooks (Phase 7); the SES
// suppression-list sync, Reputation Ramp pause notices, bounce-rule holds and scheduled website
// designs. Three
// queue consumers (jobs, webhooks, and public for what capture and events may queue) plus crons for scheduled work: every minute for Flows and the
// webhook fan-out (MINUTE_CRON), every five minutes, and once a day for housekeeping
// (DAILY_CRON). The cron strings must match wrangler.jsonc.
import { retryWhileBusy } from '@swarm/db';
import {
  checkUnengaged,
  decideHoldBacks,
  enqueueChannelCircleRefresh,
  jobQueue,
  linksFor,
  localMemberLinks,
  queueRole,
  readQueueMessage,
  enrollFromEvents,
  mailAdapter,
  promoteWelcomeSplits,
  pruneAgentLog,
  pruneSiteEdge,
  refreshPendingHostnames,
  runEngagementRollup,
  runFunnelRollup,
  reconcilePayPal,
  runPaymentsLifecycle,
  runStep,
  sendBounceHoldNotices,
  sendRampPauseNotices,
  stripeForAllAccounts,
  suppressionList,
  sweepFlows,
  syncProviderSuppressions,
  webHostnames,
  type AudienceDeps,
  type FlowsEnv,
  type JobMessage,
  type PaymentsMail,
  type WebhookMessage,
  sunsetInactiveMembers,
  pruneMemberSendHours,
  anonymiseExpiredEngagement,
  pruneOperatorRecords,
  expirePaymentReferences,
  purgeDeletedChannels,
  purgeDeletedChannelFiles,
  reduceDepartedMembers,
} from '@swarm/engine';
import { createLogger, useRuntime, type RuntimeVariables } from '@swarm/runtime';
import { Hono } from 'hono';
import { DAILY_CRON, MINUTE_CRON } from './crons';
import { mountDev } from './dev';
import { parseJobsEnv, type JobsEnv } from './env';
import { runBulk } from './handlers/bulk';
import {
  advanceEmailCheck,
  checkAddedAddresses,
  planEmailCheck,
  runEmailChecksMinute,
} from './handlers/email-checks';
import { runChampions } from './handlers/champions';
import { refreshCircle, refreshDueCircles } from './handlers/circles';
import { runExport } from './handlers/exports';
import { pruneFeeds, runFeedsMinute } from './handlers/feeds';
import { analyzeImport, runImport } from './handlers/imports';
import { maintainMembers } from './handlers/maintenance';
import { maintainPlatform, verifyAuditChains } from './handlers/platform';
import { runExportDestinations, runPrivacy } from './handlers/privacy';
import { runSponsorLinkReissue } from './handlers/sponsor-links';
import { publishDueSiteDesigns } from './handlers/siteDesign';
import { recheckSsoDomainProofs } from './handlers/sso';
import { consumeWebhooks, pruneWebhookData, runWebhooksMinute } from './handlers/webhooks';
import { flowsVault, ownStripeKeyFetch, payPalVault, recordVaultHeartbeat } from './vault';

export const app = new Hono<{ Variables: RuntimeVariables }>();
useRuntime(app, { service: 'jobs', parseEnv: parseJobsEnv });

const log = createLogger({ service: 'jobs' });

/** The Flows engine's view of the env: queues, the vault and the mail for operator notices. */
export function flowsEnv(env: JobsEnv): FlowsEnv {
  return {
    DB: env.DB,
    JOBS_QUEUE: env.JOBS_QUEUE,
    SEND_QUEUE: env.SEND_QUEUE,
    vault: flowsVault(env),
    notices: {
      mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      from: `notifications@${env.PLATFORM_MAIL_DOMAIN}`,
    },
  };
}

/** Member-facing payment mail from the cron (Gift Pass reminders). */
export function paymentsMail(env: JobsEnv): PaymentsMail {
  return {
    adapter: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
    platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
    site: { scheme: env.SITE_SCHEME, platformDomain: env.PLATFORM_SITE_DOMAIN },
    captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
  };
}

/** Mail to Members from the cron that needs their subscriber-settings link (inactive readers). */
export function audienceDeps(env: JobsEnv, now: number): AudienceDeps {
  return {
    db: env.DB,
    mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
    links: linksFor(env),
    memberLinks: localMemberLinks(linksFor(env)),
    captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
    platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
    now: () => now,
  };
}

// Development and test only: the end-to-end tests' Flow clock (see dev.ts).
mountDev(app, flowsEnv);

export async function handleJob(env: JobsEnv, message: JobMessage): Promise<void> {
  switch (message.type) {
    case 'import_analyze':
      return analyzeImport(env, message.jobId);
    case 'import_run':
      return runImport(env, message.jobId);
    case 'export':
      return runExport(env, message.jobId);
    case 'bulk':
      return runBulk(env, message.jobId);
    case 'circle_refresh':
      // Waiting out a busy database here takes milliseconds; the queue's backoff takes 10 s and up.
      // A refresh can run again: it is guarded on the generation, and its diff is one transaction.
      return retryWhileBusy(() => refreshCircle(env, message.circleId, message.generation));
    case 'channel_changed':
      // From the public queue: marks the Channel's Circles pending and queues their refreshes on
      // the jobs queue. Circles already waiting for one are skipped, so a burst costs one each.
      await retryWhileBusy(() =>
        enqueueChannelCircleRefresh(env.DB, jobQueue(env.JOBS_QUEUE), message.channelId),
      );
      return;
    case 'flow_events':
      await enrollFromEvents(flowsEnv(env), Date.now());
      return;
    case 'flow_step':
      return runStep(flowsEnv(env), message);
    case 'email_check_plan':
      return planEmailCheck(env, message.runId);
    case 'email_check_run':
      return advanceEmailCheck(env, message.runId);
    case 'email_check':
      return checkAddedAddresses(env, message);
    default:
      // Unreachable: consume reads every body against its queue first.
      throw new Error(`Unknown job type ${String((message as { type?: unknown }).type)}.`);
  }
}

/** Exponential backoff: 10 s, 20 s, 40 s … capped at 10 minutes. */
const backoff = (attempts: number) => Math.min(600, 10 * 2 ** Math.max(0, attempts - 1));

/**
 * Batches are routed by the queue they came from, never by their bodies, and every body is read
 * against what that queue carries (readQueueMessage): the public queue only what capture and
 * events may queue, the webhooks queue only deliveries, the jobs queue only jobs. A refused body
 * is logged (`message refused`) and acked, never run and never retried toward the dead-letter
 * queue. A batch from a queue this worker does not know is retried, so nothing is lost while a
 * configuration is wrong.
 */
export async function consume(batch: MessageBatch<unknown>, rawEnv: unknown): Promise<void> {
  const env = parseJobsEnv(rawEnv);
  const role = queueRole(batch.queue);
  if (!role) {
    log.error('batch from an unknown queue; retrying', {
      queue: batch.queue,
      messages: batch.messages.length,
    });
    for (const message of batch.messages) message.retry({ delaySeconds: 60 });
    return;
  }
  const jobs: { message: Message<unknown>; job: JobMessage }[] = [];
  const deliveries: Message<WebhookMessage>[] = [];
  for (const message of batch.messages) {
    const read = readQueueMessage(role, message.body);
    if (!read.ok) {
      log.warn('message refused', { queue: batch.queue, type: read.type, reason: read.reason });
      message.ack();
    } else if (read.message.type === 'webhook_delivery') {
      deliveries.push(message as Message<WebhookMessage>);
    } else {
      jobs.push({ message, job: read.message });
    }
  }
  if (deliveries.length) await consumeWebhooks(env, deliveries);
  for (const { message, job } of jobs) {
    try {
      await handleJob(env, job);
      message.ack();
    } catch (error) {
      log.warn('job failed; retrying', {
        type: job.type,
        attempts: message.attempts,
        error: (error as Error).message,
      });
      message.retry({ delaySeconds: backoff(message.attempts) });
    }
  }
}

/**
 * Failures of a cron's steps: each is logged as an error when it happens, and `done`, called
 * once every step has run, throws them together so the invocation is still marked failed.
 */
function cronSteps() {
  const failures: { step: string; error: unknown }[] = [];
  return {
    failed: (step: string) => (error: unknown) => {
      log.error(`${step} failed`, {
        error: (error as Error)?.message ?? String(error),
        stack: (error as Error)?.stack,
      });
      failures.push({ step, error });
    },
    done: () => {
      if (!failures.length) return;
      throw new AggregateError(
        failures.map((f) => f.error),
        `Cron steps failed: ${failures.map((f) => f.step).join(', ')}.`,
      );
    },
  };
}

/** The work for one cron firing. */
export async function runScheduled(env: JobsEnv, cron: string, now: number): Promise<void> {
  // Each step catches its own errors, so one that keeps failing doesn't hold up the rest.
  const steps = cronSteps();
  if (cron === MINUTE_CRON) {
    // The vault heartbeat the installer reads before it prunes keys (jobs has no public host).
    await recordVaultHeartbeat(env, now).then((ok) => {
      if (!ok) log.error('the vault does not answer through the VAULT binding');
    }, steps.failed('vault heartbeat'));
    // Flows (Phase 6): due waiting runs (long delays, wait timeouts, lost messages) and events.
    await sweepFlows(flowsEnv(env), now).catch(steps.failed('flow sweep'));
    // Funnel Explorer (Phase 6): member events, first opens and form views into funnel_daily.
    await runFunnelRollup(env.DB, now).catch(steps.failed('funnel rollup'));
    // Engagement scores (Phase 8): today's pass over each Channel, a few batches at a time.
    await runEngagementRollup(env.DB, now).catch(steps.failed('engagement rollup'));
    // Champions (Phase 6): count pending referrals, hold clusters, award milestones.
    await runChampions(env, now).catch(steps.failed('champions pass'));
    // Split Tests and Cohort Samples (Phase 6): decide winners and health, release held recipients.
    await decideHoldBacks(env, now).catch(steps.failed('hold-back decisions'));
    // Privacy Center (Phase 7): data exports and erasures that are ready to run.
    await runPrivacy(env, now).catch(steps.failed('privacy requests'));
    // After the link cutover: sponsors whose 365-day report link now ends early get a new one.
    await runSponsorLinkReissue(env, now).catch(steps.failed('sponsor report links'));
    // Event Webhooks (Phase 7): fan new events out to endpoints, re-queue overdue deliveries.
    await runWebhooksMinute(env, now).catch(steps.failed('webhook fan-out'));
    // Feed Sync (Phase 8): due feeds, then waiting items within their caps and quiet windows.
    await runFeedsMinute(env, now).catch(steps.failed('feed sync'));
    // Suppressions: queued hard bounces (and their removals) for the SES account-level
    // suppression list. Resend has no such list here, so this only clears the queue.
    await syncProviderSuppressions(env.DB, suppressionList(env), now).then((result) => {
      if (result.failed) log.warn('SES suppression sync gave up on some addresses', result);
    }, steps.failed('SES suppression sync'));
    // Email checks: parts waiting at DeBounce, their files past a day, lost planning messages.
    await runEmailChecksMinute(env, now).catch(steps.failed('email checks'));
    // Reputation Ramp: one notice to the owners and admins for each anomaly pause.
    await sendRampPauseNotices({
      DB: env.DB,
      mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      from: `notifications@${env.PLATFORM_MAIL_DOMAIN}`,
      platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
      appOrigin: env.APP_ORIGIN,
    }).catch(steps.failed('ramp pause notices'));
    // Bounce rules: one notice to the owners and admins for each subscriber on a paid plan held
    // for them instead of being stopped.
    await sendBounceHoldNotices({
      DB: env.DB,
      mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      from: `notifications@${env.PLATFORM_MAIL_DOMAIN}`,
      appOrigin: env.APP_ORIGIN,
    }).catch(steps.failed('bounce hold notices'));
    steps.done();
    return;
  }
  if (cron === DAILY_CRON) {
    const failed = steps.failed;
    // Site edge (Phase 4): visitor hashes past their day, spent reader tokens, expired sessions.
    await pruneSiteEdge(env.DB, now).then(
      (pruned) => log.info('site edge pruned', pruned),
      failed('site edge pruning'),
    );
    // Flows (Phase 6): the unengaged trigger and member event pruning.
    await checkUnengaged(flowsEnv(env), now).catch(failed('unengaged check'));
    // Welcome A/B (Phase 6): promote auto-promote split winners on live Flows.
    await promoteWelcomeSplits(env.DB, now).then(
      (promoted) => log.info('flow splits promoted', { count: promoted.length }),
      failed('flow split promotion'),
    );
    // Public API (Phase 7): old Idempotency-Keys, audit log retention per plan.
    await maintainPlatform(env, now).catch(failed('platform housekeeping'));
    // Event Webhooks (Phase 7): finished deliveries and outbox rows past 30 days.
    await pruneWebhookData(env, now).catch(failed('webhook pruning'));
    // Open Operator (Phase 8): agent log retention and expired approvals' stored requests.
    await pruneAgentLog(env.DB, now).then(
      (result) => log.info('agent log pruned', result),
      failed('agent log pruning'),
    );
    // Feed Sync (Phase 8): items past the newest 500 per feed, content of used ones.
    await pruneFeeds(env, now).catch(failed('feed pruning'));
    // Ended sessions, spent sign-in codes and unaccepted invitations (lifetimes.ts).
    await pruneOperatorRecords(env.DB, now).then(
      (pruned) => log.info('operator records pruned', pruned),
      failed('operator record pruning'),
    );
    steps.done();
    return;
  }
  const hostnames = webHostnames(env);
  await Promise.all([
    // Membership levels: grace expiry, ended comp and gift grants, Gift Pass reminders, unclaimed
    // Gift Passes and scheduled price changes.
    stripeForAllAccounts({ ...env, ownKeyFetch: ownStripeKeyFetch(env) })
      .then((stripe) => runPaymentsLifecycle(env.DB, stripe, now, paymentsMail(env)))
      .then((result) => log.info('payments lifecycle', { ...result })),
    // PayPal: subscription state compared with PayPal's own, a bounded few reads per Channel, so a
    // missed or unfinished webhook grants or ends access late rather than never.
    reconcilePayPal(env.DB, payPalVault(env), now)
      .then((result) => {
        if (result.unfinished) log.warn('paypal events left unfinished', { ...result });
        else if (result.applied) log.info('paypal reconciled', { ...result });
      })
      .catch((error: Error) => log.warn('paypal reconciliation failed', { error: error.message })),
    maintainMembers(env, now),
    pruneMemberSendHours(env.DB, now),
    // Engagement retention: deliveries, opens, clicks and per-send copies past the workspace's
    // limit stop naming the person; counts stay. Bounded batches, so a backlog spreads over runs.
    anonymiseExpiredEngagement(env.DB, now).then(
      (result) => {
        if (result.deliveries || result.copiesDeleted || result.copiesCleared) {
          log.info('engagement history anonymised', { ...result });
        }
      },
      (error: Error) => log.warn('engagement retention failed', { error: error.message }),
    ),
    // Record lifetimes (lifetimes.ts): departed subscribers' profiles past the workspace's period,
    // and deleted publications past their restore window, a bounded batch per run.
    reduceDepartedMembers(env.DB, now).then(
      (reduced) => {
        if (reduced) log.info('departed subscribers reduced', { reduced });
      },
      (error: Error) => log.warn('departed subscriber reduction failed', { error: error.message }),
    ),
    purgeDeletedChannels(env.DB, now).then(
      (purged) => {
        if (purged.members || purged.channels) log.info('deleted publications purged', purged);
      },
      (error: Error) => log.warn('deleted publication purge failed', { error: error.message }),
    ),
    // Then its stored files (media, imports, exports), a bounded batch per bucket and run.
    purgeDeletedChannelFiles(
      env.DB,
      { media: env.MEDIA, imports: env.IMPORTS, exports: env.EXPORTS },
      now,
    ).then(
      (purged) => {
        if (purged.objects || purged.channels) log.info('deleted publication files purged', purged);
      },
      (error: Error) => log.warn('deleted publication file purge failed', { error: error.message }),
    ),
    // Payment references an erasure kept for the books, past the workspace's record period.
    expirePaymentReferences(env.DB, now).then(
      (expired) => {
        if (expired.payments || expired.checkouts) log.info('payment references expired', expired);
      },
      (error: Error) => log.warn('payment reference expiry failed', { error: error.message }),
    ),
    // Inactive readers: a notice first, then the unsubscribe after the grace period.
    sunsetInactiveMembers(audienceDeps(env, now), now).then((result) =>
      log.info('inactive readers', { ...result }),
    ),
    refreshDueCircles(env, now),
    // Pending web hostnames, a bounded batch per run.
    hostnames ? refreshPendingHostnames(env.DB, hostnames, now) : null,
    // Incremental exports to operators' buckets, and expired Privacy Center export files (Phase 7).
    runExportDestinations(env, now),
    // Audit chains: every workspace verified once a day, a bounded batch per run.
    verifyAuditChains(env, now),
    // SSO domain proof: every verified domain looked up again once a day, a bounded batch per run.
    recheckSsoDomainProofs(env, now).catch((error: Error) =>
      log.warn('sso domain re-check failed', { error: error.message }),
    ),
    // Website designs scheduled to publish by now (docs/site-themes.md).
    publishDueSiteDesigns(env, now).then(
      (result) => log.info('scheduled site designs', result),
      (error: Error) => log.warn('scheduled site designs failed', { error: error.message }),
    ),
  ]);
}

export default {
  fetch: app.fetch,
  queue: consume,
  async scheduled(controller: ScheduledController, rawEnv: unknown, ctx: ExecutionContext) {
    // A failed minute run still shows as failed, but is not retried: a retry would run every
    // step again, the ones that succeeded included, and the next firing comes soon anyway. The
    // other crons fire again only minutes or a day later, so they keep the platform's retry.
    if (controller.cron === MINUTE_CRON) controller.noRetry();
    const env = parseJobsEnv(rawEnv);
    ctx.waitUntil(runScheduled(env, controller.cron, Date.now()));
  },
} satisfies ExportedHandler<unknown, unknown>;
