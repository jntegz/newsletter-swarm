// Queries and mutations for Goods (flag goods): products and their orders.
import type { CreateGood, Good, GoodOrder, UpdateGood } from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { isFeatureDisabled } from './site';

const keys = {
  goods: (channelId: string) => ['channels', channelId, 'goods'] as const,
  orders: (channelId: string) => ['channels', channelId, 'good-orders'] as const,
};

const base = (channelId: string) => `/api/v1/channels/${channelId}`;

export const goodsQuery = (channelId: string, enabled = true) =>
  queryOptions({
    queryKey: keys.goods(channelId),
    queryFn: ({ signal }) => api.get<Good[]>(`${base(channelId)}/goods`, signal),
    enabled,
    retry: (count, error) => !isFeatureDisabled(error) && count < 2,
  });

export const goodOrdersQuery = (channelId: string, enabled = true) =>
  queryOptions({
    queryKey: keys.orders(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: GoodOrder[]; nextCursor: string | null }>(
        `${base(channelId)}/good-orders?limit=100`,
        signal,
      ),
    enabled,
  });

export function useSaveGood(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: UpdateGood } | { create: CreateGood }) =>
      'create' in input
        ? api.post<Good>(`${base(channelId)}/goods`, input.create)
        : api.patch<Good>(`${base(channelId)}/goods/${input.id}`, input.patch),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.goods(channelId) }),
  });
}

export function useRefundOrder(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      api.post<GoodOrder>(`${base(channelId)}/good-orders/${orderId}/refund`, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.orders(channelId) }),
  });
}
