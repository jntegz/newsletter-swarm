// System emails an owner can reword (flag message_templates): confirmations, sign-in links, payment
// notices. Admin only, because this wording goes out under the publication's name with no review.
//
//   GET    /api/v1/channels/{channelId}/messages              every email, saved or built in
//   PUT    /api/v1/channels/{channelId}/messages/{key}        saves the owner's wording
//   DELETE /api/v1/channels/{channelId}/messages/{key}        back to the built-in wording
//   POST   /api/v1/channels/{channelId}/messages/{key}/preview  the email, with sample values
//   POST   /api/v1/channels/{channelId}/messages/{key}/test   sends that to the person asking
import { createRoute, z } from '@hono/zod-openapi';
import { first, all, run, toIso } from '@swarm/db';
import {
  MESSAGE_KEYS,
  MessageSchema,
  SaveMessageSchema,
  isMessageKey,
  messageDefinition,
  messageProblem,
  type Message,
  type MessageKey,
} from '@swarm/domain';
import { builtInWording, mailAdapter, renderMessage } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, jsonBody, ok } from '../lib/openapi';
import { requireFlag } from '../lib/site';

export const messages = createRouter();

const audit = (
  c: AppContext,
  access: { workspaceId: string; auth: { operatorId: string } },
  action: string,
  channelId: string,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType: 'channel',
    targetId: channelId,
    metadata,
  });

const OFF = 'Editable system emails are not available for this publication.';
const channelParam = z.object({ channelId: z.string() });
const keyParam = channelParam.extend({ key: z.string() });

interface Row {
  key: string;
  subject: string;
  mode: 'text' | 'html';
  heading: string;
  body: string;
  button_label: string;
  updated_at: number;
}

function toMessage(key: MessageKey, row: Row | undefined): Message {
  const def = messageDefinition(key);
  const wording = builtInWording(key);
  return {
    key,
    label: def.label,
    when: def.when,
    variables: Object.keys(def.variables),
    link: def.link,
    textOnly: def.textOnly === true,
    offUntilSaved: def.offUntilSaved === true,
    customized: row !== undefined,
    subject: row?.subject ?? wording.subject,
    mode: row?.mode ?? 'text',
    heading: row?.heading ?? wording.heading,
    body: row?.body ?? wording.body,
    buttonLabel: row?.button_label ?? wording.buttonLabel,
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

const keyOf = (raw: string): MessageKey => {
  if (!isMessageKey(raw)) throw new ApiError('not_found', 'That email doesn’t exist.');
  return raw;
};

async function guard(c: AppContext, channelId: string, role: 'viewer' | 'admin') {
  const access = await requireChannel(c, channelId, role);
  await requireFlag(c, access, 'message_templates', OFF);
  return access;
}

async function channelLook(c: AppContext, channelId: string) {
  const row = await first<{ name: string; branding_json: string }>(
    env(c).DB,
    'SELECT name, branding_json FROM channels WHERE id = ?1',
    channelId,
  );
  const accent = (JSON.parse(row?.branding_json ?? '{}') as { accentColor?: unknown }).accentColor;
  return {
    name: row?.name ?? '',
    accent: typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1',
  };
}

function checked(key: MessageKey, input: z.infer<typeof SaveMessageSchema>) {
  const problem = messageProblem(key, input);
  if (problem) throw new ApiError('invalid_input', problem.message, [problem]);
}

messages.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/messages',
    tags: ['Sending'],
    summary: 'The system emails and their wording',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(MessageSchema), 'Emails'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await guard(c, channelId, 'viewer');
    const rows = await all<Row>(
      env(c).DB,
      `SELECT key, subject, mode, heading, body, button_label, updated_at
         FROM channel_messages WHERE channel_id = ?1`,
      channelId,
    );
    const saved = new Map(rows.map((row) => [row.key, row]));
    return c.json({ data: MESSAGE_KEYS.map((key) => toMessage(key, saved.get(key))) }, 200);
  },
);

