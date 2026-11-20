// App Directory (Phase 8.12): listing of OAuth apps and the plugin specification, flag app_directory.
// Tables: migrations/0024_app_directory.sql. Docs: docs/app-directory.md.
//
// A listing describes one OAuth app (p7-oauth.ts) and moves draft → submitted → approved |
// rejected → delisted, reviewed by platform staff. The app manifest is the open plugin spec: a
// versioned JSON document that describes a listing, its OAuth settings and webhook use; its JSON
// Schema is published (docs/app-manifest.schema.json). Community Flow Recipes are sanitised copies
// of operators' Flows (packages/engine/src/app-directory.ts), reviewed the same way.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import {
  FlowEdgeSchema,
  FlowNodeIdSchema,
  FlowNodeTypeSchema,
  FlowTriggerTypeSchema,
} from './p6-flows';
import { API_SCOPES, ApiScopeSchema, WEBHOOK_EVENTS, WebhookEventTypeSchema } from './p7-platform';
import { redirectUriProblem } from './p7-oauth';
import { DispatchDocumentSchema } from './send';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Constants

export const APP_CATEGORIES = [
  'analytics',
  'flows',
  'commerce',
  'content',
  'crm',
  'design',
  'growth',
  'import_export',
  'productivity',
  'social',
  'other',
] as const;
const AppCategorySchema = z.enum(APP_CATEGORIES).openapi('AppCategory');
export type AppCategory = z.infer<typeof AppCategorySchema>;

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  analytics: 'Analytics',
  flows: 'Automations',
  commerce: 'Commerce',
  content: 'Content',
  crm: 'CRM',
  design: 'Design',
  growth: 'Growth',
  import_export: 'Import and export',
  productivity: 'Productivity',
  social: 'Social',
  other: 'Other',
};

/** Listings and community recipes share one review lifecycle. */
const REVIEW_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'delisted'] as const;
const ReviewStatusSchema = z.enum(REVIEW_STATUSES).openapi('ReviewStatus');
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const REVIEW_DECISIONS = ['approve', 'reject', 'delist'] as const;
type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * The status a staff decision moves a row to, or null when the row's status does not allow it:
 * approve and reject need `submitted`, delist needs `approved`.
 */
export function reviewOutcome(status: ReviewStatus, decision: ReviewDecision): ReviewStatus | null {
  if (decision === 'delist') return status === 'approved' ? 'delisted' : null;
  if (status !== 'submitted') return null;
  return decision === 'approve' ? 'approved' : 'rejected';
}

const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$/;
export const APP_MAX_SCREENSHOTS = 6;
export const APP_MAX_CATEGORIES = 3;
/** Requests a minute per client network on the public endpoint. */
export const APP_DIRECTORY_PUBLIC_RATE = 60;
export const APP_DIRECTORY_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';
export const APP_MANIFEST_VERSION = 1;

/** A slug from a name: lowercase ASCII letters and digits joined by single hyphens. */
export function slugifyAppName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : `app-${slug || 'listing'}`;
}

/**
 * Why a listing URL can't be used, or null when it can. The redirect-URI rules (absolute https,
 * no credentials, no fragment, no wildcard); `mailto:` only where `allowMailto` (support).
 */
