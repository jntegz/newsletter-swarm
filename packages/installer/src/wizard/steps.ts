import { oauthApi, save, type Ctx } from '../context';
import { DEPLOY_ORDER, scriptName } from '../paths';
import { closeSignup } from '../steps/bootstrap';
import { bootstrap } from '../steps/bootstrap';
import { dns } from '../steps/dns';
import { health } from '../steps/health';
import { keys } from '../steps/keys';
import { mail } from '../steps/mail';
import { postDeploy } from '../steps/postdeploy';
import { prompts } from '../steps/prompts';
import { resources } from '../steps/resources';
import { signin } from '../steps/signin';
import type { Step } from '../steps/step';
import { summary } from '../steps/summary';
import { turnstile } from '../steps/turnstile';
import { database } from '../context';
import { InstallError } from '../ui';
import { emailCheck } from './email-check';
import { applyMigrationsFromRelease, deployWorkerFromRelease } from './deploy';
import type { Release } from './release';
import { sesEvents } from './ses-events';

/** Replaces `wrangler login`: the pasted token decides the account. */
const account: Step = {
  id: 'account',
  title: 'Your Cloudflare account',
  async run(ctx: Ctx) {
    const accounts = await oauthApi(ctx).list<{ id: string; name: string }>('/accounts');
    const wanted = ctx.answers.account ?? ctx.state.account?.id;
    const chosen = wanted
      ? accounts.find((a) => a.id === wanted || a.name === wanted)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    if (!chosen) {
      throw new InstallError(
        accounts.length
          ? 'Choose which Cloudflare account to use.'
          : 'The token can see no account.',
        'Create the token again with the link on the first page.',
      );
    }
    ctx.session.accountId = chosen.id;
    // A fresh install on an account already running Swarm would make new encryption keys and
    // overwrite the ones in use, and every encrypted subscriber field would be lost for good.
    if (!ctx.state.account) {
      const scripts = await oauthApi(ctx).list<{ id: string }>(
        `/accounts/${chosen.id}/workers/scripts`,
      );
      if (scripts.some((script) => script.id === scriptName('send', ctx.env))) {
        throw new InstallError(
          'This Cloudflare account already runs Swarm, so installing again would destroy its encryption keys.',
          'To change your email service, use the change email service option with your recovery kit. See the setup guide.',
        );
      }
    }
    ctx.state.account = { id: chosen.id, name: chosen.name };
    await save(ctx);
  },
};

/**
 * The install, split so one request runs one step: nothing here outlives a request, and a failed
 * step can run again. It's the same list as `pnpm swarm`, with direct API calls in place of what
 * needs wrangler or local files.
 */
export function wizardSteps(release: Release): Step[] {
  return [
    account,
    prompts,
    resources,
    keys,
    turnstile,
    mail,
    dns,
    {
      id: 'migrations',
      title: 'Database',
      async run(ctx) {
        await ctx.ui.task('Applying database migrations', () =>
          applyMigrationsFromRelease(ctx, release),
        );
        await ctx.ui.task('Closing sign-up until the owner account exists', () =>
          closeSignup(database(ctx)),
        );
      },
    },
    ...DEPLOY_ORDER.map((worker): Step => ({
      id: `deploy-${worker}`,
      title: `Deploying ${worker}`,
      async run(ctx) {
        await ctx.ui.task(`Deploying ${scriptName(worker, ctx.env)}`, () =>
          deployWorkerFromRelease(ctx, release, worker),
        );
      },
    })),
    postDeploy,
    sesEvents,
    emailCheck,
    bootstrap,
    signin,
    health,
    summary,
  ];
}
