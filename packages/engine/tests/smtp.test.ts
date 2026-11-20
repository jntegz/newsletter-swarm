import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MailEnvFields,
  checkMailEnv,
  dedicatedSending,
  domainIdentities,
  mailAdapter,
  suppressionList,
  type MailEnv,
} from '../src/adapters';
import {
  bounceCodeFromAddress,
  bounceIsAuthenticated,
  bounceMessageToSesEvent,
  smtpFeedbackToSesEvent,
} from '../src/smtp-feedback';

const CODE = `${'a'.repeat(32)}-${'b'.repeat(20)}`;

describe('bounceCodeFromAddress', () => {
  it('reads the code, and nothing else', () => {
    expect(bounceCodeFromAddress(`bounce+${CODE}@u.example`)).toBe(CODE);
    expect(bounceCodeFromAddress(`BOUNCE+${CODE.toUpperCase()}@u.example`)).toBe(CODE);
    expect(bounceCodeFromAddress(`unsub+${CODE}@u.example`)).toBeNull();
    expect(bounceCodeFromAddress('bounce@u.example')).toBeNull();
    expect(bounceCodeFromAddress('bounce+short@u.example')).toBeNull();
  });
});

const report = (status: string, extra = '') =>
  `From: MAILER-DAEMON@mx.example\r\nContent-Type: multipart/report\r\n\r\nFinal-Recipient: rfc822; reader@example.org\r\nAction: failed\r\nStatus: ${status}\r\n${extra}`;

describe('bounceMessageToSesEvent', () => {
  it('reads a permanent failure, tied to the delivery in the signed code', () => {
    expect(
      bounceMessageToSesEvent(
        'dl_1',
        report('5.1.1', 'Diagnostic-Code: smtp; 550 no such user\r\n'),
      ),
    ).toEqual({
      eventType: 'Bounce',
      mail: { tags: { delivery: ['dl_1'] } },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ status: '5.1.1', diagnosticCode: 'smtp; 550 no such user' }],
      },
    });
  });

  it('reads a temporary failure', () => {
    expect(bounceMessageToSesEvent('dl_1', report('4.4.7'))?.bounce?.bounceType).toBe('Transient');
  });

  it("doesn't let a report name another address", () => {
    const event = bounceMessageToSesEvent(
      'dl_1',
      report('5.1.1', 'Original-Recipient: rfc822; someone.else@example.org\r\n'),
    );
    // Only the code is kept: the bounce applies to the delivery's own address.
    expect(event?.bounce?.bouncedRecipients).toEqual([{ status: '5.1.1' }]);
  });

  it('ignores an auto-reply and a delivered report', () => {
    expect(bounceMessageToSesEvent('dl_1', 'Subject: Out of office\r\n\r\nBack Monday')).toBeNull();
    expect(bounceMessageToSesEvent('dl_1', report('2.0.0'))).toBeNull();
  });
});

