// Privacy Center (Phase 7): erasure leaves no personal data in any table (the exit criterion),
// stats still add up, erased addresses are refused everywhere, data exports, retries and the
// export file purge.
import { env } from 'cloudflare:test';
import { MCP_MAX_BODY_BYTES, newId } from '@swarm/domain';
import { appendAudit } from '@swarm/db';
import {
  appendAgentAction,
  broadcastStats,
  EXPORT_INVENTORY,
  EXPORT_NOT_MAILED_NOTE,
  createDsrRequest,
  addressMarker,
  emailHash,
  eraseAddress,
  isErasedAddress,
  mailAdapter,
  openDsrAddress,
  readExportLinkToken,
  sealDsrAddress,
  subscribe,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '@swarm/vault/testing';
import { analyzeImport } from '../src/handlers/imports';
import { runExportDestinations, runPrivacy } from '../src/handlers/privacy';
import { addField, addMember, count, jobsEnv, one, seedChannel, seedImport } from './helpers';
import { testLinks } from './links';

const fieldKeys = parseKeyring(env.TEST_FIELD_KEYS);
const memberKeys = testLinks();
const DAY = 86_400_000;

/**
 * Every table in the schema, by whether it can hold a Member's personal data. The grep test
 * fails on a table that is not listed here: a migration that adds one must decide which it is,
 * seed it below when it can (and erase it in eraseAddress), then list it.
 */
const TABLES: Record<string, 'member' | 'none'> = {
  // Operators and the workspace (no Member data)
  workspaces: 'none',
  operators: 'none',
  instance_settings: 'none',
  instance_admins: 'none',
  // Progress of re-encrypting FIELD_KEYS values after a rotation: key ids and counts only.
  field_key_reseal: 'none',
  // The vault's own records: Members appear only as hashes (packages/vault core/audit.ts).
  vault_audit: 'none',
  vault_mints: 'none',
  vault_rate: 'none',
  // When jobs last reached the vault: times and a flag.
  worker_heartbeats: 'none',
  site_code_rules: 'none',
  site_code_workspaces: 'none',
  site_code_held: 'none',
  instance_audit_events: 'none',
  seats: 'none',
  channel_roles: 'none',
  channels: 'none',
  channel_email_css: 'none',
  channel_messages: 'none',
  snippets: 'none',
  // Ids from the payment service, to stop a replayed event mailing twice.
  message_send_log: 'none',
  sessions: 'none',
  account_events: 'none',
  factor_undo_tokens: 'none',
  quickpass_tokens: 'none',
  oauth_identities: 'none',
  feature_flags: 'none',
  media: 'none',
  author_profiles: 'none',
  invites: 'none',
  sending_domains: 'none',
  // The install's sending limits (0066): numbers and who changed them, no Member data.
  sending_limits: 'none',
  // A workspace's bounce rules (0067): numbers and switches only.
  bounce_policies: 'none',
  // Email checks (0068): who may use DeBounce, a workspace's rules, a run's counts, its parts'
  // files (by key and token hash, never an address) and the call leases.
  email_check_rules: 'none',
  email_check_workspaces: 'none',
  email_check_settings: 'none',
  email_check_runs: 'none',
  email_check_parts: 'none',
  email_check_leases: 'none',
  // A workspace's daily check allowance (0099): a number and who set it.
  email_check_budgets: 'none',
  // A workspace's monthly list-check allowance (0118): a number and who set it.
  email_check_list_budgets: 'none',
  mail_service_changes: 'none',
  sender_identities: 'none',
  dispatches: 'none',
  dispatch_revisions: 'none',
  reputation_ramps: 'none',
  reputation_ramp_days: 'none',
  link_targets: 'none',
  capture_forms: 'none',
  capture_form_versions: 'none',
  capture_form_daily: 'none',
  member_fields: 'none',
  tags: 'none',
  circles: 'none',
  site_settings: 'none',
  site_sections: 'none',
  site_pages: 'none',
  site_redirects: 'none',
  site_designs: 'none',
  site_design_versions: 'none',
  // The scheduled publish: a snapshot of the design and who scheduled it, an operator.
  site_design_schedules: 'none',
  custom_hostnames: 'none',
  bot_rules: 'none',
  dispatch_slugs: 'none',
  dispatch_search: 'none',
  site_page_views_daily: 'none',
  // Per section and variant: counts only, nothing about the reader.
  site_section_daily: 'none',
  site_visitors: 'none',
  // A count per SHA-256 of a scope and address (the goods library mail limit, 0091), deleted
  // two days after its window by the daily site housekeeping; it holds no address.
  mail_allowances: 'none',
  stripe_accounts: 'none',
  stripe_events: 'none',
  membership_levels: 'none',
  level_prices: 'none',
  gates: 'none',
  gate_settings: 'none',
  coupons: 'none',
  flows: 'none',
  flow_versions: 'none',
  flow_emails: 'none',
  templates: 'none',
  // Teammates' placeholders (operators, not subscribers).
  teammate_redactions: 'none',
  split_tests: 'none',
  split_test_variants: 'none',
  cohort_samples: 'none',
  champion_settings: 'none',
  champion_rewards: 'none',
  champion_milestones: 'none',
  asks: 'none',
  ask_questions: 'none',
  ask_options: 'none',
  signup_journeys: 'none',
  signup_journey_daily: 'none',
  series: 'none',
  rosters: 'none',
  series_dispatches: 'none',
  funnel_cursors: 'none',
  api_keys: 'none',
  // Phase 7 audit retention: a seq and hash per workspace, no personal data.
  audit_anchors: 'none',
  // Verification results per chain: workspace ids, counts and times only.
  audit_verifications: 'none',
  // An unfinished verification pass: a seq, a hash and counts.
  audit_verification_passes: 'none',
  mailgun_webhook_tokens: 'none',
  svix_webhook_ids: 'none',
  oauth_apps: 'none',
  oauth_grants: 'none',
  oauth_tokens: 'none',
  // Client ID Metadata Documents: what a client says about itself (0031).
  oauth_client_documents: 'none',
  webhook_endpoints: 'none',
  // A delivery's place among an endpoint's concurrent deliveries (0117): ids and a time only.
  webhook_endpoint_leases: 'none',
  event_cursors: 'none',
  passkeys: 'none',
  mfa_attempts: 'none',
  sso_domains: 'none',
  sso_released_domains: 'none',
  webauthn_challenges: 'none',
  // Usage counters (0097): a scope of ids (a Channel's PayPal checks, a workspace's DeBounce
  // checks), a window and a count.
  usage_windows: 'none',
  totp_secrets: 'none',
  recovery_codes: 'none',
  sso_connections: 'none',
  dmarc_reports: 'none',
  dmarc_records: 'none',
  // Copilot: a sealed workspace key and request metadata, never text
  copilot_keys: 'none',
  copilot_requests: 'none',
  // Applications: a sealed workspace key, and short links for addresses in posts. No readers here.
  app_connections: 'none',
  paypal_accounts: 'none',
  paypal_events: 'none',
  app_short_links: 'none',
  // Link Hub (Phase 8): links and anonymous daily click counts.
  hub_settings: 'none',
  hub_links: 'none',
  hub_link_clicks_daily: 'none',
  // Phase 8 App Directory: listings and sanitised recipes carry no Member data.
  app_listings: 'none',
  recipe_submissions: 'none',
  platform_staff: 'none',
  // Phase 8 Feed Sync: feed URLs and public feed items, no Member data.
  feed_sources: 'none',
  feed_items: 'none',
  // Rows that name a Member or their address
  members: 'member',
  suppressions: 'member',
  left_addresses: 'member',
  broadcasts: 'member',
  broadcast_recipients: 'member',
  deliveries: 'member',
  // An old email's unsubscribe link: delivery and Member ids only, cascades with the Member.
  unsubscribe_refs: 'member',
  clicks: 'member',
  opens: 'member',
  soft_bounces: 'member',
  // An address's email check result, and its place in a running check (0068).
  email_checks: 'member',
  email_check_items: 'member',
  email_check_requests: 'member',
  // Bounce history and counters per address, with what the receiving server said (0067).
  bounce_events: 'member',
  bounce_states: 'member',
  provider_suppression_sync: 'member',
  import_jobs: 'member',
  member_field_values: 'member',
  member_tags: 'member',
  confirm_requests: 'member',
  member_consents: 'member',
  // An erasure from subscriber settings waiting for its emailed confirmation (0064).
  dsr_confirmations: 'member',
  address_confirmations: 'member',
  referrals: 'member',
  circle_members: 'member',
  // A saved view's search can be an address; erasure removes that search.
  member_views: 'member',
  roster_members: 'member',
  export_jobs: 'member',
  bulk_jobs: 'member',
  reader_tokens: 'member',
  reader_sessions: 'member',
  member_entitlements: 'member',
  stripe_customers: 'member',
  checkout_sessions: 'member',
  member_subscriptions: 'member',
  payments: 'member',
  gate_meter_reads: 'member',
  gate_meter_grants: 'member',
  comp_grants: 'member',
  gift_passes: 'member',
  gift_article_links: 'member',
  pledges: 'member',
  trial_claims: 'member',
  flow_runs: 'member',
  flow_enrol_decisions: 'member',
  flow_run_steps: 'member',
  flow_holds: 'member',
  flow_email_ledger: 'member',
  member_events: 'member',
  champion_awards: 'member',
  ask_responses: 'member',
  funnel_daily: 'member',
  funnel_members: 'member',
  member_engagement: 'member',
  member_send_hours: 'member',
  goods: 'none',
  partner_picks: 'none',
  sponsor_settings: 'none',
  sponsor_slots: 'none',
  // A sponsor's contact name and address (erasure scrubs them).
  sponsor_bookings: 'member',
  good_prices: 'none',
  good_files: 'none',
  good_orders: 'member',
  good_license_keys: 'member',
  engagement_rollups: 'none',
  api_idempotency: 'member',
  webhook_deliveries: 'member',
  webhook_attempts: 'member',
  platform_events: 'member',
  direct_sends: 'member',
  dsr_requests: 'member',
  export_destinations: 'member',
  audit_events: 'member',
  // Open Operator: settings and anchors hold no Member data; the chained log holds masked
  // summaries (ids only); held calls hold the exact request until an erasure clears it.
  agent_settings: 'none',
  agent_action_anchors: 'none',
  agent_actions: 'member',
  agent_approvals: 'member',
};

/** Tables that are SQLite's, D1's or FTS5's own. */
const internal = (name: string) =>
  name.startsWith('sqlite_') ||
  name.startsWith('_cf_') ||
  name === 'd1_migrations' ||
  name.startsWith('dispatch_search_');

const tag = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

interface Person {
  email: string;
  firstName: string;
  lastName: string;
  fieldText: string;
  secret: string;
}

const person = (): Person => {
  const t = tag();
  return {
    email: `Erase.Me-${t}@Example.org`,
    firstName: `Zephyrine${t}`,
    lastName: `Quillbottom${t}`,
    fieldText: `Marmalade garden ${t}`,
    secret: `Locked note ${t}`,
  };
};

async function seedMember(
  channel: { workspaceId: string; channelId: string },
  who: Person,
  now: number,
) {
  const id = newId('member', now);
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, first_name, last_name, status, source_json, consent_at,
       confirmed_at, champion_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7, ?8, ?7, ?7)`,
  )
    .bind(
      id,
      channel.channelId,
      who.email.toLowerCase(),
      who.firstName,
      who.lastName,
      JSON.stringify({ referrer: `https://example.net/${who.firstName}` }),
      now,
      `C${tag().slice(0, 7).toUpperCase()}`,
    )
    .run();
  return id;
}

