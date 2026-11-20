import { hostnamesFor } from '../hostnames';
import type { Ctx } from '../context';
import { subscribeSns } from '../steps/postdeploy';
import type { Step } from '../steps/step';
import { InstallError } from '../ui';

/**
 * Bounce and complaint reports reach Swarm only once SNS has confirmed the subscription. The
 * terminal installer can warn about this and be run again. Here it's a step of its own that stays
 * next until it works, because this page forgets the AWS key once the install is over.
 */
export const sesEvents: Step = {
  id: 'ses-events',
  title: 'Connecting Amazon SES reports',
  async run(ctx: Ctx) {
    if (ctx.state.choices?.mail.provider !== 'ses' || ctx.state.ses?.subscriptionConfirmed) return;
    if (!ctx.session.awsAdmin) {
      throw new InstallError(
        'Swarm needs your AWS key again to connect bounce and complaint reports.',
        'This page forgets the key after 2 hours. Paste it below, then try this step again.',
      );
    }
    const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices.addresses);
    await subscribeSns(ctx, `https://${h.events}/sns/ses`);
    if (!ctx.state.ses?.subscriptionConfirmed) {
      throw new InstallError(
        "Amazon SES hasn't confirmed that it can reach your Swarm yet.",
        `Without this, Swarm can't see bounces or complaints. ${h.events} may still be starting, so wait a few minutes, then try this step again.`,
      );
    }
  },
};
