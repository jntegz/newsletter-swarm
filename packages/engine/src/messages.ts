/**
 * The emails an owner can reword (packages/domain/src/p8-messages.ts). Every caller builds its own
 * built-in version first and passes it here as the fallback. Anything wrong with the owner's version
 * (the flag off, a failed read, a render error) sends the built-in one, so a confirmation always
 * goes out.
 */
import {
  messageDefinition,
  messageProblem,
  type MessageKey,
  type SaveMessage,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { escapeHtml, systemEmail } from '@swarm/mail';
import { first } from './db';

/**
 * Member-facing transactional mail: the Channel's name, its accent, one button. Drawn in the
 * same frame as a Dispatch (systemEmail in @swarm/mail), so it reads in Outlook, on a phone and
 * in dark mode; the first paragraph is also the inbox preview line.
 */
export function memberMail(input: {
  channelName: string;
  accent: string;
  heading: string;
  paragraphs: string[];
  /** Left out for a message with nothing to do (a request outcome). */
  button?: { label: string; url: string };
  footnote: string;
}): { html: string; text: string } {
  const html = systemEmail({
    title: input.heading,
    brand: input.channelName,
    accent: input.accent,
    heading: input.heading,
    paragraphs: input.paragraphs,
    ...(input.button ? { button: input.button } : {}),
    footnote: input.footnote,
  });
  const button = input.button ? `${input.button.label}: ${input.button.url}\n\n` : '';
  const text = `${input.channelName}\n\n${input.heading}\n\n${input.paragraphs.join('\n\n')}\n\n${button}${input.footnote}\n`;
  return { html, text };
}

export interface ComposedMessage {
  subject: string;
  html: string;
  text: string;
}

export type MessageVariables = Record<string, string>;

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

const fill = (template: string, values: MessageVariables, escape: boolean) =>
  template.replace(VARIABLE, (_, name: string) => {
    // Own names only: {{constructor}} must not find Object.prototype's.
    const value = Object.hasOwn(values, name) ? (values[name] ?? '') : '';
    return escape ? escapeHtml(value) : value;
  });

/** A subject is one header line, whatever a value holds. */
const cleanSubject = (subject: string) => subject.replace(/[\r\n]+/g, ' ').trim();

function htmlToText(html: string): string {
  return html
    .replace(/<(style|title|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MessageWording {
  subject: string;
  mode: 'text' | 'html';
  heading: string;
  body: string;
  buttonLabel: string;
}

/** The email an owner's wording makes, with these values. Also what the preview shows. */
export function renderMessage(
  key: MessageKey,
  wording: MessageWording,
  input: { channelName: string; accent: string; variables: MessageVariables },
): ComposedMessage {
  const def = messageDefinition(key);
  const values = input.variables;
  const subject = cleanSubject(fill(wording.subject, values, false));
  if (wording.mode === 'html') {
    const html = fill(wording.body, values, true);
    const url = values[def.link] ?? '';
    const text = htmlToText(html);
    return { subject, html, text: text.includes(url) ? `${text}\n` : `${text}\n\n${url}\n` };
  }
  const paragraphs = fill(wording.body, values, false)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const mail = memberMail({
    channelName: input.channelName,
    accent: input.accent,
    heading: fill(wording.heading, values, false),
    paragraphs,
    button: { label: fill(wording.buttonLabel, values, false), url: values[def.link] ?? '' },
    footnote: fill(def.footnote, values, false),
  });
  return { subject, ...mail };
}

/** The built-in wording of a message, as the editor shows it. */
export function builtInWording(key: MessageKey): MessageWording {
  const def = messageDefinition(key);
  return {
    subject: def.subject,
    mode: 'text',
    heading: def.heading,
    body: def.body,
    buttonLabel: def.button,
  };
}

interface MessageRow {
  subject: string;
  mode: 'text' | 'html';
  heading: string;
  body: string;
  button_label: string;
}

const flagOn = (db: D1Database, workspaceId: string | null | undefined, channelId: string) =>
  new FlagService(new D1FlagStore(db)).enabled('message_templates', {
    workspaceId: workspaceId ?? '',
    channelId,
  });

async function savedWording(
  db: D1Database,
  key: MessageKey,
  channelId: string,
  workspaceId?: string | null,
): Promise<MessageWording | null> {
  const workspace =
    workspaceId ??
    (
      await first<{ workspace_id: string }>(
        db,
        'SELECT workspace_id FROM channels WHERE id = ?1',
        channelId,
      )
    )?.workspace_id;
  if (!(await flagOn(db, workspace, channelId))) return null;
  const row = await first<MessageRow>(
    db,
    'SELECT subject, mode, heading, body, button_label FROM channel_messages WHERE channel_id = ?1 AND key = ?2',
    channelId,
    key,
  );
  if (!row) return null;
  const wording = {
    subject: row.subject,
    mode: row.mode,
    heading: row.heading,
    body: row.body,
    buttonLabel: row.button_label,
  };
  // Rules can tighten after a message was saved: an email that breaks them isn't sent.
  return messageProblem(key, wording as SaveMessage) ? null : wording;
}

/** The owner's version of this email if they have a working one, else the fallback. */
export async function composeMessage(
  db: D1Database,
  input: {
    key: MessageKey;
    channelId: string;
    workspaceId?: string | null;
    channelName: string;
    accent: string;
    variables: MessageVariables;
    fallback: ComposedMessage;
  },
): Promise<ComposedMessage> {
  try {
    const wording = await savedWording(db, input.key, input.channelId, input.workspaceId);
    return wording ? renderMessage(input.key, wording, input) : input.fallback;
  } catch (error) {
    // The kind of error only: its text can carry what was being rendered. This line goes to
    // the console directly (the engine has no logger), so nothing redacts it.
    console.warn('message fell back to the built-in wording', {
      key: input.key,
      channelId: input.channelId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return input.fallback;
  }
}

/** Whether an optional message (a receipt) has been saved and so should go out. */
export async function messageIsSaved(
  db: D1Database,
  key: MessageKey,
  channelId: string,
  workspaceId?: string | null,
): Promise<boolean> {
  try {
    return (await savedWording(db, key, channelId, workspaceId)) !== null;
  } catch {
    return false;
  }
}

/** Claims a one-time send; false when this event already mailed. */
export async function claimMessageSend(db: D1Database, dedupeKey: string, now: number) {
  const row = await first<{ dedupe_key: string }>(
    db,
    `INSERT INTO message_send_log (dedupe_key, created_at) VALUES (?1, ?2)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
    dedupeKey,
    now,
  );
  return row !== null;
}
