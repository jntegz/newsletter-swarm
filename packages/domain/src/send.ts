import { z } from '@hono/zod-openapi';
import { DispatchAudienceSchema } from './audience';
import { EmailSchema } from './schemas';
import { idPattern } from './ids';
import type { SendWait } from './sending-limits';
import { RampPaceSchema, WarmupPlanSchema } from './warmup';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Sending domains and sender identities

/** A bare domain name: lowercase labels, at least one dot, no scheme or path. */
export const DomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Enter a domain such as news.example.com.',
  );

export const DnsRecordSchema = z
  .object({
    purpose: z.enum(['dkim', 'mail_from_mx', 'mail_from_spf', 'dmarc', 'link']),
    type: z.enum(['CNAME', 'TXT', 'MX']),
    name: z.string(),
    value: z.string(),
    priority: z.number().int().optional(),
  })
  .openapi('DnsRecord');
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

const VerificationStatusSchema = z.enum(['pending', 'success', 'failed', 'not_started']);

export const SendingDomainSchema = z
  .object({
    id: id('sendingDomain'),
    channelId: id('channel'),
    domain: z.string(),
    kind: z.enum(['email', 'link']),
    status: z.enum(['pending', 'verified', 'failed']),
    dkimStatus: VerificationStatusSchema,
    mailFromDomain: z.string().nullable(),
    mailFromStatus: VerificationStatusSchema,
    dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).nullable().openapi({
      description: 'Published DMARC policy as last checked. Sending needs quarantine or reject.',
    }),
    records: z.array(DnsRecordSchema),
    pendingChange: z
      .object({ service: z.string(), records: z.array(DnsRecordSchema) })
      .nullable()
      .openapi({
        description:
          'The email service this domain is moving to, and the records to publish for it. The current service keeps sending until the Swarm’s owner moves over.',
      }),
    lastCheckedAt: timestamp.nullable(),
    verifiedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .openapi('SendingDomain');
export type SendingDomain = z.infer<typeof SendingDomainSchema>;

/** The result of checking a domain now, with each of its records against what DNS says. */
const RecordCheckSchema = z.object({
  type: DnsRecordSchema.shape.type,
  name: z.string(),
  state: z.enum(['ok', 'missing', 'different', 'conflict', 'unknown']),
  found: z.array(z.string()),
});

export const CheckedSendingDomainSchema = SendingDomainSchema.extend({
  recordChecks: z.array(RecordCheckSchema),
  pendingChecks: z.array(RecordCheckSchema),
}).openapi('CheckedSendingDomain');
export type CheckedSendingDomain = z.infer<typeof CheckedSendingDomainSchema>;

export const CreateSendingDomainSchema = z
  .object({ domain: DomainNameSchema, kind: z.enum(['email', 'link']) })
  .openapi('CreateSendingDomain');
export type CreateSendingDomain = z.infer<typeof CreateSendingDomainSchema>;

/** The local part of a From address, e.g. "hello" in hello@news.example.com. */
const LocalPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'Use letters, numbers, dots, dashes or underscores.',
  );

export const SenderIdentitySchema = z
  .object({
    id: id('senderIdentity'),
    channelId: id('channel'),
    sendingDomainId: id('sendingDomain').nullable().openapi({
      description: 'Null sends from the shared platform mail domain',
    }),
    fromName: z.string(),
    fromAddress: z.email(),
    replyTo: z.email().nullable(),
    isDefault: z.boolean(),
    createdAt: timestamp,
  })
  .openapi('SenderIdentity');
export type SenderIdentity = z.infer<typeof SenderIdentitySchema>;

