import type { ApiRateLimiter, RateLimiter, SendMonitor, SendPacer } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      SEND_MONITOR: DurableObjectNamespace<SendMonitor>;
      RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
      API_RATE_LIMITER: DurableObjectNamespace<ApiRateLimiter>;
      SEND_PACER: DurableObjectNamespace<SendPacer>;
    }
  }
}
