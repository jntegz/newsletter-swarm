// Self-hosting: who can sign up on this Swarm, public on the sign-in page, which features are on
// and how much the email service may send. Instance admins change them in Settings → Instance.
import type {
  InstanceAudit,
  InstanceFeature,
  InstanceInfo,
  InstanceMail,
  InstanceSendingLimits,
  InstanceSettings,
  InstanceSiteCode,
  UpdateInstanceSettings,
  UpdateSendingLimits,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';

export const instanceKeys = {
  info: ['instance'] as const,
  settings: ['instance', 'settings'] as const,
  features: ['instance', 'features'] as const,
  mail: ['instance', 'mail'] as const,
  siteCode: ['instance', 'site-code'] as const,
  sendingLimits: ['instance', 'sending-limits'] as const,
  audit: ['instance', 'audit'] as const,
};

export const instanceQuery = queryOptions({
  queryKey: instanceKeys.info,
  queryFn: ({ signal }) => api.get<InstanceInfo>('/api/v1/instance', signal),
  staleTime: 5 * 60_000,
});

export const instanceSettingsQuery = queryOptions({
  queryKey: instanceKeys.settings,
  queryFn: ({ signal }) => api.get<InstanceSettings>('/api/v1/instance/settings', signal),
});

export function useSaveInstanceSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateInstanceSettings) =>
      api.put<InstanceSettings>('/api/v1/instance/settings', body),
    onSuccess: (settings) => {
      client.setQueryData(instanceKeys.settings, settings);
      client.setQueryData(instanceKeys.info, { signup: settings.signup });
    },
  });
}

/** Each read asks the email service and DNS, so it's fetched once and refreshed when asked. */
export const instanceMailQuery = queryOptions({
  queryKey: instanceKeys.mail,
  queryFn: ({ signal }) => api.get<InstanceMail>('/api/v1/instance/mail', signal),
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
});

export const instanceFeaturesQuery = queryOptions({
  queryKey: instanceKeys.features,
  queryFn: ({ signal }) => api.get<InstanceFeature[]>('/api/v1/instance/features', signal),
});

interface SaveInstanceFeature {
  key: string;
  enabled: boolean;
}

/** Only the saved answer changes the list, so a failed save leaves the switch as it was. */
export function saveInstanceFeatureOptions(client: QueryClient) {
  return {
    mutationFn: ({ key, enabled }: SaveInstanceFeature) =>
      api.put<InstanceFeature>(`/api/v1/instance/features/${encodeURIComponent(key)}`, { enabled }),
    onSuccess: (saved: InstanceFeature) => {
      client.setQueryData<InstanceFeature[]>(instanceKeys.features, (list) =>
        list?.map((feature) => (feature.key === saved.key ? saved : feature)),
      );
    },
  };
}

/** One per switch, so each shows its own saving and error state. */
export function useSaveInstanceFeature() {
  return useMutation(saveInstanceFeatureOptions(useQueryClient()));
}

/** Where website code may run on this Swarm's own domain (Settings → Instance). */
export const instanceSiteCodeQuery = queryOptions({
  queryKey: instanceKeys.siteCode,
  queryFn: ({ signal }) => api.get<InstanceSiteCode>('/api/v1/instance/site-code', signal),
});

export type SaveInstanceSiteCode =
  { everyWorkspace: boolean } | { workspaceId: string; allowed: boolean };

/** One switch: every workspace, or one of them. The saved answer replaces the whole list. */
export function useSaveInstanceSiteCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: SaveInstanceSiteCode) =>
      'workspaceId' in change
        ? api.put<InstanceSiteCode>(
            `/api/v1/instance/site-code/workspaces/${encodeURIComponent(change.workspaceId)}`,
            { allowed: change.allowed },
          )
        : api.put<InstanceSiteCode>('/api/v1/instance/site-code', change),
    onSuccess: (saved) => client.setQueryData(instanceKeys.siteCode, saved),
  });
}

/** The sending limits and what has been counted against them (Settings → Instance). */
export const sendingLimitsQuery = queryOptions({
  queryKey: instanceKeys.sendingLimits,
  queryFn: ({ signal }) =>
    api.get<InstanceSendingLimits>('/api/v1/instance/sending-limits', signal),
  refetchInterval: 60_000,
});

export function useSaveSendingLimits() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSendingLimits) =>
      api.put<InstanceSendingLimits>('/api/v1/instance/sending-limits', body),
    onSuccess: (saved) => client.setQueryData(instanceKeys.sendingLimits, saved),
  });
}

/** One page of the install's audit log, newest first; null is the newest page. */
export const instanceAuditQuery = (cursor: string | null) =>
  queryOptions({
    queryKey: [...instanceKeys.audit, cursor],
    queryFn: ({ signal }) =>
      api.get<InstanceAudit>(
        `/api/v1/instance/audit?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        signal,
      ),
  });
