import {
  AudienceEnvFields,
  EngineEnvFields,
  PaymentsEnvFields,
  ProviderEnvFields,
  SiteOriginEnvFields,
  LinkEnvFields,
  checkLinkEnv,
  checkPaymentsEnv,
  checkProviderEnv,
  checkSiteOriginEnv,
  linkKeyFields,
  type PublicMessage,
  type SiteOriginConfig,
} from '@swarm/engine';
import { BaseEnvSchema, binding, defineEnv } from '@swarm/runtime';
import { checkVaultEnv, vaultEnvFields } from '@swarm/vault';
import { z } from 'zod';

/** Cloudflare's published Turnstile test keys: fine locally, refused anywhere else. */
const TEST_TURNSTILE = /^[123]x0{20,}A{1,2}$/;

const CaptureEnvSchema = BaseEnvSchema.extend({
  DB: binding<D1Database>(),
  /** The realtime worker's RateLimiter (sliding windows per IP, per form, per address). */
  RATE_LIMITER: binding<DurableObjectNamespace>(),
  /**
   * The public queue, the only one this worker can write to: Circles re-evaluate when a sign-up,
   * confirmation or Member Center action changes a Member, and a confirmed signup is checked.
   */
  PUBLIC_QUEUE: binding<Queue<PublicMessage>>(),
  /** Finished exports (private): the Privacy Center download page streams a Member's file. */
  EXPORTS: binding<R2Bucket>(),
  /** Shared From domain, for Channels whose own sending domain can't send. */
  PLATFORM_MAIL_DOMAIN: EngineEnvFields.PLATFORM_MAIL_DOMAIN,
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  CAPTURE_ORIGIN: AudienceEnvFields.CAPTURE_ORIGIN,
  /**
   * The vault (workers/vault, CaptureVault): encrypted fields, data request addresses, signup and
   * journey tokens, Member Center links, and the Stripe, PayPal and DeBounce keys, all used there.
   * FIELD_KEYS itself is refused here.
   */
  ...vaultEnvFields<'capture'>(),
  ...LinkEnvFields,
  /**
   * Link keys (docs/security.md "Keys"). Signs: confirm and leave links (CONFIRM_KEYS), its own
   * challenge, reference and privacy confirmations (CAPTURE_KEYS), form stamps and ask pages.
   * Verifies with public keys only: Member Center, one-tap ask and data download links. Signup,
   * journey and Member Center links are the vault's.
   */
  ...linkKeyFields(
    'CONFIRM_KEYS',
    'CAPTURE_KEYS',
    'FORM_STAMP_KEYS',
    'MEMBER_VERIFY_KEYS',
    'ASK_VERIFY_KEYS',
    'ASK_PAGE_SIGNING_KEYS',
    'DSR_EXPORT_VERIFY_KEYS',
  ),
  ...ProviderEnvFields,
  /**
   * Member Center billing: cancel, resume, change level, payment method, invoices. Only the mode:
   * Stripe calls go through the vault, which holds the platform and own keys.
   */
  PAYMENTS: PaymentsEnvFields.PAYMENTS,
  /** Champions share links in the Member Center point at the Channel's site. */
  ...SiteOriginEnvFields,
  // Email checks (flag email_verification): a signup is checked with DeBounce through the vault,
  // which holds the key.
}).superRefine((env, ctx) => {
  checkVaultEnv(env, ctx);
  checkLinkEnv(env, ctx, { signs: true });
  checkProviderEnv(env, ctx);
  checkSiteOriginEnv(env, ctx);
  // No key here: the vault attaches it.
  checkPaymentsEnv(env, ctx, { viaVault: true });
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (local) return;
  if (!env.CAPTURE_ORIGIN.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['CAPTURE_ORIGIN'], message: 'must be https' });
  }
  for (const key of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'] as const) {
    if (TEST_TURNSTILE.test(env[key])) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'test keys only work locally' });
    }
  }
});

export type CaptureEnv = z.infer<typeof CaptureEnvSchema>;

export const parseCaptureEnv = defineEnv(CaptureEnvSchema);

export const isLocal = (env: CaptureEnv) =>
  env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';

/** Where Channel websites live, when configured. */
export const siteOriginConfig = (env: CaptureEnv): SiteOriginConfig | null =>
  env.PLATFORM_SITE_DOMAIN && env.SITE_SCHEME
    ? { platformDomain: env.PLATFORM_SITE_DOMAIN, scheme: env.SITE_SCHEME }
    : null;

/** The capture origin without a trailing slash. */
export const originOf = (env: CaptureEnv) => env.CAPTURE_ORIGIN.replace(/\/$/, '');
