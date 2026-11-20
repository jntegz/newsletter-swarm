// The bounce classifier against samples shaped like what each provider sends: SES (and Resend,
// which reports SES's types), Mailgun, Postmark and a mail server's own delivery status report.
// The texts are the receiving servers' published wording; addresses and IPs are documentation ones.
import { describe, expect, it } from 'vitest';
import { classifyBounce, type BounceSignals } from '../src/bounce-classifier';
import { mailgunToSesEvent, postmarkToSesEvent, resendToSesEvent } from '../src/feedback';
import { bounceMessageToSesEvent } from '../src/smtp-feedback';

type Case = [label: string, signals: BounceSignals, kind: string, cause: string | null];

const ses = (
  bounceType: string,
  bounceSubType: string,
  status?: string,
  diagnostic?: string,
): BounceSignals => ({ bounceType, bounceSubType, status, diagnostic });

const HARD: Case[] = [
  [
    'Gmail: no such user',
    ses(
      'Permanent',
      'General',
      '5.1.1',
      "smtp; 550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces. For more information, go to https://support.google.com/mail/?p=NoSuchUser 41be03b00d2f7-5f3b6b3e1a2si1234567a.12 - gsmtp",
    ),
    'hard',
    'no_mailbox',
  ],
  ['SES: NoEmail without a diagnostic', ses('Permanent', 'NoEmail'), 'hard', 'no_mailbox'],
  [
    'SES: on the account-level suppression list',
    ses(
      'Permanent',
      'OnAccountSuppressionList',
      undefined,
      'Amazon SES did not send the message to this address because it is on the suppression list for your account.',
    ),
    'hard',
    'provider_list',
  ],
  [
    'SES: on the global suppression list',
    ses(
      'Permanent',
      'Suppressed',
      '5.1.1',
      'Amazon SES has suppressed sending to this address because it has a recent history of bouncing as an invalid address.',
    ),
    'hard',
    'provider_list',
  ],
  [
    'Outlook.com: mailbox unavailable, which it says for an address that does not exist',
    ses(
      'Permanent',
      'General',
      '5.5.0',
      'smtp; 550 5.5.0 Requested action not taken: mailbox unavailable (S2017062302) [AM0PR10MB1234.EURPRD10.PROD.OUTLOOK.COM]',
    ),
    'hard',
    'rejected',
  ],
  [
    'Microsoft 365: directory-based edge blocking (the recipient is not in the tenant)',
    ses(
      'Permanent',
      'General',
      '5.4.1',
      'smtp; 550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors [BN8NAM12FT012.eop-nam12.prod.protection.outlook.com 2026-11-12T10:00:00.000Z 08DCF0D1E2A3B4C5]',
    ),
    'hard',
    'no_mailbox',
  ],
  [
    'Microsoft 365: recipient not found',
    ses(
      'Permanent',
      'General',
      '5.1.10',
      'smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient reader@example.org not found by SMTP address lookup',
    ),
    'hard',
    'no_mailbox',
  ],
  [
    'Yahoo: no such account, with no enhanced code',
    ses(
      'Permanent',
      'General',
      undefined,
      "smtp; 554 delivery error: dd This user doesn't have a yahoo.com account (reader@yahoo.com) [0] - mta1234.mail.ne1.yahoo.com",
    ),
    'hard',
    'no_mailbox',
  ],
  [
    'iCloud: user does not exist',
    ses(
      'Permanent',
      'General',
      '5.1.1',
      'smtp; 550 5.1.1 <reader@icloud.com>: user does not exist',
    ),
    'hard',
    'no_mailbox',
  ],
  [
    'Postfix: user unknown in virtual mailbox table, with a 5.7.1 code',
    ses(
      'Permanent',
      'General',
      undefined,
      'smtp; 550 5.7.1 <reader@example.org>: Recipient address rejected: User unknown in virtual mailbox table',
    ),
    'hard',
    'no_mailbox',
  ],
  [
    'A domain that does not exist',
    ses(
      'Permanent',
      'General',
      '5.1.2',
      'smtp; 550 5.1.2 Host unknown (Name server: example.con: host not found)',
    ),
    'hard',
    'no_domain',
  ],
  [
    'Postfix report: host or domain name not found',
    {
      bounceType: 'Permanent',
      status: '5.4.4',
      diagnostic:
        'X-Postfix; Host or domain name not found. Name service error for name=example.con type=A: Host not found',
    },
    'hard',
    'no_domain',
  ],
  [
    'Postmark: HardBounce',
    {
      bounceType: 'Permanent',
      bounceSubType: 'HardBounce',
      diagnostic:
        'smtp;550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient’s email address for typos or unnecessary spaces.',
    },
    'hard',
    'no_mailbox',
  ],
  [
    'Postmark: BadEmailAddress',
    {
      bounceType: 'Permanent',
      bounceSubType: 'BadEmailAddress',
      diagnostic: 'Invalid email address',
    },
    'hard',
    'no_mailbox',
  ],
  [
    'Mailgun: refused after an earlier bounce',
    {
      bounceType: 'Permanent',
      bounceSubType: 'suppress-bounce',
      diagnostic: 'Not delivering to previously bounced address',
    },
    'hard',
    'provider_list',
  ],
  [
    'Resend: on its suppression list',
    {
      bounceType: 'Permanent',
      bounceSubType: 'Suppressed',
      diagnostic:
        "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces.",
    },
    'hard',
    'provider_list',
  ],
  ['A permanent bounce with nothing more said', ses('Permanent', 'General'), 'hard', 'rejected'],
  [
    'A 556: the domain takes no email at all',
    { bounceType: 'Permanent', diagnostic: '556 5.0.0 Domain example.org does not accept mail' },
    'hard',
    'no_domain',
  ],
];

