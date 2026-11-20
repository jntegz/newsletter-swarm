import { oauthApi, save, wrangler, type Ctx } from '../context';
import { parseJsonOutput } from '../exec';
import { InstallError } from '../ui';
import type { Step } from './step';

interface Whoami {
  loggedIn?: boolean;
  email?: string;
  accounts?: { id: string; name: string }[];
}

async function whoami(ctx: Ctx): Promise<Whoami | null> {
  const result = await wrangler(ctx, ['whoami', '--json'], { allowFailure: true });
  if (result.code !== 0) return null;
  try {
    const info = parseJsonOutput<Whoami>(result.stdout);
    return info.loggedIn === false ? null : info;
  } catch {
    return null;
  }
}

/** `wrangler auth token --json` prints the current token; older output is the bare token. */
export function parseAuthToken(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = parseJsonOutput<{ token?: string; value?: string }>(trimmed);
    return parsed.token ?? parsed.value ?? null;
  } catch {
    const line = trimmed.split(/\r?\n/).pop()?.trim();
    return line && /^[\w.-]{20,}$/.test(line) ? line : null;
  }
}

/** Signs in with wrangler (once) and picks the account. Fills ctx.session. */
export async function signIn(ctx: Ctx): Promise<void> {
  let info = await ctx.ui.task(
    'Checking the Cloudflare sign-in',
    () => whoami(ctx),
    (w) => (w ? `done${w.email ? ` (${w.email})` : ''}` : 'not signed in'),
  );
  if (!info) {
    if (!ctx.interactive) {
      throw new InstallError(
        'wrangler is not signed in to Cloudflare.',
        'Run `pnpm --filter @swarm/installer exec wrangler login` once, then run this again.',
      );
    }
    ctx.ui.info('A browser window opens so you can allow wrangler to use your Cloudflare account.');
    await wrangler(ctx, ['login'], { interactive: true });
    info = await whoami(ctx);
    if (!info)
      throw new InstallError(
        'The Cloudflare sign-in did not finish.',
        'Run `pnpm swarm` again and allow access in the browser.',
      );
  }

  const token = await ctx.ui.task('Reading the sign-in token', async () => {
    const result = await wrangler(ctx, ['auth', 'token', '--json'], { allowFailure: true });
    const parsed = result.code === 0 ? parseAuthToken(result.stdout) : null;
    if (parsed) return parsed;
    const plain = await wrangler(ctx, ['auth', 'token']);
    const fallback = parseAuthToken(plain.stdout);
    if (!fallback) {
      throw new InstallError(
        'wrangler did not print a sign-in token.',
        'Run `pnpm --filter @swarm/installer exec wrangler login` again.',
      );
    }
    return fallback;
  });
  ctx.session.oauthToken = token;

  const accounts = await oauthApi(ctx)
    .get<{ id: string; name: string }[]>('/accounts')
    .catch(() => info?.accounts ?? []);
  const wanted = ctx.answers.account;
  let account =
    (wanted ? accounts.find((a) => a.id === wanted || a.name === wanted) : undefined) ??
    (ctx.state.account ? accounts.find((a) => a.id === ctx.state.account?.id) : undefined);
  if (wanted && !account) {
    throw new InstallError(
      `This sign-in cannot see the Cloudflare account "${wanted}".`,
      'Check the account in the answers file.',
    );
  }
  if (!account && accounts.length === 1) account = accounts[0];
  if (!account && accounts.length > 1) {
    if (!ctx.interactive) {
      throw new InstallError(
        'This sign-in can see several Cloudflare accounts.',
        'Add "account": "<id or name>" to the answers file.',
      );
    }
    const id = await ctx.ui.prompts.select({
      message: 'Which Cloudflare account should Swarm use?',
      options: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
    });
    account = accounts.find((a) => a.id === id);
  }
  if (!account)
    throw new InstallError(
      'This sign-in has no Cloudflare account.',
      'Sign in with a user that belongs to an account.',
    );
  ctx.session.accountId = account.id;
  ctx.state.account = { id: account.id, name: account.name };
  ctx.ui.info(`Using the Cloudflare account ${account.name}.`);
  await save(ctx);
}

export const login: Step = { id: 'login', title: 'Signing in to Cloudflare', run: signIn };
