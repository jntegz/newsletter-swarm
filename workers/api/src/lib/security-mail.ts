// Account security mail: a sign-in from a new device, and a recovery code used. Sent through the
// same path as QuickPass mail. Links only open pages; nothing changes on a GET.
import { uaFamily } from '@swarm/engine';
import { FIRST_FACTOR_UNDO_DAYS, PRODUCT_NAME } from '@swarm/domain';
import { escapeHtml, type OutgoingMail } from '@swarm/mail';
import type { ApiEnv } from '../env';
import { bold, teamMail } from './mail';

const BROWSER: Record<string, string> = {
  edge: 'Edge',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
};

/** "Chrome on Windows", from the user agent; never the raw string. */
function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = BROWSER[uaFamily(userAgent)] ?? 'A browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

const when = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms)) + ' UTC';

export function newDeviceMail(
  e: ApiEnv,
  to: string,
  sign: { userAgent: string | null; network: string | null; at: number },
): OutgoingMail {
  const subject = `New sign-in to your ${PRODUCT_NAME} account`;
  const devices = new URL('/settings/sessions', e.APP_ORIGIN).toString();
  const device = deviceLabel(sign.userAgent);
  const network = sign.network ? `network ${sign.network}` : 'an unknown network';
  return {
    category: 'new_device',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `${device} signed in to your ${PRODUCT_NAME} account from ${network} on ${when(sign.at)}.\n\nIf this was you, there is nothing to do. If it was not, open your devices, sign that one out and turn on a second factor:\n${devices}`,
    html: teamMail(subject, {
      heading: 'New sign-in',
      paragraphs: [
        {
          html: `${bold(device)} signed in from ${escapeHtml(network)} on ${escapeHtml(when(sign.at))}.`,
        },
        'If this was you, there is nothing to do.',
      ],
      button: { url: devices, label: 'This was not me' },
      footnote:
        'The button opens your devices, where you can sign that one out. It changes nothing by itself.',
    }),
  };
}

export function recoveryCodeUsedMail(
  e: ApiEnv,
  to: string,
  used: { remaining: number; at: number },
): OutgoingMail {
  const subject = `A recovery code was used on your ${PRODUCT_NAME} account`;
  const security = new URL('/settings/security', e.APP_ORIGIN).toString();
  return {
    category: 'recovery_code_used',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `A recovery code was used to sign in to your ${PRODUCT_NAME} account on ${when(used.at)}. ${used.remaining} unused codes are left.\n\nIf it was not you, sign out everywhere and create new recovery codes:\n${security}`,
    html: teamMail(subject, {
      heading: 'Recovery code used',
      paragraphs: [
        `A recovery code was used to sign in on ${when(used.at)}. ${used.remaining} unused codes are left. Each code works once.`,
      ],
      button: { url: security, label: 'Review security' },
      footnote: 'If it was not you, sign out everywhere and create new recovery codes.',
    }),
  };
}

/**
 * To a teammate whose seat someone else changed, naming the workspace: the change also signed
 * them out everywhere. An instance admin is also reminded that a role in a tenant's workspace
 * grants nothing on the install (website code on this Swarm's domain and its DeBounce credits
 * follow Settings > Instance only); any owner can make a teammate an owner without asking.
 */
export function seatRoleChangedMail(
  e: ApiEnv,
  to: string,
  change: {
    workspaceName: string;
    from: string;
    to: string;
    by: string;
    at: number;
    instanceAdmin?: boolean;
  },
): OutgoingMail {
  const subject = `Your role in ${change.workspaceName} changed`;
  const team = new URL('/settings/team', e.APP_ORIGIN).toString();
  const instance = new URL('/settings/instance', e.APP_ORIGIN).toString();
  const what = `${change.by} changed your role in ${change.workspaceName} from ${change.from} to ${change.to} on ${when(change.at)}.`;
  const signedOut = `For safety this signed you out of ${PRODUCT_NAME} on your other devices; sign in again to carry on.`;
  const note = change.instanceAdmin
    ? `You are an instance admin of this ${PRODUCT_NAME}. A role in a workspace does not let it run website code on this ${PRODUCT_NAME}’s domain or use its DeBounce credits: only Settings > Instance does.`
    : null;
  return {
    category: 'seat_role_changed',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `${what}\n\n${signedOut}${note ? `\n\n${note}` : ''}\n\nThe workspace’s team:\n${team}${note ? `\n\nSettings > Instance:\n${instance}` : ''}`,
    html: teamMail(subject, {
      heading: 'Your role changed',
      paragraphs: [
        {
          html: `${bold(change.by)} changed your role in ${bold(change.workspaceName)} from ${escapeHtml(change.from)} to ${bold(change.to)} on ${escapeHtml(when(change.at))}.`,
        },
        signedOut,
        ...(note ? [note] : []),
      ],
      button: { url: team, label: 'Open the team' },
      footnote: 'The button opens the team page. It changes nothing by itself.',
    }),
  };
}

