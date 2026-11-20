// Queries and mutations for the Privacy Center (the data-request queue) and export destinations.
import type {
  ApproveDsrRequest,
  CreateDsrRequest,
  CreateExportDestination,
  DsrKind,
  DsrRequest,
  DsrStatus,
  ExportDestination,
  ExportDestinationPatch,
  ExportDestinationTest,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const privacyKeys = {
  requests: (workspaceId: string) => ['workspaces', workspaceId, 'privacy-requests'] as const,
  destinations: (channelId: string) => ['channels', channelId, 'export-destinations'] as const,
};

interface RequestFilter {
  cursor?: string | null;
  status?: DsrStatus | undefined;
  kind?: DsrKind | undefined;
}

export const privacyRequestsQuery = (workspaceId: string, filter: RequestFilter = {}) => {
  const key = { cursor: filter.cursor ?? null, status: filter.status, kind: filter.kind };
  return queryOptions({
    queryKey: [...privacyKeys.requests(workspaceId), key],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (key.cursor) params.set('cursor', key.cursor);
      if (key.status) params.set('status', key.status);
      if (key.kind) params.set('kind', key.kind);
      return api.get<{ items: DsrRequest[]; nextCursor: string | null }>(
        `/api/v1/workspaces/${workspaceId}/privacy/requests?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
    // Requests move on within a minute of approval; keep the queue current while it's open.
    refetchInterval: 30_000,
  });
};

function useRequestMutation<V>(workspaceId: string, run: (vars: V) => Promise<DsrRequest>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: privacyKeys.requests(workspaceId) }),
  });
}

const requestsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/privacy/requests`;

export const useCreatePrivacyRequest = (workspaceId: string) =>
  useRequestMutation(workspaceId, (input: CreateDsrRequest) =>
    api.post<DsrRequest>(requestsPath(workspaceId), input),
  );

export const useApprovePrivacyRequest = (workspaceId: string) =>
  useRequestMutation(workspaceId, ({ id, ...input }: ApproveDsrRequest & { id: string }) =>
    api.post<DsrRequest>(`${requestsPath(workspaceId)}/${id}/approve`, input),
  );

export const useRejectPrivacyRequest = (workspaceId: string) =>
  useRequestMutation(workspaceId, ({ id, note }: { id: string; note: string }) =>
    api.post<DsrRequest>(`${requestsPath(workspaceId)}/${id}/reject`, { note }),
  );

export const useRetryPrivacyRequest = (workspaceId: string) =>
  useRequestMutation(workspaceId, (id: string) =>
    api.post<DsrRequest>(`${requestsPath(workspaceId)}/${id}/retry`),
  );

// ---- Export destinations ---------------------------------------------------------------------

export const exportDestinationsQuery = (channelId: string) =>
  queryOptions({
    queryKey: privacyKeys.destinations(channelId),
    queryFn: ({ signal }) =>
      api.get<ExportDestination[]>(`/api/v1/channels/${channelId}/export-destinations`, signal),
  });

function useDestinationMutation<V, R>(channelId: string, run: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: privacyKeys.destinations(channelId) }),
  });
}

export const useCreateExportDestination = (channelId: string) =>
  useDestinationMutation(channelId, (input: CreateExportDestination) =>
    api.post<ExportDestination>(`/api/v1/channels/${channelId}/export-destinations`, input),
  );

export const useUpdateExportDestination = (channelId: string) =>
  useDestinationMutation(channelId, ({ id, ...patch }: ExportDestinationPatch & { id: string }) =>
    api.patch<ExportDestination>(`/api/v1/export-destinations/${id}`, patch),
  );

/** Adopt a destination whose admin left, so it runs on your authority (needs step-up). */
export const useConfirmExportDestination = (channelId: string) =>
  useDestinationMutation(channelId, (id: string) =>
    api.post<ExportDestination>(`/api/v1/export-destinations/${id}/confirm`),
  );

export const useDeleteExportDestination = (channelId: string) =>
  useDestinationMutation(channelId, (id: string) =>
    api.delete(`/api/v1/export-destinations/${id}`),
  );

export const useTestExportDestination = () =>
  useMutation({
    mutationFn: (id: string) =>
      api.post<ExportDestinationTest>(`/api/v1/export-destinations/${id}/test`),
  });
