import { mailAdapter } from '@swarm/engine';
import {
  DevMailbox,
  escapeHtml,
  systemEmail,
  type MailAdapter,
  type OutgoingMail,
  type SystemEmailInput,
} from '@swarm/mail';
import { PRODUCT_NAME } from '@swarm/domain';
import type { ApiEnv } from '../env';

export function mailer(e: ApiEnv): MailAdapter {
  // SES outside development; env validation makes the dev mailbox impossible in production.
  return mailAdapter(e, e.MAIL_FROM.split('@')[1] as string);
}

export function devMailbox(e: ApiEnv): DevMailbox | null {
  return e.DEV_MAILBOX ? new DevMailbox(e.DEV_MAILBOX) : null;
}

/** Bold text inside a paragraph of a teammate email; the value is escaped here. */
export const bold = (value: string) => `<b>${escapeHtml(value)}</b>`;

/**
 * A teammate email: sign-in links, invites, security notices. Drawn in the frame every Swarm
 * email uses (systemEmail in @swarm/mail), so it holds up in Outlook, on a phone and in dark mode.
 * `title` is the subject line.
 */
export function teamMail(
  title: string,
  body: Pick<SystemEmailInput, 'heading' | 'paragraphs' | 'button' | 'footnote'>,
): string {
  return systemEmail({ ...body, title, brand: PRODUCT_NAME });
}

export function quickPassMail(e: ApiEnv, to: string, link: string): OutgoingMail {
  const subject = `Your ${PRODUCT_NAME} sign-in link`;
  return {
    category: 'quickpass',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `Sign in to ${PRODUCT_NAME}:\n\n${link}\n\nThe link works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
    html: teamMail(subject, {
      heading: `Sign in to ${PRODUCT_NAME}`,
      paragraphs: ['Use this link to sign in. It works once and expires in 10 minutes.'],
      button: { url: link, label: 'Sign in' },
      footnote:
        'If you did not ask for this email, you can ignore it. Nobody can sign in without the link.',
    }),
  };
}

/**
 * Sent instead of a sign-in link when an invite-only instance does not know the address, so the
 * QuickPass endpoint answers the same either way and reveals nothing.
 */
export function inviteOnlyMail(e: ApiEnv, to: string): OutgoingMail {
  const subject = `About your ${PRODUCT_NAME} sign-in`;
  return {
    category: 'invite_only',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `Someone asked to sign in to ${PRODUCT_NAME} at ${e.APP_ORIGIN} with this address.

This Swarm is invite-only, and there is no account or pending invite for ${to}. Ask the owner for an invite, then sign in again.

If you did not ask for this email, you can ignore it.`,
    html: teamMail(subject, {
      heading: 'This Swarm is invite-only',
      paragraphs: [
        `Someone asked to sign in at ${e.APP_ORIGIN} with ${to}. There is no account or pending invite for this address.`,
        'Ask the owner for an invite, then sign in again.',
      ],
      footnote: 'If you did not ask for this email, you can ignore it.',
    }),
  };
}

export function inviteMail(
  e: ApiEnv,
  to: string,
  link: string,
  workspaceName: string,
  inviter: string,
  role: string,
): OutgoingMail {
  const subject = `Join ${workspaceName} on ${PRODUCT_NAME}`;
  return {
    category: 'invite',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `${inviter} invited you to ${workspaceName} on ${PRODUCT_NAME} as ${role}.\n\nAccept the invite:\n${link}\n\nThe invite expires in 7 days.`,
    html: teamMail(subject, {
      heading: `Join ${workspaceName}`,
      paragraphs: [
        {
          html: `${escapeHtml(inviter)} invited you to work on ${escapeHtml(workspaceName)} as ${bold(role)}.`,
        },
      ],
      button: { url: link, label: 'Accept invite' },
      footnote: `The invite expires in 7 days. Sign in with ${to} to accept it.`,
    }),
  };
}
