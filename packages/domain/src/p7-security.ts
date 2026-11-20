// Account security (Phase 7): second-factor sessions, passkeys, TOTP, recovery codes, the
// workspace 2FA policy, "sign out everywhere" and SSO connections. Shared constants (methods,
// RECOVERY_CODE_COUNT, TOTP and WebAuthn timings) are in p7-platform.ts. Tables:
// migrations/0012_platform.sql and 0017_security.sql. Contract: docs/security.md.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { REQUIRE_2FA_OPTIONS } from './p7-platform';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Policy and grace

/**
 * An owner or admin (or any seat where the workspace requires it for all) who has no second
 * factor may keep working for this long after the requirement first applied to them, with a
 * prompt to set one up. After it, every session they have must enrol before it can do anything.
 */
export const MFA_GRACE_DAYS = 14;
/** Removing a factor, regenerating recovery codes or adding a factor needs a check this recent. */
export const MFA_STEP_UP_MINUTES = 10;
/** Failed second-factor attempts allowed per session per window, and per operator per hour. */
export const MFA_ATTEMPTS_PER_SESSION = 5;
export const MFA_ATTEMPTS_SESSION_WINDOW_MINUTES = 15;
export const MFA_ATTEMPTS_PER_OPERATOR = 10;
/** A sign-in from a device (browser family + network) not seen for this long emails the operator. */
export const NEW_DEVICE_LOOKBACK_DAYS = 90;
/**
 * A session that came through an identity provider ends this long after it was created, however
 * active it is, so a provider's authority is re-proved at least this often. Owner-tunable.
 */
export const SSO_SESSION_MAX_HOURS = 12;

/**
 * `ok`: the session can do anything its seats allow.
 * `verify`: a first factor only; the operator has a second factor and must use it.
 * `enroll`: a second factor is required and the grace period is over; set one up first.
 */
const SECOND_FACTOR_STATES = ['ok', 'verify', 'enroll'] as const;
export type SecondFactorState = (typeof SECOND_FACTOR_STATES)[number];

export const SecondFactorStatusSchema = z
  .object({
    state: z.enum(SECOND_FACTOR_STATES),
    /** What this operator can verify with now. */
    methods: z.array(z.enum(['passkey', 'totp', 'recovery'])),
    /** Owners and admins, or every seat in a workspace that requires it. The strictest seat wins. */
    required: z.boolean(),
    /** Set while a required operator without a second factor is in their grace period. */
    enrollBy: timestamp.nullable(),
    /** How this session proved a second factor, if it did. */
    verifiedWith: z.enum(['passkey', 'totp', 'recovery', 'sso']).nullable(),
  })
  .openapi('SecondFactorStatus');
export type SecondFactorStatus = z.infer<typeof SecondFactorStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Verifying a second factor

/** A 6-digit TOTP code; spaces are ignored. */
const TotpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app.'));

export const TotpVerifySchema = z.object({ code: TotpCodeSchema }).openapi('TotpVerify');

/** Recovery codes are shown as `xxxx-xxxx-xxxx`; case, spaces and dashes are ignored. */
const RecoveryCodeSchema = z
  .string()
  .transform((value) => value.replace(/[\s-]+/g, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]{12}$/, 'Enter one of your recovery codes.'));

export const RecoveryVerifySchema = z
  .object({ code: RecoveryCodeSchema })
  .openapi('RecoveryVerify');

/**
 * WebAuthn JSON from the browser (`@simplewebauthn/browser`). The library on the server checks
 * the structure in depth; this only bounds the size.
 */
const webauthnJson = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 16_384, 'Too large.');

export const PasskeyAssertionSchema = z
  .object({ response: webauthnJson })
  .openapi('PasskeyAssertion');

/** Options for navigator.credentials.get/create, in the WebAuthn JSON form. */
export const WebAuthnOptionsSchema = z.record(z.string(), z.unknown()).openapi('WebAuthnOptions');

// ---------------------------------------------------------------------------------------------
// Settings → Security

export const PasskeySchema = z
  .object({
    id: id('passkey'),
    name: z.string(),
    backedUp: z.boolean(),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
  })
  .openapi('Passkey');
export type Passkey = z.infer<typeof PasskeySchema>;

