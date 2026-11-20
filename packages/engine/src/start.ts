/**
 * Rendering a Dispatch, the pre-send checklist, and starting a Broadcast. Shared by the API
 * ("send now", test sends) and the send worker's scheduler, so both apply the same rules.
 */
import { EmailDesignSchema } from '@swarm/domain';
import type { EmailDesignOptions } from '@swarm/mail';
import { isUniqueViolation } from '@swarm/db';
import type { CoverImageRef, PreflightCheck, WebVisibility } from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import {
  checkContent,
  EMPTY_WARNING,
  renderDispatch,
  RenderError,
  shareLinks,
  type ContentAdvice,
  type EmailVariant,
  type RenderedTemplate,
} from '@swarm/mail';
import type { EngineConfig, SendQueue } from './config';
import {
  AudienceError,
  compileAudience,
  countAudience,
  isEveryone,
  loadAudienceRules,
  parseAudience,
  type FrozenAudience,
} from './circles';
import { all, first, newIdFor, placeholders } from './db';
import { askBlocksFor, type AskBlock } from './asks';
import { BEST_TIME_WARM_UP_NOTE, BEST_TIME_WITH_TEST_PROBLEM, fitsWarmUp } from './best-time';
import { dmarcAllowsSending } from './domains';
import {
  appendLinks,
  holdBackStartStatements,
  planHoldBackCheck,
  type CohortSampleRow,
  type SendFeatures,
  type SplitTestRow,
  type SplitVariantRow,
} from './holdback';
import {
  channelSiteOrigin,
  dispatchWebUrl,
  planSlug,
  publicationStatements,
  type SlugPlan,
} from './publishing';
import { ensureRamp, RAMP_DEFAULTS, utcDay } from './ramp';
import { channelSettings } from './tracking-choices';
import { resolveSnippets, resolveSnippetsJson, type SnippetSnapshot } from './snippets';
import { SmartBlockError, validateSmartBlocks } from './smartblocks';
import { countAdmitted, gateLevelIds, splitsByEntitlement } from './variants';

export interface DispatchRow {
  id: string;
  channel_id: string;
  subject: string;
  preheader: string;
  content_json: string;
  html: string;
  text: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';
  sender_identity_id: string | null;
  publish_at: number | null;
  sent_at: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  /** {"include": [circle ids], "exclude": [circle ids]}; absent on rows selected without it. */
  audience_json?: string;
  /** Who may read it in full on the site; 'hidden' keeps it off the site. */
  web_visibility: WebVisibility;
  /** When it appeared on the site. */
  web_published_at: number | null;
  section_id: string | null;
  /** 'flow' for a Flow email (Phase 6); absent on rows selected without it. */
  kind?: 'broadcast' | 'flow';
  flow_id?: string | null;
  /** 1 when a scheduled send goes at each reader's best time; absent on rows selected without it. */
  best_time?: number;
  /**
   * The scheduler's tries at starting this schedule, counted as each begins and cleared when it
   * starts or leaves the schedule; absent on rows selected without it.
   */
  start_attempts?: number;
  /** The scheduler leaves it until then after a failed start; absent on rows selected without it. */
  start_retry_at?: number | null;
  /** A note for the team; absent on rows selected without it. */
  internal_note?: string;
  /** Who started it; absent on rows selected without it. Null = a teammate in the dashboard. */
  created_via?: 'agent' | 'copilot' | 'api' | null;
  /** 1 when Feed Sync started it; absent on rows selected without it. */
  from_feed?: number;
  /** Hidden from the dashboard's default list; absent on rows selected without it. */
  archived_at?: number | null;
  /** The day a writer aims for (YYYY-MM-DD). It has no effect on sending. */
  planned_date?: string | null;
  /** Set on an issue from another platform, which is never sent; absent on rows selected without it. */
  imported_at?: number | null;
  /** The cover image; absent on rows selected without it. */
  cover_media_id?: string | null;
  cover_alt?: string;
}

/** The cover image stored on a Dispatch, a revision or a template. */
export const coverOf = (row: {
  cover_media_id?: string | null;
  cover_alt?: string;
}): CoverImageRef | null =>
  row.cover_media_id ? { mediaId: row.cover_media_id, alt: row.cover_alt ?? '' } : null;

export interface CoverMedia {
  r2_key: string;
  alt_text: string | null;
  width: number | null;
  height: number | null;
}

/** A media item that can be a cover image: a live, public image of this workspace, or null. */
export function loadCoverMedia(
  db: D1Database,
  workspaceId: string,
  mediaId: string,
): Promise<CoverMedia | null> {
  return first<CoverMedia>(
    db,
    `SELECT r2_key, alt_text, width, height FROM media
      WHERE id = ?1 AND workspace_id = ?2 AND visibility = 'public' AND deleted_at IS NULL
        AND content_type LIKE 'image/%'`,
    mediaId,
    workspaceId,
  );
}

interface ChannelRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  branding_json: string;
  settings_json: string;
  status: 'active' | 'paused';
  deleted_at: number | null;
}

export interface Sender {
  name: string;
  address: string;
  replyTo: string | null;
  sendingDomainId: string | null;
  /** Domain status problems; empty when the sender can send. */
  problems: { key: 'sender' | 'domain' | 'dmarc'; message: string }[];
}

