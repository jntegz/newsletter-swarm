/** Helpers shared by the Phase 2 routes: tenancy through a row's Channel, mappers, engine wiring. */
import { first, roleAtLeast, toIso } from '@swarm/db';
import type {
  DnsRecord,
  EditorDecisionsUndone,
  IdKind,
  SeatRole,
  SenderIdentity,
  SendingDomain,
} from '@swarm/domain';
import {
  engineConfig,
  linksFor,
  loadCoverMedia,
  resolveSnippets,
  SmartBlockError,
  validateSmartBlocks,
  type DomainRow,
  type EngineConfig,
  type SendFeatures,
  dmarcReportAddress,
  withRecommendedDmarc,
  type SendQueue,
} from '@swarm/engine';
import { D1FlagStore, FlagService } from '@swarm/flags';
import {
  MAX_SNIPPET_BLOCKS,
  countSnippetBlocks,
  smartBlocksOf,
  usesBlockVisibility,
} from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import type { ChannelAccess } from '@swarm/db';
import { requireChannel } from './access';
import { actorAudit, type Actor } from './actor';
import { appendAudit } from './audit';
import { env, type AppContext, type AuthContext } from './context';
import { requestMemberLinks } from './vault';

const OWNED: Partial<Record<IdKind, { table: string; label: string }>> = {
  dispatch: { table: 'dispatches', label: 'Post' },
  broadcast: { table: 'broadcasts', label: 'Send' },
  member: { table: 'members', label: 'Subscriber' },
  sendingDomain: { table: 'sending_domains', label: 'Sending domain' },
  senderIdentity: { table: 'sender_identities', label: 'Sender' },
  reputationRamp: { table: 'reputation_ramps', label: 'Warm-up' },
  flow: { table: 'flows', label: 'Automation' },
};

/**
 * Resolves a row to its Channel and applies the one tenancy check. A row in a Channel the
 * operator can't see answers 404 with the row's own name, exactly like a row that doesn't exist.
 *
 * The author role works on its own Dispatches only (phase 1 role matrix): when a route lets an
 * author act on a Dispatch, an operator whose effective role is author must have created it.
 * Reads (minimum viewer) and editor-and-up routes are unaffected.
 */
