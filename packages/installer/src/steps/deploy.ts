import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save, wrangler, type Ctx } from '../context';
import { secretValues } from '../keys';
import { DEPLOY_ORDER, generatedPath, scriptName, type Worker } from '../paths';
import type { Step } from './step';

/** Deploys one worker with its secrets. The secrets file exists only for the deploy. */
export async function deployWorker(ctx: Ctx, worker: Worker) {
  if (ctx.deployer) return ctx.deployer(ctx, worker);
  const secrets = await secretValues(worker, ctx.state, ctx.secrets);
  const names = Object.keys(secrets);
  const file = join(tmpdir(), `swarm-${worker}-${randomBytes(6).toString('hex')}.json`);
  await ctx.ui.task(
    `Deploying ${scriptName(worker, ctx.env)}`,
    async () => {
      const args = [
        'deploy',
        '--config',
        generatedPath(ctx.root, worker, ctx.env),
        '--env',
        ctx.env,
      ];
      try {
        if (names.length > 0) {
          await ctx.t.writeFile(file, JSON.stringify(secrets), { secret: true });
          args.push('--secrets-file', file);
        }
        await wrangler(ctx, args, { worker });
      } finally {
        if (names.length > 0) await ctx.t.removeFile(file);
      }
    },
    () => (names.length ? `done (${names.length} secrets)` : 'done'),
  );
  ctx.state.deployedAt = { ...ctx.state.deployedAt, [worker]: Date.now() };
  // The day the vault first went out: v3 writes wait a week from it (commands/vault.ts).
  if (worker === 'vault' && ctx.state.vault?.since === undefined) {
    ctx.state.vault = {
      writeFormat: ctx.state.vault?.writeFormat ?? 'legacy',
      legacyOpen: ctx.state.vault?.legacyOpen ?? true,
      since: Date.now(),
    };
  }
  await save(ctx);
}

export async function deployAll(ctx: Ctx, only?: readonly Worker[]) {
  for (const worker of DEPLOY_ORDER) {
    if (only && !only.includes(worker)) continue;
    await deployWorker(ctx, worker);
    if (worker === 'jobs') ctx.report.jobsDeployedAt = Date.now();
  }
}

export const deploy: Step = {
  id: 'deploy',
  title: 'Deploying the workers',
  run: (ctx) => deployAll(ctx),
};