describe('bounceIsAuthenticated', () => {
  const check = (
    authenticated: { spf?: string; dkim: string[] },
    recipient = 'reader@example.org',
    extra: { envelopeFrom?: string; relayHost?: string; relayBounceDomains?: string[] } = {},
  ) => bounceIsAuthenticated({ authenticated, recipient, envelopeFrom: '', ...extra });

  it('accepts a pass for the reader’s mailbox domain, by DKIM or SPF', () => {
    expect(check({ dkim: ['example.org'] })).toBe(true);
    expect(check({ dkim: ['mail.example.org'] })).toBe(true);
    expect(check({ dkim: [], spf: 'mx1.example.org' })).toBe(true);
    expect(check({ dkim: ['mx.example.co.uk'] }, 'reader@example.co.uk')).toBe(true);
  });

  it('refuses nothing authenticated, another domain, or a sibling under a public suffix', () => {
    expect(check({ dkim: [] })).toBe(false);
    expect(check({ dkim: ['evil.test'], spf: 'evil.test' })).toBe(false);
    expect(check({ dkim: ['other.co.uk'] }, 'reader@example.co.uk')).toBe(false);
  });

  it('accepts the bounce servers of big mailbox providers for their addresses only', () => {
    expect(check({ dkim: ['google.com'] }, 'reader@gmail.com')).toBe(true);
    expect(check({ dkim: ['googlemail.com'] }, 'reader@gmail.com')).toBe(true);
    expect(check({ dkim: [], spf: 'x.outbound.protection.outlook.com' }, 'r@hotmail.com')).toBe(
      true,
    );
    expect(check({ dkim: [], spf: 'mta1.am0.yahoodns.net' }, 'r@yahoo.com')).toBe(true);
    expect(check({ dkim: ['google.com'] }, 'reader@example.org')).toBe(false);
  });

  it('accepts the operator’s relay, unless it is a service anyone can send through', () => {
    const relayed = { dkim: ['relay.example.net'] };
    expect(check(relayed, undefined, { relayHost: 'smtp.relay.example.net' })).toBe(true);
    expect(check(relayed)).toBe(false);
    expect(check({ dkim: ['sendgrid.net'] }, undefined, { relayHost: 'smtp.sendgrid.net' })).toBe(
      false,
    );
  });

  it('accepts the domains common relays write their bounces as', () => {
    // A relay writes most 5.1.1 bounces itself, often signed as a domain other than its host's.
    const relay = (relayHost: string, authenticated: { spf?: string; dkim: string[] }) =>
      check(authenticated, undefined, { relayHost });
    expect(relay('smtp.gmail.com', { dkim: ['googlemail.com'] })).toBe(true);
    expect(relay('smtp-relay.gmail.com', { dkim: ['google.com'] })).toBe(true);
    // Only for that relay.
    expect(relay('smtp.gmail.com', { dkim: ['messagingengine.com'] })).toBe(false);
    expect(check({ dkim: ['google.com'] })).toBe(false);
  });

  it('does not take a domain every customer of a relay passes for as the relay', () => {
    // Fastmail signs all its customers' mail as messagingengine.com, and every Microsoft 365
    // tenant's mail leaves through protection.outlook.com, so any of them could write a DSN.
    const relay = (
      relayHost: string,
      authenticated: { spf?: string; dkim: string[] },
      recipient?: string,
      relayBounceDomains: string[] = [],
    ) =>
      check(authenticated, recipient, {
        relayHost,
        relayBounceDomains,
        envelopeFrom: 'postmaster@evil.test',
      });
    const fastmail = { dkim: ['evil.test', 'messagingengine.com'] };
    const microsoft = { dkim: [], spf: 'x.outbound.protection.outlook.com' };
    expect(relay('smtp.fastmail.com', fastmail)).toBe(false);
    expect(relay('mail.messagingengine.com', fastmail)).toBe(false);
    expect(relay('smtp.office365.com', microsoft)).toBe(false);
    expect(relay('smtp-mail.outlook.com', microsoft)).toBe(false);
    // Still for Outlook.com's own addresses, and when the operator names the domain.
    expect(relay('smtp.office365.com', microsoft, 'r@outlook.com')).toBe(true);
    expect(relay('smtp.fastmail.com', fastmail, undefined, ['messagingengine.com'])).toBe(true);
    expect(
      relay('smtp.office365.com', { dkim: ['contoso.onmicrosoft.com'] }, undefined, [
        'contoso.onmicrosoft.com',
      ]),
    ).toBe(true);
  });

  it('accepts the domains SMTP_BOUNCE_DOMAINS names, and their subdomains only', () => {
    const named = (authenticated: { spf?: string; dkim: string[] }, domains: string[]) =>
      check(authenticated, undefined, {
        relayHost: 'mail.example.net',
        relayBounceDomains: domains,
      });
    expect(named({ dkim: ['bounces.relay.example'] }, ['relay.example'])).toBe(true);
    expect(
      named({ dkim: [], spf: 'mx.contoso.onmicrosoft.com' }, ['contoso.onmicrosoft.com']),
    ).toBe(true);
    // Named as given, not widened to the organisational domain.
    expect(named({ dkim: ['evil.onmicrosoft.com'] }, ['contoso.onmicrosoft.com'])).toBe(false);
    // A shared sending service passes for every one of its customers.
    expect(named({ dkim: ['sendgrid.net'] }, ['sendgrid.net'])).toBe(false);
  });

  it('only takes mail with an empty or mailer-daemon sender as a bounce', () => {
    // Anyone with a Gmail account passes DKIM for gmail.com.
    const gmail = (envelopeFrom: string) =>
      check({ dkim: ['gmail.com'] }, 'reader@gmail.com', { envelopeFrom });
    expect(gmail('')).toBe(true);
    expect(gmail('<>')).toBe(true);
    expect(gmail('MAILER-DAEMON@googlemail.com')).toBe(true);
    expect(gmail('postmaster@gmail.com')).toBe(true);
    expect(gmail('someone@gmail.com')).toBe(false);
    expect(gmail('mailer-daemon.fake@gmail.com')).toBe(false);
  });
});

