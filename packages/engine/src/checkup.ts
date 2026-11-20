/**
 * The deliverability check-up: every check for one Channel in one answer, written for the person
 * who writes the newsletter. Two halves:
 *
 * - `gatherCheckupFacts` reads what the system already knows (sender, domains, DNS, DMARC reports,
 *   the last 30 days of sending, warm-up, list settings, blocklists). Each read is settled on its
 *   own, so one that fails becomes "couldn't check" and never takes the others with it.
 * - `buildCheckup` is pure: facts in, verdict, score and ordered findings out.
 *
 * The copy in here is shown in the dashboard as written, so it uses the dashboard's plain words
 * (publication, subscriber, warm-up, signup form). Explained for end users in
 * docs/deliverability-guide.md; limits are CHECKUP in @swarm/domain.
 */
import {
  CHECKUP,
  CHECKUP_SEVERITIES,
  DEBOUNCE_SIGNUP_URL,
  EmailDesignSchema,
  GMAIL_COMPLAINT_TARGET,
  GMAIL_COMPLAINT_THRESHOLD,
  resolveDoubleOptIn,
  type CheckedDnsRecord,
  type CheckupFinding,
  type CheckupFindingId,
  type CheckupLinkTarget,
  type CheckupSeverity,
  type DeliverabilityCheckup,
  type DnsRecord,
  type MailboxProvider,
  type ProviderStats,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import {
  checkDomainBlocklists,
  checkRecords,
  type DnsLookup,
  type DomainBlocklistCheck,
} from '@swarm/mail';
import type { EngineConfig } from './config';
import { all, first } from './db';
import {
  complaintStanding,
  complaintSummary,
  deliverabilityRange,
  providerBreakdown,
  recordReportsTo,
  type DayRange,
} from './deliverability';
import type { DebounceEnv } from './debounce';
import { dmarcReportAddress } from './dmarc';
import { lookupDmarc, type DmarcPolicy } from './domains';
import { emailCheckFacts, type EmailCheckFacts } from './email-checks';
import { SUNSET_MIN_SENT } from './membercenter';
import { resolveSender } from './start';

const DAY_MS = 86_400_000;

export type Settled<T> = { ok: true; value: T } | { ok: false };

export interface CheckupChannelFacts {
  name: string;
  paused: boolean;
  doubleOptIn: boolean;
  requireConfirmation: boolean;
  sunsetDays: number | null;
  /** The footer line of the email design; empty when there is none. */
  footer: string;
  /** Whether the email design (and so its footer line) is applied to emails. */
  designOn: boolean;
  /** Open tracking and reader profiles are on, so the inactive-reader cleanup can run. */
  seesOpens?: boolean;
}

export interface CheckupSenderFacts {
  /** False when the publication has no sender of its own and mail goes from the shared address. */
  hasIdentity: boolean;
  name: string;
  address: string;
  replyTo: string | null;
  sendingDomainId: string | null;
}

export interface CheckupDomainFacts {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  verifiedAt: number | null;
  /** The provider's records (DKIM, return path) as DNS has them now. */
  records: Settled<CheckedDnsRecord[]>;
  dmarc: Settled<{
    /** The policy in force, from the domain's own record or its parent's; null when none. */
    policy: DmarcPolicy | null;
    /** How many DMARC records the name itself holds. More than one makes DMARC fail. */
    published: number;
    /** Whether the published record sends aggregate reports to Swarm. */
    reportsHere: boolean;
  }>;
  reports: Settled<{ lastReportAt: number | null; messages: number; aligned: number }>;
}

export interface CheckupListFacts {
  /** Published signup forms that let people in without confirming by email. */
  formsWithoutConfirm: string[];
  /** Active subscribers. */
  active: number;
  /** Active subscribers who have been sent enough emails to judge, with opens visible. */
  measured: number;
  /** Of those, how many have not opened or clicked for CHECKUP.inactiveDays. */
  inactive: number;
  /** False when the daily engagement numbers are missing or stale. */
  engagementKnown: boolean;
  /** The largest import finished in the last CHECKUP.importRecentDays days. */
  recentImport: { rows: number; completedAt: number } | null;
}

export interface CheckupRampFacts {
  domain: string;
  status: 'warming' | 'paused' | 'complete';
  pausedReason: string | null;
  capToday: number;
}

export interface CheckupFacts {
  now: number;
  /** The shared domain publications without their own send from. */
  sharedDomain: string;
  channel: Settled<CheckupChannelFacts>;
  sender: Settled<CheckupSenderFacts>;
  /** Email sending domains a sender of this publication uses, the default sender's first. */
  domains: Settled<CheckupDomainFacts[]>;
  /** The last CHECKUP.days days of sending, by mailbox provider. */
  providers: Settled<ProviderStats[]>;
  ramps: Settled<CheckupRampFacts[]>;
  list: Settled<CheckupListFacts>;
  blocklists: Settled<DomainBlocklistCheck[]>;
  /** Email checks (flag email_verification); absent when the caller didn't ask. */
  emailChecks?: Settled<EmailCheckFacts> | undefined;
}

// ---- Findings ------------------------------------------------------------------------------

/**
 * What hurts delivery most comes first. Problems always sort before warnings; inside one
 * severity this order decides. Nothing arriving at all (paused), then identity and authentication,
 * then reputation, then list quality, then housekeeping.
 */
const IMPACT_ORDER: readonly CheckupFindingId[] = [
  'publication_paused',
  'warmup',
  'sender_free_mailbox',
  'sending_domain',
  'dns_dkim',
  'dmarc_policy',
  'blocklist',
  'complaint_rate',
  'provider_blocks',
  'bounce_rate',
  'dns_return_path_spf',
  'dns_return_path_mx',
  'dmarc_alignment',
  'provider_gap',
  'confirm_opt_in',
  'inactive_share',
  'recent_import',
  'email_check',
  'inactive_cleanup',
  'dmarc_reports',
  'footer_address',
  'sender_no_reply',
  'sender',
  'sending_volume',
];

const LINK_LABEL: Record<CheckupLinkTarget, string> = {
  sending: 'Open Sending settings',
  deliverability: 'See the details on this page',
  publication: 'Open publication settings',
  forms: 'Open signup forms',
  subscribers: 'Open subscribers',
  email_check: 'Open DeBounce',
};

interface FindingInput {
  id: CheckupFindingId;
  severity: CheckupSeverity;
  title: string;
  meaning: string;
  subject?: string | null;
  fix?: string[];
  link?: CheckupLinkTarget | null;
  external?: { label: string; url: string }[];
}

const finding = (input: FindingInput): CheckupFinding => ({
  id: input.id,
  subject: input.subject ?? null,
  severity: input.severity,
  title: input.title,
  meaning: input.meaning,
  fix: input.fix ?? [],
  link: input.link ? { to: input.link, label: LINK_LABEL[input.link] } : null,
  external: input.external ?? [],
});

const RETRY = 'Run the check-up again in a minute.';

const unknown = (
  id: CheckupFindingId,
  title: string,
  subject: string | null = null,
): CheckupFinding =>
  finding({
    id,
    subject,
    severity: 'unknown',
    title,
    meaning:
      'This check did not finish, so there is no result either way. It does not mean something is wrong.',
    fix: [RETRY],
  });

const percent = (rate: number, digits = 1) => `${(rate * 100).toFixed(digits)}%`;
const number = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`;
const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Mailbox services anyone can sign up for. Their domains only pass DMARC for their own servers. */
export const FREE_MAILBOX_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
] as const;

const FREE_MAILBOX_BRANDS = /^(?:yahoo|hotmail|live|outlook)\.(?:(?:co|com)\.)?[a-z]{2}$/;

export function isFreeMailboxDomain(domain: string): boolean {
  const name = domain.trim().toLowerCase();
  return (
    (FREE_MAILBOX_DOMAINS as readonly string[]).includes(name) || FREE_MAILBOX_BRANDS.test(name)
  );
}

/** From addresses that tell readers not to answer: noreply, no-reply, donotreply and the like. */
export const isNoReplyAddress = (address: string) =>
  /^(?:no|do[-_.]?not)[-_.]?repl(?:y|ies)\b/i.test(address.split('@')[0] ?? '');

const PROVIDER_NAME: Record<MailboxProvider, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  yahoo: 'Yahoo',
  apple: 'iCloud Mail',
  other: 'other providers',
};

/** Each provider's own tool for senders, and what it is good for. */
const PROVIDER_TOOL: Partial<Record<MailboxProvider, { label: string; url: string }>> = {
  gmail: { label: 'Google Postmaster Tools', url: 'https://postmaster.google.com/' },
  outlook: {
    label: 'Microsoft SNDS',
    url: 'https://sendersupport.olc.protection.outlook.com/snds/',
  },
  yahoo: { label: 'Yahoo Sender Hub', url: 'https://senders.yahooinc.com/' },
};

function senderFindings(facts: CheckupFacts): CheckupFinding[] {
  if (!facts.sender.ok) return [unknown('sender', 'Could not check your sender')];
  const sender = facts.sender.value;
  const domain = sender.address.slice(sender.address.lastIndexOf('@') + 1).toLowerCase();
  const out: CheckupFinding[] = [];

  if (isFreeMailboxDomain(domain)) {
    out.push(
      finding({
        id: 'sender_free_mailbox',
        severity: 'problem',
        subject: sender.address,
        title: `Your From address is on ${domain}, a free mailbox service`,
        meaning: `Only ${domain}'s own servers may send mail as ${domain}. Anything else fails DMARC, and Gmail, Yahoo and Outlook reject it or put it in spam. No setting can fix this for an address you do not control the domain of.`,
        fix: [
          'Get a domain of your own (for example yourname.com), or use one you already have.',
          'In Sending, add it under Domains and publish the DNS records it shows.',
          'Under Senders, make an address on that domain your default sender.',
          `Keep your ${domain} address as the reply-to if you like: replies are fine, only the From address matters.`,
        ],
        link: 'sending',
      }),
    );
  }

  if (isNoReplyAddress(sender.address)) {
    out.push(
      finding({
        id: 'sender_no_reply',
        severity: 'warning',
        subject: sender.address,
        title: 'Your From address tells readers not to reply',
        meaning:
          'Replies are one of the strongest signs to a mailbox provider that people want your email. A no-reply address throws that away, and readers who cannot reply to ask a question are more likely to press the spam button instead.',
        fix: [
          'In Sending, under Senders, change the address to one a person reads, such as hello@ or your first name.',
        ],
        link: 'sending',
      }),
    );
  }

  if (!sender.sendingDomainId) {
    out.push(
      sender.hasIdentity
        ? finding({
            id: 'sender',
            severity: 'good',
            subject: sender.address,
            title: `You send from the shared domain ${facts.sharedDomain}`,
            meaning:
              'The shared domain is set up and authenticated by whoever runs this Swarm, so there is nothing for you to publish. Its reputation is shared by every publication that uses it. A domain of your own builds a reputation that is only yours, which matters more as your list grows.',
            link: 'sending',
          })
        : finding({
            id: 'sender',
            severity: 'warning',
            subject: sender.address,
            title: 'No sender is set up yet',
            meaning: `Until you choose one, emails go out as ${sender.address} on the shared domain. Readers recognise a name and address they know, and unrecognised senders get more spam reports.`,
            fix: [
              'In Sending, under Senders, add the name and address your readers should see.',
              'For the best results, add your own domain under Domains first and use an address on it.',
            ],
            link: 'sending',
          }),
    );
  } else if (!out.length) {
    out.push(
      finding({
        id: 'sender',
        severity: 'good',
        subject: sender.address,
        title: `You send as ${sender.name} <${sender.address}>`,
        meaning: 'The From address is on a domain of your own and readers can reply to it.',
      }),
    );
  }
  return out;
}

