import {
  linksFor,
  mailAdapter,
  queueChannelChanged,
  type MemberLinkMinter,
  type SubscribeDeps,
} from '@swarm/engine';
import { D1FlagStore, FlagService, type FlagKey } from '@swarm/flags';
import { createLogger, type RuntimeVariables } from '@swarm/runtime';
import type { Context } from 'hono';
import { originOf, parseCaptureEnv, type CaptureEnv } from './env';
import { captureMarkers, noMemberLinks } from './vault';

export interface AppEnv {
  Variables: RuntimeVariables & {
    /** Response headers to set (or, with null, remove) after the shared security headers. */
    headerOverrides?: Record<string, string | null>;
  };
}

export type AppContext = Context<AppEnv>;

export const env = (c: AppContext): CaptureEnv => parseCaptureEnv(c.env);

export const clientIp = (c: AppContext): string => c.req.header('cf-connecting-ip') ?? 'unknown';

const log = createLogger({ service: 'capture' });

/** Runs work after the response, logging instead of failing the request. */
export function later(c: AppContext, work: Promise<unknown>): void {
  const guarded = work.catch((error: Error) =>
    log.error('background work failed', { error: error.message }),
  );
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (unit tests): the promise still runs.
  }
}

/** Queues a re-evaluation of the Channel's Circles after the response: member data changed. */
export function refreshCircles(c: AppContext, channelId: string): void {
  const e = env(c);
  later(c, queueChannelChanged(e.PUBLIC_QUEUE, channelId));
}

/** The same, for a change known by its Member. */
export function refreshCirclesOf(c: AppContext, memberId: string): void {
  const e = env(c);
  later(
    c,
    e.DB.prepare('SELECT channel_id FROM members WHERE id = ?1')
      .bind(memberId)
      .first<string>('channel_id')
      .then((channelId) =>
        channelId ? queueChannelChanged(e.PUBLIC_QUEUE, channelId) : undefined,
      ),
  );
}

/**
 * What audience mail and sign-ups need. Member Center links are minted by the vault from the
 * evidence the route holds (`memberLinks`: vault.ts evidenceLinks); without any, none is made.
 * Erasure markers come from the vault too.
 */
export function audienceDeps(
  e: CaptureEnv,
  memberLinks: MemberLinkMinter = noMemberLinks,
): SubscribeDeps {
  return {
    db: e.DB,
    mail: mailAdapter(e, e.PLATFORM_MAIL_DOMAIN),
    links: linksFor(e),
    memberLinks,
    fieldKeys: captureMarkers(e),
    captureOrigin: originOf(e),
    platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
  };
}

/** Whether a flag is on for a Channel (channel overrides beat workspace, then platform). */
export function channelFlag(
  e: CaptureEnv,
  scope: { workspaceId: string; channelId: string },
  key: FlagKey,
): Promise<boolean> {
  return new FlagService(new D1FlagStore(e.DB)).enabled(key, scope);
}