function collectMediaIds(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const child of node) collectMediaIds(child, into);
  else if (node && typeof node === 'object') {
    const { type, attrs, content } = node as {
      type?: unknown;
      attrs?: { mediaId?: unknown };
      content?: unknown;
    };
    if (
      (type === 'image' || type === 'attachment') &&
      typeof attrs?.mediaId === 'string' &&
      attrs.mediaId.length < 64
    ) {
      into.add(attrs.mediaId);
    }
    if (content) collectMediaIds(content, into);
  }
  return into;
}

export interface RenderInput {
  db: D1Database;
  workspaceId: string;
  /** Poll blocks (`askPoll`) resolve only against this Channel's Asks; without it they fail. */
  channelId?: string;
  channelName: string;
  accentColor: string | null;
  preheader: string;
  content: unknown;
  /** Kept in every variant: a Split Test's content or a teaser changes only the body. */
  cover?: CoverImageRef | null;
  mediaOrigin: string;
  allowHtmlBlocks: boolean;
  /** Paid Dispatches stop at the gate in email and link to `webUrl`. */
  webVisibility?: WebVisibility;
  webUrl?: string | null;
  /** For a gated paid Dispatch: the full email or the teaser (the default). */
  paidVariant?: EmailVariant;
  /** The Channel's editor options; looked up from `channelId` when absent (emailStyleFor). */
  emailStyle?: EmailStyle;
  /** Snippets as already read: every render given the same one uses the same versions. */
  snippets?: SnippetSnapshot;
  /** Where to read snippets when there is no `channelId` (a Channel's template, exported). */
  snippetChannelId?: string | null;
}

/** What the code_embeds and custom_email_css flags change in a Channel's emails. */
export interface EmailStyle {
  codeEmbeds: boolean;
  /** The Channel's email CSS, or null when there is none or the flag is off. */
  customCss: string | null;
  /** The Channel's email design, or null when there is none or the flag is off. */
  design: EmailDesignOptions | null;
}

const NO_STYLE: EmailStyle = { codeEmbeds: false, customCss: null, design: null };

/** The Channel's chosen look for its emails, with its logo's address. */
async function emailDesignFor(
  db: D1Database,
  channelId: string,
  mediaOrigin: string | undefined,
): Promise<EmailDesignOptions | null> {
  const row = await first<{ settings_json: string; branding_json: string }>(
    db,
    'SELECT settings_json, branding_json FROM channels WHERE id = ?1',
    channelId,
  );
  if (!row) return null;
  const parsed = EmailDesignSchema.safeParse(
    (JSON.parse(row.settings_json) as { emailDesign?: unknown }).emailDesign ?? null,
  );
  if (!parsed.success) return null;
  const { showLogo, ...design } = parsed.data;
  const logoId = (JSON.parse(row.branding_json) as { logoMediaId?: unknown }).logoMediaId;
  let logoUrl: string | null = null;
  if (showLogo && typeof logoId === 'string' && mediaOrigin) {
    const media = await first<{ r2_key: string }>(
      db,
      'SELECT r2_key FROM media WHERE id = ?1 AND deleted_at IS NULL',
      logoId,
    );
    if (media) logoUrl = `${mediaOrigin}/media/${media.r2_key}`;
  }
  return { ...design, logoUrl };
}

/**
 * The editor options for a Channel's emails, from its flags (resolved here, on the server, for
 * every render path: previews, test sends, Broadcasts and Flow emails) and its stored CSS.
 */
export async function emailStyleFor(
  db: D1Database,
  workspaceId: string,
  channelId: string,
  mediaOrigin?: string,
): Promise<EmailStyle> {
  const flags = await new FlagService(new D1FlagStore(db)).all({ workspaceId, channelId });
  const row = flags.custom_email_css
    ? await first<{ css: string }>(
        db,
        'SELECT css FROM channel_email_css WHERE channel_id = ?1',
        channelId,
      )
    : null;
  return {
    codeEmbeds: flags.code_embeds,
    customCss: row?.css ?? null,
    design: flags.email_design ? await emailDesignFor(db, channelId, mediaOrigin) : null,
  };
}

/** Renders a document with media resolved against this workspace's library only. */
export async function renderForWorkspace(input: RenderInput): Promise<RenderedTemplate> {
  // First: a snippet's images and polls are looked up like the post's own.
  const snippetChannel = input.channelId ?? input.snippetChannelId;
  const content = snippetChannel
    ? await resolveSnippets(input.db, snippetChannel, input.content, input.snippets)
    : input.content;
  const ids = [...collectMediaIds(content)].slice(0, 200);
  const rows = ids.length
    ? await all<{ id: string; r2_key: string }>(
        input.db,
        `SELECT id, r2_key FROM media WHERE workspace_id = ?1 AND deleted_at IS NULL AND id IN (${placeholders(ids.length, 2)})`,
        input.workspaceId,
        ...ids,
      )
    : [];
  const urls = new Map(rows.map((row) => [row.id, `${input.mediaOrigin}/media/${row.r2_key}`]));
  const polls = input.channelId
    ? await askBlocksFor(input.db, input.channelId, content)
    : new Map<string, AskBlock>();
  const style =
    input.emailStyle ??
    (input.channelId
      ? await emailStyleFor(input.db, input.workspaceId, input.channelId, input.mediaOrigin)
      : NO_STYLE);
  const cover = input.cover
    ? await loadCoverMedia(input.db, input.workspaceId, input.cover.mediaId)
    : null;
  return renderDispatch(content, {
    cover: input.cover
      ? {
          url: cover ? `${input.mediaOrigin}/media/${cover.r2_key}` : null,
          alt: input.cover.alt.trim() || cover?.alt_text?.trim() || '',
        }
      : null,
    codeEmbeds: style.codeEmbeds,
    customCss: style.customCss,
    design: style.design ?? null,
    ask: (askId, questionId) => polls.get(`${askId}:${questionId}`) ?? null,
    channelName: input.channelName,
    accentColor: input.accentColor,
    preheader: input.preheader,
    mediaUrl: (id) => urls.get(id) ?? null,
    allowHtmlBlocks: input.allowHtmlBlocks,
    ...(input.webVisibility ? { webVisibility: input.webVisibility } : {}),
    ...(input.paidVariant ? { paidVariant: input.paidVariant } : {}),
    webUrl: input.webUrl ?? null,
  });
}