const RECORD_WORDS: Record<
  'dkim' | 'mail_from_mx' | 'mail_from_spf',
  { id: CheckupFindingId; what: string; why: string }
> = {
  dkim: {
    id: 'dns_dkim',
    what: 'DKIM',
    why: 'DKIM is the signature that proves an email really comes from your domain. Without a working DKIM record your emails are not signed for your domain, and Gmail and Yahoo refuse unsigned bulk mail.',
  },
  mail_from_spf: {
    id: 'dns_return_path_spf',
    what: 'SPF (return path)',
    why: 'SPF tells mailbox providers which servers may send for your domain. Without it your emails lean on DKIM alone, so one hiccup with the signature and they fail DMARC.',
  },
  mail_from_mx: {
    id: 'dns_return_path_mx',
    what: 'return path MX',
    why: 'This record is where bounces come back to. Without it bounces can get lost, dead addresses stay on your list, and SPF cannot line up with your domain.',
  },
};

const describeRecord = (record: Pick<DnsRecord, 'type' | 'name' | 'value' | 'priority'>) =>
  `${record.type} record, name ${record.name}, value ${record.priority !== undefined ? `${record.priority} ` : ''}${record.value}`;

function recordFindings(domain: CheckupDomainFacts): CheckupFinding[] {
  if (!domain.records.ok) {
    return [
      unknown('dns_dkim', `Could not read the DNS records of ${domain.domain}`, domain.domain),
    ];
  }
  const out: CheckupFinding[] = [];
  for (const purpose of ['dkim', 'mail_from_spf', 'mail_from_mx'] as const) {
    const words = RECORD_WORDS[purpose];
    const records = domain.records.value.filter((record) => record.purpose === purpose);
    if (!records.length) continue;
    const bad = records.filter((r) => ['missing', 'different', 'conflict'].includes(r.state));
    const unsure = records.filter((r) => r.state === 'unknown');
    if (bad.length) {
      const states = new Set(bad.map((r) => r.state));
      const title = states.has('conflict')
        ? `${domain.domain} has more than one SPF record`
        : states.has('missing') && states.size === 1
          ? `The ${words.what} record of ${domain.domain} is missing`
          : `The ${words.what} record of ${domain.domain} is wrong`;
      out.push(
        finding({
          id: words.id,
          subject: domain.domain,
          severity: 'problem',
          title,
          meaning: states.has('conflict')
            ? `A name may hold only one SPF record. With two, SPF fails for every email. ${words.why}`
            : words.why,
          fix: [
            'Open the DNS settings where your domain is registered or hosted.',
            ...bad.map((record) =>
              record.state === 'conflict'
                ? `Merge the SPF records at ${record.name} into one, keeping: ${record.value || 'the value your mail server needs'}`
                : record.state === 'different'
                  ? `Change the ${describeRecord(record)}. DNS has ${record.found.join(' | ') || 'something else'} there now.`
                  : `Add a ${describeRecord(record)}`,
            ),
            'DNS changes can take up to an hour to show. Then press "Check again" on the domain in Sending.',
          ],
          link: 'sending',
        }),
      );
    } else if (unsure.length) {
      out.push(
        unknown(
          words.id,
          `Could not read the ${words.what} record of ${domain.domain}`,
          domain.domain,
        ),
      );
    } else {
      out.push(
        finding({
          id: words.id,
          subject: domain.domain,
          severity: 'good',
          title: `The ${words.what} record of ${domain.domain} is in place`,
          meaning: 'DNS has the value your email service expects.',
        }),
      );
    }
  }
  return out;
}