describe('smtpFeedbackToSesEvent', () => {
  it('maps a complaint and both bounces', () => {
    expect(smtpFeedbackToSesEvent({ type: 'complaint', messageId: '<dl_1@n.example>' })).toEqual({
      eventType: 'Complaint',
      mail: { messageId: 'dl_1@n.example' },
      complaint: {},
    });
    const hard = smtpFeedbackToSesEvent({
      type: 'hard_bounce',
      messageId: 'dl_1@n.example',
      detail: '550 gone',
    });
    expect(hard?.bounce).toEqual({
      bounceType: 'Permanent',
      bouncedRecipients: [{ diagnosticCode: '550 gone' }],
    });
    expect(
      smtpFeedbackToSesEvent({ type: 'soft_bounce', messageId: 'dl_1@n.example' })?.bounce
        ?.bounceType,
    ).toBe('Transient');
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'text',
      {},
      { type: 'complaint' },
      { type: 'complaint', messageId: ' ' },
      { type: 'complaint', messageId: 'x'.repeat(501) },
      { type: 'delivered', messageId: 'dl_1@n.example' },
    ]) {
      expect(smtpFeedbackToSesEvent(bad)).toBeNull();
    }
  });
});

describe('MAIL_ADAPTER=smtp', () => {
  const schema = z
    .object({ ENVIRONMENT: z.string(), ...MailEnvFields })
    .superRefine((value, ctx) => checkMailEnv(value as MailEnv, ctx));
  const base = {
    ENVIRONMENT: 'production',
    MAIL_ADAPTER: 'smtp',
    AWS_REGION: 'us-east-1',
    SMTP_HOST: 'mail.example.com',
    SMTP_PORT: '587',
    SMTP_USERNAME: 'swarm',
    SMTP_PASSWORD: 'test-only-password',
    SMTP_DKIM_SELECTOR: 'default',
  };
  const paths = (input: Record<string, unknown>) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('needs all five settings', () => {
    expect(paths(base)).toEqual([]);
    for (const key of [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
      'SMTP_DKIM_SELECTOR',
    ]) {
      expect(paths({ ...base, [key]: undefined })).toEqual([key]);
    }
  });

  it('refuses port 25 and a host that is not a hostname', () => {
    expect(paths({ ...base, SMTP_PORT: '25' })).toEqual(['SMTP_PORT']);
    expect(paths({ ...base, SMTP_PORT: 'smtp' })).toEqual(['SMTP_PORT']);
    expect(paths({ ...base, SMTP_HOST: 'mail.example.com:25' })).toEqual(['SMTP_HOST']);
    expect(paths({ ...base, SMTP_PORT: '465' })).toEqual([]);
  });

  it('sends through the server, with no SES-only features', () => {
    const env = base as MailEnv;
    expect(mailAdapter(env, 'm.test').constructor.name).toBe('SmtpMail');
    expect(domainIdentities(env).constructor.name).toBe('SmtpDomains');
    expect(dedicatedSending(env)).toBeNull();
    expect(suppressionList(env)).toBeNull();
  });
});
