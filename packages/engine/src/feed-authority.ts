// Standing feeds of a workspace's data (export destinations and webhook endpoints) and the
// authority behind them (docs/security.md "Standing feeds"). A feed runs only while someone with
// current authority stands behind it:
//
// - it was confirmed (created, repointed or adopted) by an operator through a fresh second-factor
//   check, and that operator still holds an owner or admin seat in the workspace;
// - when an API key or an OAuth grant proposed it, that credential is still live;
// - its Channel (if it has one) is not deleted;
// - the workspace's plan still includes the feed.
//
// Export runs, webhook fan-out and delivery all apply FEED_AUTHORITY_SQL; the dashboard shows
// feedAuthority's reason. A feed that fails it is suspended, not deleted: an admin can adopt it
// (confirm it again) or remove it. Tables: migrations/0086_feed_authority.sql.
import { PLAN_LIMITS, PLANS, type FeedSuspension, type Plan } from '@swarm/domain';

export type FeedKind = 'export_destination' | 'webhook_endpoint';

/** Why a feed is not running on its authority (null when it is). */
export type FeedAuthorityProblem = FeedSuspension;

const plansWith = (kind: FeedKind): Plan[] =>
  PLANS.filter((plan) =>
    kind === 'export_destination'
      ? PLAN_LIMITS[plan].exportDestinations > 0
      : PLAN_LIMITS[plan].webhookEndpoints > 0,
  );

const NOW_MS = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

/**
 * SQL CASE that names the first problem with a feed row aliased `f` (null when there is none).
 * The row needs workspace_id, channel_id, confirmed_by and confirmed_at; webhook endpoints also
 * proposed_via and proposed_by_id.
 */
export function feedProblemSql(kind: FeedKind, f = 'f'): string {
  const plans = plansWith(kind)
    .map((plan) => `'${plan}'`)
    .join(', ');
  const proposed =
    kind === 'webhook_endpoint'
      ? `WHEN ${f}.proposed_via = 'key' AND NOT EXISTS (
            SELECT 1 FROM api_keys fk WHERE fk.id = ${f}.proposed_by_id AND fk.revoked_at IS NULL
               AND (fk.expires_at IS NULL OR fk.expires_at > ${NOW_MS})) THEN 'credential_revoked'
          WHEN ${f}.proposed_via = 'oauth' AND NOT EXISTS (
            SELECT 1 FROM oauth_grants fg WHERE fg.id = ${f}.proposed_by_id AND fg.revoked_at IS NULL)
            THEN 'credential_revoked'`
      : '';
  return `(CASE
      WHEN ${f}.confirmed_at IS NULL OR ${f}.confirmed_by IS NULL THEN 'unconfirmed'
      WHEN NOT EXISTS (
        SELECT 1 FROM seats fs WHERE fs.workspace_id = ${f}.workspace_id
           AND fs.operator_id = ${f}.confirmed_by AND fs.role IN ('owner', 'admin'))
        THEN 'confirmer_left'
      ${proposed}
      WHEN ${f}.channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM channels fc WHERE fc.id = ${f}.channel_id AND fc.deleted_at IS NULL)
        THEN 'channel_deleted'
      WHEN NOT EXISTS (
        SELECT 1 FROM workspaces fw WHERE fw.id = ${f}.workspace_id AND fw.plan IN (${plans}))
        THEN 'plan'
      ELSE NULL END)`;
}

/** A WHERE condition: the feed row aliased `f` has current authority behind it. */
export const FEED_AUTHORITY_SQL = (kind: FeedKind, f = 'f') => `${feedProblemSql(kind, f)} IS NULL`;

/** What the dashboard says about a suspended feed. */
export const FEED_PROBLEM_TEXT: Record<FeedAuthorityProblem, string> = {
  unconfirmed: 'Waiting for an admin to confirm it.',
  confirmer_left: 'The admin who set it up no longer has the admin role here.',
  credential_revoked: 'The API key or app that set it up was revoked.',
  channel_deleted: 'Its publication was deleted.',
  plan: 'The plan no longer includes it.',
};
