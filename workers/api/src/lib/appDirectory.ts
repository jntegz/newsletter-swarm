// App Directory (Phase 8.12) helpers shared by routes/appDirectory.ts and
// routes/recipeSubmissions.ts: the flag, platform staff, media and the row mappers.
// Contract: docs/app-directory.md.
import { all, appendAudit, first, sha256Hex, toIso } from '@swarm/db';
import {
  SCOPE_LABELS,
  type ApiScope,
  type AppListing,
  type CommunityRecipeGraph,
  type DirectoryListing,
  type RecipeRemoval,
  type RecipeSubmission,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { ApiError } from '@swarm/runtime';
import { requireAuth } from './access';
import { clientIp, env, type AppContext, type AuthContext } from './context';
import { ipPrefix } from './crypto';

export const DIRECTORY_OFF = 'The App Directory is not available.';

/** Refuses with feature_disabled (404) when app_directory is off for the workspace. */
export async function requireDirectoryFlag(c: AppContext, workspaceId: string): Promise<void> {
  const e = env(c);
  const on = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('app_directory', {
    workspaceId,
  });
  if (!on) throw new ApiError('feature_disabled', DIRECTORY_OFF);
}

/** The public endpoint follows the platform-scope value only. */
export async function directoryPublic(c: AppContext): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('app_directory', {});
}

/**
 * A platform staff member on a session that proved a second factor (passkey, authenticator app
 * or recovery code). Anyone else gets 404, so the routes are not revealed.
 */
export async function requireStaff(c: AppContext): Promise<AuthContext> {
  const auth = requireAuth(c);
  const staff = await first(
    env(c).DB,
    'SELECT 1 AS ok FROM platform_staff WHERE operator_id = ?1',
    auth.operatorId,
  );
  if (!staff) throw new ApiError('not_found', 'Not found.');
  if (!auth.mfaMethod || auth.mfaMethod === 'sso') {
    throw new ApiError('forbidden', 'Sign in with your passkey or authenticator app to review.', [
      { path: 'secondFactor', message: 'staff_second_factor_required' },
    ]);
  }
  return auth;
}

/** A staff decision, audited in the workspace that owns the row. */
export const auditReview = (
  c: AppContext,
  auth: AuthContext,
  workspaceId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId,
    actorId: auth.operatorId,
    action,
    targetType,
    targetId,
    metadata: { ...metadata, staff: true },
    ipPrefix: ipPrefix(clientIp(c)),
  });

// ---------------------------------------------------------------------------------------------
// Media

interface MediaRef {
  id: string;
  url: string;
}

/**
 * Public, undeleted images by id; with `workspaceId`, only that workspace's. Ids that are not
 * returned are not usable.
 */
export async function loadImages(
  c: AppContext,
  ids: readonly string[],
  workspaceId?: string,
): Promise<Map<string, MediaRef>> {
  if (!ids.length) return new Map();
  const e = env(c);
  const rows = await all<{ id: string; r2_key: string }>(
    e.DB,
    `SELECT id, r2_key FROM media
      WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL AND visibility = 'public'
        AND content_type LIKE 'image/%' AND (?2 IS NULL OR workspace_id = ?2)`,
    JSON.stringify([...new Set(ids)]),
    workspaceId ?? null,
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, url: `${e.MEDIA_ORIGIN}/media/${r.r2_key}` }]));
}

// ---------------------------------------------------------------------------------------------
// Listings

export interface ListingRow {
  id: string;
  app_id: string;
  workspace_id: string;
  status: AppListing['status'];
  name: string;
  slug: string;
  tagline: string;
  description: string;
  icon_media_id: string | null;
  screenshots_json: string;
  categories_json: string;
  scopes_json: string;
  webhook_events_json: string;
  website_url: string | null;
  support_url: string | null;
  privacy_url: string | null;
  install_url: string | null;
  review_note: string | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
  /** Joined from oauth_apps. */
  app_name: string;
  app_scopes: string;
  app_revoked_at: number | null;
}

/** Listing columns with the app's name, scopes and revocation joined in. */
export const LISTING_SELECT = `SELECT l.*, a.name AS app_name, a.scopes_json AS app_scopes,
  a.revoked_at AS app_revoked_at FROM app_listings l JOIN oauth_apps a ON a.id = l.app_id`;

/** A listing as staff review it: with the app's registration too. */
export interface ReviewRow extends ListingRow {
  client_secret_hash: string | null;
  redirect_uris_json: string;
  homepage_url: string | null;
  app_updated_at: number;
}

export const REVIEW_SELECT = `SELECT l.*, a.name AS app_name, a.scopes_json AS app_scopes,
  a.revoked_at AS app_revoked_at, a.client_secret_hash, a.redirect_uris_json, a.homepage_url,
  a.updated_at AS app_updated_at FROM app_listings l JOIN oauth_apps a ON a.id = l.app_id`;

/**
 * Names the listing and app as the review queue showed them. Any edit, return to draft or
 * resubmit moves the listing's updated_at and any change to the app moves the app's, and the
 * reviewed fields are included too, so a version from before a change never matches after it,
 * even when the status is back to submitted.
 */