function dmarcFindings(
  domain: CheckupDomainFacts,
  facts: CheckupFacts,
  reportingMail: number | null,
): CheckupFinding[] {
  const out: CheckupFinding[] = [];
  const name = domain.domain;

  if (!domain.dmarc.ok) {
    out.push(unknown('dmarc_policy', `Could not read the DMARC record of ${name}`, name));
  } else if (domain.dmarc.value.published > 1) {
    out.push(
      finding({
        id: 'dmarc_policy',
        subject: name,
        severity: 'problem',
        title: `${name} has more than one DMARC record`,
        meaning:
          'A domain may publish only one DMARC record. With two, mailbox providers ignore both, which is the same as having none.',
        fix: [
          `In your DNS, delete all but one TXT record at _dmarc.${name}.`,
          'Keep the one Sending shows for this domain.',
        ],
        link: 'sending',
      }),
    );
  } else if (!domain.dmarc.value.policy) {
    out.push(
      finding({
        id: 'dmarc_policy',
        subject: name,
        severity: 'problem',
        title: `${name} has no DMARC record`,
        meaning:
          'DMARC tells mailbox providers what to do with mail that pretends to be from your domain. Gmail and Yahoo require one from anyone who sends newsletters, and Swarm will not send from a domain without it.',
        fix: [
          `In your DNS, add the TXT record for _dmarc.${name} that Sending shows for this domain.`,
          'Then press "Check again" on the domain in Sending.',
        ],
        link: 'sending',
      }),
    );
  } else if (domain.dmarc.value.policy === 'none') {
    out.push(
      finding({
        id: 'dmarc_policy',
        subject: name,
        severity: 'problem',
        title: `The DMARC policy of ${name} is "none"`,
        meaning:
          'p=none only asks for reports. It does not stop anyone from faking your address, and mailbox providers trust a domain less when its owner has not taken a stand. Swarm needs quarantine or reject before the first send.',
        fix: [
          `In your DNS, change p=none to p=quarantine in the TXT record at _dmarc.${name}.`,
          'If other tools also send email as this domain (your office mail, a shop, a help desk), make sure they are signed with DKIM first, or their mail will go to spam.',
        ],
        link: 'sending',
      }),
    );
  } else {
    out.push(
      finding({
        id: 'dmarc_policy',
        subject: name,
        severity: 'good',
        title: `DMARC is enforced for ${name} (${domain.dmarc.value.policy})`,
        meaning:
          'Mail that fakes your domain is quarantined or rejected, which is what the big mailbox providers ask for.',
      }),
    );
  }

  if (!domain.reports.ok) {
    out.push(unknown('dmarc_alignment', `Could not read the DMARC reports of ${name}`, name));
    return out;
  }
  const reports = domain.reports.value;

  if (reports.messages >= CHECKUP.minDmarcMessages) {
    const rate = reports.aligned / reports.messages;
    const failed = reports.messages - reports.aligned;
    if (rate < CHECKUP.alignmentWarning) {
      out.push(
        finding({
          id: 'dmarc_alignment',
          subject: name,
          severity: rate < CHECKUP.alignmentProblem ? 'problem' : 'warning',
          title: `${percent(1 - rate)} of mail sent as ${name} fails DMARC`,
          meaning: `Mailbox providers reported ${plural(failed, 'message', 'messages')} out of ${number(reports.messages)} in the last ${CHECKUP.days} days that passed neither SPF nor DKIM for your domain. Either another tool sends as ${name} without being set up for it, or someone is faking your address. With your policy those messages go to spam or are rejected.`,
          fix: [
            'Open the DMARC section below and look at "Sources with problems".',
            'A source you recognise (office mail, a shop, a form tool): set up DKIM for your domain in that tool.',
            'A source you do not recognise is someone else. Your DMARC policy is already dealing with it; nothing to do.',
          ],
          link: 'deliverability',
        }),
      );
    } else {
      out.push(
        finding({
          id: 'dmarc_alignment',
          subject: name,
          severity: 'good',
          title: `${percent(rate)} of mail sent as ${name} passes DMARC`,
          meaning: `From ${number(reports.messages)} messages that mailbox providers reported on in the last ${CHECKUP.days} days.`,
        }),
      );
    }
  }

  // Reports only say something once the domain has been sending to providers that send them.
  const settled =
    domain.status === 'verified' &&
    domain.verifiedAt !== null &&
    facts.now - domain.verifiedAt > CHECKUP.dmarcReportGraceDays * DAY_MS;
  const expected = settled && reportingMail !== null && reportingMail >= CHECKUP.minSent;
  const stale =
    reports.lastReportAt !== null &&
    facts.now - reports.lastReportAt > CHECKUP.dmarcReportStaleDays * DAY_MS;
  if (expected && (reports.lastReportAt === null || stale)) {
    const reportsHere = domain.dmarc.ok ? domain.dmarc.value.reportsHere : null;
    out.push(
      finding({
        id: 'dmarc_reports',
        subject: name,
        severity: 'warning',
        title:
          reports.lastReportAt === null
            ? `No DMARC reports have arrived for ${name}`
            : `DMARC reports for ${name} have stopped arriving`,
        meaning:
          'Mailbox providers send a daily report of who sent mail as your domain and whether it passed. Without the reports Swarm cannot tell you when something breaks. Your email still goes out.',
        fix:
          reportsHere === false
            ? [
                `Your DMARC record does not send reports to Swarm. In your DNS, set the TXT record at _dmarc.${name} to the value Sending shows for this domain (it ends in rua=mailto:...).`,
                'Reports start arriving a day or two after your next send.',
              ]
            : [
                'Your DMARC record asks for reports correctly. They normally arrive a day or two after a send.',
                'If none arrive after your next send, ask whoever runs this Swarm to check that mail to the DMARC report address reaches it (docs/deliverability.md).',
              ],
        link: 'deliverability',
      }),
    );
  }
  return out;
}

function domainFindings(facts: CheckupFacts): CheckupFinding[] {
  if (!facts.domains.ok) return [unknown('sending_domain', 'Could not check your sending domain')];
  const reportingMail = facts.providers.ok
    ? facts.providers.value
        .filter((p) => p.provider !== 'other' && p.provider !== 'apple')
        .reduce((sum, p) => sum + p.delivered, 0)
    : null;
  const out: CheckupFinding[] = [];
  for (const domain of facts.domains.value) {
    if (domain.status !== 'verified') {
      out.push(
        finding({
          id: 'sending_domain',
          subject: domain.domain,
          severity: 'problem',
          title: `${domain.domain} is not verified`,
          meaning:
            'Your email service has not confirmed that you control this domain, so Swarm cannot send from it. Nothing goes out from senders on this domain until it is verified.',
          fix: [
            'In Sending, under Domains, open this domain and copy each DNS record it lists.',
            'Add them where your domain is registered or hosted, exactly as shown.',
            'Wait up to an hour, then press "Check again" on the domain.',
          ],
          link: 'sending',
        }),
      );
    } else {
      out.push(
        finding({
          id: 'sending_domain',
          subject: domain.domain,
          severity: 'good',
          title: `${domain.domain} is verified`,
          meaning: 'Your email service confirmed that you control this domain.',
        }),
      );
    }
    out.push(...recordFindings(domain), ...dmarcFindings(domain, facts, reportingMail));
  }
  return out;
}

