import {
  CHECKUP,
  CHECKUP_FINDING_IDS,
  type CheckedDnsRecord,
  type ProviderStats,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  buildCheckup,
  isFreeMailboxDomain,
  isNoReplyAddress,
  type CheckupDomainFacts,
  type CheckupFacts,
  type Settled,
} from '../src/checkup';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) throw new Error('not settled');
  return settled.value;
}

const DAY = 86_400_000;

const provider = (
  name: ProviderStats['provider'],
  delivered: number,
  opened: number,
  extra: Partial<ProviderStats> = {},
): ProviderStats => ({
  provider: name,
  sent: delivered + (extra.bounced ?? 0),
  delivered,
  bounced: 0,
  blocked: 0,
  complained: 0,
  opened,
  bounceRate: null,
  complaintRate: null,
  openRate: delivered ? opened / delivered : null,
  complaintStanding: 'good',
  ...extra,
});

const record = (
  purpose: CheckedDnsRecord['purpose'],
  state: CheckedDnsRecord['state'],
  found: string[] = [],
): CheckedDnsRecord => ({
  purpose,
  type: purpose === 'dkim' ? 'CNAME' : purpose === 'mail_from_mx' ? 'MX' : 'TXT',
  name: purpose === 'dkim' ? 'abc._domainkey.news.example.com' : 'bounce.news.example.com',
  value:
    purpose === 'dkim'
      ? 'abc.dkim.amazonses.com'
      : purpose === 'mail_from_mx'
        ? 'feedback-smtp.eu-west-1.amazonses.com'
        : 'v=spf1 include:amazonses.com ~all',
  ...(purpose === 'mail_from_mx' ? { priority: 10 } : {}),
  state,
  found,
});

const domain = (extra: Partial<CheckupDomainFacts> = {}): CheckupDomainFacts => ({
  id: 'sd_1',
  domain: 'news.example.com',
  status: 'verified',
  verifiedAt: NOW - 90 * DAY,
  records: {
    ok: true,
    value: [record('dkim', 'ok'), record('mail_from_mx', 'ok'), record('mail_from_spf', 'ok')],
  },
  dmarc: { ok: true, value: { policy: 'quarantine', published: 1, reportsHere: true } },
  reports: { ok: true, value: { lastReportAt: NOW - DAY, messages: 5000, aligned: 4990 } },
  ...extra,
});

/** A publication with nothing wrong: own domain, good numbers, tidy list. */
const healthy = (extra: Partial<CheckupFacts> = {}): CheckupFacts => ({
  now: NOW,
  sharedDomain: 'mail.swarm.example',
  channel: {
    ok: true,
    value: {
      name: 'Field Notes',
      paused: false,
      doubleOptIn: true,
      requireConfirmation: false,
      sunsetDays: 180,
      footer: 'Field Notes, 12 Harbour Road, Bristol BS1 4RW',
      designOn: true,
    },
  },
  sender: {
    ok: true,
    value: {
      hasIdentity: true,
      name: 'Mara',
      address: 'mara@news.example.com',
      replyTo: null,
      sendingDomainId: 'sd_1',
    },
  },
  domains: { ok: true, value: [domain()] },
  providers: {
    ok: true,
    value: [
      provider('gmail', 4000, 1800),
      provider('outlook', 1500, 600),
      provider('yahoo', 500, 210),
      provider('apple', 800, 40),
      provider('other', 1200, 500),
    ],
  },
  ramps: {
    ok: true,
    value: [{ domain: 'news.example.com', status: 'complete', pausedReason: null, capToday: 9000 }],
  },
  list: {
    ok: true,
    value: {
      formsWithoutConfirm: [],
      active: 8000,
      measured: 6000,
      inactive: 600,
      engagementKnown: true,
      recentImport: null,
    },
  },
  blocklists: {
    ok: true,
    value: [
      {
        domain: 'news.example.com',
        results: [
          {
            list: 'spamhaus_dbl',
            name: 'Spamhaus DBL',
            state: 'clean',
            reason: null,
            lookupUrl: 'https://check.spamhaus.org/results?query=example.com',
          },
        ],
      },
    ],
  },
  ...extra,
});

const run = (facts: CheckupFacts) => buildCheckup(facts);
const find = (facts: CheckupFacts, id: string, severity?: string) =>
  run(facts).findings.filter((f) => f.id === id && (!severity || f.severity === severity));
