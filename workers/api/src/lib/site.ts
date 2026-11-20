/** Helpers shared by the Site Studio routes: flags, plan limits, the site origin and audit. */
import { first, type ChannelAccess } from '@swarm/db';
import { D1FlagStore, FlagService, type FlagKey } from '@swarm/flags';
import { channelSiteOrigin, type SiteOriginConfig } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { appendAudit } from './audit';
import { clientIp, env, type AppContext } from './context';
import { ipPrefix } from './crypto';
import { engine } from './send';

export async function flagEnabled(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  key: FlagKey,
): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled(key, {
    workspaceId: access.workspaceId,
    channelId: access.channelId,
  });
}

/** Refuses with feature_disabled (404) when the flag is off for this Channel. */
export async function requireFlag(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  key: FlagKey,
  message: string,
): Promise<void> {
  if (!(await flagEnabled(c, access, key))) throw new ApiError('feature_disabled', message);
}

/** The workspace plan of a Channel ('free', 'pro', 'scale' or 'enterprise'). */
export async function planOf(db: D1Database, channelId: string): Promise<string> {
  const row = await first<{ plan: string }>(
    db,
    'SELECT w.plan FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?1',
    channelId,
  );
  return row?.plan ?? 'free';
}

/** A plan limit, or null when the plan has none. */
export const limitFor = (limits: Record<string, number>, plan: string): number | null =>
  limits[plan] ?? null;

/** The env schema requires the site settings, so the API always has them. */
export function siteConfig(c: AppContext): SiteOriginConfig {
  const site = engine(c).site;
  if (!site) throw new Error('site origin settings are missing');
  return site;
}

export const siteOrigin = (c: AppContext, channelId: string) =>
  channelSiteOrigin(env(c).DB, siteConfig(c), channelId);

export const audit = (
  c: AppContext,
  access: { workspaceId: string; auth: { operatorId: string } },
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType,
    targetId,
    ...(metadata ? { metadata } : {}),
    ipPrefix: ipPrefix(clientIp(c)),
  });
