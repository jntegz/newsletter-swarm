import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { SecondFactorStatusSchema } from './p7-security';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });

/** Trimmed and lowercased; the database also compares emails case-insensitively. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(254));

const SeatRoleSchema = z.enum(['owner', 'admin', 'editor', 'author', 'viewer']).openapi('SeatRole');
export type SeatRole = z.infer<typeof SeatRoleSchema>;

/** Roles that can be granted by invitation (ownership is transferred, never invited). */
const InviteRoleSchema = z.enum(['admin', 'editor', 'author', 'viewer']).openapi('InviteRole');

/**
 * Addresses a Channel cannot take. Includes every label a self-hosted install uses in its zone
 * (packages/installer/src/hostnames.ts; the installer's tests compare the two): a Channel site
 * there would lose to the worker route or DNS record already on that hostname.
 */
export const RESERVED_SLUGS = [
  'api',
  'app',
  'www',
  'admin',
  'healthz',
  'media',
  'mail',
  'link',
  'forms',
  'static',
  'assets',
  'swarm',
  'help',
  'support',
  'status',
  'security',
  'events',
  'sites',
  'unsubscribe',
  'dmarc',
  'staging-app',
  'staging-forms',
  'staging-link',
  'staging-media',
  'staging-events',
  'staging-sites',
  'staging-mail',
  'staging-unsubscribe',
  'staging-dmarc',
] as const;

export const ChannelSlugSchema = z
  .string()
  .min(3, 'Use at least 3 characters.')
  .max(48, 'Use at most 48 characters.')
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/,
    'Use lowercase letters, numbers and single dashes.',
  )
  .refine(
    (slug) => !(RESERVED_SLUGS as readonly string[]).includes(slug),
    'This address is reserved.',
  );

const ChannelBrandingSchema = z
  .object({
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i, 'Use a hex colour such as #6c4cf1.')
      .nullable(),
    logoMediaId: z.string().regex(idPattern('media')).nullable(),
  })
  .openapi('ChannelBranding');
export type ChannelBranding = z.infer<typeof ChannelBrandingSchema>;

/**
 * What the Channel's website form asks for. `email` asks for the address alone; the others ask for
 * more after the address is saved, so someone who leaves early still stays on the list.
 */
/** How a Channel's emails look. Colours are checked; everything else is a choice from a list. */
export const EmailDesignSchema = z
  .object({
    font: z.enum(['system', 'serif', 'mono']).default('system'),
    /** Show the publication's logo at the top. */
    showLogo: z.boolean().default(false),
    pageColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    cardColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    textColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    /** A line above and below every email, such as a tagline or a postal address. */
    header: z.string().trim().max(200).default(''),
    footer: z.string().trim().max(500).default(''),
  })
  .openapi('EmailDesign');
export type EmailDesign = z.infer<typeof EmailDesignSchema>;

const SIGNUP_PATHS = ['email', 'email_name', 'email_name_plan'] as const;
const SignupPathSchema = z.enum(SIGNUP_PATHS);
export type SignupPath = z.infer<typeof SignupPathSchema>;

export const ChannelSchema = z
  .object({
    id: z.string().regex(idPattern('channel')),
    workspaceId: z.string().regex(idPattern('workspace')),
    slug: ChannelSlugSchema,
    name: z.string().min(1).max(80),
    description: z.string().max(280).nullable(),
    branding: ChannelBrandingSchema,
    status: z.enum(['active', 'paused']),
    /** New Members confirm by email before they are sent anything. Capture Forms can override it. */
    doubleOptIn: z.boolean(),
    /** Every signup must confirm: forms can't turn it off, and added Members are emailed. */
    requireConfirmation: z.boolean(),
    /** The steps of the website's signup form. */
    signupPath: SignupPathSchema,
    /** Unsubscribe readers with no opens or clicks for this many days; null keeps everyone. */
    sunsetDays: z.number().int().nullable(),
    /** An open pixel per person in each email (docs/privacy-controls.md). */
    trackOpens: z.boolean(),
    /** Links go through the tracker, tied to the person. Off: plain links, no click counts. */
    trackClicks: z.boolean(),
    /** Engagement scores and best-time sending. Always false while trackOpens is false. */
    profileReaders: z.boolean(),
    /** Needs the email_design flag to apply. */
    emailDesign: EmailDesignSchema,
    /** How many days a confirm link works. */
    confirmDays: z.number().int().min(1).max(30),
    /** The operator's style guide, shown to agents as publication context. Empty until written. */
    styleGuide: z.string().openapi({
      description:
        'Operator-written voice and format guidance, shared with agents as publication context',
    }),
    role: SeatRoleSchema.openapi({ description: 'Your effective role on this Channel' }),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
  })
  .openapi('Channel');