const SOFT: Case[] = [
  [
    'Gmail: out of storage (temporary)',
    ses(
      'Transient',
      'MailboxFull',
      '4.2.2',
      "smtp; 452-4.2.2 The recipient's inbox is out of storage space. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaTemp",
    ),
    'soft',
    'mailbox_full',
  ],
  [
    'Gmail: over quota with a permanent code, still soft',
    ses(
      'Permanent',
      'General',
      '5.2.2',
      'smtp; 552-5.2.2 The email account that you tried to reach is over quota and inactive.',
    ),
    'soft',
    'mailbox_full',
  ],
  [
    'Gmail: account disabled',
    ses(
      'Permanent',
      'General',
      '5.2.1',
      'smtp; 550-5.2.1 The email account that you tried to reach is disabled.',
    ),
    'soft',
    'mailbox_unavailable',
  ],
  [
    'Gmail: the reader gets mail too fast',
    ses(
      'Transient',
      'General',
      '4.2.1',
      'smtp; 450-4.2.1 The user you are trying to contact is receiving mail at a rate that prevents additional messages from being delivered.',
    ),
    'soft',
    'mailbox_unavailable',
  ],
  [
    'Yahoo: message too large',
    ses(
      'Permanent',
      'General',
      undefined,
      'smtp; 554 30 Sorry, your message size exceeds 41943040 bytes.',
    ),
    'soft',
    'too_large',
  ],
  [
    'SES: MessageTooLarge',
    ses(
      'Transient',
      'MessageTooLarge',
      '5.3.4',
      'smtp; 552 5.3.4 Message size exceeds fixed limit',
    ),
    'soft',
    'too_large',
  ],
  [
    'Yahoo: mailbox disabled',
    ses(
      'Permanent',
      'General',
      undefined,
      'smtp; 554 delivery error: dd Sorry your message to reader@yahoo.com cannot be delivered. This mailbox is disabled (554.30). - mta1234.mail.ne1.yahoo.com',
    ),
    'soft',
    'mailbox_unavailable',
  ],
  [
    'Postgrey: greylisted',
    {
      bounceType: 'Transient',
      status: '4.2.0',
      diagnostic:
        '450 4.2.0 <reader@example.org>: Recipient address rejected: Greylisted, see https://postgrey.schweikert.ch/help/example.org.html',
    },
    'soft',
    'greylisted',
  ],
  [
    'A server that cannot be reached',
    {
      bounceType: 'Transient',
      status: '4.4.1',
      diagnostic: 'X-Postfix; connect to mx.example.org[192.0.2.10]:25: Connection timed out',
    },
    'soft',
    'temporary',
  ],
  [
    'Mailgun: still failing when its retries ran out (old)',
    {
      bounceType: 'Permanent',
      bounceSubType: 'old',
      status: '421',
      diagnostic: '4.4.2 Connection dropped',
    },
    'soft',
    'temporary',
  ],
  [
    'Mailgun: a temporary failure with an over-quota message',
    {
      bounceType: 'Transient',
      bounceSubType: 'generic',
      status: '4.2.2',
      diagnostic: '4.2.2 The email account that you tried to reach is over quota.',
    },
    'soft',
    'mailbox_full',
  ],
  [
    'Postmark: SoftBounce, mailbox full',
    {
      bounceType: 'Transient',
      bounceSubType: 'SoftBounce',
      diagnostic: 'smtp;452 4.2.2 Mailbox full',
    },
    'soft',
    'mailbox_full',
  ],
  [
    'Postmark: DnsError, temporary whatever it says',
    {
      bounceType: 'Transient',
      bounceSubType: 'DnsError',
      diagnostic: 'DNS error: no MX record found',
    },
    'soft',
    'temporary',
  ],
  [
    'A transient bounce that names a missing user: the provider said temporary, so soft',
    ses('Transient', 'General', '5.1.1', 'smtp; 550 5.1.1 user unknown'),
    'soft',
    'temporary',
  ],
  [
    'Relaying denied: the domain points somewhere that does not take its mail',
    ses(
      'Permanent',
      'General',
      undefined,
      'smtp; 554 5.7.1 <reader@example.org>: Relay access denied',
    ),
    'soft',
    'unknown',
  ],
  ['SES: Transient without a diagnostic', ses('Transient', 'General'), 'soft', 'temporary'],
  ['SES: Undetermined', ses('Undetermined', 'Undetermined'), 'soft', 'unknown'],
  ['Nothing at all', {}, 'soft', 'unknown'],
];

