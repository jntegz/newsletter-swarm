// Email checks (flag email_verification; docs/email-verification.md): addresses checked with
// DeBounce, an email verification service the owner of an install connects once with the worker
// secret DEBOUNCE_API_KEY. Tables: migrations/0068_email_verification.sql. Every result is one of
// three colours; an address with no result is "not checked".
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-11-16T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/**
 * Where every "create a DeBounce account" link in the code goes: the referral link of Swarm's
 * owner. The first link in docs/email-verification.md and two tests spell it out too, so
 * change them along with it.
 */
export const DEBOUNCE_SIGNUP_URL = 'https://tegze.link/debounce';
/** DeBounce's own page with the account's API key. */
export const DEBOUNCE_API_SETTINGS_URL = 'https://app.debounce.io/api';

export const EMAIL_CHECK_COLOURS = ['green', 'orange', 'red'] as const;
export type EmailCheckColour = (typeof EMAIL_CHECK_COLOURS)[number];
/** The colours, and "not checked" for an address with no result: filters and segments. */
export const EMAIL_CHECK_STATES = [...EMAIL_CHECK_COLOURS, 'unchecked'] as const;
export type EmailCheckState = (typeof EMAIL_CHECK_STATES)[number];
export const EmailCheckStateSchema = z.enum(EMAIL_CHECK_STATES).openapi('EmailCheckState');

export const EMAIL_CHECK_STATE_LABELS: Record<EmailCheckState, string> = {
  green: 'Green',
  orange: 'Orange',
  red: 'Red',
  unchecked: 'Not checked',
};

/** Who gave the result: Swarm's own free checks, or DeBounce (one credit). */
const EMAIL_CHECK_SOURCES = ['swarm', 'debounce'] as const;
export type EmailCheckSource = (typeof EMAIL_CHECK_SOURCES)[number];

/** DeBounce's result codes, with the colour Swarm gives each and the words it shows. */
export const EMAIL_CHECK_CODES = {
  1: { colour: 'red', label: 'Not an email address', meaning: 'The address is written wrong.' },
  2: {
    colour: 'red',
    label: 'Spam trap',
    meaning: 'An address kept to catch senders who mail people who never asked.',
  },
  3: {
    colour: 'orange',
    label: 'Temporary address',
    meaning: 'A throwaway mailbox that stops working after a while.',
  },
  4: {
    colour: 'orange',
    label: 'Can’t be confirmed',
    meaning: 'The mail server accepts every address, so this one can’t be confirmed.',
  },
  5: { colour: 'green', label: 'Deliverable', meaning: 'The mailbox exists and takes email.' },
  6: { colour: 'red', label: 'Will bounce', meaning: 'The mailbox does not exist.' },
  7: {
    colour: 'orange',
    label: 'Server didn’t answer',
    meaning: 'The mail server could not be reached, even after DeBounce tried again.',
  },
  8: {
    colour: 'orange',
    label: 'Team address',
    meaning: 'An address like info@ or support@ that reaches a team, not one person.',
  },
} as const satisfies Record<number, { colour: EmailCheckColour; label: string; meaning: string }>;
export type EmailCheckCode = keyof typeof EMAIL_CHECK_CODES;

export const isEmailCheckCode = (value: unknown): value is EmailCheckCode =>
  typeof value === 'number' && Object.hasOwn(EMAIL_CHECK_CODES, value);

/** The colour of a DeBounce result code. */
export const colourOfCode = (code: EmailCheckCode): EmailCheckColour =>
  EMAIL_CHECK_CODES[code].colour;

// ---- What to do with each colour ------------------------------------------------------------

/** Where an address comes from. Each has its own rules. */
const EMAIL_CHECK_ORIGINS = ['signup', 'import', 'manual'] as const;
export type EmailCheckOrigin = (typeof EMAIL_CHECK_ORIGINS)[number];

/**
 * accept: let them in. tag: let them in and tag them `email-<colour>`. confirm: they must confirm
 * by email first, whatever the form says. refuse: a signup form says no, an import skips them.
 */
const EMAIL_CHECK_ACTIONS = ['accept', 'tag', 'confirm', 'refuse'] as const;
export type EmailCheckAction = (typeof EMAIL_CHECK_ACTIONS)[number];

