// Queries and mutations for the Deliverability Center (Phase 7).
import type {
  DedicatedSending,
  DeliverabilityCheckup,
  DeliverabilityOverview,
  DmarcDomainReport,
  DomainHealth,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface DayRange {
  from: string;
  to: string;
}

const deliverabilityKeys = {
  overview: (channelId: string) => ['channels', channelId, 'deliverability'] as const,
  dmarc: (domainId: string) => ['sending-domains', domainId, 'dmarc'] as const,
  dedicated: (channelId: string) => ['channels', channelId, 'dedicated-sending'] as const,
};

const rangeParams = (range: DayRange) => new URLSearchParams({ from: range.from, to: range.to });

export const deliverabilityQuery = (channelId: string, range: DayRange) =>
  queryOptions({
    queryKey: [...deliverabilityKeys.overview(channelId), range],
    queryFn: ({ signal }) =>
      api.get<DeliverabilityOverview>(
        `/api/v1/channels/${channelId}/deliverability?${rangeParams(range)}`,
        signal,
      ),
    placeholderData: (previous) => previous,
  });

/**
 * The check-up reads DNS and asks blocklists, so it runs when the page opens and when someone
 * presses "Run again", never on its own because a window got focus.
 */
export const checkupQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...deliverabilityKeys.overview(channelId), 'checkup'],
    queryFn: ({ signal }) =>
      api.get<DeliverabilityCheckup>(
        `/api/v1/channels/${channelId}/deliverability/checkup`,
        signal,
      ),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

export const domainHealthQuery = (domainId: string, range: DayRange) =>
  queryOptions({
    queryKey: ['sending-domains', domainId, 'health', range],
    queryFn: ({ signal }) =>
      api.get<DomainHealth>(
        `/api/v1/sending-domains/${domainId}/health?${rangeParams(range)}`,
        signal,
      ),
  });

export const dmarcQuery = (domainId: string, range: DayRange) =>
  queryOptions({
    queryKey: [...deliverabilityKeys.dmarc(domainId), range],
    queryFn: ({ signal }) =>
      api.get<DmarcDomainReport>(
        `/api/v1/sending-domains/${domainId}/dmarc?${rangeParams(range)}`,
        signal,
      ),
    placeholderData: (previous) => previous,
  });

export const dedicatedQuery = (channelId: string) =>
  queryOptions({
    queryKey: deliverabilityKeys.dedicated(channelId),
    queryFn: ({ signal }) =>
      api.get<DedicatedSending>(`/api/v1/channels/${channelId}/dedicated-sending`, signal),
  });

function useDedicatedAction(channelId: string, path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<DedicatedSending>(`/api/v1/channels/${channelId}/dedicated-sending/${path}`),
    onSuccess: (data) => client.setQueryData(deliverabilityKeys.dedicated(channelId), data),
  });
}

export const useCreateConfigurationSet = (channelId: string) =>
  useDedicatedAction(channelId, 'configuration-set');
export const useRequestDedicatedIp = (channelId: string) =>
  useDedicatedAction(channelId, 'dedicated-ip');
export const useCheckDedicatedIp = (channelId: string) =>
  useDedicatedAction(channelId, 'dedicated-ip/check');
