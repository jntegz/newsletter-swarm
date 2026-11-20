import { tail } from '../exec';
import type { Ctx } from '../context';
import { InstallError } from '../ui';
import type { Step } from './step';

export async function buildDashboard(ctx: Ctx) {
  await ctx.ui.task('Building the dashboard', async () => {
    const result = await ctx.t.exec({
      command: 'pnpm',
      args: ['--filter', '@swarm/dashboard', 'build'],
      cwd: ctx.root,
      env: { CI: '1' },
    });
    if (result.code !== 0) {
      throw new InstallError(
        `The dashboard build failed:\n${tail(result.stdout + result.stderr)}`,
        'Run `pnpm --filter @swarm/dashboard build` to see the full error.',
      );
    }
  });
}

export const build: Step = { id: 'build', title: 'Dashboard', run: buildDashboard };
