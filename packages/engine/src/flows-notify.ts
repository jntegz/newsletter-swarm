/**
 * Operator notices from the Flows engine: notify_author nodes and "a run was paused" alerts.
 * Plain transactional mail from the platform address to the Channel's owners and admins (or the
 * operators a node names, when they have a seat in the Channel's workspace).
 */
import { PRODUCT_NAME } from '@swarm/domain';
import { systemEmail, systemLink, type MailAdapter } from '@swarm/mail';
import { all } from './db';
import type { FlowsEnv } from './flows';

/**
 * Owners and admins of the Channel, once each: workspace owner and admin seats, less anyone a
 * per-Channel role lowers below admin there. A Channel role never raises a seat, so it adds no one.
 */
export async function channelAdminEmails(db: D1Database, channelId: string): Promise<string[]> {
  const rows = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o
       JOIN seats s ON s.operator_id = o.id AND s.role IN ('owner', 'admin')
       JOIN channels c ON c.workspace_id = s.workspace_id AND c.id = ?1
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_roles r WHERE r.channel_id = ?1 AND r.operator_id = o.id
           AND r.role NOT IN ('owner', 'admin'))
      ORDER BY o.email LIMIT 50`,
    channelId,
  );
  return rows.map((r) => r.email);
}

/** The listed operators who have a seat in the Channel's workspace (others are ignored). */
export async function operatorEmails(
  db: D1Database,
  channelId: string,
  operatorIds: readonly string[],
): Promise<string[]> {
  if (!operatorIds.length) return [];
  const rows = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o
       JOIN seats s ON s.operator_id = o.id
       JOIN channels c ON c.workspace_id = s.workspace_id AND c.id = ?1
      WHERE o.id IN (SELECT value FROM json_each(?2))
      ORDER BY o.email`,
    channelId,
    JSON.stringify(operatorIds),
  );
  return rows.map((r) => r.email);
}

interface FlowNotice {
  to: readonly string[];
  subject: string;
  /** Plain text paragraphs. */
  lines: readonly string[];
  category: 'flow_notify' | 'flow_paused';
  tags: Record<string, string>;
}

/** Sends one email per recipient. Returns how many were sent (0 without mail configured). */
export async function sendFlowNotice(env: FlowsEnv, notice: FlowNotice): Promise<number> {
  if (!env.notices) return 0;
  return sendOperatorNotice(env.notices, notice);
}

/** A plain notice from the platform address to operators (Flows, Reputation Ramp pauses). */
interface OperatorNotice {
  to: readonly string[];
  subject: string;
  /** Plain text paragraphs. */
  lines: readonly string[];
  category: string;
  tags: Record<string, string>;
}

/**
 * The plain text of an operator notice: its paragraphs, then the product's name on a line of its
 * own as the sign-off (plain words, no dash).
 */
export const operatorNoticeText = (lines: readonly string[]) =>
  `${lines.join('\n\n')}\n\n${PRODUCT_NAME}`;

/** Sends one email per recipient and returns how many were sent. */
export async function sendOperatorNotice(
  notices: { mail: MailAdapter; from: string },
  notice: OperatorNotice,
): Promise<number> {
  if (!notice.to.length) return 0;
  const { mail, from } = notices;
  const text = operatorNoticeText(notice.lines);
  // A line that is only a web address becomes a link; the rest are paragraphs.
  const html = systemEmail({
    title: notice.subject,
    brand: PRODUCT_NAME,
    heading: notice.subject,
    paragraphs: notice.lines.map((line) =>
      /^https?:\/\/\S+$/.test(line) ? systemLink(line) : line,
    ),
  });
  let sent = 0;
  for (const to of notice.to) {
    await mail.send({
      category: notice.category,
      from: { name: PRODUCT_NAME, address: from },
      to,
      subject: notice.subject,
      text,
      html,
      tags: notice.tags,
    });
    sent++;
  }
  return sent;
}
