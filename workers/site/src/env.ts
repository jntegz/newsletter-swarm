import {
  LinkEnvFields,
  PaymentsEnvFields,
  ProviderEnvFields,
  TEST_TURNSTILE_KEY,
  checkLinkEnv,
  checkPaymentsEnv,
  checkProviderEnv,
  linkKeyFields,
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

const SiteEnvSchema = BaseEnvSchema.extend({
  DB: binding<D1Database>(),
  /** Edge settings cache and the daily analytics salt. */
  CACHE: binding<KVNamespace>(),
  MEDIA: binding<R2Bucket>(),
  /** Channels are served at <slug>.<PLATFORM_SITE_DOMAIN>, e.g. notes.swarm.page. */
  PLATFORM_SITE_DOMAIN: z.string().min(3),
  /** "https" outside development; "http" lets local sites run on <slug>.site.localhost. */
  SITE_SCHEME: z.enum(['https', 'http']),
  MEDIA_ORIGIN: z.url(),
  /** The capture worker: subscribe posts and the Member Center. */
  CAPTURE_ORIGIN: z.url(),
  /** The dashboard, the only page allowed to frame a design preview (/_swarm/preview). */
  APP_ORIGIN: z.url(),
  /** Signs reader sign-in links and session cookies. Separate from operator and Member keys. */
  READER_KEYS: keyring,
  /** Shared From domain for reader sign-in mail. */
  PLATFORM_MAIL_DOMAIN: z.string().min(3),
  /** Page-view events, when bound. */
  ANALYTICS: binding<AnalyticsEngineDataset>().optional(),
  /**
   * Workers Rate Limiting for reader sign-in (10 a minute per client IP). Declared in every
   * environment in wrangler.jsonc; when it is missing, sign-in posts are refused outside
   * development and tests (see routes/reader.ts).
   */
  READER_LIMITER: binding<RateLimit>().optional(),
  /** Cloudflare Images, for OG cards and favicons, when bound. */
  IMAGES: binding<ImagesBinding>().optional(),
  ...LinkEnvFields,
  /**
   * Link keys (docs/security.md "Keys"). Signs: confirmations of gift and checkout sign-ups
   * (CONFIRM_KEYS), form stamps and Checkout references (the api checks them with the public
   * keys). Verifies with public keys only: survey pages (capture signs them), goods links (the
   * vault), sponsor reports (the api and jobs) and design previews (the api). Join tokens and
   * goods links are the vault's own.
   */
  ...linkKeyFields(
    'CONFIRM_KEYS',
    'FORM_STAMP_KEYS',
    'ASK_PAGE_VERIFY_KEYS',
    'GOODS_VERIFY_KEYS',
    'CHECKOUT_SIGNING_KEYS',
    'SITE_LINK_VERIFY_KEYS',
    'SPONSOR_REPORT_VERIFY_KEYS',
  ),
  /**
   * The vault (workers/vault, SiteVault): join tokens, goods links, erasure markers, and every
   * Stripe and PayPal call (the keys are used there). FIELD_KEYS itself is refused here.
   */
  ...vaultEnvFields<'site'>(),
  /** Turnstile on the plans page's checkout and pledge forms. Test keys only work locally. */
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  /**
   * Workers Rate Limiting for checkout, pledge, portal and gift posts (10 a minute per client IP).
   * Like READER_LIMITER: when it is missing, those posts are refused outside development and tests.
   */
  CHECKOUT_LIMITER: binding<RateLimit>().optional(),
  /** Only the mode: Checkout and Billing Portal sessions are created through the vault. */
  PAYMENTS: PaymentsEnvFields.PAYMENTS,
  ...ProviderEnvFields,
}).superRefine((env, ctx) => {
  checkVaultEnv(env, ctx);
  checkLinkEnv(env, ctx, { signs: true });
  checkProviderEnv(env, ctx);
  // No key here: no webhook, no Connect OAuth, and the vault attaches the Stripe key.
  checkPaymentsEnv(env, ctx, { viaVault: true });
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (!local) {
    for (const key of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'] as const) {
      if (TEST_TURNSTILE_KEY.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'test keys only work locally' });
      }
    }
  }
  if (!local && env.SITE_SCHEME !== 'https') {
    ctx.addIssue({
      code: 'custom',
      path: ['SITE_SCHEME'],
      message: 'must be https outside development',
    });
  }
});

export type SiteEnv = z.infer<typeof SiteEnvSchema>;

export const parseSiteEnv = defineEnv(SiteEnvSchema);