/**
 * The web address email links to: the Dispatch's current slug, or the one it will get when it is
 * published. Null when the deployment has no site settings.
 */
export async function webUrlFor(
  db: D1Database,
  config: EngineConfig,
  dispatch: Pick<DispatchRow, 'id' | 'channel_id' | 'subject'>,
  plan?: SlugPlan,
): Promise<string | null> {
  if (!config.site) return null;
  const { slug } = plan ?? (await planSlug(db, dispatch));
  const { origin } = await channelSiteOrigin(db, config.site, dispatch.channel_id);
  return dispatchWebUrl(origin, slug);
}

/** Replaces link placeholders with the original URLs, for previews and the stored Dispatch html. */
export function previewHtml(template: RenderedTemplate): string {
  return template.html
    .replace(/\{\{@link:(\d+)\}\}/g, (_, n: string) => template.links[Number(n)] ?? '#')
    .replace(/\{\{@unsubscribe\}\}/g, '#unsubscribe')
    .replace(/\{\{@member_center\}\}/g, '#member-center')
    .replace(/\{\{@pixel\}\}/g, '')
    .replace(/\{\{@ask:ao_[0-9a-f]{32}\}\}/g, '#');
}

async function loadChannel(db: D1Database, channelId: string): Promise<ChannelRow> {
  const row = await first<ChannelRow>(
    db,
    'SELECT id, workspace_id, slug, name, branding_json, settings_json, status, deleted_at FROM channels WHERE id = ?1',
    channelId,
  );
  if (!row) throw new Error('channel not found');
  return row;
}

/** Who a Dispatch is sent from, and whether that sender may send right now. */
export async function resolveSender(
  db: D1Database,
  config: EngineConfig,
  channel: Pick<ChannelRow, 'id' | 'slug' | 'name'>,
  senderIdentityId: string | null,
): Promise<Sender> {
  const identity = await first<{
    from_name: string;
    from_local: string;
    reply_to: string | null;
    sending_domain_id: string | null;
  }>(
    db,
    `SELECT from_name, from_local, reply_to, sending_domain_id FROM sender_identities
      WHERE channel_id = ?1 AND (id = ?2 OR (?2 IS NULL AND is_default = 1))`,
    channel.id,
    senderIdentityId,
  );
  if (senderIdentityId && !identity) {
    return {
      name: channel.name,
      address: `${channel.slug}@${config.platformMailDomain}`,
      replyTo: null,
      sendingDomainId: null,
      problems: [
        { key: 'sender', message: 'The chosen sender no longer exists. Pick another one.' },
      ],
    };
  }
  if (!identity?.sending_domain_id) {
    // The shared platform domain: always <slug>@<platform mail domain>.
    return {
      name: identity?.from_name ?? channel.name,
      address: `${channel.slug}@${config.platformMailDomain}`,
      replyTo: identity?.reply_to ?? null,
      sendingDomainId: null,
      problems: [],
    };
  }
  const domain = await first<{
    domain: string;
    status: string;
    dmarc_policy: string | null;
    kind: string;
  }>(
    db,
    'SELECT domain, status, dmarc_policy, kind FROM sending_domains WHERE id = ?1',
    identity.sending_domain_id,
  );
  const problems: Sender['problems'] = [];
  if (!domain || domain.kind !== 'email') {
    problems.push({ key: 'domain', message: 'The sending domain is missing.' });
  } else {
    if (domain.status !== 'verified') {
      problems.push({
        key: 'domain',
        message: `${domain.domain} is not verified yet. Publish its DNS records, then check again.`,
      });
    }
    if (!dmarcAllowsSending(domain.dmarc_policy)) {
      problems.push({
        key: 'dmarc',
        message: `${domain.domain} needs a DMARC policy of quarantine or reject before the first send (found ${domain.dmarc_policy ?? 'none'}).`,
      });
    }
  }
  return {
    name: identity.from_name,
    address: `${identity.from_local}@${domain?.domain ?? config.platformMailDomain}`,
    replyTo: identity.reply_to,
    sendingDomainId: identity.sending_domain_id,
    problems,
  };
}

