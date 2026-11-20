// Deliverability Center (Phase 7): DMARC aggregate reports per sending domain, the
// per-mailbox-provider breakdown, complaint rates, Reputation Ramp history and dedicated sending.
// Shared constants (rua prefix, Gmail thresholds, providers, plan limits) are in p7-platform.ts.
// Contract: docs/deliverability.md. Tables: migrations/0012_platform.sql, 0018_deliverability.sql.
import { z } from '@hono/zod-openapi';
import { SuppressionBounceSchema } from './bounces';
import { idPattern } from './ids';
import { CheckedDnsRecordSchema } from './instance';
import { MAILBOX_PROVIDERS, PLANS } from './p7-platform';
import { EmailSchema } from './schemas';
import { DnsRecordSchema } from './send';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));
const rate = z.number().min(0).max(1).nullable().openapi({
  description: 'A share between 0 and 1; null when there is nothing to divide by',
});

/** Ranges are whole UTC days, both ends included. */
export const DELIVERABILITY_DEFAULT_DAYS = 30;
export const DELIVERABILITY_MAX_DAYS = 366;
/**
 * Sources listed per domain: every source where SPF or DKIM did not align, those failing DMARC
 * (neither aligned) first, then by volume.
 */
export const DMARC_FAILING_SOURCES_LIMIT = 25;

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-27.');

export const DeliverabilityRangeQuerySchema = z.object({
  from: DaySchema.optional().openapi({ param: { name: 'from', in: 'query' } }),
  to: DaySchema.optional().openapi({ param: { name: 'to', in: 'query' } }),
});
const MailboxProviderSchema = z.enum(MAILBOX_PROVIDERS).openapi('MailboxProvider');

const ComplaintStandingSchema = z.enum(['good', 'watch', 'over']).openapi('ComplaintStanding', {
  description:
    'good: under the 0.1% target; watch: between the target and the 0.3% ceiling; over: above the ceiling',
});
export type ComplaintStanding = z.infer<typeof ComplaintStandingSchema>;

// ---------------------------------------------------------------------------------------------
// DMARC

const DmarcDomainSummarySchema = z
  .object({
    sendingDomainId: id('sendingDomain'),
    domain: z.string(),
    status: z.enum(['pending', 'verified', 'failed']),
    dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).nullable(),
    /** dmarc+<sendingDomainId>@<DMARC_MAIL_DOMAIN> */
    reportAddress: z.email(),
    /** The _dmarc TXT record to publish: the sending policy plus the report address. */
    recommendedRecord: DnsRecordSchema,
    lastReportAt: timestamp.nullable(),
    messages: z.number().int(),
    aligned: z.number().int(),
    alignmentRate: rate,
  })
  .openapi('DmarcDomainSummary');
export type DmarcDomainSummary = z.infer<typeof DmarcDomainSummarySchema>;

const DmarcFailingSourceSchema = z
  .object({
    sourceIp: z.string(),
    count: z.number().int(),
    disposition: z.enum(['none', 'quarantine', 'reject']),
    /** False when neither SPF nor DKIM aligned (the message failed DMARC). */
    dmarcPass: z.boolean(),
    spfAligned: z.boolean(),
    dkimAligned: z.boolean(),
    headerFrom: z.string(),
    /** Organisations that reported this source (from the reports; no lookups). */
    reporters: z.array(z.string()),
  })
  .openapi('DmarcFailingSource');
export type DmarcFailingSource = z.infer<typeof DmarcFailingSourceSchema>;

export const DmarcDomainReportSchema = z
  .object({
    sendingDomainId: id('sendingDomain'),
    domain: z.string(),
    from: z.string(),
    to: z.string(),
    reportAddress: z.email(),
    recommendedRecord: DnsRecordSchema,
    /** The _dmarc record published now; null when none was found or DNS could not be read. */
    publishedRecord: z.string().nullable(),
    /** Whether the published record sends aggregate reports here; null when DNS could not be read. */
    reportsConfigured: z.boolean().nullable(),
    lastReportAt: timestamp.nullable(),
    totals: z.object({
      messages: z.number().int(),
      aligned: z.number().int(),
      failed: z.number().int(),
      alignmentRate: rate,
    }),
    /** By the UTC day a report's period begins. */
    byDay: z.array(
      z.object({ day: z.string(), aligned: z.number().int(), failed: z.number().int() }),
    ),
    failingSources: z.array(DmarcFailingSourceSchema),
    reporters: z.array(
      z.object({
        orgName: z.string(),
        reports: z.number().int(),
        messages: z.number().int(),
        lastReportAt: timestamp,
      }),
    ),
  })
  .openapi('DmarcDomainReport');