const withDomain = (extra: Partial<CheckupDomainFacts>) =>
  healthy({ domains: { ok: true, value: [domain(extra)] } });
const withProviders = (value: ProviderStats[]) => healthy({ providers: { ok: true, value } });

describe('verdict and score', () => {
  it('is healthy at 100 when nothing is wrong', () => {
    const checkup = run(healthy());
    expect(checkup.verdict).toBe('healthy');
    expect(checkup.score).toBe(100);
    expect(checkup.counts).toMatchObject({ problem: 0, warning: 0, unknown: 0 });
    expect(checkup.counts.good).toBe(checkup.findings.length);
    expect(checkup.from).toEqual({ name: 'Mara', address: 'mara@news.example.com' });
    expect(checkup.checkedAt).toBe('2026-11-12T12:00:00.000Z');
  });

  it('takes 20 off for a problem and 5 for a warning, and nothing for an unknown', () => {
    const facts = healthy({
      domains: {
        ok: true,
        value: [
          domain({
            dmarc: { ok: true, value: { policy: null, published: 0, reportsHere: false } },
          }),
        ],
      },
      blocklists: { ok: false },
    });
    facts.channel = {
      ok: true,
      value: { ...valueOf(facts.channel), sunsetDays: null },
    };
    const checkup = run(facts);
    expect(checkup.counts).toMatchObject({ problem: 1, warning: 1, unknown: 1 });
    expect(checkup.score).toBe(100 - CHECKUP.problemPoints - CHECKUP.warningPoints);
    expect(checkup.verdict).toBe('problems');
  });

  it('says warnings when there are only warnings, and never goes below 0', () => {
    const warned = healthy();
    warned.channel = {
      ok: true,
      value: { ...valueOf(warned.channel), footer: '' },
    };
    expect(run(warned)).toMatchObject({ verdict: 'warnings', score: 95 });

    const broken = withDomain({
      status: 'pending',
      records: {
        ok: true,
        value: [
          record('dkim', 'missing'),
          record('mail_from_mx', 'missing'),
          record('mail_from_spf', 'missing'),
        ],
      },
      dmarc: { ok: true, value: { policy: null, published: 0, reportsHere: false } },
    });
    broken.ramps = {
      ok: true,
      value: [
        {
          domain: 'news.example.com',
          status: 'paused',
          pausedReason: 'Bounce rate 4.0% is over the 2.0% limit.',
          capToday: 200,
        },
      ],
    };
    broken.providers = {
      ok: true,
      value: [provider('gmail', 1000, 100, { bounced: 80, complained: 9 })],
    };
    expect(run(broken).score).toBe(0);
  });

  it('orders problems, warnings, unknowns, then good, with the most harmful problem first', () => {
    const facts = withDomain({
      records: { ok: true, value: [record('dkim', 'missing'), record('mail_from_mx', 'missing')] },
    });
    facts.channel = {
      ok: true,
      value: {
        ...valueOf(facts.channel),
        paused: true,
        sunsetDays: null,
        footer: '',
      },
    };
    facts.blocklists = { ok: false };
    const findings = run(facts).findings;
    const severities = findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => order(a) - order(b)));
    expect(findings.slice(0, 3).map((f) => f.id)).toEqual([
      'publication_paused',
      'dns_dkim',
      'dns_return_path_mx',
    ]);
    const warnings = findings.filter((f) => f.severity === 'warning').map((f) => f.id);
    expect(warnings).toEqual(['inactive_cleanup', 'footer_address']);
  });

  it('gives every finding a known id, a title, a meaning, and fix steps when something is wrong', () => {
    const facts = withDomain({
      status: 'pending',
      dmarc: { ok: true, value: { policy: 'none', published: 1, reportsHere: false } },
    });
    facts.sender = { ok: false };
    facts.list = { ok: false };
    for (const f of run(facts).findings) {
      expect(CHECKUP_FINDING_IDS).toContain(f.id);
      expect(f.title.length).toBeGreaterThan(5);
      expect(f.meaning.length).toBeGreaterThan(20);
      if (f.severity !== 'good') expect(f.fix.length, f.title).toBeGreaterThan(0);
      const copy = [f.title, f.meaning, ...f.fix, f.link?.label ?? ''].join(' ');
      expect(copy).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      expect(copy).not.toMatch(
        /Reputation Ramp|Channel|Members?\b|Dispatch|Broadcast|Capture Form/,
      );
    }
  });
});

