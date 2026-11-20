// Settings → Developers: API keys (Phase 7). OAuth apps and webhooks add their queries beside.
import type { ApiKey, CreateApiKey, CreatedApiKey } from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const developerKeys = {
  apiKeys: (workspaceId: string) => ['workspaces', workspaceId, 'api-keys'] as const,
};

export const apiKeysQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: developerKeys.apiKeys(workspaceId),
    queryFn: ({ signal }) =>
      api.get<ApiKey[]>(`/api/v1/workspaces/${workspaceId}/api-keys`, signal),
  });

export function useCreateApiKey(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKey) =>
      api.post<CreatedApiKey>(`/api/v1/workspaces/${workspaceId}/api-keys`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.apiKeys(workspaceId) }),
  });
}

/** Keep a suspended key: changing it (here, its name as it is) makes you stand behind it. */
export function useKeepApiKey(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: Pick<ApiKey, 'id' | 'name'>) =>
      api.patch<ApiKey>(`/api/v1/workspaces/${workspaceId}/api-keys/${key.id}`, {
        name: key.name,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.apiKeys(workspaceId) }),
  });
}

export function useRevokeApiKey(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/workspaces/${workspaceId}/api-keys/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.apiKeys(workspaceId) }),
  });
}

/** The public API's documents, served by the api worker (proxied in development). */
export const API_REFERENCE_URL = '/v2/reference';
export const API_OPENAPI_URL = '/v2/openapi.json';