export type DmarcDomainReport = z.infer<typeof DmarcDomainReportSchema>;

// ---------------------------------------------------------------------------------------------
// Mailbox providers, complaints and Reputation Ramp history

const ProviderStatsSchema = z
  .object({
    provider: MailboxProviderSchema,
    /** Accepted by the provider for delivery (failed sends are left out). */
    sent: z.number().int(),
    delivered: z.number().int(),
    /** Hard bounces and blocks (bounceRate counts both). */
    bounced: z.number().int(),
    /**
     * Of those, the emails the provider refused because of the sender (reputation, a blocklist,
     * content, authentication), not because of the address.
     */
    blocked: z.number().int(),
    complained: z.number().int(),
    /** Human opens only: machine opens (privacy proxies, scanners) are left out. */
    opened: z.number().int(),
    bounceRate: rate,
    complaintRate: rate,
    openRate: rate,
    complaintStanding: ComplaintStandingSchema,
  })
  .openapi('ProviderStats');
export type ProviderStats = z.infer<typeof ProviderStatsSchema>;

const ComplaintSummarySchema = z
  .object({
    delivered: z.number().int(),
    complained: z.number().int(),
    /** complained ÷ delivered */
    rate: rate,
    /** GMAIL_COMPLAINT_TARGET (0.1%) */
    target: z.number(),
    /** GMAIL_COMPLAINT_THRESHOLD (0.3%) */
    threshold: z.number(),
    standing: ComplaintStandingSchema,
  })
  .openapi('ComplaintSummary');
export type ComplaintSummary = z.infer<typeof ComplaintSummarySchema>;

const RampHistorySchema = z
  .object({
    rampId: id('reputationRamp'),
    sendingDomainId: id('sendingDomain').nullable(),
    domain: z.string(),
    status: z.enum(['warming', 'paused', 'complete']),
    pausedReason: z.string().nullable(),
    days: z.array(
      z.object({
        day: z.string(),
        cap: z.number().int(),
        sent: z.number().int(),
        bounces: z.number().int(),
        complaints: z.number().int(),
        bounceRate: rate,
        complaintRate: rate,
      }),
    ),
  })
  .openapi('RampHistory');
export type RampHistory = z.infer<typeof RampHistorySchema>;

export const DeliverabilityOverviewSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    domains: z.array(DmarcDomainSummarySchema),
    providers: z.array(ProviderStatsSchema),
    complaints: ComplaintSummarySchema,
    ramps: z.array(RampHistorySchema),
  })
  .openapi('DeliverabilityOverview');
export type DeliverabilityOverview = z.infer<typeof DeliverabilityOverviewSchema>;

// ---------------------------------------------------------------------------------------------
// Dedicated sending

const DEDICATED_IP_STATUSES = ['none', 'requested', 'warming', 'active'] as const;
export type DedicatedIpStatus = (typeof DEDICATED_IP_STATUSES)[number];

/**
 * One sending domain's health in one place. Rates are null when nothing was sent, because "no data"
 * and "0%" mean different things. They count finished days of its warm-up record only.
 */
export const DomainHealthSchema = z
  .object({
    sendingDomainId: id('sendingDomain'),
    domain: z.string(),
    from: z.string(),
    to: z.string(),
    status: z.enum(['pending', 'verified', 'failed']),
    dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).nullable(),
    records: z.array(CheckedDnsRecordSchema),
    ramp: z
      .object({
        status: z.enum(['warming', 'complete', 'paused']),
        pausedReason: z.string().nullable(),
        capToday: z.number().int(),
      })
      .nullable(),
    sending: z.object({
      sent: z.number().int(),
      bounces: z.number().int(),
      complaints: z.number().int(),
      bounceRate: z.number().nullable(),
      complaintRate: z.number().nullable(),
    }),
    dmarc: z.object({
      messages: z.number().int(),
      aligned: z.number().int(),
      alignmentRate: z.number().nullable(),
      lastReportAt: z.string().nullable(),
    }),
  })
  .openapi('DomainHealth');
export type DomainHealth = z.infer<typeof DomainHealthSchema>;

