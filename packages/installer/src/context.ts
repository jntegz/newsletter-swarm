import { LINK_V2_SIGNING_READY } from '@swarm/tokens';
import { CloudflareApi } from './cloudflare';
import { FallbackD1, RestD1, WranglerD1, type D1Executor } from './d1';
import { tail } from './exec';
import { generatedPath, workerDir, type EnvName, type Worker } from './paths';
import type { Secrets, State, StateStore } from './state';
import type { AwsCredentials, ExecResult, Transport } from './transport';
import { InstallError, type Ui } from './ui';
import type { Answers } from './answers';

/** What one run holds in memory. Admin keys and the OAuth token live only here. */
interface Session {
  accountId?: string;
  oauthToken?: string;
  dnsToken?: string;
  awsAdmin?: AwsCredentials;
}

/** What this run found, for the summary. */
export interface Report {
  signInLink?: string;
  /** The browser setup sent a real test email here. */
  testEmailTo?: string | undefined;
  /** Something about the email service the person needs to know before relying on it. */
  mailNote?: string | undefined;
  unhealthy: string[];
  /** When this run last deployed the jobs worker: its vault heartbeat must be newer. */
  jobsDeployedAt?: number;
  /** Keyrings this run added to an install that had keys, or retired: older backups differ. */
  keysChanged?: string[];
}

export interface Ctx {
  root: string;
  env: EnvName;
  dryRun: boolean;
  /** Accept defaults without asking (--yes). */
  yes: boolean;
  /** False for --answers runs and `update`: every question must already be answered. */
  interactive: boolean;
  t: Transport;
  ui: Ui;
  store: StateStore;
  state: State;
  secrets: Secrets;
  answers: Answers;
  session: Session;
  report: Report;
  /** Set by the browser setup, which deploys through the API because it has no wrangler. */
  deployer?: (ctx: Ctx, worker: Worker) => Promise<void>;
  /** `update --link-keys=verify-only`: deploy the cutover's first pass and stop there. */
  holdLinkCutover?: boolean;
  /**
   * Whether the workers being deployed sign v2 links. The browser setup sets it from the release
   * it installs (its signed manifest); the CLI deploys its own checkout, so it leaves it out and
   * linkV2Ready() reads @swarm/tokens.
   */
  linkV2Ready?: boolean;
}

/** Whether the code this run deploys signs v2 links (Ctx.linkV2Ready). */
export const linkV2Ready = (ctx: Pick<Ctx, 'linkV2Ready'>): boolean =>
  ctx.linkV2Ready ?? LINK_V2_SIGNING_READY;

export async function save(ctx: Ctx) {
  await ctx.store.save(ctx.state);
}

export async function saveSecrets(ctx: Ctx) {
  await ctx.store.saveSecrets(ctx.env, ctx.secrets);
}

export function accountId(ctx: Ctx): string {
  const id = ctx.session.accountId ?? ctx.state.account?.id;
  if (!id)
    throw new InstallError(
      'No Cloudflare account is selected.',
      'Run `pnpm swarm` to sign in first.',
    );
  return id;
}

export function zoneId(ctx: Ctx): string {
  if (!ctx.state.zone) throw new InstallError('No zone is selected.', 'Run `pnpm swarm` first.');
  return ctx.state.zone.id;
}

/** The account-level API, with wrangler's OAuth token. */
export function oauthApi(ctx: Ctx): CloudflareApi {
  if (!ctx.session.oauthToken) {
    throw new InstallError(
      'There is no Cloudflare sign-in for this run.',
      'Run `pnpm swarm` again; it signs in first.',
    );
  }
  return new CloudflareApi(ctx.t, ctx.session.oauthToken, 'wrangler sign-in');
}

/** The DNS API with the pasted token, or null when this run does not have one. */
export function dnsApi(ctx: Ctx): CloudflareApi | null {
  const token = ctx.session.dnsToken ?? ctx.secrets.dnsToken ?? ctx.answers.dnsToken;
  return token ? new CloudflareApi(ctx.t, token, 'DNS token') : null;
}

interface WranglerOptions {
  worker?: Worker;
  json?: boolean;
  interactive?: boolean;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
}

/** Runs wrangler from workers/<worker> (or workers/api), never through a shell. */
export async function wrangler(
  ctx: Ctx,
  args: string[],
  options: WranglerOptions = {},
): Promise<ExecResult> {
  const id = ctx.session.accountId ?? ctx.state.account?.id;
  const result = await ctx.t.exec({
    command: 'wrangler',
    args,
    cwd: workerDir(ctx.root, options.worker ?? 'api'),
    env: {
      ...(id ? { CLOUDFLARE_ACCOUNT_ID: id } : {}),
      WRANGLER_SEND_METRICS: 'false',
      ...(options.interactive ? {} : { CI: '1', FORCE_COLOR: '0' }),
    },
    ...(options.interactive ? { interactive: true } : {}),
  });
  if (result.code !== 0 && !options.allowFailure) {
    throw new InstallError(
      `wrangler ${args.slice(0, 3).join(' ')} failed:\n${tail(result.stderr || result.stdout)}`,
      'Read the message above. Fix the cause and run the same command again; finished steps are skipped.',
    );
  }
  return result;
}

/** The remote database: REST /query first, wrangler d1 execute if the API refuses. */
export function database(ctx: Ctx): D1Executor {
  const d1 = ctx.state.resources.d1;
  if (!d1) throw new InstallError('The database does not exist yet.', 'Run `pnpm swarm` first.');
  const rest = new RestD1(oauthApi(ctx), accountId(ctx), d1.id);
  const fallback = new WranglerD1(ctx.t, {
    cwd: workerDir(ctx.root, 'api'),
    config: generatedPath(ctx.root, 'api', ctx.env),
    env: ctx.env,
    accountId: accountId(ctx),
  });
  return new FallbackD1(rest, fallback, (reason) =>
    ctx.ui.warn(
      `The D1 query API refused (${reason.split('\n')[0]}); using wrangler d1 execute instead.`,
    ),
  );
}