/** A Member with a row in every table that can reference one, plus a friend they referred. */
async function seedEverything(who: Person) {
  const channel = await seedChannel();
  const { workspaceId: ws, channelId: ch } = channel;
  const now = Date.now() - 5 * DAY;
  const email = who.email.toLowerCase();
  const id = await seedMember(channel, who, now);
  const friendEmail = `friend-${tag()}@example.org`;
  const friend = newId('member', now + 1);
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, first_name, status, referred_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Friend', 'active', ?4, ?5, ?5)`,
  )
    .bind(friend, ch, friendEmail, id, now)
    .run();

  const textField = await addField(ch, 'garden', 'text');
  const lockedField = await addField(ch, 'locked', 'text', { encrypted: true });
  const tagId = newId('tag', now);
  const circleId = newId('circle', now);
  const formId = newId('captureForm', now);
  const levelId = newId('membershipLevel', now);
  const dispatchId = newId('dispatch', now);
  const broadcastId = newId('broadcast', now);
  const deliveryId = newId('delivery', now);
  const friendDelivery = newId('delivery', now + 1);
  const linkId = newId('linkTarget', now);
  const flowId = newId('flow', now);
  const runId = newId('flowRun', now);
  const askId = newId('ask', now);
  const questionId = newId('askQuestion', now);
  const milestoneId = newId('championMilestone', now);
  const endpointId = newId('webhookEndpoint', now);
  const webhookDeliveryId = newId('webhookDelivery', now);
  const subscriptionId = newId('memberSubscription', now);
  const sealed = await encrypt(fieldKeys, JSON.stringify(who.secret));
  const s = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
  const goodId = newId('good', now);
  const goodOrderId = newId('goodOrder', now);
  const sponsorSlotId = newId('sponsorSlot', now);

  await env.DB.batch([
    s(
      `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      id,
      textField,
      who.fieldText,
      now,
    ),
    s(
      `INSERT INTO member_field_values (member_id, field_id, value_enc, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      id,
      lockedField,
      sealed,
      now,
    ),
    s(
      `INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, 'gardeners', ?3)`,
      tagId,
      ch,
      now,
    ),
    s(
      `INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, ?3)`,
      id,
      tagId,
      now,
    ),
    s(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, member_count, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Keen', '{}', 1, 'ready', ?4, ?4)`,
      circleId,
      ws,
      ch,
      now,
    ),
    s(
      `INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 0)`,
      circleId,
      id,
    ),
    s(
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Footer', '{}', ?4, ?4)`,
      formId,
      ws,
      ch,
      now,
    ),
    s(`UPDATE members SET form_id = ?1 WHERE id = ?2`, formId, id),
    s(
      `INSERT INTO confirm_requests (id, member_id, channel_id, form_id, last_sent_at, confirmed_at, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?5)`,
      newId('confirmRequest', now),
      id,
      ch,
      formId,
      now,
      now + DAY,
    ),
    s(
      `INSERT INTO member_consents (member_id, source, form_id, form_version, wording, ticked, must_confirm, created_at)
       VALUES (?1, 'form', ?2, 1, 'I agree to receive this newsletter.', 1, 1, ?3)`,
      id,
      formId,
      now,
    ),
    s(
      `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, status, ip_prefix, created_at)
       VALUES (?1, ?2, ?3, ?4, 'counted', '203.0.113.0/24', ?5)`,
      newId('referral', now),
      ch,
      id,
      friend,
      now,
    ),
    s(
      `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, created_at, updated_at)
       VALUES (?1, ?2, 1, 'First friend', ?3, ?3)`,
      milestoneId,
      ch,
      now,
    ),
    s(
      `INSERT INTO champion_awards (id, channel_id, member_id, milestone_id, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      newId('championAward', now),
      ch,
      id,
      milestoneId,
      `Sent to ${who.firstName}`,
      now,
    ),
    // A "Check again" on their address that has not run yet.
    s(
      `INSERT INTO email_check_requests (id, workspace_id, channel_id, member_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      newId('emailCheckRequest', now),
      ws,
      ch,
      id,
      now,
    ),
    // The hour a send worked out for them.
    s(
      `INSERT INTO member_send_hours (member_id, channel_id, best_hour_utc, samples, computed_at)
       VALUES (?1, ?2, 14, 3, ?3)`,
      id,
      ch,
      now,
    ),
    // The erasure confirmation link they were mailed.
    s(
      `INSERT INTO dsr_confirmations (member_id, kind, created_at, expires_at)
       VALUES (?1, 'erase', ?2, ?3)`,
      id,
      now,
      now + DAY,
    ),
    // Sending: a Broadcast to both, opened and clicked; its snapshot cursor sits on the Member.
    s(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Spring', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
      dispatchId,
      ch,
      now,
    ),
    s(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, recipient_count, sent_count, snapshot_cursor, fanout_cursor,
         created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Spring', '', '<p>Hi</p>', 'Hi', 'Notes', 'notes@example.com', 1, 2, 2, ?5, ?5, ?6, ?6)`,
      broadcastId,
      dispatchId,
      ch,
      ws,
      id,
      now,
    ),
    s(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, first_name, last_name, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'sent')`,
      broadcastId,
      id,
      email,
      who.firstName,
      who.lastName,
    ),
    s(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status) VALUES (?1, ?2, ?3, 'sent')`,
      broadcastId,
      friend,
      friendEmail,
    ),
    s(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, error,
         sent_at, delivered_at, opened_at, human_opened_at, clicked_at, human_clicked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'ses-msg-1', 'delivered', ?6, ?7, ?7, ?7, ?7, ?7, ?7)`,
      deliveryId,
      broadcastId,
      ch,
      id,
      email,
      `550 ${email} greylisted once`,
      now,
    ),
    // An old email's withdrawal-only reference (retention.ts): goes with the Member.
    s(
      `INSERT INTO unsubscribe_refs (delivery_id, member_id, expires_at) VALUES (?1, ?2, ?3)`,
      deliveryId,
      id,
      now + 365 * DAY,
    ),
    s(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?6, ?6)`,
      friendDelivery,
      broadcastId,
      ch,
      friend,
      friendEmail,
      now,
    ),
    s(
      `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://example.com/read', 0)`,
      linkId,
      broadcastId,
    ),
    s(
      `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, ip_prefix, asn, created_at)
       VALUES (?1, ?2, ?3, ?4, 'human', '198.51.100.0/24', 64500, ?5)`,
      newId('click', now),
      deliveryId,
      broadcastId,
      linkId,
      now,
    ),
    s(
      `INSERT INTO opens (id, delivery_id, broadcast_id, classification, ip_prefix, created_at)
       VALUES (?1, ?2, ?3, 'human', '198.51.100.0/24', ?4)`,
      newId('open', now),
      deliveryId,
      broadcastId,
      now,
    ),
    s(
      `INSERT INTO direct_sends (id, workspace_id, channel_id, member_id, kind, status, provider_message_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'transactional', 'sent', 'ses-direct-1', ?5, ?5)`,
      newId('directSend', now),
      ws,
      ch,
      id,
      now,
    ),
    // Addresses held as text
    s(
      `INSERT INTO suppressions (id, workspace_id, email, reason, detail, created_at) VALUES (?1, ?2, ?3, 'soft_bounce', ?4, ?5)`,
      newId('suppression', now),
      ws,
      email,
      `Mailbox of ${who.firstName} full`,
      now,
    ),
    s(
      `INSERT INTO soft_bounces (workspace_id, email, created_at) VALUES (?1, ?2, ?3)`,
      ws,
      email,
      now,
    ),
    s(
      `INSERT INTO email_checks (workspace_id, email, state, code, reason, did_you_mean, source, checked_at)
       VALUES (?1, ?2, 'red', 6, 'Invalid', ?3, 'debounce', ?4)`,
      ws,
      email,
      `${email}.example`,
      now,
    ),
    s(
      `INSERT INTO email_check_runs (id, workspace_id, scope, channel_id, status, created_at, updated_at)
       VALUES (?1, ?2, 'channel', ?3, 'running', ?4, ?4)`,
      newId('emailCheckRun', now),
      ws,
      ch,
      now,
    ),
    s(
      `INSERT INTO email_check_items (run_id, email, part)
       SELECT id, ?2, 1 FROM email_check_runs WHERE workspace_id = ?1`,
      ws,
      email,
    ),
    s(
      `INSERT INTO bounce_events (workspace_id, email, send_id, kind, cause, code, detail, created_at)
       VALUES (?1, ?2, ?3, 'soft', 'mailbox_full', '4.2.2', ?4, ?5)`,
      ws,
      email,
      deliveryId,
      `452 4.2.2 Mailbox of ${who.firstName} ${email} is full`,
      now,
    ),
    s(
      `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause, last_detail,
                                  last_bounced_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, 'soft', 'mailbox_full', ?4, ?5, ?5, ?5)`,
      newId('bounceState', now),
      ws,
      email,
      `Mailbox of ${who.lastName} full`,
      now,
    ),
    s(
      `INSERT INTO provider_suppression_sync (email, action, reason, next_attempt_at, created_at, updated_at)
       VALUES (?1, 'put', 'BOUNCE', ?2, ?2, ?2) ON CONFLICT DO NOTHING`,
      email,
      now,
    ),
    s(
      `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, report_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'done', 'list.csv', '', 10, ?4, ?5, ?5)`,
      newId('importJob', now),
      ws,
      ch,
      JSON.stringify({
        samples: {
          new: [
            { line: 2, email, reason: null },
            { line: 3, email: friendEmail, reason: null },
          ],
        },
      }),
      now,
    ),
    s(
      `INSERT INTO bulk_jobs (id, workspace_id, channel_id, action, selection_json, status, cursor, created_at)
       VALUES (?1, ?2, ?3, 'tag', ?4, 'done', ?5, ?6)`,
      newId('bulkJob', now),
      ws,
      ch,
      JSON.stringify({ memberIds: [id, friend] }),
      id,
      now,
    ),
    s(
      `INSERT INTO export_jobs (id, workspace_id, channel_id, format, status, cursor, created_at)
       VALUES (?1, ?2, ?3, 'csv', 'running', ?4, ?5)`,
      newId('exportJob', now),
      ws,
      ch,
      id,
      now,
    ),
    s(
      `INSERT INTO export_destinations (id, workspace_id, channel_id, kind, config_json, credentials_enc, cursor_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 's3', '{"endpoint":null,"region":"eu-west-1","bucket":"b","prefix":""}', 'sealed', ?4, ?5, ?5)`,
      newId('exportDestination', now),
      ws,
      ch,
      JSON.stringify({ members: now, membersId: id }),
      now,
    ),
    // Site and money
    s(
      `INSERT INTO reader_tokens (token_hash, channel_id, member_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      `rt-${tag()}`,
      ch,
      id,
      now,
      now + DAY,
    ),
    s(
      `INSERT INTO reader_sessions (id_hash, channel_id, member_id, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
      `rs-${tag()}`,
      ch,
      id,
      now,
      now + DAY,
    ),
    s(
      `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Patron', ?3, ?3)`,
      levelId,
      ch,
      now,
    ),
    s(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, level_id) VALUES (?1, ?2, 'paid', 'comp', ?3, ?4)`,
      id,
      ch,
      now,
      levelId,
    ),
    s(
      `INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
      id,
      ch,
      `cus_${tag()}`,
      now,
    ),
    s(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status, stripe_subscription_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'stripe', 'canceled', ?5, ?6, ?6)`,
      subscriptionId,
      ch,
      id,
      levelId,
      `sub_${tag()}`,
      now,
    ),
    s(
      `INSERT INTO payments (id, channel_id, member_id, subscription_id, kind, stripe_object_id, currency, amount, occurred_at)
       VALUES (?1, ?2, ?3, ?4, 'invoice', ?5, 'eur', 500, ?6)`,
      newId('payment', now),
      ch,
      id,
      subscriptionId,
      `in_${tag()}`,
      now,
    ),
    s(
      `INSERT INTO comp_grants (id, channel_id, member_id, level_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      newId('compGrant', now),
      ch,
      id,
      levelId,
      `Thanks ${who.firstName} ${who.lastName}`,
      now,
    ),
    s(
      `INSERT INTO goods (id, channel_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'A guide', ?4, ?4)`,
      goodId,
      ch,
      `guide-${goodId.slice(3, 12)}`,
      now,
    ),
    s(
      `INSERT INTO good_orders (id, channel_id, good_id, member_id, email, amount, currency, status, payment_intent_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 900, 'usd', 'paid', 'pi_x', ?6)`,
      goodOrderId,
      ch,
      goodId,
      id,
      email,
      now,
    ),
    s(
      `INSERT INTO good_license_keys (id, channel_id, order_id, good_id, license_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      newId('goodLicense', now),
      ch,
      goodOrderId,
      goodId,
      `KEY-${goodId.slice(3, 15)}`,
      now,
    ),
    s(
      `INSERT INTO sponsor_slots (id, channel_id, name, amount, currency) VALUES (?1, ?2, 'Top', 100, 'usd')`,
      sponsorSlotId,
      ch,
    ),
    s(
      `INSERT INTO sponsor_bookings (id, channel_id, slot_id, run_on, sponsor_name, sponsor_email, ad_title, ad_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, '2099-01-15', ?4, ?5, 'Ad', 'https://acme.example/', ?6, ?6)`,
      newId('sponsorBooking', now),
      ch,
      sponsorSlotId,
      `${who.firstName} ${who.lastName}`,
      email,
      now,
    ),
    // A purchase announced for someone with no Member id: only the address ties it to them.
    s(
      `INSERT INTO platform_events (workspace_id, channel_id, type, payload_json, created_at)
       VALUES (?1, ?2, 'good.purchased', ?3, ?4)`,
      ws,
      ch,
      JSON.stringify({ email }),
      now,
    ),
    s(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, purchaser_member_id, recipient_email, message, status, created_at)
       VALUES (?1, ?2, ?3, 3, ?4, ?5, ?6, ?7, 'paid', ?8)`,
      newId('giftPass', now),
      ch,
      levelId,
      email,
      id,
      friendEmail,
      `From ${who.firstName}`,
      now,
    ),
    s(
      `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email, recipient_email, claimed_member_id, message, status, created_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, 'claimed', ?8)`,
      newId('giftPass', now + 1),
      ch,
      levelId,
      friendEmail,
      email,
      id,
      `For ${who.firstName}`,
      now,
    ),
    s(
      `INSERT INTO gift_article_links (token_hash, channel_id, member_id, dispatch_id, period, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, '2026-10', ?5, ?6)`,
      `ga-${tag()}`,
      ch,
      id,
      dispatchId,
      now,
      now + DAY,
    ),
    s(
      `INSERT INTO pledges (id, channel_id, member_id, level_id, interval, currency, amount, created_at)
       VALUES (?1, ?2, ?3, ?4, 'month', 'eur', 500, ?5)`,
      newId('pledge', now),
      ch,
      id,
      levelId,
      now,
    ),
    s(
      `INSERT INTO trial_claims (channel_id, email, level_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
      ch,
      email,
      levelId,
      now,
    ),
    s(
      `INSERT INTO checkout_sessions (reference, channel_id, member_id, email, intent, created_at)
       VALUES (?1, ?2, ?3, ?4, 'subscribe', ?5)`,
      `ref${tag()}${tag()}`,
      ch,
      id,
      email,
      now,
    ),
    s(
      `INSERT INTO gate_meter_reads (channel_id, reader_key, period, dispatch_id, read_at) VALUES (?1, ?2, '2026-10', ?3, ?4)`,
      ch,
      id,
      dispatchId,
      now,
    ),
    s(
      `INSERT INTO gate_meter_grants (id, channel_id, member_id, period, extra, created_at) VALUES (?1, ?2, ?3, '2026-10', 2, ?4)`,
      newId('meterGrant', now),
      ch,
      id,
      now,
    ),
    // Growth
    s(
      `INSERT INTO flows (id, workspace_id, channel_id, name, draft_graph_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Welcome', '{}', ?4, ?4)`,
      flowId,
      ws,
      ch,
      now,
    ),
    s(
      `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, context_json, started_at, updated_at)
       VALUES (?1, ?2, 1, ?3, ?4, 'completed', ?5, ?6, ?6)`,
      runId,
      flowId,
      ch,
      id,
      JSON.stringify({ trigger: { email } }),
      now,
    ),
    s(
      `INSERT INTO flow_run_steps (run_id, node_id, attempt, flow_id, version, status, result_json, started_at)
       VALUES (?1, 'n1', 1, ?2, 1, 'done', ?3, ?4)`,
      runId,
      flowId,
      JSON.stringify({ to: email }),
      now,
    ),
    s(
      `INSERT INTO flow_enrol_decisions (member_id, flow_id, version, reason, trigger_event, decided_at)
       VALUES (?1, ?2, 1, 'filter_miss', 'tag_added', ?3)`,
      id,
      flowId,
      now,
    ),
    s(
      `INSERT INTO flow_holds (run_id, node_id, flow_id, version, channel_id, member_id, reason, until, zone, held_at)
       VALUES (?1, 'n1', ?2, 1, ?3, ?4, 'quiet_hours', ?5, 'UTC', ?5)`,
      runId,
      flowId,
      ch,
      id,
      now,
    ),
    s(
      `INSERT INTO flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at)
       VALUES (?1, ?2, ?3, 0, ?4)`,
      id,
      broadcastId,
      ch,
      now,
    ),
    s(
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at) VALUES (?1, ?2, 'member_joined', '{"source":"form","status":"active"}', ?3)`,
      ch,
      id,
      now,
    ),
    s(
      `INSERT INTO asks (id, channel_id, kind, title, created_at, updated_at) VALUES (?1, ?2, 'survey', 'How?', ?3, ?3)`,
      askId,
      ch,
      now,
    ),
    s(
      `INSERT INTO ask_questions (id, ask_id, position, prompt, kind) VALUES (?1, ?2, 0, 'Say anything', 'text')`,
      questionId,
      askId,
    ),
    s(
      `INSERT INTO ask_responses (id, ask_id, question_id, channel_id, member_id, text, surface, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'page', ?7, ?7)`,
      newId('askResponse', now),
      askId,
      questionId,
      ch,
      id,
      `${who.firstName} loves it`,
      now,
    ),
    s(
      `INSERT INTO funnel_daily (channel_id, day, champion_id, subscribes, confirms, first_opens) VALUES (?1, '2026-10-20', ?2, 1, 1, 1)`,
      ch,
      id,
    ),
    s(
      `INSERT INTO funnel_daily (channel_id, day, subscribes, confirms) VALUES (?1, '2026-10-20', 2, 1)`,
      ch,
    ),
    s(
      `INSERT INTO funnel_members (member_id, channel_id, joined_at, confirmed) VALUES (?1, ?2, ?3, 1)`,
      id,
      ch,
      now,
    ),
    // Platform
    s(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
       VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      endpointId,
      ws,
      now,
    ),
    s(
      `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at, member_id)
       VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6, ?7)`,
      webhookDeliveryId,
      endpointId,
      ws,
      newId('webhookEvent', now),
      JSON.stringify({ data: { id, email, firstName: who.firstName } }),
      now,
      id,
    ),
    // A receiver that echoes the payload back leaves the address in the response excerpt.
    s(
      `INSERT INTO webhook_attempts (delivery_id, attempt, started_at, response_status, response_excerpt)
       VALUES (?1, 1, ?2, 200, ?3)`,
      webhookDeliveryId,
      now,
      `received ${email}`,
    ),
    s(
      `INSERT INTO member_views (id, channel_id, name, filters_json, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)`,
      `mv_${tag()}`,
      ch,
      `Looking for ${tag()}`,
      JSON.stringify({ q: email, status: 'active' }),
      now,
    ),
    s(
      `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
       VALUES (?1, 'k1', 'POST', '/v2/members', 'h', 201, ?2, ?3)`,
      `ky-${tag()}`,
      JSON.stringify({ data: { id, email } }),
      now,
    ),
    s(
      `INSERT INTO platform_events (workspace_id, channel_id, member_id, type, payload_json, created_at)
       VALUES (?1, ?2, ?3, 'member.updated', ?4, ?5)`,
      ws,
      ch,
      id,
      JSON.stringify({ id, email, lastName: who.lastName }),
      now,
    ),
  ]);
  // An agent deleted the Member's tag (logged with ids only) and asked to update them (held).
  await appendAgentAction(env.DB, {
    workspaceId: ws,
    source: 'mcp',
    principalKind: 'key',
    principalId: `ky_${tag()}`,
    clientName: 'Agent',
    clientVersion: null,
    tool: 'remove_member_tag',
    channelId: ch,
    risk: 'destructive',
    arguments: { channelId: ch, memberId: id, tagName: '[redacted]' },
    outcome: 'ok',
    statusCode: 204,
    errorCode: null,
    latencyMs: 3,
    approvalId: null,
  });
  await env.DB.prepare(
    `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
       scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
     VALUES (?1, ?2, ?3, 'key', 'ky_x', 'update_member', 'members:write', 'write', ?4, 'PATCH', ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      newId('agentApproval', now),
      ws,
      newId('agentAction', now),
      ch,
      `/v2/channels/${ch}/members/${id}`,
      JSON.stringify({ email, firstName: who.firstName }),
      JSON.stringify({ channelId: ch, memberId: id, body: { email: '[redacted]' } }),
      now + DAY,
      now,
    )
    .run();
  await appendAudit(env.DB, {
    workspaceId: ws,
    actorId: null,
    action: 'member.added',
    targetType: 'member',
    targetId: id,
    metadata: { channelId: ch, status: 'active' },
  });
  return { channel, id, friend, friendEmail, broadcastId, flowId };
}