/** Members a send would reach right now: active, and not suppressed in the workspace. */
export async function audienceCount(
  db: D1Database,
  channelId: string,
  workspaceId: string,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM members m
      WHERE m.channel_id = ?1 AND m.status = 'active' AND m.emails_off_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?2 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))`,
    channelId,
    workspaceId,
  );
  return row?.n ?? 0;
}

export interface PreflightResult {
  ready: boolean;
  recipientCount: number;
  from: { name: string; address: string } | null;
  checks: PreflightCheck[];
  warnings: string[];
  /**
   * Advice about the rendered email (subject, links, images, wording) that spam filters and
   * readers care about. Never blocks a send. Empty when the email did not render.
   */
  advice: ContentAdvice[];
  /** The email (for a gated paid Dispatch, the full one; its links include the teaser's). */
  template: RenderedTemplate | null;
  /** The teaser of a gated paid Dispatch, sharing `template`'s link list; null otherwise. */
  teaser: RenderedTemplate | null;
  /**
   * For a gated paid Dispatch: how many of `recipientCount` get the full email right now, how
   * many the teaser, and the levels its Gate admits (empty = any paid level). Null otherwise.
   */
  split: { full: number; teaser: number; levelIds: string[] } | null;
  /** A Split Test or Cohort Sample the send would run, with estimated counts; null otherwise. */
  holdBack: {
    kind: 'split_test' | 'cohort_sample';
    test: number;
    held: number;
    variants: number;
  } | null;
  /**
   * Whether this send may go at each reader's best time, for offering the choice. Null when the
   * flag is off.
   */
  bestTime: { available: boolean; reason: string | null; note: string | null } | null;
  /** What the send would start: the test with its variants, or the sample. */
  holdBackPlan: {
    split: { test: SplitTestRow; variants: SplitVariantRow[] } | null;
    sample: CohortSampleRow | null;
  };
  /** How the email was rendered, so variants render the same way. Null when it didn't render. */
  renderInput: RenderInput | null;
  sender: Sender;
  channel: ChannelRow;
  /** The audience the count was taken for, with its Circle rules frozen for the snapshot. */
  audience: FrozenAudience;
}

/** Hosts the publication itself owns: its short-link app, branded link domains, tracking. */
async function ownLinkHosts(
  db: D1Database,
  config: EngineConfig,
  channel: Pick<ChannelRow, 'id' | 'workspace_id'>,
): Promise<string[]> {
  const hosts: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    try {
      hosts.push(new URL(value.includes('://') ? value : `https://${value}`).hostname);
    } catch {
      // Not an address; nothing to trust.
    }
  };
  add(config.trackOrigin);
  const apps = await all<{ base_url: string; domain: string | null }>(
    db,
    'SELECT base_url, domain FROM app_connections WHERE workspace_id = ?1',
    channel.workspace_id,
  );
  for (const app of apps) {
    add(app.base_url);
    add(app.domain);
  }
  const links = await all<{ domain: string }>(
    db,
    `SELECT domain FROM sending_domains WHERE channel_id = ?1 AND kind = 'link'`,
    channel.id,
  );
  for (const link of links) add(link.domain);
  return hosts;
}

/** File sizes of the media library images an email shows, by their address. */
async function emailImageBytes(
  db: D1Database,
  config: EngineConfig,
  workspaceId: string,
  html: string,
): Promise<Map<string, number>> {
  const prefix = `${config.mediaOrigin}/media/`;
  const keys = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) {
    const src = match[1]!.replace(/&amp;/g, '&');
    if (src.startsWith(prefix)) keys.add(src.slice(prefix.length));
  }
  const sizes = new Map<string, number>();
  const wanted = [...keys].slice(0, 50);
  if (!wanted.length) return sizes;
  const rows = await all<{ r2_key: string; bytes: number }>(
    db,
    `SELECT r2_key, bytes FROM media WHERE workspace_id = ?1 AND r2_key IN (${placeholders(wanted.length, 2)})`,
    workspaceId,
    ...wanted,
  );
  for (const row of rows) sizes.set(`${prefix}${row.r2_key}`, row.bytes);
  return sizes;
}

/**
 * Content advice for the pre-send checklist. Advice must never stop or break a send, so anything
 * that goes wrong here means no advice.
 */
async function contentAdvice(
  db: D1Database,
  config: EngineConfig,
  channel: Pick<ChannelRow, 'id' | 'workspace_id'>,
  dispatch: Pick<DispatchRow, 'subject' | 'preheader'>,
  template: RenderedTemplate,
): Promise<ContentAdvice[]> {
  try {
    const [ownHosts, imageBytes] = await Promise.all([
      ownLinkHosts(db, config, channel),
      emailImageBytes(db, config, channel.workspace_id, template.html),
    ]);
    return checkContent({
      subject: dispatch.subject,
      preheader: dispatch.preheader,
      html: template.html,
      text: template.text,
      links: template.links,
      ownHosts,
      imageBytes,
    });
  } catch {
    return [];
  }
}