export type Channel = z.infer<typeof ChannelSchema>;

export const CreateChannelSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the publication a name.').max(80),
    slug: ChannelSlugSchema,
    description: z.string().trim().max(280).nullable().optional(),
  })
  .openapi('CreateChannel');
export type CreateChannel = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the publication a name.').max(80).optional(),
    description: z.string().trim().max(280).nullable().optional(),
    branding: ChannelBrandingSchema.partial().optional(),
    status: z.enum(['active', 'paused']).optional(),
    doubleOptIn: z.boolean().optional(),
    requireConfirmation: z.boolean().optional(),
    signupPath: SignupPathSchema.optional(),
    sunsetDays: z.number().int().min(90).max(3650).nullable().optional(),
    /** Admins only. Turning open tracking off also stops reader profiling. */
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    profileReaders: z.boolean().optional(),
    emailDesign: EmailDesignSchema.optional(),
    confirmDays: z.number().int().min(1).max(30).optional(),
    styleGuide: z
      .string()
      .trim()
      .max(4000, 'Keep the style guide under 4000 characters.')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateChannel');
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

const OperatorSchema = z
  .object({
    id: z.string().regex(idPattern('operator')),
    email: z.email(),
    name: z.string().max(80).nullable(),
    createdAt: timestamp,
  })
  .openapi('Operator');
export type Operator = z.infer<typeof OperatorSchema>;

export const WorkspaceSchema = z
  .object({
    id: z.string().regex(idPattern('workspace')),
    name: z.string().min(1).max(80),
    plan: z.enum(['free', 'pro', 'scale', 'enterprise']),
    role: SeatRoleSchema,
    createdAt: timestamp,
  })
  .openapi('Workspace');
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const UpdateWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .openapi('UpdateWorkspace');

export const MeSchema = z
  .object({
    operator: OperatorSchema,
    workspaces: z.array(WorkspaceSchema),
    sessionId: z.string().regex(idPattern('session')),
    /** Phase 7: whether this session still needs a second factor (docs/security.md). */
    secondFactor: SecondFactorStatusSchema.optional(),
    /** Self-hosting: whether this operator can change instance settings (0032_instance.sql). */
    instanceAdmin: z.boolean(),
  })
  .openapi('Me');
export type Me = z.infer<typeof MeSchema>;

export const AuthConfigSchema = z
  .object({
    turnstileSiteKey: z.string(),
    googleEnabled: z.boolean(),
    devMailbox: z
      .boolean()
      .openapi({ description: 'Local development only: a mailbox viewer exists' }),
  })
  .openapi('AuthConfig');
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const QuickPassRequestSchema = z
  .object({
    email: EmailSchema,
    turnstileToken: z.string().min(1).max(4096),
    returnTo: z
      .string()
      .regex(/^\/(?!\/)[^\s]*$/, 'Must be a path on this site.')
      .max(512)
      .optional(),
  })
  .openapi('QuickPassRequest');
export const QuickPassTokenSchema = z
  .object({ token: z.string().min(20).max(200) })
  .openapi('QuickPassToken');
export const QuickPassConsumeSchema = z
  .object({
    token: z.string().min(20).max(200),
    // Not EmailSchema: the token's own address is the check, and the installer mints the owner's
    // first link for an address that schema may refuse (first!last@, josé@).
    confirmEmail: z.string().trim().toLowerCase().max(254).optional().openapi({
      description:
        'The address the link signs in as, after the page has shown it. Required unless this browser asked for the link.',
    }),
  })
  .openapi('QuickPassConsume');
export const QuickPassPeekSchema = z
  .object({ email: z.string().openapi({ description: 'The address the link signs in as' }) })
  .openapi('QuickPassPeek');
export type QuickPassPeek = z.infer<typeof QuickPassPeekSchema>;

export const SessionSummarySchema = z
  .object({
    id: z.string().regex(idPattern('session')),
    current: z.boolean(),
    userAgent: z.string().nullable(),
    ipPrefix: z.string().nullable(),
    createdAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: timestamp,
  })
  .openapi('SessionSummary');
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SeatSchema = z
  .object({
    id: z.string().regex(idPattern('seat')),
    operator: OperatorSchema,
    role: SeatRoleSchema,
    createdAt: timestamp,
  })
  .openapi('Seat');