const order = (severity: string) => ['problem', 'warning', 'unknown', 'good'].indexOf(severity);

describe('never throws', () => {
  it('turns every failed read into "couldn\'t check"', () => {
    const checkup = run({
      now: NOW,
      sharedDomain: 'mail.swarm.example',
      channel: { ok: false },
      sender: { ok: false },
      domains: { ok: false },
      providers: { ok: false },
      ramps: { ok: false },
      list: { ok: false },
      blocklists: { ok: false },
    });
    expect(checkup.verdict).toBe('healthy');
    expect(checkup.score).toBe(100);
    expect(checkup.from).toBeNull();
    expect(checkup.counts.unknown).toBe(checkup.findings.length);
    expect(checkup.findings.length).toBeGreaterThanOrEqual(6);
  });

  it('survives facts that are not what they claim to be', () => {
    const facts = healthy();
    (facts.providers as { value: unknown }).value = null;
    (facts.domains as { value: unknown }).value = [{ domain: 'x.example' }];
    const checkup = run(facts);
    expect(find(facts, 'sending_volume', 'unknown')).toHaveLength(1);
    expect(
      checkup.findings.some((f) => f.id === 'sending_domain' && f.severity === 'unknown'),
    ).toBe(true);
    // The other groups still ran.
    expect(find(facts, 'inactive_cleanup', 'good')).toHaveLength(1);
  });
});

describe('sender', () => {
  const sender = (value: Partial<Extract<CheckupFacts['sender'], { ok: true }>['value']>) =>
    healthy({
      sender: {
        ok: true,
        value: {
          hasIdentity: true,
          name: 'Mara',
          address: 'mara@news.example.com',
          replyTo: null,
          sendingDomainId: 'sd_1',
          ...value,
        },
      },
    });

  it('calls a free mailbox From address a problem and explains DMARC', () => {
    const [f] = find(sender({ address: 'mara@gmail.com' }), 'sender_free_mailbox');
    expect(f).toMatchObject({ severity: 'problem', link: { to: 'sending' } });
    expect(f!.meaning).toContain('DMARC');
    expect(isFreeMailboxDomain('Yahoo.co.uk')).toBe(true);
    expect(isFreeMailboxDomain('hotmail.fr')).toBe(true);
    expect(isFreeMailboxDomain('gmail.example.com')).toBe(false);
    expect(isFreeMailboxDomain('news.example.com')).toBe(false);
  });

  it('warns about no-reply addresses, not about ones that merely contain the letters', () => {
    expect(find(sender({ address: 'no-reply@news.example.com' }), 'sender_no_reply')).toHaveLength(
      1,
    );
    for (const address of [
      'noreply@x.example',
      'no_reply@x.example',
      'donotreply@x.example',
      'do-not-reply@x.example',
      'NoReply@x.example',
    ]) {
      expect(isNoReplyAddress(address), address).toBe(true);
    }
    for (const address of [
      'nora@x.example',
      'reply@x.example',
      'norepeat@x.example',
      'hello@noreply.example',
    ]) {
      expect(isNoReplyAddress(address), address).toBe(false);
    }
  });

  it('warns when no sender is set up, and accepts the shared domain when one is', () => {
    const none = sender({
      hasIdentity: false,
      address: 'field-notes@mail.swarm.example',
      sendingDomainId: null,
    });
    expect(find(none, 'sender')[0]).toMatchObject({
      severity: 'warning',
      title: 'No sender is set up yet',
    });
    const shared = sender({ address: 'field-notes@mail.swarm.example', sendingDomainId: null });
    expect(find(shared, 'sender')[0]).toMatchObject({ severity: 'good' });
    expect(find(shared, 'sender')[0]!.title).toContain('mail.swarm.example');
  });
});