/** Additions by hand or through the API are checked afterwards, so they can only be tagged. */
export const EMAIL_CHECK_ORIGIN_ACTIONS: Record<EmailCheckOrigin, readonly EmailCheckAction[]> = {
  signup: EMAIL_CHECK_ACTIONS,
  import: EMAIL_CHECK_ACTIONS,
  manual: ['accept', 'tag'],
};

/** The tag "accept and tag" adds. */
export const emailCheckTag = (colour: EmailCheckColour) => `email-${colour}`;

const RuleSchema = z.object({
  green: z.enum(EMAIL_CHECK_ACTIONS),
  orange: z.enum(EMAIL_CHECK_ACTIONS),
  red: z.enum(EMAIL_CHECK_ACTIONS),
});

export const EMAIL_CHECK_VALID_MONTHS = { min: 1, max: 24, default: 6 } as const;

export const EmailCheckSettingsSchema = z
  .object({
    /**
     * Signups: at a single opt-in form while they wait (up to a few seconds, with checkSignups),
     * or once a double opt-in signup has confirmed (checkConfirmed). After confirming, `confirm`
     * keeps them as they are and `refuse` stops mailing them (a suppression for the publication).
     */
    signup: RuleSchema,
    /** Applies when an import is asked to check its addresses. */
    import: RuleSchema,
    /** Checked in the background after someone is added by hand or through the API. */
    manual: RuleSchema,
    /**
     * Single opt-in forms only: check new signups while they wait. Off unless the publisher turns
     * it on: the typed address goes to DeBounce at signup, before its holder has confirmed
     * anything, which the publisher's privacy notice has to say. A form that asks people to
     * confirm by email never checks at signup; see checkConfirmed.
     */
    checkSignups: z.boolean(),
    /**
     * Double opt-in: check a signup once the person has confirmed their address, and apply the
     * signup rules then (accept, tag, or stop mailing for refuse). Nothing goes to DeBounce for
     * an address nobody confirmed (security review S04-P3-TR-signup-check-after-confirmation).
     */
    checkConfirmed: z.boolean().default(true),
    /**
     * Tell the person at the form what the check found (a refusal and DeBounce's spelling
     * suggestion). Off by default: the form's answer then never says what DeBounce concluded
     * about an address, so it can't be used to test someone else's; a refused address is
     * answered like any signup and simply not added.
     */
    showSignupVerdict: z.boolean().default(false),
    checkManual: z.boolean(),
    /** A result counts for this long; a later check asks again only for older or missing ones. */
    validMonths: z
      .number()
      .int()
      .min(EMAIL_CHECK_VALID_MONTHS.min)
      .max(EMAIL_CHECK_VALID_MONTHS.max),
  })
  .superRefine((value, ctx) => {
    for (const origin of EMAIL_CHECK_ORIGINS) {
      for (const colour of EMAIL_CHECK_COLOURS) {
        if (!EMAIL_CHECK_ORIGIN_ACTIONS[origin].includes(value[origin][colour])) {
          ctx.addIssue({
            code: 'custom',
            path: [origin, colour],
            message: 'Pick accept or accept and tag: these are checked after they are added.',
          });
        }
      }
    }
  })
  .openapi('EmailCheckSettings');
export type EmailCheckSettings = z.infer<typeof EmailCheckSettingsSchema>;

/**
 * Defaults follow DeBounce's own advice for forms: accept deliverable, accept-all and unknown
 * results, so real people are never turned away; refuse only what will bounce. Checking signups
 * at the form, and showing the person what the check found, are each the publisher's own choice
 * (security review S02-P3-T-debounce-signup-disclosure, S02-P3-T-signup-verdict-oracle).
 */
export const EMAIL_CHECK_DEFAULTS: EmailCheckSettings = {
  signup: { green: 'accept', orange: 'accept', red: 'refuse' },
  import: { green: 'accept', orange: 'accept', red: 'refuse' },
  manual: { green: 'accept', orange: 'accept', red: 'tag' },
  checkSignups: false,
  checkConfirmed: true,
  showSignupVerdict: false,
  checkManual: true,
  validMonths: EMAIL_CHECK_VALID_MONTHS.default,
};

