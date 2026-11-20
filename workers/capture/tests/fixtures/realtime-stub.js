// Stand-in for the realtime worker in the capture tests: a fixed-window limiter with the real
// RateLimiter's interface. Tests reset it through the default export.
import { DurableObject } from 'cloudflare:workers';

export class RateLimiter extends DurableObject {
  async hit(limit, windowMs) {
    const now = Date.now();
    const state = (await this.ctx.storage.get('w')) ?? { start: now, count: 0 };
    if (now - state.start >= windowMs) {
      state.start = now;
      state.count = 0;
    }
    if (state.count + 1 > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((state.start + windowMs - now) / 1000)),
      };
    }
    state.count += 1;
    await this.ctx.storage.put('w', state);
    return { allowed: true, remaining: limit - state.count, retryAfterSeconds: 0 };
  }
}

// The install's sending limits: grants every turn; the real arithmetic is tested in
// workers/realtime.
export class SendPacer extends DurableObject {
  turn({ count }) {
    return { granted: count, startInMs: 0, retryAfterSeconds: 0, limit: null, resetsAt: null };
  }
  release() {}
  block() {}
}

export default { fetch: () => new Response('stub') };
