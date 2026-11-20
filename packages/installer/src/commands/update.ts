import { accountId, oauthApi, type Ctx } from '../context';
import { scriptName } from '../paths';
import { tail } from '../exec';
import { runFeatureDefaults } from '../steps/bootstrap';
import { applyMigrations } from '../steps/migrations';
import { buildDashboard } from '../steps/build';
import { deployAll } from '../steps/deploy';
import { writeDns } from '../steps/dns';
import { health } from '../steps/health';
import { keys } from '../steps/keys';
import { linkCutover } from '../steps/link-cutover';
import { signIn } from '../steps/login';
import { mail } from '../steps/mail';
import { preflight } from '../steps/preflight';
import { pruneSecrets } from '../steps/prune-secrets';
import { writeConfigs } from '../steps/render';
import { provisionResources } from '../steps/resources';
import { runSteps, type Step } from '../steps/step';
import { summary } from '../steps/summary';
import { ensureTurnstile } from '../steps/turnstile';
import { InstallError } from '../ui';

async function run(ctx: Ctx, title: string, command: 'git' | 'pnpm', args: string[]) {
  await ctx.ui.task(title, async () => {
    const result = await ctx.t.exec({ command, args, cwd: ctx.root });
    if (result.code !== 0) {
      throw new InstallError(
        `${command} ${args.join(' ')} failed:\n${tail(result.stderr || result.stdout)}`,
        'Fix the cause and run `pnpm swarm update` again.',
      );
    }
  });
}

/** Pulls the latest code and installs dependencies. */
export async function pullLatest(ctx: Ctx) {
  ctx.ui.section('Getting the latest version');
  await run(ctx, 'Pulling from git', 'git', ['pull', '--ff-only']);
  await run(ctx, 'Installing dependencies', 'pnpm', ['install', '--frozen-lockfile']);
}

const step = (id: string, title: string, fn: (ctx: Ctx) => Promise<void>): Step => ({
  id,
  title,
  run: fn,
});

/** Everything after the pull, without questions: create anything new, render, migrate, deploy. */
const UPDATE_STEPS: readonly Step[] = [
  preflight,
  step('login', 'Signing in to Cloudflare', signIn),
  step('resources', 'Cloudflare resources', provisionResources),
  keys,
  step('turnstile', 'Bot protection (Turnstile)', ensureTurnstile),
  mail,
  step('dns', 'DNS records', writeDns),
  step('render', 'Worker configs', writeConfigs),
  step('migrations', 'Database', applyMigrations),
  step('features', 'Features', runFeatureDefaults),
  step('build', 'Dashboard', buildDashboard),
  // The vault deploys before the workers bound to it (DEPLOY_ORDER): a service binding to a
  // missing script fails the upload.
  step('deploy', 'Deploying the workers', (ctx) => deployAll(ctx)),
  linkCutover,
  // Each public worker's /healthz answers 503 while the vault doesn't answer through its binding.
  health,
  // Only once they are healthy: until then the previous release (which still read FIELD_KEYS and
  // the moved link keys itself) can be rolled back to with its keys in place.
  step('prune-secrets', 'Keys the workers no longer need', pruneSecretsWhenHealthy),
  summary,
];

/** Prunes only after a clean health step; otherwise keeps every key and says why. */
async function pruneSecretsWhenHealthy(ctx: Ctx): Promise<void> {
  if (ctx.report.unhealthy.length) {
    ctx.ui.warn(
      `Keys the workers no longer need stay in place for now: ${ctx.report.unhealthy.join(', ')} did not pass its health check (a worker bound to the vault answers only while the vault does, and jobs records a heartbeat only while it reaches the vault). Run \`pnpm swarm update\` again once it does.`,
    );
    return;
  }
  await pruneSecrets(ctx);
}

/**
 * An update deploys from .swarm/. If email was moved from another computer, what's saved here is out
 * of date, and deploying it would silently put the Workers back on the old service.
 */
export async function refuseStaleMailService(ctx: Ctx) {
  // Partway through a cut-over the two disagree on purpose, and carrying on is how it gets fixed.
  if (ctx.state.mailChange?.phase === 'cutting_over') return;
  const current = await oauthApi(ctx)
    .get<{ bindings?: { type: string; name: string; text?: string }[] }>(
      `/accounts/${accountId(ctx)}/workers/scripts/${scriptName('api', ctx.env)}/settings`,
    )
    .catch(() => null);
  const deployed = current?.bindings?.find((b) => b.name === 'MAIL_ADAPTER')?.text;
  const saved = ctx.state.choices?.mail.provider;
  if (deployed && saved && deployed !== saved) {
    throw new InstallError(
      `Your Workers send through ${deployed}, but this computer has ${saved} saved, so updating would change it back.`,
      'Use your newest recovery kit. In the terminal, restore it with `pnpm swarm restore`.',
    );
  }
}

export async function update(ctx: Ctx) {
  if (!ctx.state.zone || !ctx.state.choices) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in .swarm/.`,
      'Run `pnpm swarm` to install first.',
    );
  }
  await signIn(ctx);
  await refuseStaleMailService(ctx);
  await runSteps(ctx, UPDATE_STEPS);
}