export type Seat = z.infer<typeof SeatSchema>;

export const UpdateSeatSchema = z.object({ role: SeatRoleSchema }).openapi('UpdateSeat');

/**
 * What removing a seat also revokes: the API keys this teammate created in the workspace and the
 * apps they authorised for it (OAuth grants, /v2 and /mcp), counting only live ones.
 */
export const SeatAccessSchema = z
  .object({
    apiKeys: z.number().int().nonnegative(),
    apps: z.number().int().nonnegative(),
  })
  .openapi('SeatAccess');
export type SeatAccess = z.infer<typeof SeatAccessSchema>;

export const InviteSchema = z
  .object({
    id: z.string().regex(idPattern('invite')),
    email: z.email(),
    role: InviteRoleSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  })
  .openapi('Invite');
export type Invite = z.infer<typeof InviteSchema>;

export const CreateInviteSchema = z
  .object({ email: EmailSchema, role: InviteRoleSchema })
  .openapi('CreateInvite');

export const AcceptInviteSchema = z
  .object({ token: z.string().min(20).max(200) })
  .openapi('AcceptInvite');

/** Where the subject of an image sits, as fractions of its width and height. */
const FocalPointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .openapi('FocalPoint');

export const MediaAssetSchema = z
  .object({
    id: z.string().regex(idPattern('media')),
    channelId: z.string().regex(idPattern('channel')).nullable(),
    contentType: z.string(),
    /** From the content type: image/*, font/* (WOFF2, WOFF), or any other file (PDF). */
    kind: z.enum(['image', 'font', 'file']),
    bytes: z.number().int().positive(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    altText: z.string().nullable(),
    focalPoint: FocalPointSchema.nullable(),
    url: z.url(),
    createdAt: timestamp,
  })
  .openapi('MediaAsset');
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const UpdateMediaSchema = z
  .object({
    altText: z
      .string()
      .trim()
      .max(300, 'Keep alt text under 300 characters.')
      .nullable()
      .optional(),
    focalPoint: FocalPointSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateMedia');
export type UpdateMedia = z.infer<typeof UpdateMediaSchema>;

export const AuditEventSchema = z
  .object({
    id: z.string().regex(idPattern('auditEvent')),
    seq: z.number().int(),
    action: z.string(),
    actor: z.object({ id: z.string(), email: z.string() }).nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: timestamp,
  })
  .openapi('AuditEvent');
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Upper bound (and default) for the events one verify request checks. */
export const CHAIN_VERIFY_MAX = 10_000;

/**
 * A verify request checks at most `limit` events (CHAIN_VERIFY_MAX by default), oldest first;
 * the client follows `nextCursor` until `complete`, so no request reads a whole long chain.
 */
export const ChainVerifyQuerySchema = z.object({
  /** A signed token (lib/chain-verify.ts in the api worker), so longer than other cursors. */
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(CHAIN_VERIFY_MAX).default(CHAIN_VERIFY_MAX),
});

/** Paging fields shared by both chains' verify responses. */
export const chainPageShape = {
  /**
   * The first seq this request checked. Past the chain's start, the requests before it (whose
   * signed `nextCursor` it followed) checked the rest.
   */
  fromSeq: z.number().int(),
  /** True when the check is finished: the whole chain verified, or a break found. */
  complete: z.boolean(),
  /** Pass as `cursor` to go on checking; null once complete or a break is found. */
  nextCursor: z.string().nullable(),
};

export const AuditVerificationSchema = z
  .object({
    ok: z.boolean(),
    checked: z.number().int(),
    brokenAtSeq: z.number().int().nullable(),
    /** Retention pruned events up to this seq; the kept chain starts after it (null: none). */
    anchorSeq: z.number().int().nullable(),
    ...chainPageShape,
  })
  .openapi('AuditVerification');

export const HealthSchema = z
  .object({
    ok: z.literal(true),
    service: z.string(),
    environment: z.string(),
    time: timestamp,
    /** Workers bound to the vault: it answered through their binding (otherwise this is a 503). */
    vault: z.literal('ok').optional(),
  })
  .openapi('Health');
export const FlagsSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
  })
  .openapi('Flags');
export type Flags = z.infer<typeof FlagsSchema>;
