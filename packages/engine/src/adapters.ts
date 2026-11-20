/**
 * Picks the provider implementations from a worker's env. Shared by every worker that sends or
 * verifies domains, so the fail-closed rules live in one place:
 * - MAIL_ADAPTER=dev, DNS_RESOLVER=dev and LINK_HOSTNAMES=dev only in development and test;
 * - MAIL_ADAPTER=ses needs a region, both credentials and a configuration set;
 * - MAIL_ADAPTER=resend needs RESEND_API_KEY, and AWS_REGION names the Resend region new
 *   domains are created in (us-east-1, eu-west-1, sa-east-1 or ap-northeast-1);
 * - MAIL_ADAPTER=mailgun needs MAILGUN_API_KEY and MAILGUN_REGION (us or eu);
 * - MAIL_ADAPTER=postmark needs POSTMARK_SERVER_TOKEN and POSTMARK_ACCOUNT_TOKEN;
 * - MAIL_ADAPTER=smtp needs SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD and
 *   SMTP_DKIM_SELECTOR;
 * - dedicated sending (Phase 7) follows MAIL_ADAPTER: the recording fake with "dev", SES with
 *   "ses", which then also needs SES_EVENT_TOPIC_ARN for new configuration sets, and nothing
 *   with the other services (Swarm can't use configuration sets or dedicated IPs there);
 * - the provider suppression list follows MAIL_ADAPTER the same way (in-memory with "dev");
 * - mail outside the send pipeline takes its turn from the install's sending limits when the
 *   worker binds SEND_PACER (mailAdapter); the pipeline uses providerMail and paces itself.
 */
import {
  DevDedicatedSending,
  DevDomainIdentities,
  DevMailbox,
  DevSuppressionList,
  MAILGUN_REGIONS,
  MailgunClient,
  MailgunMail,
  PostmarkClient,
  PostmarkMail,
  RESEND_REGIONS,
  ResendClient,
  ResendMail,
  SmtpClient,
  SmtpDomains,
  SmtpMail,
  SesClient,
  SesMail,
  isResendRegion,
  dohLookup,
  type DedicatedSending,
  type DnsLookup,
  type DomainIdentities,
  type MailAdapter,
  type SesAccount,
  type SmtpConnect,
  type SuppressionList,
} from '@swarm/mail';
import { z } from 'zod';
import {
  CloudflareHostnames,
  DevDnsLookup,
  DevHostnames,
  DevResolver,
  DohResolver,
  type LinkHostnames,
  type TxtResolver,
} from './domains';
import { LimitedMail, limiterOf, loadSendingLimits, type MailLimiter } from './sending-limits';

const r2 = z.custom<R2Bucket>((v) => typeof v === 'object' && v !== null, 'binding is missing');
const durableObjects = z.custom<DurableObjectNamespace>(
  (v) => typeof v === 'object' && v !== null,
  'binding is missing',
);

/** Just enough to send mail (the jobs worker's operator notices use only this). */
export const MailEnvFields = {
  MAIL_ADAPTER: z.enum(['ses', 'resend', 'mailgun', 'postmark', 'smtp', 'dev']),
  DEV_MAILBOX: r2.optional(),
  /**
   * The realtime worker's SendPacer, which holds the install's sending limits. Every worker that
   * sends mail binds it, so the limits hold for all of its mail together. Optional: without it
   * this worker's mail is not counted or limited (a local `wrangler dev` without realtime).
   */
  SEND_PACER: durableObjects.optional(),
  /**
   * SES region; also shown in MAIL FROM records, so development sets one too. With Resend, the
   * region new domains are created in.
   */
  AWS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  AWS_ACCESS_KEY_ID: z.string().min(16).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(32).optional(),
  SES_CONFIGURATION_SET: z.string().min(1).optional(),
  /** Resend API key (a secret); required with MAIL_ADAPTER=resend. */
  RESEND_API_KEY: z
    .string()
    .regex(/^re_[A-Za-z0-9_-]{8,}$/, 'a Resend API key starts with re_')
    .optional(),
  /** The Mailgun account's primary API key (a secret); required with MAIL_ADAPTER=mailgun. */
  MAILGUN_API_KEY: z.string().min(16).optional(),
  MAILGUN_REGION: z.enum(MAILGUN_REGIONS).optional(),
  /** Sends through the Postmark server (a secret); required with MAIL_ADAPTER=postmark. */
  POSTMARK_SERVER_TOKEN: z.string().min(16).optional(),
  /** Manages sending domains (a secret); required with MAIL_ADAPTER=postmark. */
  POSTMARK_ACCOUNT_TOKEN: z.string().min(16).optional(),
  /** A person's own mail server; all five are required with MAIL_ADAPTER=smtp. */
  SMTP_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/, 'a hostname such as mail.example.com')
    .optional(),
  /** 465 uses TLS from the start, and any other port needs STARTTLS. Cloudflare blocks 25. */
  SMTP_PORT: z
    .string()
    .regex(/^(?!25$)[1-9]\d{0,4}$/, 'a port such as 465 or 587; Cloudflare blocks port 25')
    .optional(),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** The selector of the DKIM record that the mail server signs with. */
  SMTP_DKIM_SELECTOR: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
};

