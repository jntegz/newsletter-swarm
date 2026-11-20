// Starts one worker the way its `dev` script does (wrangler dev --port --inspector-port
// --persist-to ../../.wrangler/state, in the shared dev registry), but with an outbound handler:
// Turnstile's siteverify is answered locally (offline.mjs) and a request for any host off this
// machine gets a 502 instead of reaching the network. Service bindings (the vault) and Durable
// Objects go through the dev registry, not this handler. Email checks use the app's in-process
// DeBounce fake (DEBOUNCE_API_KEY=dev, packages/engine/src/debounce.ts), which never calls DeBounce
// and does nothing until a spec turns checks on for its own workspace.
//
//   node local/worker.mjs <worker folder> <port> <inspector port> [--test-scheduled]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isLocalHost, siteverify } from './offline.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const [folder, port, inspectorPort, ...flags] = process.argv.slice(2);
if (!folder || !port || !inspectorPort) {
  throw new Error('usage: worker.mjs <worker folder> <port> <inspector port> [--test-scheduled]');
}
const workerDir = `${ROOT}workers/${folder}`;
// The worker's own wrangler, the one its dev script runs.
const { unstable_startWorker } = createRequire(`${workerDir}/package.json`)('wrangler');

/** The workers that read DEBOUNCE_API_KEY. `dev` is the fake, honoured only in development. */
const DEBOUNCE_FAKE = new Set(['api', 'capture', 'jobs']);

async function outbound(request) {
  const url = new URL(request.url);
  if (url.origin === 'https://challenges.cloudflare.com' && url.pathname.endsWith('/siteverify')) {
    return siteverify(await request.formData());
  }
  if (isLocalHost(url.hostname)) return fetch(request.url, request);
  console.error(`[e2e offline] ${folder}: refused ${request.method} ${url.origin}${url.pathname}`);
  return new Response('Refused: e2e runs make no requests off this machine.', { status: 502 });
}

const worker = await unstable_startWorker({
  config: `${workerDir}/wrangler.jsonc`,
  ...(DEBOUNCE_FAKE.has(folder)
    ? { bindings: { DEBOUNCE_API_KEY: { type: 'plain_text', value: 'dev' } } }
    : {}),
  dev: {
    remote: false,
    server: { hostname: 'localhost', port: Number(port) },
    inspector: { port: Number(inspectorPort) },
    persist: `${ROOT}.wrangler/state`,
    registry: process.env.WRANGLER_REGISTRY_PATH,
    testScheduled: flags.includes('--test-scheduled'),
    watch: false,
    outboundService: outbound,
  },
});
await worker.ready;
console.log(`[e2e] ${folder} ready on http://localhost:${port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    worker.dispose().finally(() => process.exit(0));
  });
}