export async function requireOwned(
  c: AppContext,
  kind: IdKind,
  id: string,
  minimum: SeatRole,
): Promise<ChannelAccess & { auth: AuthContext }> {
  const owned = OWNED[kind];
  if (!owned) throw new Error(`no ownership rule for ${kind}`);
  const notFound = new ApiError('not_found', `${owned.label} not found.`);
  const authorOwned = kind === 'dispatch' && minimum === 'author';
  const row = await first<{ channel_id: string; created_by: string | null }>(
    env(c).DB,
    `SELECT channel_id, ${authorOwned ? 'created_by' : 'NULL AS created_by'} FROM ${owned.table} WHERE id = ?1`,
    id,
  );
  if (!row) throw notFound;
  let access: ChannelAccess & { auth: AuthContext };
  try {
    access = await requireChannel(c, row.channel_id, minimum);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
  if (authorOwned && access.role === 'author' && row.created_by !== access.auth.operatorId) {
    throw new ApiError('forbidden', 'Authors can change only the posts they created.');
  }
  return access;
}

/** On the site now, and still open to edits: what an author's change takes off the site. */
const ON_SITE_EDITABLE = `web_published_at IS NOT NULL AND web_visibility <> 'hidden' AND status IN ('draft', 'scheduled')`;

/**
 * Scheduling a Dispatch and putting it on the site are editor decisions, made on the Dispatch as it
 * was then: authors can't schedule, send or publish. When someone below editor changes what would
 * go out, these statements take those decisions back, run in the same batch as the change and
 * before it: a scheduled Dispatch goes back to draft, and a post on the site comes off it (search
 * row and cached pages too) until an editor schedules or publishes it again. `email` is a change
 * to the content, subject, sender or audience; `page` one to what the site shows. Each statement
 * checks the row as it is then, so a schedule set between the caller's read and this write is
 * taken back too. Read the results with editorDecisionsUndone.
 */
export function undoEditorDecisions(
  db: D1Database,
  dispatchId: string,
  role: SeatRole,
  change: { email: boolean; page: boolean },
): D1PreparedStatement[] {
  const below = !roleAtLeast(role, 'editor');
  const schedule = below && change.email ? 1 : 0;
  const site = below && change.page ? 1 : 0;
  return [
    db
      .prepare(
        `UPDATE dispatches SET status = 'draft', publish_at = NULL, best_time = 0
          WHERE id = ?1 AND ?2 = 1 AND status = 'scheduled' RETURNING id`,
      )
      .bind(dispatchId, schedule),
    db
      .prepare(
        `DELETE FROM dispatch_search WHERE dispatch_id = ?1 AND ?2 = 1
           AND EXISTS (SELECT 1 FROM dispatches WHERE id = ?1 AND ${ON_SITE_EDITABLE})`,
      )
      .bind(dispatchId, site),
    // bumpCacheStatement, only when the post is about to come off the site.
    db
      .prepare(
        `INSERT INTO site_settings (channel_id, cache_version, updated_at)
         SELECT channel_id, 2, ?3 FROM dispatches WHERE id = ?1 AND ?2 = 1 AND ${ON_SITE_EDITABLE}
         ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
      )
      .bind(dispatchId, site, Date.now()),
    db
      .prepare(
        `UPDATE dispatches SET web_published_at = NULL
          WHERE id = ?1 AND ?2 = 1 AND ${ON_SITE_EDITABLE} RETURNING id`,
      )
      .bind(dispatchId, site),
  ];
}

/** Reads what undoEditorDecisions took back from its batch results, and audits it. */
export async function editorDecisionsUndone(
  db: D1Database,
  actor: Actor,
  dispatchId: string,
  results: D1Result[],
): Promise<EditorDecisionsUndone> {
  const undone: EditorDecisionsUndone = {};
  if (results[0]?.results.length) {
    undone.unscheduled = true;
    await appendAudit(
      db,
      actorAudit(actor, {
        action: 'dispatch.unscheduled',
        targetType: 'dispatch',
        targetId: dispatchId,
        metadata: { reason: 'changed_by_author' },
      }),
    );
  }
  if (results[3]?.results.length) {
    undone.takenOffSite = true;
    await appendAudit(
      db,
      actorAudit(actor, {
        action: 'dispatch.taken_off_site',
        targetType: 'dispatch',
        targetId: dispatchId,
        metadata: { reason: 'changed_by_author' },
      }),
    );
  }
  return undone;
}

/**
 * The send engine's settings for this request. Member Center links come from the vault under
 * the request's own credential (the api holds no member signing key).
 */
export const engine = (c: AppContext): EngineConfig => {
  const config = engineConfig(env(c), linksFor(env(c)));
  return config.memberLinks ? { ...config, memberLinks: requestMemberLinks(c) } : config;
};

export function sendQueue(c: AppContext): SendQueue {
  const queue = env(c).SEND_QUEUE;
  return {
    send: async (message, options) => {
      await queue.send(message, options);
    },
    sendBatch: async (messages) => {
      if (messages.length) await queue.sendBatch(messages);
    },
  };
}

export async function rawHtmlAllowed(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('raw_html_mode', {
    workspaceId: access.workspaceId,
    channelId: access.channelId,
  });
}

/** The Phase 6 send features the Channel's flags turn on, for preflight and starting a send. */
export async function sendFeatures(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
): Promise<SendFeatures> {
  const e = env(c);
  const flags = new FlagService(new D1FlagStore(e.DB, e.CACHE));
  const scope = { workspaceId: access.workspaceId, channelId: access.channelId };
  const [splitTests, cohortSampling, smartBlocks, bestTime] = await Promise.all([
    flags.enabled('split_tests', scope),
    flags.enabled('cohort_sampling', scope),
    flags.enabled('smart_blocks', scope),
    flags.enabled('best_time_send', scope),
  ]);
  return { splitTests, cohortSampling, smartBlocks, bestTime };
}

/**
 * Refuses a document whose Smart Blocks can't be saved: the flag is off (feature_disabled), or a
 * block is invalid or names a Circle or level of another Channel (invalid_input).
 */
export async function checkSmartBlocks(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  content: unknown,
): Promise<void> {
  if (!smartBlocksOf(content, { allSurfaces: true }).length) return;
  if (!(await sendFeatures(c, access)).smartBlocks) {
    throw new ApiError('feature_disabled', 'Smart blocks are off for this publication.');
  }
  try {
    await validateSmartBlocks(env(c).DB, access.channelId, content);
  } catch (error) {
    if (!(error instanceof SmartBlockError)) throw error;
    throw new ApiError('invalid_input', error.message, [
      { path: error.path, message: error.message },
    ]);
  }
}

/**
 * Refuses a document with a block kept to email or to the website while the flag is off. Rendering
 * still follows a stored setting, so turning the flag off never puts email-only text on the site.
 */
export async function checkBlockVisibility(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  content: unknown,
): Promise<void> {
  const e = env(c);
  // A linked snippet's blocks count: the snippet may have been saved while the flag was on.
  if (!usesBlockVisibility(await resolveSnippets(e.DB, access.channelId, content))) return;
  const on = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('block_visibility', {
    workspaceId: access.workspaceId,
    channelId: access.channelId,
  });
  if (on) return;
  throw new ApiError(
    'feature_disabled',
    'Email-only and website-only blocks are off for this publication. Set those blocks back to Email and website.',
  );
}

/** Refuses a document that links to snippets while the flag is off, or that links to too many. */
export async function checkSnippets(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  content: unknown,
): Promise<void> {
  const count = countSnippetBlocks(content);
  if (!count) return;
  const e = env(c);
  const on = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('snippets', {
    workspaceId: access.workspaceId,
    channelId: access.channelId,
  });
  if (!on) {
    throw new ApiError(
      'feature_disabled',
      'Snippets are off for this publication. Detach the snippets in this post or remove them.',
    );
  }
  if (count > MAX_SNIPPET_BLOCKS) {
    const message = `A post can use up to ${MAX_SNIPPET_BLOCKS} snippets. Detach or remove some.`;
    throw new ApiError('invalid_input', message, [{ path: 'content', message }]);
  }
}

/**
 * Refuses a new cover image unless it is an image in this workspace's media library. Checked when
 * the reference is written, not on every save: autosave keeps sending the current cover, which
 * may since have been deleted, and that only leaves it out of the render with a warning.
 */
export async function checkCoverImage(
  c: AppContext,
  workspaceId: string,
  mediaId: string,
): Promise<void> {
  if (await loadCoverMedia(env(c).DB, workspaceId, mediaId)) return;
  const message = 'Choose an image from this workspace’s media library.';
  throw new ApiError('invalid_input', message, [{ path: 'coverImage', message }]);
}

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

// The Member, Dispatch and Broadcast mappers live in the engine (api-shapes.ts), so webhook
// payloads use the same shapes.
export {
  MEMBER_COLUMNS,
  toBroadcast,
  toDispatchSummary,
  toMember,
  type MemberRow,
} from '@swarm/engine';

/**
 * With `dmarcMailDomain`, an email domain's DMARC record is today's recommendation (with its
 * per-domain report address), whatever was stored when it was added.
 */
/**
 * Hosts that belong to the platform, for both environments of an install. The installer names
 * production's <label>.D and staging's staging-<label>.D, and the two can share a mail service
 * account, where the other environment's mail domain is an identity no row of this one created.
 */
function platformDomains(config: EngineConfig): string[] {
  const own = [
    config.platformMailDomain,
    config.unsubscribeMailDomain,
    new URL(config.trackOrigin).hostname,
  ].map((host) => host.toLowerCase());
  const other = (host: string) =>
    host.startsWith('staging-') ? host.slice('staging-'.length) : `staging-${host}`;
  return [...own, ...own.map(other)];
}

export const isPlatformDomain = (domain: string, config: EngineConfig) =>
  platformDomains(config).some((host) => domain === host || domain.endsWith(`.${host}`));

export const toSendingDomain = (row: DomainRow, dmarcMailDomain?: string): SendingDomain => ({
  id: row.id,
  channelId: row.channel_id,
  domain: row.domain,
  kind: row.kind,
  status: row.status,
  dkimStatus: row.dkim_status as SendingDomain['dkimStatus'],
  mailFromDomain: row.mail_from_domain,
  mailFromStatus: row.mail_from_status as SendingDomain['mailFromStatus'],
  dmarcPolicy: row.dmarc_policy,
  records:
    dmarcMailDomain && row.kind === 'email'
      ? withRecommendedDmarc(
          JSON.parse(row.records_json) as DnsRecord[],
          row.domain,
          dmarcReportAddress(row.id, dmarcMailDomain),
        )
      : (JSON.parse(row.records_json) as DnsRecord[]),
  pendingChange:
    row.pending_provider && row.pending_records_json
      ? {
          service: row.pending_provider,
          records:
            dmarcMailDomain && row.kind === 'email'
              ? withRecommendedDmarc(
                  JSON.parse(row.pending_records_json) as DnsRecord[],
                  row.domain,
                  dmarcReportAddress(row.id, dmarcMailDomain),
                )
              : (JSON.parse(row.pending_records_json) as DnsRecord[]),
        }
      : null,
  lastCheckedAt: iso(row.last_checked_at),
  verifiedAt: iso(row.verified_at),
  createdAt: toIso(row.created_at),
});

export interface SenderIdentityRow {
  id: string;
  channel_id: string;
  sending_domain_id: string | null;
  from_name: string;
  from_local: string;
  reply_to: string | null;
  is_default: number;
  created_at: number;
  domain: string | null;
}

export const toSenderIdentity = (row: SenderIdentityRow, config: EngineConfig): SenderIdentity => ({
  id: row.id,
  channelId: row.channel_id,
  sendingDomainId: row.sending_domain_id,
  fromName: row.from_name,
  fromAddress: `${row.from_local}@${row.domain ?? config.platformMailDomain}`,
  replyTo: row.reply_to,
  isDefault: row.is_default === 1,
  createdAt: toIso(row.created_at),
});
