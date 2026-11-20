import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, resolved from this file (packages/installer/src/paths.ts). */
// There is no file to resolve from inside the Setup Worker, which never reads the repository.
export const REPO_ROOT = import.meta.url?.startsWith('file:')
  ? fileURLToPath(new URL('../../../', import.meta.url))
  : '/';

export const WORKERS = [
  'realtime',
  'vault',
  'track',
  'events',
  'site',
  'capture',
  'send',
  'jobs',
  'api',
] as const;
export type Worker = (typeof WORKERS)[number];

/**
 * Deploy order: realtime first (api, send, jobs, capture and site bind to its Durable Objects by
 * script name), then the vault (api, capture, site and jobs bind to its entrypoints, and a service
 * binding to a script that does not exist fails the upload), api last (it serves the dashboard
 * and is what people open first).
 */
export const DEPLOY_ORDER: readonly Worker[] = WORKERS;

export type EnvName = 'production' | 'staging';

export const workerDir = (root: string, worker: Worker) => join(root, 'workers', worker);
export const templatePath = (root: string, worker: Worker) =>
  join(workerDir(root, worker), 'wrangler.jsonc');
export const generatedPath = (root: string, worker: Worker, env: EnvName) =>
  join(workerDir(root, worker), `wrangler.${env}.generated.jsonc`);
export const stateDir = (root: string) => join(root, '.swarm');

/** The deployed script name: wrangler's env block names. */
export const scriptName = (worker: Worker, env: EnvName) =>
  env === 'production' ? `swarm-${worker}` : `swarm-${worker}-staging`;
