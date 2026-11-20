// Development only: canned check-up answers for ?mock=1. ?checkup=problems (the default),
// warnings, healthy, unknown or error picks the state; it sticks for the tab like ?mock.
/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = 'swarm:mock-checkup';
const DOMAIN = 'news.fieldnotes.example';

export function rememberCheckupScenario(): void {
  const wanted = new URLSearchParams(location.search).get('checkup');
  if (wanted) sessionStorage.setItem(KEY, wanted);
}

const f = (
  id: string,
  severity: 'problem' | 'warning' | 'unknown' | 'good',
  title: string,
  meaning: string,
  extra: {
    subject?: string;
    fix?: string[];
    link?: [string, string];
    external?: [string, string][];
  } = {},
) => ({
  id,
  subject: extra.subject ?? null,
  severity,
  title,
  meaning,
  fix: extra.fix ?? [],
  link: extra.link ? { to: extra.link[0], label: extra.link[1] } : null,
  external: (extra.external ?? []).map(([label, url]) => ({ label, url })),
});

const SENDING: [string, string] = ['sending', 'Open Sending settings'];

const PROBLEMS = [
  f(
    'dmarc_policy',
    'problem',
    `The DMARC policy of ${DOMAIN} is "none"`,
    'p=none only asks for reports. It does not stop anyone from faking your address, and mailbox providers trust a domain less when its owner has not taken a stand. Swarm needs quarantine or reject before the first send.',
    {
      subject: DOMAIN,
      fix: [
        `In your DNS, change p=none to p=quarantine in the TXT record at _dmarc.${DOMAIN}.`,
        'If other tools also send email as this domain (your office mail, a shop, a help desk), make sure they are signed with DKIM first, or their mail will go to spam.',
      ],
      link: SENDING,
    },
  ),
  f(
    'complaint_rate',
    'problem',
    '0.41% of readers marked your email as spam',
    '52 complaints from 12,731 delivered emails in the last 30 days. Gmail and Yahoo ask senders to stay under 0.1% and treat 0.3% as the ceiling: above it they send your mail to spam for everyone. Gmail does not tell senders about individual complaints, so the real figure for Gmail readers is in Google Postmaster Tools.',
    {
      fix: [
        'People who complained are already blocked from future sends.',
        'Send only to people who asked for this newsletter. If you imported or added people recently, that is the likely cause.',
        'Say in the first lines who you are and why they are getting this. Readers who do not remember signing up press spam.',
        'Turn on inactive-reader cleanup in Sending so people who stopped reading leave the list quietly.',
      ],
      link: ['deliverability', 'See the details on this page'],
      external: [['Google Postmaster Tools', 'https://postmaster.google.com/']],
    },
  ),
  f(
    'dns_return_path_mx',
    'problem',
    `The return path MX record of ${DOMAIN} is missing`,
    'This record is where bounces come back to. Without it bounces can get lost, dead addresses stay on your list, and SPF cannot line up with your domain.',
    {
      subject: DOMAIN,
      fix: [
        'Open the DNS settings where your domain is registered or hosted.',
        `Add a MX record, name bounce.${DOMAIN}, value 10 feedback-smtp.eu-west-1.amazonses.com`,
        'DNS changes can take up to an hour to show. Then press "Check again" on the domain in Sending.',
      ],
      link: SENDING,
    },
  ),
];

const WARNINGS = [
  f(
    'provider_gap',
    'warning',
    'Outlook readers open far less than everyone else',
    '8.0% of 1,500 emails delivered to Outlook were opened, against 44.1% at other providers. A gap this large usually means Outlook is putting your email in the spam folder. Swarm cannot see inside a mailbox, so this is the best sign available.',
    {
      subject: 'Outlook',
      fix: [
        'Send a test to your own address at Outlook and see where it lands.',
        'Sign up for Microsoft SNDS: it shows how Outlook rates your domain.',
        'For a few sends, mail only your most engaged Outlook readers (a segment of people who opened recently). Good engagement is what moves you back to the inbox.',
        'Fix every problem above this one first: authentication and complaints are what providers judge.',
      ],
      link: ['deliverability', 'See the details on this page'],
      external: [['Microsoft SNDS', 'https://sendersupport.olc.protection.outlook.com/snds/']],
    },
  ),
  f(
    'confirm_opt_in',
    'warning',
    '2 signup forms add people without confirmation',
    'Without a confirmation email, anyone can type any address into a form: typos, fake addresses, bots, and people signed up by someone else. Those bounce or complain, and both count against you. Confirmed subscribers are the single best protection for your reputation.',
    {
      fix: [
        'In Signup forms, set double opt-in to on (or to the publication default) for: Footer form and Popup.',
      ],
      link: ['forms', 'Open signup forms'],
    },
  ),
  f(
    'inactive_cleanup',
    'warning',
    'Inactive-reader cleanup is off',
    'People who stopped opening long ago stay on your list forever. They lower your open rates in the eyes of mailbox providers, and abandoned addresses eventually bounce or become spam traps.',
    {
      fix: [
        'In Sending, under "Inactive readers", choose after how long someone who never opens is unsubscribed. Six months to a year suits most newsletters.',
        'Paying subscribers are never removed by this.',
      ],
      link: SENDING,
    },
  ),
  f(
    'footer_address',
    'warning',
    'Your emails have no postal address in the footer',
    'Anti-spam laws such as CAN-SPAM in the United States require every newsletter to carry a postal address where the sender can be reached. Spam filters look for one too, and readers trust email that says who is behind it. A PO box or a business address is enough.',
    {
      fix: ['In Sending, under "Email design", put your postal address in the "Footer" field.'],
      link: SENDING,
    },
  ),
];

