import { database, wrangler, type Ctx } from '../context';
import { generatedPath } from '../paths';
import { closeSignup } from './bootstrap';
import type { Step } from './step';

export async function applyMigrations(ctx: Ctx) {
  await ctx.ui.task(`Applying database migrations to swarm-${ctx.env}`, () =>
    wrangler(ctx, [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--config',
      generatedPath(ctx.root, 'api', ctx.env),
      '--env',
      ctx.env,
    ]),
  );
}

/** Pending migration names, from `wrangler d1 migrations list`. */
export async function pendingMigrations(ctx: Ctx): Promise<string[]> {
  const result = await wrangler(ctx, [
    'd1',
    'migrations',
    'list',
    'DB',
    '--remote',
    '--config',
    generatedPath(ctx.root, 'api', ctx.env),
    '--env',
    ctx.env,
  ]);
  if (/No migrations to apply/i.test(result.stdout)) return [];
  return [...result.stdout.matchAll(/\b(\d{4}_[\w-]+\.sql)\b/g)].map((m) => m[1] as string);
}

/**
 * Only an install closes sign-up here, before its deploy step; `update` applies migrations alone
 * and leaves the sign-up mode as it is.
 */
export const migrations: Step = {
  id: 'migrations',
  title: 'Database',
  async run(ctx) {
    await applyMigrations(ctx);
    await ctx.ui.task('Closing sign-up until the owner account exists', () =>
      closeSignup(database(ctx)),
    );
  },
};
