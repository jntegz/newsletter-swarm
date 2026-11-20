import { parseKeyring, type Keyring } from '@swarm/tokens';
import { z } from 'zod';
import { localMemberLinks } from './confirm';
import type { LinkKeys, LinkSigner, MemberLinkMinter } from './links';

const keyring = z.string().transform((value, ctx): Keyring => {
  try {
    return parseKeyring(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/**
 * Env fields shared by every worker that touches the send engine (api, send, track, events).
 * Workers merge this into their own schema with `.extend(EngineEnvFields)`.
 */
export const EngineEnvFields = {
  /** Default branded-link origin (the track worker), used until a Channel verifies a link domain. */
  TRACK_ORIGIN: z.url(),
  /** Shared From domain for Channels without a verified sending domain, e.g. mail.swarm.example. */
  PLATFORM_MAIL_DOMAIN: z.string().min(3),
  /** Domain whose Email Routing worker receives unsub+<code>@ mail. */
  UNSUBSCRIBE_MAIL_DOMAIN: z.string().min(3),
  /** Signs click and open tokens (send) and verifies them (track). Format kid:secret[,kid:secret]. */
  TRACK_KEYS: keyring,
  /** Signs unsubscribe codes. A separate key, so a leaked tracking key can't unsubscribe anyone. */
  UNSUBSCRIBE_KEYS: keyring,
  /**
   * Signs bounce codes (send) and verifies them (events), since the link cutover. Its own key, so
   * the workers that hold UNSUBSCRIBE_KEYS (track, the api) can't report a workspace-wide bounce.
   */
  BOUNCE_KEYS: keyring,
};

/** Phase 3 settings shared by the api, capture and jobs workers. */
export const AudienceEnvFields = {
  /** Encrypts profile fields marked encrypted (AES-256-GCM, key derived with HKDF). */
  FIELD_KEYS: keyring,
  /** Public origin of the capture worker: embeds, confirm pages and the Member Center. */
  CAPTURE_ORIGIN: z.url(),
};

/**
 * Where Channel websites live, for web addresses in email and the API. The api and send workers
 * declare these; the site worker has the same two values.
 */
export const SiteOriginEnvFields = {
  /** Channels are served at <slug>.<PLATFORM_SITE_DOMAIN>, e.g. notes.swarm.page. */
  PLATFORM_SITE_DOMAIN: z.string().min(3),
  /** "https" outside development. */
  SITE_SCHEME: z.enum(['https', 'http']),
};

/** Use inside a worker env schema's superRefine. */
export function checkSiteOriginEnv(
  env: { ENVIRONMENT: string; SITE_SCHEME: 'https' | 'http' },
  ctx: z.RefinementCtx,
): void {
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (!local && env.SITE_SCHEME !== 'https') {
    ctx.addIssue({
      code: 'custom',
      path: ['SITE_SCHEME'],
      message: 'must be https outside development',
    });
  }
}

export interface SiteOriginConfig {
  scheme: 'https' | 'http';
  platformDomain: string;
}

export interface EngineConfig {
  trackOrigin: string;
  platformMailDomain: string;
  unsubscribeMailDomain: string;
  /** Click and open tokens: only the send worker signs them. */
  trackKeys?: Keyring;
  unsubscribeKeys: Keyring;
  /**
   * Bounce codes: BOUNCE_KEYS once links are signed per family, UNSUBSCRIBE_KEYS before that (the
   * events worker reads both for a while). Only the send worker signs them.
   */
  bounceKeys?: Keyring;
  /** Where public media is served, for image URLs in email. */
  mediaOrigin: string;
  /** Signs Member Center links for footers. Without it the footer link unsubscribes. */
  memberLinks?: MemberLinkMinter;
  /** Signs one-tap Ask links (the send worker). */
  askSigner?: LinkSigner;
  /** Public origin of the capture worker (Member Center). */
  captureOrigin?: string;
  /** Channel websites; without it emails carry no web address. */
  site?: SiteOriginConfig;
}

export function engineConfig(
  env: {
    TRACK_ORIGIN: string;
    PLATFORM_MAIL_DOMAIN: string;
    UNSUBSCRIBE_MAIL_DOMAIN: string;
    TRACK_KEYS?: Keyring;
    UNSUBSCRIBE_KEYS: Keyring;
    BOUNCE_KEYS?: Keyring;
    MEDIA_ORIGIN: string;
    CAPTURE_ORIGIN?: string;
    PLATFORM_SITE_DOMAIN?: string;
    SITE_SCHEME?: 'https' | 'http';
  },
  /** The worker's link keys (links.ts linksFor), for Member Center and Ask links. */
  links?: LinkKeys,
): EngineConfig {
  const v2 = links?.mode.signing === 'v2';
  return {
    ...(env.PLATFORM_SITE_DOMAIN && env.SITE_SCHEME
      ? { site: { scheme: env.SITE_SCHEME, platformDomain: env.PLATFORM_SITE_DOMAIN } }
      : {}),
    ...(links && env.CAPTURE_ORIGIN
      ? {
          memberLinks: localMemberLinks(links),
          askSigner: links,
          captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
        }
      : {}),
    ...(env.TRACK_KEYS ? { trackKeys: env.TRACK_KEYS } : {}),
    // Fail closed: after the cutover a bounce code is never signed with the unsubscribe key.
    ...(v2
      ? env.BOUNCE_KEYS
        ? { bounceKeys: env.BOUNCE_KEYS }
        : {}
      : { bounceKeys: env.UNSUBSCRIBE_KEYS }),
    trackOrigin: env.TRACK_ORIGIN.replace(/\/$/, ''),
    platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
    unsubscribeMailDomain: env.UNSUBSCRIBE_MAIL_DOMAIN,
    unsubscribeKeys: env.UNSUBSCRIBE_KEYS,
    mediaOrigin: env.MEDIA_ORIGIN.replace(/\/$/, ''),
  };
}

/** Queue messages on the send queue. */
export type SendMessage =
  | { type: 'snapshot'; broadcastId: string }
  | { type: 'fanout'; broadcastId: string }
  | {
      type: 'batch';
      broadcastId: string;
      memberIds: string[];
      /**
       * Deliveries of these recipients that the provider throttled before this message (not
       * counting this message's own queue retries): their backoff keeps growing on new messages.
       */
      throttled?: number;
      /**
       * A try of an email service that stopped accepting mail (send-waits.ts): sent while the
       * send is paused for it, and the whole send goes on when the service answers.
       */
      probe?: true;
    }
  /** A Cohort Sample halted the Broadcast: email its operators (holdback.ts). */
  | { type: 'cohort_halted'; broadcastId: string }
  /**
   * A send paused for a sending limit or the email service: email its owners (send-waits.ts).
   * `ended`: the email service refused mail for too long and the send ended.
   */
  | { type: 'wait_notice'; broadcastId: string; ended?: { notSent: number } };

/** The subset of a Queue producer the engine needs, so tests can drive it in memory. */
export interface SendQueue {
  send(message: SendMessage, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: { body: SendMessage; delaySeconds?: number }[]): Promise<void>;
}

export const SNAPSHOT_CHUNK = 1000;
export const FANOUT_CHUNK = 500;
export const BATCH_SIZE = 50;
/** A claimed recipient with no result after this long is considered abandoned. */
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
/** A Broadcast with no progress for this long is resumed by the reaper. */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
/** SES list price, in millionths of a dollar per message ($0.10 per 1,000). */
export const COST_MICROS_PER_MESSAGE = 100;
