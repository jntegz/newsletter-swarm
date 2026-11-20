import { ownerOnly } from './acl';
import { type Answers, loadAnswers } from './answers';
import { doctor } from './commands/doctor';
import { enable, FEATURES, type FeatureName } from './commands/enable';
import { parseFeatureArgs, runFeature, type FeatureCommand } from './commands/feature';
import {
  cancelSwitch,
  cutOver,
  cutOverWarnings,
  finishSwitch,
  prepareSwitch,
  rollBack,
  switchStatus,
} from './commands/mail-switch';
import { restoreKit } from './commands/restore';
import { vault, type VaultCommand } from './commands/vault';
import { parseKeyringName, retireKeys, rotateKeys } from './commands/rotate-keys';
import type { KeyringName } from './keys';
import { pullLatest, refuseStaleMailService, update } from './commands/update';
import type { Ctx } from './context';
import { resolveCommand } from './exec';
import { FakeTransport } from './fake';
import { MIN_KIT_PASSPHRASE } from './kit';
import { REPO_ROOT, type EnvName } from './paths';
import type { MailProvider } from './state';
import {
  emptySecrets,
  emptyState,
  FileStateStore,
  MemoryStateStore,
  WINDOWS_PERMISSIONS_NOTE,
  type SecretsPassphrase,
  type StateStore,
} from './state';
import { signInLink } from './steps/bootstrap';
import { INSTALL_STEPS, runSteps } from './steps';
import { signIn } from './steps/login';
import { RealTransport, type Transport } from './transport';
import { Cancelled, clackPrompter, consoleUi, InstallError, noPrompter, type Ui } from './ui';

type CommandName =
  | 'restore'
  | 'install'
  | 'doctor'
  | 'update'
  | 'enable'
  | 'feature'
  | 'signin-link'
  | 'mail'
  | 'rotate-keys'
  | 'vault';

interface Options {
  command: CommandName;
  /** The file for `restore`; where `rotate-keys` writes the new kit (--kit). */
  kitPath?: string;
  keyring?: KeyringName;
  /** `rotate-keys --retire`: remove the older keys. */
  retire: boolean;
  feature?: FeatureName;
  featureCommand?: FeatureCommand;
  mailCommand?: MailCommand;
  env: EnvName;
  dryRun: boolean;
  yes: boolean;
  answers?: string;
  skipPull: boolean;
  /** `update --link-keys=verify-only`: stop the link cutover after its first pass. */
  holdLinkCutover: boolean;
  /** `vault --write-format` / `--legacy-open` / `--force`. */
  vaultCommand?: VaultCommand;
  help: boolean;
}

const USAGE = `Usage: pnpm swarm [command] [options]

Commands:
  install                 Set up Swarm on your Cloudflare account (the default)
  doctor                  Check an install and say how to fix what is wrong
  update                  Pull the latest version and deploy it
  enable <feature>        Turn on custom-domains, payments, google or debounce
  feature list            Show which features are on
  feature <key> on|off    Turn one feature on or off for this Swarm
  signin-link             Make a new one-time sign-in link for the owner
  restore <kit>           Set up this computer from a recovery kit
  mail switch <service>   Start changing email service; your current one keeps sending
  mail status             See which new records are published, and what's missing
  mail cutover            Move email to the new service
  mail rollback           Go back to the old service
  mail cancel             Drop a change that hasn't moved yet
  mail finish             Remove the old service, 14 days after moving
  rotate-keys <KEYRING>   A new key for one keyring (docs/self-hosting.md lists them); the
                          old one keeps verifying
  rotate-keys <KEYRING> --retire
                          Remove the old key, once nothing that still matters needs it
  vault                   How the vault seals, and how far its re-seal got
  vault --write-format v3 Seal new values in the row-bound format (a week on the vault and every
                          worker healthy first; --force skips that, with a warning)
  vault --legacy-open off Stop opening the older formats, once the re-seal has finished with no
                          value left unread

Options:
  --env production|staging   Which environment (default: production)
  --dry-run                  Show every action without changing anything
  --answers <file.json>      Answer the questions from a file (non-interactive)
  --yes                      Accept the defaults without asking
  --kit <file.json>          Where rotate-keys writes the new recovery kit
  --link-keys=verify-only    update: give every worker the per-link keys, but keep signing
                             links the old way (run update again to finish)
  --help                     Show this help`;

type MailCommand =
  | { action: 'switch'; provider: MailProvider }
  | { action: 'status' | 'cutover' | 'rollback' | 'cancel' | 'finish' };