/** DNS lookups only (the jobs worker's daily SSO domain re-check): DoH, or the dev double. */
export const DnsEnvFields = {
  DNS_RESOLVER: z.enum(['doh', 'dev']),
};

export const ProviderEnvFields = {
  ...MailEnvFields,
  ...DnsEnvFields,
  LINK_HOSTNAMES: z.enum(['cloudflare', 'dev', 'off']),
  CF_ZONE_ID: z.string().min(1).optional(),
  CF_API_TOKEN: z.string().min(1).optional(),
};

/** Dedicated sending (Phase 7): the api and send workers create Channels' configuration sets. */
export const DedicatedEnvFields = {
  /** SNS topic that new configuration sets publish SES events to (one of SNS_TOPIC_ARNS). */
  SES_EVENT_TOPIC_ARN: z
    .string()
    .regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/)
    .optional(),
};

export interface MailEnv {
  ENVIRONMENT: string;
  MAIL_ADAPTER: 'ses' | 'resend' | 'mailgun' | 'postmark' | 'smtp' | 'dev';
  DEV_MAILBOX?: R2Bucket | undefined;
  /** With DB, every email takes its turn from the install's sending limits (sending-limits.ts). */
  SEND_PACER?: DurableObjectNamespace | undefined;
  DB?: D1Database;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string | undefined;
  AWS_SECRET_ACCESS_KEY?: string | undefined;
  SES_CONFIGURATION_SET?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  MAILGUN_API_KEY?: string | undefined;
  MAILGUN_REGION?: 'us' | 'eu' | undefined;
  POSTMARK_SERVER_TOKEN?: string | undefined;
  POSTMARK_ACCOUNT_TOKEN?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
  SMTP_USERNAME?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  SMTP_DKIM_SELECTOR?: string | undefined;
}

export interface ProviderEnv extends MailEnv {
  DNS_RESOLVER: 'doh' | 'dev';
  LINK_HOSTNAMES: 'cloudflare' | 'dev' | 'off';
  CF_ZONE_ID?: string | undefined;
  CF_API_TOKEN?: string | undefined;
}

const isLocal = (env: { ENVIRONMENT: string }) =>
  env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';

/** Use inside a worker env schema's superRefine (workers that only send mail). */
export function checkMailEnv(env: MailEnv, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const local = isLocal(env);
  if (env.MAIL_ADAPTER === 'dev') {
    if (!local) issue('MAIL_ADAPTER', 'the dev mailbox is only allowed in development and test');
    if (!env.DEV_MAILBOX) issue('DEV_MAILBOX', 'required when MAIL_ADAPTER is "dev"');
  } else if (env.MAIL_ADAPTER === 'resend') {
    if (!env.RESEND_API_KEY) issue('RESEND_API_KEY', 'required when MAIL_ADAPTER is "resend"');
    if (!isResendRegion(env.AWS_REGION)) {
      issue('AWS_REGION', `with MAIL_ADAPTER "resend", one of ${RESEND_REGIONS.join(', ')}`);
    }
  } else if (env.MAIL_ADAPTER === 'mailgun') {
    if (!env.MAILGUN_API_KEY) issue('MAILGUN_API_KEY', 'required when MAIL_ADAPTER is "mailgun"');
    if (!env.MAILGUN_REGION) issue('MAILGUN_REGION', 'required when MAIL_ADAPTER is "mailgun"');
  } else if (env.MAIL_ADAPTER === 'postmark') {
    for (const key of ['POSTMARK_SERVER_TOKEN', 'POSTMARK_ACCOUNT_TOKEN'] as const) {
      if (!env[key]) issue(key, 'required when MAIL_ADAPTER is "postmark"');
    }
  } else if (env.MAIL_ADAPTER === 'smtp') {
    for (const key of [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
      'SMTP_DKIM_SELECTOR',
    ] as const) {
      if (!env[key]) issue(key, 'required when MAIL_ADAPTER is "smtp"');
    }
  } else {
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'SES_CONFIGURATION_SET',
    ] as const) {
      if (!env[key]) issue(key, 'required when MAIL_ADAPTER is "ses"');
    }
  }
}

