// Queries and mutations for Partner Exchange and Sponsor Match.
import type {
  CreatePartnerPick,
  PartnerPick,
  SponsorBooking,
  SponsorSettings,
  UpdatePartnerPick,
  UpdateSponsorBooking,
  UpdateSponsorSettings,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { isFeatureDisabled } from './site';

const base = (channelId: string) => `/api/v1/channels/${channelId}`;
const retry = (count: number, error: Error) => !isFeatureDisabled(error) && count < 2;

const keys = {
  picks: (id: string) => ['channels', id, 'partner-picks'] as const,
  settings: (id: string) => ['channels', id, 'sponsor-settings'] as const,
  bookings: (id: string) => ['channels', id, 'sponsor-bookings'] as const,
};

export const partnerPicksQuery = (channelId: string) =>
  queryOptions({
    queryKey: keys.picks(channelId),
    queryFn: ({ signal }) => api.get<PartnerPick[]>(`${base(channelId)}/partner-picks`, signal),
    retry,
  });

export function useSavePartnerPick(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      input: { id: string; patch: UpdatePartnerPick } | { create: CreatePartnerPick },
    ) =>
      'create' in input
        ? api.post<PartnerPick>(`${base(channelId)}/partner-picks`, input.create)
        : api.patch<PartnerPick>(`${base(channelId)}/partner-picks/${input.id}`, input.patch),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.picks(channelId) }),
  });
}

export function useDeletePartnerPick(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(channelId)}/partner-picks/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.picks(channelId) }),
  });
}

export const sponsorSettingsQuery = (channelId: string) =>
  queryOptions({
    queryKey: keys.settings(channelId),
    queryFn: ({ signal }) =>
      api.get<SponsorSettings>(`${base(channelId)}/sponsor-settings`, signal),
    retry,
  });

export function useSaveSponsorSettings(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSponsorSettings) =>
      api.put<SponsorSettings>(`${base(channelId)}/sponsor-settings`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.settings(channelId) }),
  });
}

export const sponsorBookingsQuery = (channelId: string) =>
  queryOptions({
    queryKey: keys.bookings(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: SponsorBooking[]; nextCursor: string | null }>(
        `${base(channelId)}/sponsor-bookings?limit=100`,
        signal,
      ),
    retry,
  });

export function useUpdateBooking(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSponsorBooking }) =>
      api.patch<SponsorBooking>(`${base(channelId)}/sponsor-bookings/${id}`, patch),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.bookings(channelId) }),
  });
}

/** Emails a booking's sponsor a new report link (good for 90 days). */
export function useSendReportLink(channelId: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ sent: true }>(`${base(channelId)}/sponsor-bookings/${id}/report-link`),
  });
}
