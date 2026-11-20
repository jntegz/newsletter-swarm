import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { Ctx } from '../context';
import { isSealedKit, openKit } from '../kit';
import { parseSecrets, parseState } from '../state';
import { InstallError } from '../ui';

/**
 * Turns a recovery kit from the browser setup back into .swarm/, so `signin-link`, `doctor` and
 * `update` work on this computer. It changes nothing on Cloudflare.
 */
export async function restoreKit(ctx: Ctx, path: string | undefined) {
  if (!path) throw new InstallError('Say which file.', 'Run `pnpm swarm restore <recovery kit>`.');
  if (ctx.state.zone) {
    throw new InstallError(
      `There is already an install in ${ctx.store.location}, so nothing was changed.`,
      'Move that folder somewhere safe first if you do mean to replace it.',
    );
  }
  // pnpm runs the installer in packages/installer; INIT_CWD is where `pnpm swarm` was typed.
  const vars = process.env;
  const file = resolvePath(vars.INIT_CWD ?? process.cwd(), path);
  let kit: { state?: unknown; secrets?: unknown };
  try {
    kit = JSON.parse(await readFile(file, 'utf8')) as typeof kit;
  } catch {
    throw new InstallError(`Cannot read ${file} as a recovery kit.`, 'Check the path to the file.');
  }
  // A kit from the setup page is encrypted under the passphrase chosen when it was saved.
  if (isSealedKit(kit)) {
    const passphrase =
      vars.SWARM_KIT_PASSPHRASE ??
      (await ctx.ui.prompts.password({ message: "The recovery kit's passphrase" }));
    kit = await openKit(kit, passphrase);
  }
  if (!kit.state || !kit.secrets) {
    throw new InstallError(
      `${file} isn't a complete recovery kit.`,
      'Use the file the setup page gave you.',
    );
  }
  const state = parseState(JSON.stringify(kit.state), file);
  const secrets = parseSecrets(JSON.stringify(kit.secrets), file);
  await ctx.store.save(state);
  await ctx.store.saveSecrets(state.env, secrets);
  ctx.ui.info(
    `Restored the install for ${state.zone?.name ?? 'your domain'}. A new sign-in link: pnpm swarm signin-link`,
  );
}
