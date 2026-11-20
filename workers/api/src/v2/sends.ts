// The Direct Send API (/v2, Phase 7): one email to one Member of a Channel, from a Template or an
// existing Dispatch, with per-send variables. Paid plans only, PLAN_LIMITS.directSendsPerDay per
// workspace. Contract: docs/direct-send.md.
//
// Sent synchronously through the MailAdapter, not the send queue: it is one message, the caller
// wants to know at once whether it was accepted, and the queue's batching, Reputation Ramp and
// claim/reaper machinery exist for audiences, not single recipients. With SES it uses its own
// configuration set (SES_DIRECT_CONFIGURATION_SET), so its reputation and event stream stay
// apart from Broadcasts; the events worker maps provider events back to direct_sends.
import { z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  CreateDirectSendSchema,
  DIRECT_SEND_VARIABLE,
  DirectSendListQuerySchema,
  DirectSendSchema,
  PLAN_LIMITS,
  idPattern,
  isPaidPlan,
  newId,
  page,
  type CoverImageRef,
  type DirectSend,
  type DirectSendKind,
  type DirectSendStatus,
} from '@swarm/domain';
import {
  SendingLimitError,
  coverOf,
  loadSendingLimits,
  providerMail,
  quotaResetsAt,
  renderForWorkspace,
  resolveSender,
  sendLimiter,
  smartBlockVisibility,
  turnLimits,
  unsubscribeCode,
  type MailLimiter,
} from '@swarm/engine';
import {
  MailProviderError,
  RenderError,
  escapeHtml,
  personalize,
  unsubscribeHeaders,
  type MailAdapter,
} from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import type { ApiEnv } from '../env';
import { createRouter, env } from '../lib/context';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { engine } from '../lib/send';
import { flagEnabled } from '../lib/site';
import { requireApiChannel, type ApiPrincipal } from './context';
import { v2Route } from './route';

export const sends = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const sendParams = channelParam.extend({
  sendId: z
    .string()
    .regex(idPattern('directSend'))
    .openapi({ param: { name: 'sendId', in: 'path' } }),
});

/**
 * The Direct Send mailer. With SES it uses Direct Send's own configuration set (the env schema
 * requires it with MAIL_ADAPTER=ses); Resend and the dev mailbox have no configuration sets. The
 * provider's own adapter: the route takes its sending-limit turn itself, before it records the
 * send, so a send held back by a limit is answered 429 and never recorded.
 */
function directMailer(e: ApiEnv): MailAdapter {
  if (e.MAIL_ADAPTER !== 'ses') return providerMail(e, e.PLATFORM_MAIL_DOMAIN);
  return providerMail(
    { ...e, SES_CONFIGURATION_SET: e.SES_DIRECT_CONFIGURATION_SET },
    e.PLATFORM_MAIL_DOMAIN,
  );
}

/**
 * A turn from the install's sending limits for one Direct Send: transactional for `transactional`
 * (it may use the whole window and jumps the per-second line), bulk for `one_off`. Either kind can
 * wait (`canWait`): its API client is told Retry-After, so while the email service says its quota
 * is used up the pacer refuses it before anything is recorded. Null when the pacer isn't bound or
 * can't be reached: the send goes ahead, as other mail does.
 */
async function sendingTurn(
  c: Parameters<typeof env>[0],
  kind: DirectSendKind,
): Promise<{ limiter: MailLimiter; at: number } | null> {
  const e = env(c);
  const limiter = sendLimiter(e);
  if (!limiter) return null;
  const at = Date.now();
  let turn;
  try {
    turn = await limiter.turn({
      count: 1,
      priority: kind === 'transactional' ? 'transactional' : 'bulk',
      canWait: true,
      ...turnLimits(await loadSendingLimits(e.DB)),
    });
  } catch (error) {
    c.get('log').warn('send pacer unavailable; direct send goes ahead', {
      error: (error as Error).message,
    });
    return null;
  }
  if (turn.granted === 0) {
    const limit = new SendingLimitError(
      turn.limit ?? 'second',
      turn.resetsAt,
      turn.retryAfterSeconds,
      at,
    );
    c.header('retry-after', String(Math.max(1, turn.retryAfterSeconds)));
    throw new ApiError('rate_limited', limit.message, [
      { path: 'sendingLimit', message: limit.limit },
    ]);
  }
  if (turn.startInMs > 0) await new Promise((resolve) => setTimeout(resolve, turn.startInMs));
  return { limiter, at };
}