export async function preflight(
  db: D1Database,
  config: EngineConfig,
  dispatch: DispatchRow,
  options: {
    allowHtmlBlocks: boolean;
    /** The web address for the paid gate's link; looked up when not given. */
    webUrl?: string | null;
    /** Split Tests, Cohort Sampling and Smart Blocks, when their flags are on. */
    features?: SendFeatures;
    /** This send was asked to go at each reader's best time. */
    bestTime?: boolean;
  },
): Promise<PreflightResult> {
  const channel = await loadChannel(db, dispatch.channel_id);
  // Best-time sending works out personal hours: only where the publication profiles its readers.
  const features: SendFeatures = channelSettings(channel.settings_json).profileReaders
    ? (options.features ?? {})
    : { ...options.features, bestTime: false };
  const checks: PreflightCheck[] = [];
  const warnings: string[] = [];
  let advice: ContentAdvice[] = [];

  checks.push(
    dispatch.subject.trim()
      ? { key: 'subject', ok: true, message: 'Subject is set.' }
      : { key: 'subject', ok: false, message: 'Add a subject.' },
  );

  let template: RenderedTemplate | null = null;
  let teaser: RenderedTemplate | null = null;
  let renderInput: RenderInput | null = null;
  const splits = splitsByEntitlement(dispatch);
  try {
    const branding = JSON.parse(channel.branding_json) as { accentColor?: string | null };
    const input: RenderInput = {
      db,
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      channelName: channel.name,
      accentColor: branding.accentColor ?? null,
      preheader: dispatch.preheader,
      content: JSON.parse(dispatch.content_json),
      cover: coverOf(dispatch),
      mediaOrigin: config.mediaOrigin,
      allowHtmlBlocks: options.allowHtmlBlocks,
      // Looked up once, so the full and teaser renders and every variant agree.
      emailStyle: await emailStyleFor(db, channel.workspace_id, channel.id),
      // Read once, so a snippet edited during the start can't reach only part of the send.
      snippets: new Map(),
      webVisibility: dispatch.web_visibility,
      // Only a paid Dispatch's email carries the web address.
      webUrl:
        dispatch.web_visibility === 'paid'
          ? options.webUrl !== undefined
            ? options.webUrl
            : await webUrlFor(db, config, dispatch)
          : null,
    };
    template = await renderForWorkspace(input);
    renderInput = input;
    if (splits) {
      // `template` so far is the teaser; Members the Gate admits get everything.
      const full = await renderForWorkspace({ ...input, paidVariant: 'full' });
      const shared = shareLinks(full, template);
      template = {
        ...shared.full,
        warnings: [...new Set([...shared.full.warnings, ...shared.teaser.warnings])],
      };
      teaser = shared.teaser;
    }
    const empty = template.warnings.includes(EMPTY_WARNING);
    const smartBlockProblem = template.smartBlocks?.length
      ? await smartBlocksProblem(db, channel.id, JSON.parse(dispatch.content_json), features)
      : null;
    checks.push(
      empty
        ? { key: 'content', ok: false, message: EMPTY_WARNING }
        : smartBlockProblem
          ? { key: 'content', ok: false, message: smartBlockProblem }
          : { key: 'content', ok: true, message: 'Content renders.' },
    );
    warnings.push(...template.warnings.filter((w) => w !== EMPTY_WARNING));
    if (!empty) advice = await contentAdvice(db, config, channel, dispatch, template);
    const invalid = template.warnings.filter((w) => w.includes('not a valid web address'));
    checks.push(
      invalid.length
        ? {
            key: 'links',
            ok: false,
            message: `${invalid.length} link${invalid.length === 1 ? ' is' : 's are'} not valid.`,
          }
        : {
            key: 'links',
            ok: true,
            message: `${template.links.length} link${template.links.length === 1 ? '' : 's'}, all valid.`,
          },
    );
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    checks.push({ key: 'content', ok: false, message: error.message });
  }

  const sender = await resolveSender(db, config, channel, dispatch.sender_identity_id);
  const senderProblem = sender.problems.find((p) => p.key === 'sender');
  checks.push(
    senderProblem
      ? { key: 'sender', ok: false, message: senderProblem.message }
      : { key: 'sender', ok: true, message: `From ${sender.name} <${sender.address}>.` },
  );
  if (sender.sendingDomainId) {
    const domainProblem = sender.problems.find((p) => p.key === 'domain');
    checks.push(
      domainProblem
        ? { key: 'domain', ok: false, message: domainProblem.message }
        : { key: 'domain', ok: true, message: 'Sending domain is verified (SPF and DKIM).' },
    );
    const dmarcProblem = sender.problems.find((p) => p.key === 'dmarc');
    checks.push(
      dmarcProblem
        ? { key: 'dmarc', ok: false, message: dmarcProblem.message }
        : { key: 'dmarc', ok: true, message: 'DMARC is enforced.' },
    );
  } else {
    checks.push({
      key: 'domain',
      ok: true,
      message: `Sending from the shared domain ${config.platformMailDomain}.`,
    });
  }

  // The exact deduplicated count: the same compiled predicate the snapshot applies.
  let audience: FrozenAudience = { include: [], exclude: [], rules: {} };
  let recipientCount = 0;
  let audienceProblem: string | null = null;
  let split: PreflightResult['split'] = null;
  try {
    // Callers may pass a row selected without the column; never fall back to everyone then.
    const json =
      dispatch.audience_json ??
      (
        await first<{ audience_json: string }>(
          db,
          'SELECT audience_json FROM dispatches WHERE id = ?1',
          dispatch.id,
        )
      )?.audience_json;
    const requested = parseAudience(json);
    audience = {
      include: requested.include,
      exclude: requested.exclude,
      ...(requested.rosters ? { rosters: requested.rosters } : {}),
      ...(requested.unopenedOf ? { unopenedOf: requested.unopenedOf } : {}),
      rules: {},
    };
    audience = await loadAudienceRules(db, channel.id, requested);
    const compiled = await compileAudience(db, channel.id, audience);
    recipientCount = await countAudience(db, channel.id, channel.workspace_id, compiled);
    if (splits) {
      const levelIds = await gateLevelIds(db, channel.id, dispatch.id);
      const full = await countAdmitted(db, channel.id, channel.workspace_id, compiled, levelIds);
      split = { full, teaser: recipientCount - full, levelIds };
    }
  } catch (error) {
    if (!(error instanceof AudienceError)) throw error;
    audienceProblem = error.message;
  }
  const plan = await planHoldBackCheck(db, dispatch, splits, recipientCount, features);
  if (plan.problem) checks.push({ key: 'test', ok: false, message: plan.problem });
  else if (options.bestTime && features.bestTime && plan.holdBack) {
    checks.push({ key: 'test', ok: false, message: BEST_TIME_WITH_TEST_PROBLEM });
  } else if (plan.holdBack) {
    const n = (value: number) => value.toLocaleString('en-US');
    checks.push({
      key: 'test',
      ok: true,
      message:
        plan.holdBack.kind === 'split_test'
          ? `Split test: about ${n(plan.holdBack.test)} subscribers get one of ${plan.holdBack.variants} variants first; ${n(plan.holdBack.held)} get the winner.`
          : `Cohort sample: about ${n(plan.holdBack.test)} subscribers get it first; ${n(plan.holdBack.held)} follow if the sample stays healthy.`,
    });
  }
  const everyone = isEveryone(audience);
  const people = `${recipientCount.toLocaleString('en-US')} ${everyone ? 'active ' : ''}subscriber${recipientCount === 1 ? '' : 's'}`;
  checks.push(
    audienceProblem
      ? { key: 'audience', ok: false, message: audienceProblem }
      : recipientCount > 0
        ? {
            key: 'audience',
            ok: true,
            message: `${everyone ? `${people}.` : `${people} in this audience.`}${split ? ` ${splitMessage(split)}` : ''}`,
          }
        : {
            key: 'audience',
            ok: false,
            message: everyone
              ? 'There are no active subscribers to send to.'
              : 'No active subscribers are in this audience.',
          },
  );

  const ramp = await first<{
    status: 'warming' | 'paused' | 'complete';
    day: string;
    cap_today: number;
    sent_today: number;
    paused_reason: string | null;
  }>(
    db,
    `SELECT status, day, cap_today, sent_today, paused_reason FROM reputation_ramps
      WHERE channel_id = ?1 AND ifnull(sending_domain_id, '') = ?2`,
    channel.id,
    sender.sendingDomainId ?? '',
  );
  if (ramp?.status === 'paused') {
    checks.push({
      key: 'ramp',
      ok: false,
      message: `The warm-up is paused: ${ramp.paused_reason ?? 'resume it in Sending & delivery.'}`,
    });
  } else {
    const left = ramp ? Math.max(0, ramp.cap_today - ramp.sent_today) : null;
    checks.push({
      key: 'ramp',
      ok: true,
      message: ramp?.status === 'complete' ? 'Warm-up is complete.' : 'Warm-up is active.',
    });
    if (left !== null && ramp?.status === 'warming' && left < recipientCount) {
      warnings.push(
        `Today's warm-up allows ${left.toLocaleString('en-US')} more messages; the rest will go out over the next days.`,
      );
    }
  }

  if (channel.status === 'paused') {
    checks.push({ key: 'sender', ok: false, message: 'This publication is paused.' });
  }
  // A deleted Channel mails nobody again, whichever path asks for the send.
  if (channel.deleted_at !== null) {
    checks.push({ key: 'sender', ok: false, message: 'This publication is deleted.' });
  }

  return {
    ready: checks.every((check) => check.ok),
    recipientCount,
    from: senderProblem ? null : { name: sender.name, address: sender.address },
    checks,
    warnings,
    advice,
    template,
    teaser,
    split,
    holdBack: plan.holdBack,
    bestTime: features.bestTime
      ? {
          available: !plan.holdBack,
          reason: plan.holdBack ? BEST_TIME_WITH_TEST_PROBLEM : null,
          // No ramp yet: the first send makes one, at its starting limit.
          note: !fitsWarmUp(
            ramp ?? {
              status: 'warming',
              day: utcDay(Date.now()),
              sent_today: 0,
              cap_today: sender.sendingDomainId
                ? RAMP_DEFAULTS.custom.startCap
                : RAMP_DEFAULTS.platform.startCap,
            },
            recipientCount,
            Date.now(),
          )
            ? BEST_TIME_WARM_UP_NOTE
            : null,
        }
      : null,
    holdBackPlan: { split: plan.split, sample: plan.sample },
    renderInput,
    sender,
    channel,
    audience,
  };
}

