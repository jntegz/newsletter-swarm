/**
 * Dedicated sending (Phase 7). Paid Channels send through their own SES configuration set, so
 * their reputation metrics and events are their own; Pro and up can add a managed dedicated IP
 * pool, attached to that configuration set.
 *
 * - The configuration set is created when an admin asks, when a dedicated IP is requested, or
 *   on the Channel's first send on a paid plan. Until then the Channel uses the shared set.
 * - A dedicated IP moves requested → warming → active: requesting creates the pool and attaches
 *   it (a failure stays `requested` and the send worker's cron retries), and the cron follows
 *   SES's managed warm-up until every IP is done.
 */
import { PLAN_LIMITS, isPaidPlan, type DedicatedIpStatus, type Plan } from '@swarm/domain';
import type { DedicatedSending } from '@swarm/mail';
import { all, first, run } from './db';

export interface ChannelSendingRow {
  id: string;
  workspace_id: string;
  plan: Plan;
  ses_configuration_set: string | null;
  dedicated_ip_pool: string | null;
  dedicated_ip_status: DedicatedIpStatus;
  dedicated_ip_warmup_percent: number | null;
  dedicated_ip_requested_at: number | null;
  dedicated_ip_checked_at: number | null;
}

const SENDING_SELECT = `SELECT c.id, c.workspace_id, w.plan, c.ses_configuration_set, c.dedicated_ip_pool,
    c.dedicated_ip_status, c.dedicated_ip_warmup_percent, c.dedicated_ip_requested_at, c.dedicated_ip_checked_at
  FROM channels c JOIN workspaces w ON w.id = c.workspace_id`;

export async function channelSending(
  db: D1Database,
  channelId: string,
): Promise<ChannelSendingRow | null> {
  return first<ChannelSendingRow>(db, `${SENDING_SELECT} WHERE c.id = ?1`, channelId);
}

/** SES names allow letters, numbers, - and _ up to 64 characters; Channel ids are ch_<32 hex>. */
export const configurationSetName = (channelId: string) => `swarm-${channelId.replace(/_/g, '-')}`;
export const dedicatedPoolName = (channelId: string) => `swarm-ip-${channelId.replace(/_/g, '-')}`;

export const configurationSetAvailable = (plan: Plan) => isPaidPlan(plan);
export const dedicatedIpAvailable = (plan: Plan) => PLAN_LIMITS[plan].dedicatedIps;

export class DedicatedPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DedicatedPlanError';
  }
}

/**
 * The Channel's own configuration set, created on first use. Throws DedicatedPlanError on the
 * free plan; provider errors propagate.
 */
export async function ensureConfigurationSet(
  db: D1Database,
  provider: DedicatedSending,
  channelId: string,
  now = Date.now(),
): Promise<string> {
  const row = await channelSending(db, channelId);
  if (!row) throw new Error(`channel ${channelId} not found`);
  if (row.ses_configuration_set) return row.ses_configuration_set;
  if (!configurationSetAvailable(row.plan)) {
    throw new DedicatedPlanError('A configuration set for one publication needs a paid plan.');
  }
  const name = configurationSetName(channelId);
  await provider.createConfigurationSet(name);
  // Guarded, so two first sends at once store it once (the name is the same either way).
  await run(
    db,
    'UPDATE channels SET ses_configuration_set = ?1, updated_at = ?2 WHERE id = ?3 AND ses_configuration_set IS NULL',
    name,
    now,
    channelId,
  );
  return name;
}

/** Creates the pool and attaches it; moves `requested` to `warming`. */
async function provisionPool(
  db: D1Database,
  provider: DedicatedSending,
  channelId: string,
  now: number,
): Promise<void> {
  const configurationSet = await ensureConfigurationSet(db, provider, channelId, now);
  const pool = dedicatedPoolName(channelId);
  await provider.createDedicatedIpPool(pool);
  await provider.attachPool(configurationSet, pool);
  await run(
    db,
    `UPDATE channels SET dedicated_ip_pool = ?1, dedicated_ip_status = 'warming', dedicated_ip_warmup_percent = 0,
            dedicated_ip_checked_at = ?2, updated_at = ?2
      WHERE id = ?3 AND dedicated_ip_status = 'requested'`,
    pool,
    now,
    channelId,
  );
}

/**
 * Asks for a dedicated IP pool. Idempotent: a Channel that already has one (in any state) is
 * returned as it is. Returns the provider error message when provisioning failed and will be
 * retried by the cron.
 */
