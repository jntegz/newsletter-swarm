/**
 * What an undeliverable email says about the address. Pure: the provider's fields in, a kind and a
 * cause out. Every provider's event is first mapped onto SES's shape (feedback.ts for Resend,
 * Mailgun and Postmark, smtp-feedback.ts for a person's own mail server), so this is the one place
 * that decides. Contract: docs/deliverability.md "Bounces".
 *
 * - hard: the address will never work: no such mailbox, no such domain, or the email service
 *   refuses it because of an earlier hard bounce (its own list).
 * - soft: it may work later: a full or switched-off mailbox, an email too large, greylisting, a
 *   temporary error.
 * - blocked: the receiving server refused because of the sender (reputation, a blocklist, the
 *   content, SPF/DKIM/DMARC, sending too fast, its own policy), not because of the address.
 * - ignored: not a bounce (an auto-reply, a challenge email, the provider's own housekeeping).
 *
 * The signals, strongest first:
 *  1. The provider's own types for things that are not bounces, for its own suppression list, and
 *     for blocks (Postmark Blocked/DMARCPolicy, SES ContentRejected, Mailgun espblock).
 *  2. The receiving server's words: blocklist names, "unauthenticated", "over quota",
 *     "greylisted", "user unknown", "domain not found"...
 *  3. The enhanced status code (RFC 3463): X.1.1 bad mailbox, X.1.2 bad domain, X.2.2 mailbox full,
 *     X.2.1 mailbox disabled, X.3.4 too large, X.6.x content, X.7.x security or policy.
 *  4. The basic SMTP code (RFC 5321): 4xx temporary, 552 storage, 521 and 556 no mail at all.
 *  5. The provider's own call: SES NoEmail, Postmark HardBounce, Permanent or Transient.
 *
 * Hard needs a permanent signal and nothing that says "temporary": a 4.x.x code, a Transient
 * bounce type or Mailgun giving up after retries. When unsure, it is soft.
 */
import type { BounceCause, BounceKind } from '@swarm/domain';

export interface BounceSignals {
  /** SES bounceType, or the mapped one: Permanent, Transient, Undetermined. */
  bounceType?: string | undefined;
  /** SES/Resend bounceSubType, Postmark Type or Mailgun reason. */
  bounceSubType?: string | undefined;
  /** The recipient's status: an enhanced code (5.1.1) or a basic SMTP code (550). */
  status?: string | undefined;
  /** What the receiving server said (SES diagnosticCode, Mailgun message, Postmark Details). */
  diagnostic?: string | undefined;
}

export type BounceClassification =
  | { kind: BounceKind; cause: BounceCause; code: string | null }
  | { kind: 'ignored'; cause: null; code: string | null };

const lower = (value: string | undefined) => value?.trim().toLowerCase() ?? '';

/** Postmark records and other provider types that are not about a failed delivery. */
const NOT_BOUNCES = new Set([
  'autoresponder',
  'subscribe',
  'unsubscribe',
  'addresschange',
  'challengeverification',
  'openrelaytest',
  'smtpapierror',
  'inbounderror',
  'templaterenderingfailed',
]);

/** The email service refused to send because of its own list (an earlier hard bounce). */
const PROVIDER_LISTS = new Set([
  'onaccountsuppressionlist', // SES
  'suppressed', // SES global list, Resend's list
  'suppress-bounce', // Mailgun
  'suppress-unsubscribe',
  'suppress-complaint',
  'manuallydeactivated', // Postmark
]);

/** Provider types that already say the sender, not the address, was refused. */
const BLOCK_TYPES: Record<string, BounceCause> = {
  blocked: 'policy', // Postmark: "ISP block"
  dmarcpolicy: 'authentication', // Postmark
  spamnotification: 'content', // Postmark: delivered, then filtered
  virusnotification: 'content',
  contentrejected: 'content', // SES and Resend
  attachmentrejected: 'content',
  espblock: 'policy', // Mailgun
};

/** Subtypes that mean "temporary" whatever the bounce type says. */
const TEMPORARY_TYPES = new Set([
  'transient',
  'softbounce',
  'dnserror',
  'old', // Mailgun: still failing when its retries ran out
  'mailboxfull',
  'messagetoolarge',
]);

/** The provider's own cause, used when the server's words and codes say nothing clearer. */
const SUBTYPE_CAUSE: Record<string, BounceCause> = {
  noemail: 'no_mailbox', // SES
  bademailaddress: 'no_mailbox', // Postmark: not a valid address
  hardbounce: 'rejected', // Postmark
  mailboxfull: 'mailbox_full', // SES
  messagetoolarge: 'too_large', // SES
  dnserror: 'temporary', // Postmark
  old: 'temporary', // Mailgun
};