/** What changed, as the account change mail words it. */
export type AccountChange =
  | 'passkey_added'
  | 'passkey_removed'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'recovery_codes_regenerated'
  | 'signed_out_everywhere'
  | 'first_factor_undone';

const ACCOUNT_CHANGE: Record<AccountChange, { heading: string; sentence: string }> = {
  passkey_added: { heading: 'Passkey added', sentence: 'A passkey was added to' },
  passkey_removed: { heading: 'Passkey removed', sentence: 'A passkey was removed from' },
  totp_enabled: {
    heading: 'Authenticator app added',
    sentence: 'An authenticator app was set up on',
  },
  totp_disabled: {
    heading: 'Authenticator app removed',
    sentence: 'The authenticator app was turned off on',
  },
  recovery_codes_regenerated: {
    heading: 'New recovery codes',
    sentence: 'New recovery codes were created (the old ones stopped working) for',
  },
  signed_out_everywhere: {
    heading: 'Signed out everywhere',
    sentence: 'Every other session was signed out of',
  },
  first_factor_undone: {
    heading: 'Second factor removed and signed out',
    sentence:
      'Someone used the “This wasn’t me” link: the second factor added recently was removed and every device was signed out of',
  },
};

/**
 * To the operator, whenever who controls their account changes: a factor added or removed, new
 * recovery codes, or other sessions signed out. Sent to the address on the account, outside any
 * session, so a session someone else holds can't make these changes unnoticed.
 */
export function accountChangeMail(
  e: ApiEnv,
  to: string,
  change: { kind: AccountChange; at: number; first?: boolean; undoUrl?: string },
): OutgoingMail {
  const copy = ACCOUNT_CHANGE[change.kind];
  const subject = `${copy.heading} on your ${PRODUCT_NAME} account`;
  const security = new URL('/settings/security', e.APP_ORIGIN).toString();
  const what = `${copy.sentence} your ${PRODUCT_NAME} account on ${when(change.at)}.`;
  const firstNote = change.first
    ? ' It is the first second factor on the account, so signing in now needs it.'
    : '';
  const advice =
    'If this was not you, sign in with your email link, open Settings > Security, remove what you do not recognise and sign out everywhere. If you can no longer get in, contact the person who runs this Swarm.';
  if (change.undoUrl) {
    // The first factor: a way back for the real person, who may now be locked out by it.
    const undo = `If this wasn't you, use this link within ${FIRST_FACTOR_UNDO_DAYS} days. It removes the factor, signs out every device and asks for a new email sign-in. It works once.`;
    return {
      category: 'account_security_changed',
      from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
      to,
      subject,
      text: `${what}${firstNote}\n\n${undo}\n${change.undoUrl}\n\nIf this was you, there is nothing to do.\n${security}`,
      html: teamMail(subject, {
        heading: copy.heading,
        paragraphs: [`${what}${firstNote}`, undo, 'If this was you, there is nothing to do.'],
        button: { url: change.undoUrl, label: 'This wasn’t me' },
        footnote: 'The button opens a page that asks you to confirm. Nothing changes until you do.',
      }),
    };
  }
  return {
    category: 'account_security_changed',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `${what}${firstNote}\n\n${advice}\n${security}`,
    html: teamMail(subject, {
      heading: copy.heading,
      paragraphs: [`${what}${firstNote}`, 'If this was you, there is nothing to do.'],
      button: { url: security, label: 'Review security' },
      footnote: advice,
    }),
  };
}

/**
 * To an operator whose address a workspace's identity provider tried to sign in, when they hold
 * no seat in that workspace: nothing was signed in, and they hear about the attempt.
 */
export function ssoRefusedMail(
  e: ApiEnv,
  to: string,
  attempt: { workspaceName: string; at: number },
): OutgoingMail {
  const subject = `A single sign-on attempt for your ${PRODUCT_NAME} account was refused`;
  const security = new URL('/settings/security', e.APP_ORIGIN).toString();
  const what = `The identity provider of ${attempt.workspaceName} tried to sign you in on ${when(attempt.at)}. You have no seat in that workspace, so ${PRODUCT_NAME} signed nobody in.`;
  const advice = `If you expected to join ${attempt.workspaceName}, ask one of its admins to invite you. If not, there is nothing to do; your account is unchanged.`;
  return {
    category: 'sso_sign_in_refused',
    from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
    to,
    subject,
    text: `${what}\n\n${advice}\n${security}`,
    html: teamMail(subject, {
      heading: 'Single sign-on refused',
      paragraphs: [what, advice],
      button: { url: security, label: 'Review security' },
      footnote: 'The button opens your security settings. It changes nothing by itself.',
    }),
  };
}
