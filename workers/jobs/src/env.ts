import {
  AudienceEnvFields,
  DebounceEnvFields,
  DnsEnvFields,
  LinkEnvFields,
  MailEnvFields,
  PaymentsEnvFields,
  SiteOriginEnvFields,
  WebHostingEnvFields,
  checkDebounceEnv,
  checkDnsEnv,
  checkLinkEnv,
  checkMailEnv,
  checkPaymentsEnv,
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
import { z } from 'zod';

const JobsEnvSchema = BaseEnvSchema.extend({
  DB: binding<D1Database>(),
  CACHE: binding<KVNamespace>(),
  JOBS_QUEUE: binding<Queue<JobMessage>>(),
  /** Flow emails are handed to the send worker as 'batch' messages (Phase 6). */
  SEND_QUEUE: binding<Queue<SendMessage>>(),
  /** Event Webhooks (Phase 7): one message per delivery attempt; produced and consumed here. */
  WEBHOOKS_QUEUE: binding<Queue<WebhookMessage>>(),
  /** Uploaded media (images, goods' PDFs): only a deleted publication's purge deletes here. */
  MEDIA: binding<R2Bucket>(),
  /** Uploaded import files (private). */
  IMPORTS: binding<R2Bucket>(),
  /** Finished exports (private), downloaded through signed URLs. */
  EXPORTS: binding<R2Bucket>(),
  CAPTURE_ORIGIN: AudienceEnvFields.CAPTURE_ORIGIN,
  /**
   * The vault (workers/vault, JobsVault): encrypted fields of exports, imports, bulk edits and
   * Flows, data requests, webhook signatures, export destinations, PayPal and own Stripe keys.
   * FIELD_KEYS itself is refused here.
   */
  ...vaultEnvFields<'jobs'>(),
  ...LinkEnvFields,
  /**
   * Link keys (docs/security.md "Keys"): Member Center links in its mail (sunset notices,
   * Champions awards), data download links, and new sponsor report links after the cutover.
   */
  ...linkKeyFields('MEMBER_SIGNING_KEYS', 'DSR_EXPORT_SIGNING_KEYS', 'SPONSOR_REPORT_SIGNING_KEYS'),
  /** Pending web hostnames are re-checked on the cron. */
  ...WebHostingEnvFields,
  /** Scheduled price changes move subscriptions on Stripe (STRIPE_SECRET_KEY only). */
  ...PaymentsEnvFields,
  /** Flows (Phase 6) operator notices and Champions award emails go out by mail. */
  ...MailEnvFields,
  /** Notices come from notifications@<this domain>. */
  PLATFORM_MAIL_DOMAIN: z.string().min(3),
  /** Feed Sync (Phase 8): public media origin, for the stored preview of Dispatches it makes. */
  MEDIA_ORIGIN: z.url(),
  /** Gift Pass reminders link to the Channel's site (its plans page and claim links). */
  ...SiteOriginEnvFields,
  /**
   * The dashboard, linked from Reputation Ramp pause notices. Email checks also hand DeBounce
   * this origin's /api/v1/public/email-check-lists/… addresses (served by the api worker).
   */
  APP_ORIGIN: z.url(),
  /** Email checks (flag email_verification): bulk runs, import checks, background checks. */
  ...DebounceEnvFields,
  /** Verified SSO domains are re-checked every day (engine sso-domains.ts), as the api does. */
  ...DnsEnvFields,
}).superRefine((env, ctx) => {
  checkVaultEnv(env, ctx);
  checkLinkEnv(env, ctx, { signs: true });
  checkDebounceEnv(env, ctx);
  checkDnsEnv(env, ctx);
  checkMailEnv(env, ctx);
  checkSiteOriginEnv(env, ctx);
  checkWebHostingEnv(env, ctx);
  checkPaymentsEnv(env, ctx);
});

export type JobsEnv = z.infer<typeof JobsEnvSchema>;

const parseJobsEnvSchema = defineEnv(JobsEnvSchema);

/**
 * Parses the env, and points the outbound URL guard at this install's own hosts, so no
 * tenant-chosen address can be one of them (security review S02-P3-T-platform-host-egress).
 */
export const parseJobsEnv = (raw: unknown): JobsEnv => {
  const env = parseJobsEnvSchema(raw);
  setOutboundPlatformHosts(platformHostsFromEnv(raw));
  return env;
};