const MAIL_SERVICES: readonly MailProvider[] = ['ses', 'resend', 'mailgun', 'postmark', 'smtp'];

function parseMailArgs(args: string[]): MailCommand {
  const [action, provider] = args;
  if (action === 'switch') {
    if (!MAIL_SERVICES.includes(provider as MailProvider)) {
      throw new InstallError(
        'Say which service to change to: ses, resend, mailgun, postmark or smtp.',
        'For example: pnpm swarm mail switch resend',
      );
    }
    return { action, provider: provider as MailProvider };
  }
  if (
    action === 'status' ||
    action === 'cutover' ||
    action === 'rollback' ||
    action === 'cancel' ||
    action === 'finish'
  ) {
    return { action };
  }
  throw new InstallError(
    'Say what to do: switch, status, cutover, rollback, cancel or finish.',
    'Run `pnpm swarm --help`.',
  );
}

async function runMail(ctx: Ctx, command: MailCommand) {
  if (!ctx.state.zone || !ctx.state.choices) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in .swarm/.`,
      'Restore your recovery kit with `pnpm swarm restore` first.',
    );
  }
  await signIn(ctx);
  await refuseStaleMailService(ctx);
  switch (command.action) {
    case 'switch':
      return prepareSwitch(ctx, command.provider);
    case 'status': {
      const readiness = await switchStatus(ctx);
      const warnings = cutOverWarnings(readiness);
      ctx.ui.note(
        warnings.length ? 'Not everything is ready' : 'Everything is ready',
        warnings.join('\n') || 'Move over with `pnpm swarm mail cutover`.',
      );
      return;
    }
    case 'cutover':
      return cutOver(ctx, { acknowledged: ctx.yes });
    case 'rollback':
      return rollBack(ctx);
    case 'cancel':
      return cancelSwitch(ctx);
    case 'finish':
      return finishSwitch(ctx, { force: ctx.yes });
  }
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'install',
    env: 'production',
    dryRun: false,
    yes: false,
    skipPull: false,
    holdLinkCutover: false,
    help: false,
    retire: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new InstallError(`${arg} needs a value.`, USAGE);
      return next;
    };
    if (arg === '--') continue;
    else if (arg === '--env') {
      const env = value();
      if (env !== 'production' && env !== 'staging')
        throw new InstallError(`--env must be production or staging, not "${env}".`);
      options.env = env;
    } else if (arg.startsWith('--env=')) {
      const env = arg.slice(6);
      if (env !== 'production' && env !== 'staging')
        throw new InstallError(`--env must be production or staging, not "${env}".`);
      options.env = env;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--answers') options.answers = value();
    else if (arg.startsWith('--answers=')) options.answers = arg.slice(10);
    else if (arg === '--skip-pull') options.skipPull = true;
    else if (arg === '--link-keys=verify-only') options.holdLinkCutover = true;
    else if (arg === '--retire') options.retire = true;
    else if (arg === '--kit') options.kitPath = value();
    else if (arg === '--write-format' || arg.startsWith('--write-format=')) {
      const format = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : value();
      if (format !== 'v3' && format !== 'legacy')
        throw new InstallError(`--write-format is v3 or legacy, not "${format}".`);
      options.vaultCommand = { force: false, ...options.vaultCommand, writeFormat: format };
    } else if (arg === '--legacy-open' || arg.startsWith('--legacy-open=')) {
      const open = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : value();
      if (open !== 'on' && open !== 'off')
        throw new InstallError(`--legacy-open is on or off, not "${open}".`);
      options.vaultCommand = { force: false, ...options.vaultCommand, legacyOpen: open };
    } else if (arg === '--force') {
      options.vaultCommand = { ...options.vaultCommand, force: true };
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-'))
      throw new InstallError(`Unknown option ${arg}.`, 'Run `pnpm swarm --help` for the options.');
    else positional.push(arg);
  }
  const [command, feature, extra] = positional;
  if (command) {
    if (
      ![
        'install',
        'doctor',
        'update',
        'enable',
        'feature',
        'signin-link',
        'restore',
        'mail',
        'rotate-keys',
        'vault',
      ].includes(command)
    ) {
      throw new InstallError(
        `Unknown command "${command}".`,
        'Run `pnpm swarm --help` for the commands.',
      );
    }
    options.command = command as CommandName;
  }
  if (options.command === 'restore' && feature) options.kitPath = feature;
  if (options.vaultCommand && options.command !== 'vault')
    throw new InstallError(
      '--write-format, --legacy-open and --force are for vault.',
      'Run `pnpm swarm --help`.',
    );
  if (options.holdLinkCutover && options.command !== 'update')
    throw new InstallError('--link-keys is for update.', 'Run `pnpm swarm --help`.');
  if ((options.retire || options.kitPath) && !['rotate-keys', 'restore'].includes(options.command))
    throw new InstallError('--retire and --kit are for rotate-keys.', 'Run `pnpm swarm --help`.');
  if (options.command === 'rotate-keys') {
    if (!options.help) options.keyring = parseKeyringName(feature);
    if (extra)
      throw new InstallError(`Unexpected argument "${extra}".`, 'Run `pnpm swarm --help`.');
  } else if (options.command === 'restore') {
    if (extra)
      throw new InstallError(`Unexpected argument "${extra}".`, 'Run `pnpm swarm --help`.');
  } else if (options.command === 'enable') {
    if (!feature || !(FEATURES as readonly string[]).includes(feature)) {
      throw new InstallError(
        'Say what to enable: custom-domains, payments, google or debounce.',
        'For example: pnpm swarm enable payments',
      );
    }
    options.feature = feature as FeatureName;
  } else if (options.command === 'mail') {
    if (!options.help) options.mailCommand = parseMailArgs(positional.slice(1));
  } else if (options.command === 'feature') {
    // --help reads the usage, so a bare `feature --help` is not an error.
    if (!options.help) options.featureCommand = parseFeatureArgs(positional.slice(1));
  } else if (feature || extra) {
    throw new InstallError(
      `Unexpected argument "${feature ?? extra}".`,
      'Run `pnpm swarm --help`.',
    );
  }
  return options;
}

/**
 * The secrets file's passphrase, asked for at most once per run: SWARM_SECRETS_PASSPHRASE, or the
 * terminal (even for `update` and --answers runs, which ask nothing else). `known` hands it to the
 * `update` that runs again after `git pull`, so that one doesn't ask a second time.
 */
export function secretsPassphrase(
  prompts: Ui['prompts'] | null,
  fromEnv = process.env.SWARM_SECRETS_PASSPHRASE,
): SecretsPassphrase & { known(): string | undefined } {
  let known = fromEnv || undefined;
  const ask: SecretsPassphrase = async (mode, file) => {
    if (known !== undefined) return known;
    if (!prompts) {
      throw new InstallError(
        `${file} is kept encrypted under a passphrase, and this run has no terminal to ask for it.`,
        'Set SWARM_SECRETS_PASSPHRASE for this command, or run it in a terminal.',
      );
    }
    if (mode === 'open') {
      known = await prompts.password({ message: `The passphrase for ${file}` });
      return known;
    }
    for (;;) {
      const first = await prompts.password({
        message: `Choose a passphrase to encrypt ${file} (at least ${MIN_KIT_PASSPHRASE} characters). Keep it apart from your backups: without it the keys can't be read`,
        validate: (value) =>
          value.length < MIN_KIT_PASSPHRASE
            ? `At least ${MIN_KIT_PASSPHRASE} characters.`
            : undefined,
      });
      const again = await prompts.password({ message: 'The same passphrase again' });
      if (first === again) {
        known = first;
        return known;
      }
    }
  };
  return Object.assign(ask, { known: () => known });
}

