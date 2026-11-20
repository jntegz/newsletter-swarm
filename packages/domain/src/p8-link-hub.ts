// Link Hub (Phase 8.3): link-in-bio page on the Channel site with click analytics, flag link_hub.
// Tables: migrations/0021_link_hub.sql. Docs: docs/link-hub.md. Shared by the api worker, the site
// worker and the dashboard.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Constants

/** Where the page is served on every host of the Channel's website. */
export const HUB_PATH = '/links';
/** The first-party click redirect: `/_swarm/hub/<linkId>`. */
export const HUB_CLICK_PREFIX = '/_swarm/hub/';
export const hubClickPath = (linkId: string) => `${HUB_CLICK_PREFIX}${linkId}`;

export const MAX_HUB_LINKS = 50;
export const MAX_HUB_SOCIALS = 12;
export const MAX_HUB_LATEST_DISPATCHES = 10;
/** Edge cache lifetime of /links, so scheduled links appear and disappear within a minute. */
export const HUB_EDGE_TTL_SECONDS = 60;

/** Analytics ranges are whole UTC days, both ends included. */
export const HUB_ANALYTICS_DEFAULT_DAYS = 30;
export const HUB_ANALYTICS_MAX_DAYS = 366;

/** Networks a social profile can be labelled with; `website` for anything else. */
export const HUB_SOCIAL_NETWORKS = [
  'bluesky',
  'mastodon',
  'threads',
  'x',
  'instagram',
  'facebook',
  'linkedin',
  'youtube',
  'tiktok',
  'twitch',
  'github',
  'website',
] as const;
export type HubSocialNetwork = (typeof HUB_SOCIAL_NETWORKS)[number];

export const HUB_SOCIAL_LABELS: Record<HubSocialNetwork, string> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  threads: 'Threads',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  twitch: 'Twitch',
  github: 'GitHub',
  website: 'Website',
};

// ---------------------------------------------------------------------------------------------
// Targets

/**
 * Why a link target can't be used, or null when it can: an absolute http or https URL with a
 * host, no user name or password, at most 2048 characters. The site checks it again before every
 * redirect.
 */
export function hubLinkUrlProblem(value: string): string | null {
  if (value.length > 2048) return 'Keep the address under 2,048 characters.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Use a full address starting with https://.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Use an address starting with https:// or http://.';
  }
  if (!url.hostname) return 'Use a full address starting with https://.';
  if (url.username || url.password) return 'Leave the user name and password out of the address.';
  return null;
}

/** Whether a link is shown at `now`: started (or no start) and not ended (or no end). */
export function hubLinkLive(
  link: { startsAt: number | null; endsAt: number | null },
  now: number,
): boolean {
  return (
    (link.startsAt === null || link.startsAt <= now) && (link.endsAt === null || now < link.endsAt)
  );
}

