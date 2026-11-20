/**
 * Bounces and complaints for a person's own mail server, which has no webhooks of its own.
 *
 * - Bounces: posts go out with the return path bounce+<bounce code>@<UNSUBSCRIBE_MAIL_DOMAIN>, and
 *   Email Routing hands the bounce message to the events worker. A relay may replace that return
 *   path, in which case bounces only arrive through the endpoint below. A permanent failure
 *   counts as hard only when bounceIsAuthenticated; otherwise it counts as soft.
 * - Complaints: plain SMTP doesn't report them at all. A server that learns of one can report it to
 *   POST /smtp-feedback, signed like a Svix webhook with SMTP_FEEDBACK_SECRET.
 */
import type { AuthenticatedDomains } from './auth-results';
import { isSharedSendingDomain, organisationalDomain } from './dmarc';
import type { SesEvent } from './feedback';

/** bounce+<code>@domain → the code, or null. */
export function bounceCodeFromAddress(address: string): string | null {
  const match = /^bounce\+([0-9a-f]{32}-[0-9a-f]{20})@/i.exec(address.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The event for a bounce message, or null when it isn't a delivery status report (an auto-reply,
 * say). RFC 3464's Status field says 5.x.x for permanent and 4.x.x for temporary failures. The
 * delivery comes from the signed code, not from anything the message claims.
 */
export function bounceMessageToSesEvent(deliveryId: string, raw: string): SesEvent | null {
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(raw)?.[1];
  const kind = status?.[0];
  if (kind !== '4' && kind !== '5') return null;
  const diagnostic = /^Diagnostic-Code:\s*(.{1,300})/im.exec(raw)?.[1]?.trim();
  // The recipient is the delivery's own address: the report never names one (see the tests).
  return {
    eventType: 'Bounce',
    mail: { tags: { delivery: [deliveryId] } },
    bounce: {
      bounceType: kind === '5' ? 'Permanent' : 'Transient',
      bouncedRecipients: [
        { status: status!, ...(diagnostic ? { diagnosticCode: diagnostic } : {}) },
      ],
    },
  };
}

/**
 * Mailbox domains whose bounce servers authenticate as another domain: Gmail's as google.com,
 * Outlook.com's from protection.outlook.com, Yahoo's under yahoodns.net.
 */
const MAILBOX_BOUNCE_DOMAINS: Record<string, string[]> = {
  'gmail.com': ['google.com', 'googlemail.com'],
  'googlemail.com': ['google.com', 'gmail.com'],
  'outlook.com': ['outlook.com', 'protection.outlook.com'],
  'hotmail.com': ['outlook.com', 'protection.outlook.com'],
  'live.com': ['outlook.com', 'protection.outlook.com'],
  'yahoo.com': ['yahoo.com', 'yahoodns.net'],
};

/**
 * SMTP relays whose bounces (DSNs) authenticate as another domain than the host's: Gmail's and
 * Google Workspace's as google.com or googlemail.com. Microsoft 365 and Fastmail aren't here:
 * see CUSTOMER_RELAY_DOMAINS.
 */
const RELAY_BOUNCE_DOMAINS: Record<string, string[]> = {
  'smtp.gmail.com': ['google.com', 'googlemail.com'],
  'smtp-relay.gmail.com': ['google.com', 'googlemail.com'],
};

/**
 * Domains a relay's customers all pass for, so a DSN one of them writes itself would look like
 * the relay's: Fastmail signs every customer's mail as messagingengine.com, and every Microsoft
 * 365 tenant's mail leaves from protection.outlook.com (outlook.com). Never accepted for SMTP_HOST;
 * an operator who accepts that risk can name one in SMTP_BOUNCE_DOMAINS. Outlook.com's own
 * addresses still accept protection.outlook.com through MAILBOX_BOUNCE_DOMAINS.
 */
const CUSTOMER_RELAY_DOMAINS = ['outlook.com', 'messagingengine.com'];

/**
 * Whether the envelope sender is one a bounce comes from: empty (RFC 5321 says bounces use the
 * null reverse path) or a mailer-daemon or postmaster address. Ordinary users of a big provider
 * pass DKIM for its domain too, but can't send with either.
 */
function isBounceSender(envelopeFrom: string): boolean {
  const from = envelopeFrom.trim().replace(/^<|>$/g, '');
  const at = from.lastIndexOf('@');
  return from === '' || (at > 0 && /^(mailer-daemon|postmaster)$/i.test(from.slice(0, at)));
}

/**
 * Whether a mailed-in bounce authenticates as the server that would really send it: a DKIM or
 * SPF pass (authenticatedDomains) whose organisational domain is the reader's mailbox domain (or
 * its provider's, MAILBOX_BOUNCE_DOMAINS) or the operator's SMTP relay (or the domains it writes
 * bounces as, RELAY_BOUNCE_DOMAINS, but never CUSTOMER_RELAY_DOMAINS), or that is one of
 * relayBounceDomains or under one. The
 * bounce code is in the delivered copy's Return-Path, so anyone with the raw message can mail a
 * report; one that isn't authenticated this way must not count as a hard bounce.
 */
export function bounceIsAuthenticated(input: {
  authenticated: AuthenticatedDomains;
  /** message.from: the envelope MAIL FROM. */
  envelopeFrom: string;
  /** The address the email went to (deliveries.email). */
  recipient: string;
  /** SMTP_HOST, when the operator sends through their own relay. */
  relayHost?: string | undefined;
  /**
   * SMTP_BOUNCE_DOMAINS: domains the relay's bounces authenticate as. Taken as given, not as
   * their organisational domain, so a tenant such as contoso.onmicrosoft.com stays itself.
   */
  relayBounceDomains?: readonly string[] | undefined;
}): boolean {
  if (!isBounceSender(input.envelopeFrom)) return false;
  const accepted = new Set<string>();
  const mailbox = input.recipient
    .slice(input.recipient.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
  if (mailbox.includes('.')) {
    for (const domain of [mailbox, ...(MAILBOX_BOUNCE_DOMAINS[mailbox] ?? [])]) {
      accepted.add(organisationalDomain(domain));
    }
  }
  const relay = input.relayHost?.trim().toLowerCase();
  // A shared service's domain passes for every one of its customers, so it proves nothing.
  if (relay?.includes('.') && !isSharedSendingDomain(relay)) {
    for (const domain of [relay, ...(RELAY_BOUNCE_DOMAINS[relay] ?? [])]) {
      const organisational = organisationalDomain(domain);
      if (!CUSTOMER_RELAY_DOMAINS.includes(organisational)) accepted.add(organisational);
    }
  }
  const named = (input.relayBounceDomains ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.includes('.') && !isSharedSendingDomain(domain));
  const { dkim, spf } = input.authenticated;
  return [...dkim, ...(spf ? [spf] : [])].some(
    (domain) =>
      accepted.has(organisationalDomain(domain)) ||
      named.some((name) => domain === name || domain.endsWith(`.${name}`)),
  );
}

/**
 * A report sent to POST /smtp-feedback as the SES event applySesEvent understands, or null when it
 * isn't valid. `messageId` is the Message-ID Swarm put on the email, with or without angle brackets.
 */
export function smtpFeedbackToSesEvent(payload: unknown): SesEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { type, messageId, detail } = payload as Record<string, unknown>;
  if (typeof messageId !== 'string' || messageId.trim() === '' || messageId.length > 500) {
    return null;
  }
  const mail = { messageId: messageId.trim().replace(/^<|>$/g, '') };
  const diagnostic = typeof detail === 'string' ? detail.slice(0, 300) : undefined;
  const bounce = (bounceType: 'Permanent' | 'Transient'): SesEvent => ({
    eventType: 'Bounce',
    mail,
    bounce: { bounceType, bouncedRecipients: diagnostic ? [{ diagnosticCode: diagnostic }] : [] },
  });
  switch (type) {
    case 'complaint':
      return { eventType: 'Complaint', mail, complaint: {} };
    case 'hard_bounce':
      return bounce('Permanent');
    case 'soft_bounce':
      return bounce('Transient');
    default:
      return null;
  }
}
