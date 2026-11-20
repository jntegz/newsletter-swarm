// Queries and mutations for Rosters (Phase 8, flag rosters): the Rosters page, the audience
// panel's Roster part and conflict counts, and a Member's Rosters in the member drawer.
import type {
  CreateRoster,
  MemberRosters,
  Roster,
  RosterAudience,
  RosterMember,
  RosterOverlap,
  RosterStatus,
  UpdateRoster,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, request } from './client';

type Page<T> = { items: T[]; nextCursor: string | null };

const rosterKeys = {
  all: (channelId: string) => ['channels', channelId, 'rosters'] as const,
  list: (channelId: string) => ['channels', channelId, 'rosters', 'list'] as const,
  members: (channelId: string, rosterId: string, status: string, cursor: string | null) =>
    ['channels', channelId, 'rosters', rosterId, 'members', { status, cursor }] as const,
  overlap: (channelId: string, audience: string) =>
    ['channels', channelId, 'rosters', 'overlap', audience] as const,
  member: (channelId: string, memberId: string) =>
    ['channels', channelId, 'rosters', 'member', memberId] as const,
};

export const rostersQuery = (channelId: string, enabled = true) =>
  queryOptions({
    queryKey: rosterKeys.list(channelId),
    queryFn: async ({ signal }) =>
      (await api.get<{ items: Roster[] }>(`/api/v1/channels/${channelId}/rosters`, signal)).items,
    staleTime: 30_000,
    enabled,
  });

export const rosterMembersQuery = (
  channelId: string,
  rosterId: string,
  status: RosterStatus | 'all',
  cursor: string | null,
) =>
  queryOptions({
    queryKey: rosterKeys.members(channelId, rosterId, status, cursor),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (status !== 'all') params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<RosterMember>>(
        `/api/v1/channels/${channelId}/rosters/${rosterId}/members?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });

/** Counts for an audience's Roster part: who it reaches and how many are in both lists. */
export const rosterOverlapQuery = (channelId: string, rosters: RosterAudience | null) =>
  queryOptions({
    queryKey: rosterKeys.overlap(channelId, rosters ? JSON.stringify(rosters) : ''),
    queryFn: ({ signal }) =>
      request<RosterOverlap>('POST', `/api/v1/channels/${channelId}/rosters/overlap`, {
        json: rosters,
        signal,
      }),
    enabled: !!rosters && (rosters.include.length > 0 || rosters.exclude.length > 0),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });

export const memberRostersQuery = (channelId: string, memberId: string, enabled = true) =>
  queryOptions({
    queryKey: rosterKeys.member(channelId, memberId),
    queryFn: async ({ signal }) =>
      (
        await api.get<MemberRosters>(
          `/api/v1/channels/${channelId}/members/${memberId}/rosters`,
          signal,
        )
      ).items,
    enabled,
  });

function useInvalidateRosters(channelId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: rosterKeys.all(channelId) });
}

export function useCreateRoster(channelId: string) {
  const invalidate = useInvalidateRosters(channelId);
  return useMutation({
    mutationFn: (input: CreateRoster) =>
      api.post<Roster>(`/api/v1/channels/${channelId}/rosters`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateRoster(channelId: string, rosterId: string) {
  const invalidate = useInvalidateRosters(channelId);
  return useMutation({
    mutationFn: (input: UpdateRoster) =>
      api.patch<Roster>(`/api/v1/channels/${channelId}/rosters/${rosterId}`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteRoster(channelId: string, rosterId: string) {
  const invalidate = useInvalidateRosters(channelId);
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/channels/${channelId}/rosters/${rosterId}`),
    onSuccess: () => void invalidate(),
  });
}

export function useSetMemberRoster(channelId: string, memberId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateRosters(channelId);
  return useMutation({
    mutationFn: ({ rosterId, status }: { rosterId: string; status: RosterStatus }) =>
      request<MemberRosters>(
        'PUT',
        `/api/v1/channels/${channelId}/members/${memberId}/rosters/${rosterId}`,
        { json: { status } },
      ),
    onSuccess: (saved) => {
      client.setQueryData(rosterKeys.member(channelId, memberId), saved.items);
      void invalidate();
    },
  });
}