function blocklistFindings(facts: CheckupFacts): CheckupFinding[] {
  if (!facts.blocklists.ok) return [unknown('blocklist', 'Could not check domain blocklists')];
  const out: CheckupFinding[] = [];
  for (const check of facts.blocklists.value) {
    const listed = check.results.filter((r) => r.state === 'listed');
    const unsure = check.results.filter((r) => r.state === 'unknown');
    const clean = check.results.filter((r) => r.state === 'clean');
    for (const result of listed) {
      out.push(
        finding({
          id: 'blocklist',
          subject: `${check.domain} on ${result.name}`,
          severity: 'problem',
          title: `${check.domain} is listed on ${result.name}`,
          meaning: `${result.name} is a blocklist many mail servers consult. While your domain is on it, email that comes from it or links to it is often rejected or filed as spam. Listings usually follow spam complaints, a hacked website on the domain, or links that lead somewhere harmful.`,
          fix: [
            `Open the ${result.name} lookup for your domain. It says why the domain was listed.`,
            'Fix that cause first: a list will not remove a domain that is still doing what got it listed.',
            'Then use the removal request on the same page. Do not send large emails until the listing is gone.',
          ],
          external: [{ label: `Look up ${check.domain} on ${result.name}`, url: result.lookupUrl }],
        }),
      );
    }
    if (unsure.length) {
      out.push(
        finding({
          id: 'blocklist',
          subject: `${check.domain} unchecked`,
          severity: 'unknown',
          title: `Could not check ${check.domain} on ${list(unsure.map((r) => r.name))}`,
          meaning:
            'These lists refuse automatic questions that reach them through shared DNS services, which is how Swarm asks. No answer is not good news or bad news. You can look the domain up yourself in a few seconds.',
          fix: [
            'Open each lookup page and search for your domain. "Not listed" means all is well.',
          ],
          external: unsure.map((r) => ({
            label: `Look up ${check.domain} on ${r.name}`,
            url: r.lookupUrl,
          })),
        }),
      );
    }
    if (clean.length && !listed.length) {
      out.push(
        finding({
          id: 'blocklist',
          subject: `${check.domain} clean`,
          severity: 'good',
          title: `${check.domain} is not on ${list(clean.map((r) => r.name))}`,
          meaning: 'Checked just now against the list itself.',
        }),
      );
    }
  }
  return out;
}

function rateFindings(facts: CheckupFacts): CheckupFinding[] {
  if (!facts.providers.ok)
    return [unknown('sending_volume', 'Could not read your sending numbers')];
  const providers = facts.providers.value;
  const sent = providers.reduce((sum, p) => sum + p.sent, 0);
  const bounced = providers.reduce((sum, p) => sum + p.bounced, 0);
  const complaints = complaintSummary(providers);

  if (sent < CHECKUP.minSent) {
    return [
      finding({
        id: 'sending_volume',
        severity: 'unknown',
        title: 'Not enough sending yet to judge bounces and complaints',
        meaning: `You sent ${plural(sent, 'email', 'emails')} in the last ${CHECKUP.days} days. Rates from fewer than ${CHECKUP.minSent} say more about chance than about your list, so none are shown.`,
        fix: ['Nothing to do. Run the check-up again after your next few sends.'],
      }),
    ];
  }

  const out: CheckupFinding[] = [];
  const bounceRate = bounced / sent;
  if (bounceRate >= CHECKUP.bounceWarning) {
    const problem = bounceRate > CHECKUP.bounceProblem;
    out.push(
      finding({
        id: 'bounce_rate',
        severity: problem ? 'problem' : 'warning',
        title: `${percent(bounceRate)} of your emails bounced`,
        meaning: `${plural(bounced, 'email', 'emails')} out of ${number(sent)} in the last ${CHECKUP.days} days could not be delivered. Mailbox providers read a high bounce rate as a list that was bought, scraped or left to go stale, and start filing the rest as spam. ${problem ? `Over ${percent(CHECKUP.bounceProblem, 0)} also pauses your warm-up.` : `The limit is ${percent(CHECKUP.bounceProblem, 0)}; you are getting close.`}`,
        fix: [
          'Swarm stops mailing addresses that bounce, by the bounce rules in Sending. You do not need to remove them.',
          'Think about where recent subscribers came from. An imported or old list is the usual cause: send to it in small parts, or ask those people to confirm again.',
          'Turn on double opt-in so mistyped and fake addresses never get onto the list.',
        ],
        link: 'subscribers',
      }),
    );
  } else {
    out.push(
      finding({
        id: 'bounce_rate',
        severity: 'good',
        title: `Bounce rate is ${percent(bounceRate)}`,
        meaning: `${plural(bounced, 'email', 'emails')} out of ${number(sent)} bounced in the last ${CHECKUP.days} days. Under ${percent(CHECKUP.bounceWarning, 0)} is healthy.`,
      }),
    );
  }

  out.push(...blockFindings(providers));

  const rate = complaints.rate ?? 0;
  const standing = complaintStanding(complaints.rate);
  const gmailNote =
    'Gmail does not tell senders about individual complaints, so the real figure for Gmail readers is in Google Postmaster Tools.';
  if (standing !== 'good' && complaints.complained >= CHECKUP.minComplaints) {
    const over = standing === 'over';
    out.push(
      finding({
        id: 'complaint_rate',
        severity: over ? 'problem' : 'warning',
        title: `${percent(rate, 2)} of readers marked your email as spam`,
        meaning: `${plural(complaints.complained, 'complaint', 'complaints')} from ${number(complaints.delivered)} delivered emails in the last ${CHECKUP.days} days. Gmail and Yahoo ask senders to stay under ${percent(GMAIL_COMPLAINT_TARGET, 1)} and treat ${percent(GMAIL_COMPLAINT_THRESHOLD, 1)} as the ceiling: ${over ? 'above it they send your mail to spam for everyone.' : 'you are between the two, so act before it climbs.'} ${gmailNote}`,
        fix: [
          'People who complained are already blocked from future sends.',
          'Send only to people who asked for this newsletter. If you imported or added people recently, that is the likely cause.',
          'Say in the first lines who you are and why they are getting this. Readers who do not remember signing up press spam.',
          'Turn on inactive-reader cleanup in Sending so people who stopped reading leave the list quietly.',
        ],
        link: 'deliverability',
        external: [PROVIDER_TOOL.gmail!],
      }),
    );
  } else {
    out.push(
      finding({
        id: 'complaint_rate',
        severity: 'good',
        title:
          complaints.complained === 0
            ? 'No spam complaints'
            : `Complaint rate is ${percent(rate, 2)}`,
        meaning: `${plural(complaints.complained, 'complaint', 'complaints')} from ${number(complaints.delivered)} delivered emails in the last ${CHECKUP.days} days.${standing !== 'good' ? ' One complaint is too few to call a trend, so it is not counted against you.' : ` Gmail and Yahoo ask for under ${percent(GMAIL_COMPLAINT_TARGET, 1)}.`} ${gmailNote}`,
        external: [PROVIDER_TOOL.gmail!],
      }),
    );
  }

  // One provider opening far less than the rest usually means the spam folder there. iCloud is
  // left out on both sides: Apple's privacy protection hides most of its real opens.
  const comparable = providers.filter(
    (p) => p.provider !== 'apple' && p.delivered > 0 && p.openRate !== null,
  );
  const gaps: CheckupFinding[] = [];
  let compared = 0;
  for (const provider of comparable) {
    if (provider.provider === 'other' || provider.delivered < CHECKUP.providerMinDelivered)
      continue;
    const others = comparable.filter((p) => p.provider !== provider.provider);
    const delivered = others.reduce((sum, p) => sum + p.delivered, 0);
    if (delivered < CHECKUP.providerMinDelivered) continue;
    const othersRate = others.reduce((sum, p) => sum + p.opened, 0) / delivered;
    if (othersRate < CHECKUP.providerMinOpenRate) continue;
    compared += 1;
    const own = provider.openRate ?? 0;
    if (own >= othersRate * CHECKUP.providerGapRatio) continue;
    const name = PROVIDER_NAME[provider.provider];
    const tool = PROVIDER_TOOL[provider.provider];
    gaps.push(
      finding({
        id: 'provider_gap',
        subject: name,
        severity: 'warning',
        title: `${name} readers open far less than everyone else`,
        meaning: `${percent(own)} of ${number(provider.delivered)} emails delivered to ${name} were opened, against ${percent(othersRate)} at other providers. A gap this large usually means ${name} is putting your email in the spam folder. Swarm cannot see inside a mailbox, so this is the best sign available.`,
        fix: [
          `Send a test to your own address at ${name} and see where it lands.`,
          ...(tool ? [`Sign up for ${tool.label}: it shows how ${name} rates your domain.`] : []),
          `For a few sends, mail only your most engaged ${name} readers (a segment of people who opened recently). Good engagement is what moves you back to the inbox.`,
          'Fix every problem above this one first: authentication and complaints are what providers judge.',
        ],
        link: 'deliverability',
        external: tool ? [tool] : [],
      }),
    );
  }
  if (gaps.length) out.push(...gaps);
  else if (compared > 0) {
    out.push(
      finding({
        id: 'provider_gap',
        severity: 'good',
        title: 'No mailbox provider stands out with low opens',
        meaning:
          'Open rates at Gmail, Outlook and Yahoo are in line with each other, so none of them appears to be filing you as spam.',
      }),
    );
  }
  return out;
}