/** Every table and column holding one of `needles` (case-insensitive), as "table.column". */
async function findAnywhere(needles: string[]): Promise<string[]> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  const hits: string[] = [];
  for (const { name } of tables.results) {
    if (internal(name)) continue;
    const columns = await env.DB.prepare(`SELECT name FROM pragma_table_info(?1)`)
      .bind(name)
      .all<{ name: string }>();
    for (const column of columns.results) {
      for (const needle of needles) {
        const row = await env.DB.prepare(
          `SELECT count(*) AS n FROM "${name}" WHERE instr(lower(CAST("${column.name}" AS TEXT)), ?1) > 0`,
        )
          .bind(needle.toLowerCase())
          .first<{ n: number }>();
        if (row?.n) hits.push(`${name}.${column.name}`);
      }
    }
  }
  return hits;
}

const privacyEnv = () => jobsEnv().env;

describe('erasure', () => {
  it('lists every table: a new table must be classified here before it ships', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const unknown = tables.results.map((t) => t.name).filter((n) => !internal(n) && !(n in TABLES));
    expect(unknown).toEqual([]);
  });

  it('gives every person-linked table an export decision', () => {
    const person = Object.entries(TABLES)
      .filter(([, kind]) => kind === 'member')
      .map(([name]) => name);
    expect(person.filter((name) => !(name in EXPORT_INVENTORY))).toEqual([]);
    expect(Object.keys(EXPORT_INVENTORY).filter((name) => TABLES[name] !== 'member')).toEqual([]);
  });

  it('leaves no personal data in any table, and the stats still add up', async () => {
    const who = person();
    const seeded = await seedEverything(who);
    const { workspaceId: ws, channelId: ch } = seeded.channel;
    // The same address in a second Channel of the workspace is erased too; another workspace's
    // Member with it is not.
    const second = newId('channel');
    await env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Second', ?4, ?4)`,
    )
      .bind(second, ws, `ch-${tag()}`, Date.now())
      .run();
    const secondMember = await seedMember({ workspaceId: ws, channelId: second }, who, Date.now());
    const elsewhere = await seedChannel();
    const outsider = await seedMember(elsewhere, who, Date.now());

    const statsBefore = await broadcastStats(env.DB, seeded.broadcastId);
    const funnelBefore = await one<Record<string, number>>(
      'SELECT sum(subscribes) AS s, sum(confirms) AS c, sum(first_opens) AS o FROM funnel_daily WHERE channel_id = ?1',
      ch,
    );
    // A previous data export of this address, which erasure must delete from R2.
    const oldExport = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: ws,
      channelId: ch,
      memberId: seeded.id,
      email: who.email,
      kind: 'export',
      source: 'member_center',
      status: 'pending',
    });
    const key = `dsr/${ws}/${oldExport}.json`;
    await env.EXPORTS.put(key, JSON.stringify({ email: who.email }));
    await env.DB.prepare(
      "UPDATE dsr_requests SET status = 'completed', export_key = ?1, export_expires_at = ?2, email_enc = NULL WHERE id = ?3",
    )
      .bind(key, Date.now() + DAY, oldExport)
      .run();

    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: ws,
      channelId: ch,
      memberId: seeded.id,
      email: who.email,
      kind: 'erase',
      source: 'member_center',
      status: 'processing',
    });
    const { env: jobs, queue } = jobsEnv();
    await runPrivacy(jobs, Date.now());

    const request = await one<{
      status: string;
      member_id: string | null;
      email_enc: string | null;
      email_hash: string;
    }>(
      'SELECT status, member_id, email_enc, email_hash FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    expect(request).toMatchObject({ status: 'completed', member_id: null, email_enc: null });
    // The marker is keyed to the workspace, not the bare digest of the address.
    expect(request?.email_hash).toBe(await addressMarker(env.DB, ws, who.email, fieldKeys));
    expect(request?.email_hash).not.toContain(await emailHash(who.email));

    // Nothing anywhere holds the address (in any case), the names or the profile values, except
    // the other workspace's own Member row.
    const personal = await findAnywhere([
      who.email,
      who.firstName,
      who.lastName,
      who.fieldText,
      who.secret,
    ]);
    expect(personal.filter((hit) => !hit.startsWith('members.'))).toEqual([]);
    expect(
      await count('SELECT count(*) AS n FROM members WHERE email = ?1', who.email.toLowerCase()),
    ).toBe(1);
    expect(await count('SELECT count(*) AS n FROM members WHERE id = ?1', outsider)).toBe(1);
    // The ids remain only where they must: the audit chain keeps the ids it already holds (it
    // can't be rewritten) and the member.deleted events carry them for webhooks and exports.
    const ids = await findAnywhere([seeded.id, secondMember]);
    expect([...new Set(ids)].sort()).toEqual([
      'agent_actions.arguments_json',
      'audit_events.target_id',
      'platform_events.member_id',
      'platform_events.payload_json',
    ]);
    // A held agent call about the Member is canceled and keeps nothing of the request.
    expect(
      await one<{ status: string; body_json: string | null }>(
        'SELECT status, body_json FROM agent_approvals WHERE workspace_id = ?1',
        ws,
      ),
    ).toEqual({ status: 'canceled', body_json: null });
    // Ids appear in platform_events only on member.deleted rows, which carry nothing else.
    const events = await env.DB.prepare(
      'SELECT type, payload_json FROM platform_events WHERE member_id IN (?1, ?2)',
    )
      .bind(seeded.id, secondMember)
      .all<{ type: string; payload_json: string }>();
    expect(events.results.map((e) => e.type)).toEqual(['member.deleted', 'member.deleted']);
    for (const event of events.results) {
      expect(Object.keys(JSON.parse(event.payload_json)).sort()).toEqual([
        'channelId',
        'deletedAt',
        'id',
      ]);
    }
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'privacy.erased'",
    )
      .bind(ws)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toEqual({ members: 2, channels: 2 });

    // The suppression stays, as a hash only.
    const suppressions = await env.DB.prepare(
      'SELECT id, email, email_hash FROM suppressions WHERE workspace_id = ?1',
    )
      .bind(ws)
      .all<{ id: string; email: string; email_hash: string }>();
    expect(suppressions.results).toHaveLength(1);
    expect(suppressions.results[0]).toEqual({
      id: suppressions.results[0]!.id,
      email: `erased+${suppressions.results[0]!.id}@invalid`,
      email_hash: await addressMarker(env.DB, ws, who.email, fieldKeys),
    });

    // Stats: the Broadcast's numbers and the funnel's totals are unchanged.
    expect(await broadcastStats(env.DB, seeded.broadcastId)).toEqual(statsBefore);
    const funnelAfter = await one<Record<string, number>>(
      'SELECT sum(subscribes) AS s, sum(confirms) AS c, sum(first_opens) AS o FROM funnel_daily WHERE channel_id = ?1',
      ch,
    );
    expect(funnelAfter).toEqual(funnelBefore);
    const delivery = await one<{ email: string; member_id: string | null }>(
      'SELECT email, member_id FROM deliveries WHERE broadcast_id = ?1 AND member_id IS NULL',
      seeded.broadcastId,
    );
    expect(delivery).toEqual({ email: 'erased', member_id: null });
    // Cursors still select the same rows: the friend sorts after the erased id's predecessor.
    const cursor = await one<{ snapshot_cursor: string }>(
      'SELECT snapshot_cursor FROM broadcasts WHERE id = ?1',
      seeded.broadcastId,
    );
    expect(cursor!.snapshot_cursor < seeded.id).toBe(true);
    // The friend they referred stays, with their own delivery.
    expect(
      await count(
        'SELECT count(*) AS n FROM members WHERE id = ?1 AND referred_by IS NULL',
        seeded.friend,
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM deliveries WHERE member_id = ?1', seeded.friend),
    ).toBe(1);
    // The earlier export file is gone; Circles of both Channels are refreshed.
    expect(await env.EXPORTS.get(key)).toBeNull();
    expect(queue.items.filter((m) => m.type === 'circle_refresh').length).toBeGreaterThan(0);
  });

  it("keeps other workspaces' Idempotency-Key replays that mention the address", async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    const t = tag();
    const email = `a-${t}@example.test`;
    const memberId = await seedMember(a, { ...person(), email }, Date.now());
    const now = Date.now();
    const keyA = `ky_A-${t}`;
    const keyB = `ky_B-${t}`;
    const seated = `op_A-${t}`;
    const outsider = `op_B-${t}`;
    const s = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
    const replay = (principal: string, key: string, response: unknown) =>
      s(
        `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
         VALUES (?1, ?2, 'POST', '/v2/members', 'h', 201, ?3, ?4)`,
        principal,
        key,
        JSON.stringify(response),
        now,
      );
    const apiKey = (id: string, ws: string) =>
      s(
        `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, created_at)
         VALUES (?1, ?2, 'Key', 'pfx', ?1, '[]', ?3)`,
        id,
        ws,
        now,
      );
    const operator = (id: string, ws: string) => [
      s(
        'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
        id,
        `${id}@example.test`,
        now,
      ),
      s(
        "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?4)",
        `seat-${id}`,
        ws,
        id,
        now,
      ),
    ];
    await env.DB.batch([
      apiKey(keyA, a.workspaceId),
      apiKey(keyB, b.workspaceId),
      ...operator(seated, a.workspaceId),
      ...operator(outsider, b.workspaceId),
      // The erasing workspace's own replays that quote the address go.
      replay(`key:${keyA}`, 'k1', { data: { email } }),
      replay(`operator:${seated}`, 'k1', { data: { email } }),
      // Another workspace's replay goes only when it quotes one of the erased Member ids.
      replay(`key:${keyB}`, 'k1', { data: { email: `maria-${email}` } }),
      replay(`operator:${outsider}`, 'k1', { data: { email } }),
      replay(`key:${keyB}`, 'k2', { data: { memberId } }),
    ]);

    await eraseAddress(env.DB, { workspaceId: a.workspaceId, email, keys: fieldKeys });

    const left = await env.DB.prepare(
      'SELECT principal, key FROM api_idempotency WHERE principal IN (?1, ?2, ?3, ?4) ORDER BY principal, key',
    )
      .bind(`key:${keyA}`, `operator:${seated}`, `key:${keyB}`, `operator:${outsider}`)
      .all<{ principal: string; key: string }>();
    expect(left.results).toEqual([
      { principal: `key:${keyB}`, key: 'k1' },
      { principal: `operator:${outsider}`, key: 'k1' },
    ]);
  });

  it('is idempotent and merges a later suppression into the hashed one', async () => {
    const channel = await seedChannel();
    const email = `twice-${tag()}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const first = await eraseAddress(env.DB, {
      workspaceId: channel.workspaceId,
      email,
      keys: fieldKeys,
    });
    expect(first.memberIds).toHaveLength(1);
    await env.DB.prepare(
      "INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', ?4)",
    )
      .bind(newId('suppression'), channel.workspaceId, email, Date.now())
      .run();
    const again = await eraseAddress(env.DB, {
      workspaceId: channel.workspaceId,
      email,
      keys: fieldKeys,
    });
    expect(again).toEqual({ memberIds: [], channelIds: [], suppressionId: first.suppressionId });
    expect(
      await count(
        'SELECT count(*) AS n FROM suppressions WHERE workspace_id = ?1',
        channel.workspaceId,
      ),
    ).toBe(1);
  });

  it('matches the address as a whole, leaving rows about a longer address that contains it', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ana-${t}@example.org`;
    // Another Member of the same workspace whose address ends with the erased one.
    const neighbour = `xana-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const neighbourId = await addMember(channel.channelId, neighbour);
    const now = Date.now();
    const endpointId = newId('webhookEndpoint', now);
    const delivery = (id: string, payload: unknown, memberId: string | null) =>
      env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at, member_id)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6, ?7)`,
      ).bind(
        id,
        endpointId,
        ws,
        newId('webhookEvent', now),
        JSON.stringify(payload),
        now,
        memberId,
      );
    const kept = newId('webhookDelivery', now);
    const mention = newId('webhookDelivery', now + 1);
    const approvalId = newId('agentApproval', now);
    const idemKey = `k-${t}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      delivery(kept, { data: { id: neighbourId, email: neighbour } }, neighbourId),
      // Still found when it is not a whole JSON string: a display name, in capitals.
      delivery(mention, { note: `Reply to Ana <${email.toUpperCase()}>` }, null),
      env.DB.prepare(
        `INSERT INTO platform_events (workspace_id, channel_id, type, payload_json, created_at)
         VALUES (?1, ?2, 'good.purchased', ?3, ?4)`,
      ).bind(ws, channel.channelId, JSON.stringify({ email: neighbour, ref: t }), now),
      env.DB.prepare(
        `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
           scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
         VALUES (?1, ?2, ?3, 'key', 'ky_x', 'update_member', 'members:write', 'write', ?4, 'PATCH', ?5, ?6, '{}', ?7, ?8)`,
      ).bind(
        approvalId,
        ws,
        newId('agentAction', now),
        channel.channelId,
        `/v2/channels/${channel.channelId}/members/${neighbourId}`,
        JSON.stringify({ email: neighbour }),
        now + DAY,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
         VALUES ('key:ky_x', ?1, 'POST', '/v2/members', 'h', 201, ?2, ?3)`,
      ).bind(idemKey, JSON.stringify({ data: { id: neighbourId, email: neighbour } }), now),
    ]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    expect(await count('SELECT count(*) AS n FROM webhook_deliveries WHERE id = ?1', kept)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM webhook_deliveries WHERE id = ?1', mention)).toBe(
      0,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE type = 'good.purchased' AND workspace_id = ?1",
        ws,
      ),
    ).toBe(1);
    expect(
      await one('SELECT status, body_json FROM agent_approvals WHERE id = ?1', approvalId),
    ).toEqual({ status: 'pending', body_json: JSON.stringify({ email: neighbour }) });
    expect(await count('SELECT count(*) AS n FROM api_idempotency WHERE key = ?1', idemKey)).toBe(
      1,
    );
  });

  it('stays quick on a large text full of longer addresses, erring toward erasing it', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ann-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const now = Date.now();
    const endpointId = newId('webhookEndpoint', now);
    // About 1 MB: 10,000 copies of the address, each inside a longer one (joann-, leeann-).
    const crowded = Array.from(
      { length: 10_000 },
      (_, i) => `${'x'.repeat(60)} ${i % 2 ? 'jo' : 'lee'}${email}`,
    ).join('');
    // A few such copies are all looked at, so the row stays.
    const few = Array.from({ length: 20 }, () => `x jo${email}`).join(' ');
    const delivery = (id: string, note: string) =>
      env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
      ).bind(id, endpointId, ws, newId('webhookEvent', now), JSON.stringify({ note }), now);
    const crowdedId = newId('webhookDelivery', now);
    const fewId = newId('webhookDelivery', now + 1);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      delivery(crowdedId, crowded),
      delivery(fewId, few),
    ]);

    const started = performance.now();
    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });
    expect(performance.now() - started).toBeLessThan(2_000);

    expect(
      await count('SELECT count(*) AS n FROM webhook_deliveries WHERE id = ?1', crowdedId),
    ).toBe(0);
    expect(await count('SELECT count(*) AS n FROM webhook_deliveries WHERE id = ?1', fewId)).toBe(
      1,
    );
  });

  it('cancels a pending approval only when it really names the address, however many longer ones it lists', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ann-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const now = Date.now();
    // A bulk import of 100 other readers, each of whose address ends with the erased one.
    const others = Array.from({ length: 100 }, (_, i) => `n${i}${email}`);
    const approval = (id: string, emails: string[]) =>
      env.DB.prepare(
        `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
           scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
         VALUES (?1, ?2, ?3, 'key', 'ky_x', 'import_members', 'members:write', 'write', ?4, 'POST', ?5, ?6, '{}', ?7, ?8)`,
      ).bind(
        id,
        ws,
        newId('agentAction', now),
        channel.channelId,
        `/v2/channels/${channel.channelId}/members/import`,
        JSON.stringify({ members: emails.map((address) => ({ email: address })) }),
        now + DAY,
        now,
      );
    const keptId = newId('agentApproval', now);
    const namedId = newId('agentApproval', now + 1);
    await env.DB.batch([approval(keptId, others), approval(namedId, [...others, email])]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    expect(await one('SELECT status, path FROM agent_approvals WHERE id = ?1', keptId)).toEqual({
      status: 'pending',
      path: `/v2/channels/${channel.channelId}/members/import`,
    });
    expect(
      await one('SELECT status, body_json FROM agent_approvals WHERE id = ?1', namedId),
    ).toEqual({ status: 'canceled', body_json: null });
  });

  it('stays quick on an approval as large as an MCP message full of longer addresses, erring toward erasing it', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ann-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const now = Date.now();
    // As many longer addresses as fit in one message (MCP_MAX_BODY_BYTES), far past the cap.
    const members: { email: string }[] = [];
    while (JSON.stringify({ members }).length < MCP_MAX_BODY_BYTES - 100) {
      members.push(
        ...Array.from({ length: 100 }, (_, i) => ({ email: `${i % 2 ? 'jo' : 'lee'}${email}` })),
      );
    }
    const crowdedId = newId('agentApproval', now);
    await env.DB.prepare(
      `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
         scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
       VALUES (?1, ?2, ?3, 'key', 'ky_x', 'import_members', 'members:write', 'write', ?4, 'POST', '/v2/import', ?5, '{}', ?6, ?7)`,
    )
      .bind(
        crowdedId,
        ws,
        newId('agentAction', now),
        channel.channelId,
        JSON.stringify({ members }),
        now + DAY,
        now,
      )
      .run();

    const started = performance.now();
    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });
    // About a second on its own. The bound catches a scan that is no longer capped (far slower),
    // with room for a machine running every package's tests at once (up to about 6 s seen).
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await one('SELECT status FROM agent_approvals WHERE id = ?1', crowdedId)).toEqual({
      status: 'canceled',
    });
  });

  it('finds the address after a JSON escape, percent-encoded or quoted, and still not inside a longer one', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ana+news-${t}@example.org`;
    const upper = email.toUpperCase();
    const encoded = (address: string) => encodeURIComponent(address).toUpperCase();
    await seedMember(channel, { ...person(), email }, Date.now());
    // Longer addresses that contain the erased one: rows about them stay, in every form.
    const longer = [`xana+news-${t}@example.org`, `x+ana+news-${t}@example.org`, `${email}.uk`];
    const now = Date.now();
    const keyId = `ky_E-${t}`;
    const endpointId = newId('webhookEndpoint', now);
    const erased: Record<string, unknown> = {
      'after \\n': { note: `Line one\n${email}` },
      'after \\t': { note: `To:\t${upper}` },
      'after \\r\\n': { note: `Hi\r\n${email}\r\n` },
      'inside an escaped JSON string': { inner: JSON.stringify({ note: `x\n${email}` }) },
      'inside \\"': { note: `Said "${email}".` },
      'in single quotes': { note: `'${email}'` },
      'in a query string': { url: `https://example.net/unsub?email=${encoded(email)}&x=1` },
      'lower-case escapes': { url: `https://example.net/u?e=${encodeURIComponent(email)}` },
      'form-encoded after a space': { body: `note=hi+${encoded(email)}` },
      'percent-encoded brackets': { body: `to=Ana%20%3C${encoded(email)}%3E` },
      'encoded twice': {
        next: `/go?to=${encodeURIComponent(`/u?e=${encodeURIComponent(email)}`)}`,
      },
    };
    const kept: Record<string, unknown> = {};
    for (const address of longer) {
      kept[`raw ${address}`] = { email: address };
      kept[`after \\n ${address}`] = { note: `Line one\n${address}` };
      kept[`query ${address}`] = { url: `https://example.net/u?email=${encoded(address)}&x=1` };
      kept[`form ${address}`] = { body: `note=hi+${encoded(address)}` };
    }
    const ids = new Map<string, string>();
    let n = 0;
    const delivery = (label: string, payload: unknown) => {
      const id = newId('webhookDelivery', now + n++);
      ids.set(id, label);
      return env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
      ).bind(id, endpointId, ws, newId('webhookEvent', now), JSON.stringify(payload), now);
    };
    const approval = (id: string, body: unknown) =>
      env.DB.prepare(
        `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
           scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
         VALUES (?1, ?2, ?3, 'key', 'ky_x', 'update_member', 'members:write', 'write', ?4, 'PATCH', '/v2/x', ?5, '{}', ?6, ?7)`,
      ).bind(
        id,
        ws,
        newId('agentAction', now),
        channel.channelId,
        JSON.stringify(body),
        now + DAY,
        now,
      );
    const replay = (key: string, response: unknown) =>
      env.DB.prepare(
        `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
         VALUES (?1, ?2, 'POST', '/v2/members', 'h', 201, ?3, ?4)`,
      ).bind(`key:${keyId}`, key, JSON.stringify(response), now);
    const purchase = (ref: string, payload: object) =>
      env.DB.prepare(
        `INSERT INTO platform_events (workspace_id, channel_id, type, payload_json, created_at)
         VALUES (?1, ?2, 'good.purchased', ?3, ?4)`,
      ).bind(ws, channel.channelId, JSON.stringify({ ...payload, ref }), now);
    const goneApproval = newId('agentApproval', now);
    const keptApproval = newId('agentApproval', now + 1);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      env.DB.prepare(
        `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, created_at)
         VALUES (?1, ?2, 'Key', 'pfx', ?1, '[]', ?3)`,
      ).bind(keyId, ws, now),
      ...Object.entries(erased).map(([label, payload]) => delivery(`erase: ${label}`, payload)),
      ...Object.entries(kept).map(([label, payload]) => delivery(`keep: ${label}`, payload)),
      approval(goneApproval, { note: `Line one\n${email}` }),
      approval(keptApproval, { note: `Line one\n${longer[0]}` }),
      replay(`gone-${t}`, { data: { url: `https://example.net/u?to=${encoded(email)}` } }),
      replay(`kept-${t}`, { data: { url: `https://example.net/u?to=${encoded(longer[1]!)}` } }),
      purchase(`gone-${t}`, { note: `Buyer:\t${upper}` }),
      purchase(`kept-${t}`, { note: `Buyer:\t${longer[0]}` }),
    ]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    const left = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1')
      .bind(endpointId)
      .all<{ id: string }>();
    expect(left.results.map((r) => ids.get(r.id)).sort()).toEqual(
      Object.keys(kept)
        .map((label) => `keep: ${label}`)
        .sort(),
    );
    expect(
      await one('SELECT status, body_json FROM agent_approvals WHERE id = ?1', goneApproval),
    ).toEqual({ status: 'canceled', body_json: null });
    expect(await one('SELECT status FROM agent_approvals WHERE id = ?1', keptApproval)).toEqual({
      status: 'pending',
    });
    const replays = await env.DB.prepare('SELECT key FROM api_idempotency WHERE principal = ?1')
      .bind(`key:${keyId}`)
      .all<{ key: string }>();
    expect(replays.results.map((r) => r.key)).toEqual([`kept-${t}`]);
    const purchases = await env.DB.prepare(
      "SELECT json_extract(payload_json, '$.ref') AS ref FROM platform_events WHERE workspace_id = ?1 AND type = 'good.purchased'",
    )
      .bind(ws)
      .all<{ ref: string }>();
    expect(purchases.results.map((r) => r.ref)).toEqual([`kept-${t}`]);
  });

  it('finds the address next to any character an address cannot hold, in every table it scrubs', async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `ana.b-${t}@example.org`;
    const encoded = (address: string) => encodeURIComponent(address).toUpperCase();
    await seedMember(channel, { ...person(), email }, Date.now());
    const note = (text: string) => JSON.stringify({ note: text });
    // Each is JSON text as stored. Some encoders escape every non-ASCII character.
    const erased: Record<string, string> = {
      'before !': note(`<p>Thanks ${email}!</p>`),
      'curly double quotes': note(`\u201c${email}\u201d`),
      'curly single quotes': note(`\u2018${email}\u2019`),
      'em dash after': note(`${email}\u2014ask her`),
      'em dash before': note(`Ana\u2014${email}`),
      'bold markdown': note(`**${email}**`),
      backticks: note(`\`${email}\``),
      'ellipsis character': note(`Write to ${email}\u2026`),
      'three full stops': note(`Write to ${email}...`),
      tildes: note(`~${email}~`),
      'escaped em dash': `{"note":"Ana\\u2014${email}\\u2014"}`,
      'percent-encoded em dash': note(`https://example.net/?q=Ana%E2%80%94${encoded(email)}%21`),
      'escaped full stop at the end': `{"note":"Write to ${email}\\u002E"}`,
      'percent-encoded full stop at the end': note(`https://example.net/?q=${encoded(email)}%2E`),
    };
    // Longer addresses next to the same characters stay.
    const kept: Record<string, string> = {
      'longer local part': note(`<p>Thanks x${email}!</p>`),
      'longer domain': note(`**${email}.uk**`),
      'hyphenated domain': note(`\u201c${email}-mail.com\u201d`),
      'after an em dash': note(`Ana\u2014x${email}`),
      'escaped full stop': note(`https://example.net/?q=${encoded(email)}%2Euk`),
      'JSON-escaped full stop': `{"note":"${email}\\u002euk"}`,
      'escaped letter': `{"note":"\\u0078${email}"}`,
    };
    const all = [
      ...Object.entries(erased).map(([label, json]) => [`erase: ${label}`, json] as const),
      ...Object.entries(kept).map(([label, json]) => [`keep: ${label}`, json] as const),
    ];
    const now = Date.now();
    const keyId = `ky_P-${t}`;
    const endpointId = newId('webhookEndpoint', now);
    const labels = new Map<string, string>();
    const statements = all.flatMap(([label, json], i) => {
      const deliveryId = newId('webhookDelivery', now + i);
      const approvalId = newId('agentApproval', now + i);
      labels.set(deliveryId, label);
      labels.set(approvalId, label);
      labels.set(`${t}-${i}`, label);
      // The purchase event carries its label so it can be told apart.
      const event = `${json.slice(0, -1)},"ref":${JSON.stringify(`${t}-${i}`)}}`;
      return [
        env.DB.prepare(
          `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
        ).bind(deliveryId, endpointId, ws, newId('webhookEvent', now), json, now),
        env.DB.prepare(
          `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
             scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
           VALUES (?1, ?2, ?3, 'key', 'ky_x', 'update_member', 'members:write', 'write', ?4, 'PATCH', '/v2/x', ?5, '{}', ?6, ?7)`,
        ).bind(approvalId, ws, newId('agentAction', now), channel.channelId, json, now + DAY, now),
        env.DB.prepare(
          `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
           VALUES (?1, ?2, 'POST', '/v2/members', 'h', 201, ?3, ?4)`,
        ).bind(`key:${keyId}`, `${t}-${i}`, json, now),
        env.DB.prepare(
          `INSERT INTO platform_events (workspace_id, channel_id, type, payload_json, created_at)
           VALUES (?1, ?2, 'good.purchased', ?3, ?4)`,
        ).bind(ws, channel.channelId, event, now),
      ];
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      env.DB.prepare(
        `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, created_at)
         VALUES (?1, ?2, 'Key', 'pfx', ?1, '[]', ?3)`,
      ).bind(keyId, ws, now),
      ...statements,
    ]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    const keptLabels = Object.keys(kept)
      .map((label) => `keep: ${label}`)
      .sort();
    const left = async (sql: string, param: string) =>
      (await env.DB.prepare(sql).bind(param).all<{ id: string }>()).results
        .map((r) => labels.get(r.id))
        .sort();
    expect(
      await left('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1', endpointId),
    ).toEqual(keptLabels);
    expect(
      await left(
        "SELECT id FROM agent_approvals WHERE workspace_id = ?1 AND status = 'pending'",
        ws,
      ),
    ).toEqual(keptLabels);
    expect(
      await left('SELECT key AS id FROM api_idempotency WHERE principal = ?1', `key:${keyId}`),
    ).toEqual(keptLabels);
    expect(
      await left(
        `SELECT json_extract(payload_json, '$.ref') AS id FROM platform_events
          WHERE workspace_id = ?1 AND type = 'good.purchased'`,
        ws,
      ),
    ).toEqual(keptLabels);
  });

  it('finds an address with an apostrophe, which the match treats as a delimiter', async () => {
    const channel = await seedChannel();
    const email = `o'neil-${tag()}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    const now = Date.now();
    const endpointId = newId('webhookEndpoint', now);
    const deliveryId = newId('webhookDelivery', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, channel.workspaceId, now),
      env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
      ).bind(
        deliveryId,
        endpointId,
        channel.workspaceId,
        newId('webhookEvent', now),
        JSON.stringify({ note: `Reply to ${email}` }),
        now,
      ),
    ]);

    await eraseAddress(env.DB, { workspaceId: channel.workspaceId, email, keys: fieldKeys });

    expect(
      await count('SELECT count(*) AS n FROM webhook_deliveries WHERE id = ?1', deliveryId),
    ).toBe(0);
  });

  it("leaves rows about a longer address that ends in an apostrophe and the erased one (o'brien vs brien)", async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `brien-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    // Other Members' addresses: the erased one after a local part that ends in an apostrophe.
    const longer = [`o'brien-${t}@example.org`, `o''brien-${t}@example.org`];
    const neighbourId = await addMember(channel.channelId, longer[0]!);
    const now = Date.now();
    const endpointId = newId('webhookEndpoint', now);
    const erased: Record<string, unknown> = {
      'in single quotes': { note: `'${email}'` },
      'in doubled single quotes': { note: `''${email}''` },
      'after a word with an apostrophe': { note: `It's ${email}` },
      possessive: { note: `${email}'s inbox` },
      'percent-encoded in single quotes': { url: `https://example.net/u?e=%27${email}%27` },
    };
    const kept: Record<string, unknown> = {};
    for (const address of longer) {
      kept[`raw ${address}`] = { email: address };
      kept[`quoted ${address}`] = { note: `'${address}'` };
      kept[`query ${address}`] = {
        url: `https://example.net/u?email=${encodeURIComponent(address)}`,
      };
      kept[`form ${address}`] = {
        body: `note=hi+${encodeURIComponent(address).replace(/'/g, '%27')}`,
      };
    }
    // Some JSON encoders escape the apostrophe; JSON.stringify does not, so these are written out.
    const escaped = (address: string) => `{"note":"${address.replace(/'/g, '\\u0027')}"}`;
    const ids = new Map<string, string>();
    let n = 0;
    const delivery = (label: string, payload: unknown) => {
      const id = newId('webhookDelivery', now + n++);
      ids.set(id, label);
      const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
      ).bind(id, endpointId, ws, newId('webhookEvent', now), json, now);
    };
    for (const address of longer) kept[`\\u0027 ${address}`] = escaped(address);
    const approvalId = newId('agentApproval', now);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      ...Object.entries(erased).map(([label, payload]) => delivery(`erase: ${label}`, payload)),
      ...Object.entries(kept).map(([label, payload]) => delivery(`keep: ${label}`, payload)),
      env.DB.prepare(
        `INSERT INTO agent_approvals (id, workspace_id, action_id, principal_kind, principal_id, tool,
           scope, risk, channel_id, method, path, body_json, arguments_json, expires_at, created_at)
         VALUES (?1, ?2, ?3, 'key', 'ky_x', 'update_member', 'members:write', 'write', ?4, 'PATCH', '/v2/x', ?5, '{}', ?6, ?7)`,
      ).bind(
        approvalId,
        ws,
        newId('agentAction', now),
        channel.channelId,
        JSON.stringify({ email: longer[0] }),
        now + DAY,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO platform_events (workspace_id, channel_id, type, payload_json, created_at)
         VALUES (?1, ?2, 'good.purchased', ?3, ?4)`,
      ).bind(ws, channel.channelId, JSON.stringify({ buyer: longer[0], ref: t }), now),
    ]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    const left = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1')
      .bind(endpointId)
      .all<{ id: string }>();
    expect(left.results.map((r) => ids.get(r.id)).sort()).toEqual(
      Object.keys(kept)
        .map((label) => `keep: ${label}`)
        .sort(),
    );
    expect(
      await one('SELECT status, body_json FROM agent_approvals WHERE id = ?1', approvalId),
    ).toEqual({ status: 'pending', body_json: JSON.stringify({ email: longer[0] }) });
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE type = 'good.purchased' AND workspace_id = ?1",
        ws,
      ),
    ).toBe(1);
    expect(await count('SELECT count(*) AS n FROM members WHERE id = ?1', neighbourId)).toBe(1);

    // Erasing the longer address still finds it, in every form, and leaves the shorter one alone.
    await delivery('shorter', { email }).run();
    await eraseAddress(env.DB, { workspaceId: ws, email: longer[0]!, keys: fieldKeys });
    const after = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1')
      .bind(endpointId)
      .all<{ id: string }>();
    expect(after.results.map((r) => ids.get(r.id)).sort()).toEqual(
      [
        'shorter',
        ...Object.keys(kept)
          .filter((l) => l.endsWith(longer[1]!))
          .map((l) => `keep: ${l}`),
      ].sort(),
    );
  });

  it("leaves rows about a longer address that starts with an apostrophe ('brien vs brien)", async () => {
    const channel = await seedChannel();
    const ws = channel.workspaceId;
    const t = tag();
    const email = `brien-${t}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    // Other Members' addresses: the erased one with apostrophes in front, which the validator allows.
    const longer = [`'brien-${t}@example.org`, `''brien-${t}@example.org`];
    const neighbourId = await addMember(channel.channelId, longer[0]!);
    const now = Date.now();
    const endpointId = newId('webhookEndpoint', now);
    const erased: Record<string, unknown> = {
      'in single quotes': { note: `'${email}'` },
      'in doubled single quotes': { note: `''${email}''` },
      'quoted after a space': { note: `Write to '${email} today` },
      'after a word with an apostrophe': { note: `It's ${email}` },
      possessive: { note: `${email}'s inbox` },
      'percent-encoded in single quotes': { url: `https://example.net/u?e=%27${email}%27` },
      '\\u0027 in single quotes': `{"note":"\\u0027${email}\\u0027"}`,
    };
    const kept: Record<string, unknown> = {};
    for (const address of longer) {
      kept[`raw ${address}`] = { email: address };
      kept[`in brackets ${address}`] = { to: `Pat <${address}>` };
      kept[`query ${address}`] = {
        url: `https://example.net/u?email=${encodeURIComponent(address).replace(/'/g, '%27')}`,
      };
      kept[`form ${address}`] = {
        body: `email=${encodeURIComponent(address).replace(/'/g, '%27')}&x=1`,
      };
      kept[`\\u0027 ${address}`] = `{"email":"${address.replace(/'/g, '\\u0027')}"}`;
    }
    const ids = new Map<string, string>();
    let n = 0;
    const delivery = (label: string, payload: unknown) => {
      const id = newId('webhookDelivery', now + n++);
      ids.set(id, label);
      const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'member.created', ?5, ?6, ?6)`,
      ).bind(id, endpointId, ws, newId('webhookEvent', now), json, now);
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, 'https://hooks.example.com/in', '["member.created"]', 'sealed', ?3, ?3)`,
      ).bind(endpointId, ws, now),
      ...Object.entries(erased).map(([label, payload]) => delivery(`erase: ${label}`, payload)),
      ...Object.entries(kept).map(([label, payload]) => delivery(`keep: ${label}`, payload)),
    ]);

    await eraseAddress(env.DB, { workspaceId: ws, email, keys: fieldKeys });

    const left = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1')
      .bind(endpointId)
      .all<{ id: string }>();
    expect(left.results.map((r) => ids.get(r.id)).sort()).toEqual(
      Object.keys(kept)
        .map((label) => `keep: ${label}`)
        .sort(),
    );
    expect(await count('SELECT count(*) AS n FROM members WHERE id = ?1', neighbourId)).toBe(1);

    // Erasing the longer address still finds it, in every form, and leaves the others alone.
    await delivery('shorter', { email }).run();
    await eraseAddress(env.DB, { workspaceId: ws, email: longer[0]!, keys: fieldKeys });
    const after = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?1')
      .bind(endpointId)
      .all<{ id: string }>();
    expect(after.results.map((r) => ids.get(r.id)).sort()).toEqual(
      [
        'shorter',
        ...Object.keys(kept)
          .filter((l) => l.endsWith(longer[1]!))
          .map((l) => `keep: ${l}`),
      ].sort(),
    );
  });

  it('an erased address is refused by subscribe and by imports', async () => {
    const channel = await seedChannel();
    const email = `gone-${tag()}@example.org`;
    await seedMember(channel, { ...person(), email }, Date.now());
    await eraseAddress(env.DB, { workspaceId: channel.workspaceId, email, keys: fieldKeys });
    expect(await isErasedAddress(env.DB, channel.workspaceId, email.toUpperCase(), fieldKeys)).toBe(
      true,
    );

    const jobs = privacyEnv();
    const result = await subscribe(
      {
        db: env.DB,
        mail: mailAdapter(jobs, jobs.PLATFORM_MAIL_DOMAIN),
        links: memberKeys,
        fieldKeys,
        captureOrigin: 'https://forms.example.com',
        platformMailDomain: jobs.PLATFORM_MAIL_DOMAIN,
      },
      {
        channelId: channel.channelId,
        workspaceId: channel.workspaceId,
        formId: null,
        email,
        doubleOptIn: false,
      },
    );
    expect(result).toEqual({ outcome: 'ignored', memberId: null });

    const jobId = await seedImport(
      channel,
      `email,first_name\n${email.toUpperCase()},Again\nfresh-${tag()}@example.org,New\n`,
      ['email', 'first_name'],
      { email: 'email', first_name: 'first_name' },
    );
    await analyzeImport(jobs, jobId);
    const report = await one<{ report_json: string }>(
      'SELECT report_json FROM import_jobs WHERE id = ?1',
      jobId,
    );
    const parsed = JSON.parse(report!.report_json) as {
      counts: Record<string, number>;
      samples: Record<string, { reason: string | null }[]>;
    };
    expect(parsed.counts.suppressed).toBe(1);
    expect(parsed.counts.new).toBe(1);
    expect(parsed.samples.suppressed?.[0]?.reason).toContain('Erased');
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', channel.channelId),
    ).toBe(0);
  });
});

