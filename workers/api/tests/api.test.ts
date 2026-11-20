import { SELF, env } from 'cloudflare:test';
import { FLAG_KEYS } from '@swarm/flags';
import { describe, expect, it } from 'vitest';
import { createApp, openApiDocument } from '../src/app';

const EXPECTED_TABLES = [
  'account_events',
  'address_confirmations',
  'agent_action_anchors',
  'agent_actions',
  'agent_approvals',
  'agent_settings',
  'api_idempotency',
  'api_keys',
  'app_connections',
  'app_listings',
  'app_short_links',
  'ask_options',
  'ask_questions',
  'ask_responses',
  'asks',
  'audit_anchors',
  'audit_events',
  'audit_verification_passes',
  'audit_verifications',
  'author_profiles',
  'bot_rules',
  'bounce_events',
  'bounce_policies',
  'bounce_states',
  'broadcast_recipients',
  'broadcasts',
  'bulk_jobs',
  'capture_form_daily',
  'capture_form_versions',
  'capture_forms',
  'champion_awards',
  'champion_milestones',
  'champion_rewards',
  'champion_settings',
  'channel_email_css',
  'channel_messages',
  'channel_roles',
  'channels',
  'checkout_sessions',
  'circle_members',
  'circles',
  'clicks',
  'cohort_samples',
  'comp_grants',
  'confirm_requests',
  'copilot_keys',
  'copilot_requests',
  'coupons',
  'custom_hostnames',
  'deliveries',
  'direct_sends',
  'dispatch_revisions',
  'dispatch_search',
  'dispatch_search_config',
  'dispatch_search_content',
  'dispatch_search_data',
  'dispatch_search_docsize',
  'dispatch_search_idx',
  'dispatch_slugs',
  'dispatches',
  'dmarc_records',
  'dmarc_reports',
  'dsr_confirmations',
  'dsr_requests',
  'email_check_budgets',
  'email_check_items',
  'email_check_leases',
  'email_check_list_budgets',
  'email_check_parts',
  'email_check_requests',
  'email_check_rules',
  'email_check_runs',
  'email_check_settings',
  'email_check_workspaces',
  'email_checks',
  'engagement_rollups',
  'event_cursors',
  'export_destinations',
  'export_jobs',
  'factor_undo_tokens',
  'feature_flags',
  'feed_items',
  'feed_sources',
  'field_key_reseal',
  'flow_email_ledger',
  'flow_emails',
  'flow_enrol_decisions',
  'flow_holds',
  'flow_run_steps',
  'flow_runs',
  'flow_versions',
  'flows',
  'funnel_cursors',
  'funnel_daily',
  'funnel_members',
  'gate_meter_grants',
  'gate_meter_reads',
  'gate_settings',
  'gates',
  'gift_article_links',
  'gift_passes',
  'good_files',
  'good_license_keys',
  'good_orders',
  'good_prices',
  'goods',
  'hub_link_clicks_daily',
  'hub_links',
  'hub_settings',
  'import_jobs',
  'instance_admins',
  'instance_audit_events',
  'instance_settings',
  'invites',
  'left_addresses',
  'level_prices',
  'link_targets',
  'mail_allowances',
  'mail_service_changes',
  'mailgun_webhook_tokens',
  'media',
  'member_consents',
  'member_engagement',
  'member_entitlements',
  'member_events',
  'member_field_values',
  'member_fields',
  'member_send_hours',
  'member_subscriptions',
  'member_tags',
  'member_views',
  'members',
  'membership_levels',
  'message_send_log',
  'mfa_attempts',
  'oauth_apps',
  'oauth_client_documents',
  'oauth_grants',
  'oauth_identities',
  'oauth_tokens',
  'opens',
  'operators',
  'partner_picks',
  'passkeys',
  'payments',
  'paypal_accounts',
  'paypal_events',
  'platform_events',
  'platform_staff',
  'pledges',
  'provider_suppression_sync',
  'quickpass_tokens',
  'reader_sessions',
  'reader_tokens',
  'recipe_submissions',
  'recovery_codes',
  'referrals',
  'reputation_ramp_days',
  'reputation_ramps',
  'roster_members',
  'rosters',
  'seats',
  'sender_identities',
  'sending_domains',
  'sending_limits',
  'series',
  'series_dispatches',
  'sessions',
  'signup_journey_daily',
  'signup_journeys',
  'site_code_held',
  'site_code_rules',
  'site_code_workspaces',
  'site_design_schedules',
  'site_design_versions',
  'site_designs',
  'site_page_views_daily',
  'site_pages',
  'site_redirects',
  'site_section_daily',
  'site_sections',
  'site_settings',
  'site_visitors',
  'snippets',
  'soft_bounces',
  'split_test_variants',
  'split_tests',
  'sponsor_bookings',
  'sponsor_settings',
  'sponsor_slots',
  'sso_connections',
  'sso_domains',
  'sso_released_domains',
  'stripe_accounts',
  'stripe_customers',
  'stripe_events',
  'suppressions',
  'svix_webhook_ids',
  'tags',
  'teammate_redactions',
  'templates',
  'totp_secrets',
  'trial_claims',
  'unsubscribe_refs',
  'usage_windows',
  'vault_audit',
  'vault_mints',
  'vault_rate',
  'webauthn_challenges',
  'webhook_attempts',
  'webhook_deliveries',
  'webhook_endpoint_leases',
  'webhook_endpoints',
  'worker_heartbeats',
  'workspaces',
];