/** Stored settings over the defaults: a missing or broken key keeps its default. */
export function emailCheckSettings(stored: unknown): EmailCheckSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const merged = {
    ...EMAIL_CHECK_DEFAULTS,
    ...value,
    signup: { ...EMAIL_CHECK_DEFAULTS.signup, ...(value.signup as object) },
    import: { ...EMAIL_CHECK_DEFAULTS.import, ...(value.import as object) },
    manual: { ...EMAIL_CHECK_DEFAULTS.manual, ...(value.manual as object) },
  };
  const parsed = EmailCheckSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : EMAIL_CHECK_DEFAULTS;
}

/** Refused at a signup form: shown to the person signing up. */
export const EMAIL_CHECK_REFUSAL = 'This email address can’t receive email. Check it for typos.';

// ---- Access ---------------------------------------------------------------------------------

/**
 * Why a workspace may use DeBounce, which bills the install owner's credits: an instance admin
 * allowed it (a workspace an instance admin makes is allowed when it is made), or every workspace
 * may. An owner seat held by an instance admin allows nothing by itself.
 */
const EMAIL_CHECK_ACCESS = ['allowed', 'every_workspace', 'not_allowed'] as const;
export type EmailCheckAccess = (typeof EMAIL_CHECK_ACCESS)[number];

export const EmailCheckStatusSchema = z
  .object({
    /** The email_verification feature is on here. */
    enabled: z.boolean(),
    /** The install has a DeBounce key (DEBOUNCE_API_KEY). The key itself never leaves the server. */
    keySet: z.boolean(),
    access: z.enum(EMAIL_CHECK_ACCESS),
    /** Checks can run for this workspace: enabled, a key, and access. */
    available: z.boolean(),
    /** Credits left on the install's DeBounce account; null when unknown or not shown. */
    balance: z.number().int().nullable(),
    settings: EmailCheckSettingsSchema,
    /**
     * This workspace's share of the install's single checks today (UTC). When it is used up,
     * signups pass unchecked and additions are not checked until tomorrow.
     */
    budget: z.object({
      dailyChecks: z.number().int(),
      usedToday: z.number().int(),
      exhausted: z.boolean(),
      /**
       * Addresses its checks of a list (and imports that check addresses) may send to DeBounce
       * this calendar month (UTC), and how many they have. A check that needs more than is left
       * can't start.
       */
      listChecks: z.number().int(),
      listUsedThisMonth: z.number().int(),
      listResetsAt: timestamp,
    }),
  })
  .openapi('EmailCheckStatus');
export type EmailCheckStatus = z.infer<typeof EmailCheckStatusSchema>;

/** Instance admins: the key, the balance and who may use the install's DeBounce credits. */
export const InstanceEmailChecksSchema = z
  .object({
    keySet: z.boolean(),
    /** DeBounce answered with this many credits; null without a key or when it can't be reached. */
    balance: z.number().int().nullable(),
    /** The key was refused by DeBounce. */
    keyRejected: z.boolean(),
    everyWorkspace: z.boolean(),
    /** What a workspace gets without its own numbers: single checks a day, list checks a month. */
    defaults: z.object({ dailyChecks: z.number().int(), listChecks: z.number().int() }),
    workspaces: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          /** An instance admin allowed this workspace: the only thing that lets it use the key. */
          allowed: z.boolean(),
          /** Single checks it may spend per day (UTC), and how many it has today. */
          dailyChecks: z.number().int(),
          usedToday: z.number().int(),
          /** Addresses its checks of a list may send per calendar month (UTC), and this month's. */
          listChecks: z.number().int(),
          listUsedThisMonth: z.number().int(),
          /** Whether an instance admin set its own numbers, rather than the install's defaults. */
          customDailyChecks: z.boolean(),
          customListChecks: z.boolean(),
          /**
           * An owner of the workspace is an instance admin. For information only: it allows
           * nothing by itself, because any owner can make a teammate an owner.
           */
          ownedByInstanceAdmin: z.boolean(),
        }),
      )
      .openapi({ description: 'Every workspace on this Swarm, by name, up to the first 500.' }),
  })
  .openapi('InstanceEmailChecks');
