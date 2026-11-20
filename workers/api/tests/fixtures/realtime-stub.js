// Stand-in for the realtime worker in the api tests: the send monitor stub (as in the send tests),
// the /v2 token bucket with the same arithmetic as ApiRateLimiter in workers/realtime, and a
// scriptable send pacer.
/* global WebSocketPair */
import { DurableObject } from 'cloudflare:workers';

export class SendMonitor extends DurableObject {
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.send(JSON.stringify((await this.latest()) ?? { hello: true }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async publish(progress) {
    await this.ctx.storage.put('latest', progress);
  }
  async latest() {
    return (await this.ctx.storage.get('latest')) ?? null;
  }
}

export class ApiRateLimiter extends DurableObject {
  async take(perMinute, capacity, now = Date.now()) {
    const perMs = perMinute / 60_000;
    const saved = (await this.ctx.storage.get('b')) ?? null;
    const elapsed = saved ? Math.max(0, now - saved.at) : 0;
    const tokens = saved ? Math.min(capacity, saved.tokens + elapsed * perMs) : capacity;
    const fullIn = (left) => Math.ceil((capacity - left) / perMs / 1000);
    if (tokens < 1) {
      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetSeconds: fullIn(tokens),
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)),
      };
    }
    await this.ctx.storage.put('b', { tokens: tokens - 1, at: now });
    return {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(tokens - 1),
      resetSeconds: fullIn(tokens - 1),
      retryAfterSeconds: 0,
    };
  }
}

// The install's sending limits: grants every turn unless a test scripted the next answers or the
// email service's quota is blocked (refusing bulk turns and turns that can wait, as the real one
// does), and counts what it granted so the instance settings can show usage. It keeps the newest
// limits it was told. The real arithmetic is tested in workers/realtime.
export class SendPacer extends DurableObject {
  async script(turns) {
    await this.ctx.storage.put('script', turns);
  }
  async turn({ count, priority, canWait, limits, limitsSavedAt }) {
    const asked = (await this.ctx.storage.get('asked')) ?? [];
    const entry = { count, priority, ...(canWait ? { canWait } : {}) };
    await this.ctx.storage.put('asked', [...asked, entry].slice(-1000));
    const told = (await this.ctx.storage.get('told')) ?? null;
    if (limitsSavedAt !== undefined && (!told || limitsSavedAt >= told.limitsSavedAt)) {
      await this.ctx.storage.put('told', { limits, limitsSavedAt });
    }
    const service = (await this.ctx.storage.get('service')) ?? null;
    if (service && service.until > Date.now() && (priority === 'bulk' || canWait)) {
      return {
        granted: 0,
        startInMs: 0,
        retryAfterSeconds: Math.ceil((service.until - Date.now()) / 1000),
        limit: `service_${service.window}`,
        resetsAt: service.until,
      };
    }
    const script = (await this.ctx.storage.get('script')) ?? [];
    const next = script.shift();
    await this.ctx.storage.put('script', script);
    const answer = next ?? {
      granted: count,
      startInMs: 0,
      retryAfterSeconds: 0,
      limit: null,
      resetsAt: null,
    };
    await this.ctx.storage.put(
      'used',
      ((await this.ctx.storage.get('used')) ?? 0) + answer.granted,
    );
    return answer;
  }
  async release(count) {
    await this.ctx.storage.put('released', ((await this.ctx.storage.get('released')) ?? 0) + count);
  }
  async block(window, until) {
    await this.ctx.storage.put('service', { window, until });
  }
  async counts() {
    return {
      asked: (await this.ctx.storage.get('asked')) ?? [],
      used: (await this.ctx.storage.get('used')) ?? 0,
      released: (await this.ctx.storage.get('released')) ?? 0,
      service: (await this.ctx.storage.get('service')) ?? null,
      told: (await this.ctx.storage.get('told')) ?? null,
    };
  }
  async usage(limits) {
    const used = (await this.ctx.storage.get('used')) ?? 0;
    const window = (limit, resetsAt) => ({
      used,
      limit,
      forSends: limit === null ? null : limit - Math.max(1, Math.ceil(limit / 10)),
      resetsAt,
    });
    const now = Date.now();
    return {
      hour: window(limits.perHour, now - (now % 3_600_000) + 3_600_000),
      day: window(limits.perDay, now - (now % 86_400_000) + 86_400_000),
      month: window(limits.perMonth, now + 30 * 86_400_000),
      service: (await this.ctx.storage.get('service')) ?? null,
      ceiling: 2,
    };
  }
}

export default { fetch: () => new Response('stub') };