messages.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/messages/{key}',
    tags: ['Sending'],
    summary: 'Save your own wording for a system email',
    description:
      'Admin role. Refused when it uses a value the email doesn’t have, or an HTML email leaves out its link or holds scripts, frames, forms or event handlers.',
    request: { params: keyParam, body: jsonBody(SaveMessageSchema) },
    responses: {
      200: ok(MessageSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, key: raw } = c.req.valid('param');
    const input = c.req.valid('json');
    const key = keyOf(raw);
    const access = await guard(c, channelId, 'admin');
    checked(key, input);
    const now = Date.now();
    const row = await first<Row>(
      env(c).DB,
      `INSERT INTO channel_messages (channel_id, key, subject, mode, heading, body, button_label, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (channel_id, key) DO UPDATE SET subject = ?3, mode = ?4, heading = ?5, body = ?6,
         button_label = ?7, updated_by = ?8, updated_at = ?9
       RETURNING key, subject, mode, heading, body, button_label, updated_at`,
      channelId,
      key,
      input.subject,
      input.mode,
      input.heading,
      input.body,
      input.buttonLabel,
      access.auth.operatorId,
      now,
    );
    await audit(c, access, 'channel.message_saved', channelId, {
      key,
      mode: input.mode,
    });
    return c.json({ data: toMessage(key, row ?? undefined) }, 200);
  },
);

messages.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/messages/{key}',
    tags: ['Sending'],
    summary: 'Go back to the built-in wording',
    request: { params: keyParam },
    responses: {
      204: { description: 'Removed' },
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, key: raw } = c.req.valid('param');
    const key = keyOf(raw);
    const access = await guard(c, channelId, 'admin');
    await run(
      env(c).DB,
      'DELETE FROM channel_messages WHERE channel_id = ?1 AND key = ?2',
      channelId,
      key,
    );
    await audit(c, access, 'channel.message_reset', channelId, { key });
    return c.body(null, 204);
  },
);

const RenderedSchema = z.object({ subject: z.string(), html: z.string(), text: z.string() });

messages.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/messages/{key}/preview',
    tags: ['Sending'],
    summary: 'See this wording as an email, with sample values',
    request: { params: keyParam, body: jsonBody(SaveMessageSchema) },
    responses: {
      200: ok(RenderedSchema, 'The email'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, key: raw } = c.req.valid('param');
    const input = c.req.valid('json');
    const key = keyOf(raw);
    await guard(c, channelId, 'admin');
    checked(key, input);
    const look = await channelLook(c, channelId);
    const rendered = renderMessage(key, input, {
      channelName: look.name,
      accent: look.accent,
      variables: { ...messageDefinition(key).variables, channel_name: look.name },
    });
    return c.json({ data: rendered }, 200);
  },
);

messages.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/messages/{key}/test',
    tags: ['Sending'],
    summary: 'Send this wording to yourself, with sample values',
    request: { params: keyParam, body: jsonBody(SaveMessageSchema) },
    responses: {
      202: ok(z.object({ sentTo: z.string() }), 'Sent'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, key: raw } = c.req.valid('param');
    const input = c.req.valid('json');
    const key = keyOf(raw);
    const access = await guard(c, channelId, 'admin');
    checked(key, input);
    const e = env(c);
    const operator = await first<{ email: string }>(
      e.DB,
      'SELECT email FROM operators WHERE id = ?1',
      access.auth.operatorId,
    );
    if (!operator) throw new ApiError('not_found', 'Your account has no email address.');
    const look = await channelLook(c, channelId);
    const rendered = renderMessage(key, input, {
      channelName: look.name,
      accent: look.accent,
      variables: { ...messageDefinition(key).variables, channel_name: look.name },
    });
    await mailAdapter(e, e.PLATFORM_MAIL_DOMAIN).send({
      category: 'message_test',
      from: { name: look.name, address: e.MAIL_FROM },
      to: operator.email,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      tags: { channel: channelId },
    });
    await audit(c, access, 'channel.message_tested', channelId, { key });
    return c.json({ data: { sentTo: operator.email } }, 202);
  },
);
