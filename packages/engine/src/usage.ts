/**
 * Fixed-window usage counters in D1, for bounds that must hold on every install whatever edge
 * rules sit in front of it: one row per scope (for example `paypal_verify:<channelId>`), reset
 * when a new window starts. A take that goes over the limit still counts, so a flood stays
 * refused for the rest of its window.
 */
import { first } from './db';

export interface UsageTake {
  ok: boolean;
  /** Takes in this window so far, this one included. */
  used: number;
  /** When the current window ends, in ms. */
  resetsAt: number;
}

export async function takeUsage(
  db: D1Database,
  input: { scope: string; windowMs: number; limit: number; now: number; amount?: number },
): Promise<UsageTake> {
  const start = input.now - (input.now % input.windowMs);
  const amount = Math.max(1, Math.floor(input.amount ?? 1));
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO usage_windows (scope, window_start, count) VALUES (?1, ?2, ?3)
     ON CONFLICT (scope) DO UPDATE SET
       count = CASE WHEN usage_windows.window_start = excluded.window_start
                    THEN usage_windows.count + excluded.count ELSE excluded.count END,
       window_start = excluded.window_start
     RETURNING count`,
    input.scope,
    start,
    amount,
  );
  const used = row?.count ?? amount;
  return { ok: used <= input.limit, used, resetsAt: start + input.windowMs };
}

/** What a scope has used in the current window, without taking any. */
export async function usageOf(
  db: D1Database,
  input: { scope: string; windowMs: number; now: number },
): Promise<number> {
  const start = input.now - (input.now % input.windowMs);
  const row = await first<{ count: number }>(
    db,
    'SELECT count FROM usage_windows WHERE scope = ?1 AND window_start = ?2',
    input.scope,
    start,
  );
  return row?.count ?? 0;
}