/** Use inside a worker env schema's superRefine (workers that create configuration sets). */
export function checkDedicatedEnv(
  env: MailEnv & { SES_EVENT_TOPIC_ARN?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (env.MAIL_ADAPTER === 'ses' && !env.SES_EVENT_TOPIC_ARN) {
    ctx.addIssue({
      code: 'custom',
      path: ['SES_EVENT_TOPIC_ARN'],
      message: 'required when MAIL_ADAPTER is "ses"',
    });
  }
}

/** Use inside a worker env schema's superRefine (workers with DnsEnvFields only). */
export function checkDnsEnv(
  env: { ENVIRONMENT: string; DNS_RESOLVER: 'doh' | 'dev' },
  ctx: z.RefinementCtx,
): void {
  if (env.DNS_RESOLVER === 'dev' && !isLocal(env)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DNS_RESOLVER'],
      message: 'the dev resolver is only allowed in development and test',
    });
  }
}

/** Use inside a worker env schema's superRefine. */
export function checkProviderEnv(env: ProviderEnv, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const local = isLocal(env);
  checkMailEnv(env, ctx);
  if (env.DNS_RESOLVER === 'dev' && !local) {
    issue('DNS_RESOLVER', 'the dev resolver is only allowed in development and test');
  }
  if (env.LINK_HOSTNAMES === 'dev' && !local) {
    issue('LINK_HOSTNAMES', 'dev hostnames are only allowed in development and test');
  }
  if (env.LINK_HOSTNAMES === 'cloudflare' && (!env.CF_ZONE_ID || !env.CF_API_TOKEN)) {
    issue('CF_API_TOKEN', 'CF_ZONE_ID and CF_API_TOKEN are required for Cloudflare hostnames');
  }
}

function sesClient(env: MailEnv & { SES_EVENT_TOPIC_ARN?: string | undefined }): SesClient {
  return new SesClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    },
    configurationSet: env.SES_CONFIGURATION_SET as string,
    ...(env.SES_EVENT_TOPIC_ARN ? { eventTopicArn: env.SES_EVENT_TOPIC_ARN } : {}),
  });
}

function resendClient(env: MailEnv): ResendClient {
  return new ResendClient({ apiKey: env.RESEND_API_KEY as string, region: env.AWS_REGION });
}

function mailgunClient(env: MailEnv): MailgunClient {
  return new MailgunClient({
    apiKey: env.MAILGUN_API_KEY as string,
    region: env.MAILGUN_REGION as 'us' | 'eu',
  });
}

function postmarkClient(env: MailEnv): PostmarkClient {
  return new PostmarkClient({
    serverToken: env.POSTMARK_SERVER_TOKEN as string,
    accountToken: env.POSTMARK_ACCOUNT_TOKEN as string,
  });
}

/** Imported when first used, because `cloudflare:sockets` only exists inside Workers. */
const workerConnect: SmtpConnect = async (address, options) => {
  const { connect } = await import('cloudflare:sockets');
  return connect(address, options) as unknown as Awaited<ReturnType<SmtpConnect>>;
};

function smtpClient(env: MailEnv, heloName: string): SmtpClient {
  return new SmtpClient({
    host: env.SMTP_HOST as string,
    port: Number(env.SMTP_PORT),
    username: env.SMTP_USERNAME as string,
    password: env.SMTP_PASSWORD as string,
    connect: workerConnect,
    heloName,
  });
}

/**
 * The provider's own adapter, with no sending limits. The send pipeline takes its turns itself;
 * everything else uses `mailAdapter`. The env schema guarantees the bindings and secrets.
 */
