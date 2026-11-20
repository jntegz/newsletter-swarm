// An owner's cookie popup and the code they add to their website: analytics, tag managers or their
// own. Presets take an id and build the code, so nobody has to paste a script to use a common tool.
import { z } from '@hono/zod-openapi';

const CODE_CATEGORIES = ['necessary', 'analytics', 'marketing'] as const;
export type CodeCategory = (typeof CODE_CATEGORIES)[number];
export const CODE_PRESETS = [
  'google_analytics',
  'google_tag_manager',
  'plausible',
  'fathom',
  'meta_pixel',
  'verification',
  'custom',
] as const;
export type CodePreset = (typeof CODE_PRESETS)[number];
export const MAX_SITE_CODE_ENTRIES = 20;
const MAX_SITE_CODE_LENGTH = 20_000;

export const SiteCodeEntrySchema = z
  .object({
    name: z.string().trim().min(1, 'Name it.').max(60),
    preset: z.enum(CODE_PRESETS),
    /** What it does decides whether it waits for the reader to agree. */
    category: z.enum(CODE_CATEGORIES),
    /** The tool's id, the verification tag, or the code itself. */
    value: z.string().trim().min(1).max(MAX_SITE_CODE_LENGTH),
    /**
     * The owner confirmed that this entry is strictly necessary although it looks like a tracking
     * tool (KNOWN_TRACKERS). Saving such an entry as necessary without it is refused.
     */
    necessaryConfirmed: z.boolean().optional(),
  })
  .openapi('SiteCodeEntry');
export type SiteCodeEntry = z.infer<typeof SiteCodeEntrySchema>;

const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1a2b3c.');

export const SiteConsentSchema = z
  .object({
    enabled: z.boolean().default(false),
    text: z.string().trim().max(600).default(DEFAULT_CONSENT_TEXT()),
    acceptLabel: z.string().trim().min(1).max(40).default('Accept all'),
    rejectLabel: z.string().trim().min(1).max(40).default('Reject all'),
    /** A site path or https address. */
    policyUrl: z.string().trim().max(500).default(''),
    position: z.enum(['bottom', 'bottom_left', 'center']).default('bottom'),
    background: COLOR.optional(),
    textColor: COLOR.optional(),
  })
  .openapi('SiteConsent');
export type SiteConsent = z.infer<typeof SiteConsentSchema>;

function DEFAULT_CONSENT_TEXT() {
  return 'We use cookies to understand how this site is used. You can accept or reject them, and change your mind at any time.';
}
export const defaultSiteConsent = (): SiteConsent => SiteConsentSchema.parse({});

const PATTERNS: Partial<Record<CodePreset, { pattern: RegExp; message: string }>> = {
  google_analytics: { pattern: /^G-[A-Z0-9]{4,20}$/, message: 'Use an id like G-ABC123DEF4.' },
  google_tag_manager: { pattern: /^GTM-[A-Z0-9]{4,12}$/, message: 'Use an id like GTM-ABC123.' },
  plausible: {
    pattern: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    message: 'Use your site’s domain, like news.example.com.',
  },
  fathom: { pattern: /^[A-Z]{4,12}$/, message: 'Use your Fathom site id, like ABCDEFG.' },
  meta_pixel: { pattern: /^\d{5,20}$/, message: 'Use your pixel id, which is all digits.' },
};

const VERIFICATION = /^<meta\s+name="([a-zA-Z0-9_:.-]{1,80})"\s+content="([^"<>]{1,300})"\s*\/?>$/;

/** A verification tag's name and content, or null. */
export const parseVerificationTag = (value: string) => {
  const match = VERIFICATION.exec(value.trim());
  return match ? { name: match[1]!, content: match[2]! } : null;
};

/** Why this entry can't be saved, or null. */
export function siteCodeProblem(entry: SiteCodeEntry): string | null {
  const rule = PATTERNS[entry.preset];
  if (rule && !rule.pattern.test(entry.value)) return `${entry.name}: ${rule.message}`;
  if (entry.preset === 'verification' && !parseVerificationTag(entry.value)) {
    return `${entry.name}: paste one tag, like <meta name="site-verification" content="abc123">.`;
  }
  return null;
}

