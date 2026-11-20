// Feed Sync (Dispatches → Feed Sync, Phase 8): feed sources, their items, check now and preview.
import type {
  CreateFeedSource,
  FeedCheckResult,
  FeedItem,
  FeedPreview,
  FeedSource,
  UpdateFeedSource,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { isFeatureDisabled } from './site';

const base = (channelId: string) => `/api/v1/channels/${channelId}/feed-sources`;

const feedKeys = {
  all: (channelId: string) => ['channels', channelId, 'feed-sources'] as const,
  items: (channelId: string, sourceId: string) =>
    [...feedKeys.all(channelId), sourceId, 'items'] as const,
  preview: (channelId: string, sourceId: string) =>
    [...feedKeys.all(channelId), sourceId, 'preview'] as const,
};

export const feedSourcesQuery = (channelId: string) =>
  queryOptions({
    queryKey: feedKeys.all(channelId),
    queryFn: ({ signal }) => api.get<FeedSource[]>(base(channelId), signal),
    // feature_disabled is an answer, not a hiccup.
    retry: (count, error) => !isFeatureDisabled(error) && count < 2,
    // Checks run on their own every minute; keep the status fresh while the page is open.
    refetchInterval: (query) => (query.state.error ? false : 60_000),
  });

export const feedItemsQuery = (channelId: string, sourceId: string) =>
  queryOptions({
    queryKey: feedKeys.items(channelId, sourceId),
    queryFn: ({ signal }) => api.get<FeedItem[]>(`${base(channelId)}/${sourceId}/items`, signal),
  });

export const feedPreviewQuery = (channelId: string, sourceId: string) =>
  queryOptions({
    queryKey: feedKeys.preview(channelId, sourceId),
    queryFn: ({ signal }) => api.get<FeedPreview>(`${base(channelId)}/${sourceId}/preview`, signal),
    retry: false,
  });

function useInvalidate(channelId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: feedKeys.all(channelId) });
}

export function useCreateFeedSource(channelId: string) {
  const invalidate = useInvalidate(channelId);
  return useMutation({
    mutationFn: (input: CreateFeedSource) => api.post<FeedSource>(base(channelId), input),
    onSuccess: invalidate,
  });
}

export function useUpdateFeedSource(channelId: string, sourceId: string) {
  const invalidate = useInvalidate(channelId);
  return useMutation({
    mutationFn: (input: UpdateFeedSource) =>
      api.patch<FeedSource>(`${base(channelId)}/${sourceId}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteFeedSource(channelId: string) {
  const invalidate = useInvalidate(channelId);
  return useMutation({
    mutationFn: (sourceId: string) => api.delete(`${base(channelId)}/${sourceId}`),
    onSuccess: invalidate,
  });
}

export function useCheckFeedSource(channelId: string) {
  const invalidate = useInvalidate(channelId);
  return useMutation({
    mutationFn: (sourceId: string) =>
      api.post<FeedCheckResult>(`${base(channelId)}/${sourceId}/check`),
    onSuccess: invalidate,
  });
}