export type InstanceEmailChecks = z.infer<typeof InstanceEmailChecksSchema>;

export const UpdateInstanceEmailChecksSchema = z
  .object({ everyWorkspace: z.boolean() })
  .openapi('UpdateInstanceEmailChecks');
export const UpdateInstanceEmailChecksWorkspaceSchema = z
  .object({
    allowed: z.boolean(),
    /** Single checks per day for this workspace; null goes back to the install's default. */
    dailyChecks: z.number().int().min(0).max(1_000_000).nullable().optional(),
    /** Addresses its checks of a list may send per month; null goes back to the default. */
    listChecks: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .openapi('UpdateInstanceEmailChecksWorkspace');

// ---- One address's result -------------------------------------------------------------------

export const MemberEmailCheckSchema = z
  .object({
    state: z.enum(EMAIL_CHECK_COLOURS),
    /** DeBounce's result code (1 to 8); Swarm's own checks use the same codes. */
    code: z.number().int().nullable(),
    /** The code in plain words. */
    reason: z.string(),
    /** DeBounce's suggested spelling, when the address looks like a typo. */
    didYouMean: z.string().nullable(),
    source: z.enum(EMAIL_CHECK_SOURCES),
    checkedAt: timestamp,
    /** Older than the workspace's valid period: the next check asks again. */
    stale: z.boolean(),
  })
  .openapi('MemberEmailCheck');
export type MemberEmailCheck = z.infer<typeof MemberEmailCheckSchema>;

// ---- Checking a list ------------------------------------------------------------------------

/** Addresses per part sent to DeBounce's bulk API, one part at a time. */
export const EMAIL_CHECK_PART_SIZE = 5000;
/** Below this many addresses, a check asks DeBounce one address at a time instead. */
export const EMAIL_CHECK_SINGLE_MAX = 100;
/** DeBounce allows this many calls at once per account. */
export const DEBOUNCE_MAX_CONCURRENT = 5;
/** A part's file can be fetched for at most this long. */
export const EMAIL_CHECK_FILE_HOURS = 24;

const EMAIL_CHECK_SCOPES = ['workspace', 'channel', 'segment', 'import'] as const;
export type EmailCheckScope = (typeof EMAIL_CHECK_SCOPES)[number];

/**
 * planning: counting. planned: waiting for the go-ahead. running: parts going to DeBounce.
 * stopping: no new parts; the one at DeBounce finishes first. paused: out of credits, or the key
 * stopped working. completed, stopped, canceled (a plan nobody started) and failed are final.
 */
const EMAIL_CHECK_RUN_STATUSES = [
  'planning',
  'planned',
  'running',
  'stopping',
  'paused',
  'completed',
  'stopped',
  'canceled',
  'failed',
] as const;
export type EmailCheckRunStatus = (typeof EMAIL_CHECK_RUN_STATUSES)[number];
export const EMAIL_CHECK_RUN_FINAL: readonly EmailCheckRunStatus[] = [
  'completed',
  'stopped',
  'canceled',
  'failed',
];

const colourCounts = z.object({
  green: z.number().int(),
  orange: z.number().int(),
  red: z.number().int(),
});

export const EmailCheckRunSchema = z
  .object({
    id: id('emailCheckRun'),
    scope: z.enum(EMAIL_CHECK_SCOPES),
    channelId: z.string().nullable(),
    circleId: z.string().nullable(),
    importId: z.string().nullable(),
    onlyNeverChecked: z.boolean(),
    status: z.enum(EMAIL_CHECK_RUN_STATUSES),
    /** Why it is paused: credits ran out, or DeBounce refused the key. */
    pausedReason: z.enum(['credits', 'key']).nullable(),
    error: z.string().nullable(),
    plan: z.object({
      /** Different addresses in scope. */
      addresses: z.number().int(),
      /** Already checked within the valid period: skipped. */
      fresh: z.number().int(),
      /** Settled by Swarm's own checks, for free. */
      local: z.number().int(),
      /** Sent to DeBounce: one credit each. */
      toCheck: z.number().int(),
      parts: z.number().int(),
      /** bulk: in parts through the bulk API. single: one address at a time. */
      method: z.enum(['bulk', 'single']),
    }),
    /** DeBounce's balance when the plan was made; null when unknown. */
    balance: z.number().int().nullable(),
    progress: z.object({
      /** The part at DeBounce now, or the last one sent. */
      part: z.number().int(),
      parts: z.number().int(),
      /** Addresses with a result from this check so far. */
      checked: z.number().int(),
      creditsUsed: z.number().int(),
      /** How far DeBounce is with the part it has, 0 to 100. */
      partPercent: z.number().int(),
    }),
    results: colourCounts,
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
  })
  .openapi('EmailCheckRun');
export type EmailCheckRun = z.infer<typeof EmailCheckRunSchema>;

export const CreateEmailCheckRunSchema = z
  .object({
    scope: z.enum(['workspace', 'channel', 'segment']),
    channelId: id('channel').optional(),
    circleId: id('circle').optional(),
    /** Only addresses that were never checked, not those whose result is old. */
    onlyNeverChecked: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.scope !== 'workspace' && !value.channelId) {
      ctx.addIssue({ code: 'custom', path: ['channelId'], message: 'Choose a publication.' });
    }
    if (value.scope === 'segment' && !value.circleId) {
      ctx.addIssue({ code: 'custom', path: ['circleId'], message: 'Choose a segment.' });
    }
  })
  .openapi('CreateEmailCheckRun');
export type CreateEmailCheckRun = z.input<typeof CreateEmailCheckRunSchema>;

// ---- A publication's results ----------------------------------------------------------------

export const EmailCheckSummarySchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    keySet: z.boolean(),
    access: z.enum(EMAIL_CHECK_ACCESS),
    /** Subscribers who may be mailed (pending, active, paused). */
    subscribers: z.number().int(),
    counts: colourCounts.extend({
      unchecked: z.number().int(),
      /** Of the coloured ones, results older than the valid period. */
      stale: z.number().int(),
    }),
    reasons: z.array(
      z.object({
        code: z.number().int(),
        state: z.enum(EMAIL_CHECK_COLOURS),
        label: z.string(),
        count: z.number().int(),
      }),
    ),
    validMonths: z.number().int(),
    /** The workspace's running check, or its latest one. */
    run: EmailCheckRunSchema.nullable(),
  })
  .openapi('EmailCheckSummary');
