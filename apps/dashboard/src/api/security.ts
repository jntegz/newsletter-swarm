// Queries and mutations for account security (Phase 7): the second-factor step after sign-in,
// Settings → Security (passkeys, authenticator app, recovery codes, workspace policy, SSO) and
// sign out everywhere. Passkeys go through @simplewebauthn/browser.
import type {
  FactorAdded,
  Me,
  Passkey,
  PauseFeeds,
  PausedFeeds,
  Require2fa,
  SecurityOverview,
  SsoConnection,
  SsoDomain,
  TotpEnrollment,
  WorkspaceSecurity,
} from '@swarm/domain';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { keys } from './queries';

export const securityKeys = {
  overview: ['security'] as const,
  workspace: (workspaceId: string) => ['workspaces', workspaceId, 'security'] as const,
  sso: (workspaceId: string) => ['workspaces', workspaceId, 'sso-connections'] as const,
};

export const securityQuery = queryOptions({
  queryKey: securityKeys.overview,
  queryFn: ({ signal }) => api.get<SecurityOverview>('/api/v1/security', signal),
});

export const workspaceSecurityQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: securityKeys.workspace(workspaceId),
    queryFn: ({ signal }) =>
      api.get<WorkspaceSecurity>(`/api/v1/workspaces/${workspaceId}/security`, signal),
  });

export const ssoConnectionsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: securityKeys.sso(workspaceId),
    queryFn: ({ signal }) =>
      api.get<SsoConnection[]>(`/api/v1/workspaces/${workspaceId}/sso-connections`, signal),
  });

/** True when the server wants a fresh second-factor check before this change. */
export const needsStepUp = (error: unknown) =>
  error instanceof ApiError && error.field('secondFactor') === 'step_up_required';

/** True when the browser has no WebAuthn at all (passkey buttons are hidden then). */
export const passkeysSupported = () =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';

// ---------------------------------------------------------------------------------------------
// Verifying (the sign-in step, and the check before a sensitive change)

export async function verifyWithPasskey(): Promise<Me> {
  const options = await api.post<PublicKeyCredentialRequestOptionsJSON>(
    '/api/v1/auth/second-factor/passkey/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<Me>('/api/v1/auth/second-factor/passkey', { response });
}

export const verifyWithTotp = (code: string) =>
  api.post<Me>('/api/v1/auth/second-factor/totp', { code });

export const verifyWithRecoveryCode = (code: string) =>
  api.post<Me>('/api/v1/auth/second-factor/recovery', { code });

/** After any verification the session token rotates and its status changes: refetch both. */
export function useAfterVerify() {
  const client = useQueryClient();
  return async (me?: Me) => {
    if (me) client.setQueryData(keys.me, me);
    await client.invalidateQueries({ queryKey: keys.me });
    await client.invalidateQueries({ queryKey: securityKeys.overview });
  };
}

// ---------------------------------------------------------------------------------------------
// Adding and removing factors

export async function addPasskey(name: string): Promise<FactorAdded> {
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    '/api/v1/security/passkeys/options',
  );
  const response = await startRegistration({ optionsJSON: options });
  return api.post<FactorAdded>('/api/v1/security/passkeys', { name, response });
}

export const startTotp = () => api.post<TotpEnrollment>('/api/v1/security/totp');
export const confirmTotp = (code: string) =>
  api.post<FactorAdded>('/api/v1/security/totp/confirm', { code });

export function useSecurityMutation<T, V = void>(fn: (vars: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: securityKeys.overview });
      await client.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export const renamePasskey = ({ id, name }: { id: string; name: string }) =>
  api.patch<Passkey>(`/api/v1/security/passkeys/${id}`, { name });
export const removePasskey = (id: string) => api.delete(`/api/v1/security/passkeys/${id}`);
export const disableTotp = () => api.delete('/api/v1/security/totp');
export const regenerateRecoveryCodes = () =>
  api.post<{ recoveryCodes: string[] }>('/api/v1/security/recovery-codes');

export function useSignOutEverywhere() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keepCurrent: boolean) =>
      api.post<{ revoked: number }>('/api/v1/auth/sessions/sign-out-everywhere', { keepCurrent }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}

export function useWorkspacePolicy(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (require2fa: Require2fa) =>
      api.put<WorkspaceSecurity>(`/api/v1/workspaces/${workspaceId}/security`, { require2fa }),
    onSuccess: (data) => client.setQueryData(securityKeys.workspace(workspaceId), data),
  });
}

/** Incident response: pause every export destination and webhook endpoint (needs step-up). */
export function usePauseAllFeeds(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PauseFeeds) =>
      api.post<PausedFeeds>(`/api/v1/workspaces/${workspaceId}/security/pause-feeds`, input),
    onSuccess: () => client.invalidateQueries(),
  });
}

// ---------------------------------------------------------------------------------------------
// SSO

export function useSsoMutation<T, V>(workspaceId: string, fn: (vars: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: securityKeys.sso(workspaceId) }),
  });
}

export const createSsoConnection = (
  workspaceId: string,
  input: { issuer: string; clientId: string; clientSecret: string; jitRole: string | null },
) =>
  api.post<SsoConnection>(`/api/v1/workspaces/${workspaceId}/sso-connections`, {
    protocol: 'oidc',
    ...input,
  });

export const updateSsoConnection = (id: string, input: Record<string, unknown>) =>
  api.patch<SsoConnection>(`/api/v1/sso-connections/${id}`, input);
export const deleteSsoConnection = (id: string) => api.delete(`/api/v1/sso-connections/${id}`);
export const addSsoDomain = (id: string, domain: string) =>
  api.post<SsoDomain>(`/api/v1/sso-connections/${id}/domains`, { domain });
export const verifySsoDomain = (id: string, domainId: string) =>
  api.post<SsoDomain>(`/api/v1/sso-connections/${id}/domains/${domainId}/verify`);
export const removeSsoDomain = (id: string, domainId: string) =>
  api.delete(`/api/v1/sso-connections/${id}/domains/${domainId}`);