/** The code a preset stands for. Its value has already passed siteCodeProblem. */
export function siteCodeHtml(entry: SiteCodeEntry): string {
  const id = entry.value;
  switch (entry.preset) {
    case 'google_analytics':
      // Loaded only once the reader agrees, so nothing reaches Google before that.
      return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${id}');</script>`;
    case 'google_tag_manager':
      return `<script>window.dataLayer=window.dataLayer||[];window.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});</script><script async src="https://www.googletagmanager.com/gtm.js?id=${id}"></script>`;
    case 'plausible':
      return `<script defer data-domain="${id}" src="https://plausible.io/js/script.js"></script>`;
    case 'fathom':
      return `<script defer data-site="${id}" src="https://cdn.usefathom.com/script.js"></script>`;
    case 'meta_pixel':
      return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;t.nonce=b.currentScript.nonce;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>`;
    default:
      return entry.value;
  }
}

/**
 * Tools that track readers or show them ads, by name and by what their code contains (hostnames
 * and snippets, matched in lower case). Kept short and conservative: a match only asks the owner
 * to confirm "strictly necessary", so a missing tool means no question, never a wrong block.
 */
export const KNOWN_TRACKERS: readonly { name: string; match: readonly string[] }[] = [
  { name: 'Google Analytics', match: ['google-analytics.com', 'gtag/js', "gtag('config'"] },
  { name: 'Google Tag Manager', match: ['googletagmanager.com/gtm.js', 'gtm.start'] },
  {
    name: 'Google Ads',
    match: ['googleadservices.com', 'googlesyndication.com', 'doubleclick.net'],
  },
  { name: 'Meta Pixel', match: ['connect.facebook.net', 'fbq('] },
  { name: 'TikTok Pixel', match: ['analytics.tiktok.com', 'ttq.load'] },
  { name: 'LinkedIn Insight Tag', match: ['snap.licdn.com', '_linkedin_partner_id'] },
  { name: 'X (Twitter) Pixel', match: ['static.ads-twitter.com', 'twq('] },
  { name: 'Pinterest Tag', match: ['s.pinimg.com/ct/', 'pintrk('] },
  { name: 'Snap Pixel', match: ['sc-static.net/scevent', 'snaptr('] },
  { name: 'Hotjar', match: ['static.hotjar.com', 'hotjar.com/c/hotjar'] },
  { name: 'Microsoft Clarity', match: ['clarity.ms'] },
  { name: 'Microsoft Advertising', match: ['bat.bing.com'] },
  { name: 'Mixpanel', match: ['cdn.mxpnl.com', 'mixpanel.init('] },
  { name: 'Segment', match: ['cdn.segment.com'] },
  { name: 'Amplitude', match: ['cdn.amplitude.com'] },
  { name: 'Heap', match: ['cdn.heapanalytics.com'] },
  { name: 'FullStory', match: ['fullstory.com/s/fs.js', 'edge.fullstory.com'] },
  { name: 'Yandex Metrica', match: ['mc.yandex.ru'] },
];

/** The known tracking tools this entry's code uses, by name, in KNOWN_TRACKERS order. */
export function trackersIn(entry: Pick<SiteCodeEntry, 'preset' | 'value'>): string[] {
  if (entry.preset === 'verification') return [];
  const code = siteCodeHtml(entry as SiteCodeEntry).toLowerCase();
  return KNOWN_TRACKERS.filter((tool) => tool.match.some((needle) => code.includes(needle))).map(
    (tool) => tool.name,
  );
}

/** Marked strictly necessary while it looks like a tracking tool, and not confirmed by the owner. */
function unconfirmedNecessaryTrackers(entry: SiteCodeEntry): string[] {
  if (entry.category !== 'necessary' || entry.necessaryConfirmed) return [];
  return trackersIn(entry);
}

/** Why this entry can't be saved as strictly necessary without the owner's confirmation, or null. */
export function necessaryTrackerProblem(entry: SiteCodeEntry): string | null {
  const tools = unconfirmedNecessaryTrackers(entry);
  if (!tools.length) return null;
  return `${entry.name}: this looks like ${tools.join(', ')}, which usually needs the reader’s agreement. Choose Analytics or Marketing, or confirm that it is strictly necessary.`;
}

/**
 * Why code may run on this install's own domain (<slug>.PLATFORM_SITE_DOMAIN). It always runs on
 * a publication's own custom domain. Table: migrations/0065_site_code_rules.sql.
 */
const SITE_CODE_REASONS = ['allowed', 'every_workspace', 'held', 'not_allowed'] as const;
export type SiteCodeReason = (typeof SITE_CODE_REASONS)[number];

export const SiteCodeAccessSchema = z
  .object({
    /** Whether code runs on the platform address. */
    platformAddress: z.boolean(),
    reason: z.enum(SITE_CODE_REASONS).openapi({
      description:
        '`allowed`: an instance admin allowed this workspace (a workspace an instance admin makes is allowed when it is made). `every_workspace`: an instance admin allowed every workspace. `held`: every workspace is allowed, but this workspace’s code was withheld when that was turned on, so it stays off until an instance admin allows this workspace by itself. `not_allowed`: code runs only on a custom domain. An owner seat held by an instance admin allows nothing by itself.',
    }),
    /** Whether the publication has an active custom web domain, where code always runs. */
    customDomain: z.boolean(),
  })
  .openapi('SiteCodeAccess');
export type SiteCodeAccess = z.infer<typeof SiteCodeAccessSchema>;
