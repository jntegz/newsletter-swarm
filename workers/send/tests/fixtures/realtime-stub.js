// Stand-in for the realtime worker in the send and api tests: records what is published and
// accepts sockets.
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

// Grants every turn at once and counts nothing; the pacer itself is tested in the realtime worker.
export class SendPacer extends DurableObject {
  take(count) {
    return { granted: count, startInMs: 0, retryAfterSeconds: 0 };
  }
  turn({ count }) {
    return { granted: count, startInMs: 0, retryAfterSeconds: 0, limit: null, resetsAt: null };
  }
  release() {}
  block() {}
  usage() {
    const window = { used: 0, limit: null, forSends: null, resetsAt: Date.now() + 3_600_000 };
    return { hour: window, day: window, month: window, service: null, ceiling: null };
  }
}

export default { fetch: () => new Response('stub') };
