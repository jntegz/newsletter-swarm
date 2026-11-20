// Bounce rules (Sending → Bounces), subscribers on a paid plan waiting for a decision, and one
// subscriber's bounces. Contract: docs/deliverability.md "Bounces".
import type {
  BounceHold,
  BounceHoldDecision,
  BouncePolicy,
  BouncePolicySaved,
  BouncePolicySettings,
  BouncePreview,
  MemberBounces,
  UpdateBouncePolicy,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const policyKey = (workspaceId: string) => ['workspaces', workspaceId, 'bounce-policy'] as const;
const holdsKey = (channelId: string) => ['bounce-holds', channelId] as const;

export const bouncePolicyQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: policyKey(workspaceId),
    queryFn: ({ signal }) =>
      api.get<BouncePolicySettings>(`/api/v1/workspaces/${workspaceId}/bounce-policy`, signal),
  });

export const bouncePreviewQuery = (workspaceId: string, policy: BouncePolicy) =>
  queryOptions({
    queryKey: [...policyKey(workspaceId), 'preview', policy] as const,
    // A read: the preview changes nothing, it only needs the rules in the body.
    queryFn: () =>
      api.post<BouncePreview>(`/api/v1/workspaces/${workspaceId}/bounce-policy/preview`, policy),
  });

export function useSaveBouncePolicy(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBouncePolicy) =>
      api.put<BouncePolicySaved>(`/api/v1/workspaces/${workspaceId}/bounce-policy`, input),
    onSuccess: async (saved) => {
      client.setQueryData(policyKey(workspaceId), saved);
      if (saved.applied) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['bounce-holds'] }),
          client.invalidateQueries({ queryKey: ['suppressions'] }),
          client.invalidateQueries({ queryKey: ['members'] }),
        ]);
      }
    },
  });
}

export const bounceHoldsQuery = (channelId: string) =>
  queryOptions({
    queryKey: holdsKey(channelId),
    queryFn: ({ signal }) =>
      api.get<BounceHold[]>(`/api/v1/channels/${channelId}/bounce-holds`, signal),
  });

export function useDecideBounceHold(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ holdId, decision }: { holdId: string } & BounceHoldDecision) =>
      api.post(`/api/v1/channels/${channelId}/bounce-holds/${holdId}`, { decision }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: holdsKey(channelId) }),
        client.invalidateQueries({ queryKey: ['suppressions', channelId] }),
        client.invalidateQueries({ queryKey: ['members'] }),
      ]),
  });
}

export const memberBouncesQuery = (memberId: string) =>
  queryOptions({
    queryKey: ['members', memberId, 'bounces'] as const,
    queryFn: ({ signal }) => api.get<MemberBounces>(`/api/v1/members/${memberId}/bounces`, signal),
  });