describe('sending domain and DNS', () => {
  it('reports an unverified domain as a problem', () => {
    expect(find(withDomain({ status: 'pending' }), 'sending_domain')[0]).toMatchObject({
      severity: 'problem',
      subject: 'news.example.com',
      title: 'news.example.com is not verified',
    });
  });

  it('names each record that is missing or wrong, with the value to publish', () => {
    const facts = withDomain({
      records: {
        ok: true,
        value: [
          record('dkim', 'missing'),
          record('mail_from_mx', 'different', ['10 mx.other.example']),
          record('mail_from_spf', 'conflict', ['v=spf1 a ~all', 'v=spf1 mx ~all']),
        ],
      },
    });
    const dkim = find(facts, 'dns_dkim')[0]!;
    expect(dkim).toMatchObject({
      severity: 'problem',
      title: 'The DKIM record of news.example.com is missing',
    });
    expect(dkim.fix.join(' ')).toContain('abc._domainkey.news.example.com');
    expect(dkim.fix.join(' ')).toContain('abc.dkim.amazonses.com');
    const mx = find(facts, 'dns_return_path_mx')[0]!;
    expect(mx.title).toBe('The return path MX record of news.example.com is wrong');
    expect(mx.fix.join(' ')).toContain('10 mx.other.example');
    expect(find(facts, 'dns_return_path_spf')[0]!.title).toBe(
      'news.example.com has more than one SPF record',
    );
  });

  it('does not guess when DNS could not be read', () => {
    const facts = withDomain({
      records: { ok: true, value: [record('dkim', 'unknown'), record('mail_from_mx', 'ok')] },
      dmarc: { ok: false },
    });
    expect(find(facts, 'dns_dkim')[0]!.severity).toBe('unknown');
    expect(find(facts, 'dns_return_path_mx')[0]!.severity).toBe('good');
    expect(find(facts, 'dmarc_policy')[0]!.severity).toBe('unknown');
    expect(run(facts).counts.problem).toBe(0);
  });

  it('judges the DMARC policy: missing, none and duplicate are problems', () => {
    const policy = (value: {
      policy: 'none' | 'quarantine' | 'reject' | null;
      published: number;
    }) =>
      find(
        withDomain({ dmarc: { ok: true, value: { ...value, reportsHere: true } } }),
        'dmarc_policy',
      )[0]!;
    expect(policy({ policy: null, published: 0 })).toMatchObject({
      severity: 'problem',
      title: 'news.example.com has no DMARC record',
    });
    expect(policy({ policy: 'none', published: 1 }).severity).toBe('problem');
    expect(policy({ policy: 'none', published: 1 }).fix[0]).toContain('p=quarantine');
    expect(policy({ policy: 'reject', published: 2 }).title).toContain(
      'more than one DMARC record',
    );
    expect(policy({ policy: 'reject', published: 1 }).severity).toBe('good');
    // Inherited from the parent domain: nothing published at the name itself, still enforced.
    expect(policy({ policy: 'quarantine', published: 0 }).severity).toBe('good');
  });
});

describe('DMARC reports', () => {
  const reports = (
    value: { lastReportAt: number | null; messages: number; aligned: number },
    extra: Partial<CheckupDomainFacts> = {},
  ) => withDomain({ reports: { ok: true, value }, ...extra });

  it('judges alignment only with enough reported messages', () => {
    expect(
      find(reports({ lastReportAt: NOW, messages: 99, aligned: 10 }), 'dmarc_alignment'),
    ).toEqual([]);
    expect(
      find(reports({ lastReportAt: NOW, messages: 1000, aligned: 985 }), 'dmarc_alignment')[0]!
        .severity,
    ).toBe('good');
    expect(
      find(reports({ lastReportAt: NOW, messages: 1000, aligned: 950 }), 'dmarc_alignment')[0],
    ).toMatchObject({
      severity: 'warning',
      title: '5.0% of mail sent as news.example.com fails DMARC',
    });
    expect(
      find(reports({ lastReportAt: NOW, messages: 1000, aligned: 800 }), 'dmarc_alignment')[0]!
        .severity,
    ).toBe('problem');
  });

  it('warns when reports never arrived or stopped, once the domain has been sending', () => {
    const never = find(
      reports({ lastReportAt: null, messages: 0, aligned: 0 }),
      'dmarc_reports',
    )[0]!;
    expect(never).toMatchObject({
      severity: 'warning',
      title: 'No DMARC reports have arrived for news.example.com',
    });
    expect(never.fix[0]).toContain('asks for reports correctly');
    const stopped = find(
      reports({ lastReportAt: NOW - 20 * DAY, messages: 0, aligned: 0 }),
      'dmarc_reports',
    )[0]!;
    expect(stopped.title).toContain('stopped arriving');
    const elsewhere = find(
      reports(
        { lastReportAt: null, messages: 0, aligned: 0 },
        { dmarc: { ok: true, value: { policy: 'reject', published: 1, reportsHere: false } } },
      ),
      'dmarc_reports',
    )[0]!;
    expect(elsewhere.fix[0]).toContain('does not send reports to Swarm');
  });

  it('says nothing about reports for a new domain or one that has barely sent', () => {
    expect(
      find(
        reports({ lastReportAt: null, messages: 0, aligned: 0 }, { verifiedAt: NOW - 2 * DAY }),
        'dmarc_reports',
      ),
    ).toEqual([]);
    const quiet = reports({ lastReportAt: null, messages: 0, aligned: 0 });
    quiet.providers = {
      ok: true,
      value: [provider('gmail', 40, 10), provider('other', 5000, 2000)],
    };
    expect(find(quiet, 'dmarc_reports')).toEqual([]);
    expect(
      find(reports({ lastReportAt: NOW - 3 * DAY, messages: 0, aligned: 0 }), 'dmarc_reports'),
    ).toEqual([]);
  });
});

