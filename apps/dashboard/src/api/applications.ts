// Shorthop's connection (its card on the Apps page) and the short links writers make.
// docs/applications.md.
import type {
  ConnectShorthop,
  CreateShortLink,
  ShortLink,
  ShorthopConnection,
  ShorthopStatus,
  UpdateShorthop,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const path = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/applications/shorthop`;
const connectionKey = (workspaceId: string) => ['workspaces', workspaceId, 'shorthop'] as const;
const statusKey = (channelId: string) => ['channels', channelId, 'shorthop'] as const;

export const shorthopConnectionQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: connectionKey(workspaceId),
    queryFn: ({ signal }) => api.get<ShorthopConnection>(path(workspaceId), signal),
  });

export const shorthopStatusQuery = (channelId: string) =>
  queryOptions({
    queryKey: statusKey(channelId),
    queryFn: ({ signal }) =>
      api.get<ShorthopStatus>(`/api/v1/channels/${channelId}/applications/shorthop`, signal),
  });

function useChange<Input>(workspaceId: string, call: (input: Input) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: connectionKey(workspaceId) });
      // Every publication's editor follows the workspace's connection.
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'channels' && query.queryKey[2] === 'shorthop',
      });
    },
  });
}

export const useConnectShorthop = (workspaceId: string) =>
  useChange(workspaceId, (input: ConnectShorthop) =>
    api.put<ShorthopConnection>(path(workspaceId), input),
  );

export const useUpdateShorthop = (workspaceId: string) =>
  useChange(workspaceId, (input: UpdateShorthop) =>
    api.patch<ShorthopConnection>(path(workspaceId), input),
  );

export const useDisconnectShorthop = (workspaceId: string) =>
  useChange(workspaceId, () => api.delete(path(workspaceId)));

export const useCreateShortLink = (channelId: string) =>
  useMutation({
    mutationFn: (input: CreateShortLink) =>
      api.post<ShortLink>(`/api/v1/channels/${channelId}/applications/shorthop/links`, input),
  });
