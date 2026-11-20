// `pnpm swarm vault`: the vault's rollout controls (docs/deployment.md "The vault").
//
//   pnpm swarm vault                       how the vault seals, and how far its re-seal got
//   pnpm swarm vault --write-format v3     seal every new value in the row-bound format
//   pnpm swarm vault --legacy-open off     stop opening values in the older formats
//
// v3 writes are a one-way door for rollbacks: code from before the vault can't read them. So the
// switch waits until every worker bound to the vault answers its health check (each answers 503
// while the vault doesn't answer it) and the install has run on the vault for VAULT_V3_AFTER_DAYS;
// --force goes ahead anyway, with a warning. Closing legacy opening waits for the re-seal: the
// field_key_reseal row `v3:<current kid>` finished, with no value it couldn't open. It has no
// --force: a value still in an older format would never open again.
import { parseKeyring } from '@swarm/tokens';
import { database, save, type Ctx } from '../context';
import { healthCheck } from '../steps/health';
import { writeConfigs } from '../steps/render';
import { deployAll } from '../steps/deploy';
import { signIn } from '../steps/login';
import { InstallError } from '../ui';

/** Days on the vault before v3 writes, unless --force. */
export const VAULT_V3_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

export interface VaultCommand {
  writeFormat?: 'legacy' | 'v3';
  legacyOpen?: 'on' | 'off';
  force: boolean;
}

interface ResealProgress {
  /** The progress row: `v3:<kid>` once writes are v3, else the current key id. */
  target: string;
  resealed: number;
  unreadable: number;
  finished: boolean;
}

interface VaultStatus {
  writeFormat: 'legacy' | 'v3';
  legacyOpen: boolean;
  /** When the vault was first deployed here (ms), if known. */
  since: number | null;
  reseal: ResealProgress | null;
}

const settings = (ctx: Ctx) => ({
  writeFormat: ctx.state.vault?.writeFormat ?? ('legacy' as const),
  legacyOpen: ctx.state.vault?.legacyOpen ?? true,
});

/** When the vault first went out here (recorded by the deploy step). */
const vaultSince = (ctx: Ctx): number | null => ctx.state.vault?.since ?? null;

/** The current FIELD_KEYS key id (only the vault holds FIELD_KEYS). */
function currentFieldKid(ctx: Ctx): string {
  const ring = ctx.secrets.keys.FIELD_KEYS;
  if (!ring) {
    throw new InstallError(
      'This computer has no FIELD_KEYS in .swarm/.',
      'Restore .swarm/ from your recovery kit (`pnpm swarm restore`).',
    );
  }
  return parseKeyring(ring).current;
}

/** The re-seal's progress row for `target`, from D1 (null before its first run). */
async function resealProgress(ctx: Ctx, target: string): Promise<ResealProgress | null> {
  const [set] = await database(ctx).run([
    {
      sql: 'SELECT resealed, unreadable, finished_at FROM field_key_reseal WHERE kid = ?1',
      params: [target],
    },
  ]);
  const row = set?.results[0];
  if (!row) return null;
  return {
    target,
    resealed: Number(row.resealed ?? 0),
    unreadable: Number(row.unreadable ?? 0),
    finished: row.finished_at !== null && row.finished_at !== undefined,
  };
}

export async function vaultStatus(ctx: Ctx): Promise<VaultStatus> {
  const { writeFormat, legacyOpen } = settings(ctx);
  const kid = currentFieldKid(ctx);
  const target = writeFormat === 'v3' ? `v3:${kid}` : kid;
  return {
    writeFormat,
    legacyOpen,
    since: vaultSince(ctx),
    reseal: await resealProgress(ctx, target),
  };
}

/** One line for doctor and the bare command. */
export function describeVault(status: VaultStatus, now: number): string {
  const parts = [
    `writes ${status.writeFormat === 'v3' ? 'the row-bound v3 format' : 'the legacy formats'}`,
    `legacy opening ${status.legacyOpen ? 'on' : 'off'}`,
  ];
  if (status.since !== null) {
    parts.push(`on the vault for ${Math.floor((now - status.since) / DAY_MS)} days`);
  }
  const r = status.reseal;
  if (r) {
    parts.push(
      `re-seal ${r.target}: ${r.resealed} sealed again, ${r.unreadable} unreadable${r.finished ? ', finished' : ', running'}`,
    );
  } else if (status.writeFormat === 'v3') {
    parts.push('re-seal not started yet');
  }
  return parts.join('; ');
}