describe('bounces and complaints', () => {
  it('shows no rates below the minimum volume', () => {
    const facts = withProviders([provider('gmail', 60, 10, { bounced: 30, complained: 5 })]);
    expect(find(facts, 'sending_volume')[0]).toMatchObject({ severity: 'unknown' });
    expect(find(facts, 'bounce_rate')).toEqual([]);
    expect(find(facts, 'complaint_rate')).toEqual([]);
    expect(run(facts).counts.problem).toBe(0);
  });

  it('judges the bounce rate against 1% and 2%', () => {
    const bounce = (bounced: number) =>
      find(
        withProviders([provider('gmail', 10_000 - bounced, 4000, { bounced })]),
        'bounce_rate',
      )[0]!;
    expect(bounce(50)).toMatchObject({ severity: 'good', title: 'Bounce rate is 0.5%' });
    expect(bounce(100).severity).toBe('warning');
    expect(bounce(200).severity).toBe('warning');
    expect(bounce(201)).toMatchObject({
      severity: 'problem',
      title: '2.0% of your emails bounced',
    });
    expect(bounce(201).meaning).toContain('pauses your warm-up');
  });

  it('judges the complaint rate against Gmail’s 0.1% and 0.3%', () => {
    const complaint = (complained: number, delivered = 10_000) =>
      find(
        withProviders([provider('gmail', delivered, delivered * 0.4, { complained })]),
        'complaint_rate',
      )[0]!;
    expect(complaint(0)).toMatchObject({ severity: 'good', title: 'No spam complaints' });
    expect(complaint(9).severity).toBe('good');
    expect(complaint(10)).toMatchObject({
      severity: 'warning',
      title: '0.10% of readers marked your email as spam',
    });
    expect(complaint(29).severity).toBe('warning');
    expect(complaint(30).severity).toBe('problem');
    expect(complaint(30).meaning).toContain('0.3%');
    expect(complaint(30).external[0]!.url).toBe('https://postmaster.google.com/');
  });

  it('does not turn a single complaint on a small list into an alarm', () => {
    const one = find(
      withProviders([provider('gmail', 200, 80, { complained: 1 })]),
      'complaint_rate',
    )[0]!;
    expect(one.severity).toBe('good');
    expect(one.meaning).toContain('too few to call a trend');
    const two = find(
      withProviders([provider('gmail', 200, 80, { complained: 2 })]),
      'complaint_rate',
    )[0]!;
    expect(two.severity).toBe('problem');
  });
});