export function providerMail(env: MailEnv, messageIdDomain: string): MailAdapter {
  if (env.MAIL_ADAPTER === 'dev') return new DevMailbox(env.DEV_MAILBOX as R2Bucket);
  if (env.MAIL_ADAPTER === 'resend') return new ResendMail(resendClient(env), messageIdDomain);
  if (env.MAIL_ADAPTER === 'mailgun') return new MailgunMail(mailgunClient(env), messageIdDomain);
  if (env.MAIL_ADAPTER === 'postmark')
    return new PostmarkMail(postmarkClient(env), messageIdDomain);
  if (env.MAIL_ADAPTER === 'smtp') {
    return new SmtpMail(smtpClient(env, messageIdDomain), messageIdDomain);
  }
  return new SesMail(sesClient(env), messageIdDomain);
}

/** The install's pacer, when this worker binds it. */
export function sendLimiter(env: Pick<MailEnv, 'SEND_PACER'>): MailLimiter | null {
  return env.SEND_PACER ? limiterOf(env.SEND_PACER) : null;
}

/**
 * The adapter for mail outside the send pipeline: sign-in links, confirmations, receipts,
 * notices. With the SEND_PACER binding each email takes a transactional turn from the install's
 * sending limits first (LimitedMail); without it, this is the provider's adapter.
 */
export function mailAdapter(
  env: MailEnv,
  messageIdDomain: string,
  log?: (message: string, fields?: Record<string, unknown>) => void,
): MailAdapter {
  const provider = providerMail(env, messageIdDomain);
  const limiter = sendLimiter(env);
  const db = env.DB;
  if (!limiter || !db) return provider;
  return new LimitedMail(provider, limiter, () => loadSendingLimits(db), log);
}

export function domainIdentities(env: MailEnv): DomainIdentities {
  if (env.MAIL_ADAPTER === 'dev') return new DevDomainIdentities();
  if (env.MAIL_ADAPTER === 'resend') return resendClient(env);
  if (env.MAIL_ADAPTER === 'mailgun') return mailgunClient(env);
  if (env.MAIL_ADAPTER === 'postmark') return postmarkClient(env);
  if (env.MAIL_ADAPTER === 'smtp') {
    const resolver = new DohResolver();
    return new SmtpDomains((name) => resolver.txt(name), env.SMTP_DKIM_SELECTOR as string);
  }
  return sesClient(env);
}

/**
 * Null when the mail provider has no dedicated sending (only SES has it). The env schema
 * (checkDedicatedEnv) guarantees the topic when this is SES.
 */
export function dedicatedSending(
  env: MailEnv & { SES_EVENT_TOPIC_ARN?: string | undefined },
): DedicatedSending | null {
  if (env.MAIL_ADAPTER === 'dev') return new DevDedicatedSending();
  return env.MAIL_ADAPTER === 'ses' ? sesClient(env) : null;
}

/**
 * The SES account-level suppression list (account-wide: every workspace shares it). Null when the
 * mail provider has no list Swarm keeps in step (only SES has one).
 */
export function suppressionList(env: MailEnv): SuppressionList | null {
  if (env.MAIL_ADAPTER === 'dev') return new DevSuppressionList();
  return env.MAIL_ADAPTER === 'ses' ? sesClient(env) : null;
}

/** The SES account's standing. Null when the mail provider isn't SES. */
export function sesAccount(env: MailEnv): { account(): Promise<SesAccount> } | null {
  return env.MAIL_ADAPTER === 'ses' ? sesClient(env) : null;
}

/** Full DNS lookups, for checking published records. */
export function dnsLookup(env: ProviderEnv): DnsLookup {
  return env.DNS_RESOLVER === 'dev' ? new DevDnsLookup() : dohLookup();
}

export function txtResolver(env: ProviderEnv): TxtResolver {
  return env.DNS_RESOLVER === 'dev' ? new DevResolver() : new DohResolver();
}

/** Null when link domains are switched off for this deployment. */
export function linkHostnames(env: ProviderEnv): LinkHostnames | null {
  if (env.LINK_HOSTNAMES === 'off') return null;
  if (env.LINK_HOSTNAMES === 'dev') return new DevHostnames();
  return new CloudflareHostnames(env.CF_ZONE_ID as string, env.CF_API_TOKEN as string);
}
