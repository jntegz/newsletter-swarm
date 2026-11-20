import { accountId, oauthApi, save, saveSecrets, type Ctx } from '../context';
import { InstallError } from '../ui';
import type { Step } from './step';

interface Widget {
  sitekey: string;
  name: string;
  domains?: string[];
  secret?: string;
}

/** Finds or creates the Turnstile widget swarm-<env> for the zone (subdomains included). */
export async function ensureTurnstile(ctx: Ctx): Promise<void> {
  const cf = oauthApi(ctx);
  const base = `/accounts/${accountId(ctx)}/challenges/widgets`;
  const name = `swarm-${ctx.env}`;
  const zone = ctx.state.zone?.name;
  if (!zone) throw new InstallError('No zone is selected.', 'Run `pnpm swarm` first.');
  let created = false;
  const widget = await ctx.ui.task(
    `Creating Turnstile widget ${name}`,
    async () => {
      const list = await cf.list<Widget>(base, {}, 50);
      const existing = list.find((w) => w.name === name);
      if (!existing) {
        created = true;
        return cf.post<Widget>(base, { name, domains: [zone], mode: 'managed' });
      }
      if (existing.sitekey === ctx.state.turnstile?.sitekey && ctx.secrets.turnstileSecret)
        return existing;
      // The list leaves the secret out; the widget itself has it.
      return cf.get<Widget>(`${base}/${existing.sitekey}`);
    },
    () => (created ? 'done' : 'already there'),
  );
  if (!widget.secret && !ctx.secrets.turnstileSecret) {
    throw new InstallError(
      `Cloudflare did not return the secret of the Turnstile widget ${name}.`,
      'Delete the widget in the Cloudflare dashboard (Turnstile) and run `pnpm swarm` again.',
    );
  }
  ctx.state.turnstile = { sitekey: widget.sitekey };
  if (widget.secret) ctx.secrets.turnstileSecret = widget.secret;
  await save(ctx);
  await saveSecrets(ctx);
}

export const turnstile: Step = {
  id: 'turnstile',
  title: 'Bot protection (Turnstile)',
  run: ensureTurnstile,
};