const BLOCKED: Case[] = [
  [
    'Outlook: on its block list (S3150)',
    ses(
      'Permanent',
      'General',
      '5.7.1',
      "smtp; 550 5.7.1 Unfortunately, messages from [203.0.113.7] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150). You can also refer your provider to http://mail.live.com/mail/troubleshooting.aspx#errors. [VI1EUR03FT012.eop-EUR03.prod.protection.outlook.com]",
    ),
    'blocked',
    'blocklist',
  ],
  [
    'Spamhaus, through any server',
    ses(
      'Permanent',
      'General',
      '5.7.1',
      'smtp; 554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org; https://www.spamhaus.org/query/ip/203.0.113.7',
    ),
    'blocked',
    'blocklist',
  ],
  [
    'Gmail: unauthenticated',
    ses(
      'Permanent',
      'General',
      '5.7.26',
      'smtp; 550-5.7.26 This mail has been blocked because the sender is unauthenticated. Gmail requires all senders to authenticate with either SPF or DKIM. Authentication results: DKIM = did not pass SPF [example.com] with ip: [203.0.113.7] = did not pass',
    ),
    'blocked',
    'authentication',
  ],
  [
    'Gmail: no PTR record',
    ses(
      'Permanent',
      'General',
      '5.7.25',
      'smtp; 550-5.7.25 [203.0.113.7] The IP address sending this message does not have a PTR record setup, or the corresponding forward DNS entry does not point to the sending IP.',
    ),
    'blocked',
    'authentication',
  ],
  [
    'Gmail: this message is likely unsolicited',
    ses(
      'Permanent',
      'General',
      '5.7.1',
      'smtp; 550-5.7.1 [203.0.113.7] Gmail has detected that this message is likely unsolicited mail. To reduce the amount of spam sent to Gmail, this message has been blocked.',
    ),
    'blocked',
    'content',
  ],
  [
    'Gmail: a security issue in the content',
    ses(
      'Permanent',
      'General',
      '5.7.0',
      'smtp; 552-5.7.0 This message was blocked because its content presents a potential security issue.',
    ),
    'blocked',
    'content',
  ],
  [
    'Gmail: an unusual rate of unsolicited mail from the IP',
    ses(
      'Transient',
      'General',
      '4.7.28',
      'smtp; 421-4.7.28 [203.0.113.7 15] Gmail has detected an unusual rate of unsolicited mail originating from your IP address. To protect our users from spam, mail sent from your IP address has been temporarily rate limited.',
    ),
    'blocked',
    'reputation',
  ],
  [
    'Microsoft: rate limited because of IP reputation',
    ses(
      'Transient',
      'General',
      '4.7.650',
      'smtp; 451 4.7.650 The mail server [203.0.113.7] has been temporarily rate limited due to IP reputation. For e-mail delivery information, see https://postmaster.live.com (S775) [Name=Protocol Filter Agent]',
    ),
    'blocked',
    'reputation',
  ],
  [
    'Microsoft: banned sending IP',
    ses(
      'Permanent',
      'General',
      '5.7.606',
      'smtp; 550 5.7.606 Access denied, banned sending IP [203.0.113.7]. To request removal from this list please visit https://sender.office.com/',
    ),
    'blocked',
    'reputation',
  ],
  [
    'Yahoo: deferred for unexpected volume (TSS04)',
    ses(
      'Transient',
      'General',
      undefined,
      'smtp; 421 4.7.0 [TSS04] Messages from 203.0.113.7 temporarily deferred due to unexpected volume or user complaints - 4.16.55.1; see https://postmaster.yahooinc.com/error-codes',
    ),
    'blocked',
    'rate_limited',
  ],
  [
    'iCloud: local policy',
    ses(
      'Permanent',
      'General',
      undefined,
      'smtp; 554 5.7.1 [CS01] Message rejected due to local policy. Please visit https://support.apple.com/en-us/HT204137',
    ),
    'blocked',
    'policy',
  ],
  [
    'SES: ContentRejected',
    ses('Transient', 'ContentRejected', '5.7.1', 'smtp; 554 5.7.1 Message rejected'),
    'blocked',
    'content',
  ],
  [
    'Postmark: Blocked, naming Spamhaus',
    {
      bounceType: 'Transient',
      bounceSubType: 'Blocked',
      diagnostic:
        'smtp;554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org',
    },
    'blocked',
    'blocklist',
  ],
  [
    'Postmark: DMARCPolicy',
    {
      bounceType: 'Transient',
      bounceSubType: 'DMARCPolicy',
      diagnostic:
        'smtp;550 5.7.509 Access denied, sending domain example.com does not pass DMARC verification and has a DMARC policy of reject.',
    },
    'blocked',
    'authentication',
  ],
  [
    'Postmark: a HardBounce that is really a block',
    {
      bounceType: 'Permanent',
      bounceSubType: 'HardBounce',
      diagnostic:
        'smtp;550 5.7.1 [203.0.113.7] Our system has detected that this message is likely unsolicited mail.',
    },
    'blocked',
    'content',
  ],
  [
    'Mailgun: espblock',
    {
      bounceType: 'Permanent',
      bounceSubType: 'espblock',
      status: '5.7.1',
      diagnostic: '5.7.1 Mail from IP 203.0.113.7 was rejected by the receiving service',
    },
    'blocked',
    'policy',
  ],
  [
    'A 4.7.x code alone',
    { bounceType: 'Transient', diagnostic: 'smtp; 421 4.7.0 Try again later, closing connection.' },
    'blocked',
    'policy',
  ],
];

