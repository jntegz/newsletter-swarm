// `pnpm swarm feature`: the same switches as Settings > Instance, for the install on record in
// .swarm/. Not to be confused with `enable`, which connects outside services and redeploys.
import { newId } from '@swarm/domain';
import { listPlatformFeatures, setPlatformFeature } from '@swarm/flags/platform';
import {
  FEATURES_WITHOUT_A_GATE,
  isFlagKey,
  isSwitchableFlag,
  type FlagKey,
} from '@swarm/flags/registry';
import { database, type Ctx } from '../context';
import { asD1Database } from '../d1';
import { signIn } from '../steps/login';
import { InstallError } from '../ui';

export type FeatureCommand = { action: 'list' } | { action: 'set'; key: FlagKey; enabled: boolean };

const USAGE = 'Run `pnpm swarm feature list` for the features you can change.';
const DELAY =
  'A change can take up to a minute to reach everyone, and up to six minutes on website pages that are already stored.';
const PAID = 'Copilot uses a paid AI service.';
const NO_GATE = 'Nothing checks this one: the plain subscribe form always works.';
const isCopilot = (key: FlagKey) => key.startsWith('copilot');

/** The words after `feature`. */
export function parseFeatureArgs(args: string[]): FeatureCommand {
  const [first, state, extra] = args;
  if (!first) {
    throw new InstallError('Say which feature, and on or off.', USAGE);
  }
  if (extra !== undefined) {
    throw new InstallError(`Unexpected argument "${extra}".`, 'Run `pnpm swarm --help`.');
  }
  if (first === 'list') {
    if (state !== undefined) {
      throw new InstallError(`Unexpected argument "${state}".`, 'Run `pnpm swarm --help`.');
    }
    return { action: 'list' };
  }
  if (!isFlagKey(first)) throw new InstallError(`There is no feature called "${first}".`, USAGE);
  if (!isSwitchableFlag(first)) {
    throw new InstallError(`"${first}" is not built yet, so it cannot be turned on or off.`, USAGE);
  }
  if (state !== 'on' && state !== 'off') {
    throw new InstallError(
      `Say on or off for ${first}.`,
      `For example: pnpm swarm feature ${first} off`,
    );
  }
  return { action: 'set', key: first, enabled: state === 'on' };
}

function db(ctx: Ctx) {
  return asD1Database(database(ctx));
}

function requireDatabase(ctx: Ctx) {
  if (!ctx.state.resources.d1) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in .swarm/.`,
      'Run `pnpm swarm` to install first.',
    );
  }
}

function listLine(key: FlagKey, enabled: boolean, stored: boolean): string {
  const notes = [
    stored ? null : 'not set yet: `pnpm swarm update` sets it',
    isCopilot(key) ? 'uses a paid AI service' : null,
    FEATURES_WITHOUT_A_GATE.includes(key) ? 'always works, whatever this says' : null,
  ].filter(Boolean);
  return `${enabled ? 'on ' : 'off'}  ${key}${notes.length ? `  (${notes.join('; ')})` : ''}`;
}

export async function runFeature(ctx: Ctx, command: FeatureCommand) {
  requireDatabase(ctx);
  await signIn(ctx);
  if (command.action === 'list') {
    const features = await ctx.ui.task('Reading the features', () => listPlatformFeatures(db(ctx)));
    for (const f of features) ctx.ui.info(listLine(f.key, f.enabled, f.updatedAt !== null));
    ctx.ui.info(`\nChange one with \`pnpm swarm feature <key> on|off\`. ${DELAY}`);
    return;
  }
  const { key, enabled } = command;
  const state = enabled ? 'on' : 'off';
  await ctx.ui.task(`Turning ${key} ${state}`, () =>
    setPlatformFeature(db(ctx), {
      id: newId('featureFlag'),
      key,
      enabled,
      updatedBy: null,
      now: Date.now(),
    }),
  );
  ctx.ui.info(`${key} is ${state}. ${DELAY}`);
  if (enabled && isCopilot(key)) ctx.ui.info(PAID);
  if (FEATURES_WITHOUT_A_GATE.includes(key)) ctx.ui.info(NO_GATE);
}