interface CreateOptions {
  options: Options;
  root?: string;
  transport?: Transport;
  store?: StateStore;
  ui?: Ui;
  answers?: Answers;
  /** For the files in .swarm/ (when no store is given). */
  passphrase?: SecretsPassphrase;
}

/** Builds the run context: real or recorded side effects, files or memory, prompts or answers. */
export async function createContext(create: CreateOptions): Promise<Ctx> {
  const { options } = create;
  const root = create.root ?? REPO_ROOT;
  const answers = create.answers ?? (options.answers ? await loadAnswers(options.answers) : {});
  const interactive =
    !options.answers &&
    !create.answers &&
    process.stdin.isTTY === true &&
    options.command !== 'update';
  const ui = create.ui ?? consoleUi(interactive ? clackPrompter : noPrompter);

  let store = create.store;
  if (!store) {
    const restrict = ownerOnly();
    const files = new FileStateStore(root, {
      passphrase:
        create.passphrase ?? secretsPassphrase(process.stdin.isTTY ? clackPrompter : null),
      ...(restrict ? { restrict } : {}),
      warn: (message) => ui.warn(message),
    });
    store = options.dryRun ? new MemoryStateStore(await files.load(options.env)) : files;
  }
  const loaded = await store.load(options.env);
  const transport =
    create.transport ??
    (options.dryRun
      ? new FakeTransport({
          ...((answers.zone ?? loaded.state?.zone?.name)
            ? { zone: answers.zone ?? loaded.state?.zone?.name }
            : {}),
          environment: options.env,
          onAction: (line) => ui.detail(`> ${line}`),
        })
      : new RealTransport());

  return {
    root,
    env: options.env,
    dryRun: options.dryRun,
    yes: options.yes,
    interactive,
    t: transport,
    ui,
    store,
    state: loaded.state ?? emptyState(options.env),
    secrets: loaded.secrets ?? emptySecrets(),
    answers,
    session: {},
    report: { unhealthy: [] },
    ...(options.holdLinkCutover ? { holdLinkCutover: true } : {}),
  };
}

