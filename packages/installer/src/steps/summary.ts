import type { Ctx } from '../context';
import { hostnamesFor } from '../hostnames';
import { BACKUP_WARNING, WINDOWS_PERMISSIONS_NOTE } from '../state';
import type { Step } from './step';

function summaryLines(ctx: Ctx): string[] {
  const zone = ctx.state.zone?.name ?? '';
  const h = hostnamesFor(zone, ctx.env, ctx.state.choices?.addresses);
  const choices = ctx.state.choices;
  const lines: string[] = [];
  lines.push(`Dashboard        https://${h.app}`);
  if (h.wildcard && choices)
    lines.push(`Your publication https://${choices.publication.slug}.${zone}`);
  lines.push(`Signup forms     https://${h.forms}`);
  lines.push('');
  if (ctx.report.signInLink) {
    lines.push('Sign in (works once, for 60 minutes):');
    lines.push(ctx.report.signInLink);
    lines.push('New link later: pnpm swarm signin-link');
    lines.push('');
  }
  if (choices?.mail.provider === 'resend') {
    const status = ctx.state.resend?.status ?? 'unknown';
    lines.push(
      `Email: Resend, sending from ${h.mailFrom}. Domain: ${status === 'verified' ? 'verified' : `${status}; Resend keeps checking the DNS records`}.`,
    );
    lines.push("Resend's free plan allows 100 emails a day and 3,000 a month, on up to 3 domains.");
  } else if (choices?.mail.provider === 'mailgun') {
    const verified = ctx.state.mailgun?.status === 'active';
    lines.push(
      `Email: Mailgun (${choices.mail.region.toUpperCase()}), sending from ${h.mailFrom}. Domain: ${verified ? 'verified' : 'not verified yet; DNS can take a while'}.`,
    );
  } else if (choices?.mail.provider === 'postmark') {
    const verified = ctx.state.postmark?.dkimVerified === true;
    lines.push(
      `Email: Postmark, sending from ${h.mailFrom}. Domain: ${verified ? 'verified' : 'not verified yet; DNS can take a while'}.`,
    );
    lines.push(
      'Until Postmark approves your account, it only delivers to addresses on your domain.',
    );
  } else if (choices?.mail.provider === 'smtp') {
    lines.push(`Email: your own server ${choices.mail.smtp?.host}, sending from ${h.mailFrom}.`);
    lines.push('Swarm cannot pause a send over spam complaints unless your server reports them.');
  } else if (choices?.mail.provider === 'ses') {
    lines.push(`Email: Amazon SES (${choices.mail.region}), sending from ${h.mailFrom}.`);
    if (ctx.state.ses && !ctx.state.ses.productionAccess) {
      lines.push(
        `SES is in the sandbox: mail only reaches verified addresses, such as ${choices.owner.email} once you click AWS's link.`,
      );
    }
    if (ctx.state.ses && !ctx.state.ses.subscriptionConfirmed)
      lines.push('SES events are not connected yet; run `pnpm swarm` again in a few minutes.');
  }
  lines.push('');
  const off: string[] = [];
  if (!ctx.state.features.payments) off.push('payments (pnpm swarm enable payments)');
  if (!ctx.state.features.customDomains)
    off.push('custom domains (pnpm swarm enable custom-domains)');
  if (!ctx.state.features.google) off.push('Google sign-in (pnpm swarm enable google)');
  if (off.length) lines.push(`Switched off for now: ${off.join(', ')}.`);
  if (ctx.report.unhealthy.length) {
    lines.push(
      `Not answering yet: ${ctx.report.unhealthy.join(', ')}. New certificates can take a few minutes; then run \`pnpm swarm doctor\`.`,
    );
  }
  lines.push('');
  lines.push('What to do next:');
  lines.push('  1. Sign in with the link above.');
  lines.push(
    '  2. Under Sending & delivery, check your sender and read how warm-up paces a new domain.',
  );
  lines.push('  3. Add subscribers or a signup form, then write your first post.');
  lines.push('The guide for this is docs/getting-started.md.');
  lines.push('');
  if (ctx.report.keysChanged?.length) {
    lines.push(
      `The keys changed in this run (${ctx.report.keysChanged.join(', ')}). Back up .swarm/ again, and save a new recovery kit if you keep one: an older copy does not have them.`,
    );
  }
  lines.push(BACKUP_WARNING);
  if (process.platform === 'win32') lines.push(WINDOWS_PERMISSIONS_NOTE);
  return lines;
}

export const summary: Step = {
  id: 'summary',
  title: 'Done',
  async run(ctx) {
    ctx.ui.note(
      ctx.dryRun ? 'Dry run finished. Nothing was created.' : 'Swarm is installed',
      summaryLines(ctx).join('\n'),
    );
  },
};