/**
 * The receiving server's words, in the order they are tried. A block is about the sender, so it
 * is read before anything about the address; "mailbox full" before "mailbox not found".
 */
const BLOCK_WORDS: [BounceCause, RegExp][] = [
  [
    'blocklist',
    /spamhaus|spamcop|barracuda|sorbs|surbl|uribl|invaluement|abuseat|\b(?:cbl|pbl|sbl|xbl|dbl|zen|dnsbl|rbl)\b|block ?list|black ?list|blacklisted|listed (?:at|on|in|by)\b|\bs3150\b|\bs3140\b/,
  ],
  [
    'authentication',
    /dmarc|\bspf\b|dkim|unauthenticated|not authenticated|authentication (?:fail|required|check|result)|5\.7\.2[3-7]\b|5\.7\.509\b|5\.7\.515\b|ptr record|reverse dns|\brdns\b|sender (?:address )?(?:is )?not authori[sz]ed/,
  ],
  [
    'content',
    /\bcontent\b|virus|malware|phish|attachment|security issue|likely unsolicited|looks like spam|(?:considered|classified|identified|detected|rejected|flagged) as (?:spam|junk|bulk)|spam message|message .{0,20}(?:spam|junk) (?:filter|score)|5\.7\.0 .{0,40}blocked/,
  ],
  [
    'reputation',
    /reputation|unsolicited|\bspam\b|\bjunk\b|\bbulk\b|sender score|\bbanned\b|5\.7\.(?:606|708|511|512)\b|not accepting (?:mail|email|messages) from|(?:has been|is|was|are) blocked|blocked (?:due|because|for|by)|\bip\b.{0,40}\bblock/,
  ],
  [
    'rate_limited',
    /rate.?limit|too many (?:messages|connections|recipients|emails|mails)|throttl|deferred due to|unexpected volume|\btss?0\d\b/,
  ],
];

const FULL_WORDS =
  /over ?quota|quota (?:exceeded|exceed)|exceeds? (?:the |their |its |his |her )?(?:storage|quota)|mailbox (?:is )?full|mailbox (?:has )?exceeded|insufficient storage|out of (?:storage|space)|not enough (?:storage|space)|storage (?:limit|allocation)|quotaexceeded|mailbox size limit|user is over/;
const TOO_LARGE_WORDS =
  /too large|too big|message size|size exceeds|exceeds (?:the )?(?:maximum|message|size)|message length exceeds/;
const GREYLIST_WORDS = /gr[ea]y ?list/;
const NO_DOMAIN_WORDS =
  /domain (?:name )?not found|no such domain|domain (?:does not|doesn't|did not) exist|host (?:or domain name )?not found|host unknown|unrouteable|unroutable|no mx\b|mx (?:record )?not found|nxdomain|name service error|bad destination system|domain .{0,40}(?:does not|doesn't) (?:exist|accept)|does not accept mail/;
const NO_MAILBOX_WORDS =
  /user ?unknown|unknown user|no such (?:user|mailbox|recipient|account|address)|(?:mailbox|account|user|address|recipient|email account) (?:does not|doesn't|did not|didn't|that you tried to reach does not) exist|does not exist|doesn't exist|recipient not found|user not found|mailbox not found|address not found|unknown (?:recipient|mailbox|address)|invalid (?:recipient|mailbox|address|email)|address rejected: (?:user|unknown|not found|undeliverable)|recipientnotfound|\bno mailbox\b|(?:does not|doesn't) have an? .{0,30}account|account (?:has been )?(?:deleted|closed|terminated|removed)|no longer (?:valid|exists)|not a valid (?:mailbox|address|user|recipient)|bad (?:mailbox|address|recipient)|recipient address rejected: access denied|as\(201806281\)/;
const UNAVAILABLE_WORDS =
  /disabled|inactive|suspended|deactivated|account (?:is )?(?:locked|frozen|unavailable)|mailbox (?:is )?(?:locked|frozen|temporarily unavailable)|temporarily (?:unavailable|disabled)|receiving mail at a rate|not accepting (?:mail|email|messages)(?! from)/;
const RELAY_WORDS =
  /relay(?:ing)? (?:access )?(?:denied|not permitted)|not permitted to relay|unable to relay|we do not relay/;
const POLICY_WORDS =
  /\bpolic(?:y|ies)\b|not allowed|not permitted|prohibited|administrative|access denied|\brefused\b/;

/** Enhanced status codes not glued to an IP address ("[192.0.2.4]" holds "2.0.2.4"). */
const ENHANCED = /(?<![\d.])([245])\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)/;
/** A basic reply code after "smtp;", a space or a bracket, and not the start of an IP address. */
const BASIC = /(?:^|[\s;:([])([245]\d\d)(?=[\s\-,:;)\]]|\.(?!\d)|$)/;

