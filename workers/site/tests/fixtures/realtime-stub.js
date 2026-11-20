// Stand-in for the realtime worker in the site tests: the install's sending limits, granting every
// turn. The real arithmetic is tested in workers/realtime.
import { DurableObject } from 'cloudflare:workers';

export class SendPacer extends DurableObject {
  turn({ count }) {
    return { granted: count, startInMs: 0, retryAfterSeconds: 0, limit: null, resetsAt: null };
  }
  release() {}
  block() {}
}

export default { fetch: () => new Response('stub') };