export const DedicatedSendingSchema = z
  .object({
    plan: z.enum(PLANS),
    /** False when the mail provider has no dedicated sending (it needs Amazon SES). */
    supported: z.boolean(),
    configurationSet: z.object({
      /** Paid plans. */
      available: z.boolean(),
      /** The Channel's own configuration set; null while it uses the shared one. */
      name: z.string().nullable(),
    }),
    dedicatedIp: z.object({
      /** Pro and up (PLAN_LIMITS.dedicatedIps). */
      available: z.boolean(),
      status: z.enum(DEDICATED_IP_STATUSES),
      pool: z.string().nullable(),
      /** Managed warm-up progress as last read from the provider. */
      warmupPercent: z.number().int().min(0).max(100).nullable(),
      requestedAt: timestamp.nullable(),
      checkedAt: timestamp.nullable(),
    }),
  })
  .openapi('DedicatedSending');
export type DedicatedSending = z.infer<typeof DedicatedSendingSchema>;

// ---------------------------------------------------------------------------------------------
// Suppressions (migrations/0026_suppressions.sql): addresses a Channel never mails. Workspace-wide
// rows come from hard bounces, complaints, erasures and operators; Channel rows only from
// operators. Unsubscribes are a Member's status, not a suppression.

const SUPPRESSION_REASONS = ['hard_bounce', 'soft_bounce', 'complaint', 'manual'] as const;
const SUPPRESSION_SCOPES = ['workspace', 'channel'] as const;
/** Rows per list response, newest first. */
export const SUPPRESSIONS_PAGE_LIMIT = 100;

export const SuppressionSchema = z
  .object({
    id: id('suppression'),
    /** Erased addresses (Privacy Center) are listed as null: only their hash is kept. */
    email: z.string().nullable(),
    scope: z.enum(SUPPRESSION_SCOPES),
    reason: z.enum(SUPPRESSION_REASONS),
    /** For a bounce, what the receiving server said. For a manual one, the teammate's note. */
    detail: z.string().nullable(),
    /** The bounce rule that stopped mailing the address; null for other reasons and older rows. */
    bounce: SuppressionBounceSchema.nullable(),
    /** Complaints and erasures stay; the rest can be removed by an admin. */
    removable: z.boolean(),
    createdAt: timestamp,
  })
  .openapi('Suppression');
export type Suppression = z.infer<typeof SuppressionSchema>;

export const SuppressionListQuerySchema = z.object({
  /** An exact address. */
  email: EmailSchema.optional().openapi({ param: { name: 'email', in: 'query' } }),
  /** The createdAt of the last row of the previous page. */
  before: timestamp.optional().openapi({ param: { name: 'before', in: 'query' } }),
});

export const CreateSuppressionSchema = z
  .object({
    email: EmailSchema,
    /** channel: only this Channel; workspace: every Channel of the workspace (workspace admins). */
    scope: z.enum(SUPPRESSION_SCOPES).default('channel'),
    note: z.string().trim().max(500).optional(),
  })
  .openapi('CreateSuppression');

// ---------------------------------------------------------------------------------------------
// Deliverability check-up: every check for one Channel in one answer, as findings a writer can
// act on. Built in @swarm/engine checkup.ts; explained for end users in docs/deliverability-guide.md.

/** problem: fix this first. warning: worth improving. good: fine. unknown: could not be checked. */
export const CHECKUP_SEVERITIES = ['problem', 'warning', 'unknown', 'good'] as const;
export type CheckupSeverity = (typeof CHECKUP_SEVERITIES)[number];

/** Where in the dashboard a finding is fixed. The dashboard turns each into a route. */
const CHECKUP_LINK_TARGETS = [
  'sending',
  'deliverability',
  'publication',
  'forms',
  'subscribers',
  /** The DeBounce card on the Apps page (email checks). */
  'email_check',
] as const;
export type CheckupLinkTarget = (typeof CHECKUP_LINK_TARGETS)[number];

/** Every check the check-up can report. A finding's `id` is one of these and never changes. */
export const CHECKUP_FINDING_IDS = [
  'publication_paused',
  'warmup',
  'sender',
  'sender_free_mailbox',
  'sender_no_reply',
  'sending_domain',
  'dns_dkim',
  'dns_return_path_mx',
  'dns_return_path_spf',
  'dmarc_policy',
  'dmarc_alignment',
  'dmarc_reports',
  'blocklist',
  'complaint_rate',
  'provider_blocks',
  'bounce_rate',
  'sending_volume',
  'provider_gap',
  'confirm_opt_in',
  'inactive_share',
  'recent_import',
  'inactive_cleanup',
  'footer_address',
  'email_check',
] as const;
export type CheckupFindingId = (typeof CHECKUP_FINDING_IDS)[number];

