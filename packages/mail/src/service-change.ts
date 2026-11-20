/**
 * The database side of changing the email service. It lives here because two things share it, with
 * no other common home: the installer runs it, and the API's tests run it against a real database.
 * Each statement takes the time as ?1.
 */

/**
 * Swaps each sending domain's current and pending service. SQLite reads every right-hand side from
 * the row as it was, so this is a true swap, and running it again rolls back. The domain goes back
 * to pending, so nothing new starts on it until the new service confirms it (send worker's cron).
 */
export const SWAP_DOMAINS_SQL = `UPDATE sending_domains SET
    records_json = pending_records_json, pending_records_json = records_json,
    provider_ref = pending_provider_ref, pending_provider_ref = provider_ref,
    provider = pending_provider, pending_provider = provider,
    status = 'pending', dkim_status = 'pending', mail_from_status = 'pending', verified_at = NULL,
    provider_changed_at = ?1, updated_at = ?1
  WHERE kind = 'email' AND pending_records_json IS NOT NULL`;

/**
 * A domain the new service doesn't have yet can't send, and shouldn't look as if it can: left
 * verified, it would pass the send check and the new service would refuse every recipient.
 */
export const HOLD_UNREGISTERED_SQL = `UPDATE sending_domains SET
    status = 'pending', verified_at = NULL, provider_changed_at = ?1, updated_at = ?1
  WHERE kind = 'email' AND pending_records_json IS NULL`;

/**
 * A new service means no sending history, so warm-up starts again from each ramp's first day. The
 * cap only ends once it can cover everyone active, a skip is forgotten and the day count starts
 * over. A ramp that's paused stays paused: the reason it
 * paused is still someone's to look at.
 */
export const REWARM_SQL = `UPDATE reputation_ramps SET
    status = 'warming', cap_today = start_cap, sent_today = 0, paused_reason = NULL,
    day = strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch'),
    max_cap = max(start_cap + 1, (SELECT count(*) FROM members m
                                   WHERE m.channel_id = reputation_ramps.channel_id AND m.status = 'active')),
    skipped_at = NULL, started_day = strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch'),
    updated_at = ?1
  WHERE status IN ('warming', 'complete')`;

/** Days until a cap of `start` growing by `growth` a day covers `readers`, for the warning shown first. */
export function rewarmDays(readers: number, start: number, growth: number): number {
  if (readers <= start || growth <= 1) return 1;
  return Math.ceil(Math.log(readers / start) / Math.log(growth)) + 1;
}
