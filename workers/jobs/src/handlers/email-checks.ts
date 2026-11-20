// Email checks (docs/email-verification.md): planning and moving runs along, and checking
// addresses someone just added. The work itself is in @swarm/engine email-checks.ts; this file
// gives it the jobs worker's bindings. The parts' files live in IMPORTS (private) and are served
// to DeBounce by the api worker at APP_ORIGIN.
import { first } from '@swarm/db';
import {
  advanceRun,
  debounceFor,
  dropExpiredFiles,
  dueRuns,
  emailCheckFile,
  jobQueue,
  loadRun,
  memberCandidates,
  planRun,
  runBackgroundChecks,
  type RunDeps,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';
import { importCheckCandidates } from './imports';

const log = createLogger({ service: 'jobs' });

export function emailCheckDeps(env: JobsEnv): RunDeps {
  // The fake DeBounce (key "dev", development and tests) reads the lists the way DeBounce would.
  const readList = async (url: string) => {
    const token = /\/([A-Za-z0-9_-]{43})\.csv$/.exec(url)?.[1];
    return token ? emailCheckFile(env.DB, env.IMPORTS, token) : null;
  };
  return {
    db: env.DB,
    debounce: debounceFor(env, { readList }),
    queue: jobQueue(env.JOBS_QUEUE),
    files: env.IMPORTS,
    fileOrigin: env.APP_ORIGIN,
  };
}

export async function planEmailCheck(env: JobsEnv, runId: string, now = Date.now()) {
  const row = await loadRun(env.DB, runId);
  if (!row) return;
  const source = row.scope === 'import' ? importCheckCandidates(env) : memberCandidates(env.DB);
  await planRun(emailCheckDeps(env), runId, source, now);
}

export async function advanceEmailCheck(env: JobsEnv, runId: string, now = Date.now()) {
  await advanceRun(emailCheckDeps(env), runId, now);
}

/**
 * An `email_check` message names its workspace, Channel and Members, so nothing in it is taken on
 * trust: the Channel must be a live Channel of that workspace, or the message is refused and
 * counted in the log (`email_check refused`), with no provider call and no write. Only that
 * Channel's own Members are then checked. "Check again" is forced, which skips the workspace's
 * settings and a result that still counts, so it is only ever read from a stored request
 * (email_check_requests, 0112) the api wrote for a signed-in editor; the message names its id.
 */
export async function checkAddedAddresses(
  env: JobsEnv,
  message: {
    workspaceId: string;
    channelId: string;
    memberIds?: string[];
    requestId?: string;
    confirmed?: true;
  },
) {
  let input: {
    workspaceId: string;
    channelId: string;
    memberIds: string[];
    force: boolean;
    confirmed: boolean;
  };
  if (message.requestId) {
    // "Check again": the stored request says who, where and that it is forced; used once.
    const request = await first<{ workspace_id: string; channel_id: string; member_id: string }>(
      env.DB,
      `DELETE FROM email_check_requests WHERE id = ?1
       RETURNING workspace_id, channel_id, member_id`,
      message.requestId,
    );
    if (!request) {
      log.warn('email_check refused', { reason: 'no_stored_request', ...ids(message) });
      return;
    }
    input = {
      workspaceId: request.workspace_id,
      channelId: request.channel_id,
      memberIds: [request.member_id],
      force: true,
      confirmed: false,
    };
  } else {
    input = {
      workspaceId: message.workspaceId,
      channelId: message.channelId,
      memberIds: message.memberIds ?? [],
      force: false,
      // Signup rules apply only to Members who really confirmed; the engine checks confirmed_at.
      confirmed: message.confirmed === true,
    };
  }
  const channel = await first<{ workspace_id: string }>(
    env.DB,
    'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    input.channelId,
  );
  if (!channel || channel.workspace_id !== input.workspaceId) {
    log.warn('email_check refused', { reason: 'channel_not_in_workspace', ...ids(input) });
    return;
  }
  const deps = emailCheckDeps(env);
  // The engine checks only Members of this Channel, found by id, so addresses of anyone else are
  // never sent to the vendor.
  const result = await runBackgroundChecks({ db: env.DB, env, debounce: deps.debounce }, input);
  if (result.failed) log.info('some added addresses were not checked', { ...result });
}

const ids = (message: { workspaceId: string; channelId: string }) => ({
  workspaceId: message.workspaceId,
  channelId: message.channelId,
});

/** The minute cron: parts waiting at DeBounce, plans whose message got lost. */
export async function runEmailChecksMinute(env: JobsEnv, now: number): Promise<void> {
  await dropExpiredFiles(env.DB, env.IMPORTS, now);
  // "Check again" requests whose message never arrived.
  await env.DB.prepare('DELETE FROM email_check_requests WHERE created_at < ?1')
    .bind(now - 86_400_000)
    .run();
  for (const row of await dueRuns(env.DB, now)) {
    try {
      if (row.status === 'planning') await planEmailCheck(env, row.id, now);
      else await advanceEmailCheck(env, row.id, now);
    } catch (error) {
      log.warn('email check run failed a step', { runId: row.id, error: (error as Error).message });
    }
  }
}