/** Why a document's Smart Blocks can't be sent, or null when they can. */
async function smartBlocksProblem(
  db: D1Database,
  channelId: string,
  content: unknown,
  features: SendFeatures,
): Promise<string | null> {
  if (!features.smartBlocks) {
    return 'Smart blocks are off for this publication. Remove them, or turn Smart blocks on.';
  }
  try {
    await validateSmartBlocks(db, channelId, content);
    return null;
  } catch (error) {
    if (error instanceof SmartBlockError) return `A Smart block can’t be sent: ${error.message}`;
    throw error;
  }
}

function splitMessage(split: { full: number; teaser: number }): string {
  const n = (value: number) => value.toLocaleString('en-US');
  return `${n(split.full)} get${split.full === 1 ? 's' : ''} the full post and ${n(split.teaser)} the teaser that stops at the paywall.`;
}

/** Why an imported issue can't go out: its readers already had it. */
export const PAST_ISSUE_NOT_SENT =
  'This is a past issue from another platform, so it can’t be emailed. Start a new post to send it to your subscribers.';

export class StartError extends Error {
  constructor(
    readonly code: 'not_ready' | 'already_sending' | 'wrong_status',
    message: string,
    readonly checks: PreflightCheck[] = [],
  ) {
    super(message);
    this.name = 'StartError';
  }
}

