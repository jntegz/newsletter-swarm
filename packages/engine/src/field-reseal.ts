// Sealing stored FIELD_KEYS values again, place by place (packages/domain/src/sealed-columns.ts).
// One walker serves both re-seals: the rotation one in the jobs worker (each value sealed again with
// the current key, in its own format; workers/jobs/src/handlers/field-keys.ts) and the vault's
// cron, which also moves values to the row-bound v3 format (workers/vault). A bounded number of
// rows of each place is read in primary-key order, and the place reached is kept in
// field_key_reseal under the target's name: a failed or timed-out run loses at most its last
// batch, and the next one continues from there. A value is replaced only if it is still the one
// that was read, so a write in between is never undone, and progress moves only from the place
// this run read: two runners on one target never skip each other's rows.
import { FIELD_SEALED_COLUMNS, sealedValueSql, type SealedColumn } from '@swarm/domain';
import { all, first, run } from './db';

/** What a target does with one stored value. */
export type ResealOutcome = { sealed: string } | 'current' | 'unreadable';

export interface ResealTarget {
  /** The progress row (field_key_reseal.kid): the key id for a rotation, `v3:<kid>` for the vault. */
  name: string;
  /** SQL for extra columns the target needs per row (`AS` names), e.g. a v3 row binding. */
  extraColumns?(place: SealedColumn): string | null;
  reseal(place: SealedColumn, sealed: string, row: Record<string, unknown>): Promise<ResealOutcome>;
}

export interface ResealRun {
  target: string;
  resealed: number;
  unreadable: number;
  finished: boolean;
}

interface Progress {
  place: string | null;
  after_key: string | null;
  finished_at: number | null;
}

const placeName = (place: SealedColumn) => `${place.table}.${place.column}`;

async function resealBatch(
  db: D1Database,
  target: ResealTarget,
  place: SealedColumn,
  after: unknown[] | null,
  size: number,
) {
  const keyList = place.key.join(', ');
  const from = after
    ? `WHERE (${keyList}) > (${place.key.map((_, i) => `?${i + 2}`).join(', ')})`
    : '';
  const extra = target.extraColumns?.(place);
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT ${keyList}, ${sealedValueSql(place)} AS sealed${extra ? `, ${extra}` : ''}
       FROM ${place.table} ${from} ORDER BY ${keyList} LIMIT ?1`,
    size,
    ...(after ?? []),
  );
  const updates: { k: unknown[]; o: string; n: string }[] = [];
  let unreadable = 0;
  for (const row of rows) {
    if (typeof row.sealed !== 'string' || !row.sealed) continue;
    const result = await target.reseal(place, row.sealed, row);
    if (result === 'unreadable') unreadable++;
    else if (result !== 'current') {
      updates.push({ k: place.key.map((k) => row[k]), o: row.sealed, n: result.sealed });
    }
  }
  let resealed = 0;
  if (updates.length) {
    const set = place.jsonPath ? `json_set(${place.column}, '${place.jsonPath}', u.n)` : 'u.n';
    const match = place.key.map((k, i) => `${place.table}.${k} = u.k${i}`).join(' AND ');
    const columns = place.key.map((_, i) => `json_extract(value, '$.k[${i}]') AS k${i}`).join(', ');
    const result = await run(
      db,
      `UPDATE ${place.table} SET ${place.column} = ${set}
         FROM (SELECT ${columns}, json_extract(value, '$.o') AS o, json_extract(value, '$.n') AS n
                 FROM json_each(?1)) AS u
        WHERE ${match} AND ${sealedValueSql(place, place.table)} = u.o`,
      JSON.stringify(updates),
    );
    resealed = result.meta.changes ?? 0;
  }
  const last = rows.at(-1);
  return {
    resealed,
    unreadable,
    next: rows.length < size || !last ? null : place.key.map((k) => last[k]),
  };
}

/**
 * One run's share of a target: up to `batches` batches of `batchSize` rows. Null when the target
 * has walked every place already.
 */
export async function resealSealedColumns(
  db: D1Database,
  target: ResealTarget,
  now: number,
  options: { batchSize?: number; batches?: number; places?: readonly SealedColumn[] } = {},
): Promise<ResealRun | null> {
  const places = options.places ?? FIELD_SEALED_COLUMNS;
  const size = options.batchSize ?? 200;
  const batches = options.batches ?? 5;
  await run(
    db,
    `INSERT INTO field_key_reseal (kid, place, started_at, updated_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT (kid) DO NOTHING`,
    target.name,
    placeName(places[0] as SealedColumn),
    now,
  );
  const progress = await first<Progress>(
    db,
    'SELECT place, after_key, finished_at FROM field_key_reseal WHERE kid = ?1',
    target.name,
  );
  if (!progress || progress.finished_at !== null) return null;

  let index = places.findIndex((place) => placeName(place) === progress.place);
  let readPlace = progress.place;
  let readAfter = progress.after_key;
  let after = index === -1 || !readAfter ? null : (JSON.parse(readAfter) as unknown[]);
  if (index === -1) index = 0;
  let resealed = 0;
  let unreadable = 0;
  let raced = false;
  for (let batch = 0; batch < batches && index < places.length; batch++) {
    const place = places[index] as SealedColumn;
    const done = await resealBatch(db, target, place, after, size);
    resealed += done.resealed;
    unreadable += done.unreadable;
    after = done.next;
    if (!after) index++;
    const next = places[index];
    const nextPlace = next ? placeName(next) : null;
    const nextAfter = after ? JSON.stringify(after) : null;
    const moved = await run(
      db,
      `UPDATE field_key_reseal SET place = ?2, after_key = ?3, resealed = resealed + ?4,
              unreadable = unreadable + ?5, updated_at = ?6, finished_at = ?7
        WHERE kid = ?1 AND place IS ?8 AND after_key IS ?9 AND finished_at IS NULL`,
      target.name,
      nextPlace,
      nextAfter,
      done.resealed,
      done.unreadable,
      now,
      next ? null : now,
      readPlace,
      readAfter,
    );
    // Another runner moved first: its progress stands, and this one stops for now.
    if ((moved.meta.changes ?? 0) === 0) {
      raced = true;
      break;
    }
    readPlace = nextPlace;
    readAfter = nextAfter;
  }
  return {
    target: target.name,
    resealed,
    unreadable,
    finished: !raced && index >= places.length,
  };
}
