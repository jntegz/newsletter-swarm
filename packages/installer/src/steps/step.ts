import type { Ctx } from '../context';

/** One idempotent stage of the install. Re-running a step looks before it creates. */
export interface Step {
  id: string;
  title: string;
  run(ctx: Ctx): Promise<void>;
}

export async function runSteps(ctx: Ctx, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    ctx.ui.section(step.title);
    await step.run(ctx);
  }
}
