/** Local dev ports, matching each worker's `dev` script (its folder under workers/). */
export const WORKERS = [
  { name: 'api', port: 8787, inspectorPort: 9240, securityTxt: true },
  { name: 'send', port: 8788, inspectorPort: 9239, securityTxt: false, testScheduled: true },
  { name: 'events', port: 8789, inspectorPort: 9232, securityTxt: false },
  { name: 'track', port: 8790, inspectorPort: 9233, securityTxt: true },
  { name: 'capture', port: 8791, inspectorPort: 9238, securityTxt: true },
  { name: 'site', port: 8792, inspectorPort: 9235, securityTxt: true },
  { name: 'jobs', port: 8793, inspectorPort: 9236, securityTxt: false },
  { name: 'realtime', port: 8796, inspectorPort: 9237, securityTxt: false },
] as const;

/**
 * The vault has no route (its fetch answers 404 on every path, so it has no /healthz): api,
 * capture, site and jobs reach it only through service bindings, which locally resolve through
 * the dev registry. Started on its own so those bindings have a script to call.
 */
export const VAULT = { name: 'vault', port: 8798, inspectorPort: 9241 } as const;

/** The stand-in Turnstile widget (local/turnstile.mjs); Chromium sends challenges.cloudflare.com here. */
export const TURNSTILE_PORT = 8799;

export const DASHBOARD_PORT = 5273;
