import {
  AudienceEnvFields,
  CopilotEnvFields,
  DebounceEnvFields,
  DedicatedEnvFields,
  EngineEnvFields,
  LinkEnvFields,
  PaymentsEnvFields,
  ProviderEnvFields,
  SiteOriginEnvFields,
  WebHostingEnvFields,
  checkCopilotEnv,
  checkDebounceEnv,
  checkDedicatedEnv,
  checkLinkEnv,
  checkPaymentsEnv,
  checkProviderEnv,
  checkSiteOriginEnv,
  checkWebHostingEnv,
  linkKeyFields,
  platformHostsFromEnv,
  setOutboundPlatformHosts,
  type JobMessage,
  type SendMessage,
  type WebhookMessage,
} from '@swarm/engine';
import { BaseEnvSchema, binding, defineEnv } from '@swarm/runtime';
import { checkVaultEnv, vaultEnvFields } from '@swarm/vault';
import { parseKeyring, type Keyring } from '@swarm/tokens';
import { z } from 'zod';

const keyring = z.string().transform((value, ctx): Keyring => {
  try {
    return parseKeyring(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

export const ApiEnvSchema = BaseEnvSchema.extend({
  /** Dashboard origin. CSRF checks, cookies and every link in email use it. */
  APP_ORIGIN: z.url(),
  /** Origin that serves public media (the site worker's /media route). */
  MEDIA_ORIGIN: z.url(),
  DB: binding<D1Database>(),
  CACHE: binding<KVNamespace>(),
  MEDIA: binding<R2Bucket>(),
  QUICKPASS_LIMITER: binding<RateLimit>(),
  /** Signs short-lived cookies (OAuth state). Format: kid:secret[,kid:secret]. */
  AUTH_KEYS: keyring,
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  /** From address of sign-in and invite mail. */
  MAIL_FROM: z.email(),
  SEND_QUEUE: binding<Queue<SendMessage>>(),
  /** The realtime worker's SendMonitor. Optional: without it the dashboard polls. */
  SEND_MONITOR: binding<DurableObjectNamespace>().optional(),
  /**
   * The realtime worker's ApiRateLimiter: /v2 token buckets. Required outside development; a
   * local `wrangler dev` without the realtime worker serves /v2 unlimited.
   */
  API_RATE_LIMITER: binding<DurableObjectNamespace>().optional(),
  /** Limits test sends per operator. */
  TEST_SEND_LIMITER: binding<RateLimit>(),
  JOBS_QUEUE: binding<Queue<JobMessage>>(),
  /** Event Webhooks (Phase 7): test events and redrives; the jobs worker consumes it. */
  WEBHOOKS_QUEUE: binding<Queue<WebhookMessage>>(),
  /** Uploaded import files (private). */
  IMPORTS: binding<R2Bucket>(),
  /** Finished exports (private), downloaded through signed URLs. */
  EXPORTS: binding<R2Bucket>(),
  TRACK_ORIGIN: EngineEnvFields.TRACK_ORIGIN,
  PLATFORM_MAIL_DOMAIN: EngineEnvFields.PLATFORM_MAIL_DOMAIN,
  UNSUBSCRIBE_MAIL_DOMAIN: EngineEnvFields.UNSUBSCRIBE_MAIL_DOMAIN,
  /**
   * Unsubscribe codes in Direct Sends. The api holds neither TRACK_KEYS nor BOUNCE_KEYS: it signs
   * no click, open or bounce code.
   */
  UNSUBSCRIBE_KEYS: EngineEnvFields.UNSUBSCRIBE_KEYS,
  CAPTURE_ORIGIN: AudienceEnvFields.CAPTURE_ORIGIN,
  /**
   * The vault (workers/vault, ApiVault): encrypted fields, every sealed secret (TOTP, SSO,
   * webhook, export, Copilot, application, Stripe and PayPal keys), data request addresses, and
   * Member Center and goods links. It is handed the request's own credential. FIELD_KEYS itself
   * is refused here.
   */
  ...vaultEnvFields<'api'>(),
  ...LinkEnvFields,
  /**
   * Link keys (docs/security.md "Keys"). Signs: confirmations an operator sends (CONFIRM_KEYS),
   * sponsor reports and design previews for the site. Member Center and goods links come from the
   * vault. Verifies the site's Checkout references with public keys only.
   */
  ...linkKeyFields(
    'CONFIRM_KEYS',
    'CHECKOUT_VERIFY_KEYS',
    'SITE_LINK_SIGNING_KEYS',
    'SPONSOR_REPORT_SIGNING_KEYS',
  ),
  ...ProviderEnvFields,
  /** Channel websites: web addresses of Dispatches and pages. */
  ...SiteOriginEnvFields,
  /** Custom web domains (Cloudflare for SaaS custom hostnames). */
  ...WebHostingEnvFields,
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** Membership levels: Stripe Connect, the webhook and the dev fake (see docs/deployment.md). */
  ...PaymentsEnvFields,
  /**
   * SES configuration set for the Direct Send API, separate from Broadcasts and sign-in mail.
   * Only with MAIL_ADAPTER=ses (Resend has no configuration sets).
   */
  SES_DIRECT_CONFIGURATION_SET: z.string().min(1).optional(),
  /** Deliverability Center: the domain whose Email Routing receives dmarc+<id>@ reports. */
  DMARC_MAIL_DOMAIN: z.string().min(3),
  /** Paid Channels' own configuration sets and dedicated IP pools. */
  ...DedicatedEnvFields,
  /** Copilot (Phase 8): adapter, model id and the optional platform key (docs/copilot.md). */
  ...CopilotEnvFields,
  /** Email checks (flag email_verification): the install's DeBounce key (docs/email-verification.md). */
  ...DebounceEnvFields,
}).superRefine((env, ctx) => {
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  checkVaultEnv(env, ctx);
  checkLinkEnv(env, ctx, { signs: true });
  checkDebounceEnv(env, ctx);
  checkProviderEnv(env, ctx);
  checkDedicatedEnv(env, ctx);
  checkCopilotEnv(env, ctx);
  checkSiteOriginEnv(env, ctx);
  checkWebHostingEnv(env, ctx);
  checkPaymentsEnv(env, ctx, { webhook: true, connect: true });
  if (env.MAIL_ADAPTER === 'ses' && !env.SES_DIRECT_CONFIGURATION_SET) {
    ctx.addIssue({
      code: 'custom',
      path: ['SES_DIRECT_CONFIGURATION_SET'],
      message: 'required when MAIL_ADAPTER is "ses"',
    });
  }
  if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_CLIENT_SECRET'],
      message: 'set both Google credentials or neither',
    });
  }
  if (env.ENVIRONMENT !== 'development' && !env.API_RATE_LIMITER) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_RATE_LIMITER'],
      message: 'the /v2 rate limiter is required outside development',
    });
  }
  if (!local && !env.APP_ORIGIN.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_ORIGIN'],
      message: 'must be https outside development',
    });
  }
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

const parseApiEnvSchema = defineEnv(ApiEnvSchema);

/**
 * Parses the env, and points the outbound URL guard at this install's own hosts, so no
 * tenant-chosen address can be one of them (security review S02-P3-T-platform-host-egress).
 */
export const parseApiEnv = (raw: unknown): ApiEnv => {
  const env = parseApiEnvSchema(raw);
  setOutboundPlatformHosts(platformHostsFromEnv(raw));
  return env;
};

export const isLocal = (env: ApiEnv) =>
  env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