const IGNORED: Case[] = [
  [
    'Postmark: an auto-reply',
    {
      bounceType: 'Transient',
      bounceSubType: 'AutoResponder',
      diagnostic: 'Out of office until Monday',
    },
    'ignored',
    null,
  ],
  [
    'Postmark: a challenge email',
    { bounceType: 'Transient', bounceSubType: 'ChallengeVerification' },
    'ignored',
    null,
  ],
];

describe('classifyBounce', () => {
  for (const [group, cases] of [
    ['hard', HARD],
    ['soft', SOFT],
    ['blocked', BLOCKED],
    ['ignored', IGNORED],
  ] as const) {
    describe(group, () => {
      it.each(cases)('%s', (_, signals, kind, cause) => {
        expect(classifyBounce(signals)).toMatchObject({ kind, cause });
      });
    });
  }

  it('reports the code it read, ignoring numbers inside IP addresses', () => {
    expect(
      classifyBounce(ses('Permanent', 'General', undefined, 'smtp; 550 5.1.1 user unknown')).code,
    ).toBe('5.1.1');
    expect(
      classifyBounce({
        bounceType: 'Transient',
        diagnostic: 'Remote host [192.0.2.4] said: 421 Service not available',
      }).code,
    ).toBe('421');
    expect(classifyBounce(ses('Permanent', 'NoEmail')).code).toBeNull();
  });

  it('never calls a bounce hard while anything says temporary', () => {
    for (const [, signals, kind] of [...HARD, ...SOFT, ...BLOCKED]) {
      if (kind !== 'hard') continue;
      for (const temporary of [
        { ...signals, bounceType: 'Transient' },
        { ...signals, bounceSubType: 'old' },
      ]) {
        const result = classifyBounce(temporary);
        if (result.cause === 'provider_list') continue;
        expect(result.kind, JSON.stringify(temporary)).not.toBe('hard');
      }
    }
  });
});