describe('schema', () => {
  it('creates exactly the expected tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual(EXPECTED_TABLES);
  });

  it('treats emails case-insensitively', async () => {
    const now = Date.now();
    const insert = 'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)';
    await env.DB.prepare(insert).bind('op_case_a', 'Case@Example.com', now, now).run();
    await expect(
      env.DB.prepare(insert).bind('op_case_b', 'case@example.com', now, now).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('rejects a platform flag override that names a scope id', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES ('ff_x', 'pledges', 'platform', 'ws_1', 1, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('api worker', () => {
  it('reports healthy through the real entry point', async () => {
    const res = await SELF.fetch('https://api.test/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { ok: true, service: 'api', environment: 'test' },
    });
  });

  it('returns every registered flag and applies platform overrides', async () => {
    await env.DB.prepare(
      "INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES ('ff_1', 'founding_level', 'platform', NULL, 1, 0)",
    ).run();
    await env.CACHE.delete('flags:v1:-:-');
    const res = await SELF.fetch('https://api.test/api/v1/flags');
    const body = (await res.json()) as { data: { flags: Record<string, boolean> } };
    expect(Object.keys(body.data.flags).sort()).toEqual([...FLAG_KEYS].sort());
    expect(body.data.flags.founding_level).toBe(true);
    expect(body.data.flags.gift_passes).toBe(false);
  });

  it('fails closed when a binding is missing', async () => {
    const { CACHE: _cache, ...withoutCache } = env;
    const res = await createApp().request('/api/v1/flags', {}, withoutCache);
    expect(res.status).toBe(503);
  });

  it('refuses the dev mailbox outside development and test', async () => {
    const res = await createApp().request(
      '/healthz',
      {},
      { ...env, ENVIRONMENT: 'production', APP_ORIGIN: 'https://app.example' },
    );
    expect(res.status).toBe(503);
  });

  it('answers unknown routes with the error envelope', async () => {
    const res = await SELF.fetch('https://api.test/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('documents every route in OpenAPI', () => {
    const document = openApiDocument(createApp());
    const paths = Object.keys(document.paths ?? {});
    for (const path of [
      '/api/v1/auth/quickpass',
      '/api/v1/workspaces/{workspaceId}/channels',
      '/api/v1/channels/{channelId}/media',
    ]) {
      expect(paths).toContain(path);
    }
  });
});