interface Code {
  enhanced: [number, number, number] | null;
  basic: number | null;
  text: string | null;
}

function readCode(status: string, diagnostic: string): Code {
  const enhanced = ENHANCED.exec(status) ?? ENHANCED.exec(diagnostic);
  const basic = BASIC.exec(status) ?? BASIC.exec(diagnostic);
  const parts = enhanced
    ? ([Number(enhanced[1]), Number(enhanced[2]), Number(enhanced[3])] as [number, number, number])
    : null;
  return {
    enhanced: parts,
    basic: basic ? Number(basic[1]) : null,
    text: enhanced ? enhanced.slice(1, 4).join('.') : basic ? basic[1]! : null,
  };
}

export function classifyBounce(signals: BounceSignals): BounceClassification {
  const type = lower(signals.bounceType);
  const sub = lower(signals.bounceSubType);
  const words = lower(signals.diagnostic);
  const code = readCode(lower(signals.status), words);
  const result = (kind: BounceKind, cause: BounceCause): BounceClassification => ({
    kind,
    cause,
    code: code.text,
  });

  if (NOT_BOUNCES.has(sub)) return { kind: 'ignored', cause: null, code: code.text };
  if (PROVIDER_LISTS.has(sub)) return result('hard', 'provider_list');

  const codeClass = code.enhanced?.[0] ?? (code.basic ? Math.floor(code.basic / 100) : null);
  const temporary = type === 'transient' || TEMPORARY_TYPES.has(sub) || codeClass === 4;
  const permanent = !temporary && (type === 'permanent' || codeClass === 5);

  const blockType = BLOCK_TYPES[sub];
  if (blockType) {
    const named = BLOCK_WORDS.find(([, pattern]) => pattern.test(words));
    return result('blocked', named?.[0] ?? blockType);
  }

  // 2. The server's words.
  for (const [cause, pattern] of BLOCK_WORDS) {
    if (pattern.test(words)) return result('blocked', cause);
  }
  if (FULL_WORDS.test(words)) return result('soft', 'mailbox_full');
  if (TOO_LARGE_WORDS.test(words)) return result('soft', 'too_large');
  if (GREYLIST_WORDS.test(words)) return result('soft', 'greylisted');
  if (NO_DOMAIN_WORDS.test(words)) {
    return permanent ? result('hard', 'no_domain') : result('soft', 'temporary');
  }
  if (NO_MAILBOX_WORDS.test(words)) {
    return permanent ? result('hard', 'no_mailbox') : result('soft', 'temporary');
  }
  if (UNAVAILABLE_WORDS.test(words)) return result('soft', 'mailbox_unavailable');
  if (RELAY_WORDS.test(words)) return result('soft', 'unknown');

  // 3. The enhanced status code.
  if (code.enhanced) {
    const [, subject, detail] = code.enhanced;
    if (subject === 7) {
      return result(
        'blocked',
        [23, 24, 25, 26, 27, 509, 515].includes(detail) ? 'authentication' : 'policy',
      );
    }
    if (subject === 6) return result('blocked', 'content');
    if (subject === 2) {
      if (detail === 2) return result('soft', 'mailbox_full');
      if (detail === 3) return result('soft', 'too_large');
      if (detail === 1) return result('soft', 'mailbox_unavailable');
      return result('soft', 'temporary');
    }
    if (subject === 3 && detail === 4) return result('soft', 'too_large');
    if (subject === 1) {
      if (!permanent) return result('soft', 'temporary');
      if (detail === 2) return result('hard', 'no_domain');
      if ([0, 1, 3, 6, 10].includes(detail)) return result('hard', 'no_mailbox');
    }
    if (subject === 4 && detail === 4) {
      return permanent ? result('hard', 'no_domain') : result('soft', 'temporary');
    }
  }

  // 4. The basic SMTP code.
  if (code.basic && !code.enhanced) {
    if (code.basic === 552) return result('soft', 'mailbox_full');
    if ((code.basic === 521 || code.basic === 556) && permanent) return result('hard', 'no_domain');
  }
  if (POLICY_WORDS.test(words)) return result('blocked', 'policy');

  // 5. The provider's own call.
  const own = SUBTYPE_CAUSE[sub];
  if (own === 'no_mailbox' || own === 'rejected') {
    if (permanent || (!temporary && type !== 'undetermined')) return result('hard', own);
    return result('soft', 'temporary');
  }
  if (own) return result('soft', own);
  if (permanent) return result('hard', 'rejected');
  if (temporary) return result('soft', 'temporary');
  return result('soft', 'unknown');
}