const PasskeyNameSchema = z.string().trim().min(1, 'Enter a name.').max(80);

export const RegisterPasskeySchema = z
  .object({ response: webauthnJson, name: PasskeyNameSchema })
  .openapi('RegisterPasskey');

export const RenamePasskeySchema = z.object({ name: PasskeyNameSchema }).openapi('RenamePasskey');

/**
 * One of the operator's own account security events, with the network prefix and browser it came
 * from. Only the operator sees these; workspace audit logs get the action, method and time only.
 */
const AccountEventSchema = z
  .object({
    action: z.string().openapi({ example: 'operator.signed_in' }),
    method: z.string().nullable().openapi({ example: 'quickpass' }),
    ipPrefix: z.string().nullable(),
    userAgent: z.string().nullable(),
    at: timestamp,
  })
  .openapi('AccountEvent');
export type AccountEvent = z.infer<typeof AccountEventSchema>;

export const SecurityOverviewSchema = z
  .object({
    passkeys: z.array(PasskeySchema),
    totp: z.object({ enabled: z.boolean(), confirmedAt: timestamp.nullable() }),
    recoveryCodes: z.object({ remaining: z.number().int(), createdAt: timestamp.nullable() }),
    secondFactor: SecondFactorStatusSchema,
    /** The operator's own recent account events, newest first. */
    activity: z.array(AccountEventSchema),
  })
  .openapi('SecurityOverview');
export type SecurityOverview = z.infer<typeof SecurityOverviewSchema>;

export const TotpEnrollmentSchema = z
  .object({
    /** Base32, for typing into an app that cannot scan. */
    secret: z.string(),
    /** otpauth:// URI; the dashboard draws it as a QR code in the browser. */
    uri: z.string(),
  })
  .openapi('TotpEnrollment');
export type TotpEnrollment = z.infer<typeof TotpEnrollmentSchema>;

/** Shown once. Null when the operator already had a second factor (their codes are unchanged). */
export const FactorAddedSchema = z
  .object({ recoveryCodes: z.array(z.string()).nullable() })
  .openapi('FactorAdded');
export type FactorAdded = z.infer<typeof FactorAddedSchema>;

export const RecoveryCodesSchema = z
  .object({ recoveryCodes: z.array(z.string()) })
  .openapi('RecoveryCodes');

export const SignOutEverywhereSchema = z
  .object({ keepCurrent: z.boolean().default(true) })
  .openapi('SignOutEverywhere');

export const SignOutEverywhereResultSchema = z
  .object({ revoked: z.number().int() })
  .openapi('SignOutEverywhereResult');

const Require2faSchema = z.enum(REQUIRE_2FA_OPTIONS).openapi('Require2fa');
export type Require2fa = z.infer<typeof Require2faSchema>;

export const WorkspaceSecuritySchema = z
  .object({
    require2fa: Require2faSchema,
    /** Seats that must use a second factor under this policy and have none yet. */
    seatsWithoutSecondFactor: z.number().int().nullable(),
  })
  .openapi('WorkspaceSecurity');
export type WorkspaceSecurity = z.infer<typeof WorkspaceSecuritySchema>;

export const UpdateWorkspaceSecuritySchema = z
  .object({ require2fa: Require2faSchema })
  .openapi('UpdateWorkspaceSecurity');

// ---------------------------------------------------------------------------------------------
// SSO connections (Pro and up)

const SSO_PROTOCOLS = ['oidc', 'saml'] as const;
const SSO_STATUSES = ['draft', 'active', 'disabled'] as const;
const SSO_JIT_ROLES = ['admin', 'editor', 'author', 'viewer'] as const;
/** TXT record proving control of a domain: `_swarm-sso.<domain>` = `swarm-sso=<token>`. */
export const SSO_TXT_PREFIX = '_swarm-sso';
export const SSO_TXT_VALUE_PREFIX = 'swarm-sso=';
export const SSO_MAX_DOMAINS = 20;
/** A verified domain's TXT record is looked up again at sign-in once its last check is this old. */
export const SSO_DOMAIN_RECHECK_HOURS = 24;
/** A proof whose record has been missing this long lapses: the domain stops capturing sign-in and
 *  another workspace may prove it. Admins are warned when it first goes missing. Owner-tunable. */
