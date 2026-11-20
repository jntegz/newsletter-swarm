// Queries and mutations for the App Directory (Phase 8): developers' listings, the directory,
// staff review and community Flow Recipes. Routes: workers/api/src/routes/{appDirectory,
// recipeSubmissions}.ts. Installed apps reuse the OAuth grant queries in ./oauth.
import type {
  AppCategory,
  AppListing,
  AppManifest,
  CommunityRecipeInfo,
  CreateAppListing,
  CreateRecipeSubmission,
  RecipeSubmission,
  ReviewDecisionInput,
  ReviewQueue,
  UpdateAppListing,
  WorkspaceDirectoryListing,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';

export const directoryKeys = {
  listings: (workspaceId: string) => ['workspaces', workspaceId, 'app-listings'] as const,
  directory: (workspaceId: string, q: string, category: string) =>
    ['workspaces', workspaceId, 'app-directory', { q, category }] as const,
  directoryAll: (workspaceId: string) => ['workspaces', workspaceId, 'app-directory'] as const,
  review: ['app-directory', 'review'] as const,
  submissions: (channelId: string) => ['channels', channelId, 'recipe-submissions'] as const,
  community: (channelId: string) => ['channels', channelId, 'community-recipes'] as const,
};

const base = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

/** feature_disabled means the App Directory is off here: callers hide it instead of erroring. */
export const isDirectoryOff = (error: unknown) =>
  error instanceof ApiError && error.code === 'feature_disabled';

const noRetryWhenOff = (count: number, error: Error) =>
  !isDirectoryOff(error) && !(error instanceof ApiError && error.status < 500) && count < 2;

// ---- Developers ------------------------------------------------------------------------------

export const appListingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: directoryKeys.listings(workspaceId),
    queryFn: ({ signal }) => api.get<AppListing[]>(`${base(workspaceId)}/app-listings`, signal),
    retry: noRetryWhenOff,
  });

function useListingMutation<I>(workspaceId: string, fn: (input: I) => Promise<AppListing>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: directoryKeys.listings(workspaceId) });
      void client.invalidateQueries({ queryKey: directoryKeys.directoryAll(workspaceId) });
    },
  });
}

export const useCreateListing = (workspaceId: string) =>
  useListingMutation(workspaceId, (input: CreateAppListing) =>
    api.post<AppListing>(`${base(workspaceId)}/app-listings`, input),
  );

export const useUpdateListing = (workspaceId: string) =>
  useListingMutation(workspaceId, ({ id, ...input }: UpdateAppListing & { id: string }) =>
    api.patch<AppListing>(`${base(workspaceId)}/app-listings/${id}`, input),
  );

export const useImportManifest = (workspaceId: string) =>
  useListingMutation(workspaceId, (input: { appId: string; manifest: unknown }) =>
    api.post<AppListing>(`${base(workspaceId)}/app-listings/import`, input),
  );

export const useListingAction = (workspaceId: string) =>
  useListingMutation(workspaceId, ({ id, action }: { id: string; action: 'submit' | 'withdraw' }) =>
    api.post<AppListing>(`${base(workspaceId)}/app-listings/${id}/${action}`),
  );

export function useDeleteListing(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(workspaceId)}/app-listings/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: directoryKeys.listings(workspaceId) }),
  });
}

export const fetchManifest = (workspaceId: string, listingId: string) =>
  api.get<AppManifest>(`${base(workspaceId)}/app-listings/${listingId}/manifest`);

// ---- Operators -------------------------------------------------------------------------------

export const directoryQuery = (workspaceId: string, q: string, category: AppCategory | '') =>
  queryOptions({
    queryKey: directoryKeys.directory(workspaceId, q, category),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (q.trim()) query.set('q', q.trim());
      if (category) query.set('category', category);
      const suffix = query.size ? `?${query}` : '';
      return api.get<WorkspaceDirectoryListing[]>(
        `${base(workspaceId)}/app-directory${suffix}`,
        signal,
      );
    },
    retry: noRetryWhenOff,
    placeholderData: (previous) => previous,
  });

// ---- Staff -----------------------------------------------------------------------------------

/** The review queue; 404 for anyone who is not platform staff, so the tab stays hidden. */
export const reviewQueueQuery = queryOptions({
  queryKey: directoryKeys.review,
  queryFn: ({ signal }) => api.get<ReviewQueue>('/api/v1/app-directory/review', signal),
  retry: false,
  staleTime: 30_000,
});

export function useReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      id,
      ...input
    }: ReviewDecisionInput & { kind: 'listings' | 'recipes'; id: string }) =>
      api.post(`/api/v1/app-directory/review/${kind}/${id}`, input),
    // Also after a refusal: a 409 means the item changed, and staff should see the new version.
    onSettled: () => client.invalidateQueries({ queryKey: directoryKeys.review }),
  });
}

// ---- Community Flow Recipes ------------------------------------------------------------------

export const recipeSubmissionsQuery = (channelId: string) =>
  queryOptions({
    queryKey: directoryKeys.submissions(channelId),
    queryFn: ({ signal }) =>
      api.get<RecipeSubmission[]>(`/api/v1/channels/${channelId}/recipe-submissions`, signal),
    retry: noRetryWhenOff,
  });

export const communityRecipesQuery = (channelId: string) =>
  queryOptions({
    queryKey: directoryKeys.community(channelId),
    queryFn: ({ signal }) =>
      api.get<CommunityRecipeInfo[]>(`/api/v1/channels/${channelId}/community-recipes`, signal),
    retry: noRetryWhenOff,
  });

export function useShareRecipe(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRecipeSubmission) =>
      api.post<RecipeSubmission>(`/api/v1/channels/${channelId}/recipe-submissions`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: directoryKeys.submissions(channelId) }),
  });
}

export function useRecipeAction(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'submit' | 'withdraw' | 'delete' }) =>
      action === 'delete'
        ? api.delete(`/api/v1/channels/${channelId}/recipe-submissions/${id}`)
        : api.post(`/api/v1/channels/${channelId}/recipe-submissions/${id}/${action}`),
    onSuccess: () => client.invalidateQueries({ queryKey: directoryKeys.submissions(channelId) }),
  });
}

export function useFlowFromCommunityRecipe(channelId: string) {
  return useMutation({
    mutationFn: (recipeId: string) =>
      api.post<{ id: string }>(`/api/v1/channels/${channelId}/community-recipes/${recipeId}/flows`),
  });
}
