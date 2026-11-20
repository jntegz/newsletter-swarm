/**
 * Full or teaser email for gated paid Dispatches (Phase 5).
 *
 * A Dispatch whose web visibility is 'paid' and whose content has a gate divider is rendered
 * twice per Broadcast: the full email for Members its Gate admits, and the teaser that stops at
 * the gate with "Continue reading on the web" for everyone else. Every other Dispatch is one
 * email for everyone ('members' Dispatches go only to Members, so they are always full).
 *
 * The Gate (`gates.level_ids_json`) names the Membership levels that read past the divider; an
 * empty list, or no Gate row, admits any paid level. Admission reads the `member_entitlements`
 * cache: a 'paid' row that has started and not expired, whose level is in the list. A row with no
 * level (written before levels existed) is admitted only by a Gate that admits any paid level.
 *
 * The split happens during the snapshot: each broadcast_recipients row records its variant, so a
 * retried batch sends each recipient the email it was assigned, whatever happens to entitlements
 * in between.
 */
import { hasGateDivider } from '@swarm/mail';
import type { CompiledCircle } from './circles';
import { first } from './db';

export type { EmailVariant } from '@swarm/mail';

/** Whether a Dispatch is sent as two emails (full and teaser). */
export function splitsByEntitlement(dispatch: {
  web_visibility: string;
  content_json: string;
}): boolean {
  if (dispatch.web_visibility !== 'paid') return false;
  try {
    return hasGateDivider(JSON.parse(dispatch.content_json));
  } catch {
    return false;
  }
}

/** Keeps the strings of a stored level list, once each. */
export function normalizeLevelIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((v): v is string => typeof v === 'string' && v.length < 64))];
  } catch {
    return [];
  }
}

/** The levels a Dispatch's Gate admits; empty for any paid level (also when it has no Gate). */
export async function gateLevelIds(
  db: D1Database,
  channelId: string,
  dispatchId: string,
): Promise<string[]> {
  const row = await first<{ level_ids_json: string }>(
    db,
    'SELECT level_ids_json FROM gates WHERE dispatch_id = ?1 AND channel_id = ?2',
    dispatchId,
    channelId,
  );
  return normalizeLevelIds(row?.level_ids_json);
}

/**
 * The admission rule for one Member, given `entitledLevel`'s answer (undefined: not entitled;
 * null: entitled with no level).
 */
export function gateAdmits(levelIds: readonly string[], level: string | null | undefined): boolean {
  if (level === undefined) return false;
  if (levelIds.length === 0) return true;
  return level !== null && levelIds.includes(level);
}

/**
 * The admission rule in SQL, over `members m`. `now` and `levels` are parameter numbers: the time
 * in milliseconds and the JSON array of admitted level ids ('[]' for any paid level).
 */
export function admittedSql(now: number, levels: number): string {
  return `EXISTS (SELECT 1 FROM member_entitlements e
      WHERE e.member_id = m.id AND e.channel_id = m.channel_id AND e.kind = 'paid'
        AND e.starts_at <= ?${now} AND (e.expires_at IS NULL OR e.expires_at > ?${now})
        AND (json_array_length(?${levels}) = 0 OR e.level_id IN (SELECT value FROM json_each(?${levels}))))`;
}

/** How many Members of an audience would get the full email right now. */
export async function countAdmitted(
  db: D1Database,
  channelId: string,
  workspaceId: string,
  compiled: CompiledCircle,
  levelIds: readonly string[],
  now: number = Date.now(),
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM members m
      WHERE m.channel_id = ?2 AND m.status = 'active' AND m.emails_off_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?3 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))
        AND (${compiled.where})
        AND ${admittedSql(4, 5)}`,
    ...compiled.params,
    channelId,
    workspaceId,
    now,
    JSON.stringify(levelIds),
  );
  return row?.n ?? 0;
}
