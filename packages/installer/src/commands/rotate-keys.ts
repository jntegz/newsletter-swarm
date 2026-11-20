// `pnpm swarm rotate-keys <KEYRING>`: a new signing key for one keyring, with the old one kept for
// verifying, on every worker that holds the ring, and a new recovery kit sealed with it.
// `--retire` later removes the old key, once nothing that still matters can need it.
// docs/self-hosting.md "Rotate keys" is the procedure.
import { resolve as resolvePath } from 'node:path';
import { FIELD_SEALED_COLUMNS, sealedWithOtherKeySql } from '@swarm/domain';
import { parseKeyring, publicKeyring, verifyKeysName } from '@swarm/tokens';
import { accountId, database, oauthApi, save, saveSecrets, type Ctx } from '../context';
import {
  KEYRING_NAMES,
  keyringEntry,
  newSecretFor,
  secretContext,
  secretNames,
  type KeyringName,
} from '../keys';
import { MIN_KIT_PASSPHRASE, sealKit } from '../kit';
import { DEPLOY_ORDER, scriptName, type Worker } from '../paths';
import { signIn } from '../steps/login';
import { InstallError } from '../ui';

const DAY_MS = 86_400_000;

/**
 * How long after a rotation something made with the old key must keep working: the longest
 * lifetime of what the ring signs (null: some of it never expires), from the key registry.
 */