/**
 * A mailbox provider refusing mail because of the sender (bounce rules: "blocked"). The subscribers
 * are kept, since it is not their fault, so the fix is the sender's reputation at that provider.
 */
function blockFindings(providers: ProviderStats[]): CheckupFinding[] {
  const out: CheckupFinding[] = [];
  let sent = 0;
  for (const provider of providers) {
    sent += provider.sent;
    if (provider.provider === 'other' || !provider.sent) continue;
    const share = provider.blocked / provider.sent;
    if (provider.blocked < CHECKUP.blockMinCount || share < CHECKUP.blockWarning) continue;
    const name = PROVIDER_NAME[provider.provider];
    const tool = PROVIDER_TOOL[provider.provider];
    out.push(
      finding({
        id: 'provider_blocks',
        subject: name,
        severity: share > CHECKUP.blockProblem ? 'problem' : 'warning',
        title: `${name} is refusing some of your emails`,
        meaning: `${name} refused ${plural(provider.blocked, 'email', 'emails')} of ${number(provider.sent)} in the last ${CHECKUP.days} days because of the sender, not the address: your domain's reputation at ${name}, its authentication (SPF, DKIM, DMARC), a blocklist, or what the emails contained. Swarm keeps these subscribers, because it is not their fault. The refusals count towards your bounce rate and can pause your warm-up.`,
        fix: [
          'Fix every problem above this one first: authentication and complaints are what mailbox providers judge.',
          `Open a ${name} subscriber whose email was refused: their page shows what ${name} said, which usually names the reason and links to ${name}'s help for senders.`,
          ...(tool ? [`Sign up for ${tool.label} to see how ${name} rates your domain.`] : []),
          `For a few sends, mail only your most engaged ${name} readers (a segment of people who opened recently), so ${name} sees that people want your email.`,
        ],
        link: 'deliverability',
        external: tool ? [tool] : [],
      }),
    );
  }
  if (!out.length && sent > 0) {
    out.push(
      finding({
        id: 'provider_blocks',
        severity: 'good',
        title: 'No mailbox provider is refusing your email',
        meaning: `No provider refused more than a few of your emails because of the sender in the last ${CHECKUP.days} days.`,
      }),
    );
  }
  return out;
}

function warmupFindings(facts: CheckupFacts): CheckupFinding[] {
  const out: CheckupFinding[] = [];
  if (facts.channel.ok && facts.channel.value.paused) {
    out.push(
      finding({
        id: 'publication_paused',
        severity: 'problem',
        title: 'This publication is paused',
        meaning: 'A paused publication sends nothing at all: no posts and no automations.',
        fix: ['In the publication settings, set the publication back to active.'],
        link: 'publication',
      }),
    );
  }
  if (!facts.ramps.ok) return [...out, unknown('warmup', 'Could not read your warm-up')];
  for (const ramp of facts.ramps.value) {
    if (ramp.status === 'paused') {
      out.push(
        finding({
          id: 'warmup',
          subject: ramp.domain,
          severity: 'problem',
          title: `Warm-up for ${ramp.domain} is paused, so nothing is being sent`,
          meaning: `${ramp.pausedReason ?? 'It was paused by hand.'} Swarm pauses sending on its own when bounces or complaints jump, because carrying on would damage your reputation further. Posts wait until you resume.`,
          fix: [
            'Find out what caused it first: look at the bounce and complaint findings in this check-up.',
            'When the cause is dealt with, resume the warm-up in Sending.',
            'Read docs/warm-up.md for what a pause means and how the daily limit recovers.',
          ],
          link: 'sending',
        }),
      );
    } else if (ramp.status === 'warming') {
      out.push(
        finding({
          id: 'warmup',
          subject: ramp.domain,
          severity: 'good',
          title: `Warm-up for ${ramp.domain} is in progress`,
          meaning: `Today's limit is ${plural(ramp.capToday, 'email', 'emails')}. A new domain has no reputation, so Swarm raises the daily amount step by step. A send larger than the limit is spread over the following days, which is expected and not a fault.`,
          link: 'sending',
        }),
      );
    }
  }
  return out;
}

/**
 * Email checks: one finding, only with the feature on and a list big enough to matter. Without
 * DeBounce it says what checking would do ("unknown", so it never lowers the score).
 */
