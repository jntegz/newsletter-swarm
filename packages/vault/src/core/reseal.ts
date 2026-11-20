/**
 * The vault's cron share of re-sealing stored values, on the walker the jobs worker also uses
 * (@swarm/engine resealSealedColumns):
 * - VAULT_WRITE_FORMAT=v3: every value not yet v3 under the current key is opened (any format,
 *   while VAULT_LEGACY_OPEN is on) and sealed again as v3 for its own row. The row binding is read
 *   from the row's columns (sealing.ts COLUMN_SPECS), never from the plaintext. Progress is kept
 *   under `v3:<kid>`.
 * - VAULT_WRITE_FORMAT=legacy: after a FIELD_KEYS rotation, values on an older key are sealed again
 *   with the current one in their own format, under the key id: the same target, and so the same
 *   progress row, as the jobs worker's, which stays until callers stop holding FIELD_KEYS.
 * A value that will not open is left in place and counted as unreadable, never deleted.
 */
import {
  isSealedV3,
  resealSealedColumns,
  resealWithCurrentKey,
  sealedKeyId,
  sealV3,
  sealedBinding,
  type ResealRun,
} from '@swarm/engine';
import type { VaultContext } from './context';
import {
  assertColumnSpecs,
  bindingColumnsSql,
  bindingFromRow,
  columnSpec,
  openValue,
  SEALED_KINDS,
} from './sealing';

export async function resealToCurrent(ctx: VaultContext): Promise<ResealRun | null> {
  assertColumnSpecs();
  const keys = ctx.keys.field;
  if (ctx.config.writeFormat === 'legacy') {
    if (Object.keys(keys.keys).length < 2) return null;
    return resealSealedColumns(
      ctx.db,
      { name: keys.current, reseal: (_place, sealed) => resealWithCurrentKey(keys, sealed) },
      ctx.now(),
    );
  }
  return resealSealedColumns(
    ctx.db,
    {
      name: `v3:${keys.current}`,
      extraColumns: bindingColumnsSql,
      async reseal(place, sealed, row) {
        if (isSealedV3(sealed) && sealedKeyId(sealed) === keys.current) return 'current';
        const parts = bindingFromRow(place, row);
        if (!parts) return 'unreadable';
        const spec = columnSpec(place);
        const plain = await openValue(ctx, spec.kind, parts, sealed);
        if (plain === null) return 'unreadable';
        const purpose = SEALED_KINDS[spec.kind].purpose;
        return { sealed: await sealV3(keys, purpose, sealedBinding(parts), plain) };
      },
    },
    ctx.now(),
  );
}