export const reviewVersion = (row: ReviewRow): Promise<string> =>
  sha256Hex(
    JSON.stringify([
      row.id,
      row.status,
      row.updated_at,
      row.submitted_at,
      row.name,
      row.slug,
      row.tagline,
      row.description,
      row.icon_media_id,
      row.screenshots_json,
      row.categories_json,
      row.scopes_json,
      row.webhook_events_json,
      row.website_url,
      row.support_url,
      row.privacy_url,
      row.install_url,
      row.app_updated_at,
      row.app_name,
      row.app_scopes,
      row.client_secret_hash !== null,
      row.redirect_uris_json,
      row.homepage_url,
      row.app_revoked_at,
    ]),
  );

export const listingMediaIds = (rows: readonly ListingRow[]) =>
  rows.flatMap((r) => [
    ...(r.icon_media_id ? [r.icon_media_id] : []),
    ...(JSON.parse(r.screenshots_json) as string[]),
  ]);

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

export function toListing(row: ListingRow, media: Map<string, MediaRef>): AppListing {
  const icon = row.icon_media_id ? media.get(row.icon_media_id) : undefined;
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    appRevoked: row.app_revoked_at !== null,
    status: row.status,
    name: row.name,
    slug: row.slug,
    tagline: row.tagline,
    description: row.description,
    icon: icon ? { mediaId: icon.id, url: icon.url } : null,
    screenshots: (JSON.parse(row.screenshots_json) as string[]).flatMap((id) => {
      const shot = media.get(id);
      return shot ? [{ mediaId: shot.id, url: shot.url }] : [];
    }),
    categories: JSON.parse(row.categories_json) as AppListing['categories'],
    scopes: JSON.parse(row.scopes_json) as ApiScope[],
    webhookEvents: JSON.parse(row.webhook_events_json) as AppListing['webhookEvents'],
    websiteUrl: row.website_url,
    supportUrl: row.support_url,
    privacyUrl: row.privacy_url,
    installUrl: row.install_url,
    reviewNote: row.review_note,
    submittedAt: iso(row.submitted_at),
    reviewedAt: iso(row.reviewed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const labelled = (scopes: readonly ApiScope[]) =>
  scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] }));

/** What operators and the public see. Only approved listings get here, so the URLs are set. */
export function toDirectoryListing(
  row: ListingRow,
  media: Map<string, MediaRef>,
): DirectoryListing {
  const scopes = JSON.parse(row.scopes_json) as ApiScope[];
  const declared = new Set(scopes);
  const appScopes = JSON.parse(row.app_scopes) as ApiScope[];
  return {
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    iconUrl: (row.icon_media_id && media.get(row.icon_media_id)?.url) || null,
    screenshotUrls: (JSON.parse(row.screenshots_json) as string[]).flatMap((id) => {
      const shot = media.get(id);
      return shot ? [shot.url] : [];
    }),
    categories: JSON.parse(row.categories_json) as DirectoryListing['categories'],
    scopes: labelled(scopes),
    extraScopes: labelled(appScopes.filter((s) => !declared.has(s))),
    webhookEvents: JSON.parse(row.webhook_events_json) as DirectoryListing['webhookEvents'],
    websiteUrl: row.website_url ?? '',
    supportUrl: row.support_url ?? '',
    privacyUrl: row.privacy_url ?? '',
    installUrl: row.install_url ?? '',
    approvedAt: toIso(row.reviewed_at ?? row.updated_at),
  };
}

/** Approved listings of unrevoked apps, newest approval first, filtered by text and category. */
export async function directoryRows(
  c: AppContext,
  filter: { q?: string | undefined; category?: string | undefined; slug?: string },
): Promise<ListingRow[]> {
  return all<ListingRow>(
    env(c).DB,
    `${LISTING_SELECT}
      WHERE l.status = 'approved' AND a.revoked_at IS NULL
        AND (?1 IS NULL OR instr(lower(l.name || ' ' || l.tagline || ' ' || l.description), ?1) > 0)
        AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(l.categories_json) WHERE value = ?2))
        AND (?3 IS NULL OR l.slug = ?3)
      ORDER BY l.reviewed_at DESC, l.id LIMIT 100`,
    filter.q ? filter.q.toLowerCase() : null,
    filter.category ?? null,
    filter.slug ?? null,
  );
}

// ---------------------------------------------------------------------------------------------
// Recipe submissions

export interface RecipeRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  flow_id: string | null;
  status: RecipeSubmission['status'];
  name: string;
  description: string;
  trigger_type: string;
  email_count: number;
  setup_steps: number;
  recipe_json: string;
  removed_json: string;
  review_note: string | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export function toSubmission(row: RecipeRow): RecipeSubmission {
  return {
    id: row.id,
    channelId: row.channel_id,
    flowId: row.flow_id,
    status: row.status,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type as RecipeSubmission['triggerType'],
    emailCount: row.email_count,
    recipe: JSON.parse(row.recipe_json) as CommunityRecipeGraph,
    removed: JSON.parse(row.removed_json) as RecipeRemoval[],
    reviewNote: row.review_note,
    submittedAt: iso(row.submitted_at),
    reviewedAt: iso(row.reviewed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