interface DirectSendRow {
  id: string;
  channel_id: string;
  member_id: string | null;
  template_id: string | null;
  dispatch_id: string | null;
  kind: DirectSendKind;
  status: DirectSendStatus;
  error: string | null;
  created_at: number;
  sent_at: number | null;
  updated_at: number;
}

const COLUMNS = `id, channel_id, member_id, template_id, dispatch_id, kind, status, error, created_at, sent_at,
  updated_at`;

const toSend = (row: DirectSendRow): DirectSend => ({
  id: row.id,
  channelId: row.channel_id,
  memberId: row.member_id,
  kind: row.kind,
  templateId: row.template_id,
  dispatchId: row.dispatch_id,
  status: row.status,
  error: row.error,
  createdAt: toIso(row.created_at),
  sentAt: row.sent_at === null ? null : toIso(row.sent_at),
  updatedAt: toIso(row.updated_at),
});

/** Midnight UTC today: the daily limit's window. */
export const dayStart = (now: number) => now - (now % 86_400_000);

/** `{{ var.name }}` → the send's value (escaped in HTML); unknown names become empty. */
function fillVariables(input: string, values: Record<string, string>, html: boolean): string {
  return input.replace(DIRECT_SEND_VARIABLE, (_, name: string) => {
    // Own names only: {{ var.constructor }} must not find Object.prototype's.
    const value = Object.hasOwn(values, name) ? (values[name] ?? '') : '';
    return html ? escapeHtml(value) : value;
  });
}

interface Body {
  subject: string;
  preheader: string;
  content: unknown;
  cover: CoverImageRef | null;
  senderIdentityId: string | null;
}

/** The Template (this Channel's or shared with the workspace) or Dispatch to send. */
async function loadBody(
  db: D1Database,
  principal: ApiPrincipal,
  channelId: string,
  input: { templateId?: string | undefined; dispatchId?: string | undefined },
): Promise<Body> {
  if (input.templateId) {
    const row = await first<{
      subject: string;
      preheader: string;
      content_json: string;
      cover_media_id: string | null;
      cover_alt: string;
    }>(
      db,
      `SELECT subject, preheader, content_json, cover_media_id, cover_alt FROM templates
        WHERE id = ?1 AND workspace_id = ?2 AND (channel_id IS NULL OR channel_id = ?3)
          AND kind = 'dispatch' AND deleted_at IS NULL`,
      input.templateId,
      principal.workspaceId,
      channelId,
    );
    if (!row) {
      throw new ApiError('invalid_input', 'That template is not available to this publication.', [
        { path: 'templateId', message: 'Not found in this publication.' },
      ]);
    }
    return {
      subject: row.subject,
      preheader: row.preheader,
      content: JSON.parse(row.content_json),
      cover: coverOf(row),
      senderIdentityId: null,
    };
  }
  const row = await first<{
    subject: string;
    preheader: string;
    content_json: string;
    sender_identity_id: string | null;
    cover_media_id: string | null;
    cover_alt: string;
  }>(
    db,
    'SELECT subject, preheader, content_json, sender_identity_id, cover_media_id, cover_alt FROM dispatches WHERE id = ?1 AND channel_id = ?2',
    input.dispatchId,
    channelId,
  );
  if (!row) {
    throw new ApiError('invalid_input', 'That post is not in this publication.', [
      { path: 'dispatchId', message: 'Not found in this publication.' },
    ]);
  }
  return {
    subject: row.subject,
    preheader: row.preheader,
    content: JSON.parse(row.content_json),
    cover: coverOf(row),
    senderIdentityId: row.sender_identity_id,
  };
}