describe('the provider mappings feed the classifier', () => {
  it('Mailgun: the enhanced code, or the SMTP reply code', () => {
    const event = (status: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      mailgunToSesEvent({
        event: 'failed',
        severity: 'permanent',
        reason: 'bounce',
        recipient: 'reader@example.org',
        'delivery-status': status,
        ...extra,
      });
    expect(
      event({ code: 550, 'enhanced-code': '5.1.1', message: 'The email account does not exist' })
        ?.bounce?.bouncedRecipients?.[0],
    ).toMatchObject({ status: '5.1.1' });
    expect(
      event({ code: 552, message: 'Mailbox full' })?.bounce?.bouncedRecipients?.[0],
    ).toMatchObject({
      status: '552',
    });
    // Mailgun's own 605 ("previously bounced") is not an SMTP code.
    const suppressed = event(
      { code: 605, description: 'Not delivering to previously bounced address' },
      { reason: 'suppress-bounce' },
    );
    expect(suppressed?.bounce?.bouncedRecipients?.[0]?.status).toBeUndefined();
    const b = suppressed!.bounce!;
    expect(
      classifyBounce({
        bounceType: b.bounceType,
        bounceSubType: b.bounceSubType,
        diagnostic: b.bouncedRecipients?.[0]?.diagnosticCode,
      }),
    ).toMatchObject({ kind: 'hard', cause: 'provider_list' });
  });

  it('a delivery status report keeps its Status code', () => {
    const report =
      'Final-Recipient: rfc822; reader@example.org\r\nAction: failed\r\nStatus: 5.2.2\r\nDiagnostic-Code: smtp; 552 mailbox over quota\r\n';
    const recipient = bounceMessageToSesEvent('dl_1', report)?.bounce?.bouncedRecipients?.[0];
    expect(recipient).toEqual({ status: '5.2.2', diagnosticCode: 'smtp; 552 mailbox over quota' });
    expect(
      classifyBounce({
        bounceType: 'Permanent',
        ...recipient,
        diagnostic: recipient?.diagnosticCode,
      }),
    ).toMatchObject({ kind: 'soft', cause: 'mailbox_full' });
  });

  it('Postmark and Resend pass their types through', () => {
    const postmark = postmarkToSesEvent({
      RecordType: 'Bounce',
      Type: 'Blocked',
      Inactive: true,
      Email: 'reader@example.org',
      Details: 'smtp;554 5.7.1 blocked using zen.spamhaus.org',
    })!.bounce!;
    expect(
      classifyBounce({
        bounceType: postmark.bounceType,
        bounceSubType: postmark.bounceSubType,
        diagnostic: postmark.bouncedRecipients?.[0]?.diagnosticCode,
      }),
    ).toMatchObject({ kind: 'blocked', cause: 'blocklist' });
    const resend = resendToSesEvent({
      type: 'email.bounced',
      data: {
        email_id: 'em_1',
        to: ['reader@example.org'],
        bounce: { type: 'Transient', subType: 'MailboxFull', message: 'Mailbox full' },
      },
    })!.bounce!;
    expect(
      classifyBounce({
        bounceType: resend.bounceType,
        bounceSubType: resend.bounceSubType,
        diagnostic: resend.bouncedRecipients?.[0]?.diagnosticCode,
      }),
    ).toMatchObject({ kind: 'soft', cause: 'mailbox_full' });
  });
});
