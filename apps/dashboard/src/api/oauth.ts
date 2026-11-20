// Queries and mutations for OAuth apps (Settings → Developers → OAuth apps), the apps authorised
// on a workspace, and the consent page. Routes: workers/api/src/routes/{oauthApps,oauth}.ts.
import type {
  AuthorizeParams,
  ConsentDecision,
  ConsentInfo,
  ConsentResult,
  CreateOAuthApp,
  OAuthApp,
  OAuthAppWithSecret,
  OAuthGrant,
  UpdateOAuthApp,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const oauthKeys = {
  apps: (workspaceId: string) => ['workspaces', workspaceId, 'oauth-apps'] as const,
  grants: (workspaceId: string) => ['workspaces', workspaceId, 'oauth-grants'] as const,
  consent: (params: AuthorizeParams) => ['oauth', 'consent', params] as const,
};

const base = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

export const oauthAppsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: oauthKeys.apps(workspaceId),
    queryFn: ({ signal }) => api.get<OAuthApp[]>(`${base(workspaceId)}/oauth-apps`, signal),
  });

export const oauthGrantsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: oauthKeys.grants(workspaceId),
    queryFn: ({ signal }) => api.get<OAuthGrant[]>(`${base(workspaceId)}/oauth-grants`, signal),
  });

export function useCreateOAuthApp(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOAuthApp) =>
      api.post<OAuthAppWithSecret>(`${base(workspaceId)}/oauth-apps`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: oauthKeys.apps(workspaceId) }),
  });
}

export function useUpdateOAuthApp(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateOAuthApp & { id: string }) =>
      api.patch<OAuthApp>(`${base(workspaceId)}/oauth-apps/${id}`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: oauthKeys.apps(workspaceId) }),
  });
}

export function useRotateOAuthSecret(workspaceId: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<OAuthAppWithSecret>(`${base(workspaceId)}/oauth-apps/${id}/rotate-secret`),
  });
}

export function useRevokeOAuthApp(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(workspaceId)}/oauth-apps/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: oauthKeys.apps(workspaceId) });
      void client.invalidateQueries({ queryKey: oauthKeys.grants(workspaceId) });
    },
  });
}

export function useRevokeOAuthGrant(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(workspaceId)}/oauth-grants/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: oauthKeys.grants(workspaceId) }),
  });
}

/** The authorization request as the consent page received it; the server checks it again. */
export const consentQuery = (params: AuthorizeParams) =>
  queryOptions({
    queryKey: oauthKeys.consent(params),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams(
        Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]),
      );
      return api.get<ConsentInfo>(`/api/v1/oauth/consent?${query}`, signal);
    },
    retry: false,
    staleTime: Infinity,
  });

export function useConsent() {
  return useMutation({
    mutationFn: (input: ConsentDecision) => api.post<ConsentResult>('/api/v1/oauth/consent', input),
  });
}
