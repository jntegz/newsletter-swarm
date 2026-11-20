// How long engagement history stays tied to a person (Settings → Privacy).
import type { EngagementRetention, FormerTeammate, UpdateEngagementRetention } from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const retentionKey = (workspaceId: string) => ['workspaces', workspaceId, 'retention'] as const;

export const retentionQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: retentionKey(workspaceId),
    queryFn: ({ signal }) =>
      api.get<EngagementRetention>(`/api/v1/workspaces/${workspaceId}/retention`, signal),
  });

export function useSetRetention(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEngagementRetention) =>
      api.put<EngagementRetention>(`/api/v1/workspaces/${workspaceId}/retention`, input),
    onSuccess: (saved) => client.setQueryData(retentionKey(workspaceId), saved),
  });
}

const formerKey = (workspaceId: string) => ['workspaces', workspaceId, 'former-teammates'] as const;

/** People who worked here and no longer do (owners only). */
export const formerTeammatesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: formerKey(workspaceId),
    queryFn: ({ signal }) =>
      api.get<FormerTeammate[]>(`/api/v1/workspaces/${workspaceId}/former-teammates`, signal),
  });

export function useRedactTeammate(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operatorId: string) =>
      api.post<FormerTeammate>(
        `/api/v1/workspaces/${workspaceId}/former-teammates/${operatorId}/redact`,
        {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: formerKey(workspaceId) }),
  });
}
