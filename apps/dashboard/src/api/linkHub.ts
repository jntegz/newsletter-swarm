// Queries and mutations for Link Hub (Phase 8, flag link_hub): the /links page's settings and
// links, and its click report.
import type {
  CreateHubLink,
  HubLink,
  LinkHub,
  LinkHubAnalytics,
  UpdateHubLink,
  UpdateLinkHub,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { isFeatureDisabled } from './site';

const linkHubKeys = {
  hub: (channelId: string) => ['channels', channelId, 'link-hub'] as const,
  analytics: (channelId: string) => ['channels', channelId, 'link-hub', 'analytics'] as const,
};

const base = (channelId: string) => `/api/v1/channels/${channelId}/link-hub`;

export const linkHubQuery = (channelId: string) =>
  queryOptions({
    queryKey: linkHubKeys.hub(channelId),
    queryFn: ({ signal }) => api.get<LinkHub>(base(channelId), signal),
    // feature_disabled is an answer, not a hiccup.
    retry: (count, error) => !isFeatureDisabled(error) && count < 2,
  });

interface LinkHubRange {
  from: string;
  to: string;
  linkId?: string | undefined;
}

export const linkHubAnalyticsQuery = (channelId: string, range: LinkHubRange) =>
  queryOptions({
    queryKey: [...linkHubKeys.analytics(channelId), range],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (range.linkId) params.set('linkId', range.linkId);
      return api.get<LinkHubAnalytics>(`${base(channelId)}/analytics?${params}`, signal);
    },
    placeholderData: (previous) => previous,
  });

export function useUpdateLinkHub(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLinkHub) => api.patch<LinkHub>(base(channelId), input),
    onSuccess: (hub) => client.setQueryData(linkHubKeys.hub(channelId), hub),
  });
}

function useLinkMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: linkHubKeys.hub(channelId) }),
  });
}

export const useCreateHubLink = (channelId: string) =>
  useLinkMutation(channelId, (input: CreateHubLink) =>
    api.post<HubLink>(`${base(channelId)}/links`, input),
  );

export const useUpdateHubLink = (channelId: string) =>
  useLinkMutation(channelId, ({ id, ...input }: UpdateHubLink & { id: string }) =>
    api.patch<HubLink>(`${base(channelId)}/links/${id}`, input),
  );

export const useDeleteHubLink = (channelId: string) =>
  useLinkMutation(channelId, (id: string) => api.delete(`${base(channelId)}/links/${id}`));

export function useReorderHubLinks(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.put<LinkHub>(`${base(channelId)}/order`, { ids }),
    onSuccess: (hub) => client.setQueryData(linkHubKeys.hub(channelId), hub),
  });
}