/** What the operator can do next, if anything. */
export function nextVaultStep(status: VaultStatus, now: number): string | null {
  if (status.writeFormat === 'legacy') {
    const days = status.since === null ? 0 : (now - status.since) / DAY_MS;
    return days >= VAULT_V3_AFTER_DAYS
      ? 'When every worker is healthy, switch to row-bound writes: `pnpm swarm vault --write-format v3`.'
      : null;
  }
  const r = status.reseal;
  if (status.legacyOpen && r?.finished && r.unreadable === 0) {
    return 'Every stored value is row-bound now: `pnpm swarm vault --legacy-open off` closes the older formats.';
  }
  return null;
}

async function apply(ctx: Ctx, next: { writeFormat: 'legacy' | 'v3'; legacyOpen: boolean }) {
  ctx.state.vault = { ...ctx.state.vault, ...next };
  await save(ctx);
  // Only the vault reads these vars; its callers are not redeployed.
  await writeConfigs(ctx);
  await deployAll(ctx, ['vault']);
}

export async function vault(ctx: Ctx, command: VaultCommand, now = Date.now()): Promise<void> {
  await signIn(ctx);
  const current = settings(ctx);
  if (!command.writeFormat && !command.legacyOpen) {
    const status = await vaultStatus(ctx);
    ctx.ui.note('The vault', describeVault(status, now));
    const next = nextVaultStep(status, now);
    if (next) ctx.ui.info(next);
    return;
  }
  let writeFormat = current.writeFormat;
  let legacyOpen = current.legacyOpen;

  if (command.writeFormat === 'legacy' && current.writeFormat === 'v3') {
    throw new InstallError(
      'The vault already writes the row-bound format, and values written since need it.',
      'There is no going back to legacy writes; restore from a backup made before the switch if you must.',
    );
  }
  if (command.writeFormat === 'v3' && current.writeFormat !== 'v3') {
    const problems: string[] = [];
    const since = vaultSince(ctx);
    const days = since === null ? 0 : (now - since) / DAY_MS;
    if (days < VAULT_V3_AFTER_DAYS) {
      problems.push(
        since === null
          ? 'this install has no record of when the vault was first deployed'
          : `the vault has run here for ${Math.floor(days)} of ${VAULT_V3_AFTER_DAYS} days`,
      );
    }
    const unhealthy = await healthCheck(ctx, false);
    if (unhealthy.length) problems.push(`not healthy: ${unhealthy.join(', ')}`);
    if (problems.length && !command.force) {
      throw new InstallError(
        `Not switching to row-bound writes yet: ${problems.join('; ')}.`,
        `Once written, values can't be read by a release from before the vault, so rolling back past it loses them. Wait, check \`pnpm swarm doctor\`, or pass --force.`,
      );
    }
    if (problems.length) {
      ctx.ui.warn(
        `Switching to row-bound writes anyway (--force): ${problems.join('; ')}. A rollback to a release from before the vault can no longer read what is written from now on.`,
      );
    }
    writeFormat = 'v3';
  }

  if (command.legacyOpen === 'on') legacyOpen = true;
  if (command.legacyOpen === 'off' && current.legacyOpen) {
    if (writeFormat !== 'v3') {
      throw new InstallError(
        'The vault still writes the legacy formats, so it must keep opening them.',
        'Switch first: `pnpm swarm vault --write-format v3`, and let the re-seal finish.',
      );
    }
    const target = `v3:${currentFieldKid(ctx)}`;
    const progress = await resealProgress(ctx, target);
    if (!progress?.finished || progress.unreadable > 0) {
      throw new InstallError(
        !progress?.finished
          ? `The vault's re-seal (${target}) hasn't finished: values in the older formats are still stored.`
          : `The vault's re-seal (${target}) found ${progress.unreadable} values no key opens.`,
        !progress?.finished
          ? 'It runs every five minutes. Check progress with `pnpm swarm vault`, then try again.'
          : 'Put the key they were sealed with back into FIELD_KEYS and let the re-seal run again, or accept losing them (docs/self-hosting.md "Rotate keys").',
      );
    }
    legacyOpen = false;
  }

  if (writeFormat === current.writeFormat && legacyOpen === current.legacyOpen) {
    ctx.ui.info(`Nothing to change: the vault ${describeVault(await vaultStatus(ctx), now)}.`);
    return;
  }
  await apply(ctx, { writeFormat, legacyOpen });
  ctx.ui.info(
    `The vault now ${writeFormat === 'v3' ? 'writes the row-bound format' : 'writes the legacy formats'}, legacy opening ${legacyOpen ? 'on' : 'off'}.`,
  );
}
