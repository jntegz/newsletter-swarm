// What Settings → Instance says about each feature. The keys come from packages/flags/src/registry.ts,
// whose descriptions use internal words, so the plain words live here. A test checks that every
// switchable key has its words here, or is listed in NO_SWITCH.
import type { InstanceFeature } from '@swarm/domain';

interface FeatureCopy {
  key: string;
  label: string;
  help: string;
}

interface FeatureGroupCopy {
  title: string;
  note?: string;
  features: FeatureCopy[];
}

export const COPILOT_NOTE = 'Copilot uses a paid AI service, so it starts off.';

export const FEATURE_GROUPS: FeatureGroupCopy[] = [
  {
    title: 'Writing',
    features: [
      {
        key: 'raw_html_mode',
        label: 'Raw HTML posts',
        help: 'Write a post in HTML, with a safe preview and checks.',
      },
      {
        key: 'code_embeds',
        label: 'Code blocks',
        help: 'Code with highlighting, and a table of contents for long posts.',
      },
      {
        key: 'smart_blocks',
        label: 'Smart blocks',
        help: 'Parts of a post that show or hide depending on who is reading.',
      },
      {
        key: 'block_visibility',
        label: 'Email or website blocks',
        help: 'Choose whether a block of a post shows only in the email or only on the website.',
      },
      {
        key: 'post_series',
        label: 'Series',
        help: 'Put posts in order as a series, with a link to the next part.',
      },
      {
        key: 'design_templates',
        label: 'Design templates',
        help: 'Ready-made designs to start a post or a website from.',
      },
      {
        key: 'custom_email_css',
        label: 'Custom email styles',
        help: 'A publication can add its own CSS to its emails. Swarm checks it first.',
      },
    ],
  },
  {
    title: 'Sending',
    features: [
      {
        key: 'resend_unopens',
        label: 'Resend to people who didn’t open',
        help: 'After a send, start a copy that goes only to people who neither opened nor clicked it.',
      },
      {
        key: 'click_map',
        label: 'Click map',
        help: 'On a send’s report, see the email as it went out, with each link marked with how many people clicked it. Never shows who clicked.',
      },
      {
        key: 'split_tests',
        label: 'Split tests',
        help: 'Try different subjects or content in one send.',
      },
      {
        key: 'cohort_sampling',
        label: 'Cohort sampling',
        help: 'Send to a share of subscribers first, then to the rest if the send stays healthy.',
      },
      {
        key: 'best_time_send',
        label: 'Send at each reader’s best time',
        help: 'A choice on each send: within 24 hours of the chosen time, readers get it at the hour they’ve usually opened or clicked before. Readers with little history get the chosen time.',
      },
      {
        key: 'rosters',
        label: 'Rosters',
        help: 'Several opt-in lists in one publication, so a send can go to chosen lists only.',
      },
      {
        key: 'feed_sync',
        label: 'Feed sync',
        help: 'Make posts from an RSS or Atom feed.',
      },
    ],
  },
  {
    title: 'Signups and growth',
    features: [
      {
        key: 'subscribe_attribution_fields',
        label: 'Where subscribers came from',
        help: 'Keep the link tags, referrer and landing page of each signup. This is personal data, so it starts off.',
      },
      {
        key: 'email_design',
        label: 'Email design',
        help: 'Choose your emails’ logo, font, colours, header and footer.',
      },
      {
        key: 'post_archive',
        label: 'Post archive',
        help: 'Archive sent posts to tidy your posts list. They stay on your website and keep their stats.',
      },
      {
        key: 'content_calendar',
        label: 'Content calendar',
        help: 'See posts on a month view, and give drafts a planned date. Planned dates don’t affect sending.',
      },
      {
        key: 'snippets',
        label: 'Snippets',
        help: 'Save a block, such as a sign-off, and insert it into later posts.',
      },
      {
        key: 'archive_import',
        label: 'Import past issues',
        help: 'Bring an archive over from another platform. Posts go on the website and are never emailed.',
      },
      {
        key: 'site_custom_code',
        label: 'Cookie popup and site code',
        help: 'Let owners add a cookie popup, analytics and their own code to their websites. Nothing runs until an owner adds it, and it waits for each reader to agree.',
      },
      {
        key: 'message_templates',
        label: 'Editable system emails',
        help: 'Change the wording and HTML of confirmation, sign-in and payment emails.',
      },
      {
        key: 'site_templates',
        label: 'Website templates',
        help: 'Five website designs to choose from, with your own colours, fonts and CSS.',
      },
      {
        key: 'signup_paths',
        label: 'Signup steps',
        help: 'Website signup in steps: email first, then name, then free or paid.',
      },
      {
        key: 'signup_journeys',
        label: 'Signup journeys',
        help: 'Steps people see right after they subscribe.',
      },
      {
        key: 'reader_survey_on_subscribe',
        label: 'Survey after signup',
        help: 'A survey as a step in a signup journey. Needs Signup journeys.',
      },
      {
        key: 'welcome_page',
        label: 'Welcome page',
        help: 'A welcome page as a step in a signup journey, with a way to opt out. Needs Signup journeys.',
      },
      {
        key: 'smart_prompts',
        label: 'Smart prompts',
        help: 'Signup prompts on your website that appear by your rules, such as on scroll.',
      },
      {
        key: 'referral_awards',
        label: 'Referral leaderboard and awards',
        help: 'Show the top referrers and give them awards.',
      },
    ],
  },
  {
    title: 'Audience',
    features: [
      {
        key: 'engagement_scores',
        label: 'Engagement scores',
        help: 'A daily score for each subscriber, from the opens and clicks of real people.',
      },
    ],
  },
  {
    title: 'Website',
    features: [
      {
        key: 'site_homepage_layouts',
        label: 'Homepage layouts',
        help: 'Magazine and newspaper homepages, with pinned posts.',
      },
      {
        key: 'site_sections',
        label: 'Sections',
        help: 'Group posts into sections on the website.',
      },
      {
        key: 'site_prev_next_nav',
        label: 'Previous and next links',
        help: 'Links to the post before and after, on each post page.',
      },
      {
        key: 'site_drop_caps',
        label: 'Drop caps and type options',
        help: 'A large first letter and other type choices for post pages.',
      },
      {
        key: 'author_pages',
        label: 'Author pages',
        help: 'A page for each writer, for publications with several.',
      },
      {
        key: 'landing_pages',
        label: 'Landing pages',
        help: 'Website pages built around one signup form, without the site’s navigation.',
      },
      {
        key: 'link_hub',
        label: 'Link hub',
        help: 'A link-in-bio page with click counts.',
      },
      {
        key: 'gated_seo_exposure',
        label: 'Paid posts in search engines',
        help: 'Lets a publication show paywalled posts to verified search engines. Each publication still chooses this itself.',
      },
    ],
  },
  {
    title: 'Paid subscriptions',
    features: [
      {
        key: 'founding_level',
        label: 'Founding plan',
        help: 'A plan above your regular paid plans.',
      },
      {
        key: 'pay_what_you_want',
        label: 'Pay what you want',
        help: 'Subscribers choose their own price, and can leave a tip.',
      },
      {
        key: 'paywall_coupon',
        label: 'Coupons at the paywall',
        help: 'Show a coupon at the paywall break.',
      },
      {
        key: 'gift_passes',
        label: 'Gift subscriptions',
        help: 'People can give a paid subscription to someone else.',
      },
      {
        key: 'gift_articles',
        label: 'Gift a post',
        help: 'Share one paywalled post with someone who is not a subscriber.',
      },
      {
        key: 'pledges',
        label: 'Pledges',
        help: 'Readers can promise to pay before your paid plans launch.',
      },
    ],
  },
  {
    title: 'Selling and partners',
    note: 'These handle money or outside parties and haven’t had a fraud and abuse review, so they start off.',
    features: [
      {
        key: 'stripe_own_key',
        label: 'Stripe with a restricted key',
        help: 'Owners can add Stripe in Settings → Payments without any command-line setup. Turning this off stops new connections; connected accounts keep working.',
      },
      {
        key: 'paypal_memberships',
        label: 'PayPal memberships',
        help: 'Owners can connect PayPal for paid memberships. It has never run against PayPal itself. Turning this off stops new connections; connected accounts keep working.',
      },
      {
        key: 'goods',
        label: 'Products',
        help: 'Sell PDFs through your own Stripe account, with license keys and refunds.',
      },
      {
        key: 'partner_exchange',
        label: 'Partner recommendations',
        help: 'Recommend other publications at signup and on your website, with click counts.',
      },
      {
        key: 'sponsor_match',
        label: 'Sponsors',
        help: 'A page where sponsors book a placement, and click reports for them. They pay you directly.',
      },
    ],
  },
  {
    title: 'Apps',
    features: [
      {
        key: 'applications',
        label: 'Applications',
        help: 'Connect other products on the Apps page, such as Shorthop for short links in posts.',
      },
      {
        key: 'email_verification',
        label: 'Email checks',
        help: 'Check subscriber addresses with DeBounce at signup, on import and across the list. It does nothing until you run pnpm swarm enable debounce.',
      },
      {
        key: 'app_directory',
        label: 'App directory',
        help: 'A reviewed list of apps and automation recipes people can install.',
      },
      {
        key: 'open_operator_mcp',
        label: 'AI tools (MCP)',
        help: 'AI tools you give access to can work with your Swarm through its API.',
      },
    ],
  },
  {
    title: 'Copilot',
    note: COPILOT_NOTE,
    features: [
      {
        key: 'copilot',
        label: 'Copilot',
        help: 'A writing assistant in the post editor.',
      },
      {
        key: 'copilot_byok',
        label: 'Your own AI key',
        help: 'A workspace can use its own AI service key for Copilot. Needs Copilot.',
      },
      {
        key: 'copilot_actions',
        label: 'Copilot actions',
        help: 'Copilot can make changes once a person approves them. Needs Copilot.',
      },
    ],
  },
  {
    title: 'Single sign-on',
    note: 'Off to start with. It has not been tested with a real identity provider, and it can add people even when sign-up is invite-only.',
    features: [
      {
        key: 'sso',
        label: 'Single sign-on',
        help: 'Workspaces can sign people in through their own identity provider. Needs the Pro plan or up.',
      },
    ],
  },
];