/**
 * Creates the Broadcast with a frozen render and link targets, then enqueues the snapshot.
 * The partial unique index on broadcasts(dispatch_id) makes a double send impossible.
 */
export async function startBroadcast(
  db: D1Database,
  queue: SendQueue,
  config: EngineConfig,
  input: {
    dispatch: DispatchRow;
    operatorId: string | null;
    allowHtmlBlocks: boolean;
    /** Split Tests, Cohort Sampling and Smart Blocks, when their flags are on. */
    features?: SendFeatures;
    /** Asked to go at each reader's best time. Ignored while features.bestTime is off. */
    bestTime?: boolean;
    now?: number;
  },
): Promise<{ broadcastId: string }> {
  const { dispatch } = input;
  if (dispatch.status !== 'draft' && dispatch.status !== 'scheduled') {
    throw new StartError(
      'wrong_status',
      dispatch.status === 'sending'
        ? 'This post is already being sent.'
        : dispatch.status === 'sent'
          ? "A sent post can't be sent again."
          : `A ${dispatch.status} post can't be sent.`,
    );
  }
  if (dispatch.imported_at != null) throw new StartError('wrong_status', PAST_ISSUE_NOT_SENT);
  // A slug another Dispatch takes between planning and the batch is retried with a fresh one.
  for (let attempt = 0; ; attempt++) {
    const slug = await planSlug(db, dispatch);
    try {
      return await startOnce(db, queue, config, input, slug);
    } catch (error) {
      if (error instanceof SlugRace && attempt < 3) continue;
      if (error instanceof SlugRace) {
        throw new StartError('already_sending', 'This post is already being sent.');
      }
      throw error;
    }
  }
}

class SlugRace extends Error {}