describe('data exports', () => {
  it('builds the JSON with decrypted fields and history, then emails a link', async () => {
    const who = person();
    const seeded = await seedEverything(who);
    const { workspaceId: ws, channelId: ch } = seeded.channel;
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: ws,
      channelId: ch,
      memberId: seeded.id,
      email: who.email,
      kind: 'export',
      source: 'member_center',
      status: 'processing',
    });
    await runPrivacy(privacyEnv(), Date.now());
    const row = await one<{
      status: string;
      export_key: string;
      email_enc: string | null;
      completed_at: number;
    }>(
      'SELECT status, export_key, email_enc, completed_at FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    expect(row).toMatchObject({ status: 'completed', email_enc: null });
    const file = await env.EXPORTS.get(row!.export_key);
    const data = (await file!.json()) as {
      email: string;
      channels: {
        member: { first_name: string };
        fields: Record<string, { value: unknown }>;
        tags: string[];
        circles: string[];
        consents: { wording: string }[];
        deliveries: { subject: string }[];
        clicks: { url: string }[];
        askResponses: { text: string }[];
        payments: { amount: number }[];
        giftPasses: { role: string }[];
        flowRuns: { flow: string }[];
        flowDecisions: { flow: string; reason: string }[];
        flowHolds: { flow: string; reason: string }[];
        bestSendHour: { best_hour_utc: number; samples: number; computed_at: string }[];
      }[];
      suppression: { reason: string } | null;
    };
    expect(data.email).toBe(who.email.toLowerCase());
    const [channel] = data.channels;
    expect(channel?.member.first_name).toBe(who.firstName);
    expect(channel?.fields.garden?.value).toBe(who.fieldText);
    expect(channel?.fields.locked?.value).toBe(who.secret);
    expect(channel?.tags).toEqual(['gardeners']);
    expect(channel?.circles).toEqual(['Keen']);
    expect(channel?.consents.map((c) => c.wording)).toEqual([
      'I agree to receive this newsletter.',
    ]);
    expect(channel?.deliveries[0]?.subject).toBe('Spring');
    expect(channel?.bestSendHour).toEqual([
      { best_hour_utc: 14, samples: 3, computed_at: expect.any(String) },
    ]);
    expect(channel?.clicks[0]?.url).toBe('https://example.com/read');
    expect(channel?.askResponses[0]?.text).toContain(who.firstName);
    expect(channel?.payments[0]?.amount).toBe(500);
    expect(channel?.giftPasses.map((g) => g.role).sort()).toEqual(['bought', 'received']);
    expect(channel?.flowRuns[0]?.flow).toBe('Welcome');
    expect(channel?.flowDecisions[0]).toMatchObject({ flow: 'Welcome', reason: 'filter_miss' });
    expect(channel?.flowHolds[0]).toMatchObject({ flow: 'Welcome', reason: 'quiet_hours' });
    expect(data.suppression?.reason).toBe('soft_bounce');

    // The email links to the download page with a token for this request.
    const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    const mailKey = listing.objects.find(
      (o) =>
        o.customMetadata?.to === who.email.toLowerCase() &&
        o.customMetadata?.category === 'privacy_export',
    )?.key;
    const mail = await (await env.DEV_MAILBOX.get(mailKey!))!.json<{ text: string }>();
    const token = /\/m\/data\/([A-Za-z0-9._-]+)/.exec(mail.text)?.[1];
    expect(await readExportLinkToken(memberKeys, token!)).toEqual({
      requestId,
      workspaceId: expect.stringMatching(/^ws_/),
    });
  });

  it('includes the network data kept with opens, clicks and their own referral signup', async () => {
    const who = person();
    const seeded = await seedEverything(who);
    const { workspaceId: ws, channelId: ch } = seeded.channel;
    await env.DB.prepare(
      `UPDATE opens SET ip_prefix = '198.51.100.0/24', asn = 64500, ua_family = 'Firefox'
        WHERE delivery_id IN (SELECT id FROM deliveries WHERE member_id = ?1)`,
    )
      .bind(seeded.id)
      .run();
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: ws,
      channelId: ch,
      memberId: seeded.id,
      email: who.email,
      kind: 'export',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(privacyEnv(), Date.now());
    const row = await one<{ export_key: string }>(
      'SELECT export_key FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    const data = (await (await env.EXPORTS.get(row!.export_key))!.json()) as {
      truncated: string[];
      note: string;
      channels: {
        opens: { ip_prefix: string | null; asn: number | null; ua_family: string | null }[];
        clicks: { ip_prefix: string | null }[];
        referrals: { role: string; ip_prefix: string | null }[];
      }[];
    };
    expect(data.truncated).toEqual([]);
    expect(data.note).toContain('network prefix');
    const [channel] = data.channels;
    expect(channel?.opens[0]).toMatchObject({
      ip_prefix: '198.51.100.0/24',
      asn: 64500,
      ua_family: 'Firefox',
    });
    expect(channel?.clicks[0]).toHaveProperty('ip_prefix');
    // Someone they referred signed up from their own network: not part of this person's data.
    for (const referral of channel?.referrals ?? []) {
      if (referral.role === 'referred_someone') expect(referral.ip_prefix).toBeNull();
    }
  });

  it('does not email an address that bounced; an admin downloads the file instead', async () => {
    const channel = await seedChannel();
    const email = `bounced-${tag()}@example.org`;
    const memberId = await addMember(channel.channelId, email, { status: 'bounced' });
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', ?4)`,
    )
      .bind(newId('suppression'), channel.workspaceId, email, Date.now())
      .run();
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
      memberId,
      email,
      kind: 'export',
      source: 'operator',
      status: 'processing',
      note: 'Asked by post.',
    });
    await runPrivacy(privacyEnv(), Date.now());
    const row = await one<{ status: string; export_key: string | null; note: string }>(
      'SELECT status, export_key, note FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    expect(row).toMatchObject({
      status: 'completed',
      note: `Asked by post. ${EXPORT_NOT_MAILED_NOTE}`,
    });
    expect(await env.EXPORTS.get(row!.export_key!)).not.toBeNull();
    const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    expect(listing.objects.some((o) => o.customMetadata?.to === email)).toBe(false);
  });

  it('fails at once with a recovery route when the sealed address cannot be opened', async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, 'keyloss@example.org');
    const requestId = newId('dsrRequest');
    const now = Date.now();
    // Sealed under a key ("gone") this worker no longer has.
    const lost = await sealDsrAddress(
      parseKeyring(`gone:${'g'.repeat(64)}`),
      'keyloss@example.org',
    );
    await env.DB.prepare(
      `INSERT INTO dsr_requests (id, workspace_id, email_hash, email_enc, kind, source, status, due_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'export', 'operator', 'processing', ?5, ?6, ?6)`,
    )
      .bind(requestId, channel.workspaceId, '0'.repeat(64), lost, now + DAY, now)
      .run();
    await runPrivacy(privacyEnv(), now);
    const row = await one<{ status: string; attempts: number; error: string }>(
      'SELECT status, attempts, error FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    // No retries that can't help: visible to the admin at once, naming the key and what to do.
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row!.error).toContain('sealed with key "gone"');
    expect(row!.error).toContain('retry');
    expect(row!.error).not.toContain('keyloss@example.org');
    // Recovery: with the key back (here: resealed under the current one), a retry completes.
    await env.DB.prepare(
      "UPDATE dsr_requests SET status = 'processing', attempts = 0, claimed_until = NULL, email_enc = ?1 WHERE id = ?2",
    )
      .bind(await sealDsrAddress(fieldKeys, 'keyloss@example.org'), requestId)
      .run();
    await runPrivacy(privacyEnv(), now + 60_000);
    expect(await one('SELECT status FROM dsr_requests WHERE id = ?1', requestId)).toEqual({
      status: 'completed',
    });
  });

  it('seals request addresses under their own key, apart from profile fields', async () => {
    const sealed = await sealDsrAddress(fieldKeys, 'apart@example.org');
    expect(sealed.startsWith('dsr-address~')).toBe(true);
    // The profile-field key can't open it, and the request key opens an older plain seal too.
    expect(await decrypt(fieldKeys, sealed)).toBeNull();
    expect(await openDsrAddress(fieldKeys, sealed)).toBe('apart@example.org');
    expect(await openDsrAddress(fieldKeys, await encrypt(fieldKeys, 'old@example.org'))).toBe(
      'old@example.org',
    );
  });

  it('deletes export files once the link has expired', async () => {
    const channel = await seedChannel();
    const requestId = newId('dsrRequest');
    const key = `dsr/${channel.workspaceId}/${requestId}.json`;
    const now = Date.now();
    await env.EXPORTS.put(key, '{}');
    await env.DB.prepare(
      `INSERT INTO dsr_requests (id, workspace_id, email_hash, kind, source, status, due_at, export_key,
         export_expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'export', 'member_center', 'completed', ?4, ?5, ?4, ?4, ?4)`,
    )
      .bind(requestId, channel.workspaceId, '0'.repeat(64), now - DAY, key)
      .run();
    await runExportDestinations(privacyEnv(), now, async () => new Response(null, { status: 500 }));
    expect(await env.EXPORTS.get(key)).toBeNull();
    expect(
      await count(
        'SELECT count(*) AS n FROM dsr_requests WHERE id = ?1 AND export_key IS NULL',
        requestId,
      ),
    ).toBe(1);
  });
});
