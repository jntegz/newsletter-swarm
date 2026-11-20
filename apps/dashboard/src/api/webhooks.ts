// Event Webhooks (Settings → Developers → Webhooks): endpoints, the delivery log and redrive.
import type {
  CreateWebhookEndpoint,
  UpdateWebhookEndpoint,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookEventType,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const base = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/webhooks`;

const webhookKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'webhooks'] as const,
  endpoint: (workspaceId: string, endpointId: string) =>
    [...webhookKeys.all(workspaceId), endpointId] as const,
  deliveries: (workspaceId: string, endpointId: string) =>
    [...webhookKeys.endpoint(workspaceId, endpointId), 'deliveries'] as const,
};

export const webhookEndpointsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: webhookKeys.all(workspaceId),
    queryFn: ({ signal }) => api.get<WebhookEndpoint[]>(base(workspaceId), signal),
  });

export const webhookEndpointQuery = (workspaceId: string, endpointId: string) =>
  queryOptions({
    queryKey: webhookKeys.endpoint(workspaceId, endpointId),
    queryFn: ({ signal }) => api.get<WebhookEndpoint>(`${base(workspaceId)}/${endpointId}`, signal),
  });

export interface DeliveryFilter {
  status: WebhookDeliveryStatus | '';
  eventType: WebhookEventType | '';
}

export const webhookDeliveriesQuery = (
  workspaceId: string,
  endpointId: string,
  filter: DeliveryFilter,
  cursor: string | null,
) =>
  queryOptions({
    queryKey: [...webhookKeys.deliveries(workspaceId, endpointId), filter, cursor],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (filter.status) params.set('status', filter.status);
      if (filter.eventType) params.set('eventType', filter.eventType);
      if (cursor) params.set('cursor', cursor);
      return api.get<{ items: WebhookDelivery[]; nextCursor: string | null }>(
        `${base(workspaceId)}/${endpointId}/deliveries?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
    // Pending and retrying rows change on their own; keep the log fresh while it is open.
    refetchInterval: 15_000,
  });

export const webhookDeliveryQuery = (workspaceId: string, endpointId: string, deliveryId: string) =>
  queryOptions({
    queryKey: [...webhookKeys.deliveries(workspaceId, endpointId), 'detail', deliveryId],
    queryFn: ({ signal }) =>
      api.get<WebhookDeliveryDetail>(
        `${base(workspaceId)}/${endpointId}/deliveries/${deliveryId}`,
        signal,
      ),
  });

function useInvalidate(workspaceId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: webhookKeys.all(workspaceId) });
}

export function useCreateWebhook(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: CreateWebhookEndpoint) =>
      api.post<WebhookEndpointWithSecret>(base(workspaceId), input),
    onSuccess: invalidate,
  });
}

export function useUpdateWebhook(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: UpdateWebhookEndpoint) =>
      api.patch<WebhookEndpoint>(`${base(workspaceId)}/${endpointId}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteWebhook(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (endpointId: string) => api.delete<void>(`${base(workspaceId)}/${endpointId}`),
    onSuccess: invalidate,
  });
}

/** Confirm an endpoint a key or app proposed, or adopt one whose admin left (needs step-up). */
export function useConfirmWebhook(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: () => api.post<WebhookEndpoint>(`${base(workspaceId)}/${endpointId}/confirm`),
    onSuccess: invalidate,
  });
}

export function useRotateWebhookSecret(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: () =>
      api.post<WebhookEndpointWithSecret>(`${base(workspaceId)}/${endpointId}/rotate-secret`),
    onSuccess: invalidate,
  });
}

export function useSendTestWebhook(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (type: WebhookEventType | undefined) =>
      api.post<WebhookDelivery>(`${base(workspaceId)}/${endpointId}/test`, type ? { type } : {}),
    onSuccess: invalidate,
  });
}

export function useRedriveDelivery(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.post<WebhookDelivery>(
        `${base(workspaceId)}/${endpointId}/deliveries/${deliveryId}/redrive`,
      ),
    onSuccess: invalidate,
  });
}

export function useRedriveFailed(workspaceId: string, endpointId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (since: string) =>
      api.post<{ redriven: number }>(`${base(workspaceId)}/${endpointId}/redrive`, { since }),
    onSuccess: invalidate,
  });
}