describe('one provider opening far less', () => {
  it('flags the provider and points at its own tool', () => {
    const facts = withProviders([
      provider('gmail', 4000, 1800),
      provider('outlook', 1500, 120),
      provider('yahoo', 500, 210),
      provider('other', 1200, 500),
    ]);
    const [gap] = find(facts, 'provider_gap');
    expect(gap).toMatchObject({ severity: 'warning', subject: 'Outlook' });
    expect(gap!.meaning).toContain('8.0%');
    expect(gap!.external[0]!.label).toBe('Microsoft SNDS');
  });

  it('needs volume on both sides and a real open rate elsewhere', () => {
    const small = withProviders([provider('gmail', 4000, 1800), provider('outlook', 150, 0)]);
    expect(find(small, 'provider_gap', 'warning')).toEqual([]);
    const alone = withProviders([provider('gmail', 4000, 100), provider('outlook', 100, 60)]);
    expect(find(alone, 'provider_gap')).toEqual([]);
    const allLow = withProviders([provider('gmail', 4000, 80), provider('outlook', 4000, 300)]);
    expect(find(allLow, 'provider_gap')).toEqual([]);
  });

  it('never flags iCloud, whose real opens are hidden, nor counts it for the others', () => {
    const facts = withProviders([
      provider('gmail', 4000, 1800),
      provider('outlook', 1500, 600),
      provider('apple', 3000, 30),
    ]);
    expect(find(facts, 'provider_gap')).toHaveLength(1);
    expect(find(facts, 'provider_gap')[0]!.severity).toBe('good');
  });
});

describe('one provider refusing mail because of the sender', () => {
  it('names the provider, keeps the subscribers and points at its own tool', () => {
    const facts = withProviders([
      provider('gmail', 4000, 1800, { bounced: 60, blocked: 60 }),
      provider('outlook', 1500, 600),
      provider('yahoo', 500, 210, { bounced: 2, blocked: 2 }),
    ]);
    const blocks = find(facts, 'provider_blocks');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ severity: 'warning', subject: 'Gmail' });
    expect(blocks[0]!.title).toBe('Gmail is refusing some of your emails');
    expect(blocks[0]!.meaning).toContain('60 emails of 4,060');
    expect(blocks[0]!.meaning).toContain('Swarm keeps these subscribers');
    expect(blocks[0]!.external[0]!.label).toBe('Google Postmaster Tools');
  });

  it('is a problem above 2%, and says nothing bad about a few blocks or other providers', () => {
    const many = withProviders([provider('outlook', 1000, 400, { bounced: 40, blocked: 40 })]);
    expect(find(many, 'provider_blocks')[0]).toMatchObject({ severity: 'problem' });
    const few = withProviders([
      provider('gmail', 4000, 1800, { bounced: 2, blocked: 2 }),
      provider('other', 1000, 400, { bounced: 50, blocked: 50 }),
    ]);
    expect(find(few, 'provider_blocks')).toEqual([expect.objectContaining({ severity: 'good' })]);
  });
});

describe('warm-up', () => {
  const ramp = (status: 'warming' | 'paused' | 'complete', pausedReason: string | null = null) =>
    healthy({
      ramps: {
        ok: true,
        value: [{ domain: 'news.example.com', status, pausedReason, capToday: 450 }],
      },
    });

  it('treats a pause as the reason nothing arrives, and warming as information', () => {
    const paused = find(ramp('paused', 'Bounce rate 4.0% is over the 2.0% limit.'), 'warmup')[0]!;
    expect(paused).toMatchObject({ severity: 'problem', link: { to: 'sending' } });
    expect(paused.meaning).toContain('Bounce rate 4.0%');
    expect(run(ramp('paused')).findings[0]!.id).toBe('warmup');
    const warming = find(ramp('warming'), 'warmup')[0]!;
    expect(warming.severity).toBe('good');
    expect(warming.meaning).toContain('450 emails');
    expect(find(ramp('complete'), 'warmup')).toEqual([]);
  });
});

