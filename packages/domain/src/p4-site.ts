// Site Studio API (Phase 4): settings, sections, pages, redirects, Bot Rules, web hostnames and
// site analytics. Shared by the api worker and the dashboard.
import { z } from '@hono/zod-openapi';
import {
  MAX_SITE_CODE_ENTRIES,
  SiteCodeAccessSchema,
  SiteCodeEntrySchema,
  SiteConsentSchema,
} from './p8-site-code';
import { idPattern } from './ids';
import { DispatchDocumentSchema, DomainNameSchema } from './send';
import {
  AiBotsPolicySchema,
  KNOWN_AI_BOTS,
  RESERVED_SITE_PATHS,
  SiteLayoutSchema,
  SiteSlugSchema,
} from './site';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Limits

/** Custom pages per Channel by plan (the matrix: 5 on free, unlimited on paid plans). */
export const SITE_PAGE_LIMITS: Record<string, number> = { free: 5 };
/** Redirects per Channel by plan: unlimited on paid plans, 50 on free. */
export const SITE_REDIRECT_LIMITS: Record<string, number> = { free: 50 };
export const MAX_PINNED = 3;
export const MAX_NAV_LINKS = 20;
export const MAX_SECTIONS = 50;
/** Web hostnames (web and apex rows together) per Channel. */
export const MAX_HOSTNAMES = 10;
/** Rows in one redirect CSV import. */
export const MAX_REDIRECT_IMPORT_ROWS = 5000;

// ---------------------------------------------------------------------------------------------
// Shared pieces

/** A site path ("/about", "/p/hello") or an https URL. */
const SiteHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => isSitePath(value) || isHttpsUrl(value),
    'Use a path on the site (starting with /) or an https address.',
  );

export function isSitePath(value: string): boolean {
  return /^\/(?!\/)[^\s\\]*$/.test(value) && !value.includes('\0');
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A page or section slug: lowercase letters, digits and hyphens, at most 60 characters. */
const SitePageSlugSchema = SiteSlugSchema.pipe(z.string().min(1).max(60));

/** Slugs a custom page can't take, so it never shadows a system route. */
export const isReservedSitePath = (slug: string) =>
  (RESERVED_SITE_PATHS as readonly string[]).includes(slug);

// ---------------------------------------------------------------------------------------------
// Settings

const NavLinkSchema = z
  .object({ label: z.string().trim().min(1).max(40), href: SiteHrefSchema })
  .openapi('SiteNavLink');
export type NavLink = z.infer<typeof NavLinkSchema>;

const VerificationTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_\-.=]{1,120}$/, 'Paste only the token value.');

const SiteSeoSchema = z
  .object({
    /** Default social image, from this workspace's media library. */
    ogMediaId: id('media').nullable().optional(),
    verification: z
      .object({
        google: VerificationTokenSchema.optional(),
        bing: VerificationTokenSchema.optional(),
      })
      .optional(),
    /** Profiles of the Channel elsewhere (JSON-LD sameAs). */
    sameAs: z
      .array(z.string().trim().max(2048).refine(isHttpsUrl, 'Use an https address.'))
      .max(10)
      .optional(),
  })
  .openapi('SiteSeo');

const SITE_TEMPLATES = [
  'gate',
  'letter',
  'magazine',
  'newspaper',
  'launch',
  'night',
  'zine',
  'brief',
] as const;
export const SiteTemplateSchema = z.enum(SITE_TEMPLATES);
export type SiteTemplate = z.infer<typeof SiteTemplateSchema>;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1a2b3c.');