/** Runs the new code after `git pull`: the process that pulled still has the old modules loaded. */
async function updateAfterPull(
  ctx: Ctx,
  options: Options,
  passphrase: string | undefined,
): Promise<number> {
  await pullLatest(ctx);
  if (ctx.dryRun) {
    await update(ctx);
    return 0;
  }
  const args = [
    'swarm',
    'update',
    '--skip-pull',
    '--env',
    options.env,
    ...(options.yes ? ['--yes'] : []),
    ...(options.holdLinkCutover ? ['--link-keys=verify-only'] : []),
  ];
  const { spawn } = await import('node:child_process');
  const { file, prefix, shell } = resolveCommand('pnpm');
  return new Promise((resolve) => {
    const child = spawn(file, [...prefix, ...args], {
      cwd: ctx.root,
      stdio: 'inherit',
      shell,
      env: { ...process.env, ...(passphrase ? { SWARM_SECRETS_PASSPHRASE: passphrase } : {}) },
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export async function main(argv: string[]): Promise<number> {
  let ui = consoleUi(noPrompter);
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
    const passphrase = secretsPassphrase(process.stdin.isTTY ? clackPrompter : null);
    // Read once; wrangler, git and the other tools this run starts don't need it.
    delete process.env.SWARM_SECRETS_PASSPHRASE;
    const ctx = await createContext({ options, passphrase });
    ui = ctx.ui;
    ui.info(
      `Swarm ${options.command}${options.feature ? ` ${options.feature}` : ''} (${options.env})${options.dryRun ? ', dry run: nothing is changed' : ''}`,
    );
    if (options.dryRun) ui.info('Every action is listed with ">"; the ids are made up.');
    switch (options.command) {
      case 'install':
        if (process.platform === 'win32' && !options.dryRun) ui.info(WINDOWS_PERMISSIONS_NOTE);
        await runSteps(ctx, INSTALL_STEPS);
        return 0;
      case 'doctor':
        return (await doctor(ctx)) ? 0 : 1;
      case 'update':
        if (options.skipPull) {
          await update(ctx);
          return 0;
        }
        return await updateAfterPull(ctx, options, passphrase.known());
      case 'enable':
        await enable(ctx, options.feature as FeatureName);
        return 0;
      case 'feature':
        await runFeature(ctx, options.featureCommand as FeatureCommand);
        return 0;
      case 'restore':
        await restoreKit(ctx, options.kitPath);
        return 0;
      case 'mail':
        await runMail(ctx, options.mailCommand as MailCommand);
        return 0;
      case 'rotate-keys': {
        const keyring = options.keyring as KeyringName;
        if (options.retire) await retireKeys(ctx, keyring, { kitPath: options.kitPath });
        else await rotateKeys(ctx, keyring, { kitPath: options.kitPath });
        return 0;
      }
      case 'vault':
        await vault(ctx, options.vaultCommand ?? { force: false });
        return 0;
      case 'signin-link': {
        await signIn(ctx);
        const link = await signInLink(ctx);
        ui.note('Sign in (works once, for 60 minutes)', link);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof Cancelled) {
      ui.info(
        '\nStopped. Everything finished so far is saved; run the same command again to continue.',
      );
      return 130;
    }
    if (error instanceof InstallError) {
      ui.error(error.message, error.fix);
      return 1;
    }
    ui.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      'This looks like a bug in the installer. Run the same command again; finished steps are skipped. If it repeats, open an issue with this output.',
    );
    return 1;
  }
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