const UNKNOWN = [
  f(
    'blocklist',
    'unknown',
    `Could not check ${DOMAIN} on Spamhaus DBL and URIBL`,
    'These lists refuse automatic questions that reach them through shared DNS services, which is how Swarm asks. No answer is not good news or bad news. You can look the domain up yourself in a few seconds.',
    {
      subject: `${DOMAIN} unchecked`,
      fix: ['Open each lookup page and search for your domain. "Not listed" means all is well.'],
      external: [
        [
          `Look up ${DOMAIN} on Spamhaus DBL`,
          'https://check.spamhaus.org/results?query=fieldnotes.example',
        ],
        [`Look up ${DOMAIN} on URIBL`, 'https://lookup.uribl.com/?domain=fieldnotes.example'],
      ],
    },
  ),
];

const GOOD = [
  f(
    'sender',
    'good',
    `You send as Mara at Field Notes <mara@${DOMAIN}>`,
    'The From address is on a domain of your own and readers can reply to it.',
    { subject: `mara@${DOMAIN}` },
  ),
  f(
    'sending_domain',
    'good',
    `${DOMAIN} is verified`,
    'Your email service confirmed that you control this domain.',
    { subject: DOMAIN },
  ),
  f(
    'dns_dkim',
    'good',
    `The DKIM record of ${DOMAIN} is in place`,
    'DNS has the value your email service expects.',
    { subject: DOMAIN },
  ),
  f(
    'bounce_rate',
    'good',
    'Bounce rate is 0.5%',
    '64 emails out of 12,795 bounced in the last 30 days. Under 1% is healthy.',
  ),
  f(
    'warmup',
    'good',
    `Warm-up for ${DOMAIN} is in progress`,
    "Today's limit is 1,012 emails. A new domain has no reputation, so Swarm raises the daily amount step by step. A send larger than the limit is spread over the following days, which is expected and not a fault.",
    { subject: DOMAIN, link: SENDING },
  ),
  f('blocklist', 'good', `${DOMAIN} is not on SURBL`, 'Checked just now against the list itself.', {
    subject: `${DOMAIN} clean`,
  }),
];

const HEALTHY_GOOD = [
  ...GOOD.filter((g) => g.id !== 'warmup' && g.id !== 'blocklist'),
  f(
    'dmarc_policy',
    'good',
    `DMARC is enforced for ${DOMAIN} (quarantine)`,
    'Mail that fakes your domain is quarantined or rejected, which is what the big mailbox providers ask for.',
    { subject: DOMAIN },
  ),
  f(
    'complaint_rate',
    'good',
    'Complaint rate is 0.02%',
    '3 complaints from 12,731 delivered emails in the last 30 days. Gmail and Yahoo ask for under 0.1%. Gmail does not tell senders about individual complaints, so the real figure for Gmail readers is in Google Postmaster Tools.',
    { external: [['Google Postmaster Tools', 'https://postmaster.google.com/']] },
  ),
  f(
    'confirm_opt_in',
    'good',
    'New subscribers confirm by email',
    'Double opt-in keeps typos, bots and unwilling addresses off your list.',
  ),
  f(
    'blocklist',
    'good',
    `${DOMAIN} is not on Spamhaus DBL, SURBL and URIBL`,
    'Checked just now against the list itself.',
    { subject: `${DOMAIN} clean` },
  ),
];

/** The mock answer for GET …/deliverability/checkup: [status, data]. */
export function mockCheckup(): [number, any] {
  const scenario = sessionStorage.getItem(KEY) ?? 'problems';
  if (scenario === 'error') {
    return [
      500,
      { error: { code: 'internal', message: 'The database is busy. Try again in a moment.' } },
    ];
  }
  const findings =
    scenario === 'healthy'
      ? HEALTHY_GOOD
      : scenario === 'unknown'
        ? [...UNKNOWN, ...HEALTHY_GOOD.filter((g) => g.id !== 'blocklist')]
        : scenario === 'warnings'
          ? [...WARNINGS.slice(1), ...UNKNOWN, ...GOOD]
          : [...PROBLEMS, ...WARNINGS, ...UNKNOWN, ...GOOD];
  const counts = { problem: 0, warning: 0, unknown: 0, good: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return [
    200,
    {
      checkedAt: new Date().toISOString(),
      verdict: counts.problem ? 'problems' : counts.warning ? 'warnings' : 'healthy',
      score: Math.max(0, 100 - 20 * counts.problem - 5 * counts.warning),
      counts,
      from: { name: 'Mara at Field Notes', address: `mara@${DOMAIN}` },
      findings,
    },
  ];
}

/** Content advice for the mock pre-send checklist, covering the common kinds. */
export const MOCK_ADVICE = [
  {
    id: 'subject_caps',
    message:
      'The subject is written in capitals. Spam filters and readers both take that as shouting. Use normal sentence case.',
  },
  {
    id: 'link_shortener',
    message:
      'A link goes through a public link shortener (bit.ly). Spammers hide behind these, so many filters distrust them. Link to the real address instead.',
  },
  {
    id: 'link_text_mismatch',
    message:
      'A link shows one web address but opens another (fieldnotes.example opens tracking.partner.example). That is how phishing emails look, and filters punish it. Use words for the link text, or make the two match.',
  },
];