describe('list hygiene', () => {
  const channel = (value: Partial<Extract<CheckupFacts['channel'], { ok: true }>['value']>) => {
    const facts = healthy();
    facts.channel = { ok: true, value: { ...valueOf(facts.channel), ...value } };
    return facts;
  };
  const listWith = (value: Partial<Extract<CheckupFacts['list'], { ok: true }>['value']>) => {
    const facts = healthy();
    facts.list = { ok: true, value: { ...valueOf(facts.list), ...value } };
    return facts;
  };

  it('warns when double opt-in is off for the publication or for a form', () => {
    const off = find(channel({ doubleOptIn: false }), 'confirm_opt_in')[0]!;
    expect(off).toMatchObject({
      severity: 'warning',
      title: 'Double opt-in is off',
      link: { to: 'publication' },
    });
    expect(
      find(channel({ doubleOptIn: false, requireConfirmation: true }), 'confirm_opt_in')[0]!
        .severity,
    ).toBe('good');
    const forms = find(
      listWith({ formsWithoutConfirm: ['Footer form', 'Popup'] }),
      'confirm_opt_in',
    )[0]!;
    expect(forms).toMatchObject({ severity: 'warning', link: { to: 'forms' } });
    expect(forms.title).toBe('2 signup forms add people without confirmation');
    expect(forms.fix.join(' ')).toContain('Footer form and Popup');
  });

  it('does not ask for inactive-reader cleanup where opens are not tracked', () => {
    expect(
      find(channel({ sunsetDays: 180, seesOpens: false }), 'inactive_cleanup')[0],
    ).toMatchObject({ severity: 'unknown', title: 'Inactive-reader cleanup needs open tracking' });
  });

  it('warns when cleanup is off or a large share is inactive, with enough people measured', () => {
    expect(find(channel({ sunsetDays: null }), 'inactive_cleanup')[0]!.severity).toBe('warning');
    expect(find(listWith({ measured: 1000, inactive: 300 }), 'inactive_share')[0]).toMatchObject({
      severity: 'warning',
      title: '30% of your subscribers have not opened in 180 days',
    });
    expect(find(listWith({ measured: 1000, inactive: 299 }), 'inactive_share')[0]!.severity).toBe(
      'good',
    );
    expect(find(listWith({ measured: 99, inactive: 99 }), 'inactive_share')).toEqual([]);
    expect(
      find(listWith({ measured: 1000, inactive: 900, engagementKnown: false }), 'inactive_share'),
    ).toEqual([]);
  });

  it('mentions a recent large import', () => {
    const imported = find(
      listWith({ recentImport: { rows: 4200, completedAt: NOW - 3 * DAY } }),
      'recent_import',
    )[0]!;
    expect(imported).toMatchObject({
      severity: 'warning',
      title: 'You imported 4,200 addresses 3 days ago',
    });
    expect(find(healthy(), 'recent_import')).toEqual([]);
  });

  it('asks for a postal address when the footer line is empty or not applied', () => {
    const empty = find(channel({ footer: '  ' }), 'footer_address')[0]!;
    expect(empty.severity).toBe('warning');
    expect(empty.meaning).toContain('CAN-SPAM');
    expect(find(channel({ designOn: false }), 'footer_address')[0]!.fix).toHaveLength(2);
    expect(find(healthy(), 'footer_address')[0]!.severity).toBe('good');
  });
});

describe('blocklists', () => {
  const result = (name: string, state: 'listed' | 'clean' | 'unknown') => ({
    list: 'spamhaus_dbl' as const,
    name,
    state,
    reason: null,
    lookupUrl: `https://lookup.example/${encodeURIComponent(name)}`,
  });
  const blocklists = (...results: ReturnType<typeof result>[]) =>
    healthy({ blocklists: { ok: true, value: [{ domain: 'news.example.com', results }] } });

  it('reports a listing as a problem with the list’s own lookup page', () => {
    const facts = blocklists(result('Spamhaus DBL', 'listed'), result('SURBL', 'clean'));
    const [listed] = find(facts, 'blocklist', 'problem');
    expect(listed!.title).toBe('news.example.com is listed on Spamhaus DBL');
    expect(listed!.external).toEqual([
      {
        label: 'Look up news.example.com on Spamhaus DBL',
        url: 'https://lookup.example/Spamhaus%20DBL',
      },
    ]);
    // Not "clean" overall while it is listed somewhere.
    expect(find(facts, 'blocklist', 'good')).toEqual([]);
  });

  it('reports refused lists as "couldn\'t check" with links, never as clean or listed', () => {
    const facts = blocklists(
      result('Spamhaus DBL', 'unknown'),
      result('URIBL', 'unknown'),
      result('SURBL', 'clean'),
    );
    const [unsure] = find(facts, 'blocklist', 'unknown');
    expect(unsure!.title).toBe('Could not check news.example.com on Spamhaus DBL and URIBL');
    expect(unsure!.external).toHaveLength(2);
    expect(find(facts, 'blocklist', 'problem')).toEqual([]);
    expect(find(facts, 'blocklist', 'good')[0]!.title).toBe('news.example.com is not on SURBL');
    expect(run(facts).score).toBe(100);
  });
});
