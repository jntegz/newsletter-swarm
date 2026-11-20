/**
 * Address checks shared by imports (dry-run classes) and Capture Forms (bot defence):
 * disposable mailbox providers and role accounts. The lists are deliberately short and
 * conservative; they flag, and callers decide whether to refuse.
 */

/** Well-known throwaway mailbox providers. Subdomains match too. */
const DISPOSABLE = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'mailinator.com',
  'mailinator.net',
  'maildrop.cc',
  'mailnesia.com',
  'yopmail.com',
  'yopmail.net',
  'yopmail.fr',
  'trashmail.com',
  'trashmail.de',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'fakeinbox.com',
  'mintemail.com',
  'mohmal.com',
  'emailondeck.com',
  'spamgourmet.com',
  'mytemp.email',
  'moakt.com',
  'burnermail.io',
  'discard.email',
  'mailcatch.com',
  'mail-temp.com',
  'tmpmail.org',
  'tmail.ws',
  'inboxkitten.com',
]);

/** Local parts that reach a team or a system rather than a person. */
const ROLE = new Set([
  'abuse',
  'admin',
  'administrator',
  'billing',
  'compliance',
  'contact',
  'devnull',
  'dns',
  'hello',
  'help',
  'hostmaster',
  'info',
  'jobs',
  'legal',
  'mailer-daemon',
  'marketing',
  'no-reply',
  'noc',
  'noreply',
  'office',
  'postmaster',
  'privacy',
  'root',
  'sales',
  'security',
  'support',
  'team',
  'webmaster',
]);

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

export function isDisposableAddress(email: string): boolean {
  const labels = domainOf(email).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export function isRoleAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase().split('+')[0] ?? '';
  return ROLE.has(local);
}