function retireAfterMs(name: KeyringName): number | null {
  const days = keyringEntry(name).maxLinkLifetimeDays;
  return days === null ? null : days * DAY_MS;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseKeyringName(value: string | undefined): KeyringName {
  if (!value || !(KEYRING_NAMES as readonly string[]).includes(value)) {
    throw new InstallError(
      `Say which keyring to rotate: ${KEYRING_NAMES.join(', ')}.`,
      'For example: pnpm swarm rotate-keys TRACK_KEYS',
    );
  }
  return value as KeyringName;
}

/** The workers that hold this secret, as deploys give them their secrets. */
function holders(ctx: Ctx, secret: string): Worker[] {
  const context = secretContext(ctx.state, ctx.secrets);
  return DEPLOY_ORDER.filter((worker) => secretNames(worker, context).includes(secret));
}

/** Every worker that holds the keyring, its private or shared key or its public keys. */
function ringHolders(ctx: Ctx, name: KeyringName): Worker[] {
  const names = [name, ...(keyringEntry(name).alg === 'ed25519' ? [verifyKeysName(name)] : [])];
  return DEPLOY_ORDER.filter((worker) => names.some((n) => holders(ctx, n).includes(worker)));
}

async function push(ctx: Ctx, secret: string, text: string, what: string) {
  const cf = oauthApi(ctx);
  const account = accountId(ctx);
  for (const worker of holders(ctx, secret)) {
    const script = scriptName(worker, ctx.env);
    await ctx.ui.task(`${what} on ${script}`, () =>
      cf.put(`/accounts/${account}/workers/scripts/${script}/secrets`, {
        name: secret,
        text,
        type: 'secret_text',
      }),
    );
  }
}

/**
 * Pushes a keyring's text to the workers that sign with it, and for Ed25519 its public keys to
 * those that only verify, first: a verifier always has a key before anything is signed with it.
 */
async function pushRing(ctx: Ctx, name: KeyringName, text: string, what: string) {
  if (keyringEntry(name).alg === 'ed25519') {
    await push(ctx, verifyKeysName(name), await publicKeyring(name, text), what);
  }
  await push(ctx, name, text, what);
}

/** A key id not in the ring yet: k<yyyymmdd>, then k<yyyymmdd>b, c, … for more on one day. */
function freshKid(taken: Readonly<Record<string, string>>, now: number): string {
  const base = `k${day(now).replaceAll('-', '')}`;
  for (const suffix of ['', ...'bcdefghijklmnopqrstuvwxyz']) {
    if (!Object.hasOwn(taken, `${base}${suffix}`)) return `${base}${suffix}`;
  }
  throw new InstallError('This keyring was rotated too often today.', 'Try again tomorrow.');
}

/** Writes a new recovery kit with the keys as they are now, sealed under a passphrase. */
async function writeKit(ctx: Ctx, path: string | undefined, now: number) {
  const vars = process.env;
  const file = resolvePath(
    vars.INIT_CWD ?? process.cwd(),
    path ?? `swarm-recovery-kit-${ctx.env}-${day(now)}.json`,
  );
  let passphrase = vars.SWARM_KIT_PASSPHRASE;
  if (!passphrase) {
    if (!ctx.interactive) {
      throw new InstallError(
        'A new recovery kit is written before any worker gets the new key, and this run cannot ask for its passphrase.',
        'Set SWARM_KIT_PASSPHRASE for this command, or run it in a terminal.',
      );
    }
    for (;;) {
      const first = await ctx.ui.prompts.password({
        message: `Choose a passphrase for the new recovery kit (at least ${MIN_KIT_PASSPHRASE} characters)`,
        validate: (value) =>
          value.length < MIN_KIT_PASSPHRASE
            ? `At least ${MIN_KIT_PASSPHRASE} characters.`
            : undefined,
      });
      if (first === (await ctx.ui.prompts.password({ message: 'The same passphrase again' }))) {
        passphrase = first;
        break;
      }
    }
  }
  const kit = await sealKit({ state: ctx.state, secrets: ctx.secrets }, passphrase, {
    what: 'The recovery kit for your Swarm install, encrypted under the passphrase you chose. Keep the file and the passphrase apart. See the setup guide for when you need it.',
    createdAt: new Date(now).toISOString(),
    domain: ctx.state.zone?.name ?? null,
  });
  await ctx.t.writeFile(file, `${JSON.stringify(kit, null, 2)}\n`, { secret: true });
  return file;
}

function requireInstall(ctx: Ctx, name: KeyringName): string {
  const ring = ctx.secrets.keys[name];
  if (!ctx.state.zone || !ctx.state.choices) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in ${ctx.store.location}.`,
      'Restore your recovery kit with `pnpm swarm restore` first.',
    );
  }
  if (!ring) {
    throw new InstallError(
      `This install has no ${name} yet.`,
      '`pnpm swarm update` creates it and gives it to the workers that need it.',
    );
  }
  return ring;
}

function retireAdvice(name: KeyringName, oldKids: string[], at: number): string {
  const lifetime = retireAfterMs(name);
  const old = oldKids.join(', ');
  if (lifetime === null) {
    return [
      `Keep ${old} in ${name}. Unsubscribe links in mail already sent were made with it and never expire;`,
      'removing it would break them. Remove it only if it must stop working at once:',
      `pnpm swarm rotate-keys ${name} --retire --yes`,
    ].join('\n');
  }
  const when = day(at + lifetime);
  if (name === 'FIELD_KEYS') {
    return [
      'The jobs worker now encrypts stored values again with the new key, a few hundred rows a minute.',
      `When that is done, and not before ${when}, remove ${old}:`,
      `pnpm swarm rotate-keys ${name} --retire`,
      'It checks the database first and refuses while any value still needs the old key.',
    ].join('\n');
  }
  const lines = [
    `${old} still verifies what it signed. From ${when} nothing it signed is still valid; then remove it:`,
    `pnpm swarm rotate-keys ${name} --retire`,
  ];
  if (name === 'MEMBER_KEYS' || name === 'CAPTURE_KEYS') {
    lines.push(
      'The swarm_member reference a form passes to your own thank-you page changes for every subscriber,',
      'and a returning address may see a different signup journey variant.',
    );
  }
  return lines.join('\n');
}

/** Adds a new signing key to the ring, pushes it everywhere, and writes a new recovery kit. */
export async function rotateKeys(
  ctx: Ctx,
  name: KeyringName,
  options: { kitPath?: string | undefined; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const ring = requireInstall(ctx, name);
  if (name === 'MEMBER_KEYS' && ctx.state.linkKeys?.mode === 'v2') {
    throw new InstallError(
      'MEMBER_KEYS signs nothing any more. It only verifies links made before the switch to per-link keys, until they expire.',
      '`pnpm swarm update` removes it from each worker when that time is up; rotate the keyring that signs those links instead.',
    );
  }
  await signIn(ctx);
  const pending = ctx.state.keyRotations?.[name];
  if (!pending || pending.pushed) {
    const kid = freshKid(parseKeyring(ring).keys, now);
    const secret = await newSecretFor(name);
    // Saved before any worker has it, so a key a worker signs or seals with is never lost.
    ctx.secrets.keys[name] = `${kid}:${secret},${ring}`;
    ctx.state.keyRotations = { ...ctx.state.keyRotations, [name]: { kid, at: now, pushed: false } };
    await saveSecrets(ctx);
    await save(ctx);
  } else {
    ctx.ui.info(`Finishing the rotation of ${name} to ${pending.kid} that was started earlier.`);
  }
  const rotation = ctx.state.keyRotations?.[name] as { kid: string; at: number; pushed: boolean };
  const kit = await writeKit(ctx, options.kitPath, now);

  // First as a verify-only key on every worker, then as the signing key: no worker ever meets
  // something signed with a key it doesn't hold yet.
  const entries = (ctx.secrets.keys[name] as string).split(',');
  await pushRing(ctx, name, [...entries.slice(1), entries[0]].join(','), `Adding ${rotation.kid}`);
  await push(ctx, name, entries.join(','), `Signing with ${rotation.kid}`);
  rotation.pushed = true;
  await save(ctx);

  const oldKids = entries.slice(1).map((entry) => entry.slice(0, entry.indexOf(':')));
  ctx.ui.note(
    `${name} now signs with ${rotation.kid}`,
    [
      `Every worker that holds ${name} has the new key (${ringHolders(ctx, name).join(', ')}).`,
      `A new recovery kit is at ${kit}. Keep it, and its passphrase, in place of the old kit:`,
      'an older kit does not have the new key.',
      '',
      retireAdvice(name, oldKids, rotation.at),
    ].join('\n'),
  );
}

/** How many FIELD_KEYS values in the database are still sealed with a key other than `kid`. */
async function fieldValuesOnOlderKeys(ctx: Ctx, kid: string) {
  const db = database(ctx);
  const counts = await db.run(
    FIELD_SEALED_COLUMNS.map((place) => ({
      sql: `SELECT COUNT(*) AS n FROM ${place.table} WHERE ${sealedWithOtherKeySql(place)}`,
      params: [kid],
    })),
  );
  const remaining = counts.reduce((sum, set) => sum + Number(set.results[0]?.n ?? 0), 0);
  const [progress] =
    (
      await db.run([
        {
          sql: 'SELECT finished_at, unreadable FROM field_key_reseal WHERE kid = ?1',
          params: [kid],
        },
      ])
    )[0]?.results ?? [];
  return {
    db,
    remaining,
    finished: progress?.finished_at != null,
    unreadable: progress?.unreadable,
  };
}

/** Removes every key but the signing one, once nothing that still matters needs them. */
export async function retireKeys(
  ctx: Ctx,
  name: KeyringName,
  options: { kitPath?: string | undefined; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const ring = parseKeyring(requireInstall(ctx, name));
  const older = Object.keys(ring.keys).filter((kid) => kid !== ring.current);
  if (older.length === 0) {
    ctx.ui.info(`${name} has one key (${ring.current}); there is nothing to retire.`);
    return;
  }
  const rotation = ctx.state.keyRotations?.[name];
  if (rotation && !rotation.pushed) {
    throw new InstallError(
      `The rotation of ${name} to ${rotation.kid} has not reached every worker yet.`,
      `Run \`pnpm swarm rotate-keys ${name}\` to finish it first.`,
    );
  }
  const lifetime = retireAfterMs(name);
  if (!ctx.yes) {
    if (lifetime === null) {
      throw new InstallError(
        `Removing ${older.join(', ')} from ${name} breaks the unsubscribe links in every email already sent with it.`,
        'Keep it. If it must stop working anyway, run this again with --yes.',
      );
    }
    if (!rotation) {
      throw new InstallError(
        `There is no record of when ${name} was rotated, so the installer can't tell whether ${older.join(', ')} is still needed.`,
        'Run this again with --yes if you are sure.',
      );
    }
    if (now < rotation.at + lifetime) {
      throw new InstallError(
        `${older.join(', ')} may still be needed until ${day(rotation.at + lifetime)}.`,
        'Run this again after that date, or with --yes to remove it now and break what it signed.',
      );
    }
  }
  await signIn(ctx);
  if (name === 'FIELD_KEYS') {
    const check = await fieldValuesOnOlderKeys(ctx, ring.current);
    if (check.remaining > 0) {
      if (check.finished && !ctx.yes) {
        // Written on the old key after the jobs worker passed them: walk everything again.
        await check.db.run([
          { sql: 'DELETE FROM field_key_reseal WHERE kid = ?1', params: [ring.current] },
        ]);
      }
      if (!check.finished || !ctx.yes) {
        throw new InstallError(
          `${check.remaining} stored values are still encrypted with an older FIELD_KEYS key; removing it now would make them unreadable.`,
          check.finished
            ? `The jobs worker finished a pass, but ${check.unreadable ?? 0} values no key could open, and others may have been written since; it is going over them again. Run this again later. If only values no key opens are left, --yes removes the key anyway.`
            : 'The jobs worker is still encrypting them again with the new key. Run this again later.',
        );
      }
    }
  }
  const kept = `${ring.current}:${ring.keys[ring.current] as string}`;
  await pushRing(ctx, name, kept, `Removing ${older.join(', ')}`);
  ctx.secrets.keys[name] = kept;
  const rotations = { ...ctx.state.keyRotations };
  delete rotations[name];
  ctx.state.keyRotations = rotations;
  await saveSecrets(ctx);
  await save(ctx);
  const kit = await writeKit(ctx, options.kitPath, now);
  ctx.ui.note(
    `${name} has one key again (${ring.current})`,
    `Removed ${older.join(', ')} from every worker that holds ${name}. A new recovery kit is at ${kit}.`,
  );
}
