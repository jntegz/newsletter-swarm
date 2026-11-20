// Security notices to a workspace's owners (and, where it matters, admins): changes to who can
// sign people in, and standing feeds of the workspace's data. Sent through the same path as
// QuickPass mail; a mail outage never stops the change itself, which is audited either way.
import { all } from '@swarm/db';
import { PRODUCT_NAME, type SeatRole } from '@swarm/domain';
import type { Logger } from '@swarm/runtime';
import type { ApiEnv } from '../env';
import { mailer, teamMail } from './mail';

export interface TeamNotice {
  /** Mail category, for delivery logs. */
  category: string;
  subject: string;
  heading: string;
  /** Plain sentences; values in them are escaped by the mail frame. */
  lines: string[];
  /** A dashboard path the button opens (it changes nothing by itself). */
  path: string;
  label: string;
}

/**
 * Mails `notice` to every seat holder in `workspaceId` with one of `roles`, except `skipOperatorId`
 * (usually whoever made the change). Returns how many were sent.
 */
export async function noticeTeam(
  e: ApiEnv,
  log: Pick<Logger, 'warn'>,
  workspaceId: string,
  roles: readonly SeatRole[],
  notice: TeamNotice,
  skipOperatorId: string | null = null,
): Promise<number> {
  const people = await all<{ email: string }>(
    e.DB,
    `SELECT o.email FROM seats st JOIN operators o ON o.id = st.operator_id
      WHERE st.workspace_id = ?1 AND st.role IN (SELECT value FROM json_each(?2))
        AND st.operator_id <> ?3`,
    workspaceId,
    JSON.stringify(roles),
    skipOperatorId ?? '',
  );
  const url = new URL(notice.path, e.APP_ORIGIN).toString();
  let sent = 0;
  for (const { email } of people) {
    try {
      await mailer(e).send({
        category: notice.category,
        from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
        to: email,
        subject: notice.subject,
        text: `${notice.lines.join('\n\n')}\n\n${url}`,
        html: teamMail(notice.subject, {
          heading: notice.heading,
          paragraphs: notice.lines,
          button: { url, label: notice.label },
          footnote: 'The button opens the dashboard. It changes nothing by itself.',
        }),
      });
      sent++;
    } catch (error) {
      log.warn('team notice failed', {
        category: notice.category,
        error: (error as Error).message,
      });
    }
  }
  return sent;
}