export const SSO_DOMAIN_LAPSE_DAYS = 7;
/** For this long after a workspace releases a proven domain, proving it again there for another
 *  identity provider needs an owner. Owner-tunable. */
export const SSO_RELEASED_DOMAIN_DAYS = 30;

/** A lowercased hostname with at least one dot; no wildcards, ports or trailing dot. */
const SsoDomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .max(253)
      .regex(
        /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        'Enter a domain such as example.com.',
      ),
  );

export const SsoDomainSchema = z
  .object({
    id: id('ssoDomain'),
    domain: z.string(),
    verified: z.boolean(),
    verifiedAt: timestamp.nullable(),
    /** Publish this TXT record, then verify. */
    txtName: z.string(),
    txtValue: z.string(),
  })
  .openapi('SsoDomain');
export type SsoDomain = z.infer<typeof SsoDomainSchema>;

export const SsoConnectionSchema = z
  .object({
    id: id('ssoConnection'),
    protocol: z.enum(SSO_PROTOCOLS),
    issuer: z.string(),
    clientId: z.string(),
    clientSecretSet: z.boolean(),
    domains: z.array(SsoDomainSchema),
    jitRole: z.enum(SSO_JIT_ROLES).nullable(),
    enforced: z.boolean(),
    status: z.enum(SSO_STATUSES),
    /** Where the identity provider must send people back to. */
    redirectUri: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('SsoConnection');
export type SsoConnection = z.infer<typeof SsoConnectionSchema>;

const issuerUrl = z
  .string()
  .trim()
  .max(500)
  .pipe(
    z.url({ protocol: /^https?$/, error: 'Enter the issuer URL from your identity provider.' }),
  );

export const CreateSsoConnectionSchema = z
  .object({
    protocol: z.enum(SSO_PROTOCOLS).default('oidc'),
    issuer: issuerUrl,
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().min(1).max(500),
    jitRole: z.enum(SSO_JIT_ROLES).nullable().default(null),
  })
  .openapi('CreateSsoConnection');

export const UpdateSsoConnectionSchema = z
  .object({
    issuer: issuerUrl.optional(),
    clientId: z.string().trim().min(1).max(300).optional(),
    clientSecret: z.string().min(1).max(500).optional(),
    jitRole: z.enum(SSO_JIT_ROLES).nullable().optional(),
    enforced: z.boolean().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSsoConnection');

export const AddSsoDomainSchema = z.object({ domain: SsoDomainNameSchema }).openapi('AddSsoDomain');

/**
 * Incident response: pause every outbound feed of a workspace at once (export destinations and
 * webhook endpoints), optionally revoking every API key and app grant too. Each feed is then
 * resumed one by one.
 */
export const PauseFeedsSchema = z
  .object({
    revokeApiKeys: z.boolean().default(false),
    revokeApps: z.boolean().default(false),
  })
  .openapi('PauseFeeds');
export type PauseFeeds = z.infer<typeof PauseFeedsSchema>;

const PausedFeedSchema = z.object({
  kind: z.enum(['export_destination', 'webhook_endpoint']),
  id: z.string(),
  /** Where it sent data: the bucket or the URL. */
  target: z.string(),
  channelId: z.string().nullable(),
});

export const PausedFeedsSchema = z
  .object({
    /** Every feed this paused, with where it pointed. Already paused or turned-off ones are left. */
    paused: z.array(PausedFeedSchema),
    apiKeysRevoked: z.number().int(),
    appsRevoked: z.number().int(),
  })
  .openapi('PausedFeeds');
export type PausedFeeds = z.infer<typeof PausedFeedsSchema>;

/** How long the "This wasn't me" link in the first-factor mail works. */
export const FIRST_FACTOR_UNDO_DAYS = 7;

export const UndoFirstFactorSchema = z
  .object({ token: z.string().min(20).max(100) })
  .openapi('UndoFirstFactor');

export const FirstFactorUndoneSchema = z
  .object({
    passkeysRemoved: z.number().int(),
    authenticatorRemoved: z.boolean(),
    sessionsEnded: z.number().int(),
  })
  .openapi('FirstFactorUndone');
export type FirstFactorUndone = z.infer<typeof FirstFactorUndoneSchema>;