function emailCheckFindings(facts: CheckupFacts): CheckupFinding[] {
  const settled = facts.emailChecks;
  if (!settled) return [];
  if (!settled.ok) throw new Error('email checks not read');
  const f = settled.value;
  if (!f.enabled || f.subscribers < CHECKUP.emailCheckMinSubscribers) return [];
  if (!f.available) {
    return [
      finding({
        id: 'email_check',
        severity: 'unknown',
        title: 'Your subscribers’ addresses have not been checked',
        meaning:
          'Swarm can check every address with DeBounce, an email verification service, and tell you which ones will bounce before you send. Bounces hurt how mailbox providers see you.',
        fix: f.keySet
          ? [
              'Ask the owner of this Swarm to let this workspace use DeBounce, on the DeBounce card under Apps.',
            ]
          : [
              'The owner of this Swarm creates a DeBounce account and sets it up once with `pnpm swarm enable debounce`.',
            ],
        link: 'email_check',
        external: f.keySet
          ? []
          : [{ label: 'Create a DeBounce account', url: DEBOUNCE_SIGNUP_URL }],
      }),
    ];
  }
  const redShare = f.checked ? f.red / f.checked : 0;
  if (f.checked >= CHECKUP.emailCheckMinSubscribers / 2 && redShare >= CHECKUP.emailRedWarning) {
    return [
      finding({
        id: 'email_check',
        severity: 'warning',
        title: `${number(f.red)} ${f.red === 1 ? 'address' : 'addresses'} on your list will bounce`,
        meaning: `${percent(redShare, 1)} of the checked addresses are red: they don’t exist, are not real addresses or are spam traps. Every email to them bounces, and a high bounce rate gets you sent to spam.`,
        fix: ['On the Subscribers page, filter by "Red", then choose "Stop mailing them".'],
        link: 'subscribers',
      }),
    ];
  }
  if (f.unchecked / f.subscribers >= CHECKUP.emailUncheckedWarning) {
    return [
      finding({
        id: 'email_check',
        severity: 'warning',
        title: `${percent(f.unchecked / f.subscribers, 0)} of your list has never been checked`,
        meaning: `${number(f.unchecked)} subscribers have no email check yet. Old or imported addresses are the ones most likely to bounce.`,
        fix: [
          'On the Subscribers page, choose "Check addresses". You see how many credits it takes before it starts.',
        ],
        link: 'subscribers',
      }),
    ];
  }
  return [
    finding({
      id: 'email_check',
      severity: 'good',
      title: 'Your subscribers’ addresses are checked',
      meaning: `${number(f.checked)} of ${number(f.subscribers)} addresses have an email check, and few of them are red.`,
    }),
  ];
}

function listFindings(facts: CheckupFacts): CheckupFinding[] {
  const out: CheckupFinding[] = [];
  const channel = facts.channel.ok ? facts.channel.value : null;
  if (!facts.channel.ok) {
    out.push(unknown('confirm_opt_in', 'Could not read your publication settings'));
  }

  if (facts.list.ok) {
    const facts_ = facts.list.value;
    const optInOff = channel ? !channel.requireConfirmation && !channel.doubleOptIn : false;
    if (facts_.formsWithoutConfirm.length || optInOff) {
      const forms = facts_.formsWithoutConfirm;
      out.push(
        finding({
          id: 'confirm_opt_in',
          severity: 'warning',
          title: forms.length
            ? `${plural(forms.length, 'signup form adds', 'signup forms add')} people without confirmation`
            : 'Double opt-in is off',
          meaning:
            'Without a confirmation email, anyone can type any address into a form: typos, fake addresses, bots, and people signed up by someone else. Those bounce or complain, and both count against you. Confirmed subscribers are the single best protection for your reputation.',
          fix: [
            ...(optInOff ? ['In the publication settings, turn on "Double opt-in".'] : []),
            ...(forms.length
              ? [
                  `In Signup forms, set double opt-in to on (or to the publication default) for: ${list(forms.slice(0, 5))}${forms.length > 5 ? ' and others' : ''}.`,
                ]
              : []),
          ],
          link: optInOff ? 'publication' : 'forms',
        }),
      );
    } else if (channel) {
      out.push(
        finding({
          id: 'confirm_opt_in',
          severity: 'good',
          title: 'New subscribers confirm by email',
          meaning: 'Double opt-in keeps typos, bots and unwilling addresses off your list.',
        }),
      );
    }

    if (facts_.engagementKnown && facts_.measured >= CHECKUP.inactiveMinMeasured) {
      const share = facts_.inactive / facts_.measured;
      if (share >= CHECKUP.inactiveShareWarning) {
        out.push(
          finding({
            id: 'inactive_share',
            severity: 'warning',
            title: `${percent(share, 0)} of your subscribers have not opened in ${CHECKUP.inactiveDays} days`,
            meaning: `${number(facts_.inactive)} of ${number(facts_.measured)} subscribers who get your emails regularly have not opened or clicked one in ${CHECKUP.inactiveDays} days. Mailbox providers watch how many people ignore you. A large silent share drags down delivery for the readers who do want your email, and old unused addresses can be turned into spam traps.`,
            fix: [
              'Send these readers one "do you still want this?" email (make a segment of people who have not opened in 180 days).',
              'Then turn on inactive-reader cleanup in Sending, so anyone who stays silent is unsubscribed for you.',
            ],
            link: 'sending',
          }),
        );
      } else {
        out.push(
          finding({
            id: 'inactive_share',
            severity: 'good',
            title: 'Most of your subscribers are reading',
            meaning: `${percent(share, 0)} of regular recipients have not opened or clicked in ${CHECKUP.inactiveDays} days. Under ${percent(CHECKUP.inactiveShareWarning, 0)} is fine.`,
          }),
        );
      }
    }

    if (facts_.recentImport) {
      const days = Math.max(0, Math.floor((facts.now - facts_.recentImport.completedAt) / DAY_MS));
      out.push(
        finding({
          id: 'recent_import',
          severity: 'warning',
          title: `You imported ${plural(facts_.recentImport.rows, 'address', 'addresses')} ${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`,
          meaning:
            'A large import is the most common reason a healthy sender suddenly lands in spam. Mailbox providers notice a jump in volume to people who have never heard from this domain, and an older list carries dead addresses and people who have forgotten you.',
          fix: [
            'Do not send to the whole import at once. Start with a part of it and watch bounces and complaints here after each send.',
            'Introduce yourself in the first email: who you are and why they are hearing from you.',
            'If bounces go over 2%, stop and clean the list before sending to the rest.',
          ],
          link: 'subscribers',
        }),
      );
    }
  } else {
    out.push(unknown('inactive_share', 'Could not read your list health'));
  }

  if (channel) {
    if (channel.seesOpens === false) {
      // Tracking choices (tracking-choices.ts): without opens nobody can be judged inactive.
      out.push(
        finding({
          id: 'inactive_cleanup',
          severity: 'unknown',
          title: 'Inactive-reader cleanup needs open tracking',
          meaning:
            'This publication does not track opens or does not keep reader profiles, so Swarm cannot tell who has stopped reading and unsubscribes nobody for it.',
          fix: [
            'Every few months, send one "do you still want this?" email and remove addresses that bounce.',
            'Or, once your readers have agreed to it, turn open tracking and reader profiles on in Sending, under "Tracking".',
          ],
          link: 'sending',
        }),
      );
    } else if (channel.sunsetDays === null) {
      out.push(
        finding({
          id: 'inactive_cleanup',
          severity: 'warning',
          title: 'Inactive-reader cleanup is off',
          meaning:
            'People who stopped opening long ago stay on your list forever. They lower your open rates in the eyes of mailbox providers, and abandoned addresses eventually bounce or become spam traps.',
          fix: [
            'In Sending, under "Inactive readers", choose after how long someone who never opens is unsubscribed. Six months to a year suits most newsletters.',
            'Paying subscribers are never removed by this.',
          ],
          link: 'sending',
        }),
      );
    } else {
      out.push(
        finding({
          id: 'inactive_cleanup',
          severity: 'good',
          title: `Readers inactive for ${channel.sunsetDays} days are unsubscribed`,
          meaning: 'Your list cleans itself, which keeps engagement up and spam traps out.',
        }),
      );
    }

    if (!channel.designOn || !channel.footer.trim()) {
      out.push(
        finding({
          id: 'footer_address',
          severity: 'warning',
          title: 'Your emails have no postal address in the footer',
          meaning:
            'Anti-spam laws such as CAN-SPAM in the United States require every newsletter to carry a postal address where the sender can be reached. Spam filters look for one too, and readers trust email that says who is behind it. A PO box or a business address is enough.',
          fix: channel.designOn
            ? ['In Sending, under "Email design", put your postal address in the "Footer" field.']
            : [
                'In Sending, under "Email design", put your postal address in the "Footer" field.',
                'If there is no Email design section, ask whoever runs this Swarm to turn that feature on. Until then, add the address at the end of each post.',
              ],
          link: 'sending',
        }),
      );
    } else {
      out.push(
        finding({
          id: 'footer_address',
          severity: 'good',
          title: 'Your emails carry a footer line',
          meaning:
            'Swarm cannot tell whether it is a postal address. Make sure it contains one: anti-spam laws such as CAN-SPAM require it.',
        }),
      );
    }
  }
  return out;
}

