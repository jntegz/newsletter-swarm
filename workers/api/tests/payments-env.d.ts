// Bindings the Phase 5 payments tests use, on top of env.d.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      MEMBER_KEYS: string;
      LINK_LEGACY_CUTOFF: string;
      TEST_LINK_KEYS: string;
      PAYMENTS: string;
      STRIPE_WEBHOOK_SECRETS: string;
      // The Stripe test-clock suite (vitest.stripe-live.config.ts) only.
      LIVE_STRIPE_ENABLED?: string;
      LIVE_STRIPE_ACCOUNT?: string;
      STRIPE_SECRET_KEY?: string;
    }
  }
}

export {};
