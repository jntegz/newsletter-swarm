import { readFile } from 'node:fs/promises';
import { assertNoPlaceholders, renderInput, renderWorkerConfig } from '../config/render';
import type { Ctx } from '../context';
import { generatedPath, templatePath, WORKERS, type Worker } from '../paths';
import type { Step } from './step';

/** Renders every worker's config in memory. */
export async function renderAll(ctx: Ctx): Promise<Map<Worker, string>> {
  const input = renderInput(ctx.state);
  const out = new Map<Worker, string>();
  for (const worker of WORKERS) {
    const template = await readFile(templatePath(ctx.root, worker), 'utf8');
    const rendered = renderWorkerConfig(worker, template, input);
    assertNoPlaceholders(worker, rendered, ctx.env);
    out.set(worker, rendered);
  }
  return out;
}

export async function writeConfigs(ctx: Ctx) {
  const rendered = await ctx.ui.task(
    'Rendering worker configs',
    () => renderAll(ctx),
    (m) => `done (${m.size})`,
  );
  for (const [worker, text] of rendered) {
    await ctx.t.writeFile(generatedPath(ctx.root, worker, ctx.env), text);
  }
}

export const render: Step = { id: 'render', title: 'Worker configs', run: writeConfigs };