/** Why an owner's CSS can't be used, or null. It may not load anything from elsewhere. */
export function customCssProblem(css: string): string | null {
  if (css.length > CUSTOM_CSS_MAX) return `Keep your CSS under ${CUSTOM_CSS_MAX} characters.`;
  const plain = css.replace(/\\/g, '').toLowerCase();
  if (plain.includes('</')) return 'CSS can’t contain “</”.';
  if (css.includes('\\')) return 'CSS can’t contain backslash escapes.';
  if (plain.includes('@import')) return '@import isn’t allowed: it loads a file from elsewhere.';
  if (/url\(\s*(?!['"]?data:image\/)/.test(plain)) {
    return 'url() can only hold a data:image. Files from other sites aren’t allowed.';
  }
  if (/expression\(|javascript:|behaviou?r\s*:|-moz-binding/.test(plain)) {
    return 'That CSS can run code, so it isn’t allowed.';
  }
  return null;
}
const CUSTOM_CSS_MAX = 20_000;

const SiteThemeSchema = z
  .object({
    /** Needs the site_templates flag. Unset keeps the layout setting's look. */
    template: SiteTemplateSchema.optional(),
    font: z.enum(['geist', 'inter', 'grotesk', 'archivo', 'serif']).optional(),
    /** The large heading on the home page; the publication's name when empty. */
    headline: z.string().trim().max(120).optional(),
    /** The line under it; the publication's description when empty. */
    pitch: z.string().trim().max(400).optional(),
    /** What subscribers get, listed on the Launch template. */
    benefits: z.array(z.string().trim().min(1).max(160)).max(6).optional(),
    showSubscriberCount: z.boolean().optional(),
    pageColor: HexColorSchema.optional(),
    inkColor: HexColorSchema.optional(),
    colorScheme: z.enum(['light', 'dark', 'auto']).optional(),
    dropCaps: z.boolean().optional(),
  })
  .openapi('SiteTheme');
export type SiteTheme = z.infer<typeof SiteThemeSchema>;

export const SiteSettingsSchema = z
  .object({
    channelId: id('channel'),
    layout: SiteLayoutSchema,
    /** Up to 3 Dispatch ids shown first on the home page. */
    pinned: z.array(id('dispatch')),
    about: DispatchDocumentSchema,
    nav: z.array(NavLinkSchema),
    seo: SiteSeoSchema,
    theme: SiteThemeSchema,
    /** The owner's own CSS, added after the template's. */
    customCss: z.string(),
    /** Needs the site_custom_code flag. Admin only. */
    consent: SiteConsentSchema,
    code: z.array(SiteCodeEntrySchema),
    /** Where the code runs: always on a custom domain, on the platform address only if allowed. */
    codeAccess: SiteCodeAccessSchema,
    aiBots: AiBotsPolicySchema,
    exposeGated: z.boolean(),
    prevNextNav: z.boolean(),
    /** Bumped on every change that affects rendered pages. */
    cacheVersion: z.number().int(),
    /** Where the site is served: the primary active custom hostname, else the platform address. */
    url: z.string(),
    /** The platform address, which always works. */
    platformUrl: z.string(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('SiteSettings');
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

export const UpdateSiteSettingsSchema = z
  .object({
    layout: SiteLayoutSchema.optional(),
    pinned: z.array(id('dispatch')).max(MAX_PINNED, 'Pin at most 3 posts.').optional(),
    about: DispatchDocumentSchema.optional(),
    nav: z.array(NavLinkSchema).max(MAX_NAV_LINKS).optional(),
    seo: SiteSeoSchema.optional(),
    theme: SiteThemeSchema.optional(),
    /** Needs the admin role and the site_templates flag. */
    customCss: z.string().optional(),
    /** Needs the admin role and the site_custom_code flag. */
    consent: SiteConsentSchema.optional(),
    code: z.array(SiteCodeEntrySchema).max(MAX_SITE_CODE_ENTRIES).optional(),
    /** Changing it needs the admin role, like the Bot Rules. */
    aiBots: AiBotsPolicySchema.optional(),
    /** Needs the gated_seo_exposure flag. */
    exposeGated: z.boolean().optional(),
    prevNextNav: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSiteSettings');
export type UpdateSiteSettings = z.infer<typeof UpdateSiteSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Sections

export const SiteSectionSchema = z
  .object({
    id: id('siteSection'),
    channelId: id('channel'),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    position: z.number().int(),
    /** Dispatches on the site in this section. */
    dispatchCount: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('SiteSection');
export type SiteSection = z.infer<typeof SiteSectionSchema>;

export const CreateSiteSectionSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the section.').max(60),
    slug: SitePageSlugSchema.optional(),
    description: z.string().trim().max(280).nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .openapi('CreateSiteSection');
export type CreateSiteSection = z.infer<typeof CreateSiteSectionSchema>;

export const UpdateSiteSectionSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    slug: SitePageSlugSchema.optional(),
    description: z.string().trim().max(280).nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSiteSection');
export type UpdateSiteSection = z.infer<typeof UpdateSiteSectionSchema>;

// ---------------------------------------------------------------------------------------------
// Pages

const SitePageStatusSchema = z.enum(['draft', 'published']).openapi('SitePageStatus');

const SitePageSummarySchema = z
  .object({
    id: id('sitePage'),
    channelId: id('channel'),
    slug: z.string(),
    title: z.string(),
    status: SitePageStatusSchema,
    inNav: z.boolean(),
    position: z.number().int(),
    /** Set on a landing page: the form it shows. The page leaves out the site's navigation. */
    landingFormId: id('captureForm').nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('SitePageSummary');
export type SitePageSummary = z.infer<typeof SitePageSummarySchema>;

export const SitePageSchema = SitePageSummarySchema.extend({
  content: DispatchDocumentSchema,
  url: z.string(),
}).openapi('SitePage');
export type SitePage = z.infer<typeof SitePageSchema>;

export const SitePageListSchema = z
  .object({
    items: z.array(SitePageSummarySchema),
    /** Null when the plan has no limit. */
    limit: z.number().int().nullable(),
  })
  .openapi('SitePageList');

export const CreateSitePageSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the page a title.').max(120),
    slug: SitePageSlugSchema.optional(),
    content: DispatchDocumentSchema.optional(),
    status: SitePageStatusSchema.optional(),
    inNav: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    landingFormId: id('captureForm').nullable().optional(),
  })
  .openapi('CreateSitePage');
export type CreateSitePage = z.infer<typeof CreateSitePageSchema>;

export const UpdateSitePageSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    slug: SitePageSlugSchema.optional(),
    content: DispatchDocumentSchema.optional(),
    status: SitePageStatusSchema.optional(),
    inNav: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    landingFormId: id('captureForm').nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSitePage');
export type UpdateSitePage = z.infer<typeof UpdateSitePageSchema>;

// ---------------------------------------------------------------------------------------------
// Redirects

const RedirectStatusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
  z.literal(308),
]);

/** An exact path on the site: starts with one slash, no query, fragment or whitespace. */
const RedirectFromSchema = z
  .string()
  .trim()
  .max(512)
  .regex(/^\/(?!\/)[^\s?#\\]*$/, 'Use a path on the site, such as /old-post.')
  .refine((path) => path !== '/', 'The home page can’t be redirected.')
  .refine((path) => !/^\/_swarm(\/|$)/.test(path), 'Paths under /_swarm belong to the platform.')
  // Trailing slashes are dropped so /old and /old/ are one redirect.
  .transform((path) => (path.length > 1 ? path.replace(/\/+$/, '') : path));

const RedirectToSchema = SiteHrefSchema.pipe(z.string().max(2048));

export const SiteRedirectSchema = z
  .object({
    id: id('siteRedirect'),
    channelId: id('channel'),
    from: z.string(),
    to: z.string(),
    statusCode: RedirectStatusCodeSchema,
    createdAt: timestamp,
  })
  .openapi('SiteRedirect');
export type SiteRedirect = z.infer<typeof SiteRedirectSchema>;

export const SiteRedirectListSchema = z
  .object({
    items: z.array(SiteRedirectSchema),
    /** Null when the plan has no limit. */
    limit: z.number().int().nullable(),
  })
  .openapi('SiteRedirectList');

export const CreateSiteRedirectSchema = z
  .object({
    from: RedirectFromSchema,
    to: RedirectToSchema,
    statusCode: RedirectStatusCodeSchema.optional(),
  })
  .openapi('CreateSiteRedirect');
export type CreateSiteRedirect = z.infer<typeof CreateSiteRedirectSchema>;

export const UpdateSiteRedirectSchema = z
  .object({
    to: RedirectToSchema.optional(),
    statusCode: RedirectStatusCodeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSiteRedirect');

export const ImportRedirectsSchema = z
  .object({
    /**
     * CSV with the columns from, to and optionally status (301, 302, 307 or 308). A header row
     * is optional. Existing redirects from the same path are replaced.
     */
    csv: z
      .string()
      .min(1)
      .max(512 * 1024),
  })
  .openapi('ImportRedirects');

export const RedirectImportResultSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  })
  .openapi('RedirectImportResult');
export type RedirectImportResult = z.infer<typeof RedirectImportResultSchema>;

// ---------------------------------------------------------------------------------------------
// Bot Rules

const botKeys = KNOWN_AI_BOTS.map((bot) => bot.key) as [string, ...string[]];
const AiBotKeySchema = z.enum(botKeys).openapi('AiBotKey');
const BotActionSchema = z.enum(['allow', 'block']).openapi('BotAction');

export const BotRulesSchema = z
  .object({
    policy: AiBotsPolicySchema,
    /** Per-crawler choices; they apply when the policy is custom. */
    overrides: z.record(z.string(), BotActionSchema),
    /** Every known crawler with what the site does with it now. */
    agents: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        robots: z.string(),
        action: BotActionSchema,
      }),
    ),
  })
  .openapi('BotRules');
export type BotRules = z.infer<typeof BotRulesSchema>;

export const UpdateBotRulesSchema = z
  .object({
    policy: AiBotsPolicySchema,
    overrides: z.partialRecord(AiBotKeySchema, BotActionSchema).optional(),
  })
  .openapi('UpdateBotRules');
export type UpdateBotRules = z.infer<typeof UpdateBotRulesSchema>;

// ---------------------------------------------------------------------------------------------
// Web hostnames

const HostnameRoleSchema = z.enum(['web', 'apex_redirect']).openapi('HostnameRole');
const HostnameStatusSchema = z
  .enum(['pending', 'active', 'failed', 'removed'])
  .openapi('HostnameStatus');

const HostnameRecordSchema = z
  .object({
    type: z.enum(['CNAME', 'ALIAS']),
    name: z.string(),
    value: z.string(),
    note: z.string().optional(),
  })
  .openapi('HostnameRecord');
export type HostnameRecord = z.infer<typeof HostnameRecordSchema>;

const CustomHostnameSchema = z
  .object({
    id: id('customHostname'),
    channelId: id('channel'),
    hostname: z.string(),
    role: HostnameRoleSchema,
    /** Only verified hostnames are active, and only active hostnames are served. */
    status: HostnameStatusSchema,
    isPrimary: z.boolean(),
    records: z.array(HostnameRecordSchema),
    detail: z.string().nullable(),
    lastCheckedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .openapi('CustomHostname');
export type CustomHostname = z.infer<typeof CustomHostnameSchema>;

export const AddWebDomainSchema = z
  .object({
    /**
     * The web hostname, e.g. www.example.com. A bare domain (example.com) is taken as its www
     * hostname with the bare domain redirecting to it.
     */
    hostname: DomainNameSchema,
    /** Also redirect the bare domain to the web hostname (only for www hostnames). */
    redirectApex: z.boolean().optional(),
  })
  .openapi('AddWebDomain');
export type AddWebDomain = z.infer<typeof AddWebDomainSchema>;

const RoleStatusSchema = z.enum(['active', 'pending', 'failed', 'not_set_up']);

/** One domain, four roles: web, root redirect, email sending and links. */
const DomainRolesSchema = z
  .object({
    domain: z.string(),
    web: z.object({ hostname: z.string(), status: RoleStatusSchema, id: z.string().nullable() }),
    apexRedirect: z.object({
      hostname: z.string(),
      status: RoleStatusSchema,
      id: z.string().nullable(),
    }),
    email: z.object({
      hostname: z.string().nullable(),
      status: RoleStatusSchema,
      id: z.string().nullable(),
    }),
    link: z.object({
      hostname: z.string().nullable(),
      status: RoleStatusSchema,
      id: z.string().nullable(),
    }),
  })
  .openapi('DomainRoles');
export type DomainRoles = z.infer<typeof DomainRolesSchema>;

// ---------------------------------------------------------------------------------------------
// Analytics

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-27.');

export const SiteAnalyticsQuerySchema = z.object({
  from: DaySchema.optional().openapi({ param: { name: 'from', in: 'query' } }),
  to: DaySchema.optional().openapi({ param: { name: 'to', in: 'query' } }),
  path: z
    .string()
    .max(512)
    .optional()
    .openapi({ param: { name: 'path', in: 'query' } }),
  source: z
    .string()
    .max(120)
    .optional()
    .openapi({ param: { name: 'source', in: 'query' } }),
});

const Counted = z.object({ views: z.number().int(), visitors: z.number().int() });

export const SiteAnalyticsSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    /** Visitors are summed from daily rollups, so they approximate unique visitors. */
    totals: Counted,
    byDay: z.array(Counted.extend({ day: z.string() })),
    topPaths: z.array(Counted.extend({ path: z.string() })),
    topSources: z.array(Counted.extend({ source: z.string() })),
    devices: z.array(Counted.extend({ device: z.string() })),
    countries: z.array(Counted.extend({ country: z.string() })),
  })
  .openapi('SiteAnalytics');
export type SiteAnalytics = z.infer<typeof SiteAnalyticsSchema>;

/** Web hostnames of a Channel and every domain they belong to with all four roles. */
export const WebDomainListSchema = z
  .object({
    hostnames: z.array(CustomHostnameSchema),
    domains: z.array(DomainRolesSchema),
    /** Where operators point their CNAME records. */
    cnameTarget: z.string(),
    /** False when this deployment has custom web domains switched off. */
    available: z.boolean(),
  })
  .openapi('WebDomainList');
export type WebDomainList = z.infer<typeof WebDomainListSchema>;

// ---------------------------------------------------------------------------------------------
// Author pages (flag author_pages)

/** A teammate's public profile on a Channel's website, at /authors/<slug>. */
export const AuthorProfileSchema = z
  .object({
    operatorId: id('operator'),
    channelId: id('channel'),
    slug: z.string(),
    name: z.string(),
    bio: z.string().nullable(),
    avatarMediaId: id('media').nullable(),
    /** The avatar's public URL, when it is still in the media library. */
    avatarUrl: z.string().nullable(),
    /** Where the page is on the website. */
    url: z.string(),
    /** Dispatches by this teammate on the website: their bylines link here. */
    dispatchCount: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('AuthorProfile');
export type AuthorProfile = z.infer<typeof AuthorProfileSchema>;

export const UpsertAuthorProfileSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter the name readers see.').max(80),
    /** Made from the name unless given. */
    slug: SiteSlugSchema.pipe(z.string().max(60)).optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
    /** An image from the Channel's media library. */
    avatarMediaId: id('media').nullable().optional(),
  })
  .openapi('UpsertAuthorProfile');
export type UpsertAuthorProfile = z.infer<typeof UpsertAuthorProfileSchema>;

// ---------------------------------------------------------------------------------------------
// Landing page starters

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const bullets = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((text) => ({ type: 'listItem', content: [para(text)] })),
});
const heading = (text: string) => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});

/**
 * Starting text for a new landing page. Everything in square brackets is a prompt for the owner to
 * replace with their own words; the rest can stay as it is. Each starter leads with what the
 * visitor gets, says what happens after they sign up, and ends just above the form.
 */
export const LANDING_TEMPLATES = [
  {
    id: 'signup',
    name: 'Newsletter signup',
    description: 'What readers get, how often, and why it is worth their time.',
    title: 'Get [your newsletter] by email',
    content: {
      type: 'doc',
      content: [
        para('[One sentence: what you write about, and who it is for.]'),
        heading('What you get'),
        bullets([
          '[What arrives and how often, for example: one practical idea every Tuesday morning]',
          '[Why it is worth opening, for example: written from ten years of doing this for a living]',
          '[What it costs, for example: free, and one click to unsubscribe]',
        ]),
        para('[Optional: a line from a reader, or how many people already read it.]'),
      ],
    },
  },
  {
    id: 'download',
    name: 'Free download',
    description: 'Offer a guide or checklist in return for joining.',
    title: 'Get [the guide] free',
    content: {
      type: 'doc',
      content: [
        para('[One sentence: what the guide helps people do, and how long it takes to read.]'),
        heading('What’s inside'),
        bullets([
          '[The first thing they will be able to do after reading it]',
          '[The second thing]',
          '[The third thing]',
        ]),
        para(
          'Enter your email below and it’s yours. [Say how it arrives, for example: the download link comes by email within a minute.] You will also get [your newsletter], and you can unsubscribe at any time.',
        ),
      ],
    },
  },
  {
    id: 'waitlist',
    name: 'Waitlist',
    description: 'Collect people before something launches.',
    title: '[Your project] is coming',
    content: {
      type: 'doc',
      content: [
        para('[One sentence: what you are making, and who it is for.]'),
        heading('Why join the list'),
        bullets([
          'Be the first to hear when it opens [say when you expect that to be]',
          '[What early subscribers get, for example: a launch discount, early access, or a say in what gets built]',
          'One or two updates along the way, and nothing else',
        ]),
      ],
    },
  },
] as const;
export type LandingTemplateId = (typeof LANDING_TEMPLATES)[number]['id'];