const HubUrlSchema = z
  .string()
  .trim()
  .min(1, 'Add an address.')
  .superRefine((value, ctx) => {
    const problem = hubLinkUrlProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an https address.');

// ---------------------------------------------------------------------------------------------
// Links

export const HubLinkSchema = z
  .object({
    id: id('hubLink'),
    channelId: id('channel'),
    title: z.string(),
    url: z.string(),
    thumbnailMediaId: z.string().nullable(),
    /** The thumbnail's public address, while the image is in the media library. */
    thumbnailUrl: z.string().nullable(),
    startsAt: timestamp.nullable(),
    endsAt: timestamp.nullable(),
    position: z.number().int(),
    /** Shown on the page right now (inside its start and end times). */
    live: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('HubLink');
export type HubLink = z.infer<typeof HubLinkSchema>;

const windowRefine = (
  value: { startsAt?: string | null | undefined; endsAt?: string | null | undefined },
  ctx: z.RefinementCtx,
) => {
  if (value.startsAt && value.endsAt && Date.parse(value.startsAt) >= Date.parse(value.endsAt)) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End after the start.' });
  }
};

export const CreateHubLinkSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the link a title.').max(80),
    url: HubUrlSchema,
    thumbnailMediaId: id('media').nullable().optional(),
    startsAt: timestamp.nullable().optional(),
    endsAt: timestamp.nullable().optional(),
    /** 0 puts it first; left out, it goes last. */
    position: z.number().int().min(0).max(MAX_HUB_LINKS).optional(),
  })
  .superRefine(windowRefine)
  .openapi('CreateHubLink');
export type CreateHubLink = z.infer<typeof CreateHubLinkSchema>;

export const UpdateHubLinkSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the link a title.').max(80).optional(),
    url: HubUrlSchema.optional(),
    thumbnailMediaId: id('media').nullable().optional(),
    startsAt: timestamp.nullable().optional(),
    endsAt: timestamp.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .superRefine(windowRefine)
  .openapi('UpdateHubLink');
export type UpdateHubLink = z.infer<typeof UpdateHubLinkSchema>;

export const ReorderHubLinksSchema = z
  .object({
    /** Every link of the page exactly once, in the new order. */
    ids: z.array(id('hubLink')).max(MAX_HUB_LINKS),
  })
  .openapi('ReorderHubLinks');
// ---------------------------------------------------------------------------------------------
// Settings

const HubSocialSchema = z
  .object({
    network: z.enum(HUB_SOCIAL_NETWORKS),
    url: HttpsUrlSchema,
  })
  .openapi('HubSocial');
export type HubSocial = z.infer<typeof HubSocialSchema>;

export const LinkHubSchema = z
  .object({
    channelId: id('channel'),
    /** The page is served only while this is on (and the flag is on). */
    enabled: z.boolean(),
    /** The page heading; the Channel name when null. */
    title: z.string().nullable(),
    bio: z.string().nullable(),
    socials: z.array(HubSocialSchema),
    /** How many of the newest Dispatches on the site to list (0 hides them). */
    latestDispatches: z.number().int(),
    showCaptureForm: z.boolean(),
    /** The Capture Form to show; null shows the Channel's site form. */
    captureFormId: z.string().nullable(),
    /** The page's address on the Channel's primary host. */
    url: z.string(),
    links: z.array(HubLinkSchema),
    updatedAt: timestamp.nullable(),
  })
  .openapi('LinkHub');
export type LinkHub = z.infer<typeof LinkHubSchema>;

export const UpdateLinkHubSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().trim().min(1).max(80).nullable().optional(),
    bio: z.string().trim().max(280).nullable().optional(),
    socials: z
      .array(HubSocialSchema)
      .max(MAX_HUB_SOCIALS, `Add at most ${MAX_HUB_SOCIALS} profiles.`)
      .optional(),
    latestDispatches: z.number().int().min(0).max(MAX_HUB_LATEST_DISPATCHES).optional(),
    showCaptureForm: z.boolean().optional(),
    captureFormId: id('captureForm').nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateLinkHub');
export type UpdateLinkHub = z.infer<typeof UpdateLinkHubSchema>;

// ---------------------------------------------------------------------------------------------
// Analytics

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-27.');

export const LinkHubAnalyticsQuerySchema = z.object({
  from: DaySchema.optional().openapi({ param: { name: 'from', in: 'query' } }),
  to: DaySchema.optional().openapi({ param: { name: 'to', in: 'query' } }),
  linkId: id('hubLink')
    .optional()
    .openapi({ param: { name: 'linkId', in: 'query' } }),
});
export const LinkHubAnalyticsSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    /** Clicks in the range (one link's when linkId is given). */
    clicks: z.number().int(),
    /** Views and visitors of /links from the site analytics, for click-through. */
    pageViews: z.number().int(),
    pageVisitors: z.number().int(),
    /** Every day of the range, with zeros. */
    byDay: z.array(z.object({ day: z.string(), clicks: z.number().int() })),
    /** Every link with clicks in the range or on the page now; deleted links have a null title. */
    byLink: z.array(
      z.object({ linkId: z.string(), title: z.string().nullable(), clicks: z.number().int() }),
    ),
    sources: z.array(z.object({ source: z.string(), clicks: z.number().int() })),
    countries: z.array(z.object({ country: z.string(), clicks: z.number().int() })),
  })
  .openapi('LinkHubAnalytics');
export type LinkHubAnalytics = z.infer<typeof LinkHubAnalyticsSchema>;
