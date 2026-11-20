// Privacy Center and incremental exports (Phase 7, part 5).
//
// Every minute: data requests that are `processing` (Member Center requests and approved ones)
// run through @swarm/engine privacy.ts; Channels that lost Members get a Circle refresh; people
// whose request was rejected or failed are told, and admins are reminded of failed ones (erasure
// markers of older forms are rewritten by the vault's cron, which holds the key). Every
// five minutes: due export destinations write to their buckets (export-sync.ts), and Privacy
// Center export files past their link's expiry are deleted. A destination that fails
// EXPORT_DESTINATION_NOTIFY_AFTER runs in a row emails the workspace's owners and admins once.
import { EXPORT_DESTINATION_NOTIFY_AFTER } from '@swarm/domain';
import { all } from '@swarm/db';
import {
  enqueueChannelCircleRefresh,
  jobQueue,
  linksFor,
  mailAdapter,
  purgeExpiredExports,
  runDueExportDestinations,
  runPrivacyRequests,
  sendRequestOutcomeNotices,
  pruneAddressConfirmations,
  type Fetcher,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';
import { exportVault, privacyVault } from '../vault';

const log = createLogger({ service: 'jobs' });

/** fetch, wrapped: calling the bare global as a method throws "Illegal invocation" in workerd. */
const fetcher: Fetcher = (input, init) => fetch(input, init);

export async function runPrivacy(env: JobsEnv, now: number): Promise<void> {
  const mail = mailAdapter(env, env.PLATFORM_MAIL_DOMAIN);
  const deps = {
    db: env.DB,
    mail,
    links: linksFor(env),
    fieldKeys: privacyVault(env),
    captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
    platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
    exports: env.EXPORTS,
    now: () => now,
  };
  const result = await runPrivacyRequests(deps, now);
  const outcomes = await sendRequestOutcomeNotices(
    {
      ...deps,
      notices: { mail, from: `notifications@${env.PLATFORM_MAIL_DOMAIN}` },
      appOrigin: env.APP_ORIGIN,
    },
    now,
  );
  if (outcomes.people || outcomes.admins) log.info('privacy request outcomes', outcomes);
  // Request-page confirmations a day after they were used or expired (they hold a sealed address).
  const confirmations = await pruneAddressConfirmations(env.DB, now);
  if (confirmations) log.info('request page confirmations pruned', { rows: confirmations });
  for (const channelId of result.channelIds) {
    await enqueueChannelCircleRefresh(env.DB, jobQueue(env.JOBS_QUEUE), channelId, { now });
  }
  if (result.completed.length || result.failed.length) {
    log.info('privacy requests', { completed: result.completed.length, failed: result.failed });
  }
}

export async function runExportDestinations(
  env: JobsEnv,
  now: number,
  fetch: Fetcher = fetcher,
): Promise<void> {
  const purged = await purgeExpiredExports(env.DB, env.EXPORTS, now);
  if (purged) log.info('privacy exports purged', { count: purged });
  const outcomes = await runDueExportDestinations(
    { db: env.DB, vault: exportVault(env), fetch },
    now,
  );
  const mail = mailAdapter(env, env.PLATFORM_MAIL_DOMAIN);
  for (const outcome of outcomes) {
    if (outcome.ok) continue;
    log.warn('export destination failed', { id: outcome.id, error: outcome.error });
    if (outcome.failureCount !== EXPORT_DESTINATION_NOTIFY_AFTER) continue;
    const admins = await all<{ email: string }>(
      env.DB,
      `SELECT o.email FROM seats s JOIN operators o ON o.id = s.operator_id
        WHERE s.workspace_id = ?1 AND s.role IN ('owner', 'admin')`,
      outcome.workspaceId,
    );
    for (const admin of admins) {
      await mail.send({
        category: 'export_destination_failing',
        from: { name: 'Swarm', address: `notifications@${env.PLATFORM_MAIL_DOMAIN}` },
        to: admin.email,
        subject: 'An export destination keeps failing',
        text: `Swarm could not write to one of your export destinations ${EXPORT_DESTINATION_NOTIFY_AFTER} times in a row. It keeps retrying on its schedule.\n\nLast error: ${outcome.error}\n\nCheck the bucket and keys in the publication's export destinations, and use "Test connection".\n`,
        html: `<p>Swarm could not write to one of your export destinations ${EXPORT_DESTINATION_NOTIFY_AFTER} times in a row. It keeps retrying on its schedule.</p><p>Last error: ${escape(outcome.error ?? '')}</p><p>Check the bucket and keys in the publication’s export destinations, and use “Test connection”.</p>`,
        tags: { workspace: outcome.workspaceId },
      });
    }
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