export function listingUrlProblem(
  url: string,
  options: { allowHttp: boolean; allowMailto?: boolean },
): string | null {
  if (options.allowMailto && url.startsWith('mailto:')) {
    return /^mailto:[^@\s/?#]+@[^@\s/?#]+\.[^@\s/?#]+$/.test(url)
      ? null
      : 'Use mailto: followed by one address.';
  }
  return redirectUriProblem(url, options.allowHttp);
}

// ---------------------------------------------------------------------------------------------
// The app manifest (open plugin spec, version 1). Strict objects: unknown keys are refused, so a
// manifest never loses fields silently. No transforms, so the JSON Schema is exact.

const urlString = z.string().min(1).max(2000);

const AppManifestListingSchema = z
  .strictObject({
    name: z.string().min(1).max(80),
    slug: z.string().regex(APP_SLUG_PATTERN).optional(),
    tagline: z.string().min(1).max(120),
    description: z.string().max(5000).default(''),
    categories: z.array(AppCategorySchema).min(1).max(APP_MAX_CATEGORIES),
    websiteUrl: urlString,
    supportUrl: urlString,
    privacyUrl: urlString,
    installUrl: urlString,
  })
  .meta({ description: 'What the directory shows. Icons and screenshots are added from Media.' });

export const AppManifestSchema = z
  .strictObject({
    $schema: z.string().max(2000).optional(),
    manifestVersion: z.literal(APP_MANIFEST_VERSION),
    listing: AppManifestListingSchema,
    oauth: z.strictObject({
      clientType: z.enum(['public', 'confidential']),
      redirectUris: z.array(urlString).min(1).max(10),
      scopes: z.array(ApiScopeSchema).min(1).max(API_SCOPES.length),
    }),
    webhooks: z
      .strictObject({ events: z.array(WebhookEventTypeSchema).max(WEBHOOK_EVENTS.length) })
      .default({ events: [] }),
  })
  .meta({
    title: 'Swarm app manifest',
    description:
      'Describes an OAuth app for the Swarm App Directory: its listing, OAuth settings and the Event Webhooks it uses. Spec: docs/app-directory.md.',
  })
  .openapi('AppManifest');
export type AppManifest = z.infer<typeof AppManifestSchema>;

/** The manifest's JSON Schema (draft 2020-12), as published and committed. */
export function appManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AppManifestSchema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------------------------
// Listings

const scopesSchema = z
  .array(ApiScopeSchema)
  .max(API_SCOPES.length)
  .transform((scopes) => [...new Set(scopes)].sort());
const eventsSchema = z
  .array(WebhookEventTypeSchema)
  .max(WEBHOOK_EVENTS.length)
  .transform((events) => [...new Set(events)].sort());

/** Create and update share one shape; every field is optional on update. */
const UpsertAppListingSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the listing.').max(80),
    slug: z.string().trim().regex(APP_SLUG_PATTERN, 'Use 2 to 50 lowercase letters, digits or -.'),
    tagline: z.string().trim().min(1, 'Add a tagline.').max(120),
    description: z.string().trim().max(5000),
    iconMediaId: id('media').nullable(),
    screenshotMediaIds: z.array(id('media')).max(APP_MAX_SCREENSHOTS),
    categories: z
      .array(AppCategorySchema)
      .max(APP_MAX_CATEGORIES)
      .transform((c) => [...new Set(c)]),
    scopes: scopesSchema,
    webhookEvents: eventsSchema,
    websiteUrl: z.string().trim().max(2000).nullable(),
    supportUrl: z.string().trim().max(2000).nullable(),
    privacyUrl: z.string().trim().max(2000).nullable(),
    installUrl: z.string().trim().max(2000).nullable(),
  })
  .partial();

export const CreateAppListingSchema = UpsertAppListingSchema.extend({
  appId: id('oauthApp'),
  name: z.string().trim().min(1, 'Name the listing.').max(80),
}).openapi('CreateAppListing');
export type CreateAppListing = z.input<typeof CreateAppListingSchema>;

export const UpdateAppListingSchema = UpsertAppListingSchema.openapi('UpdateAppListing');
export type UpdateAppListing = z.input<typeof UpdateAppListingSchema>;

export const ImportAppManifestSchema = z
  .object({ appId: id('oauthApp'), manifest: z.unknown() })
  .openapi('ImportAppManifest');
const imageSchema = z.object({ mediaId: z.string(), url: z.string() });

/** A listing as its developer sees it. */
export const AppListingSchema = z
  .object({
    id: id('appListing'),
    appId: id('oauthApp'),
    appName: z.string(),
    /** The app was revoked: the listing is hidden from the directory. */
    appRevoked: z.boolean(),
    status: ReviewStatusSchema,
    name: z.string(),
    slug: z.string(),
    tagline: z.string(),
    description: z.string(),
    icon: imageSchema.nullable(),
    screenshots: z.array(imageSchema),
    categories: z.array(AppCategorySchema),
    scopes: z.array(ApiScopeSchema),
    webhookEvents: z.array(WebhookEventTypeSchema),
    websiteUrl: z.string().nullable(),
    supportUrl: z.string().nullable(),
    privacyUrl: z.string().nullable(),
    installUrl: z.string().nullable(),
    /** Staff's note on the last decision (always set for rejected and staff-delisted). */
    reviewNote: z.string().nullable(),
    submittedAt: timestamp.nullable(),
    reviewedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('AppListing');
export type AppListing = z.infer<typeof AppListingSchema>;

const scopeWithLabel = z.object({ scope: ApiScopeSchema, label: z.string() });

/** An approved listing as operators and the public endpoint see it. */
export const DirectoryListingSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    tagline: z.string(),
    description: z.string(),
    iconUrl: z.string().nullable(),
    screenshotUrls: z.array(z.string()),
    categories: z.array(AppCategorySchema),
    scopes: z.array(scopeWithLabel),
    /** Registered on the app but not declared by the listing: shown as "May also ask for". */
    extraScopes: z.array(scopeWithLabel),
    webhookEvents: z.array(WebhookEventTypeSchema),
    websiteUrl: z.string(),
    supportUrl: z.string(),
    privacyUrl: z.string(),
    installUrl: z.string(),
    approvedAt: timestamp,
  })
  .openapi('DirectoryListing');
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

/** The dashboard's view adds whether the app is installed on the workspace. */
export const WorkspaceDirectoryListingSchema = DirectoryListingSchema.extend({
  appId: id('oauthApp'),
  /** The active grant on this workspace, when the app is installed. */
  installedGrantId: z.string().nullable(),
}).openapi('WorkspaceDirectoryListing');
export type WorkspaceDirectoryListing = z.infer<typeof WorkspaceDirectoryListingSchema>;

