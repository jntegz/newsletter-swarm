// Queries and mutations for Circles (Phase 3), plus the profile fields and tags the builder
// offers as conditions.
import type {
  Circle,
  CircleListItem,
  CirclePreview,
  CircleRule,
  CreateCircle,
  DispatchAudience,
  Member,
  MemberField,
  Preflight,
  Tag,
  UpdateCircle,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, request } from './client';

type Page<T> = { items: T[]; nextCursor: string | null };

const circleKeys = {
  all: (channelId: string) => ['channels', channelId, 'circles'] as const,
  list: (channelId: string, cursor: string | null) =>
    ['channels', channelId, 'circles', 'list', { cursor }] as const,
  every: (channelId: string) => ['channels', channelId, 'circles', 'every'] as const,
  preview: (channelId: string, rule: string) =>
    ['channels', channelId, 'circles', 'preview', rule] as const,
  circle: (id: string) => ['circles', id] as const,
  /** Keyed by the evaluation, so a finished refresh loads the new membership. */
  members: (id: string, evaluatedAt: string | null, cursor: string | null) =>
    ['circles', id, 'members', { evaluatedAt, cursor }] as const,
  fields: (channelId: string) => ['channels', channelId, 'member-fields'] as const,
  tags: (channelId: string) => ['channels', channelId, 'tags'] as const,
};

/** Still being evaluated by the jobs worker. */
export const isEvaluating = (circle: Pick<Circle, 'status'>) =>
  circle.status === 'pending' || circle.status === 'refreshing';

const POLL_MS = 2000;

export const circlesQuery = (channelId: string, cursor: string | null) =>
  queryOptions({
    queryKey: circleKeys.list(channelId, cursor),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<CircleListItem>>(
        `/api/v1/channels/${channelId}/circles?${params}`,
        signal,
      );
    },
    refetchInterval: (query) => (query.state.data?.items.some(isEvaluating) ? POLL_MS * 2 : false),
  });

/** Every Circle in the Channel (up to 1,000), for pickers. */
export const allCirclesQuery = (channelId: string) =>
  queryOptions({
    queryKey: circleKeys.every(channelId),
    queryFn: async ({ signal }) => {
      const items: CircleListItem[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page: Page<CircleListItem> = await api.get<Page<CircleListItem>>(
          `/api/v1/channels/${channelId}/circles?${params}`,
          signal,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return items;
    },
    staleTime: 30_000,
  });

export const circleQuery = (id: string) =>
  queryOptions({
    queryKey: circleKeys.circle(id),
    queryFn: ({ signal }) => api.get<Circle>(`/api/v1/circles/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && isEvaluating(query.state.data) ? POLL_MS : false,
  });

export const circleMembersQuery = (id: string, evaluatedAt: string | null, cursor: string | null) =>
  queryOptions({
    queryKey: circleKeys.members(id, evaluatedAt, cursor),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<Member>>(`/api/v1/circles/${id}/members?${params}`, signal);
    },
  });

export const memberFieldsQuery = (channelId: string) =>
  queryOptions({
    queryKey: circleKeys.fields(channelId),
    queryFn: ({ signal }) =>
      api.get<MemberField[]>(`/api/v1/channels/${channelId}/member-fields`, signal),
    staleTime: 30_000,
  });

export const tagsQuery = (channelId: string) =>
  queryOptions({
    queryKey: circleKeys.tags(channelId),
    queryFn: ({ signal }) => api.get<Tag[]>(`/api/v1/channels/${channelId}/tags`, signal),
    staleTime: 30_000,
  });

/** Returns `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The live count and sample for an unsaved rule. Pass the rule only when it is complete; the
 * previous result stays on screen while the next one loads.
 */
export const circlePreviewQuery = (channelId: string, rule: CircleRule | null) => {
  const json = rule ? JSON.stringify(rule) : '';
  return queryOptions({
    queryKey: circleKeys.preview(channelId, json),
    queryFn: ({ signal }) =>
      request<CirclePreview>('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        json: { rule },
        signal,
      }),
    enabled: !!rule,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
};

function useInvalidateCircles(channelId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: circleKeys.all(channelId) });
}

export function useCreateCircle(channelId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateCircles(channelId);
  return useMutation({
    mutationFn: (input: CreateCircle) =>
      api.post<Circle>(`/api/v1/channels/${channelId}/circles`, input),
    onSuccess: (circle) => {
      client.setQueryData(circleKeys.circle(circle.id), circle);
      void invalidate();
    },
  });
}

export function useUpdateCircle(circle: Pick<Circle, 'id' | 'channelId'>) {
  const client = useQueryClient();
  const invalidate = useInvalidateCircles(circle.channelId);
  return useMutation({
    mutationFn: (input: UpdateCircle) => api.patch<Circle>(`/api/v1/circles/${circle.id}`, input),
    onSuccess: (saved) => {
      client.setQueryData(circleKeys.circle(circle.id), saved);
      void client.invalidateQueries({ queryKey: [...circleKeys.circle(circle.id), 'members'] });
      void invalidate();
    },
  });
}

export function useRefreshCircle(circle: Pick<Circle, 'id' | 'channelId'>) {
  const client = useQueryClient();
  const invalidate = useInvalidateCircles(circle.channelId);
  return useMutation({
    mutationFn: () => api.post<Circle>(`/api/v1/circles/${circle.id}/refresh`),
    onSuccess: (saved) => {
      client.setQueryData(circleKeys.circle(circle.id), saved);
      void invalidate();
    },
  });
}

export function useDeleteCircle(circle: Pick<Circle, 'id' | 'channelId'>) {
  const client = useQueryClient();
  const invalidate = useInvalidateCircles(circle.channelId);
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/circles/${circle.id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: circleKeys.circle(circle.id) });
      void invalidate();
    },
  });
}

/**
 * The exact recipient count for a Dispatch's saved audience, from preflight. Keyed by the
 * audience rather than shared with the checklist, so content autosaves don't recount.
 */
export const audienceCountQuery = (dispatchId: string, audience: DispatchAudience) =>
  queryOptions({
    queryKey: ['dispatches', dispatchId, 'audience-count', audience] as const,
    queryFn: ({ signal }) =>
      api.get<Preflight>(`/api/v1/dispatches/${dispatchId}/preflight`, signal),
    select: (preflight) => ({
      recipientCount: preflight.recipientCount,
      problem: preflight.checks.find((c) => c.key === 'audience' && !c.ok)?.message ?? null,
    }),
    staleTime: 60_000,
  });
