/**
 * Every optional feature has a flag here, and every flag is off by default.
 * `decision` records the product call from the rebuild plan (2026-10-27):
 * "build" = in scope for its phase, "defer" = keep the idea, "undecided" = not yet chosen.
 * Dropped options are deliberately absent. Referencing an unregistered key is a type error.
 *
 * "Off by default" is what the code does with no row: dev, tests and a manual deploy. The installer
 * writes platform-scope rows so a real install starts differently (FEATURES_OFF_AT_INSTALL below).
 */

type FlagOrigin = 'core' | 'parity' | 'extended';
type FlagDecision = 'build' | 'defer' | 'undecided';

interface FlagDefinition {
  phase: number;
  origin: FlagOrigin;
  decision: FlagDecision;
  description: string;
}

function flag(
  phase: number,
  origin: FlagOrigin,
  decision: FlagDecision,
  description: string,
): FlagDefinition {
  return { phase, origin, decision, description };
}

export const FLAG_REGISTRY = {
  // Core options inside the main phases
  editor_collab: flag(
    2,
    'core',
    'defer',
    'Real-time collaborative editing (Yjs) and editor comments (Phase 2b)',
  ),
  raw_html_mode: flag(2, 'core', 'build', 'Raw HTML Dispatches with a sandboxed preview and lint'),
  // Phase 6 optional growth features. Flows, Welcome, Champions, Ask, the Template Library and
  // the Funnel Explorer are the phase's core and are not gated.
  split_tests: flag(6, 'core', 'build', 'Split Tests: subject or content variants on a Broadcast'),
  cohort_sampling: flag(
    6,
    'core',
    'build',
    'Cohort Sampling: send to a share first, extend when health holds',
  ),
  best_time_send: flag(
    6,
    'core',
    'build',
    'Send at each reader’s best time, within 24 hours of the chosen time',
  ),
  smart_blocks: flag(6, 'core', 'build', 'Smart Blocks: content shown or hidden by condition'),
  // Off: the dashboard hides the choice and saving a new one is refused. A document that already
  // has one still renders by it, so email-only text never reaches the website.
  block_visibility: flag(
    2,
    'core',
    'build',
    'Blocks shown only in the email or only on the website',
  ),
  signup_journeys: flag(6, 'core', 'build', 'Signup Journeys: steps shown after subscribing'),
  signup_paths: flag(6, 'core', 'build', 'Website signup in steps: email, then name, then plan'),
  smart_prompts: flag(6, 'core', 'build', 'Smart Prompts: on-site Capture Form prompts with rules'),

  // Phase 7. Read at platform scope only: sign-in happens before any workspace is known, so a
  // workspace or Channel override does nothing. The OIDC code is built and tested against a fake
  // identity provider, never a real one, so it stays off until a self-hoster who has one turns it on.
  sso: flag(
    7,
    'core',
    'build',
    'Single sign-on with OpenID Connect (not yet tested with a real identity provider)',
  ),

  // Options beyond the core newsletter set
  // Core, never checked: the Channel website runs no JavaScript, so its subscribe form is the
  // plain form post, and the Capture Form snippet offers the same form. Kept to record the decision.
  nojs_subscribe: flag(
    3,
    'extended',
    'build',
    'Core, always on: the plain HTML subscribe form that works without JavaScript (not gated)',
  ),
  subscribe_attribution_fields: flag(
    3,
    'extended',
    'build',
    'First-touch and current-touch attribution (UTMs, referrer, landing page) stored on signup',
  ),
  // Off: Member Center hides the choice and refuses it. Nothing sends digests yet, and a stored
  // value never changes sending.
  digest: flag(3, 'extended', 'defer', 'Digest frequency choice in Member Center'),
  site_homepage_layouts: flag(
    4,
    'extended',
    'build',
    'Magazine and newspaper homepage layouts with pins',
  ),
  site_sections: flag(4, 'extended', 'build', 'Sections that group Dispatches on the site'),
  site_prev_next_nav: flag(4, 'extended', 'build', 'Previous and next links on Dispatch pages'),
  site_drop_caps: flag(4, 'extended', 'build', 'Drop caps and typography options'),
  gated_seo_exposure: flag(
    4,
    'extended',
    'build',
    'Serve gated content to verified search crawlers',
  ),
  author_pages: flag(4, 'extended', 'build', 'Author pages for multi-author Channels'),
  founding_level: flag(5, 'extended', 'build', 'A Founding Level above the regular paid levels'),
  paywall_coupon: flag(5, 'extended', 'build', 'Show a coupon inside the Gate'),
  gift_passes: flag(5, 'extended', 'build', 'Gift a membership to someone else'),
  gift_articles: flag(5, 'extended', 'build', 'Share one gated Dispatch with a non-member'),
  pledges: flag(5, 'extended', 'build', 'Pledge to pay before paid levels launch'),
  pay_what_you_want: flag(5, 'parity', 'build', 'Pay what you want and tips'),
  group_seats: flag(5, 'extended', 'defer', 'Team and group memberships'),
  referral_awards: flag(6, 'extended', 'build', 'Champions leaderboard and awards'),
  reader_survey_on_subscribe: flag(6, 'extended', 'build', 'Survey step in Signup Journeys'),
  welcome_page: flag(6, 'extended', 'build', 'Welcome page after subscribing, with an opt-out'),
  post_series: flag(6, 'extended', 'build', 'Ordered Series of Dispatches'),
  email_design: flag(6, 'core', 'build', 'Logo, fonts, colours, header and footer for emails'),
  snippets: flag(6, 'core', 'build', 'Save blocks to reuse in posts'),
  post_archive: flag(2, 'core', 'build', 'Archive sent posts to tidy the dashboard posts list'),
  content_calendar: flag(
    2,
    'core',
    'build',
    'A month view of posts, with planned dates for drafts',
  ),
  archive_import: flag(6, 'core', 'build', 'Bring past issues over from another platform'),
  message_templates: flag(6, 'core', 'build', 'Your own wording and HTML for system emails'),
  site_templates: flag(6, 'extended', 'build', 'Website templates, design settings and custom CSS'),
  design_templates: flag(6, 'extended', 'build', 'Design templates for Dispatches and sites'),
  code_embeds: flag(
    2,
    'extended',
    'build',
    'Code blocks with highlighting and a table of contents',
  ),
  custom_email_css: flag(2, 'extended', 'build', 'Custom email CSS with lint'),
  site_comments: flag(8, 'extended', 'undecided', 'Comments on Dispatch pages'),
  direct_messages: flag(9, 'extended', 'defer', 'Direct messages between members and operators'),
  reader_inbox: flag(
    9,
    'extended',
    'defer',
    'Web reader inbox across Channels (decided with member_pwa)',
  ),

  // Parity extras (Phase 8), each its own sub-project
  rosters: flag(8, 'parity', 'build', 'Multiple opt-in lists per Channel'),
  feed_sync: flag(8, 'parity', 'build', 'Create Dispatches from RSS or Atom feeds'),
  link_hub: flag(8, 'parity', 'build', 'Link-in-bio page with click analytics'),
  partner_exchange: flag(8, 'parity', 'build', 'Recommending other publications by hand'),
  signals: flag(8, 'parity', 'defer', 'Cross-Channel acquisition credits'),
  signals_paid: flag(8, 'parity', 'defer', 'Paid acquisition with escrowed payouts'),
  sponsor_match: flag(8, 'parity', 'build', 'A sponsor page, bookings and ad click reports'),
  goods: flag(8, 'parity', 'build', 'Digital products and license keys'),
  stripe_own_key: flag(8, 'parity', 'build', 'Owners connect Stripe with a restricted key'),
  paypal_memberships: flag(8, 'parity', 'build', 'Paid memberships through PayPal'),
  podcast: flag(8, 'parity', 'defer', 'Podcast hosting, private feeds and episode pages'),
  voice_editions: flag(8, 'parity', 'defer', 'Audio editions of Dispatches'),
  commons: flag(8, 'parity', 'defer', 'Community spaces'),
  commons_lite_free: flag(8, 'parity', 'defer', 'Single community room on the free plan'),
  reactions: flag(8, 'parity', 'defer', 'Verified reactions on Dispatch pages'),
  site_blocks_advanced: flag(8, 'parity', 'defer', 'Advanced Site Studio blocks'),
  site_custom_code: flag(
    8,
    'parity',
    'build',
    'Cookie popup, and code owners add to their site, which waits for consent',
  ),
  site_ai_starter: flag(8, 'parity', 'defer', 'Generate a site layout from a prompt'),
  applications: flag(8, 'parity', 'build', 'Connecting other products, starting with Shorthop'),
  // On at install, and does nothing until the owner sets DEBOUNCE_API_KEY (pnpm swarm enable debounce).
  email_verification: flag(
    8,
    'parity',
    'build',
    'Check subscriber addresses with DeBounce, at signup, on import and across the list',
  ),
  landing_pages: flag(8, 'parity', 'build', 'Website pages built around one signup form'),
  engagement_scores: flag(8, 'parity', 'build', 'A daily engagement score for each Member'),
  resend_unopens: flag(8, 'parity', 'build', 'Resend a Broadcast to people who did not open it'),
  click_map: flag(
    8,
    'parity',
    'build',
    'A sent email on its report, with clicks marked on each link',
  ),
  copilot: flag(8, 'parity', 'build', 'In-product writing assistant'),
  copilot_byok: flag(8, 'parity', 'build', 'Bring your own model key for Copilot'),
  copilot_actions: flag(8, 'parity', 'build', 'Copilot actions with human approval'),
  open_operator_mcp: flag(8, 'parity', 'build', 'MCP server over the public API'),
  app_directory: flag(8, 'parity', 'build', 'Directory of OAuth apps'),
  member_pwa: flag(8, 'parity', 'defer', 'Installable reader app for members'),
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAG_REGISTRY;

export const FLAG_KEYS = Object.keys(FLAG_REGISTRY) as FlagKey[];

export function isFlagKey(value: string): value is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, value);
}

/** Decision "build": the features someone running Swarm can turn on and off. */
export const SWITCHABLE_FLAG_KEYS: readonly FlagKey[] = FLAG_KEYS.filter(
  (key) => FLAG_REGISTRY[key].decision === 'build',
);

export function isSwitchableFlag(value: string): value is FlagKey {
  return isFlagKey(value) && FLAG_REGISTRY[value].decision === 'build';
}

/**
 * The "build" features a new install leaves off; every other one starts on. Copilot uses a paid AI
 * service, SSO has never met a real identity provider, and signup attribution stores personal data.
 * Keep this the only list of its kind.
 */
export const FEATURES_OFF_AT_INSTALL: readonly FlagKey[] = [
  'copilot',
  'copilot_byok',
  'copilot_actions',
  'sso',
  'subscribe_attribution_fields',
  // These handle money and no fraud and abuse review has happened, so the installer asks first.
  'goods',
  'stripe_own_key',
  'paypal_memberships',
  'partner_exchange',
  'sponsor_match',
];

/** "build" keys nothing checks, so their switch would change nothing. The dashboard hides them. */
export const FEATURES_WITHOUT_A_GATE: readonly FlagKey[] = ['nojs_subscribe'];
