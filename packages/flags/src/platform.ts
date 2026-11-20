// Platform-scope rows: what the person running this Swarm chose, for everyone on it. The installer,
// the instance routes and `pnpm swarm feature` all write through here. These read and write D1
// directly, past FlagService's cache, so a screen shows what was saved; the gates catch up when
// their cached copy expires (at most 60 seconds).
import { FEATURES_OFF_AT_INSTALL, SWITCHABLE_FLAG_KEYS, type FlagKey } from './registry';

export interface PlatformFeature {
  key: FlagKey;
  /** No row reads as off, as it does in resolveFlags. */
  enabled: boolean;
  /** Null when the installer or the command line wrote the row, or there is no row. */
  updatedBy: string | null;
  /** Null when there is no row yet. */
  updatedAt: number | null;
}

/** Every switchable feature in registry order, with or without a row. */
export async function listPlatformFeatures(db: D1Database): Promise<PlatformFeature[]> {
  const { results } = await db
    .prepare(
      `SELECT key, enabled, updated_by AS updatedBy, updated_at AS updatedAt
         FROM feature_flags WHERE scope = 'platform'`,
    )
    .all<{ key: string; enabled: number; updatedBy: string | null; updatedAt: number }>();
  const rows = new Map(results.map((row) => [row.key, row]));
  return SWITCHABLE_FLAG_KEYS.map((key) => {
    const row = rows.get(key);
    return {
      key,
      enabled: row?.enabled === 1,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Stores a choice. Off is a row with enabled = 0, never a missing row: applyInstallDefaults fills
 * in missing rows, so deleting one would turn the feature back on at the next update. The conflict
 * target repeats the unique index's expression, because scope_id is NULL at this scope.
 */
export async function setPlatformFeature(
  db: D1Database,
  input: { id: string; key: FlagKey; enabled: boolean; updatedBy: string | null; now: number },
): Promise<PlatformFeature> {
  await db
    .prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_by, updated_at)
       VALUES (?1, ?2, 'platform', NULL, ?3, ?4, ?5)
       ON CONFLICT (key, scope, ifnull(scope_id, '')) DO UPDATE SET
         enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.key, input.enabled ? 1 : 0, input.updatedBy, input.now)
    .run();
  return {
    key: input.key,
    enabled: input.enabled,
    updatedBy: input.updatedBy,
    updatedAt: input.now,
  };
}

/**
 * What a new install starts with: every switchable feature on, except FEATURES_OFF_AT_INSTALL.
 * Writes only the rows that are missing, so a re-run or an update never changes a choice. One
 * statement per flag: D1 allows 100 bound parameters in one statement, and this reports each row.
 */
export async function applyInstallDefaults(
  db: D1Database,
  options: { newId: () => string; now: number },
): Promise<{ added: FlagKey[] }> {
  const results = await db.batch(
    SWITCHABLE_FLAG_KEYS.map((key) =>
      db
        .prepare(
          `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_by, updated_at)
           VALUES (?1, ?2, 'platform', NULL, ?3, NULL, ?4)
           ON CONFLICT DO NOTHING`,
        )
        .bind(options.newId(), key, FEATURES_OFF_AT_INSTALL.includes(key) ? 0 : 1, options.now),
    ),
  );
  return { added: SWITCHABLE_FLAG_KEYS.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0) };
}