async function startOnce(
  db: D1Database,
  queue: SendQueue,
  config: EngineConfig,
  input: {
    dispatch: DispatchRow;
    operatorId: string | null;
    allowHtmlBlocks: boolean;
    features?: SendFeatures;
    bestTime?: boolean;
    now?: number;
  },
  slug: SlugPlan,
): Promise<{ broadcastId: string }> {
  const { dispatch } = input;
  const webUrl =
    dispatch.web_visibility === 'paid' ? await webUrlFor(db, config, dispatch, slug) : null;
  // Flag off: a send scheduled with this choice goes as a normal send.
  const bestTime = !!input.bestTime && !!input.features?.bestTime;
  const check = await preflight(db, config, dispatch, {
    allowHtmlBlocks: input.allowHtmlBlocks,
    webUrl,
    bestTime,
    ...(input.features ? { features: input.features } : {}),
  });
  if (!check.ready || !check.template) {
    throw new StartError(
      'not_ready',
      'The post is not ready to send.',
      check.checks.filter((c) => !c.ok),
    );
  }

  const now = input.now ?? Date.now();
  const broadcastId = newIdFor('broadcast', now);
  const ramp = await ensureRamp(db, check.channel.id, check.sender.sendingDomainId, now);
  const { template, teaser, channel } = check;
  // Split Test variants with their own render (content, or a different preheader) are frozen
  // now; their links join the Broadcast's link targets after the Dispatch's own.
  const allLinks = [...template.links];
  const renders = new Map<string, { html: string; text: string }>();
  const plan = check.holdBackPlan;
  if (plan.split && check.renderInput) {
    for (const variant of plan.split.variants) {
      if (variant.label === 'A') continue;
      const own =
        plan.split.test.variable === 'content'
          ? { content: JSON.parse(variant.content_json ?? 'null') as unknown }
          : variant.preheader !== null && variant.preheader !== dispatch.preheader && !teaser
            ? { preheader: variant.preheader }
            : null;
      if (!own) continue;
      try {
        const rendered = await renderForWorkspace({ ...check.renderInput, ...own });
        const merged = appendLinks(allLinks, rendered);
        renders.set(variant.id, { html: merged.html, text: merged.text });
      } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        throw new StartError('not_ready', 'The post is not ready to send.', [
          { key: 'test', ok: false, message: `Variant ${variant.label}: ${error.message}` },
        ]);
      }
    }
  }
  // The search index holds the snippet as this send used it; the site reads the current one.
  const withSnippets = await resolveSnippetsJson(
    db,
    channel.id,
    dispatch.content_json,
    check.renderInput?.snippets,
  );
  const usesSnippets = withSnippets !== dispatch.content_json;
  try {
    await db.batch([
      ...frozenBroadcastStatements(db, {
        broadcastId,
        dispatch,
        check: { ...check, template },
        links: allLinks,
        rampId: ramp.id,
        operatorId: input.operatorId,
        now,
        status: 'queued',
        kind: 'broadcast',
        flowId: null,
      }),
      ...holdBackStartStatements(db, {
        broadcastId,
        now,
        split: plan.split,
        sample: plan.sample,
        renders,
      }),
      // check.bestTime is null when the flag is off or the publication doesn't profile readers.
      ...(bestTime && check.bestTime
        ? [
            db
              .prepare('UPDATE broadcasts SET best_time = ?1 WHERE id = ?2')
              .bind(fitsWarmUp(ramp, check.recipientCount, now) ? 1 : 2, broadcastId),
          ]
        : []),
      db
        .prepare(
          `UPDATE dispatches SET status = 'sending', publish_at = NULL, best_time = 0, start_attempts = 0,
                  start_retry_at = NULL, updated_at = ?1 WHERE id = ?2 AND status IN ('draft', 'scheduled')`,
        )
        .bind(now, dispatch.id),
      // The stored preview of a sent post shows the snippets it went out with.
      ...(usesSnippets
        ? [
            db
              .prepare('UPDATE dispatches SET html = ?1, text = ?2 WHERE id = ?3')
              .bind(previewHtml(teaser ?? template), (teaser ?? template).text, dispatch.id),
          ]
        : []),
      // The Dispatch goes on the web as it starts sending, in the same batch.
      ...publicationStatements(db, {
        dispatch: { ...dispatch, content_json: withSnippets },
        channelName: channel.name,
        slug,
        now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (slug.isNew && /dispatch_slugs/.test((error as Error).message)) throw new SlugRace();
      throw new StartError('already_sending', 'This post is already being sent.');
    }
    throw error;
  }
  await queue.send({ type: 'snapshot', broadcastId });
  return { broadcastId };
}

/**
 * The statements that freeze a render into a Broadcast: the broadcasts row (html, text, sender,
 * frozen audience, teaser) and its link_targets, positioned as {{@link:N}} refers to them.
 * Shared by startBroadcast (status 'queued', kind 'broadcast') and Flow publishing
 * (publishFlowVersion: status 'sending', kind 'flow', one per send_email node), so every email
 * Swarm sends is frozen the same way.
 */
export function frozenBroadcastStatements(
  db: D1Database,
  input: {
    broadcastId: string;
    dispatch: Pick<DispatchRow, 'id' | 'subject' | 'preheader'>;
    check: Pick<PreflightResult, 'teaser' | 'split' | 'sender' | 'channel' | 'audience'> & {
      template: RenderedTemplate;
    };
    rampId: string;
    operatorId: string | null;
    now: number;
    status: 'queued' | 'sending';
    kind: 'broadcast' | 'flow';
    flowId: string | null;
    /** Every link of every render (Split Test variants append theirs); default the template's. */
    links?: string[];
  },
): D1PreparedStatement[] {
  const { broadcastId, dispatch, now } = input;
  const { template, teaser, split, sender, channel, audience } = input.check;
  // Positions are what {{@link:N}} refers to in the frozen template.
  const links = (input.links ?? template.links).map((url, position) => ({
    id: newIdFor('linkTarget', now),
    url,
    position,
  }));
  return [
    db
      .prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
           from_name, from_address, reply_to, sending_domain_id, ramp_id, track_opens, created_by, created_at, last_progress_at,
           audience_json, teaser_html, teaser_text, gate_level_ids_json, kind, flow_id, track_clicks)
         VALUES (?1, ?2, ?3, ?4, ?21, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19, ?20, ?22, ?23, ?24)`,
      )
      .bind(
        broadcastId,
        dispatch.id,
        channel.id,
        channel.workspace_id,
        dispatch.subject,
        dispatch.preheader,
        template.html,
        template.text,
        sender.name,
        sender.address,
        sender.replyTo,
        sender.sendingDomainId,
        input.rampId,
        channelSettings(channel.settings_json).trackOpens ? 1 : 0,
        input.operatorId,
        now,
        // The Circles' rules as counted, so editing a Circle mid-send can't change who gets it.
        JSON.stringify(audience),
        // A gated paid Dispatch: the teaser, and the Gate's levels as counted, for the snapshot.
        teaser?.html ?? null,
        teaser?.text ?? null,
        teaser && split ? JSON.stringify(split.levelIds) : null,
        input.status,
        input.kind,
        input.flowId,
        channelSettings(channel.settings_json).trackClicks ? 1 : 0,
      ),
    ...links.map((link) =>
      db
        .prepare(
          'INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(link.id, broadcastId, link.url, link.position),
    ),
  ];
}

/**
 * Dispatches whose scheduled time has come. A deleted Channel's stay scheduled and wait: nobody
 * can reach them to unschedule, and a restore decides what happens to them. One that failed to
 * start waits for its retry time, and one workspace fills at most `perWorkspace` of the window,
 * so rows that keep failing can't stop other workspaces' posts from starting.
 */
export async function dueDispatches(
  db: D1Database,
  now = Date.now(),
  limit = 25,
  perWorkspace = 10,
): Promise<DispatchRow[]> {
  return all<DispatchRow>(
    db,
    `WITH due AS (
       SELECT d.id, d.publish_at,
              row_number() OVER (PARTITION BY c.workspace_id ORDER BY d.publish_at, d.id) AS n
         FROM dispatches d JOIN channels c ON c.id = d.channel_id
        WHERE d.status = 'scheduled' AND d.publish_at <= ?1 AND c.deleted_at IS NULL
          AND (d.start_retry_at IS NULL OR d.start_retry_at <= ?1))
     SELECT d.* FROM due JOIN dispatches d ON d.id = due.id
      WHERE due.n <= ?3 ORDER BY due.publish_at, due.id LIMIT ?2`,
    now,
    limit,
    perWorkspace,
  );
}
