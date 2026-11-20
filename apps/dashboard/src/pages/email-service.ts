// What Settings → Instance says about email services. Exact values, such as DKIM keys, only exist
// once a service has created the domain, so a service not yet connected is described by its shape.
import type { InstanceMail, MailServiceKey } from '@swarm/domain';

export const SERVICE_NAMES: Record<MailServiceKey, string> = {
  ses: 'Amazon SES',
  resend: 'Resend',
  mailgun: 'Mailgun',
  postmark: 'Postmark',
  smtp: 'Your own mail server',
  dev: 'Development mailbox',
};

/** Tested only against stand-ins for the real service, so the page says so. */
export const PREVIEW_SERVICES: readonly MailServiceKey[] = ['ses', 'mailgun', 'postmark', 'smtp'];

interface RecordShape {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  purpose: string;
}

export interface ServiceGuide {
  service: Exclude<MailServiceKey, 'dev'>;
  needs: string;
  records: RecordShape[];
}

/** Every service but the one in use, each with the records it would need for `domain`. */
export function serviceGuides(domain: string, current: MailServiceKey): ServiceGuide[] {
  const bounce = `bounce.${domain}`;
  const dmarc: RecordShape = {
    type: 'TXT',
    name: `_dmarc.${domain}`,
    value: 'v=DMARC1; p=quarantine; adkim=r; aspf=r',
    purpose: 'DMARC, the same for every service',
  };
  const guides: ServiceGuide[] = [
    {
      service: 'ses',
      needs:
        'An AWS account and a setup key. AWS also has to approve the account for production before it will email subscribers, usually within a day.',
      records: [
        {
          type: 'CNAME',
          name: `<token>._domainkey.${domain}`,
          value: '<token>.dkim.amazonses.com',
          purpose: 'DKIM, three of these, with tokens from SES',
        },
        {
          type: 'MX',
          name: bounce,
          value: '10 feedback-smtp.<region>.amazonses.com',
          purpose: 'Bounces',
        },
        {
          type: 'TXT',
          name: bounce,
          value: 'v=spf1 include:amazonses.com ~all',
          purpose: 'SPF',
        },
        dmarc,
      ],
    },
    {
      service: 'resend',
      needs: 'A Resend API key with Full access.',
      records: [
        {
          type: 'TXT',
          name: `resend._domainkey.${domain}`,
          value: 'The key Resend gives you',
          purpose: 'DKIM',
        },
        { type: 'MX', name: bounce, value: 'The host Resend gives you', purpose: 'Bounces' },
        { type: 'TXT', name: bounce, value: 'The SPF record Resend gives you', purpose: 'SPF' },
        dmarc,
      ],
    },
    {
      service: 'mailgun',
      needs: 'A Mailgun Private API key. A domain sending key is not enough.',
      records: [
        {
          type: 'TXT',
          name: `<selector>._domainkey.${domain}`,
          value: 'The key Mailgun gives you',
          purpose: 'DKIM',
        },
        { type: 'TXT', name: domain, value: 'v=spf1 include:mailgun.org ~all', purpose: 'SPF' },
        dmarc,
      ],
    },
    {
      service: 'postmark',
      needs:
        'A Postmark Account API token. Until Postmark approves a new account, it only delivers to addresses on your own domain.',
      records: [
        {
          type: 'TXT',
          name: `<selector>._domainkey.${domain}`,
          value: 'The key Postmark gives you',
          purpose: 'DKIM',
        },
        { type: 'CNAME', name: bounce, value: 'pm.mtasv.net', purpose: 'Bounces' },
        dmarc,
      ],
    },
    {
      service: 'smtp',
      needs:
        'A mail server that signs with DKIM and takes logins on port 465 or 587. Plain SMTP does not report spam complaints, so Swarm can’t pause a send when they rise unless your server reports them.',
      records: [
        {
          type: 'TXT',
          name: `<selector>._domainkey.${domain}`,
          value: 'The key your server gives you',
          purpose: 'DKIM',
        },
        { type: 'TXT', name: domain, value: 'Your server’s SPF record', purpose: 'SPF' },
        dmarc,
      ],
    },
  ];
  return guides.filter((guide) => guide.service !== current);
}

/** The same steps for the setup page and the terminal, whose commands are in brackets. */
export function changeSteps(service: ServiceGuide['service']): string[] {
  return [
    `Start the change on your setup page, or run \`pnpm swarm mail switch ${service}\`. Your current service keeps sending.`,
    'Publish the new records. Swarm writes its own if it can, and each publication’s owner adds theirs under Sending & delivery.',
    'Check what’s missing there, or with `pnpm swarm mail status`.',
    'Move over from your setup page, or with `pnpm swarm mail cutover`. If it goes badly, you can go back for 14 days.',
    'After 14 days, finish from your setup page, or with `pnpm swarm mail finish`, to remove the old service’s keys and records. Late complaints still count until then.',
  ];
}

export function changeSummary(change: NonNullable<InstanceMail['change']>): string {
  const from = SERVICE_NAMES[change.from as MailServiceKey] ?? change.from;
  const to = SERVICE_NAMES[change.to as MailServiceKey] ?? change.to;
  if (change.state === 'prepared') {
    return `Moving from ${from} to ${to}. ${from} is still sending. Publications can see their new records under Sending & delivery.`;
  }
  const until = change.drainUntil?.slice(0, 10);
  return `Email now goes through ${to}. Reports from ${from} keep arriving until ${until}, and you can go back until you finish the change.`;
}

interface MailNotice {
  tone: 'warn' | 'info';
  text: string;
}

/** What someone should know about the service right now, the most urgent first. */
export function mailNotices(mail: InstanceMail): MailNotice[] {
  const notices: MailNotice[] = [];
  const name = SERVICE_NAMES[mail.service];
  if (!mail.recordsComplete) {
    notices.push({
      tone: 'warn',
      text: `Swarm couldn’t ask ${name} for its records, so some may be missing below. Its key may have changed, or ${name} may be down.`,
    });
  }
  if (mail.ses && !mail.ses.sendingEnabled) {
    notices.push({
      tone: 'warn',
      text: 'AWS has paused sending on this account. Check the Amazon SES console for why.',
    });
  }
  if (mail.feedback.state === 'silent') {
    notices.push({
      tone: 'warn',
      text: `${name} hasn’t reported back on the last ${mail.feedback.sent} emails. Without reports, Swarm can’t see bounces or complaints, so bad addresses stay on your list and sends won’t pause when they should.`,
    });
  }
  if (mail.ses && !mail.ses.productionAccess) {
    notices.push({
      tone: 'warn',
      text: 'Your AWS account is in the SES sandbox, so email only reaches addresses you’ve verified, up to 200 a day. Ask AWS for production access in the SES console. A person there reviews it, usually within a day.',
    });
  }
  if (mail.feedback.state === 'not_reported' && mail.service === 'smtp') {
    notices.push({
      tone: 'info',
      text: 'Plain SMTP doesn’t report deliveries or complaints unless your server is set up to.',
    });
  }
  return notices;
}

export const countMissing = (mail: InstanceMail) =>
  mail.records.filter((record) => record.state !== 'ok' && record.state !== 'unknown').length;