export async function requestDedicatedIp(
  db: D1Database,
  provider: DedicatedSending,
  channelId: string,
  now = Date.now(),
): Promise<{ row: ChannelSendingRow; error: string | null }> {
  const before = await channelSending(db, channelId);
  if (!before) throw new Error(`channel ${channelId} not found`);
  if (!dedicatedIpAvailable(before.plan)) {
    throw new DedicatedPlanError('Dedicated IPs are on the Pro plan and up.');
  }
  let error: string | null = null;
  if (before.dedicated_ip_status === 'none' || before.dedicated_ip_status === 'requested') {
    await run(
      db,
      `UPDATE channels SET dedicated_ip_status = 'requested', dedicated_ip_requested_at = coalesce(dedicated_ip_requested_at, ?1),
              updated_at = ?1
        WHERE id = ?2 AND dedicated_ip_status IN ('none', 'requested')`,
      now,
      channelId,
    );
    try {
      await provisionPool(db, provider, channelId, now);
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 300) : 'provider error';
    }
  }
  return { row: (await channelSending(db, channelId)) as ChannelSendingRow, error };
}

/** Reads warm-up for one warming pool; all IPs done makes it active. */
async function checkWarmup(
  db: D1Database,
  provider: DedicatedSending,
  row: ChannelSendingRow,
  now: number,
): Promise<void> {
  if (!row.dedicated_ip_pool) return;
  const warmup = await provider.poolWarmup(row.dedicated_ip_pool);
  await run(
    db,
    `UPDATE channels SET dedicated_ip_warmup_percent = ?1, dedicated_ip_checked_at = ?2, updated_at = ?2,
            dedicated_ip_status = CASE WHEN ?3 THEN 'active' ELSE dedicated_ip_status END
      WHERE id = ?4 AND dedicated_ip_status = 'warming'`,
    warmup.percent,
    now,
    warmup.state === 'done' ? 1 : 0,
    row.id,
  );
}

/** One Channel's pool, now (the dashboard's "Check now"). */
export async function refreshDedicatedIp(
  db: D1Database,
  provider: DedicatedSending,
  channelId: string,
  now = Date.now(),
): Promise<ChannelSendingRow | null> {
  const row = await channelSending(db, channelId);
  if (!row) return null;
  if (row.dedicated_ip_status === 'requested') await provisionPool(db, provider, channelId, now);
  else if (row.dedicated_ip_status === 'warming') await checkWarmup(db, provider, row, now);
  return channelSending(db, channelId);
}

/** Pools checked per cron run; warm-up takes weeks, so a slow sweep is fine. */
const SWEEP_LIMIT = 25;
/** A warming pool is read at most this often. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * The send worker's cron: provisions requested pools and follows warm-up. Errors are reported
 * per Channel and never stop the sweep.
 */
export async function sweepDedicatedIps(
  db: D1Database,
  provider: DedicatedSending,
  now = Date.now(),
  log: (message: string, fields: Record<string, unknown>) => void = () => {},
): Promise<number> {
  const rows = await all<ChannelSendingRow>(
    db,
    `${SENDING_SELECT}
      WHERE c.dedicated_ip_status IN ('requested', 'warming')
        AND (c.dedicated_ip_checked_at IS NULL OR c.dedicated_ip_checked_at < ?1 OR c.dedicated_ip_status = 'requested')
      ORDER BY c.dedicated_ip_checked_at LIMIT ${SWEEP_LIMIT}`,
    now - CHECK_EVERY_MS,
  );
  let handled = 0;
  for (const row of rows) {
    try {
      if (row.dedicated_ip_status === 'requested') await provisionPool(db, provider, row.id, now);
      else await checkWarmup(db, provider, row, now);
      handled++;
    } catch (error) {
      log('dedicated IP check failed', { channelId: row.id, error: (error as Error).message });
    }
  }
  return handled;
}

const configurationSets = new Map<string, string>();
const failedUntil = new Map<string, number>();
/** After a failed create, the shared set is used for this long before trying again. */
const RETRY_CREATE_MS = 10 * 60 * 1000;

/**
 * The configuration set a Channel's Broadcasts go through: its own on a paid plan (created on
 * the first send), undefined for the shared one. Never throws: a provider error falls back to
 * the shared set, so a send is never blocked by it.
 */
export async function sendingConfigurationSet(
  db: D1Database,
  provider: DedicatedSending | undefined,
  channelId: string,
  now = Date.now(),
  log: (message: string, fields: Record<string, unknown>) => void = () => {},
): Promise<string | undefined> {
  const cached = configurationSets.get(channelId);
  if (cached) return cached;
  const row = await channelSending(db, channelId);
  if (!row) return undefined;
  if (row.ses_configuration_set) {
    if (configurationSets.size > 1000) configurationSets.clear();
    configurationSets.set(channelId, row.ses_configuration_set);
    return row.ses_configuration_set;
  }
  if (!provider || !configurationSetAvailable(row.plan)) return undefined;
  if ((failedUntil.get(channelId) ?? 0) > now) return undefined;
  try {
    const name = await ensureConfigurationSet(db, provider, channelId, now);
    configurationSets.set(channelId, name);
    return name;
  } catch (error) {
    if (failedUntil.size > 1000) failedUntil.clear();
    failedUntil.set(channelId, now + RETRY_CREATE_MS);
    log('configuration set not created; using the shared one', {
      channelId,
      error: (error as Error).message,
    });
    return undefined;
  }
}
