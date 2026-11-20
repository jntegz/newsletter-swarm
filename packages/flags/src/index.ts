import { FLAG_KEYS, isFlagKey, type FlagKey } from './registry';

export * from './platform';
export * from './registry';

type FlagScopeKind = 'platform' | 'workspace' | 'channel';

export interface FlagOverride {
  key: string;
  scope: FlagScopeKind;
  scopeId: string | null;
  enabled: boolean;
}

export interface FlagContext {
  workspaceId?: string | undefined;
  channelId?: string | undefined;
}

interface FlagStore {
  /** Overrides for the platform plus the given workspace and channel. */
  load(context: FlagContext): Promise<FlagOverride[]>;
}

export type FlagValues = Record<FlagKey, boolean>;

const PRECEDENCE: Record<FlagScopeKind, number> = { platform: 0, workspace: 1, channel: 2 };

/**
 * Every flag defaults to off. Overrides apply in order platform → workspace → channel,
 * so the most specific scope wins. Overrides for unknown (dropped) keys are ignored.
 */
export function resolveFlags(overrides: readonly FlagOverride[], context: FlagContext): FlagValues {
  const values = Object.fromEntries(FLAG_KEYS.map((key) => [key, false])) as FlagValues;
  const applicable = overrides
    .filter((o) => isFlagKey(o.key))
    .filter(
      (o) =>
        o.scope === 'platform' ||
        (o.scope === 'workspace' && o.scopeId === context.workspaceId) ||
        (o.scope === 'channel' && o.scopeId === context.channelId),
    )
    .sort((a, b) => PRECEDENCE[a.scope] - PRECEDENCE[b.scope]);
  for (const override of applicable) values[override.key as FlagKey] = override.enabled;
  return values;
}

export class FlagService {
  constructor(private readonly store: FlagStore) {}

  async all(context: FlagContext = {}): Promise<FlagValues> {
    return resolveFlags(await this.store.load(context), context);
  }

  async enabled(key: FlagKey, context: FlagContext = {}): Promise<boolean> {
    return (await this.all(context))[key];
  }
}

const CACHE_TTL_SECONDS = 60;

/** D1-backed store with a 60-second KV read-through cache. */
export class D1FlagStore implements FlagStore {
  constructor(
    private readonly db: D1Database,
    private readonly cache?: KVNamespace,
  ) {}

  async load(context: FlagContext): Promise<FlagOverride[]> {
    const cacheKey = `flags:v1:${context.workspaceId ?? '-'}:${context.channelId ?? '-'}`;
    if (this.cache) {
      const cached = await this.cache.get<FlagOverride[]>(cacheKey, 'json');
      if (cached) return cached;
    }

    const { results } = await this.db
      .prepare(
        `SELECT key, scope, scope_id AS scopeId, enabled FROM feature_flags
         WHERE scope = 'platform'
            OR (scope = 'workspace' AND scope_id = ?1)
            OR (scope = 'channel' AND scope_id = ?2)`,
      )
      .bind(context.workspaceId ?? null, context.channelId ?? null)
      .all<{ key: string; scope: FlagScopeKind; scopeId: string | null; enabled: number }>();

    const overrides = results.map((row) => ({ ...row, enabled: row.enabled === 1 }));
    if (this.cache) {
      await this.cache.put(cacheKey, JSON.stringify(overrides), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    }
    return overrides;
  }
}