const SCORE_NOTE = `100, minus ${CHECKUP.problemPoints} for each problem and ${CHECKUP.warningPoints} for each warning, never below 0. Checks that could not run do not change it.`;

/** How the score is worked out, for showing next to it. */
export const CHECKUP_SCORE_NOTE = SCORE_NOTE;

/**
 * Facts in, check-up out. Pure, and it never throws: a group of checks that fails becomes one
 * "couldn't check" finding and the rest carry on.
 */
export function buildCheckup(facts: CheckupFacts): DeliverabilityCheckup {
  const groups: [CheckupFindingId, string, (facts: CheckupFacts) => CheckupFinding[]][] = [
    ['warmup', 'Could not check whether sending is paused', warmupFindings],
    ['sender', 'Could not check your sender', senderFindings],
    ['sending_domain', 'Could not check your sending domain', domainFindings],
    ['blocklist', 'Could not check domain blocklists', blocklistFindings],
    ['sending_volume', 'Could not read your sending numbers', rateFindings],
    ['confirm_opt_in', 'Could not check your list settings', listFindings],
    ['email_check', 'Could not check how many addresses were checked', emailCheckFindings],
  ];
  const findings: CheckupFinding[] = [];
  for (const [id, title, run] of groups) {
    try {
      findings.push(...run(facts));
    } catch {
      findings.push(unknown(id, title));
    }
  }

  const rank = (f: CheckupFinding) =>
    CHECKUP_SEVERITIES.indexOf(f.severity) * 100 + IMPACT_ORDER.indexOf(f.id);
  // A stable sort keeps a domain's findings in the order they were made within one rank.
  findings.sort((a, b) => rank(a) - rank(b));

  const counts = { problem: 0, warning: 0, unknown: 0, good: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const score = Math.max(
    0,
    100 - counts.problem * CHECKUP.problemPoints - counts.warning * CHECKUP.warningPoints,
  );
  return {
    checkedAt: new Date(facts.now).toISOString(),
    verdict: counts.problem ? 'problems' : counts.warning ? 'warnings' : 'healthy',
    score,
    counts,
    from: facts.sender.ok
      ? { name: facts.sender.value.name, address: facts.sender.value.address }
      : null,
    findings,
  };
}

// ---- Gathering -----------------------------------------------------------------------------

async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch {
    return { ok: false };
  }
}

export interface CheckupDeps {
  db: D1Database;
  config: EngineConfig;
  /** DNS for the record checks. */
  dns: DnsLookup;
  /** The domain DMARC reports are mailed to (DMARC_MAIL_DOMAIN). */
  dmarcMailDomain: string;
  /**
   * Looks a domain up on the blocklists. The caller owns the resolver, the timeout and any
   * caching; the default asks through `dns` with the standard timeout.
   */
  blocklists?: (domain: string) => Promise<DomainBlocklistCheck>;
  /** Whether DeBounce is set up (DEBOUNCE_API_KEY), for the email check finding. */
  emailCheckEnv?: DebounceEnv;
  now?: number;
}

interface DomainDbRow {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  verified_at: number | null;
  records_json: string;
}

async function domainFacts(
  deps: CheckupDeps,
  row: DomainDbRow,
  range: DayRange,
): Promise<CheckupDomainFacts> {
  const [records, dmarc, reports] = await Promise.all([
    settle(async () => {
      const expected = (JSON.parse(row.records_json) as DnsRecord[]).filter(
        (record) => record.purpose !== 'dmarc' && record.purpose !== 'link',
      );
      const checked = await checkRecords(expected, deps.dns);
      return checked.map(({ check, ...record }) => ({
        ...record,
        state: check.state,
        found: check.found,
      }));
    }),
    settle(async () => {
      const own = (await deps.dns.lookup(`_dmarc.${row.domain}`, 'TXT')).filter((value) =>
        /^v=DMARC1\s*(;|$)/i.test(value.trim()),
      );
      const policy = await lookupDmarc({ txt: (name) => deps.dns.lookup(name, 'TXT') }, row.domain);
      const address = dmarcReportAddress(row.id, deps.dmarcMailDomain);
      return {
        policy,
        published: own.length,
        reportsHere: own.some((value) => recordReportsTo(value, address)),
      };
    }),
    settle(async () => {
      const totals = await first<{ last: number | null; messages: number; aligned: number }>(
        deps.db,
        `SELECT (SELECT max(created_at) FROM dmarc_reports WHERE sending_domain_id = ?1) AS last,
                coalesce(sum(message_count), 0) AS messages, coalesce(sum(pass_count), 0) AS aligned
           FROM dmarc_reports WHERE sending_domain_id = ?1 AND begin_at >= ?2 AND begin_at < ?3`,
        row.id,
        range.startMs,
        range.endMs,
      );
      return {
        lastReportAt: totals?.last ?? null,
        messages: totals?.messages ?? 0,
        aligned: totals?.aligned ?? 0,
      };
    }),
  ]);
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    verifiedAt: row.verified_at,
    records,
    dmarc,
    reports,
  };
}