/** Keys nothing checks: a switch for them would change nothing, so none is shown. */
export const NO_SWITCH: readonly string[] = ['nojs_subscribe'];

export interface FeatureRow extends FeatureCopy {
  enabled: boolean;
}

interface FeatureGroupRows {
  title: string;
  note?: string;
  rows: FeatureRow[];
}

/**
 * The API's list in the screen's groups and order. A key with no words here still gets a switch,
 * under "Other", so a feature can never become impossible to turn off.
 */
export function arrangeFeatures(features: readonly InstanceFeature[]): FeatureGroupRows[] {
  const enabled = new Map(features.map((f) => [f.key, f.enabled]));
  const groups: FeatureGroupRows[] = FEATURE_GROUPS.map((group) => ({
    title: group.title,
    ...(group.note ? { note: group.note } : {}),
    rows: group.features.flatMap((copy) => {
      const on = enabled.get(copy.key);
      return on === undefined ? [] : [{ ...copy, enabled: on }];
    }),
  }));
  const known = new Set(FEATURE_GROUPS.flatMap((group) => group.features.map((f) => f.key)));
  const other = features
    .filter((f) => !known.has(f.key) && !NO_SWITCH.includes(f.key))
    .map((f) => ({ key: f.key, label: f.key, help: '', enabled: f.enabled }));
  if (other.length) groups.push({ title: 'Other', rows: other });
  return groups.filter((group) => group.rows.length > 0);
}

// Two caches: flags for 60 seconds (packages/flags), then website pages for 5 minutes on top
// (workers/site/src/render/html.ts), so a page stored just before the change shows it last.
export const FEATURES_INTRO =
  'Turn parts of Swarm on or off for everyone using it. A change can take up to a minute to reach everyone, and up to six minutes on website pages that are already stored.';

export const FEATURE_SAVING = 'Saving…';
export const FEATURE_SAVED =
  'Saved. This can take up to a minute to reach everyone, or up to six on website pages.';

/** Says what happened and what to do, and that the switch is back where it was. */
export function featureSaveError(enabled: boolean, message: string): string {
  return `Not saved, so this is still ${enabled ? 'on' : 'off'}. ${message}`;
}