interface MemberRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  suppressed: number;
}

sends.openapi(
  v2Route('sends:write', {
    method: 'post',
    path: '/v2/channels/{channelId}/sends',
    operationId: 'createDirectSend',
    tags: ['Direct Send'],
    summary: 'Send one email to one Member',
    description:
      'Renders a Template or a Dispatch for one Member of the Channel, fills `{{ var.name }}` from `variables`, and sends it at once. Suppressed addresses are never mailed: the send is recorded with status `suppressed`. `one_off` needs an active Member and carries List-Unsubscribe with One-Click; `transactional` carries no unsubscribe headers. Paid plans only; every accepted request counts against the daily limit. Scope `sends:write`.',
    request: { params: channelParam, body: jsonBody(CreateDirectSendSchema) },
    responses: {
      201: ok(DirectSendSchema, 'Recorded; `status` says whether it was sent'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'insufficient_scope',
        'plan_required',
        'not_found',
        'conflict',
        'rate_limited',
      ),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const principal = await requireApiChannel(c, channelId, 'sends:write');
    if (!isPaidPlan(principal.plan)) {
      throw new ApiError('plan_required', 'The Direct Send API needs a paid plan.');
    }
    const e = env(c);
    const db = e.DB;
    const config = engine(c);

    const member = await first<MemberRow>(
      db,
      `SELECT m.id, m.email, m.first_name, m.last_name, m.status,
              EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?3 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id)) AS suppressed
         FROM members m WHERE m.channel_id = ?1 AND ${'memberId' in input.to ? 'm.id = ?2' : 'm.email = ?2'}`,
      channelId,
      'memberId' in input.to ? input.to.memberId : input.to.email,
      principal.workspaceId,
    );
    if (!member) {
      throw new ApiError(
        'invalid_input',
        'The recipient is not a subscriber of this publication.',
        [{ path: 'to', message: 'Not a subscriber of this publication.' }],
      );
    }

    // Render before recording anything: a body that can't be sent is the caller's error.
    const body = await loadBody(db, principal, channelId, input);
    if (!body.subject.trim()) {
      throw new ApiError('invalid_input', 'The email has no subject.', [
        { path: input.templateId ? 'templateId' : 'dispatchId', message: 'No subject.' },
      ]);
    }
    const channel = (await first<{ slug: string; name: string; branding_json: string }>(
      db,
      'SELECT slug, name, branding_json FROM channels WHERE id = ?1',
      channelId,
    ))!;
    const scope = { workspaceId: principal.workspaceId, channelId };
    let template;
    try {
      template = await renderForWorkspace({
        db,
        workspaceId: principal.workspaceId,
        channelId,
        channelName: channel.name,
        accentColor:
          (JSON.parse(channel.branding_json) as { accentColor?: string | null }).accentColor ??
          null,
        preheader: body.preheader,
        content: body.content,
        cover: body.cover,
        mediaOrigin: config.mediaOrigin,
        allowHtmlBlocks: await flagEnabled(c, scope, 'raw_html_mode'),
      });
    } catch (error) {
      if (!(error instanceof RenderError)) throw error;
      throw new ApiError('invalid_input', error.message, [
        { path: input.templateId ? 'templateId' : 'dispatchId', message: error.message },
      ]);
    }
    const sender = await resolveSender(
      db,
      config,
      { id: channelId, slug: channel.slug, name: channel.name },
      body.senderIdentityId,
    );
    if (sender.problems.length) {
      throw new ApiError('conflict', sender.problems[0]!.message);
    }

    // The compliance gate, as for Broadcasts: a suppressed address is never mailed, and a one-off
    // message needs a Member who is still subscribed.
    const blocked =
      member.suppressed || member.status === 'bounced' || member.status === 'complained'
        ? 'address_suppressed'
        : input.kind === 'one_off' && member.status !== 'active'
          ? 'member_not_active'
          : null;

    // The install's sending limits first: held back, the send is answered 429 and not recorded,
    // so the caller retries it after Retry-After and nothing is lost or counted twice.
    const turn = blocked ? null : await sendingTurn(c, input.kind);
    const giveBack = () => turn?.limiter.release(1, turn.at).catch(() => undefined);

    // Recorded and counted against the day's limit in one statement, so concurrent requests
    // can't both take the last slot.
    const now = Date.now();
    const id = newId('directSend', now);
    const limit = PLAN_LIMITS[principal.plan].directSendsPerDay;
    const inserted = await run(
      db,
      `INSERT INTO direct_sends (id, workspace_id, channel_id, member_id, template_id, dispatch_id, kind, status,
         error, api_key_id, oauth_grant_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
        WHERE (SELECT count(*) FROM direct_sends WHERE workspace_id = ?2 AND created_at >= ?13) < ?14`,
      id,
      principal.workspaceId,
      channelId,
      member.id,
      input.templateId ?? null,
      input.dispatchId ?? null,
      input.kind,
      blocked ? 'suppressed' : 'queued',
      blocked,
      principal.kind === 'key' ? principal.id : null,
      principal.kind === 'oauth' ? principal.id : null,
      now,
      dayStart(now),
      limit,
    );
    if (!inserted.meta.changes) {
      await giveBack();
      c.header('retry-after', String(Math.ceil((dayStart(now) + 86_400_000 - now) / 1000)));
      throw new ApiError(
        'rate_limited',
        `This workspace has sent its ${limit.toLocaleString('en')} Direct Sends for today.`,
      );
    }

    if (!blocked) {
      const hex = id.slice(3);
      // Unsubscribe codes carry a delivery-shaped id; the events and track workers resolve the
      // dn_ twin (unsubscribeDelivery in @swarm/engine).
      const code =
        input.kind === 'one_off'
          ? await unsubscribeCode(config.unsubscribeKeys, `dl_${hex}`)
          : null;
      const unsubscribeUrl = code ? `${config.trackOrigin}/u/${code}` : null;
      const memberCenterUrl =
        config.memberLinks && config.captureOrigin
          ? `${config.captureOrigin}/m/${await config.memberLinks.memberToken(
              { memberId: member.id, channelId },
              { now },
            )}`
          : null;
      const smartBlocks = template.smartBlocks?.length
        ? await smartBlockVisibility(db, channelId, member.id, body.content)
        : undefined;
      const filled = personalize(
        { html: template.html, text: template.text, subject: body.subject },
        {
          ...(smartBlocks ? { smartBlocks } : {}),
          link: (n) => template.links[n] ?? '#',
          // A transactional footer links to Member Center instead of unsubscribing.
          unsubscribeUrl: unsubscribeUrl ?? memberCenterUrl ?? config.trackOrigin,
          ...(memberCenterUrl ? { memberCenterUrl } : {}),
          pixelUrl: null,
          member: { email: member.email, firstName: member.first_name, lastName: member.last_name },
        },
      );
      const variables = input.variables ?? {};
      const fromDomain = sender.address.split('@')[1] as string;
      let outcome: { status: 'sent'; providerId: string } | { status: 'failed'; error: string };
      try {
        const sent = await directMailer(e).send({
          category: 'direct_send',
          from: { name: sender.name, address: sender.address },
          to: member.email,
          replyTo: sender.replyTo ?? sender.address,
          subject: fillVariables(filled.subject, variables, false).replace(/[\r\n]+/g, ' '),
          html: fillVariables(filled.html, variables, true),
          text: fillVariables(filled.text, variables, false),
          messageId: `${id}@${fromDomain}`,
          headers: {
            ...(code && unsubscribeUrl
              ? unsubscribeHeaders(unsubscribeUrl, `unsub+${code}@${config.unsubscribeMailDomain}`)
              : {}),
            'Feedback-ID': `${id}:${channelId}:direct:swarm`,
            'X-Swarm-Direct-Send': id,
          },
          tags: { direct_send: id, channel: channelId },
        });
        outcome = { status: 'sent', providerId: sent.messageId };
      } catch (error) {
        outcome = {
          status: 'failed',
          error: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
        };
        if (error instanceof MailProviderError && (error.retryable || error.quota))
          await giveBack();
        // The service's quota is used up: the pacer is told, so posts and automation emails wait
        // for it and the next Direct Send of either kind is answered 429 with Retry-After before
        // anything is recorded (its turn can wait). Sign-in links and other mail Swarm sends
        // itself are still tried.
        const limiter = turn?.limiter ?? sendLimiter(e);
        if (error instanceof MailProviderError && error.quota && limiter) {
          await limiter
            .block(error.quota, quotaResetsAt(error.quota, Date.now()))
            .catch(() => undefined);
        }
      }
      const done = Date.now();
      await run(
        db,
        `UPDATE direct_sends SET status = ?1, provider_message_id = ?2, error = ?3, sent_at = ?4, updated_at = ?4
          WHERE id = ?5`,
        outcome.status,
        outcome.status === 'sent' ? outcome.providerId : null,
        outcome.status === 'failed' ? outcome.error : null,
        done,
        id,
      );
      if (outcome.status === 'failed') {
        c.get('log').warn('direct send failed', { directSendId: id, error: outcome.error });
      }
    }

    const row = await first<DirectSendRow>(
      db,
      `SELECT ${COLUMNS} FROM direct_sends WHERE id = ?1`,
      id,
    );
    return c.json({ data: toSend(row!) }, 201);
  },
);

sends.openapi(
  v2Route('sends:read', {
    method: 'get',
    path: '/v2/channels/{channelId}/sends',
    operationId: 'listDirectSends',
    tags: ['Direct Send'],
    summary: 'Direct Sends of a Channel, newest first',
    description: 'Scope `sends:read` (or `sends:write`).',
    request: { params: channelParam, query: DirectSendListQuerySchema },
    responses: {
      200: ok(page(DirectSendSchema), 'A page of sends'),
      ...errors('invalid_input', 'unauthorized', 'insufficient_scope', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { cursor, limit, status } = c.req.valid('query');
    await requireApiChannel(c, channelId, 'sends:read');
    const rows = await all<DirectSendRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM direct_sends
        WHERE channel_id = ?1 AND (?2 IS NULL OR id < ?2) AND (?3 IS NULL OR status = ?3)
        ORDER BY id DESC LIMIT ?4`,
      channelId,
      cursor ?? null,
      status ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toSend);
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

sends.openapi(
  v2Route('sends:read', {
    method: 'get',
    path: '/v2/channels/{channelId}/sends/{sendId}',
    operationId: 'getDirectSend',
    tags: ['Direct Send'],
    summary: 'One Direct Send and its status',
    description:
      'Status follows provider events: `sent`, then `delivered`, `bounced` or `complained`. Scope `sends:read` (or `sends:write`).',
    request: { params: sendParams },
    responses: {
      200: ok(DirectSendSchema, 'The send'),
      ...errors('unauthorized', 'insufficient_scope', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, sendId } = c.req.valid('param');
    await requireApiChannel(c, channelId, 'sends:read');
    const row = await first<DirectSendRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM direct_sends WHERE id = ?1 AND channel_id = ?2`,
      sendId,
      channelId,
    );
    if (!row) throw new ApiError('not_found', 'Direct Send not found.');
    return c.json({ data: toSend(row) }, 200);
  },
);
