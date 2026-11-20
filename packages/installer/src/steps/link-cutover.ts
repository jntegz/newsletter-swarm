import { linkV2Ready, save, type Ctx } from '../context';
import { cutOverLinkKeys, LINK_WORKERS } from '../keys';
import { deployAll } from './deploy';
import { healthCheck } from './health';
import { writeConfigs } from './render';
import type { Step } from './step';

/**
 * The second pass of the move to per-family link keys. The deploy step (pass one) gave every
 * worker the new keyrings, so every verifier accepts v2 links while signers still issue v1. Once
 * this code can sign v2, and only when every worker answers, the signers switch: the cutoff is
 * recorded, which starts each worker's MEMBER_KEYS window (the prune step removes it afterwards),
 * and the workers that hold link keys deploy again. `--link-keys=verify-only` stays at pass one.
 */
async function cutOverLinks(ctx: Ctx, v2Ready: boolean = linkV2Ready(ctx)) {
  if (!v2Ready || ctx.state.linkKeys?.mode !== 'verify-v2') return;
  if (ctx.holdLinkCutover) {
    ctx.ui.info(
      'Every worker accepts the new links; signers keep the old ones (--link-keys=verify-only).',
    );
    return;
  }
  const unhealthy = await healthCheck(ctx, true);
  if (unhealthy.length > 0) {
    ctx.ui.warn(
      `Links stay signed the old way for now: ${unhealthy.join(', ')} did not answer. Run \`pnpm swarm update\` again once they do.`,
    );
    return;
  }
  ctx.state.linkKeys = cutOverLinkKeys(Date.now());
  await save(ctx);
  ctx.ui.info('Every worker accepts the new links. Switching the signers to them.');
  await writeConfigs(ctx);
  await deployAll(ctx, LINK_WORKERS);
}

export const linkCutover: Step = {
  id: 'link-cutover',
  title: 'Signing links with per-link keys',
  run: (ctx) => cutOverLinks(ctx),
};