/** The limits the check-up judges by. Complaint limits are GMAIL_COMPLAINT_TARGET / _THRESHOLD. */
export const CHECKUP = {
  /** Sending numbers are read over this many days. */
  days: 30,
  /** Rates are not judged on fewer sent emails than this. */
  minSent: 100,
  /** A single complaint is never called a trend: a rate needs at least this many. */
  minComplaints: 2,
  /** Bounce rate from which the finding is a warning ... */
  bounceWarning: 0.01,
  /** ... and a problem. The same limit pauses a warm-up (RAMP_DEFAULTS.bounceThreshold). */
  bounceProblem: 0.02,
  /** A mailbox provider refusing at least this many emails because of the sender ... */
  blockMinCount: 3,
  /** ... and this share of the emails sent to it is a warning, over blockProblem a problem. */
  blockWarning: 0.005,
  blockProblem: 0.02,
  /** DMARC alignment is judged once reports cover this many messages. */
  minDmarcMessages: 100,
  alignmentWarning: 0.98,
  alignmentProblem: 0.9,
  /** Reports are expected once a domain has been verified and sending for this long. */
  dmarcReportGraceDays: 7,
  /** Reports "stopped" when the newest one is older than this. */
  dmarcReportStaleDays: 14,
  /** A provider's open rate is compared only with this many delivered there and elsewhere. */
  providerMinDelivered: 200,
  /** The other providers must open at least this much for a gap to mean anything. */
  providerMinOpenRate: 0.1,
  /** Flagged when a provider's open rate is under this share of the others' rate. */
  providerGapRatio: 0.5,
  /** Readers count as inactive after this many days without an open or a click. */
  inactiveDays: 180,
  /** The inactive share is judged once this many readers have been sent enough emails. */
  inactiveMinMeasured: 100,
  inactiveShareWarning: 0.3,
  /** An import finished within this many days ... */
  importRecentDays: 14,
  /** ... of at least this many rows, and at least this share of the active list. */
  importMinRows: 500,
  importMinShare: 0.2,
  /** Email checks are judged on a list of at least this many subscribers ... */
  emailCheckMinSubscribers: 200,
  /** ... and a warning from this share never checked, or this share of the checked ones red. */
  emailUncheckedWarning: 0.5,
  emailRedWarning: 0.02,
  /** Points off the score of 100. Checks that could not run change nothing. */
  problemPoints: 20,
  warningPoints: 5,
} as const;

const CheckupFindingSchema = z
  .object({
    id: z.enum(CHECKUP_FINDING_IDS),
    /** What the finding is about when a check runs more than once: a domain, a blocklist. */
    subject: z.string().nullable(),
    severity: z.enum(CHECKUP_SEVERITIES),
    title: z.string(),
    /** What it means for delivery, in plain words. */
    meaning: z.string(),
    /** What to do, one step per entry. Empty when nothing needs doing. */
    fix: z.array(z.string()),
    /** Where in the dashboard to do it. */
    link: z.object({ to: z.enum(CHECKUP_LINK_TARGETS), label: z.string() }).nullable(),
    /** Pages outside Swarm that help: a blocklist's own lookup, a provider's tool. */
    external: z.array(z.object({ label: z.string(), url: z.url() })),
  })
  .openapi('CheckupFinding');
export type CheckupFinding = z.infer<typeof CheckupFindingSchema>;

export const DeliverabilityCheckupSchema = z
  .object({
    checkedAt: timestamp,
    /** problems: at least one problem. warnings: no problems, at least one warning. */
    verdict: z.enum(['problems', 'warnings', 'healthy']),
    score: z.number().int().min(0).max(100).openapi({
      description:
        '100, minus 20 for each problem and 5 for each warning, never below 0. Checks that could not run do not change it.',
    }),
    counts: z.object({
      problem: z.number().int(),
      warning: z.number().int(),
      unknown: z.number().int(),
      good: z.number().int(),
    }),
    /** The default sender the checks were run for; null when it could not be read. */
    from: z.object({ name: z.string(), address: z.string() }).nullable(),
    /** Most harmful first: problems, warnings, checks that could not run, then what is fine. */
    findings: z.array(CheckupFindingSchema),
  })
  .openapi('DeliverabilityCheckup');
export type DeliverabilityCheckup = z.infer<typeof DeliverabilityCheckupSchema>;