export type EmailCheckSummary = z.infer<typeof EmailCheckSummarySchema>;

/** suppress: stop mailing them (a suppression for this publication; reversible). delete: delete them. */
const EMAIL_CHECK_RED_ACTIONS = ['suppress', 'delete'] as const;
export type EmailCheckRedAction = (typeof EMAIL_CHECK_RED_ACTIONS)[number];
/** Red subscribers acted on per request; the dashboard repeats until none remain. */
export const EMAIL_CHECK_RED_BATCH = 1000;

export const EmailCheckRedActionSchema = z
  .object({
    action: z.enum(EMAIL_CHECK_RED_ACTIONS),
    /** false: only count. true: do it, for up to EMAIL_CHECK_RED_BATCH subscribers. */
    confirm: z.boolean().default(false),
  })
  .openapi('EmailCheckRedAction');
export type EmailCheckRedActionInput = z.input<typeof EmailCheckRedActionSchema>;

export const EmailCheckRedResultSchema = z
  .object({
    /** Red subscribers this action would change (paying ones never count). */
    actionable: z.number().int(),
    /** Done by this request. */
    done: z.number().int(),
    /** Still to do: send the request again. */
    remaining: z.number().int(),
    /** Red subscribers with a paid subscription: never changed automatically. */
    paying: z.number().int(),
    /** The first of them, to look at one by one. */
    needsAttention: z.array(z.object({ id: z.string(), email: z.string() })),
    /** Bulk deletes queued by this request. */
    jobIds: z.array(z.string()),
  })
  .openapi('EmailCheckRedResult');
export type EmailCheckRedResult = z.infer<typeof EmailCheckRedResultSchema>;

/** Turns "Check addresses during import" on or off before an import is confirmed. */
export const ImportEmailCheckSchema = z
  .object({ checkAddresses: z.boolean() })
  .openapi('ImportEmailCheck');