export const CreateSenderIdentitySchema = z
  .object({
    fromName: z.string().trim().min(1, 'Add a sender name.').max(80),
    fromLocal: LocalPartSchema,
    sendingDomainId: id('sendingDomain').nullable(),
    replyTo: EmailSchema.nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .openapi('CreateSenderIdentity');
export type CreateSenderIdentity = z.infer<typeof CreateSenderIdentitySchema>;

export const UpdateSenderIdentitySchema = z
  .object({
    fromName: z.string().trim().min(1).max(80).optional(),
    replyTo: EmailSchema.nullable().optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSenderIdentity');

// ---------------------------------------------------------------------------------------------
// Dispatches

/**
 * The editor document (TipTap JSON). Only the outer shape is checked here; the server-side
 * renderer in @swarm/mail rejects unknown node types and unsafe attributes.
 */
export const DispatchDocumentSchema = z
  .object({
    type: z.literal('doc'),
    content: z.array(z.record(z.string(), z.unknown())).max(2000),
  })
  .openapi('DispatchDocument', {
    description:
      'Editor document. Node types: paragraph, heading, bulletList, orderedList, listItem, blockquote, horizontalRule, image, button, linkCard, hardBreak, gate (top level; what follows is the gated part), askPoll (top level; attrs askId and questionId of a choice question of this Channel: a one-tap poll), codeBlock (attrs.language: highlighted in email and on the web with the flag code_embeds), tableOfContents (flag code_embeds; top level; attrs.title?: lists the top-level headings, as links on the web), htmlBlock (flag raw_html_mode), smartBlock (flag smart_blocks; top level only, not nested: `{ type: "smartBlock", attrs: { condition: CircleRule, label?, anonymous: "hide" | "show" }, content: [blocks] }`, shown to the Members whose condition matches when the Broadcast starts, and on the web as `anonymous` says). snippet (flag snippets; top level only; attrs.snippetId: a snippet of this Channel, whose current content replaces the block when it renders. A send uses the snippet as it was when the send started; the website always uses the current one; a snippet that is gone renders nothing, with a warning). Any block may set attrs.showOn (flag block_visibility): "email" keeps it out of the website and site search, "web" keeps it out of the email, absent or null shows it on both, any other value is refused.',
  });
export type DispatchDocument = z.infer<typeof DispatchDocumentSchema>;

export const EMPTY_DOCUMENT: DispatchDocument = { type: 'doc', content: [{ type: 'paragraph' }] };

const DispatchStatusSchema = z
  .enum(['draft', 'scheduled', 'sending', 'sent', 'canceled'])
  .openapi('DispatchStatus');
export type DispatchStatus = z.infer<typeof DispatchStatusSchema>;

export const DispatchSummarySchema = z
  .object({
    id: id('dispatch'),
    channelId: id('channel'),
    subject: z.string(),
    preheader: z.string(),
    status: DispatchStatusSchema,
    senderIdentityId: id('senderIdentity').nullable(),
    publishAt: timestamp.nullable(),
    sentAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    latestBroadcastId: id('broadcast').nullable(),
    /** Who can read it in full on the Channel's website; hidden keeps it off the site. */
    webVisibility: z.enum(['public', 'members', 'paid', 'hidden']),
    /** When it appeared on the site; null while it isn't published there. */
    webPublishedAt: timestamp.nullable(),
    /** 'flow' for a Flow email: sent only by its Flow, never to an audience. */
    kind: z.enum(['broadcast', 'flow']),
    /** The Flow a Flow email belongs to; null for a Broadcast Dispatch. */
    flowId: id('flow').nullable(),
    /** Who started it: null = a teammate in the dashboard; api = a direct /v2 call; agent = an Open Operator tool call; copilot = a Copilot action; feed = Feed Sync. */
    createdVia: z.enum(['agent', 'copilot', 'api', 'feed']).nullable(),
    /** Hidden from the dashboard's default list. Stats, sends and the website are untouched. */
    archivedAt: timestamp.nullable(),
    plannedDate: z.iso.date().nullable().openapi({
      description:
        'The day a writer aims to send a draft, for the content calendar. It has no effect on sending.',
    }),
    importedAt: timestamp.nullable().openapi({
      description:
        'Set on an issue brought over from another platform. It stays on the website and can never be sent or scheduled.',
    }),
    bestTime: z.boolean().openapi({
      description: 'A scheduled send goes at each reader’s best time',
    }),
  })
  .openapi('DispatchSummary');
export type DispatchSummary = z.infer<typeof DispatchSummarySchema>;

/** How a post's latest send did, counting people, never machines (privacy proxies, link scanners). */
const LatestSendSchema = z
  .object({
    broadcastId: id('broadcast'),
    delivered: z.number().int(),
    humanOpens: z.number().int().openapi({ description: 'People who opened it, counted once' }),
    humanClicks: z
      .number()
      .int()
      .openapi({ description: 'People who clicked a link in it, counted once' }),
    openRate: z.number().openapi({ description: 'humanOpens over delivered, 0 to 1' }),
    clickRate: z.number().openapi({ description: 'humanClicks over delivered, 0 to 1' }),
  })
  .openapi('LatestSend');

/** A row of the dashboard's posts list: the summary, who started it, and how its last send did. */
export const DispatchListItemSchema = DispatchSummarySchema.extend({
  author: z
    .object({ id: z.string(), name: z.string().nullable(), email: z.string() })
    .nullable()
    .openapi({
      description:
        'The teammate who started it. Null when no teammate did (some agent, API and Feed Sync posts) or their account is gone',
    }),
  latestSend: LatestSendSchema.nullable().optional().openapi({
    description:
      'Only with `stats=latest`: the latest send’s delivered count and its unique human open and click rates. Null when it has not been sent',
  }),
}).openapi('DispatchListItem');
export type DispatchListItem = z.infer<typeof DispatchListItemSchema>;

/** The posts list's filters: each chip of the dashboard is one of these. */
export const DispatchListStatusSchema = z.enum(['draft', 'scheduled', 'sent']).openapi({
  description:
    'draft: drafts, without past issues. scheduled: waiting to send. sent: posts that went out, whether being sent, sent or stopped part way, and past issues',
});
export type DispatchListStatus = z.infer<typeof DispatchListStatusSchema>;

export const DispatchStartedBySchema = z.enum(['people', 'agents']).openapi({
  description:
    'people: started by a teammate in the dashboard. agents: started by an agent, Copilot or the API. Feed Sync posts match neither',
});
export type DispatchStartedBy = z.infer<typeof DispatchStartedBySchema>;

export const DispatchCountsSchema = z
  .object({
    all: z.number().int(),
    draft: z.number().int(),
    scheduled: z.number().int(),
    sent: z.number().int(),
    archived: z.number().int().nullable().openapi({
      description:
        'Posts in the archive. Null while the post_archive flag is off, when the other counts include them',
    }),
  })
  .openapi('DispatchCounts');
export type DispatchCounts = z.infer<typeof DispatchCountsSchema>;

/** A cover image as stored on a Dispatch, a revision or a template. */
export const CoverImageRefSchema = z
  .object({
    mediaId: id('media'),
    alt: z.string(),
  })
  .openapi('CoverImageRef');
export type CoverImageRef = z.infer<typeof CoverImageRefSchema>;

const CoverImageSchema = CoverImageRefSchema.extend({
  url: z.string().nullable().openapi({
    description:
      'Null when the media item was deleted: the image is left out of the email and the website, with a warning',
  }),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
}).openapi('CoverImage');
export type CoverImage = z.infer<typeof CoverImageSchema>;

/** A new cover image must be an image in the media library of the same workspace. */
export const CoverImageInputSchema = z
  .object({
    mediaId: id('media'),
    alt: z.string().trim().max(300, 'Keep alt text under 300 characters.').default(''),
  })
  .openapi('CoverImageInput');

export const DispatchSchema = DispatchSummarySchema.extend({
  content: DispatchDocumentSchema,
  coverImage: CoverImageSchema.nullable().openapi({
    description: 'Shown above the body in the email and at the top of the web page',
  }),
  html: z.string().openapi({ description: 'Server render of the body, without personalisation' }),
  warnings: z.array(z.string()).openapi({ description: 'Lint results for the current render' }),
  htmlBlocksAllowed: z
    .boolean()
    .openapi({ description: 'Whether raw HTML blocks are enabled (the raw_html_mode flag)' }),
  audience: DispatchAudienceSchema.openapi({
    description: 'Who it goes to: Circles to include (everyone when empty) and to exclude',
  }),
  unopenedOf: id('broadcast').nullable().openapi({
    description:
      'A resend: only people that Broadcast reached who neither opened nor clicked it get this one',
  }),
  seoTitle: z.string(),
  seoDescription: z.string(),
  internalNote: z.string().openapi({
    description: 'A note for the team. It goes in no email, page, feed or webhook',
  }),
  sectionId: id('siteSection').nullable().openapi({ description: 'Site section, if any' }),
  slug: z.string().nullable().openapi({
    description: 'Current web slug (/p/<slug>); created from the subject when first published',
  }),
  onSite: z.boolean().openapi({ description: 'Published on the web and not hidden' }),
  webUrl: z.string().nullable().openapi({
    description: 'Canonical web address, once the Dispatch has a slug',
  }),
}).openapi('Dispatch');
export type Dispatch = z.infer<typeof DispatchSchema>;

/**
 * Scheduling and putting a post on the site are editor decisions. A change by someone below editor
 * takes them back, and the answer to that change says so, so the dashboard can tell them an editor
 * has to act again.
 */
export const EditorDecisionsUndoneSchema = z.object({
  unscheduled: z.boolean().optional().openapi({
    description:
      'This change took the scheduled Dispatch back to draft; an editor must schedule it again',
  }),
  takenOffSite: z.boolean().optional().openapi({
    description: 'This change took the post off the website; an editor must publish it again',
  }),
});
export type EditorDecisionsUndone = z.infer<typeof EditorDecisionsUndoneSchema>;

/** The answer to a save or a restore of a Dispatch (/api/v1). */
export const SavedDispatchSchema = DispatchSchema.extend(EditorDecisionsUndoneSchema.shape).openapi(
  'SavedDispatch',
);

export const CreateDispatchSchema = z
  .object({
    subject: z.string().trim().max(200).optional(),
    preheader: z.string().trim().max(200).optional(),
    content: DispatchDocumentSchema.optional(),
    coverImage: CoverImageInputSchema.nullable().optional(),
  })
  .openapi('CreateDispatch');
export type CreateDispatch = z.infer<typeof CreateDispatchSchema>;

export const UpdateDispatchSchema = z
  .object({
    subject: z.string().trim().max(200, 'Keep the subject under 200 characters.').optional(),
    preheader: z.string().trim().max(200, 'Keep the preview text under 200 characters.').optional(),
    content: DispatchDocumentSchema.optional(),
    /** Null removes it. */
    coverImage: CoverImageInputSchema.nullable().optional(),
    senderIdentityId: id('senderIdentity').nullable().optional(),
    /** Circles must belong to the Dispatch's Channel. */
    audience: DispatchAudienceSchema.optional(),
    /** Can be changed after sending too. */
    /** For search results and social shares; empty uses the subject and preheader. */
    seoTitle: z.string().trim().max(120, 'Keep the search title under 120 characters.').optional(),
    seoDescription: z
      .string()
      .trim()
      .max(300, 'Keep the search description under 300 characters.')
      .optional(),
    internalNote: z.string().trim().max(2000, 'Keep the note under 2000 characters.').optional(),
    /** Web fields can be changed after sending too (editor role). */
    webVisibility: z.enum(['public', 'members', 'paid', 'hidden']).optional(),
    sectionId: id('siteSection').nullable().optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and hyphens.')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateDispatch');
export type UpdateDispatch = z.infer<typeof UpdateDispatchSchema>;

export const DispatchRevisionSchema = z
  .object({
    id: id('dispatchRevision'),
    name: z.string().nullable(),
    subject: z.string(),
    preheader: z.string(),
    createdBy: z.object({ id: z.string(), email: z.string() }).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('DispatchRevision');
export type DispatchRevision = z.infer<typeof DispatchRevisionSchema>;

export const DispatchRevisionDetailSchema = DispatchRevisionSchema.extend({
  content: DispatchDocumentSchema,
  coverImage: CoverImageRefSchema.nullable(),
}).openapi('DispatchRevisionDetail');
export type DispatchRevisionDetail = z.infer<typeof DispatchRevisionDetailSchema>;

export const NameRevisionSchema = z
  .object({ name: z.string().trim().min(1, 'Name the snapshot.').max(80) })
  .openapi('NameRevision');

export const TestSendSchema = z
  .object({
    to: z
      .array(EmailSchema)
      .min(1)
      .max(5)
      .optional()
      .openapi({ description: 'Operator addresses in this workspace. Defaults to your own.' }),
    memberId: id('member').optional().openapi({
      description: 'Personalise the test as this Member would see it',
    }),
    variant: z.enum(['full', 'teaser']).optional().openapi({
      description:
        'For a paid Dispatch with a gate divider: the full email Members the Gate admits get, or the teaser that stops at the gate. Defaults to full.',
    }),
  })
  .openapi('TestSend');
export type TestSend = z.infer<typeof TestSendSchema>;

const BEST_TIME_DESCRIPTION =
  'Send at each reader’s best time, within 24 hours of the chosen time, worked out from when they opened or clicked before. Readers with too little history get the chosen time. Needs the best_time_send flag, and can’t run with a Split Test or Cohort Sample.';

export const ScheduleDispatchSchema = z
  .object({
    publishAt: timestamp,
    bestTime: z
      .boolean()
      .optional()
      .openapi({
        description: `${BEST_TIME_DESCRIPTION} Left out, a scheduled Dispatch keeps what it had.`,
      }),
  })
  .openapi('ScheduleDispatch');

export const SendDispatchSchema = z
  .object({
    bestTime: z.boolean().optional().openapi({ description: BEST_TIME_DESCRIPTION }),
  })
  .openapi('SendDispatch');

export const SetPlannedDateSchema = z
  .object({ plannedDate: z.iso.date('Choose a valid date.').nullable() })
  .openapi('SetPlannedDate');

export const ArchiveDispatchesSchema = z
  .object({ dispatchIds: z.array(id('dispatch')).min(1).max(100) })
  .openapi('ArchiveDispatches');

export const ArchiveResultSchema = z
  .object({
    changed: z.array(id('dispatch')),
    refused: z.array(z.object({ id: id('dispatch'), message: z.string() })),
  })
  .openapi('ArchiveResult');
export type ArchiveResult = z.infer<typeof ArchiveResultSchema>;

const PreflightCheckSchema = z
  .object({
    key: z.enum([
      'subject',
      'content',
      'sender',
      'domain',
      'dmarc',
      'links',
      'audience',
      'ramp',
      'test',
    ]),
    ok: z.boolean(),
    message: z.string(),
  })
  .openapi('PreflightCheck');
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

/** One piece of content advice. The ids are CONTENT_ADVICE_IDS in @swarm/mail. */
const PreflightAdviceSchema = z
  .object({
    id: z.string().openapi({ example: 'link_shortener' }),
    message: z.string(),
  })
  .openapi('PreflightAdvice');
export type PreflightAdvice = z.infer<typeof PreflightAdviceSchema>;

export const PreflightSchema = z
  .object({
    ready: z.boolean(),
    recipientCount: z.number().int().openapi({
      description: 'Exact number of Members this send would reach right now',
    }),
    from: z.object({ name: z.string(), address: z.string() }).nullable(),
    checks: z.array(PreflightCheckSchema),
    warnings: z.array(z.string()),
    advice: z.array(PreflightAdviceSchema).openapi({
      description:
        'Advice about the rendered email that spam filters and readers care about (subject, preview text, wording, links, images). Never blocks a send.',
    }),
    /** The audience the count is for. */
    audience: DispatchAudienceSchema,
    split: z
      .object({
        full: z.number().int().openapi({ description: 'Members the Gate admits right now' }),
        teaser: z.number().int().openapi({ description: 'Everyone else' }),
      })
      .nullable()
      .openapi({
        description:
          'For a paid Dispatch with a gate divider: how many of recipientCount get the full email and how many the teaser. Null when everyone gets the same email.',
      }),
    holdBack: z
      .object({
        kind: z.enum(['split_test', 'cohort_sample']),
        test: z.number().int().openapi({
          description: 'About how many Members get the email first (the test or the sample)',
        }),
        held: z.number().int().openapi({
          description: 'About how many are held back until the winner or the health check',
        }),
        variants: z
          .number()
          .int()
          .openapi({ description: 'Variants in a Split Test; 1 otherwise' }),
      })
      .nullable()
      .openapi({
        description:
          'A Split Test (flag split_tests) or Cohort Sample (flag cohort_sampling) on this Dispatch: estimated from the percentage, the exact split is decided per Member when the send starts. Null when everyone is sent at once.',
      }),
    bestTime: z
      .object({
        available: z.boolean(),
        reason: z.string().nullable().openapi({ description: 'Why it isn’t available' }),
        note: z
          .string()
          .nullable()
          .openapi({ description: 'What would happen instead, if anything, were it chosen now' }),
      })
      .nullable()
      .openapi({
        description:
          'Whether this send can go at each reader’s best time. Null when the best_time_send flag is off.',
      }),
  })
  .openapi('Preflight');
export type Preflight = z.infer<typeof PreflightSchema>;

// ---------------------------------------------------------------------------------------------
// Broadcasts

const BroadcastStatusSchema = z
  .enum(['queued', 'sending', 'sent', 'partially_failed', 'canceled', 'failed'])
  .openapi('BroadcastStatus');
export type BroadcastStatus = z.infer<typeof BroadcastStatusSchema>;

export const BroadcastSchema = z
  .object({
    id: id('broadcast'),
    dispatchId: id('dispatch'),
    channelId: id('channel'),
    status: BroadcastStatusSchema,
    subject: z.string(),
    from: z.object({ name: z.string(), address: z.string() }),
    recipientCount: z.number().int(),
    sentCount: z.number().int(),
    failedCount: z.number().int(),
    failureReason: z.string().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
    canceledAt: timestamp.nullable(),
    bestTime: z
      .object({
        personal: z.number().int().openapi({ description: 'Readers given a personal time' }),
        chosenTime: z.number().int().openapi({ description: 'Readers given the chosen time' }),
        limitedByWarmUp: z.boolean().openapi({
          description:
            'Today’s warm-up limit couldn’t reach the whole audience, so everyone got the chosen time',
        }),
      })
      .nullable()
      .openapi({
        description:
          'For a send asked to go at each reader’s best time; counted when the snapshot ends. Null otherwise.',
      }),
  })
  .openapi('Broadcast');
export type Broadcast = z.infer<typeof BroadcastSchema>;

/** Pushed by the send monitor over WebSocket while a Broadcast is live. */
export interface BroadcastProgress {
  broadcastId: string;
  status: BroadcastStatus;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  completedAt: string | null;
  /** Set while the send waits for a sending limit or the email service (sending-limits.ts). */
  waiting?: SendWait | null;
  /** Milliseconds since the epoch; newer wins. */
  at: number;
}

const MoneySchema = z
  .object({
    amountMicros: z.number().int().openapi({ description: 'Millionths of the currency unit' }),
    currency: z.literal('USD'),
  })
  .openapi('Money');

export const BroadcastStatsSchema = z
  .object({
    sent: z.number().int(),
    delivered: z.number().int(),
    bounced: z.number().int(),
    complained: z.number().int(),
    failed: z.number().int(),
    unsubscribed: z.number().int(),
    uniqueOpens: z.number().int(),
    humanOpens: z.number().int(),
    machineOpens: z.number().int(),
    uniqueClicks: z.number().int(),
    humanClicks: z.number().int(),
    bounceRate: z.number(),
    complaintRate: z.number(),
    openRate: z.number().openapi({
      description:
        'Human unique opens / delivered, leaving out emails sent untracked because the person asked',
    }),
    clickToOpenRate: z.number(),
    tracking: z
      .object({
        opens: z.boolean().openapi({ description: 'The send had an open pixel per person' }),
        clicks: z.boolean().openapi({ description: 'Links went through the tracker per person' }),
        untracked: z.number().int().openapi({
          description:
            'Emails sent without a pixel or tracked links because the person asked not to be tracked',
        }),
      })
      .openapi({ description: 'What this send tracked (docs/privacy-controls.md)' }),
    cost: MoneySchema.openapi({ description: 'Mail provider cost at $0.10 per 1,000 messages' }),
    links: z.array(
      z.object({
        url: z.string(),
        destination: z.string().nullable().openapi({
          description: 'Where a shortened link goes, when Swarm made it; null otherwise',
        }),
        position: z.number().int(),
        clicks: z.number().int().openapi({ description: 'Every click, scanners and bots too' }),
        humanClicks: z.number().int().openapi({ description: 'Clicks by people' }),
        humanPeople: z.number().int().openapi({ description: 'People who clicked, each once' }),
      }),
    ),
  })
  .openapi('BroadcastStats');
export type BroadcastStats = z.infer<typeof BroadcastStatsSchema>;

/** One way a send's email went out: a Split Test version, the full email or the teaser. */
const ClickMapViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  subject: z.string(),
  html: z.string().nullable().openapi({
    description:
      'The frozen email with marks written in and nothing that can fire: for a sandboxed frame. Null when no copy is stored.',
  }),
  totalPeople: z.number().int(),
  totalClicks: z.number().int(),
  uncountedLinks: z.number().int().openapi({ description: 'Links in raw HTML, not tracked' }),
  hasSmartBlocks: z.boolean(),
  links: z.array(
    z.object({
      number: z.number().int().openapi({ description: 'The number on the badge in the html' }),
      position: z.number().int(),
      url: z.string(),
      destination: z.string().nullable(),
      people: z.number().int(),
      clicks: z.number().int(),
      share: z.number().openapi({ description: 'Part of this view’s clicks, from 0 to 1' }),
      level: z.number().int().min(0).max(4),
      occurrences: z.number().int().openapi({
        description: 'Places in the html using this link; 0 when it isn’t in the html',
      }),
    }),
  ),
});
export type ClickMapView = z.infer<typeof ClickMapViewSchema>;

export const BroadcastClickMapSchema = z
  .object({
    views: z.array(ClickMapViewSchema),
    unplaced: z
      .object({
        people: z.number().int(),
        clicks: z.number().int(),
      })
      .openapi({
        description:
          'Clicks by people who can’t be placed in a view, because they have since left the list. Only a send with several views can have any.',
      }),
  })
  .openapi('BroadcastClickMap');
export type BroadcastClickMap = z.infer<typeof BroadcastClickMapSchema>;

// ---------------------------------------------------------------------------------------------
// Reputation Ramp

export const RampSchema = z
  .object({
    id: id('reputationRamp'),
    sendingDomainId: id('sendingDomain').nullable(),
    domain: z.string(),
    kind: z.enum(['custom', 'shared']).openapi({
      description: 'A verified sending domain of the Channel’s own, or the shared platform domain',
    }),
    status: z.enum(['warming', 'paused', 'complete']),
    sharedOverride: z.boolean().openapi({
      description:
        'True on the shared domain’s ramp when the caller is an instance admin: they may raise maxCap above 5,000, use the bounds of a custom domain and skip warm-up there',
    }),
    skipped: z.boolean().openapi({
      description: 'True when the ramp is complete because an admin skipped it',
    }),
    skippedAt: timestamp.nullable(),
    startedDay: z.string().openapi({
      description: 'The UTC day this warm-up started (or started again), YYYY-MM-DD',
    }),
    day: z.string(),
    capToday: z.number().int(),
    sentToday: z.number().int(),
    pace: RampPaceSchema.openapi({
      description: 'The named pace startCap and growth match, or "custom"',
    }),
    startCap: z.number().int(),
    growth: z.number(),
    maxCap: z.number().int(),
    bounceThreshold: z.number(),
    complaintThreshold: z.number(),
    pausedReason: z.string().nullable().openapi({
      description: 'Why it is paused, in words for people. Never decides who may resume.',
    }),
    pausedBy: z.enum(['system', 'person']).nullable().openapi({
      description:
        'Who paused it: "system" when it paused itself over bounces or spam complaints, "person" when someone paused it by hand. Null unless paused. On the shared domain only an instance admin may resume a "system" pause.',
    }),
    days: z.array(
      z.object({
        day: z.string(),
        cap: z.number().int(),
        sent: z.number().int(),
        bounces: z.number().int(),
        complaints: z.number().int(),
      }),
    ),
    plan: WarmupPlanSchema,
  })
  .openapi('Ramp');
export type Ramp = z.infer<typeof RampSchema>;

export const UpdateRampSchema = z
  .object({
    pace: z.enum(['careful', 'standard', 'fast']).optional().openapi({
      description:
        'A named pace: sets startCap and growth together. Not with startCap or growth in the same request.',
    }),
    startCap: z.number().int().min(10).max(100_000).optional().openapi({
      description:
        'The first day’s cap of a custom pace (at most 500 on the shared domain). On a ramp already warming, today’s cap is raised to it and never lowered.',
    }),
    growth: z.number().min(1.05).max(3).optional().openapi({
      description: 'Daily growth after a healthy day (at most 1.5 on the shared domain)',
    }),
    maxCap: z.number().int().min(100).max(10_000_000).optional(),
    bounceThreshold: z.number().gt(0).max(0.1).optional(),
    complaintThreshold: z.number().gt(0).max(0.01).optional(),
    status: z.enum(['warming', 'paused']).optional().openapi({
      description:
        'Resume a paused ramp with "warming", or pause a warming one by hand. A pause of a paused ramp changes nothing.',
    }),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .refine(
    (value) => !value.pace || (value.startCap === undefined && value.growth === undefined),
    'Choose a named pace, or set startCap and growth yourself, not both.',
  )
  .openapi('UpdateRamp');
export type UpdateRamp = z.infer<typeof UpdateRampSchema>;

export const SkipRampSchema = z
  .object({
    confirm: z.literal(true).openapi({
      description: 'Must be true: skipping removes the daily cap at once',
    }),
    dailyVolume: z.number().int().min(0).max(100_000_000).optional().openapi({
      description:
        'How many emails a day this domain already sends elsewhere, as the admin states it. Kept in the audit log.',
    }),
  })
  .openapi('SkipRamp');
export type SkipRamp = z.infer<typeof SkipRampSchema>;

export const RestartRampSchema = z
  .object({
    confirm: z.literal(true).openapi({
      description: 'Must be true: restarting brings the daily cap back from the first day',
    }),
    pace: z.enum(['careful', 'standard', 'fast']).optional().openapi({
      description: 'Start again at a named pace; without it the ramp keeps its pace',
    }),
  })
  .openapi('RestartRamp');
export type RestartRamp = z.infer<typeof RestartRampSchema>;

// ---------------------------------------------------------------------------------------------
// Custom email CSS (the custom_email_css flag)

/** The largest email stylesheet, in bytes; the same as EMAIL_CSS_MAX_BYTES in @swarm/mail. */
const EMAIL_CSS_MAX_LENGTH = 20_000;

const EmailCssIssueSchema = z
  .object({
    level: z.enum(['error', 'warning']),
    message: z.string(),
    line: z.number().int().min(1).openapi({ description: '1-based line in the stylesheet' }),
  })
  .openapi('EmailCssIssue');
export const EmailCssSchema = z
  .object({
    css: z.string().openapi({ description: 'The stylesheet; empty when the Channel has none' }),
    updatedAt: timestamp.nullable(),
    warnings: z.array(EmailCssIssueSchema).openapi({
      description: 'What major mail clients will ignore; the stylesheet is used anyway',
    }),
  })
  .openapi('EmailCss');
export type EmailCss = z.infer<typeof EmailCssSchema>;

export const UpdateEmailCssSchema = z
  .object({
    css: z.string().max(EMAIL_CSS_MAX_LENGTH).openapi({
      description:
        'The whole stylesheet; empty removes it. Refused when the lint finds an error (@import, url(), expression(), position: fixed, `<`, unbalanced braces).',
    }),
  })
  .openapi('UpdateEmailCss');
// ---------------------------------------------------------------------------------------------
// Channel overview: the numbers on the dashboard's Overview, in one read

/** How many recent Broadcasts the overview reports. */
export const OVERVIEW_BROADCASTS = 8;

const ChannelOverviewBroadcastSchema = z
  .object({
    id: id('broadcast'),
    dispatchId: id('dispatch'),
    subject: z.string(),
    status: BroadcastStatusSchema,
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
    recipientCount: z.number().int(),
    delivered: z.number().int(),
    humanOpens: z.number().int(),
    humanClicks: z.number().int(),
    openRate: z.number().openapi({ description: 'Human unique opens / delivered' }),
    clickRate: z.number().openapi({ description: 'Human unique clicks / delivered' }),
  })
  .openapi('ChannelOverviewBroadcast');
export type ChannelOverviewBroadcast = z.infer<typeof ChannelOverviewBroadcastSchema>;

export const ChannelOverviewSchema = z
  .object({
    members: z.object({
      /** Members with status active now. */
      active: z.number().int(),
      /** Members created in the last 30 days, whatever their status now. */
      joinedLast30Days: z.number().int(),
      /** Members who unsubscribed in the last 30 days. */
      leftLast30Days: z.number().int(),
    }),
    /** The latest sent (or partly failed) Broadcasts, newest first. */
    broadcasts: z.array(ChannelOverviewBroadcastSchema).max(OVERVIEW_BROADCASTS),
  })
  .openapi('ChannelOverview');
export type ChannelOverview = z.infer<typeof ChannelOverviewSchema>;