export const DirectoryQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: AppCategorySchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Community Flow Recipes

/**
 * A step of a sanitised recipe. `config` holds only what the sanitiser kept; `needsSetup` names
 * the settings it removed that the step cannot run without (the Flow gets it as a pending step).
 */
const RecipeNodeSchema = z.object({
  id: FlowNodeIdSchema,
  type: FlowNodeTypeSchema,
  name: z.string().max(80).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: z.record(z.string(), z.unknown()),
  needsSetup: z.array(z.string()).optional(),
});
export type RecipeNode = z.infer<typeof RecipeNodeSchema>;

const RecipeEmailSchema = z.object({
  /** send_email steps refer to the email by this key (config.emailKey). */
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  subject: z.string().max(200),
  preheader: z.string().max(200),
  content: DispatchDocumentSchema,
});
export type RecipeEmail = z.infer<typeof RecipeEmailSchema>;

const CommunityRecipeGraphSchema = z
  .object({
    schema: z.literal(1),
    triggerType: FlowTriggerTypeSchema,
    reentry: z.enum(['never', 'after_exit']),
    nodes: z.array(RecipeNodeSchema),
    edges: z.array(FlowEdgeSchema),
    emails: z.array(RecipeEmailSchema),
  })
  .openapi('CommunityRecipeGraph');
export type CommunityRecipeGraph = z.infer<typeof CommunityRecipeGraphSchema>;

/** What the sanitiser took out of one step (or an email), for the operator and the reviewer. */
const RecipeRemovalSchema = z
  .object({
    nodeId: z.string().nullable(),
    emailKey: z.string().nullable(),
    what: z.string(),
  })
  .openapi('RecipeRemoval');
export type RecipeRemoval = z.infer<typeof RecipeRemovalSchema>;

export const RecipeSubmissionSchema = z
  .object({
    id: id('recipeSubmission'),
    channelId: z.string().nullable(),
    flowId: z.string().nullable(),
    status: ReviewStatusSchema,
    name: z.string(),
    description: z.string(),
    triggerType: FlowTriggerTypeSchema,
    emailCount: z.number().int(),
    recipe: CommunityRecipeGraphSchema,
    removed: z.array(RecipeRemovalSchema),
    reviewNote: z.string().nullable(),
    submittedAt: timestamp.nullable(),
    reviewedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('RecipeSubmission');
export type RecipeSubmission = z.infer<typeof RecipeSubmissionSchema>;

export const CreateRecipeSubmissionSchema = z
  .object({
    flowId: id('flow'),
    name: z.string().trim().min(1, 'Name the recipe.').max(80),
    description: z.string().trim().min(1, 'Describe what the recipe does.').max(500),
  })
  .openapi('CreateRecipeSubmission');
export type CreateRecipeSubmission = z.input<typeof CreateRecipeSubmissionSchema>;

/** An approved community recipe, shown next to the built-in Flow Recipes. */
export const CommunityRecipeInfoSchema = z
  .object({
    id: id('recipeSubmission'),
    name: z.string(),
    description: z.string(),
    triggerType: FlowTriggerTypeSchema,
    emailCount: z.number().int(),
    /** Steps that need the Channel's own settings before the Flow can be published. */
    setupSteps: z.number().int(),
    approvedAt: timestamp,
  })
  .openapi('CommunityRecipeInfo');
export type CommunityRecipeInfo = z.infer<typeof CommunityRecipeInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Review (platform staff)

export const ReviewDecisionSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    note: z.string().trim().max(1000).optional(),
    /**
     * For a listing: the `reviewVersion` the queue showed. Approving a listing needs it, and a
     * decision on a listing or app that changed since is refused, so staff approve what they saw.
     */
    version: z.string().max(128).optional(),
  })
  .refine((v) => v.decision === 'approve' || (v.note?.length ?? 0) > 0, {
    message: 'Give the developer a reason.',
    path: ['note'],
  })
  .openapi('ReviewDecision');
export type ReviewDecisionInput = z.input<typeof ReviewDecisionSchema>;

export const ReviewQueueSchema = z
  .object({
    listings: z.array(
      AppListingSchema.extend({
        /** The app's registration as it is now, to compare with what the listing declares. */
        app: z.object({
          clientType: z.enum(['public', 'confidential']),
          scopes: z.array(ApiScopeSchema),
          redirectUris: z.array(z.string()),
          homepageUrl: z.string().nullable(),
        }),
        /** Names this listing and app as shown; sent back with the decision. */
        reviewVersion: z.string(),
      }),
    ),
    approvedListings: z.array(AppListingSchema),
    recipes: z.array(RecipeSubmissionSchema),
    approvedRecipes: z.array(RecipeSubmissionSchema),
  })
  .openapi('AppReviewQueue');
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;