async function listFacts(db: D1Database, channelId: string, now: number, settings: unknown) {
  const forms = await all<{ name: string; config: string | null }>(
    db,
    `SELECT name, published_config_json AS config FROM capture_forms
      WHERE channel_id = ?1 AND status = 'published' AND deleted_at IS NULL ORDER BY created_at`,
    channelId,
  );
  const channelSettings = (settings ?? {}) as {
    doubleOptIn?: unknown;
    requireConfirmation?: unknown;
  };
  const formsWithoutConfirm = forms
    .filter((form) => {
      let own: boolean | null = null;
      try {
        const value = (JSON.parse(form.config ?? '{}') as { doubleOptIn?: unknown }).doubleOptIn;
        own = typeof value === 'boolean' ? value : null;
      } catch {
        own = null;
      }
      // Only a form that itself turns confirmation off. One that follows a publication default
      // of "off" is covered by the publication's own finding.
      return own === false && !resolveDoubleOptIn(own, channelSettings);
    })
    .map((form) => form.name);

  const engagement = await first<{
    active: number;
    measured: number;
    inactive: number;
    fresh: number;
  }>(
    db,
    `SELECT (SELECT count(*) FROM members WHERE channel_id = ?1 AND status = 'active') AS active,
            coalesce(sum(e.sent_count >= ?2 AND e.band NOT IN ('too_few_posts', 'opens_hidden')), 0) AS measured,
            coalesce(sum(e.sent_count >= ?2 AND e.band NOT IN ('too_few_posts', 'opens_hidden')
                         AND coalesce(e.last_engaged_at, 0) < ?3), 0) AS inactive,
            count(e.member_id) AS fresh
       FROM members m JOIN member_engagement e ON e.member_id = m.id AND e.computed_at > ?4
      WHERE m.channel_id = ?1 AND m.status = 'active'`,
    channelId,
    SUNSET_MIN_SENT,
    now - CHECKUP.inactiveDays * DAY_MS,
    now - 7 * DAY_MS,
  );
  const active = engagement?.active ?? 0;

  const imported = await first<{ rows: number; completed_at: number }>(
    db,
    `SELECT processed_rows AS rows, completed_at FROM import_jobs
      WHERE channel_id = ?1 AND status = 'done' AND completed_at >= ?2
      ORDER BY processed_rows DESC LIMIT 1`,
    channelId,
    now - CHECKUP.importRecentDays * DAY_MS,
  );
  const bigImport =
    imported &&
    imported.rows >= CHECKUP.importMinRows &&
    imported.rows >= active * CHECKUP.importMinShare
      ? { rows: imported.rows, completedAt: imported.completed_at }
      : null;

  return {
    formsWithoutConfirm,
    active,
    measured: engagement?.measured ?? 0,
    inactive: engagement?.inactive ?? 0,
    engagementKnown: (engagement?.fresh ?? 0) > 0,
    recentImport: bigImport,
  } satisfies CheckupListFacts;
}

/** Everything the check-up judges, each part read on its own so one failure stays one failure. */
export async function gatherCheckupFacts(
  deps: CheckupDeps,
  channelId: string,
): Promise<CheckupFacts> {
  const now = deps.now ?? Date.now();
  const { db, config } = deps;
  const days = deliverabilityRange({}, now) as DayRange;

  const channelRow = await settle(async () => {
    const row = await first<{
      id: string;
      workspace_id: string;
      slug: string;
      name: string;
      status: 'active' | 'paused';
      settings_json: string;
    }>(
      db,
      'SELECT id, workspace_id, slug, name, status, settings_json FROM channels WHERE id = ?1',
      channelId,
    );
    if (!row) throw new Error('channel not found');
    return { ...row, settings: JSON.parse(row.settings_json) as Record<string, unknown> };
  });

  const channel = await settle(async (): Promise<CheckupChannelFacts> => {
    if (!channelRow.ok) throw new Error('channel not read');
    const { settings } = channelRow.value;
    const design = EmailDesignSchema.safeParse(settings.emailDesign ?? {});
    const flags = await new FlagService(new D1FlagStore(db)).all({
      workspaceId: channelRow.value.workspace_id,
      channelId,
    });
    const sunset = settings.sunsetDays;
    return {
      name: channelRow.value.name,
      paused: channelRow.value.status === 'paused',
      doubleOptIn: settings.doubleOptIn !== false,
      requireConfirmation: settings.requireConfirmation === true,
      sunsetDays: typeof sunset === 'number' && sunset >= 90 ? sunset : null,
      footer: design.success ? design.data.footer : '',
      designOn: flags.email_design,
      seesOpens: settings.trackOpens !== false && settings.profileReaders !== false,
    };
  });

  const sender = await settle(async (): Promise<CheckupSenderFacts> => {
    if (!channelRow.ok) throw new Error('channel not read');
    const resolved = await resolveSender(db, config, channelRow.value, null);
    const identity = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM sender_identities WHERE channel_id = ?1 AND is_default = 1',
      channelId,
    );
    return {
      hasIdentity: (identity?.n ?? 0) > 0,
      name: resolved.name,
      address: resolved.address,
      replyTo: resolved.replyTo,
      sendingDomainId: resolved.sendingDomainId,
    };
  });

  const domainRows = await settle(() =>
    all<DomainDbRow>(
      db,
      // Domains a sender uses, the default sender's first. A domain nobody sends from yet is not
      // a delivery problem, so it is left to the Sending page.
      `SELECT sd.id, sd.domain, sd.status, sd.verified_at, sd.records_json
         FROM sending_domains sd
        WHERE sd.channel_id = ?1 AND sd.kind = 'email'
          AND EXISTS (SELECT 1 FROM sender_identities si WHERE si.sending_domain_id = sd.id)
        ORDER BY (SELECT max(si.is_default) FROM sender_identities si WHERE si.sending_domain_id = sd.id) DESC,
                 sd.created_at
        LIMIT 3`,
      channelId,
    ),
  );

  const blocklist =
    deps.blocklists ?? ((domain: string) => checkDomainBlocklists(domain, deps.dns));

  const [domains, providers, ramps, list, blocklists] = await Promise.all([
    settle(async () => {
      if (!domainRows.ok) throw new Error('domains not read');
      return Promise.all(domainRows.value.map((row) => domainFacts(deps, row, days)));
    }),
    settle(() => providerBreakdown(db, channelId, days)),
    settle(async (): Promise<CheckupRampFacts[]> => {
      const rows = await all<{
        domain: string | null;
        status: CheckupRampFacts['status'];
        paused_reason: string | null;
        cap_today: number;
      }>(
        db,
        `SELECT sd.domain, r.status, r.paused_reason, r.cap_today
           FROM reputation_ramps r LEFT JOIN sending_domains sd ON sd.id = r.sending_domain_id
          WHERE r.channel_id = ?1 ORDER BY r.sending_domain_id IS NOT NULL, r.created_at`,
        channelId,
      );
      return rows.map((row) => ({
        domain: row.domain ?? config.platformMailDomain,
        status: row.status,
        pausedReason: row.paused_reason,
        capToday: row.cap_today,
      }));
    }),
    settle(() =>
      listFacts(db, channelId, now, channelRow.ok ? channelRow.value.settings : undefined),
    ),
    settle(async () => {
      // The domain readers see in the From address: the default sender's, shared or not.
      const names = new Set<string>();
      if (sender.ok)
        names.add(sender.value.address.slice(sender.value.address.lastIndexOf('@') + 1));
      if (domainRows.ok) for (const row of domainRows.value) names.add(row.domain);
      if (!names.size) throw new Error('no domain to check');
      return Promise.all([...names].slice(0, 3).map((name) => blocklist(name.toLowerCase())));
    }),
  ]);

  return {
    now,
    sharedDomain: config.platformMailDomain,
    channel,
    sender,
    domains,
    providers,
    ramps,
    list,
    blocklists,
    ...(deps.emailCheckEnv
      ? {
          emailChecks: await settle(() => emailCheckFacts(db, deps.emailCheckEnv!, channelId, now)),
        }
      : {}),
  };
}

/** The whole check-up for one Channel. Never throws for a check that failed. */
export async function deliverabilityCheckup(
  deps: CheckupDeps,
  channelId: string,
): Promise<DeliverabilityCheckup> {
  return buildCheckup(await gatherCheckupFacts(deps, channelId));
}
