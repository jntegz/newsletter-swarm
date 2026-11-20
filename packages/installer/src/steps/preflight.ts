import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { wranglerScript } from '../exec';
import { templatePath, WORKERS } from '../paths';
import { InstallError } from '../ui';
import type { Step } from './step';

function nodeMajor(version = process.versions.node): number {
  return Number(version.split('.')[0]);
}

export const preflight: Step = {
  id: 'preflight',
  title: 'Checking this computer',
  async run(ctx) {
    await ctx.ui.task(
      'Checking Node.js',
      async () => {
        if (nodeMajor() < 22) {
          throw new InstallError(
            `Swarm needs Node.js 22 or newer; this is ${process.versions.node}.`,
            'Install Node.js 22 LTS from https://nodejs.org and run `pnpm swarm` again.',
          );
        }
      },
      () => `done (${process.versions.node})`,
    );
    await ctx.ui.task('Checking dependencies', async () => {
      if (!existsSync(join(ctx.root, 'node_modules')) || !existsSync(wranglerScript())) {
        throw new InstallError(
          'The dependencies are not installed.',
          'Run `pnpm install` in the repository, then `pnpm swarm`.',
        );
      }
      for (const worker of WORKERS) {
        if (!existsSync(templatePath(ctx.root, worker))) {
          throw new InstallError(
            `workers/${worker}/wrangler.jsonc is missing.`,
            'Run the installer from a complete clone of the repository.',
          );
        }
      }
    });
  },
};
